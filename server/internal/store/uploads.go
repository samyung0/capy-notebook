package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
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
	UserID       string
	CreatedBy    *string
	ChapterID    *string
	ChapterName  string
	ObjectPath   string
	FinalPath    string
	Name         string
	Kind         string
	ContentType  string
	DeclaredSize int64
	ParseMode    string
	Status       string
	FileID       *string
	ExpiresAt    time.Time
}

type NewUploadSession struct {
	ID           string
	WorkspaceID  string
	CreatedBy    string
	ChapterID    *string
	ChapterName  string
	ObjectPath   string
	FinalPath    string
	Name         string
	Kind         string
	ContentType  string
	DeclaredSize int64
	ParseMode    string
	ExpiresAt    time.Time
	BatchID      string
}

// OpenSourceBatch records a submission's batch on its first upload reservation
// or import request and touches it on later ones. A batch id held by another
// actor, workspace or source conflicts.
func (s *Store) OpenSourceBatch(ctx context.Context, id, workspaceID, userID, source string, total int) error {
	err := s.pool.QueryRow(ctx, `INSERT INTO source_batches (id, workspace_id, user_id, source, total)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (id) DO UPDATE SET updated_at=now()
		WHERE source_batches.workspace_id=$2 AND source_batches.user_id=$3
			AND source_batches.source=$4
		RETURNING id`, id, workspaceID, userID, source, total).Scan(&id)
	if isNoRows(err) {
		return ErrConflict
	}
	return err
}

// FailSourceBatchFile counts a refused reservation or import request as a
// failed file.
func (s *Store) FailSourceBatchFile(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `SELECT source_batch_settle($1, 0, 1)`, id)
	return err
}

// SourceBatchIdle closes batches idle this long, counting their unsettled files
// as failed (tab closed, file never sent).
const SourceBatchIdle = time.Hour

// SettleSourceBatches closes idle batches, then takes the batches that have
// notified: their rows are deleted and their notifications returned for the
// live push. A late file of a deleted batch settles nothing.
func (s *Store) SettleSourceBatches(ctx context.Context) ([]Notification, error) {
	if _, err := s.pool.Exec(ctx, `SELECT source_batch_settle(id, 0, total-done-failed)
		FROM (SELECT id, total, done, failed FROM source_batches
			WHERE notified_at IS NULL AND updated_at < now() - make_interval(secs => $1)
			ORDER BY updated_at LIMIT 100) idle`, SourceBatchIdle.Seconds()); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `WITH taken AS (
			DELETE FROM source_batches WHERE id IN (
				SELECT id FROM source_batches WHERE notified_at IS NOT NULL
				LIMIT 100 FOR UPDATE SKIP LOCKED)
			RETURNING notification_id)
		SELECT n.id, n.kind, n.data, COALESCE(n.href,''), n.at, n.user_id, COALESCE(n.workspace_id,'')
		FROM taken JOIN notifications n ON n.id=taken.notification_id`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Notification, error) {
		var n Notification
		err := row.Scan(&n.ID, &n.Kind, &n.Data, &n.Href, &n.At, &n.UserID, &n.WorkspaceID)
		return n, err
	})
}

func (s *Store) CreateUploadSession(ctx context.Context, in NewUploadSession) (UploadSession, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return UploadSession{}, err
	}
	defer tx.Rollback(ctx)
	ownerID, err := s.lockWorkspaceEditorMutationTx(
		ctx, tx, in.WorkspaceID, in.CreatedBy,
	)
	if err != nil {
		return UploadSession{}, err
	}
	if err := s.reserveStorageTx(ctx, tx, ownerID, in.DeclaredSize); err != nil {
		return UploadSession{}, err
	}
	if err := s.gateWorkspaceFilesTx(ctx, tx, in.WorkspaceID, 1); err != nil {
		return UploadSession{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO upload_sessions
		(id, target, workspace_id, user_id, created_by, chapter_id, chapter_name,
		 object_path, final_path, name, kind, content_type, declared_size, reserved_size, parse_mode,
		 expires_at, batch_id)
		VALUES ($1,'source',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$15)`,
		in.ID, in.WorkspaceID, ownerID, nullStr(in.CreatedBy), in.ChapterID, in.ChapterName,
		in.ObjectPath, in.FinalPath,
		in.Name, in.Kind, in.ContentType, in.DeclaredSize, in.ParseMode,
		in.ExpiresAt, nullStr(in.BatchID))
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
		&u.Name, &u.Kind, &u.ContentType, &u.DeclaredSize, &u.ParseMode,
		&u.Status, &u.FileID, &u.ExpiresAt)
	return u, err
}

const uploadSessionCols = `id, workspace_id, user_id, created_by, chapter_id, chapter_name, object_path, final_path,
	name, kind, content_type, declared_size, parse_mode, status, file_id, expires_at`

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

// FinalizeUploadSession creates the source and its first pipeline job exactly once. The
// B2 promotion happens before this transaction and is safe to retry.
func (s *Store) FinalizeUploadSession(ctx context.Context, uploadID, sourceETag, parser string) (File, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return File{}, err
	}
	defer tx.Rollback(ctx)

	var workspaceID string
	if err := tx.QueryRow(ctx, `SELECT workspace_id`+uploadSessionFrom+`id=$1`, uploadID).
		Scan(&workspaceID); err != nil {
		if isNoRows(err) {
			return File{}, ErrNotFound
		}
		return File{}, err
	}
	ownerID, err := s.storageOwnerTx(ctx, tx, workspaceID)
	if err != nil {
		return File{}, err
	}
	var createdBy *string
	var storedOwnerID string
	if err := tx.QueryRow(ctx, `SELECT user_id, created_by`+uploadSessionFrom+`id=$1`, uploadID).
		Scan(&storedOwnerID, &createdBy); err != nil {
		if isNoRows(err) {
			return File{}, ErrNotFound
		}
		return File{}, err
	}
	if storedOwnerID != ownerID {
		return File{}, ErrUploadState
	}
	actorID := ""
	if createdBy != nil {
		actorID = *createdBy
	}
	ownerID, err = s.lockWorkspaceEditorMutationTx(ctx, tx, workspaceID, actorID)
	if err != nil {
		return File{}, err
	}
	if err := s.lockStorageRowTx(ctx, tx, ownerID); err != nil {
		return File{}, err
	}

	file, err := s.finalizeUploadSessionTx(
		ctx, tx, uploadID, sourceETag, parser,
	)
	if err != nil {
		return File{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, err
	}
	return file, nil
}

func (s *Store) finalizeUploadSessionTx(
	ctx context.Context,
	tx pgx.Tx,
	uploadID, sourceETag, parser string,
) (File, error) {
	u, err := scanUploadSession(tx.QueryRow(ctx,
		`SELECT `+uploadSessionCols+uploadSessionFrom+`id=$1 FOR UPDATE`, uploadID))
	if isNoRows(err) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, err
	}
	if u.Status == "completed" && u.FileID != nil {
		file, err := scanFile(tx.QueryRow(ctx,
			`SELECT `+fileCols+` FROM files WHERE id=$1`, *u.FileID))
		if isNoRows(err) {
			return File{}, ErrNotFound
		}
		return file, err
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
	now := time.Now().UTC()
	processingPlan, err := sourceupload.BuildProcessingPlan(u.Name, u.Kind, u.ParseMode)
	if err != nil {
		return File{}, err
	}
	ready := processingPlan.Route == sourceupload.RouteStoreOnly
	status := "pending"
	if ready {
		status = "ready"
	}
	_, err = tx.Exec(ctx, `INSERT INTO files
		(id, workspace_id, user_id, created_by, chapter_id, name, kind, size_bytes, added_at, status, parser, blob_path, source_etag, parse_mode, batch_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
			(SELECT batch_id FROM upload_sessions WHERE id=$15))`,
		fileID, u.WorkspaceID, u.UserID, u.CreatedBy, chapterID, u.Name, u.Kind, u.DeclaredSize,
		now, status, parser, u.FinalPath, sourceETag, u.ParseMode, u.ID)
	if err != nil {
		return File{}, err
	}

	if !ready {
		jobID := uid("job")
		actor := ""
		if u.CreatedBy != nil {
			actor = *u.CreatedBy
		}
		reservationID, err := s.beginIngestSpendTx(ctx, tx, actor, u.WorkspaceID)
		if err != nil {
			return File{}, err
		}
		payload, err := s.ingestJobPayload(ctx, tx, actor, map[string]any{
			"fileId": fileID, "workspaceId": u.WorkspaceID, "blobPath": u.FinalPath,
			"kind": u.Kind, "parser": parser,
			"parseMode":      u.ParseMode,
			"processingPlan": processingPlan,
			"sourceETag":     sourceETag,
			"sourceRevision": int64(1),
			"reservationId":  reservationID,
		})
		if err != nil {
			return File{}, err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO jobs (id, type, payload) VALUES ($1,$2,$3)`,
			jobID, initialPipelineJobType(processingPlan), payload); err != nil {
			return File{}, err
		}
	}

	if _, err := tx.Exec(ctx, `UPDATE upload_sessions
		SET status='completed', file_id=$2, source_etag=$3, completed_at=now()
		WHERE id=$1`, uploadID, fileID, sourceETag); err != nil {
		return File{}, err
	}
	file := File{
		ID: fileID, WorkspaceID: u.WorkspaceID, ChapterID: chapterID,
		Name: u.Name, Kind: FileKind(u.Kind), SizeBytes: u.DeclaredSize,
		AddedAt: now, Status: FileStatus(status), Indexed: false, HasBytes: u.FinalPath != "", Revision: 1,
	}
	if ready && FileKind(u.Kind) == FilePDF {
		previewURL := "/api/files/" + fileID + "/preview"
		file.PreviewURL = &previewURL
	}
	return file, nil
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
	err = tx.QueryRow(ctx, `SELECT user_id FROM upload_sessions
		WHERE target='source' AND id=$1 AND status='pending'`, id).Scan(&userID)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := s.lockStorageRowTx(ctx, tx, userID); err != nil {
		return err
	}
	var objectPath, finalPath, attemptObjectPath string
	err = tx.QueryRow(ctx, `UPDATE upload_sessions SET status='expired'
		WHERE id=$1 AND status='pending'
		RETURNING object_path, final_path`, id).Scan(&objectPath, &finalPath)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `SELECT COALESCE(attempt_object_path,'')
		FROM source_import_jobs WHERE upload_session_id=$1`, id).
		Scan(&attemptObjectPath); err != nil && !isNoRows(err) {
		return err
	}
	if err := s.EnqueueBlobDeletionTx(ctx, tx, uploadPresignGrace,
		objectPath, finalPath, attemptObjectPath); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE source_import_jobs
		SET status='failed', completed_at=now(), lease_token=NULL,
			lease_expires_at=NULL, attempt_object_path=NULL,
			last_error_code='import_expired',
			last_error='source import expired before completion', updated_at=now()
		WHERE upload_session_id=$1
			AND status NOT IN ('succeeded','failed','cancelled')`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// PruneUploadSessions drops sessions that have outlived their usefulness as an
// idempotency record. The delete trigger re-queues their paths, which is a no-op
// for a completed session because the file that took over final_path holds the
// reference.
func (s *Store) PruneUploadSessions(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM upload_sessions
		WHERE (status='completed' AND completed_at < now() - interval '30 days')
		   OR (status='expired' AND expires_at < now() - interval '7 days')`); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM source_import_requests
		WHERE completed_at < now() - interval '30 days'
		   OR (response IS NULL AND created_at < now() - interval '1 day')`)
	return err
}
