package materialdoc

import (
	"encoding/json"
	"fmt"
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
	if tokens <= NoteDataPlaceholderTokens || NoteEffectTokens(effects) >= tokens {
		t.Fatalf("net tokens %d, chat tokens %d", tokens, NoteEffectTokens(effects))
	}
}

func TestChangeTokensCountChangedCJKOneEach(t *testing.T) {
	if got := changeTokens("abcd", "abcd界界"); got != 4 {
		t.Fatalf("tokens = %d", got)
	}
}
