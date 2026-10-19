// Package embeds is the catalog of what a material document may hold: every
// element type with its keys and placement, the rich embed kinds (charts,
// diagrams, interactive HTML, embedded quizzes and flashcard sets) with their
// name in each layer, the material kinds, and the limits they share.
//
// Every layer is tested against it rather than run from it (todo-embeds.md):
// Go, the browser, the collaboration server and the pipeline keep their own
// validators and renderers, and each has a test comparing its lists with this
// catalog. `pnpm gen:openapi` writes it as JSON for the pipeline, as
// TypeScript for the browser and as Rust for the collaboration server; a type
// the catalog does not list is refused everywhere (Epo 2026-10-13).
package embeds

import (
	"fmt"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
)

// Version changes when a layer must change with the catalog.
const Version = 1

// Limits shared by every validator of an embed.
const (
	// HTMLEmbedMaxBytes bounds one interactive HTML snippet (UTF-8 bytes) and
	// HTMLEmbedMaxCount the interactive blocks of one document.
	HTMLEmbedMaxBytes = 64 << 10
	HTMLEmbedMaxCount = 10
	// BlockCaptionMax bounds an interactive block's caption (characters).
	BlockCaptionMax = 300
	// A resizable block stores its width as a whole percentage in this range.
	MediaWidthMin = 20
	MediaWidthMax = 100
)

// Material kinds.
const (
	Note       = "note"
	Quiz       = "quiz"
	Flashcards = "flashcards"
	Mindmap    = "mindmap"
	Diagram    = "diagram"
)

var allMaterials = []string{Note, Quiz, Flashcards, Mindmap, Diagram}

// Class is how an embed is stored, which decides most of its lifecycle.
type Class string

const (
	// ClassValue is an attribute of its node, replaced whole on every write.
	ClassValue Class = "value"
	// ClassLiveSource keeps its source in a shared text, so typing merges.
	ClassLiveSource Class = "live_source"
	// ClassItem is a child material row with its own rooms, referenced from a
	// note by a material_ref node.
	ClassItem Class = "item"
)

// Surfaces an embed renders on.
const (
	SurfaceChat     = "chat"     // chat answers (OpenUI)
	SurfaceNote     = "note"     // the note editor and its View
	SurfaceMaterial = "material" // a standalone material of its own
	SurfaceQuiz     = "quiz"     // inside a quiz question
	SurfaceShare    = "share"    // the public share pages
	SurfaceExport   = "export"   // DOCX, PDF and markdown export
)

// Element is one element type a material document may hold.
type Element struct {
	Type   string `json:"type"`
	Void   bool   `json:"void,omitempty"`
	Inline bool   `json:"inline,omitempty"`
	// TopLevel elements are only stored as top-level blocks.
	TopLevel bool `json:"topLevel,omitempty"`
	// Required keys besides type and children.
	Required []string `json:"required,omitempty"`
	// Fields is the closed set of keys the element may carry; nil leaves it
	// open (Plate's formatting keys).
	Fields []string `json:"fields,omitempty"`
	// Forbidden keys no stored element carries.
	Forbidden []string `json:"forbidden,omitempty"`
	// SharedText keys are held as shared text in a room, so typing merges.
	SharedText []string `json:"sharedText,omitempty"`
	// Assets are the paths naming editor assets ([] walks a list); the
	// children pass, asset pruning and clone rewrites follow them.
	Assets []string `json:"assets,omitempty"`
	// Resizable elements take a width (MediaWidthMin–MediaWidthMax %).
	Resizable bool `json:"resizable,omitempty"`
	// Children are the element types it holds, in order, when fixed.
	Children []string `json:"children,omitempty"`
	// Materials are the material kinds whose documents may hold it.
	Materials []string `json:"materials"`
}

// Fence is an embed's markdown form in notes: ```lang with a body.
type Fence struct {
	Lang string `json:"lang"`
	// Body is "json", "yaml" or "text" (the raw source).
	Body string `json:"body"`
}

// Edit names who may change an embed: the surfaces with a user editor and
// the agent tools that write it.
type Edit struct {
	User  []string `json:"user"`
	Agent []string `json:"agent"`
}

// Embed is one rich block kind and its name in each layer.
type Embed struct {
	Kind  string `json:"kind"`
	Class Class  `json:"class"`
	// Element is the node type a note holds it as; an item is a material_ref
	// whose refKind is the kind.
	Element string `json:"element"`
	Fence   Fence  `json:"fence"`
	// Chat is the OpenUI component of chat answers; empty when chat has none.
	Chat string `json:"chat,omitempty"`
	// Materials are the material kinds that hold one as their whole document.
	Materials []string `json:"materials,omitempty"`
	// QuestionBlock kinds are question blocks too: quizzes, notes and chat
	// share one schema.
	QuestionBlock bool `json:"questionBlock,omitempty"`
	// QuestionMedia kinds are what add_question_media puts under a question.
	QuestionMedia bool     `json:"questionMedia,omitempty"`
	Surfaces      []string `json:"surfaces"`
	Edit          Edit     `json:"edit"`
	// Schema is the JSON Schema of the block the agent writes, when one is
	// checked before the validators.
	Schema map[string]any `json:"schema,omitempty"`
	// Rules are what the agent is told about the kind wherever it writes one:
	// the note format (agenttools) and the chat component (chat/schema.ts)
	// quote them.
	Rules string `json:"rules,omitempty"`
}

// MaterialKind is one kind of material row.
type MaterialKind struct {
	Kind string `json:"kind"`
	// Requires is the element its document must hold.
	Requires string `json:"requires,omitempty"`
	// Item kinds are edited in their own item rooms, and a note embeds one
	// through a material_ref whose refKind is the kind.
	Item bool `json:"item,omitempty"`
}

// Catalog is the whole generated value.
type Catalog struct {
	Version       int            `json:"version"`
	Elements      []Element      `json:"elements"`
	Embeds        []Embed        `json:"embeds"`
	MaterialKinds []MaterialKind `json:"materialKinds"`
	// Limits are by name (the Rust file declares each as a constant).
	Limits map[string]int `json:"limits"`
}

// Limit is one named bound, under the name every layer uses.
type Limit struct {
	Name  string `json:"name"`
	Value int    `json:"value"`
}

func plain(typ string) Element {
	return Element{Type: typ, Materials: allMaterials}
}

func void(typ string) Element {
	e := plain(typ)
	e.Void = true
	return e
}

func inline(typ string, isVoid bool) Element {
	e := plain(typ)
	e.Inline, e.Void = true, isVoid
	return e
}

// media is an uploaded file: it names its editor asset, never a URL. One
// that does not resize stores no width (audio, Epo 2026-10-18).
func media(typ string, resizable bool) Element {
	e := void(typ)
	e.Required = []string{"assetId"}
	e.Forbidden = []string{"url", "src"}
	if !resizable {
		e.Forbidden = append(e.Forbidden, "width")
	}
	e.Assets = []string{"assetId"}
	e.Resizable = resizable
	return e
}

// figure is a chart, plot or graph: one question block under `block`.
func figure(typ string) Element {
	e := void(typ)
	e.TopLevel = true
	e.Required = []string{"id", "block"}
	e.Fields = []string{"type", "id", "block", "children", "width"}
	e.Resizable = true
	return e
}

// opaque are the bulk keys an item document never stores on its nodes.
var opaque = []string{"questions", "cards", "code"}

// Elements lists every element type in a stored document or a room. Plate's
// transient ones (a media placeholder while it uploads, the mention and slash
// inputs while typing) are documents' nodes too, so they are listed.
func Elements() []Element {
	quiz := plain("quiz")
	quiz.Required = []string{"id"}
	quiz.Forbidden = append(append([]string{}, opaque...), "timeLimitMin")
	quiz.Children = []string{"quiz_question"}
	quiz.Materials = []string{Quiz}

	question := void("quiz_question")
	question.Required = []string{"id", "question"}
	question.Forbidden = append(append([]string{}, opaque...),
		"questionType", "level", "points", "rubrics", "pairs", "acceptedAnswers", "hints",
		"correctOptionIds", "correctBoolean")
	question.Assets = []string{
		"question.stem[].image.assetId",
		"question.parts[].blocks[].image.assetId",
		"question.parts[].solution[].image.assetId",
	}
	question.Materials = []string{Quiz}

	cards := plain("flashcards")
	cards.Required = []string{"id"}
	cards.Forbidden = opaque
	cards.Children = []string{"flashcard"}
	cards.Materials = []string{Flashcards}

	card := plain("flashcard")
	card.Required = []string{"id"}
	card.Forbidden = opaque
	card.Children = []string{"flashcard_front", "flashcard_back"}
	card.Assets = []string{"image.assetId"}
	card.Materials = []string{Flashcards}

	front, back := plain("flashcard_front"), plain("flashcard_back")
	front.Materials, back.Materials = []string{Flashcards}, []string{Flashcards}

	mermaid := plain("mermaid")
	mermaid.Required = []string{"id", "source"}
	mermaid.Forbidden = opaque
	mermaid.SharedText = []string{"source"}
	mermaid.Resizable = true
	mermaid.Children = []string{"mermaid_caption"}

	html := void("html_embed")
	html.TopLevel = true
	html.Required = []string{"id", "html"}
	html.Fields = []string{"type", "id", "html", "caption", "children"}

	ref := void("material_ref")
	ref.TopLevel = true
	ref.Required = []string{"id", "materialId", "refKind"}
	ref.Forbidden = []string{"pending"}
	ref.Materials = []string{Note}

	video := void("video")
	video.Required = []string{"provider", "videoId"}
	video.Forbidden = []string{"assetId", "url", "src"}
	video.Resizable = true

	return []Element{
		plain("p"),
		plain("h1"), plain("h2"), plain("h3"), plain("h4"), plain("h5"), plain("h6"),
		plain("blockquote"),
		void("hr"),
		plain("code_block"), plain("code_line"),
		plain("table"), plain("tr"), plain("td"), plain("th"),
		void("toc"),
		plain("callout"),
		plain("column_group"), plain("column"),
		void("equation"),
		inline("inline_equation", true),
		inline("a", false),
		inline("mention", true),
		inline("mention_input", true),
		inline("slash_input", true),
		media("img", true), media("audio", false),
		video,
		void("placeholder"),
		figure("chart"), figure("plot"), figure("graph"),
		html,
		mermaid, plain("mermaid_caption"),
		ref,
		quiz, question,
		cards, card, front, back,
	}
}

// Embeds lists the rich block kinds.
func Embeds() []Embed {
	writeNote := []string{"create_material", "edit_document"}
	return []Embed{
		{
			Kind: "chart", Class: ClassValue, Element: "chart",
			Fence: Fence{Lang: "chart", Body: "json"}, Chat: "Chart",
			QuestionBlock: true, QuestionMedia: true,
			Surfaces: []string{SurfaceChat, SurfaceNote, SurfaceQuiz, SurfaceShare, SurfaceExport},
			Edit: Edit{
				User:  []string{SurfaceNote, SurfaceQuiz},
				Agent: []string{"create_material", "edit_document", "add_question_media"},
			},
			Schema: chartSchema(),
		},
		{
			Kind: "plot", Class: ClassValue, Element: "plot",
			Fence: Fence{Lang: "plot", Body: "json"}, Chat: "Plot",
			QuestionBlock: true, QuestionMedia: true,
			Surfaces: []string{SurfaceChat, SurfaceNote, SurfaceQuiz, SurfaceShare, SurfaceExport},
			// No plot editor yet (Epo 2026-10-13): users can only remove one.
			Edit: Edit{
				User:  []string{},
				Agent: []string{"create_material", "edit_document", "add_question_media"},
			},
			Schema: plotSchema(),
		},
		{
			// The agent writes no graph; a fence still converts (paste, export).
			Kind: "graph", Class: ClassValue, Element: "graph",
			Fence:         Fence{Lang: "graph", Body: "json"},
			QuestionBlock: true,
			Surfaces:      []string{SurfaceNote, SurfaceQuiz, SurfaceShare, SurfaceExport},
			Edit:          Edit{User: []string{SurfaceNote, SurfaceQuiz}, Agent: []string{}},
		},
		{
			Kind: "html_embed", Class: ClassValue, Element: "html_embed",
			Fence: Fence{Lang: "html-embed", Body: "yaml"}, Chat: "HtmlEmbed",
			Surfaces: []string{SurfaceChat, SurfaceNote, SurfaceShare, SurfaceExport},
			Edit:     Edit{User: []string{SurfaceNote}, Agent: writeNote},
			Rules:    htmlEmbedRules,
		},
		{
			Kind: "mermaid", Class: ClassLiveSource, Element: "mermaid",
			Fence: Fence{Lang: "mermaid", Body: "text"}, Chat: "Mermaid",
			Materials: []string{Mindmap, Diagram},
			Surfaces:  []string{SurfaceChat, SurfaceNote, SurfaceMaterial, SurfaceShare, SurfaceExport},
			Edit:      Edit{User: []string{SurfaceNote, SurfaceMaterial}, Agent: writeNote},
		},
		{
			Kind: "quiz", Class: ClassItem, Element: "material_ref",
			Fence:     Fence{Lang: "quiz", Body: "yaml"},
			Materials: []string{Quiz},
			Surfaces:  []string{SurfaceNote, SurfaceMaterial, SurfaceShare, SurfaceExport},
			Edit: Edit{
				User:  []string{SurfaceNote, SurfaceMaterial},
				Agent: []string{"create_material", "edit_document", "add_questions", "add_question_media"},
			},
		},
		{
			Kind: "flashcards", Class: ClassItem, Element: "material_ref",
			Fence:     Fence{Lang: "flashcards", Body: "yaml"},
			Materials: []string{Flashcards},
			Surfaces:  []string{SurfaceNote, SurfaceMaterial, SurfaceShare, SurfaceExport},
			Edit:      Edit{User: []string{SurfaceNote, SurfaceMaterial}, Agent: writeNote},
		},
	}
}

// htmlEmbedRules are the HTML embed's rules: notes and chat draw it in the
// same sandboxed frame (src/features/materials/HtmlEmbed.tsx, embed/).
var htmlEmbedRules = fmt.Sprintf("The html is one small snippet under %d KB: inline CSS and "+
	"script; a library may load (script src, stylesheet link or module import) only from "+
	"https://cdnjs.cloudflare.com, https://cdn.jsdelivr.net, https://esm.sh or https://unpkg.com "+
	"at an exact version, and nothing else reaches the network (no other src or href, no "+
	"fetch, no navigating the page); colours only from the provided variables --bg, --fg, "+
	"--muted, --accent and --border so it follows the light and dark theme, height fitting "+
	"its content with no vh or vw units. The frame already gives the body the page's font "+
	"(--font), text colour, no margin and a transparent background, and form controls the "+
	"accent colour, so style only what differs.", HTMLEmbedMaxBytes>>10)

// RulesOf returns the agent rules of an embed kind.
func RulesOf(kind string) string {
	for _, e := range Embeds() {
		if e.Kind == kind {
			return e.Rules
		}
	}
	return ""
}

// MaterialKinds lists the material kinds and what each document must hold.
func MaterialKinds() []MaterialKind {
	return []MaterialKind{
		{Kind: Note},
		{Kind: Quiz, Requires: "quiz", Item: true},
		{Kind: Flashcards, Requires: "flashcards", Item: true},
		{Kind: Mindmap, Requires: "mermaid"},
		{Kind: Diagram, Requires: "mermaid"},
	}
}

// Limits lists the embed limits, then the question bounds every question
// validator shares (fieldlimits.QuestionBounds).
func Limits() []Limit {
	out := []Limit{
		{"HTML_EMBED_MAX_BYTES", HTMLEmbedMaxBytes},
		{"HTML_EMBED_MAX_COUNT", HTMLEmbedMaxCount},
		{"BLOCK_CAPTION_MAX", BlockCaptionMax},
		{"MEDIA_WIDTH_MIN", MediaWidthMin},
		{"MEDIA_WIDTH_MAX", MediaWidthMax},
		{"CARD_FRONT_MAX", fieldlimits.CardFront},
		{"CARD_BACK_MAX", fieldlimits.CardBack},
	}
	for _, name := range fieldlimits.QuestionBoundNames() {
		out = append(out, Limit{name, fieldlimits.QuestionBounds[name]})
	}
	return out
}

// Get returns the whole catalog.
func Get() Catalog {
	limits := map[string]int{}
	for _, l := range Limits() {
		limits[l.Name] = l.Value
	}
	return Catalog{
		Version:       Version,
		Elements:      Elements(),
		Embeds:        Embeds(),
		MaterialKinds: MaterialKinds(),
		Limits:        limits,
	}
}

// ElementOf returns the element of type typ.
func ElementOf(typ string) (Element, bool) {
	for _, e := range Elements() {
		if e.Type == typ {
			return e, true
		}
	}
	return Element{}, false
}

// MediaSchemas are the schemas of the kinds add_question_media writes, by kind.
func MediaSchemas() map[string]any {
	out := map[string]any{}
	for _, e := range Embeds() {
		if e.QuestionMedia {
			out[e.Kind] = e.Schema
		}
	}
	return out
}

func obj(props map[string]any, required ...string) map[string]any {
	schema := map[string]any{"type": "object", "additionalProperties": false, "properties": props}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

var (
	label  = map[string]any{"type": "string", "maxLength": fieldlimits.QuestionMetadata}
	number = map[string]any{"type": "number"}
)

func list(min, max int, items map[string]any) map[string]any {
	return map[string]any{"type": "array", "minItems": min, "maxItems": max, "items": items}
}

// chartSchema and plotSchema mirror questions.ValidateBlock, which stays the
// backstop; the retrieval service checks agent media against them first.
func chartSchema() map[string]any {
	title := map[string]any{"type": "string", "maxLength": fieldlimits.QuestionChartTitle}
	return obj(map[string]any{
		"type":   map[string]any{"const": "chart"},
		"kind":   map[string]any{"enum": []string{"bar", "hbar", "line", "area", "pie", "stacked"}},
		"title":  title,
		"labels": list(1, fieldlimits.QuestionChartLabels, map[string]any{"type": "string", "maxLength": fieldlimits.QuestionChartLabel}),
		"series": list(1, fieldlimits.QuestionChartSeries, obj(map[string]any{
			// null is an empty cell, drawn as nothing.
			"name": map[string]any{"type": "string", "maxLength": fieldlimits.QuestionChartSeriesName}, "values": map[string]any{"type": "array", "items": map[string]any{
				"type": []string{"number", "null"}, "minimum": -fieldlimits.QuestionChartValue, "maximum": fieldlimits.QuestionChartValue,
			}},
		}, "name", "values")),
		"xTitle": title, "yTitle": title,
		"gridlines": map[string]any{"enum": []string{"normal", "fine"}},
	}, "type", "kind", "title", "labels", "series")
}

func plotSchema() map[string]any {
	return obj(map[string]any{
		"type": map[string]any{"const": "plot"}, "kind": map[string]any{"enum": []string{"line", "scatter"}},
		"title": label, "xTitle": label, "yTitle": label, "unit": label,
		// A scatter series needs one point, a line two (questions.ValidateBlock).
		"series": list(1, fieldlimits.QuestionPlotSeries, obj(map[string]any{
			"name":   label,
			"points": list(1, fieldlimits.QuestionPlotPoints, list(2, 2, number)),
		}, "name", "points")),
		"lines": list(0, fieldlimits.QuestionPlotMarks, obj(map[string]any{
			"axis": map[string]any{"enum": []string{"x", "y"}}, "value": number, "label": label,
		}, "axis", "value")),
		"marks": list(0, fieldlimits.QuestionPlotMarks, obj(map[string]any{
			"x": number, "y": number, "label": label,
		}, "x", "y", "label")),
	}, "type", "title", "xTitle", "yTitle", "series")
}
