package store

import (
	"context"
	"time"
)

// ClaimUsersDueForPurge returns tombstone candidates whose purge window has
// elapsed. The claim is soft: callers must call PurgeUser, which is idempotent
// against a concurrent purge of the same row.
func (s *Store) ClaimUsersDueForPurge(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 10
	}
	rows, err := s.pool.Query(ctx, `SELECT id FROM users
		WHERE deleted_at IS NULL
			AND purge_after IS NOT NULL
			AND purge_after <= now()
		ORDER BY purge_after
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
// Order matters:
//  1. Destroy owned workspaces (cascade + blob deletion outbox + RAG teardown).
//  2. Destroy standalone materials and personal planner data.
//  3. Scrub PII and set deleted_at in one statement so a crash between content
//     deletion and scrub cannot leave an authenticated account with empty data.
func (s *Store) PurgeUser(ctx context.Context, userID string) error {
	status, err := s.AccountAccess(ctx, userID)
	if err != nil {
		return err
	}
	if status.State == AccountDeleted {
		return nil
	}
	if status.State != AccountDeletionPending {
		return ErrForbidden
	}
	// Refuse a premature scrub that would destroy content while reactivation
	// is still offered. Immediate Clerk-deleted identities set purge_after=now.
	if status.PurgeAfter != nil && status.PurgeAfter.After(time.Now()) {
		return ErrForbidden
	}

	owned, err := s.WorkspacesDestroyedByDeletion(ctx, userID)
	if err != nil {
		return err
	}
	blocking, err := s.WorkspacesBlockingDeletion(ctx, userID)
	if err != nil {
		return err
	}
	// Shared workspaces must have been transferred before deletion was
	// requested. If any remain, refuse rather than silently destroying other
	// people's membership.
	if len(blocking) > 0 {
		return ErrForbidden
	}
	for _, ws := range owned {
		if _, err := s.DeleteWorkspaceWithResult(ctx, userID, ws.ID); err != nil {
			return err
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

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
	if _, err := tx.Exec(ctx, `DELETE FROM email_outbox
		WHERE user_id=$1 AND status='pending'`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM lifecycle_notices WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM user_llm_credentials WHERE user_id=$1`, userID); err != nil {
		return err
	}

	// Scrub PII. Keep stripe_customer_id — invoice history depends on it.
	// email is set NULL so the unique active-email index frees the address.
	tag, err := tx.Exec(ctx, `UPDATE users SET
			name = '',
			email = NULL,
			avatar_url = NULL,
			class_label = NULL,
			deleted_at = COALESCE(deleted_at, now()),
			deletion_requested_at = COALESCE(deletion_requested_at, now()),
			purge_after = COALESCE(purge_after, now()),
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
