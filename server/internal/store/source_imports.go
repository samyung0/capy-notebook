package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const importAttemptLease = 12 * time.Minute

var (
	ErrImportLeaseLost           = errors.New("source import attempt lease lost")
	ErrImportNotReady            = errors.New("source import is not ready")
	ErrImportTooLarge            = errors.New("source import exceeds its byte limit")
	ErrImportIdempotencyConflict = errors.New("source import idempotency key conflict")
	errImportOwnerChanged        = errors.New("source import storage owner changed")
)

type SourceImportJob struct {
	ID                string
	UploadSessionID   string
	WorkspaceID       string
	StorageOwnerID    string
	ActorUserID       *string
	Provider          string
	ProviderFileID    string
	ProviderDriveID   string
	MaxBytes          int64
	IdempotencyKey    string
	TraceID           string
	Status            string
	Attempts          int
	LeaseToken        string
	LeaseExpiresAt    *time.Time
	LeaseActive       bool
	SessionExpired    bool
	AttemptObjectPath string
	LastErrorCode     string
	LastError         string
	FileID            *string
	Name              string
	Kind              string
	ContentType       string
	DeclaredSize      int64
	ObjectPath        string
	FinalPath         string
	SessionExpiresAt  time.Time
}

type NewSourceImport struct {
	JobID           string
	Upload          NewUploadSession
	Provider        string
	ProviderFileID  string
	ProviderDriveID string
	MaxBytes        int64
	IdempotencyKey  string
	TraceID         string
}

func (s *Store) BeginSourceImportRequest(
	ctx context.Context,
	actorUserID, workspaceID, requestID, fingerprint string,
) (json.RawMessage, bool, error) {
	if actorUserID == "" || workspaceID == "" || requestID == "" ||
		fingerprint == "" || len(requestID) > 128 {
		return nil, false, errors.New("invalid source import request")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)
	if _, err := s.lockWorkspaceEditorMutationTx(
		ctx, tx, workspaceID, actorUserID,
	); err != nil {
		return nil, false, err
	}
	tag, err := tx.Exec(ctx, `INSERT INTO source_import_requests
		(actor_user_id, request_id, workspace_id, fingerprint)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (actor_user_id, request_id) DO NOTHING`,
		actorUserID, requestID, workspaceID, fingerprint)
	if err != nil {
		return nil, false, err
	}
	if tag.RowsAffected() == 1 {
		return nil, false, tx.Commit(ctx)
	}

	var storedWorkspace, storedFingerprint string
	var response []byte
	var completed bool
	err = tx.QueryRow(ctx, `SELECT workspace_id, fingerprint,
		COALESCE(response,'null'::jsonb), response IS NOT NULL
		FROM source_import_requests
		WHERE actor_user_id=$1 AND request_id=$2`,
		actorUserID, requestID).
		Scan(&storedWorkspace, &storedFingerprint, &response, &completed)
	if err != nil {
		return nil, false, err
	}
	if storedWorkspace != workspaceID || storedFingerprint != fingerprint {
		return nil, false, ErrImportIdempotencyConflict
	}
	if !completed {
		return nil, false, tx.Commit(ctx)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return json.RawMessage(response), true, nil
}

func secureImportToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// CreateSourceImports writes reservations, their import rows and the pipeline
// `import` queue jobs in one transaction. The attempt lease and idempotent
// upload finalization make a re-delivered queue claim harmless.
func (s *Store) CreateSourceImports(
	ctx context.Context,
	imports []NewSourceImport,
) ([]SourceImportJob, error) {
	for range 3 {
		jobs, err := s.createSourceImports(ctx, imports, nil)
		if errors.Is(err, errImportOwnerChanged) {
			continue
		}
		return jobs, err
	}
	return nil, errImportOwnerChanged
}

type sourceImportRequestCompletion struct {
	actorUserID string
	workspaceID string
	requestID   string
	fingerprint string
	response    json.RawMessage
	stored      json.RawMessage
}

// CreateSourceImportsAndCompleteRequest commits the canonical response in the
// same transaction as the import rows, reservations, and queue jobs it names.
func (s *Store) CreateSourceImportsAndCompleteRequest(
	ctx context.Context,
	actorUserID, workspaceID, requestID, fingerprint string,
	imports []NewSourceImport,
	response json.RawMessage,
) (json.RawMessage, error) {
	completion := sourceImportRequestCompletion{
		actorUserID: actorUserID,
		workspaceID: workspaceID,
		requestID:   requestID,
		fingerprint: fingerprint,
		response:    response,
	}
	for range 3 {
		completion.stored = nil
		_, err := s.createSourceImports(ctx, imports, &completion)
		if errors.Is(err, errImportOwnerChanged) {
			continue
		}
		return completion.stored, err
	}
	return nil, errImportOwnerChanged
}

func (s *Store) createSourceImports(
	ctx context.Context,
	imports []NewSourceImport,
	completion *sourceImportRequestCompletion,
) ([]SourceImportJob, error) {
	if completion != nil && (completion.actorUserID == "" ||
		completion.workspaceID == "" || completion.requestID == "" ||
		completion.fingerprint == "" || !json.Valid(completion.response)) {
		return nil, errors.New("invalid source import request completion")
	}
	if len(imports) == 0 && completion == nil {
		return nil, nil
	}
	workspaceID := ""
	if completion != nil {
		workspaceID = completion.workspaceID
	} else {
		workspaceID = imports[0].Upload.WorkspaceID
	}
	var total int64
	keys := make(map[string]struct{}, len(imports))
	for _, item := range imports {
		if item.Upload.WorkspaceID != workspaceID {
			return nil, errors.New("source imports must share a workspace")
		}
		if completion != nil && item.Upload.CreatedBy != completion.actorUserID {
			return nil, errors.New("source imports must share the request actor")
		}
		if item.Provider != "google" && item.Provider != "microsoft" {
			return nil, fmt.Errorf("unsupported import provider %q", item.Provider)
		}
		if item.ProviderFileID == "" || item.MaxBytes <= 0 ||
			item.Upload.DeclaredSize < 0 || item.IdempotencyKey == "" ||
			len(item.IdempotencyKey) > 256 {
			return nil, errors.New("invalid source import")
		}
		if _, exists := keys[item.IdempotencyKey]; exists {
			return nil, errors.New("duplicate source import idempotency key")
		}
		keys[item.IdempotencyKey] = struct{}{}
		if item.Upload.DeclaredSize > item.MaxBytes {
			return nil, ErrImportTooLarge
		}
		if total > int64(^uint64(0)>>1)-item.Upload.DeclaredSize {
			return nil, errors.New("source import reservation overflow")
		}
		total += item.Upload.DeclaredSize
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	ownerID, err := s.storageOwnerTx(ctx, tx, workspaceID)
	if err != nil {
		return nil, err
	}
	actors := map[string]struct{}{}
	if completion != nil {
		actors[completion.actorUserID] = struct{}{}
	}
	for _, item := range imports {
		actorID := item.Upload.CreatedBy
		actors[actorID] = struct{}{}
	}
	for actorID := range actors {
		currentOwnerID, err := s.lockWorkspaceEditorMutationTx(
			ctx, tx, workspaceID, actorID,
		)
		if err != nil {
			return nil, err
		}
		if currentOwnerID != ownerID {
			return nil, errImportOwnerChanged
		}
	}
	if err := s.lockStorageRowTx(ctx, tx, ownerID); err != nil {
		return nil, err
	}
	currentOwnerID, err := s.storageOwnerTx(ctx, tx, workspaceID)
	if err != nil {
		return nil, err
	}
	if currentOwnerID != ownerID {
		return nil, errImportOwnerChanged
	}
	if completion != nil {
		var storedWorkspace, storedFingerprint string
		var stored []byte
		var completed bool
		err := tx.QueryRow(ctx, `SELECT workspace_id, fingerprint,
			COALESCE(response,'null'::jsonb), response IS NOT NULL
			FROM source_import_requests
			WHERE actor_user_id=$1 AND request_id=$2
			FOR UPDATE`, completion.actorUserID, completion.requestID).Scan(
			&storedWorkspace, &storedFingerprint, &stored, &completed,
		)
		if isNoRows(err) {
			return nil, ErrImportIdempotencyConflict
		}
		if err != nil {
			return nil, err
		}
		if storedWorkspace != completion.workspaceID ||
			storedFingerprint != completion.fingerprint {
			return nil, ErrImportIdempotencyConflict
		}
		if completed {
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			completion.stored = json.RawMessage(stored)
			return nil, nil
		}
	}

	existing := make([]SourceImportJob, 0, len(imports))
	for _, item := range imports {
		job, err := scanSourceImport(tx.QueryRow(ctx, sourceImportSelect+
			` WHERE j.idempotency_key=$1 AND j.actor_user_id=$2`,
			item.IdempotencyKey, item.Upload.CreatedBy))
		if isNoRows(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if job.WorkspaceID != workspaceID || job.ActorUserID == nil ||
			*job.ActorUserID != item.Upload.CreatedBy ||
			job.Provider != item.Provider ||
			job.ProviderFileID != item.ProviderFileID ||
			job.ProviderDriveID != item.ProviderDriveID {
			return nil, errors.New("source import idempotency key conflict")
		}
		existing = append(existing, job)
	}
	if len(existing) > 0 {
		if completion != nil {
			return nil, ErrImportIdempotencyConflict
		}
		if len(existing) != len(imports) {
			return nil, errors.New("partial source import idempotency replay")
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return existing, nil
	}
	if err := s.reserveStorageTx(ctx, tx, ownerID, total); err != nil {
		return nil, err
	}
	if err := s.gateWorkspaceFilesTx(ctx, tx, workspaceID, len(imports)); err != nil {
		return nil, err
	}

	out := make([]SourceImportJob, 0, len(imports))
	for _, item := range imports {
		u := item.Upload
		if _, err := tx.Exec(ctx, `INSERT INTO upload_sessions
			(id, target, workspace_id, user_id, created_by, chapter_id, chapter_name,
			 object_path, final_path, name, kind, content_type, declared_size, reserved_size,
			 parse_mode, caption_images, expires_at)
			VALUES ($1,'source',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$15)`,
			u.ID, u.WorkspaceID, ownerID, nullStr(u.CreatedBy), u.ChapterID,
			u.ChapterName, u.ObjectPath, u.FinalPath, u.Name, u.Kind,
			u.ContentType, u.DeclaredSize, u.ParseMode, u.CaptionImages,
			u.ExpiresAt); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO source_import_jobs
			(id, upload_session_id, actor_user_id, provider, provider_file_id,
			 provider_drive_id, max_bytes, idempotency_key, trace_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			item.JobID, u.ID, nullStr(u.CreatedBy), item.Provider,
			item.ProviderFileID, item.ProviderDriveID, item.MaxBytes,
			item.IdempotencyKey, item.TraceID); err != nil {
			return nil, err
		}
		// The pipeline's import worker claims this row; the payload names only
		// the import so provider identity stays on source_import_jobs.
		queuePayload, err := json.Marshal(map[string]any{
			"importJobId": item.JobID,
			"workspaceId": u.WorkspaceID,
			"actorUserId": u.CreatedBy,
			"traceId":     item.TraceID,
		})
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO jobs (id, type, payload)
			VALUES ($1,'import',$2)`, item.JobID, queuePayload); err != nil {
			return nil, err
		}
		job, err := scanSourceImport(tx.QueryRow(ctx,
			sourceImportSelect+` WHERE j.id=$1`, item.JobID))
		if err != nil {
			return nil, err
		}
		out = append(out, job)
	}
	if completion != nil {
		var stored []byte
		err := tx.QueryRow(ctx, `UPDATE source_import_requests
			SET response=$5::jsonb, completed_at=now()
			WHERE actor_user_id=$1 AND request_id=$2 AND workspace_id=$3
				AND fingerprint=$4 AND response IS NULL
			RETURNING response`, completion.actorUserID, completion.requestID,
			completion.workspaceID, completion.fingerprint,
			string(completion.response)).Scan(&stored)
		if isNoRows(err) {
			return nil, ErrImportIdempotencyConflict
		}
		if err != nil {
			return nil, err
		}
		completion.stored = json.RawMessage(stored)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	return out, nil
}

const sourceImportSelect = `SELECT j.id, j.upload_session_id, u.workspace_id,
	u.user_id, j.actor_user_id, j.provider, j.provider_file_id, j.provider_drive_id,
	j.max_bytes, j.idempotency_key, j.trace_id, j.status, j.attempts,
	COALESCE(j.lease_token,''), j.lease_expires_at,
	COALESCE(j.lease_expires_at > now(),false),
	u.expires_at <= now(), COALESCE(j.attempt_object_path,''),
	COALESCE(j.last_error_code,''), COALESCE(j.last_error,''), u.file_id,
	u.name, u.kind, u.content_type, u.declared_size, u.object_path, u.final_path,
	u.expires_at
	FROM source_import_jobs j
	JOIN upload_sessions u ON u.id=j.upload_session_id`

func scanSourceImport(row interface{ Scan(...any) error }) (SourceImportJob, error) {
	var job SourceImportJob
	err := row.Scan(
		&job.ID, &job.UploadSessionID, &job.WorkspaceID, &job.StorageOwnerID,
		&job.ActorUserID,
		&job.Provider, &job.ProviderFileID, &job.ProviderDriveID, &job.MaxBytes,
		&job.IdempotencyKey, &job.TraceID, &job.Status, &job.Attempts,
		&job.LeaseToken, &job.LeaseExpiresAt,
		&job.LeaseActive, &job.SessionExpired,
		&job.AttemptObjectPath,
		&job.LastErrorCode, &job.LastError, &job.FileID, &job.Name, &job.Kind,
		&job.ContentType, &job.DeclaredSize, &job.ObjectPath, &job.FinalPath,
		&job.SessionExpiresAt,
	)
	return job, err
}

func (s *Store) GetSourceImport(ctx context.Context, workspaceID, jobID string) (SourceImportJob, error) {
	job, err := scanSourceImport(s.pool.QueryRow(ctx,
		sourceImportSelect+` WHERE j.id=$1 AND u.workspace_id=$2`, jobID, workspaceID))
	if isNoRows(err) {
		return job, ErrNotFound
	}
	return job, err
}

func (s *Store) GetSourceImportByID(ctx context.Context, jobID string) (SourceImportJob, error) {
	job, err := scanSourceImport(s.pool.QueryRow(ctx,
		sourceImportSelect+` WHERE j.id=$1`, jobID))
	if isNoRows(err) {
		return job, ErrNotFound
	}
	return job, err
}

func (s *Store) AcquireSourceImport(ctx context.Context, jobID string) (SourceImportJob, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SourceImportJob{}, err
	}
	defer tx.Rollback(ctx)

	job, err := scanSourceImport(tx.QueryRow(ctx, sourceImportSelect+
		` WHERE j.id=$1 FOR UPDATE OF j, u`, jobID))
	if isNoRows(err) {
		return job, ErrNotFound
	}
	if err != nil {
		return job, err
	}
	if job.Status == "succeeded" {
		return job, nil
	}
	if job.Status == "failed" || job.Status == "cancelled" ||
		job.SessionExpired {
		return job, ErrImportNotReady
	}
	if job.Status == "running" && job.LeaseActive {
		return job, ErrImportNotReady
	}
	token, err := secureImportToken()
	if err != nil {
		return job, err
	}
	objectToken, err := secureImportToken()
	if err != nil {
		return job, err
	}
	attemptObjectPath := job.ObjectPath + ".attempt-" + objectToken
	if job.AttemptObjectPath != "" {
		if err := s.EnqueueBlobDeletionTx(
			ctx, tx, uploadPresignGrace, job.AttemptObjectPath,
		); err != nil {
			return job, err
		}
	}
	var leaseExpires time.Time
	if err := tx.QueryRow(ctx, `UPDATE source_import_jobs
		SET status='running', attempts=attempts+1, lease_token=$2,
			lease_expires_at=now()+$3, attempt_object_path=$4,
			last_error_code=NULL, last_error=NULL, updated_at=now()
		WHERE id=$1 RETURNING lease_expires_at`,
		jobID, token, importAttemptLease, attemptObjectPath).
		Scan(&leaseExpires); err != nil {
		return job, err
	}
	if err := tx.Commit(ctx); err != nil {
		return job, err
	}
	job.Status = "running"
	job.Attempts++
	job.LeaseToken = token
	job.LeaseExpiresAt = &leaseExpires
	job.LeaseActive = true
	job.AttemptObjectPath = attemptObjectPath
	job.LastErrorCode = ""
	job.LastError = ""
	return job, nil
}

func (s *Store) PrepareSourceImportUpload(
	ctx context.Context,
	jobID, leaseToken string,
	actualSize int64,
) (SourceImportJob, error) {
	for range 3 {
		job, err := s.prepareSourceImportUpload(
			ctx, jobID, leaseToken, actualSize,
		)
		if errors.Is(err, errImportOwnerChanged) {
			continue
		}
		return job, err
	}
	return SourceImportJob{}, errImportOwnerChanged
}

func (s *Store) prepareSourceImportUpload(
	ctx context.Context,
	jobID, leaseToken string,
	actualSize int64,
) (SourceImportJob, error) {
	if actualSize < 0 {
		return SourceImportJob{}, ErrImportTooLarge
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SourceImportJob{}, err
	}
	defer tx.Rollback(ctx)

	var workspaceID string
	var actorID *string
	if err := tx.QueryRow(ctx, `SELECT u.workspace_id, j.actor_user_id
		FROM source_import_jobs j
		JOIN upload_sessions u ON u.id=j.upload_session_id
		WHERE j.id=$1`, jobID).Scan(&workspaceID, &actorID); err != nil {
		if isNoRows(err) {
			return SourceImportJob{}, ErrNotFound
		}
		return SourceImportJob{}, err
	}
	ownerID, err := s.storageOwnerTx(ctx, tx, workspaceID)
	if err != nil {
		return SourceImportJob{}, err
	}
	actor := ""
	if actorID != nil {
		actor = *actorID
	}
	ownerID, err = s.lockWorkspaceEditorMutationTx(ctx, tx, workspaceID, actor)
	if err != nil {
		return SourceImportJob{}, err
	}
	if err := s.lockStorageRowTx(ctx, tx, ownerID); err != nil {
		return SourceImportJob{}, err
	}
	job, err := scanSourceImport(tx.QueryRow(ctx, sourceImportSelect+
		` WHERE j.id=$1 FOR UPDATE OF j, u`, jobID))
	if isNoRows(err) {
		return job, ErrNotFound
	}
	if err != nil {
		return job, err
	}
	if job.StorageOwnerID != ownerID {
		return job, errImportOwnerChanged
	}
	// A concurrent completion may already have committed. Replay its result
	// without renewing a lease or changing the settled upload reservation.
	if job.Status == "succeeded" && job.FileID != nil {
		return job, nil
	}
	if job.Status != "running" || job.LeaseToken != leaseToken ||
		!job.LeaseActive {
		return job, ErrImportLeaseLost
	}
	if actualSize > job.MaxBytes {
		return job, ErrImportTooLarge
	}
	if actualSize > job.DeclaredSize {
		if err := s.gateStorageTx(
			ctx,
			tx,
			ownerID,
			actualSize-job.DeclaredSize,
		); err != nil {
			return job, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE upload_sessions
		SET declared_size=$2, reserved_size=$2
		WHERE id=$1 AND status='pending'`,
		job.UploadSessionID, actualSize); err != nil {
		return job, err
	}
	if err := tx.Commit(ctx); err != nil {
		return job, err
	}
	job.DeclaredSize = actualSize
	return job, nil
}

// FenceSourceImportCompletion atomically verifies the attempt and renews its
// lease before the gateway mutates blob state. A replacement attempt cannot be
// acquired while the fenced completion request is in flight.
func (s *Store) FenceSourceImportCompletion(
	ctx context.Context,
	jobID, leaseToken string,
) (SourceImportJob, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SourceImportJob{}, err
	}
	defer tx.Rollback(ctx)

	job, err := scanSourceImport(tx.QueryRow(ctx, sourceImportSelect+
		` WHERE j.id=$1 FOR UPDATE OF j`, jobID))
	if isNoRows(err) {
		return SourceImportJob{}, ErrNotFound
	}
	if err != nil {
		return SourceImportJob{}, err
	}
	// A concurrent completion may already have committed. Replay its result
	// without renewing a lease or changing the settled upload reservation.
	if job.Status == "succeeded" && job.FileID != nil {
		return job, nil
	}
	if job.Status != "running" || job.LeaseToken != leaseToken ||
		!job.LeaseActive {
		return SourceImportJob{}, ErrImportLeaseLost
	}
	var leaseExpires time.Time
	if err := tx.QueryRow(ctx, `UPDATE source_import_jobs
		SET lease_expires_at=now()+$2, updated_at=now() WHERE id=$1
		RETURNING lease_expires_at`,
		jobID, importAttemptLease).Scan(&leaseExpires); err != nil {
		return SourceImportJob{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SourceImportJob{}, err
	}
	job.LeaseExpiresAt = &leaseExpires
	return job, nil
}

// FinalizeSourceImport validates the live attempt, creates the file and ingest
// job, completes the upload session, and marks the import succeeded in one
// transaction. Holding the import row lock prevents an expired attempt from
// racing a replacement attempt through finalization.
func (s *Store) FinalizeSourceImport(
	ctx context.Context,
	jobID, leaseToken, sourceETag, parser, engine string,
) (File, error) {
	for range 3 {
		file, err := s.finalizeSourceImport(
			ctx, jobID, leaseToken, sourceETag, parser, engine,
		)
		if errors.Is(err, errImportOwnerChanged) {
			continue
		}
		return file, err
	}
	return File{}, errImportOwnerChanged
}

func (s *Store) finalizeSourceImport(
	ctx context.Context,
	jobID, leaseToken, sourceETag, parser, engine string,
) (File, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return File{}, err
	}
	defer tx.Rollback(ctx)

	var workspaceID string
	var actorID *string
	if err := tx.QueryRow(ctx, `SELECT u.workspace_id, j.actor_user_id
		FROM source_import_jobs j
		JOIN upload_sessions u ON u.id=j.upload_session_id
		WHERE j.id=$1`, jobID).Scan(&workspaceID, &actorID); err != nil {
		if isNoRows(err) {
			return File{}, ErrNotFound
		}
		return File{}, err
	}
	ownerID, err := s.storageOwnerTx(ctx, tx, workspaceID)
	if err != nil {
		return File{}, err
	}
	actor := ""
	if actorID != nil {
		actor = *actorID
	}
	ownerID, err = s.lockWorkspaceEditorMutationTx(ctx, tx, workspaceID, actor)
	if err != nil {
		return File{}, err
	}
	if err := s.lockStorageRowTx(ctx, tx, ownerID); err != nil {
		return File{}, err
	}
	job, err := scanSourceImport(tx.QueryRow(ctx, sourceImportSelect+
		` WHERE j.id=$1 FOR UPDATE OF j`, jobID))
	if isNoRows(err) {
		return File{}, ErrNotFound
	}
	if err != nil {
		return File{}, err
	}
	if job.StorageOwnerID != ownerID {
		return File{}, errImportOwnerChanged
	}
	if job.Status == "succeeded" && job.FileID != nil {
		file, err := scanFile(tx.QueryRow(ctx,
			`SELECT `+fileCols+` FROM files WHERE id=$1`, *job.FileID))
		if err != nil {
			return File{}, err
		}
		return file, tx.Commit(ctx)
	}
	if job.Status != "running" || job.LeaseToken != leaseToken ||
		!job.LeaseActive {
		return File{}, ErrImportLeaseLost
	}
	if err := assertSourceImportActorTx(ctx, tx, job); err != nil {
		return File{}, err
	}

	file, err := s.finalizeUploadSessionTx(
		ctx, tx, job.UploadSessionID, sourceETag, parser, engine,
	)
	if err != nil {
		return File{}, err
	}
	tag, err := tx.Exec(ctx, `UPDATE source_import_jobs
		SET status='succeeded', completed_at=now(), lease_token=NULL,
			lease_expires_at=NULL, attempt_object_path=NULL, updated_at=now()
		WHERE id=$1 AND status='running' AND lease_token=$2`,
		jobID, leaseToken)
	if err != nil {
		return File{}, err
	}
	if tag.RowsAffected() != 1 {
		return File{}, ErrImportLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, err
	}
	return file, nil
}

func assertSourceImportActorTx(
	ctx context.Context,
	tx pgx.Tx,
	job SourceImportJob,
) error {
	if job.ActorUserID == nil {
		return ErrForbidden
	}
	var deletedAt, suspendedAt, deletionRequestedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT deleted_at, suspended_at,
		deletion_requested_at FROM users WHERE id=$1 FOR SHARE`,
		*job.ActorUserID).
		Scan(&deletedAt, &suspendedAt, &deletionRequestedAt); err != nil {
		if isNoRows(err) {
			return ErrForbidden
		}
		return err
	}
	if deletedAt != nil || suspendedAt != nil || deletionRequestedAt != nil {
		return ErrForbidden
	}
	var ownerID string
	if err := tx.QueryRow(ctx, `SELECT user_id FROM workspaces
		WHERE id=$1 FOR SHARE`, job.WorkspaceID).Scan(&ownerID); err != nil {
		if isNoRows(err) {
			return ErrForbidden
		}
		return err
	}
	if ownerID == *job.ActorUserID {
		return nil
	}
	var role WorkspaceRole
	if err := tx.QueryRow(ctx, `SELECT role FROM workspace_members
		WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`,
		job.WorkspaceID, *job.ActorUserID).Scan(&role); err != nil {
		if isNoRows(err) {
			return ErrForbidden
		}
		return err
	}
	if !RoleCanEdit(role) {
		return ErrForbidden
	}
	return nil
}

// MarkSourceImportRetry releases a live attempt so the pipeline's next queue
// claim can acquire again; the retry schedule itself lives on the jobs row.
func (s *Store) MarkSourceImportRetry(
	ctx context.Context,
	jobID, leaseToken, code, message string,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	job, err := scanSourceImport(tx.QueryRow(ctx, sourceImportSelect+
		` WHERE j.id=$1 FOR UPDATE OF j`, jobID))
	if isNoRows(err) {
		return ErrImportLeaseLost
	}
	if err != nil {
		return err
	}
	if job.Status != "running" || job.LeaseToken != leaseToken ||
		!job.LeaseActive {
		return ErrImportLeaseLost
	}
	tag, err := tx.Exec(ctx, `UPDATE source_import_jobs
		SET status='pending', lease_token=NULL,
			lease_expires_at=NULL, attempt_object_path=NULL,
			last_error_code=$3, last_error=$4, updated_at=now()
		WHERE id=$1 AND status='running' AND lease_token=$2
			AND lease_expires_at>now()`,
		jobID, leaseToken, code, message)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrImportLeaseLost
	}
	if err := s.EnqueueBlobDeletionTx(
		ctx, tx, uploadPresignGrace, job.AttemptObjectPath,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// MarkSourceImportFailed closes an import and expires its upload session so the
// reservation is released. With a lease token it fences the live attempt; with
// an empty token it closes a job that holds no live lease and refuses one that
// does, which is how the pipeline reports a job whose attempts ran out before
// an attempt was ever acquired.
func (s *Store) MarkSourceImportFailed(
	ctx context.Context,
	jobID, leaseToken, code, message string,
) error {
	return s.failSourceImport(ctx, jobID, leaseToken, code, message, leaseToken == "")
}

func (s *Store) failSourceImport(
	ctx context.Context,
	jobID, leaseToken, code, message string,
	ignoreLease bool,
) error {
	for range 3 {
		err := s.failSourceImportOnce(
			ctx, jobID, leaseToken, code, message, ignoreLease,
		)
		if errors.Is(err, errImportOwnerChanged) {
			continue
		}
		return err
	}
	return errImportOwnerChanged
}

func (s *Store) failSourceImportOnce(
	ctx context.Context,
	jobID, leaseToken, code, message string,
	ignoreLease bool,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var ownerID string
	if err := tx.QueryRow(ctx, `SELECT u.user_id
		FROM source_import_jobs j
		JOIN upload_sessions u ON u.id=j.upload_session_id
		WHERE j.id=$1`, jobID).Scan(&ownerID); err != nil {
		if isNoRows(err) {
			return nil
		}
		return err
	}
	if err := s.lockStorageRowTx(ctx, tx, ownerID); err != nil {
		return err
	}
	job, err := scanSourceImport(tx.QueryRow(ctx, sourceImportSelect+
		` WHERE j.id=$1 FOR UPDATE OF j, u`, jobID))
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if job.StorageOwnerID != ownerID {
		return errImportOwnerChanged
	}
	if job.Status == "succeeded" || job.Status == "failed" || job.Status == "cancelled" {
		return tx.Commit(ctx)
	}
	if ignoreLease && job.Status == "running" && job.LeaseActive {
		return ErrImportNotReady
	}
	if !ignoreLease && (job.Status != "running" ||
		job.LeaseToken != leaseToken || !job.LeaseActive) {
		return ErrImportLeaseLost
	}

	updateQuery := `UPDATE source_import_jobs
		SET status='failed', completed_at=now(), lease_token=NULL,
			lease_expires_at=NULL, attempt_object_path=NULL,
			last_error_code=$2, last_error=$3, updated_at=now()
		WHERE id=$1`
	updateArgs := []any{jobID, code, message}
	if !ignoreLease {
		updateQuery += ` AND status='running' AND lease_token=$4
			AND lease_expires_at>now()`
		updateArgs = append(updateArgs, leaseToken)
	}
	tag, err := tx.Exec(ctx, updateQuery, updateArgs...)
	if err != nil {
		return err
	}
	if !ignoreLease && tag.RowsAffected() == 0 {
		return ErrImportLeaseLost
	}
	var objectPath, finalPath string
	err = tx.QueryRow(ctx, `UPDATE upload_sessions SET status='expired'
		WHERE id=$1 AND status='pending'
		RETURNING object_path, final_path`, job.UploadSessionID).
		Scan(&objectPath, &finalPath)
	if err != nil && !isNoRows(err) {
		return err
	}
	if err == nil {
		if err := s.EnqueueBlobDeletionTx(ctx, tx, uploadPresignGrace,
			objectPath, finalPath, job.AttemptObjectPath); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
