package questions

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// The fixtures are shared with grade.ts's Vitest, so the two scorers agree.
func TestScoringFixtures(t *testing.T) {
	paths, err := filepath.Glob("testdata/scoring/*.json")
	if err != nil || len(paths) == 0 {
		t.Fatal("scoring fixtures unavailable", err)
	}
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var file struct {
			Cases []struct {
				Name    string
				Part    map[string]any
				Answer  any
				Awarded float64
				Items   []bool
			}
		}
		if err := json.Unmarshal(raw, &file); err != nil {
			t.Fatal(path, err)
		}
		for _, c := range file.Cases {
			t.Run(filepath.Base(path)+"/"+c.Name, func(t *testing.T) {
				awarded, items := ScorePart(c.Part, c.Answer)
				if awarded != c.Awarded || !slices.Equal(items, c.Items) {
					t.Fatalf("got %v %v, want %v %v", awarded, items, c.Awarded, c.Items)
				}
			})
		}
	}
}

// Stored content that never validated must not panic the learner view.
func TestLearnerViewToleratesMalformedContent(t *testing.T) {
	for _, q := range []map[string]any{
		{},
		{"parts": "nope"},
		{"parts": []any{"nope", map[string]any{"answer": "nope"}}},
		{"parts": []any{map[string]any{"answer": map[string]any{"type": "matching", "options": 1, "pairs": []any{1}}}}},
		{"parts": []any{map[string]any{"answer": map[string]any{"type": "ordering", "items": nil}}}},
	} {
		LearnerView(q)
	}
}

// Graded keeps the key, awards every part and leaves the stored question alone.
func TestGradedAwardsEveryPart(t *testing.T) {
	q := map[string]any{"id": "q", "parts": []any{
		map[string]any{"id": "a", "marks": 2.0, "answer": map[string]any{"type": "gaps", "accepted": []any{[]any{"x"}, []any{"y"}}}},
		map[string]any{"id": "b", "marks": 3.0, "answer": map[string]any{"type": "open", "accepted": []any{"k"}, "hints": []any{}},
			"markscheme": []any{map[string]any{"text": "one", "marks": 2.0}, map[string]any{"text": "two", "marks": 1.0}}},
		map[string]any{"id": "c", "marks": 1.0, "answer": map[string]any{"type": "boolean", "correct": true}},
	}}
	graded, awarded, total := Graded(q, map[string]any{"a": []any{"x", "z"}, "c": true}, map[string][]float64{})
	parts := graded["parts"].([]any)
	gaps, open, boolean := parts[0].(map[string]any), parts[1].(map[string]any), parts[2].(map[string]any)
	if awarded != 2 || total != 6 || gaps["awarded"] != 1.0 || !slices.Equal(gaps["itemResults"].([]bool), []bool{true, false}) ||
		open["awarded"] != 0.0 || !slices.Equal(open["itemAwards"].([]float64), []float64{0, 0}) ||
		boolean["awarded"] != 1.0 || boolean["itemResults"] != nil || boolean["answer"].(map[string]any)["correct"] != true {
		t.Fatalf("graded %v, %v of %v", graded, awarded, total)
	}
	graded, awarded, _ = Graded(q, map[string]any{}, map[string][]float64{"b": {2, 0.5}})
	if awarded != 2.5 || graded["parts"].([]any)[1].(map[string]any)["awarded"] != 2.5 {
		t.Fatalf("open part from Jev: %v", graded)
	}
	if _, ok := q["parts"].([]any)[0].(map[string]any)["awarded"]; ok {
		t.Fatal("the stored question was modified")
	}
}
