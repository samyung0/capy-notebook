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
	"github.com/go-chi/chi/v5"
	"golang.org/x/sync/errgroup"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/jev"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Open quiz parts are graded by Jev, one request per part and one award per
// marking item. Requests name parts of a stored quiz and carry only answers,
// so the endpoints cannot grade arbitrary text against arbitrary schemes.

// GradeQuizReq maps open part ids to the learner's answers. Blank answers may
// be omitted; the browser scores them 0.
type GradeQuizReq struct {
	Answers map[string]string `json:"answers"`
	// LocalID is the anonymous browser's reporting id; ignored when signed in.
	LocalID string `json:"localId,omitempty"`
}

// GradedPart awards each marking item 0, 0.5 or 1; Awarded is their sum.
type GradedPart struct {
	Awarded    float64   `json:"awarded"`
	ItemAwards []float64 `json:"itemAwards" nullable:"false"`
}

type GradeQuizResp struct {
	Parts map[string]GradedPart `json:"parts" nullable:"false"`
}

type gradeQuizInput struct {
	ID   string `path:"id"`
	Body GradeQuizReq
}
type gradeQuizOutput struct {
	Body GradeQuizResp
}

// gradeBodyMaxBytes fits twenty 5,000-character answers as UTF-8.
const gradeBodyMaxBytes = 512 << 10

var errGradeRequest = errors.New("answers must name open parts of this quiz")

func (a *api) registerQuizGrading(api huma.API) {
	regWithMaxBody(api, http.MethodPost, "/api/quizzes/{id}/grade", "gradeQuiz", "Quizzes",
		"Grade the open parts of one quiz attempt", http.StatusOK, gradeBodyMaxBytes, a.gradeQuiz)
}

type openPart struct {
	question   string
	markscheme []string
	itemMarks  []float64
	answer     string
}

// openParts matches answers to the quiz's open parts and drops blank ones.
func openParts(raw json.RawMessage, answers map[string]string) (map[string]openPart, error) {
	if len(answers) > fieldlimits.QuizOpenParts {
		return nil, errGradeRequest
	}
	var qs []map[string]any
	if err := json.Unmarshal(raw, &qs); err != nil {
		return nil, err
	}
	type location struct {
		question map[string]any
		index    int
		part     map[string]any
	}
	open := map[string]location{}
	for _, q := range qs {
		parts, _ := q["parts"].([]any)
		for i, rawPart := range parts {
			p, _ := rawPart.(map[string]any)
			if a, _ := p["answer"].(map[string]any); a["type"] == "open" {
				id, _ := p["id"].(string)
				open[id] = location{q, i, p}
			}
		}
	}
	out := map[string]openPart{}
	for id, answer := range answers {
		loc, ok := open[id]
		if !ok || utf8.RuneCountInString(answer) > fieldlimits.QuizOpenAnswer {
			return nil, errGradeRequest
		}
		if strings.TrimSpace(answer) == "" {
			continue
		}
		items, marks := questions.MarkItems(loc.part)
		out[id] = openPart{question: questions.GradingText(loc.question, loc.index), markscheme: items, itemMarks: marks, answer: answer}
	}
	return out, nil
}

// gradeOpenParts sends each part to Jev with bounded concurrency. Any failure
// fails the whole attempt; the learner retries.
func (a *api) gradeOpenParts(ctx context.Context, parts map[string]openPart) (GradeQuizResp, jev.Usage, error) {
	resp := GradeQuizResp{Parts: map[string]GradedPart{}}
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
			total := 0.0
			for i := range awards {
				awards[i] *= part.itemMarks[i]
				total += awards[i]
			}
			mu.Lock()
			defer mu.Unlock()
			resp.Parts[id] = GradedPart{Awarded: total, ItemAwards: awards}
			usage.Model = used.Model
			usage.InputTokens += used.InputTokens
			return nil
		})
	}
	return resp, usage, group.Wait()
}

func (a *api) gradeQuiz(ctx context.Context, in *gradeQuizInput) (*gradeQuizOutput, error) {
	// Anyone who can read the quiz, including link/public viewers, can take it.
	if _, err := a.materialRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	quiz, err := a.s.GetQuiz(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	parts, err := openParts(quiz.Questions, in.Body.Answers)
	if errors.Is(err, errGradeRequest) {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	if err != nil {
		return nil, hErr(err)
	}
	if len(parts) == 0 {
		return &gradeQuizOutput{Body: GradeQuizResp{Parts: map[string]GradedPart{}}}, nil
	}
	resp, usage, err := a.gradeOpenParts(ctx, parts)
	if err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz})
		return nil, huma.Error503ServiceUnavailable("grading is unavailable, try again")
	}
	// Usage is recorded, never charged. A failed write must not discard grades
	// the learner already waited for.
	if err := a.s.RecordUsage(ctx, store.UsageEvent{
		ActorUserID: userID(ctx), WorkspaceID: quiz.WorkspaceID,
		Kind: store.KindLLM, Surface: store.SurfaceQuiz, Provider: "typesafe", Model: usage.Model,
		InputTokens: usage.InputTokens, Units: int64(len(parts)), Unit: "parts",
		Metadata: map[string]any{"quizId": quiz.ID, "costMicroUsd": jev.CostMicroUSD(usage.InputTokens)},
	}); err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz})
	}
	return &gradeQuizOutput{Body: resp}, nil
}

// gradeAnonymousQuiz serves POST /api/public/quizzes/{token}/grade, reached
// through the site Worker. It is a plain handler because the daily caps key on
// the client IP.
func (a *api) gradeAnonymousQuiz(w http.ResponseWriter, r *http.Request) {
	id, ok := a.s.VerifyShareToken(chi.URLParam(r, "token"))
	if !ok {
		a.fail(w, store.ErrNotFound)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, gradeBodyMaxBytes)
	var in GradeQuizReq
	if err := decode(r, &in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid grading request"})
		return
	}
	quiz, err := a.s.AnonymousQuiz(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	parts, err := openParts(quiz.Questions, in.Answers)
	if errors.Is(err, errGradeRequest) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"message": err.Error()})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	if len(parts) == 0 {
		writeJSON(w, http.StatusOK, GradeQuizResp{Parts: map[string]GradedPart{}})
		return
	}
	if a.jev == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "grading is unavailable, try again"})
		return
	}
	ipHash := a.s.AnonymousIPHash(obs.ClientIP(r))
	if err := a.s.ReserveAnonymousGrading(r.Context(), ipHash, in.LocalID, len(parts)); errors.Is(err, store.ErrAnonymousGradingLimit) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{
			"code": "anonymous_grading_limit", "message": "sign in to keep grading open answers today",
		})
		return
	} else if err != nil {
		a.fail(w, err)
		return
	}
	resp, usage, err := a.gradeOpenParts(r.Context(), parts)
	if err != nil {
		obs.CaptureErr(r.Context(), err, map[string]string{"surface": "anonymous_quiz"})
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "grading is unavailable, try again"})
		return
	}
	if err := a.s.RecordAnonymousGradingUsage(r.Context(), ipHash, in.LocalID, usage.InputTokens, jev.CostMicroUSD(usage.InputTokens)); err != nil {
		obs.CaptureErr(r.Context(), err, map[string]string{"surface": "anonymous_quiz"})
	}
	writeJSON(w, http.StatusOK, resp)
}

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
