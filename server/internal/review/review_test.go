package review

import (
	"testing"
	"time"
)

func TestScoreRating(t *testing.T) {
	for score, want := range map[float64]Rating{0: Again, 0.49: Again, 0.5: Hard, 0.69: Hard, 0.7: Good, 1: Good} {
		if got := ScoreRating(score); got != want {
			t.Errorf("ScoreRating(%v) = %v, want %v", score, got, want)
		}
	}
}

func TestForgottenItemsRankFirst(t *testing.T) {
	start := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	good := Rate(nil, Good, start)
	missed := Rate(&good, Again, start.Add(48*time.Hour))
	if missed.Lapses != 1 || missed.Reps != 2 {
		t.Fatalf("after Again: %+v", missed)
	}
	later := start.Add(7 * 24 * time.Hour)
	steady := Rate(&good, Good, start.Add(48*time.Hour))
	if Retrievability(missed, later) >= Retrievability(steady, later) {
		t.Fatal("a lapsed item should be less retained than one answered well")
	}
}

func question(prompt string, answer any, marks float64, scheme ...any) map[string]any {
	part := map[string]any{"blocks": []any{map[string]any{"type": "text", "text": prompt}}, "answer": answer, "marks": marks, "solution": []any{"why"}}
	if scheme != nil {
		part["markscheme"] = scheme
	}
	return map[string]any{"id": "q1", "stem": []any{}, "layout": "paper", "parts": []any{part}}
}

func TestQuestionHashCoversThePromptTextOnly(t *testing.T) {
	base := question("Cells have membranes?", map[string]any{"type": "boolean", "correct": true}, 1)
	edited := question("Cells have membranes?", map[string]any{"type": "boolean", "correct": false}, 3,
		map[string]any{"text": "Names the membrane", "marks": 3})
	edited["layout"] = "split"
	edited["stem"] = []any{map[string]any{"type": "image", "image": map[string]any{"assetId": "a"}, "width": 640, "height": 480}}
	if QuestionHash(base) != QuestionHash(edited) {
		t.Fatal("an answer, marking scheme, mark, layout or image changed the hash")
	}
	if QuestionHash(base) == QuestionHash(question("Ribosomes have membranes?", map[string]any{"type": "boolean", "correct": true}, 1)) {
		t.Fatal("a new prompt kept the hash")
	}
	edited["stem"] = []any{map[string]any{"type": "text", "text": "Cell biology"}}
	if QuestionHash(base) == QuestionHash(edited) {
		t.Fatal("new stem text kept the hash")
	}
}

func TestFirstMissIsALapse(t *testing.T) {
	now := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	missed := Rate(nil, Again, now)
	if got := Rate(&missed, Good, now.Add(time.Minute)); got.Lapses != 1 {
		t.Fatalf("new card Again then Good: lapses = %d", got.Lapses)
	}
}

func TestQuestionScoreUsesPartMarks(t *testing.T) {
	q := map[string]any{"parts": []any{
		map[string]any{"marks": 2.0, "awarded": 1.5},
		map[string]any{"marks": 2.0, "awarded": 0.0},
	}}
	if score, ok := QuestionScore(q); !ok || score != 0.375 {
		t.Fatalf("score = %v ok = %v", score, ok)
	}
	if _, ok := QuestionScore(map[string]any{"parts": []any{}}); ok {
		t.Fatal("a question without marks scored")
	}
}
