package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

const drawingQuestion = `{"id":"q4","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p4","blocks":[{"type":"text","text":"Draw it"}],"answer":{"type":"drawing"},"marks":2,"markscheme":[{"text":"Shape","marks":1},{"text":"Labels","marks":1}],"solution":[]}]}`

func drawingFrozen(t *testing.T) []map[string]any {
	t.Helper()
	var q map[string]any
	if err := json.Unmarshal([]byte(drawingQuestion), &q); err != nil {
		t.Fatal(err)
	}
	return append(frozenFixture(t), q)
}

// TestDrawingAnswersAreTheStoredDrawings: a drawing part's answer is the
// drawing stored for it, whatever the browser sent, and an answered one waits
// for the AI as an open part does.
func TestDrawingAnswersAreTheStoredDrawings(t *testing.T) {
	answers := withDrawingAnswers(map[string]any{
		"p2": "osmosis",
		"p4": map[string]any{"drawing": "dr_someone_elses"},
		"p9": map[string]any{"drawing": "dr_not_held"},
	}, map[string]Drawing{"p4": {ID: "dr_mine", PartID: "p4"}})
	if got := answers["p4"].(map[string]any)["drawing"]; got != "dr_mine" {
		t.Fatalf("p4 = %v", got)
	}
	if _, kept := answers["p9"]; kept || answers["p2"] != "osmosis" {
		t.Fatalf("answers = %v", answers)
	}
	graded, _ := gradeAttempt(drawingFrozen(t), answers)
	drawn := graded[3]["parts"].([]any)[0].(map[string]any)
	if drawn["pending"] != true {
		t.Fatalf("an answered drawing part = %v", drawn)
	}
}

// TestAssignmentDrawingIsChargedToTheMemberAndGoesWithTheAssignment: Done
// stores the board and image for a drawing part of the running attempt, charged
// to the member (Epo 2026-11-06); a part that takes no drawing is refused; the
// submitted answer names the drawing and waits for the AI; deleting the
// assignment ends the charge. The recount agrees at every step.
func TestAssignmentDrawingIsChargedToTheMemberAndGoesWithTheAssignment(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-drawing")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	used := func(user string) int64 {
		t.Helper()
		usage, err := f.s.unlockedStorageUsage(ctx, f.s.pool, user)
		if err != nil {
			t.Fatal(err)
		}
		var recount, reserved int64
		if err := f.s.pool.QueryRow(ctx, storageRecountSQL, user).Scan(&recount, &reserved); err != nil {
			t.Fatal(err)
		}
		if usage.UsedBytes != recount {
			t.Fatalf("the meter reads %d, the recount %d", usage.UsedBytes, recount)
		}
		return usage.UsedBytes
	}
	form := f.form(t, now.Add(time.Hour))
	form.Questions = drawingFrozen(t)
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	before, owner := used(f.viewer), used(f.user)
	board := DrawingObject{Key: "drawings/" + run.ID + "/board_1.ydoc", Bytes: 1000, Type: "application/octet-stream"}
	image := &DrawingObject{Key: "drawings/" + run.ID + "/image_1.webp", Bytes: 500, Type: "image/webp"}
	if _, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, "p2", board, image, now); !errors.Is(err, ErrNotDrawingPart) {
		t.Fatalf("a short-answer part took a drawing: %v", err)
	}
	saved, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, "p4", board, image, now)
	if err != nil {
		t.Fatal(err)
	}
	if got := used(f.viewer); got != before+1500 {
		t.Fatalf("the member's meter = %d, want %d", got, before+1500)
	}
	if used(f.user) != owner {
		t.Fatal("the owner was charged for a member's drawing")
	}
	// Done again replaces it: the meter follows the new board alone.
	board.Key, board.Bytes = "drawings/"+run.ID+"/board_2.ydoc", 800
	again, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, "p4", board, nil, now)
	if err != nil || again.ID != saved.ID {
		t.Fatalf("the second Done = %+v, err %v", again, err)
	}
	if got := used(f.viewer); got != before+800 {
		t.Fatalf("after replacing, the meter = %d, want %d", got, before+800)
	}
	done, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{
		"p4": map[string]any{"drawing": "dr_forged"},
	}, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := done.Answers["p4"].(map[string]any); got["drawing"] != saved.ID {
		t.Fatalf("the submitted answer = %v", done.Answers["p4"])
	}
	if err := f.s.DeleteAssignment(ctx, f.user, created.ID); err != nil {
		t.Fatal(err)
	}
	if got := used(f.viewer); got != before {
		t.Fatalf("deleting the assignment left %d of the member's charge", got-before)
	}
	var left int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM drawings WHERE attempt_id=$1`, run.ID).Scan(&left); err != nil || left != 0 {
		t.Fatalf("drawings left = %d, err %v", left, err)
	}
}

// TestMarkedDrawingsListAndDeleteForTheirPayer: Files › Canvas lists a member's
// drawing only once its part is marked, named by the quiz with its question and
// part; the member deletes it and the charge ends, while the marks stay.
func TestMarkedDrawingsListAndDeleteForTheirPayer(t *testing.T) {
	f := newAssignmentFixture(t, "marked-drawings")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	form := f.form(t, now.Add(time.Hour))
	form.Questions = drawingFrozen(t)
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	board := DrawingObject{Key: "drawings/" + run.ID + "/board_1.ydoc", Bytes: 1000, Type: "application/octet-stream"}
	saved, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, "p4", board, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.MarkAssignmentAnswer(ctx, f.user, run.ID, AssignmentMark{
		QuestionID: "q4",
		Parts:      []AssignmentPartMark{{PartID: "p4", Items: []float64{1, 0}}},
	}, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	page, err := f.s.ListMarkedDrawings(ctx, f.viewer, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if page.Count != 1 || page.TotalBytes != 1000 || len(page.Items) != 1 {
		t.Fatalf("page = %+v", page)
	}
	got := page.Items[0]
	if got.ID != saved.ID || !got.Assignment || got.Question != 4 || got.Part != 0 || got.QuizName == "" {
		t.Fatalf("listed = %+v", got)
	}
	n, err := f.s.DeleteMarkedDrawings(ctx, f.viewer, []string{saved.ID})
	if err != nil || n != 1 {
		t.Fatalf("deleted %d, err %v", n, err)
	}
	var left int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM drawings WHERE user_id=$1`, f.viewer).Scan(&left); err != nil || left != 0 {
		t.Fatalf("drawings left = %d, err %v", left, err)
	}
}

// TestAnEmptiedDrawingIsForgotten: Done on an emptied board forgets the part's
// stored drawing, so the submitted attempt leaves the part unanswered and the
// member stops paying for it.
func TestAnEmptiedDrawingIsForgotten(t *testing.T) {
	f := newAssignmentFixture(t, "emptied-drawing")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	form := f.form(t, now.Add(time.Hour))
	form.Questions = drawingFrozen(t)
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	board := DrawingObject{Key: "drawings/" + run.ID + "/board_1.ydoc.gz", Bytes: 1000, Type: "application/gzip"}
	if _, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, "p4", board, nil, now); err != nil {
		t.Fatal(err)
	}
	if err := f.s.DeleteAssignmentDrawing(ctx, f.viewer, run.ID, "p4"); err != nil {
		t.Fatal(err)
	}
	done, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{}, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if _, answered := done.Answers["p4"]; answered {
		t.Fatalf("an emptied drawing was submitted: %v", done.Answers["p4"])
	}
}
