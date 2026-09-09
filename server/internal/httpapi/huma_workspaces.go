package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

type listWorkspacesInput struct {
	Q     string `query:"q"`
	Sort  string `query:"sort"`
	Color string `query:"color" doc:"Comma-separated colors; OR-matched with tags"`
	Tag   string `query:"tag" doc:"Comma-separated tags; OR-matched with colors"`
}
type workspacesOutput struct {
	Body []apimodel.Workspace `nullable:"false"`
}
type workspaceOutput struct {
	Body apimodel.Workspace
}
type workspaceIDInput struct {
	ID string `path:"id"`
}
type createWorkspaceInput struct {
	Body apimodel.CreateWorkspaceReq
}
type updateWorkspaceInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateWorkspaceReq
}
type updateWorkspaceSharingInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateWorkspaceSharingReq
}
type workspaceStatsOutput struct {
	Body apimodel.WorkspaceStats
}

func (a *api) registerWorkspaces(api huma.API) {
	const tag = "Workspaces"
	reg(api, http.MethodGet, "/api/workspaces", "listWorkspaces", tag, "List workspaces", http.StatusOK, a.listWorkspaces)
	reg(api, http.MethodPost, "/api/workspaces", "createWorkspace", tag, "Create a workspace", http.StatusCreated, a.createWorkspace)
	reg(api, http.MethodGet, "/api/workspaces/{id}", "getWorkspace", tag, "Get a workspace", http.StatusOK, a.getWorkspace)
	reg(api, http.MethodPatch, "/api/workspaces/{id}", "updateWorkspace", tag, "Update a workspace", http.StatusOK, a.updateWorkspace)
	reg(api, http.MethodPatch, "/api/workspaces/{id}/sharing", "updateWorkspaceSharing", tag, "Update workspace sharing", http.StatusOK, a.updateWorkspaceSharing)
	reg(api, http.MethodDelete, "/api/workspaces/{id}", "deleteWorkspace", tag, "Delete a workspace", http.StatusNoContent, a.deleteWorkspace)
	reg(api, http.MethodGet, "/api/workspaces/{id}/stats", "getWorkspaceStats", tag, "Workspace stats", http.StatusOK, a.getWorkspaceStats)
}

// workspaceOutputFor renders w with the requester's membership and effective
// role, so an editor member or share-role editor gets the controls they hold,
// and resolves the owner's storage state so the client can warn before the
// next write is refused.
func (a *api) workspaceOutputFor(
	ctx context.Context,
	w store.Workspace,
) (*workspaceOutput, error) {
	member, effective, err := a.s.WorkspaceRoles(ctx, userID(ctx), w.ID)
	if err != nil {
		return nil, hErr(err)
	}
	ownerState, err := a.workspaceOwnerState(ctx, w)
	if err != nil {
		return nil, err
	}
	return &workspaceOutput{Body: apimodel.FromWorkspaceAccess(w, member, effective, ownerState)}, nil
}

func (a *api) listWorkspaces(ctx context.Context, in *listWorkspacesInput) (*workspacesOutput, error) {
	res, err := a.s.ListWorkspaces(ctx, userID(ctx), in.Q, in.Sort, in.Color, in.Tag)
	if err != nil {
		return nil, hErr(err)
	}
	ownerStates, err := a.workspaceOwnerStates(ctx, res...)
	if err != nil {
		return nil, err
	}
	out := make([]apimodel.Workspace, len(res))
	for i, workspace := range res {
		effective := store.EffectiveRole(workspace.MemberRole, workspace.Privacy, workspace.ShareRole)
		out[i] = apimodel.FromWorkspaceAccess(workspace, workspace.MemberRole, effective, ownerStates[workspace.OwnerUserID])
	}
	return &workspacesOutput{Body: out}, nil
}

func (a *api) getWorkspace(ctx context.Context, in *workspaceIDInput) (*workspaceOutput, error) {
	// Owners get a normal (touching) read; everyone else with access reads the
	// shared projection.
	isOwner, err := a.workspaceRead(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	var res store.Workspace
	if isOwner {
		res, err = a.s.GetWorkspace(ctx, userID(ctx), in.ID, true)
	} else {
		res, err = a.s.GetWorkspaceShared(ctx, in.ID)
	}
	if err != nil {
		return nil, hErr(err)
	}
	return a.workspaceOutputFor(ctx, res)
}

func (a *api) createWorkspace(ctx context.Context, in *createWorkspaceInput) (*workspaceOutput, error) {
	res, err := a.s.CreateWorkspace(
		ctx,
		userID(ctx),
		string(in.Body.Name),
		in.Body.Color,
		apimodel.ToTagRefs(in.Body.Tags),
	)
	if err != nil {
		return nil, hErr(err)
	}
	return a.workspaceOutputFor(ctx, res)
}

// updateWorkspace changes descriptive metadata, none of which moves stored content bytes, so
// an over-quota account keeps them. Owner and editor members only.
func (a *api) updateWorkspace(ctx context.Context, in *updateWorkspaceInput) (*workspaceOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	p := store.WorkspacePatch{
		Name: apimodel.Str(in.Body.Name), Color: in.Body.Color, Description: apimodel.Str(in.Body.Description),
		AutoReparse: in.Body.AutoReparse, AutoReindex: in.Body.AutoReindex,
	}
	if in.Body.Tags != nil {
		t := apimodel.ToTagRefs(*in.Body.Tags)
		p.Tags = &t
	}
	res, err := a.s.UpdateWorkspace(ctx, userID(ctx), in.ID, p)
	if err != nil {
		return nil, hErr(err)
	}
	return a.workspaceOutputFor(ctx, res)
}

// updateWorkspaceSharing widens exposure of the owner's bytes, so the store
// gates it on the owner's lifecycle; the actor only needs a mutating session.
func (a *api) updateWorkspaceSharing(ctx context.Context, in *updateWorkspaceSharingInput) (*workspaceOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	res, err := a.s.UpdateWorkspaceSharing(
		ctx,
		userID(ctx),
		in.ID,
		in.Body.Privacy,
		in.Body.ShareRole,
	)
	if err != nil {
		return nil, hErr(err)
	}
	return a.workspaceOutputFor(ctx, res)
}

func (a *api) deleteWorkspace(ctx context.Context, in *workspaceIDInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	removed, err := a.s.DeleteWorkspaceWithResult(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	a.publishNotificationRemovals(ctx, removed)
	return &Empty{}, nil
}

func (a *api) getWorkspaceStats(ctx context.Context, in *workspaceIDInput) (*workspaceStatsOutput, error) {
	res, err := a.s.WorkspaceStats(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &workspaceStatsOutput{Body: res}, nil
}
