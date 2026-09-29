package httpapi

import (
	"context"
	"errors"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

const liveAuthorizationRecheckInterval = 5 * time.Second

// liveWorkspaceContext keeps a long-running provider or event stream inside
// the same actor and workspace lifecycle boundary used at request admission.
// It closes promptly when the actor is locked, membership is removed, or the
// workspace owner starts account deletion.
func (a *api) liveWorkspaceContext(
	parent context.Context,
	userID, workspaceID string,
) (context.Context, context.CancelFunc) {
	return a.liveWorkspaceContextAtInterval(
		parent, userID, workspaceID, liveAuthorizationRecheckInterval,
	)
}

func (a *api) liveWorkspaceContextAtInterval(
	parent context.Context,
	userID, workspaceID string,
	interval time.Duration,
) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				allowed, _, err := a.s.AccountSessionAllowed(ctx, userID)
				if err != nil || !allowed {
					cancel()
					return
				}
				if _, err := a.s.WorkspaceAccess(ctx, userID, workspaceID); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	return ctx, cancel
}

// requireAccountEdit rejects the request when the authenticated user may not
// create or edit: a frozen account edits nowhere. Grace passes, and its storage
// growth fails the ordinary quota check instead.
func (a *api) requireAccountEdit(ctx context.Context) error {
	status, err := a.s.AccountAccess(ctx, userID(ctx))
	if err != nil {
		return hErr(err)
	}
	if err := status.Err(); err != nil {
		return hErr(err)
	}
	return nil
}

// requireAccountMutate admits the actions a frozen account keeps: deleting,
// narrowing exposure and account settings. Only locked accounts fail it.
func (a *api) requireAccountMutate(ctx context.Context) error {
	status, err := a.s.AccountAccess(ctx, userID(ctx))
	if err != nil {
		return hErr(err)
	}
	if err := status.MutateErr(); err != nil {
		return hErr(err)
	}
	return nil
}

// accountStatuses resolves each distinct account once, with its storage usage
// level. Owners repeat heavily in a list (most rows in "my workspaces" share
// one).
func (a *api) accountStatuses(
	ctx context.Context,
	userIDs ...string,
) (map[string]store.AccountStatus, error) {
	out := make(map[string]store.AccountStatus, 1)
	for _, id := range userIDs {
		if id == "" {
			continue
		}
		if _, done := out[id]; done {
			continue
		}
		status, err := a.s.AccountAccess(ctx, id)
		if err != nil {
			return nil, hErr(err)
		}
		if status, err = a.s.WithStorageUsage(ctx, status); err != nil {
			return nil, hErr(err)
		}
		out[id] = status
	}
	return out, nil
}

// workspaceStatuses resolves the requester and each workspace's storage owner.
//
// A workspace reports its owner's state and not the requester's: the owner is
// the account charged for the workspace's bytes, so the owner is who has to
// free space before anybody, member or owner, can add to it. The requester's
// own state only decides whether they may edit at all.
func (a *api) workspaceStatuses(
	ctx context.Context,
	ws ...store.Workspace,
) (map[string]store.AccountStatus, error) {
	ids := make([]string, len(ws))
	for i, w := range ws {
		ids[i] = w.OwnerUserID
	}
	statuses, err := a.accountStatuses(ctx, ids...)
	if err != nil {
		return nil, err
	}
	// The requester needs only their state (can they edit at all), not usage.
	if requester := userID(ctx); requester != "" {
		if _, done := statuses[requester]; !done {
			status, err := a.s.AccountAccess(ctx, requester)
			if err != nil {
				return nil, hErr(err)
			}
			statuses[requester] = status
		}
	}
	return statuses, nil
}

// editErr returns the locked error when a frozen (or locked) account makes
// content paid for by ownerID read-only for the requester: their own account,
// or the owner's.
func (a *api) editErr(ctx context.Context, ownerID string) error {
	for _, id := range []string{userID(ctx), ownerID} {
		status, err := a.s.AccountAccess(ctx, id)
		if err != nil {
			return err
		}
		if err := status.Err(); err != nil {
			return err
		}
	}
	return nil
}

// readOnly is editErr as a capability: true when an account makes the content
// read-only for the requester.
func (a *api) readOnly(ctx context.Context, ownerID string) (bool, error) {
	err := a.editErr(ctx, ownerID)
	var locked *store.AccountLockedError
	if errors.As(err, &locked) {
		return true, nil
	}
	return false, err
}

// ownerFull reports the storage owner at or over its limit (full, grace
// included): the content it pays for is view-only.
func (a *api) ownerFull(ctx context.Context, ownerID string) (bool, error) {
	err := a.s.StorageFullErr(ctx, ownerID)
	if errors.Is(err, store.ErrStorageQuotaExceeded) {
		return true, nil
	}
	return false, err
}

// canEditMaterial narrows a role's editing by frozen (or locked) accounts: the
// requester's own and the material's storage owner's. Content editing is also
// off while that owner is at its storage limit.
func (a *api) canEditMaterial(
	ctx context.Context,
	materialID string,
	role store.WorkspaceRole,
) (canEdit, canEditContent bool, err error) {
	if !store.RoleCanEdit(role) {
		return false, false, nil
	}
	owner, err := a.s.MaterialOwnerAccess(ctx, materialID)
	if err != nil {
		return false, false, err
	}
	readOnly, err := a.readOnly(ctx, owner.UserID)
	if err != nil || readOnly {
		return false, false, err
	}
	full, err := a.ownerFull(ctx, owner.UserID)
	return true, !full, err
}
