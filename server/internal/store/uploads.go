package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

var (
	ErrUploadExpired        = errors.New("upload session expired")
	ErrUploadState          = errors.New("upload session is not pending")
	ErrFileRevisionConflict = errors.New("file changed after the editor opened")
	ErrFileNotReady         = errors.New("file is not ready to edit")
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
	UserID           string
	CreatedBy        *string
	ChapterID        *string
	ChapterName      string
	ObjectPath       string
	FinalPath        string
	Name             string
	Kind             string
	ContentType      string
	DeclaredSize     int64
	ReservedSize     int64
	ParseMode        string
	CaptionImages    bool
	Status           string
	FileID           *string
	ExpectedRevision *int64
	ExpiresAt        time.Time
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

type NewReplacementUploadSession struct {
	ID               string
	FileID           string
	CreatedBy        string
	ObjectPath       string
	FinalPath        string
	ContentType      string
	DeclaredSize     int64
	ExpectedRevision int64
	ExpiresAt        time.Time
}

// FileIngestPolicy returns the persisted processing choice that a replacement
// inherits. Store-only files must not be blocked by an empty inference budget.
func (s *Store) FileIngestPolicy(ctx context.Context, fileID string) (name, kind, parseMode string, err error) {
	err = s.pool.QueryRow(ctx,
		`SELECT name, kind, parse_mode FROM files WHERE id=$1`, fileID,
	).Scan(&name, &kind, &parseMode)
	if isNoRows(err) {
		return "", "", "", ErrNotFound
	}
	return name, kind, parseMode, err
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
		 caption_images, expires_at)
		VALUES ($1,'source',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$15)`,
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

func (s *Store) CreateReplacementUploadSession(
	ctx context.Context,
	in NewReplacementUploadSession,
) (UploadSession, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return UploadSession{}, err
	}
	defer tx.Rollback(ctx)

	var workspaceID string
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM files WHERE id=$1`, in.FileID).
		Scan(&workspaceID); err != nil {
		if isNoRows(err) {
			return UploadSession{}, ErrNotFound
		}
		return UploadSession{}, err
	}
	ownerID, err := s.lockWorkspaceEditorMutationTx(
		ctx, tx, workspaceID, in.CreatedBy,
	)
	if err != nil {
		return UploadSession{}, err
	}
	var storedOwnerID, name, kind, parseMode, status string
	var chapterID *string
	var oldSize, revision int64
	var captionImages bool
	err = tx.QueryRow(ctx, `SELECT workspace_id, user_id, chapter_id, name, kind,
		size_bytes, revision, parse_mode, caption_images, status
		FROM files WHERE id=$1 FOR UPDATE`, in.FileID).Scan(
		&workspaceID, &storedOwnerID, &chapterID, &name, &kind, &oldSize, &revision,
		&parseMode, &captionImages, &status,
	)
	if isNoRows(err) {
		return UploadSession{}, ErrNotFound
	}
	if err != nil {
		return UploadSession{}, err
	}
	if storedOwnerID != ownerID {
		return UploadSession{}, ErrUploadState
	}
	if revision != in.ExpectedRevision {
		return UploadSession{}, ErrFileRevisionConflict
	}
	if status != string(FileReady) {
		return UploadSession{}, ErrFileNotReady
	}
	reservedSize := max(in.DeclaredSize-oldSize, 0)
	if reservedSize > 0 {
		if err := s.reserveStorageTx(ctx, tx, ownerID, reservedSize); err != nil {
			return UploadSession{}, err
		}
	} else {
		// A non-growing replacement is how an over-quota owner can recover while
		// continuing to edit an Office file. Other locked owner states still
		// reject writes made by collaborators.
		ownerStatus, err := s.accountAccess(ctx, tx, ownerID)
		if err != nil {
			return UploadSession{}, err
		}
		if err := ownerStatus.MutateErr(); err != nil {
			return UploadSession{}, err
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO upload_sessions
		(id, target, workspace_id, user_id, created_by, chapter_id, object_path,
		 final_path, name, kind, content_type, declared_size, reserved_size,
		 parse_mode, caption_images, file_id, expected_revision, expires_at)
		VALUES ($1,'source_replace',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
		in.ID, workspaceID, ownerID, nullStr(in.CreatedBy), chapterID,
		in.ObjectPath, in.FinalPath, name, kind, in.ContentType, in.DeclaredSize,
		reservedSize, parseMode, captionImages, in.FileID, in.ExpectedRevision,
		in.ExpiresAt)
	if err != nil {
		return UploadSession{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return UploadSession{}, err
	}
	return s.GetReplacementUploadSession(ctx, in.ID)
}

func scanUploadSession(row interface{ Scan(...any) error }) (UploadSession, error) {
	var u UploadSession
	err := row.Scan(&u.ID, &u.WorkspaceID, &u.UserID, &u.CreatedBy, &u.ChapterID, &u.ChapterName, &u.ObjectPath, &u.FinalPath,
		&u.Name, &u.Kind, &u.ContentType, &u.DeclaredSize, &u.ReservedSize, &u.ParseMode, &u.CaptionImages,
		&u.Status, &u.FileID, &u.ExpectedRevision, &u.ExpiresAt)
	return u, err
}

const uploadSessionCols = `id, workspace_id, user_id, created_by, chapter_id, chapter_name, object_path, final_path,
	name, kind, content_type, declared_size, COALESCE(reserved_size, declared_size), parse_mode, caption_images, status, file_id, expected_revision, expires_at`

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

func (s *Store) GetReplacementUploadSession(ctx context.Context, id string) (UploadSession, error) {
	u, err := scanUploadSession(s.pool.QueryRow(ctx,
		`SELECT `+uploadSessionCols+` FROM upload_sessions WHERE target='source_replace' AND id=$1`, id))
	if isNoRows(err) {
		return u, ErrNotFound
	}
	return u, err
}

// FinalizeUploadSession creates the source and its first pipeline job exactly once. The
// B2 promotion happens before this transaction and is safe to retry.
func (s *Store) FinalizeUploadSession(ctx context.Context, uploadID, sourceETag, parser, engine string) (File, error) {
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
		ctx, tx, uploadID, sourceETag, parser, engine,
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
	uploadID, sourceETag, parser, engine string,
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
	fileURL := "/api/files/" + fileID + "/raw"
	now := time.Now().UTC()
	processingPlan, err := sourceupload.BuildProcessingPlan(u.Name, u.Kind, u.ParseMode, u.CaptionImages)
	if err != nil {
		return File{}, err
	}
	ready := processingPlan.Route == sourceupload.RouteStoreOnly
	status := "pending"
	if ready {
		status = "ready"
	}
	_, err = tx.Exec(ctx, `INSERT INTO files
		(id, workspace_id, user_id, created_by, chapter_id, name, kind, size_bytes, added_at, status, parser, engine, blob_path, url, source_etag, parse_mode, caption_images)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
		fileID, u.WorkspaceID, u.UserID, u.CreatedBy, chapterID, u.Name, u.Kind, u.DeclaredSize,
		now, status, parser, engine, u.FinalPath, fileURL, sourceETag, u.ParseMode, u.CaptionImages)
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
		payload, err := s.ingestJobPayload(ctx, actor, map[string]any{
			"fileId": fileID, "workspaceId": u.WorkspaceID, "blobPath": u.FinalPath,
			"kind": u.Kind, "parser": parser, "engine": engine,
			"parseMode": u.ParseMode, "captionImages": u.CaptionImages,
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
		AddedAt: now, Status: FileStatus(status), Indexed: false, URL: &fileURL, Revision: 1,
	}
	if ready && FileKind(u.Kind) == FilePDF {
		previewURL := "/api/files/" + fileID + "/preview"
		file.PreviewURL = &previewURL
	}
	return file, nil
}

// FinalizeReplacementUploadSession swaps the blob behind an existing logical
// file, invalidates its retrieval association, and enqueues the same ingest
// policy that was chosen for the original upload.
func (s *Store) FinalizeReplacementUploadSession(
	ctx context.Context,
	uploadID, sourceETag, parser, engine string,
) (File, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return File{}, err
	}
	defer tx.Rollback(ctx)

	var workspaceID string
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM upload_sessions
		WHERE target='source_replace' AND id=$1`, uploadID).Scan(&workspaceID); err != nil {
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
	if err := tx.QueryRow(ctx, `SELECT created_by FROM upload_sessions
		WHERE target='source_replace' AND id=$1`, uploadID).Scan(&createdBy); err != nil {
		return File{}, err
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
	u, err := scanUploadSession(tx.QueryRow(ctx,
		`SELECT `+uploadSessionCols+` FROM upload_sessions
		WHERE target='source_replace' AND id=$1 FOR UPDATE`, uploadID))
	if isNoRows(err) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, err
	}
	if u.FileID == nil || u.ExpectedRevision == nil {
		return File{}, ErrUploadState
	}
	if u.UserID != ownerID {
		return File{}, ErrUploadState
	}
	if u.Status == "completed" {
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

	var currentRevision int64
	var currentStatus string
	err = tx.QueryRow(ctx, `SELECT revision, status FROM files WHERE id=$1 FOR UPDATE`,
		*u.FileID).Scan(&currentRevision, &currentStatus)
	if isNoRows(err) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, err
	}
	if currentRevision != *u.ExpectedRevision {
		return File{}, ErrFileRevisionConflict
	}
	if currentStatus != string(FileReady) {
		return File{}, ErrFileNotReady
	}

	processingPlan, err := sourceupload.BuildProcessingPlan(u.Name, u.Kind, u.ParseMode, u.CaptionImages)
	if err != nil {
		return File{}, err
	}
	ready := processingPlan.Route == sourceupload.RouteStoreOnly
	status := string(FilePending)
	if ready {
		status = string(FileReady)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM rag_file_contents WHERE file_id=$1`, *u.FileID); err != nil {
		return File{}, err
	}
	file, err := scanFile(tx.QueryRow(ctx, `UPDATE files SET
		size_bytes=$3, status=$4, indexed=false, parser=$5, engine=$6,
		blob_path=$7, source_etag=$8, source_sha256=NULL, content_hash=NULL,
		content=NULL, preview_blob_path=NULL, parsed_blob_path=NULL, parsed_fingerprint=NULL,
		parsed_parser_version=NULL, caption_blob_path=NULL,
		parse_mode=$9, caption_images=$10, revision=revision+1
		WHERE id=$1 AND revision=$2 RETURNING `+fileCols,
		*u.FileID, *u.ExpectedRevision, u.DeclaredSize, status, parser, engine,
		u.FinalPath, sourceETag, u.ParseMode, u.CaptionImages))
	if err != nil {
		return File{}, err
	}
	if err := supersedeOlderPipelineJobsTx(ctx, tx, *u.FileID, file.Revision); err != nil {
		return File{}, err
	}

	if !ready {
		actor := ""
		if u.CreatedBy != nil {
			actor = *u.CreatedBy
		}
		reservationID, err := s.beginIngestSpendTx(ctx, tx, actor, u.WorkspaceID)
		if err != nil {
			return File{}, err
		}
		payload, err := s.ingestJobPayload(ctx, actor, map[string]any{
			"fileId": *u.FileID, "workspaceId": u.WorkspaceID,
			"blobPath": u.FinalPath, "kind": u.Kind, "parser": parser,
			"engine": engine, "parseMode": u.ParseMode,
			"captionImages": u.CaptionImages, "sourceETag": sourceETag,
			"processingPlan": processingPlan,
			"sourceRevision": file.Revision, "reservationId": reservationID,
			"quotaRecovery": u.ReservedSize == 0,
		})
		if err != nil {
			return File{}, err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO jobs (id, type, payload) VALUES ($1,$2,$3)`,
			uid("job"), initialPipelineJobType(processingPlan), payload); err != nil {
			return File{}, err
		}
	}

	if _, err := tx.Exec(ctx, `UPDATE upload_sessions SET
		status='completed', source_etag=$2, completed_at=now()
		WHERE id=$1`, uploadID, sourceETag); err != nil {
		return File{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, err
	}
	return file, nil
}

// supersedeOlderPipelineJobsTx fences workers for the blob that replacement just
// retired. SKIP LOCKED avoids a file->job/job->file deadlock with a worker that
// is inside its final transaction; that worker will instead hit the file
// revision guard and close its own reservation on the terminal path.
func supersedeOlderPipelineJobsTx(
	ctx context.Context,
	tx pgx.Tx,
	fileID string,
	currentRevision int64,
) error {
	var superseded int64
	return tx.QueryRow(ctx, `WITH candidates AS MATERIALIZED (
		SELECT id FROM jobs
		WHERE type IN ('parse','ingest') AND payload->>'fileId'=$1
		  AND status IN ('pending','running')
		  AND CASE
		    WHEN jsonb_typeof(payload->'sourceRevision')='number'
		    THEN (payload->>'sourceRevision')::bigint
		    ELSE 0
		  END < $2
		FOR UPDATE SKIP LOCKED
	)
	SELECT cancel_pipeline_jobs(
		COALESCE(array_agg(id), ARRAY[]::text[]),
		'superseded', 'superseded', 'source_superseded',
		'superseded by file replacement'
	) FROM candidates`, fileID, currentRevision).Scan(&superseded)
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
		WHERE target IN ('source','source_replace') AND id=$1 AND status='pending'`, id).Scan(&userID)
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
