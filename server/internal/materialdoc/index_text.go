package materialdoc

import (
	"strconv"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/embeds"
)

// A note's index text is what retrieval chunks and note effects read: each
// element contributes what its embed catalog index rule says
// (openwiki/embeds.md "Index text"). The collaboration server's
// notes::index_text gives the same text per block; both read the golden
// fixtures in testdata/index_text.

// IndexBlock is the index text of one top-level block.
type IndexBlock struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

var indexRules = func() map[string]embeds.Index {
	rules := map[string]embeds.Index{}
	for _, e := range embeds.Elements() {
		rules[e.Type] = e.Index
	}
	return rules
}()

// indexRule is an element's rule. A type the catalog does not list gives its
// text, as the read-only View shows an unsupported block's text (Epo
// 2026-10-13: such a document stays readable).
func indexRule(node map[string]any) embeds.Index {
	typ, _ := node["type"].(string)
	if rule, ok := indexRules[typ]; ok {
		return rule
	}
	return embeds.IndexText
}

// ExtractIndexBlocks renders a note for retrieval, one entry per top-level
// block that has text, in document order. items holds the stored content of
// the note's embedded quizzes and flashcard sets by material id; a reference
// to an item not in it gives nothing.
func ExtractIndexBlocks(raw string, items map[string]string) ([]IndexBlock, error) {
	doc, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	// Only the referenced items are read; a reference is a top-level block.
	texts := map[string]string{}
	for _, node := range doc.Value {
		id, _ := node["materialId"].(string)
		content, ok := items[id]
		if _, done := texts[id]; !ok || done || indexRule(node) != embeds.IndexItem {
			continue
		}
		item, err := Parse(content)
		if err != nil {
			return nil, err
		}
		texts[id] = strings.Join(indexPieces(item.Value, nil), "\n\n")
	}
	var blocks []IndexBlock
	for _, node := range doc.Value {
		if pieces := indexPieces([]map[string]any{node}, texts); len(pieces) > 0 {
			id, _ := node["id"].(string)
			blocks = append(blocks, IndexBlock{ID: id, Text: strings.Join(pieces, "\n\n")})
		}
	}
	return blocks, nil
}

// JoinIndexBlocks is a note's whole index text: its blocks, a blank line apart.
func JoinIndexBlocks(blocks []IndexBlock) string {
	texts := make([]string, len(blocks))
	for i, block := range blocks {
		texts[i] = block.Text
	}
	return strings.Join(texts, "\n\n")
}

// ExtractIndexText is JoinIndexBlocks of ExtractIndexBlocks.
func ExtractIndexText(raw string, items map[string]string) (string, error) {
	blocks, err := ExtractIndexBlocks(raw, items)
	return JoinIndexBlocks(blocks), err
}

var indexContainers = set("callout", "column_group", "column", "quiz", "flashcards")

func indexPieces(nodes []map[string]any, items map[string]string) []string {
	var out []string
	for _, node := range nodes {
		writeIndexBlock(node, items, &out)
	}
	return out
}

func writeIndexBlock(node map[string]any, items map[string]string, out *[]string) {
	add := func(text string) {
		if text != "" {
			*out = append(*out, text)
		}
	}
	typ, _ := node["type"].(string)
	switch indexRule(node) {
	case embeds.IndexNone:
		return
	case embeds.IndexFigure:
		block, _ := node["block"].(map[string]any)
		add(figureIndexText(block))
		return
	case embeds.IndexMermaid:
		lines := []string{}
		if caption := strings.TrimSpace(indexNodeText(node)); caption != "" {
			lines = append(lines, caption)
		}
		if source, _ := node["source"].(string); !blank(source) {
			lines = append(lines, "```mermaid\n"+source+"\n```")
		}
		add(strings.Join(lines, "\n"))
		return
	case embeds.IndexQuestion:
		question, _ := node["question"].(map[string]any)
		*out = append(*out, questionIndexPieces(question)...)
		return
	case embeds.IndexItem:
		id, _ := node["materialId"].(string)
		add(items[id])
		return
	}
	switch {
	case indexContainers[typ]:
		for _, child := range children(node) {
			writeIndexBlock(child, items, out)
		}
		return
	case typ == "table":
		var rows []string
		for _, tr := range children(node) {
			var cells []string
			for _, td := range children(tr) {
				cells = append(cells, strings.TrimSpace(indexNodeText(td)))
			}
			if len(cells) > 0 {
				rows = append(rows, tableRow(cells))
			}
		}
		add(strings.Join(rows, "\n"))
		return
	case typ == "flashcard":
		// One card a block: its front, then its back.
		var sides []string
		for _, side := range children(node) {
			if text := strings.TrimSpace(indexNodeText(side)); text != "" {
				sides = append(sides, text)
			}
		}
		add(strings.Join(sides, "\n"))
		return
	case typ == "code_block":
		var lines []string
		for _, line := range children(node) {
			lines = append(lines, indexNodeText(line))
		}
		lang, _ := node["lang"].(string)
		add("```" + lang + "\n" + strings.Join(lines, "\n") + "\n```")
		return
	}
	text := strings.TrimSpace(indexNodeText(node))
	if text == "" {
		return
	}
	switch {
	case len(typ) == 2 && typ[0] == 'h' && typ[1] >= '1' && typ[1] <= '6':
		text = strings.Repeat("#", int(typ[1]-'0')) + " " + text
	case typ == "blockquote":
		text = "> " + text
	case typ == "p":
		if style, _ := node["listStyleType"].(string); style != "" {
			indent := 0
			if n, ok := number(node["indent"]); ok && n > 1 {
				indent = int(n) - 1
			}
			prefix := "- "
			switch style {
			case "decimal":
				prefix = "1. "
			case "todo":
				prefix = "- [ ] "
				if checked, _ := node["checked"].(bool); checked {
					prefix = "- [x] "
				}
			}
			text = strings.Repeat("  ", indent) + prefix + text
		}
	}
	*out = append(*out, text)
}

// indexNodeText is a node's text, leaving out elements whose rule is none.
func indexNodeText(node map[string]any) string {
	if text, ok := node["text"].(string); ok {
		return text
	}
	if indexRule(node) == embeds.IndexNone {
		return ""
	}
	var result strings.Builder
	for _, child := range children(node) {
		result.WriteString(indexNodeText(child))
	}
	return result.String()
}

func tableRow(cells []string) string {
	return "| " + strings.Join(cells, " | ") + " |"
}

func blank(s string) bool { return strings.TrimSpace(s) == "" }

// field is a string field as stored; blank or missing gives "".
func field(m map[string]any, key string) string {
	s, _ := m[key].(string)
	if blank(s) {
		return ""
	}
	return s
}

// formatIndexNumber writes a number in plain decimal, the shortest that reads
// back exactly, never with an exponent (Rust's f64 Display writes the same),
// and -0 as 0.
func formatIndexNumber(value any) (string, bool) {
	n, ok := number(value)
	if !ok {
		return "", false
	}
	if n == 0 {
		n = 0
	}
	return strconv.FormatFloat(n, 'f', -1, 64), true
}

// pair writes [x, y] as "(x, y)".
func pair(value any) (string, bool) {
	xy, ok := value.([]any)
	if !ok || len(xy) != 2 {
		return "", false
	}
	x, okX := formatIndexNumber(xy[0])
	y, okY := formatIndexNumber(xy[1])
	return "(" + x + ", " + y + ")", okX && okY
}

func maps(value any) []map[string]any {
	raw, _ := value.([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, v := range raw {
		if m, ok := v.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func strs(value any) []string {
	raw, _ := value.([]any)
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		s, _ := v.(string)
		out = append(out, s)
	}
	return out
}

// figureIndexText renders a chart, plot or graph block, its fields on lines
// and empty ones left out.
func figureIndexText(block map[string]any) string {
	var lines []string
	add := func(prefix, value string) {
		if value != "" {
			lines = append(lines, prefix+value)
		}
	}
	switch block["type"] {
	case "chart":
		add("", field(block, "title"))
		add("", field(block, "description"))
		add("x: ", field(block, "xTitle"))
		add("y: ", field(block, "yTitle"))
		labels, series := strs(block["labels"]), maps(block["series"])
		if len(labels) == 0 || len(series) == 0 {
			break
		}
		header, rule := []string{field(block, "xTitle")}, []string{"---"}
		for _, s := range series {
			header, rule = append(header, field(s, "name")), append(rule, "---")
		}
		lines = append(lines, tableRow(header), tableRow(rule))
		for i, label := range labels {
			row := []string{label}
			for _, s := range series {
				// Values past the labels are left out and missing ones are
				// empty, as a merged chart is repaired on read.
				values, _ := s["values"].([]any)
				cell := ""
				if i < len(values) {
					cell, _ = formatIndexNumber(values[i])
				}
				row = append(row, cell)
			}
			lines = append(lines, tableRow(row))
		}
	case "plot":
		add("", field(block, "title"))
		add("", field(block, "description"))
		add("x: ", field(block, "xTitle"))
		add("y: ", field(block, "yTitle"))
		add("unit: ", field(block, "unit"))
		for _, s := range maps(block["series"]) {
			raw, _ := s["points"].([]any)
			points := []string{}
			for _, p := range raw {
				if text, ok := pair(p); ok {
					points = append(points, text)
				}
			}
			add("", labelled(field(s, "name"), strings.Join(points, ", ")))
		}
		for _, line := range maps(block["lines"]) {
			axis, _ := line["axis"].(string)
			if value, ok := formatIndexNumber(line["value"]); ok {
				add("", labelled(axis+" = "+value, field(line, "label")))
			}
		}
		for _, mark := range maps(block["marks"]) {
			if at, ok := pair([]any{mark["x"], mark["y"]}); ok {
				add("", labelled(at, field(mark, "label")))
			}
		}
	case "graph":
		add("", field(block, "description"))
		elements := maps(block["elements"])
		points := map[string]string{}
		for _, e := range elements {
			if e["type"] != "point" {
				continue
			}
			id, _ := e["id"].(string)
			if _, seen := points[id]; seen {
				continue
			}
			if name := field(e, "name"); name != "" {
				points[id] = name
			} else if at, ok := pair(e["coords"]); ok {
				points[id] = at
			}
		}
		for _, e := range elements {
			if hidden, _ := e["hidden"].(bool); !hidden {
				add("", graphElementText(e, points))
			}
		}
	}
	return strings.Join(lines, "\n")
}

// labelled is "head: tail", or whichever of the two is not empty.
func labelled(head, tail string) string {
	switch {
	case head == "":
		return tail
	case tail == "":
		return head
	}
	return head + ": " + tail
}

// graphElementText is one graph element as stored: its type, then its term,
// points (by name, else coordinates), text or label. An element naming a
// point that is gone is left out, as a merged graph is repaired on read.
func graphElementText(e map[string]any, points map[string]string) string {
	typ, _ := e["type"].(string)
	refs := func(ids ...string) (string, bool) {
		out := make([]string, len(ids))
		for i, id := range ids {
			ref, ok := points[id]
			if !ok {
				return "", false
			}
			out[i] = ref
		}
		return strings.Join(out, ", "), true
	}
	str := func(key string) string { s, _ := e[key].(string); return s }
	var body string
	ok := true
	switch typ {
	case "functiongraph":
		body = str("term")
		if domain, okDomain := e["domain"].([]any); okDomain && len(domain) == 2 {
			a, okA := formatIndexNumber(domain[0])
			b, okB := formatIndexNumber(domain[1])
			if okA && okB {
				body += " on [" + a + ", " + b + "]"
			}
		}
	case "point":
		body, ok = pair(e["coords"])
		if name := field(e, "name"); name != "" {
			typ += " " + name
		}
	case "line", "segment", "polygon":
		body, ok = refs(strs(e["points"])...)
	case "angle":
		body, ok = refs(strs(e["points"])...)
		if label := field(e, "label"); label != "" {
			typ += " " + label
		}
	case "circle":
		var center string
		center, ok = refs(str("center"))
		radius, okRadius := formatIndexNumber(e["radius"])
		body, ok = "center "+center+", radius "+radius, ok && okRadius
	case "arc", "sector":
		var center, ends string
		center, ok = refs(str("center"))
		if ok {
			ends, ok = refs(strs(e["points"])...)
		}
		body = "center " + center + ", " + ends
	case "text":
		body = field(e, "text")
	default:
		return ""
	}
	if !ok || body == "" {
		return ""
	}
	return typ + ": " + body
}

// questionIndexPieces renders a quiz question: its stem blocks, then each
// part's blocks and options (mcq options; matching prompts, then choices,
// both in stored order, which holds no key). Worked solutions and ordering
// items (their stored order is the key) stay out: viewers chat over the
// index and never get answer keys (Epo 2026-10-06), against "stems, options
// and solutions" (Epo 2026-10-17); awaiting Epo's call.
func questionIndexPieces(q map[string]any) []string {
	var out []string
	add := func(text string) {
		if text != "" {
			out = append(out, text)
		}
	}
	blocks := func(value any) {
		for _, b := range maps(value) {
			add(questionBlockText(b))
		}
	}
	list := func(items []string) {
		var lines []string
		for _, item := range items {
			if !blank(item) {
				lines = append(lines, "- "+item)
			}
		}
		add(strings.Join(lines, "\n"))
	}
	blocks(q["stem"])
	for _, part := range maps(q["parts"]) {
		blocks(part["blocks"])
		answer, _ := part["answer"].(map[string]any)
		switch answer["type"] {
		case "mcq":
			list(strs(answer["options"]))
		case "matching":
			var lefts []string
			for _, pair := range maps(answer["pairs"]) {
				left, _ := pair["left"].(string)
				lefts = append(lefts, left)
			}
			list(lefts)
			list(strs(answer["options"]))
		}
	}
	return out
}

// questionBlockText is one question block: a text's label and text, a
// figure's rendering, a table's rows or an image's description.
func questionBlockText(b map[string]any) string {
	switch b["type"] {
	case "text":
		return labelledLines(field(b, "label"), field(b, "text"))
	case "chart", "plot", "graph":
		return figureIndexText(b)
	case "table":
		rows, _ := b["rows"].([]any)
		lines := make([]string, 0, len(rows))
		for _, row := range rows {
			if cells := strs(row); len(cells) > 0 {
				lines = append(lines, tableRow(cells))
			}
		}
		return strings.Join(lines, "\n")
	case "image":
		return field(b, "description")
	}
	return ""
}

func labelledLines(first, second string) string {
	switch {
	case first == "":
		return second
	case second == "":
		return first
	}
	return first + "\n" + second
}
