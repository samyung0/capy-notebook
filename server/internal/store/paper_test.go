package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/questions"
)

const orderingQuestion = `{"id":"q4","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p4","blocks":[{"type":"text","text":"Order them"}],"answer":{"type":"ordering","items":["first","second","third"]},"marks":1,"solution":[]}]}`

// TestPaperIsHandedInReadAndKept: a member answering on paper uploads a file
// into their attempt, which submits with every part waiting; the read's
// letters, taken from the member's seeded view, mark the closed parts against
// the key, and the open part waits for the AI on its pages. Submitted, the
// file stays off the Files page (it is on the assignment's), charged to no
// one, and stays after the close (Epo 2026-11-25).
func TestPaperIsHandedInReadAndKept(t *testing.T) {
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
	created, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, form, now)
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
		ExpiresAt: now.Add(time.Hour), AttemptID: run.ID,
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
	// Waiting, the member reads no mark so far (Epo 2026-11-25); the owner reads
	// what waits.
	if done.Paper != PaperReading || !done.GradesHidden || len(done.PaperFiles) != 1 || done.PaperFiles[0].ID != file.ID {
		t.Fatalf("handed in = %s, hidden %v, files %+v", done.Paper, done.GradesHidden, done.PaperFiles)
	}
	if owner, err := f.s.GetAssignmentAttempt(ctx, f.user, run.ID, now.Add(time.Minute)); err != nil || owner.WaitingAnswers != 4 {
		t.Fatalf("the owner's read: waiting %d, err %v", owner.WaitingAnswers, err)
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

	if _, _, err := f.s.MarkAssignmentAnswer(ctx, f.user, run.ID, AssignmentMark{
		QuestionID: "q3", Parts: []AssignmentPartMark{{PartID: "p3", Items: []float64{2, 1}}},
	}, now.Add(3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	// Handed-in work is on its assignment's page, not Files (Epo 2026-11-25).
	if got := submissionsOf(t, f.s, f.viewer); len(got) != 0 {
		t.Fatalf("a submitted paper listed on Files: %+v", got)
	}
	if usage, err := f.s.StorageUsage(ctx, f.viewer); err != nil || usage.UsedBytes != 0 || usage.ReservedBytes != 0 {
		t.Fatalf("charged %+v, err %v", usage, err)
	}
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, true, now.Add(4*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := f.s.DeleteLeftHandIn(ctx, f.viewer, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted a submitted paper: %v", err)
	}
	after, err := f.s.GetAssignmentAttempt(ctx, f.user, run.ID, now.Add(5*time.Minute))
	if err != nil || after.Correct != 7 || len(after.PaperFiles) != 1 {
		t.Fatalf("after close = %v, files %d, err %v", after.Correct, len(after.PaperFiles), err)
	}
}

// TestOneWayToAnswer: the first start picks the way for good (Epo
// 2026-11-25). Upload only takes one attempt; a member who answered online
// uploads no paper, and one who handed in a paper starts nothing more.
func TestOneWayToAnswer(t *testing.T) {
	f := newAssignmentFixture(t, "one-way")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	form := f.form(t, now.Add(time.Hour))
	form.AllowUploads, form.UploadOnly, form.Attempts = true, true, 2
	if _, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, form, now); err == nil {
		t.Fatal("upload only took two attempts")
	}
	form.UploadOnly, form.Attempts = false, 3
	created, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	online, err := f.s.StartAssignment(ctx, f.viewer, created.ID, false, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, online.ID, map[string]any{}, now); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.StartAssignment(ctx, f.viewer, created.ID, true, now); !errors.Is(err, ErrAnsweredOnline) {
		t.Fatalf("paper after answering online: %v", err)
	}
	run, err := f.s.StartAssignment(ctx, f.other, created.ID, true, now)
	if err != nil {
		t.Fatal(err)
	}
	upload, err := f.s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), CreatedBy: f.other, ObjectPath: "sources/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "paper.pdf", Kind: "pdf", ContentType: "application/pdf", DeclaredSize: 1024, ParseMode: "none",
		ExpiresAt: now.Add(time.Hour), AttemptID: run.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.FinalizeUploadSession(ctx, f.other, upload.ID, "etag", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.other, run.ID, map[string]any{}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	for _, paper := range []bool{true, false} {
		if _, err := f.s.StartAssignment(ctx, f.other, created.ID, paper, now.Add(2*time.Minute)); !errors.Is(err, ErrPaperHandedIn) {
			t.Fatalf("start after the paper (upload %v): %v", paper, err)
		}
	}
}

// TestHandInIsFinalAndKept: on an unmarked assignment that takes files, a
// member's upload joins their hand-in, stored with no parse; Hand in needs a
// file and is final; staff read the files on the member's row. Handed in, the
// files stay off the Files page, charged to no one, and stay after the close;
// a file another member added but never handed in lists on their Files page
// for them to delete once it closes (Epo 2026-11-25).
func TestHandInIsFinalAndKept(t *testing.T) {
	f := newAssignmentFixture(t, "handin")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	form := AssignmentForm{Kind: AssignmentUnmarked, Title: "Lab write-up",
		Attempts: 1, AssignAll: true, Marking: MarkingAIApprove, ShowAnswers: AnswersAfterClose, ShowGrades: GradesAutomatic,
		Files: []AssignmentFileRef{}, AllowUploads: true}
	created, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, created.ID, true, now); err == nil {
		t.Fatal("handed in with no files")
	}
	upload, err := f.s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), CreatedBy: f.viewer, ObjectPath: "sources/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "write-up.pdf", Kind: "pdf", ContentType: "application/pdf", DeclaredSize: 2048, ParseMode: "none",
		ExpiresAt: now.Add(time.Hour), HandInID: created.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	file, err := f.s.FinalizeUploadSession(ctx, f.viewer, upload.ID, "etag", "", "")
	if err != nil || file.Status != "ready" {
		t.Fatalf("file %+v, err %v", file, err)
	}
	mine, err := f.s.GetAssignment(ctx, f.viewer, created.ID, now)
	if err != nil || len(mine.Mine.HandIn) != 1 || mine.Mine.HandIn[0].ID != file.ID {
		t.Fatalf("mine = %+v, err %v", mine.Mine, err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, created.ID, true, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := f.s.RemoveHandInFile(ctx, f.viewer, created.ID, file.ID); !errors.Is(err, ErrHandInClosed) {
		t.Fatalf("removed after hand in: %v", err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, created.ID, false, now.Add(time.Minute)); !errors.Is(err, ErrHandInFinal) {
		t.Fatalf("undid hand in: %v", err)
	}
	// Uploads turned off later leave no Undo either.
	form.AllowUploads = false
	if _, err := f.s.UpdateAssignment(ctx, f.user, created.ID, form, now); err != nil {
		t.Fatal(err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, created.ID, false, now.Add(time.Minute)); !errors.Is(err, ErrHandInFinal) {
		t.Fatalf("undid hand in with uploads off: %v", err)
	}
	form.AllowUploads = true
	if _, err := f.s.UpdateAssignment(ctx, f.user, created.ID, form, now); err != nil {
		t.Fatal(err)
	}
	report, err := f.s.GetAssignmentReport(ctx, f.user, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	var handedIn []PaperFile
	for _, row := range report.Members {
		if row.UserID == f.viewer {
			handedIn = row.Files
		}
	}
	if len(handedIn) != 1 || handedIn[0].ID != file.ID {
		t.Fatalf("member row files = %+v", handedIn)
	}
	if _, err := f.s.HandInFileBlob(ctx, f.user, created.ID, file.ID); err != nil {
		t.Fatalf("staff link: %v", err)
	}

	if got := submissionsOf(t, f.s, f.viewer); len(got) != 0 {
		t.Fatalf("a handed-in file listed on Files: %+v", got)
	}
	if usage, err := f.s.StorageUsage(ctx, f.viewer); err != nil || usage.UsedBytes != 0 || usage.ReservedBytes != 0 {
		t.Fatalf("charged %+v, err %v", usage, err)
	}
	left, err := f.s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), CreatedBy: f.other, ObjectPath: "sources/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "draft.pdf", Kind: "pdf", ContentType: "application/pdf", DeclaredSize: 1024, ParseMode: "none",
		ExpiresAt: now.Add(time.Hour), HandInID: created.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	draft, err := f.s.FinalizeUploadSession(ctx, f.other, left.ID, "etag", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if got := submissionsOf(t, f.s, f.other); len(got) != 0 {
		t.Fatalf("an open hand-in listed %+v", got)
	}
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, true, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := f.s.DeleteLeftHandIn(ctx, f.viewer, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted a handed-in file: %v", err)
	}
	if got := submissionsOf(t, f.s, f.other); len(got) != 1 || got[0].ID != draft.ID || got[0].QuizName != "Lab write-up" {
		t.Fatalf("left file listed %+v", got)
	}
	if got := submissionsOf(t, f.s, f.viewer); len(got) != 0 {
		t.Fatalf("a handed-in file listed on Files after the close: %+v", got)
	}
	if err := f.s.DeleteLeftHandIn(ctx, f.other, draft.ID); err != nil {
		t.Fatal(err)
	}
}

// TestUnmarkedFollowsTheLateRules: an unmarked assignment closes at its due
// date only under No late submissions, as a marked one does (Epo 2026-11-09);
// without it a tick after the due date stays open and reads Late.
func TestUnmarkedFollowsTheLateRules(t *testing.T) {
	f := newAssignmentFixture(t, "unmarked-late")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	due := now.Add(time.Hour)
	after := now.Add(2 * time.Hour)
	create := func(noLate bool) Assignment {
		t.Helper()
		created, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, AssignmentForm{Kind: AssignmentUnmarked, Title: "Read it",
			Attempts: 1, AssignAll: true, DueAt: &due, NoLate: noLate, Marking: MarkingAIApprove, ShowAnswers: AnswersAfterClose,
			ShowGrades: GradesAutomatic, Files: []AssignmentFileRef{}}, now)
		if err != nil {
			t.Fatal(err)
		}
		return created
	}
	open := create(false)
	if err := f.s.SetAssignmentDone(ctx, f.viewer, open.ID, true, after); err != nil {
		t.Fatal(err)
	}
	mine, err := f.s.GetAssignment(ctx, f.viewer, open.ID, after)
	if err != nil || mine.Closed || !mine.Mine.Late {
		t.Fatalf("late tick: closed %v, mine %+v, err %v", mine.Closed, mine.Mine, err)
	}
	closing := create(true)
	if err := f.s.SetAssignmentDone(ctx, f.viewer, closing.ID, true, after); !errors.Is(err, ErrAssignmentClosed) {
		t.Fatalf("ticked after a No late due date: %v", err)
	}
}

// submissionsOf lists user's submissions as the Files page does (ListItems).
func submissionsOf(t *testing.T, s *Store, user string) []SubmittedPaper {
	t.Helper()
	page, err := s.ListItems(context.Background(), user, ItemListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	var out []SubmittedPaper
	for _, item := range page.Items {
		if item.Submission != nil {
			out = append(out, *item.Submission)
		}
	}
	return out
}

// TestPaperLettersNameShuffledOptions: a paper's letters name an mcq's options
// as the member's view shows them (Shuffle options), and the answer stored is
// each option's authored index, which the key grades.
func TestPaperLettersNameShuffledOptions(t *testing.T) {
	a := map[string]any{"type": "mcq", "options": []any{"Osmosis", "Diffusion", "None"}, "correct": []any{1.0}}
	shown := map[string]any{"type": "mcq", "options": a["options"], "order": []any{1, 0, 2}}
	value, ok := paperAnswer("mcq", a, shown, []any{"A"})
	if !ok || value.([]any)[0] != 1.0 {
		t.Fatalf("A read as %v, want authored option 1", value)
	}
	part := map[string]any{"answer": a, "marks": 1.0}
	if marks, _ := questions.ScorePart(part, value); marks != 1 {
		t.Fatalf("scored %v", marks)
	}
}

// TestUploadOnlyStartsAsUpload: an upload-only assignment (Epo 2026-11-19)
// keeps its mode and starts only as an upload.
func TestUploadOnlyStartsAsUpload(t *testing.T) {
	f := newAssignmentFixture(t, "uploadonly")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	form := f.form(t, now.Add(time.Hour))
	form.Questions = frozenFixture(t)
	form.AllowUploads = true
	form.UploadOnly = true
	created, err := f.s.makeAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if !created.UploadOnly || !created.AllowUploads {
		t.Fatalf("made = uploadOnly %v, allowUploads %v", created.UploadOnly, created.AllowUploads)
	}
	if _, err := f.s.StartAssignment(ctx, f.viewer, created.ID, false, now); err == nil {
		t.Fatal("started online")
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, true, now)
	if err != nil || run.Paper != PaperUpload {
		t.Fatalf("start = %+v, err %v", run.Paper, err)
	}
}

// TestFileGradedQuiz: a graded quiz made from a file is upload only, its
// question paper the file, which a member reads once they start even while it
// is hidden from members, and its hand-in waits for staff's one mark with no
// read; changing its settings keeps the file.
func TestFileGradedQuiz(t *testing.T) {
	f := newAssignmentFixture(t, "filequiz")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	file := uploadWorkspaceFile(t, f.s, f.user, f.ws.ID)
	thumb := "thumbs/" + uid("t") + ".webp"
	if _, err := f.s.pool.Exec(ctx, `UPDATE files SET hidden=true, kind='pdf', thumbnail_key=$2 WHERE id=$1`, file.ID, thumb); err != nil {
		t.Fatal(err)
	}
	form := f.form(t, now.Add(time.Hour))
	total := 80
	form.QuizID, form.Questions, form.Title, form.TotalMarks = "", nil, "Mock paper", &total
	created, err := f.s.MakeFileGradedQuiz(ctx, f.user, f.ws.ID, file.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if !created.PaperFile || !created.UploadOnly || created.Marks != 80 || len(created.Files) != 1 || *created.Files[0].FileID != file.ID {
		t.Fatalf("made = %+v", created)
	}
	// Named to the member, unread until they start: not even its page 1.
	given, err := f.s.GetAssignment(ctx, f.viewer, created.ID, now)
	if err != nil || len(given.Files) != 1 || given.Files[0].ThumbnailKey != "" {
		t.Fatalf("member's = %+v, err %v", given.Files, err)
	}
	if _, err := f.s.FileReadRole(ctx, f.viewer, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("read before start: err %v", err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, true, now)
	if err != nil {
		t.Fatal(err)
	}
	if role, err := f.s.FileReadRole(ctx, f.viewer, file.ID); err != nil || role != RoleViewer {
		t.Fatalf("read once started = %q, err %v", role, err)
	}
	if given, err = f.s.GetAssignment(ctx, f.viewer, created.ID, now); err != nil || given.Files[0].ThumbnailKey != thumb {
		t.Fatalf("started member's = %+v, err %v", given.Files, err)
	}
	if _, err := f.s.ListPDFAnnotations(ctx, f.viewer, file.ID); err != nil {
		t.Fatalf("own marks: err %v", err)
	}
	// Read once, never its room: the edit session keeps the hidden rule.
	if _, err := f.s.SourceSession(ctx, f.viewer, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("source session: err %v", err)
	}
	// Only the paper's routes: the hidden rule stands elsewhere, and for a
	// classmate who has not started.
	if _, err := f.s.FileEffectiveRole(ctx, f.viewer, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("effective role: err %v", err)
	}
	if _, err := f.s.FileReadRole(ctx, f.other, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("classmate's read: err %v", err)
	}
	done, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{}, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if done.Paper != PaperRead || !done.GradesHidden {
		t.Fatalf("handed in = %s, hidden %v", done.Paper, done.GradesHidden)
	}
	if owner, err := f.s.GetAssignmentAttempt(ctx, f.user, run.ID, now.Add(time.Minute)); err != nil || owner.WaitingAnswers != 1 {
		t.Fatalf("the owner's read: waiting %d, err %v", owner.WaitingAnswers, err)
	}
	q := done.Questions[0]
	part := q["parts"].([]any)[0].(map[string]any)
	marked, _, err := f.s.MarkAssignmentAnswer(ctx, f.user, run.ID, AssignmentMark{
		QuestionID: q["id"].(string), Parts: []AssignmentPartMark{{PartID: part["id"].(string), Items: []float64{54}}},
	}, now.Add(2*time.Minute))
	if err != nil || marked.Correct != 54 || marked.WaitingAnswers != 0 {
		t.Fatalf("marked = %v, waiting %d, err %v", marked.Correct, marked.WaitingAnswers, err)
	}
	// A new total keeps the mark given, out of it; none below it.
	total = 50
	if _, err := f.s.UpdateAssignment(ctx, f.user, created.ID, form, now.Add(3*time.Minute)); !errors.Is(err, ErrPaperTotalBelowMark) {
		t.Fatalf("a total below the mark given: err %v", err)
	}
	total = 100
	form.Title, form.Marking, form.UploadOnly = "Mock paper 2025", MarkingAI, false
	updated, err := f.s.UpdateAssignment(ctx, f.user, created.ID, form, now.Add(3*time.Minute))
	if err != nil || updated.Title != "Mock paper 2025" || !updated.UploadOnly || len(updated.Files) != 1 || updated.Marks != 100 || updated.Manage.Graded != 1 {
		t.Fatalf("updated = %+v, err %v", updated, err)
	}
	if after, err := f.s.GetAssignmentAttempt(ctx, f.user, run.ID, now); err != nil || after.Correct != 54 || after.Total != 100 {
		t.Fatalf("after the new total = %v / %v, err %v", after.Correct, after.Total, err)
	}
	// Change file: the starter reads the new paper, hidden too, not the old one.
	next := uploadWorkspaceFile(t, f.s, f.user, f.ws.ID)
	if _, err := f.s.pool.Exec(ctx, `UPDATE files SET hidden=true WHERE id=$1`, next.ID); err != nil {
		t.Fatal(err)
	}
	changed, err := f.s.ChangePaperFile(ctx, f.user, created.ID, next.ID, now)
	if err != nil || len(changed.Files) != 1 || *changed.Files[0].FileID != next.ID {
		t.Fatalf("changed = %+v, err %v", changed.Files, err)
	}
	if role, err := f.s.FileReadRole(ctx, f.viewer, next.ID); err != nil || role != RoleViewer {
		t.Fatalf("new paper = %q, err %v", role, err)
	}
	// Its marking point names the new file in the member's graded copy too.
	renamed, err := f.s.GetAssignmentAttempt(ctx, f.user, run.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	item := renamed.Questions[0]["parts"].([]any)[0].(map[string]any)["markscheme"].([]any)[0].(map[string]any)
	if item["text"] != next.Name {
		t.Fatalf("marking point = %v", item["text"])
	}
	if _, err := f.s.FileReadRole(ctx, f.viewer, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old paper: err %v", err)
	}
	// A draft holds its copy, and Publish gives it out.
	form.Draft, total = true, 20
	draft, err := f.s.MakeFileGradedQuiz(ctx, f.user, f.ws.ID, file.ID, form, now)
	if err != nil || !draft.Draft || draft.Marks != 20 {
		t.Fatalf("draft = %+v, err %v", draft, err)
	}
	published, err := f.s.PublishAssignment(ctx, f.user, draft.ID, nil, now)
	if err != nil || published.Draft || published.Marks != 20 || published.Questions != 1 {
		t.Fatalf("published = %+v, err %v", published, err)
	}
}
