package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
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

	// A quiz inside a note is a mini check: no progress, no review state.
	note, err := f.s.CreateMaterial(ctx, Material{CreatedBy: f.user, WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Kind: "note", Title: "Note", Content: "# Note"})
	if err != nil {
		t.Fatal(err)
	}
	embedded, err := f.s.CreateEmbeddedMaterial(ctx, f.user, note.ID, EmbeddedDraft{Kind: "quiz", Questions: json.RawMessage(studyQuestions)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CreateAttempt(ctx, f.user, embedded.ID, 1, 2, json.RawMessage(`{}`), json.RawMessage(studySnapshot)); err != nil {
		t.Fatal(err)
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
	if _, err := f.s.CreateCard(ctx, f.user, set, "Nucleus", "Holds DNA", cards[0].Revision); err != nil {
		t.Fatal(err)
	}
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
	front := "Golgi apparatus"
	if _, err := f.s.UpdateCardContent(ctx, kept[1].ID, CardContentPatch{ExpectedRevision: kept[1].Revision, Front: &front, UpdatedBy: f.user}); err != nil {
		t.Fatal(err)
	}

	mixed, err := f.s.WorkspaceReview(ctx, f.user, f.ws.ID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(mixed.Sets) != 1 || mixed.Sets[0].MaterialID != kept[0].MaterialID || len(mixed.Items) != 1 || mixed.Items[0].ItemID != kept[0].ID {
		t.Fatalf("mixed review = %+v", mixed)
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
	if n := f.count(t, `SELECT count(*) FROM review_log WHERE user_id=$1`, f.user); n != 4 {
		t.Fatalf("review log after reset = %d", n)
	}

	if _, err := f.s.RequestAccountDeletion(ctx, f.user, true); err != nil {
		t.Fatal(err)
	}
	if err := f.s.PurgeUser(ctx, f.user); err != nil {
		t.Fatal(err)
	}
	if n := f.count(t, `SELECT count(*) FROM review_log WHERE user_id=$1`, f.user); n != 0 {
		t.Fatalf("review log after account purge = %d", n)
	}
}
