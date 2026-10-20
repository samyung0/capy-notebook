package httpapi

import (
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// The chat agent's Office tools (Epo 2026-10-15, 2026-10-20):
// inspect_office_document reads through the internal inspect route with an
// office query, edit_office_document edits through the internal edit route
// with office set, and its create command makes a new file here. Go turns the
// model's snake_case commands into the engine's (office-service Command).

// officeOnlyMessage answers edit_office_document on anything but an Office
// file.
const officeOnlyMessage = "edit_office_document edits Word, Excel and PowerPoint files; edit this one with edit_document."

// officeCommand is one edit_office_document command as the model writes it.
type officeCommand struct {
	Type string `json:"type"`
	// XLSX
	Sheet               string          `json:"sheet"`
	Range               string          `json:"range"`
	Expected            json.RawMessage `json:"expected"`
	Values              json.RawMessage `json:"values"`
	Bold                *bool           `json:"bold"`
	Italic              *bool           `json:"italic"`
	Strikethrough       *bool           `json:"strikethrough"`
	FontFamily          string          `json:"font_family"`
	FontSize            *float64        `json:"font_size"`
	TextColor           string          `json:"text_color"`
	FillColor           string          `json:"fill_color"`
	HorizontalAlignment string          `json:"horizontal_alignment"`
	VerticalAlignment   string          `json:"vertical_alignment"`
	Wrap                *bool           `json:"wrap"`
	NumberFormat        string          `json:"number_format"`
	Name                string          `json:"name"`
	After               string          `json:"after"`
	ExpectedName        string          `json:"expected_name"`
	At                  json.RawMessage `json:"at"`
	Count               int             `json:"count"`
	// DOCX, PPTX
	TargetID     string `json:"target_id"`
	ExpectedText string `json:"expected_text"`
	Text         string `json:"text"`
}

// namedNumberFormats are format_cells' preset number formats and the engine's
// NumberFormatMutation tags (xlsx-ops formatting.rs); any other text is a
// custom pattern.
var namedNumberFormats = map[string]string{
	"automatic": "automatic", "plain_text": "plainText", "number": "number", "percent": "percent",
	"scientific": "scientific", "currency": "currency", "date": "date", "time": "time",
}

var xlsxCommands = []string{
	"set_range", "format_cells", "add_sheet", "rename_sheet", "insert_rows", "delete_rows",
	"insert_columns", "delete_columns", "delete_sheet",
}

// normalizeOfficeCommands turns edit_office_document's commands into the
// engine's: the type stays snake_case, the fields become camelCase, and
// format_cells' flat style fields become its style object. Every field name
// the engine reads is here, so a rename on its side is a one-line change.
func normalizeOfficeCommands(format string, raw []json.RawMessage) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, 0, len(raw))
	for _, item := range raw {
		var c officeCommand
		if err := json.Unmarshal(item, &c); err != nil {
			return nil, refusal(agenttools.ErrInvalidInput, "invalid command: %v", err)
		}
		xlsx := slices.Contains(xlsxCommands, c.Type)
		switch {
		case c.Type == "create":
			return nil, refusal(agenttools.ErrInvalidInput, "create must be the call's first command, without file_id")
		case xlsx && format != "xlsx":
			return nil, refusal(agenttools.ErrUnsupportedOperation, "%s applies to XLSX files, not %s", c.Type, strings.ToUpper(format))
		case c.Type == "replace_text" && format == "xlsx":
			return nil, refusal(agenttools.ErrUnsupportedOperation, "replace_text applies to DOCX and PPTX files; write cells with set_range")
		case !xlsx && c.Type != "replace_text":
			return nil, refusal(agenttools.ErrUnsupportedOperation, "unsupported command %q", c.Type)
		}
		var normalized map[string]any
		switch c.Type {
		case "set_range":
			normalized = map[string]any{"sheet": c.Sheet, "range": c.Range, "expected": c.Expected, "values": c.Values}
		case "format_cells":
			style := map[string]any{}
			for key, set := range map[string]*bool{"bold": c.Bold, "italic": c.Italic, "strikethrough": c.Strikethrough} {
				if set != nil {
					style[key] = *set
				}
			}
			if c.FontSize != nil {
				style["fontSize"] = *c.FontSize
			}
			for key, value := range map[string]string{
				"fontFamily": c.FontFamily, "textColor": c.TextColor, "fillColor": c.FillColor,
				"horizontalAlignment": c.HorizontalAlignment, "verticalAlignment": c.VerticalAlignment,
			} {
				if value != "" {
					style[key] = value
				}
			}
			if c.Wrap != nil {
				style["textWrapping"] = map[bool]string{true: "wrap", false: "overflow"}[*c.Wrap]
			}
			if name, ok := namedNumberFormats[c.NumberFormat]; ok {
				style["numberFormat"] = map[string]any{"type": name}
			} else if c.NumberFormat != "" {
				style["numberFormat"] = map[string]any{"type": "custom", "pattern": c.NumberFormat}
			}
			if len(style) == 0 {
				return nil, refusal(agenttools.ErrInvalidInput, "format_cells needs at least one format to set")
			}
			normalized = map[string]any{"sheet": c.Sheet, "range": c.Range, "style": style}
		case "add_sheet":
			normalized = map[string]any{"name": c.Name}
			if c.After != "" {
				normalized["after"] = c.After
			}
		case "rename_sheet":
			normalized = map[string]any{"sheet": c.Sheet, "expectedName": c.ExpectedName, "name": c.Name}
		case "insert_rows", "insert_columns":
			normalized = map[string]any{"sheet": c.Sheet, "at": c.At, "count": c.Count}
		case "delete_rows", "delete_columns":
			normalized = map[string]any{"sheet": c.Sheet, "at": c.At, "count": c.Count, "expected": c.Expected}
		case "delete_sheet":
			normalized = map[string]any{"sheet": c.Sheet, "expectedName": c.ExpectedName}
		case "replace_text":
			if c.TargetID == "" {
				return nil, refusal(agenttools.ErrInvalidInput, "replace_text on %s needs target_id", strings.ToUpper(format))
			}
			normalized = map[string]any{"targetId": c.TargetID, "expectedText": c.ExpectedText, "text": c.Text}
		}
		normalized["type"] = c.Type
		encoded, err := json.Marshal(normalized)
		if err != nil {
			return nil, err
		}
		out = append(out, encoded)
	}
	return out, nil
}

type internalOfficeCreateReq struct {
	WorkspaceID        string `json:"workspaceId"`
	UserID             string `json:"userId"`
	AssistantMessageID string `json:"assistantMessageId"`
	ToolCallID         string `json:"toolCallId"`
	Format             string `json:"format"`
	Title              string `json:"title"`
	ChapterID          string `json:"chapterId"`
	// Commands are the call's commands after its create, applied to the new
	// file before it is stored.
	Commands []json.RawMessage `json:"commands"`
}

// officeTitleUnsafe is what a file name may not hold: path separators and
// control characters.
var officeTitleUnsafe = regexp.MustCompile(`[\\/\x00-\x1f]+`)

// internalCreateOfficeDocument is edit_office_document's create: the
// collaboration server's engine builds the file from its starter with the
// call's other commands applied, and it is stored as the agent's deck is, an
// upload with a receipt whose Undo trashes it (Epo 2026-10-20).
func (a *api) internalCreateOfficeDocument(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	var req internalOfficeCreateReq
	if err := decode(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": err.Error()})
		return
	}
	if req.AssistantMessageID == "" || req.ToolCallID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code": "invalid_input", "message": "assistantMessageId and toolCallId are required",
		})
		return
	}
	if req.Format != "xlsx" && req.Format != "docx" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code": "invalid_input", "message": "create makes an xlsx or docx file; a deck is made with create_deck",
		})
		return
	}
	title := strings.Join(strings.Fields(officeTitleUnsafe.ReplaceAllString(req.Title, " ")), " ")
	if title == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "create needs a title"})
		return
	}
	name := fieldlimits.ClampFileName(title + "." + req.Format)
	op, ok := a.agentFileOperation(w, r, req.UserID, req.WorkspaceID, req.AssistantMessageID, req.ToolCallID, map[string]any{
		"format": req.Format, "title": req.Title, "chapterId": req.ChapterID, "commands": req.Commands,
	})
	if !ok {
		return
	}
	commands, err := normalizeOfficeCommands(req.Format, req.Commands)
	if err != nil {
		a.failDocument(w, err)
		return
	}
	created, err := a.s.CreateOfficeDocument(r.Context(), req.UserID, req.Format, commands)
	if err != nil {
		a.failDocument(w, err)
		return
	}
	receipt, ok := a.storeAgentFile(w, r.Context(), agentFile{
		name: name, chapterID: req.ChapterID, content: created.Content, op: op,
	})
	if ok {
		writeJSON(w, http.StatusOK, store.DocumentEdit{AgentOperation: receipt, Notice: created.Notice})
	}
}
