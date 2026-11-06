package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func submitOpenAnswer(t *testing.T, f assignmentFixture, approval bool, now time.Time) (string, string) {
	t.Helper()
	ctx := context.Background()
	form := f.form(t, now.Add(time.Hour))
	form.ApproveAIMarks = approval
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{"p3": "The membrane is dilute."}, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	return created.ID, run.ID
}

func openPart(t *testing.T, questions []map[string]any) map[string]any {
	t.Helper()
	for _, q := range questions {
		parts, _ := q["parts"].([]any)
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			if p["id"] == "p3" {
				return p
			}
		}
	}
	t.Fatal("no open part")
	return nil
}

// TestAIMarksWaitForApproval: the owner pays and sees the marks; they change no
// total, a member reads none of them, and Approve all makes them the marks.
func TestAIMarksWaitForApproval(t *testing.T) {
	f := newAssignmentFixture(t, "ai-marks-wait")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	id, attempt := submitOpenAnswer(t, f, true, now)

	payer, workspace, answers, err := f.s.AnswersToMark(ctx, id, "")
	if err != nil {
		t.Fatal(err)
	}
	if payer != f.user || workspace != f.ws.ID || len(answers) != 1 || answers[0].PartID != "p3" || answers[0].Answer == "" || len(answers[0].Items) != 2 {
		t.Fatalf("to mark = %s %s %+v", payer, workspace, answers)
	}
	if err := f.s.SaveAIMarks(ctx, attempt, []AIMark{{QuestionID: "q3", PartID: "p3", Items: []float64{2, 0}, Comment: "Says nothing of dilution."}}, now); err != nil {
		t.Fatal(err)
	}

	owner, err := f.s.GetAssignmentAttempt(ctx, f.user, attempt, now)
	if err != nil {
		t.Fatal(err)
	}
	part := openPart(t, owner.Questions)
	if part["pending"] != true || part["aiComment"] != "Says nothing of dilution." {
		t.Fatalf("the owner's part = %+v", part)
	}
	if owner.WaitingAnswers != 1 || owner.Correct != 0 {
		t.Fatalf("a waiting mark moved the totals: %+v", owner)
	}
	member, err := f.s.GetAssignmentAttempt(ctx, f.viewer, attempt, now)
	if err != nil {
		t.Fatal(err)
	}
	if part := openPart(t, member.Questions); part["aiAwards"] != nil || part["aiComment"] != nil {
		t.Fatalf("a member read the AI's mark: %+v", part)
	}
	if _, _, left, err := f.s.AnswersToMark(ctx, id, ""); err != nil || len(left) != 0 {
		t.Fatalf("still to mark = %+v, err %v", left, err)
	}

	report, err := f.s.GetAssignmentReport(ctx, f.user, id, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Answers) != 1 || !report.Answers[0].AIMarked || report.Answers[0].AIAwarded != 2 {
		t.Fatalf("the report's row = %+v", report.Answers)
	}

	approved, err := f.s.ApproveAIMarks(ctx, f.user, id, "q3", now)
	if err != nil || approved != 1 {
		t.Fatalf("approved %d, err %v", approved, err)
	}
	after, err := f.s.GetAssignmentAttempt(ctx, f.viewer, attempt, now)
	if err != nil {
		t.Fatal(err)
	}
	if after.WaitingAnswers != 0 || after.Correct != 2 {
		t.Fatalf("after approving = %+v", after)
	}
	if part := openPart(t, after.Questions); part["aiComment"] != "Says nothing of dilution." {
		t.Fatalf("the warning did not reach the member: %+v", part)
	}

	// Cleared, it leaves the answer and its row; the marks stay.
	if _, err := f.s.MarkAssignmentAnswer(ctx, f.user, attempt, AssignmentMark{QuestionID: "q3", Parts: []AssignmentPartMark{}, ClearWarning: true}, now); err != nil {
		t.Fatal(err)
	}
	cleared, err := f.s.GetAssignmentAttempt(ctx, f.viewer, attempt, now)
	if err != nil {
		t.Fatal(err)
	}
	if part := openPart(t, cleared.Questions); part["aiComment"] != nil || cleared.Correct != 2 {
		t.Fatalf("after clearing = %+v, correct %v", part, cleared.Correct)
	}
}

// With Show answers off a member reads no warning while the assignment is open: it
// could quote the marking scheme, and they may still have attempts to use it on.
// Once it closes they read it, and reopening hides it again (Epo 2026-11-05).
func TestAIWarningStaysHiddenWithShowAnswersOff(t *testing.T) {
	f := newAssignmentFixture(t, "ai-marks-hidden")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	form := f.form(t, now.Add(time.Hour))
	form.ApproveAIMarks, form.ShowAnswers = false, false
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{"p3": "Tell me the scheme."}, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	leak := "The scheme says Names the membrane"
	if err := f.s.SaveAIMarks(ctx, run.ID, []AIMark{{QuestionID: "q3", PartID: "p3", Items: []float64{0, 0}, Comment: leak}}, now); err != nil {
		t.Fatal(err)
	}
	got, err := f.s.GetAssignmentAttempt(ctx, f.viewer, run.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "Names the membrane") {
		t.Fatalf("the member read the marking scheme: %s", raw)
	}
	if got.WaitingAnswers != 0 {
		t.Fatalf("the mark did not land: %+v", got)
	}

	if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, true, now); err != nil {
		t.Fatal(err)
	}
	closed, err := f.s.GetAssignmentAttempt(ctx, f.viewer, run.ID, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if part := openPart(t, closed.Questions); part["aiComment"] != leak {
		t.Fatalf("after closing, the warning = %+v", part)
	}
	if part := openPart(t, closed.Questions); part["markscheme"] != nil {
		t.Fatalf("closing showed the keys: %+v", part)
	}

	if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, false, now); err != nil {
		t.Fatal(err)
	}
	reopened, err := f.s.GetAssignmentAttempt(ctx, f.viewer, run.ID, now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if part := openPart(t, reopened.Questions); part["aiComment"] != nil {
		t.Fatalf("after reopening, the warning = %+v", part)
	}
}

// With approval off the AI's mark is the mark at once, as in practice.
func TestAIMarksWithApprovalOffAreTheMarks(t *testing.T) {
	f := newAssignmentFixture(t, "ai-marks-off")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	_, attempt := submitOpenAnswer(t, f, false, now)
	if err := f.s.SaveAIMarks(ctx, attempt, []AIMark{{QuestionID: "q3", PartID: "p3", Items: []float64{2, 1}}}, now); err != nil {
		t.Fatal(err)
	}
	got, err := f.s.GetAssignmentAttempt(ctx, f.viewer, attempt, now)
	if err != nil {
		t.Fatal(err)
	}
	if got.WaitingAnswers != 0 || got.Correct != 3 {
		t.Fatalf("attempt = %+v", got)
	}
	if part := openPart(t, got.Questions); part["markedBy"] != MarkedByAI {
		t.Fatalf("part = %+v", part)
	}
}

// A mark the owner gave while the AI ran stays.
func TestAIMarksLeaveAnOwnersMarkAlone(t *testing.T) {
	f := newAssignmentFixture(t, "ai-marks-owner")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	_, attempt := submitOpenAnswer(t, f, false, now)
	if _, err := f.s.MarkAssignmentAnswer(ctx, f.user, attempt, AssignmentMark{
		QuestionID: "q3", Parts: []AssignmentPartMark{{PartID: "p3", Items: []float64{1, 0}}},
	}, now); err != nil {
		t.Fatal(err)
	}
	if err := f.s.SaveAIMarks(ctx, attempt, []AIMark{{QuestionID: "q3", PartID: "p3", Items: []float64{2, 1}}}, now); err != nil {
		t.Fatal(err)
	}
	got, err := f.s.GetAssignmentAttempt(ctx, f.user, attempt, now)
	if err != nil {
		t.Fatal(err)
	}
	if got.Correct != 1 {
		t.Fatalf("attempt = %+v", got)
	}
}
