package store

import (
	"context"
	"maps"
	"testing"
	"time"
)

// Bank answers keep only the latest score; marks read only current questions
// (the hashes the bank reports), and purge removes the rows.
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
	answer("right", "t", "h-right", 0, now.Add(-time.Hour))
	answer("right", "t", "h-right", 1, now)
	answer("partial", "t", "h-partial", 0.6, now)
	answer("edited", "t", "h-before", 0, now)
	answer("retracted", "t", "h-gone", 0, now)
	answer("elsewhere", "other", "h-else", 0, now)

	// What the bank says now: "edited" has a new prompt, "retracted" is gone;
	// "elsewhere" belongs to another topic.
	hashes := map[string]string{"right": "h-right", "partial": "h-partial", "edited": "h-after", "elsewhere": "h-else"}
	marks, err := s.BankMarks(ctx, user, "t", hashes)
	if err != nil {
		t.Fatal(err)
	}
	if want := map[string]float64{"right": 1, "partial": 0.6}; !maps.Equal(marks, want) {
		t.Fatalf("marks = %v", marks)
	}
	results, err := s.BankResults(ctx, user)
	if err != nil || len(results) != 5 {
		t.Fatalf("results = %v %v", results, err)
	}

	if _, err := s.RequestAccountDeletion(ctx, user, true); err != nil {
		t.Fatal(err)
	}
	if err := s.PurgeUser(ctx, user); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM bank_progress WHERE user_id=$1`, user).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rows after purge = %d %v", n, err)
	}
}
