package materialdoc

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/samyung0/capy-notebook/server/internal/questions"
)

// The list-card preview of a material (openwiki/thumbnails.md): a small,
// answer-free summary of its content that every list row carries, so cards
// draw without loading documents. Writers of materials.content store it
// alongside (materials.preview); a preview stays at about 1 KB of JSON.
const (
	previewMaxBlocks   = 8
	previewMaxRunes    = 600 // a note's text across all its blocks
	previewTableRows   = 4
	previewTableCells  = 4
	previewCodeLines   = 6
	previewStemRunes   = 200
	previewChoices     = 4
	previewChoiceRunes = 60
	previewFrontRunes  = 200
	previewSourceBytes = 1024
	// previewGap stands for one numbered blank of a gaps question's text.
	previewGap = "\u0001"
)

type previewBlock struct {
	T     string     `json:"t"`
	Text  string     `json:"text,omitempty"`
	Level int        `json:"level,omitempty"`
	Items any        `json:"items,omitempty"` // []string for ul, []previewTodo for todo
	Rows  [][]string `json:"rows,omitempty"`
	Tex   string     `json:"tex,omitempty"`
	Lang  string     `json:"lang,omitempty"`
}

type previewTodo struct {
	Done bool   `json:"done"`
	Text string `json:"text"`
}

type notePreview struct {
	Kind   string         `json:"kind"`
	Blocks []previewBlock `json:"blocks"`
}

type quizPreview struct {
	Kind          string           `json:"kind"`
	QuestionCount int              `json:"questionCount"`
	First         *questionPreview `json:"first,omitempty"`
}

// questionPreview carries no answer key. Matching shows only its left-hand
// prompts (the right-hand options and the pairing are the key) and ordering
// only how many items it has (any order of them could be the answer).
type questionPreview struct {
	Type      string   `json:"type"`
	Stem      string   `json:"stem"`
	Options   []string `json:"options,omitempty"`
	Prompts   []string `json:"prompts,omitempty"`
	ItemCount int      `json:"itemCount,omitempty"`
	HasChart  bool     `json:"hasChart,omitempty"`
}

type flashcardsPreview struct {
	Kind      string       `json:"kind"`
	CardCount int          `json:"cardCount"`
	First     *cardPreview `json:"first,omitempty"`
}

type cardPreview struct {
	Front    string `json:"front"`
	HasImage bool   `json:"hasImage"`
}

type diagramPreview struct {
	Kind   string `json:"kind"`
	Source string `json:"source"`
}

// Preview is the list-card preview of stored content of the given material
// kind; nil for a kind without one.
func Preview(kind, raw string) (json.RawMessage, error) {
	doc, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	return preview(kind, doc.Value)
}

// Preview is Preview for the projection's value.
func (p Projection) Preview(kind string) (json.RawMessage, error) {
	return preview(kind, p.value)
}

func preview(kind string, nodes []map[string]any) (json.RawMessage, error) {
	var value any
	switch kind {
	case "note":
		value = notePreview{Kind: kind, Blocks: noteBlocks(nodes)}
	case "quiz":
		value = quizPreviewOf(nodes)
	case "flashcards":
		value = flashcardsPreviewOf(nodes)
	case "mindmap", "diagram":
		value = diagramPreview{Kind: kind, Source: clipLines(diagramSource(nodes), previewSourceBytes)}
	default:
		return nil, nil
	}
	return marshalCanonicalJSON(value)
}

// Media, embeds and diagrams have no preview block; containers are read
// through.
var previewSkipped = set("hr", "toc", "audio", "video", "mermaid", "diagram", "mindmap",
	"chart", "plot", "graph", HTMLEmbedType, RefType, "quiz", "flashcards")

type noteBuilder struct {
	blocks []previewBlock
	runes  int // text runes left
}

func noteBlocks(nodes []map[string]any) []previewBlock {
	b := &noteBuilder{blocks: []previewBlock{}, runes: previewMaxRunes}
	b.walk(nodes)
	return b.blocks
}

func (b *noteBuilder) walk(nodes []map[string]any) {
	for _, node := range nodes {
		if b.runes <= 0 || len(b.blocks) == previewMaxBlocks {
			return
		}
		b.add(node)
	}
}

// take clips text to the runes left and spends them.
func (b *noteBuilder) take(text string) string {
	text = clipRunes(text, b.runes)
	b.runes -= utf8.RuneCountInString(text)
	return text
}

// last returns the previous block when it has type t, so list items merge.
func (b *noteBuilder) last(t string) *previewBlock {
	if n := len(b.blocks); n > 0 && b.blocks[n-1].T == t {
		return &b.blocks[n-1]
	}
	return nil
}

func (b *noteBuilder) add(node map[string]any) {
	typ, _ := node["type"].(string)
	switch {
	case indexContainers[typ]:
		b.walk(children(node))
	case previewSkipped[typ]:
	case typ == "img":
		b.blocks = append(b.blocks, previewBlock{T: "image"})
	case typ == "equation":
		if tex, _ := node["texExpression"].(string); strings.TrimSpace(tex) != "" {
			b.blocks = append(b.blocks, previewBlock{T: "math", Tex: b.take(tex)})
		}
	case typ == "code_block":
		var lines []string
		for _, line := range children(node) {
			if len(lines) == previewCodeLines {
				break
			}
			lines = append(lines, nodeText(line))
		}
		if text := strings.Join(lines, "\n"); strings.TrimSpace(text) != "" {
			lang, _ := node["lang"].(string)
			b.blocks = append(b.blocks, previewBlock{T: "code", Text: b.take(text), Lang: lang})
		}
	case typ == "table":
		var rows [][]string
		for _, tr := range children(node) {
			if len(rows) == previewTableRows || b.runes <= 0 {
				break
			}
			cells := []string{}
			for _, td := range children(tr) {
				if len(cells) == previewTableCells {
					break
				}
				cells = append(cells, b.take(strings.TrimSpace(nodeText(td))))
			}
			rows = append(rows, cells)
		}
		if len(rows) > 0 {
			b.blocks = append(b.blocks, previewBlock{T: "table", Rows: rows})
		}
	default:
		b.addText(node, typ)
	}
}

func (b *noteBuilder) addText(node map[string]any, typ string) {
	text := strings.TrimSpace(nodeText(node))
	if text == "" {
		return
	}
	style, _ := node["listStyleType"].(string)
	switch {
	case len(typ) == 2 && typ[0] == 'h' && typ[1] >= '1' && typ[1] <= '6':
		b.blocks = append(b.blocks, previewBlock{T: "h", Text: b.take(text), Level: int(typ[1] - '0')})
	case typ == "blockquote":
		b.blocks = append(b.blocks, previewBlock{T: "quote", Text: b.take(text)})
	case typ == "p" && style == "todo":
		done, _ := node["checked"].(bool)
		item := previewTodo{Done: done, Text: b.take(text)}
		if last := b.last("todo"); last != nil {
			last.Items = append(last.Items.([]previewTodo), item)
		} else {
			b.blocks = append(b.blocks, previewBlock{T: "todo", Items: []previewTodo{item}})
		}
	case typ == "p" && style != "":
		item := b.take(text)
		if last := b.last("ul"); last != nil {
			last.Items = append(last.Items.([]string), item)
		} else {
			b.blocks = append(b.blocks, previewBlock{T: "ul", Items: []string{item}})
		}
	default:
		b.blocks = append(b.blocks, previewBlock{T: "p", Text: b.take(text)})
	}
}

func quizPreviewOf(nodes []map[string]any) quizPreview {
	out := quizPreview{Kind: "quiz"}
	quiz := find(nodes, "quiz")
	if quiz == nil {
		return out
	}
	for _, child := range childrenOfType(quiz, "quiz_question") {
		q, ok := child["question"].(map[string]any)
		if !ok {
			continue
		}
		out.QuestionCount++
		if out.First == nil {
			out.First = questionPreviewOf(q)
		}
	}
	return out
}

// questionPreviewOf reads the first part as a card shows it: its text, or the
// question stem when the part has none.
func questionPreviewOf(q map[string]any) *questionPreview {
	stem, _ := q["stem"].([]any)
	var partBlocks []any
	var answer map[string]any
	if parts, _ := q["parts"].([]any); len(parts) > 0 {
		part, _ := parts[0].(map[string]any)
		partBlocks, _ = part["blocks"].([]any)
		answer, _ = part["answer"].(map[string]any)
	}
	typ, _ := answer["type"].(string)
	out := &questionPreview{Type: typ}
	text := blocksPlainText(partBlocks)
	if text == "" {
		text = blocksPlainText(stem)
	}
	if typ == "gaps" {
		text = questions.GapMarker.ReplaceAllLiteralString(text, previewGap)
	}
	out.Stem = clipRunes(text, previewStemRunes)
	for _, raw := range append(append([]any{}, stem...), partBlocks...) {
		if block, _ := raw.(map[string]any); block["type"] == "chart" || block["type"] == "plot" || block["type"] == "graph" {
			out.HasChart = true
		}
	}
	switch typ {
	case "mcq":
		options, _ := answer["options"].([]any)
		out.Options = clippedChoices(options)
	case "matching":
		var prompts []any
		pairs, _ := answer["pairs"].([]any)
		for _, raw := range pairs {
			pair, _ := raw.(map[string]any)
			prompts = append(prompts, pair["left"])
		}
		out.Prompts = clippedChoices(prompts)
	case "ordering":
		items, _ := answer["items"].([]any)
		out.ItemCount = len(items)
	}
	return out
}

// blocksPlainText joins a question's text blocks.
func blocksPlainText(blocks []any) string {
	var texts []string
	for _, raw := range blocks {
		block, _ := raw.(map[string]any)
		if text, _ := block["text"].(string); block["type"] == "text" && strings.TrimSpace(text) != "" {
			texts = append(texts, strings.TrimSpace(text))
		}
	}
	return strings.Join(texts, " ")
}

// clippedChoices keeps the first previewChoices strings, each clipped.
func clippedChoices(values []any) []string {
	var out []string
	for _, value := range values {
		if len(out) == previewChoices {
			break
		}
		if text, ok := value.(string); ok {
			out = append(out, clipRunes(text, previewChoiceRunes))
		}
	}
	return out
}

func flashcardsPreviewOf(nodes []map[string]any) flashcardsPreview {
	out := flashcardsPreview{Kind: "flashcards"}
	deck := find(nodes, "flashcards")
	if deck == nil {
		return out
	}
	cards := childrenOfType(deck, "flashcard")
	out.CardCount = len(cards)
	if len(cards) > 0 {
		front := strings.TrimSpace(nodeText(firstChild(cards[0], "flashcard_front")))
		out.First = &cardPreview{
			Front:    clipRunes(front, previewFrontRunes),
			HasImage: cardImage(cards[0]) != nil,
		}
	}
	return out
}

func diagramSource(nodes []map[string]any) string {
	for _, typ := range []string{"mermaid", "diagram", "mindmap"} {
		if node := find(nodes, typ); node != nil {
			source, _ := node["source"].(string)
			return source
		}
	}
	return ""
}

// clipRunes keeps at most n whole characters of s.
func clipRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i]
		}
		count++
	}
	return s
}

// clipLines keeps the whole lines of s that fit in max bytes.
func clipLines(s string, max int) string {
	if len(s) <= max {
		return s
	}
	if cut := strings.LastIndexByte(s[:max+1], '\n'); cut >= 0 {
		return s[:cut]
	}
	return ""
}
