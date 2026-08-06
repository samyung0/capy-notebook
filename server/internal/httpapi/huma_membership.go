package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/materialdoc"
	"github.com/evonotes/server/internal/store"
)

type workspaceMembersOutput struct{ Body []apimodel.WorkspaceMember }
type workspaceMemberOutput struct{ Body apimodel.WorkspaceMember }

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
	reg(api, http.MethodPatch, "/api/workspaces/{id}/members/{memberId}", "updateWorkspaceMember", tag, "Change a workspace member role", http.StatusNoContent, a.updateWorkspaceMember)
	reg(api, http.MethodDelete, "/api/workspaces/{id}/members/{memberId}", "removeWorkspaceMember", tag, "Remove a workspace member", http.StatusNoContent, a.removeWorkspaceMember)
	reg(api, http.MethodPost, "/api/workspaces/{id}/transfer", "transferWorkspace", tag, "Transfer workspace ownership to another member", http.StatusOK, a.transferWorkspace)
	reg(api, http.MethodPost, "/api/workspaces/{id}/invites", "createWorkspaceInvite", tag, "Privately invite a workspace member", http.StatusAccepted, a.createWorkspaceInvite)
	reg(api, http.MethodPost, "/api/workspace-invites/{token}/accept", "acceptWorkspaceInvite", tag, "Accept a workspace invite", http.StatusOK, a.acceptWorkspaceInvite)
}

func collaborationError(err error) error {
	if errors.Is(err, store.ErrForbidden) {
		return huma.Error403Forbidden("insufficient workspace role")
	}
	if errors.Is(err, store.ErrConflict) {
		return huma.Error409Conflict("material revision is stale")
	}
	if errors.Is(err, materialdoc.ErrInvalid) {
		return huma.Error400BadRequest(err.Error())
	}
	return hErr(err)
}

func (a *api) listWorkspaceMembers(ctx context.Context, in *workspaceIDInput) (*workspaceMembersOutput, error) {
	role, err := a.s.WorkspaceRole(ctx, userID(ctx), in.ID)
	if err != nil || role == "" {
		if err == nil {
			err = store.ErrForbidden
		}
		return nil, collaborationError(err)
	}
	members, err := a.s.ListWorkspaceMembers(ctx, in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	return &workspaceMembersOutput{Body: members}, nil
}

func (a *api) createWorkspaceInvite(ctx context.Context, in *createWorkspaceInviteInput) (*Empty, error) {
	if err := a.s.AssertWorkspaceOwner(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	notification, created, err := a.s.CreateWorkspaceInviteWithResult(
		ctx, in.ID, in.Body.Identifier, in.Body.Role, userID(ctx),
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

func (a *api) acceptWorkspaceInvite(ctx context.Context, in *acceptWorkspaceInviteInput) (*workspaceMemberOutput, error) {
	member, notificationID, err := a.s.AcceptWorkspaceInviteWithResult(ctx, in.Token, userID(ctx))
	if err != nil {
		return nil, collaborationError(err)
	}
	if notificationID != "" {
		a.publishNotificationEvent(ctx, userID(ctx), notificationEvent{
			Type: "removed",
			IDs:  []string{notificationID},
		})
	}
	return &workspaceMemberOutput{Body: member}, nil
}

func (a *api) updateWorkspaceMember(ctx context.Context, in *updateWorkspaceMemberInput) (*Empty, error) {
	if err := a.s.AssertWorkspaceOwner(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	notification, created, err := a.s.SetWorkspaceMemberRoleWithResult(ctx, in.ID, in.MemberID, in.Body.Role)
	if err != nil {
		return nil, collaborationError(err)
	}
	if created && notification != nil {
		a.publishNotificationEvent(ctx, in.MemberID, notificationEvent{
			Type:         "created",
			Notification: notification,
		})
	}
	a.publishWorkspaceEvictions(ctx, in.ID)
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
		return nil, huma.Error409Conflict(err.Error())
	}
	if err != nil {
		return nil, collaborationError(err)
	}
	a.publishWorkspaceEvictions(ctx, in.ID)
	return a.ownedWorkspaceOutput(ctx, ws)
}

func (a *api) removeWorkspaceMember(ctx context.Context, in *workspaceMemberInput) (*Empty, error) {
	if err := a.s.AssertWorkspaceOwner(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	notification, created, err := a.s.RemoveWorkspaceMemberWithResult(ctx, in.ID, in.MemberID)
	if err != nil {
		return nil, collaborationError(err)
	}
	if created && notification != nil {
		a.publishNotificationEvent(ctx, in.MemberID, notificationEvent{
			Type:         "created",
			Notification: notification,
		})
	}
	a.publishWorkspaceEvictions(ctx, in.ID)
	return &Empty{}, nil
}
