package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"golang.org/x/sync/errgroup"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/jev"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Grading happens here, never in the browser: readers who are not editing get
// answer-free questions (questions.LearnerView), and checking an answer or
// submitting an attempt sends the learner's answers by part id. Closed parts
// are scored by questions.ScorePart; open parts go to Jev, one request per
// answered part and one award per marking item. The response carries the key
// for what was just checked.

// answersMaxBytes bounds a request of answers: twenty 5,000-character open
// answers plus every closed answer of a 100-part quiz.
const answersMaxBytes = 2 << 20

var errGradeRequest = errors.New("answers must name parts of these questions, and an open answer is text of at most 5,000 characters")

type openPart struct {
	question   string
	markscheme []string
	itemMarks  []float64
	answer     string
}

// gradePlan is a grading request checked against the stored questions; open
// holds the answered open parts, the ones Jev grades.
type gradePlan struct {
	questions []map[string]any
	answers   map[string]any
	open      map[string]openPart
}

// planGrading refuses answers to parts the questions do not have and open
// answers that are not text or are too long. Blank open answers earn 0
// without a Jev call.
func planGrading(qs []map[string]any, answers map[string]any) (gradePlan, error) {
	plan := gradePlan{questions: qs, answers: answers, open: map[string]openPart{}}
	known := map[string]bool{}
	for _, q := range qs {
		parts, _ := q["parts"].([]any)
		for i, raw := range parts {
			p, _ := raw.(map[string]any)
			id, _ := p["id"].(string)
			known[id] = true
			if a, _ := p["answer"].(map[string]any); a["type"] != "open" || answers[id] == nil {
				continue
			}
			text, ok := answers[id].(string)
			if !ok || utf8.RuneCountInString(text) > fieldlimits.QuizOpenAnswer {
				return gradePlan{}, errGradeRequest
			}
			if strings.TrimSpace(text) == "" {
				continue
			}
			items, marks := questions.MarkItems(p)
			plan.open[id] = openPart{question: questions.GradingText(q, i), markscheme: items, itemMarks: marks, answer: text}
		}
	}
	for id := range answers {
		if !known[id] {
			return gradePlan{}, errGradeRequest
		}
	}
	return plan, nil
}

// gradeRequestError answers a refused plan with 422 and passes others on.
func gradeRequestError(err error) error {
	if errors.Is(err, errGradeRequest) {
		return huma.Error422UnprocessableEntity(err.Error())
	}
	return hErr(err)
}

// gradeOpenParts sends each part to Jev with bounded concurrency. Any failure
// fails the whole request; the learner retries. It returns each part's marks
// per marking item.
func (a *api) gradeOpenParts(ctx context.Context, parts map[string]openPart) (map[string][]float64, jev.Usage, error) {
	out := map[string][]float64{}
	var usage jev.Usage
	var mu sync.Mutex
	group, ctx := errgroup.WithContext(ctx)
	group.SetLimit(5)
	for id, part := range parts {
		group.Go(func() error {
			awards, used, err := a.jev.GradePart(ctx, part.question, part.markscheme, part.answer)
			if err != nil {
				return err
			}
			// Jev judges each item as none, half or all of it; items carry their own marks.
			for i := range awards {
				awards[i] *= part.itemMarks[i]
			}
			mu.Lock()
			defer mu.Unlock()
			out[id] = awards
			usage.Model = used.Model
			usage.InputTokens += used.InputTokens
			return nil
		})
	}
	return out, usage, group.Wait()
}

// grade grades every part of the plan and returns the questions with keys and
// awards (questions.Graded) and the awarded marks over the total.
func (a *api) grade(ctx context.Context, plan gradePlan) ([]map[string]any, float64, float64, jev.Usage, error) {
	var open map[string][]float64
	var usage jev.Usage
	if len(plan.open) > 0 {
		var err error
		if open, usage, err = a.gradeOpenParts(ctx, plan.open); err != nil {
			return nil, 0, 0, usage, err
		}
	}
	graded := make([]map[string]any, len(plan.questions))
	var correct, total float64
	for i, q := range plan.questions {
		var awarded, marks float64
		graded[i], awarded, marks = questions.Graded(q, plan.answers, open)
		correct, total = correct+awarded, total+marks
	}
	return graded, correct, total, usage, nil
}

// gradeSignedIn grades for a signed-in learner and records Jev's usage,
// uncharged. A failed usage write must not discard grades the learner waited for.
func (a *api) gradeSignedIn(ctx context.Context, plan gradePlan, workspaceID string, metadata map[string]any) ([]map[string]any, float64, float64, error) {
	graded, correct, total, usage, err := a.grade(ctx, plan)
	if err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz})
		return nil, 0, 0, huma.Error503ServiceUnavailable("grading is unavailable, try again")
	}
	if total <= 0 {
		return nil, 0, 0, huma.Error422UnprocessableEntity("there are no questions to grade")
	}
	if len(plan.open) == 0 {
		return graded, correct, total, nil
	}
	metadata["costMicroUsd"] = jev.CostMicroUSD(usage.InputTokens)
	if err := a.s.RecordUsage(ctx, store.UsageEvent{
		ActorUserID: userID(ctx), WorkspaceID: workspaceID,
		Kind: store.KindLLM, Surface: store.SurfaceQuiz, Provider: "typesafe", Model: usage.Model,
		InputTokens: usage.InputTokens, Units: int64(len(plan.open)), Unit: "parts", Metadata: metadata,
	}); err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz})
	}
	return graded, correct, total, nil
}

func decodeStoredQuestions(raw json.RawMessage) ([]map[string]any, error) {
	var qs []map[string]any
	if len(raw) == 0 {
		return qs, nil
	}
	return qs, json.Unmarshal(raw, &qs)
}

/* ------------------------------------------------------- signed-out grading */

type clientIPKey struct{}

type gradeAnonymousQuizInput struct {
	Token string `path:"token"`
	Body  apimodel.GradeAnonymousQuizReq
}
type gradeAnonymousNoteQuizInput struct {
	Token  string `path:"token"`
	QuizID string `path:"quizId"`
	Body   apimodel.GradeAnonymousQuizReq
}
type gradedQuizOutput struct {
	Body apimodel.GradedQuiz
}

// registerAnonymousGrading serves POST /api/public/quizzes/{token}/grade and,
// for a quiz embedded in a shared note, POST
// /api/public/notes/{token}/quizzes/{quizId}/grade, reached directly, not
// through the site Worker. Nothing is stored; the daily caps key on the client
// IP and count only the open parts Jev grades.
func (a *api) registerAnonymousGrading(api huma.API) {
	clientIP := huma.Middlewares{func(ctx huma.Context, next func(huma.Context)) {
		r, _ := humachi.Unwrap(ctx)
		next(huma.WithValue(ctx, clientIPKey{}, obs.ClientIP(r)))
	}}
	huma.Register(api, huma.Operation{
		OperationID: "gradeAnonymousQuiz", Method: http.MethodPost, Path: "/api/public/quizzes/{token}/grade",
		Summary: "Grade a signed-out attempt at a shared quiz", Tags: []string{"Sharing"},
		DefaultStatus: http.StatusOK, MaxBodyBytes: answersMaxBytes, Middlewares: clientIP,
	}, func(ctx context.Context, in *gradeAnonymousQuizInput) (*gradedQuizOutput, error) {
		out, err := a.gradeAnonymousQuiz(ctx, in)
		return out, reportHandlerError(ctx, err)
	})
	huma.Register(api, huma.Operation{
		OperationID: "gradeAnonymousNoteQuiz", Method: http.MethodPost, Path: "/api/public/notes/{token}/quizzes/{quizId}/grade",
		Summary: "Grade an attempt at a quiz embedded in a shared note", Tags: []string{"Sharing"},
		DefaultStatus: http.StatusOK, MaxBodyBytes: answersMaxBytes, Middlewares: clientIP,
	}, func(ctx context.Context, in *gradeAnonymousNoteQuizInput) (*gradedQuizOutput, error) {
		out, err := a.gradeAnonymousNoteQuiz(ctx, in)
		return out, reportHandlerError(ctx, err)
	})
}

func (a *api) gradeAnonymousQuiz(ctx context.Context, in *gradeAnonymousQuizInput) (*gradedQuizOutput, error) {
	id, err := a.sharedMaterialID(in.Token)
	if err != nil {
		return nil, err
	}
	quiz, err := a.s.AnonymousQuiz(ctx, id)
	if err != nil {
		return nil, hErr(err)
	}
	return a.gradeAnonymous(ctx, quiz.Questions, in.Body)
}

// gradeAnonymousNoteQuiz grades a quiz the shared note embeds and references;
// any other quiz is 404.
func (a *api) gradeAnonymousNoteQuiz(ctx context.Context, in *gradeAnonymousNoteQuizInput) (*gradedQuizOutput, error) {
	id, err := a.sharedMaterialID(in.Token)
	if err != nil {
		return nil, err
	}
	stored, err := a.s.AnonymousNoteQuiz(ctx, id, in.QuizID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.gradeAnonymous(ctx, stored, in.Body)
}

// gradeAnonymous grades a signed-out attempt against the stored questions
// under the anonymous daily caps.
func (a *api) gradeAnonymous(ctx context.Context, stored json.RawMessage, body apimodel.GradeAnonymousQuizReq) (*gradedQuizOutput, error) {
	qs, err := decodeStoredQuestions(stored)
	if err != nil {
		return nil, hErr(err)
	}
	plan, err := planGrading(qs, body.Answers)
	if err != nil {
		return nil, gradeRequestError(err)
	}
	var ipHash string
	if len(plan.open) > 0 {
		if a.jev == nil {
			return nil, huma.Error503ServiceUnavailable("grading is unavailable, try again")
		}
		ip, _ := ctx.Value(clientIPKey{}).(string)
		ipHash = a.s.AnonymousIPHash(ip)
		if err := a.s.ReserveAnonymousGrading(ctx, ipHash, body.LocalID, len(plan.open)); errors.Is(err, store.ErrAnonymousGradingLimit) {
			return nil, &huma.ErrorModel{
				Status: http.StatusTooManyRequests, Title: http.StatusText(http.StatusTooManyRequests),
				Detail: "sign in to keep grading open answers today", Errors: []*huma.ErrorDetail{{Message: "anonymous_grading_limit"}},
			}
		} else if err != nil {
			return nil, hErr(err)
		}
	}
	graded, correct, total, usage, err := a.grade(ctx, plan)
	if err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"surface": "anonymous_quiz"})
		return nil, huma.Error503ServiceUnavailable("grading is unavailable, try again")
	}
	if total <= 0 {
		return nil, huma.Error422UnprocessableEntity("there are no questions to grade")
	}
	if len(plan.open) > 0 {
		if err := a.s.RecordAnonymousGradingUsage(ctx, ipHash, body.LocalID, usage.InputTokens, jev.CostMicroUSD(usage.InputTokens)); err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"surface": "anonymous_quiz"})
		}
	}
	return &gradedQuizOutput{Body: apimodel.GradedQuiz{Correct: correct, Total: total, Questions: graded}}, nil
}

/* --------------------------------------------------------- authoring check */

// ComputationCheckReq names one open part of a draft question.
type ComputationCheckReq struct {
	Question map[string]any `json:"question"`
	PartID   string         `json:"partId"`
}

// ComputationCheckResp warns an author that Jev cannot reliably grade this
// open part because grading it needs a calculation checked.
type ComputationCheckResp struct {
	Computational bool    `json:"computational"`
	Probability   float64 `json:"probability"`
}

type computationCheckInput struct {
	Body ComputationCheckReq
}
type computationCheckOutput struct {
	Body ComputationCheckResp
}

func (a *api) registerComputationCheck(api huma.API) {
	regWithMaxBody(api, http.MethodPost, "/api/questions/computation-check", "checkQuestionComputation", "Quizzes",
		"Check whether an open part needs computation to grade", http.StatusOK, materialRequestMaxBytes, a.checkQuestionComputation)
}

func (a *api) checkQuestionComputation(ctx context.Context, in *computationCheckInput) (*computationCheckOutput, error) {
	if err := questions.Validate(in.Body.Question, questions.Policy{}); err != nil {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	parts, _ := in.Body.Question["parts"].([]any)
	for i, raw := range parts {
		p, _ := raw.(map[string]any)
		answer, _ := p["answer"].(map[string]any)
		if p["id"] != in.Body.PartID || answer["type"] != "open" {
			continue
		}
		items, _ := questions.MarkItems(p)
		probability, usage, err := a.jev.RequiresComputation(ctx, questions.GradingText(in.Body.Question, i), items)
		if err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz})
			return nil, huma.Error503ServiceUnavailable("the check is unavailable, try again")
		}
		if err := a.s.RecordUsage(ctx, store.UsageEvent{
			ActorUserID: userID(ctx), Kind: store.KindLLM, Surface: store.SurfaceQuiz,
			Provider: "typesafe", Model: usage.Model, InputTokens: usage.InputTokens, Units: 1, Unit: "checks",
			Metadata: map[string]any{"costMicroUsd": jev.CostMicroUSD(usage.InputTokens)},
		}); err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz})
		}
		return &computationCheckOutput{Body: ComputationCheckResp{
			Computational: probability >= jev.ComputationThreshold, Probability: probability,
		}}, nil
	}
	return nil, huma.Error422UnprocessableEntity("partId must name an open part of the question")
}
