package store

import (
	"context"
	"encoding/json"
	"strconv"
	"time"
)

// DeletionGraceDays is the reactivation window between a deletion request and
// the purge. The purge needs a job regardless — it enumerates workspaces, blobs
// and per-workspace RAG tenants, which cannot run inside an HTTP request — so
// the window costs nothing beyond one timestamp and buys a lossless undo.
const DeletionGraceDays = 30

// RequestAccountDeletion locks the account and schedules its purge. Callers are
// responsible for the billing precondition (no live subscription). Callers
// outside the self-service HTTP path are also responsible for identity session
// handling; the HTTP path uses the generation-fenced durable-revocation form.
//
// immediate skips the reactivation window. It is used when the Clerk identity
// itself is already gone, because there is then no way for the user to come
// back and claim the account.
func (s *Store) RequestAccountDeletion(
	ctx context.Context,
	userID string,
	immediate bool,
) (AccountStatus, error) {
	return s.requestAccountDeletion(ctx, userID, immediate, nil)
}

// RequestAccountDeletionAtGeneration rejects a confirmation based on a stale
// preflight. Support cancellation advances the generation, while duplicate
// requests made against the same uninterrupted deletion window stay
// idempotent.
func (s *Store) RequestAccountDeletionAtGeneration(
	ctx context.Context,
	userID string,
	immediate bool,
	expectedGeneration int64,
) (AccountStatus, error) {
	return s.requestAccountDeletionAtGeneration(
		ctx, userID, immediate, expectedGeneration, false,
	)
}

// RequestAccountDeletionAtGenerationWithSessionRevocation atomically closes
// the local account gate and records that Clerk sessions still need a complete
// sweep. The HTTP deletion path uses this form so a process crash cannot leave
// an untracked external session between the database commit and the Clerk call.
func (s *Store) RequestAccountDeletionAtGenerationWithSessionRevocation(
	ctx context.Context,
	userID string,
	immediate bool,
	expectedGeneration int64,
) (AccountStatus, error) {
	return s.requestAccountDeletionAtGeneration(
		ctx, userID, immediate, expectedGeneration, true,
	)
}

func (s *Store) requestAccountDeletionAtGeneration(
	ctx context.Context,
	userID string,
	immediate bool,
	expectedGeneration int64,
	revokeSessions bool,
) (AccountStatus, error) {
	unlock, err := s.lockAccountLifecycle(ctx, userID)
	if err != nil {
		return AccountStatus{}, err
	}
	defer unlock()
	return s.requestAccountDeletion(
		ctx, userID, immediate, &expectedGeneration, revokeSessions,
	)
}

func (s *Store) requestAccountDeletion(
	ctx context.Context,
	userID string,
	immediate bool,
	expectedGeneration *int64,
	revokeSessions ...bool,
) (AccountStatus, error) {
	purgeAfter := time.Now().AddDate(0, 0, DeletionGraceDays)
	if immediate {
		purgeAfter = time.Now()
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AccountStatus{}, err
	}
	defer tx.Rollback(ctx)
	var deletedAt *time.Time
	var lifecycleGeneration int64
	if err := tx.QueryRow(ctx, `SELECT deleted_at, lifecycle_generation
		FROM users WHERE id=$1 FOR UPDATE`, userID).
		Scan(&deletedAt, &lifecycleGeneration); err != nil {
		if isNoRows(err) {
			return AccountStatus{}, ErrNotFound
		}
		return AccountStatus{}, err
	}
	if expectedGeneration != nil && lifecycleGeneration != *expectedGeneration {
		return AccountStatus{}, ErrAccountLifecycleChanged
	}
	if deletedAt != nil {
		return s.accountAccess(ctx, tx, userID)
	}
	// COALESCE keeps the original request time so a repeated request (or a
	// user.deleted webhook arriving after a self-service request) does not
	// extend the window. An immediate request still pulls purge_after forward.
	needsSessionRevocation := len(revokeSessions) > 0 && revokeSessions[0]
	_, err = tx.Exec(ctx, `UPDATE users SET
			deletion_requested_at = COALESCE(deletion_requested_at, now()),
			purge_after = CASE
				WHEN purge_after IS NULL THEN $2::timestamptz
				ELSE least(purge_after, $2::timestamptz)
			END,
			session_revoke_pending = CASE
				WHEN $3 AND deletion_requested_at IS NULL THEN true
				ELSE session_revoke_pending
			END,
			session_revoke_attempts = CASE
				WHEN $3 AND deletion_requested_at IS NULL THEN 0
				ELSE session_revoke_attempts
			END,
			session_revoke_not_before = CASE
				WHEN $3 AND deletion_requested_at IS NULL THEN now()
				ELSE session_revoke_not_before
			END,
			session_revoke_last_error = CASE
				WHEN $3 AND deletion_requested_at IS NULL THEN ''
				ELSE session_revoke_last_error
			END,
			updated_at = now()
		WHERE id = $1 AND deleted_at IS NULL`, userID, purgeAfter, needsSessionRevocation)
	if err != nil {
		return AccountStatus{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT cancel_user_async_work($1)`, userID); err != nil {
		return AccountStatus{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO stripe_compensations
		(user_id, action, object_id)
		SELECT $1, 'expire_checkout', provider_session_id
		FROM stripe_checkout_sessions
		WHERE user_id=$1 AND status='open' AND provider_session_id IS NOT NULL
		ON CONFLICT (action, object_id) DO UPDATE SET
			status='pending',attempts=0,lease_token=NULL,lease_expires_at=NULL,
			next_attempt_at=now(),last_error='',completed_at=NULL,updated_at=now()
		WHERE stripe_compensations.status='suppressed'`, userID); err != nil {
		return AccountStatus{}, err
	}
	// The remote preflight and this transaction cannot be atomic. A Checkout
	// webhook may have activated a local subscription between them, so enqueue
	// cancellation under the same user-row lock instead of waiting for the daily
	// reconciliation backstop.
	if _, err := tx.Exec(ctx, `INSERT INTO stripe_compensations
		(user_id, action, object_id)
		SELECT $1, 'cancel_subscription', stripe_subscription_id
		FROM user_subscriptions
		WHERE user_id=$1 AND status IN `+entitlingStatuses+`
		  AND (current_period_end IS NULL OR current_period_end>now())
		  AND NOT cancel_at_period_end
		ON CONFLICT (action, object_id) DO UPDATE SET
			status='pending',attempts=0,lease_token=NULL,lease_expires_at=NULL,
			provider_started_at=NULL,next_attempt_at=now(),last_error='',
			completed_at=NULL,updated_at=now()
		WHERE stripe_compensations.status IN ('succeeded','suppressed')`, userID); err != nil {
		return AccountStatus{}, err
	}
	status, err := s.accountAccess(ctx, tx, userID)
	if err != nil {
		return AccountStatus{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AccountStatus{}, err
	}
	// A no-op update means the account is already a purged tombstone; the
	// resolved state reports that rather than failing.
	return status, nil
}

// AccountLifecycleGeneration returns the optimistic token included in account
// deletion preflight. It changes only when support cancels deletion.
func (s *Store) AccountLifecycleGeneration(ctx context.Context, userID string) (int64, error) {
	var generation int64
	err := s.pool.QueryRow(ctx,
		`SELECT lifecycle_generation FROM users WHERE id=$1`, userID).Scan(&generation)
	if isNoRows(err) {
		return 0, ErrNotFound
	}
	return generation, err
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
	unlock, err := s.lockAccountLifecycle(ctx, userID)
	if err != nil {
		return AccountStatus{}, err
	}
	defer unlock()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AccountStatus{}, err
	}
	defer tx.Rollback(ctx)
	var providerCancellationStarted, sessionRevocationPending bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM stripe_compensations
		WHERE user_id=$1 AND action='cancel_subscription'
		  AND status IN ('pending','running')
		  AND provider_started_at IS NOT NULL
	), (SELECT session_revoke_pending FROM users WHERE id=$1)`, userID).
		Scan(&providerCancellationStarted, &sessionRevocationPending); err != nil {
		return AccountStatus{}, err
	}
	if providerCancellationStarted || sessionRevocationPending {
		return AccountStatus{}, ErrConflict
	}
	tag, err := tx.Exec(ctx, `UPDATE users SET
			deletion_requested_at = NULL,
			purge_after = NULL,
			lifecycle_generation = lifecycle_generation + 1,
			updated_at = now()
		WHERE id = $1 AND deleted_at IS NULL AND identity_deleted_at IS NULL
			AND deletion_requested_at IS NOT NULL
			AND purge_after > now()`, userID)
	if err != nil {
		return AccountStatus{}, err
	}
	if tag.RowsAffected() == 0 {
		var identityDeletedAt *time.Time
		if err := s.pool.QueryRow(ctx, `SELECT identity_deleted_at FROM users WHERE id=$1`,
			userID).Scan(&identityDeletedAt); err != nil {
			if isNoRows(err) {
				return AccountStatus{}, ErrNotFound
			}
			return AccountStatus{}, err
		}
		status, statusErr := s.AccountAccess(ctx, userID)
		if statusErr != nil {
			return AccountStatus{}, statusErr
		}
		// A purged account cannot be reinstated: its content is gone.
		if status.State == AccountDeleted || status.State == AccountDeletionPending || identityDeletedAt != nil {
			return status, ErrForbidden
		}
		return status, nil
	}
	// Expiration/cancellation is deletion-only work and must not run after this
	// transaction restores the account. Refund jobs are deliberately retained:
	// once a raced charge or cancellation occurred, refunding it remains owed.
	if _, err := tx.Exec(ctx, `UPDATE stripe_compensations SET
		status='suppressed',lease_token=NULL,lease_expires_at=NULL,
		last_error='account deletion cancelled',updated_at=now()
		WHERE user_id=$1 AND status='pending'
		  AND action IN ('expire_checkout','cancel_subscription')`, userID); err != nil {
		return AccountStatus{}, err
	}
	// Reconciliation preserves live Stripe rows while the lifecycle is closed
	// and only suppresses their local projection. Restore that projection in the
	// same transaction as the lifecycle so the account never waits for the next
	// daily Stripe pass to regain an entitlement that still exists remotely.
	if err := s.deriveUserPlanTx(ctx, tx, userID); err != nil {
		return AccountStatus{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AccountStatus{}, err
	}
	return s.AccountAccess(ctx, userID)
}

// lockAccountLifecycle serializes cancellation with the multi-transaction
// purge workflow. A session advisory lock survives the workspace-deletion
// transactions inside PurgeUser, and PostgreSQL releases it automatically if
// the connection dies.
func (s *Store) lockAccountLifecycle(ctx context.Context, userID string) (func(), error) {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	lockKey := "account-lifecycle:" + userID
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext($1))`, lockKey); err != nil {
		conn.Release()
		return nil, err
	}
	return func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock(hashtext($1))`, lockKey)
		conn.Release()
	}, nil
}

// MarkIdentityDeleted handles a Clerk user.deleted event. The identity is gone,
// so the account enters the same purge flow with no reactivation window. It is
// idempotent: an account already scheduled or already purged is left alone.
func (s *Store) MarkIdentityDeleted(ctx context.Context, userID string) error {
	unlock, err := s.lockAccountLifecycle(ctx, userID)
	if err != nil {
		return err
	}
	defer unlock()
	if _, err := s.RequestAccountDeletion(ctx, userID, true); err != nil {
		return err
	}
	return s.MarkIdentityDeletionComplete(ctx, userID)
}

// NotifyAccountDeletionRequested records the in-app + email confirmation that
// the purge window has started. Best-effort: a failure here must not roll back
// the lifecycle transition itself.
func (s *Store) NotifyAccountDeletionRequested(ctx context.Context, userID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var email *string
	var locale string
	var purgeAfter *time.Time
	var lifecycleGeneration int64
	err = tx.QueryRow(ctx, `SELECT email, locale, purge_after, lifecycle_generation
		FROM users WHERE id=$1 AND deletion_requested_at IS NOT NULL
			AND deleted_at IS NULL FOR UPDATE`, userID).
		Scan(&email, &locale, &purgeAfter, &lifecycleGeneration)
	if isNoRows(err) {
		return nil
	}
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
	if _, err := NotifyTx(ctx, tx, NotifyParams{
		UserID:   userID,
		ToEmail:  toEmail,
		Locale:   locale,
		Kind:     NotifSystem,
		Data:     data,
		Href:     "/settings",
		Template: "account-deletion-requested",
		Category: "lifecycle",
		IdempotencyKey: "account-deletion-requested:" + userID + ":" +
			strconv.FormatInt(lifecycleGeneration, 10),
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// NotifyAccountDeletionCancelled records that the user reactivated in time.
func (s *Store) NotifyAccountDeletionCancelled(ctx context.Context, userID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var email *string
	var locale string
	var lifecycleGeneration int64
	err = tx.QueryRow(ctx, `SELECT email, locale, lifecycle_generation
		FROM users WHERE id=$1 AND deletion_requested_at IS NULL
			AND deleted_at IS NULL FOR UPDATE`, userID).
		Scan(&email, &locale, &lifecycleGeneration)
	if isNoRows(err) {
		return nil
	}
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
	if _, err := NotifyTx(ctx, tx, NotifyParams{
		UserID:   userID,
		ToEmail:  toEmail,
		Locale:   locale,
		Kind:     NotifSystem,
		Data:     data,
		Href:     "/settings",
		Template: "account-deletion-cancelled",
		Category: "lifecycle",
		IdempotencyKey: "account-deletion-cancelled:" + userID + ":" +
			strconv.FormatInt(lifecycleGeneration, 10),
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
