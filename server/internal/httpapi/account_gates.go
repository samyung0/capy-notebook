package httpapi

import (
	"context"

	"github.com/evonotes/server/internal/store"
)

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
// perform unrestricted mutations (rename, schedule edits, sharing changes).
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

// accountCreateAllowed is the raw-chi counterpart of requireAccountCreate.
func (a *api) accountCreateAllowed(ctx context.Context, uid string) error {
	status, err := a.s.AccountAccess(ctx, uid)
	if err != nil {
		return err
	}
	return status.CreateErr()
}

// Ensure the helpers stay typed against the store error they re-wrap.
var _ = store.AccountActive
