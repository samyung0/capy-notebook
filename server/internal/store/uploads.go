package store

import (
	"context"
	"errors"
	"time"

	"github.com/evonotes/server/internal/sourceupload"
)

var (
	ErrUploadExpired = errors.New("upload session expired")
	ErrUploadState   = errors.New("upload session is not pending")
)

// uploadPresignGrace is how long an abandoned upload's objects wait before the
// reaper takes them. It has to outlast the presigned PUT URL: a request already
// in flight can still create the object after the row is written off, and
// deleting early would leave that object unreferenced and unqueued forever.
const uploadPresignGrace = 24 * time.Hour

type UploadSession struct {
	ID          string
	WorkspaceID string
	// UserID is the storage owner charged for the reservation; CreatedBy is the
	// uploader, which may be a collaborator rather than the workspace owner.
	UserID        string
	CreatedBy     *string
	ChapterID     *string
	ChapterName   string
	ObjectPath    string
	FinalPath     string
	Name          string
	Kind          string
	ContentType   string
	DeclaredSize  int64
	ParseMode     string
	CaptionImages bool
	Status        string
	FileID        *string
	ExpiresAt     time.Time
}

type NewUploadSession struct {
	ID            string
	WorkspaceID   string
	CreatedBy     string
	ChapterID     *string
	ChapterName   string
	ObjectPath    string
	FinalPath     string
	Name          string
	Kind          string
	ContentType   string
	DeclaredSize  int64
	ParseMode     string
	CaptionImages bool
	ExpiresAt     time.Time
}

func (s *Store) CreateUploadSession(ctx context.Context, in NewUploadSession) (UploadSession, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return UploadSession{}, err
	}
	defer tx.Rollback(ctx)
	ownerID, err := s.storageOwnerTx(ctx, tx, in.WorkspaceID)
	if err != nil {
		return UploadSession{}, err
	}
	if err := s.reserveStorageTx(ctx, tx, ownerID, in.DeclaredSize); err != nil {
		return UploadSession{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO upload_sessions
		(id, target, workspace_id, user_id, created_by, chapter_id, chapter_name,
		 object_path, final_path, name, kind, content_type, declared_size, parse_mode,
		 caption_images, expires_at)
		VALUES ($1,'source',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
		in.ID, in.WorkspaceID, ownerID, nullStr(in.CreatedBy), in.ChapterID, in.ChapterName,
		in.ObjectPath, in.FinalPath,
		in.Name, in.Kind, in.ContentType, in.DeclaredSize, in.ParseMode,
		in.CaptionImages, in.ExpiresAt)
	if err != nil {
		return UploadSession{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return UploadSession{}, err
	}
	return s.GetUploadSession(ctx, in.ID)
}

func scanUploadSession(row interface{ Scan(...any) error }) (UploadSession, error) {
	var u UploadSession
	err := row.Scan(&u.ID, &u.WorkspaceID, &u.UserID, &u.CreatedBy, &u.ChapterID, &u.ChapterName, &u.ObjectPath, &u.FinalPath,
		&u.Name, &u.Kind, &u.ContentType, &u.DeclaredSize, &u.ParseMode, &u.CaptionImages,
		&u.Status, &u.FileID, &u.ExpiresAt)
	return u, err
}

const uploadSessionCols = `id, workspace_id, user_id, created_by, chapter_id, chapter_name, object_path, final_path,
	name, kind, content_type, declared_size, parse_mode, caption_images, status, file_id, expires_at`

// uploadSessionFrom restricts the shared table to the source flow, so an
// editor-asset upload id can never be driven through the file finalize path.
const uploadSessionFrom = ` FROM upload_sessions WHERE target='source' AND `

func (s *Store) GetUploadSession(ctx context.Context, id string) (UploadSession, error) {
	u, err := scanUploadSession(s.pool.QueryRow(ctx,
		`SELECT `+uploadSessionCols+uploadSessionFrom+`id=$1`, id))
	if isNoRows(err) {
		return u, ErrNotFound
	}
	return u, err
}

// FinalizeUploadSession creates the source and ingest job exactly once. The
// B2 promotion happens before this transaction and is safe to retry.
func (s *Store) FinalizeUploadSession(ctx context.Context, uploadID, sourceETag, parser, engine string) (File, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return File{}, err
	}
	defer tx.Rollback(ctx)

	var ownerID string
	if err := tx.QueryRow(ctx, `SELECT user_id`+uploadSessionFrom+`id=$1`, uploadID).
		Scan(&ownerID); err != nil {
		if isNoRows(err) {
			return File{}, ErrNotFound
		}
		return File{}, err
	}
	if err := s.lockStorageRowTx(ctx, tx, ownerID); err != nil {
		return File{}, err
	}
	u, err := scanUploadSession(tx.QueryRow(ctx,
		`SELECT `+uploadSessionCols+uploadSessionFrom+`id=$1 FOR UPDATE`, uploadID))
	if isNoRows(err) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, err
	}
	if u.Status == "completed" && u.FileID != nil {
		_ = tx.Rollback(ctx)
		return s.GetFile(ctx, *u.FileID)
	}
	if u.Status != "pending" {
		return File{}, ErrUploadState
	}
	if time.Now().UTC().After(u.ExpiresAt) {
		return File{}, ErrUploadExpired
	}

	chapterID, err := resolveUploadChapterID(ctx, tx, u.WorkspaceID, u.ChapterID, u.ChapterName)
	if err != nil {
		return File{}, err
	}
	fileID := uid("f")
	fileURL := "/api/files/" + fileID + "/raw"
	now := time.Now().UTC()
	ready := !sourceupload.NeedsIngestJob(u.Kind, u.ParseMode)
	status := "processing"
	if ready {
		status = "ready"
	}
	_, err = tx.Exec(ctx, `INSERT INTO files
		(id, workspace_id, user_id, created_by, chapter_id, name, kind, size_bytes, added_at, status, parser, engine, blob_path, url, source_etag)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
		fileID, u.WorkspaceID, u.UserID, u.CreatedBy, chapterID, u.Name, u.Kind, u.DeclaredSize,
		now, status, parser, engine, u.FinalPath, fileURL, sourceETag)
	if err != nil {
		return File{}, err
	}

	if !ready {
		jobID := uid("job")
		actor := ""
		if u.CreatedBy != nil {
			actor = *u.CreatedBy
		}
		payload := s.ingestJobPayload(ctx, actor, map[string]any{
			"fileId": fileID, "workspaceId": u.WorkspaceID, "blobPath": u.FinalPath,
			"kind": u.Kind, "parser": parser, "engine": engine,
			"parseMode": u.ParseMode, "captionImages": u.CaptionImages,
			"sourceETag": sourceETag,
		})
		if _, err := tx.Exec(ctx,
			`INSERT INTO jobs (id, type, payload) VALUES ($1,'ingest',$2)`,
			jobID, payload); err != nil {
			return File{}, err
		}
	}

	if _, err := tx.Exec(ctx, `UPDATE upload_sessions
		SET status='completed', file_id=$2, source_etag=$3, completed_at=now()
		WHERE id=$1`, uploadID, fileID, sourceETag); err != nil {
		return File{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, err
	}
	return File{
		ID: fileID, WorkspaceID: u.WorkspaceID, ChapterID: chapterID,
		Name: u.Name, Kind: FileKind(u.Kind), SizeBytes: u.DeclaredSize,
		AddedAt: now, Status: FileStatus(status), Indexed: false, URL: &fileURL,
	}, nil
}

// SweepExpiredUploads writes off reservations whose presigned window closed
// without a completion. It covers both upload targets, because they share the
// table, and processes each session in its own transaction so one wedged row
// cannot block the batch behind it.
//
// Nothing here talks to the bucket. Expiry only queues object paths; the reaper
// drains that queue, which is also how objects orphaned by cascading deletes get
// collected.
func (s *Store) SweepExpiredUploads(ctx context.Context, limit int) (int, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, target FROM upload_sessions
		WHERE status='pending' AND expires_at < now()
		ORDER BY expires_at LIMIT $1`, limit)
	if err != nil {
		return 0, err
	}
	type staleUpload struct{ id, target string }
	var stale []staleUpload
	for rows.Next() {
		var item staleUpload
		if err := rows.Scan(&item.id, &item.target); err != nil {
			rows.Close()
			return 0, err
		}
		stale = append(stale, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	swept := 0
	var firstErr error
	for _, item := range stale {
		var err error
		if item.target == "editor_asset" {
			err = s.MarkEditorAssetUploadExpired(ctx, item.id)
		} else {
			err = s.MarkUploadExpired(ctx, item.id)
		}
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		swept++
	}
	return swept, firstErr
}

// MarkUploadExpired releases a source reservation and queues both of its object
// paths in the same transaction, so the accounting change and the cleanup that
// pays for it commit together.
func (s *Store) MarkUploadExpired(ctx context.Context, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var userID string
	err = tx.QueryRow(ctx, `SELECT user_id`+uploadSessionFrom+
		`id=$1 AND status='pending'`, id).Scan(&userID)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := s.lockStorageRowTx(ctx, tx, userID); err != nil {
		return err
	}
	var objectPath, finalPath string
	err = tx.QueryRow(ctx, `UPDATE upload_sessions SET status='expired'
		WHERE id=$1 AND status='pending'
		RETURNING object_path, final_path`, id).Scan(&objectPath, &finalPath)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := s.EnqueueBlobDeletionTx(ctx, tx, uploadPresignGrace,
		objectPath, finalPath); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// PruneUploadSessions drops sessions that have outlived their usefulness as an
// idempotency record. The delete trigger re-queues their paths, which is a no-op
// for a completed session because the file that took over final_path holds the
// reference.
func (s *Store) PruneUploadSessions(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM upload_sessions
		WHERE (status='completed' AND completed_at < now() - interval '30 days')
		   OR (status='expired' AND expires_at < now() - interval '7 days')`)
	return err
}
