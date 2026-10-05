package store

import (
	"context"
	"maps"
	"slices"
	"testing"
	"time"
)

// Bank answers rate like workspace review questions; marks and mistake review
// read only current questions (the hashes the bank reports), and an edited
// question starts again.
func TestBankProgress(t *testing.T) {
	s := openAccessTestStore(t)
	user := newBlobTestUser(t, s, "u_bank_progress")
	ctx := context.Background()
	now := time.Now()
	answer := func(id, topic, hash string, score float64, at time.Time) {
		t.Helper()
		if err := s.RecordBankAnswer(ctx, user, id, topic, hash, score, at); err != nil {
			t.Fatal(err)
		}
	}
	state := func(id string) (reps, lapses int, score float64) {
		t.Helper()
		if err := s.pool.QueryRow(ctx, `SELECT reps, lapses, last_score FROM bank_review_states WHERE user_id=$1 AND question_id=$2`, user, id).
			Scan(&reps, &lapses, &score); err != nil {
			t.Fatal(err)
		}
		return
	}

	answer("right", "t", "h-right", 1, now)
	answer("partial", "t", "h-partial", 0.6, now)                  // Hard: wrong, no lapse
	answer("old-miss", "t", "h-old", 0.25, now.AddDate(0, 0, -30)) // Again, long ago
	answer("new-miss", "t", "h-new", 0, now)
	answer("edited", "t", "h-before", 0, now)
	answer("retracted", "t", "h-gone", 0, now)
	answer("elsewhere", "other", "h-else", 0, now)
	if reps, lapses, score := state("new-miss"); reps != 1 || lapses != 1 || score != 0 {
		t.Fatalf("first miss = reps %d lapses %d score %v", reps, lapses, score)
	}
	answer("right", "t", "h-right", 1, now.Add(time.Hour))
	if reps, lapses, _ := state("right"); reps != 2 || lapses != 0 {
		t.Fatalf("second answer = reps %d lapses %d", reps, lapses)
	}

	// What the bank says now: "edited" has a new prompt, "retracted" is gone;
	// "elsewhere" belongs to another topic.
	hashes := map[string]string{"right": "h-right", "partial": "h-partial", "old-miss": "h-old", "new-miss": "h-new", "edited": "h-after", "elsewhere": "h-else"}
	marks, err := s.BankMarks(ctx, user, "t", hashes)
	if err != nil {
		t.Fatal(err)
	}
	if want := map[string]bool{"right": true, "partial": false, "old-miss": false, "new-miss": false}; !maps.Equal(marks, want) {
		t.Fatalf("marks = %v", marks)
	}
	batch, err := s.BankReview(ctx, user, "t", hashes, now)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(batch, []string{"old-miss", "new-miss"}) {
		t.Fatalf("review = %v", batch)
	}

	// Answering the edited question rates it as new.
	answer("edited", "t", "h-after", 1, now)
	if reps, lapses, _ := state("edited"); reps != 1 || lapses != 0 {
		t.Fatalf("edited answer = reps %d lapses %d", reps, lapses)
	}
	if marks, _ := s.BankMarks(ctx, user, "t", hashes); !marks["edited"] {
		t.Fatalf("edited mark = %v", marks)
	}

	if _, err := s.RequestAccountDeletion(ctx, user, true); err != nil {
		t.Fatal(err)
	}
	if err := s.PurgeUser(ctx, user); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM bank_review_states WHERE user_id=$1`, user).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rows after purge = %d %v", n, err)
	}
}
