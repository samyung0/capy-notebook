package store

import (
	"context"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

// BlankFileDraft is a blank Office file the Create tab made, already in the
// blob store at BlobPath.
type BlankFileDraft struct {
	WorkspaceID, ActorUserID, Name, Kind string
	ChapterID                            *string
	SizeBytes                            int64
	BlobPath, Parser, SHA256             string
}

// CreateBlankFile records a blank Office file as a stored source that is not
// processed (parse mode none), so it costs no credits and lands ready and not
// indexed; the Indexing tab processes it later like any store-only upload.
// It takes an upload's gates: the actor edits the workspace and its account
// may add bytes, the actor pays (uploader pays) within its storage, and the
// workspace has room for one more file.
func (s *Store) CreateBlankFile(ctx context.Context, d BlankFileDraft) (File, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return File{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := s.lockWorkspaceEditorMutationTx(ctx, tx, d.WorkspaceID, d.ActorUserID); err != nil {
		return File{}, err
	}
	chapterID, err := resolveUploadChapterID(ctx, tx, d.WorkspaceID, d.ChapterID, "")
	if err != nil {
		return File{}, err
	}
	if err := s.gateStorageTx(ctx, tx, d.ActorUserID, d.SizeBytes); err != nil {
		return File{}, err
	}
	if err := s.gateWorkspaceFilesTx(ctx, tx, d.WorkspaceID, 1); err != nil {
		return File{}, err
	}
	fileID := uid("f")
	if _, err := tx.Exec(ctx, `INSERT INTO files
		(id, workspace_id, user_id, created_by, chapter_id, name, kind, size_bytes, added_at, status, parser, blob_path, parse_mode, source_sha256)
		VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,'ready',$9,$10,$11,$12)`,
		fileID, d.WorkspaceID, d.ActorUserID, chapterID, d.Name, d.Kind, d.SizeBytes, time.Now().UTC(),
		d.Parser, d.BlobPath, sourceupload.ParseModeNone, d.SHA256); err != nil {
		return File{}, err
	}
	if err := markCreatedTx(ctx, tx, d.ActorUserID, OpenFile, fileID); err != nil {
		return File{}, err
	}
	// Read before the commit, so nothing that can fail runs after it: the
	// caller deletes the object on any error.
	file, err := scanFile(tx.QueryRow(ctx, `SELECT `+fileCols+` FROM files WHERE id=$1`, fileID))
	if err != nil {
		return File{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, err
	}
	return file, nil
}
