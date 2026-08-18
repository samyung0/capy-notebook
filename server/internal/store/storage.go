package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

const (
	FreeStorageLimitBytes = int64(100 * 1024 * 1024)
	ProStorageLimitBytes  = int64(1024 * 1024 * 1024)
	MaxFilesPerWorkspace  = 100
	MaxFilesPerUpload     = 20
)

var ErrStorageQuotaExceeded = errors.New("storage quota exceeded")

// QuotaExceededError contains the values used by the creation gate. The
// effective used value includes material deltas that have not yet been folded
// into user_storage.used_bytes.
type QuotaExceededError struct {
	UserID         string
	UsedBytes      int64
	ReservedBytes  int64
	RequestedBytes int64
	LimitBytes     int64
	PlanTier       PlanTier
}

func (e *QuotaExceededError) Error() string {
	return fmt.Sprintf(
		"%s: used=%d reserved=%d requested=%d limit=%d",
		ErrStorageQuotaExceeded,
		e.UsedBytes,
		e.ReservedBytes,
		e.RequestedBytes,
		e.LimitBytes,
	)
}

func (e *QuotaExceededError) Unwrap() error { return ErrStorageQuotaExceeded }

var ErrFileLimitExceeded = errors.New("workspace file limit exceeded")

// FileLimitExceededError is the counterpart of QuotaExceededError for the
// per-workspace file count (LLM context bound) and the per-request batch cap.
// Kind is "workspace" or "batch".
type FileLimitExceededError struct {
	WorkspaceID string
	Used        int
	Reserved    int
	Requested   int
	Limit       int
	Kind        string
}

func (e *FileLimitExceededError) Error() string {
	return fmt.Sprintf(
		"%s: kind=%s used=%d reserved=%d requested=%d limit=%d",
		ErrFileLimitExceeded,
		e.Kind,
		e.Used,
		e.Reserved,
		e.Requested,
		e.Limit,
	)
}

func (e *FileLimitExceededError) Unwrap() error { return ErrFileLimitExceeded }

func (e *FileLimitExceededError) Code() string {
	if e.Kind == "batch" {
		return "files_batch_exceeded"
	}
	return "files_limit_exceeded"
}

type StorageUsage struct {
	UserID        string   `json:"userId"`
	UsedBytes     int64    `json:"storageUsedBytes"`
	ReservedBytes int64    `json:"storageReservedBytes"`
	LimitBytes    int64    `json:"storageLimitBytes"`
	PlanTier      PlanTier `json:"planTier"`
}

func StorageLimitBytes(tier PlanTier) int64 {
	if tier == PlanPro {
		return ProStorageLimitBytes
	}
	return FreeStorageLimitBytes
}

// WorkspaceOwnerPlan is the plan of the account that pays for the workspace.
// Per-file upload caps follow this, not the editor who is uploading.
func (s *Store) WorkspaceOwnerPlan(ctx context.Context, workspaceID string) (PlanTier, error) {
	var tier PlanTier
	err := s.pool.QueryRow(ctx, `
		SELECT u.plan_tier FROM workspaces w
		JOIN users u ON u.id = w.user_id
		WHERE w.id=$1`, workspaceID).Scan(&tier)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return tier, err
}

func storageJSONSizeTx(ctx context.Context, tx pgx.Tx, content string) (int64, error) {
	var size int64
	err := tx.QueryRow(
		ctx,
		`SELECT octet_length($1::jsonb::text)`,
		content,
	).Scan(&size)
	return size, err
}

func (s *Store) storageOwnerTx(ctx context.Context, tx pgx.Tx, workspaceID string) (string, error) {
	var ownerID string
	err := tx.QueryRow(ctx, `SELECT user_id FROM workspaces WHERE id=$1`, workspaceID).Scan(&ownerID)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return ownerID, err
}

func (s *Store) ensureStorageRowTx(ctx context.Context, tx pgx.Tx, userID string) error {
	if userID == "" {
		return ErrNotFound
	}
	_, err := tx.Exec(ctx, `INSERT INTO user_storage (user_id)
		VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, userID)
	return err
}

func (s *Store) lockStorageRowTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
) error {
	if err := s.ensureStorageRowTx(ctx, tx, userID); err != nil {
		return err
	}
	var lockedUserID string
	return tx.QueryRow(
		ctx,
		`SELECT user_id FROM user_storage WHERE user_id=$1 FOR UPDATE`,
		userID,
	).Scan(&lockedUserID)
}

func (s *Store) lockedStorageUsageTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
) (tier PlanTier, usage StorageUsage, err error) {
	if err = s.ensureStorageRowTx(ctx, tx, userID); err != nil {
		return
	}
	if err = tx.QueryRow(ctx, `SELECT plan_tier FROM users WHERE id=$1`, userID).Scan(&tier); err != nil {
		if isNoRows(err) {
			err = ErrNotFound
		}
		return
	}
	var baseUsed, reserved, pending int64
	err = tx.QueryRow(ctx, `SELECT used_bytes, reserved_bytes
		FROM user_storage WHERE user_id=$1 FOR UPDATE`, userID).
		Scan(&baseUsed, &reserved)
	if err != nil {
		return
	}
	err = tx.QueryRow(ctx, `SELECT COALESCE(sum(delta_bytes), 0)
		FROM user_storage_deltas WHERE user_id=$1`, userID).Scan(&pending)
	if err != nil {
		return
	}
	usage = StorageUsage{
		UserID:        userID,
		UsedBytes:     baseUsed + pending,
		ReservedBytes: reserved,
		LimitBytes:    StorageLimitBytes(tier),
		PlanTier:      tier,
	}
	return
}

// unlockedStorageUsageTx reads the same effective usage without taking the
// counter-row lock or provisioning a missing row. Lifecycle and reporting reads
// use it; only the creation gate needs the lock, and account state is resolved
// on every authenticated request, so locking there would serialize a user's
// entire request stream behind one row.
func (s *Store) unlockedStorageUsage(
	ctx context.Context,
	q rowQueryer,
	userID string,
) (usage StorageUsage, err error) {
	var tier PlanTier
	var baseUsed, reserved, pending int64
	err = q.QueryRow(ctx, `SELECT u.plan_tier,
			COALESCE(st.used_bytes, 0),
			COALESCE(st.reserved_bytes, 0),
			COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas d
				WHERE d.user_id = u.id), 0)
		FROM users u
		LEFT JOIN user_storage st ON st.user_id = u.id
		WHERE u.id=$1`, userID).Scan(&tier, &baseUsed, &reserved, &pending)
	if isNoRows(err) {
		return usage, ErrNotFound
	}
	if err != nil {
		return usage, err
	}
	return StorageUsage{
		UserID:        userID,
		UsedBytes:     baseUsed + pending,
		ReservedBytes: reserved,
		LimitBytes:    StorageLimitBytes(tier),
		PlanTier:      tier,
	}, nil
}

// gateStorageTx serializes creation decisions on the user's counter row.
// Resource triggers update used_bytes after the gate succeeds in the same
// transaction, so a concurrent creation cannot pass the check twice.
func (s *Store) gateStorageTx(ctx context.Context, tx pgx.Tx, userID string, requested int64) error {
	if requested < 0 {
		return fmt.Errorf("negative storage request: %d", requested)
	}
	// Lifecycle first: an over-quota or locked account must not create even
	// when the byte counter would still fit. The counter lock below also
	// serializes this check against concurrent creates.
	status, err := s.accountAccess(ctx, tx, userID)
	if err != nil {
		return err
	}
	if err := status.CreateErr(); err != nil {
		return err
	}
	tier, usage, err := s.lockedStorageUsageTx(ctx, tx, userID)
	if err != nil {
		return err
	}
	if usage.UsedBytes+usage.ReservedBytes+requested > usage.LimitBytes {
		return &QuotaExceededError{
			UserID:         userID,
			UsedBytes:      usage.UsedBytes,
			ReservedBytes:  usage.ReservedBytes,
			RequestedBytes: requested,
			LimitBytes:     usage.LimitBytes,
			PlanTier:       tier,
		}
	}
	return nil
}

func (s *Store) reserveStorageTx(ctx context.Context, tx pgx.Tx, userID string, requested int64) error {
	if err := s.gateStorageTx(ctx, tx, userID, requested); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE user_storage
		SET reserved_bytes=reserved_bytes+$2, updated_at=now()
		WHERE user_id=$1`, userID, requested)
	return err
}

func (s *Store) lockWorkspaceTx(ctx context.Context, tx pgx.Tx, workspaceID string) error {
	var id string
	err := tx.QueryRow(ctx, `SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, workspaceID).Scan(&id)
	if isNoRows(err) {
		return ErrNotFound
	}
	return err
}

func (s *Store) workspaceFileUsageTx(ctx context.Context, tx pgx.Tx, workspaceID string) (files, reserved int, err error) {
	err = tx.QueryRow(ctx, `SELECT count(*) FROM files WHERE workspace_id=$1`, workspaceID).Scan(&files)
	if err != nil {
		return
	}
	err = tx.QueryRow(ctx, `
		SELECT count(*) FROM upload_sessions
		WHERE workspace_id=$1 AND target='source' AND status='pending' AND expires_at > now()`,
		workspaceID).Scan(&reserved)
	return
}

// gateWorkspaceFilesTx enforces the per-workspace file cap and the per-request
// batch cap. requested is the number of files this write wants to add. Open
// unexpired source upload sessions count as reserved slots so concurrent
// session creates cannot all pass a check against 99.
func (s *Store) gateWorkspaceFilesTx(ctx context.Context, tx pgx.Tx, workspaceID string, requested int) error {
	if requested < 0 {
		return fmt.Errorf("negative file request: %d", requested)
	}
	if err := s.lockWorkspaceTx(ctx, tx, workspaceID); err != nil {
		return err
	}
	files, reserved, err := s.workspaceFileUsageTx(ctx, tx, workspaceID)
	if err != nil {
		return err
	}
	if requested > MaxFilesPerUpload {
		return &FileLimitExceededError{
			WorkspaceID: workspaceID,
			Used:        files,
			Reserved:    reserved,
			Requested:   requested,
			Limit:       MaxFilesPerUpload,
			Kind:        "batch",
		}
	}
	if files+reserved+requested > MaxFilesPerWorkspace {
		return &FileLimitExceededError{
			WorkspaceID: workspaceID,
			Used:        files,
			Reserved:    reserved,
			Requested:   requested,
			Limit:       MaxFilesPerWorkspace,
			Kind:        "workspace",
		}
	}
	return nil
}

// AssertWorkspaceFileRoom is the non-insert preflight for a batch (cloud
// import). It locks the workspace, checks room, and rolls back — the inserts
// still go through gateWorkspaceFilesTx.
func (s *Store) AssertWorkspaceFileRoom(ctx context.Context, workspaceID string, requested int) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	return s.gateWorkspaceFilesTx(ctx, tx, workspaceID, requested)
}

func (s *Store) releaseStorageReservationTx(ctx context.Context, tx pgx.Tx, userID string, bytes int64) error {
	if bytes < 0 {
		return fmt.Errorf("negative storage reservation release: %d", bytes)
	}
	if err := s.ensureStorageRowTx(ctx, tx, userID); err != nil {
		return err
	}
	if err := s.lockStorageRowTx(ctx, tx, userID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE user_storage
		SET reserved_bytes=GREATEST(0, reserved_bytes-$2), updated_at=now()
		WHERE user_id=$1`, userID, bytes)
	return err
}

func (s *Store) StorageUsage(ctx context.Context, userID string) (StorageUsage, error) {
	return s.unlockedStorageUsage(ctx, s.pool, userID)
}

// ReconcileStorage recomputes counters from authoritative rows. Each user is
// repaired in its own short transaction, and only ledger rows observed before
// the authoritative read are removed; a concurrent material update therefore
// remains for the next pass instead of being lost.
func (s *Store) ReconcileStorage(ctx context.Context) (int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT id FROM users ORDER BY id`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var repaired int64
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return repaired, err
		}
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return repaired, err
		}
		if err := s.reconcileStorageUserTx(ctx, tx, userID); err != nil {
			_ = tx.Rollback(ctx)
			return repaired, err
		}
		if err := tx.Commit(ctx); err != nil {
			return repaired, err
		}
		repaired++
	}
	return repaired, rows.Err()
}

func (s *Store) reconcileStorageUserTx(ctx context.Context, tx pgx.Tx, userID string) error {
	if err := s.lockStorageRowTx(ctx, tx, userID); err != nil {
		return err
	}
	for _, query := range []string{
		`SELECT id FROM files WHERE user_id=$1 FOR UPDATE`,
		`SELECT id FROM editor_assets WHERE user_id=$1 FOR UPDATE`,
		`SELECT id FROM materials WHERE owner_user_id=$1 FOR UPDATE`,
		`SELECT id FROM upload_sessions
			WHERE user_id=$1 AND status='pending' AND expires_at > now() FOR UPDATE`,
	} {
		rows, err := tx.Query(ctx, query, userID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
		}
		queryErr := rows.Err()
		rows.Close()
		if queryErr != nil {
			return queryErr
		}
	}
	var maxDeltaID int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(max(id), 0)
		FROM user_storage_deltas WHERE user_id=$1`, userID).Scan(&maxDeltaID); err != nil {
		return err
	}
	var used, reserved int64
	if err := tx.QueryRow(ctx, `SELECT
		COALESCE((SELECT sum(size_bytes) FROM files WHERE user_id=$1), 0)
		+ COALESCE((SELECT sum(size_bytes) FROM editor_assets
			WHERE user_id=$1 AND status='ready'), 0)
		+ COALESCE((SELECT sum(size_bytes) FROM materials
			WHERE owner_user_id=$1), 0),
		COALESCE((SELECT sum(declared_size) FROM upload_sessions
			WHERE user_id=$1 AND status='pending' AND expires_at > now()), 0)`,
		userID).Scan(&used, &reserved); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE user_storage
		SET used_bytes=$2, reserved_bytes=$3, updated_at=now()
		WHERE user_id=$1`, userID, used, reserved); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM user_storage_deltas
		WHERE user_id=$1 AND id <= $2`, userID, maxDeltaID)
	return err
}
