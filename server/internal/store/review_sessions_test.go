package store

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
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

// Quick review takes the top four fading cards; questions and recalled items
// never enter.
func TestQuickReviewPick(t *testing.T) {
	ids := func(items []ReviewItem) (out []string) {
		for _, it := range items {
			out = append(out, it.ItemID)
		}
		return out
	}
	var items []scored
	for _, c := range []struct {
		id string
		r  float64
	}{{"c1", 0.3}, {"c2", 0.4}, {"c3", 0.5}, {"c4", 0.6}, {"c5", 0.7}, {"fresh", 0.95}} {
		it, _ := item(c.id, "", c.r)
		items = append(items, it)
	}
	question, _ := item("q", "", 0.5)
	question.Kind = "question"
	if got := ids(quickReview(append(items, question))); len(got) != 4 || got[0] != "c1" || got[3] != "c4" {
		t.Fatalf("cards on top = %v", got)
	}
	question, _ = item("q", "", 0.05)
	question.Kind = "question"
	if got := ids(quickReview(append(items, question))); len(got) != 4 || got[0] != "c1" {
		t.Fatalf("question on top = %v", got)
	}
	recalled, _ := item("fresh", "", 0.95)
	if got := quickReview([]scored{recalled}); len(got) != 0 {
		t.Fatalf("recalled items = %v", ids(got))
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
	// The Study tab continues the same whole-workspace session.
	if summary, err := f.s.StudySummary(ctx, f.user, f.ws.ID, time.Now()); err != nil || summary.Unfinished == nil || summary.Unfinished.ID != first.ID || summary.Unfinished.Total != 3 {
		t.Fatalf("study summary unfinished = %+v, %v", summary.Unfinished, err)
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
	if summary, err := f.s.StudySummary(ctx, f.user, f.ws.ID, time.Now()); err != nil || summary.Unfinished != nil {
		t.Fatalf("study summary after the last answer = %+v, %v", summary.Unfinished, err)
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
	// Its result: the answered card, which rose from Again in the first session.
	result, err := f.s.ReviewSessionResult(ctx, f.user, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Session.ID != second.ID || len(result.Items) != 1 || result.Items[0].Rating != 3 || result.Better != 1 {
		t.Fatalf("result = %+v", result)
	}
	if _, err := f.s.ReviewSessionResult(ctx, other, second.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another user's result: %v", err)
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

func TestPlanReviewSession(t *testing.T) {
	f := newStudyFixture(t, "u_plan_review")
	ctx := context.Background()
	other, err := f.s.CreateWorkspace(ctx, f.user, WorkspaceCreate{Name: "Chemistry", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	inPlan := f.set(t, [2]string{"Golgi", "Ships proteins"}, [2]string{"Lysosome", "Digests waste"})
	outside := f.set(t, [2]string{"Ribosome", "Makes proteins"})
	elsewhere := studyFixture{f.s, f.user, other}.set(t, [2]string{"Ion", "Charged atom"})
	for _, c := range append(append(append([]Flashcard{}, inPlan...), outside...), elsewhere...) {
		f.rate(t, c, 1)
	}
	plan, err := f.s.CreateStudyPlan(ctx, f.user, f.ws.ID, "Winter exams")
	if err != nil {
		t.Fatal(err)
	}
	steps := []PlanStepInput{
		{Kind: "material", WorkspaceID: f.ws.ID, TargetID: inPlan[0].MaterialID},
		{Kind: "material", WorkspaceID: other.ID, TargetID: elsewhere[0].MaterialID},
	}
	if err := f.s.UpdateStudyPlan(ctx, f.user, plan.ID, nil, &steps); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(72 * time.Hour)
	keys := func(items []ReviewItem) map[string]bool {
		out := map[string]bool{}
		for _, it := range items {
			out[it.ItemID] = true
		}
		return out
	}

	// The plan's Quick review and review draw from both workspaces, only its steps.
	summary, err := f.s.PlanStudySummary(ctx, f.user, f.ws.ID, plan.ID, later)
	if err != nil {
		t.Fatal(err)
	}
	if got := keys(summary.QuickReview); summary.Reviewable != 3 || !got[elsewhere[0].ID] || got[outside[0].ID] {
		t.Fatalf("plan summary = %d %+v", summary.Reviewable, summary.QuickReview)
	}
	review, err := f.s.WorkspaceReview(ctx, f.user, f.ws.ID, ReviewSessionInfo{Group: GroupPlan, PlanID: &plan.ID}, later)
	if err != nil {
		t.Fatal(err)
	}
	if got := keys(review.Items); len(review.Items) != 3 || got[outside[0].ID] {
		t.Fatalf("plan review = %+v", review.Items)
	}
	// The Review tab lists the plan with its review's pool.
	overview, err := f.s.ReviewOverview(ctx, f.user, later)
	if err != nil {
		t.Fatal(err)
	}
	if len(overview.Plans) != 1 || overview.Plans[0].PlanID != plan.ID || overview.Plans[0].Reviewable != 3 || !overview.Plans[0].CanReview {
		t.Fatalf("overview plans = %+v", overview.Plans)
	}
	// A plan holding only a file has nothing to review, though its workspace
	// has sets.
	fileID := uid("f")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO files (id, workspace_id, user_id, name, kind) VALUES ($1,$2,$3,'notes.md','md')`, fileID, f.ws.ID, f.user); err != nil {
		t.Fatal(err)
	}
	reading, err := f.s.CreateStudyPlan(ctx, f.user, f.ws.ID, "Reading")
	if err != nil {
		t.Fatal(err)
	}
	fileSteps := []PlanStepInput{{Kind: "file", WorkspaceID: f.ws.ID, TargetID: fileID}}
	if err := f.s.UpdateStudyPlan(ctx, f.user, reading.ID, nil, &fileSteps); err != nil {
		t.Fatal(err)
	}
	overview, err = f.s.ReviewOverview(ctx, f.user, later)
	if err != nil {
		t.Fatal(err)
	}
	if len(overview.Plans) != 2 || overview.Plans[0].PlanID != reading.ID || overview.Plans[0].CanReview {
		t.Fatalf("file-only plan = %+v", overview.Plans)
	}

	// Answers from either workspace record into the plan session; the plan
	// continues it, the workspace does not.
	scope, err := f.s.PlanScopeOf(ctx, f.user, plan.ID)
	if err != nil {
		t.Fatal(err)
	}
	a := &SessionAnswer{ID: uuid.NewString(), WorkspaceID: f.ws.ID, Info: ReviewSessionInfo{Group: GroupPlan, PlanID: &plan.ID}, Plan: &scope}
	for _, it := range review.Items {
		a.Items = append(a.Items, SessionItem{MaterialID: it.MaterialID, ItemID: it.ItemID})
	}
	good := 3
	if err := f.s.RateItem(ctx, f.user, Rating{MaterialID: elsewhere[0].MaterialID, ItemID: elsewhere[0].ID, Rating: &good, Session: a}, later); err != nil {
		t.Fatal(err)
	}
	if err := f.s.RateItem(ctx, f.user, Rating{MaterialID: outside[0].MaterialID, ItemID: outside[0].ID, Rating: &good, Session: a}, later); err != nil {
		t.Fatal(err)
	}
	resumed, err := f.s.ResumeReviewSession(ctx, f.user, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if resumed.Group != GroupPlan || resumed.PlanID == nil || *resumed.PlanID != plan.ID || len(resumed.Done) != 2 || len(resumed.Items) != 2 {
		t.Fatalf("resumed = %+v", resumed)
	}
	if summary, err := f.s.PlanStudySummary(ctx, f.user, f.ws.ID, plan.ID, later); err != nil || summary.Unfinished == nil || summary.Unfinished.ID != a.ID || summary.Unfinished.ChapterName != "Winter exams" || len(summary.Items) != 0 {
		t.Fatalf("plan unfinished = %+v, %v", summary.Unfinished, err)
	}
	if summary, err := f.s.StudySummary(ctx, f.user, f.ws.ID, later); err != nil || summary.Unfinished != nil {
		t.Fatalf("workspace unfinished = %+v, %v", summary.Unfinished, err)
	}

	// An answer naming another plan kept here is refused.
	otherPlan, err := f.s.CreateStudyPlan(ctx, f.user, f.ws.ID, "Spring quiz")
	if err != nil {
		t.Fatal(err)
	}
	wrong := &SessionAnswer{ID: a.ID, WorkspaceID: f.ws.ID, Info: ReviewSessionInfo{Group: GroupPlan, PlanID: &otherPlan.ID}, Items: a.Items}
	if err := f.s.RateItem(ctx, f.user, Rating{MaterialID: inPlan[0].MaterialID, ItemID: inPlan[0].ID, Rating: &good, Session: wrong}, later); !errors.Is(err, ErrReviewSession) {
		t.Fatalf("answer naming another plan: %v", err)
	}

	// A plan is reviewed only from its own workspace.
	if _, err := f.s.PlanStudySummary(ctx, f.user, other.ID, plan.ID, later); !errors.Is(err, ErrReviewGroup) {
		t.Fatalf("plan from another workspace: %v", err)
	}
	// The session keeps its plan's name once the plan is deleted.
	if err := f.s.DeleteStudyPlan(ctx, f.user, plan.ID); err != nil {
		t.Fatal(err)
	}
	// It keeps taking answers, as resumed without a plan.
	resumedAnswer := &SessionAnswer{ID: a.ID, WorkspaceID: f.ws.ID, Info: ReviewSessionInfo{Group: GroupPlan}, Items: a.Items}
	if err := f.s.RateItem(ctx, f.user, Rating{MaterialID: inPlan[1].MaterialID, ItemID: inPlan[1].ID, Rating: &good, Session: resumedAnswer}, later); err != nil {
		t.Fatalf("answer after the plan's deletion: %v", err)
	}
	rows, _, err := f.s.PastReviews(ctx, f.user, PastReviewParams{ID: a.ID, Limit: 1})
	if err != nil || len(rows) != 1 || rows[0].Group != GroupPlan || rows[0].ChapterName != "Winter exams" {
		t.Fatalf("deleted plan's session = %+v, %v", rows, err)
	}
}

// A manual session takes 60% new items and 40% practised ones, spread
// through it; a short side leaves its places to the other.
func TestWithNewShares(t *testing.T) {
	items := func(prefix string, n int) ([]scored, []ranked) {
		var practised []scored
		var fresh []ranked
		for i := range n {
			it := ranked{studyItem: studyItem{ReviewItem: ReviewItem{ItemID: fmt.Sprintf("%s%d", prefix, i), Kind: "card"}}}
			practised = append(practised, scored{ranked: it, parts: [3]float64{1, 0, 0}})
			fresh = append(fresh, it)
		}
		return practised, fresh
	}
	count := func(list []ReviewItem, prefix string) int {
		n := 0
		for _, it := range list {
			if strings.HasPrefix(it.ItemID, prefix) {
				n++
			}
		}
		return n
	}
	practised, _ := items("old", 20)
	_, fresh := items("new", 20)
	prefs := ReviewPrefs{Size: 10, Items: "both"}
	got := withNew(practised, fresh, reviewGroup{kind: GroupWorkspace}, prefs)
	if len(got) != 10 || count(got, "new") != 6 || count(got, "old") != 4 || count(got[:5], "old") < 2 {
		t.Fatalf("shares = %+v", got)
	}
	got = withNew(practised, fresh[:2], reviewGroup{kind: GroupWorkspace}, prefs)
	if len(got) != 10 || count(got, "new") != 2 || count(got, "old") != 8 {
		t.Fatalf("few new = %+v", got)
	}
}

// New items come in reading order (chapters in order, then unfiled); a set
// marked unread keeps its rated cards in the practised pool.
func TestReviewPoolsOrderAndUnread(t *testing.T) {
	f := newStudyFixture(t, "u_review_pools")
	ctx := context.Background()
	first, err := f.s.AddChapter(ctx, f.ws.ID, f.user, "First")
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.s.AddChapter(ctx, f.ws.ID, f.user, "Second")
	if err != nil {
		t.Fatal(err)
	}
	late := f.set(t, [2]string{"Late", "In the second chapter"})
	early := f.set(t, [2]string{"Early", "In the first chapter"})
	loose := f.set(t, [2]string{"Loose", "Outside chapters"})
	for ch, set := range map[string][]Flashcard{second.ID: late, first.ID: early} {
		if _, err := f.s.pool.Exec(ctx, `UPDATE materials SET chapter_id=$1 WHERE id=$2`, ch, set[0].MaterialID); err != nil {
			t.Fatal(err)
		}
	}
	fresh, err := f.s.newPool(ctx, f.user, f.ws.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(fresh) != 3 || fresh[0].ItemID != early[0].ID || fresh[1].ItemID != late[0].ID || fresh[2].ItemID != loose[0].ID {
		t.Fatalf("new pool order = %+v", fresh)
	}

	f.rate(t, loose[0], 3)
	if err := f.s.SetStudyItem(ctx, f.user, f.ws.ID, nil, &loose[0].MaterialID, nil); err != nil {
		t.Fatal(err)
	}
	pool, err := f.s.reviewPool(ctx, f.user, f.ws.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(pool) != 1 || pool[0].ItemID != loose[0].ID {
		t.Fatalf("practised pool after Mark as unread = %+v", pool)
	}
}
