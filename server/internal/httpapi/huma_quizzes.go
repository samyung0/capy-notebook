package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/store"
)

type quizzesOutput struct {
	Body []apimodel.Quiz `nullable:"false"`
}
type quizOutput struct {
	Body apimodel.Quiz
}
type quizIDInput struct {
	ID string `path:"id"`
}
type createQuizInput struct {
	Body apimodel.CreateQuizReq
}
type updateQuizInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateQuizReq
}
type createAttemptInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateAttemptReq
}
type attemptsOutput struct {
	Body []apimodel.Attempt `nullable:"false"`
}
type attemptOutput struct {
	Body apimodel.Attempt
}
type attemptIDInput struct {
	ID string `path:"id"`
}
type attemptDetailOutput struct {
	Body apimodel.AttemptDetail
}

func (a *api) registerQuizzes(api huma.API) {
	const tag = "Quizzes"
	reg(api, http.MethodGet, "/api/quizzes", "listQuizzes", tag, "List quizzes", http.StatusOK, a.listQuizzes)
	reg(api, http.MethodPost, "/api/quizzes", "createQuiz", tag, "Create a quiz", http.StatusCreated, a.createQuiz)
	reg(api, http.MethodGet, "/api/mistakes", "getMistakes", tag, "Review-mistakes quiz", http.StatusOK, a.getMistakes)
	reg(api, http.MethodGet, "/api/quizzes/{id}", "getQuiz", tag, "Get a quiz", http.StatusOK, a.getQuiz)
	reg(api, http.MethodPatch, "/api/quizzes/{id}", "updateQuiz", tag, "Update a quiz", http.StatusOK, a.updateQuiz)
	reg(api, http.MethodDelete, "/api/quizzes/{id}", "deleteQuiz", tag, "Delete a quiz", http.StatusNoContent, a.deleteQuiz)
	reg(api, http.MethodPost, "/api/quizzes/{id}/attempts", "createAttempt", tag, "Record a quiz attempt", http.StatusCreated, a.createAttempt)
	reg(api, http.MethodGet, "/api/attempts", "listAttempts", tag, "List attempts", http.StatusOK, a.listAttempts)
	reg(api, http.MethodGet, "/api/attempts/{id}", "getAttempt", tag, "Get an attempt's result breakdown", http.StatusOK, a.getAttempt)
}

func (a *api) listQuizzes(ctx context.Context, _ *struct{}) (*quizzesOutput, error) {
	res, err := a.s.ListQuizzes(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &quizzesOutput{Body: apimodel.FromQuizzes(res)}, nil
}

func (a *api) getMistakes(ctx context.Context, _ *struct{}) (*quizOutput, error) {
	res, err := a.s.MistakesQuiz(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &quizOutput{Body: apimodel.FromQuiz(res)}, nil
}

func (a *api) getQuiz(ctx context.Context, in *quizIDInput) (*quizOutput, error) {
	// "review_mistakes" is a virtual quiz assembled from the mistakes pool.
	if in.ID == "review_mistakes" {
		return a.getMistakes(ctx, nil)
	}
	// Owners plus link/public viewers (shared quizzes can be attempted).
	isOwner, err := a.materialRead(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.GetQuiz(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	body := apimodel.FromQuiz(res)
	body.IsOwner = isOwner
	return &quizOutput{Body: body}, nil
}

func (a *api) createQuiz(ctx context.Context, in *createQuizInput) (*quizOutput, error) {
	b := in.Body
	name := b.Name
	if name == "" {
		name = "Untitled quiz"
	}
	privacy := b.Privacy
	if privacy == "" {
		privacy = "private"
	}
	wsID, wsName := b.WorkspaceID, ""
	if wsID != "" {
		ws, err := a.s.GetWorkspace(ctx, userID(ctx), wsID, false)
		if err != nil {
			return nil, hErr(err)
		}
		wsName = ws.Name
	}
	res, err := a.s.CreateQuiz(ctx, store.Quiz{
		UserID: userID(ctx), Name: name, WorkspaceID: wsID, WorkspaceName: wsName, Chapters: b.Chapters,
		Questions: apimodel.EncodeQuestions(b.Questions), Privacy: privacy, TimeLimitMin: b.TimeLimitMin,
	})
	if err != nil {
		return nil, hErr(err)
	}
	return &quizOutput{Body: apimodel.FromQuiz(res)}, nil
}

func (a *api) updateQuiz(ctx context.Context, in *updateQuizInput) (*quizOutput, error) {
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	p := store.QuizPatch{Name: in.Body.Name, Chapters: in.Body.Chapters, Privacy: in.Body.Privacy, TimeLimitMin: in.Body.TimeLimitMin}
	if in.Body.Questions != nil {
		raw := apimodel.EncodeQuestions(*in.Body.Questions)
		p.Questions = &raw
	}
	res, err := a.s.UpdateQuiz(ctx, in.ID, p)
	if err != nil {
		return nil, hErr(err)
	}
	return &quizOutput{Body: apimodel.FromQuiz(res)}, nil
}

func (a *api) deleteQuiz(ctx context.Context, in *quizIDInput) (*Empty, error) {
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	if err := a.s.DeleteQuiz(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

func (a *api) listAttempts(ctx context.Context, _ *struct{}) (*attemptsOutput, error) {
	res, err := a.s.ListAttempts(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &attemptsOutput{Body: res}, nil
}

func (a *api) createAttempt(ctx context.Context, in *createAttemptInput) (*attemptOutput, error) {
	// review_mistakes is a virtual per-user quiz; real quizzes must be readable
	// (owner/member or link/public) before an attempt can be recorded.
	if in.ID != "review_mistakes" {
		if _, err := a.materialRead(ctx, in.ID); err != nil {
			return nil, hErr(err)
		}
	}
	if in.Body.Correct > in.Body.Total {
		return nil, huma.Error422UnprocessableEntity("correct cannot exceed total")
	}
	wrong := make([]json.RawMessage, 0, len(in.Body.Wrong))
	ids := make([]string, 0, len(in.Body.Wrong))
	for _, q := range in.Body.Wrong {
		wrong = append(wrong, apimodel.EncodeRaw(q))
		if id, ok := q["id"].(string); ok && id != "" {
			ids = append(ids, id)
		}
	}
	if len(wrong) > 0 {
		_ = a.s.AddMistakes(ctx, userID(ctx), wrong)
	}
	// A review-mistakes attempt prunes everything answered correctly this round.
	if in.ID == "review_mistakes" {
		_ = a.s.ClearMistakesExcept(ctx, userID(ctx), ids)
	}
	res, err := a.s.CreateAttempt(ctx, userID(ctx), in.ID, in.Body.Correct, in.Body.Total,
		apimodel.EncodeRaw(in.Body.Answers), apimodel.EncodeQuestions(in.Body.Questions))
	if err != nil {
		return nil, hErr(err)
	}
	return &attemptOutput{Body: res}, nil
}

func (a *api) getAttempt(ctx context.Context, in *attemptIDInput) (*attemptDetailOutput, error) {
	res, err := a.s.GetAttempt(ctx, in.ID, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &attemptDetailOutput{Body: apimodel.FromAttemptDetail(res)}, nil
}
