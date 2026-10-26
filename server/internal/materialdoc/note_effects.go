package materialdoc

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
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

// ExtractNoteBlocks is ExtractIndexBlocks with each block's kind and title,
// from one parse.
func ExtractNoteBlocks(raw string, items map[string]string) ([]NoteBlock, error) {
	doc, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	blocks, err := indexBlocks(doc, items)
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

// lineDiffCells bounds a line diff's work: past this many cells of lines
// before × lines after (once the common first and last lines are trimmed)
// the change is a placeholder counting its lines, not an LCS. A Mermaid
// source is bounded only by the document cap.
const lineDiffCells = 1 << 18

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
	// Removed blocks in document order: the evidence reads the same every turn.
	seen := map[string]int{}
	for i := range before {
		prev := before[i]
		seen[prev.ID]++
		if seen[prev.ID] > used[prev.ID] {
			e, t := blockEffect(&prev, nil)
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
				ID: effectID(block.ID, "move", fmt.Sprint(position)), Kind: "text", Operation: "move",
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
	bounded := true
	if lineDiffKinds[named.Kind] {
		before, after, bounded = lineDiff(before, after)
	} else {
		before, after = trimChange(before, after)
	}
	tokens := changeTokens(before, after)
	if !bounded {
		changed := max(len(splitLines(before)), len(splitLines(after)))
		total := len(splitLines(textOf(next)))
		if next == nil {
			total = len(splitLines(textOf(prev)))
		}
		return []NoteEffect{{
			ID:        effectID(named.ID, operation, textOf(prev), textOf(next)),
			Kind:      "data",
			Operation: operation,
			Label:     fmt.Sprintf("%s: %d of %d lines changed", blockLabel(*named), changed, total),
			BlockID:   named.ID,
		}}, tokens
	}
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
// common subsequence of lines), each side joined by newlines. Past
// lineDiffCells it is not bounded (false) and gives every line between the
// common first and last ones.
func lineDiff(before, after string) (string, string, bool) {
	b, a := splitLines(before), splitLines(after)
	prefix, suffix := commonEnds(b, a)
	b, a = b[prefix:len(b)-suffix], a[prefix:len(a)-suffix]
	if len(b)*len(a) > lineDiffCells {
		return strings.Join(b, "\n"), strings.Join(a, "\n"), false
	}
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
	return strings.Join(removed, "\n"), strings.Join(added, "\n"), true
}

func splitLines(text string) []string {
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

// lcsKeep marks the elements of a longest common subsequence of a and b;
// callers bound len(a)*len(b) (lineDiffCells).
func lcsKeep(a, b []string) ([]bool, []bool) {
	n, m := len(a), len(b)
	w := m + 1
	table := make([]int32, (n+1)*w)
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				table[i*w+j] = table[(i+1)*w+j+1] + 1
			} else {
				table[i*w+j] = max(table[(i+1)*w+j], table[i*w+j+1])
			}
		}
	}
	keepA, keepB := make([]bool, n), make([]bool, m)
	for i, j := 0, 0; i < n && j < m; {
		switch {
		case a[i] == b[j]:
			keepA[i], keepB[j] = true, true
			i, j = i+1, j+1
		case table[(i+1)*w+j] >= table[i*w+j+1]:
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

// longestIncreasing marks a longest increasing subsequence of positions
// (patience sorting, n log n).
func longestIncreasing(positions []int) []bool {
	n := len(positions)
	prev := make([]int, n)
	var tails []int // tails[k]: index of the smallest tail of a run of k+1
	for i, position := range positions {
		k := sort.Search(len(tails), func(k int) bool { return positions[tails[k]] >= position })
		prev[i] = -1
		if k > 0 {
			prev[i] = tails[k-1]
		}
		if k == len(tails) {
			tails = append(tails, i)
		} else {
			tails[k] = i
		}
	}
	keep := make([]bool, n)
	if len(tails) > 0 {
		for i := tails[len(tails)-1]; i >= 0; i = prev[i] {
			keep[i] = true
		}
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
