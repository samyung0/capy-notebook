package store

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/samyung0/capy-notebook/server/internal/review"
)

// item is a scored pool item: r is its recall, misses its latest answers
// (true a miss, newest first), chapter "" outside chapters.
func item(id, chapter string, r float64, misses ...bool) (scored, []review.Rating) {
	var history []review.Rating
	for _, m := range misses {
		if m {
			history = append(history, review.Again)
		} else {
			history = append(history, review.Good)
		}
	}
	it := ranked{studyItem: studyItem{ReviewItem: ReviewItem{MaterialID: "m", ItemID: id, Kind: "card"}}, r: r, reps: len(history)}
	if chapter != "" {
		it.chapterID = &chapter
	}
	return scoreItems([]ranked{it}, map[string][]review.Rating{"m/" + id: history}, ReviewPrefs{Items: "both", Focus: "balanced"})[0], history
}

func pool(items ...func() (scored, []review.Rating)) ([]scored, map[string][]review.Rating) {
	var out []scored
	history := map[string][]review.Rating{}
	for _, mk := range items {
		it, h := mk()
		out = append(out, it)
		history["m/"+it.ItemID] = h
	}
	return out, history
}

func mk(id, chapter string, r float64, misses ...bool) func() (scored, []review.Rating) {
	return func() (scored, []review.Rating) { return item(id, chapter, r, misses...) }
}

func TestGroupSuggestions(t *testing.T) {
	// Chapter A has four missed items, chapter B two faded ones that pass
	// nothing alone, and an item the learner still recalls counts for nothing.
	items, history := pool(
		mk("a1", "A", 0.4, true), mk("a2", "A", 0.4, true), mk("a3", "A", 0.4, true), mk("a4", "A", 0.4, true),
		mk("b1", "B", 0.5, false, false, false), mk("b2", "B", 0.5, false, false, false),
		mk("b3", "B", 0.95, true),
	)
	got := groupSuggestions(items, history, 1)
	if len(got) != 1 || got[0].Group != GroupChapter || *got[0].ChapterID != "A" || got[0].Items != 4 {
		t.Fatalf("suggestions = %+v", got)
	}
	if ev := got[0].Evidence; ev.Missed != 4 || ev.Young != 4 {
		t.Fatalf("evidence = %+v", ev)
	}
	// Discounted for a long absence, A no longer passes.
	if got := groupSuggestions(items, history, interest(100*24*time.Hour)); len(got) != 0 {
		t.Fatalf("an old workspace suggested %+v", got)
	}

	// No chapter passes alone, the workspace does: one whole-workspace group.
	spread, history := pool(mk("a1", "A", 0.3, false, false), mk("b1", "B", 0.3, false, false),
		mk("c1", "C", 0.3, false, false), mk("o1", "", 0.3, false, false))
	if got := groupSuggestions(spread, history, 1); len(got) != 1 || got[0].Group != GroupWorkspace || got[0].Mode != ModeFading {
		t.Fatalf("spread suggestions = %+v", got)
	}

	// A workspace without chapters is always one group.
	flat, history := pool(mk("1", "", 0.6, false), mk("2", "", 0.6, true), mk("3", "", 0.6, false), mk("4", "", 0.6, false), mk("5", "", 0.6, true))
	if got := groupSuggestions(flat, history, 1); len(got) != 1 || got[0].Group != GroupWorkspace || got[0].Mode != ModeFading {
		t.Fatalf("flat suggestions = %+v", got)
	}
}

func TestPickItemsInterleavesAndCuts(t *testing.T) {
	items, _ := pool(
		mk("t1", "", 0.7, true, true), mk("t2", "", 0.7, true, true), mk("t3", "", 0.7, true, true),
		mk("f1", "", 0.4, false, false, false, false, false, false, false, false),
		mk("f2", "", 0.4, false, false, false, false, false, false, false, false),
		mk("known", "", 0.97, false),
	)
	got := pickItems(items, reviewGroup{kind: GroupWorkspace}, true, 4)
	var ids []string
	for _, it := range got {
		ids = append(ids, it.ItemID)
	}
	if len(ids) != 4 || ids[0] != "t1" || ids[1] != "f1" || ids[2] != "t2" {
		t.Fatalf("picked %v", ids)
	}
	// A manual review takes items the learner still recalls too.
	if all := pickItems(items, reviewGroup{kind: GroupWorkspace}, false, 20); len(all) != 6 {
		t.Fatalf("manual pick = %d items", len(all))
	}
}

// The label weighs time against history: the same answers read Tricky or
// Just learned while recent and Fading once mostly forgotten.
func TestModeLabels(t *testing.T) {
	for _, tc := range []struct {
		r      float64
		misses []bool // newest first
		want   string
	}{
		{0.85, []bool{true, false, false, false}, ModeTricky},
		{0.6, []bool{true, false, false, false}, ModeFading},
		{0.85, []bool{false, true, false, true}, ModeTricky},
		{0.4, []bool{false, true, false, true}, ModeFading},
		{0.85, []bool{false}, ModeLearned},
		{0.85, []bool{true}, ModeLearned},
		{0.4, []bool{true, true, true, true}, ModeTricky},
		{0.85, []bool{false, false, false, false, false}, ModeFading},
	} {
		if it, _ := item("x", "", tc.r, tc.misses...); it.mode() != tc.want {
			t.Errorf("R %v, misses %v: %s, want %s (labels %v)", tc.r, tc.misses, it.mode(), tc.want, it.labels)
		}
	}
}

func TestInterestCurve(t *testing.T) {
	day := 24 * time.Hour
	if interest(10*day) != 1 || interest(30*day) != 1 || interest(90*day) != interestFloor || interest(400*day) != interestFloor {
		t.Fatal("interest plateaus")
	}
	if mid := interest(60 * day); math.Abs(mid-(1+interestFloor)/2) > 1e-9 {
		t.Fatalf("interest at 60 days = %v", mid)
	}
}

func TestReviewSessionRecords(t *testing.T) {
	f := newStudyFixture(t, "u_review_sessions")
	ctx := context.Background()
	cards := f.set(t, [2]string{"Golgi", "Ships proteins"}, [2]string{"Lysosome", "Digests waste"}, [2]string{"Ribosome", "Makes proteins"})
	rate := func(a *SessionAnswer, c Flashcard, rating int) error {
		return f.s.RateItem(ctx, f.user, Rating{MaterialID: c.MaterialID, ItemID: c.ID, Rating: &rating, Session: a}, time.Now())
	}

	// No row until the first answer; then the session lists every served item.
	first := f.session(cards...)
	if n := f.count(t, `SELECT count(*) FROM review_sessions WHERE user_id=$1`, f.user); n != 0 {
		t.Fatalf("sessions before an answer = %d", n)
	}
	if err := rate(first, cards[0], 1); err != nil {
		t.Fatal(err)
	}
	resumed, err := f.s.ResumeReviewSession(ctx, f.user, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if resumed.Answered != 1 || resumed.Total != 3 || len(resumed.Items) != 2 || resumed.Items[0].ItemID != cards[1].ID {
		t.Fatalf("resumed = %+v", resumed)
	}
	// The answered card comes back with its rating, for Previous to show.
	if len(resumed.Done) != 1 || resumed.Done[0].ItemID != cards[0].ID || resumed.Done[0].Rating != 1 || resumed.Done[0].Front != "Golgi" {
		t.Fatalf("resumed done = %+v", resumed.Done)
	}
	overview, err := f.s.ReviewOverview(ctx, f.user, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(overview.Unfinished) != 1 || overview.Unfinished[0].Answered != 1 || overview.Workspaces[0].LastReviewedAt == nil {
		t.Fatalf("overview = %+v", overview)
	}

	// Someone else cannot answer into it.
	other := newBlobTestUser(t, f.s, "u_review_sessions_other")
	good := 3
	if err := f.s.RateItem(ctx, other, Rating{MaterialID: cards[1].MaterialID, ItemID: cards[1].ID, Rating: &good, Session: first}, time.Now()); !errors.Is(err, ErrReviewSession) {
		t.Fatalf("another user's answer: %v", err)
	}

	// The last served item finishes it; Past reviews counts Good and Easy.
	if err := rate(first, cards[1], 3); err != nil {
		t.Fatal(err)
	}
	if err := rate(first, cards[2], 4); err != nil {
		t.Fatal(err)
	}
	past, more, err := f.s.PastReviews(ctx, f.user, PastReviewParams{Sort: "date", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if more || len(past) != 1 || past[0].Cards == nil || past[0].Cards.Correct != 2 || past[0].Cards.Total != 3 || past[0].Quiz != nil {
		t.Fatalf("past = %+v", past)
	}

	// A second session, ended early with Done, lists first.
	second := f.session(cards...)
	if err := rate(second, cards[0], 3); err != nil {
		t.Fatal(err)
	}
	if err := f.s.FinishReviewSession(ctx, f.user, second.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	past, _, err = f.s.PastReviews(ctx, f.user, PastReviewParams{Sort: "date", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(past) != 2 || past[0].ID != second.ID || past[0].Answered != 1 || past[0].Total != 3 {
		t.Fatalf("past after a second session = %+v", past)
	}
	if past, _, _ := f.s.PastReviews(ctx, f.user, PastReviewParams{Sort: "date", Has: []string{"quiz"}, Limit: 10}); len(past) != 0 {
		t.Fatalf("quiz filter kept card sessions: %+v", past)
	}
	if err := f.s.FinishReviewSession(ctx, other, second.ID, time.Now()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another user finished it: %v", err)
	}
	if _, err := f.s.ResumeReviewSession(ctx, f.user, uuid.NewString()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("resume of a missing session: %v", err)
	}
}
