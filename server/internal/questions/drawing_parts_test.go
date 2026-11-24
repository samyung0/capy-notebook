package questions

import (
	"encoding/json"
	"maps"
	"os"
	"testing"
)

// Parts answering in one canvas share the first one's drawing; a part on its
// own canvas holds its own (Epo 2026-11-23). A learner view reads the same.
func TestDrawingParts(t *testing.T) {
	for file, want := range map[string]map[string]string{
		"canvas-shared-stem.json":  {"p1": "p1", "p2": "p1"},
		"canvas-shared-group.json": {"p1": "p1", "p2": "p2"},
		"canvas.json":              {"p1": "p1"},
		"canvas-shown.json":        {},
	} {
		raw, err := os.ReadFile("testdata/" + file)
		if err != nil {
			t.Fatal(err)
		}
		var f struct{ Question map[string]any }
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		for _, view := range []map[string]any{f.Question, LearnerView(f.Question)} {
			if got := DrawingParts(view); !maps.Equal(got, want) {
				t.Fatalf("%s: %v, want %v", file, got, want)
			}
		}
	}
}

// A drawing's canvas is named by where it sits, so a republish can follow it
// (Epo 2026-11-24).
func TestDrawingCanvases(t *testing.T) {
	for file, want := range map[string]map[string]string{
		"canvas-shared-stem.json":  {"p1": "stem/"},
		"canvas-shared-group.json": {"p1": "group/g1", "p2": "part/p2"},
		"canvas.json":              {"p1": "part/p1"},
	} {
		raw, err := os.ReadFile("testdata/" + file)
		if err != nil {
			t.Fatal(err)
		}
		var f struct{ Question map[string]any }
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		if got := DrawingCanvases(f.Question); !maps.Equal(got, want) {
			t.Fatalf("%s: %v, want %v", file, got, want)
		}
	}
}

// ungrouped is canvas-shared-group.json after Ungroup (Epo 2026-11-24): the
// group's text, its canvas with it, goes to its first sub-part, which answers
// in it as its own.
func ungrouped(t *testing.T) (before, after map[string]any) {
	t.Helper()
	load := func() map[string]any {
		raw, err := os.ReadFile("testdata/canvas-shared-group.json")
		if err != nil {
			t.Fatal(err)
		}
		var f struct{ Question map[string]any }
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		return f.Question
	}
	before, after = load(), load()
	group := after["groups"].([]any)[0].(map[string]any)
	delete(after, "groups")
	for i, raw := range after["parts"].([]any) {
		p := raw.(map[string]any)
		delete(p, "group")
		if i == 0 {
			p["blocks"] = append(group["blocks"].([]any), p["blocks"].([]any)...)
			p["answer"] = map[string]any{"type": "canvas"}
		}
	}
	return before, after
}

func TestUngroupedCanvases(t *testing.T) {
	before, after := ungrouped(t)
	if got := UngroupedCanvases(before, after); !maps.Equal(got, map[string]string{"group/g1": "part/p1"}) {
		t.Fatalf("renamed %v", got)
	}
}
