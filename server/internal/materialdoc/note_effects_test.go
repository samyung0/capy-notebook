package materialdoc

import (
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"testing"
)

func effectsDoc(t *testing.T, nodes ...map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"schemaVersion": 1, "value": nodes})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func effectsPara(id, text string) map[string]any {
	return map[string]any{"type": "p", "id": id, "children": []any{map[string]any{"text": text}}}
}

func effectsChart(id, title string, rows int, value func(int) float64) map[string]any {
	labels, values := []any{}, []any{}
	for i := range rows {
		labels = append(labels, fmt.Sprintf("r%d", i))
		values = append(values, value(i))
	}
	return map[string]any{
		"type": "chart", "id": id, "children": []any{map[string]any{"text": ""}},
		"block": map[string]any{
			"type": "chart", "kind": "bar", "title": title, "labels": labels,
			"series": []any{map[string]any{"name": "S", "values": values}},
		},
	}
}

func effectsBlocks(t *testing.T, raw string) []NoteBlock {
	t.Helper()
	blocks, err := ExtractNoteBlocks(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	return blocks
}

func TestNoteChangesTrimATextChangeToItsSpanWithContext(t *testing.T) {
	long := strings.Repeat("a", 60)
	before := effectsBlocks(t, effectsDoc(t, effectsPara("p1", long+" cell "+long), effectsPara("p2", "unchanged")))
	after := effectsBlocks(t, effectsDoc(t, effectsPara("p1", long+" nucleus "+long), effectsPara("p2", "unchanged")))
	effects, tokens := NoteChanges(before, after)
	if len(effects) != 1 {
		t.Fatalf("effects = %+v", effects)
	}
	e := effects[0]
	ctx := strings.Repeat("a", 39)
	if e.Operation != "replace" || e.BlockID != "p1" || e.Kind != "text" ||
		*e.Before != "…"+ctx+" cell "+ctx+"…" || *e.After != "…"+ctx+" nucleus "+ctx+"…" {
		t.Fatalf("effect = %+v before=%q after=%q", e, *e.Before, *e.After)
	}
	if tokens != changeTokens(*e.Before, *e.After) {
		t.Fatalf("tokens = %d", tokens)
	}
}

func TestNoteChangesAddRemoveAndMove(t *testing.T) {
	before := effectsBlocks(t, effectsDoc(t, effectsPara("a", "Alpha"), effectsPara("b", "Beta"), effectsPara("c", "Gamma")))
	after := effectsBlocks(t, effectsDoc(t, effectsPara("c", "Gamma"), effectsPara("a", "Alpha"), effectsPara("d", "Delta")))
	effects, _ := NoteChanges(before, after)
	got := map[string]string{}
	for _, e := range effects {
		got[e.BlockID] = e.Operation
	}
	// Swapping a and c moves exactly one of them.
	moved := 0
	for _, id := range []string{"a", "c"} {
		if got[id] == "move" {
			moved++
		}
	}
	if got["b"] != "remove" || got["d"] != "add" || moved != 1 || len(got) != 3 {
		t.Fatalf("operations = %v", got)
	}
	for _, e := range effects {
		if e.Operation == "move" && (e.Before != nil || e.After != nil) {
			t.Fatalf("a move carries text: %+v", e)
		}
	}
}

func TestNoteChangesInlineASmallChartChangeAsLines(t *testing.T) {
	before := effectsBlocks(t, effectsDoc(t, effectsChart("ch", "Rain", 5, func(i int) float64 { return float64(i) })))
	after := effectsBlocks(t, effectsDoc(t, effectsChart("ch", "Rain", 5, func(i int) float64 {
		if i == 2 {
			return 9
		}
		return float64(i)
	})))
	effects, _ := NoteChanges(before, after)
	if len(effects) != 1 || effects[0].Kind != "text" || *effects[0].Before != "| r2 | 2 |" ||
		*effects[0].After != "| r2 | 9 |" {
		t.Fatalf("effects = %+v", effects)
	}
}

// Epo 2026-10-17: a heavy data change is a placeholder naming its block and
// a count, resolved through resolve_source_change.
func TestNoteChangesMakeAHeavyChartChangeAPlaceholder(t *testing.T) {
	before := effectsBlocks(t, effectsDoc(t, effectsChart("ch", "Rain", 50, func(i int) float64 { return float64(i) })))
	after := effectsBlocks(t, effectsDoc(t, effectsChart("ch", "Rain", 50, func(i int) float64 {
		if i < 40 {
			return float64(i) + 0.5
		}
		return float64(i)
	})))
	effects, tokens := NoteChanges(before, after)
	if len(effects) != 1 {
		t.Fatalf("effects = %+v", effects)
	}
	e := effects[0]
	if e.Kind != "data" || e.Before != nil || e.After != nil || e.BlockID != "ch" ||
		e.Label != `chart "Rain": 40 of 104 cells changed` {
		t.Fatalf("placeholder = %+v", e)
	}
	if tokens <= NoteDataPlaceholderTokens {
		t.Fatalf("net tokens %d", tokens)
	}
}

func TestChangeTokensCountChangedCJKOneEach(t *testing.T) {
	if got := changeTokens("abcd", "abcd界界"); got != 4 {
		t.Fatalf("tokens = %d", got)
	}
}

func TestNoteChangesListRemovedBlocksInDocumentOrder(t *testing.T) {
	var paras []map[string]any
	for i := range 20 {
		paras = append(paras, effectsPara(fmt.Sprintf("p%02d", i), fmt.Sprintf("para %d", i)))
	}
	before := effectsBlocks(t, effectsDoc(t, paras...))
	for range 5 {
		effects, _ := NoteChanges(before, nil)
		for i, e := range effects {
			if e.Operation != "remove" || e.BlockID != fmt.Sprintf("p%02d", i) {
				t.Fatalf("effect %d = %s %s", i, e.Operation, e.BlockID)
			}
		}
	}
}

// allocated is the bytes NoteChanges allocates for one call.
func allocated(before, after []NoteBlock) ([]NoteEffect, uint64) {
	var start, end runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&start)
	effects, _ := NoteChanges(before, after)
	runtime.ReadMemStats(&end)
	return effects, end.TotalAlloc - start.TotalAlloc
}

func mermaidBlock(lines []string) []NoteBlock {
	return []NoteBlock{{IndexBlock: IndexBlock{ID: "m", Text: strings.Join(lines, "\n")}, Kind: "mermaid"}}
}

// Review B1 (2026-10-20): a line diff's table was lines x lines over the
// whole block, so a large Mermaid source could exhaust the API's memory on
// every chat turn and on the reindex measure. Unchanged first and last lines
// are trimmed, and a change still past lineDiffCells is a line-count
// placeholder. Both sizes allocate about 200 MB without the bound.
func TestNoteChangesBoundALargeLineDiff(t *testing.T) {
	const lines = 5000
	source := make([]string, lines)
	for i := range source {
		source[i] = fmt.Sprintf("  n%d --> n%d", i, i+1)
	}
	edited := append([]string(nil), source...)
	edited[lines/2] = "  changed --> line"
	effects, bytes := allocated(mermaidBlock(source), mermaidBlock(edited))
	if len(effects) != 1 || effects[0].Kind != "text" || *effects[0].Before != source[lines/2] ||
		*effects[0].After != "  changed --> line" {
		t.Fatalf("one changed line = %+v", effects)
	}
	if bytes > 32<<20 {
		t.Fatalf("one changed line allocated %d MB", bytes>>20)
	}

	// Many one-character lines, all changed: past the bound.
	short, other := make([]string, lines), make([]string, lines)
	for i := range short {
		short[i], other[i] = string(rune('a'+i%2)), string(rune('c'+i%2))
	}
	effects, bytes = allocated(mermaidBlock(short), mermaidBlock(other))
	if len(effects) != 1 || effects[0].Kind != "data" || effects[0].Label != "mermaid m: 5000 of 5000 lines changed" {
		t.Fatalf("every line changed = %+v", effects)
	}
	if bytes > 32<<20 {
		t.Fatalf("every line changed allocated %d MB", bytes>>20)
	}
}

// Q415: a note's blocks with their kinds and titles come from one parse; a
// second one doubled the index text's cost on near-limit notes.
func TestExtractNoteBlocksParsesOnce(t *testing.T) {
	nodes := []map[string]any{}
	for i := range 200 {
		nodes = append(nodes, effectsPara(fmt.Sprintf("p%d", i), strings.Repeat("words ", 20)))
	}
	raw := effectsDoc(t, nodes...)
	allocs := func(f func()) float64 { return testing.AllocsPerRun(5, f) }
	parse := allocs(func() { _, _ = Parse(raw) })
	index := allocs(func() { _, _ = ExtractIndexBlocks(raw, nil) })
	note := allocs(func() { _, _ = ExtractNoteBlocks(raw, nil) })
	if note > index+parse/2 {
		t.Fatalf("ExtractNoteBlocks made %.0f allocations: the index blocks' %.0f plus most of another parse (%.0f)",
			note, index, parse)
	}
}
