package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/store"
)

type listWorkspacesInput struct {
	Q     string `query:"q"`
	Sort  string `query:"sort"`
	Color string `query:"color" doc:"Comma-separated colors; OR-matched with tags"`
	Tag   string `query:"tag" doc:"Comma-separated tags; OR-matched with colors"`
}
type workspacesOutput struct {
	Body []apimodel.Workspace
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

// ownedWorkspaceOutput renders a workspace the caller owns, resolving the
// owner's storage state so the client can warn before the next write is
// refused.
func (a *api) ownedWorkspaceOutput(
	ctx context.Context,
	w store.Workspace,
) (*workspaceOutput, error) {
	ownerState, err := a.workspaceOwnerState(ctx, w)
	if err != nil {
		return nil, err
	}
	return &workspaceOutput{Body: apimodel.FromWorkspace(w, ownerState)}, nil
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
		role, err := a.s.WorkspaceRole(ctx, userID(ctx), workspace.ID)
		if err != nil {
			return nil, hErr(err)
		}
		out[i] = apimodel.FromWorkspaceAccess(workspace, role, ownerStates[workspace.OwnerUserID])
	}
	return &workspacesOutput{Body: out}, nil
}

func (a *api) getWorkspace(ctx context.Context, in *workspaceIDInput) (*workspaceOutput, error) {
	// Owners get a normal (touching) read; non-owners may view link/public
	// workspaces read-only.
	isOwner, err := a.workspaceRead(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	role, err := a.s.WorkspaceRole(ctx, userID(ctx), in.ID)
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
	ownerState, err := a.workspaceOwnerState(ctx, res)
	if err != nil {
		return nil, err
	}
	return &workspaceOutput{Body: apimodel.FromWorkspaceAccess(res, role, ownerState)}, nil
}

func (a *api) createWorkspace(ctx context.Context, in *createWorkspaceInput) (*workspaceOutput, error) {
	color := in.Body.Color
	if color == "" {
		color = "graphite"
	}
	res, err := a.s.CreateWorkspace(
		ctx,
		userID(ctx),
		in.Body.Name,
		color,
		apimodel.ToTagRefs(in.Body.Tags),
	)
	if err != nil {
		return nil, hErr(err)
	}
	return a.ownedWorkspaceOutput(ctx, res)
}

// updateWorkspace changes name, colour and tags, none of which move bytes, so
// an over-quota account keeps them.
func (a *api) updateWorkspace(ctx context.Context, in *updateWorkspaceInput) (*workspaceOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	p := store.WorkspacePatch{
		Name: in.Body.Name, Color: in.Body.Color,
	}
	if in.Body.Tags != nil {
		t := apimodel.ToTagRefs(*in.Body.Tags)
		p.Tags = &t
	}
	res, err := a.s.UpdateWorkspace(ctx, userID(ctx), in.ID, p)
	if err != nil {
		return nil, hErr(err)
	}
	return a.ownedWorkspaceOutput(ctx, res)
}

// updateWorkspaceSharing stays on the strict gate. Publishing a workspace puts
// it on Explore where every clone is charged to the cloner, so it is an
// exposure change rather than a size-neutral edit.
func (a *api) updateWorkspaceSharing(ctx context.Context, in *updateWorkspaceSharingInput) (*workspaceOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
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
	// Sharing decides part of everyone's effective material role, members
	// included, and room tokens carry the role they were minted with. Without
	// this, unsharing a workspace leaves live write connections open until the
	// tokens expire.
	a.publishWorkspaceEvictions(ctx, in.ID)
	return a.ownedWorkspaceOutput(ctx, res)
}

func (a *api) deleteWorkspace(ctx context.Context, in *workspaceIDInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	materialIDs, _ := a.s.WorkspaceMaterialIDs(ctx, in.ID)
	removed, err := a.s.DeleteWorkspaceWithResult(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	for _, materialID := range materialIDs {
		a.publishMaterialEviction(ctx, materialID)
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
