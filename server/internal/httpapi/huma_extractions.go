package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/samyung0/capy-notebook/server/internal/imagecheck"
	"io"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
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
// selected pages of a paper into questions, a map call with any answer files, then
// copy batches, then solve batches; this gateway starts the run, keeps how far it has got and
// saves the quiz at the end.
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

type confirmExtractionInput struct {
	ID   string `path:"id"`
	Body apimodel.ConfirmExtractionReq
}

// extractionBodyDeadline gives a request of 40 drawn pages time to arrive on a
// slow connection: Huma's default is 5 s.
func extractionBodyDeadline(op *huma.Operation) {
	op.BodyReadTimeout = 60 * time.Second
}

func (a *api) registerExtractions(api huma.API) {
	regWithMaxBody(api, http.MethodPost, "/api/workspaces/{id}/extractions", "createExtraction", "Generate",
		"Start reading the questions on selected pages into a new quiz", http.StatusAccepted, extractionMaxBody, a.createExtraction, extractionBodyDeadline)
	reg(api, http.MethodGet, "/api/extractions/{id}", "getExtraction", "Generate",
		"A Make a quiz run its starter began", http.StatusOK, a.getExtraction)
	reg(api, http.MethodPost, "/api/extractions/{id}/confirm", "confirmExtraction", "Generate",
		"Make the first questions of a run waiting on its starter", http.StatusOK, a.confirmExtraction)
	reg(api, http.MethodPost, "/api/extractions/{id}/cancel", "cancelExtraction", "Generate",
		"End a run waiting on its starter", http.StatusOK, a.cancelExtraction)
}

// checkExtractionRequest holds a run to its caps (Epo 2026-11-05): at most
// ExtractionPaperFiles question files, ExtractionAnswerFiles answer files and
// ExtractionPages picked pages across them; each file once, each page once and counted
// from 1.
func checkExtractionRequest(req apimodel.CreateExtractionReq) error {
	if len(req.Paper) > fieldlimits.ExtractionPaperFiles {
		return fmt.Errorf("a run reads at most %d question files; this one has %d", fieldlimits.ExtractionPaperFiles, len(req.Paper))
	}
	if len(req.Answers) > fieldlimits.ExtractionAnswerFiles {
		return fmt.Errorf("a run reads at most %d answer files; this one has %d", fieldlimits.ExtractionAnswerFiles, len(req.Answers))
	}
	seen := map[string]bool{}
	pages := 0
	for _, file := range slices.Concat(req.Paper, req.Answers) {
		if seen[file.FileID] {
			return fmt.Errorf("file %q is listed twice", file.FileID)
		}
		seen[file.FileID] = true
		picked := map[int]bool{}
		for _, page := range file.Pages {
			if page < 1 {
				return fmt.Errorf("file %q: pages are counted from 1", file.FileID)
			}
			if picked[page] {
				return fmt.Errorf("file %q: page %d is selected twice", file.FileID, page)
			}
			picked[page] = true
		}
		pages += len(file.Pages)
	}
	if pages > fieldlimits.ExtractionPages {
		return fmt.Errorf("a run reads at most %d selected pages; %d are selected", fieldlimits.ExtractionPages, pages)
	}
	return nil
}

// extractionLLM is the run's model: the extraction slot's default pin, a vision
// model on OpenRouter (never direct DeepSeek, Epo 2026-11-03), with reasoning
// at mid for the map and solve calls and low for the copy calls (Epo 2026-11-05).
// The run's starter pays.
func (a *api) extractionLLM(ctx context.Context, userID string) (resolvedLLM, error) {
	var out resolvedLLM
	if a.modelReg == nil {
		return out, fmt.Errorf("%w: registry not configured", store.ErrModelUnavailable)
	}
	cfg, err := a.modelReg.Default(ctx, models.SlotExtraction)
	if err != nil {
		return out, fmt.Errorf("%w: %v", store.ErrModelUnavailable, err)
	}
	if !slices.Contains(cfg.ThinkingLevels, models.ThinkingMid) || !slices.Contains(cfg.ThinkingLevels, models.ThinkingLow) {
		return out, fmt.Errorf("%w: %s lacks low or mid thinking", store.ErrModelUnavailable, cfg.Ref())
	}
	out.Cfg, out.Rates, out.UserID, out.Thinking = cfg, store.RatesFromConfig(cfg), userID, models.ThinkingMid
	return out, nil
}

// A browser-drawn page: at most this many bytes of JPEG, and a request's body holds
// a run's worth of them in base64.
const (
	extractionImageBytes = 1 << 20
	extractionMaxBody    = fieldlimits.ExtractionPages*extractionImageBytes*4/3 + 1<<20
)

// extractionFile is a file as the retrieval service reads it.
type extractionFile struct {
	FileID string   `json:"fileId"`
	Name   string   `json:"name"`
	Pages  []int    `json:"pages,omitempty"`
	Images []string `json:"images,omitempty"`
}

// checkDrawnPages holds a Word or PowerPoint file's browser-drawn pages: one JPEG a
// picked page.
func checkDrawnPages(f store.File, p apimodel.ExtractionFile) error {
	if len(p.Pages) == 0 || len(p.Images) != len(p.Pages) {
		return huma.Error400BadRequest(fmt.Sprintf("%s: each selected page needs its drawn image.", f.Name))
	}
	for i, image := range p.Images {
		data, err := base64.StdEncoding.DecodeString(image)
		// The pixels too: a flat page small in bytes can be huge once decoded.
		if err != nil || len(data) > extractionImageBytes || imagecheck.Format(data) != "jpeg" ||
			imagecheck.CheckSourceImage(bytes.NewReader(data)) != nil {
			return huma.Error400BadRequest(fmt.Sprintf("%s: page %d's drawn image is not a JPEG of at most 1 MB and 5 megapixels.", f.Name, p.Pages[i]))
		}
	}
	return nil
}

// checkPickedPages holds a file to what its kind picks: a PDF any of its pages, an
// image its one, a Word or PowerPoint file its drawn pages, and anything else nothing,
// since it goes whole.
func checkPickedPages(f store.File, p apimodel.ExtractionFile) error {
	switch format := store.SourceEditFormat(f.Name, string(f.Kind)); {
	case format == "docx" || format == "pptx":
		return checkDrawnPages(f, p)
	case len(p.Images) > 0:
		return huma.Error400BadRequest(fmt.Sprintf("%s: only a Word or PowerPoint file sends drawn pages.", f.Name))
	case f.Kind == store.FilePDF:
		if len(p.Pages) == 0 {
			return huma.Error400BadRequest(fmt.Sprintf("%s: pick at least one page.", f.Name))
		}
	case f.Kind == store.FileImage:
		if !slices.Equal(p.Pages, []int{1}) {
			return huma.Error400BadRequest(fmt.Sprintf("%s is an image: its one page is page 1.", f.Name))
		}
	case len(p.Pages) > 0:
		return huma.Error400BadRequest(fmt.Sprintf("%s is read whole: it has no pages to pick.", f.Name))
	}
	return nil
}

// extractionFiles checks each file is the workspace's, untrashed and of a kind a run
// reads: not Excel, which is neither a paper nor an answer file, and not audio. A paper
// file must be indexed. An answer file that failed to read doesn't refuse the run (Epo
// 2026-11-05, Q613): it is left out, named in unread, and the confirm dialog says so.
func (a *api) extractionFiles(ctx context.Context, wsID string, req apimodel.CreateExtractionReq) (paper, answers []extractionFile, unread []string, err error) {
	paper, answers = []extractionFile{}, []extractionFile{}
	read := func(id string) (store.File, error) {
		f, err := a.s.GetFile(ctx, id)
		if errors.Is(err, store.ErrNotFound) || (err == nil && f.WorkspaceID != wsID) {
			return f, huma.Error400BadRequest(fmt.Sprintf("No workspace file has the id %q: it may have been deleted or moved to trash.", id))
		}
		if err != nil {
			return f, err
		}
		ext := strings.ToLower(filepath.Ext(f.Name))
		if f.Kind == store.FileAudio || f.Kind == store.FileUnknown || ext == ".xlsx" || ext == ".xls" {
			return f, huma.Error400BadRequest(fmt.Sprintf("%s: questions and answers can't be read from this kind of file.", f.Name))
		}
		return f, nil
	}
	notYet := func(f store.File) error {
		return huma.Error400BadRequest(fmt.Sprintf("%s has no indexed text yet: wait until it has been read, or process it.", f.Name))
	}
	for _, p := range req.Paper {
		f, err := read(p.FileID)
		if err != nil {
			return nil, nil, nil, err
		}
		if !f.Indexed {
			return nil, nil, nil, notYet(f)
		}
		if err := checkPickedPages(f, p); err != nil {
			return nil, nil, nil, err
		}
		paper = append(paper, extractionFile{FileID: f.ID, Name: f.Name, Pages: p.Pages, Images: p.Images})
	}
	for _, p := range req.Answers {
		f, err := read(p.FileID)
		if err != nil {
			return nil, nil, nil, err
		}
		if !f.Indexed {
			if fileStillReading(f) {
				return nil, nil, nil, notYet(f)
			}
			unread = append(unread, f.Name)
			continue
		}
		if err := checkPickedPages(f, p); err != nil {
			return nil, nil, nil, err
		}
		answers = append(answers, extractionFile{FileID: f.ID, Name: f.Name, Pages: p.Pages, Images: p.Images})
	}
	return paper, answers, unread, nil
}

// fileStillReading is a file on its way in, which holds a run until it ends.
func fileStillReading(f store.File) bool {
	return f.Status == store.FilePending || f.Status == store.FileProcessing
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
	paper, answers, unread, err := a.extractionFiles(ctx, wsID, in.Body)
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
	// The retrieval service reads this run's row for the starter's answer.
	runID := uuid.NewString()
	body := map[string]any{
		"workspaceId": wsID, "runId": runID, "paper": paper, "answerFiles": answers, "spendSessionId": charge.id,
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
	names := make([]string, len(paper))
	paperPages := 0
	for i, file := range paper {
		names[i] = file.Name
		paperPages += len(file.Pages)
	}
	paperNames := strings.Join(names, ", ")
	// The run leaves its files' visibility alone (Epo 2026-11-04): a file
	// picked from the workspace keeps its setting, and one uploaded in the
	// Make a quiz dialog was uploaded hidden (CreateSourceUploadReq.Hidden),
	// so a mark scheme never reaches the students. The quiz starts hidden.
	run, err := a.s.CreateExtraction(runCtx, store.ExtractionStart{
		ID: runID, WorkspaceID: wsID, UserID: actor, Title: title, SpendSessionID: charge.id, UnreadAnswers: unread,
		PaperName: paperNames, PaperPages: paperPages, AnswerFiles: len(answers),
	})
	if err != nil {
		stream.Close()
		charge.release(ctx)
		return nil, hErr(err)
	}
	go a.relayExtraction(runCtx, stream, charge, run, actor, ws.Name)
	return &extractionOutput{Body: run}, nil
}

// confirmExtraction sets a run waiting on its starter going with its first questions.
func (a *api) confirmExtraction(ctx context.Context, in *confirmExtractionInput) (*extractionOutput, error) {
	run, err := a.s.ConfirmExtraction(ctx, userID(ctx), in.ID, in.Body.Questions)
	if err != nil {
		return nil, hErr(err)
	}
	return &extractionOutput{Body: run}, nil
}

// cancelExtraction ends a run waiting on its starter; the retrieval service sees it on
// its next look and stops.
func (a *api) cancelExtraction(ctx context.Context, in *getExtractionInput) (*extractionOutput, error) {
	run, err := a.s.CancelExtraction(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
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
	Copied    int             `json:"copied"`
	Answered  int             `json:"answered"`
}

// relayExtraction follows a run to its end: it keeps how far it has got, pauses on
// the starter after the map, then saves the quiz, or
// fails the run. The map's credits were charged as it ended and the questions' are
// charged here, so the session closes as settled either way.
func (a *api) relayExtraction(ctx context.Context, stream io.ReadCloser, charge *spend, run store.Extraction, actor, wsName string) {
	defer stream.Close()
	defer charge.settle(ctx)
	ended := a.followExtraction(ctx, stream, run, actor, wsName)
	if ended.Status == store.ExtractionRunning {
		var err error
		ended, err = a.s.FailExtraction(ctx, run.ID, "extraction_failed",
			"Reading the questions stopped before it finished.", nil)
		// Its starter cancelled it, and nobody is waiting to hear.
		if errors.Is(err, store.ErrNotFound) {
			return
		}
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
			case "map":
				if err := a.s.AwaitExtractionConfirm(ctx, run.ID, ev.Questions); err != nil {
					obs.CaptureErr(ctx, err, map[string]string{"stage": "extraction_map"})
				}
				a.publishNotificationEvent(ctx, actor, notificationEvent{
					Type: "extraction", ExtractionID: run.ID, Status: store.ExtractionConfirming,
				})
			case "progress":
				if err := a.s.SaveExtractionProgress(ctx, run.ID, ev.Copied, ev.Answered); err != nil {
					obs.CaptureErr(ctx, err, map[string]string{"stage": "extraction_progress"})
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
	// A question with a part that has no answer goes to the quiz's room once the
	// quiz exists; only a room holds one (Epo 2026-11-05).
	complete, incomplete, err := materialdoc.SplitIncomplete(questions)
	if err != nil {
		return fail("quiz_invalid", err.Error())
	}
	// The quiz starts hidden from members (Epo 2026-11-03).
	draft := store.MaterialDraft{
		ActorUserID: actor, WorkspaceID: run.WorkspaceID, WorkspaceName: wsName,
		Kind: store.MaterialQuiz, Title: title, Questions: complete, Assets: assets, Hidden: true,
		AllowNoQuestions: len(incomplete) > 0,
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
		if draft.Questions, incomplete, err = materialdoc.SplitIncomplete(bare); err != nil {
			return fail("quiz_invalid", err.Error())
		}
		draft.Assets, assets = nil, nil
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
	var saved []json.RawMessage
	if err := json.Unmarshal(ev.Questions, &saved); err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"stage": "extraction_charge"})
	}
	savedCount := len(saved)
	if err := a.addIncompleteQuestions(ctx, run.ID, actor, mt.ID, incomplete); err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"stage": "extraction_incomplete"})
		ev.Report = answersMissingLeftOut(ev.Report)
		savedCount -= len(incomplete)
	}
	ended, err := a.s.FinishExtraction(ctx, run.ID, mt.ID, ev.Report)
	if err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"stage": "extraction_finish"})
		return ended
	}
	// The quiz is saved either way: a failed charge under-charges, like a failed settle.
	if err := a.s.ChargeExtractionQuestions(ctx, ended, actor, savedCount); err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"stage": "extraction_charge"})
	}
	return ended
}

// addIncompleteQuestions puts a run's incomplete questions in the new quiz's room,
// each after the question printed before it, through the same edit an agent's
// question command makes. Only complete questions reach materials.content, so
// grading and shared pages stay on what they read.
func (a *api) addIncompleteQuestions(ctx context.Context, runID, actor, materialID string, incomplete []materialdoc.IncompleteQuestion) error {
	if len(incomplete) == 0 {
		return nil
	}
	commands := make([]json.RawMessage, len(incomplete))
	sum := sha256.New()
	for i, question := range incomplete {
		var after any
		if question.After != "" {
			after = question.After
		}
		command, err := json.Marshal(map[string]any{
			"type": "insert_child", "parentType": "quiz", "afterNodeId": after, "node": question.Node,
		})
		if err != nil {
			return err
		}
		commands[i] = command
		sum.Write(command)
	}
	// Uncancelled: the quiz is saved, and closing the stream should not lose these.
	_, err := a.s.EditDocument(context.WithoutCancel(ctx), actor,
		store.DocumentTarget{Kind: agenttools.KindMaterial, ID: materialID}, commands, nil,
		store.DocumentOperation{
			ID: store.ChatOperationID(runID, "incomplete-questions"), RequestHash: hex.EncodeToString(sum.Sum(nil)), ToolVersion: 1,
		})
	return err
}

// answersMissingLeftOut is the report of a run whose incomplete questions the
// room did not take: they are named as questions with no copy.
func answersMissingLeftOut(raw json.RawMessage) json.RawMessage {
	var report map[string]any
	if json.Unmarshal(raw, &report) != nil {
		return raw
	}
	missing, _ := report["missing"].([]any)
	parts, _ := report["answersMissing"].([]any)
	seen := map[string]bool{}
	for _, part := range parts {
		name, _ := part.(string)
		label, _, _ := strings.Cut(name, "(")
		if label != "" && !seen[label] {
			seen[label] = true
			missing = append(missing, label)
		}
	}
	report["missing"], report["answersMissing"] = missing, []any{}
	out, err := json.Marshal(report)
	if err != nil {
		return raw
	}
	return out
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
// creation does, for the retrieval service's copy and solve calls: 200 with the
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
