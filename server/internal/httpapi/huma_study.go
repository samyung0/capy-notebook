package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/questions"
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
type reviewOverviewOutput struct {
	Body store.ReviewOverview
}
type workspaceReviewInput struct {
	ID        string `path:"id"`
	Group     string `query:"group" enum:"chapter,others,workspace" default:"workspace"`
	ChapterID string `query:"chapterId" doc:"The chapter of a chapter group"`
	Mode      string `query:"mode" enum:"tricky,fading,learned" doc:"A suggestion's mode; omitted for a review from the workspace list"`
}
type reviewSessionIDInput struct {
	ID string `path:"id" format:"uuid"`
}
type pastReviewsInput struct {
	Sort        string `query:"sort" enum:"date,quiz,cards,time" default:"date"`
	Dir         string `query:"dir" enum:"asc,desc" default:"desc"`
	WorkspaceID string `query:"workspaceId" doc:"Comma-separated workspace ids"`
	Has         string `query:"has" doc:"Comma-separated: quiz, flashcards; a session with either passes"`
	Offset      int    `query:"offset" minimum:"0"`
	Limit       int    `query:"limit" minimum:"1" maximum:"100" default:"30"`
}
type pastReviewsOutput struct {
	Body struct {
		Items []store.PastReview `json:"items" nullable:"false"`
		More  bool               `json:"more"`
	}
}
type learningProgressOutput struct {
	Body store.LearningProgress
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
type reviewCheckInput struct {
	Body apimodel.CheckReviewItemReq
}
type gradedQuestionOutput struct {
	Body apimodel.GradedQuestion
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
	reg(api, http.MethodGet, "/api/workspaces/{id}/review", "getWorkspaceReview", tag, "A new review session: a suggestion's items, or the whole workspace's", http.StatusOK, a.getWorkspaceReview)
	reg(api, http.MethodGet, "/api/review/sessions/{id}", "resumeReviewSession", tag, "An unfinished review session's items still to answer", http.StatusOK, a.resumeReviewSession)
	reg(api, http.MethodPost, "/api/review/sessions/{id}/finish", "finishReviewSession", tag, "End a review session before its last item", http.StatusNoContent, a.finishReviewSession)
	reg(api, http.MethodGet, "/api/review/sessions", "listPastReviews", tag, "Finished review sessions with their quiz and flashcard results", http.StatusOK, a.listPastReviews)
	reg(api, http.MethodPost, "/api/review/ratings", "rateReviewItem", tag, "Record a flashcard's review rating", http.StatusNoContent, a.rateReviewItem)
	regWithMaxBody(api, http.MethodPost, "/api/review/check", "checkReviewItem", tag, "Grade and rate one question of a review session", http.StatusOK, answersMaxBytes, a.checkReviewItem)
	reg(api, http.MethodGet, "/api/review/overview", "getReviewOverview", tag, "Learning's Review tab: suggested reviews, sessions to continue, every workspace", http.StatusOK, a.getReviewOverview)
	reg(api, http.MethodGet, "/api/learning/progress", "getLearningProgress", tag, "Learning's Progress tab: workspaces in progress and finished, the leading one's items", http.StatusOK, a.getLearningProgress)
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

func (a *api) getWorkspaceReview(ctx context.Context, in *workspaceReviewInput) (*reviewOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	info := store.ReviewSessionInfo{Group: in.Group}
	if in.ChapterID != "" {
		info.ChapterID = &in.ChapterID
	}
	if in.Mode != "" {
		info.Mode = &in.Mode
	}
	res, err := a.s.WorkspaceReview(ctx, userID(ctx), in.ID, info, time.Now())
	if errors.Is(err, store.ErrReviewGroup) {
		return nil, huma.Error404NotFound(err.Error())
	}
	if err != nil {
		return nil, hErr(err)
	}
	return &reviewOutput{Body: learnerSession(res)}, nil
}

// learnerSession hides answer keys: a review session is studying, and its
// questions are graded by checkReviewItem.
func learnerSession(res store.ReviewSession) store.ReviewSession {
	for i, it := range res.Items {
		if it.Question != nil {
			res.Items[i].Question = questions.LearnerView(it.Question)
		}
	}
	return res
}

func (a *api) resumeReviewSession(ctx context.Context, in *reviewSessionIDInput) (*reviewOutput, error) {
	wsID, err := a.s.ReviewSessionWorkspace(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if _, err := a.workspaceRead(ctx, wsID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.ResumeReviewSession(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &reviewOutput{Body: learnerSession(res)}, nil
}

func (a *api) finishReviewSession(ctx context.Context, in *reviewSessionIDInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	return &Empty{}, hErr(a.s.FinishReviewSession(ctx, userID(ctx), in.ID, time.Now()))
}

func (a *api) listPastReviews(ctx context.Context, in *pastReviewsInput) (*pastReviewsOutput, error) {
	list, more, err := a.s.PastReviews(ctx, userID(ctx), store.PastReviewParams{
		Sort: in.Sort, Ascending: in.Dir == "asc",
		Workspaces: commaValues(in.WorkspaceID), Has: commaValues(in.Has),
		Offset: in.Offset, Limit: in.Limit,
	})
	if err != nil {
		return nil, hErr(err)
	}
	out := &pastReviewsOutput{}
	out.Body.Items, out.Body.More = list, more
	return out, nil
}

func commaValues(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func (a *api) getReviewOverview(ctx context.Context, _ *struct{}) (*reviewOverviewOutput, error) {
	res, err := a.s.ReviewOverview(ctx, userID(ctx), time.Now())
	if err != nil {
		return nil, hErr(err)
	}
	return &reviewOverviewOutput{Body: res}, nil
}

// sessionAnswer is the store's view of an answer's session, nil without one.
func sessionAnswer(ref *apimodel.ReviewSessionRef) *store.SessionAnswer {
	if ref == nil {
		return nil
	}
	return &store.SessionAnswer{ID: ref.ID, WorkspaceID: ref.WorkspaceID, Info: ref.ReviewSessionInfo, Items: ref.Items}
}

func (a *api) getLearningProgress(ctx context.Context, _ *struct{}) (*learningProgressOutput, error) {
	res, err := a.s.LearningProgress(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &learningProgressOutput{Body: res}, nil
}

func (a *api) rateReviewItem(ctx context.Context, in *reviewRatingInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	if _, err := a.materialRead(ctx, in.Body.MaterialID); err != nil {
		return nil, hErr(err)
	}
	err := a.s.RateItem(ctx, userID(ctx), store.Rating{
		MaterialID: in.Body.MaterialID, ItemID: in.Body.ItemID, Rating: &in.Body.Rating,
		Session: sessionAnswer(in.Body.Session),
	}, time.Now())
	if errors.Is(err, store.ErrStudyRating) || errors.Is(err, store.ErrStudyEmbedded) || errors.Is(err, store.ErrReviewSession) {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	return &Empty{}, hErr(err)
}

// checkReviewItem grades one question of a review session on the server,
// rates it from the score and returns it with its key.
func (a *api) checkReviewItem(ctx context.Context, in *reviewCheckInput) (*gradedQuestionOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	if _, err := a.materialRead(ctx, in.Body.MaterialID); err != nil {
		return nil, hErr(err)
	}
	q, workspaceID, err := a.s.ReviewQuestion(ctx, in.Body.MaterialID, in.Body.ItemID)
	if errors.Is(err, store.ErrStudyRating) {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	if err != nil {
		return nil, hErr(err)
	}
	plan, err := planGrading([]map[string]any{q}, in.Body.Answers)
	if err != nil {
		return nil, gradeRequestError(err)
	}
	graded, correct, total, err := a.gradeSignedIn(ctx, plan, workspaceID, map[string]any{"quizId": in.Body.MaterialID})
	if err != nil {
		return nil, err
	}
	score := correct / total
	session := sessionAnswer(in.Body.Session)
	if session != nil {
		answers, err := json.Marshal(in.Body.Answers)
		if err != nil {
			return nil, err
		}
		session.Answers, session.Graded, session.Correct, session.Total = answers, graded[0], correct, total
	}
	if err := a.s.RateItem(ctx, userID(ctx), store.Rating{
		MaterialID: in.Body.MaterialID, ItemID: in.Body.ItemID, Score: &score, Session: session,
	}, time.Now()); errors.Is(err, store.ErrStudyEmbedded) || errors.Is(err, store.ErrReviewSession) {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	} else if err != nil {
		return nil, hErr(err)
	}
	return &gradedQuestionOutput{Body: apimodel.GradedQuestion{Correct: correct, Total: total, Question: graded[0]}}, nil
}

// setStudyPreferences replaces the saved preferences; the chat agent reads
// them on every turn and AI generate for its defaults.
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
