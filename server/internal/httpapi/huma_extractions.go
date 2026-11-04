package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Make a quiz (todo-study-tracking.md §8): the retrieval service reads the
// selected pages of a paper into questions, two pages a call, and pairs the
// mark scheme and answer files with them by label; this gateway starts the
// run, keeps the questions as each window ends and saves the quiz at the end.
// The run outlives the request, like a chat turn: it relays on a detached
// context in this process, and FailOrphanedExtractions fails what a restart
// cut short.

type createExtractionInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateExtractionReq
}

type extractionOutput struct {
	Body store.Extraction
}

type getExtractionInput struct {
	ID string `path:"id"`
}

func (a *api) registerExtractions(api huma.API) {
	reg(api, http.MethodPost, "/api/workspaces/{id}/extractions", "createExtraction", "Generate",
		"Start reading the questions on selected pages into a new quiz", http.StatusAccepted, a.createExtraction)
	reg(api, http.MethodGet, "/api/extractions/{id}", "getExtraction", "Generate",
		"A Make a quiz run its starter began", http.StatusOK, a.getExtraction)
}

// checkExtractionRequest holds a run to its caps (Epo 2026-11-03): at most
// ExtractionPages selected pages and ExtractionFiles files, mark scheme and
// answer files included; each file once, each page once and counted from 1.
func checkExtractionRequest(req apimodel.CreateExtractionReq) error {
	files := len(req.Paper) + len(req.AnswerFileIDs)
	if files > fieldlimits.ExtractionFiles {
		return fmt.Errorf("a run reads at most %d files, mark scheme and answer files included; this one has %d", fieldlimits.ExtractionFiles, files)
	}
	seen := map[string]bool{}
	pages := 0
	for _, paper := range req.Paper {
		if seen[paper.FileID] {
			return fmt.Errorf("file %q is listed twice", paper.FileID)
		}
		seen[paper.FileID] = true
		picked := map[int]bool{}
		for _, page := range paper.Pages {
			if page < 1 {
				return fmt.Errorf("file %q: pages are counted from 1", paper.FileID)
			}
			if picked[page] {
				return fmt.Errorf("file %q: page %d is selected twice", paper.FileID, page)
			}
			picked[page] = true
		}
		pages += len(paper.Pages)
	}
	if pages > fieldlimits.ExtractionPages {
		return fmt.Errorf("a run reads at most %d selected pages; %d are selected", fieldlimits.ExtractionPages, pages)
	}
	for _, id := range req.AnswerFileIDs {
		if seen[id] {
			return fmt.Errorf("file %q is listed twice", id)
		}
		seen[id] = true
	}
	return nil
}

// extractionLLM is the run's model: the extraction slot's default pin, a vision
// model on OpenRouter (never direct DeepSeek, Epo 2026-11-03), with reasoning
// at mid for the page windows, which work keys out as well as copying them;
// outline and scheme calls turn it off. The run's starter pays.
func (a *api) extractionLLM(ctx context.Context, userID string) (resolvedLLM, error) {
	var out resolvedLLM
	if a.modelReg == nil {
		return out, fmt.Errorf("%w: registry not configured", store.ErrModelUnavailable)
	}
	cfg, err := a.modelReg.Default(ctx, models.SlotExtraction)
	if err != nil {
		return out, fmt.Errorf("%w: %v", store.ErrModelUnavailable, err)
	}
	if !slices.Contains(cfg.ThinkingLevels, models.ThinkingMid) {
		return out, fmt.Errorf("%w: %s has no mid thinking", store.ErrModelUnavailable, cfg.Ref())
	}
	out.Cfg, out.Rates, out.UserID, out.Thinking = cfg, store.RatesFromConfig(cfg), userID, models.ThinkingMid
	return out, nil
}

// extractionFile is a file as the retrieval service reads it.
type extractionFile struct {
	FileID string `json:"fileId"`
	Name   string `json:"name"`
	Pages  []int  `json:"pages,omitempty"`
}

// extractionFiles checks each file is the workspace's, untrashed and indexed;
// a paper is a PDF or an image (Office files come later, §8).
func (a *api) extractionFiles(ctx context.Context, wsID string, req apimodel.CreateExtractionReq) (paper, answers []extractionFile, err error) {
	paper, answers = []extractionFile{}, []extractionFile{}
	read := func(id string) (store.File, error) {
		f, err := a.s.GetFile(ctx, id)
		if errors.Is(err, store.ErrNotFound) || (err == nil && f.WorkspaceID != wsID) {
			return f, huma.Error400BadRequest(fmt.Sprintf("No workspace file has the id %q: it may have been deleted or moved to trash.", id))
		}
		if err != nil {
			return f, err
		}
		if !f.Indexed {
			return f, huma.Error400BadRequest(fmt.Sprintf("%s has no indexed text yet: wait until it has been read, or process it.", f.Name))
		}
		return f, nil
	}
	for _, p := range req.Paper {
		f, err := read(p.FileID)
		if err != nil {
			return nil, nil, err
		}
		if f.Kind != store.FilePDF && f.Kind != store.FileImage {
			return nil, nil, huma.Error400BadRequest(fmt.Sprintf("%s: questions are read from PDF files and images for now.", f.Name))
		}
		if f.Kind == store.FileImage && !slices.Equal(p.Pages, []int{1}) {
			return nil, nil, huma.Error400BadRequest(fmt.Sprintf("%s is an image: its one page is page 1.", f.Name))
		}
		paper = append(paper, extractionFile{FileID: f.ID, Name: f.Name, Pages: p.Pages})
	}
	for _, id := range req.AnswerFileIDs {
		f, err := read(id)
		if err != nil {
			return nil, nil, err
		}
		answers = append(answers, extractionFile{FileID: f.ID, Name: f.Name})
	}
	return paper, answers, nil
}

func (a *api) createExtraction(ctx context.Context, in *createExtractionInput) (*extractionOutput, error) {
	if err := a.assertWorkspaceEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	// The quiz is the starter's material in the workspace: refuse a frozen
	// account or a full one before credits are reserved.
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	actor, wsID := userID(ctx), in.ID
	if err := a.s.StorageFullErr(ctx, actor); err != nil {
		return nil, hErr(err)
	}
	title, err := normalizeGenerateTitle(string(in.Body.Title))
	if err != nil {
		return nil, huma.Error400BadRequest(err.Error())
	}
	if err := checkExtractionRequest(in.Body); err != nil {
		return nil, huma.Error400BadRequest(err.Error())
	}
	if taken, err := a.s.MaterialTitleTaken(ctx, wsID, title); err != nil {
		return nil, hErr(err)
	} else if taken {
		return nil, hErr(store.ErrTitleTaken)
	}
	paper, answers, err := a.extractionFiles(ctx, wsID, in.Body)
	var refused huma.StatusError
	if errors.As(err, &refused) {
		return nil, err
	}
	if err != nil {
		return nil, hErr(err)
	}
	ws, err := a.s.GetWorkspaceShared(ctx, wsID)
	if err != nil {
		return nil, hErr(err)
	}
	if a.pipe == nil {
		return nil, hErr(errAIUnavailable)
	}
	llm, err := a.extractionLLM(ctx, actor)
	if err != nil {
		return nil, hErr(err)
	}
	charge, err := a.beginProviderSession(ctx, actor, wsID, store.SurfaceGenerate, llm.Rates, store.TokenRates{}, llm.Thinking)
	if err != nil {
		return nil, hErr(err)
	}
	body := map[string]any{
		"workspaceId": wsID, "paper": paper, "answerFiles": answers, "spendSessionId": charge.id,
		"locale": a.userLocale(ctx, actor),
	}
	llm.attach(body)
	// The run goes on after this request returns.
	runCtx := context.WithoutCancel(ctx)
	stream, err := a.pipe.PostStream(runCtx, "/extract", body)
	if err != nil {
		charge.release(ctx)
		if mapped := pipelineExtractionError(err); mapped != nil {
			return nil, mapped
		}
		if mapped := pipelineLLMError(err); mapped != nil {
			return nil, hErr(mapped)
		}
		return nil, hErr(&aiServiceError{cause: err})
	}
	// The run leaves its files' visibility alone (Epo 2026-11-04): a file
	// picked from the workspace keeps its setting, and one uploaded in the
	// Make a quiz dialog was uploaded hidden (CreateSourceUploadReq.Hidden),
	// so a mark scheme never reaches the students. The quiz starts hidden.
	run, err := a.s.CreateExtraction(runCtx, wsID, actor, title)
	if err != nil {
		stream.Close()
		charge.release(ctx)
		return nil, hErr(err)
	}
	go a.relayExtraction(runCtx, stream, charge, run, actor, ws.Name)
	return &extractionOutput{Body: run}, nil
}

func (a *api) getExtraction(ctx context.Context, in *getExtractionInput) (*extractionOutput, error) {
	run, err := a.s.GetExtraction(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &extractionOutput{Body: run}, nil
}

// pipelineExtractionError maps the retrieval service's refusal of a request it
// cannot read (a page past the file's end, a file with no page view) to a 400
// carrying its code and message.
func pipelineExtractionError(err error) error {
	var pe *pipeline.Error
	if !errors.As(err, &pe) || pe.Status != http.StatusBadRequest {
		return nil
	}
	body := pe.Decode()
	if body.Code == "" || body.Message == "" {
		return nil
	}
	return &huma.ErrorModel{
		Status: http.StatusBadRequest,
		Title:  http.StatusText(http.StatusBadRequest),
		Detail: body.Message,
		Errors: []*huma.ErrorDetail{{Message: body.Code}},
	}
}

// extractionEvent is one event of the retrieval service's /extract stream.
// A done event's Figures are the JPEG crops its questions' image blocks name
// (`figure:<id>`).
type extractionEvent struct {
	Type      string          `json:"type"`
	Questions json.RawMessage `json:"questions"`
	Figures   []agentFigure   `json:"figures"`
	Report    json.RawMessage `json:"report"`
	Code      string          `json:"code"`
	Message   string          `json:"message"`
}

// relayExtraction follows a run to its end: it keeps the recorded questions
// after each page window, then saves the quiz, or fails the run. Credits were
// charged per model call, so the session closes as settled either way.
func (a *api) relayExtraction(ctx context.Context, stream io.ReadCloser, charge *spend, run store.Extraction, actor, wsName string) {
	defer stream.Close()
	defer charge.settle(ctx)
	ended := a.followExtraction(ctx, stream, run, actor, wsName)
	if ended.Status == store.ExtractionRunning {
		ended, _ = a.s.FailExtraction(ctx, run.ID, "extraction_failed",
			"Reading the questions stopped before it finished.", nil)
	}
	a.publishNotificationEvent(ctx, actor, notificationEvent{
		Type: "extraction", ExtractionID: run.ID, Status: ended.Status,
	})
}

func (a *api) followExtraction(ctx context.Context, stream io.Reader, run store.Extraction, actor, wsName string) store.Extraction {
	reader := bufio.NewReader(stream)
	for {
		line, err := reader.ReadString('\n')
		if payload, ok := strings.CutPrefix(strings.TrimRight(line, "\r\n"), "data:"); ok && strings.TrimSpace(payload) != "" {
			var ev extractionEvent
			if json.Unmarshal([]byte(payload), &ev) != nil {
				continue
			}
			switch ev.Type {
			case "questions":
				if err := a.s.SaveExtractionQuestions(ctx, run.ID, ev.Questions); err != nil {
					obs.CaptureErr(ctx, err, map[string]string{"stage": "extraction_save"})
				}
			case "done":
				return a.finishExtraction(ctx, run, actor, wsName, ev)
			case "error":
				ended, failErr := a.s.FailExtraction(ctx, run.ID, ev.Code, ev.Message, ev.Report)
				if failErr != nil {
					obs.CaptureErr(ctx, failErr, map[string]string{"stage": "extraction_fail"})
				}
				return ended
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				obs.CaptureErr(ctx, err, map[string]string{"stage": "extraction_stream"})
			}
			return store.Extraction{Status: store.ExtractionRunning}
		}
	}
}

// finishExtraction saves the run's questions as a new quiz in the workspace,
// its figures as the quiz's own editor assets, charged to the starter like
// images it uploads (M16). The title was free when the run started; a quiz
// made since under it moves this one to "Title 2".
func (a *api) finishExtraction(ctx context.Context, run store.Extraction, actor, wsName string, ev extractionEvent) store.Extraction {
	fail := func(code, message string) store.Extraction {
		ended, err := a.s.FailExtraction(ctx, run.ID, code, message, ev.Report)
		if err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"stage": "extraction_fail"})
		}
		return ended
	}
	failed := func(stage string, err error) store.Extraction {
		if errors.Is(err, store.ErrStorageQuotaExceeded) {
			return fail("storage_full", "The quiz does not fit in your storage.")
		}
		obs.CaptureErr(ctx, err, map[string]string{"stage": stage})
		return fail("extraction_failed", "The quiz could not be saved.")
	}
	if qs := strings.TrimSpace(string(ev.Questions)); qs == "" || qs == "[]" || qs == "null" {
		return fail("extraction_empty", "No questions could be read from the selected pages.")
	}
	title, err := a.s.DisambiguateMaterialTitle(ctx, run.WorkspaceID, run.Title)
	if err != nil {
		return fail("extraction_failed", "The quiz could not be saved.")
	}
	figures := newAgentFigures(run.ID, "extraction", ev.Figures)
	questions, err := figures.resolveQuestions(ev.Questions)
	if err != nil {
		return failed("extraction_figures", err)
	}
	var assets []store.AgentAsset
	if len(figures.used) > 0 {
		imageMaxBytes, err := a.s.ImageMaxBytes(ctx, actor)
		if err != nil {
			return failed("extraction_figures", err)
		}
		if assets, err = a.putAgentFigures(ctx, figures, imageMaxBytes); err != nil {
			return failed("extraction_figures", err)
		}
	}
	// The quiz starts hidden from members (Epo 2026-11-03).
	draft := store.MaterialDraft{
		ActorUserID: actor, WorkspaceID: run.WorkspaceID, WorkspaceName: wsName,
		Kind: store.MaterialQuiz, Title: title, Questions: questions, Assets: assets, Hidden: true,
	}
	mt, err := a.s.CreateMaterialDraft(ctx, draft)
	if err != nil {
		a.deleteAgentAssets(ctx, assets)
	}
	if errors.Is(err, store.ErrStorageQuotaExceeded) && len(assets) > 0 {
		// The quiz is saved without its figures when they do not fit, and
		// the report names their questions (Epo 2026-11-04).
		bare, ok := withoutFigures(ev.Questions)
		if !ok {
			return fail("extraction_failed", "The quiz could not be saved.")
		}
		draft.Questions, draft.Assets, assets = bare, nil, nil
		ev.Report = figuresLeftOut(ev.Report)
		mt, err = a.s.CreateMaterialDraft(ctx, draft)
	}
	if errors.Is(err, materialdoc.ErrInvalid) {
		return fail("quiz_invalid", err.Error())
	}
	if err != nil {
		return failed("extraction_quiz", err)
	}
	if len(assets) > 0 {
		ids := make([]string, len(assets))
		for i, asset := range assets {
			ids[i] = asset.ID
		}
		a.thumbnailFigures(ctx, figures, ids)
	}
	ended, err := a.s.FinishExtraction(ctx, run.ID, mt.ID, ev.Report)
	if err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"stage": "extraction_finish"})
	}
	return ended
}

// withoutFigures is a run's questions with their cropped figures (image blocks
// of assetId `figure:<id>`) taken out; false when a part would be left empty.
func withoutFigures(raw json.RawMessage) (json.RawMessage, bool) {
	var list []map[string]any
	if json.Unmarshal(raw, &list) != nil {
		return nil, false
	}
	for _, question := range list {
		kept := map[string]string{}
		for _, id := range questions.AssetIDs(question) {
			if !strings.HasPrefix(id, materialdoc.FigureRefPrefix) {
				kept[id] = id
			}
		}
		if !questions.RewriteAssetIDs(question, kept) {
			return nil, false
		}
	}
	out, err := json.Marshal(list)
	return out, err == nil
}

// figuresLeftOut moves the report's questions with figures into
// figuresLeftOut, after any whose figures were already left out.
func figuresLeftOut(raw json.RawMessage) json.RawMessage {
	var report map[string]any
	if json.Unmarshal(raw, &report) != nil {
		return raw
	}
	left, _ := report["figuresLeftOut"].([]any)
	with, _ := report["figures"].([]any)
	report["figuresLeftOut"], report["figures"] = append(left, with...), []any{}
	out, err := json.Marshal(report)
	if err != nil {
		return raw
	}
	return out
}

// internalCheckQuestion validates one extracted question the way a quiz's
// creation does, for the retrieval service's page windows: 200 with the
// refusal in "problem", or with none.
func (a *api) internalCheckQuestion(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Question json.RawMessage `json:"question"`
	}
	if err := decodeBoundedJSON(w, r, &req, internalQuestionMaxBytes); err != nil || len(req.Question) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid question check"})
		return
	}
	problem := ""
	if _, err := materialdoc.QuizDocument(json.RawMessage("["+string(req.Question)+"]"), nil); err != nil {
		problem = err.Error()
	}
	writeJSON(w, http.StatusOK, map[string]string{"problem": problem})
}

// internalQuestionMaxBytes bounds one question: its blocks, parts and figures
// are bounded by the validator, so this only stops an oversized body early.
const internalQuestionMaxBytes = 4 << 20
