package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Study progress and review: every endpoint needs read access only, and a
// frozen account may record its own progress.

type studyOutput struct {
	Body store.StudySummary
}
type reviewOutput struct {
	Body store.ReviewSession
}
type reviewWorkspacesOutput struct {
	Body struct {
		Workspaces []store.ReviewWorkspace `json:"workspaces" nullable:"false"`
	}
}
type studyEnabledInput struct {
	ID   string `path:"id"`
	Body apimodel.SetStudyEnabledReq
}
type studyItemInput struct {
	ID   string `path:"id"`
	Body apimodel.SetStudyItemReq
}
type reviewRatingInput struct {
	Body apimodel.RateReviewItemReq
}
type studyDefaultInput struct {
	Body apimodel.SetStudyEnabledReq
}

type studyPreferencesInput struct {
	Body store.StudyPreferences
}

func (a *api) registerStudy(api huma.API) {
	const tag = "Study"
	reg(api, http.MethodGet, "/api/workspaces/{id}/study", "getWorkspaceStudy", tag, "Study progress in a workspace", http.StatusOK, a.getWorkspaceStudy)
	reg(api, http.MethodPut, "/api/workspaces/{id}/study/enabled", "setWorkspaceStudy", tag, "Turn study progress on or off in a workspace", http.StatusNoContent, a.setWorkspaceStudy)
	reg(api, http.MethodPut, "/api/workspaces/{id}/study/items", "setStudyItem", tag, "Mark a file or material read, unread or removed", http.StatusNoContent, a.setStudyItem)
	reg(api, http.MethodPost, "/api/workspaces/{id}/study/reset", "resetWorkspaceStudy", tag, "Clear study progress in a workspace", http.StatusNoContent, a.resetWorkspaceStudy)
	reg(api, http.MethodGet, "/api/workspaces/{id}/review", "getWorkspaceReview", tag, "Next mixed review session", http.StatusOK, a.getWorkspaceReview)
	reg(api, http.MethodPost, "/api/review/ratings", "rateReviewItem", tag, "Record a review rating", http.StatusNoContent, a.rateReviewItem)
	reg(api, http.MethodGet, "/api/review/workspaces", "listReviewWorkspaces", tag, "Workspaces with study progress, for Learning's Review tab", http.StatusOK, a.listReviewWorkspaces)
	reg(api, http.MethodPatch, "/api/me/study-progress", "setStudyProgressDefault", tag, "Default study progress setting", http.StatusNoContent, a.setStudyProgressDefault)
	reg(api, http.MethodPatch, "/api/me/study-preferences", "setStudyPreferences", tag, "Save study preferences", http.StatusNoContent, a.setStudyPreferences)
}

func (a *api) getWorkspaceStudy(ctx context.Context, in *workspaceIDInput) (*studyOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.StudySummary(ctx, userID(ctx), in.ID, time.Now())
	if err != nil {
		return nil, hErr(err)
	}
	return &studyOutput{Body: res}, nil
}

func (a *api) setWorkspaceStudy(ctx context.Context, in *studyEnabledInput) (*Empty, error) {
	if err := a.requireStudyWrite(ctx, in.ID); err != nil {
		return nil, err
	}
	return &Empty{}, hErr(a.s.SetWorkspaceStudy(ctx, userID(ctx), in.ID, in.Body.Enabled))
}

func (a *api) setStudyItem(ctx context.Context, in *studyItemInput) (*Empty, error) {
	if (in.Body.FileID == nil) == (in.Body.MaterialID == nil) {
		return nil, huma.Error422UnprocessableEntity("send exactly one of fileId and materialId")
	}
	if err := a.requireStudyWrite(ctx, in.ID); err != nil {
		return nil, err
	}
	err := a.s.SetStudyItem(ctx, userID(ctx), in.ID, in.Body.FileID, in.Body.MaterialID, in.Body.State)
	if errors.Is(err, store.ErrStudyTarget) {
		return nil, huma.Error404NotFound(err.Error())
	}
	return &Empty{}, hErr(err)
}

func (a *api) resetWorkspaceStudy(ctx context.Context, in *workspaceIDInput) (*Empty, error) {
	if err := a.requireStudyWrite(ctx, in.ID); err != nil {
		return nil, err
	}
	return &Empty{}, hErr(a.s.ResetStudy(ctx, userID(ctx), in.ID))
}

func (a *api) getWorkspaceReview(ctx context.Context, in *workspaceIDInput) (*reviewOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.WorkspaceReview(ctx, userID(ctx), in.ID, time.Now())
	if err != nil {
		return nil, hErr(err)
	}
	return &reviewOutput{Body: res}, nil
}

func (a *api) listReviewWorkspaces(ctx context.Context, _ *struct{}) (*reviewWorkspacesOutput, error) {
	list, err := a.s.ReviewWorkspaces(ctx, userID(ctx), time.Now())
	if err != nil {
		return nil, hErr(err)
	}
	out := &reviewWorkspacesOutput{}
	out.Body.Workspaces = list
	return out, nil
}

func (a *api) rateReviewItem(ctx context.Context, in *reviewRatingInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	if _, err := a.materialRead(ctx, in.Body.MaterialID); err != nil {
		return nil, hErr(err)
	}
	err := a.s.RateItem(ctx, userID(ctx), store.Rating{
		MaterialID: in.Body.MaterialID, ItemID: in.Body.ItemID, Rating: in.Body.Rating, Score: in.Body.Score,
	}, time.Now())
	if errors.Is(err, store.ErrStudyRating) {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	return &Empty{}, hErr(err)
}

// setStudyPreferences replaces the saved preferences; the chat agent reads
// them on every turn.
func (a *api) setStudyPreferences(ctx context.Context, in *studyPreferencesInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	return &Empty{}, hErr(a.s.SetStudyPreferences(ctx, userID(ctx), in.Body))
}

func (a *api) setStudyProgressDefault(ctx context.Context, in *studyDefaultInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	return &Empty{}, hErr(a.s.SetStudyProgressDefault(ctx, userID(ctx), in.Body.Enabled))
}

// requireStudyWrite allows any reader of the workspace whose account can sign in.
func (a *api) requireStudyWrite(ctx context.Context, wsID string) error {
	if err := a.requireAccountMutate(ctx); err != nil {
		return err
	}
	if _, err := a.workspaceRead(ctx, wsID); err != nil {
		return hErr(err)
	}
	return nil
}
