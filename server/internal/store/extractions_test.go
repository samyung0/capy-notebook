package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

// TestExtractionLifecycle: a run keeps its recorded questions while running,
// ends once, is visible only to its starter, and a restart fails what was left
// running.
func TestExtractionLifecycle(t *testing.T) {
	f := newStudyFixture(t, "extract")
	ctx := context.Background()
	other := newBlobTestUser(t, f.s, "extract-other")

	run, err := f.s.CreateExtraction(ctx, f.ws.ID, f.user, "Paper 2")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ExtractionRunning || run.Recorded != 0 {
		t.Fatalf("new run = %+v", run)
	}
	if err := f.s.SaveExtractionQuestions(ctx, run.ID, json.RawMessage(`[{"id":"q1"},{"id":"q2"}]`)); err != nil {
		t.Fatal(err)
	}
	if got, err := f.s.GetExtraction(ctx, f.user, run.ID); err != nil || got.Recorded != 2 {
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

	cut, err := f.s.CreateExtraction(ctx, f.ws.ID, f.user, "Paper 1")
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
