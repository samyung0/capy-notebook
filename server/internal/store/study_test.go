package store

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

const studyQuestions = `[
 {"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"Cells have membranes?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"},
 {"id":"q2","stem":[],"parts":[{"id":"q2:part:1","blocks":[{"type":"text","text":"Ribosomes have membranes?"}],"answer":{"type":"boolean","correct":false},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}
]`

// snapshot is an attempt's questions with q1 right and q2 wrong.
const studySnapshot = `[
 {"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[],"answer":{"type":"boolean","correct":true},"marks":1,"awarded":1,"solution":[]}],"layout":"paper","labels":"letters"},
 {"id":"q2","stem":[],"parts":[{"id":"q2:part:1","blocks":[],"answer":{"type":"boolean","correct":false},"marks":1,"awarded":0,"solution":[]}],"layout":"paper","labels":"letters"}
]`

// studyAnswers answers both studySnapshot questions; a wholly blank question
// is not rated.
const studyAnswers = `{"q1:part:1":true,"q2:part:1":true}`

type studyFixture struct {
	s    *Store
	user string
	ws   Workspace
}

// checkQuiz checks every question of a graded snapshot into one attempt, as
// the quiz page does, giving each question its own answers, and returns the
// attempt.
func checkQuiz(t *testing.T, s *Store, userID, quizID string, snapshot []byte, answers string) AttemptDetail {
	t.Helper()
	var qs []map[string]any
	if err := json.Unmarshal(snapshot, &qs); err != nil {
		t.Fatal(err)
	}
	var given map[string]any
	if err := json.Unmarshal([]byte(answers), &given); err != nil {
		t.Fatal(err)
	}
	var order []string
	marks := map[string]float64{}
	for _, q := range qs {
		id := q["id"].(string)
		order = append(order, id)
		_, marks[id] = questionMarks(q)
	}
	var d AttemptDetail
	for _, q := range qs {
		own := map[string]any{}
		for _, raw := range q["parts"].([]any) {
			id := raw.(map[string]any)["id"].(string)
			if answer, ok := given[id]; ok {
				own[id] = answer
			}
		}
		var err error
		d, err = s.CheckQuizQuestion(context.Background(), userID, quizID, QuizCheck{
			AttemptID: d.ID, Answers: own, Question: q, Order: order, Marks: marks,
		}, time.Now())
		if err != nil {
			t.Fatal(err)
		}
	}
	return d
}

func newStudyFixture(t *testing.T, label string) studyFixture {
	t.Helper()
	s := openAccessTestStore(t)
	user := newBlobTestUser(t, s, label)
	ws, err := s.CreateWorkspace(context.Background(), user, WorkspaceCreate{Name: "Study", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	return studyFixture{s, user, ws}
}

func (f studyFixture) set(t *testing.T, cards ...[2]string) []Flashcard {
	t.Helper()
	set, err := f.s.CreateFlashcardSetWithCards(context.Background(), f.user, uid("Cards "), "blue", f.ws.ID, cards, "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	list, err := f.s.ListCards(context.Background(), set.ID)
	if err != nil {
		t.Fatal(err)
	}
	return list
}

func (f studyFixture) rate(t *testing.T, c Flashcard, rating int) {
	t.Helper()
	if err := f.s.RateItem(context.Background(), f.user, Rating{MaterialID: c.MaterialID, ItemID: c.ID, Rating: &rating}, time.Now()); err != nil {
		t.Fatal(err)
	}
}

// session is a whole-workspace session serving the given cards.
func (f studyFixture) session(cards ...Flashcard) *SessionAnswer {
	a := &SessionAnswer{ID: uuid.NewString(), WorkspaceID: f.ws.ID, Info: ReviewSessionInfo{Group: GroupWorkspace}}
	for _, c := range cards {
		a.Items = append(a.Items, SessionItem{MaterialID: c.MaterialID, ItemID: c.ID})
	}
	return a
}

func (f studyFixture) quiz(t *testing.T) Quiz {
	t.Helper()
	quiz, err := f.s.CreateQuiz(context.Background(), Quiz{UserID: f.user, Name: "Quiz", WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Questions: json.RawMessage(studyQuestions), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	return quiz
}

func (f studyFixture) progress(t *testing.T, materialID string) string {
	t.Helper()
	var state string
	err := f.s.pool.QueryRow(context.Background(), `SELECT state FROM study_progress WHERE user_id=$1 AND material_id=$2`, f.user, materialID).Scan(&state)
	if isNoRows(err) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func (f studyFixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := f.s.pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPracticeRecordsStudyProgress(t *testing.T) {
	f := newStudyFixture(t, "u_study_practice")
	ctx := context.Background()

	quiz, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: "Quiz", WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Questions: json.RawMessage(studyQuestions), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	checkQuiz(t, f.s, f.user, quiz.ID, []byte(studySnapshot), studyAnswers)
	if got := f.progress(t, quiz.ID); got != "done" {
		t.Fatalf("quiz progress after an attempt = %q", got)
	}
	if n := f.count(t, `SELECT count(*) FROM review_states WHERE user_id=$1 AND material_id=$2`, f.user, quiz.ID); n != 2 {
		t.Fatalf("rated questions = %d", n)
	}

	// A quiz inside a note is a quick check that records nothing: the graded
	// attempt comes back without an id, and no attempt, progress or review state
	// is stored.
	note, err := f.s.CreateMaterial(ctx, Material{CreatedBy: f.user, WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Kind: "note", Title: "Note", Content: materialTestContent(t, "# Note")})
	if err != nil {
		t.Fatal(err)
	}
	embedded, err := f.s.CreateEmbeddedMaterial(ctx, f.user, note.ID, EmbeddedDraft{Kind: "quiz", Questions: json.RawMessage(studyQuestions)})
	if err != nil {
		t.Fatal(err)
	}
	var first []map[string]any
	if err := json.Unmarshal([]byte(studySnapshot), &first); err != nil {
		t.Fatal(err)
	}
	if attempt, err := f.s.CheckQuizQuestion(ctx, f.user, embedded.ID, QuizCheck{
		Answers: map[string]any{"q1:part:1": true}, Question: first[0], Order: []string{"q1", "q2"}, Marks: map[string]float64{"q1": 1, "q2": 1},
	}, time.Now()); err != nil || attempt.ID != "" || attempt.Correct != 1 {
		t.Fatalf("embedded attempt %+v %v", attempt, err)
	}
	if n := f.count(t, `SELECT count(*) FROM attempts WHERE material_id=$1`, embedded.ID); n != 0 {
		t.Fatalf("embedded quiz attempts = %d", n)
	}
	if got := f.progress(t, embedded.ID); got != "" {
		t.Fatalf("embedded quiz progress = %q", got)
	}
	if n := f.count(t, `SELECT count(*) FROM review_states WHERE material_id=$1`, embedded.ID); n != 0 {
		t.Fatalf("embedded quiz review states = %d", n)
	}

	cards := f.set(t, [2]string{"Golgi", "Ships proteins"}, [2]string{"Lysosome", "Digests waste"})
	set := cards[0].MaterialID
	f.rate(t, cards[0], 3)
	if got := f.progress(t, set); got != "started" {
		t.Fatalf("set after one card = %q", got)
	}
	f.rate(t, cards[1], 1)
	if got := f.progress(t, set); got != "done" {
		t.Fatalf("set after every card = %q", got)
	}
	// A card added later leaves the set done.
	appendCard(t, f.s, f.user, set, "Nucleus", "Holds DNA")
	f.rate(t, cards[0], 3)
	if got := f.progress(t, set); got != "done" {
		t.Fatalf("set after a new card = %q", got)
	}
	// Practising a removed set brings it back.
	removed := "removed"
	if err := f.s.SetStudyItem(ctx, f.user, f.ws.ID, nil, &set, &removed); err != nil {
		t.Fatal(err)
	}
	f.rate(t, cards[0], 3)
	if got := f.progress(t, set); got == "removed" || got == "" {
		t.Fatalf("removed set after practice = %q", got)
	}
	score := 1.0
	if err := f.s.RateItem(ctx, f.user, Rating{MaterialID: set, ItemID: cards[0].ID, Score: &score}, time.Now()); !errors.Is(err, ErrStudyRating) {
		t.Fatalf("a card scored like a question: %v", err)
	}
	if err := f.s.SetStudyItem(ctx, f.user, f.ws.ID, nil, &embedded.ID, &removed); !errors.Is(err, ErrStudyTarget) {
		t.Fatalf("an embedded quiz entered progress: %v", err)
	}

	// What the chat agent reads: the quiz and the set, the one workspace quiz
	// attempt, and the unfiled chapter holding all four rated items.
	progress, err := f.s.AgentStudyProgress(ctx, f.user, f.ws.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !progress.Enabled || len(progress.Items) != 2 || len(progress.RecentAttempts) != 1 ||
		len(progress.WeakChapters) != 1 || progress.WeakChapters[0].Items != 4 {
		t.Fatalf("agent progress = %+v", progress)
	}
}

func TestWorkspaceReviewSelection(t *testing.T) {
	f := newStudyFixture(t, "u_study_review")
	ctx := context.Background()
	kept := f.set(t, [2]string{"Golgi", "Ships proteins"}, [2]string{"Lysosome", "Digests waste"})
	gone := f.set(t, [2]string{"Ribosome", "Makes proteins"})
	trashed := f.set(t, [2]string{"Nucleus", "Holds DNA"})
	unrated := f.set(t, [2]string{"Vacuole", "Stores water"})
	for _, c := range []Flashcard{kept[0], kept[1], gone[0], trashed[0]} {
		f.rate(t, c, 3)
	}
	removed := "removed"
	if err := f.s.SetStudyItem(ctx, f.user, f.ws.ID, nil, &gone[0].MaterialID, &removed); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.TrashMaterial(ctx, f.user, trashed[0].MaterialID, "", AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	// Editing a card makes it new until it is rated again.
	editCardFront(t, f.s, f.user, kept[1].MaterialID, kept[1].ID, "Golgi apparatus")

	// A manual review takes the practised card and the new ones (the edited
	// card and the never-rated set), not the removed or trashed sets.
	mixed, err := f.s.WorkspaceReview(ctx, f.user, f.ws.ID, ReviewSessionInfo{Group: GroupWorkspace}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, it := range mixed.Items {
		got[it.ItemID] = true
	}
	if len(mixed.Items) != 3 || !got[kept[0].ID] || !got[kept[1].ID] || !got[unrated[0].ID] {
		t.Fatalf("mixed review = %+v", mixed)
	}
	// A missed card enters Quick review with both faces once it fades (a
	// moment after the miss it is still recalled); the Study tab and Learning
	// count the same pool.
	f.rate(t, kept[0], 1)
	fresh, err := f.s.StudySummary(ctx, f.user, f.ws.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(fresh.QuickReview) != 0 {
		t.Fatalf("quick review right after the miss = %+v", fresh.QuickReview)
	}
	summary, err := f.s.StudySummary(ctx, f.user, f.ws.ID, time.Now().Add(72*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if summary.Reviewable != 1 || len(summary.QuickReview) != 1 || summary.QuickReview[0].Front != "Golgi" || summary.QuickReview[0].Back != "Ships proteins" {
		t.Fatalf("quick review = %+v", summary)
	}
	overview, err := f.s.ReviewOverview(ctx, f.user, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if listed := overview.Workspaces; len(listed) != 1 || listed[0].WorkspaceID != f.ws.ID || listed[0].Reviewable != 1 || listed[0].LastReviewedAt != nil {
		t.Fatalf("review workspaces = %+v", listed)
	}

	if err := f.s.ResetStudy(ctx, f.user, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	if n := f.count(t, `SELECT count(*) FROM study_progress WHERE user_id=$1`, f.user); n != 0 {
		t.Fatalf("progress after reset = %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM review_states WHERE user_id=$1`, f.user); n != 0 {
		t.Fatalf("review states after reset = %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM review_log WHERE user_id=$1`, f.user); n != 5 {
		t.Fatalf("review log after reset = %d", n)
	}

	// Account purge deletes every per-user study row, sessions included.
	good := 3
	if err := f.s.RateItem(ctx, f.user, Rating{MaterialID: kept[0].MaterialID, ItemID: kept[0].ID, Rating: &good,
		Session: f.session(kept[0])}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := f.s.SetWorkspaceStudy(ctx, f.user, f.ws.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CreateStudyPlan(ctx, f.user, f.ws.ID, "Plan"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.RequestAccountDeletion(ctx, f.user, true); err != nil {
		t.Fatal(err)
	}
	if err := f.s.PurgeUser(ctx, f.user); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"study_progress", "workspace_study", "review_states", "review_log", "review_sessions", "study_plans"} {
		if n := f.count(t, `SELECT count(*) FROM `+table+` WHERE user_id=$1`, f.user); n != 0 {
			t.Fatalf("%s after account purge = %d", table, n)
		}
	}
}

// A question's rating follows its share of the marks, half marks included.
func TestQuizAttemptRatesHalfMarks(t *testing.T) {
	f := newStudyFixture(t, "u_study_half")
	ctx := context.Background()
	question := func(id string, awarded any) map[string]any {
		part := map[string]any{"id": id + ":part:1", "blocks": []any{map[string]any{"type": "text", "text": "Explain " + id}},
			"answer": map[string]any{"type": "open", "accepted": []any{"A model answer"}, "hints": []any{}}, "marks": 2,
			"markscheme": []any{map[string]any{"text": "Point", "marks": 2}}, "solution": []any{}}
		if awarded != nil {
			part["awarded"] = awarded
		}
		return map[string]any{"id": id, "stem": []any{}, "parts": []any{part}, "layout": "paper", "labels": "letters"}
	}
	authored, _ := json.Marshal([]any{question("a", nil), question("b", nil), question("c", nil)})
	quiz, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: "Half", WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Questions: authored, Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	// Remove the quiz first: an attempt brings it back.
	removed := "removed"
	if err := f.s.SetStudyItem(ctx, f.user, f.ws.ID, nil, &quiz.ID, &removed); err != nil {
		t.Fatal(err)
	}
	snapshot, _ := json.Marshal([]any{question("a", 0.5), question("b", 1), question("c", 1.5)})
	answers := `{"a:part:1":"x","b:part:1":"x","c:part:1":"x"}`
	checkQuiz(t, f.s, f.user, quiz.ID, snapshot, answers)
	if got := f.progress(t, quiz.ID); got != "done" {
		t.Fatalf("removed quiz after an attempt = %q", got)
	}
	for item, want := range map[string]int{"a": 1, "b": 2, "c": 3} {
		if n := f.count(t, `SELECT rating FROM review_log WHERE user_id=$1 AND material_id=$2 AND item_id=$3`, f.user, quiz.ID, item); n != want {
			t.Errorf("question %s rated %d, want %d", item, n, want)
		}
	}
}

// Checks build one attempt in the quiz's order, scored out of the whole quiz;
// a question is checked once per attempt, and an unknown id starts a new one.
func TestQuizChecksBuildOneAttempt(t *testing.T) {
	f := newStudyFixture(t, "u_study_checks")
	ctx := context.Background()
	quiz, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: "Quiz", WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Questions: json.RawMessage(studyQuestions), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	var graded []map[string]any
	if err := json.Unmarshal([]byte(studySnapshot), &graded); err != nil {
		t.Fatal(err)
	}
	started := time.Now().Add(-5 * time.Minute)
	marks := map[string]float64{"q1": 1, "q2": 1}
	check := func(attemptID string, q int) (AttemptDetail, error) {
		id := graded[q]["id"].(string)
		return f.s.CheckQuizQuestion(ctx, f.user, quiz.ID, QuizCheck{
			AttemptID: attemptID, StartedAt: &started, Answers: map[string]any{id + ":part:1": true},
			Question: graded[q], Order: []string{"q1", "q2"}, Marks: marks,
		}, time.Now())
	}
	// q2 first: the snapshot still follows the quiz's order.
	first, err := check("", 1)
	if err != nil || first.ID == "" || first.Correct != 0 || first.Total != 2 || first.StartedAt == nil {
		t.Fatalf("first check = %+v, %v", first.Attempt, err)
	}
	if _, err := check(first.ID, 1); !errors.Is(err, ErrQuestionChecked) {
		t.Fatalf("second check of a question = %v", err)
	}
	if checked, err := f.s.QuizQuestionChecked(ctx, f.user, quiz.ID, first.ID, "q2"); err != nil || !checked {
		t.Fatalf("q2 checked = %v, %v", checked, err)
	}
	if checked, err := f.s.QuizQuestionChecked(ctx, f.user, quiz.ID, first.ID, "q1"); err != nil || checked {
		t.Fatalf("q1 checked = %v, %v", checked, err)
	}
	// q2's marks rise after it was checked: it still counts out of the 1 mark
	// it was checked against, so the score never passes its total.
	marks["q2"] = 5
	both, err := check(first.ID, 0)
	if err != nil || both.ID != first.ID || both.Correct != 1 || both.Total != 2 || both.Pct != 50 {
		t.Fatalf("continued attempt = %+v, %v", both.Attempt, err)
	}
	var order []struct{ ID string }
	var answers map[string]any
	if err := json.Unmarshal(both.Questions, &order); err != nil || len(order) != 2 || order[0].ID != "q1" {
		t.Fatalf("snapshot order = %+v, %v", order, err)
	}
	if err := json.Unmarshal(both.Answers, &answers); err != nil || len(answers) != 2 {
		t.Fatalf("answers = %v, %v", answers, err)
	}
	if fresh, err := check("at_gone", 0); err != nil || fresh.ID == "at_gone" || fresh.ID == first.ID {
		t.Fatalf("unknown attempt id = %+v, %v", fresh.Attempt, err)
	}
	if n := f.count(t, `SELECT count(*) FROM attempts WHERE material_id=$1`, quiz.ID); n != 2 {
		t.Fatalf("attempts = %d, want 2", n)
	}
}

// A question left wholly blank scores 0 in the attempt but is not rated: a
// skip says nothing about recall.
func TestQuizAttemptSkipsBlankQuestions(t *testing.T) {
	f := newStudyFixture(t, "u_study_blank")
	ctx := context.Background()
	quiz, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: "Quiz", WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Questions: json.RawMessage(studyQuestions), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	if d := checkQuiz(t, f.s, f.user, quiz.ID, []byte(studySnapshot), `{"q1:part:1":true}`); d.Correct != 1 || d.Total != 2 {
		t.Fatalf("attempt scored %v of %v", d.Correct, d.Total)
	}
	if n := f.count(t, `SELECT count(*) FROM review_log WHERE user_id=$1 AND material_id=$2 AND item_id='q1'`, f.user, quiz.ID); n != 1 {
		t.Fatalf("answered question ratings = %d, want 1", n)
	}
	if n := f.count(t, `SELECT count(*) FROM review_log WHERE user_id=$1 AND material_id=$2 AND item_id='q2'`, f.user, quiz.ID); n != 0 {
		t.Fatalf("blank question ratings = %d, want 0", n)
	}
}

// Embedded sets and cards deleted from their set stay out of review; an
// edited card comes back as a new item and starts again when it is rated.
func TestReviewSkipsEmbeddedOrphanedAndEditedItems(t *testing.T) {
	f := newStudyFixture(t, "u_study_orphans")
	ctx := context.Background()
	cards := f.set(t, [2]string{"Golgi", "Ships proteins"}, [2]string{"Lysosome", "Digests waste"}, [2]string{"Nucleus", "Holds DNA"})
	for _, c := range cards {
		f.rate(t, c, 3)
	}
	f.rate(t, cards[2], 3)
	note, err := f.s.CreateMaterial(ctx, Material{CreatedBy: f.user, WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Kind: "note", Title: "Note", Content: materialTestContent(t, "# Note")})
	if err != nil {
		t.Fatal(err)
	}
	embedded, err := f.s.CreateEmbeddedMaterial(ctx, f.user, note.ID, EmbeddedDraft{Kind: "flashcards", Cards: [][2]string{{"Ribosome", "Makes proteins"}}})
	if err != nil {
		t.Fatal(err)
	}
	inner, err := f.s.ListCards(ctx, embedded.ID)
	if err != nil {
		t.Fatal(err)
	}
	again := 1
	if err := f.s.RateItem(ctx, f.user, Rating{MaterialID: embedded.ID, ItemID: inner[0].ID, Rating: &again}, time.Now()); !errors.Is(err, ErrStudyEmbedded) {
		t.Fatalf("embedded card rating: %v, want ErrStudyEmbedded", err)
	}

	removeCard(t, f.s, f.user, cards[0].MaterialID, cards[1].ID)
	editCardFront(t, f.s, f.user, cards[0].MaterialID, cards[2].ID, "Nucleus envelope")
	mixed, err := f.s.WorkspaceReview(ctx, f.user, f.ws.ID, ReviewSessionInfo{Group: GroupWorkspace}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(mixed.Items) != 2 || mixed.Items[0].ItemID != cards[2].ID || mixed.Items[1].ItemID != cards[0].ID {
		t.Fatalf("mixed review = %+v", mixed)
	}
	f.rate(t, cards[2], 3)
	if n := f.count(t, `SELECT reps FROM review_states WHERE user_id=$1 AND item_id=$2`, f.user, cards[2].ID); n != 1 {
		t.Fatalf("edited card reps after a new rating = %d, want 1", n)
	}
}

// Ratings of a set's last cards made at once still mark it done.
func TestConcurrentRatingsFinishASet(t *testing.T) {
	f := newStudyFixture(t, "u_study_race")
	for round := 0; round < 5; round++ {
		cards := f.set(t, [2]string{"A", "1"}, [2]string{"B", "2"}, [2]string{"C", "3"}, [2]string{"D", "4"})
		var wg sync.WaitGroup
		errs := make(chan error, len(cards))
		for _, c := range cards {
			wg.Add(1)
			go func(c Flashcard) {
				defer wg.Done()
				good := 3
				errs <- f.s.RateItem(context.Background(), f.user, Rating{MaterialID: c.MaterialID, ItemID: c.ID, Rating: &good}, time.Now())
			}(c)
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatal(err)
			}
		}
		if got := f.progress(t, cards[0].MaterialID); got != "done" {
			t.Fatalf("round %d: set rated at once = %q", round, got)
		}
	}
}

// Progress is the user's own: a cloned workspace starts with none.
func TestCloneCopiesNoStudyProgress(t *testing.T) {
	f := newStudyFixture(t, "u_study_clone")
	ctx := context.Background()
	cards := f.set(t, [2]string{"Golgi", "Ships proteins"})
	f.rate(t, cards[0], 1)
	clone, err := f.s.CloneWorkspace(ctx, f.user, f.ws.ID, WorkspaceCreate{Name: "Clone"})
	if err != nil {
		t.Fatal(err)
	}
	if n := f.count(t, `SELECT count(*) FROM study_progress WHERE workspace_id=$1`, clone.ID); n != 0 {
		t.Fatalf("cloned progress rows = %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM review_states rs JOIN materials m ON m.id=rs.material_id WHERE m.workspace_id=$1`, clone.ID); n != 0 {
		t.Fatalf("cloned review states = %d", n)
	}
}

func TestReviewCardItemsCarryTheCardImage(t *testing.T) {
	content, err := materialdoc.FlashcardsDocument([]materialdoc.Card{
		{ID: "c1", Front: "Nucleus", Back: "Holds DNA", Image: &materialdoc.CardImage{AssetID: "asset-cell"}},
		{ID: "c2", Front: "Golgi", Back: "Ships proteins"},
	})
	if err != nil {
		t.Fatal(err)
	}
	items, err := materialItems(Material{ID: "m", Kind: "flashcards", Content: content})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].Image == nil || items[0].Image.AssetID != "asset-cell" || items[1].Image != nil {
		t.Fatalf("items = %+v", items)
	}
}

func TestQuickQuestion(t *testing.T) {
	part := func(kind string) map[string]any {
		return map[string]any{"id": "p", "answer": map[string]any{"type": kind}}
	}
	q := func(parts ...map[string]any) map[string]any {
		list := []any{}
		for _, p := range parts {
			list = append(list, p)
		}
		return map[string]any{"id": "q", "parts": list}
	}
	for _, kind := range []string{"mcq", "boolean", "short", "gaps"} {
		if !quickQuestion(q(part(kind))) {
			t.Errorf("single %s part left out", kind)
		}
	}
	for name, question := range map[string]map[string]any{
		"open":       q(part("open")),
		"matching":   q(part("matching")),
		"ordering":   q(part("ordering")),
		"multi-part": q(part("mcq"), part("short")),
		"card":       nil,
	} {
		if quickQuestion(question) {
			t.Errorf("%s entered quick review", name)
		}
	}
}

// A flashcard attempt keeps cards in first-rated order with every rating,
// scores first ratings of Good or Easy, and lists with quiz attempts.
func TestFlashcardAttemptRecordsRatings(t *testing.T) {
	f := newStudyFixture(t, "u_study_card_attempt")
	ctx := context.Background()
	cards := f.set(t, [2]string{"Mitochondria", "ATP"}, [2]string{"Ribosome", "Proteins"})
	ref := &FlashcardAttemptRef{ID: uuid.NewString(), StartedAt: time.Now().Add(-9 * time.Minute)}
	for _, r := range []struct {
		card   Flashcard
		rating int
	}{{cards[1], 1}, {cards[0], 4}, {cards[1], 3}} {
		rating := r.rating
		if err := f.s.RateItem(ctx, f.user, Rating{MaterialID: r.card.MaterialID, ItemID: r.card.ID, Rating: &rating, Attempt: ref}, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	d, err := f.s.GetAttempt(ctx, ref.ID, f.user)
	if err != nil {
		t.Fatal(err)
	}
	var got []AttemptCard
	if err := json.Unmarshal(d.Questions, &got); err != nil {
		t.Fatal(err)
	}
	if d.Kind != "flashcards" || d.Correct != 1 || d.Total != 2 || d.StartedAt == nil ||
		len(got) != 2 || got[0].Front != "Ribosome" || len(got[0].Ratings) != 2 || got[1].Ratings[0] != 4 {
		t.Fatalf("attempt = %+v, cards %+v", d.Attempt, got)
	}
	checkQuiz(t, f.s, f.user, f.quiz(t).ID, []byte(studySnapshot), studyAnswers)
	only, _, err := f.s.ListAttempts(ctx, f.user, AttemptParams{Kinds: []string{"flashcards"}, Limit: 30})
	if err != nil || len(only) != 1 || only[0].ID != ref.ID {
		t.Fatalf("flashcard attempts = %+v, %v", only, err)
	}
	items, err := f.s.WorkspaceAttempts(ctx, f.user, f.ws.ID)
	if err != nil || len(items) != 2 {
		t.Fatalf("workspace attempts = %+v, %v", items, err)
	}
	for _, it := range items {
		if it.Count != 1 || len(it.Recent) != 1 || it.Size != 2 {
			t.Fatalf("item = %+v", it)
		}
	}
}

// A flashcard result carries the set's attempt before it.
func TestFlashcardAttemptPrevious(t *testing.T) {
	f := newStudyFixture(t, "u_study_card_previous")
	ctx := context.Background()
	cards := f.set(t, [2]string{"Mitochondria", "ATP"}, [2]string{"Ribosome", "Proteins"})
	first, second := uuid.NewString(), uuid.NewString()
	at := time.Now().Add(-time.Hour)
	for _, run := range []struct {
		id     string
		at     time.Time
		rating int
	}{{first, at, 1}, {second, at.Add(time.Minute), 3}} {
		rating := run.rating
		ref := &FlashcardAttemptRef{ID: run.id, StartedAt: run.at.Add(-time.Minute)}
		if err := f.s.RateItem(ctx, f.user, Rating{MaterialID: cards[0].MaterialID, ItemID: cards[0].ID, Rating: &rating, Attempt: ref}, run.at); err != nil {
			t.Fatal(err)
		}
	}
	d, err := f.s.GetAttempt(ctx, second, f.user)
	if err != nil || d.Previous == nil || d.Previous.Correct != 0 || d.Previous.Total != 1 {
		t.Fatalf("previous = %+v, %v", d.Previous, err)
	}
}

// A suspended account records no flashcard attempt, as it records no quiz
// attempt.
func TestSuspendedUserRecordsNoFlashcardAttempt(t *testing.T) {
	f := newStudyFixture(t, "u_study_card_suspended")
	ctx := context.Background()
	cards := f.set(t, [2]string{"Front", "Back"})
	if _, err := f.s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id=$1`, f.user); err != nil {
		t.Fatal(err)
	}
	rating := 3
	ref := &FlashcardAttemptRef{ID: uuid.NewString(), StartedAt: time.Now()}
	if err := f.s.RateItem(ctx, f.user, Rating{MaterialID: cards[0].MaterialID, ItemID: cards[0].ID, Rating: &rating, Attempt: ref}, time.Now()); err == nil {
		t.Fatal("suspended user rated a card into an attempt")
	}
	if n := f.count(t, `SELECT count(*) FROM attempts WHERE user_id=$1`, f.user); n != 0 {
		t.Fatalf("attempts = %d", n)
	}
}
