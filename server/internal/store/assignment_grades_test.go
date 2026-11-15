package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func (f assignmentFixture) gradedForm(due time.Time, points int) AssignmentForm {
	return AssignmentForm{Kind: AssignmentUnmarked, Title: "Lab write-up", DueAt: &due, Attempts: 1, AssignAll: true,
		Assignees: []string{}, Marking: MarkingAIApprove, ShowAnswers: AnswersAfterClose, ShowGrades: GradesAutomatic,
		Files: []AssignmentFileRef{}, Points: &points}
}

// A graded Assignment (Epo 2026-11-14): staff give each member a grade out of
// its points, which the report, the Average, the member's own row and Members
// read with the late penalty off it, as a graded quiz's marks.
func TestGradedAssignment(t *testing.T) {
	f := newAssignmentFixture(t, "graded-assignment")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	form := f.gradedForm(now.Add(time.Hour), 20)
	form.LatePenaltyPct = 20
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if created.Points == nil || *created.Points != 20 {
		t.Fatalf("points = %v", created.Points)
	}
	// Handed in late; the other member on time.
	if err := f.s.SetAssignmentDone(ctx, f.viewer, created.ID, true, now.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.other, created.ID, true, now); err != nil {
		t.Fatal(err)
	}
	grade := func(actor, member string, points float64) error {
		return f.s.SetAssignmentGrade(ctx, actor, created.ID, member, &points, now)
	}
	if err := grade(f.viewer, f.viewer, 20); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a member's grade = %v", err)
	}
	var input *AssignmentInputError
	for _, bad := range []float64{20.5, 3.25} {
		if err := grade(f.user, f.viewer, bad); !errors.As(err, &input) {
			t.Fatalf("grade %v = %v", bad, err)
		}
	}
	if err := grade(f.user, f.viewer, 15); err != nil {
		t.Fatal(err)
	}
	if err := grade(f.editor, f.other, 18); err != nil {
		t.Fatal(err)
	}

	at := now.Add(3 * time.Hour)
	report, err := f.s.GetAssignmentReport(ctx, f.user, created.ID, at)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range report.Members {
		if row.UserID != f.viewer {
			continue
		}
		if !row.Late || row.LatePenaltyPct != 20 || *row.Correct != 15 || *row.Mark != 12 || *row.Total != 20 {
			t.Fatalf("report row = %+v", row)
		}
	}
	staff, err := f.s.GetAssignment(ctx, f.user, created.ID, at)
	if err != nil {
		t.Fatal(err)
	}
	// (12/20 + 18/20) / 2.
	if avg := staff.Manage.Average; avg == nil || *avg != 0.75 {
		t.Fatalf("average = %v", avg)
	}
	mine, err := f.s.GetAssignment(ctx, f.viewer, created.ID, at)
	if err != nil {
		t.Fatal(err)
	}
	if m := mine.Mine; m.Mark == nil || *m.Mark != 12 || *m.Total != 20 || m.LatePenaltyPct != 20 {
		t.Fatalf("mine = %+v", m)
	}
	marks, err := f.s.membersMarks(ctx, f.ws.ID, []string{f.viewer}, at)
	if err != nil {
		t.Fatal(err)
	}
	if o := marks[f.viewer].Overall; o == nil || *o != 0.6 {
		t.Fatalf("overall = %v", o)
	}

	// Cleared, it reads as not graded again.
	if err := f.s.SetAssignmentGrade(ctx, f.user, created.ID, f.viewer, nil, now); err != nil {
		t.Fatal(err)
	}
	if mine, err = f.s.GetAssignment(ctx, f.viewer, created.ID, at); err != nil || mine.Mine.Mark != nil {
		t.Fatalf("after clearing = %+v, %v", mine.Mine, err)
	}
}

// Show grades Manual holds a grade until release, which tells each member
// graded.
func TestGradedAssignmentWaitsForRelease(t *testing.T) {
	f := newAssignmentFixture(t, "graded-release")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	form := f.gradedForm(now.Add(time.Hour), 10)
	form.ShowGrades = GradesManual
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	points := 7.5
	if err := f.s.SetAssignmentGrade(ctx, f.user, created.ID, f.viewer, &points, now); err != nil {
		t.Fatal(err)
	}
	held, err := f.s.GetAssignment(ctx, f.viewer, created.ID, now)
	if err != nil || held.Mine.Mark != nil || !held.GradesHidden {
		t.Fatalf("before release = %+v, %v", held.Mine, err)
	}
	_, told, err := f.s.ReleaseAssignmentGrades(ctx, f.user, created.ID, now)
	if err != nil || len(told) != 1 || told[0].UserID != f.viewer {
		t.Fatalf("release told %+v, %v", told, err)
	}
	shown, err := f.s.GetAssignment(ctx, f.viewer, created.ID, now)
	if err != nil || shown.Mine.Mark == nil || *shown.Mine.Mark != 7.5 {
		t.Fatalf("after release = %+v, %v", shown.Mine, err)
	}
}

// Points belong to a class's Assignment: a graded quiz and a task have none.
func TestPointsOnlyOnAnAssignment(t *testing.T) {
	f := newAssignmentFixture(t, "graded-points-kind")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	points := 10
	marked := f.form(t, now.Add(time.Hour))
	marked.Points = &points
	var input *AssignmentInputError
	if _, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, marked, now); !errors.As(err, &input) {
		t.Fatalf("a graded quiz with points = %v", err)
	}
	task := f.gradedForm(now.Add(time.Hour), 10)
	task.AssignAll, task.Assignees = false, []string{f.viewer}
	if _, err := f.s.CreateAssignment(ctx, f.viewer, f.ws.ID, task, now); !errors.As(err, &input) {
		t.Fatalf("a task with points = %v", err)
	}
}
