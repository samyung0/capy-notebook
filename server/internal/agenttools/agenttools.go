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
const ContractVersion = 11

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
				"markdown":       text("Note markdown, in the format create_material takes for a note, fences included."),
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
				"question":    map[string]any{"type": "object", "additionalProperties": true, "description": questionJSONDescription},
			}, "question_id", "question"),
			variant("add_question", map[string]any{
				"question":          map[string]any{"type": "object", "additionalProperties": true, "description": questionJSONDescription},
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
const noteMarkdownDescription = "mindmap/diagram/note only. Markdown. A mindmap or diagram is one " +
	"```mermaid fence. A note may also hold, where they help an idea: ```mermaid fences; " +
	"```quiz fences (YAML `questions:` list, each in the quiz question format) and " +
	"```flashcards fences (YAML `cards:` list of `front`/`back`), each a mini check of 2 to 4 " +
	"items; and ```html-embed fences for an interactive (YAML: `title`, `fallback`, `html: |`). " +
	"The html is one self-contained snippet under 64 KB: inline CSS and script, no network, " +
	"no external URLs, colours from the variables --bg, --fg, --muted, --accent and --border so " +
	"it follows the light and dark theme, height fitting its content. The fallback is the plain " +
	"text a reader sees in export or where scripts cannot run, so it states what the interactive " +
	"shows. Use an interactive only where moving something teaches more than a diagram."

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
			Name:      "search_workspace",
			Retention: RetainCitedPassages,
			Description: "Search the user's sources for passages relevant to a query. One " +
				"call per assistant message, with one focused query. Search again " +
				"in a later step rather than concatenating several questions.",
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
			Description: "List source files by chapter and workspace study materials, with " +
				"ids, resource kinds and editability. Source files include passage counts and short descriptors.",
			InputSchema:        obj(map[string]any{}),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpSourceRead, OpMaterialRead},
		}),
		chatTool(Definition{
			Name:      "read_document",
			Retention: RetainCitedPassages,
			Description: "Read a source file or note in order from a given chunk index. Use after " +
				"search when a passage needs its surrounding argument, or to walk " +
				"a short document end to end.",
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
			Description: "Render one source page, or a boxed region of it, and read it " +
				"directly as an image. Use the file_id and 1-based page shown with a " +
				"passage; only pages a shown passage cites can be captured. bbox is " +
				"optional: [x0, y0, x1, y1] on a 0-1000 grid over the page, origin " +
				"top-left, to zoom into a table, figure or formula. An uploaded image " +
				"is one page: capture page 1 to see it; on a low-resolution image a " +
				"bbox crops without adding detail, so the zoom may not help. Costs " +
				"one tool call and a few seconds.",
			InputSchema: obj(map[string]any{
				"file_id": str(""),
				"page":    map[string]any{"type": "integer", "minimum": 1},
				"bbox": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "number", "minimum": 0, "maximum": 1000},
					"minItems":    4,
					"maxItems":    4,
					"description": "Region to zoom into on the 0-1000 page grid, top-left origin.",
				},
			}, "file_id", "page"),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpSourceRead},
		}),
		chatTool(Definition{
			Name:      "read_study_progress",
			Retention: RetainFull,
			Description: "Read the learner's own study progress in this workspace: the files " +
				"and materials marked done, started or removed, recent quiz results, and the " +
				"chapters whose questions and cards they retain least. Use it to decide what " +
				"to build or practise next; it is read-only.",
			InputSchema:        obj(map[string]any{}),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpSourceRead},
		}),
		chatTool(Definition{
			Name:      "search_knowledge",
			Retention: RetainNone,
			Description: "Search the shared knowledge library of verified textbook excerpts. One " +
				"excerpt is one section of one book. `roles` filters what the excerpt teaches: " +
				"introduction, formal, worked_example, exercise, summary, reference. Results " +
				"include the hit passage and reviewed scope; full notes are in read_knowledge. " +
				"`topics` takes the exact `topic_id` values returned by " +
				"browse_knowledge({\"subject\": \"<subject ID>\"}); omit it for a direct or " +
				"cross-topic search. Subject IDs and labels are not topic filters. Use this when " +
				"you need a specific role or a specific idea; an empty result under a role " +
				"filter reports what those topics do hold by role, so relax the filter on " +
				"purpose instead of rewording.",
			InputSchema: obj(map[string]any{
				"query":  str(""),
				"topics": idList("Exact topic_id values returned by browse_knowledge with a subject. Subject IDs and labels are not accepted. Omit for a direct search.", 0, 8),
				"roles":  idList("Excerpt roles to restrict to.", 0, 6),
			}, "query"),
			UsesEmbedding:      true,
			Concurrency:        "read",
			RequiredOperations: []Operation{OpLibraryRead},
		}),
		chatTool(Definition{
			Name:      "browse_knowledge",
			Retention: RetainNone,
			Description: "List what the library holds. Pass exactly one of `subject` or `topic`. " +
				"Use a subject browse call listed below to retrieve its topics with excerpt counts. " +
				"Subject IDs are only for `subject`; use the returned `topic_id` values in " +
				"search_knowledge.topics or this tool's `topic`. A topic ID returns verified " +
				"excerpt counts by role and by book, then a page of excerpts with their section " +
				"paths and reviewed scope. Browse when you need topic IDs or coverage; a direct " +
				"search needs no preceding browse.",
			InputSchema: obj(map[string]any{
				"subject": str("Subject ID from a browse call in this tool's description. Retrieves topic IDs for search_knowledge.topics."),
				"topic":   str("Exact topic_id returned by a subject browse. Retrieves excerpt coverage; do not pass a subject ID or label."),
				"page":    map[string]any{"type": "integer", "minimum": 1, "default": 1},
			}),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpLibraryRead},
		}),
		chatTool(Definition{
			Name:      "read_knowledge",
			Retention: RetainUsedExcerpts,
			Description: "Read an excerpt's full reviewed notes and original source chunks, in " +
				"order from a chunk index. Always read an excerpt before writing a material from " +
				"it; a search hit is one chunk of it. The scope field explains applicability and " +
				"when linked source context is needed; follow links relevant to the chosen " +
				"example or claim. Use next start to continue an excerpt; notes appear on its " +
				"first page.",
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
			Description: "List the question bank of reviewed exam questions, for practice to " +
				"reuse before writing new questions. Pass subject, a bank subject listed " +
				"below (not a library subject), for its syllabus topics and question " +
				"counts, or topic for its questions as compact cards, 50 at a time from " +
				"offset. read_question returns a question in full.",
			InputSchema: obj(map[string]any{
				"subject": str("A bank subject id from this description."),
				"topic":   str("A topic id from a subject's list."),
				"offset":  map[string]any{"type": "integer", "minimum": 0, "default": 0},
			}),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpLibraryRead},
		}),
		chatTool(Definition{
			Name:      "read_question",
			Retention: RetainFull,
			Description: "Read one question-bank question in full: its JSON, to copy into a " +
				"quiz unchanged, with its worked solution, marking scheme and sources.",
			InputSchema: obj(map[string]any{
				"question_id": str(""),
			}, "question_id"),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpLibraryRead},
		}),
		chatTool(Definition{
			Name:      "capture_knowledge_page",
			Retention: RetainNone,
			Description: "Render one printed page of the book an excerpt comes from, or a boxed " +
				"region of it, and read it directly as an image. Only pages the excerpt " +
				"covers, or the page of one of its figures, can be captured. bbox is " +
				"optional: [x0, y0, x1, y1] on a 0-1000 grid over the page, origin " +
				"top-left, to zoom into a figure, table or formula. Use it when the text " +
				"of an excerpt does not carry the layout the material needs.",
			InputSchema: obj(map[string]any{
				"excerpt_id": str(""),
				"page":       map[string]any{"type": "integer", "minimum": 1},
				"bbox": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "number", "minimum": 0, "maximum": 1000},
					"minItems":    4,
					"maxItems":    4,
					"description": "Region to zoom into on the 0-1000 page grid, top-left origin.",
				},
			}, "excerpt_id", "page"),
			Concurrency:        "read",
			RequiredOperations: []Operation{OpLibraryRead},
		}),
		chatTool(Definition{
			Name:      "create_ledger",
			Retention: RetainNone,
			Description: "Add or edit todos on the conversation's ledger when building more than " +
				"one item: one todo per material or section to write. Each string in todos adds " +
				"a new todo with an assigned ID. An object {id, todo} adds that ID or overwrites " +
				"its text. Use fresh IDs for new todos; completed IDs are not reused. Unmentioned " +
				"todos stay unchanged. Pass only additions or edits, not the whole list. At most " +
				"10 unfinished todos may exist. A material write marks its todo done; editing " +
				"todo text does not change completion.",
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
			Description: "Create a study material in this workspace from content you already " +
				"wrote: a note, quiz, flashcard deck, mindmap or diagram. A learner asking to " +
				"learn, make or practise something is a request for materials, so do not ask " +
				"whether to create one. Ground the content in passages or excerpts you have " +
				"read. While the ledger has open todos, pass todo, the id of the todo this " +
				"material completes. Pass excerpt_ids for every library excerpt it was written " +
				"from; they become its attribution footer, and each must have been read this " +
				"turn or have its full text retained in context. A search card or compacted " +
				"summary alone is not a read. Do not mix this call with retrieval tools in the " +
				"same response.",
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
					"description": "quiz only; " + questionJSONDescription,
					// Deliberately open: Go's materialdoc validates each question.
					"items": map[string]any{"type": "object", "additionalProperties": true},
				},
				"content": map[string]any{
					"type":        "string",
					"description": noteMarkdownDescription,
				},
				"scope": scopeSchema(),
				"chapter_id": str("The chapter this material is filed in, as list_sources shows it; " +
					"omit to leave it unfiled. A standalone quiz or flashcard set goes in the chapter it practises."),
				"excerpt_ids": idList(
					"Library excerpt ids this material was written from. Required for every "+
						"material built from the knowledge library; they become its attribution footer.",
					0, 32,
				),
				"todo": map[string]any{
					"type":        "integer",
					"minimum":     0,
					"description": "Id of the open ledger todo this write completes, as the turn context shows it.",
				},
			}, "kind"),
			Mutates:            true,
			Concurrency:        "mutate",
			RequiredOperations: []Operation{OpMaterialCreate},
		}),
		chatTool(Definition{
			Name:      "resolve_source_change",
			Retention: RetainFull,
			Description: "Describe an added or changed source image from an exact " +
				"pending-change placeholder. Only use identifiers supplied in the " +
				"pending-source evidence.",
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
			Description: "Read the current authoritative content of one document as " +
				"editable targets: Plate blocks with stable block ids, text lines with " +
				"offsets, DOCX/PPTX paragraphs or XLSX cells with stable ids. Always " +
				"inspect before editing; never derive edit positions from search results.",
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
			Description: "Apply content edits to one inspected document. Each command names " +
				"a stable target from inspect_document and the exact text or value it " +
				"expects to find; the whole call is refused if any expectation is stale. " +
				"Edits save directly and each result has an Undo the user can trigger. " +
				"Formatting, images, media, layout and PDF edits are not supported. To grow a " +
				"material section by section, append the next section per call rather than " +
				"rewriting the whole note; editing a material takes todo while todos are open " +
				"and excerpt_ids for appended library content. Editing one of the user's own " +
				"source files takes neither.",
			InputSchema: obj(map[string]any{
				"target": resourceTarget("The document to edit."),
				"commands": map[string]any{
					"type":     "array",
					"minItems": 1,
					"maxItems": 20,
					"items":    editCommandSchema(),
				},
				"excerpt_ids": idList(
					"Library excerpt ids the appended content was written from; "+
						"they join the material's attribution footer.",
					0, 32,
				),
				"todo": map[string]any{
					"type":        "integer",
					"minimum":     0,
					"description": "Id of the open ledger todo this write completes, as the turn context shows it.",
				},
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
