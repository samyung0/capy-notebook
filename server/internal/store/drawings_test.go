package store

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

const drawingQuestion = `{"id":"q4","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p4","blocks":[{"type":"text","text":"Draw it"},{"type":"canvas"}],"answer":{"type":"canvas"},"marks":2,"markscheme":[{"text":"Shape","marks":1},{"text":"Labels","marks":1}],"solution":[]}]}`

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

// storageUsed is user's storage meter, checked against the recount.
func storageUsed(t *testing.T, f assignmentFixture, user string) int64 {
	t.Helper()
	ctx := context.Background()
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

// TestAssignmentDrawingIsFreeAndGoesWithTheAssignment: Done stores the board
// and image for a drawing part of the running attempt, charged to no one (Epo
// 2026-11-25; the member paid before), its pictures too; a part that takes no
// drawing is refused; the submitted answer names the drawing and waits for the
// AI; deleting the assignment deletes it. A practice drawing is still charged
// to the member. The recount agrees at every step.
func TestAssignmentDrawingIsFreeAndGoesWithTheAssignment(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-drawing")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	used := func(user string) int64 { return storageUsed(t, f, user) }
	form := f.form(t, now.Add(time.Hour))
	form.Questions = drawingFrozen(t)
	created, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, false, now)
	if err != nil {
		t.Fatal(err)
	}
	before, owner := used(f.viewer), used(f.user)
	board := DrawingObject{Key: "drawings/" + run.ID + "/board_1.ydoc", Bytes: 1000, Type: "application/octet-stream"}
	image := &DrawingObject{Key: "drawings/" + run.ID + "/image_1.webp", Bytes: 500, Type: "image/webp"}
	if _, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, "p2", board, image, nil, now); !errors.Is(err, ErrNotDrawingPart) {
		t.Fatalf("a short-answer part took a drawing: %v", err)
	}
	saved, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, "p4", board, image, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if got := used(f.viewer); got != before {
		t.Fatalf("an assignment drawing charged the member: meter %d, want %d", got, before)
	}
	if used(f.user) != owner {
		t.Fatal("the owner was charged for a member's drawing")
	}
	// Done again replaces it, still charging nothing.
	board.Key, board.Bytes = "drawings/"+run.ID+"/board_2.ydoc", 800
	again, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, "p4", board, nil, nil, now)
	if err != nil || again.ID != saved.ID {
		t.Fatalf("the second Done = %+v, err %v", again, err)
	}
	if got := used(f.viewer); got != before {
		t.Fatalf("after replacing, the meter = %d, want %d", got, before)
	}
	// The board's pictures are stored with it, free too, and each Done
	// replaces them with the ones it sends.
	picture := func(id string, size int64) DrawingPicture {
		return DrawingPicture{SourceID: id, Object: DrawingObject{Key: "drawings/" + run.ID + "/img_" + id + ".webp", Bytes: size, Type: "image/webp"}}
	}
	if _, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, "p4", board, nil,
		[]DrawingPicture{picture("a", 300), picture("b", 200)}, now); err != nil {
		t.Fatal(err)
	}
	if got := used(f.viewer); got != before {
		t.Fatalf("with two pictures, the meter = %d, want %d", got, before)
	}
	if _, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, "p4", board, nil,
		[]DrawingPicture{picture("b", 200)}, now); err != nil {
		t.Fatal(err)
	}
	pictures, err := f.s.DrawingPictures(ctx, saved.ID)
	if err != nil || len(pictures) != 1 || pictures[0].SourceID != "b" || pictures[0].Object.Bytes != 200 {
		t.Fatalf("the drawing's pictures = %+v, err %v", pictures, err)
	}
	if got := used(f.viewer); got != before {
		t.Fatalf("with one picture left, the meter = %d, want %d", got, before)
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
	graded, given := gradeAttempt(frozenFixture(t), map[string]any{})
	if _, err := f.s.CheckQuizQuestion(ctx, f.viewer, f.quiz.ID, QuizCheck{
		Answers: given, Question: graded[0], Order: []string{"q1", "q2", "q3"}, Marks: map[string]float64{"q1": 1, "q2": 2, "q3": 3},
		Drawings: map[string]QuizDrawing{"p1": {Board: DrawingObject{Key: "drawings/" + f.viewer + "/practice.ydoc.gz", Bytes: 100, Type: "application/gzip"}}},
	}, now); err != nil {
		t.Fatal(err)
	}
	if got := used(f.viewer); got != before+100 {
		t.Fatalf("a practice drawing: meter %d, want %d", got, before+100)
	}
	if err := f.s.DeleteAssignment(ctx, f.user, created.ID); err != nil {
		t.Fatal(err)
	}
	// The assignment takes its quiz, and the practice drawing goes with it.
	if got := used(f.viewer); got != before {
		t.Fatalf("after deleting the assignment the meter = %d, want %d", got, before)
	}
	var left int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM drawings WHERE attempt_id=$1`, run.ID).Scan(&left); err != nil || left != 0 {
		t.Fatalf("drawings left = %d, err %v", left, err)
	}
}

// TestMarkedDrawingsListAndDeleteForTheirPayer: Files › Canvas lists a payer's
// marked practice drawings, named by the quiz with its question, and its payer
// deletes them while the marks stay. An assignment's drawing is never listed
// or deleted, even closed with its grades out: it stays as handed in, on the
// assignment's page (Epo 2026-11-25).
func TestMarkedDrawingsListAndDeleteForTheirPayer(t *testing.T) {
	f := newAssignmentFixture(t, "marked-drawings")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	form := f.form(t, now.Add(time.Hour))
	form.Questions = drawingFrozen(t)
	created, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, false, now)
	if err != nil {
		t.Fatal(err)
	}
	board := DrawingObject{Key: "drawings/" + run.ID + "/board_1.ydoc", Bytes: 1000, Type: "application/octet-stream"}
	if _, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, "p4", board, nil, nil, now); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.s.MarkAssignmentAnswer(ctx, f.user, run.ID, AssignmentMark{
		QuestionID: "q4",
		Parts:      []AssignmentPartMark{{PartID: "p4", Items: []float64{1, 0}}},
	}, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, true, now.Add(3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if page, err := f.s.ListMarkedDrawings(ctx, f.viewer, ListFilter{}, "", 50); err != nil || page.Count != 0 || len(page.Items) != 0 {
		t.Fatalf("an assignment drawing listed: %+v, err %v", page, err)
	}
	graded, given := gradeAttempt(frozenFixture(t), map[string]any{})
	practice, err := f.s.CheckQuizQuestion(ctx, f.viewer, f.quiz.ID, QuizCheck{
		Answers: given, Question: graded[0], Order: []string{"q1", "q2", "q3"}, Marks: map[string]float64{"q1": 1, "q2": 2, "q3": 3},
		Drawings: map[string]QuizDrawing{"p1": {Board: DrawingObject{Key: "drawings/" + f.viewer + "/practice.ydoc.gz", Bytes: 100, Type: "application/gzip"}}},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	page, err := f.s.ListMarkedDrawings(ctx, f.viewer, ListFilter{}, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if page.Count != 1 || page.TotalBytes != 100 || len(page.Items) != 1 {
		t.Fatalf("page = %+v", page)
	}
	if got := page.Items[0]; got.AttemptID != practice.ID || got.Question != 1 || got.QuizName == "" {
		t.Fatalf("listed = %+v", got)
	}
	// The Canvas tab's Workspace filter keeps the drawings of its quizzes.
	if page.Items[0].WorkspaceID != "" {
		inWs, err := f.s.ListMarkedDrawings(ctx, f.viewer, ListFilter{WorkspaceIDs: []string{page.Items[0].WorkspaceID}}, "", 50)
		if err != nil || len(inWs.Items) != 1 {
			t.Fatalf("workspace filter = %+v, err %v", inWs.Items, err)
		}
	}
	if n, err := f.s.DeleteMarkedDrawings(ctx, f.viewer, nil); err != nil || n != 1 {
		t.Fatalf("deleted %d, err %v", n, err)
	}
	var left int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM drawings WHERE user_id=$1 AND assignment`, f.viewer).Scan(&left); err != nil || left != 1 {
		t.Fatalf("assignment drawings left = %d, err %v", left, err)
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
	created, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, false, now)
	if err != nil {
		t.Fatal(err)
	}
	board := DrawingObject{Key: "drawings/" + run.ID + "/board_1.ydoc.gz", Bytes: 1000, Type: "application/gzip"}
	if _, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, "p4", board, nil, nil, now); err != nil {
		t.Fatal(err)
	}
	if err := f.s.DeleteAssignmentDrawing(ctx, f.viewer, run.ID, "p4", now); err != nil {
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

// sharedDrawingQuestion's two parts answer in its stem's canvas (shared).
const sharedDrawingQuestion = `{"id":"q5","stem":[{"type":"text","text":"A Punnett square."},{"type":"canvas"}],"layout":"paper","labels":"letters","parts":[
	{"id":"s1","blocks":[{"type":"text","text":"Fill in the boxes."}],"answer":{"type":"canvas","shared":true},"marks":2,"markscheme":[{"text":"Boxes","marks":2}],"solution":[]},
	{"id":"s2","blocks":[{"type":"text","text":"Write the ratio."}],"answer":{"type":"canvas","shared":true},"marks":1,"markscheme":[{"text":"Ratio","marks":1}],"solution":[]}]}`

// TestASharedCanvasIsOneDrawingForItsParts (Epo 2026-11-23): parts answering in
// one canvas share one drawing, stored under the first of them alone; each
// waits and goes to the AI on it, and the drawing keeps its marking image
// until both are marked.
func TestASharedCanvasIsOneDrawingForItsParts(t *testing.T) {
	f := newAssignmentFixture(t, "shared-drawing")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	var q map[string]any
	if err := json.Unmarshal([]byte(sharedDrawingQuestion), &q); err != nil {
		t.Fatal(err)
	}
	form := f.form(t, now.Add(time.Hour))
	form.Questions, form.Marking = append(frozenFixture(t), q), MarkingAI
	created, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, false, now)
	if err != nil {
		t.Fatal(err)
	}
	board := DrawingObject{Key: "drawings/" + run.ID + "/board.ydoc.gz", Bytes: 1000, Type: "application/gzip"}
	image := &DrawingObject{Key: "drawings/" + run.ID + "/image.webp", Bytes: 500, Type: "image/webp"}
	if _, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, "s2", board, image, nil, now); !errors.Is(err, ErrNotDrawingPart) {
		t.Fatalf("the second sharing part took a drawing: %v", err)
	}
	if _, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, "s1", board, image, nil, now); err != nil {
		t.Fatal(err)
	}
	done, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{}, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if _, named := done.Answers["s2"]; named || done.Answers["s1"] == nil {
		t.Fatalf("submitted answers = %v", done.Answers)
	}
	_, answers, err := f.s.AnswersToMark(ctx, created.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(answers) != 2 || answers[0].DrawingPart != "s1" || answers[1].DrawingPart != "s1" {
		t.Fatalf("to mark = %+v, want s1 and s2 on s1's drawing", answers)
	}
	held := func() Drawing {
		t.Helper()
		drawings, err := f.s.AttemptDrawings(ctx, run.ID)
		if err != nil {
			t.Fatal(err)
		}
		return drawings["s1"]
	}
	mark := func(part string, items ...float64) {
		t.Helper()
		if _, err := f.s.SaveAIMarks(ctx, run.ID, []AIMark{{QuestionID: "q5", PartID: part, Items: items}}, now.Add(2*time.Minute)); err != nil {
			t.Fatal(err)
		}
		if err := f.s.DropDrawingImages(ctx, run.ID, []string{part}); err != nil {
			t.Fatal(err)
		}
	}
	mark("s1", 2)
	if held().ImageKey == "" {
		t.Fatal("the drawing lost its image while s2 waits on it")
	}
	mark("s2", 1)
	if held().ImageKey != "" {
		t.Fatal("the drawing kept its image once both parts were marked")
	}
}

// TestRepublishMovesADrawingWithItsCanvas (Epo 2026-11-24): a republish that
// makes another part the first answering in a canvas moves the stored drawing
// to it, still free; a part's own canvas no part answers in any more,
// and then the stem's, drop theirs, the first before another moves onto its
// part.
func TestRepublishMovesADrawingWithItsCanvas(t *testing.T) {
	f := newAssignmentFixture(t, "republish-drawing")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	// shared answers both parts in the stem's canvas; own(s1) gives s1 a
	// canvas of its own, own(s1, s2) both.
	shared := func() map[string]any {
		var q map[string]any
		if err := json.Unmarshal([]byte(sharedDrawingQuestion), &q); err != nil {
			t.Fatal(err)
		}
		return q
	}
	own := func(ids ...string) []map[string]any {
		q := shared()
		for _, raw := range q["parts"].([]any) {
			p := raw.(map[string]any)
			if slices.Contains(ids, p["id"].(string)) {
				p["answer"] = map[string]any{"type": "canvas"}
				p["blocks"] = append(p["blocks"].([]any), map[string]any{"type": "canvas"})
			}
		}
		return append(frozenFixture(t), q)
	}
	form := f.form(t, now.Add(time.Hour))
	form.Questions, form.Marking = append(frozenFixture(t), shared()), MarkingAI
	created, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, false, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.s.SaveAssignmentAnswers(ctx, f.viewer, run.ID, map[string]any{"p2": "osmosis"}, now); err != nil {
		t.Fatal(err)
	}
	before := storageUsed(t, f, f.viewer)
	draw := func(part, name string) Drawing {
		t.Helper()
		board := DrawingObject{Key: "drawings/" + run.ID + "/" + name + ".ydoc.gz", Bytes: 1000, Type: "application/gzip"}
		image := &DrawingObject{Key: "drawings/" + run.ID + "/" + name + ".webp", Bytes: 500, Type: "image/webp"}
		saved, err := f.s.SaveAssignmentDrawing(ctx, f.viewer, run.ID, part, board, image, nil, now)
		if err != nil {
			t.Fatal(err)
		}
		return saved
	}
	// held reads the attempt's drawings and its answers' drawing ids by part.
	held := func(want map[string]string) {
		t.Helper()
		drawings, err := f.s.AttemptDrawings(ctx, run.ID)
		if err != nil {
			t.Fatal(err)
		}
		view, err := f.s.GetAssignmentAttempt(ctx, f.viewer, run.ID, now)
		if err != nil {
			t.Fatal(err)
		}
		for _, part := range []string{"s1", "s2"} {
			answer, _ := view.Answers[part].(map[string]any)
			if named, _ := answer["drawing"].(string); drawings[part].ID != want[part] || named != want[part] {
				t.Fatalf("%s holds %q, answers %v; want %q", part, drawings[part].ID, view.Answers[part], want[part])
			}
		}
		if view.Answers["p2"] != "osmosis" {
			t.Fatalf("the short answer went: %v", view.Answers)
		}
	}
	republish := func(qs []map[string]any) {
		t.Helper()
		if _, err := f.s.RepublishAssignment(ctx, f.user, created.ID, qs, now); err != nil {
			t.Fatal(err)
		}
	}
	stem := draw("s1", "stem")
	// s1 switched to New: the stem's drawing moves to s2, its first part now.
	republish(own("s1"))
	held(map[string]string{"s2": stem.ID})
	if got := storageUsed(t, f, f.viewer); got != before {
		t.Fatalf("after the move, the meter = %d, want %d", got, before)
	}
	mine := draw("s1", "own")
	// Two drawings may swap parts in one move.
	swap := func() {
		t.Helper()
		if err := f.s.inTx(ctx, func(tx pgx.Tx) error {
			_, err := moveDrawingsTx(ctx, tx, run.ID, map[string]string{"s1": "s2", "s2": "s1"})
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	swap()
	if drawings, err := f.s.AttemptDrawings(ctx, run.ID); err != nil || drawings["s1"].ID != stem.ID || drawings["s2"].ID != mine.ID {
		t.Fatalf("after a swap: %+v, err %v", drawings, err)
	}
	swap()
	// s1 shares again: its own canvas has no part answering in it, so its
	// drawing goes, and the stem's moves back onto s1.
	republish(append(frozenFixture(t), shared()))
	held(map[string]string{"s1": stem.ID})
	if got := storageUsed(t, f, f.viewer); got != before {
		t.Fatalf("after dropping s1's own, the meter = %d, want %d", got, before)
	}
	// Neither answers in the stem's canvas: its drawing goes.
	republish(own("s1", "s2"))
	held(map[string]string{})
	if got := storageUsed(t, f, f.viewer); got != before {
		t.Fatalf("after dropping the stem's, the meter = %d, want %d", got, before)
	}
}

// TestDrawingTargetsFollowAnUngroupedCanvas (Epo 2026-11-24): Ungroup hands
// the group's canvas to its first sub-part, which answers in it as its own, so
// the group canvas's drawing stays with it rather than being dropped.
func TestDrawingTargetsFollowAnUngroupedCanvas(t *testing.T) {
	decode := func(raw string) []map[string]any {
		var q map[string]any
		if err := json.Unmarshal([]byte(raw), &q); err != nil {
			t.Fatal(err)
		}
		return []map[string]any{q}
	}
	before := decode(`{"id":"q6","stem":[],"layout":"paper","labels":"letters","groups":[{"id":"g1","blocks":[{"type":"text","text":"A triangle."},{"type":"canvas"}]}],"parts":[
		{"id":"u1","group":"g1","blocks":[{"type":"text","text":"Mark its right angle."}],"answer":{"type":"canvas","shared":true},"marks":1,"markscheme":[{"text":"Marked","marks":1}],"solution":[]},
		{"id":"u2","group":"g1","blocks":[{"type":"text","text":"Name it."}],"answer":{"type":"short","accepted":["ABC"]},"marks":1,"solution":[]}]}`)
	after := decode(`{"id":"q6","stem":[],"layout":"paper","labels":"letters","parts":[
		{"id":"u1","blocks":[{"type":"text","text":"A triangle."},{"type":"canvas"},{"type":"text","text":"Mark its right angle."}],"answer":{"type":"canvas"},"marks":1,"markscheme":[{"text":"Marked","marks":1}],"solution":[]},
		{"id":"u2","blocks":[{"type":"text","text":"Name it."}],"answer":{"type":"short","accepted":["ABC"]},"marks":1,"solution":[]}]}`)
	if got := drawingTargets(before, after); got["u1"] != "u1" {
		t.Fatalf("targets = %v, want u1's drawing kept", got)
	}
}

// drawingRun starts a member's attempt at a drawing assignment marked as marking
// says, and saves a board (and an image) for its drawing part p4.
func drawingRun(t *testing.T, f assignmentFixture, member, marking string, now time.Time) (Assignment, AssignmentAttempt) {
	t.Helper()
	ctx := context.Background()
	form := f.form(t, now.Add(time.Hour))
	form.Questions, form.Marking = drawingFrozen(t), marking
	created, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	return created, drawIn(t, f, created, member, now)
}

func drawIn(t *testing.T, f assignmentFixture, created Assignment, member string, now time.Time) AssignmentAttempt {
	t.Helper()
	ctx := context.Background()
	run, err := f.s.StartAssignment(ctx, member, created.ID, false, now)
	if err != nil {
		t.Fatal(err)
	}
	board := DrawingObject{Key: "drawings/" + run.ID + "/board.ydoc.gz", Bytes: 1000, Type: "application/gzip"}
	image := &DrawingObject{Key: "drawings/" + run.ID + "/image.webp", Bytes: 500, Type: "image/webp"}
	if _, err := f.s.SaveAssignmentDrawing(ctx, member, run.ID, "p4", board, image, nil, now); err != nil {
		t.Fatal(err)
	}
	return run
}

func keptImage(t *testing.T, f assignmentFixture, attemptID string) bool {
	t.Helper()
	held, err := f.s.AttemptDrawings(context.Background(), attemptID)
	if err != nil {
		t.Fatal(err)
	}
	return held["p4"].ImageKey != ""
}

// TestMarkingByHandOrSwitchingToManualDropsTheImage: a drawing marked by hand,
// and every drawing of an assignment switched to manual grading, keep no marking
// image (Epo 2026-11-06).
func TestMarkingByHandOrSwitchingToManualDropsTheImage(t *testing.T) {
	f := newAssignmentFixture(t, "drawing-image-drops")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	_, run := drawingRun(t, f, f.viewer, MarkingAIApprove, now)
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if !keptImage(t, f, run.ID) {
		t.Fatal("a waiting drawing lost its image")
	}
	if _, _, err := f.s.MarkAssignmentAnswer(ctx, f.user, run.ID, AssignmentMark{
		QuestionID: "q4", Parts: []AssignmentPartMark{{PartID: "p4", Items: []float64{1, 1}}},
	}, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if keptImage(t, f, run.ID) {
		t.Fatal("a drawing marked by hand kept its image")
	}

	switched, other := drawingRun(t, f, f.other, MarkingAI, now)
	form := f.form(t, now.Add(time.Hour))
	form.Marking = MarkingManual
	if _, err := f.s.UpdateAssignment(ctx, f.user, switched.ID, form, now); err != nil {
		t.Fatal(err)
	}
	if keptImage(t, f, other.ID) {
		t.Fatal("switching to manual grading kept a marking image")
	}
}

// TestADrawingWithoutAnImageNeedsHandMarking (Epo 2026-11-07, Q695): saved under
// manual grading, a drawing has no marking image; switched to the AI, Mark with
// AI leaves it out and the report names it as needing hand marking, while a
// drawing saved with its image goes to the AI.
func TestADrawingWithoutAnImageNeedsHandMarking(t *testing.T) {
	f := newAssignmentFixture(t, "drawing-hand-marking")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	created, run := drawingRun(t, f, f.viewer, MarkingManual, now)
	if keptImage(t, f, run.ID) {
		t.Fatal("manual grading kept a marking image")
	}
	form := f.form(t, now.Add(time.Hour))
	form.Marking = MarkingAI
	if _, err := f.s.UpdateAssignment(ctx, f.user, created.ID, form, now); err != nil {
		t.Fatal(err)
	}
	withImage := drawIn(t, f, created, f.other, now)
	for _, member := range []struct{ user, attempt string }{{f.viewer, run.ID}, {f.other, withImage.ID}} {
		if _, err := f.s.SubmitAssignmentAttempt(ctx, member.user, member.attempt, map[string]any{}, now.Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	_, answers, err := f.s.AnswersToMark(ctx, created.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(answers) != 1 || answers[0].AttemptID != withImage.ID || answers[0].DrawingPart != answers[0].PartID {
		t.Fatalf("to mark = %+v, want the drawing with its image alone", answers)
	}
	report, err := f.s.GetAssignmentReport(ctx, f.user, created.ID, now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	hand := map[string]bool{}
	for _, row := range report.Answers {
		if row.QuestionID == "q4" {
			hand[row.AttemptID] = row.HandMarking
		}
	}
	if !hand[run.ID] || hand[withImage.ID] {
		t.Fatalf("hand marking by attempt = %v", hand)
	}
}

// TestDeletingADrawingChecksMembershipAndTime: Done on an emptied board forgets
// a drawing only for a member still in the class, in an attempt still running.
func TestDeletingADrawingChecksMembershipAndTime(t *testing.T) {
	f := newAssignmentFixture(t, "drawing-delete-checks")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	created, run := drawingRun(t, f, f.viewer, MarkingAI, now)
	held := func() int {
		t.Helper()
		drawings, err := f.s.AttemptDrawings(ctx, run.ID)
		if err != nil {
			t.Fatal(err)
		}
		return len(drawings)
	}
	if _, err := f.s.pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, f.ws.ID, f.viewer); err != nil {
		t.Fatal(err)
	}
	if err := f.s.DeleteAssignmentDrawing(ctx, f.viewer, run.ID, "p4", now); !errors.Is(err, ErrNotFound) || held() != 1 {
		t.Fatalf("a member who left deleted their drawing: err %v, %d left", err, held())
	}
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, f.ws.ID, f.viewer); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE assignments SET closed_at=$2 WHERE id=$1`, created.ID, now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := f.s.DeleteAssignmentDrawing(ctx, f.viewer, run.ID, "p4", now); !errors.Is(err, ErrAttemptFinished) || held() != 1 {
		t.Fatalf("a closed attempt's drawing was deleted: err %v, %d left", err, held())
	}
}

// TestReadableDrawingFollowsTheAssignmentStaff (security): a drawing opens for
// whoever drew it and the class's owner and editors; another member, a teacher
// who left, an outsider, and the owner over a member's practice drawing get
// nothing.
func TestReadableDrawingFollowsTheAssignmentStaff(t *testing.T) {
	f := newAssignmentFixture(t, "drawing-readers")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	_, run := drawingRun(t, f, f.viewer, MarkingAI, now)
	held, err := f.s.AttemptDrawings(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	drawing := held["p4"].ID
	graded, given := gradeAttempt(frozenFixture(t), map[string]any{})
	practice, err := f.s.CheckQuizQuestion(ctx, f.viewer, f.quiz.ID, QuizCheck{
		Answers: given, Question: graded[0], Order: []string{"q1", "q2", "q3"}, Marks: map[string]float64{"q1": 1, "q2": 2, "q3": 3},
		Drawings: map[string]QuizDrawing{"p1": {Board: DrawingObject{Key: "drawings/" + f.viewer + "/practice.ydoc.gz", Bytes: 100, Type: "application/gzip"}}},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	ownPractice, err := f.s.AttemptDrawings(ctx, practice.ID)
	if err != nil {
		t.Fatal(err)
	}
	outsider := newBlobTestUser(t, f.s, "drawing-readers-outsider")
	reads := func(user, id string) bool {
		t.Helper()
		_, err := f.s.ReadableDrawing(ctx, user, id)
		if err != nil && !errors.Is(err, ErrNotFound) {
			t.Fatal(err)
		}
		return err == nil
	}
	for _, c := range []struct {
		who, user, id string
		want          bool
	}{
		{"the member who drew it", f.viewer, drawing, true},
		{"the owner", f.user, drawing, true},
		{"an editor", f.editor, drawing, true},
		{"another member", f.other, drawing, false},
		{"an outsider", outsider, drawing, false},
		{"the member's own practice", f.viewer, ownPractice["p1"].ID, true},
		{"the owner over a member's practice", f.user, ownPractice["p1"].ID, false},
	} {
		if got := reads(c.user, c.id); got != c.want {
			t.Fatalf("%s reads it: %v, want %v", c.who, got, c.want)
		}
	}
	if _, err := f.s.pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, f.ws.ID, f.editor); err != nil {
		t.Fatal(err)
	}
	if reads(f.editor, drawing) {
		t.Fatal("an editor who left still reads a member's drawing")
	}
}
