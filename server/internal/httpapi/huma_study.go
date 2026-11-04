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
type reviewResultOutput struct {
	Body store.ReviewResult
}
type learningOverviewOutput struct {
	Body store.LearningOverview
}
type studyTopicsOutput struct {
	Body store.StudyTopics
}
type practiceOutput struct {
	Body store.Practice
}
type workspaceDashboardOutput struct {
	Body store.WorkspaceDashboard
}
type workspaceReviewInput struct {
	ID      string `path:"id"`
	Group   string `query:"group" enum:"topic,others,workspace" default:"workspace"`
	TopicID string `query:"topicId" doc:"The topic of a topic group"`
	Mode    string `query:"mode" enum:"tricky,fading,learned" doc:"A suggestion's mode; omitted for a review from the workspace list"`
	Items   string `query:"items" enum:"quiz" doc:"quiz serves questions only, whatever the review items preference (Practice's topic sessions)"`
	Count   int    `query:"count" minimum:"0" maximum:"1000" doc:"The session's size, picked in its start dialog"`
	Order   string `query:"order" enum:"recommended,unattempted,incorrect" doc:"Which items come first; recommended by default"`
}
type reviewSessionIDInput struct {
	ID string `path:"id" format:"uuid"`
}
type pastReviewsInput struct {
	Sort        string `query:"sort" enum:"date,quiz,cards,time,workspace,topic,status" default:"date"`
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
type studyEnabledInput struct {
	ID   string `path:"id"`
	Body apimodel.SetStudyEnabledReq
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
type studyPreferencesInput struct {
	Body store.StudyPreferences
}

func (a *api) registerStudy(api huma.API) {
	const tag = "Study"
	reg(api, http.MethodGet, "/api/workspaces/{id}/study", "getWorkspaceStudy", tag, "Study progress in a workspace", http.StatusOK, a.getWorkspaceStudy)
	reg(api, http.MethodGet, "/api/workspaces/{id}/study/attempts", "getWorkspaceAttempts", tag, "Each quiz's and set's attempt count and latest attempts", http.StatusOK, a.getWorkspaceAttempts)
	reg(api, http.MethodPut, "/api/workspaces/{id}/study/enabled", "setWorkspaceStudy", tag, "Show or hide study progress in a workspace", http.StatusNoContent, a.setWorkspaceStudy)
	reg(api, http.MethodPost, "/api/workspaces/{id}/study/reset", "resetWorkspaceStudy", tag, "Clear study progress in a workspace", http.StatusNoContent, a.resetWorkspaceStudy)
	reg(api, http.MethodGet, "/api/workspaces/{id}/dashboard", "getWorkspaceDashboard", tag, "The workspace's Dashboard: its owner, member count and latest activity", http.StatusOK, a.getWorkspaceDashboard)
	reg(api, http.MethodGet, "/api/workspaces/{id}/practice", "getWorkspacePractice", tag, "The workspace's Practice page: suggestions, quizzes and the caller's topic reviews", http.StatusOK, a.getWorkspacePractice)
	reg(api, http.MethodGet, "/api/workspaces/{id}/review", "getWorkspaceReview", tag, "A new review session: a suggestion's items, or the whole workspace's", http.StatusOK, a.getWorkspaceReview)
	reg(api, http.MethodGet, "/api/review/sessions/{id}", "resumeReviewSession", tag, "An unfinished review session's items still to answer", http.StatusOK, a.resumeReviewSession)
	reg(api, http.MethodGet, "/api/review/sessions/{id}/result", "getReviewResult", tag, "A review session's result: its scores and every answered item", http.StatusOK, a.getReviewResult)
	reg(api, http.MethodPost, "/api/review/sessions/{id}/finish", "finishReviewSession", tag, "End a review session before its last item", http.StatusNoContent, a.finishReviewSession)
	reg(api, http.MethodGet, "/api/review/sessions", "listPastReviews", tag, "Finished review sessions with their quiz and flashcard results", http.StatusOK, a.listPastReviews)
	reg(api, http.MethodPost, "/api/review/ratings", "rateReviewItem", tag, "Record a flashcard's review rating", http.StatusNoContent, a.rateReviewItem)
	regWithMaxBody(api, http.MethodPost, "/api/review/check", "checkReviewItem", tag, "Grade and rate one question of a review session", http.StatusOK, answersMaxBytes, a.checkReviewItem)
	reg(api, http.MethodGet, "/api/workspaces/{id}/study/question-count", "getStudyQuestionCount", tag, "How many questions a practice group holds, for its start dialog", http.StatusOK, a.getStudyQuestionCount)
	reg(api, http.MethodGet, "/api/learning/overview", "getLearningOverview", tag, "Learning's Overview: what to do next across workspaces and how each stands", http.StatusOK, a.getLearningOverview)
	reg(api, http.MethodGet, "/api/workspaces/{id}/study/topics", "getWorkspaceStudyTopics", tag, "Study → Summary: the caller's own standing per topic", http.StatusOK, a.getWorkspaceStudyTopics)
	reg(api, http.MethodPatch, "/api/me/study-preferences", "setStudyPreferences", tag, "Save study preferences", http.StatusNoContent, a.setStudyPreferences)
}

func (a *api) getWorkspaceStudy(ctx context.Context, in *workspaceIDInput) (*studyOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.StudySummary(ctx, userID(ctx), in.ID, time.Now())
	if err != nil {
		return nil, storedContentError(ctx, "", err)
	}
	// Quick review questions are checked on the server, like a session's.
	for i, it := range res.QuickReview {
		if it.Question != nil {
			res.QuickReview[i].Question = questions.LearnerView(it.Question)
		}
	}
	return &studyOutput{Body: res}, nil
}

type workspaceAttemptsOutput struct {
	Body struct {
		Items []store.ItemAttempts `json:"items" nullable:"false"`
	}
}

func (a *api) getWorkspaceAttempts(ctx context.Context, in *workspaceIDInput) (*workspaceAttemptsOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	items, err := a.s.WorkspaceAttempts(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, storedContentError(ctx, "", err)
	}
	out := &workspaceAttemptsOutput{}
	out.Body.Items = items
	return out, nil
}

func (a *api) setWorkspaceStudy(ctx context.Context, in *studyEnabledInput) (*Empty, error) {
	if err := a.requireStudyWrite(ctx, in.ID); err != nil {
		return nil, err
	}
	return &Empty{}, hErr(a.s.SetWorkspaceStudy(ctx, userID(ctx), in.ID, in.Body.Enabled))
}

func (a *api) resetWorkspaceStudy(ctx context.Context, in *workspaceIDInput) (*Empty, error) {
	if err := a.requireStudyWrite(ctx, in.ID); err != nil {
		return nil, err
	}
	return &Empty{}, hErr(a.s.ResetStudy(ctx, userID(ctx), in.ID))
}

// getWorkspaceDashboard is any reader's Dashboard header and Activity: files
// and materials every reader of the workspace can already list, with who
// added them.
func (a *api) getWorkspaceDashboard(ctx context.Context, in *workspaceIDInput) (*workspaceDashboardOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.WorkspaceDashboard(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &workspaceDashboardOutput{Body: res}, nil
}

// getWorkspacePractice is any reader's Practice page; a class's owner and
// editor members get how members use each quiz (counts and averages only)
// in place of their own practice.
func (a *api) getWorkspacePractice(ctx context.Context, in *workspaceIDInput) (*practiceOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	role, err := a.s.WorkspaceRole(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.WorkspacePractice(ctx, userID(ctx), in.ID, store.RoleCanEdit(role), time.Now())
	if err != nil {
		return nil, storedContentError(ctx, "", err)
	}
	return &practiceOutput{Body: res}, nil
}

func (a *api) getWorkspaceReview(ctx context.Context, in *workspaceReviewInput) (*reviewOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	info := store.ReviewSessionInfo{Group: in.Group}
	if in.TopicID != "" {
		info.TopicID = &in.TopicID
	}
	if in.Mode != "" {
		info.Mode = &in.Mode
	}
	res, err := a.s.WorkspaceReview(ctx, userID(ctx), in.ID, info, in.Items == "quiz", store.ReviewOptions{Count: in.Count, Order: in.Order}, time.Now())
	if errors.Is(err, store.ErrReviewGroup) {
		return nil, huma.Error404NotFound(err.Error())
	}
	if err != nil {
		return nil, storedContentError(ctx, "", err)
	}
	return a.reviewOutput(ctx, res)
}

// reviewOutput is a session to study: answer keys hidden (learnerSession) and
// the images of the items still to answer that no longer exist named: deleted
// by their uploader, or with the uploader's account (M16). Answered items are
// graded copies, whose missing images keep the plain empty box (Q270).
func (a *api) reviewOutput(ctx context.Context, res store.ReviewSession) (*reviewOutput, error) {
	var ids []string
	for _, it := range res.Items {
		if it.Image != nil {
			ids = append(ids, it.Image.AssetID)
		}
		if it.Question != nil {
			ids = append(ids, questions.AssetIDs(it.Question)...)
		}
	}
	var err error
	if res.RemovedAssetIDs, err = a.s.MissingEditorAssetIDs(ctx, ids); err != nil {
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
		return nil, storedContentError(ctx, "", err)
	}
	return a.reviewOutput(ctx, res)
}

func (a *api) getReviewResult(ctx context.Context, in *reviewSessionIDInput) (*reviewResultOutput, error) {
	wsID, err := a.s.ReviewSessionWorkspace(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if _, err := a.workspaceRead(ctx, wsID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.ReviewSessionResult(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &reviewResultOutput{Body: res}, nil
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

type studyQuestionCountInput struct {
	ID      string `path:"id"`
	Group   string `query:"group" enum:"topic,others,workspace" default:"workspace"`
	TopicID string `query:"topicId" doc:"The topic of a topic group"`
}
type studyQuestionCountOutput struct {
	Body struct {
		Total int `json:"total"`
	}
}

func (a *api) getStudyQuestionCount(ctx context.Context, in *studyQuestionCountInput) (*studyQuestionCountOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	var topicID *string
	if in.TopicID != "" {
		topicID = &in.TopicID
	}
	n, err := a.s.StudyQuestionCount(ctx, userID(ctx), in.ID, in.Group, topicID, time.Now())
	if err != nil {
		return nil, storedContentError(ctx, "", err)
	}
	out := &studyQuestionCountOutput{}
	out.Body.Total = n
	return out, nil
}

func (a *api) getLearningOverview(ctx context.Context, _ *struct{}) (*learningOverviewOutput, error) {
	res, err := a.s.LearningOverview(ctx, userID(ctx), time.Now())
	if err != nil {
		return nil, storedContentError(ctx, "", err)
	}
	return &learningOverviewOutput{Body: res}, nil
}

// getWorkspaceStudyTopics is for whoever practises here: a class's owner and
// editors manage it and have no results of their own (Epo 2026-11-04, board U3).
func (a *api) getWorkspaceStudyTopics(ctx context.Context, in *workspaceIDInput) (*studyTopicsOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	role, err := a.s.WorkspaceRole(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.WorkspaceStudyTopics(ctx, userID(ctx), in.ID, store.RoleCanEdit(role), time.Now())
	if err != nil {
		return nil, hErr(err)
	}
	return &studyTopicsOutput{Body: res}, nil
}

// sessionAnswer is the store's view of an answer's session, nil without one.
func sessionAnswer(ref *apimodel.ReviewSessionRef) *store.SessionAnswer {
	if ref == nil {
		return nil
	}
	return &store.SessionAnswer{ID: ref.ID, WorkspaceID: ref.WorkspaceID, Info: ref.ReviewSessionInfo, Items: ref.Items}
}

func (a *api) rateReviewItem(ctx context.Context, in *reviewRatingInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	if _, err := a.materialRead(ctx, in.Body.MaterialID); err != nil {
		return nil, hErr(err)
	}
	var attempt *store.FlashcardAttemptRef
	if ref := in.Body.Attempt; ref != nil {
		attempt = &store.FlashcardAttemptRef{ID: ref.ID, StartedAt: ref.StartedAt}
	}
	err := a.s.RateItem(ctx, userID(ctx), store.Rating{
		MaterialID: in.Body.MaterialID, ItemID: in.Body.ItemID, Rating: &in.Body.Rating,
		Session: sessionAnswer(in.Body.Session), Attempt: attempt,
	}, time.Now())
	if errors.Is(err, store.ErrStudyRating) || errors.Is(err, store.ErrStudyEmbedded) || errors.Is(err, store.ErrReviewSession) || errors.Is(err, store.ErrFlashcardAttempt) {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	if err != nil {
		return nil, storedContentError(ctx, in.Body.MaterialID, err)
	}
	return &Empty{}, nil
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
	session := sessionAnswer(in.Body.Session)
	q, workspaceID, err := a.s.ReviewQuestion(ctx, in.Body.MaterialID, in.Body.ItemID)
	if errors.Is(err, store.ErrStudyRating) {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	if err != nil {
		return nil, storedContentError(ctx, in.Body.MaterialID, err)
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
	if session != nil {
		answers, err := json.Marshal(in.Body.Answers)
		if err != nil {
			return nil, err
		}
		session.Answers, session.Graded, session.Correct, session.Total = answers, graded[0], correct, total
	}
	if err := a.s.RateItem(ctx, userID(ctx), store.Rating{
		MaterialID: in.Body.MaterialID, ItemID: in.Body.ItemID, Score: &score, Session: session,
		Graded: graded[0], Answers: in.Body.Answers,
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
