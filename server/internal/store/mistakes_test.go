package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/questions"
)

func TestMistakesBatchesPreserveUnattemptedQuestions(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	for _, large := range []bool{false, true} {
		t.Run(fmt.Sprint(large), func(t *testing.T) {
			user := newBlobTestUser(t, s, "u_mistakes_batch")
			count := fieldlimits.QuestionCount + 1
			blocks := []any{map[string]any{"type": "text", "text": "Explain."}}
			if large {
				count = 3
				blocks = make([]any, 40)
				for i := range blocks {
					blocks[i] = map[string]any{"type": "text", "text": strings.Repeat("a", fieldlimits.QuestionText)}
				}
			}
			raw := make([]json.RawMessage, count)
			for i := range raw {
				q := map[string]any{
					"id": fmt.Sprintf("q-%03d", i), "stem": blocks, "layout": "paper", "labels": "letters",
					"parts": []any{map[string]any{
						"id": "part-1", "blocks": blocks,
						"answer":     map[string]any{"type": "boolean", "correct": true},
						"markscheme": []string{"Identifies the evidence."}, "solution": []any{},
					}},
				}
				var err error
				raw[i], err = json.Marshal(q)
				if err != nil {
					t.Fatal(err)
				}
			}
			if err := s.AddMistakes(ctx, user, raw); err != nil {
				t.Fatal(err)
			}
			quiz, err := s.MistakesQuiz(ctx, user)
			if err != nil {
				t.Fatal(err)
			}
			var batch []map[string]any
			if err := json.Unmarshal(quiz.Questions, &batch); err != nil {
				t.Fatal(err)
			}
			if len(batch) >= count || len(batch) == 0 || len(quiz.Questions) > materialdoc.MaxDocumentBytes {
				t.Fatalf("unbounded batch: count=%d bytes=%d", len(batch), len(quiz.Questions))
			}
			if err := questions.ValidateAll(batch, questions.Policy{}); err != nil {
				t.Fatalf("invalid aggregate: %v", err)
			}
			attempted := make([]string, len(batch))
			for i, q := range batch {
				attempted[i] = q["id"].(string)
			}
			if err := s.ClearReviewedMistakes(ctx, user, attempted, attempted[:1]); err != nil {
				t.Fatal(err)
			}
			var remaining int
			if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM mistakes WHERE user_id=$1", user).Scan(&remaining); err != nil {
				t.Fatal(err)
			}
			if remaining != count-len(batch)+1 {
				t.Fatalf("removed unattempted questions: %d", remaining)
			}
			var partID string
			if err := s.pool.QueryRow(ctx, "SELECT question->'parts'->0->>'id' FROM mistakes WHERE user_id=$1 AND question_id=$2", user, attempted[0]).Scan(&partID); err != nil {
				t.Fatal(err)
			}
			if partID != "part-1" {
				t.Fatal("virtual IDs changed the source mistake")
			}
		})
	}
}
