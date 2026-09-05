package store

import (
	"context"
	"strings"
	"time"
)

const sessionRevocationLease = 5 * time.Minute

// ClaimUsersDueForSessionRevocation leases due Clerk session sweeps. A soft
// lease makes the work replica-safe enough for an idempotent provider call and
// guarantees that a crashed worker becomes due again.
func (s *Store) ClaimUsersDueForSessionRevocation(
	ctx context.Context,
	limit int,
) ([]string, error) {
	if limit <= 0 {
		limit = 10
	}
	rows, err := s.pool.Query(ctx, `WITH due AS (
		SELECT id FROM users
		WHERE session_revoke_pending
		  AND deletion_requested_at IS NOT NULL
		  AND deleted_at IS NULL
		  AND COALESCE(session_revoke_not_before, now()) <= now()
		ORDER BY session_revoke_not_before NULLS FIRST, id
		FOR UPDATE SKIP LOCKED
		LIMIT $1
	)
	UPDATE users u SET
		session_revoke_not_before=now()+make_interval(secs => $2),
		updated_at=now()
	FROM due WHERE u.id=due.id
	RETURNING u.id`, limit, int(sessionRevocationLease/time.Second))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) MarkSessionRevocationComplete(ctx context.Context, userID string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE users SET
		session_revoke_pending=false,
		session_revoke_not_before=NULL,
		session_revoke_last_error='',
		updated_at=now()
		WHERE id=$1 AND session_revoke_pending`, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)`, userID).
			Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
	}
	return nil
}

func (s *Store) RetrySessionRevocation(
	ctx context.Context,
	userID string,
	revokeErr error,
) error {
	message := "session revocation failed"
	if revokeErr != nil && strings.TrimSpace(revokeErr.Error()) != "" {
		message = revokeErr.Error()
	}
	tag, err := s.pool.Exec(ctx, `UPDATE users SET
		session_revoke_pending=true,
		session_revoke_attempts=session_revoke_attempts+1,
		session_revoke_not_before=now()+make_interval(
			secs => LEAST(86400, 60 * (2 ^ LEAST(session_revoke_attempts, 10)))
		),
		session_revoke_last_error=$2,
		updated_at=now()
		WHERE id=$1 AND deletion_requested_at IS NOT NULL AND deleted_at IS NULL`, userID, message)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ClaimUsersDueForPurge returns tombstone candidates whose purge window has
// elapsed. The claim is soft: callers must call PurgeUser, which is idempotent
// against a concurrent purge of the same row.
func (s *Store) ClaimUsersDueForPurge(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 10
	}
	rows, err := s.pool.Query(ctx, `SELECT id FROM users
		WHERE (deleted_at IS NULL
			AND purge_after IS NOT NULL
			AND purge_after <= now())
		   OR (deleted_at IS NOT NULL AND identity_delete_pending
			AND COALESCE(identity_delete_not_before, now()) <= now())
		ORDER BY COALESCE(identity_delete_not_before, purge_after)
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// PurgeUser destroys the account's owned content, scrubs PII, and marks the row
// a tombstone. The user id is retained forever so authorship FKs stay valid
// and Stripe invoice history keeps its customer mapping.
//
// Owned content, PII scrubbing, and the tombstone are one transaction. Blob
// deletion remains an outbox side effect created by the same transaction.
func (s *Store) PurgeUser(ctx context.Context, userID string) error {
	unlock, err := s.lockAccountLifecycle(ctx, userID)
	if err != nil {
		return err
	}
	defer unlock()

	var deletionRequestedAt, purgeAfter, deletedAt *time.Time
	err = s.pool.QueryRow(ctx, `SELECT deletion_requested_at, purge_after, deleted_at
		FROM users WHERE id=$1`, userID).Scan(&deletionRequestedAt, &purgeAfter, &deletedAt)
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if deletedAt != nil {
		return nil
	}
	if deletionRequestedAt == nil || purgeAfter == nil {
		return ErrForbidden
	}
	// Refuse a premature scrub that would destroy content while reactivation
	// is still offered. Immediate Clerk-deleted identities set purge_after=now.
	if purgeAfter.After(time.Now()) {
		return ErrForbidden
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `SELECT w.id FROM workspaces w
		WHERE w.user_id=$1
		ORDER BY w.id
		FOR UPDATE OF w`, userID)
	if err != nil {
		return err
	}
	owned := []string{}
	for rows.Next() {
		var workspaceID string
		if err := rows.Scan(&workspaceID); err != nil {
			rows.Close()
			return err
		}
		owned = append(owned, workspaceID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, workspaceID := range owned {
		// Purge already owns the account-lifecycle advisory lock and requires a
		// due deletion request above. The normal API gate would reject this
		// intentionally deletion-pending account and strand every purge.
		if _, err := s.deleteWorkspaceWithResultTx(
			ctx, tx, userID, workspaceID, false,
		); err != nil {
			return err
		}
	}

	// Standalone materials (no workspace) are owned by the user directly.
	if _, err := tx.Exec(ctx, `DELETE FROM materials
		WHERE owner_user_id=$1 AND workspace_id IS NULL`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM events WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM tasks WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM canvases WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM labels WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM conversations WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM tags WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM attempts WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM mistakes WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM notifications WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM email_outbox WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM notification_prefs WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM lifecycle_notices WHERE user_id=$1`, userID); err != nil {
		return err
	}
	// Cloud-import identifiers can reveal document/drive identity and are not
	// needed once their actor requests destructive deletion. Completed upload
	// rows (workspace content) remain, but the provider-side request history does
	// not.
	if _, err := tx.Exec(ctx, `DELETE FROM source_import_jobs WHERE actor_user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE jobs SET payload=payload-'actorUserId'
		WHERE payload->>'actorUserId'=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM user_llm_credentials WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM user_model_reasoning WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM workspace_members WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM workspace_invites
		WHERE invited_user_id=$1 OR invited_by=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE workspace_invites SET accepted_by=NULL
		WHERE accepted_by=$1`, userID); err != nil {
		return err
	}
	// Attribution in content owned by somebody else survives as a tombstone,
	// but no longer resolves to the deleted user's profile. Existing Plate
	// mentions keep their stored label; the collaborator directory drops them.
	for _, statement := range []string{
		`UPDATE files SET created_by=NULL WHERE created_by=$1`,
		`UPDATE editor_assets SET created_by=NULL WHERE created_by=$1`,
		`UPDATE materials SET created_by=NULL WHERE created_by=$1`,
		`UPDATE materials SET updated_by=NULL WHERE updated_by=$1`,
		`UPDATE material_revisions SET created_by=NULL WHERE created_by=$1`,
		`UPDATE material_discussions SET created_by=NULL WHERE created_by=$1`,
		`UPDATE material_discussions SET deleted_by=NULL WHERE deleted_by=$1`,
		`UPDATE material_comments SET user_id=NULL WHERE user_id=$1`,
		`UPDATE material_comments SET deleted_by=NULL WHERE deleted_by=$1`,
	} {
		if _, err := tx.Exec(ctx, statement, userID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM operators WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE reconcile_runs SET requested_by_name=''
		WHERE requested_by_id=$1`, userID); err != nil {
		return err
	}
	// Webhook payloads can contain the old name, email, and avatar. Keep event
	// identity/status for delivery diagnostics but remove the personal body.
	if _, err := tx.Exec(ctx, `UPDATE webhook_events SET payload='{}'::jsonb
		WHERE user_id=$1`, userID); err != nil {
		return err
	}

	// Scrub PII. Keep stripe_customer_id — invoice history depends on it.
	// email is set NULL so the unique active-email index frees the address.
	tag, err := tx.Exec(ctx, `UPDATE users SET
			name = '',
			email = NULL,
			avatar_url = NULL,
			class_label = NULL,
			streak = 0,
			suspended_at = NULL,
			suspended_reason = NULL,
			deleted_at = COALESCE(deleted_at, now()),
			deletion_requested_at = COALESCE(deletion_requested_at, now()),
				purge_after = COALESCE(purge_after, now()),
				identity_delete_pending = identity_deleted_at IS NULL,
				identity_delete_not_before = CASE
					WHEN identity_deleted_at IS NULL THEN now()
					ELSE identity_delete_not_before END,
				updated_at = now()
		WHERE id = $1 AND deleted_at IS NULL`, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// Concurrent purge won; treat as success.
		return tx.Commit(ctx)
	}
	return tx.Commit(ctx)
}

func (s *Store) MarkIdentityDeletionComplete(ctx context.Context, userID string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE users SET
		identity_deleted_at=COALESCE(identity_deleted_at, now()),
		identity_delete_pending=false, identity_delete_not_before=NULL,
		session_revoke_pending=false, session_revoke_not_before=NULL,
		session_revoke_last_error='',
		updated_at=now() WHERE id=$1`, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) RetryIdentityDeletion(ctx context.Context, userID string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE users SET
		identity_delete_pending=true,
		identity_delete_attempts=identity_delete_attempts+1,
		identity_delete_not_before=now()+make_interval(
			secs => LEAST(86400, 60 * (2 ^ LEAST(identity_delete_attempts, 10)))
		), updated_at=now()
		WHERE id=$1 AND deleted_at IS NOT NULL AND identity_deleted_at IS NULL`, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
