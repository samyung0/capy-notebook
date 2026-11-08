package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Study → Members (openwiki/study-progress.md#members): how a class's members
// are doing, for its owner and teaching assistants only; the store refuses
// everyone else.

type membersProgressOutput struct {
	Body store.MembersProgress
}
type memberProfileOutput struct {
	Body store.MemberProfile
}

func (a *api) registerMembersProgress(api huma.API) {
	const tag = "Study"
	reg(api, http.MethodGet, "/api/workspaces/{id}/study/members", "getWorkspaceMembersProgress", tag, "Study → Members: each member's assignments, practice and topic labels, for a class's owner and teaching assistants", http.StatusOK, a.getWorkspaceMembersProgress)
	reg(api, http.MethodGet, "/api/workspaces/{id}/study/members/{memberId}", "getWorkspaceMemberProfile", tag, "A member's profile: assignments, topics, questions still missed and recent work, for a class's owner and teaching assistants", http.StatusOK, a.getWorkspaceMemberProfile)
}

func (a *api) getWorkspaceMembersProgress(ctx context.Context, in *workspaceIDInput) (*membersProgressOutput, error) {
	res, err := a.s.WorkspaceMembersProgress(ctx, userID(ctx), in.ID, time.Now())
	if err != nil {
		return nil, hErr(err)
	}
	return &membersProgressOutput{Body: res}, nil
}

func (a *api) getWorkspaceMemberProfile(ctx context.Context, in *workspaceMemberInput) (*memberProfileOutput, error) {
	res, err := a.s.WorkspaceMemberProfile(ctx, userID(ctx), in.ID, in.MemberID, time.Now())
	if err != nil {
		return nil, hErr(err)
	}
	return &memberProfileOutput{Body: res}, nil
}
