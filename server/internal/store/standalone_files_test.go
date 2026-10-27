package store

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// uploadStandaloneFile stores a store-only upload with no workspace for owner.
func uploadStandaloneFile(t *testing.T, s *Store, owner string, size int64) File {
	t.Helper()
	ctx := context.Background()
	upload, err := s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), CreatedBy: owner,
		ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "archive.zip", Kind: "unknown", ContentType: "application/zip",
		DeclaredSize: size, ParseMode: "none", ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.FinalizeUploadSession(ctx, owner, upload.ID, "etag", "", "")
	if err != nil {
		t.Fatal(err)
	}
	return file
}

func listedFileIDs(t *testing.T, s *Store, userID string, f FileListFilter) []string {
	t.Helper()
	page, err := s.ListOwnedFiles(context.Background(), userID, f)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(page.Items))
	for _, file := range page.Items {
		ids = append(ids, file.ID)
	}
	return ids
}

// A standalone upload (Epo 2026-10-27) is its uploader's alone: charged to it,
// readable and editable by it, listed for it, and reachable by no one else.
func TestStandaloneUploadBelongsToItsUploader(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_standalone_owner")
	other := newBlobTestUser(t, s, "u_standalone_other")

	file := uploadStandaloneFile(t, s, owner, 300)
	if file.WorkspaceID != "" || file.Status != FileReady {
		t.Fatalf("file = %+v, want ready with no workspace", file)
	}
	usage, err := s.StorageUsage(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if usage.UsedBytes < 300 {
		t.Fatalf("owner used=%d, want the file charged", usage.UsedBytes)
	}

	if role, err := s.FileEffectiveRole(ctx, owner, file.ID); err != nil || role != RoleOwner {
		t.Fatalf("owner role = %q, %v", role, err)
	}
	if _, err := s.FileEffectiveRole(ctx, other, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other user's role = %v, want not found", err)
	}

	if ids := listedFileIDs(t, s, owner, FileListFilter{Locations: []string{"standalone"}}); !slices.Contains(ids, file.ID) {
		t.Fatalf("owner's standalone listing = %v, want %s", ids, file.ID)
	}
	if ids := listedFileIDs(t, s, owner, FileListFilter{Locations: []string{"workspace"}}); slices.Contains(ids, file.ID) {
		t.Fatalf("owner's workspace listing holds the standalone file")
	}
	if ids := listedFileIDs(t, s, owner, FileListFilter{Member: true}); !slices.Contains(ids, file.ID) {
		t.Fatalf("owner's recent listing = %v, want %s", ids, file.ID)
	}
	if ids := listedFileIDs(t, s, other, FileListFilter{Member: true}); slices.Contains(ids, file.ID) {
		t.Fatalf("another user's recent listing holds the standalone file")
	}

	renamed := "renamed.zip"
	if got, err := s.UpdateFile(ctx, owner, file.ID, FilePatch{Name: &renamed}); err != nil || got.Name != renamed {
		t.Fatalf("owner rename = %+v, %v", got, err)
	}
	if _, err := s.UpdateFile(ctx, other, file.ID, FilePatch{Name: &renamed}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other rename = %v, want not found", err)
	}
}

// Its owner trashes, restores and purges a standalone file; nobody else can.
func TestStandaloneFileTrashLifecycle(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_standalone_trash_owner")
	other := newBlobTestUser(t, s, "u_standalone_trash_other")
	file := uploadStandaloneFile(t, s, owner, 200)

	if _, err := s.TrashFile(ctx, other, file.ID, AgentOperation{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other trash = %v, want not found", err)
	}
	trashed, err := s.TrashFile(ctx, owner, file.ID, AgentOperation{})
	if err != nil {
		t.Fatal(err)
	}
	page, err := s.ListTrash(ctx, owner, "", 50, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != file.ID || page.Items[0].WorkspaceID != "" || !page.Items[0].CanRestore {
		t.Fatalf("owner trash = %+v", page.Items)
	}
	episode := trashed.Effect.TrashEpisodeID
	if _, err := s.RestoreTrashed(ctx, owner, agenttools.KindSourceFile, file.ID, episode, AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	again, err := s.TrashFile(ctx, owner, file.ID, AgentOperation{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PurgeTrashed(ctx, owner, agenttools.KindSourceFile, file.ID, again.Effect.TrashEpisodeID, AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	var left bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM files WHERE id=$1)`, file.ID).Scan(&left); err != nil || left {
		t.Fatalf("purged file still there: %v, %v", left, err)
	}
}

// Its owner copies a standalone file standalone; another user cannot copy it.
func TestStandaloneFileCloneStaysWithItsOwner(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_standalone_clone_owner")
	other := newBlobTestUser(t, s, "u_standalone_clone_other")
	file := uploadStandaloneFile(t, s, owner, 100)

	copied, _, err := s.CloneFile(ctx, owner, file.ID, CloneTarget{Name: "copy.zip"})
	if err != nil {
		t.Fatal(err)
	}
	if copied.WorkspaceID != "" || copied.ID == file.ID {
		t.Fatalf("copy = %+v, want a standalone copy", copied)
	}
	if _, _, err := s.CloneFile(ctx, other, file.ID, CloneTarget{Name: "theirs.zip"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other clone = %v, want not found", err)
	}
}

// Account deletion's cleanup releases a pending standalone reservation, which
// the workspaces join used to miss.
func TestAccountDeletionCancelsStandaloneUpload(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_standalone_deleted")
	upload, err := s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), CreatedBy: owner,
		ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "archive.zip", Kind: "unknown", ContentType: "application/zip",
		DeclaredSize: 100, ParseMode: "none", ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `SELECT cancel_user_async_work($1)`, owner); err != nil {
		t.Fatal(err)
	}
	var left bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM upload_sessions WHERE id=$1)`, upload.ID).Scan(&left); err != nil || left {
		t.Fatalf("pending standalone upload kept: %v, %v", left, err)
	}
}

// A standalone file's owner-scoped index goes with the file: the composite
// (id, workspace_id) keys skip a NULL workspace, so 0125's single-column keys
// carry the cascade.
func TestStandaloneFileIndexGoesWithTheFile(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_standalone_index")
	file := uploadStandaloneFile(t, s, owner, 100)
	content := uid("rgc")
	if _, err := s.pool.Exec(ctx, `INSERT INTO rag_contents (id, user_id, content_hash, status) VALUES ($1,$2,'h','ready')`, content, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO rag_file_contents (file_id, content_id) VALUES ($1,$2)`, file.ID, content); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM files WHERE id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	var left bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM rag_contents WHERE id=$1)`, content).Scan(&left); err != nil || left {
		t.Fatalf("standalone content kept after its file: %v, %v", left, err)
	}
}

// uploadWorkspaceFile stores a store-only upload by actor into wsID.
func uploadWorkspaceFile(t *testing.T, s *Store, actor, wsID string) File {
	t.Helper()
	ctx := context.Background()
	upload, err := s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), WorkspaceID: wsID, CreatedBy: actor,
		ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "notes.zip", Kind: "unknown", ContentType: "application/zip",
		DeclaredSize: 100, ParseMode: "none", ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.FinalizeUploadSession(ctx, actor, upload.ID, "etag", "", "")
	if err != nil {
		t.Fatal(err)
	}
	return file
}

// A standalone file moves into a workspace its owner edits (Epo
// 2026-10-27): same file, same payer, its index carried into the workspace's
// space without processing again.
func TestStandaloneFileMovesIntoAWorkspaceWithItsIndex(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_move_owner")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Target", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	file := uploadStandaloneFile(t, s, owner, 100)
	content := uid("rgc")
	if _, err := s.pool.Exec(ctx, `INSERT INTO rag_contents
		(id, user_id, content_hash, status, embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim)
		SELECT $1, $2, 'h', 'ready', embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim
		FROM workspaces WHERE id=$3`, content, owner, ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO rag_file_contents (file_id, content_id) VALUES ($1,$2)`, file.ID, content); err != nil {
		t.Fatal(err)
	}

	moved, err := s.MoveFiles(ctx, owner, []string{file.ID}, MoveTarget{WorkspaceID: ws.ID, ChapterName: "Imported"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(moved) != 1 || moved[0].ID != file.ID || moved[0].WorkspaceID != ws.ID || moved[0].ChapterID == nil {
		t.Fatalf("moved = %+v, want the same file in a new chapter of the workspace", moved)
	}
	var aliasWorkspace, payer string
	if err := s.pool.QueryRow(ctx, `SELECT fc.workspace_id, f.user_id FROM rag_file_contents fc
		JOIN rag_contents rc ON rc.id=fc.content_id AND rc.workspace_id=$2
		JOIN files f ON f.id=fc.file_id WHERE fc.file_id=$1`, file.ID, ws.ID).Scan(&aliasWorkspace, &payer); err != nil {
		t.Fatalf("index not carried into the workspace: %v", err)
	}
	if payer != owner {
		t.Fatalf("payer = %s, want the uploader %s", payer, owner)
	}
	var oldLeft bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM rag_contents WHERE id=$1)`, content).Scan(&oldLeft); err != nil || oldLeft {
		t.Fatalf("owner-scoped content kept after the move: %v, %v", oldLeft, err)
	}
}

// Between workspaces the source owner or the payer moves a file, an editor
// who is neither cannot, and progress there goes only once confirmed.
func TestWorkspaceFileMoveAuthorityAndProgressLoss(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_move_src_owner")
	member := newBlobTestUser(t, s, "u_move_member")
	editor := newBlobTestUser(t, s, "u_move_editor")
	src, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Source", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	dst, err := s.CreateWorkspace(ctx, member, WorkspaceCreate{Name: "Mine", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	addWorkspaceEditor(t, s, src.ID, member)
	addWorkspaceEditor(t, s, src.ID, editor)
	addWorkspaceEditor(t, s, dst.ID, editor)
	file := uploadWorkspaceFile(t, s, member, src.ID)
	if _, err := s.pool.Exec(ctx, `INSERT INTO study_progress (user_id, workspace_id, file_id, state) VALUES ($1,$2,$3,'done')`,
		owner, src.ID, file.ID); err != nil {
		t.Fatal(err)
	}

	if _, err := s.MoveFiles(ctx, editor, []string{file.ID}, MoveTarget{WorkspaceID: dst.ID}, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("editor move = %v, want not found", err)
	}
	var loss *ProgressLossError
	if _, err := s.MoveFiles(ctx, member, []string{file.ID}, MoveTarget{WorkspaceID: dst.ID}, false); !errors.As(err, &loss) || loss.People != 1 {
		t.Fatalf("unconfirmed move = %v, want one person's progress reported", err)
	}
	moved, err := s.MoveFiles(ctx, member, []string{file.ID}, MoveTarget{WorkspaceID: dst.ID}, true)
	if err != nil {
		t.Fatal(err)
	}
	if moved[0].WorkspaceID != dst.ID {
		t.Fatalf("moved = %+v", moved[0])
	}
	var progressLeft bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM study_progress WHERE file_id=$1)`, file.ID).Scan(&progressLeft); err != nil || progressLeft {
		t.Fatalf("progress kept after a confirmed move: %v, %v", progressLeft, err)
	}
}

// indexFile gives file a ready alias onto content scoped to wsID (or, with
// no workspace, to owner) in wsPinOf's embedding space.
func indexFile(t *testing.T, s *Store, fileID, wsID, owner, wsPinOf, hash string) string {
	t.Helper()
	content := uid("rgc")
	var scopeWS, scopeUser any
	if wsID != "" {
		scopeWS = wsID
	} else {
		scopeUser = owner
	}
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx, `INSERT INTO rag_contents
		(id, workspace_id, user_id, content_hash, status, embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim)
		SELECT $1, $2, $3, $4, 'ready', embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim
		FROM workspaces WHERE id=$5`, content, scopeWS, scopeUser, hash, wsPinOf); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO rag_file_contents (file_id, workspace_id, content_id) VALUES ($1,$2,$3)`,
		fileID, scopeWS, content); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE files SET indexed=true, content_hash=$2 WHERE id=$1`, fileID, hash); err != nil {
		t.Fatal(err)
	}
	return content
}

// R1 and R2 of the 2026-10-27 review: an indexed workspace file moves with
// its index into the target's space, and no thumbnail key names a file of
// another workspace afterwards.
func TestIndexedWorkspaceFileMovesWithItsIndexAndOwnThumbnailsOnly(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_move_indexed")
	src, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "From", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	dst, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "To", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	moved := uploadWorkspaceFile(t, s, owner, src.ID)
	sibling := uploadWorkspaceFile(t, s, owner, src.ID)
	lender := uploadWorkspaceFile(t, s, owner, src.ID)
	content := indexFile(t, s, moved.ID, src.ID, owner, src.ID, "h-moved")
	// moved borrows lender's key; sibling borrows moved's own key.
	for _, row := range []struct{ id, key string }{
		{moved.ID, "thumbs/" + lender.ID + "/a.webp"},
		{sibling.ID, "thumbs/" + moved.ID + "/b.webp"},
	} {
		if _, err := s.pool.Exec(ctx, `UPDATE files SET thumbnail_key=$2 WHERE id=$1`, row.id, row.key); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := s.MoveFiles(ctx, owner, []string{moved.ID}, MoveTarget{WorkspaceID: dst.ID}, false); err != nil {
		t.Fatal(err)
	}
	var aliasWS string
	if err := s.pool.QueryRow(ctx, `SELECT fc.workspace_id FROM rag_file_contents fc
		JOIN rag_contents rc ON rc.id=fc.content_id AND rc.workspace_id=$2 AND rc.status='ready'
		WHERE fc.file_id=$1`, moved.ID, dst.ID).Scan(&aliasWS); err != nil {
		t.Fatalf("index not carried into the target: %v", err)
	}
	var oldLeft bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM rag_contents WHERE id=$1)`, content).Scan(&oldLeft); err != nil || oldLeft {
		t.Fatalf("source content kept after the move: %v, %v", oldLeft, err)
	}
	var movedKey, siblingKey *string
	if err := s.pool.QueryRow(ctx, `SELECT (SELECT thumbnail_key FROM files WHERE id=$1), (SELECT thumbnail_key FROM files WHERE id=$2)`,
		moved.ID, sibling.ID).Scan(&movedKey, &siblingKey); err != nil {
		t.Fatal(err)
	}
	if movedKey != nil || siblingKey != nil {
		t.Fatalf("keys naming another workspace's file kept: moved=%v sibling=%v", movedKey, siblingKey)
	}
}

// R8, R9 and R10: who may move is answered before a file's state, a file
// still processing stays put, and only started or finished progress asks.
func TestMoveRefusalsComeInOrder(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_move_order_owner")
	stranger := newBlobTestUser(t, s, "u_move_order_stranger")
	src, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "From", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	dst, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "To", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := s.CreateWorkspace(ctx, stranger, WorkspaceCreate{Name: "Theirs", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	file := uploadWorkspaceFile(t, s, owner, src.ID)
	if _, err := s.pool.Exec(ctx, `INSERT INTO jobs (id, type, payload) VALUES ($1,'source_refresh',jsonb_build_object('fileId',$2::text))`,
		uid("job"), file.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.MoveFiles(ctx, stranger, []string{file.ID}, MoveTarget{WorkspaceID: theirs.ID}, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger move of a busy file = %v, want not found", err)
	}
	if _, err := s.MoveFiles(ctx, owner, []string{file.ID}, MoveTarget{WorkspaceID: dst.ID}, true); !errors.Is(err, ErrFileProcessing) {
		t.Fatalf("move during a source refresh = %v, want processing", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE jobs SET status='done' WHERE payload->>'fileId'=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO study_progress (user_id, workspace_id, file_id, state) VALUES ($1,$2,$3,'removed')`,
		owner, src.ID, file.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.MoveFiles(ctx, owner, []string{file.ID}, MoveTarget{WorkspaceID: dst.ID}, false); err != nil {
		t.Fatalf("move with only removed progress = %v, want no confirmation", err)
	}
}

// R3: a standalone import's status answers its owner alone.
func TestStandaloneImportStatusIsTheOwnersAlone(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_import_status_owner")
	other := newBlobTestUser(t, s, "u_import_status_other")
	uploadID := uid("up")
	created, err := s.CreateSourceImports(ctx, []NewSourceImport{{
		JobID: uid("imp"),
		Upload: NewUploadSession{
			ID: uploadID, CreatedBy: owner,
			ObjectPath: "incoming/" + uploadID + "/file.pdf", FinalPath: "sources/" + uid("blob") + ".pdf",
			Name: "file.pdf", Kind: "pdf", ContentType: "application/pdf",
			DeclaredSize: 100, ParseMode: "none", ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
		Provider: "google", ProviderFileID: "drive-file", MaxBytes: 1000, IdempotencyKey: uid("ireq"), TraceID: "trace",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetSourceImport(ctx, "", owner, created[0].ID); err != nil {
		t.Fatalf("owner status = %v", err)
	}
	if _, err := s.GetSourceImport(ctx, "", other, created[0].ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other user's status = %v, want not found", err)
	}
}

// R12: purging an account takes its standalone files' job history with them.
func TestPurgeTakesStandaloneFileJobs(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_purge_standalone")
	file := uploadStandaloneFile(t, s, owner, 100)
	job := uid("job")
	if _, err := s.pool.Exec(ctx, `INSERT INTO jobs (id, type, status, payload)
		VALUES ($1,'ingest','done',jsonb_build_object('fileId',$2::text,'actorUserId',$3::text))`, job, file.ID, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, owner, true); err != nil {
		t.Fatal(err)
	}
	if err := s.PurgeUser(ctx, owner); err != nil {
		t.Fatal(err)
	}
	var left bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1)`, job).Scan(&left); err != nil || left {
		t.Fatalf("standalone job kept after purge: %v, %v", left, err)
	}
}
