// Package agenttools is the shared agent-tool contract: tool definitions the
// chat model may call, the resource operations a caller must hold to run them,
// and the result/effect shapes every tool returns.
//
// Go owns this contract. `cmd/openapi -agent-tools` exports it as JSON for the
// Python retrieval service (which validates model arguments against the input
// schemas) and the effect/error types flow into openapi.yaml through the chat
// message activity blocks, so the frontend consumes generated types. Nothing
// here talks to the database or HTTP; it is data plus a role → operations map.
package agenttools

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/embeds"
	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
)

// ContractVersion changes whenever a tool definition, input schema, operation
// name or result shape changes incompatibly. Python refuses to start on a
// version it does not know.
//
// v6: curate mode adds the library.read operation, the knowledge tools
// (including capture_knowledge_page), the conversation progress ledger
// (create_ledger plus a todo id on create_material and edit_document) and
// excerpt_ids on both writes.
// v7: the library taxonomy gains subjects over topics; browse_knowledge takes
// exactly one of subject (its topics with counts) or topic (its excerpts).
// v8: ledger upserts and material-backed library excerpt retention.
// v9: every question part has marks; only open parts have a markscheme of
// {text, marks} items adding up to them.
// v10: Library is a per-turn switch instead of a curate thread mode; the
// stream request carries library, openResource and studyProgress, and the
// curate-only tools and ledger rules apply to any build. Notes are markdown
// converted by the editor's own import: insert_markdown replaces insert_block.
// v11: list_question_bank (a subject's topics or a topic's questions, the
// exams and subjects listed in its description) replaces search_questions.
// v12: read_skill loads a skill's instructions on demand; the note and
// question formats move out of the write tools into Formats, which the
// materials skill quotes.
// v13: copy_questions copies bank questions by id into a new or existing
// quiz, each credited from the bank's own sources.
// v14: html-embed fences carry no fallback, only title and html.
// v15: create_deck and write_slide write a slide deck the ppt-master way; the
// exported PPTX is stored as a workspace file. list_question_bank filters a
// topic by answer_type instead of question_type.
// v16: search_knowledge filters by book and section; read_knowledge takes a
// count. Section reading for the intake comparison: browse_knowledge with book
// lists its outline and read_knowledge with book and section reads a section in
// order; the pipeline offers those two arguments only behind
// CAPY_LIBRARY_SECTION_TOOLS.
// v17: html-embed fences name their muted line `caption` instead of `title`,
// and the frame gives snippets the note's font and base style.
// v18: edit_document gains replace_block (a note block rewritten from
// markdown); inspect_document shows math as $tex$, and expected texts match
// that rendering.
// v19: the agent writes questions in three small shapes through
// add_questions, add_open_question and add_question_media, which the
// retrieval service expands into the question format; create_material makes
// no quizzes, edit_document loses add_question and replace_question, the
// question format leaves Formats, MediaBlocks carries the media schemas, and a
// note's quiz fence takes the small shapes.
// v21: card fronts and backs carry their stored caps (4,000 and 2,000
// characters) in create_material and edit_document's card commands.
// v22: the build ledger is gone (Epo 2026-10-13): no create_ledger and no todo
// on the write tools; excerpt_ids is optional, and a write naming none credits
// the excerpts read since the last write.
// v23: chart media and fences lose unit (it goes in the title); plot media and
// fences take kind line or scatter.
// v24: the embed catalog (server/internal/embeds) names each embed kind once
// per layer: chat's Diagram and Interactive are Mermaid and HtmlEmbed, and the
// html-embed rules the note format and chat quote come from the catalog.
// v25: add_open_question is gone (Epo 2026-10-14): add_questions items take
// an open question too (marks, markscheme, model_answer, hints?), the item's
// fields deciding its kind, so a note's quiz fence takes exactly its items.
// v26: the question-bank tools are gone (Epo 2026-10-14): no list_question_bank,
// read_question or copy_questions; the learner's bank keeps its own copy.
// v27: add_question_media takes a library figure, {"type": "figure", "id",
// "caption"?}, stored as the quiz's own image (Epo 2026-10-13).
// v28: search_knowledge takes a subject id instead of topics, book and
// section; browse_knowledge and section reading (read_knowledge's book and
// section) are gone (Epo 2026-10-14).
// v29: the skills are editing, note_building and deck_building; insert_markdown
// takes after_block_id "end"; create and edit receipts list the note blocks
// they wrote (effect.blockIds); replace_card keeps a side it is not sent; a
// multiple-choice question keeps its options in the order written (Epo
// 2026-10-14).
const ContractVersion = 29

// Slot names the product feature that may expose a tool loop. Only chat does.
type Slot string

const SlotChat Slot = "chat"

// Operation is a resource permission evaluated from the actor's effective role
// and rechecked by every Go mutation. These are not model capabilities.
type Operation string

const (
	OpSourceRead     Operation = "source.read"
	OpMaterialRead   Operation = "material.read"
	OpMaterialCreate Operation = "material.create"
	OpDocumentEdit   Operation = "document.edit"
	OpResourceTrash  Operation = "resource.trash"
	OpTrashRead      Operation = "trash.read"
	OpTrashRestore   Operation = "trash.restore"
	// OpLibraryRead is not derived from a role: the shared knowledge library is
	// not a workspace resource. The chat's Library switch grants it per turn.
	OpLibraryRead Operation = "library.read"
)

// AllOperations is the closed policy table, in stable order.
var AllOperations = []Operation{
	OpSourceRead, OpMaterialRead, OpMaterialCreate, OpDocumentEdit,
	OpResourceTrash, OpTrashRead, OpTrashRestore, OpLibraryRead,
}

// OperationsForRole maps a workspace effective role onto the operations the
// chat turn may offer. Viewers read; editors (member or share role) also
// create, edit and trash; only the owner reads or restores trash.
// library.read is deliberately absent: the Library switch adds it.
func OperationsForRole(role string) []Operation {
	switch role {
	case "owner":
		return []Operation{
			OpSourceRead, OpMaterialRead, OpMaterialCreate, OpDocumentEdit,
			OpResourceTrash, OpTrashRead, OpTrashRestore,
		}
	case "editor":
		return []Operation{OpSourceRead, OpMaterialRead, OpMaterialCreate, OpDocumentEdit, OpResourceTrash}
	case "viewer":
		return []Operation{OpSourceRead, OpMaterialRead}
	}
	return nil
}

// Definition is one model-callable tool. InputSchema is JSON Schema
// (draft 2020-12) and is the only part of the definition the model sees
// together with Name and Description.
type Definition struct {
	Name        string `json:"name"`
	Version     int    `json:"version"`
	Description string `json:"description"`
	// InputSchema is draft 2020-12 JSON Schema. Every object sets
	// additionalProperties:false so unknown model arguments are rejected.
	InputSchema        map[string]any `json:"inputSchema"`
	Mutates            bool           `json:"mutates"`
	UsesEmbedding      bool           `json:"usesEmbedding"`
	Concurrency        string         `json:"concurrency" enum:"search,read,mutate"`
	AllowedSlots       []Slot         `json:"allowedSlots"`
	RequiredOperations []Operation    `json:"requiredOperations"`
	// Retention applies after the answer completes; live tool results stay exact.
	Retention ResultRetention `json:"retention" enum:"full,cited_passages,used_excerpts,none"`
}

type ResultRetention string

const (
	RetainFull          ResultRetention = "full"
	RetainCitedPassages ResultRetention = "cited_passages"
	RetainNone          ResultRetention = "none"
	RetainUsedExcerpts  ResultRetention = "used_excerpts"
)

// ResourceKind tags a ResourceRef.
type ResourceKind string

const (
	KindSourceFile ResourceKind = "source_file"
	KindMaterial   ResourceKind = "material"
)

// ResourceRef identifies a source file or Plate material. Title and
// MaterialKind are server-populated for rendering; the model never chooses
// how a result is displayed.
type ResourceRef struct {
	Kind         ResourceKind `json:"kind" enum:"source_file,material"`
	ID           string       `json:"id"`
	Title        string       `json:"title,omitempty"`
	MaterialKind string       `json:"materialKind,omitempty"`
	WorkspaceID  string       `json:"workspaceId,omitempty"`
}

// Outcome is the terminal state of one tool call.
type Outcome string

const (
	OutcomeSucceeded Outcome = "succeeded"
	OutcomeRefused   Outcome = "refused"
	OutcomeFailed    Outcome = "failed"
	OutcomeCancelled Outcome = "cancelled"
	OutcomeUnknown   Outcome = "outcome_unknown"
)

// ErrorCode is the stable technical code on a refused or failed call. The
// frontend localizes; the code never changes wording.
type ErrorCode string

const (
	ErrUnsupportedFormat    ErrorCode = "unsupported_format"
	ErrUnsupportedOperation ErrorCode = "unsupported_operation"
	ErrInvalidInput         ErrorCode = "invalid_input"
	ErrUnavailableTarget    ErrorCode = "unavailable_target"
	ErrStaleTarget          ErrorCode = "stale_target"
	ErrQuotaRejected        ErrorCode = "quota_rejected"
	ErrLifecycleRejected    ErrorCode = "lifecycle_rejected"
	ErrOutcomeUnknown       ErrorCode = "outcome_unknown"
	ErrLimitReached         ErrorCode = "limit_reached"
	// ErrOfficeEditingPaused: the Office maintenance window pauses edits.
	ErrOfficeEditingPaused ErrorCode = "office_editing_paused"
)

// ToolError is the safe typed error carried on a result. Message is already
// user-safe; it never contains provider output or document content.
type ToolError struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
}

// UndoStatus is the advisory availability of an edit's Undo action.
type UndoStatus string

const (
	UndoAvailable   UndoStatus = "available"
	UndoUndone      UndoStatus = "undone"
	UndoUnavailable UndoStatus = "unavailable"
	UndoPending     UndoStatus = "pending"
)

// UndoRef points at the durable edit operation whose inverse the server holds.
// The inverse payload itself never leaves the server.
type UndoRef struct {
	OperationID string     `json:"operationId"`
	Status      UndoStatus `json:"status" enum:"available,undone,unavailable,pending"`
	Reason      string     `json:"reason,omitempty"`
}

// EffectOperation names what a mutation did to a resource.
type EffectOperation string

const (
	EffectCreated    EffectOperation = "created"
	EffectEdited     EffectOperation = "edited"
	EffectEditUndone EffectOperation = "edit_undone"
	EffectTrashed    EffectOperation = "trashed"
	EffectRestored   EffectOperation = "restored"
)

// ResourceEffect is one durable mutation receipt as shown in chat and stored
// on the assistant message. It carries identity and status only, never the
// document content or an inverse payload.
type ResourceEffect struct {
	Operation   EffectOperation `json:"operation" enum:"created,edited,edit_undone,trashed,restored"`
	Resource    ResourceRef     `json:"resource"`
	OperationID string          `json:"operationId,omitempty"`
	// ProjectionPending says the SQL read model still lags the committed edit.
	ProjectionPending bool       `json:"projectionPending,omitempty"`
	TrashEpisodeID    string     `json:"trashEpisodeId,omitempty"`
	PurgeAfter        *time.Time `json:"purgeAfter,omitempty"`
	Undo              *UndoRef   `json:"undo,omitempty"`
	// Relocated lists the edit's inserts whose anchor block was gone.
	Relocated []Relocation `json:"relocated,omitempty"`
	// BlockIDs are the top-level note blocks an agent create or edit wrote, in
	// order, so the next section can follow them; absent on a replayed receipt.
	BlockIDs []string `json:"blockIds,omitempty"`
}

// Relocation is an insert whose anchor block was gone and where it landed
// instead: after the nearest block before the anchor's place when the same
// edit removed the anchor, else at the end of the material (End). After is
// the block it follows; nil is the start.
type Relocation struct {
	Anchor string  `json:"anchor"`
	After  *string `json:"after"`
	End    bool    `json:"end"`
}

// Contract is the exported document Python loads at startup.
type Contract struct {
	Version          int               `json:"version"`
	Operations       []Operation       `json:"operations"`
	Outcomes         []Outcome         `json:"outcomes"`
	ErrorCodes       []ErrorCode       `json:"errorCodes"`
	EffectOperations []EffectOperation `json:"effectOperations"`
	Tools            []Definition      `json:"tools"`
	// Formats are the content formats the write tools validate, quoted by the
	// note_building skill rather than repeated in every tool description.
	Formats map[string]string `json:"formats"`
	// MediaBlocks are the JSON Schemas add_question_media checks its media
	// against; the model is not shown them.
	MediaBlocks map[string]any `json:"mediaBlocks"`
}

func Export() Contract {
	return Contract{
		Version:    ContractVersion,
		Operations: AllOperations,
		Outcomes: []Outcome{
			OutcomeSucceeded, OutcomeRefused, OutcomeFailed, OutcomeCancelled, OutcomeUnknown,
		},
		ErrorCodes: []ErrorCode{
			ErrUnsupportedFormat, ErrUnsupportedOperation, ErrInvalidInput, ErrUnavailableTarget,
			ErrStaleTarget, ErrQuotaRejected, ErrLifecycleRejected, ErrOutcomeUnknown, ErrLimitReached,
			ErrOfficeEditingPaused,
		},
		EffectOperations: []EffectOperation{
			EffectCreated, EffectEdited, EffectEditUndone, EffectTrashed, EffectRestored,
		},
		Tools: Definitions(),
		Formats: map[string]string{
			"note": noteMarkdownDescription,
		},
		MediaBlocks: embeds.MediaSchemas(),
	}
}

// Marshal renders the contract deterministically for the generated file.
func Marshal() ([]byte, error) {
	out, err := json.MarshalIndent(Export(), "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

// Definition lookup by name; nil when unknown.
func Lookup(name string) *Definition {
	for _, def := range Definitions() {
		if def.Name == name {
			d := def
			return &d
		}
	}
	return nil
}

/* ------------------------------------------------------------ definitions */

func obj(props map[string]any, required ...string) map[string]any {
	schema := map[string]any{
		"type":                 "object",
		"properties":           props,
		"additionalProperties": false,
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

// A card's front and back carry the stored caps (fieldlimits).
func cardFront() map[string]any {
	return map[string]any{"type": "string", "maxLength": fieldlimits.CardFront}
}

func cardBack() map[string]any {
	return map[string]any{"type": "string", "maxLength": fieldlimits.CardBack}
}

func str(desc string) map[string]any {
	s := map[string]any{"type": "string", "minLength": 1}
	if desc != "" {
		s["description"] = desc
	}
	return s
}

func idList(desc string, min, max int) map[string]any {
	s := map[string]any{
		"type":  "array",
		"items": map[string]any{"type": "string", "minLength": 1},
	}
	if desc != "" {
		s["description"] = desc
	}
	if min > 0 {
		s["minItems"] = min
	}
	if max > 0 {
		s["maxItems"] = max
	}
	return s
}

// scopeSchema is the optional source scope shared by material creation.
func scopeSchema() map[string]any {
	s := obj(map[string]any{
		"file_ids":    idList("", 0, 0),
		"chapter_ids": idList("", 0, 0),
	})
	s["description"] = "Source scope for the material. Omit or leave empty to use the current chat scope."
	return s
}

// resourceTarget is the tagged reference the trash and document tools take.
func resourceTarget(desc string) map[string]any {
	s := obj(map[string]any{
		"kind": map[string]any{"type": "string", "enum": []string{string(KindSourceFile), string(KindMaterial)}},
		"id":   str(""),
	}, "kind", "id")
	s["description"] = desc
	return s
}

// editCommandSchema is the tagged union of content edits. Every variant is a
// closed object discriminated by `type`.
func editCommandSchema() map[string]any {
	variant := func(name string, props map[string]any, required ...string) map[string]any {
		props["type"] = map[string]any{"const": name}
		return obj(props, append([]string{"type"}, required...)...)
	}
	text := func(desc string) map[string]any {
		return map[string]any{"type": "string", "maxLength": 200_000, "description": desc}
	}
	return map[string]any{
		"oneOf": []any{
			variant("replace_text", map[string]any{
				"target_id":     map[string]any{"type": "string", "description": "Block, paragraph or shape target id; omit for a plain text source."},
				"expected_text": text("Exact text to replace as inspect_document shows it, without math; must occur once in the target."),
				"text":          text("Plain replacement text; empty deletes the expected text."),
			}, "expected_text", "text"),
			variant("replace_block", map[string]any{
				"block_id":      str(""),
				"expected_text": text("The block's current text as inspect_document shows it."),
				"markdown":      text("The block's new content as note markdown in the note_building skill's format."),
			}, "block_id", "expected_text", "markdown"),
			variant("insert_markdown", map[string]any{
				"after_block_id": map[string]any{"type": []string{"string", "null"}, "description": `Insert after this block; "end" appends after the last block, null inserts at the start.`},
				"markdown":       text("Note markdown in the note_building skill's format."),
			}, "after_block_id", "markdown"),
			variant("remove_block", map[string]any{
				"block_id":      str(""),
				"expected_text": text("The block's current text as inspect_document shows it."),
			}, "block_id", "expected_text"),
			variant("set_cell", map[string]any{
				"sheet":          str("Sheet id or name from inspect_document."),
				"cell":           str("A1-style address."),
				"expected_value": map[string]any{"type": "string", "description": "Current value or =formula; empty for an empty cell."},
				"value":          map[string]any{"type": "string", "description": "New value; prefix with = for a formula; empty clears."},
			}, "sheet", "cell", "expected_value", "value"),
			variant("replace_card", map[string]any{
				"card_id": str("A side left out stays as it is."),
				"front":   cardFront(),
				"back":    cardBack(),
			}, "card_id"),
			variant("add_card", map[string]any{
				"front":         cardFront(),
				"back":          cardBack(),
				"after_card_id": map[string]any{"type": []string{"string", "null"}},
			}, "front", "back"),
			variant("remove_card", map[string]any{"card_id": str("")}, "card_id"),
			variant("remove_question", map[string]any{"question_id": str("")}, "question_id"),
			variant("set_mermaid", map[string]any{
				"expected_source": text("Current mermaid source."),
				"source":          text("New mermaid source."),
			}, "expected_source", "source"),
		},
	}
}

// noteFigureFences are the chart and plot fences: one question block as JSON
// (src/features/questions/validation.ts, questions.ValidateBlock).
var noteFigureFences = fmt.Sprintf("```chart fences comparing labelled categories, JSON "+
	`{"type": "chart", "kind": "bar"|"hbar"|"line"|"area"|"pie"|"stacked", "title", "labels": [...], `+
	`"series": [{"name", "values": one number per label}]} with any unit in the title; `+
	"```plot fences for numbers against numbers: curves of a quantity along a numeric axis (a "+
	"membrane potential over time, a titration curve) or a scatter of points, JSON "+
	`{"type": "plot", "kind"?: "line"|"scatter" (default line), "title", "xTitle", "yTitle" (axis names with units), `+
	`"series": 1 to %d [{"name", "points": [[x, y], ...] in x order for a line, 2 to %d}], `+
	`"lines"?: [{"axis": "x"|"y", "value", "label"?}] dashed reference lines, `+
	`"marks"?: [{"x", "y", "label"}] labelled points}; `,
	fieldlimits.QuestionPlotSeries, fieldlimits.QuestionPlotPoints)

// noteMarkdownDescription is the fence format notes are written in; the
// editor's markdown import reads the same fences (src/features/notes/blocks).
var noteMarkdownDescription = "Markdown. A mindmap or diagram is one " +
	"```mermaid fence. A note may also hold, where they help an idea: ```mermaid fences; " +
	noteFigureFences +
	"```quiz fences (YAML `questions:` list, each a question as add_questions takes it) and " +
	"```flashcards fences (YAML `cards:` list of `front`/`back`), each a knowledge check sized " +
	"and placed as the study preferences say; and " + fmt.Sprintf("```html-embed fences for an interactive (YAML: a quoted `caption`, "+
	"`html: |`), at most %d per note. ", embeds.HTMLEmbedMaxCount) + embeds.RulesOf("html_embed") +
	" Use an interactive only where moving something teaches more than a diagram."

// The agent writes questions in small shapes (Epo 2026-10-13): multiple-choice,
// short-answer and open questions through add_questions (one tool since
// 2026-10-14), and a chart, a plot or a library figure under a question
// through add_question_media. The retrieval service checks every argument,
// naming each problem at once, and expands the shapes into the question format
// (pipeline/retrieval/questions.py); the quiz validator stays the backstop.
// The schemas stay lean because the model reads them on every call.

func textField(desc string) map[string]any {
	s := map[string]any{"type": "string"}
	if desc != "" {
		s["description"] = desc
	}
	return s
}

func textList(desc string, min int) map[string]any {
	return map[string]any{"type": "array", "minItems": min, "items": textField(""), "description": desc}
}

// quizPlace adds where a question tool writes to its properties: a quiz by id
// (a note's quiz too), at the end or after a question.
func quizPlace(props map[string]any) map[string]any {
	props["quiz_id"] = str("The quiz to add to, a note's quiz too; add_questions' result gives a new quiz's id.")
	props["after_question_id"] = str("Add after this question, not at the end.")
	props["excerpt_ids"] = excerptIDs("Library excerpts the questions were written from.")
	return props
}

func replacesSchema() map[string]any {
	return str("A question of the quiz to rewrite in place instead (its media is dropped).")
}

// questionSchema is one add_questions item, its kind decided by its fields:
// options and correct make a multiple-choice question, accepted (and unit) a
// short answer, marks, markscheme and model_answer an open one.
func questionSchema() map[string]any {
	return obj(map[string]any{
		"question": textField("The question as the learner reads it."),
		"options":  textList("Multiple choice: the options.", 2),
		"correct":  textField("Multiple choice: the one correct option, copied exactly."),
		"accepted": textList("Short answer: the accepted answers.", 1),
		"unit": textField(`Short answer to a quantity: the unit shown after the box; accepted then ` +
			`holds plain numbers only, like "9.8".`),
		"marks": map[string]any{
			"type": "integer", "minimum": 1, "maximum": fieldlimits.QuestionMarks, "description": "Open: its marks.",
		},
		"markscheme": map[string]any{
			"type": "array", "minItems": 1, "maxItems": fieldlimits.QuizMarkscheme,
			"description": "Open: what earns marks, the items' marks adding up to marks.",
			"items": obj(map[string]any{
				"text":  textField(""),
				"marks": map[string]any{"type": "integer", "minimum": 1},
			}, "text", "marks"),
		},
		"model_answer": map[string]any{
			"type": "string", "maxLength": fieldlimits.QuizOpenAnswer, "description": "Open: a full-marks answer.",
		},
		"hints":       textList("Open, optional: nudges the learner may open.", 0),
		"explanation": textField("Optional: why the answer is right or the worked solution, shown after checking."),
		"replaces":    replacesSchema(),
	}, "question")
}

// A deck holds at most 30 slides of at most 40,000 SVG characters each (the
// example decks' slides are 3 to 9 KB).
const (
	deckMaxSlides   = 30
	deckMaxSlideSVG = 40_000
)

// excerptIDs is excerpt_ids on a write tool. It is optional: a write naming
// none is credited with the excerpts read since the last write, or all read
// this turn when none are new (pipeline retrieval/tools.py write_sources).
func excerptIDs(desc string) map[string]any {
	return idList(desc+" Optional; omitted, the excerpts read since your last write are credited.", 0, 32)
}

// deckExcerpts is excerpt_ids on the deck tools: their books are credited on
// the deck's Sources slide.
func deckExcerpts() map[string]any {
	return excerptIDs("Library excerpts this was written from; they become the deck's Sources slide.")
}

// bboxSchema is the optional zoom region of the page-capture tools.
func bboxSchema() map[string]any {
	return map[string]any{
		"type":        "array",
		"items":       map[string]any{"type": "number", "minimum": 0, "maximum": 1000},
		"minItems":    4,
		"maxItems":    4,
		"description": "[x0, y0, x1, y1] on a 0-1000 page grid, top-left origin, to zoom into a table, figure or formula.",
	}
}

func chatTool(def Definition) Definition {
	def.AllowedSlots = []Slot{SlotChat}
	if def.Version == 0 {
		def.Version = 1
	}
	return def
}

// Definitions returns every tool the contract knows. Python binds a local
// handler to each name it implements; a definition with no handler is simply
// not offered to the model.
func Definitions() []Definition {
	return []Definition{
		chatTool(Definition{
			Name:        "search_workspace",
			Retention:   RetainCitedPassages,
			Description: "Search the learner's sources for passages matching one focused query.",
			InputSchema: obj(map[string]any{
				"query":    str(""),
				"file_ids": idList("Restrict to these files. Omit to search the current scope.", 0, 0),
			}, "query"),
			UsesEmbedding:      true,
			Concurrency:        "search",
			RequiredOperations: []Operation{OpSourceRead},
		}),
		chatTool(Definition{
			Name:      "list_sources",
			Retention: RetainFull,
			Description: "List the workspace's source files and study materials by chapter, " +
				"with ids, kinds, editability and passage counts.",
			InputSchema:        obj(map[string]any{}),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpSourceRead, OpMaterialRead},
		}),
		chatTool(Definition{
			Name:      "read_document",
			Retention: RetainCitedPassages,
			Description: "Read a source file or note in order from a chunk index: a passage's " +
				"surrounding argument, or a short document end to end.",
			InputSchema: obj(map[string]any{
				"file_id": str(""),
				"start":   map[string]any{"type": "integer", "minimum": 0, "default": 0},
				"count":   map[string]any{"type": "integer", "minimum": 1, "maximum": 12, "default": 4},
			}, "file_id"),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpSourceRead},
		}),
		chatTool(Definition{
			Name:      "capture_page",
			Retention: RetainNone,
			Description: "Render a source page a shown passage cites, or a region of it, as an " +
				"image you read directly. An uploaded image is page 1.",
			InputSchema: obj(map[string]any{
				"file_id": str(""),
				"page":    map[string]any{"type": "integer", "minimum": 1},
				"bbox":    bboxSchema(),
			}, "file_id", "page"),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpSourceRead},
		}),
		chatTool(Definition{
			Name:      "read_study_progress",
			Retention: RetainFull,
			Description: "Read the learner's study progress in this workspace: files and " +
				"materials done or started, recent quiz results, and the chapters they retain least.",
			InputSchema:        obj(map[string]any{}),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpSourceRead},
		}),
		chatTool(Definition{
			Name:      "search_knowledge",
			Retention: RetainNone,
			Description: "Search the shared library of verified textbook excerpts, one section " +
				"of one book each. A hit is a selection aid; read_knowledge reads the excerpt.",
			InputSchema: obj(map[string]any{
				"query":   str(""),
				"subject": str("A subject id listed below: search only its excerpts."),
				"roles": map[string]any{
					"type":        "array",
					"maxItems":    6,
					"description": "What the excerpts teach.",
					"items": map[string]any{"type": "string", "enum": []string{
						"introduction", "formal", "worked_example", "exercise", "summary", "reference",
					}},
				},
			}, "query"),
			UsesEmbedding:      true,
			Concurrency:        "read",
			RequiredOperations: []Operation{OpLibraryRead},
		}),
		chatTool(Definition{
			Name:      "read_knowledge",
			Retention: RetainUsedExcerpts,
			Description: "Read an excerpt's reviewed notes and source chunks in order from a " +
				"chunk index; the notes and scope come on its first page.",
			InputSchema: obj(map[string]any{
				"excerpt_id": str(""),
				"start":      map[string]any{"type": "integer", "minimum": 0, "default": 0},
				"count": map[string]any{
					"type": "integer", "minimum": 1, "maximum": 12, "default": 12,
					"description": "Chunks per page, at most 12.",
				},
			}, "excerpt_id"),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpLibraryRead},
		}),
		chatTool(Definition{
			Name:      "capture_knowledge_page",
			Retention: RetainNone,
			Description: "Render a printed page an excerpt covers, or a region of it, as an " +
				"image you read directly.",
			InputSchema: obj(map[string]any{
				"excerpt_id": str(""),
				"page":       map[string]any{"type": "integer", "minimum": 1},
				"bbox":       bboxSchema(),
			}, "excerpt_id", "page"),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpLibraryRead},
		}),
		chatTool(Definition{
			Name:      "read_skill",
			Retention: RetainNone,
			Description: "Read a skill: the full instructions for one kind of work, listed " +
				"below with when to read it. Read it before that work.",
			InputSchema: obj(map[string]any{
				"name": str("A skill name listed below."),
			}, "name"),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpMaterialCreate},
		}),
		chatTool(Definition{
			Name:      "create_material",
			Retention: RetainFull,
			Description: "Create a study material from content you wrote, in the formats the " +
				"editing skill describes (a note: the note_building skill). A quiz is made with add_questions.",
			InputSchema: obj(map[string]any{
				"kind": map[string]any{
					"type": "string",
					"enum": []string{"flashcards", "mindmap", "diagram", "note"},
				},
				"title": map[string]any{"type": "string", "maxLength": fieldlimits.MaterialTitle},
				"cards": map[string]any{
					"type":        "array",
					"description": "flashcards only",
					"items": obj(map[string]any{
						"front": cardFront(),
						"back":  cardBack(),
					}, "front", "back"),
				},
				"content": map[string]any{
					"type":        "string",
					"description": "note, mindmap or diagram only: markdown.",
				},
				"scope":       scopeSchema(),
				"chapter_id":  str("The chapter to file it in; omit to leave it unfiled."),
				"excerpt_ids": excerptIDs("Library excerpts it was written from; they become its attribution."),
			}, "kind"),
			Mutates:            true,
			Concurrency:        "mutate",
			RequiredOperations: []Operation{OpMaterialCreate},
		}),
		chatTool(Definition{
			Name:      "add_questions",
			Retention: RetainFull,
			Description: "Add questions to a quiz (quiz_id), or create a quiz with them (title). A " +
				"question's fields make its kind: multiple choice (options, one correct) and short answer " +
				"(accepted) are 1 mark each; an open question, answered in writing, has marks and a " +
				"markscheme adding up to them, and a model_answer. Options show in the order written, " +
				"so vary which position holds the correct one. The result lists each question's id. " +
				`Example: {"title": "Osmosis", "questions": [{"question": "Which way does water move when ` +
				`a red blood cell is put in pure water?", "options": ["Into the cell", "Out of the cell"], ` +
				`"correct": "Into the cell", "explanation": "From the higher water potential outside."}, ` +
				`{"question": "What percentage of NaCl is normal saline?", "accepted": ["0.9"], "unit": ` +
				`"%"}, {"question": "Explain why the cell bursts.", "marks": 2, "markscheme": [{"text": ` +
				`"Water enters by osmosis", "marks": 1}, {"text": "No cell wall resists the swelling", ` +
				`"marks": 1}], "model_answer": "Water enters by osmosis and, with no cell wall to resist ` +
				`it, the membrane ruptures."}]}`,
			InputSchema: obj(quizPlace(map[string]any{
				"title":      str("Instead of quiz_id: create a quiz with this title."),
				"chapter_id": str("With title: the new quiz's chapter."),
				"questions": map[string]any{
					"type": "array", "minItems": 1, "maxItems": 20, "items": questionSchema(),
				},
			}), "questions"),
			Mutates:            true,
			Concurrency:        "mutate",
			RequiredOperations: []Operation{OpMaterialCreate},
		}),
		chatTool(Definition{
			Name:      "add_question_media",
			Retention: RetainFull,
			Description: "Add a chart, a plot or a library figure to one quiz question, shown after " +
				`its text. A figure is one read_knowledge listed this turn: {"type": "figure", "id": ` +
				`"<figure id>", "caption": "what it shows"}; the question shows it with its printed ` +
				`credit and the quiz credits its book. Example: {"quiz_id": "mat_1", "question_id": "q_3f9a1c2b7e", ` +
				`"media": {"type": "plot", "title": "Action potential", "xTitle": "Time (ms)", "yTitle": ` +
				`"Membrane potential (mV)", "series": [{"name": "Vm", "points": [[0, -70], [1, 30], ` +
				`[2, -80], [4, -70]]}]}}`,
			InputSchema: obj(map[string]any{
				"quiz_id":     str(""),
				"question_id": str(""),
				"media": map[string]any{
					"type": "object", "additionalProperties": true,
					"description": "A note's chart or plot fence JSON, or a library figure.",
				},
				"excerpt_ids": excerptIDs("Library excerpts the media was drawn from."),
			}, "quiz_id", "question_id", "media"),
			Mutates:            true,
			Concurrency:        "mutate",
			RequiredOperations: []Operation{OpDocumentEdit},
		}),
		chatTool(Definition{
			Name:      "create_deck",
			Retention: RetainFull,
			Description: "Create a slide deck from an outline, one title and brief per slide, as " +
				"the deck skill describes.",
			InputSchema: obj(map[string]any{
				"title": map[string]any{"type": "string", "minLength": 1, "maxLength": fieldlimits.MaterialTitle},
				"slides": map[string]any{
					"type":     "array",
					"minItems": 1,
					"maxItems": deckMaxSlides,
					"items": obj(map[string]any{
						"title": map[string]any{"type": "string", "minLength": 1, "maxLength": 160},
						"brief": map[string]any{"type": "string", "minLength": 1, "maxLength": 1200},
					}, "title", "brief"),
				},
				"chapter_id":  str("The chapter to file the deck in; omit to leave it unfiled."),
				"excerpt_ids": deckExcerpts(),
			}, "title", "slides"),
			Mutates:            true,
			Concurrency:        "mutate",
			RequiredOperations: []Operation{OpMaterialCreate},
		}),
		chatTool(Definition{
			Name:      "write_slide",
			Retention: RetainFull,
			Description: "Write one slide of a deck as SVG in the deck skill's rules; writing a " +
				"slide again replaces it.",
			InputSchema: obj(map[string]any{
				"deck_id":     str(""),
				"slide":       map[string]any{"type": "integer", "minimum": 1},
				"svg":         map[string]any{"type": "string", "minLength": 1, "maxLength": deckMaxSlideSVG},
				"excerpt_ids": deckExcerpts(),
			}, "deck_id", "slide", "svg"),
			Mutates:            true,
			Concurrency:        "mutate",
			RequiredOperations: []Operation{OpMaterialCreate},
		}),
		chatTool(Definition{
			Name:      "resolve_source_change",
			Retention: RetainNone,
			Description: "See an added or changed source image from an exact " +
				"pending-change placeholder; the image is attached to the next " +
				"message. Only use identifiers supplied in the pending-source evidence.",
			InputSchema: obj(map[string]any{
				"file_id":    str(""),
				"change_id":  str(""),
				"checkpoint": map[string]any{"type": "integer", "minimum": 0},
			}, "file_id", "change_id", "checkpoint"),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpSourceRead},
		}),
		chatTool(Definition{
			Name:      "inspect_document",
			Retention: RetainFull,
			Description: "Read a document's current content as editable targets with stable " +
				"ids. Inspect before editing; never take edit positions from search results. A quiz's " +
				"answers, solutions and marking schemes appear only when the user may edit it.",
			InputSchema: obj(map[string]any{
				"target": resourceTarget("The document to inspect."),
				"start":  map[string]any{"type": "integer", "minimum": 0, "default": 0, "description": "First target index to return."},
				"count":  map[string]any{"type": "integer", "minimum": 1, "maximum": 200, "default": 60},
			}, "target"),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpSourceRead, OpMaterialRead},
		}),
		chatTool(Definition{
			Name:      "edit_document",
			Retention: RetainFull,
			Description: "Edit the content of one inspected document: each command names a " +
				"target and the exact text or value it expects, and one stale expectation refuses " +
				"the whole call. Edits save directly, each with an Undo; replace_block rewrites a note " +
				"block with formatting or math. Uploaded media and PDFs cannot be edited; a library " +
				"figure placed in a note is removed only by the learner's Undo. Quiz questions are " +
				"added and replaced with the question tools.",
			InputSchema: obj(map[string]any{
				"target": resourceTarget("The document to edit."),
				"commands": map[string]any{
					"type":     "array",
					"minItems": 1,
					"maxItems": 20,
					"items":    editCommandSchema(),
				},
				"excerpt_ids": excerptIDs("Library excerpts the added content was written from."),
			}, "target", "commands"),
			Mutates:            true,
			Concurrency:        "mutate",
			RequiredOperations: []Operation{OpDocumentEdit},
		}),
		chatTool(Definition{
			Name:      "trash_file",
			Retention: RetainFull,
			Description: "Move a source file or study material in this workspace to the " +
				"trash. Only call this when the user asked to delete or remove it. " +
				"The owner can restore it from Files › Trash within 30 days.",
			InputSchema: obj(map[string]any{
				"target": resourceTarget("The file or material to trash."),
			}, "target"),
			Mutates:            true,
			Concurrency:        "mutate",
			RequiredOperations: []Operation{OpResourceTrash},
		}),
		chatTool(Definition{
			Name:      "list_trashed_files",
			Retention: RetainFull,
			Description: "List the trashed source files and study materials of this " +
				"workspace with their ids, names and expiry. Use it before restore_file " +
				"so you never guess an id.",
			InputSchema:        obj(map[string]any{}),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpTrashRead},
		}),
		chatTool(Definition{
			Name:      "restore_file",
			Retention: RetainFull,
			Description: "Restore a trashed source file or study material of this " +
				"workspace. Only call this when the user asked for it; use " +
				"list_trashed_files to find the id.",
			InputSchema: obj(map[string]any{
				"target": resourceTarget("The trashed file or material to restore."),
			}, "target"),
			Mutates:            true,
			Concurrency:        "mutate",
			RequiredOperations: []Operation{OpTrashRestore},
		}),
	}
}
