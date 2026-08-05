package integrations

import (
	"context"
	"fmt"

	clerksession "github.com/clerk/clerk-sdk-go/v2/session"
	clerkuser "github.com/clerk/clerk-sdk-go/v2/user"
)

// Clerk is the system of record for credentials; this database is the system of
// record for account lifecycle. These helpers are how a lifecycle transition
// here is pushed back to the identity provider.

// sessionRevokeMaxPasses bounds the revoke loop. Revoking a session removes it
// from the "active" filter, so each pass re-reads from the start rather than
// advancing an offset that would skip sessions shifting down behind it.
const sessionRevokeMaxPasses = 20

// RevokeUserSessions revokes every active Clerk session for a user. Flipping a
// lifecycle flag locally is not enough on its own: an already-issued JWT stays
// valid until it expires, so the account would keep working for minutes after
// deletion or suspension.
//
// Errors from individual revocations are collected rather than aborting the
// sweep, so one stuck session cannot leave the rest live.
func RevokeUserSessions(ctx context.Context, userID string) error {
	status := "active"
	var firstErr error
	for pass := 0; pass < sessionRevokeMaxPasses; pass++ {
		list, err := clerksession.List(ctx, &clerksession.ListParams{
			UserID: &userID,
			Status: &status,
		})
		if err != nil {
			return fmt.Errorf("clerk list sessions: %w", err)
		}
		if len(list.Sessions) == 0 {
			return firstErr
		}
		revoked := 0
		for _, s := range list.Sessions {
			if s == nil {
				continue
			}
			if _, err := clerksession.Revoke(ctx, &clerksession.RevokeParams{ID: s.ID}); err != nil {
				if firstErr == nil {
					firstErr = fmt.Errorf("clerk revoke session %s: %w", s.ID, err)
				}
				continue
			}
			revoked++
		}
		// Nothing moved, so further passes would repeat the same failures.
		if revoked == 0 {
			return firstErr
		}
	}
	return firstErr
}

// DeleteIdentity removes the Clerk user. Called at the end of a purge, once the
// local content is gone: at that point there is nothing left for the identity to
// sign in to, and Clerk's own user.deleted webhook becomes a no-op because the
// account is already a tombstone.
func DeleteIdentity(ctx context.Context, userID string) error {
	if _, err := clerkuser.Delete(ctx, userID); err != nil {
		return fmt.Errorf("clerk delete user: %w", err)
	}
	return nil
}
