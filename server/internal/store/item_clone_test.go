package store

import (
	"context"
	"errors"
	"strings"
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
	if err := s.pool.QueryRow(ctx, `SELECT f.user_id, d.user_id, convert_from(d.state,'UTF8'), d.base_revision, f.revision
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
