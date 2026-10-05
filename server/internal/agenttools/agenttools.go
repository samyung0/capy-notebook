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

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
)

// questionJSONDescription documents the question shape and the user-quiz bounds
// the validator enforces.
var questionJSONDescription = fmt.Sprintf("Question JSON: id, stem typed blocks, parts [{id, blocks, answer, marks 1-%d, markscheme [{text, marks}] on open parts only, solution blocks}], layout paper|split, labels letters|numbers, optional level. An open part's markscheme item marks add up to its marks; closed parts have no markscheme and explain in solution. Part ids must be globally unique. Answers: mcq/multi options string[] and correct indices; boolean correct; short accepted string[] and optional fixed unit; matching options string[] and pairs [{left,right option index}]; ordering items string[]; open accepted and hints string[]. Blocks: text, chart, graph, table. At most %d parts per question and %d marking items per part; a quiz has at most %d parts, %d of them open; open accepted answers under %d characters. No legacy prompt/points/rubrics or awarded scores.",
	fieldlimits.QuestionMarks, fieldlimits.QuizQuestionParts, fieldlimits.QuizMarkscheme, fieldlimits.QuizParts, fieldlimits.QuizOpenParts, fieldlimits.QuizOpenAnswer)

// questionExample is one valid user-quiz question, a closed part and an open
// one, that the materials skill shows beside the format (checked by
// TestQuestionExampleIsValid).
const questionExample = `{"id": "q1", "stem": [{"type": "text", "text": "A red blood cell is placed in pure water."}], "parts": [` +
	`{"id": "q1a", "blocks": [{"type": "text", "text": "Which way does water move?"}], "answer": {"type": "mcq", "options": ["Into the cell", "Out of the cell"], "correct": [0]}, "marks": 1, "solution": [{"type": "text", "text": "Into the cell, from the higher water potential outside."}]}, ` +
	`{"id": "q1b", "blocks": [{"type": "text", "text": "Explain why the cell may burst."}], "answer": {"type": "open", "accepted": ["Water enters by osmosis and, with no cell wall, the membrane ruptures."], "hints": ["What resists the swelling in a plant cell?"]}, "marks": 2, "markscheme": [{"text": "Water enters by osmosis", "marks": 1}, {"text": "No cell wall, so the membrane ruptures", "marks": 1}], "solution": [{"type": "text", "text": "Water keeps entering by osmosis; an animal cell has no wall to resist the pressure, so it lyses."}]}` +
	`], "layout": "paper", "labels": "letters"}`

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
const ContractVersion = 15

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
	// materials skill rather than repeated in every tool description.
	Formats map[string]string `json:"formats"`
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
			"question":         questionJSONDescription,
			"question_example": questionExample,
			"note":             noteMarkdownDescription,
		},
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
				"expected_text": text("Exact text to replace; must occur once in the target."),
				"text":          text("Replacement text; empty deletes the expected text."),
			}, "expected_text", "text"),
			variant("insert_markdown", map[string]any{
				"after_block_id": map[string]any{"type": []string{"string", "null"}, "description": "Insert after this block; null inserts at the start."},
				"markdown":       text("Note markdown in the materials skill's format."),
			}, "after_block_id", "markdown"),
			variant("remove_block", map[string]any{
				"block_id":      str(""),
				"expected_text": text("The block's current text."),
			}, "block_id", "expected_text"),
			variant("set_cell", map[string]any{
				"sheet":          str("Sheet id or name from inspect_document."),
				"cell":           str("A1-style address."),
				"expected_value": map[string]any{"type": "string", "description": "Current value or =formula; empty for an empty cell."},
				"value":          map[string]any{"type": "string", "description": "New value; prefix with = for a formula; empty clears."},
			}, "sheet", "cell", "expected_value", "value"),
			variant("replace_card", map[string]any{
				"card_id": str(""),
				"front":   map[string]any{"type": "string"},
				"back":    map[string]any{"type": "string"},
			}, "card_id"),
			variant("add_card", map[string]any{
				"front":         map[string]any{"type": "string"},
				"back":          map[string]any{"type": "string"},
				"after_card_id": map[string]any{"type": []string{"string", "null"}},
			}, "front", "back"),
			variant("remove_card", map[string]any{"card_id": str("")}, "card_id"),
			variant("replace_question", map[string]any{
				"question_id": str(""),
				"question":    map[string]any{"type": "object", "additionalProperties": true, "description": "Question JSON in the materials skill's format."},
			}, "question_id", "question"),
			variant("add_question", map[string]any{
				"question":          map[string]any{"type": "object", "additionalProperties": true, "description": "Question JSON in the materials skill's format."},
				"after_question_id": map[string]any{"type": []string{"string", "null"}},
			}, "question"),
			variant("remove_question", map[string]any{"question_id": str("")}, "question_id"),
			variant("set_mermaid", map[string]any{
				"expected_source": text("Current mermaid source."),
				"source":          text("New mermaid source."),
			}, "expected_source", "source"),
		},
	}
}

// noteMarkdownDescription is the fence format notes are written in; the
// editor's markdown import reads the same fences (src/features/notes/blocks).
const noteMarkdownDescription = "Markdown. A mindmap or diagram is one " +
	"```mermaid fence. A note may also hold, where they help an idea: ```mermaid fences; " +
	"```quiz fences (YAML `questions:` list, each in the quiz question format) and " +
	"```flashcards fences (YAML `cards:` list of `front`/`back`), each a mini check of 2 to 4 " +
	"items; and ```html-embed fences for an interactive (YAML: `title`, `html: |`), at most 10 " +
	"per note. The html is one small self-contained snippet under 64 KB: inline CSS and script, " +
	"no network, no external URLs, no navigating the page, colours only from the provided " +
	"variables --bg, --fg, --muted, --accent and --border so it follows the light and dark " +
	"theme, height fitting its content with no vh or vw units. Use an interactive only where " +
	"moving something teaches more than a diagram."

// todoSchema is the ledger todo a write completes.
func todoSchema() map[string]any {
	return map[string]any{
		"type":        "integer",
		"minimum":     0,
		"description": "The open ledger todo this write completes.",
	}
}

// A deck holds at most 30 slides of at most 40,000 SVG characters each (the
// example decks' slides are 3 to 9 KB).
const (
	deckMaxSlides   = 30
	deckMaxSlideSVG = 40_000
)

// deckExcerpts is excerpt_ids on the deck tools: their books are credited on
// the deck's Sources slide.
func deckExcerpts() map[string]any {
	return idList("Library excerpts this was written from; they become the deck's Sources slide.", 0, 32)
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
				"query":  str(""),
				"topics": idList("topic_id values from a browse_knowledge subject; omit for a direct search.", 0, 8),
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
			Name:      "browse_knowledge",
			Retention: RetainNone,
			Description: "List what the library holds: a subject listed below for its topics " +
				"with excerpt counts, or a topic for its excerpts by role and book.",
			InputSchema: obj(map[string]any{
				"subject": str("A subject id listed below."),
				"topic":   str("A topic_id from a subject browse."),
				"page":    map[string]any{"type": "integer", "minimum": 1, "default": 1},
			}),
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
			}, "excerpt_id"),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpLibraryRead},
		}),
		chatTool(Definition{
			Name:      "list_question_bank",
			Retention: RetainNone,
			Description: "List the question bank of reviewed exam questions: a bank subject " +
				"listed below for its topics, or a topic for its questions as cards, 50 per page, " +
				"optionally only those with a part of one answer type.",
			InputSchema: obj(map[string]any{
				"subject": str("A bank subject id from this description."),
				"topic":   str("A topic id from a subject's list."),
				"answer_type": map[string]any{
					"type": "string",
					"enum": []string{"mcq", "multi", "boolean", "short", "matching", "ordering", "open", "gaps"},
					"description": "With topic: only questions with a part of this answer type, as cards list " +
						"them after their marks (True/False/Not given items are mcq).",
				},
				"offset": map[string]any{"type": "integer", "minimum": 0, "default": 0},
			}),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpLibraryRead},
		}),
		chatTool(Definition{
			Name:      "read_question",
			Retention: RetainFull,
			Description: "Read one question-bank question in full, with its solution, marking " +
				"scheme and sources.",
			InputSchema: obj(map[string]any{
				"question_id": str(""),
			}, "question_id"),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpLibraryRead},
		}),
		chatTool(Definition{
			Name:      "copy_questions",
			Retention: RetainFull,
			Description: "Copy question-bank questions by id, unchanged, into a new quiz (title, " +
				"optional chapter_id) or a quiz in this workspace (quiz_id), instead of writing them out.",
			InputSchema: obj(map[string]any{
				"question_ids": map[string]any{
					"type": "array", "minItems": 1, "maxItems": 20, "uniqueItems": true,
					"items": map[string]any{"type": "string", "minLength": 1},
				},
				"title":      map[string]any{"type": "string", "minLength": 1, "maxLength": fieldlimits.MaterialTitle},
				"chapter_id": str("The chapter to file a new quiz in."),
				"quiz_id":    str("A quiz in this workspace to append to."),
				"todo":       todoSchema(),
			}, "question_ids"),
			Mutates:            true,
			Concurrency:        "mutate",
			RequiredOperations: []Operation{OpMaterialCreate, OpLibraryRead},
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
			Name:      "create_ledger",
			Retention: RetainNone,
			Description: "Add or edit the conversation's ledger todos, one per item to write: a " +
				"string adds a todo, {id, todo} rewrites one. Pass only the changes.",
			InputSchema: obj(map[string]any{
				"todos": map[string]any{
					"type": "array", "maxItems": 10,
					"items": map[string]any{"anyOf": []any{
						map[string]any{"type": "string", "minLength": 1, "maxLength": 200},
						obj(map[string]any{
							"id":   map[string]any{"type": "integer", "minimum": 0},
							"todo": map[string]any{"type": "string", "minLength": 1, "maxLength": 200},
						}, "id", "todo"),
					}},
				},
			}, "todos"),
			Mutates:            true,
			Concurrency:        "mutate",
			RequiredOperations: []Operation{OpMaterialCreate},
		}),
		chatTool(Definition{
			Name:      "create_material",
			Retention: RetainFull,
			Description: "Create a study material from content you wrote, in the formats the " +
				"materials skill describes.",
			InputSchema: obj(map[string]any{
				"kind": map[string]any{
					"type": "string",
					"enum": []string{"quiz", "flashcards", "mindmap", "diagram", "note"},
				},
				"title": map[string]any{"type": "string", "maxLength": fieldlimits.MaterialTitle},
				"cards": map[string]any{
					"type":        "array",
					"description": "flashcards only",
					"items": obj(map[string]any{
						"front": map[string]any{"type": "string"},
						"back":  map[string]any{"type": "string"},
					}, "front", "back"),
				},
				"questions": map[string]any{
					"type":        "array",
					"description": "quiz only: question JSON.",
					// Deliberately open: Go's materialdoc validates each question.
					"items": map[string]any{"type": "object", "additionalProperties": true},
				},
				"content": map[string]any{
					"type":        "string",
					"description": "note, mindmap or diagram only: markdown.",
				},
				"scope":       scopeSchema(),
				"chapter_id":  str("The chapter to file it in; omit to leave it unfiled."),
				"excerpt_ids": idList("Library excerpts it was written from; they become its attribution.", 0, 32),
				"todo":        todoSchema(),
			}, "kind"),
			Mutates:            true,
			Concurrency:        "mutate",
			RequiredOperations: []Operation{OpMaterialCreate},
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
				"todo":        todoSchema(),
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
				"todo":        todoSchema(),
			}, "deck_id", "slide", "svg"),
			Mutates:            true,
			Concurrency:        "mutate",
			RequiredOperations: []Operation{OpMaterialCreate},
		}),
		chatTool(Definition{
			Name:      "resolve_source_change",
			Retention: RetainFull,
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
				"ids. Inspect before editing; never take edit positions from search results.",
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
				"the whole call. Edits save directly, each with an Undo; no formatting, media or PDF edits.",
			InputSchema: obj(map[string]any{
				"target": resourceTarget("The document to edit."),
				"commands": map[string]any{
					"type":     "array",
					"minItems": 1,
					"maxItems": 20,
					"items":    editCommandSchema(),
				},
				"excerpt_ids": idList("Library excerpts the added content was written from.", 0, 32),
				"todo":        todoSchema(),
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
