package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/questions"
)

const orderingQuestion = `{"id":"q4","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p4","blocks":[{"type":"text","text":"Order them"}],"answer":{"type":"ordering","items":["first","second","third"]},"marks":1,"solution":[]}]}`

// TestPaperIsHandedInReadAndDeleted: a member answering on paper uploads a file
// into their attempt, which submits with every part waiting; the read's
// letters, taken from the member's seeded view, mark the closed parts against
// the key, the open part waits for the AI on its pages, and once marked and
// closed the member may delete the file from Files › Submissions.
func TestPaperIsHandedInReadAndDeleted(t *testing.T) {
	f := newAssignmentFixture(t, "paper")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	form := f.form(t, now.Add(time.Hour))
	var ordering map[string]any
	if err := json.Unmarshal([]byte(orderingQuestion), &ordering); err != nil {
		t.Fatal(err)
	}
	form.Questions = append(frozenFixture(t), ordering)
	form.AllowUploads = true
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, true, now)
	if err != nil || run.Paper != PaperUpload {
		t.Fatalf("start = %+v, err %v", run.Paper, err)
	}
	upload, err := f.s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), CreatedBy: f.viewer, ObjectPath: "sources/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "paper.pdf", Kind: "pdf", ContentType: "application/pdf", DeclaredSize: 4096, ParseMode: "none",
		ExpiresAt: now.Add(time.Hour), AttemptID: run.ID, PaperMaxBytes: 10 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	file, err := f.s.FinalizeUploadSession(ctx, f.viewer, upload.ID, "etag", "", "")
	if err != nil {
		t.Fatal(err)
	}
	done, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{}, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if done.Paper != PaperReading || done.WaitingAnswers != 4 || len(done.PaperFiles) != 1 || done.PaperFiles[0].ID != file.ID {
		t.Fatalf("handed in = %s, waiting %d, files %+v", done.Paper, done.WaitingAnswers, done.PaperFiles)
	}

	paper, err := f.s.GetPaper(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if paper.Parts[0].Label != "1" || !strings.Contains(paper.Parts[0].Listing, "1 (choice): Pick\nA. a\nB. b") {
		t.Fatalf("listing = %q", paper.Parts[0].Listing)
	}
	// The letters the member saw for the right order.
	view := questions.LearnerViewsSeeded(form.Questions, run.ID)[3]["parts"].([]any)[0].(map[string]any)["answer"].(map[string]any)
	shown := view["items"].([]any)
	var order []any
	for _, want := range []string{"first", "second", "third"} {
		for i, item := range shown {
			if item == want {
				order = append(order, letter(i))
			}
		}
	}
	if err := f.s.SavePaperRead(ctx, run.ID, map[string]PaperFinding{
		"p1": {Pages: []int{1}, Answer: []any{"B"}},
		"p2": {Pages: []int{1}, Answer: "osmosis"},
		"p3": {Pages: []int{2}},
		"p4": {Pages: []int{2}, Answer: order},
	}, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	read, err := f.s.GetAssignmentAttempt(ctx, f.user, run.ID, now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if read.Paper != PaperRead || read.Correct != 4 || read.WaitingAnswers != 1 {
		t.Fatalf("read = %s, correct %v, waiting %d", read.Paper, read.Correct, read.WaitingAnswers)
	}
	_, waiting, err := f.s.AnswersToMark(ctx, created.ID, run.ID)
	if err != nil || len(waiting) != 1 || waiting[0].PartID != "p3" || len(waiting[0].Pages) != 1 || waiting[0].Pages[0] != 2 {
		t.Fatalf("to mark = %+v, err %v", waiting, err)
	}

	if _, err := f.s.MarkAssignmentAnswer(ctx, f.user, run.ID, AssignmentMark{
		QuestionID: "q3", Parts: []AssignmentPartMark{{PartID: "p3", Items: []float64{2, 1}}},
	}, now.Add(3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	// Marked but open: staff may still revise it.
	if page, err := f.s.ListSubmittedPapers(ctx, f.viewer, "", 50); err != nil || page.Count != 0 {
		t.Fatalf("open assignment listed %+v, err %v", page, err)
	}
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, true, now.Add(4*time.Minute)); err != nil {
		t.Fatal(err)
	}
	page, err := f.s.ListSubmittedPapers(ctx, f.viewer, "", 50)
	if err != nil || page.Count != 1 || page.Items[0].ID != file.ID || page.TotalBytes != 4096 {
		t.Fatalf("listed %+v, err %v", page, err)
	}
	if n, err := f.s.DeleteSubmittedPapers(ctx, f.viewer, nil); err != nil || n != 1 {
		t.Fatalf("deleted %d, err %v", n, err)
	}
	after, err := f.s.GetAssignmentAttempt(ctx, f.user, run.ID, now.Add(5*time.Minute))
	if err != nil || after.Correct != 7 || len(after.PaperFiles) != 0 {
		t.Fatalf("after delete = %v, files %d, err %v", after.Correct, len(after.PaperFiles), err)
	}
}
