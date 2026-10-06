package store

import (
	"context"
	"time"
)

// createReadyFile inserts a ready source with no ingest job, through the
// editor, storage and file-count gates an upload passes. Test fixture only.
func (s *Store) createReadyFile(ctx context.Context, wsID, createdBy, name, kind string, chapterID *string, chapterName string, sizeBytes int64, blobPath string) (File, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return File{}, err
	}
	defer tx.Rollback(ctx)

	ownerID, err := s.lockWorkspaceEditorMutationTx(ctx, tx, wsID, createdBy)
	if err != nil {
		return File{}, err
	}
	chapterID, err = resolveUploadChapterID(ctx, tx, wsID, chapterID, chapterName)
	if err != nil {
		return File{}, err
	}
	if err := s.gateStorageTx(ctx, tx, ownerID, sizeBytes); err != nil {
		return File{}, err
	}
	if err := s.gateWorkspaceFilesTx(ctx, tx, wsID, 1); err != nil {
		return File{}, err
	}
	fileID := uid("f")
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `INSERT INTO files
		(id, workspace_id, user_id, created_by, chapter_id, name, kind, size_bytes, added_at, status, blob_path)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10)`,
		fileID, wsID, ownerID, nullStr(createdBy), chapterID, name, kind, sizeBytes, now, blobPath); err != nil {
		return File{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, err
	}
	file := File{ID: fileID, WorkspaceID: wsID, ChapterID: chapterID, Name: name, Kind: FileKind(kind), SizeBytes: sizeBytes, AddedAt: now, Status: "ready", Indexed: false, HasBytes: blobPath != "", Revision: 1}
	if FileKind(kind) == FilePDF && blobPath != "" {
		previewURL := "/api/files/" + fileID + "/preview"
		file.PreviewURL = &previewURL
	}
	return file, nil
}

// createSourceWithJob runs createSourceWithJobTx in its own transaction.
func (s *Store) createSourceWithJob(ctx context.Context, wsID, createdBy, name, kind string, chapterID *string, chapterName string, sizeBytes int64, blobPath, parser, parseMode string) (File, string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return File{}, "", err
	}
	defer tx.Rollback(ctx)
	f, jobID, err := s.createSourceWithJobTx(ctx, tx, wsID, createdBy, name, kind, chapterID, chapterName, sizeBytes, blobPath, parser, parseMode, nil)
	if err != nil {
		return File{}, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, "", err
	}
	return f, jobID, nil
}
