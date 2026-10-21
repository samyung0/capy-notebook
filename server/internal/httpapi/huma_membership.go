package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

type workspaceMembersOutput struct {
	Body []apimodel.WorkspaceMember `nullable:"false"`
}
type workspaceMemberOutput struct{ Body apimodel.WorkspaceMember }
type workspaceCollaboratorsOutput struct {
	Body []apimodel.WorkspaceCollaborator `nullable:"false"`
}

type pendingWorkspaceInvitesOutput struct {
	Body []apimodel.PendingWorkspaceInvite `nullable:"false"`
}
type workspaceInviteInput struct {
	ID       string `path:"id"`
	InviteID string `path:"inviteId"`
}
type createWorkspaceInviteInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateWorkspaceInviteReq
}
type acceptWorkspaceInviteInput struct {
	Token string `path:"token"`
}
type workspaceMemberInput struct {
	ID       string `path:"id"`
	MemberID string `path:"memberId"`
}
type updateWorkspaceMemberInput struct {
	ID       string `path:"id"`
	MemberID string `path:"memberId"`
	Body     apimodel.UpdateWorkspaceMemberReq
}
type transferWorkspaceInput struct {
	ID   string `path:"id"`
	Body apimodel.TransferWorkspaceReq
}

func (a *api) registerMembership(api huma.API) {
	const tag = "Workspace collaboration"
	reg(api, http.MethodGet, "/api/workspaces/{id}/members", "listWorkspaceMembers", tag, "List workspace members", http.StatusOK, a.listWorkspaceMembers)
	reg(api, http.MethodGet, "/api/workspaces/{id}/collaborators", "listWorkspaceCollaborators", tag, "List mentionable workspace collaborators", http.StatusOK, a.listWorkspaceCollaborators)
	reg(api, http.MethodPatch, "/api/workspaces/{id}/members/{memberId}", "updateWorkspaceMember", tag, "Change a workspace member role", http.StatusNoContent, a.updateWorkspaceMember)
	reg(api, http.MethodDelete, "/api/workspaces/{id}/members/{memberId}", "removeWorkspaceMember", tag, "Remove a workspace member", http.StatusNoContent, a.removeWorkspaceMember)
	reg(api, http.MethodPost, "/api/workspaces/{id}/transfer", "transferWorkspace", tag, "Transfer workspace ownership to another member", http.StatusOK, a.transferWorkspace)
	reg(api, http.MethodPost, "/api/workspaces/{id}/invites", "createWorkspaceInvite", tag, "Privately invite a workspace member", http.StatusAccepted, a.createWorkspaceInvite)
	reg(api, http.MethodGet, "/api/workspaces/{id}/invites", "listWorkspaceInvites", tag, "List pending workspace invites", http.StatusOK, a.listWorkspaceInvites)
	reg(api, http.MethodDelete, "/api/workspaces/{id}/invites/{inviteId}", "cancelWorkspaceInvite", tag, "Cancel a pending workspace invite", http.StatusNoContent, a.cancelWorkspaceInvite)
	reg(api, http.MethodPost, "/api/workspace-invites/{token}/accept", "acceptWorkspaceInvite", tag, "Accept a workspace invite", http.StatusOK, a.acceptWorkspaceInvite)
}

func collaborationError(err error) error {
	if errors.Is(err, store.ErrForbidden) {
		return huma.Error403Forbidden("insufficient workspace role")
	}
	if errors.Is(err, materialdoc.ErrInvalid) {
		return huma.Error400BadRequest(err.Error())
	}
	return hErr(err)
}

// listWorkspaceMembers is non-disclosing: no read access at all answers 404,
// a reader who is not a member answers 403.
func (a *api) listWorkspaceMembers(ctx context.Context, in *workspaceIDInput) (*workspaceMembersOutput, error) {
	member, effective, err := a.s.WorkspaceRoles(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if effective == "" {
		return nil, hErr(store.ErrNotFound)
	}
	if member == "" {
		return nil, collaborationError(store.ErrForbidden)
	}
	members, err := a.s.ListWorkspaceMembers(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	return &workspaceMembersOutput{Body: members}, nil
}

// listWorkspaceCollaborators serves the mention menu. It is gated on the
// effective role rather than membership, because a share-role editor can
// write comments and needs names to mention. The full roster with roles stays
// member-facing.
func (a *api) listWorkspaceCollaborators(
	ctx context.Context,
	in *workspaceIDInput,
) (*workspaceCollaboratorsOutput, error) {
	role, err := a.s.WorkspaceEffectiveRole(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	if !store.RoleCanEdit(role) {
		return nil, collaborationError(store.ErrForbidden)
	}
	collaborators, err := a.s.ListWorkspaceCollaborators(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	return &workspaceCollaboratorsOutput{Body: collaborators}, nil
}

func (a *api) createWorkspaceInvite(ctx context.Context, in *createWorkspaceInviteInput) (*Empty, error) {
	if err := a.s.AssertWorkspaceOwner(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	notification, created, err := a.s.CreateWorkspaceInviteWithResult(
		ctx, in.ID, string(in.Body.Identifier), in.Body.Role.WorkspaceRole(), userID(ctx),
	)
	if err != nil {
		return nil, collaborationError(err)
	}
	if created && notification != nil {
		a.publishNotificationEvent(ctx, notification.UserID, notificationEvent{
			Type:         "created",
			Notification: notification,
		})
	}
	return &Empty{}, nil
}

// listWorkspaceInvites is the owner's pending list: every typed address, as
// typed, whether or not it reaches an account.
func (a *api) listWorkspaceInvites(ctx context.Context, in *workspaceIDInput) (*pendingWorkspaceInvitesOutput, error) {
	if err := a.s.AssertWorkspaceOwner(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	invites, err := a.s.ListWorkspaceInvites(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &pendingWorkspaceInvitesOutput{Body: invites}, nil
}

func (a *api) cancelWorkspaceInvite(ctx context.Context, in *workspaceInviteInput) (*Empty, error) {
	if err := a.s.AssertWorkspaceOwner(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	if err := a.s.CancelWorkspaceInvite(ctx, userID(ctx), in.ID, in.InviteID); err != nil {
		return nil, collaborationError(err)
	}
	return &Empty{}, nil
}

func (a *api) acceptWorkspaceInvite(ctx context.Context, in *acceptWorkspaceInviteInput) (*workspaceMemberOutput, error) {
	accepted, err := a.s.AcceptWorkspaceInviteWithResult(ctx, in.Token, userID(ctx))
	if err != nil {
		return nil, collaborationError(err)
	}
	if len(accepted.RemovedNotificationIDs) > 0 {
		a.publishNotificationEvent(ctx, userID(ctx), notificationEvent{
			Type: "removed",
			IDs:  accepted.RemovedNotificationIDs,
		})
	}
	if n := accepted.InviterNotification; n != nil {
		a.publishNotificationEvent(ctx, n.UserID, notificationEvent{
			Type:         "created",
			Notification: n,
		})
	}
	return &workspaceMemberOutput{Body: accepted.Member}, nil
}

func (a *api) updateWorkspaceMember(ctx context.Context, in *updateWorkspaceMemberInput) (*Empty, error) {
	if err := a.s.AssertWorkspaceOwner(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	notification, created, err := a.s.SetWorkspaceMemberRoleWithResult(
		ctx, userID(ctx), in.ID, in.MemberID, in.Body.Role.WorkspaceRole(),
	)
	if err != nil {
		return nil, collaborationError(err)
	}
	if created && notification != nil {
		a.publishNotificationEvent(ctx, in.MemberID, notificationEvent{
			Type:         "created",
			Notification: notification,
		})
	}
	return &Empty{}, nil
}

// transferWorkspace hands ownership, and the storage bill, to another member.
// Every collaborator's room token is invalidated afterwards: their effective role
// changed, and the token carries the old one.
//
// An over-quota sender may transfer. Handing a workspace away is one of the two
// ways such an account gets back under its limit, so the strict gate would
// close a recovery path. The recipient is still gated on their own quota inside
// TransferWorkspace.
func (a *api) transferWorkspace(ctx context.Context, in *transferWorkspaceInput) (*workspaceOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	ws, err := a.s.TransferWorkspace(ctx, userID(ctx), in.ID, in.Body.RecipientID)
	if errors.Is(err, store.ErrTransferSelf) {
		return nil, conflictError("transfer_self", err.Error())
	}
	if err != nil {
		return nil, collaborationError(err)
	}
	return a.workspaceOutputFor(ctx, ws)
}

func (a *api) removeWorkspaceMember(ctx context.Context, in *workspaceMemberInput) (*Empty, error) {
	if err := a.s.AssertWorkspaceOwner(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	notification, created, err := a.s.RemoveWorkspaceMemberWithResult(
		ctx, userID(ctx), in.ID, in.MemberID,
	)
	if err != nil {
		return nil, collaborationError(err)
	}
	if created && notification != nil {
		a.publishNotificationEvent(ctx, in.MemberID, notificationEvent{
			Type:         "created",
			Notification: notification,
		})
	}
	return &Empty{}, nil
}
