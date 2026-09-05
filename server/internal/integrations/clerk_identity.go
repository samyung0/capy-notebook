package integrations

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/clerk/clerk-sdk-go/v2"
	clerksession "github.com/clerk/clerk-sdk-go/v2/session"
	clerkuser "github.com/clerk/clerk-sdk-go/v2/user"
)

// Clerk is the system of record for credentials; this database is the system of
// record for account lifecycle. These helpers are how a lifecycle transition
// here is pushed back to the identity provider.

const (
	sessionRevokePageSize  int64 = 100
	sessionRevokeMaxPages        = 100
	sessionRevokeMaxSweeps       = 20
)

var errClerkSessionsRemain = errors.New("active Clerk sessions remain after revoke sweep")

type activeSessionLister func(context.Context, string, int64, int64) ([]string, int64, error)
type sessionRevoker func(context.Context, string) error

// RevokeUserSessions revokes every active Clerk session for a user. Flipping a
// lifecycle flag locally is not enough on its own: an already-issued JWT stays
// valid until it expires, so the account would keep working for minutes after
// deletion or suspension.
//
// Errors from individual revocations are collected rather than aborting the
// sweep, so one stuck session cannot leave the rest live.
func RevokeUserSessions(ctx context.Context, userID string) error {
	list := func(ctx context.Context, userID string, limit, offset int64) ([]string, int64, error) {
		status := "active"
		page, err := clerksession.List(ctx, &clerksession.ListParams{
			ListParams: clerk.ListParams{Limit: &limit, Offset: &offset},
			UserID:     &userID,
			Status:     &status,
		})
		if err != nil {
			return nil, 0, err
		}
		ids := make([]string, 0, len(page.Sessions))
		for _, session := range page.Sessions {
			if session != nil && session.ID != "" {
				ids = append(ids, session.ID)
			} else {
				// Preserve the provider page width so the next offset cannot move
				// backwards if Clerk returns a malformed entry.
				ids = append(ids, "")
			}
		}
		return ids, page.TotalCount, nil
	}
	revoke := func(ctx context.Context, sessionID string) error {
		_, err := clerksession.Revoke(ctx, &clerksession.RevokeParams{ID: sessionID})
		return err
	}
	return revokeUserSessions(ctx, userID, list, revoke)
}

func revokeUserSessions(
	ctx context.Context,
	userID string,
	list activeSessionLister,
	revoke sessionRevoker,
) error {
	var firstErr error
	for sweep := 0; sweep < sessionRevokeMaxSweeps; sweep++ {
		ids := make([]string, 0, sessionRevokePageSize)
		var offset int64
		for pageNo := 0; ; pageNo++ {
			page, total, err := list(ctx, userID, sessionRevokePageSize, offset)
			if err != nil {
				return fmt.Errorf("clerk list sessions: %w", err)
			}
			ids = append(ids, page...)
			offset += int64(len(page))
			if len(page) == 0 && offset < total {
				return errors.Join(firstErr, errClerkSessionsRemain)
			}
			if offset >= total {
				break
			}
			if pageNo+1 >= sessionRevokeMaxPages {
				return errors.Join(firstErr, errClerkSessionsRemain)
			}
		}
		if len(ids) == 0 {
			// The active-session listing is provider truth. A previous revoke may
			// have returned an uncertain error even though Clerk applied it, or the
			// session may have disappeared through another device in the meantime.
			return nil
		}
		revoked := 0
		for _, sessionID := range ids {
			if sessionID == "" {
				continue
			}
			if err := revoke(ctx, sessionID); err != nil {
				if identityAlreadyDeleted(err) {
					revoked++
					continue
				}
				if firstErr == nil {
					firstErr = fmt.Errorf("clerk revoke session %s: %w", sessionID, err)
				}
				continue
			}
			revoked++
		}
		// Even when every call returned an error, list again. A provider timeout
		// does not prove that the revoke failed, while an empty listing does prove
		// that no active session remains.
		if revoked == 0 {
			continue
		}
	}
	return errors.Join(firstErr, errClerkSessionsRemain)
}

// DeleteIdentity removes the Clerk user. Called at the end of a purge, once the
// local content is gone: at that point there is nothing left for the identity to
// sign in to, and Clerk's own user.deleted webhook becomes a no-op because the
// account is already a tombstone.
func DeleteIdentity(ctx context.Context, userID string) error {
	if _, err := clerkuser.Delete(ctx, userID); err != nil {
		if identityAlreadyDeleted(err) {
			return nil
		}
		return fmt.Errorf("clerk delete user: %w", err)
	}
	return nil
}

func identityAlreadyDeleted(err error) bool {
	var apiErr *clerk.APIErrorResponse
	return errors.As(err, &apiErr) && apiErr.HTTPStatusCode == http.StatusNotFound
}
