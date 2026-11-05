package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
)

// TestExtractionLifecycle: a run keeps its recorded questions while running,
// ends once, is visible only to its starter, and a restart fails what was left
// running.
func TestExtractionLifecycle(t *testing.T) {
	f := newStudyFixture(t, "extract")
	ctx := context.Background()
	other := newBlobTestUser(t, f.s, "extract-other")

	run, err := f.s.CreateExtraction(ctx, ExtractionStart{ID: uuid.NewString(), WorkspaceID: f.ws.ID, UserID: f.user, Title: "Paper 2"})
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ExtractionRunning || run.Recorded != 0 {
		t.Fatalf("new run = %+v", run)
	}
	if err := f.s.SaveExtractionProgress(ctx, run.ID, 2, 1); err != nil {
		t.Fatal(err)
	}
	if got, err := f.s.GetExtraction(ctx, f.user, run.ID); err != nil || got.Recorded != 2 || got.Answered != 1 {
		t.Fatalf("saved run = %+v, %v", got, err)
	}
	if _, err := f.s.GetExtraction(ctx, other, run.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another user read the run: %v", err)
	}
	quiz, err := f.s.CreateMaterialDraft(ctx, MaterialDraft{
		ActorUserID: f.user, WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Kind: MaterialQuiz, Title: "Paper 2",
		Questions: json.RawMessage(`[{"id":"q1","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p1","blocks":[{"type":"text","text":"Pick"}],"answer":{"type":"mcq","options":["a","b"],"correct":[1]},"marks":1,"solution":[]}]}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	done, err := f.s.FinishExtraction(ctx, run.ID, quiz.ID, json.RawMessage(`{"missing":["3"]}`))
	if err != nil || done.Status != ExtractionDone || done.QuizID == nil || *done.QuizID != quiz.ID || done.FinishedAt == nil {
		t.Fatalf("finished run = %+v, %v", done, err)
	}
	if _, err := f.s.FailExtraction(ctx, run.ID, "late", "late", nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an ended run failed again: %v", err)
	}

	cut, err := f.s.CreateExtraction(ctx, ExtractionStart{ID: uuid.NewString(), WorkspaceID: f.ws.ID, UserID: f.user, Title: "Paper 1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.s.FailOrphanedExtractions(ctx); err != nil {
		t.Fatal(err)
	}
	if got, err := f.s.GetExtraction(ctx, f.user, cut.ID); err != nil || got.Status != ExtractionFailed || got.ErrorCode == nil || *got.ErrorCode != "interrupted" {
		t.Fatalf("orphaned run = %+v, %v", got, err)
	}
}

// A run paused on its map: confirming holds the price and takes the session's rates
// to zero, and the charge at the end is per saved question up to the number confirmed;
// cancelling ends it with nothing more to pay.
func TestExtractionConfirmHoldsThePriceAndChargesPerQuestion(t *testing.T) {
	f := newStudyFixture(t, "extract-confirm")
	ctx := context.Background()
	found := json.RawMessage(`[{"label":"1","first":1,"last":1,"parts":[]},{"label":"2","first":1,"last":1,"parts":["a"]},{"label":"3","first":2,"last":2,"parts":[]}]`)
	paused := func(title string) Extraction {
		t.Helper()
		session, err := f.s.BeginProviderSession(ctx, f.user, f.ws.ID, SurfaceGenerate,
			TokenRates{MicrosPerInputToken: 200, MicrosPerOutputToken: 1200, MicrosPerCachedInputToken: 20}, TokenRates{}, "")
		if err != nil {
			t.Fatal(err)
		}
		run, err := f.s.CreateExtraction(ctx, ExtractionStart{
			ID: uuid.NewString(), WorkspaceID: f.ws.ID, UserID: f.user, Title: title, SpendSessionID: session,
			UnreadAnswers: []string{"Scheme.pdf"}, PaperName: "Paper.pdf",
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := f.s.AwaitExtractionConfirm(ctx, run.ID, found); err != nil {
			t.Fatal(err)
		}
		return run
	}

	run := paused("Paper A")
	got, err := f.s.GetExtraction(ctx, f.user, run.ID)
	if err != nil || got.Status != ExtractionConfirming || got.Found == nil || len(got.Found.Questions) != 3 ||
		got.Found.Questions[1].Parts[0] != "a" || got.Found.UnreadAnswers[0] != "Scheme.pdf" || got.Found.AvailableCredits <= 0 {
		t.Fatalf("paused run = %+v, %v", got, err)
	}
	before, err := f.s.CreditBalance(ctx, f.user)
	if err != nil {
		t.Fatal(err)
	}
	confirmed, err := f.s.ConfirmExtraction(ctx, f.user, run.ID, 2)
	if err != nil || confirmed.Status != ExtractionRunning || confirmed.Confirmed == nil || *confirmed.Confirmed != 2 {
		t.Fatalf("confirmed run = %+v, %v", confirmed, err)
	}
	held, err := f.s.CreditBalance(ctx, f.user)
	if err != nil {
		t.Fatal(err)
	}
	// The row keeps the run's record, and nothing of the files.
	var kept int
	var foundNull bool
	var paperName string
	if err := f.s.pool.QueryRow(ctx, `SELECT found_questions, found IS NULL, paper_name
		FROM question_extractions WHERE id=$1`, run.ID).Scan(&kept, &foundNull, &paperName); err != nil {
		t.Fatal(err)
	}
	if kept != 3 || !foundNull || paperName != "" {
		t.Fatalf("after the confirm: found %d, cleared %v, paper %q", kept, foundNull, paperName)
	}
	if held.ReservedMicros != before.ReservedMicros+2*ExtractionQuestionMicros {
		t.Fatalf("held %d, was %d", held.ReservedMicros, before.ReservedMicros)
	}
	if _, err := f.s.ConfirmExtraction(ctx, f.user, run.ID, 2); !errors.Is(err, ErrConflict) {
		t.Fatalf("confirmed twice: %v", err)
	}
	var input int64
	if err := f.s.pool.QueryRow(ctx, `SELECT llm_micros_per_input_token FROM provider_sessions WHERE id=$1`,
		confirmed.SpendSessionID).Scan(&input); err != nil || input != 0 {
		t.Fatalf("session rate = %d, %v", input, err)
	}
	// Three saved, two confirmed: two charged, once however often it is asked.
	for range 2 {
		if err := f.s.ChargeExtractionQuestions(ctx, confirmed, f.user, 3); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.s.SettleCredits(ctx, confirmed.SpendSessionID); err != nil {
		t.Fatal(err)
	}
	after, err := f.s.CreditBalance(ctx, f.user)
	if err != nil {
		t.Fatal(err)
	}
	if after.ReservedMicros != before.ReservedMicros || after.AvailableMicros() != before.AvailableMicros()-2*ExtractionQuestionMicros {
		t.Fatalf("after = %+v, before = %+v", after, before)
	}

	cancelled := paused("Paper B")
	if _, err := f.s.ConfirmExtraction(ctx, f.user, cancelled.ID, 4); !errors.Is(err, ErrConflict) {
		t.Fatalf("more questions than found: %v", err)
	}
	ended, err := f.s.CancelExtraction(ctx, f.user, cancelled.ID)
	if err != nil || ended.Status != ExtractionCancelled || ended.FinishedAt == nil {
		t.Fatalf("cancelled run = %+v, %v", ended, err)
	}
	if _, err := f.s.ConfirmExtraction(ctx, f.user, cancelled.ID, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("confirmed a cancelled run: %v", err)
	}
	if _, err := f.s.FailExtraction(ctx, cancelled.ID, "late", "late", nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("failed a cancelled run: %v", err)
	}

	// A restart mid-run gives the hold back at once.
	cut := paused("Paper C")
	free, err := f.s.CreditBalance(ctx, f.user)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.ConfirmExtraction(ctx, f.user, cut.ID, 2); err != nil {
		t.Fatal(err)
	}
	if err := f.s.FailOrphanedExtractions(ctx); err != nil {
		t.Fatal(err)
	}
	released, err := f.s.CreditBalance(ctx, f.user)
	if err != nil || released.ReservedMicros >= free.ReservedMicros+ExtractionQuestionMicros {
		t.Fatalf("after a restart: held %d, was %d, %v", released.ReservedMicros, free.ReservedMicros, err)
	}
}
