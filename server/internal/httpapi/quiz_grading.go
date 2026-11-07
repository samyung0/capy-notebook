package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"golang.org/x/sync/errgroup"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/jev"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Grading happens here, never in the browser: readers who are not editing get
// answer-free questions (questions.LearnerView), and checking an answer or
// submitting an attempt sends the learner's answers by part id. Closed parts
// are scored by questions.ScorePart; open parts go to the grading slot's model,
// one request per answered part and one award per marking item, except on a
// shared page, where they stay Not marked. The response carries the key for what
// was just checked.

// answersMaxBytes bounds a request of answers: a hundred 5,000-character open
// answers at up to four bytes a character plus every closed answer of a
// 100-part quiz.
const answersMaxBytes = 4 << 20

var errGradeRequest = errors.New("answers must name parts of these questions, give every ordering part an order, and keep an open answer to text of at most 5,000 characters")

type openPart struct {
	question   string
	markscheme []string
	itemMarks  []float64
	answer     string
	// A drawing part: its marking image and type, in place of answer, and
	// its drawn sample answer's image, sent before it when it has one.
	image     []byte
	imageType string
	sample    sampleOwner
}

// sampleOwner is a drawing part's drawn sample answer image (assetID) and what
// it must belong to: the quiz checked (materialID) or the assignment's frozen
// copy (assignmentID). A bank question names neither, so it takes none.
type sampleOwner struct {
	assetID, materialID, assignmentID string
}

// gradePlan is a grading request checked against the stored questions; open
// holds the answered open and drawing parts, the ones a model may grade, and
// drawings the boards (and images) a check sent, which a signed-in check keeps.
type gradePlan struct {
	questions []map[string]any
	answers   map[string]any
	open      map[string]openPart
	drawings  map[string]drawingUpload
}

// planGrading refuses answers to parts the questions do not have, ordering
// parts with no order (the shown order is always an answer, so a client sends
// it), and open answers that are not text or are too long. Blank open answers
// earn 0 without a model call.
func planGrading(qs []map[string]any, answers map[string]any, owner sampleOwner) (gradePlan, error) {
	plan := gradePlan{questions: qs, answers: answers, open: map[string]openPart{}, drawings: map[string]drawingUpload{}}
	known := map[string]bool{}
	for _, q := range qs {
		parts, _ := q["parts"].([]any)
		for i, raw := range parts {
			p, _ := raw.(map[string]any)
			id, _ := p["id"].(string)
			known[id] = true
			a, _ := p["answer"].(map[string]any)
			if a["type"] == "ordering" && answers[id] == nil {
				return gradePlan{}, errGradeRequest
			}
			if a["type"] == "drawing" && answers[id] != nil {
				drawing, imageType, err := sentDrawing(answers[id])
				if err != nil {
					return gradePlan{}, err
				}
				plan.drawings[id] = drawing
				// Stored as the drawing's id once kept (store.withDrawingAnswers).
				answers[id] = map[string]any{"drawing": ""}
				if imageType != "" {
					items, marks := questions.MarkItems(p)
					plan.open[id] = openPart{
						question: questions.GradingText(q, i), markscheme: items, itemMarks: marks,
						image: drawing.Image, imageType: imageType,
						sample: sampleOwner{assetID: questions.DrawnSampleImage(p), materialID: owner.materialID, assignmentID: owner.assignmentID},
					}
				}
				continue
			}
			if a["type"] != "open" || answers[id] == nil {
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

// sentDrawing reads a drawing part's answer as a check sends it, {board,
// image} in base64, and checks both before anything is stored or marked.
func sentDrawing(value any) (drawingUpload, string, error) {
	m, ok := value.(map[string]any)
	if !ok {
		return drawingUpload{}, "", errGradeRequest
	}
	decode := func(key string) ([]byte, bool) {
		text, isText := m[key].(string)
		if !isText {
			return nil, m[key] == nil
		}
		b, err := base64.StdEncoding.DecodeString(text)
		return b, err == nil
	}
	board, okBoard := decode("board")
	image, okImage := decode("image")
	if !okBoard || !okImage || len(board) == 0 {
		return drawingUpload{}, "", errGradeRequest
	}
	upload := drawingUpload{Board: board, Image: image}
	imageType, err := checkedDrawing(upload)
	return upload, imageType, err
}

// gradeRequestError answers a refused plan with 422 and passes others on.
func gradeRequestError(err error) error {
	if errors.Is(err, errGradeRequest) {
		return huma.Error422UnprocessableEntity(err.Error())
	}
	return hErr(err)
}

// gradingLimitError is the refusal past the signed-in daily part cap.
func gradingLimitError() error {
	return limitError("grading_limit", "today's grading limit is reached; it resets at midnight UTC")
}

// reserveGrading counts parts against the signed-in user's daily cap before
// any model call.
func (a *api) reserveGrading(ctx context.Context, parts int) error {
	if err := a.s.ReserveGrading(ctx, userID(ctx), parts); errors.Is(err, store.ErrGradingLimit) {
		return gradingLimitError()
	} else if err != nil {
		return hErr(err)
	}
	return nil
}

const (
	// gradingPartTimeout bounds one part just past the pipeline's own bound: its
	// turn in the model's line (up to 60 s), then a part with working's 120 s.
	gradingPartTimeout = 3*time.Minute + 15*time.Second
	// gradingCheckTimeout bounds a check someone waits on, inside the 100 s the
	// proxy in front allows: a part still running then stays Not marked, and the
	// parts done are kept.
	gradingCheckTimeout = 90 * time.Second
)

// gradingLLM is the grading slot's pin. A part with working thinks at low; the
// pipeline turns thinking off for the rest.
func (a *api) gradingLLM(ctx context.Context, userID string) (resolvedLLM, error) {
	var out resolvedLLM
	if a.modelReg == nil || a.pipe == nil {
		return out, fmt.Errorf("%w: registry or pipeline not configured", store.ErrModelUnavailable)
	}
	cfg, err := a.modelReg.Default(ctx, models.SlotGrading)
	if err != nil {
		return out, fmt.Errorf("%w: %v", store.ErrModelUnavailable, err)
	}
	out.Cfg, out.Rates, out.UserID, out.Thinking = cfg, store.RatesFromConfig(cfg), userID, models.ThinkingLow
	return out, nil
}

// partGrade is a part's marks per marking item, and the AI's comment on it; Flag
// names what code told apart ("copied", "instructions"), which shows as an error.
type partGrade struct {
	Items   []float64
	Comment string
	Flag    string
}

// gradeWithModel marks open parts on the payer's credits, ten at once (Epo
// 2026-11-04). It keeps each part's result: one that fails, or all of them when
// there is nothing to pay with, is simply absent, and stays "Not marked". Nothing
// retries it.
func (a *api) gradeWithModel(ctx context.Context, payerID, workspaceID string, parts map[string]openPart) map[string]partGrade {
	out := make(map[string]partGrade, len(parts))
	if len(parts) == 0 {
		return out
	}
	llm, err := a.gradingLLM(ctx, payerID)
	if err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz})
		return out
	}
	charge, err := a.beginProviderSession(ctx, payerID, workspaceID, store.SurfaceQuiz, llm.Rates, store.TokenRates{}, llm.Thinking)
	if err != nil {
		if !errors.Is(err, store.ErrCreditsExhausted) {
			obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz})
		}
		return out
	}
	defer charge.settle(ctx)
	var mu sync.Mutex
	var group errgroup.Group
	group.SetLimit(10)
	// One report a run: a line of failures has one cause, such as credits running
	// out partway.
	var report sync.Once
	for id, part := range parts {
		group.Go(func() error {
			grade, err := a.gradePartSafely(ctx, llm, charge.id, part)
			if err != nil {
				report.Do(func() {
					obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz, "stage": "grade_part"})
				})
				return nil
			}
			mu.Lock()
			defer mu.Unlock()
			out[id] = grade
			return nil
		})
	}
	_ = group.Wait()
	return out
}

// gradePartSafely makes gradePart's panic that part's failure. It runs on a
// goroutine of its own, where nothing above it catches one, so a panic would stop
// the whole server for everyone.
func (a *api) gradePartSafely(ctx context.Context, llm resolvedLLM, sessionID string, part openPart) (grade partGrade, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = panicError("grading a part", r)
		}
	}()
	return a.gradePart(ctx, llm, sessionID, part)
}

// panicError turns a recovered panic into an error that keeps where it happened.
func panicError(what string, recovered any) error {
	return fmt.Errorf("%s panicked: %v\n%s", what, recovered, debug.Stack())
}

func (a *api) gradePart(ctx context.Context, llm resolvedLLM, sessionID string, part openPart) (partGrade, error) {
	ctx, cancel := context.WithTimeout(ctx, gradingPartTimeout)
	defer cancel()
	items := make([]map[string]any, len(part.markscheme))
	for i, text := range part.markscheme {
		items[i] = map[string]any{"text": text, "marks": part.itemMarks[i]}
	}
	body := map[string]any{"question": part.question, "items": items, "spendSessionId": sessionID}
	// A drawing goes as its marking image in place of the answer (M1, Epo
	// 2026-11-07), after its drawn sample answer's image when it has one (Q3).
	if len(part.image) > 0 {
		body["image"] = "data:" + part.imageType + ";base64," + base64.StdEncoding.EncodeToString(part.image)
		if part.sample.assetID != "" {
			sample, err := a.sampleImage(ctx, part.sample)
			if err != nil {
				return partGrade{}, err
			}
			body["sampleImage"] = sample
		}
	} else {
		body["answer"] = part.answer
	}
	llm.attach(body)
	raw, err := a.pipe.PostRawUntil(ctx, "/grade", body)
	if err != nil {
		return partGrade{}, err
	}
	var reply struct {
		Shares  []float64 `json:"shares"`
		Comment string    `json:"comment"`
		Flag    string    `json:"flag"`
	}
	if err := json.Unmarshal(raw, &reply); err != nil {
		return partGrade{}, err
	}
	if len(reply.Shares) != len(part.itemMarks) {
		return partGrade{}, fmt.Errorf("grading answered %d items of %d", len(reply.Shares), len(part.itemMarks))
	}
	// The model judges none, half or all of an item; items carry their own marks.
	marks := make([]float64, len(reply.Shares))
	for i, share := range reply.Shares {
		marks[i] = share * part.itemMarks[i]
	}
	return partGrade{Items: marks, Comment: reply.Comment, Flag: reply.Flag}, nil
}

// applyPartGrade writes a late mark into a part left Not marked.
func applyPartGrade(p map[string]any, grade partGrade) {
	delete(p, "pending")
	p["itemAwards"] = grade.Items
	var awarded float64
	for _, item := range grade.Items {
		awarded += item
	}
	if marks, ok := p["marks"].(float64); ok && awarded > marks {
		awarded = marks
	}
	p["awarded"] = awarded
	if grade.Comment != "" {
		p["aiComment"] = grade.Comment
		if grade.Flag != "" {
			p["aiFlag"] = grade.Flag
		}
	}
}

// gradedWithModel applies the model's marks to the plan's questions. An answered
// open part it has no mark for is "Not marked", counted in the total and not as
// wrong: nothing logs it, and it joins no review.
func gradedWithModel(plan gradePlan, grades map[string]partGrade) ([]map[string]any, float64, float64) {
	open := make(map[string][]float64, len(grades))
	for id, grade := range grades {
		open[id] = grade.Items
	}
	graded := make([]map[string]any, len(plan.questions))
	var correct, total float64
	for i, q := range plan.questions {
		out, awarded, marks := questions.Graded(q, plan.answers, open)
		parts, _ := out["parts"].([]any)
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			id, _ := p["id"].(string)
			if _, answered := plan.open[id]; !answered {
				continue
			}
			grade, marked := grades[id]
			if !marked {
				p["pending"] = true
				delete(p, "itemAwards")
			} else if grade.Comment != "" {
				p["aiComment"] = grade.Comment
				if grade.Flag != "" {
					p["aiFlag"] = grade.Flag
				}
			}
		}
		graded[i] = out
		correct, total = correct+awarded, total+marks
	}
	return graded, correct, total
}

// gradeSignedIn grades for a signed-in learner under the daily part cap, on
// their own credits (Epo 2026-11-03): whoever starts a job pays. Out of credits,
// or on a failure, the closed parts still mark and the open ones stay unmarked.
func (a *api) gradeSignedIn(ctx context.Context, plan gradePlan, workspaceID string) ([]map[string]any, float64, float64, error) {
	if len(plan.open) > 0 {
		if err := a.reserveGrading(ctx, len(plan.open)); err != nil {
			return nil, 0, 0, err
		}
	}
	marking, cancel := context.WithTimeout(ctx, gradingCheckTimeout)
	defer cancel()
	graded, correct, total := gradedWithModel(plan, a.gradeWithModel(marking, userID(ctx), workspaceID, plan.open))
	if total <= 0 {
		return nil, 0, 0, huma.Error422UnprocessableEntity("there are no questions to grade")
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

/* ----------------------------------------------------- a shared page's check */

type gradeAnonymousQuizInput struct {
	Token string `path:"token"`
	Body  apimodel.GradeAnonymousQuizReq
}
type gradeAnonymousNoteQuizInput struct {
	Token  string `path:"token"`
	QuizID string `path:"quizId"`
	Body   apimodel.GradeAnonymousQuizReq
}

// registerAnonymousGrading serves POST /api/public/quizzes/{token}/grade and,
// for a quiz embedded in a shared note, POST
// /api/public/notes/{token}/quizzes/{quizId}/grade: a shared page's check, for
// every visitor, signed in or out (Epo 2026-11-05, Q640 B). The browser calls
// them directly, not through the site Worker, so the /api/public/ limit keys on
// the visitor's address. A forged token is refused before the body is read.
func (a *api) registerAnonymousGrading(api huma.API) {
	verified := huma.Middlewares{func(ctx huma.Context, next func(huma.Context)) {
		if _, ok := a.s.VerifyShareToken(ctx.Param("token")); !ok {
			_ = huma.WriteErr(api, ctx, http.StatusNotFound, "not found")
			return
		}
		next(ctx)
	}}
	huma.Register(api, huma.Operation{
		OperationID: "gradeAnonymousQuiz", Method: http.MethodPost, Path: "/api/public/quizzes/{token}/grade",
		Summary: "Check one question of a shared quiz; an answered open part stays Not marked", Tags: []string{"Sharing"},
		DefaultStatus: http.StatusOK, MaxBodyBytes: answersMaxBytes, Middlewares: verified,
	}, func(ctx context.Context, in *gradeAnonymousQuizInput) (*gradedQuestionOutput, error) {
		out, err := a.gradeAnonymousQuiz(ctx, in)
		return out, reportHandlerError(ctx, err)
	})
	huma.Register(api, huma.Operation{
		OperationID: "gradeAnonymousNoteQuiz", Method: http.MethodPost, Path: "/api/public/notes/{token}/quizzes/{quizId}/grade",
		Summary: "Check one question of a quiz embedded in a shared note; an answered open part stays Not marked", Tags: []string{"Sharing"},
		DefaultStatus: http.StatusOK, MaxBodyBytes: answersMaxBytes, Middlewares: verified,
	}, func(ctx context.Context, in *gradeAnonymousNoteQuizInput) (*gradedQuestionOutput, error) {
		out, err := a.gradeAnonymousNoteQuiz(ctx, in)
		return out, reportHandlerError(ctx, err)
	})
}

func (a *api) gradeAnonymousQuiz(ctx context.Context, in *gradeAnonymousQuizInput) (*gradedQuestionOutput, error) {
	id, err := a.sharedMaterialID(in.Token)
	if err != nil {
		return nil, err
	}
	quiz, err := a.s.AnonymousQuiz(ctx, id)
	if err != nil {
		return nil, storedContentError(ctx, id, err)
	}
	return gradeAnonymous(quiz.Questions, in.Body)
}

// gradeAnonymousNoteQuiz grades a quiz the shared note embeds and references;
// any other quiz is 404.
func (a *api) gradeAnonymousNoteQuiz(ctx context.Context, in *gradeAnonymousNoteQuizInput) (*gradedQuestionOutput, error) {
	id, err := a.sharedMaterialID(in.Token)
	if err != nil {
		return nil, err
	}
	stored, err := a.s.AnonymousNoteQuiz(ctx, id, in.QuizID)
	if err != nil {
		return nil, storedContentError(ctx, id, err)
	}
	return gradeAnonymous(stored, in.Body)
}

// gradeAnonymous checks one question against the stored questions. Closed parts
// mark here; no model reads an open answer, so an answered open part comes back
// Not marked, with the marking points and solution any check reveals. Nothing is
// stored.
func gradeAnonymous(stored json.RawMessage, body apimodel.GradeAnonymousQuizReq) (*gradedQuestionOutput, error) {
	qs, err := decodeStoredQuestions(stored)
	if err != nil {
		return nil, hErr(err)
	}
	q, _, _ := quizQuestion(qs, body.QuestionID)
	if q == nil {
		return nil, noAnswersConfiguredError()
	}
	plan, err := planGrading([]map[string]any{q}, body.Answers, sampleOwner{})
	if err != nil {
		return nil, gradeRequestError(err)
	}
	graded, correct, total := gradedWithModel(plan, nil)
	if total <= 0 {
		return nil, huma.Error422UnprocessableEntity("there are no questions to grade")
	}
	return &gradedQuestionOutput{Body: apimodel.GradedQuestion{Correct: correct, Total: total, Question: graded[0]}}, nil
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
		if err := a.reserveGrading(ctx, 1); err != nil {
			return nil, err
		}
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

// sampleImage reads a drawn sample answer's image asset as a data URL. It must be
// a ready, untrashed image of the quiz checked or of the assignment's frozen
// copy, so an author can't have the model read someone else's image (Q693). One
// that isn't, or can't be read, fails the part, which stays Not marked: marking
// without the sample would judge it on less than its author gave.
func (a *api) sampleImage(ctx context.Context, owner sampleOwner) (string, error) {
	assetID := owner.assetID
	asset, err := a.s.GetEditorAsset(ctx, assetID)
	if err != nil {
		return "", err
	}
	belongs := (owner.materialID != "" && asset.MaterialID == owner.materialID) ||
		(owner.assignmentID != "" && asset.AssignmentID == owner.assignmentID)
	if !belongs || asset.Purpose != "image" || asset.Status != "ready" || asset.Trashed || a.blob == nil {
		return "", fmt.Errorf("drawn sample answer %s is not this quiz's stored image", assetID)
	}
	r, err := a.blob.Open(ctx, asset.ObjectPath)
	if err != nil {
		return "", err
	}
	defer r.Close()
	data, err := io.ReadAll(io.LimitReader(r, fieldlimits.DrawingImageBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > fieldlimits.DrawingImageBytes {
		return "", fmt.Errorf("drawn sample answer %s is over the image cap", assetID)
	}
	return "data:" + asset.ContentType + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}
