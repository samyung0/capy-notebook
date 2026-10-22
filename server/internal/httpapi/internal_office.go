package httpapi

import (
	"context"
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
	// DOCX, PPTX
	AfterID   string          `json:"after_id"`
	BeforeID  string          `json:"before_id"`
	Style     string          `json:"style"`
	List      string          `json:"list"`
	IDs       []string        `json:"ids"`
	ID        string          `json:"id"`
	Rows      json.RawMessage `json:"rows"`
	Underline *bool           `json:"underline"`
	Color     string          `json:"color"`
	Highlight string          `json:"highlight"`
	Alignment string          `json:"alignment"`
	// PPTX
	ShapeID     string          `json:"shape_id"`
	Paragraphs  json.RawMessage `json:"paragraphs"`
	SlideID     string          `json:"slide_id"`
	AfterSlide  string          `json:"after_slide"`
	BeforeSlide string          `json:"before_slide"`
	Layout      string          `json:"layout"`
	X           *float64        `json:"x"`
	Y           *float64        `json:"y"`
	W           *float64        `json:"w"`
	H           *float64        `json:"h"`
}

// namedNumberFormats are format_cells' preset number formats, matched in any
// case, and the engine's NumberFormatMutation tags (xlsx-ops formatting.rs);
// Excel's "General" is automatic, and any other text is a custom pattern.
var namedNumberFormats = map[string]string{
	"automatic": "automatic", "general": "automatic", "plain_text": "plainText", "number": "number",
	"percent": "percent", "scientific": "scientific", "currency": "currency", "date": "date", "time": "time",
}

var xlsxCommands = []string{
	"set_range", "format_cells", "add_sheet", "rename_sheet", "insert_rows", "delete_rows",
	"insert_columns", "delete_columns", "delete_sheet",
}

// paragraphCommands are the DOCX and PPTX commands.
var paragraphCommands = []string{"replace_text", "insert_paragraph", "delete_paragraph", "format_text", "set_alignment"}

// docxCommands are the commands only DOCX files take.
var docxCommands = []string{"set_list", "insert_table", "delete_table"}

// pptxCommands are the commands only PPTX files take.
var pptxCommands = []string{"set_shape_text", "add_slide", "delete_slide", "move_slide", "add_text_box"}

// NormalizeOfficeCommands turns edit_office_document's commands into the
// engine's: the type stays snake_case, the fields become camelCase, and
// format_cells' flat style fields become its style object. Every field name
// the engine reads is here, so a rename on its side is a one-line change. The
// lab playground runs it through cmd/officecommands.
func NormalizeOfficeCommands(format string, raw []json.RawMessage) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, 0, len(raw))
	for _, item := range raw {
		var c officeCommand
		if err := json.Unmarshal(item, &c); err != nil {
			return nil, refusal(agenttools.ErrInvalidInput, "invalid command: %v", err)
		}
		xlsx, docx := slices.Contains(xlsxCommands, c.Type), slices.Contains(docxCommands, c.Type)
		paragraphs, pptx := slices.Contains(paragraphCommands, c.Type), slices.Contains(pptxCommands, c.Type)
		switch {
		case c.Type == "create":
			return nil, refusal(agenttools.ErrInvalidInput, "create must be the call's first command, without file_id")
		case xlsx && format != "xlsx":
			return nil, refusal(agenttools.ErrUnsupportedOperation, "%s applies to XLSX files, not %s", c.Type, strings.ToUpper(format))
		case docx && format != "docx":
			return nil, refusal(agenttools.ErrUnsupportedOperation, "%s applies to DOCX files, not %s", c.Type, strings.ToUpper(format))
		case pptx && format != "pptx":
			return nil, refusal(agenttools.ErrUnsupportedOperation, "%s applies to PPTX files, not %s", c.Type, strings.ToUpper(format))
		case paragraphs && format == "xlsx":
			return nil, refusal(agenttools.ErrUnsupportedOperation, "%s applies to DOCX and PPTX files; write cells with set_range", c.Type)
		case !xlsx && !paragraphs && !docx && !pptx:
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
			if name, ok := namedNumberFormats[strings.ToLower(c.NumberFormat)]; ok {
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
			// The band's inputs as a grid of rows (Epo 2026-10-20, review
			// finding 6); [] expects an empty band.
			var band [][]string
			if err := json.Unmarshal(c.Expected, &band); err != nil || band == nil {
				return nil, refusal(agenttools.ErrInvalidInput, "%s needs expected: the band's current inputs as a grid of rows, [] when it is empty", c.Type)
			}
			normalized = map[string]any{"sheet": c.Sheet, "at": c.At, "count": c.Count, "expected": band}
		case "delete_sheet":
			normalized = map[string]any{"sheet": c.Sheet, "expectedName": c.ExpectedName}
		case "replace_text":
			if c.TargetID == "" {
				return nil, refusal(agenttools.ErrInvalidInput, "replace_text on %s needs target_id", strings.ToUpper(format))
			}
			normalized = map[string]any{"targetId": c.TargetID, "expectedText": c.ExpectedText, "text": c.Text}
		case "insert_paragraph":
			normalized = map[string]any{"text": c.Text}
			for key, value := range map[string]string{"afterId": c.AfterID, "beforeId": c.BeforeID, "style": c.Style, "list": c.List} {
				if value != "" {
					normalized[key] = value
				}
			}
		case "delete_paragraph":
			normalized = map[string]any{"targetId": c.TargetID, "expectedText": c.ExpectedText}
		case "set_list":
			normalized = map[string]any{"ids": c.IDs, "list": c.List}
		case "insert_table":
			var rows [][]string
			if err := json.Unmarshal(c.Rows, &rows); err != nil || rows == nil {
				return nil, refusal(agenttools.ErrInvalidInput, "insert_table needs rows: the cells' text as a grid of rows")
			}
			normalized = map[string]any{"rows": rows}
			if c.AfterID != "" {
				normalized["afterId"] = c.AfterID
			}
		case "delete_table":
			var cells [][]string
			if err := json.Unmarshal(c.Expected, &cells); err != nil || cells == nil {
				return nil, refusal(agenttools.ErrInvalidInput, "delete_table needs expected: the table's cells' text as a grid of rows")
			}
			normalized = map[string]any{"id": c.ID, "expected": cells}
		case "format_text":
			normalized = map[string]any{"targetId": c.TargetID, "expectedText": c.ExpectedText}
			for key, set := range map[string]*bool{"bold": c.Bold, "italic": c.Italic, "underline": c.Underline, "strikethrough": c.Strikethrough} {
				if set != nil {
					normalized[key] = *set
				}
			}
			if c.FontSize != nil {
				normalized["fontSize"] = *c.FontSize
			}
			for key, value := range map[string]string{"color": c.Color, "highlight": c.Highlight, "fontFamily": c.FontFamily} {
				if value != "" {
					normalized[key] = value
				}
			}
		case "set_alignment":
			normalized = map[string]any{"targetId": c.TargetID, "alignment": c.Alignment}
		case "set_shape_text":
			var texts []string
			if err := json.Unmarshal(c.Paragraphs, &texts); err != nil || texts == nil {
				return nil, refusal(agenttools.ErrInvalidInput, "set_shape_text needs paragraphs: the shape's new text, one string a paragraph")
			}
			normalized = map[string]any{"shapeId": c.ShapeID, "expectedText": c.ExpectedText, "paragraphs": texts}
		case "add_slide", "move_slide":
			// add_slide names a layout, move_slide its slide.
			fields := map[string]string{"afterSlide": c.AfterSlide, "beforeSlide": c.BeforeSlide, "layout": c.Layout}
			if c.Type == "move_slide" {
				fields = map[string]string{"afterSlide": c.AfterSlide, "beforeSlide": c.BeforeSlide, "slideId": c.SlideID}
			}
			normalized = map[string]any{}
			for key, value := range fields {
				if value != "" {
					normalized[key] = value
				}
			}
		case "delete_slide":
			normalized = map[string]any{"slideId": c.SlideID, "expectedText": c.ExpectedText}
		case "add_text_box":
			var texts []string
			if err := json.Unmarshal(c.Paragraphs, &texts); err != nil || texts == nil {
				return nil, refusal(agenttools.ErrInvalidInput, "add_text_box needs paragraphs: the box's text, one string a paragraph")
			}
			if c.X == nil || c.Y == nil || c.W == nil || c.H == nil {
				return nil, refusal(agenttools.ErrInvalidInput, "add_text_box needs x, y, w and h in points")
			}
			normalized = map[string]any{"slideId": c.SlideID, "paragraphs": texts, "x": *c.X, "y": *c.Y, "w": *c.W, "h": *c.H}
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
	// A retry waits for a running attempt and replays its receipt, as an edit's
	// does (operationLocks).
	unlock, err := a.operations.lock(r.Context(), store.ChatOperationID(req.AssistantMessageID, req.ToolCallID))
	if err != nil {
		a.fail(w, err)
		return
	}
	defer unlock()
	op, ok := a.agentFileOperation(w, r, req.UserID, req.WorkspaceID, req.AssistantMessageID, req.ToolCallID, map[string]any{
		"format": req.Format, "title": req.Title, "chapterId": req.ChapterID, "commands": req.Commands,
	})
	if !ok {
		return
	}
	chapterID, ok := a.agentChapter(w, r.Context(), req.ChapterID, req.WorkspaceID)
	if !ok {
		return
	}
	commands, err := NormalizeOfficeCommands(req.Format, req.Commands)
	if err != nil {
		a.failDocument(w, err)
		return
	}
	// Uncancelled from here: an attempt the retrieval service gave up on still
	// builds and stores the file, so its retry replays the receipt.
	ctx := context.WithoutCancel(r.Context())
	created, err := a.s.CreateOfficeDocument(ctx, req.UserID, req.Format, commands)
	if err != nil {
		a.failDocument(w, err)
		return
	}
	receipt, ok := a.storeAgentFile(w, ctx, agentFile{
		name: name, chapterID: chapterID, content: created.Content, op: op,
	})
	if ok {
		writeJSON(w, http.StatusOK, store.DocumentEdit{AgentOperation: receipt, Notice: created.Notice})
	}
}
