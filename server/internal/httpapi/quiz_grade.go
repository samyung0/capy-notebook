package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/store"
)

type quizGradeInput struct {
	Body apimodel.QuizGradeReq
}

type quizGradeOutput struct {
	Body apimodel.QuizGradeResp
}

func (a *api) registerQuizGrade(api huma.API) {
	reg(api, http.MethodPost, "/api/quiz-grade", "gradeQuizAnswer", "Quizzes",
		"Mark one open quiz answer against its marking scheme", http.StatusOK, a.gradeQuizAnswer)
}

func (a *api) gradeQuizAnswer(ctx context.Context, in *quizGradeInput) (*quizGradeOutput, error) {
	actor := userID(ctx)
	me, err := a.s.Me(ctx, actor)
	if err != nil {
		return nil, hErr(err)
	}
	if store.IsBrowserQuizKey(me.QuizModelKey) {
		return nil, huma.Error400BadRequest("cloud quiz model required")
	}
	if strings.TrimSpace(in.Body.UserAnswer) == "" {
		return &quizGradeOutput{Body: apimodel.QuizGradeResp{}}, nil
	}

	wsID := in.Body.WorkspaceID
	if wsID != "" {
		if _, err := a.s.WorkspaceAccess(ctx, actor, wsID); err != nil {
			wsID = ""
		}
	}

	llm, err := a.resolveLLM(ctx, actor, models.SurfaceQuiz)
	if err != nil {
		return nil, hErr(err)
	}
	charge, err := a.beginSpend(ctx, actor, wsID, store.SurfaceQuiz, llm.PaidBy)
	if err != nil {
		return nil, hErr(err)
	}
	defer charge.release(ctx)

	if a.pipe == nil {
		return nil, huma.Error503ServiceUnavailable("AI service is unavailable")
	}
	body := map[string]any{
		"hints":       in.Body.Hints,
		"modelAnswer": in.Body.ModelAnswer,
		"prompt":      in.Body.Prompt,
		"rubrics":     in.Body.Rubrics,
		"userAnswer":  in.Body.UserAnswer,
		"workspaceId": wsID,
		"locale":      a.userLocale(ctx, actor),
	}
	llm.attach(body)
	raw, err := a.pipe.PostRaw(ctx, "/quiz-grade", body)
	if err != nil {
		if mapped := pipelineLLMError(err); mapped != nil {
			return nil, hErr(mapped)
		}
		return nil, huma.Error503ServiceUnavailable("AI service is unavailable")
	}
	usage := usageFrom(raw)
	var parsed struct {
		Award  float64 `json:"award"`
		Reason string  `json:"reason"`
	}
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, huma.Error503ServiceUnavailable("AI service is unavailable")
	}
	charge.settle(ctx, usage.events(actor, wsID, store.SurfaceQuiz, llm.Rates, store.TokenRates{}, llm.PaidBy)...)
	return &quizGradeOutput{Body: apimodel.QuizGradeResp{
		Award:  snapGradeAward(parsed.Award),
		Reason: parsed.Reason,
	}}, nil
}

func snapGradeAward(n float64) float64 {
	if n >= 0.75 {
		return 1
	}
	if n >= 0.25 {
		return 0.5
	}
	return 0
}
