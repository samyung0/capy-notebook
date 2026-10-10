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

type studyFixture struct {
	s    *Store
	user string
	ws   Workspace
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
	if _, err := f.s.CreateAttempt(ctx, f.user, quiz.ID, 1, 2, json.RawMessage(`{}`), json.RawMessage(studySnapshot)); err != nil {
		t.Fatal(err)
	}
	if got := f.progress(t, quiz.ID); got != "done" {
		t.Fatalf("quiz progress after an attempt = %q", got)
	}
	if n := f.count(t, `SELECT count(*) FROM review_states WHERE user_id=$1 AND material_id=$2`, f.user, quiz.ID); n != 2 {
		t.Fatalf("rated questions = %d", n)
	}

	// A quiz inside a note is a quick check that records nothing: the graded
	// attempt comes back without an id, and no attempt, progress or review state
	// is stored.
	note, err := f.s.CreateMaterial(ctx, Material{CreatedBy: f.user, WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Kind: "note", Title: "Note", Content: "# Note"})
	if err != nil {
		t.Fatal(err)
	}
	embedded, err := f.s.CreateEmbeddedMaterial(ctx, f.user, note.ID, EmbeddedDraft{Kind: "quiz", Questions: json.RawMessage(studyQuestions)})
	if err != nil {
		t.Fatal(err)
	}
	if attempt, err := f.s.CreateAttempt(ctx, f.user, embedded.ID, 1, 2, json.RawMessage(`{}`), json.RawMessage(studySnapshot)); err != nil || attempt.ID != "" || attempt.Correct != 1 {
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
	// Editing a card makes it new: it leaves mixed review until it is rated again.
	editCardFront(t, f.s, f.user, kept[1].MaterialID, kept[1].ID, "Golgi apparatus")

	mixed, err := f.s.WorkspaceReview(ctx, f.user, f.ws.ID, ReviewSessionInfo{Group: GroupWorkspace}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(mixed.Items) != 1 || mixed.Items[0].ItemID != kept[0].ID {
		t.Fatalf("mixed review = %+v", mixed)
	}
	// A missed card enters Quick review with both faces; the Study tab and
	// Learning count the same pool.
	f.rate(t, kept[0], 1)
	summary, err := f.s.StudySummary(ctx, f.user, f.ws.ID, time.Now())
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
	if _, err := f.s.RequestAccountDeletion(ctx, f.user, true); err != nil {
		t.Fatal(err)
	}
	if err := f.s.PurgeUser(ctx, f.user); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"study_progress", "workspace_study", "review_states", "review_log", "review_sessions"} {
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
	if _, err := f.s.CreateAttempt(ctx, f.user, quiz.ID, 3, 6, json.RawMessage(`{}`), snapshot); err != nil {
		t.Fatal(err)
	}
	if got := f.progress(t, quiz.ID); got != "done" {
		t.Fatalf("removed quiz after an attempt = %q", got)
	}
	for item, want := range map[string]int{"a": 1, "b": 2, "c": 3} {
		if n := f.count(t, `SELECT rating FROM review_log WHERE user_id=$1 AND material_id=$2 AND item_id=$3`, f.user, quiz.ID, item); n != want {
			t.Errorf("question %s rated %d, want %d", item, n, want)
		}
	}
}

// Embedded sets, cards deleted from their set and edited cards stay out of
// review; an edited card starts again when it is rated.
func TestReviewSkipsEmbeddedOrphanedAndEditedItems(t *testing.T) {
	f := newStudyFixture(t, "u_study_orphans")
	ctx := context.Background()
	cards := f.set(t, [2]string{"Golgi", "Ships proteins"}, [2]string{"Lysosome", "Digests waste"}, [2]string{"Nucleus", "Holds DNA"})
	for _, c := range cards {
		f.rate(t, c, 3)
	}
	f.rate(t, cards[2], 3)
	note, err := f.s.CreateMaterial(ctx, Material{CreatedBy: f.user, WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Kind: "note", Title: "Note", Content: "# Note"})
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
	if len(mixed.Items) != 1 || mixed.Items[0].ItemID != cards[0].ID {
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
	clone, err := f.s.CloneWorkspace(ctx, f.user, f.ws.ID)
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
