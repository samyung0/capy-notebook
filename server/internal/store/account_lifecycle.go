package store

import (
	"context"
	"encoding/json"
	"time"
)

// DeletionGraceDays is the reactivation window between a deletion request and
// the purge. The purge needs a job regardless — it enumerates workspaces, blobs
// and per-workspace RAG tenants, which cannot run inside an HTTP request — so
// the window costs nothing beyond one timestamp and buys a lossless undo.
const DeletionGraceDays = 30

// RequestAccountDeletion locks the account and schedules its purge. Callers are
// responsible for the preconditions (no live subscription, no co-owned
// workspaces) and for revoking the identity's sessions; this only moves the
// lifecycle columns.
//
// immediate skips the reactivation window. It is used when the Clerk identity
// itself is already gone, because there is then no way for the user to come
// back and claim the account.
func (s *Store) RequestAccountDeletion(
	ctx context.Context,
	userID string,
	immediate bool,
) (AccountStatus, error) {
	purgeAfter := time.Now().AddDate(0, 0, DeletionGraceDays)
	if immediate {
		purgeAfter = time.Now()
	}
	// COALESCE keeps the original request time so a repeated request (or a
	// user.deleted webhook arriving after a self-service request) does not
	// extend the window. An immediate request still pulls purge_after forward.
	_, err := s.pool.Exec(ctx, `UPDATE users SET
			deletion_requested_at = COALESCE(deletion_requested_at, now()),
			purge_after = CASE
				WHEN purge_after IS NULL THEN $2::timestamptz
				ELSE least(purge_after, $2::timestamptz)
			END,
			updated_at = now()
		WHERE id = $1 AND deleted_at IS NULL`, userID, purgeAfter)
	if err != nil {
		return AccountStatus{}, err
	}
	// A no-op update means the account is already a purged tombstone; the
	// resolved state reports that rather than failing.
	return s.AccountAccess(ctx, userID)
}

// FindActiveUserIDByEmail resolves a live (non-deleted) account by email.
// Used by support tooling; the unique index only covers active rows.
func (s *Store) FindActiveUserIDByEmail(ctx context.Context, email string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx,
		`SELECT id FROM users
			WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
		email).Scan(&id)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return id, err
}

// CancelAccountDeletion reactivates an account still inside its deletion grace
// window. There is no user-facing API for this — support runs
// cmd/cancel-deletion after verifying the request out-of-band.
func (s *Store) CancelAccountDeletion(ctx context.Context, userID string) (AccountStatus, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE users SET
			deletion_requested_at = NULL,
			purge_after = NULL,
			updated_at = now()
		WHERE id = $1 AND deleted_at IS NULL AND deletion_requested_at IS NOT NULL`, userID)
	if err != nil {
		return AccountStatus{}, err
	}
	if tag.RowsAffected() == 0 {
		status, statusErr := s.AccountAccess(ctx, userID)
		if statusErr != nil {
			return AccountStatus{}, statusErr
		}
		// A purged account cannot be reinstated: its content is gone.
		if status.State == AccountDeleted {
			return status, ErrForbidden
		}
		return status, nil
	}
	return s.AccountAccess(ctx, userID)
}

// MarkIdentityDeleted handles a Clerk user.deleted event. The identity is gone,
// so the account enters the same purge flow with no reactivation window. It is
// idempotent: an account already scheduled or already purged is left alone.
func (s *Store) MarkIdentityDeleted(ctx context.Context, userID string) error {
	_, err := s.RequestAccountDeletion(ctx, userID, true)
	return err
}

// NotifyAccountDeletionRequested records the in-app + email confirmation that
// the purge window has started. Best-effort: a failure here must not roll back
// the lifecycle transition itself.
func (s *Store) NotifyAccountDeletionRequested(ctx context.Context, userID string) error {
	var email *string
	var locale string
	var purgeAfter *time.Time
	err := s.pool.QueryRow(ctx, `SELECT email, locale, purge_after FROM users WHERE id=$1`, userID).
		Scan(&email, &locale, &purgeAfter)
	if err != nil {
		return err
	}
	toEmail := ""
	if email != nil {
		toEmail = *email
	}
	data, err := json.Marshal(map[string]any{
		"code":       "account_deletion_requested",
		"purgeAfter": purgeAfter,
		"graceDays":  DeletionGraceDays,
	})
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := NotifyTx(ctx, tx, NotifyParams{
		UserID:         userID,
		ToEmail:        toEmail,
		Locale:         locale,
		Kind:           NotifSystem,
		Data:           data,
		Href:           "/settings",
		Template:       "account-deletion-requested",
		Category:       "lifecycle",
		IdempotencyKey: "account-deletion-requested:" + userID,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// NotifyAccountDeletionCancelled records that the user reactivated in time.
func (s *Store) NotifyAccountDeletionCancelled(ctx context.Context, userID string) error {
	var email *string
	var locale string
	err := s.pool.QueryRow(ctx, `SELECT email, locale FROM users WHERE id=$1`, userID).
		Scan(&email, &locale)
	if err != nil {
		return err
	}
	toEmail := ""
	if email != nil {
		toEmail = *email
	}
	data, err := json.Marshal(map[string]any{"code": "account_deletion_cancelled"})
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := NotifyTx(ctx, tx, NotifyParams{
		UserID:         userID,
		ToEmail:        toEmail,
		Locale:         locale,
		Kind:           NotifSystem,
		Data:           data,
		Href:           "/settings",
		Template:       "account-deletion-cancelled",
		Category:       "lifecycle",
		IdempotencyKey: "account-deletion-cancelled:" + userID + ":" + time.Now().UTC().Format("2006-01-02T15"),
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
