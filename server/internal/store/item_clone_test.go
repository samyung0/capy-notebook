package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// itemCloneMember adds userID to workspaceID with role.
func itemCloneMember(t *testing.T, s *Store, workspaceID, userID, role string) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(), `INSERT INTO workspace_members (workspace_id,user_id,role)
		VALUES ($1,$2,$3)`, workspaceID, userID, role); err != nil {
		t.Fatal(err)
	}
}

// itemCloneIndex gives fileID a ready index of one chunk and its vector.
func itemCloneIndex(t *testing.T, s *Store, workspaceID, fileID, hash string) string {
	t.Helper()
	ctx := context.Background()
	contentID, chunkID := uid("rgc"), uid("rc")
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO rag_contents(id,workspace_id,content_hash,status) VALUES($1,$2,$3,'ready')`, []any{contentID, workspaceID, hash}},
		{`INSERT INTO rag_file_contents(file_id,workspace_id,content_id) VALUES($1,$2,$3)`, []any{fileID, workspaceID, contentID}},
		{`INSERT INTO rag_chunks(id,workspace_id,content_id,chunk_idx,text,indexed_text,lang) VALUES($1,$2,$3,0,'passage','passage','en')`, []any{chunkID, workspaceID, contentID}},
		{`INSERT INTO rag_chunk_vectors_2560(chunk_id,workspace_id,embedding) VALUES($1,$2,array_fill(0.5::real, ARRAY[2560])::halfvec)`, []any{chunkID, workspaceID}},
		{`UPDATE files SET indexed=true WHERE id=$1`, []any{fileID}},
	} {
		if _, err := s.pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	return contentID
}

// A file clone into another workspace is paid by that workspace's owner,
// carries the saved edits on the same counted base blob, copies the index
// under fresh chunk ids and names its thumbnail copy after the new file; a
// clone into the source's own workspace shares the source's index.
func TestFileCloneCarriesSavedEditsIndexAndThumbnail(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_file_clone_owner")
	targetOwner := newBlobTestUser(t, s, "u_file_clone_target")
	source, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "saved-edits")
	sourceContent := itemCloneIndex(t, s, source.ID, file.ID, "lesson-hash")
	if _, err := s.pool.Exec(ctx, `UPDATE files SET thumbnail_key=$2, provenance=$3 WHERE id=$1`,
		file.ID, "thumbs/"+file.ID+"/abc.webp", `{"books":[{"id":"ahss","title":"T","authors":["A"],"version":1,"license":"CC BY 4.0","excerptIds":[]}],"license":"CC BY 4.0"}`); err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateWorkspace(ctx, targetOwner, WorkspaceCreate{Name: "Target"})
	if err != nil {
		t.Fatal(err)
	}
	itemCloneMember(t, s, target.ID, owner, "editor")
	baseRefs := blobRefCount(t, s, doc.BaseBlobPath)

	clone, copies, err := s.CloneFile(ctx, owner, file.ID, CloneTarget{
		WorkspaceID: target.ID, ChapterName: "Imported", Name: "Lesson copy.docx",
	})
	if err != nil {
		t.Fatal(err)
	}
	var payer, docPayer, state string
	var baseRevision, revision int64
	if err := s.pool.QueryRow(ctx, `SELECT f.user_id, d.user_id, `+cloneSavedRowsSQL+`, d.base_revision, f.revision
		FROM files f JOIN source_documents d ON d.file_id=f.id WHERE f.id=$1`, clone.ID).
		Scan(&payer, &docPayer, &state, &baseRevision, &revision); err != nil {
		t.Fatal(err)
	}
	if payer != targetOwner || docPayer != targetOwner || state != "saved-edits" || baseRevision != revision {
		t.Fatalf("payer=%s doc payer=%s state=%q base_revision=%d revision=%d", payer, docPayer, state, baseRevision, revision)
	}
	// Nothing was published since the edit, so the base is also the published
	// file: the copy holds it twice.
	if got := blobRefCount(t, s, doc.BaseBlobPath); got != baseRefs+2 {
		t.Fatalf("base blob refs = %d, want %d", got, baseRefs+2)
	}
	if clone.Name != "Lesson copy.docx" || clone.ChapterID == nil || clone.Provenance == nil ||
		clone.Provenance.Books[0].ID != "ahss" {
		t.Fatalf("clone = %+v", clone)
	}
	if len(copies) != 1 || copies[0].FileID != clone.ID || copies[0].To != "thumbs/"+clone.ID+"/abc.webp" {
		t.Fatalf("thumbnail copies = %+v", copies)
	}
	var contentID, chunkID string
	var vectors int
	if err := s.pool.QueryRow(ctx, `SELECT fc.content_id, c.id,
			(SELECT count(*) FROM rag_chunk_vectors_2560 v WHERE v.chunk_id=c.id)
		FROM rag_file_contents fc JOIN rag_chunks c ON c.content_id=fc.content_id
		WHERE fc.file_id=$1 AND fc.workspace_id=$2`, clone.ID, target.ID).Scan(&contentID, &chunkID, &vectors); err != nil {
		t.Fatal(err)
	}
	if contentID == sourceContent || vectors != 1 || !clone.Indexed {
		t.Fatalf("copied index content=%s chunk=%s vectors=%d indexed=%v", contentID, chunkID, vectors, clone.Indexed)
	}

	same, _, err := s.CloneFile(ctx, owner, file.ID, CloneTarget{WorkspaceID: source.ID, Name: "lesson (copy).docx"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT content_id FROM rag_file_contents WHERE file_id=$1`, same.ID).
		Scan(&contentID); err != nil || contentID != sourceContent {
		t.Fatalf("same-workspace clone index = %s %v, want shared %s", contentID, err, sourceContent)
	}
}

// cloneSavedRowsSQL is a source document's saved rows (alias d) in its
// epoch, as text in checkpoint order: what a save wrote over the base.
const cloneSavedRowsSQL = `(SELECT string_agg(convert_from(u.update,'UTF8'), ',' ORDER BY u.checkpoint)
	FROM source_document_updates u WHERE u.file_id=d.file_id AND u.epoch=d.epoch)`

// A file's saves since its last fold are rows over the base (migration
// 0075). A clone copies the current epoch's rows as epoch 1 with their log
// totals, so it opens on the same document, and its payer is charged the
// copied storage, as reconciliation recounts it.
func TestFileCloneCarriesUnfoldedSaves(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_clone_rows_owner")
	targetOwner := newBlobTestUser(t, s, "u_clone_rows_target")
	_, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "first")
	doc = sourceTestEdit(t, s, owner, doc, "second")
	if doc.State != nil || len(doc.StateRows) != 2 {
		t.Fatalf("source state=%q rows=%d, want two unfolded rows", doc.State, len(doc.StateRows))
	}
	target, err := s.CreateWorkspace(ctx, targetOwner, WorkspaceCreate{Name: "Target"})
	if err != nil {
		t.Fatal(err)
	}
	itemCloneMember(t, s, target.ID, owner, "editor")
	before := chargeTestCharged(t, s, targetOwner)

	clone, _, err := s.CloneFile(ctx, owner, file.ID, CloneTarget{WorkspaceID: target.ID, Name: "Lesson copy.docx"})
	if err != nil {
		t.Fatal(err)
	}
	copied := sourceTestSeed(t, s, owner, clone.ID)
	rows := func(doc SourceSession) string {
		out := make([]string, len(doc.StateRows))
		for i, row := range doc.StateRows {
			out[i] = string(row)
		}
		return strings.Join(out, ",")
	}
	if copied.Epoch != 1 || copied.Checkpoint != doc.Checkpoint || copied.State != nil || rows(copied) != "first,second" {
		t.Fatalf("clone epoch=%d checkpoint=%d state=%q rows=%q, want epoch 1 at %d with the source's rows",
			copied.Epoch, copied.Checkpoint, copied.State, rows(copied), doc.Checkpoint)
	}
	var sourceBytes, cloneBytes, fileBytes int64
	var cloneRows int
	if err := s.pool.QueryRow(ctx, `SELECT
			(SELECT storage_bytes FROM source_documents WHERE file_id=$1),
			(SELECT storage_bytes FROM source_documents WHERE file_id=$2),
			(SELECT log_rows FROM source_documents WHERE file_id=$2),
			(SELECT size_bytes FROM files WHERE id=$2)`, file.ID, clone.ID).
		Scan(&sourceBytes, &cloneBytes, &cloneRows, &fileBytes); err != nil {
		t.Fatal(err)
	}
	if sourceBytes <= 0 || cloneBytes != sourceBytes || cloneRows != 2 {
		t.Fatalf("storage bytes source=%d clone=%d, clone log rows=%d", sourceBytes, cloneBytes, cloneRows)
	}
	if charged := chargeTestCharged(t, s, targetOwner) - before; charged != fileBytes+cloneBytes {
		t.Fatalf("payer charged %d, want the file %d plus its document %d", charged, fileBytes, cloneBytes)
	}
}

// A material clone lands in a chosen workspace and chapter (paid by its
// owner) or standalone; mentions stay live only for the destination's
// members, scope is cleared outside the source's workspace, embedded rows are
// copied with fresh ids, a taken title is refused and an embedded row is
// never cloned on its own. A workspace clone, whose only member is the
// cloner, carries the same mention rule.
func TestMaterialCloneDestinationsMentionsAndTitles(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_mat_clone_owner")
	actor := newBlobTestUser(t, s, "u_mat_clone_actor")
	outsider := newBlobTestUser(t, s, "u_mat_clone_outsider")
	source, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Source"})
	if err != nil {
		t.Fatal(err)
	}
	itemCloneMember(t, s, source.ID, actor, "viewer")
	itemCloneMember(t, s, source.ID, outsider, "viewer")
	target, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Target"})
	if err != nil {
		t.Fatal(err)
	}
	itemCloneMember(t, s, target.ID, actor, "editor")
	chapter, err := s.AddChapter(ctx, target.ID, owner, "Week 1")
	if err != nil {
		t.Fatal(err)
	}
	mention := func(id, name string) map[string]any {
		return map[string]any{"type": "mention", "key": id, "value": name, "children": []any{map[string]any{"text": ""}}}
	}
	content, err := materialdoc.Marshal(materialdoc.Envelope{SchemaVersion: 1, Value: []map[string]any{{
		"type": "p", "id": "b1", "children": []any{
			map[string]any{"text": "Ask "}, mention(actor, "Ana"), map[string]any{"text": " and "}, mention(outsider, "Bo"),
		},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: owner, WorkspaceID: source.ID, WorkspaceName: source.Name, Kind: "note",
		Title: "Lecture", Content: content, ScopeChapters: []string{"Old chapter"},
	})
	if err != nil {
		t.Fatal(err)
	}
	cards, err := s.CreateEmbeddedMaterial(ctx, owner, note.ID, EmbeddedDraft{Kind: "flashcards", Cards: [][2]string{{"f", "b"}}})
	if err != nil {
		t.Fatal(err)
	}
	withRef := noteWithRefs(t, cards)
	doc, err := materialdoc.Parse(withRef)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := materialdoc.Parse(content)
	if err != nil {
		t.Fatal(err)
	}
	doc.Value = append(parsed.Value, doc.Value[1])
	if content, err = materialdoc.Marshal(doc); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &content, UpdatedBy: owner}); err != nil {
		t.Fatal(err)
	}

	clone, err := s.CloneMaterial(ctx, actor, note.ID, CloneTarget{WorkspaceID: target.ID, ChapterID: &chapter.ID, Name: "Lecture copy"})
	if err != nil {
		t.Fatal(err)
	}
	if clone.WorkspaceID != target.ID || clone.ChapterID == nil || *clone.ChapterID != chapter.ID ||
		clone.OwnerUserID != owner || clone.CreatedBy != actor || len(clone.ScopeChapters) != 0 {
		t.Fatalf("workspace clone = %+v", clone)
	}
	if !strings.Contains(clone.Content, actor) || strings.Contains(clone.Content, outsider) ||
		!strings.Contains(clone.Content, `"@Bo"`) {
		t.Fatalf("workspace clone mentions: %s", clone.Content)
	}
	refs, err := materialdoc.ExtractMaterialRefs(clone.Content)
	if err != nil || len(refs) != 1 || refs[0].MaterialID == cards.ID {
		t.Fatalf("clone refs = %+v %v", refs, err)
	}
	child, err := s.GetMaterial(ctx, refs[0].MaterialID)
	if err != nil || child.ParentMaterialID != clone.ID || child.WorkspaceID != target.ID {
		t.Fatalf("embedded copy = %+v %v", child, err)
	}
	if _, err := s.CloneMaterial(ctx, actor, note.ID, CloneTarget{WorkspaceID: target.ID, Name: "lecture COPY"}); !errors.Is(err, ErrTitleTaken) {
		t.Fatalf("title clash = %v, want ErrTitleTaken", err)
	}
	if _, err := s.CloneMaterial(ctx, actor, cards.ID, CloneTarget{Name: "Embedded"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("embedded row clone = %v, want ErrNotFound", err)
	}

	standalone, err := s.CloneMaterial(ctx, actor, note.ID, CloneTarget{Name: "Mine"})
	if err != nil {
		t.Fatal(err)
	}
	if standalone.WorkspaceID != "" || standalone.OwnerUserID != actor || strings.Contains(standalone.Content, `"type":"mention"`) {
		t.Fatalf("standalone clone = %+v", standalone)
	}

	copied, err := s.CloneWorkspace(ctx, actor, source.ID, WorkspaceCreate{Name: "Copy"})
	if err != nil {
		t.Fatal(err)
	}
	var copiedContent string
	if err := s.pool.QueryRow(ctx, `SELECT content::text FROM materials WHERE workspace_id=$1 AND title='Lecture'`,
		copied.ID).Scan(&copiedContent); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(copiedContent, actor) || strings.Contains(copiedContent, outsider) {
		t.Fatalf("workspace clone mentions: %s", copiedContent)
	}
}

// Security regression (item clone access, Epo 2026-10-11): a file or material
// inside a workspace is cloned only by its members and effective editors, the
// workspace clone's rule; a link viewer who can read it cannot copy it.
func TestItemCloneRefusesWorkspaceLinkViewers(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_item_clone_sec_owner")
	member := newBlobTestUser(t, s, "u_item_clone_sec_member")
	visitor := newBlobTestUser(t, s, "u_item_clone_sec_visitor")
	source, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Shared"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='link', share_role='viewer' WHERE id=$1`, source.ID); err != nil {
		t.Fatal(err)
	}
	itemCloneMember(t, s, source.ID, member, "viewer")
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: owner, WorkspaceID: source.ID, WorkspaceName: source.Name, Kind: "note",
		Title: "Shared note", Content: materialTestContent(t, "body"),
	})
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.createReadyFile(ctx, source.ID, owner, "notes.md", "md", nil, "", 10, "sources/"+uid("sec"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.MaterialEffectiveRole(ctx, visitor, note.ID); err != nil {
		t.Fatalf("the link visitor reads the note: %v", err)
	}
	visitorSpace, err := s.CreateWorkspace(ctx, visitor, WorkspaceCreate{Name: "Visitor"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CloneMaterial(ctx, visitor, note.ID, CloneTarget{Name: "Copy"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("link viewer material clone = %v, want ErrForbidden", err)
	}
	if _, _, err := s.CloneFile(ctx, visitor, file.ID, CloneTarget{WorkspaceID: visitorSpace.ID, Name: "Copy"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("link viewer file clone = %v, want ErrForbidden", err)
	}

	if _, err := s.CloneMaterial(ctx, member, note.ID, CloneTarget{Name: "Copy"}); err != nil {
		t.Fatalf("member material clone: %v", err)
	}
	memberSpace, err := s.CreateWorkspace(ctx, member, WorkspaceCreate{Name: "Member"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.CloneFile(ctx, member, file.ID, CloneTarget{WorkspaceID: memberSpace.ID, Name: "Copy"}); err != nil {
		t.Fatalf("member file clone: %v", err)
	}
	// The destination still needs edit rights: the member is only a viewer of
	// the source, so it is no destination for them.
	if _, err := s.CloneMaterial(ctx, member, note.ID, CloneTarget{WorkspaceID: source.ID, Name: "Viewer copy"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer destination = %v, want ErrForbidden", err)
	}
	// A link editor holds content authority, so the link visitor may copy now.
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET share_role='editor' WHERE id=$1`, source.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CloneMaterial(ctx, visitor, note.ID, CloneTarget{Name: "Copy"}); err != nil {
		t.Fatalf("link editor material clone: %v", err)
	}
}

// A file whose export-only publication left its bytes unindexed is marked for
// reprocessing; its copy keeps the mark, so the scheduler indexes the copy as
// it does the source.
func TestFileCloneKeepsTheReprocessMark(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_clone_reprocess")
	_, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	sourceTestSeed(t, s, owner, file.ID)
	// What applyExportTx leaves behind.
	for _, q := range []string{
		`UPDATE files SET ever_parsed_successfully=true, parse_mode='fast', indexed=false, content_hash=NULL WHERE id=$1`,
		`UPDATE source_documents SET reprocess_at=now()-interval '1 minute' WHERE file_id=$1`,
	} {
		if _, err := s.pool.Exec(ctx, q, file.ID); err != nil {
			t.Fatal(err)
		}
	}
	target, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Target"})
	if err != nil {
		t.Fatal(err)
	}
	clone, _, err := s.CloneFile(ctx, owner, file.ID, CloneTarget{WorkspaceID: target.ID, Name: "lesson.docx"})
	if err != nil {
		t.Fatal(err)
	}
	var due bool
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(reprocess_at<=now(),false) FROM source_documents WHERE file_id=$1`,
		clone.ID).Scan(&due); err != nil {
		t.Fatal(err)
	}
	if !due || clone.Indexed {
		t.Fatalf("clone reprocess due=%v indexed=%v, want due and unindexed", due, clone.Indexed)
	}
}

// A note's index travels with its copy only while it is current: a note
// edited since its index was built starts dirty in a single and in a
// workspace clone, so the scheduler indexes the copy's own text.
func TestNoteCloneLeavesAStaleIndexBehind(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_note_clone_index")
	source, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Source"})
	if err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: owner, WorkspaceID: source.ID, WorkspaceName: source.Name, Kind: "note",
		Title: "Lecture", Content: materialTestContent(t, "body"),
	})
	if err != nil {
		t.Fatal(err)
	}
	contentID := uid("rgc")
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO rag_contents(id,workspace_id,content_hash,status) VALUES($1,$2,'note-hash','ready')`, []any{contentID, source.ID}},
		{`INSERT INTO rag_material_contents(material_id,workspace_id,content_id) VALUES($1,$2,$3)`, []any{note.ID, source.ID, contentID}},
		{`UPDATE materials SET index_dirty_at=NULL, index_job_id=NULL, index_error=NULL WHERE id=$1`, []any{note.ID}},
	} {
		if _, err := s.pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	index := func(materialID string) (content string, dirty bool) {
		t.Helper()
		if err := s.pool.QueryRow(ctx, `SELECT COALESCE((SELECT content_id FROM rag_material_contents WHERE material_id=m.id),''),
				m.index_dirty_at IS NOT NULL FROM materials m WHERE m.id=$1`, materialID).Scan(&content, &dirty); err != nil {
			t.Fatal(err)
		}
		return content, dirty
	}

	current, err := s.CloneMaterial(ctx, owner, note.ID, CloneTarget{WorkspaceID: source.ID, Name: "Current"})
	if err != nil {
		t.Fatal(err)
	}
	if content, dirty := index(current.ID); content != contentID || dirty {
		t.Fatalf("current index: copy has %q dirty=%v, want the shared %s", content, dirty, contentID)
	}

	// Edited within the scheduler's idle window: the index still holds the old text.
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET index_dirty_at=now() WHERE id=$1`, note.ID); err != nil {
		t.Fatal(err)
	}
	stale, err := s.CloneMaterial(ctx, owner, note.ID, CloneTarget{WorkspaceID: source.ID, Name: "Stale"})
	if err != nil {
		t.Fatal(err)
	}
	if content, dirty := index(stale.ID); content != "" || !dirty {
		t.Fatalf("stale index: copy has %q dirty=%v, want none and dirty", content, dirty)
	}
	copied, err := s.CloneWorkspace(ctx, owner, source.ID, WorkspaceCreate{Name: "Copy"})
	if err != nil {
		t.Fatal(err)
	}
	var copiedNote string
	if err := s.pool.QueryRow(ctx, `SELECT id FROM materials WHERE workspace_id=$1 AND title='Lecture'`,
		copied.ID).Scan(&copiedNote); err != nil {
		t.Fatal(err)
	}
	if content, dirty := index(copiedNote); content != "" || !dirty {
		t.Fatalf("workspace clone of a stale index: %q dirty=%v, want none and dirty", content, dirty)
	}
}

// A file cloned into a workspace that embeds in another space is processed
// again like an upload (Epo 2026-10-12): the cloner's credits are reserved
// and an exhausted cloner is refused; a processed store-only Office file is
// parsed as its source was; the copy's bytes stay charged while it is pending.
func TestFileClonePinMismatchQueuesIngest(t *testing.T) {
	s := maintenanceTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_clone_pin_owner")
	targetOwner := newBlobTestUser(t, s, "u_clone_pin_target")
	source, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	itemCloneIndex(t, s, source.ID, file.ID, "pin-hash")
	// A store-only upload its owner processed later keeps parse_mode 'none'.
	if _, err := s.pool.Exec(ctx, `UPDATE files SET parse_mode='none', ever_parsed_successfully=true WHERE id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateWorkspace(ctx, targetOwner, WorkspaceCreate{Name: "Target"})
	if err != nil {
		t.Fatal(err)
	}
	itemCloneMember(t, s, target.ID, owner, "editor")
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET embedding_model_version=embedding_model_version+1 WHERE id=$1`, target.ID); err != nil {
		t.Fatal(err)
	}
	used := userUsedBytes(t, s, targetOwner)

	clone, _, err := s.CloneFile(ctx, owner, file.ID, CloneTarget{WorkspaceID: target.ID, Name: "lesson.docx"})
	if err != nil {
		t.Fatal(err)
	}
	if clone.Status != "pending" || clone.Indexed {
		t.Fatalf("clone status=%s indexed=%v, want pending and unindexed", clone.Status, clone.Indexed)
	}
	var mode, actor, reservation string
	if err := s.pool.QueryRow(ctx, `SELECT payload->>'parseMode', payload->>'actorUserId', payload->>'reservationId'
		FROM jobs WHERE payload->>'fileId'=$1`, clone.ID).Scan(&mode, &actor, &reservation); err != nil {
		t.Fatal(err)
	}
	if mode != "fast" || actor != owner || reservation == "" {
		t.Fatalf("ingest job mode=%s actor=%s reservation=%q, want fast, the cloner, a reservation", mode, actor, reservation)
	}
	if got := userUsedBytes(t, s, targetOwner); got != used+file.SizeBytes {
		t.Fatalf("payer used %d, want %d (the pending copy charged)", got, used+file.SizeBytes)
	}

	if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits (user_id, used_micros, purchased_micros)
		VALUES ($1, $2, 0)
		ON CONFLICT (user_id) DO UPDATE SET used_micros=EXCLUDED.used_micros, purchased_micros=0`,
		owner, mustPlanLimits(t, s, PlanFree).CreditMicros); err != nil {
		t.Fatal(err)
	}
	var exhausted *CreditsExhaustedError
	if _, _, err := s.CloneFile(ctx, owner, file.ID, CloneTarget{WorkspaceID: target.ID, Name: "again.docx"}); !errors.As(err, &exhausted) {
		t.Fatalf("clone without credits = %v, want CreditsExhaustedError", err)
	}
}

// Clones copy a partial file as partial (parts design Q2): failed and
// indexed, its content aliased and searchable in the destination, a missing
// descriptor still missing and unread pages' NULL identity still NULL, so
// Retry processing by the copy's owner re-runs only the missing parts. A
// failed file without an index is not copied.
func TestClonesCopyPartialFiles(t *testing.T) {
	s := maintenanceTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_partial_clone_owner")
	targetOwner := newBlobTestUser(t, s, "u_partial_clone_target")
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := s.pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	source, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Source"})
	if err != nil {
		t.Fatal(err)
	}
	newFile := func(name string) File {
		t.Helper()
		file, err := s.createReadyFile(ctx, source.ID, owner, name, "pdf", nil, "", 100, "sources/"+uid("base"))
		if err != nil {
			t.Fatal(err)
		}
		return file
	}
	// partial is a failed file served by ready content of its revision (its
	// content_hash) built on its fast parse_mode, with a part missing.
	partial := func(name, identity string, summarized bool) File {
		t.Helper()
		file := newFile(name)
		content := itemCloneIndex(t, s, source.ID, file.ID, name)
		exec(`UPDATE rag_contents SET pipeline_identity=NULLIF($2,'') WHERE id=$1`, content, identity)
		if summarized {
			exec(`INSERT INTO rag_content_summaries(content_id,workspace_id,descriptor) VALUES($1,$2,'A lesson.')`, content, source.ID)
		}
		exec(`UPDATE files SET status='failed',parse_mode='fast',ever_parsed_successfully=true,content_hash=$2 WHERE id=$1`, file.ID, name)
		return file
	}
	const parsed = "plan-v2:fast:odl-test:v12"
	summaryPartial := partial("summary.pdf", parsed, false)
	pagesPartial := partial("pages.pdf", "", true)
	unindexed := newFile("unindexed.pdf")
	exec(`UPDATE files SET status='failed' WHERE id=$1`, unindexed.ID)

	type want struct {
		identity   string // "" is NULL
		summarized bool
		jobType    string
		partsOnly  string
		parseFee   string
	}
	wants := map[string]want{
		"summary.pdf": {identity: parsed, jobType: "ingest", partsOnly: "true"},
		"pages.pdf":   {summarized: true, jobType: "parse", parseFee: "false"},
	}
	check := func(t *testing.T, copyID, workspaceID, workspaceOwner string, w want) {
		t.Helper()
		var status string
		var indexed bool
		var identity *string
		var vectors, summaries int
		if err := s.pool.QueryRow(ctx, `SELECT f.status, f.indexed, rc.pipeline_identity,
				(SELECT count(*) FROM rag_chunks c JOIN rag_chunk_vectors_2560 v ON v.chunk_id=c.id WHERE c.content_id=rc.id),
				(SELECT count(*) FROM rag_content_summaries s WHERE s.content_id=rc.id)
			FROM files f
			JOIN rag_file_contents fc ON fc.file_id=f.id
			JOIN rag_contents rc ON rc.id=fc.content_id AND rc.status='ready' AND rc.content_hash=f.content_hash
			WHERE f.id=$1 AND rc.workspace_id=$2`, copyID, workspaceID).
			Scan(&status, &indexed, &identity, &vectors, &summaries); err != nil {
			t.Fatalf("copy's served content: %v", err)
		}
		gotIdentity := ""
		if identity != nil {
			gotIdentity = *identity
		}
		if status != "failed" || !indexed || vectors != 1 || gotIdentity != w.identity || (summaries == 1) != w.summarized {
			t.Fatalf("copy %s indexed=%v vectors=%d identity=%q summaries=%d, want failed, indexed, 1 vector, %q, summarized=%v",
				status, indexed, vectors, gotIdentity, summaries, w.identity, w.summarized)
		}
		if err := s.RetryFileProcessing(ctx, workspaceOwner, copyID, "fast", "test"); err != nil {
			t.Fatal(err)
		}
		var jobType, partsOnly, parseFee string
		if err := s.pool.QueryRow(ctx, `SELECT type,COALESCE(payload->>'partsOnly',''),COALESCE(payload->>'parseFee','')
			FROM jobs WHERE payload->>'fileId'=$1`, copyID).Scan(&jobType, &partsOnly, &parseFee); err != nil {
			t.Fatal(err)
		}
		if jobType != w.jobType || partsOnly != w.partsOnly || parseFee != w.parseFee {
			t.Fatalf("retry job %q partsOnly=%q parseFee=%q, want %q %q %q", jobType, partsOnly, parseFee, w.jobType, w.partsOnly, w.parseFee)
		}
	}

	t.Run("workspace clone", func(t *testing.T) {
		clone, err := s.CloneWorkspace(ctx, owner, source.ID, WorkspaceCreate{Name: "Copy"})
		if err != nil {
			t.Fatal(err)
		}
		rows, err := s.pool.Query(ctx, `SELECT id, name FROM files WHERE workspace_id=$1 ORDER BY name`, clone.ID)
		if err != nil {
			t.Fatal(err)
		}
		copies := map[string]string{}
		for rows.Next() {
			var id, name string
			if err := rows.Scan(&id, &name); err != nil {
				t.Fatal(err)
			}
			copies[name] = id
		}
		rows.Close()
		if len(copies) != 2 || copies["summary.pdf"] == "" || copies["pages.pdf"] == "" {
			t.Fatalf("workspace clone files = %v, want the two partial files only", copies)
		}
		for name, w := range wants {
			t.Run(name, func(t *testing.T) { check(t, copies[name], clone.ID, owner, w) })
		}
	})

	t.Run("file clone", func(t *testing.T) {
		target, err := s.CreateWorkspace(ctx, targetOwner, WorkspaceCreate{Name: "Target"})
		if err != nil {
			t.Fatal(err)
		}
		itemCloneMember(t, s, target.ID, owner, "editor")
		for _, file := range []File{summaryPartial, pagesPartial} {
			t.Run(file.Name, func(t *testing.T) {
				clone, _, err := s.CloneFile(ctx, owner, file.ID, CloneTarget{WorkspaceID: target.ID, Name: file.Name})
				if err != nil {
					t.Fatal(err)
				}
				check(t, clone.ID, target.ID, targetOwner, wants[file.Name])
			})
		}
		if _, _, err := s.CloneFile(ctx, owner, unindexed.ID, CloneTarget{WorkspaceID: target.ID, Name: "unindexed.pdf"}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("clone of a failed unindexed file = %v, want not found", err)
		}
	})
}

// A clone honours the per-file cap of the plan that pays for it, as an upload
// does (Epo 2026-10-12): the file clone is refused, and a workspace clone
// leaves the file out, copies the rest and counts it (Epo 2026-10-20).
func TestCloneRefusesAFilePastThePayersCap(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	limit := mustPlanLimits(t, s, PlanFree).SourceFileBytes
	bigFile := func(owner string) (Workspace, File) {
		t.Helper()
		source, file := sourceTestFile(t, s, owner, "big.pdf", "pdf")
		if _, err := s.pool.Exec(ctx, `UPDATE files SET size_bytes=$2 WHERE id=$1`, file.ID, limit+1); err != nil {
			t.Fatal(err)
		}
		return source, file
	}

	// A Pro editor copies into a Free owner's workspace: the owner pays, so
	// the Free cap applies although the cloner's plan would take the file.
	cloner := newBlobTestUser(t, s, "u_clone_cap_pro")
	if _, err := s.pool.Exec(ctx, `UPDATE users SET plan_tier='pro' WHERE id=$1`, cloner); err != nil {
		t.Fatal(err)
	}
	_, file := bigFile(cloner)
	freeOwner := newBlobTestUser(t, s, "u_clone_cap_free")
	freeSpace, err := s.CreateWorkspace(ctx, freeOwner, WorkspaceCreate{Name: "Free target"})
	if err != nil {
		t.Fatal(err)
	}
	itemCloneMember(t, s, freeSpace.ID, cloner, "editor")
	var tooLarge *FileTooLargeError
	if _, _, err := s.CloneFile(ctx, cloner, file.ID, CloneTarget{WorkspaceID: freeSpace.ID, Name: "big.pdf"}); !errors.As(err, &tooLarge) || tooLarge.LimitBytes != limit {
		t.Fatalf("clone into a Free owner's workspace = %v, want FileTooLargeError at %d", err, limit)
	}
	proSpace, err := s.CreateWorkspace(ctx, cloner, WorkspaceCreate{Name: "Pro target"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.CloneFile(ctx, cloner, file.ID, CloneTarget{WorkspaceID: proSpace.ID, Name: "big.pdf"}); err != nil {
		t.Fatalf("clone into the Pro cloner's own workspace: %v", err)
	}

	// A workspace clone is the cloner's to pay: the big file stays behind.
	freeCloner := newBlobTestUser(t, s, "u_clone_cap")
	source, _ := bigFile(freeCloner)
	if _, err := s.createReadyFile(ctx, source.ID, freeCloner, "small.pdf", "pdf", nil, "", 100, "sources/"+uid("base")); err != nil {
		t.Fatal(err)
	}
	copied, _, skipped, err := s.CloneWorkspaceThumbnails(ctx, freeCloner, source.ID, WorkspaceCreate{Name: "Copy"})
	if err != nil {
		t.Fatalf("workspace clone: %v", err)
	}
	var names []string
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(array_agg(name ORDER BY name), '{}') FROM files WHERE workspace_id=$1`,
		copied.ID).Scan(&names); err != nil {
		t.Fatal(err)
	}
	if skipped != 1 || len(names) != 1 || names[0] != "small.pdf" {
		t.Fatalf("workspace clone copied %q and skipped %d, want small.pdf and 1", names, skipped)
	}
}

// Concurrent clones into one workspace (repeatable read) stay under its file
// cap and share one new chapter: both charge the payer's storage row, so the
// later one fails to serialize and retries on a snapshot holding the first.
func TestConcurrentFileClonesKeepTheCapAndOneChapter(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_clone_race")
	_, file := sourceTestFile(t, s, owner, "race.pdf", "pdf")
	race := func(workspaceID string) []error {
		t.Helper()
		errs := make([]error, 2)
		var wg sync.WaitGroup
		for i := range errs {
			wg.Go(func() {
				_, _, errs[i] = s.CloneFile(ctx, owner, file.ID, CloneTarget{
					WorkspaceID: workspaceID, ChapterName: "Race", Name: fmt.Sprintf("race %d.pdf", i),
				})
			})
		}
		wg.Wait()
		return errs
	}

	full, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Full"})
	if err != nil {
		t.Fatal(err)
	}
	seedWorkspaceFiles(t, s, full.ID, owner, mustPlanLimits(t, s, PlanFree).FilesPerWorkspace-1)
	errs := race(full.ID)
	var limit *FileLimitExceededError
	if (errs[0] == nil) == (errs[1] == nil) || !(errors.As(errs[0], &limit) || errors.As(errs[1], &limit)) {
		t.Fatalf("clones at the cap = %v, want one copy and one file-limit refusal", errs)
	}

	roomy, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Roomy"})
	if err != nil {
		t.Fatal(err)
	}
	if errs := race(roomy.ID); errs[0] != nil || errs[1] != nil {
		t.Fatalf("clones with room = %v", errs)
	}
	var chapters int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM chapters WHERE workspace_id=$1 AND name='Race'`,
		roomy.ID).Scan(&chapters); err != nil {
		t.Fatal(err)
	}
	if chapters != 1 {
		t.Fatalf("chapters named Race = %d, want 1", chapters)
	}
}

// Explore offers Clone by the clone rule: in a public workspace only its
// members and effective editors; a standalone public item to every reader.
func TestExploreCanCloneFollowsTheCloneRule(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_explore_clone_owner")
	member := newBlobTestUser(t, s, "u_explore_clone_member")
	stranger := newBlobTestUser(t, s, "u_explore_clone_stranger")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Public"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public', share_role='viewer' WHERE id=$1`, ws.ID); err != nil {
		t.Fatal(err)
	}
	itemCloneMember(t, s, ws.ID, member, "viewer")
	inWorkspace, err := s.CreateQuiz(ctx, Quiz{UserID: owner, Name: "In workspace", WorkspaceID: ws.ID, WorkspaceName: ws.Name, Questions: json.RawMessage(`[]`), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	standalone, err := s.CreateQuiz(ctx, Quiz{UserID: owner, Name: "Standalone", Questions: json.RawMessage(`[]`), Privacy: PrivacyPublic})
	if err != nil {
		t.Fatal(err)
	}
	canClone := func(userID string) map[string]bool {
		t.Helper()
		quizzes, err := s.ListPublicQuizzes(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]bool{}
		for _, q := range quizzes {
			out[q.ID] = q.CanClone
		}
		return out
	}
	check := func(label, userID string, wantInWorkspace bool) {
		t.Helper()
		got := canClone(userID)
		if got[inWorkspace.ID] != wantInWorkspace || !got[standalone.ID] {
			t.Fatalf("%s: in workspace %v (want %v), standalone %v (want true)",
				label, got[inWorkspace.ID], wantInWorkspace, got[standalone.ID])
		}
	}
	check("member", member, true)
	check("public viewer", stranger, false)
	// A public editor share role carries content authority, so Clone shows.
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET share_role='editor' WHERE id=$1`, ws.ID); err != nil {
		t.Fatal(err)
	}
	check("public editor", stranger, true)
}
