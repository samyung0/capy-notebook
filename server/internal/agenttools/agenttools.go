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
	"strings"
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
// per layer: chat's Interactive is HtmlEmbed (chat's Mermaid went in v41), and the
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
// they wrote (effect.blockIds); replace_card keeps a side it is not sent (Epo
// 2026-10-14).
// v30: an open question's model_answer is optional (Epo 2026-10-15).
// v31: resolve_source_change also takes a note's material_id and block_id,
// returning that block's index text before and after (Epo 2026-10-17).
// v32: Word, Excel and PowerPoint files are read with inspect_office_document
// and edited or created with edit_office_document, offered once the
// office_building skill is read (Epo 2026-10-20); edit_document loses set_cell
// and its replace_text takes notes and text sources only.
// v33: create_material, add_questions (a new quiz) and create_deck take
// sources, a made-from line of plain strings, instead of an id scope;
// search_workspace's file_ids take any workspace item (Epo 2026-10-21).
// v34: the live Undo (Epo 2026-10-20): an edit receipt carries effect.undo
// only when a loaded room holds the edit's Undo, and edit_document and
// edit_office_document no longer promise one.
// v35: edit_office_document inserts and deletes DOCX and PPTX paragraphs
// (insert_paragraph, delete_paragraph), and a DOCX read names each
// paragraph's style and lists the file's paragraph styles (Epo 2026-10-21).
// v36: edit_office_document creates Word files; insert_paragraph's anchor is
// optional (the body's end) and it takes a list; set_list, insert_table,
// delete_table, format_text and set_alignment edit Word files; a DOCX read
// marks lists, table cells, content controls and locked paragraphs and reads
// headers, footers and notes after the body; the engine applies a call's
// commands up to its per-call limits (its limits.json, which Marshal writes
// into the description) and returns the rest unapplied by index (Epo
// 2026-10-21, 2026-10-22).
// v37: edit_document loses set_mermaid (a mindmap's or diagram's Mermaid
// block changes through replace_block), may remove or replace any note
// block, media included, and replace_card takes expected_front and
// expected_back, required with the side it replaces (Epo 2026-10-21); a
// Mermaid block's inspected and expected text is its source, nested ones
// included, and a replace_block keeps the replaced block's caption and width
// (a Mermaid block's theme too) on the replacement's first block of its type,
// unless that shows a different picture, which brings its own caption and
// credit (Epo 2026-10-22).
// v38: inspect_office_document reads a PPTX by slide (its slides with their
// layouts and shapes, the deck's layouts; a slide's shapes and paragraphs);
// edit_office_document's set_shape_text, add_slide, delete_slide,
// move_slide and add_text_box edit PowerPoint files, and format_text and
// set_alignment take PPTX paragraphs too (Epo 2026-10-20); the slide read
// pages shapes with paragraphs and gives the slide's speaker notes, which
// delete_slide names (Epo 2026-10-22).
// v39: format_text names its span text, not expected_text, and delete_table
// takes a table's short id (body:t0) that names one table (Epo 2026-10-23).
// v40: search_web searches the web, its cited results kept like passages; the
// stream request carries workspaceOnly instead of library, library.read is
// granted with every chat, and the library tools and search_web stay offered
// whatever the switch says, answering as unavailable while it is on (Epo
// 2026-10-24).
// v41: the agent makes no Mermaid: create_material takes flashcards or a note
// (no mindmap or diagram) and the note format names no mermaid fence; a
// Mermaid block a learner added still rewrites through replace_block (Epo
// 2026-10-25).
const ContractVersion = 41

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
	// Retention applies between user messages; until a turn's answer is
	// finished every result stays whole (Epo 2026-10-21).
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

// UndoStatus is the availability of a step's Undo: the server sends
// available; the chat marks a refused step unavailable for the session.
type UndoStatus string

const (
	UndoAvailable   UndoStatus = "available"
	UndoUnavailable UndoStatus = "unavailable"
)

// UndoRef names the step a chat Undo or Redo reverses; a loaded collaboration
// room holds its Yjs items while the step is live (Epo 2026-10-20). An edit
// step's is offered until ExpiresAt, 24 h after its agent edit (Q385), when
// the chat hides it; a file step's has none.
type UndoRef struct {
	OperationID string     `json:"operationId"`
	Status      UndoStatus `json:"status" enum:"available,unavailable"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
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
// document content.
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
	// OfficeShapeText is the engine's per-shape text bound, which Marshal
	// adds for the office_building skill.
	OfficeShapeText *ShapeText `json:"officeShapeText,omitempty"`
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

// Marshal renders the contract deterministically for the generated file,
// edit_office_document's description ending with the Office engine's
// per-call limits from officeLimits (the file at OfficeLimitsPath).
func Marshal(officeLimits []byte) ([]byte, error) {
	limits, err := parseOfficeLimits(officeLimits)
	if err != nil {
		return nil, err
	}
	contract := Export()
	contract.OfficeShapeText = &limits.ShapeText
	for i := range contract.Tools {
		if contract.Tools[i].Name == "edit_office_document" {
			contract.Tools[i].Description = strings.Replace(contract.Tools[i].Description,
				"(Marshal adds the engine's per-call limits.)", officeLimitsSentence(limits), 1)
			withShapeText(contract.Tools[i].InputSchema, limits.ShapeText)
		}
	}
	out, err := json.MarshalIndent(contract, "", "  ")
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

// sourcesSchema is the made-from line of whatever a create tool makes
// (Epo 2026-10-21): plain strings, which Go stores as names. lead prefixes the
// description.
func sourcesSchema(lead string) map[string]any {
	return map[string]any{
		"type":     "array",
		"maxItems": fieldlimits.MaterialSources,
		"items":    map[string]any{"type": "string", "maxLength": fieldlimits.MaterialSource},
		"description": fmt.Sprintf("%smade-from line: each source it is made from, named in words or by id: "+
			"workspace files, notes, Office files, quizzes and flashcard sets (ids from list_sources), or "+
			"outside sources such as a lecture, a handout or a web address. At most %d, each at most %d "+
			"characters. An id or exact name of a workspace item is stored as that item's current name. "+
			"Omit it to name none.", lead, fieldlimits.MaterialSources, fieldlimits.MaterialSource),
	}
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
				"target_id":     map[string]any{"type": "string", "description": "The note block's id; omit for a plain text source."},
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
			variant("replace_card", map[string]any{
				"card_id":        str("A side left out stays as it is."),
				"front":          cardFront(),
				"back":           cardBack(),
				"expected_front": text("The card's front as inspect_document shows it; required with front."),
				"expected_back":  text("The card's back as inspect_document shows it; required with back."),
			}, "card_id"),
			variant("add_card", map[string]any{
				"front":         cardFront(),
				"back":          cardBack(),
				"after_card_id": map[string]any{"type": []string{"string", "null"}},
			}, "front", "back"),
			variant("remove_card", map[string]any{"card_id": str("")}, "card_id"),
			variant("remove_question", map[string]any{"question_id": str("")}, "question_id"),
		},
	}
}

// officeCommandSchema is edit_office_document's tagged union. Each variant's
// description starts with the formats it applies to; Go turns the model's
// snake_case commands into the engine's (NormalizeOfficeCommands). The grid
// bounds are schema sanity bounds only: the engine refuses a range, or a call,
// over 10,000 cells and the retrieval service a call whose commands are over
// 256 KB of JSON or 10,000 cells (Epo 2026-10-20).
func officeCommandSchema() map[string]any {
	variant := func(name, desc string, props map[string]any, required ...string) map[string]any {
		props["type"] = map[string]any{"const": name}
		s := obj(props, append([]string{"type"}, required...)...)
		s["description"] = desc
		return s
	}
	grid := func(desc string) map[string]any {
		return map[string]any{
			"type": "array", "minItems": 1, "maxItems": 10000, "description": desc,
			"items": map[string]any{"type": "array", "minItems": 1, "maxItems": 10000, "items": map[string]any{"type": "string"}},
		}
	}
	sheet := str("The sheet's id or name as inspect_office_document lists it.")
	cellRange := str(`An A1 range on that sheet, like "B2:D9".`)
	count := map[string]any{"type": "integer", "minimum": 1}
	row := map[string]any{"type": "integer", "minimum": 1, "description": "The row number the first new row takes; rows from there move down."}
	column := str(`The column letter the first new column takes, like "C"; columns from there move right.`)
	// A delete's expected band: rows of cells like set_range's expected, with
	// trailing empty cells and rows left out (Epo 2026-10-20, review finding 6).
	band := func(desc string) map[string]any {
		return map[string]any{
			"type": "array", "description": desc,
			"items": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		}
	}
	paragraph := str("A paragraph's target id from inspect_office_document.")
	after := str("The body paragraph it follows; several inserts after one paragraph keep their order. Omit to add it at the end of the document.")
	flag := map[string]any{"type": "boolean"}
	slideID := str("A slide's id from inspect_office_document.")
	// A shape's text, bounded by the engine's limits.json (Marshal).
	shapeText := func(desc string) map[string]any {
		return map[string]any{
			"type": "array", "minItems": 1, shapeTextKey: true, "items": map[string]any{"type": "string"},
			"description": desc + " At most " + shapeParagraphs + " paragraphs and " + shapeCharacters + " characters together.",
		}
	}
	points := map[string]any{"type": "number", "minimum": 0, "description": "Points from the slide's left or top edge."}
	return map[string]any{
		"oneOf": []any{
			variant("create", "First command only, without file_id: makes a new file; the call's other commands then apply to it.", map[string]any{
				"format":     map[string]any{"type": "string", "enum": []string{"xlsx", "docx"}},
				"title":      map[string]any{"type": "string", "minLength": 1, "maxLength": fieldlimits.MaterialTitle, "description": "The file's name, without its extension."},
				"chapter_id": str("The chapter to file it in; omit to leave it unfiled."),
			}, "format", "title"),
			variant("set_range", "XLSX: write a rectangle of cells.", map[string]any{
				"sheet":    sheet,
				"range":    cellRange,
				"expected": grid(`The range's current inputs as inspect_office_document shows them, one row per array; "" for an empty cell.`),
				"values":   grid(`The new inputs as typed, in the range's shape: "=..." for a formula, "" to clear.`),
			}, "sheet", "range", "expected", "values"),
			variant("format_cells", "XLSX: format a range; fields left out stay as they are.", map[string]any{
				"sheet":                sheet,
				"range":                cellRange,
				"bold":                 map[string]any{"type": "boolean"},
				"italic":               map[string]any{"type": "boolean"},
				"strikethrough":        map[string]any{"type": "boolean"},
				"font_family":          str(""),
				"font_size":            map[string]any{"type": "number", "minimum": 1, "maximum": 409},
				"text_color":           str(`A hex colour, like "#1F4E79".`),
				"fill_color":           str(`A hex colour, like "#FFF2CC".`),
				"horizontal_alignment": map[string]any{"type": "string", "enum": []string{"left", "center", "right"}},
				"vertical_alignment":   map[string]any{"type": "string", "enum": []string{"top", "middle", "bottom"}},
				"wrap":                 map[string]any{"type": "boolean", "description": "true wraps text inside the cell; false lets it overflow."},
				"number_format": str(`automatic, plain_text, number, percent, scientific, currency, date, time, ` +
					`or an Excel number format pattern like "0.0%" or "yyyy-mm-dd".`),
			}, "sheet", "range"),
			variant("add_sheet", "XLSX: add an empty sheet.", map[string]any{
				"name":  str(""),
				"after": str("The sheet it follows; omit to add it last."),
			}, "name"),
			variant("rename_sheet", "XLSX: rename a sheet.", map[string]any{
				"sheet":         sheet,
				"expected_name": str("The sheet's current name."),
				"name":          str(""),
			}, "sheet", "expected_name", "name"),
			variant("insert_rows", "XLSX: insert empty rows.", map[string]any{
				"sheet": sheet, "at": row, "count": count,
			}, "sheet", "at", "count"),
			variant("delete_rows", "XLSX: delete whole rows.", map[string]any{
				"sheet":    sheet,
				"at":       map[string]any{"type": "integer", "minimum": 1, "description": "The first row number to delete."},
				"count":    count,
				"expected": band(`The rows' current inputs as inspect_office_document shows them, one array per row with its cells from column A; trailing empty cells and rows may be left out, [] for empty rows.`),
			}, "sheet", "at", "count", "expected"),
			variant("insert_columns", "XLSX: insert empty columns.", map[string]any{
				"sheet": sheet, "at": column, "count": count,
			}, "sheet", "at", "count"),
			variant("delete_columns", "XLSX: delete whole columns.", map[string]any{
				"sheet":    sheet,
				"at":       str(`The first column letter to delete, like "C".`),
				"count":    count,
				"expected": band(`The columns' current inputs as inspect_office_document shows them, one array per row from row 1 holding the deleted columns' cells; trailing empty cells and rows may be left out, [] for empty columns.`),
			}, "sheet", "at", "count", "expected"),
			variant("delete_sheet", "XLSX: delete a sheet.", map[string]any{
				"sheet":         sheet,
				"expected_name": str("The sheet's current name."),
			}, "sheet", "expected_name"),
			variant("replace_text", "DOCX, PPTX: replace text inside one paragraph or shape.", map[string]any{
				"target_id":     str("The paragraph's or shape's target id from inspect_office_document."),
				"expected_text": map[string]any{"type": "string", "description": "Exact text to replace as inspect_office_document shows it; must occur once in the target."},
				"text":          map[string]any{"type": "string", "description": "Plain replacement text; empty deletes the expected text."},
			}, "target_id", "expected_text", "text"),
			variant("insert_paragraph", "DOCX, PPTX: insert one paragraph right after after_id or right before before_id (at most one); DOCX paragraphs go in the document body, at its end with neither.", map[string]any{
				"after_id":  str("The paragraph it follows, a target id from inspect_office_document."),
				"before_id": str("The paragraph it precedes; the first paragraph's id inserts at the start."),
				"text":      str("One paragraph's plain text, up to 5,000 characters, without line breaks."),
				"style":     str("DOCX: a paragraph style id inspect_office_document lists; omit to continue the paragraph before it as Enter does."),
				"list":      map[string]any{"type": "string", "enum": []string{"bullet", "numbered", "none"}, "description": "DOCX: start or end a list; omit to continue the paragraph before it."},
			}, "text"),
			variant("delete_paragraph", "DOCX, PPTX: delete one paragraph, never its story's or shape's last.", map[string]any{
				"target_id":     str("The paragraph's target id from inspect_office_document."),
				"expected_text": map[string]any{"type": "string", "description": "The paragraph's whole text as inspect_office_document shows it."},
			}, "target_id", "expected_text"),
			variant("set_list", "DOCX: make paragraphs bulleted or numbered, or end their list.", map[string]any{
				"ids":  map[string]any{"type": "array", "minItems": 1, "items": map[string]any{"type": "string"}, "description": "Paragraph target ids."},
				"list": map[string]any{"type": "string", "enum": []string{"bullet", "numbered", "none"}},
			}, "ids", "list"),
			variant("insert_table", "DOCX: add a table of text to the document body, followed by an empty paragraph.", map[string]any{
				"after_id": after,
				"rows":     band("The cells' text, one array per row, every row the same length; at most 20 rows of 10 cells."),
			}, "rows"),
			variant("delete_table", "DOCX: delete a table.", map[string]any{
				"id":       str("The table's id from inspect_office_document."),
				"expected": band("The table's cells' text as inspect_office_document shows them, one array per row; a cell's paragraphs joined by line breaks."),
			}, "id", "expected"),
			variant("format_text", "DOCX, PPTX: format text inside one paragraph; fields left out stay as they are.", map[string]any{
				"target_id":     paragraph,
				"text":          str("The exact text to format as inspect_office_document shows it; must occur once in the paragraph."),
				"bold":          flag,
				"italic":        flag,
				"underline":     flag,
				"strikethrough": flag,
				"color":         str(`A hex colour, like "#1F4E79".`),
				"highlight": map[string]any{"type": "string", "description": "DOCX only.", "enum": []string{
					"none", "yellow", "green", "cyan", "magenta", "blue", "red", "darkBlue", "darkCyan",
					"darkGreen", "darkMagenta", "darkRed", "darkYellow", "darkGray", "lightGray", "black", "white",
				}},
				"font_size":   map[string]any{"type": "number", "minimum": 1, "maximum": 1638, "description": "Points."},
				"font_family": str(`A font name, like "Arial".`),
			}, "target_id", "text"),
			variant("set_alignment", "DOCX, PPTX: align one paragraph.", map[string]any{
				"target_id": paragraph,
				"alignment": map[string]any{"type": "string", "enum": []string{"left", "center", "right", "justify"}},
			}, "target_id", "alignment"),
			variant("set_shape_text", "PPTX: replace a shape's whole text; its paragraphs keep their level and bullet, added ones continue the last.", map[string]any{
				"shape_id":      str("The shape's id from inspect_office_document's slide read."),
				"expected_text": map[string]any{"type": "string", "description": "The shape's whole text as the slide read shows it, its paragraphs joined by line breaks."},
				"paragraphs":    shapeText(`The new text, one string a paragraph without line breaks; [""] empties the shape.`),
			}, "shape_id", "expected_text", "paragraphs"),
			variant("add_slide", "PPTX: add a slide with its layout's title and text placeholders, empty, right after after_slide or right before before_slide (at most one), last with neither.", map[string]any{
				"after_slide":  slideID,
				"before_slide": slideID,
				"layout":       str("A layout id the deck read lists; omit for the layout of the slide it follows (the first slide's when it goes first)."),
			}),
			variant("delete_slide", "PPTX: delete a slide, never the deck's only one.", map[string]any{
				"slide_id":      slideID,
				"expected_text": map[string]any{"type": "string", "description": "The slide's text as its slide read shows it: every paragraph, one a line, in shape order, then its speaker notes as the read shows them (cut marker included); blank lines and the spaces around a line are not compared."},
			}, "slide_id", "expected_text"),
			variant("move_slide", "PPTX: move a slide right after after_slide or right before before_slide (exactly one).", map[string]any{
				"slide_id":     slideID,
				"after_slide":  slideID,
				"before_slide": slideID,
			}, "slide_id"),
			variant("add_text_box", "PPTX: add a text box to a slide, its box in points from the slide's top left corner, inside the slide.", map[string]any{
				"slide_id":   slideID,
				"paragraphs": shapeText("The text, one string a paragraph without line breaks."),
				"x":          points, "y": points,
				"w": map[string]any{"type": "number", "exclusiveMinimum": 0, "description": "Width in points."},
				"h": map[string]any{"type": "number", "exclusiveMinimum": 0, "description": "Height in points."},
			}, "slide_id", "paragraphs", "x", "y", "w", "h"),
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
	`"series": 1 to %d [{"name", "points": [[x, y], ...] in x order for a line, 2 to %d (1 or more for a scatter)}], `+
	`"lines"?: [{"axis": "x"|"y", "value", "label"?}] dashed reference lines, `+
	`"marks"?: [{"x", "y", "label"}] labelled points}; `,
	fieldlimits.QuestionPlotSeries, fieldlimits.QuestionPlotPoints)

// noteMarkdownDescription is the fence format notes are written in; the
// editor's markdown import reads the same fences (src/features/notes/blocks).
var noteMarkdownDescription = "Markdown. A note may also hold, where they help an idea: " +
	noteFigureFences +
	"```quiz fences (YAML `questions:` list, each a question as add_questions takes it) and " +
	"```flashcards fences (YAML `cards:` list of `front`/`back`), each a knowledge check sized " +
	"and placed as the study preferences say; and " + fmt.Sprintf("```html-embed fences for an interactive (YAML: a quoted `caption`, "+
	"`html: |`), at most %d per note. ", embeds.HTMLEmbedMaxCount) + embeds.RulesOf("html_embed") +
	" Use an interactive only where moving something teaches more than a still picture."

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
// short answer, marks and markscheme (model_answer optional) an open one.
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
			"type": "string", "maxLength": fieldlimits.QuizOpenAnswer, "description": "Open, optional: a full-marks answer.",
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
				"query": str(""),
				"file_ids": idList("Restrict to these workspace items (ids from list_sources); only source "+
					"files and notes hold text to search. Omit to search the current scope.", 0, 0),
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
			Retention: RetainNone,
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
			Name:      "search_web",
			Retention: RetainCitedPassages,
			Description: "Search the web. Expensive: each search costs the learner credits, so " +
				"call it only when the workspace, the library and your own knowledge cannot " +
				"answer (recent events, facts they lack). At most 3 searches per learner " +
				"message, one focused query each, written in your own words rather than " +
				"copied from the learner's files. Results are pages anyone can publish.",
			InputSchema: obj(map[string]any{
				"query": map[string]any{
					"type": "string", "minLength": 1, "maxLength": 128,
					"description": "One focused query. site:, -site:, lang:, after: and " +
						"before: narrow it.",
				},
			}, "query"),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpSourceRead},
		}),
		chatTool(Definition{
			Name:      "read_skill",
			Retention: RetainNone,
			Description: "Read a skill: the full instructions for one kind of work, listed " +
				"below with when to read it. Read it before that work.",
			InputSchema: obj(map[string]any{
				"name": str("A skill name listed below."),
			}, "name"),
			Concurrency: "read",
			// Every role that can chat reads skills: a viewer reads
			// office_building for inspect_office_document (Epo 2026-10-20).
			RequiredOperations: []Operation{OpSourceRead},
		}),
		chatTool(Definition{
			Name:      "create_material",
			Retention: RetainFull,
			Description: "Create a study material from content you wrote, in the formats the " +
				"editing skill describes (a note: the note_building skill). A quiz is made with add_questions.",
			InputSchema: obj(map[string]any{
				"kind": map[string]any{
					"type": "string",
					"enum": []string{"flashcards", "note"},
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
					"description": "note only: markdown.",
				},
				"sources":     sourcesSchema("The "),
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
			Description: "Add questions to a quiz (quiz_id), or create a quiz with them (title); read " +
				"the editing skill before the first call. A question's fields make its kind: multiple choice (options, one correct) and short answer " +
				"(accepted) are 1 mark each; an open question, answered in writing, has marks and a " +
				"markscheme adding up to them, and optionally a model_answer. Options are shown shuffled: never " +
				`refer to one by its letter or position (A, B, "the first", "all of the above"). ` +
				"The result lists each question's id. " +
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
				"sources":    sourcesSchema("With title: the new quiz's "),
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
				"sources":     sourcesSchema("The "),
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
			Description: "Resolve an exact pending-change placeholder. For a file's image " +
				"change give file_id, change_id and checkpoint: the image is attached to " +
				"the next message. For a note's data change give material_id and " +
				"block_id: the block's text before and after is returned. Only use " +
				"identifiers supplied in the pending-source evidence.",
			InputSchema: obj(map[string]any{
				"file_id":     str(""),
				"change_id":   str(""),
				"checkpoint":  map[string]any{"type": "integer", "minimum": 0},
				"material_id": str(""),
				"block_id":    str(""),
			}),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpSourceRead, OpMaterialRead},
		}),
		chatTool(Definition{
			Name:      "inspect_document",
			Retention: RetainNone,
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
				"the whole call. Edits save directly; replace_block rewrites a note " +
				"block with formatting or math, and a Mermaid block a learner added as one " +
				"```mermaid fence, expecting the source inspect shows as its text. " +
				"Any note block may be removed or replaced, media included; the only media an edit " +
				"adds are library figures. A block rewritten as one of its own type keeps its " +
				"caption and width (a diagram its theme too); an image swapped for a different " +
				"picture or figure takes the new one's caption. PDFs cannot be edited. Quiz " +
				"questions are added and replaced with the question tools.",
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
			Retention: RetainNone,
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
		// The Office tools come last: the retrieval service appends them to a
		// turn's tools once the office_building skill is read, keeping the rest
		// of the request's prefix.
		chatTool(Definition{
			Name:      "inspect_office_document",
			Retention: RetainNone,
			Description: "Read a Word, Excel or PowerPoint file as editable targets, as the " +
				"office_building skill describes. XLSX: without range, its sheets (id, name, used " +
				"range); with sheet and range, each cell's input and shown value, at most 2,000 " +
				"cells a read. DOCX: count paragraphs from start with their target ids, styles, lists and " +
				"table cells, the body's and then the headers', footers' and notes', which take replace_text " +
				"only; the first page also lists the file's paragraph styles. " +
				"PPTX: without slide, count slides from start with their layouts and first shapes (id, kind, " +
				"first line), the first page also listing the deck's layouts; with slide, count of that " +
				"slide's shapes and paragraphs from start, each shape followed by its paragraphs with their " +
				"target ids, the first page also giving the slide's speaker notes.",
			InputSchema: obj(map[string]any{
				"file_id": str(""),
				"sheet":   str("XLSX: the sheet's id or name."),
				"range":   str(`XLSX: an A1 range on that sheet, like "A1:H40".`),
				"start":   map[string]any{"type": "integer", "minimum": 0, "default": 0, "description": "DOCX: first paragraph; PPTX: first slide, or with slide its first shape or paragraph; counting from 0."},
				"count":   map[string]any{"type": "integer", "minimum": 1, "maximum": 200, "default": 60, "description": "DOCX: paragraphs to read; PPTX: slides, or with slide shapes and paragraphs."},
				"slide":   map[string]any{"type": "integer", "minimum": 1, "description": "PPTX: one slide's number, from 1."},
			}, "file_id"),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpSourceRead},
		}),
		chatTool(Definition{
			Name:      "edit_office_document",
			Retention: RetainFull,
			Description: "Edit one Word, Excel or PowerPoint file, or create a Word or Excel file, with the commands " +
				"of its format as the office_building skill describes. Each command names what it " +
				"expects as inspect_office_document shows it, and one stale expectation refuses the " +
				"whole call. Edits save directly. A call's commands are at most 256 KB; a larger call is " +
				"refused. (Marshal adds the engine's per-call limits.)",
			InputSchema: obj(map[string]any{
				"file_id": str("The file to edit; omit when the first command is create."),
				"commands": map[string]any{
					"type":     "array",
					"minItems": 1,
					"items":    officeCommandSchema(),
				},
			}, "commands"),
			Mutates:            true,
			Concurrency:        "mutate",
			RequiredOperations: []Operation{OpDocumentEdit},
		}),
	}
}
