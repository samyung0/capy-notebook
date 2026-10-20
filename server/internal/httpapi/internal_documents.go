package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"net/http"
	"slices"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Chat document tools: discovery, inspection and direct edits of Plate
// materials and editable sources. Go validates the trusted context, the
// resource, the actor's operation and the command shapes, then the
// collaboration authority applies the edit against the durable pre-state and
// returns the receipt. PDFs are refused before any content is read.

type internalDocumentsListReq struct {
	WorkspaceID string `json:"workspaceId"`
	UserID      string `json:"userId"`
}

type documentListItem struct {
	Kind         agenttools.ResourceKind `json:"kind"`
	ID           string                  `json:"id"`
	Title        string                  `json:"title"`
	Format       string                  `json:"format"`
	MaterialKind string                  `json:"materialKind"`
	ChapterID    *string                 `json:"chapterId,omitempty"`
	Editable     bool                    `json:"editable"`
	Reason       string                  `json:"reason,omitempty"`
}

const pdfRefusal = "Cannot edit PDF files."

func (a *api) internalDocumentsActor(w http.ResponseWriter, r *http.Request, userID, workspaceID string, edit bool) bool {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return false
	}
	if workspaceID == "" || userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "workspaceId and userId are required"})
		return false
	}
	status, err := a.s.AccountAccess(r.Context(), userID)
	if err != nil {
		a.fail(w, err)
		return false
	}
	if !status.CanAuthenticate() {
		a.fail(w, status.Err())
		return false
	}
	if edit {
		err = a.s.AssertWorkspaceEditor(r.Context(), userID, workspaceID)
	} else {
		_, err = a.s.WorkspaceEffectiveRole(r.Context(), userID, workspaceID)
	}
	if err != nil {
		a.fail(w, store.ErrNotFound)
		return false
	}
	return true
}

func (a *api) internalListDocuments(w http.ResponseWriter, r *http.Request) {
	var req internalDocumentsListReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if !a.internalDocumentsActor(w, r, req.UserID, req.WorkspaceID, false) {
		return
	}
	ctx := r.Context()
	items := []documentListItem{}
	files, err := a.s.ListFiles(ctx, "", req.WorkspaceID)
	if err != nil {
		a.fail(w, err)
		return
	}
	for _, f := range files {
		item := documentListItem{Kind: agenttools.KindSourceFile, ID: f.ID, Title: f.Name, Format: string(f.Kind)}
		if format := store.SourceEditFormat(f.Name, string(f.Kind)); format != "" {
			item.Format, item.Editable = format, true
		} else if f.Kind == "pdf" {
			item.Reason = pdfRefusal
		} else {
			item.Reason = "This file type cannot be edited."
		}
		items = append(items, item)
	}
	refs, err := a.s.ListMaterialRefs(ctx, req.WorkspaceID)
	if err != nil {
		a.fail(w, err)
		return
	}
	for _, m := range refs {
		items = append(items, documentListItem{
			Kind: agenttools.KindMaterial, ID: m.ID, Title: m.Title, Format: "plate",
			MaterialKind: string(m.Type), ChapterID: m.ChapterID, Editable: true,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// learnerInspectedQuestions replaces each inspected quiz question, whose text
// is the question JSON, with its answer-free questions.LearnerView.
func learnerInspectedQuestions(children []json.RawMessage) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, len(children))
	for i, raw := range children {
		var child struct {
			ID   string `json:"id"`
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal(raw, &child); err != nil {
			return nil, err
		}
		out[i] = raw
		if child.Type != "quiz_question" {
			continue
		}
		var q map[string]any
		if err := json.Unmarshal([]byte(child.Text), &q); err != nil {
			return nil, err
		}
		text, err := json.Marshal(questions.LearnerView(q))
		if err != nil {
			return nil, err
		}
		child.Text = string(text)
		if out[i], err = json.Marshal(child); err != nil {
			return nil, err
		}
	}
	return out, nil
}

type internalDocumentsInspectReq struct {
	WorkspaceID string                 `json:"workspaceId"`
	UserID      string                 `json:"userId"`
	Target      agenttools.ResourceRef `json:"target"`
	Start       int                    `json:"start"`
	Count       int                    `json:"count"`
	// Office is inspect_office_document's read of an Office file; without it
	// an Office file is refused (inspect_document's call).
	Office *officeInspectQuery `json:"office"`
}

// officeInspectQuery is inspect_office_document's arguments: an XLSX sheet
// and range, a DOCX or PPTX page, a PPTX slide.
type officeInspectQuery struct {
	Sheet string `json:"sheet"`
	Range string `json:"range"`
	Start int    `json:"start"`
	Count int    `json:"count"`
	Slide int    `json:"slide"`
}

// officeToolsMessage answers an Office file sent to the general document
// tools (Epo 2026-10-20).
const officeToolsMessage = `Office files are read and edited with inspect_office_document and edit_office_document, offered after read_skill("office_building").`

// pageCount is an inspection page's size: 60 targets unless 1 to 200 are asked.
func pageCount(count int) int {
	if count <= 0 || count > 200 {
		return 60
	}
	return count
}

func (a *api) internalInspectDocument(w http.ResponseWriter, r *http.Request) {
	var req internalDocumentsInspectReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if !a.internalDocumentsActor(w, r, req.UserID, req.WorkspaceID, false) {
		return
	}
	req.Start, req.Count = max(req.Start, 0), pageCount(req.Count)
	ctx := r.Context()
	wsID, err := a.s.ResourceWorkspaceID(ctx, req.Target.Kind, req.Target.ID, true)
	if err != nil || wsID != req.WorkspaceID {
		a.fail(w, store.ErrNotFound)
		return
	}
	switch req.Target.Kind {
	case agenttools.KindMaterial:
		mt, err := a.s.GetMaterial(ctx, req.Target.ID)
		if err != nil {
			a.fail(w, err)
			return
		}
		inspection, err := a.s.InspectMaterialDocument(ctx, req.UserID, req.Target.ID)
		if err != nil {
			a.failDocument(w, err)
			return
		}
		total := len(inspection.Blocks)
		end := min(req.Start+req.Count, total)
		blocks := inspection.Blocks[min(req.Start, total):end]
		// The agent reads a quiz's keys only for a user who may edit it.
		if mt.Kind == "quiz" {
			err := a.s.AssertMaterialEditor(ctx, req.UserID, req.Target.ID)
			if err != nil && !errors.Is(err, store.ErrForbidden) {
				a.fail(w, err)
				return
			}
			if err != nil {
				for i := range blocks {
					if blocks[i].Children, err = learnerInspectedQuestions(blocks[i].Children); err != nil {
						a.fail(w, err)
						return
					}
				}
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"format": "plate", "materialKind": mt.Kind, "title": mt.Title,
			"incarnation":         inspection.RoomSchema,
			"supportedOperations": materialOperations(string(mt.Kind)),
			"blocks":              blocks, "total": total, "nextStart": nextStart(end, total),
		})
	case agenttools.KindSourceFile:
		file, err := a.s.GetFile(ctx, req.Target.ID)
		if err != nil {
			a.fail(w, err)
			return
		}
		format := store.SourceEditFormat(file.Name, string(file.Kind))
		if format == "" {
			message := "This file type cannot be edited."
			if file.Kind == "pdf" {
				message = pdfRefusal
			}
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": "unsupported_format", "message": message})
			return
		}
		// Office files have their own tools (Epo 2026-10-20).
		if office := format != "text"; office != (req.Office != nil) {
			message := officeToolsMessage
			if !office {
				message = "inspect_office_document reads Word, Excel and PowerPoint files; read this file with inspect_document."
			}
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": "unsupported_operation", "message": message})
			return
		}
		var query *store.OfficeQuery
		switch {
		case format == "xlsx":
			query = &store.OfficeQuery{Sheet: req.Office.Sheet, Range: req.Office.Range}
		case format == "pptx" && req.Office.Slide > 0:
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
				"code": "unsupported_operation", "message": "Reading one slide is not available yet; read the deck's shapes with start and count.",
			})
			return
		case req.Office != nil:
			req.Start, req.Count = max(req.Office.Start, 0), pageCount(req.Office.Count)
		}
		inspection, err := a.s.InspectSourceDocument(ctx, req.UserID, req.Target.ID, query)
		if err != nil {
			a.failDocument(w, err)
			return
		}
		body := map[string]any{
			"format": inspection.Format, "title": file.Name,
			"incarnation": inspection.Epoch, "access": inspection.Access,
		}
		switch {
		case query != nil && len(inspection.Scoped) == 0:
			// A collaboration server without the engine's scoped reads.
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
				"code": "unsupported_operation", "message": "Reading a workbook is not available yet.",
			})
			return
		case query != nil:
			body["scoped"] = inspection.Scoped
		case inspection.Format == "text":
			lines := textLines(deref(inspection.Text))
			total := len(lines)
			end := min(req.Start+req.Count, total)
			body["lines"] = lines[min(req.Start, total):end]
			body["total"], body["nextStart"] = total, nextStart(end, total)
			body["supportedOperations"] = []string{"replace_text"}
		default:
			// DOCX and PPTX read as their paragraph and shape entries until
			// the engine's scoped reads land.
			total := len(inspection.Entries)
			end := min(req.Start+req.Count, total)
			body["entries"] = inspection.Entries[min(req.Start, total):end]
			body["total"], body["nextStart"] = total, nextStart(end, total)
			body["supportedOperations"] = []string{"replace_text"}
		}
		writeJSON(w, http.StatusOK, body)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "unsupported target kind"})
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func nextStart(end, total int) any {
	if end >= total {
		return nil
	}
	return end
}

type textLine struct {
	Start int    `json:"start"`
	Text  string `json:"text"`
}

// textLines splits a text source into lines with UTF-16 offsets, the unit
// the collaboration Y.Text indexes by.
func textLines(text string) []textLine {
	lines := []textLine{}
	offset := 0
	for _, line := range strings.SplitAfter(text, "\n") {
		if line == "" {
			continue
		}
		lines = append(lines, textLine{Start: offset, Text: strings.TrimRight(line, "\n")})
		offset += utf16Len(line)
	}
	return lines
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func materialOperations(kind string) []string {
	switch kind {
	case "quiz":
		// add_questions adds and replaces questions; the model's edit removes.
		return []string{"remove_question"}
	case "flashcards":
		return []string{"replace_card", "add_card", "remove_card"}
	case "mindmap", "diagram":
		return []string{"set_mermaid"}
	default:
		return []string{"replace_text", "replace_block", "insert_markdown", "remove_block"}
	}
}

// failDocument maps authority refusals to the typed tool error shape.
func (a *api) failDocument(w http.ResponseWriter, err error) {
	obs.ResponseError(w, err)
	var refusal *store.EditRefusal
	if errors.As(err, &refusal) {
		body := map[string]any{"code": refusal.Code, "message": refusal.Message}
		if len(refusal.Details) > 0 {
			body["details"] = refusal.Details
		}
		writeJSON(w, http.StatusConflict, body)
		return
	}
	if errors.Is(err, store.ErrAuthorityUnavailable) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "outcome_unknown", "message": "The document authority is unavailable."})
		return
	}
	a.fail(w, err)
}

type internalDocumentsEditReq struct {
	WorkspaceID        string                 `json:"workspaceId"`
	UserID             string                 `json:"userId"`
	AssistantMessageID string                 `json:"assistantMessageId"`
	ToolCallID         string                 `json:"toolCallId"`
	Target             agenttools.ResourceRef `json:"target"`
	Commands           []json.RawMessage      `json:"commands"`
	// Provenance is what this edit was written from, resolved by the retrieval
	// service from the excerpt ids the model named. It is appended to the
	// material's stored record; absent for a workspace edit.
	Provenance *store.Provenance `json:"provenance"`
	// The library figures the commands' markdown or questions place, rendered
	// by the retrieval service; each becomes an editor asset of the note or quiz.
	Figures []agentFigure `json:"figures"`
	// Office says the commands are edit_office_document's: only an Office
	// file takes them, and an Office file takes no others.
	Office bool `json:"office"`
}

func (a *api) internalEditDocument(w http.ResponseWriter, r *http.Request) {
	var req internalDocumentsEditReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if code, err := validateProvenance(req.Provenance); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": code, "message": err.Error()})
		return
	}
	a.editAgentDocument(w, r, req)
}

// editAgentDocument applies one chat edit: the internal edit route with a
// model's commands, or the bank copy route appending the bank's questions with
// their credits. Callers have checked the provenance origin.
func (a *api) editAgentDocument(w http.ResponseWriter, r *http.Request, req internalDocumentsEditReq) {
	if !a.internalDocumentsActor(w, r, req.UserID, req.WorkspaceID, true) {
		return
	}
	if req.AssistantMessageID == "" || req.ToolCallID == "" || len(req.Commands) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "assistantMessageId, toolCallId and commands are required"})
		return
	}
	ctx := r.Context()
	convUser, convWS, convID, err := a.s.AssistantMessageContext(ctx, req.AssistantMessageID)
	if err != nil || convUser != req.UserID || convWS != req.WorkspaceID {
		a.fail(w, store.ErrNotFound)
		return
	}
	opID := store.ChatOperationID(req.AssistantMessageID, req.ToolCallID)
	hash, err := store.RequestHash(hashFigures(map[string]any{
		"target": req.Target, "commands": req.Commands, "provenance": req.Provenance,
	}, req.Figures))
	if err != nil {
		a.fail(w, err)
		return
	}
	if existing, err := a.s.ReplayAgentOperation(ctx, opID, hash); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		a.fail(w, err)
		return
	}
	wsID, err := a.s.ResourceWorkspaceID(ctx, req.Target.Kind, req.Target.ID, true)
	if err != nil || wsID != req.WorkspaceID {
		a.fail(w, store.ErrNotFound)
		return
	}
	var normalized []json.RawMessage
	// Provenance accumulates over the edits of a curated material: the stored
	// record is merged with this edit's books before the authority writes it in
	// the same transaction as the content.
	var provenance *store.Provenance
	// The rows insert_markdown created for the note's knowledge checks. They are
	// discarded unless the edit commits or its outcome is unknown, so a refused
	// edit leaves no hidden rows behind.
	var embedded []string
	// The figure assets the edit added, discarded on the same terms.
	var assets []string
	// The top-level blocks the edit's markdown became, for the receipt.
	var blockIDs []string
	discard := true
	defer func() {
		if discard && len(embedded) > 0 {
			if err := a.s.DiscardEmbeddedDrafts(context.WithoutCancel(ctx), req.Target.ID, embedded); err != nil {
				obs.Log(ctx).Warn("refused edit left its embedded rows", "note_id", req.Target.ID, "error", err)
			}
		}
		if discard && len(assets) > 0 {
			if err := a.s.DiscardAgentAssets(context.WithoutCancel(ctx), req.Target.ID, assets); err != nil {
				obs.Log(ctx).Warn("refused edit left its figure assets", "note_id", req.Target.ID, "error", err)
			}
		}
	}()
	if len(req.Figures) > 0 && req.Target.Kind != agenttools.KindMaterial {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "only a note or a quiz shows figures"})
		return
	}
	if req.Office && req.Target.Kind != agenttools.KindSourceFile {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": "unsupported_operation", "message": officeOnlyMessage})
		return
	}
	switch req.Target.Kind {
	case agenttools.KindMaterial:
		mt, err := a.s.GetMaterial(ctx, req.Target.ID)
		if err != nil {
			a.fail(w, err)
			return
		}
		var drafts []store.EmbeddedDraft
		figures := newAgentFigures(req.AssistantMessageID, req.ToolCallID, req.Figures)
		commands := req.Commands
		if mt.Kind == "quiz" {
			if commands, err = figures.resolveQuizCommands(commands); err != nil {
				a.failDocument(w, err)
				return
			}
		}
		// A replace_card keeps the stored side it is not sent (Epo 2026-10-14).
		var cards []materialdoc.Card
		if mt.Kind == "flashcards" {
			if cards, err = materialdoc.ExtractFlashcards(mt.Content); err != nil {
				a.fail(w, err)
				return
			}
		}
		written, markdownCommands := 0, 0
		normalized, err = normalizeMaterialCommands(string(mt.Kind), commands, func(i int, markdown string) ([]any, error) {
			blocks, fences, err := a.noteBlocksFromMarkdown(ctx, req, i, markdown, figures)
			drafts = append(drafts, fences...)
			written += len(blocks)
			markdownCommands++
			for _, block := range blocks {
				if id, ok := block.(map[string]any)["id"].(string); ok {
					blockIDs = append(blockIDs, id)
				}
			}
			return blocks, err
		}, cards)
		if err != nil {
			a.failDocument(w, err)
			return
		}
		// A write cannot say which of its sources went into which quiz or
		// flashcards fence, so every fence's item records all of them (Epo
		// 2026-10-10: over-credit), and the note keeps them only when the write
		// put anything else in it.
		var fence *store.Provenance
		if req.Provenance != nil && len(drafts) > 0 {
			fence = req.Provenance
			for i := range drafts {
				drafts[i].Provenance = fence
			}
			if markdownCommands == len(req.Commands) && written == len(drafts) {
				req.Provenance = nil
			}
		}
		if req.Provenance != nil {
			var code string
			provenance, code, err = mergeProvenance(mt.Provenance, req.Provenance)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"code": code, "message": err.Error()})
				return
			}
		}
		if code, err := a.checkFooterLicence(ctx, mt, provenance, fence); err != nil {
			if code == "" {
				a.fail(w, err)
			} else {
				writeJSON(w, http.StatusBadRequest, map[string]string{"code": code, "message": err.Error()})
			}
			return
		}
		for _, draft := range drafts {
			if err := a.s.EnsureEmbeddedMaterial(ctx, req.UserID, req.Target.ID, draft); err != nil {
				if errors.Is(err, materialdoc.ErrInvalid) {
					err = refusal(agenttools.ErrInvalidInput, "%s", err.Error())
				}
				a.failDocument(w, err)
				return
			}
			embedded = append(embedded, draft.ID)
		}
		// Like the rows, the figures' assets exist before the blocks that
		// reference them are inserted.
		if len(figures.used) > 0 {
			if assets, err = a.ensureFigureAssets(ctx, req, figures); err != nil {
				a.failDocument(w, err)
				return
			}
		}
	case agenttools.KindSourceFile:
		if req.Provenance != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"code": "invalid_input", "message": "only study materials carry provenance",
			})
			return
		}
		file, err := a.s.GetFile(ctx, req.Target.ID)
		if err != nil {
			a.fail(w, err)
			return
		}
		format := store.SourceEditFormat(file.Name, string(file.Kind))
		if format == "" {
			message := "This file type cannot be edited."
			if file.Kind == "pdf" {
				message = pdfRefusal
			}
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": "unsupported_format", "message": message})
			return
		}
		// Office files have their own tool (Epo 2026-10-20).
		if office := format != "text"; office != req.Office {
			message := officeToolsMessage
			if !office {
				message = officeOnlyMessage
			}
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": "unsupported_operation", "message": message})
			return
		}
		if req.Office {
			normalized, err = NormalizeOfficeCommands(format, req.Commands)
		} else {
			normalized, err = normalizeTextCommands(req.Commands)
		}
		if err != nil {
			a.failDocument(w, err)
			return
		}
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "unsupported target kind"})
		return
	}
	receipt, err := a.s.EditDocument(ctx, req.UserID, store.DocumentTarget{Kind: req.Target.Kind, ID: req.Target.ID}, normalized, provenance, store.DocumentOperation{
		ID: opID, RequestHash: hash, ToolVersion: 1, ConversationID: convID, MessageID: req.AssistantMessageID, CallID: req.ToolCallID,
	})
	// Only the authority's refusal is final; a lost answer may have committed.
	var editRefusal *store.EditRefusal
	discard = errors.As(err, &editRefusal)
	if err != nil {
		a.failDocument(w, err)
		return
	}
	if receipt.Effect != nil {
		receipt.Effect.BlockIDs = blockIDs
	}
	writeJSON(w, http.StatusOK, receipt)
}

// checkFooterLicence refuses an agent or bank write that would put two
// copyleft families in a note's footer, which credits the note's own sources
// with its live embeds': a write to the note (merged, its record after the
// write, and fence, the record of the items the write embeds) or to one of
// its embeds (merged, that embed's record after the write). The code is empty
// for a failure other than the refusal.
func (a *api) checkFooterLicence(ctx context.Context, mt store.Material, merged, fence *store.Provenance) (string, error) {
	switch {
	case mt.Kind == "note" && (merged != nil || fence != nil):
		if merged != nil {
			mt.Provenance = merged
		}
		if fence == nil {
			return a.s.CheckFooterLicence(ctx, mt)
		}
		return a.s.CheckFooterLicence(ctx, mt, fence)
	case mt.ParentMaterialID != "" && merged != nil:
		note, err := a.s.GetMaterial(ctx, mt.ParentMaterialID)
		if err != nil {
			return "", err
		}
		return a.s.CheckFooterLicence(ctx, note, merged)
	}
	return "", nil
}

// noteBlocksFromMarkdown converts an insert_markdown command through the
// collaboration service. Its quiz and flashcards fences come back as drafts
// with ids derived from the tool call and command, so a retried edit finds
// their rows instead of creating them again; the caller creates the rows
// before the reference blocks are inserted, the order the editor uses.
func (a *api) noteBlocksFromMarkdown(ctx context.Context, req internalDocumentsEditReq, command int, markdown string, figures *agentFigures) ([]any, []store.EmbeddedDraft, error) {
	converted, err := a.s.ConvertAgentMarkdown(ctx, markdown)
	if err != nil {
		return nil, nil, err
	}
	ids := make([]string, len(converted.Embedded))
	for i := range ids {
		ids[i] = store.ChatMaterialID(req.AssistantMessageID, fmt.Sprintf("%s/%d/embedded/%d", req.ToolCallID, command, i))
	}
	content, err := materialdoc.ResolvePendingRefs(string(converted.Document), ids)
	if err != nil {
		return nil, nil, refusal(agenttools.ErrInvalidInput, "%s", strings.TrimPrefix(err.Error(), materialdoc.ErrInvalid.Error()+": "))
	}
	if content, err = figures.resolve(content); err != nil {
		return nil, nil, documentRefusal(err)
	}
	// An agent's blocks: figures strictly, as from outside a room.
	doc, err := materialdoc.ParseWrite(content)
	if err != nil {
		return nil, nil, documentRefusal(err)
	}
	blocks := make([]any, len(doc.Value))
	for i, node := range doc.Value {
		blocks[i] = node
	}
	if len(blocks) == 0 {
		return nil, nil, refusal(agenttools.ErrInvalidInput, "insert_markdown needs markdown")
	}
	return blocks, converted.EmbeddedDrafts(ids), nil
}

type rawCommand struct {
	Type            string          `json:"type"`
	TargetID        string          `json:"target_id"`
	ExpectedText    string          `json:"expected_text"`
	Text            string          `json:"text"`
	Markdown        string          `json:"markdown"`
	AfterBlockID    *string         `json:"after_block_id"`
	BlockID         string          `json:"block_id"`
	CardID          string          `json:"card_id"`
	Front           *string         `json:"front"`
	Back            *string         `json:"back"`
	AfterCardID     *string         `json:"after_card_id"`
	QuestionID      string          `json:"question_id"`
	Question        map[string]any  `json:"question"`
	AfterQuestionID *string         `json:"after_question_id"`
	ExpectedSource  string          `json:"expected_source"`
	Source          string          `json:"source"`
	raw             json.RawMessage `json:"-"`
}

func refusal(code agenttools.ErrorCode, format string, args ...any) error {
	return &store.EditRefusal{Code: code, Message: fmt.Sprintf(format, args...)}
}

// documentRefusal names why converted note blocks cannot be stored, as the
// create route does; a refusal already typed passes through.
func documentRefusal(err error) error {
	var typed *store.EditRefusal
	if errors.As(err, &typed) {
		return err
	}
	return refusal(agenttools.ErrInvalidInput, "invalid material document: %s", strings.TrimPrefix(err.Error(), materialdoc.ErrInvalid.Error()+": "))
}

// normalizeMaterialCommands turns model-facing study commands into node-level
// authority commands, building Plate nodes with the same validated builders
// the material routes use. Text and block commands pass through.
//
// insertMarkdown turns the markdown of the i-th command into the blocks to
// insert; it is nil where no note is being edited.
// normalizeMaterialCommands turns the model's commands into the authority's.
// stored are a flashcard set's cards as saved, for a replace_card that leaves
// a side out (the projection may lag a live edit by seconds).
func normalizeMaterialCommands(kind string, raw []json.RawMessage, insertMarkdown func(i int, markdown string) ([]any, error), stored []materialdoc.Card) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, 0, len(raw))
	for i, item := range raw {
		var c rawCommand
		if err := json.Unmarshal(item, &c); err != nil {
			return nil, refusal(agenttools.ErrInvalidInput, "invalid command: %v", err)
		}
		var normalized any
		switch c.Type {
		case "replace_text":
			if kind != "note" {
				return nil, refusal(agenttools.ErrUnsupportedOperation, "use the %s commands for this material", kind)
			}
			if c.TargetID == "" {
				return nil, refusal(agenttools.ErrInvalidInput, "replace_text on a material needs target_id")
			}
			normalized = map[string]any{"type": "replace_text", "blockId": c.TargetID, "expectedText": c.ExpectedText, "text": c.Text}
		case "insert_markdown", "replace_block":
			if kind != "note" {
				return nil, refusal(agenttools.ErrUnsupportedOperation, "use the %s commands for this material", kind)
			}
			if strings.TrimSpace(c.Markdown) == "" {
				return nil, refusal(agenttools.ErrInvalidInput, "%s needs markdown", c.Type)
			}
			if insertMarkdown == nil {
				return nil, refusal(agenttools.ErrUnsupportedOperation, "%s is not available here", c.Type)
			}
			blocks, err := insertMarkdown(i, c.Markdown)
			if err != nil {
				return nil, err
			}
			if c.Type == "replace_block" {
				normalized = map[string]any{"type": "replace_block", "blockId": c.BlockID, "expectedText": c.ExpectedText, "blocks": blocks}
			} else {
				normalized = map[string]any{"type": "insert_block", "afterBlockId": c.AfterBlockID, "blocks": blocks}
			}
		case "remove_block":
			if kind != "note" {
				return nil, refusal(agenttools.ErrUnsupportedOperation, "use the %s commands for this material", kind)
			}
			normalized = map[string]any{"type": "remove_block", "blockId": c.BlockID, "expectedText": c.ExpectedText}
		case "replace_card", "add_card", "remove_card":
			if kind != "flashcards" {
				return nil, refusal(agenttools.ErrUnsupportedOperation, "%s only applies to flashcard sets", c.Type)
			}
			var card materialdoc.Card
			if c.Type == "replace_card" {
				i := slices.IndexFunc(stored, func(s materialdoc.Card) bool { return s.ID == c.CardID })
				if i < 0 && (c.Front == nil || c.Back == nil) {
					return nil, refusal(agenttools.ErrUnavailableTarget, "replace_card: no card %s in this set; send front and back", c.CardID)
				}
				if i >= 0 {
					card = stored[i]
				}
				card.ID = c.CardID
				if c.Front != nil {
					card.Front = *c.Front
				}
				if c.Back != nil {
					card.Back = *c.Back
				}
				c.Front, c.Back = &card.Front, &card.Back
			}
			if err := materialdoc.ValidateCardText(deref(c.Front), deref(c.Back)); err != nil {
				return nil, refusal(agenttools.ErrInvalidInput, "%s: %v", c.Type, err)
			}
			switch c.Type {
			case "replace_card":
				// The stored card's image stays: replace_card writes text only.
				normalized = map[string]any{"type": "replace_child", "parentType": "flashcards", "nodeId": c.CardID,
					"node": materialdoc.CardNode(card)}
			case "add_card":
				normalized = map[string]any{"type": "insert_child", "parentType": "flashcards", "afterNodeId": c.AfterCardID,
					"node": materialdoc.CardNode(materialdoc.Card{Front: deref(c.Front), Back: deref(c.Back)})}
			default:
				normalized = map[string]any{"type": "remove_child", "parentType": "flashcards", "nodeId": c.CardID}
			}
		case "replace_question", "add_question", "remove_question":
			if kind != "quiz" {
				return nil, refusal(agenttools.ErrUnsupportedOperation, "%s only applies to quizzes", c.Type)
			}
			if c.Type != "add_question" && strings.TrimSpace(c.QuestionID) == "" {
				return nil, refusal(agenttools.ErrInvalidInput, "%s needs question_id", c.Type)
			}
			switch c.Type {
			case "remove_question":
				normalized = map[string]any{"type": "remove_child", "parentType": "quiz", "nodeId": c.QuestionID}
			default:
				question := c.Question
				if question == nil {
					return nil, refusal(agenttools.ErrInvalidInput, "%s needs a question", c.Type)
				}
				if c.Type == "replace_question" {
					question["id"] = c.QuestionID
				}
				node, err := materialdoc.QuizQuestionNode(question)
				if err != nil {
					return nil, refusal(agenttools.ErrInvalidInput, "invalid question: %v", err)
				}
				if c.Type == "replace_question" {
					normalized = map[string]any{"type": "replace_child", "parentType": "quiz", "nodeId": c.QuestionID, "node": node}
				} else {
					normalized = map[string]any{"type": "insert_child", "parentType": "quiz", "afterNodeId": c.AfterQuestionID, "node": node}
				}
			}
		case "set_mermaid":
			if kind != "mindmap" && kind != "diagram" {
				return nil, refusal(agenttools.ErrUnsupportedOperation, "set_mermaid only applies to mindmaps and diagrams")
			}
			normalized = map[string]any{"type": "set_property", "nodeType": "mermaid", "property": "source",
				"expectedValue": c.ExpectedSource, "value": c.Source}
		default:
			return nil, refusal(agenttools.ErrUnsupportedOperation, "unsupported command %q", c.Type)
		}
		encoded, err := json.Marshal(normalized)
		if err != nil {
			return nil, err
		}
		out = append(out, encoded)
	}
	return out, nil
}

// normalizeTextCommands accepts replace_text for a text source; everything
// else is an explicit unsupported operation.
func normalizeTextCommands(raw []json.RawMessage) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, 0, len(raw))
	for _, item := range raw {
		var c rawCommand
		if err := json.Unmarshal(item, &c); err != nil {
			return nil, refusal(agenttools.ErrInvalidInput, "invalid command: %v", err)
		}
		if c.Type != "replace_text" {
			return nil, refusal(agenttools.ErrUnsupportedOperation, "%s only applies to study materials", c.Type)
		}
		encoded, err := json.Marshal(map[string]any{"type": "replace_text", "targetId": c.TargetID, "expectedText": c.ExpectedText, "text": c.Text})
		if err != nil {
			return nil, err
		}
		out = append(out, encoded)
	}
	return out, nil
}
