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
	reg(api, http.MethodGet, "/api/workspaces/{id}/study/members/{memberId}/questions", "getWorkspaceMemberQuestions", tag, "A member's topic questions or Frequently wrong, each with their latest result, read only, for a class's owner and teaching assistants", http.StatusOK, a.getWorkspaceMemberQuestions)
	reg(api, http.MethodGet, "/api/workspaces/{id}/study/members/{memberId}/answers/{materialId}/{questionId}", "getWorkspaceMemberAnswer", tag, "A member's latest answer to a question their lists show answered, marked, with the question's key, for a class's owner and teaching assistants", http.StatusOK, a.getWorkspaceMemberAnswer)
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

type memberAnswerInput struct {
	ID         string `path:"id"`
	MemberID   string `path:"memberId"`
	MaterialID string `path:"materialId"`
	QuestionID string `path:"questionId"`
}
type memberAnswerOutput struct{ Body store.MemberAnswer }

func (a *api) getWorkspaceMemberAnswer(ctx context.Context, in *memberAnswerInput) (*memberAnswerOutput, error) {
	res, err := a.s.WorkspaceMemberAnswer(ctx, userID(ctx), in.ID, in.MemberID, in.MaterialID, in.QuestionID)
	if err != nil {
		return nil, storedContentError(ctx, in.MaterialID, err)
	}
	return &memberAnswerOutput{Body: res}, nil
}

func (a *api) getWorkspaceMemberQuestions(ctx context.Context, in *memberQuestionsInput) (*studyQuestionsOutput, error) {
	f, err := questionsFilter(in.List, in.TopicID)
	if err != nil {
		return nil, err
	}
	list, err := a.s.WorkspaceMemberQuestions(ctx, userID(ctx), in.ID, in.MemberID, f)
	if err != nil {
		return nil, storedContentError(ctx, "", err)
	}
	out := &studyQuestionsOutput{}
	out.Body.Questions = list
	return out, nil
}
