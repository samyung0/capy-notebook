package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
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
	Kind        string `json:"kind"`
	Query       string `json:"query"`
}

type documentListItem struct {
	Kind         agenttools.ResourceKind `json:"kind"`
	ID           string                  `json:"id"`
	Title        string                  `json:"title"`
	Format       string                  `json:"format"`
	MaterialKind string                  `json:"materialKind,omitempty"`
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
	query := strings.ToLower(strings.TrimSpace(req.Query))
	items := []documentListItem{}
	if req.Kind == "" || req.Kind == string(agenttools.KindSourceFile) {
		files, err := a.s.ListFiles(ctx, "", req.WorkspaceID)
		if err != nil {
			a.fail(w, err)
			return
		}
		for _, f := range files {
			if query != "" && !strings.Contains(strings.ToLower(f.Name), query) {
				continue
			}
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
	}
	if req.Kind == "" || req.Kind == string(agenttools.KindMaterial) {
		refs, err := a.s.ListMaterialRefs(ctx, req.WorkspaceID)
		if err != nil {
			a.fail(w, err)
			return
		}
		for _, m := range refs {
			if query != "" && !strings.Contains(strings.ToLower(m.Title), query) {
				continue
			}
			items = append(items, documentListItem{
				Kind: agenttools.KindMaterial, ID: m.ID, Title: m.Title, Format: "plate",
				MaterialKind: string(m.Type), Editable: true,
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

type internalDocumentsInspectReq struct {
	WorkspaceID string                 `json:"workspaceId"`
	UserID      string                 `json:"userId"`
	Target      agenttools.ResourceRef `json:"target"`
	Start       int                    `json:"start"`
	Count       int                    `json:"count"`
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
	if req.Count <= 0 || req.Count > 200 {
		req.Count = 60
	}
	if req.Start < 0 {
		req.Start = 0
	}
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
		inspection, err := a.s.InspectSourceDocument(ctx, req.UserID, req.Target.ID)
		if err != nil {
			a.failDocument(w, err)
			return
		}
		body := map[string]any{
			"format": inspection.Format, "title": file.Name,
			"incarnation": inspection.Epoch, "access": inspection.Access,
		}
		if inspection.Format == "text" {
			lines := textLines(deref(inspection.Text))
			total := len(lines)
			end := min(req.Start+req.Count, total)
			body["lines"] = lines[min(req.Start, total):end]
			body["total"], body["nextStart"] = total, nextStart(end, total)
			body["supportedOperations"] = []string{"replace_text"}
		} else {
			total := len(inspection.Entries)
			end := min(req.Start+req.Count, total)
			body["entries"] = inspection.Entries[min(req.Start, total):end]
			body["total"], body["nextStart"] = total, nextStart(end, total)
			if inspection.Format == "xlsx" {
				body["supportedOperations"] = []string{"set_cell"}
			} else {
				body["supportedOperations"] = []string{"replace_text"}
			}
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
		return []string{"replace_question", "add_question", "remove_question"}
	case "flashcards":
		return []string{"replace_card", "add_card", "remove_card"}
	case "mindmap", "diagram":
		return []string{"set_mermaid"}
	default:
		return []string{"replace_text", "insert_block", "remove_block"}
	}
}

// failDocument maps authority refusals to the typed tool error shape.
func (a *api) failDocument(w http.ResponseWriter, err error) {
	var refusal *store.EditRefusal
	if errors.As(err, &refusal) {
		writeJSON(w, http.StatusConflict, map[string]string{"code": string(refusal.Code), "message": refusal.Message})
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
}

func (a *api) internalEditDocument(w http.ResponseWriter, r *http.Request) {
	var req internalDocumentsEditReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
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
	hash, err := store.RequestHash(map[string]any{"target": req.Target, "commands": req.Commands})
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
	switch req.Target.Kind {
	case agenttools.KindMaterial:
		mt, err := a.s.GetMaterial(ctx, req.Target.ID)
		if err != nil {
			a.fail(w, err)
			return
		}
		normalized, err = normalizeMaterialCommands(string(mt.Kind), req.Commands)
		if err != nil {
			a.failDocument(w, err)
			return
		}
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
		normalized, err = normalizeSourceCommands(format, req.Commands)
		if err != nil {
			a.failDocument(w, err)
			return
		}
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "unsupported target kind"})
		return
	}
	receipt, err := a.s.EditDocument(ctx, req.UserID, store.DocumentTarget{Kind: req.Target.Kind, ID: req.Target.ID}, normalized, store.DocumentOperation{
		ID: opID, RequestHash: hash, ToolVersion: 1, ConversationID: convID, MessageID: req.AssistantMessageID, CallID: req.ToolCallID,
	})
	if err != nil {
		a.failDocument(w, err)
		return
	}
	writeJSON(w, http.StatusOK, receipt)
}

type rawCommand struct {
	Type            string          `json:"type"`
	TargetID        string          `json:"target_id"`
	ExpectedText    string          `json:"expected_text"`
	Text            string          `json:"text"`
	AfterBlockID    *string         `json:"after_block_id"`
	BlockID         string          `json:"block_id"`
	Sheet           string          `json:"sheet"`
	Cell            string          `json:"cell"`
	ExpectedValue   string          `json:"expected_value"`
	Value           string          `json:"value"`
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

// normalizeMaterialCommands turns model-facing study commands into node-level
// authority commands, building Plate nodes with the same validated builders
// the material routes use. Text and block commands pass through.
func normalizeMaterialCommands(kind string, raw []json.RawMessage) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, 0, len(raw))
	for _, item := range raw {
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
		case "insert_block":
			if kind != "note" {
				return nil, refusal(agenttools.ErrUnsupportedOperation, "use the %s commands for this material", kind)
			}
			blocks := []any{}
			for _, line := range strings.Split(strings.ReplaceAll(c.Text, "\r\n", "\n"), "\n") {
				if strings.TrimSpace(line) == "" {
					continue
				}
				blocks = append(blocks, materialdoc.ParagraphNode(line))
			}
			if len(blocks) == 0 {
				return nil, refusal(agenttools.ErrInvalidInput, "insert_block needs text")
			}
			normalized = map[string]any{"type": "insert_block", "afterBlockId": c.AfterBlockID, "blocks": blocks}
		case "remove_block":
			if kind != "note" {
				return nil, refusal(agenttools.ErrUnsupportedOperation, "use the %s commands for this material", kind)
			}
			normalized = map[string]any{"type": "remove_block", "blockId": c.BlockID, "expectedText": c.ExpectedText}
		case "replace_card", "add_card", "remove_card":
			if kind != "flashcards" {
				return nil, refusal(agenttools.ErrUnsupportedOperation, "%s only applies to flashcard sets", c.Type)
			}
			switch c.Type {
			case "replace_card":
				if c.Front == nil || c.Back == nil {
					return nil, refusal(agenttools.ErrInvalidInput, "replace_card needs front and back")
				}
				normalized = map[string]any{"type": "replace_child", "parentType": "flashcards", "nodeId": c.CardID,
					"node": materialdoc.CardNode(materialdoc.Card{ID: c.CardID, Front: *c.Front, Back: *c.Back})}
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
		case "set_cell":
			return nil, refusal(agenttools.ErrUnsupportedOperation, "set_cell only applies to spreadsheets")
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

// normalizeSourceCommands accepts replace_text for text, DOCX and PPTX and
// set_cell for XLSX; everything else is an explicit unsupported operation.
func normalizeSourceCommands(format string, raw []json.RawMessage) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, 0, len(raw))
	for _, item := range raw {
		var c rawCommand
		if err := json.Unmarshal(item, &c); err != nil {
			return nil, refusal(agenttools.ErrInvalidInput, "invalid command: %v", err)
		}
		var normalized any
		switch {
		case c.Type == "replace_text" && format != "xlsx":
			if format != "text" && c.TargetID == "" {
				return nil, refusal(agenttools.ErrInvalidInput, "replace_text on %s needs target_id", strings.ToUpper(format))
			}
			normalized = map[string]any{"type": "replace_text", "targetId": c.TargetID, "expectedText": c.ExpectedText, "text": c.Text}
		case c.Type == "set_cell" && format == "xlsx":
			normalized = map[string]any{"type": "set_cell", "sheet": c.Sheet, "cell": strings.ToUpper(strings.TrimSpace(c.Cell)),
				"expectedValue": c.ExpectedValue, "value": c.Value}
		case c.Type == "replace_text" || c.Type == "set_cell":
			return nil, refusal(agenttools.ErrUnsupportedOperation, "%s does not apply to %s sources", c.Type, strings.ToUpper(format))
		default:
			return nil, refusal(agenttools.ErrUnsupportedOperation, "%s only applies to study materials", c.Type)
		}
		encoded, err := json.Marshal(normalized)
		if err != nil {
			return nil, err
		}
		out = append(out, encoded)
	}
	return out, nil
}
