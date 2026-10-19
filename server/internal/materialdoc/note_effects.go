package materialdoc

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf16"
)

// Note pending effects (Epo 2026-10-17): a note's index text per top-level
// block now, against what its last index job chunked, aligned by element id.
// They tell chat what changed in a note since it was indexed, as Office
// pending effects do for a file.

// NoteBlock is a top-level block's index text with what note effects name
// it by: its element type (a figure's chart, plot or graph) and title.
type NoteBlock struct {
	IndexBlock
	Kind  string `json:"kind"`
	Title string `json:"title,omitempty"`
}

// JoinNoteBlocks is JoinIndexBlocks over note blocks.
func JoinNoteBlocks(blocks []NoteBlock) string {
	index := make([]IndexBlock, len(blocks))
	for i, block := range blocks {
		index[i] = block.IndexBlock
	}
	return JoinIndexBlocks(index)
}

// ExtractNoteBlocks is ExtractIndexBlocks with each block's kind and title.
func ExtractNoteBlocks(raw string, items map[string]string) ([]NoteBlock, error) {
	blocks, err := ExtractIndexBlocks(raw, items)
	if err != nil {
		return nil, err
	}
	doc, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	type named struct{ kind, title string }
	byID := map[string]named{}
	for _, node := range doc.Value {
		id, _ := node["id"].(string)
		kind, _ := node["type"].(string)
		title := ""
		switch kind {
		case "chart", "plot":
			block, _ := node["block"].(map[string]any)
			title = field(block, "title")
		case "graph":
			block, _ := node["block"].(map[string]any)
			title = field(block, "description")
		case "mermaid":
			title = strings.TrimSpace(indexNodeText(node))
		}
		if _, seen := byID[id]; !seen {
			byID[id] = named{kind, title}
		}
	}
	out := make([]NoteBlock, len(blocks))
	for i, block := range blocks {
		out[i] = NoteBlock{IndexBlock: block, Kind: byID[block.ID].kind, Title: byID[block.ID].title}
	}
	return out, nil
}

// NoteEffect is one change to a note's index text, in the shape Office
// pending effects have, plus the block it names. A heavy data change is a
// placeholder: kind "data", no text, a count in its label, and its block's
// before and after through resolve_source_change.
type NoteEffect struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Operation string  `json:"operation"`
	Label     string  `json:"label"`
	Before    *string `json:"before,omitempty"`
	After     *string `json:"after,omitempty"`
	BlockID   string  `json:"blockId"`
}

// NoteEffectContext is the context kept on each side of a text change, as
// Office's EFFECT_CONTEXT_CHARS; '…' marks a cut.
const NoteEffectContext = 40

// NoteDataPlaceholderTokens is the diff past which a chart, plot, graph or
// Mermaid change becomes a placeholder (Epo 2026-10-17, about 150 tokens).
const NoteDataPlaceholderTokens = 150

// dataUnits names what a heavy data block's count counts.
var dataUnits = map[string]string{"chart": "cells", "plot": "points", "graph": "elements", "mermaid": "lines"}

// lineDiffKinds are the embeds whose changes are line diffs within the block.
var lineDiffKinds = map[string]bool{"chart": true, "plot": true, "graph": true, "mermaid": true, "material_ref": true}

// NoteChanges are the effects from `before` (the indexed blocks) to `after`
// and the net tokens of the change, a placeholder counted at its full diff
// (what the reindex threshold measures).
func NoteChanges(before, after []NoteBlock) ([]NoteEffect, int64) {
	old := groupByID(before)
	used := map[string]int{}
	var effects []NoteEffect
	var tokens int64
	// Blocks both hold, in after's order, for the move check.
	var common []int
	for _, block := range after {
		n := used[block.ID]
		used[block.ID]++
		if n >= len(old[block.ID]) {
			e, t := blockEffect(nil, &block)
			effects, tokens = append(effects, e...), tokens+t
			continue
		}
		prev := old[block.ID][n]
		common = append(common, prev.index)
		if prev.Text != block.Text {
			e, t := blockEffect(&prev.NoteBlock, &block)
			effects, tokens = append(effects, e...), tokens+t
		}
	}
	for id, list := range old {
		for _, prev := range list[min(used[id], len(list)):] {
			e, t := blockEffect(&prev.NoteBlock, nil)
			effects, tokens = append(effects, e...), tokens+t
		}
	}
	// A block whose place among the shared blocks changed moved: no text,
	// no tokens (as Office moves).
	stay := longestIncreasing(common)
	for i, position := range common {
		if !stay[i] {
			block := before[position]
			effects = append(effects, NoteEffect{
				ID: effectID(block.ID, "move", "", ""), Kind: "text", Operation: "move",
				Label: blockLabel(block), BlockID: block.ID,
			})
		}
	}
	return effects, tokens
}

type indexedBlock struct {
	NoteBlock
	index int
}

// groupByID keeps each id's blocks in order; id-less blocks share "" and
// pair in order.
func groupByID(blocks []NoteBlock) map[string][]indexedBlock {
	out := map[string][]indexedBlock{}
	for i, block := range blocks {
		out[block.ID] = append(out[block.ID], indexedBlock{block, i})
	}
	return out
}

func blockLabel(block NoteBlock) string {
	name := block.Kind
	if name == "" {
		name = "block"
	}
	if block.Title != "" {
		return fmt.Sprintf("%s %q", name, block.Title)
	}
	return fmt.Sprintf("%s %s", name, block.ID)
}

// blockEffect is one block's change: added (prev nil), removed (next nil)
// or changed.
func blockEffect(prev, next *NoteBlock) ([]NoteEffect, int64) {
	named := next
	if named == nil {
		named = prev
	}
	var before, after string
	if prev != nil {
		before = prev.Text
	}
	if next != nil {
		after = next.Text
	}
	operation := "replace"
	switch {
	case prev == nil:
		operation = "add"
	case next == nil:
		operation = "remove"
	}
	if lineDiffKinds[named.Kind] {
		before, after = lineDiff(before, after)
	} else {
		before, after = trimChange(before, after)
	}
	tokens := changeTokens(before, after)
	if unit, data := dataUnits[named.Kind]; data && tokens > NoteDataPlaceholderTokens {
		changed, total := dataCount(named.Kind, textOf(prev), textOf(next))
		return []NoteEffect{{
			ID:        effectID(named.ID, operation, textOf(prev), textOf(next)),
			Kind:      "data",
			Operation: operation,
			Label:     fmt.Sprintf("%s: %d of %d %s changed", blockLabel(*named), changed, total, unit),
			BlockID:   named.ID,
		}}, tokens
	}
	return []NoteEffect{{
		ID:        effectID(named.ID, operation, before, after),
		Kind:      "text",
		Operation: operation,
		Label:     blockLabel(*named),
		Before:    &before,
		After:     &after,
		BlockID:   named.ID,
	}}, tokens
}

func textOf(block *NoteBlock) string {
	if block == nil {
		return ""
	}
	return block.Text
}

func effectID(parts ...string) string {
	raw, _ := json.Marshal(parts)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// trimChange is the one contiguous replacement from before to after, cut to
// the changed span plus NoteEffectContext UTF-16 units on each side
// (Office's trim_effect).
func trimChange(before, after string) (string, string) {
	b, a := utf16.Encode([]rune(before)), utf16.Encode([]rune(after))
	prefix, suffix := commonEnds(b, a)
	cut := func(text []uint16) string {
		from := max(prefix-NoteEffectContext, 0)
		to := len(text) - max(suffix-NoteEffectContext, 0)
		if from > 0 && lowSurrogate(text, from) {
			from--
		}
		if to < len(text) && lowSurrogate(text, to) {
			to++
		}
		out := string(utf16.Decode(text[from:to]))
		if from > 0 {
			out = "…" + out
		}
		if to < len(text) {
			out += "…"
		}
		return out
	}
	return cut(b), cut(a)
}

func lowSurrogate(text []uint16, at int) bool {
	return at < len(text) && text[at] >= 0xDC00 && text[at] <= 0xDFFF
}

func commonEnds[T comparable](a, b []T) (int, int) {
	prefix := 0
	for prefix < len(a) && prefix < len(b) && a[prefix] == b[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(a)-prefix && suffix < len(b)-prefix && a[len(a)-1-suffix] == b[len(b)-1-suffix] {
		suffix++
	}
	return prefix, suffix
}

// lineDiff keeps only the lines before lost and after gained (a longest
// common subsequence of lines), each side joined by newlines.
func lineDiff(before, after string) (string, string) {
	b, a := splitLines(before), splitLines(after)
	keepB, keepA := lcsKeep(b, a)
	var removed, added []string
	for i, line := range b {
		if !keepB[i] {
			removed = append(removed, line)
		}
	}
	for i, line := range a {
		if !keepA[i] {
			added = append(added, line)
		}
	}
	return strings.Join(removed, "\n"), strings.Join(added, "\n")
}

func splitLines(text string) []string {
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

// lcsKeep marks the elements of a longest common subsequence of a and b.
func lcsKeep(a, b []string) ([]bool, []bool) {
	n, m := len(a), len(b)
	table := make([][]int, n+1)
	for i := range table {
		table[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				table[i][j] = table[i+1][j+1] + 1
			} else {
				table[i][j] = max(table[i+1][j], table[i][j+1])
			}
		}
	}
	keepA, keepB := make([]bool, n), make([]bool, m)
	for i, j := 0, 0; i < n && j < m; {
		switch {
		case a[i] == b[j]:
			keepA[i], keepB[j] = true, true
			i, j = i+1, j+1
		case table[i+1][j] >= table[i][j+1]:
			i++
		default:
			j++
		}
	}
	return keepA, keepB
}

var plotPoint = regexp.MustCompile(`\([^()]*\)`)

// dataCount is a heavy data change's count: changed units of the block's
// kind (chart cells, plot points, graph elements, Mermaid lines) and the
// block's units now (or before, for a removal).
func dataCount(kind, before, after string) (int, int) {
	units := func(text string) []string {
		switch kind {
		case "chart":
			var cells []string
			for _, line := range splitLines(text) {
				if strings.HasPrefix(line, "|") {
					cells = append(cells, strings.Split(strings.Trim(line, "|"), "|")...)
				}
			}
			return cells
		case "plot":
			return plotPoint.FindAllString(text, -1)
		}
		return splitLines(text)
	}
	b, a := units(before), units(after)
	counts := map[string]int{}
	for _, unit := range b {
		counts[unit]++
	}
	gained := 0
	for _, unit := range a {
		if counts[unit] > 0 {
			counts[unit]--
		} else {
			gained++
		}
	}
	lost := 0
	for _, left := range counts {
		lost += left
	}
	total := len(a)
	if total == 0 {
		total = len(b)
	}
	return max(gained, lost), total
}

// longestIncreasing marks a longest increasing subsequence of positions.
func longestIncreasing(positions []int) []bool {
	n := len(positions)
	length, prev := make([]int, n), make([]int, n)
	best := -1
	for i := range positions {
		length[i], prev[i] = 1, -1
		for j := 0; j < i; j++ {
			if positions[j] < positions[i] && length[j]+1 > length[i] {
				length[i], prev[i] = length[j]+1, j
			}
		}
		if best < 0 || length[i] > length[best] {
			best = i
		}
	}
	keep := make([]bool, n)
	for i := best; i >= 0; i = prev[i] {
		keep[i] = true
	}
	return keep
}

// cjk is a Han, Hiragana, Katakana or Hangul character, one token each.
func cjk(r rune) bool {
	return r >= 0x1100 && unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul)
}

// changeTokens estimates a change's tokens as Office's effect_tokens: 4
// UTF-16 units a token, except changed CJK characters, one each.
func changeTokens(before, after string) int64 {
	b, a := []rune(before), []rune(after)
	prefix, suffix := commonEnds(b, a)
	changed := int64(0)
	for _, r := range b[prefix : len(b)-suffix] {
		if cjk(r) {
			changed++
		}
	}
	for _, r := range a[prefix : len(a)-suffix] {
		if cjk(r) {
			changed++
		}
	}
	units := int64(len(utf16.Encode(b)) + len(utf16.Encode(a)))
	return (units-changed+3)/4 + changed
}

// NoteEffectTokens are the tokens chat reads for a list of effects: a move
// counts 0, a placeholder its label.
func NoteEffectTokens(effects []NoteEffect) int64 {
	var total int64
	for _, effect := range effects {
		switch {
		case effect.Operation == "move":
		case effect.Kind == "data":
			total += changeTokens("", effect.Label) + 1
		default:
			total += changeTokens(deref(effect.Before), deref(effect.After))
		}
	}
	return total
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
