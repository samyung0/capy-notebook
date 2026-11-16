package store

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/models"
)

// Fixes from the board train's submissions review (Q714 A): paper and hand-in
// access, submissions kept out of account chat and edits, reads that start or
// run again, and what goes with a leaver.

// paperRun is a viewer's paper attempt on an assignment that takes uploads.
type paperRun struct {
	assignment Assignment
	attemptID  string
}

func startPaper(t *testing.T, f assignmentFixture, now time.Time, edit func(*AssignmentForm)) paperRun {
	t.Helper()
	ctx := context.Background()
	form := f.form(t, now.Add(time.Hour))
	form.AllowUploads = true
	if edit != nil {
		edit(&form)
	}
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, true, now)
	if err != nil {
		t.Fatal(err)
	}
	return paperRun{created, run.ID}
}

// addPaperFile uploads name into the viewer's running paper; a text file
// queues its ingest, which pins the registry's models.
func addPaperFile(t *testing.T, f assignmentFixture, attemptID, name, kind string, now time.Time) File {
	t.Helper()
	ctx := context.Background()
	if f.s.ModelRegistry() == nil {
		reg, err := models.New(ctx, f.s.Pool())
		if err != nil {
			t.Fatal(err)
		}
		f.s.SetModelRegistry(reg)
	}
	upload, err := f.s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), CreatedBy: f.viewer, ObjectPath: "sources/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: name, Kind: kind, ContentType: "application/octet-stream", DeclaredSize: 2048, ParseMode: "none",
		ExpiresAt: now.Add(time.Hour), AttemptID: attemptID, PaperMaxBytes: 10 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	file, err := f.s.FinalizeUploadSession(ctx, f.viewer, upload.ID, "etag", "", "")
	if err != nil {
		t.Fatal(err)
	}
	return file
}

// TestPaperFileOpensForItsMemberAndStaffOnly (security): a paper's file opens
// for the member who handed it in and, once submitted, for the class's staff;
// another member never, and staff not while the attempt runs.
func TestPaperFileOpensForItsMemberAndStaffOnly(t *testing.T) {
	f := newAssignmentFixture(t, "paper-blob")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	run := startPaper(t, f, now, nil)
	file := addPaperFile(t, f, run.attemptID, "paper.pdf", "pdf", now)
	if _, _, err := f.s.PaperFileBlob(ctx, f.viewer, run.attemptID, file.ID); err != nil {
		t.Fatalf("member: %v", err)
	}
	if _, _, err := f.s.PaperFileBlob(ctx, f.user, run.attemptID, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("staff before submit: %v", err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.attemptID, map[string]any{}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.s.PaperFileBlob(ctx, f.other, run.attemptID, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another member: %v", err)
	}
	if _, _, err := f.s.PaperFileBlob(ctx, f.editor, run.attemptID, file.ID); err != nil {
		t.Fatalf("staff after submit: %v", err)
	}
}

// TestHandInFileOpensForItsMemberAndStaffOnly (security): a hand-in's file
// opens for its member and, once handed in, for staff; another member never,
// and staff not before Hand in.
func TestHandInFileOpensForItsMemberAndStaffOnly(t *testing.T) {
	f := newAssignmentFixture(t, "handin-blob")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	created := unmarkedHandIn(t, f, now)
	file := addHandInFile(t, f, created.ID, now)
	if _, _, err := f.s.HandInFileBlob(ctx, f.viewer, created.ID, file.ID); err != nil {
		t.Fatalf("member: %v", err)
	}
	if _, _, err := f.s.HandInFileBlob(ctx, f.user, created.ID, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("staff before hand in: %v", err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, created.ID, true, now); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.s.HandInFileBlob(ctx, f.other, created.ID, file.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another member: %v", err)
	}
	if _, _, err := f.s.HandInFileBlob(ctx, f.user, created.ID, file.ID); err != nil {
		t.Fatalf("staff after hand in: %v", err)
	}
}

func unmarkedHandIn(t *testing.T, f assignmentFixture, now time.Time, assignees ...string) Assignment {
	t.Helper()
	created, err := f.s.CreateAssignment(context.Background(), f.user, f.ws.ID, AssignmentForm{Kind: AssignmentUnmarked,
		Title: "Lab write-up", Attempts: 1, AssignAll: len(assignees) == 0, Assignees: assignees, Marking: MarkingAIApprove,
		ShowAnswers: AnswersAfterClose, ShowGrades: GradesAutomatic, Files: []AssignmentFileRef{}, AllowUploads: true}, now)
	if err != nil {
		t.Fatal(err)
	}
	return created
}

func addHandInFile(t *testing.T, f assignmentFixture, assignmentID string, now time.Time) File {
	t.Helper()
	ctx := context.Background()
	upload, err := f.s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), CreatedBy: f.viewer, ObjectPath: "sources/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "write-up.pdf", Kind: "pdf", ContentType: "application/pdf", DeclaredSize: 2048, ParseMode: "none",
		ExpiresAt: now.Add(time.Hour), HandInID: assignmentID, PaperMaxBytes: 10 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	file, err := f.s.FinalizeUploadSession(ctx, f.viewer, upload.ID, "etag", "", "")
	if err != nil {
		t.Fatal(err)
	}
	return file
}

// TestAnUploadJoinsOnlyTheUploadersOwnWork (security): another member's
// attempt id refuses the upload ticket and the upload session, and an
// assignment not given to the uploader refuses their hand-in upload.
func TestAnUploadJoinsOnlyTheUploadersOwnWork(t *testing.T) {
	f := newAssignmentFixture(t, "upload-own")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	run := startPaper(t, f, now, nil)
	if err := f.s.AssertPaperUpload(ctx, run.attemptID, f.other, 1024, 10<<20, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ticket on another's attempt: %v", err)
	}
	if _, err := f.s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), CreatedBy: f.other, ObjectPath: "sources/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "paper.pdf", Kind: "pdf", ContentType: "application/pdf", DeclaredSize: 1024, ParseMode: "none",
		ExpiresAt: now.Add(time.Hour), AttemptID: run.attemptID, PaperMaxBytes: 10 << 20,
	}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("session on another's attempt: %v", err)
	}
	handIn := unmarkedHandIn(t, f, now, f.viewer)
	if err := f.s.AssertHandInUpload(ctx, handIn.ID, f.other, 1024, 10<<20); !errors.Is(err, ErrNotFound) {
		t.Fatalf("hand-in by a member it did not go to: %v", err)
	}
	if err := f.s.AssertHandInUpload(ctx, handIn.ID, f.viewer, 1024, 10<<20); err != nil {
		t.Fatalf("hand-in by its member: %v", err)
	}
}

// TestHandInTakesNoFileOnceStorageIsFull (Q728 A): a file added while there
// is room saves though it takes the member past their limit; once full, the
// ticket and the upload session refuse the next file, as a Marked paper's
// start does, while Hand in and Undo hand in still work.
func TestHandInTakesNoFileOnceStorageIsFull(t *testing.T) {
	f := newAssignmentFixture(t, "handin-full")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	handIn := unmarkedHandIn(t, f, now, f.viewer)
	limit := mustPlanLimits(t, f.s, PlanFree).StorageBytes
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO user_storage (user_id, used_bytes) VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE SET used_bytes=EXCLUDED.used_bytes`, f.viewer, limit-1024); err != nil {
		t.Fatal(err)
	}
	addHandInFile(t, f, handIn.ID, now) // 2048 bytes into 1024 of room
	var quota *QuotaExceededError
	if err := f.s.AssertHandInUpload(ctx, handIn.ID, f.viewer, 1024, 10<<20); !errors.As(err, &quota) {
		t.Fatalf("ticket once full = %v", err)
	}
	if _, err := f.s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), CreatedBy: f.viewer, ObjectPath: "sources/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "more.pdf", Kind: "pdf", ContentType: "application/pdf", DeclaredSize: 1024, ParseMode: "none",
		ExpiresAt: now.Add(time.Hour), HandInID: handIn.ID, PaperMaxBytes: 10 << 20,
	}); !errors.As(err, &quota) {
		t.Fatalf("upload session once full = %v", err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, handIn.ID, true, now); err != nil {
		t.Fatalf("hand in when full: %v", err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, handIn.ID, false, now); err != nil {
		t.Fatalf("undo hand in when full: %v", err)
	}
}

// TestSubmissionIsNoAccountDocumentAndReadOnly (security, finding 4): a
// handed-in file opens no editing session for its member, takes no edit, and
// is neither listed nor readable in their account chat.
func TestSubmissionIsNoAccountDocumentAndReadOnly(t *testing.T) {
	f := newAssignmentFixture(t, "submission-scope")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	run := startPaper(t, f, now, nil)
	file := addPaperFile(t, f, run.attemptID, "answers.txt", "txt", now)
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.attemptID, map[string]any{}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	session, err := f.s.SourceSession(ctx, f.viewer, file.ID)
	if err != nil || session.Access != "read" {
		t.Fatalf("session access %q, err %v", session.Access, err)
	}
	if err := f.s.CheckSourceAccess(ctx, f.viewer, file.ID, session.Epoch, true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("edit admitted: %v", err)
	}
	docs, err := f.s.AccountDocuments(ctx, f.viewer, AccountDocumentPlace{})
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range docs {
		if d.ID == file.ID {
			t.Fatalf("listed in account chat: %+v", d)
		}
	}
	read, err := f.s.AccountDocumentAccess(ctx, f.viewer, []agenttools.ResourceRef{{Kind: agenttools.KindSourceFile, ID: file.ID}})
	if err != nil || read[0].CanRead {
		t.Fatalf("account chat reads it: %+v, err %v", read, err)
	}
}

// TestClosedQuizKeepsItsKeysFromAssignees (security, finding 5): closing an
// assignment hands its quiz to those it went to only once grades are out under
// Show grades Manual, and never under Show answers Do not show.
func TestClosedQuizKeepsItsKeysFromAssignees(t *testing.T) {
	f := newAssignmentFixture(t, "closed-keys")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	closeWith := func(edit func(*AssignmentForm)) Assignment {
		t.Helper()
		form := f.form(t, now.Add(time.Hour))
		edit(&form)
		created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, true, now); err != nil {
			t.Fatal(err)
		}
		return created
	}
	manual := closeWith(func(form *AssignmentForm) { form.ShowGrades = GradesManual })
	if _, err := f.s.MaterialEffectiveRole(ctx, f.viewer, f.quiz.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("closed before release: %v", err)
	}
	if _, _, err := f.s.ReleaseAssignmentGrades(ctx, f.user, manual.ID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.MaterialEffectiveRole(ctx, f.viewer, f.quiz.ID); err != nil {
		t.Fatalf("released: %v", err)
	}
	never := closeWith(func(form *AssignmentForm) { form.ShowAnswers = AnswersNever })
	if _, err := f.s.MaterialEffectiveRole(ctx, f.viewer, f.quiz.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("closed with answers never shown: %v", err)
	}
	// The sweep leaves it held until staff turn it to practice: no Practise again.
	if _, _, err := f.s.SweepAssignments(ctx, 50, now); err != nil {
		t.Fatal(err)
	}
	if mine, err := f.s.GetAssignment(ctx, f.viewer, never.ID, now); err != nil || mine.PracticeQuizID != nil {
		t.Fatalf("practice offered: %v, err %v", mine.PracticeQuizID, err)
	}
}

// TestManualGradesSubmitStillNeedsMarking (finding 1): under Show grades
// Manual the member's view shows nothing waiting, while the submit still
// says its answers go to the AI.
func TestManualGradesSubmitStillNeedsMarking(t *testing.T) {
	f := newAssignmentFixture(t, "manual-grades-marking")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	form := f.form(t, now.Add(time.Hour))
	form.ShowGrades = GradesManual
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, false, now)
	if err != nil {
		t.Fatal(err)
	}
	done, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{"p3": "The membrane"}, now.Add(time.Minute))
	if err != nil || !done.GradesHidden || done.WaitingAnswers != 0 || !done.NeedsMarking {
		t.Fatalf("submitted hidden %v waiting %d needs %v, err %v", done.GradesHidden, done.WaitingAnswers, done.NeedsMarking, err)
	}
	again, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{}, now.Add(2*time.Minute))
	if err != nil || again.NeedsMarking {
		t.Fatalf("a repeated submit needs marking: %v, err %v", again.NeedsMarking, err)
	}
}

// TestServerSubmittedPaperStartsItsRead (finding 2): a paper the sweep
// submits, or one found past its time when read, starts its read.
func TestServerSubmittedPaperStartsItsRead(t *testing.T) {
	f := newAssignmentFixture(t, "paper-auto-read")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	var mu sync.Mutex
	var read []string
	f.s.OnPaperHandedIn(func(_, attemptID string) {
		mu.Lock()
		defer mu.Unlock()
		read = append(read, attemptID)
	})
	t.Cleanup(func() { f.s.OnPaperHandedIn(nil) })
	limit := 10
	timed := func(form *AssignmentForm) { form.TimeLimitMin = &limit }
	swept := startPaper(t, f, now, timed)
	opened := startPaper(t, f, now, timed)
	later := now.Add(time.Hour)
	if _, _, err := f.s.SweepAssignments(ctx, 50, later); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	sweptRead := len(read) > 0
	mu.Unlock()
	if !sweptRead {
		t.Fatal("the sweep's paper started no read")
	}
	// The sweep took both; a third, found past its time on read, starts one too.
	third := startPaper(t, f, now, timed)
	if _, err := f.s.GetAssignmentAttempt(ctx, f.viewer, third.attemptID, later); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	got := map[string]bool{}
	for _, id := range read {
		got[id] = true
	}
	for _, id := range []string{swept.attemptID, opened.attemptID, third.attemptID} {
		if !got[id] {
			t.Fatalf("no read started for %s: %v", id, read)
		}
	}
}

// TestPaperReadUsesTheAttemptsOwnCopy (finding 10): a republish after the
// submit changes what the assignment holds, not what the paper is read and
// marked against.
func TestPaperReadUsesTheAttemptsOwnCopy(t *testing.T) {
	f := newAssignmentFixture(t, "paper-own-copy")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	run := startPaper(t, f, now, nil)
	addPaperFile(t, f, run.attemptID, "paper.pdf", "pdf", now)
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.attemptID, map[string]any{}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.RepublishAssignment(ctx, f.user, run.assignment.ID, frozenFixture(t)[:1], now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	paper, err := f.s.GetPaper(ctx, run.attemptID)
	if err != nil || len(paper.Parts) != 3 {
		t.Fatalf("parts = %d, err %v", len(paper.Parts), err)
	}
	if err := f.s.SavePaperRead(ctx, run.attemptID, map[string]PaperFinding{
		"p1": {Pages: []int{1}, Answer: []any{"B"}},
		"p2": {Pages: []int{1}, Answer: "osmosis"},
	}, now.Add(3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	read, err := f.s.GetAssignmentAttempt(ctx, f.user, run.attemptID, now.Add(3*time.Minute))
	if err != nil || read.Paper != PaperRead || read.Correct != 3 || read.Total != 6 {
		t.Fatalf("read = %s, %v of %v, err %v", read.Paper, read.Correct, read.Total, err)
	}
}

// TestPaperTextGapSaysWhy (finding 8, Q730): an Office paper with no passages
// says No credits when its ingest was skipped for them and Can't read file
// when it failed.
func TestPaperTextGapSaysWhy(t *testing.T) {
	f := newAssignmentFixture(t, "paper-text-gap")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	run := startPaper(t, f, now, nil)
	file := addPaperFile(t, f, run.attemptID, "answers.docx", "doc", now)
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.attemptID, map[string]any{}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	for status, want := range map[string]string{"ready": AIErrorCredits, "failed": AIErrorFile} {
		// A fast parse it would have run, had credits not skipped it.
		if _, err := f.s.pool.Exec(ctx, `UPDATE files SET status=$2, indexed=false, parse_mode='fast' WHERE id=$1`, file.ID, status); err != nil {
			t.Fatal(err)
		}
		paper, err := f.s.GetPaper(ctx, run.attemptID)
		if err != nil || paper.TextGap != want {
			t.Fatalf("%s: gap %q, err %v", status, paper.TextGap, err)
		}
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE files SET status='ready', indexed=true WHERE id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	if paper, err := f.s.GetPaper(ctx, run.attemptID); err != nil || paper.TextGap != "" {
		t.Fatalf("indexed: gap %q, err %v", paper.TextGap, err)
	}
}

// TestLeaverMarkedPaperAndHandInGo (finding 11): as a member leaves, their
// marked paper's files and their hand-ins go, as marked drawings do; a paper
// still waiting stays for staff.
func TestLeaverMarkedPaperAndHandInGo(t *testing.T) {
	f := newAssignmentFixture(t, "paper-leaver")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	marked := startPaper(t, f, now, nil)
	markedFile := addPaperFile(t, f, marked.attemptID, "marked.pdf", "pdf", now)
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, marked.attemptID, map[string]any{}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := f.s.SavePaperRead(ctx, marked.attemptID, map[string]PaperFinding{"p1": {Pages: []int{1}, Answer: []any{"B"}}}, now); err != nil {
		t.Fatal(err)
	}
	waiting := startPaper(t, f, now, nil)
	waitingFile := addPaperFile(t, f, waiting.attemptID, "waiting.pdf", "pdf", now)
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, waiting.attemptID, map[string]any{}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	handIn := unmarkedHandIn(t, f, now)
	handInFile := addHandInFile(t, f, handIn.ID, now)
	if err := f.s.RemoveWorkspaceMember(ctx, f.user, f.ws.ID, f.viewer); err != nil {
		t.Fatal(err)
	}
	var left []string
	rows, err := f.s.pool.Query(ctx, `SELECT id FROM files WHERE id = ANY($1)`,
		[]string{markedFile.ID, waitingFile.ID, handInFile.ID})
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		left = append(left, id)
	}
	if rows.Err() != nil || len(left) != 1 || left[0] != waitingFile.ID {
		t.Fatalf("left %v, want only the waiting paper's %s", left, waitingFile.ID)
	}
}
