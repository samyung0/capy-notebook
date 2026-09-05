package httpapi

import (
	"context"
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

// requireAccountCreate rejects the request when the authenticated user may not
// create workspaces, files, materials, uploads or clones.
func (a *api) requireAccountCreate(ctx context.Context) error {
	status, err := a.s.AccountAccess(ctx, userID(ctx))
	if err != nil {
		return hErr(err)
	}
	if err := status.CreateErr(); err != nil {
		return hErr(err)
	}
	return nil
}

// requireAccountEdit rejects the request when the authenticated user may not
// perform unrestricted mutations.
//
// Reserve this for actions that can grow storage or widen exposure. Size-
// neutral metadata (rename, re-file, reorder) must use requireAccountMutate
// instead: the over-quota states are a creation gate, and blocking a rename
// would leave an over-quota owner unable to tidy up the content they are being
// asked to shrink.
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

// requireAccountMutate rejects the request when the authenticated user may not
// delete content or apply shrink-only material recovery edits.
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

// workspaceOwnerStates resolves the lifecycle state of each workspace's storage
// owner, keyed by owner user id. Owners repeat heavily in a list (most rows in
// "my workspaces" share one), so each distinct account is evaluated once.
//
// This deliberately reports the owner's state and not the requester's: the
// owner is the account charged for the workspace's bytes, so the owner is who
// has to free space before anybody — member or owner — can add to it.
func (a *api) workspaceOwnerStates(
	ctx context.Context,
	ws ...store.Workspace,
) (map[string]store.AccountState, error) {
	out := make(map[string]store.AccountState, 1)
	for _, w := range ws {
		if w.OwnerUserID == "" {
			continue
		}
		if _, done := out[w.OwnerUserID]; done {
			continue
		}
		status, err := a.s.AccountAccess(ctx, w.OwnerUserID)
		if err != nil {
			return nil, hErr(err)
		}
		out[w.OwnerUserID] = status.State
	}
	return out, nil
}

// workspaceOwnerState is the single-workspace form of workspaceOwnerStates.
func (a *api) workspaceOwnerState(
	ctx context.Context,
	w store.Workspace,
) (store.AccountState, error) {
	states, err := a.workspaceOwnerStates(ctx, w)
	if err != nil {
		return "", err
	}
	return states[w.OwnerUserID], nil
}
