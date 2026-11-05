package store

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/planlimits"
	"github.com/samyung0/capy-notebook/server/internal/review"
)

// assignmentQuestions is a multiple choice, a short answer and an open part.
const assignmentQuestions = `[
 {"id":"q1","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p1","blocks":[{"type":"text","text":"Pick"}],"answer":{"type":"mcq","options":["a","b"],"correct":[1]},"marks":1,"solution":[]}]},
 {"id":"q2","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p2","blocks":[{"type":"text","text":"Name it"}],"answer":{"type":"short","accepted":["osmosis"]},"marks":2,"solution":[]}]},
 {"id":"q3","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"p3","blocks":[{"type":"text","text":"Explain"}],"answer":{"type":"open","accepted":[],"hints":[]},"marks":3,"markscheme":[{"text":"Names the membrane","marks":2},{"text":"Says dilute","marks":1}],"solution":[]}]}
]`

func frozenFixture(t *testing.T) []map[string]any {
	t.Helper()
	var qs []map[string]any
	if err := json.Unmarshal([]byte(assignmentQuestions), &qs); err != nil {
		t.Fatal(err)
	}
	return qs
}

// TestGradeAttemptMarksClosedPartsAndHoldsOpenOnes: closed parts are scored, an
// answered open part waits with no marks and no model, a blank one scores 0.
func TestGradeAttemptMarksClosedPartsAndHoldsOpenOnes(t *testing.T) {
	graded, given := gradeAttempt(frozenFixture(t), map[string]any{
		"p1": []any{float64(1)}, "p2": "Osmosis", "p3": "Water moves in", "unknown": "dropped",
	})
	if _, ok := given["unknown"]; ok {
		t.Fatal("kept an answer to a part the copy does not have")
	}
	correct, total, waitingMarks, waitingAnswers := attemptTotals(graded)
	if correct != 3 || total != 6 || waitingMarks != 3 || waitingAnswers != 1 {
		t.Fatalf("totals = %v of %v, waiting %v in %d answers", correct, total, waitingMarks, waitingAnswers)
	}
	open := graded[2]["parts"].([]any)[0].(map[string]any)
	if open["pending"] != true || open["itemAwards"] != nil {
		t.Fatalf("an answered open part = %v", open)
	}

	blank, _ := gradeAttempt(frozenFixture(t), map[string]any{"p3": "   "})
	if _, _, _, waiting := attemptTotals(blank); waiting != 0 {
		t.Fatal("a blank open answer waits for the owner")
	}
}

// TestApplyPartMarks: the owner's marks clear the wait, in half marks up to the
// marks, and a closed part's mark changes too.
func TestApplyPartMarks(t *testing.T) {
	graded, _ := gradeAttempt(frozenFixture(t), map[string]any{"p1": []any{float64(0)}, "p3": "Water moves in"})
	now := time.Now()
	open := graded[2]
	changed, err := applyPartMarks(open, []AssignmentPartMark{{PartID: "p3", Items: []float64{1.5, 1}}}, "owner", now)
	if err != nil || !changed["p3"] || questionWaiting(open) {
		t.Fatalf("changed %v, waiting %v, err %v", changed, questionWaiting(open), err)
	}
	if awarded, _ := questionMarks(open); awarded != 2.5 {
		t.Fatalf("open part awarded %v", awarded)
	}
	mark := 1.0
	changed, err = applyPartMarks(graded[0], []AssignmentPartMark{{PartID: "p1", Mark: &mark}}, "owner", now)
	if err != nil || !changed["p1"] {
		t.Fatalf("closed part: changed %v, err %v", changed, err)
	}
	if awarded, _ := questionMarks(graded[0]); awarded != 1 {
		t.Fatalf("closed part awarded %v", awarded)
	}
	for _, bad := range []AssignmentPartMark{
		{PartID: "p3", Items: []float64{3, 0}},
		{PartID: "p3", Items: []float64{0.25, 0}},
		{PartID: "p3", Items: []float64{1}},
		{PartID: "missing", Items: []float64{1, 1}},
	} {
		var input *AssignmentInputError
		if _, err := applyPartMarks(open, []AssignmentPartMark{bad}, "owner", now); !errors.As(err, &input) {
			t.Fatalf("mark %+v: err = %v", bad, err)
		}
	}
}

// TestGradedWithoutKeys: with Show answers off, a member gets marks and comments
// and no keys, marking points or worked solutions.
func TestGradedWithoutKeys(t *testing.T) {
	graded, _ := gradeAttempt(frozenFixture(t), map[string]any{"p1": []any{float64(1)}, "p3": "x"})
	graded[0]["comment"] = "Well done"
	raw, err := json.Marshal(gradedWithoutKeys(graded))
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, leak := range []string{"correct", "accepted", "markscheme", "Names the membrane", "solution"} {
		if strings.Contains(text, leak) {
			t.Fatalf("%q reached a member: %s", leak, text)
		}
	}
	if !strings.Contains(text, "Well done") || !strings.Contains(text, `"awarded":1`) || !strings.Contains(text, `"pending":true`) {
		t.Fatalf("marks or comment missing: %s", text)
	}
}

func TestShuffledQuestionsKeepAnAttemptsOrder(t *testing.T) {
	qs := frozenFixture(t)
	first, second := shuffledQuestions("at_1", qs), shuffledQuestions("at_1", qs)
	for i := range first {
		if first[i]["id"] != second[i]["id"] {
			t.Fatal("an attempt's order changed between reads")
		}
	}
}

// TestQuestionReports: answer frequencies, common wrong answers and marking
// points; shared numbers wait for five results.
func TestQuestionReports(t *testing.T) {
	var attempts []reportAttempt
	for i, answers := range []map[string]any{
		{"p1": []any{float64(1)}, "p2": "Osmosis", "p3": "a"},
		{"p1": []any{float64(1)}, "p2": "diffusion", "p3": "b"},
		{"p1": []any{float64(0)}, "p2": "Diffusion "},
		{"p1": []any{float64(1)}, "p2": "osmosis"},
	} {
		graded, given := gradeAttempt(frozenFixture(t), answers)
		byID := map[string]map[string]any{}
		for _, q := range graded {
			byID[q["id"].(string)] = q
		}
		attempts = append(attempts, reportAttempt{id: "at" + string(rune('a'+i)), userID: "u" + string(rune('a'+i)), answers: given, graded: byID})
	}
	// One of the two open answers is marked.
	open := attempts[0].graded["q3"]
	if _, err := applyPartMarks(open, []AssignmentPartMark{{PartID: "p3", Items: []float64{2, 0}}}, "owner", time.Now()); err != nil {
		t.Fatal(err)
	}
	// As the report reads it back from the database.
	raw, err := json.Marshal(open)
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]any
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	attempts[0].graded["q3"] = stored
	reports, rows := questionReports(frozenFixture(t), attempts)
	if got := reports[0].Parts[0].Options; got[0] != 1 || got[1] != 3 {
		t.Fatalf("options = %v", got)
	}
	if wrong := reports[1].Parts[0].WrongAnswers; len(wrong) != 1 || wrong[0].Text != "diffusion" || wrong[0].Count != 2 {
		t.Fatalf("wrong answers = %+v", wrong)
	}
	items := reports[2].Parts[0].Items
	if items[0].Awarded != 1 || items[1].Awarded != 0 {
		t.Fatalf("marking points = %+v", items)
	}
	if reports[0].Percent != nil {
		t.Fatal("a percentage showed under five results")
	}
	waiting := 0
	for _, row := range rows {
		if row.Waiting {
			waiting++
		}
	}
	if len(rows) != 4 || waiting != 1 {
		t.Fatalf("answer rows = %+v", rows)
	}

	attempts = append(attempts, attempts[3])
	attempts[4].userID = "ue"
	reports, _ = questionReports(frozenFixture(t), attempts)
	if reports[0].Percent == nil || *reports[0].Percent != 0.8 {
		t.Fatalf("percent = %v", reports[0].Percent)
	}
}

// TestCheckLatePolicy: the form takes what the dialog offers.
func TestCheckLatePolicy(t *testing.T) {
	due := time.Now()
	marked := AssignmentForm{Kind: AssignmentMarked, DueAt: &due}
	for _, form := range []func(f *AssignmentForm){
		func(f *AssignmentForm) {},
		func(f *AssignmentForm) { f.NoLate = true },
		func(f *AssignmentForm) { f.LatePenaltyPct = 20 },
		func(f *AssignmentForm) { f.LatePenaltyPct = 50 },
	} {
		f := marked
		form(&f)
		if err := checkLatePolicy(f); err != nil {
			t.Fatalf("%+v: %v", f, err)
		}
	}
	for _, form := range []func(f *AssignmentForm){
		func(f *AssignmentForm) { f.LatePenaltyPct = 30 },
		func(f *AssignmentForm) { f.NoLate, f.LatePenaltyPct = true, 20 },
		func(f *AssignmentForm) { f.NoLate, f.DueAt = true, nil },
		func(f *AssignmentForm) { f.LatePenaltyPct, f.DueAt = 20, nil },
		func(f *AssignmentForm) { f.NoLate, f.Kind = true, AssignmentUnmarked },
	} {
		f := marked
		form(&f)
		var input *AssignmentInputError
		if err := checkLatePolicy(f); !errors.As(err, &input) {
			t.Fatalf("%+v: err = %v", f, err)
		}
	}
}

// TestAssignmentClosing: a due date closes only under No late submissions, and
// only that makes nothing late.
func TestAssignmentClosing(t *testing.T) {
	now := time.Now()
	past, future, earlier := now.Add(-time.Hour), now.Add(time.Hour), now.Add(-2*time.Hour)
	if assignmentClosedAt(false, &past, nil, now) != nil {
		t.Fatal("a due date closed it with late work open")
	}
	if at := assignmentClosedAt(true, &past, nil, now); at == nil || !at.Equal(past) {
		t.Fatalf("No late submissions past due = %v", at)
	}
	if assignmentClosedAt(true, &future, nil, now) != nil {
		t.Fatal("closed before its due date")
	}
	if at := assignmentClosedAt(false, &past, &earlier, now); at == nil || !at.Equal(earlier) {
		t.Fatalf("closed by hand = %v", at)
	}
	if at := assignmentClosedAt(true, &past, &earlier, now); at == nil || !at.Equal(earlier) {
		t.Fatalf("closed by hand before its due date = %v", at)
	}
	if !assignmentLate(false, &past, now) || assignmentLate(true, &past, now) || assignmentLate(false, nil, now) {
		t.Fatal("late is after the due date, unless nothing late is taken")
	}
}

func TestPenalisedMark(t *testing.T) {
	for _, c := range []struct {
		correct float64
		pct     int
		want    float64
	}{{30, 20, 24}, {30, 50, 15}, {30, 0, 30}, {2.5, 20, 2}, {0, 50, 0}, {3.5, 50, 1.75}} {
		if got := penalisedMark(c.correct, c.pct); got != c.want {
			t.Fatalf("penalisedMark(%v, %d) = %v, want %v", c.correct, c.pct, got, c.want)
		}
	}
	if penaltyFor(false, 50) != 0 || penaltyFor(true, 50) != 50 {
		t.Fatal("only late work loses marks")
	}
}

type assignmentFixture struct {
	studyFixture
	editor, viewer, other string
	quiz                  Quiz
}

func newAssignmentFixture(t *testing.T, label string) assignmentFixture {
	t.Helper()
	f := newStudyFixture(t, label)
	ctx := context.Background()
	editor := newBlobTestUser(t, f.s, label+"-editor")
	viewer := newBlobTestUser(t, f.s, label+"-viewer")
	other := newBlobTestUser(t, f.s, label+"-other")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,'editor'), ($1,$3,'viewer'), ($1,$4,'viewer')`, f.ws.ID, editor, viewer, other); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='class' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	quiz, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: "Paper", WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name,
		Questions: json.RawMessage(assignmentQuestions), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	return assignmentFixture{f, editor, viewer, other, quiz}
}

func (f assignmentFixture) form(t *testing.T, due time.Time) AssignmentForm {
	t.Helper()
	return AssignmentForm{Kind: AssignmentMarked, Title: "Paper", QuizID: f.quiz.ID, Questions: frozenFixture(t),
		DueAt: &due, Attempts: 1, AssignAll: true, Assignees: []string{}, ApproveAIMarks: true, ShowAnswers: true, Files: []AssignmentFileRef{}}
}

// TestAssignmentRun walks a marked assignment: created with its quiz refused to
// its assignees, served from its frozen copy without keys, saved, submitted with its open part
// waiting, reported, and marked by an editor.
func TestAssignmentRun(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-run")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	limit := 30
	form := f.form(t, now.Add(24*time.Hour))
	form.TimeLimitMin = &limit
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if created.Questions != 3 || created.Marks != 6 || created.Draft || created.Manage == nil || created.Manage.Assigned != 2 {
		t.Fatalf("created = %+v manage %+v", created, created.Manage)
	}
	// The quiz is not the assignee's to read.
	if _, err := f.s.MaterialEffectiveRole(ctx, f.viewer, f.quiz.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the assignee reached the quiz: %v", err)
	}
	mine, err := f.s.ListAssignments(ctx, f.viewer, f.ws.ID, now)
	if err != nil || len(mine.Items) != 1 || mine.Items[0].Manage != nil || mine.Items[0].Mine == nil || mine.Members != nil {
		t.Fatalf("a member's list = %+v, err %v", mine, err)
	}

	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != "running" || run.DeadlineAt == nil || !run.DeadlineAt.Equal(now.Add(30*time.Minute)) {
		t.Fatalf("run = %+v", run)
	}
	raw, _ := json.Marshal(run.Questions)
	for _, leak := range []string{`"correct"`, "accepted", "markscheme"} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("%s reached the running attempt: %s", leak, raw)
		}
	}
	again, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now.Add(time.Minute))
	if err != nil || again.ID != run.ID {
		t.Fatalf("a second start = %v, err %v", again.ID, err)
	}
	// Saved answers come back on a reload.
	if err := f.s.SaveAssignmentAnswers(ctx, f.viewer, run.ID, map[string]any{"p2": "osmosis"}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	reread, err := f.s.GetAssignmentAttempt(ctx, f.viewer, run.ID, now.Add(time.Minute))
	if err != nil || reread.Answers["p2"] != "osmosis" {
		t.Fatalf("reread = %+v, err %v", reread.Answers, err)
	}

	done, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{
		"p1": []any{float64(1)}, "p2": "osmosis", "p3": "Water moves in",
	}, now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if done.Status != "submitted" || done.Correct != 3 || done.Total != 6 || done.WaitingMarks != 3 || done.WaitingAnswers != 1 || done.Late {
		t.Fatalf("submitted = %+v", done)
	}
	if _, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now.Add(3*time.Minute)); !errors.Is(err, ErrAssignmentNoAttempts) {
		t.Fatalf("a start past the attempts = %v", err)
	}

	report, err := f.s.GetAssignmentReport(ctx, f.editor, created.ID, now.Add(3*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Members) != 2 || len(report.Answers) != 1 || !report.Answers[0].Waiting {
		t.Fatalf("report = %+v", report)
	}
	marked, err := f.s.MarkAssignmentAnswer(ctx, f.editor, run.ID, AssignmentMark{
		QuestionID: "q3", Parts: []AssignmentPartMark{{PartID: "p3", Items: []float64{2, 0}}}, Comment: "Say why",
	}, now.Add(4*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if marked.Correct != 5 || marked.WaitingAnswers != 0 {
		t.Fatalf("marked = %+v", marked)
	}
	own, err := f.s.GetAssignmentAttempt(ctx, f.viewer, run.ID, now.Add(4*time.Minute))
	if err != nil || own.Questions[2]["comment"] != "Say why" || own.Questions[2]["commentByName"] == nil {
		t.Fatalf("a member's result = %+v, err %v", own.Questions, err)
	}
	var events int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM answer_events WHERE attempt_id=$1 AND source='assignment'`, run.ID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 3 {
		t.Fatalf("answer events = %d", events)
	}
	// Practice never counts it.
	practice, err := f.s.WorkspacePractice(ctx, f.viewer, f.ws.ID, false, now)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range practice.Quizzes {
		if q.ID == f.quiz.ID {
			t.Fatal("an assigned quiz listed as its assignee's practice")
		}
	}
	if _, err := f.s.GetAttempt(ctx, run.ID, f.viewer); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the plain attempt route read an assignment attempt: %v", err)
	}
	list, _, err := f.s.ListAttempts(ctx, f.viewer, AttemptParams{Limit: 10})
	if err != nil || len(list) != 0 {
		t.Fatalf("attempts list = %+v, err %v", list, err)
	}
}

// TestAssignmentAuthorization: members only take what went to them and read
// their own results; only a class's owner and editor members manage.
func TestAssignmentAuthorization(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-auth")
	ctx := context.Background()
	now := time.Now().UTC()
	due := now.Add(time.Hour)
	form := f.form(t, due)
	form.AssignAll, form.Assignees = false, []string{f.viewer}
	created, err := f.s.CreateAssignment(ctx, f.editor, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	notFound := func(name string, err error) {
		t.Helper()
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s: err = %v", name, err)
		}
	}
	_, err = f.s.CreateAssignment(ctx, f.viewer, f.ws.ID, f.form(t, due), now)
	if err == nil {
		t.Fatal("a viewer created an assignment")
	}
	_, err = f.s.UpdateAssignment(ctx, f.viewer, created.ID, form, now)
	if err == nil {
		t.Fatal("a viewer changed an assignment")
	}
	if err := f.s.DeleteAssignment(ctx, f.viewer, created.ID); err == nil {
		t.Fatal("a viewer deleted an assignment")
	}
	_, err = f.s.SetAssignmentClosed(ctx, f.viewer, created.ID, true, now)
	if err == nil {
		t.Fatal("a viewer closed an assignment")
	}
	_, err = f.s.GetAssignmentReport(ctx, f.viewer, created.ID, now)
	notFound("viewer report", err)

	// Not given to them.
	_, err = f.s.GetAssignment(ctx, f.other, created.ID, now)
	notFound("other member reads", err)
	_, err = f.s.StartAssignment(ctx, f.other, created.ID, now)
	notFound("other member starts", err)

	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.s.GetAssignmentAttempt(ctx, f.other, run.ID, now)
	notFound("other member reads the attempt", err)
	_, err = f.s.GetAssignmentAttempt(ctx, f.editor, run.ID, now)
	notFound("staff read a running attempt", err)
	notFound("other member saves", f.s.SaveAssignmentAnswers(ctx, f.other, run.ID, map[string]any{}, now))
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{"p3": "x"}, now); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.GetAssignmentAttempt(ctx, f.other, run.ID, now)
	notFound("other member reads the result", err)
	if _, err := f.s.GetAssignmentAttempt(ctx, f.user, run.ID, now); err != nil {
		t.Fatalf("the owner reads the result: %v", err)
	}
	_, err = f.s.MarkAssignmentAnswer(ctx, f.viewer, run.ID, AssignmentMark{QuestionID: "q3", Parts: []AssignmentPartMark{{PartID: "p3", Items: []float64{3, 0}}}}, now)
	if err == nil {
		t.Fatal("a member marked their own answer")
	}

	// A share-role editor edits content but is not staff here.
	sharer := newBlobTestUser(t, f.s, "assignment-auth-sharer")
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public', share_role='editor' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.GetAssignmentReport(ctx, sharer, created.ID, now)
	notFound("share-role editor's report", err)
	_, err = f.s.CreateAssignment(ctx, sharer, f.ws.ID, f.form(t, due), now)
	notFound("share-role editor creates", err)

	// A personal workspace hides them, deleting nothing.
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='personal' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	_, err = f.s.ListAssignments(ctx, f.user, f.ws.ID, now)
	notFound("personal list", err)
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='class' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	list, err := f.s.ListAssignments(ctx, f.user, f.ws.ID, now)
	if err != nil || len(list.Items) != 1 {
		t.Fatalf("back to a class: %+v, err %v", list, err)
	}
}

// TestAssignmentAssignTo: all members covers viewers and later joiners; named
// lists and "You" reach only those.
func TestAssignmentAssignTo(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-to")
	ctx := context.Background()
	now := time.Now().UTC()
	all, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	later := newBlobTestUser(t, f.s, "assignment-to-later")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, f.ws.ID, later); err != nil {
		t.Fatal(err)
	}
	got, err := f.s.GetAssignment(ctx, later, all.ID, now)
	if err != nil || got.Mine == nil {
		t.Fatalf("a later joiner = %+v, err %v", got, err)
	}
	staff, err := f.s.GetAssignment(ctx, f.user, all.ID, now)
	if err != nil || staff.Manage.Assigned != 3 || staff.Mine != nil {
		t.Fatalf("all members = %+v manage %+v, err %v", staff, staff.Manage, err)
	}

	form := AssignmentForm{Kind: AssignmentUnmarked, Title: "Read it", Attempts: 1, AssignAll: false, Assignees: []string{f.viewer, f.user}, Files: []AssignmentFileRef{}}
	named, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if named.Mine == nil || named.Manage.Assigned != 2 {
		t.Fatalf("named = %+v", named)
	}
	if _, err := f.s.GetAssignment(ctx, f.other, named.ID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("someone not named read it: %v", err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, named.ID, true, now); err != nil {
		t.Fatal(err)
	}
	ticked, err := f.s.GetAssignment(ctx, f.viewer, named.ID, now)
	if err != nil || !ticked.Mine.Done {
		t.Fatalf("ticked = %+v, err %v", ticked.Mine, err)
	}
	report, err := f.s.GetAssignmentReport(ctx, f.user, named.ID, now)
	if err != nil || len(report.Members) != 2 {
		t.Fatalf("report = %+v, err %v", report, err)
	}
}

// TestAssignmentLateMissingAndTimeOut: after the due date a submission is late
// until the owner closes it; the server submits what was saved at time-out and
// at closing.
func TestAssignmentLateMissingAndTimeOut(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-late")
	ctx := context.Background()
	now := time.Now().UTC()
	limit := 10
	form := f.form(t, now.Add(time.Hour))
	form.TimeLimitMin = &limit
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.s.SaveAssignmentAnswers(ctx, f.viewer, run.ID, map[string]any{"p2": "osmosis"}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	// Time ran out: a late save submits what was there and refuses.
	late := now.Add(11 * time.Minute)
	if err := f.s.SaveAssignmentAnswers(ctx, f.viewer, run.ID, map[string]any{"p2": "changed"}, late); !errors.Is(err, ErrAttemptFinished) {
		t.Fatalf("a save past the time = %v", err)
	}
	result, err := f.s.GetAssignmentAttempt(ctx, f.viewer, run.ID, late)
	if err != nil || !result.AutoSubmitted || result.Correct != 2 {
		t.Fatalf("timed out = %+v, err %v", result, err)
	}

	// Past due the other member is missing, then submits late.
	pastDue := now.Add(2 * time.Hour)
	report, err := f.s.GetAssignmentReport(ctx, f.user, created.ID, pastDue)
	if err != nil {
		t.Fatal(err)
	}
	missing := 0
	for _, m := range report.Members {
		if m.Missing {
			missing++
		}
	}
	if missing != 1 {
		t.Fatalf("missing = %d in %+v", missing, report.Members)
	}
	second, err := f.s.StartAssignment(ctx, f.other, created.ID, pastDue)
	if err != nil {
		t.Fatal(err)
	}
	done, err := f.s.SubmitAssignmentAttempt(ctx, f.other, second.ID, map[string]any{}, pastDue)
	if err != nil || !done.Late {
		t.Fatalf("late submission = %+v, err %v", done, err)
	}

	// Closed: no more starts, and the sweep submits a running attempt.
	third := newBlobTestUser(t, f.s, "assignment-late-third")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, f.ws.ID, third); err != nil {
		t.Fatal(err)
	}
	running, err := f.s.StartAssignment(ctx, third, created.ID, pastDue)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, true, pastDue); err != nil {
		t.Fatal(err)
	}
	finished, _, err := f.s.SweepAssignments(ctx, 50, pastDue)
	if err != nil || finished == 0 {
		t.Fatalf("sweep = %d, err %v", finished, err)
	}
	swept, err := f.s.GetAssignmentAttempt(ctx, third, running.ID, pastDue)
	if err != nil || swept.Status != "submitted" || !swept.AutoSubmitted {
		t.Fatalf("swept = %+v, err %v", swept, err)
	}
	fourth := newBlobTestUser(t, f.s, "assignment-late-fourth")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, f.ws.ID, fourth); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.StartAssignment(ctx, fourth, created.ID, pastDue); !errors.Is(err, ErrAssignmentClosed) {
		t.Fatalf("a start after closing = %v", err)
	}
}

// TestAssignmentBecomesPractice: its due date alone releases nothing; closing by
// hand shows its quiz in Practice with a note and joins marked answers to reviews,
// the owner can hide it again, and another open assignment on the same quiz holds
// it back (Epo 2026-11-04).
func TestAssignmentBecomesPractice(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-practice")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	due := now.Add(time.Hour)
	first, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, due), now)
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(3*time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, first.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{"p1": []any{float64(1)}, "p3": "x"}, now); err != nil {
		t.Fatal(err)
	}
	listed := func(at time.Time) (bool, *time.Time) {
		t.Helper()
		practice, err := f.s.WorkspacePractice(ctx, f.viewer, f.ws.ID, false, at)
		if err != nil {
			t.Fatal(err)
		}
		for _, q := range practice.Quizzes {
			if q.ID == f.quiz.ID {
				return true, q.AssignmentClosedAt
			}
		}
		return false, nil
	}
	// Both past their due dates, with late work still open: nothing is practice.
	later := now.Add(4 * time.Hour)
	if _, released, err := f.s.SweepAssignments(ctx, 50, later); err != nil || released != 0 {
		t.Fatalf("a due date released %d, err %v", released, err)
	}
	if shown, _ := listed(later); shown {
		t.Fatal("the quiz showed at its due date")
	}
	got, err := f.s.GetAssignment(ctx, f.user, first.ID, later)
	if err != nil || got.Closed || got.ClosedAt != nil {
		t.Fatalf("past due = closed %v at %v, err %v", got.Closed, got.ClosedAt, err)
	}

	// Closing the first releases it, but the second still uses the quiz.
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, first.ID, true, later); err != nil {
		t.Fatal(err)
	}
	if _, released, err := f.s.SweepAssignments(ctx, 50, later); err != nil || released != 1 {
		t.Fatalf("sweep: released %d, err %v", released, err)
	}
	if shown, _ := listed(later); shown {
		t.Fatal("the quiz showed while another open assignment uses it")
	}
	if _, err := f.s.SetAssignmentClosed(ctx, f.editor, second.ID, true, later); err != nil {
		t.Fatal(err)
	}
	if _, released, err := f.s.SweepAssignments(ctx, 50, later); err != nil || released != 1 {
		t.Fatalf("second sweep: released %d, err %v", released, err)
	}
	shown, closedAt := listed(later)
	if !shown || closedAt == nil || !closedAt.Equal(later) {
		t.Fatalf("after closing: shown %v, note %v", shown, closedAt)
	}
	var rated int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM review_states WHERE user_id=$1 AND material_id=$2`, f.viewer, f.quiz.ID).Scan(&rated); err != nil {
		t.Fatal(err)
	}
	if rated != 1 {
		t.Fatalf("rated %d questions, want the marked answered one (q1)", rated)
	}
	got, err = f.s.GetAssignment(ctx, f.viewer, first.ID, later)
	if err != nil || got.PracticeQuizID == nil {
		t.Fatalf("Practise again = %+v, err %v", got.PracticeQuizID, err)
	}
	// Hidden again by the owner, the sweep leaves it hidden.
	if _, err := f.s.pool.Exec(ctx, `UPDATE materials SET hidden=true WHERE id=$1`, f.quiz.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.s.SweepAssignments(ctx, 50, later.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if shown, _ := listed(later); shown {
		t.Fatal("the sweep showed a quiz the owner hid again")
	}
}

// TestAssignmentNoLateClosesAtDue: with No late submissions it closes itself at
// the due date: a running attempt is submitted as saved, unpenalised and not
// late, nothing more is taken, and its quiz becomes practice.
func TestAssignmentNoLateClosesAtDue(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-no-late")
	ctx := context.Background()
	// In the past, as the lists read the database's clock for an open assignment.
	now := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Microsecond)
	due := now.Add(time.Hour)
	form := f.form(t, due)
	form.NoLate = true
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if created.Closed || created.ClosedAt != nil || !created.NoLate {
		t.Fatalf("before its due date = %+v", created)
	}
	if _, released, err := f.s.SweepAssignments(ctx, 50, now); err != nil || released != 0 {
		t.Fatalf("released %d before the due date, err %v", released, err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.s.SaveAssignmentAnswers(ctx, f.viewer, run.ID, map[string]any{"p2": "osmosis"}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}

	// A submit landing inside the grace still takes what the page sends.
	third := newBlobTestUser(t, f.s, "assignment-no-late-third")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, f.ws.ID, third); err != nil {
		t.Fatal(err)
	}
	almost, err := f.s.StartAssignment(ctx, third, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	inGrace, err := f.s.SubmitAssignmentAttempt(ctx, third, almost.ID, map[string]any{"p2": "osmosis"}, due.Add(5*time.Second))
	if err != nil || inGrace.AutoSubmitted || inGrace.Late || inGrace.Correct != 2 {
		t.Fatalf("a submit in the grace = %+v, err %v", inGrace, err)
	}

	past := due.Add(time.Minute)
	got, err := f.s.GetAssignment(ctx, f.user, created.ID, past)
	if err != nil || !got.Closed || got.ClosedAt == nil || !got.ClosedAt.Equal(due) {
		t.Fatalf("past its due date = closed %v at %v, err %v", got.Closed, got.ClosedAt, err)
	}
	if _, err := f.s.StartAssignment(ctx, f.other, created.ID, past); !errors.Is(err, ErrAssignmentClosed) {
		t.Fatalf("a start past the due date = %v", err)
	}
	if err := f.s.SaveAssignmentAnswers(ctx, f.viewer, run.ID, map[string]any{"p2": "changed"}, past); !errors.Is(err, ErrAttemptFinished) {
		t.Fatalf("a save past the due date = %v", err)
	}
	result, err := f.s.GetAssignmentAttempt(ctx, f.viewer, run.ID, past)
	if err != nil || !result.AutoSubmitted || result.Late || result.LatePenaltyPct != 0 || result.Mark != 2 {
		t.Fatalf("submitted for them = %+v, err %v", result, err)
	}

	if _, released, err := f.s.SweepAssignments(ctx, 50, past); err != nil || released != 1 {
		t.Fatalf("sweep: released %d, err %v", released, err)
	}
	practice, err := f.s.WorkspacePractice(ctx, f.viewer, f.ws.ID, false, past)
	if err != nil {
		t.Fatal(err)
	}
	var note *time.Time
	for _, q := range practice.Quizzes {
		if q.ID == f.quiz.ID {
			note = q.AssignmentClosedAt
		}
	}
	if note == nil || !note.Equal(due) {
		t.Fatalf("the Practice note = %v, want the due date", note)
	}
}

// TestAssignmentNoLateSweepSubmitsRunningAttempts: the server submits for a closed
// tab, as at a timer's zero.
func TestAssignmentNoLateSweepSubmitsRunningAttempts(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-no-late-sweep")
	ctx := context.Background()
	now := time.Now().UTC()
	due := now.Add(time.Hour)
	form := f.form(t, due)
	form.NoLate = true
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.s.SaveAssignmentAnswers(ctx, f.viewer, run.ID, map[string]any{"p2": "osmosis"}, now); err != nil {
		t.Fatal(err)
	}
	if finished, _, err := f.s.SweepAssignments(ctx, 50, due.Add(time.Second)); err != nil || finished != 0 {
		t.Fatalf("swept %d inside the grace, err %v", finished, err)
	}
	past := due.Add(time.Minute)
	if finished, _, err := f.s.SweepAssignments(ctx, 50, past); err != nil || finished == 0 {
		t.Fatalf("swept %d past the grace, err %v", finished, err)
	}
	var submitted bool
	if err := f.s.pool.QueryRow(ctx, `SELECT submitted_at IS NOT NULL AND auto_submitted FROM attempts WHERE id=$1`, run.ID).Scan(&submitted); err != nil {
		t.Fatal(err)
	}
	if !submitted {
		t.Fatal("the sweep left a running attempt open past a No late submissions due date")
	}
}

// TestAssignmentLatePenalty: off, late work stays open and loses its penalty off
// the submission's mark, which holds when an open part is marked later and is what
// the member, the report and the average read. Work on time loses nothing.
func TestAssignmentLatePenalty(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-penalty")
	ctx := context.Background()
	now := time.Now().UTC()
	due := now.Add(time.Hour)
	form := f.form(t, due)
	form.LatePenaltyPct = 20
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	onTime, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	inTime, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, onTime.ID, map[string]any{"p2": "osmosis"}, now)
	if err != nil || inTime.Late || inTime.LatePenaltyPct != 0 || inTime.Mark != 2 {
		t.Fatalf("on time = %+v, err %v", inTime, err)
	}

	past := due.Add(time.Hour)
	if got, err := f.s.GetAssignment(ctx, f.other, created.ID, past); err != nil || got.Closed || got.Mine == nil || !got.Mine.Missing {
		t.Fatalf("past due, open = %+v, err %v", got, err)
	}
	late, err := f.s.StartAssignment(ctx, f.other, created.ID, past)
	if err != nil {
		t.Fatal(err)
	}
	done, err := f.s.SubmitAssignmentAttempt(ctx, f.other, late.ID, map[string]any{
		"p1": []any{float64(1)}, "p2": "osmosis", "p3": "Water moves in",
	}, past)
	if err != nil {
		t.Fatal(err)
	}
	if !done.Late || done.LatePenaltyPct != 20 || done.Correct != 3 || done.Mark != 2.4 {
		t.Fatalf("late = %+v", done)
	}
	marked, err := f.s.MarkAssignmentAnswer(ctx, f.editor, late.ID, AssignmentMark{
		QuestionID: "q3", Parts: []AssignmentPartMark{{PartID: "p3", Items: []float64{2, 1}}},
	}, past)
	if err != nil {
		t.Fatal(err)
	}
	if marked.Correct != 6 || marked.Mark != 4.8 || marked.LatePenaltyPct != 20 {
		t.Fatalf("after marking the open part = %+v", marked)
	}
	mine, err := f.s.GetAssignment(ctx, f.other, created.ID, past)
	if err != nil || mine.Mine == nil || mine.Mine.Mark == nil || *mine.Mine.Mark != 4.8 || mine.Mine.LatePenaltyPct != 20 {
		t.Fatalf("a member's row = %+v, err %v", mine.Mine, err)
	}
	report, err := f.s.GetAssignmentReport(ctx, f.user, created.ID, past)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range report.Members {
		switch row.UserID {
		case f.other:
			if !row.Late || row.LatePenaltyPct != 20 || row.Mark == nil || *row.Mark != 4.8 {
				t.Fatalf("a late row = %+v", row)
			}
		case f.viewer:
			if row.Late || row.LatePenaltyPct != 0 || row.Mark == nil || *row.Mark != 2 {
				t.Fatalf("an on-time row = %+v", row)
			}
		}
	}

	// The average reads the marks after the penalty, once five have submitted.
	for i := 0; i < 3; i++ {
		user := newBlobTestUser(t, f.s, "assignment-penalty-"+uid("m"))
		if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, f.ws.ID, user); err != nil {
			t.Fatal(err)
		}
		run, err := f.s.StartAssignment(ctx, user, created.ID, now)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.s.SubmitAssignmentAttempt(ctx, user, run.ID, map[string]any{"p2": "osmosis"}, now); err != nil {
			t.Fatal(err)
		}
	}
	got, err := f.s.GetAssignment(ctx, f.user, created.ID, past)
	if err != nil || got.Manage == nil || got.Manage.Average == nil {
		t.Fatalf("average = %+v, err %v", got.Manage, err)
	}
	// Four on time at 2 of 6 and one late at 4.8 of 6.
	want := (4*(2.0/6) + 4.8/6) / 5
	if diff := *got.Manage.Average - want; diff > 0.0001 || diff < -0.0001 {
		t.Fatalf("average = %v, want %v", *got.Manage.Average, want)
	}

	// A higher penalty, set after the work came in, reads through.
	form.LatePenaltyPct = 50
	if _, err := f.s.UpdateAssignment(ctx, f.user, created.ID, form, past); err != nil {
		t.Fatal(err)
	}
	again, err := f.s.GetAssignmentAttempt(ctx, f.other, late.ID, past)
	if err != nil || again.Mark != 3 || again.LatePenaltyPct != 50 {
		t.Fatalf("after changing the penalty = %+v, err %v", again, err)
	}
}

// TestAssignmentFrozenCopyAndDelete: a draft freezes at publishing, and deleting
// takes its attempts and gives the quiz back.
func TestAssignmentFrozenCopyAndDelete(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-frozen")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	form := f.form(t, now.Add(time.Hour))
	form.Draft, form.Questions = true, nil
	draft, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if !draft.Draft || draft.Questions != 0 {
		t.Fatalf("draft = %+v", draft)
	}
	if _, err := f.s.GetAssignment(ctx, f.viewer, draft.ID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a member read a draft: %v", err)
	}
	published, err := f.s.PublishAssignment(ctx, f.user, draft.ID, frozenFixture(t), now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if published.Draft || published.Questions != 3 || !published.PostedAt.Equal(now.Add(time.Minute)) {
		t.Fatalf("published = %+v", published)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, draft.ID, now.Add(time.Minute))
	if err != nil || len(run.Questions) != 3 {
		t.Fatalf("run = %+v, err %v", run, err)
	}
	if err := f.s.DeleteAssignment(ctx, f.user, draft.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.MaterialEffectiveRole(ctx, f.viewer, f.quiz.ID); err != nil {
		t.Fatalf("deleting left the quiz refused: %v", err)
	}
	var left int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM attempts WHERE id=$1`, run.ID).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 0 {
		t.Fatal("deleting left its attempts")
	}
}

// TestAssignmentFrozenImages: the copy's images are its own rows, charged to who
// published, so deleting the quiz leaves them; a workspace clone leaves them out;
// deleting the assignment deletes them.
func TestAssignmentFrozenImages(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-images")
	ctx := context.Background()
	now := time.Now().UTC()
	assetID := uid("asset")
	questions := json.RawMessage(`[{"id":"q1","stem":[{"type":"image","image":{"assetId":"` + assetID + `"},"width":10,"height":10,"description":"Figure"}],"layout":"paper","labels":"letters","parts":[{"id":"p1","blocks":[{"type":"text","text":"Pick"}],"answer":{"type":"mcq","options":["a","b"],"correct":[1]},"marks":1,"solution":[]}]}]`)
	quiz, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: "With figure", WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Questions: questions, Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	objectPath := "editor-assets/assignment-images/" + uid("blob")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO editor_assets
		(id, workspace_id, material_id, user_id, created_by, name, purpose, object_path, content_type, size_bytes, status, completed_at)
		VALUES ($1,$2,$3,$4,$4,'figure.png','image',$5,'image/png',10,'ready',now())`, assetID, f.ws.ID, quiz.ID, f.user, objectPath); err != nil {
		t.Fatal(err)
	}
	var qs []map[string]any
	if err := json.Unmarshal(questions, &qs); err != nil {
		t.Fatal(err)
	}
	form := f.form(t, now.Add(time.Hour))
	form.QuizID, form.Questions = quiz.ID, qs
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	var copied string
	if err := f.s.pool.QueryRow(ctx, `SELECT id FROM editor_assets WHERE assignment_id=$1`, created.ID).Scan(&copied); err != nil {
		t.Fatalf("no frozen image row: %v", err)
	}
	if copied == assetID {
		t.Fatal("the copy names the quiz's own image")
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if raw, _ := json.Marshal(run.Questions); !strings.Contains(string(raw), copied) || strings.Contains(string(raw), assetID) {
		t.Fatalf("the running copy's images = %s", raw)
	}
	if len(run.RemovedAssetIDs) != 0 {
		t.Fatalf("removed = %v", run.RemovedAssetIDs)
	}

	clone, err := f.s.CloneWorkspace(ctx, f.user, f.ws.ID, WorkspaceCreate{Name: "Clone", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	var cloned int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM editor_assets WHERE workspace_id=$1`, clone.ID).Scan(&cloned); err != nil {
		t.Fatal(err)
	}
	if cloned != 1 {
		t.Fatalf("a clone holds %d images, want the quiz's one", cloned)
	}

	if err := f.s.DeleteAssignment(ctx, f.user, created.ID); err != nil {
		t.Fatal(err)
	}
	var left int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM editor_assets WHERE id=$1`, copied).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 0 {
		t.Fatal("deleting the assignment left its frozen image")
	}
}

// assignedRow reads the quiz's row as userID lists it, and whether it lists.
func (f assignmentFixture) assignedRow(t *testing.T, userID string) (MaterialRef, bool) {
	t.Helper()
	refs, err := f.s.ListMaterialRefs(context.Background(), userID, f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ref := range refs {
		if ref.ID == f.quiz.ID {
			return ref, true
		}
	}
	return MaterialRef{}, false
}

func (f assignmentFixture) inPractice(t *testing.T, userID string, now time.Time) bool {
	t.Helper()
	practice, err := f.s.WorkspacePractice(context.Background(), userID, f.ws.ID, false, now)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range practice.Quizzes {
		if q.ID == f.quiz.ID {
			return true
		}
	}
	return false
}

// TestAssignedVisibleQuizIsOneRow: a draft changes nothing; published from a
// visible quiz it stays visible, with the icon for its assignee, whose row opens
// the assignment, whose quiz is refused and off Practice; the member it did not
// go to keeps a normal quiz; at close it is a normal quiz for the assignee too.
func TestAssignedVisibleQuizIsOneRow(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-one-row")
	ctx := context.Background()
	now := time.Now().UTC()
	form := f.form(t, now.Add(time.Hour))
	form.AssignAll, form.Assignees = false, []string{f.viewer}
	form.Draft, form.Questions = true, nil
	draft, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if row, ok := f.assignedRow(t, f.viewer); !ok || row.Assigned || row.AssignmentID != "" || row.Hidden {
		t.Fatalf("under a draft the viewer's row = %+v, listed %v", row, ok)
	}
	if !f.inPractice(t, f.viewer, now) {
		t.Fatal("a draft took the quiz off Practice")
	}
	if _, err := f.s.PublishAssignment(ctx, f.user, draft.ID, frozenFixture(t), now); err != nil {
		t.Fatal(err)
	}

	if row, ok := f.assignedRow(t, f.viewer); !ok || !row.Assigned || row.AssignmentID != draft.ID || row.Hidden {
		t.Fatalf("the assignee's row = %+v, listed %v", row, ok)
	}
	if _, err := f.s.MaterialEffectiveRole(ctx, f.viewer, f.quiz.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the assignee read the quiz: %v", err)
	}
	if f.inPractice(t, f.viewer, now) {
		t.Fatal("an assigned quiz on its assignee's Practice")
	}
	if row, ok := f.assignedRow(t, f.other); !ok || row.Assigned || row.AssignmentID != "" {
		t.Fatalf("the unassigned member's row = %+v, listed %v", row, ok)
	}
	if _, err := f.s.MaterialEffectiveRole(ctx, f.other, f.quiz.ID); err != nil {
		t.Fatalf("the unassigned member lost the quiz: %v", err)
	}
	if !f.inPractice(t, f.other, now) {
		t.Fatal("the quiz left an unassigned member's Practice")
	}
	for _, staff := range []string{f.user, f.editor} {
		if row, ok := f.assignedRow(t, staff); !ok || !row.Assigned || row.AssignmentID != "" {
			t.Fatalf("staff's row = %+v, listed %v", row, ok)
		}
		if _, err := f.s.MaterialEffectiveRole(ctx, staff, f.quiz.ID); err != nil {
			t.Fatalf("staff lost the quiz: %v", err)
		}
	}

	// The earliest due of two opens first.
	sooner := f.form(t, now.Add(30*time.Minute))
	first, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, sooner, now)
	if err != nil {
		t.Fatal(err)
	}
	if row, _ := f.assignedRow(t, f.viewer); row.AssignmentID != first.ID {
		t.Fatalf("with two open the row opens %s, want %s", row.AssignmentID, first.ID)
	}
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, first.ID, true, now); err != nil {
		t.Fatal(err)
	}
	if row, _ := f.assignedRow(t, f.viewer); row.AssignmentID != draft.ID {
		t.Fatalf("with one left the row opens %s, want %s", row.AssignmentID, draft.ID)
	}

	if _, err := f.s.SetAssignmentClosed(ctx, f.user, draft.ID, true, now); err != nil {
		t.Fatal(err)
	}
	if row, ok := f.assignedRow(t, f.viewer); !ok || row.Assigned || row.AssignmentID != "" {
		t.Fatalf("after closing the row = %+v, listed %v", row, ok)
	}
	if _, err := f.s.MaterialEffectiveRole(ctx, f.viewer, f.quiz.ID); err != nil {
		t.Fatalf("after closing the quiz is refused: %v", err)
	}
	if !f.inPractice(t, f.viewer, now) {
		t.Fatal("after closing the quiz is not on Practice")
	}
}

// TestAssignedHiddenQuizOpensToItsAssignees: published from a hidden quiz it lists
// for the assignee alone among members, across workspaces too; deleting leaves it
// hidden; closing makes it a normal visible quiz.
func TestAssignedHiddenQuizOpensToItsAssignees(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-hidden")
	ctx := context.Background()
	now := time.Now().UTC()
	if _, err := f.s.pool.Exec(ctx, `UPDATE materials SET hidden=true WHERE id=$1`, f.quiz.ID); err != nil {
		t.Fatal(err)
	}
	form := f.form(t, now.Add(time.Hour))
	form.AssignAll, form.Assignees = false, []string{f.viewer}
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if row, ok := f.assignedRow(t, f.viewer); !ok || row.AssignmentID != created.ID || row.Hidden {
		t.Fatalf("the assignee's row = %+v, listed %v", row, ok)
	}
	if row, ok := f.assignedRow(t, f.editor); !ok || !row.Assigned || !row.Hidden {
		t.Fatalf("staff's row = %+v, listed %v", row, ok)
	}
	page, err := f.s.ListOwnedMaterials(ctx, f.viewer, MaterialListFilter{Member: true, IDs: []string{f.quiz.ID}})
	if err != nil || len(page.Items) != 1 || page.Items[0].AssignmentID != created.ID || page.Items[0].Hidden || page.Items[0].Preview != nil {
		t.Fatalf("across workspaces = %+v, err %v", page.Items, err)
	}
	if _, ok := f.assignedRow(t, f.other); ok {
		t.Fatal("the hidden quiz lists for a member it did not go to")
	}

	// Undo: as it was.
	if err := f.s.DeleteAssignment(ctx, f.user, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.assignedRow(t, f.viewer); ok {
		t.Fatal("deleting showed a quiz that was hidden before")
	}

	created, err = f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, true, now); err != nil {
		t.Fatal(err)
	}
	if _, released, err := f.s.SweepAssignments(ctx, 50, now); err != nil || released != 1 {
		t.Fatalf("sweep: released %d, err %v", released, err)
	}
	if row, ok := f.assignedRow(t, f.other); !ok || row.Hidden {
		t.Fatalf("after closing another member's row = %+v, listed %v", row, ok)
	}
}

// TestClassViewersCloneNothing: a viewer member of a class copies neither it nor
// anything in it, while the same member of a personal workspace does, and staff
// always.
func TestClassViewersCloneNothing(t *testing.T) {
	f := newAssignmentFixture(t, "class-clone")
	ctx := context.Background()
	file, err := f.s.createReadyFile(ctx, f.ws.ID, f.user, "notes.md", "md", nil, "", 10, "sources/"+uid("cc"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CloneWorkspace(ctx, f.viewer, f.ws.ID, WorkspaceCreate{Name: "Copy"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("workspace clone = %v, want ErrForbidden", err)
	}
	if _, err := f.s.CloneMaterial(ctx, f.viewer, f.quiz.ID, CloneTarget{Name: "Copy"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("quiz clone = %v, want ErrForbidden", err)
	}
	if _, _, err := f.s.CloneFile(ctx, f.viewer, file.ID, CloneTarget{Name: "Copy"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("file clone = %v, want ErrForbidden", err)
	}
	if rights := fileCloneRight(t, f.s, f.viewer, file.ID); rights {
		t.Fatal("a class viewer's file row offers Clone")
	}
	if rights := fileCloneRight(t, f.s, f.editor, file.ID); !rights {
		t.Fatal("a teaching assistant's file row does not offer Clone")
	}
	copied, err := f.s.CloneWorkspace(ctx, f.editor, f.ws.ID, WorkspaceCreate{Name: "Staff copy"})
	if err != nil || copied.Kind != WorkspaceClass {
		t.Fatalf("a teaching assistant's clone = %+v, err %v", copied, err)
	}

	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='personal' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CloneMaterial(ctx, f.viewer, f.quiz.ID, CloneTarget{Name: "Copy"}); err != nil {
		t.Fatalf("a personal workspace's viewer clones: %v", err)
	}
	if rights := fileCloneRight(t, f.s, f.viewer, file.ID); !rights {
		t.Fatal("a personal viewer's file row does not offer Clone")
	}
}

func fileCloneRight(t *testing.T, s *Store, userID, fileID string) bool {
	t.Helper()
	page, err := s.ListOwnedFiles(context.Background(), userID, FileListFilter{All: true, Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range page.Items {
		if file.ID == fileID && file.Rights != nil {
			return file.Rights.Clone
		}
	}
	t.Fatalf("%s does not list %s", userID, fileID)
	return false
}

// TestAssignedQuizClonesForStaffAlone: while an assignment is open only the owner
// and teaching assistants copy its quiz; a link editor's item clone is refused and
// their workspace clone leaves it out, counted; after closing the normal rules are
// back.
func TestAssignedQuizClonesForStaffAlone(t *testing.T) {
	f := newAssignmentFixture(t, "assigned-clone")
	ctx := context.Background()
	now := time.Now().UTC()
	note, err := f.s.CreateMaterial(ctx, Material{CreatedBy: f.user, WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name,
		Kind: "note", Title: "Kept note", Content: materialTestContent(t, "body")})
	if err != nil {
		t.Fatal(err)
	}
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CloneMaterial(ctx, f.editor, f.quiz.ID, CloneTarget{Name: "Staff copy"}); err != nil {
		t.Fatalf("a teaching assistant's clone: %v", err)
	}
	staffCopy, err := f.s.CloneWorkspace(ctx, f.user, f.ws.ID, WorkspaceCreate{Name: "Owner copy"})
	if err != nil {
		t.Fatal(err)
	}
	titles := func(wsID string) map[string]bool {
		t.Helper()
		refs, err := f.s.ListMaterialRefs(ctx, f.user, wsID)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]bool{}
		for _, ref := range refs {
			out[ref.Title] = true
		}
		return out
	}
	if !titles(staffCopy.ID)[f.quiz.Name] {
		t.Fatal("the owner's clone left the assigned quiz out")
	}

	linkEditor := newBlobTestUser(t, f.s, "assigned-clone-link")
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET privacy='link', share_role='editor' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	redeemLink(t, f.s, linkEditor, f.ws.ID)
	if _, err := f.s.CloneMaterial(ctx, linkEditor, f.quiz.ID, CloneTarget{Name: "Copy"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a link editor's quiz clone = %v, want ErrForbidden", err)
	}
	if _, err := f.s.CloneMaterial(ctx, linkEditor, note.ID, CloneTarget{Name: "Note copy"}); err != nil {
		t.Fatalf("a link editor's note clone: %v", err)
	}
	copied, _, skipped, err := f.s.CloneWorkspaceThumbnails(ctx, linkEditor, f.ws.ID, WorkspaceCreate{Name: "Link copy"})
	if err != nil {
		t.Fatal(err)
	}
	inCopy, err := f.s.ListMaterialRefs(ctx, linkEditor, copied.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(inCopy) != 1 || inCopy[0].Title != "Kept note" || skipped != 1 || copied.Kind != WorkspacePersonal {
		t.Fatalf("the link editor's clone holds %+v, skipped %d, kind %s", inCopy, skipped, copied.Kind)
	}

	if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, true, now); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CloneMaterial(ctx, linkEditor, f.quiz.ID, CloneTarget{Name: "After closing"}); err != nil {
		t.Fatalf("after closing a link editor's clone: %v", err)
	}
}

// TestSharingNoticeIsToldOnce: a class's viewer member is told once, with its
// owner; staff, a stranger and a personal workspace's member never.
func TestSharingNoticeIsToldOnce(t *testing.T) {
	f := newAssignmentFixture(t, "sharing-notice")
	ctx := context.Background()
	stranger := newBlobTestUser(t, f.s, "sharing-notice-stranger")
	if _, err := f.s.pool.Exec(ctx, `UPDATE users SET name='Ms Wong', avatar_url='https://example.com/wong.png' WHERE id=$1`, f.user); err != nil {
		t.Fatal(err)
	}
	due := func(userID string) bool {
		t.Helper()
		got, err := f.s.SharingNoticeFor(ctx, userID, f.ws.ID)
		if err != nil {
			t.Fatal(err)
		}
		return got.Due
	}
	if !due(f.viewer) || !due(f.other) {
		t.Fatal("a class's viewer members are not due the notice")
	}
	notice, err := f.s.SharingNoticeFor(ctx, f.viewer, f.ws.ID)
	if err != nil || notice.Owner == nil || notice.Owner.Name != "Ms Wong" || notice.Owner.AvatarURL != "https://example.com/wong.png" {
		t.Fatalf("the notice = %+v, err %v", notice, err)
	}
	if due(f.user) || due(f.editor) || due(stranger) {
		t.Fatal("the notice is due someone who shares nothing")
	}
	if err := f.s.MarkSharingNoticeSeen(ctx, f.viewer, f.ws.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	if due(f.viewer) || !due(f.other) {
		t.Fatal("telling one member did not tell only them")
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='personal' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	if due(f.other) {
		t.Fatal("a personal workspace's member is due the notice")
	}
}

// TestAssignmentSweepPassesOverABadRow: an attempt that cannot submit and an
// assignment that cannot release leave the others' to go through.
func TestAssignmentSweepPassesOverABadRow(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-sweep-bad")
	ctx := context.Background()
	now := time.Now().UTC()
	open := func() (Assignment, AssignmentAttempt) {
		t.Helper()
		created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now)
		if err != nil {
			t.Fatal(err)
		}
		run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
		if err != nil {
			t.Fatal(err)
		}
		return created, run
	}
	bad, badRun := open()
	good, goodRun := open()
	t.Cleanup(func() { _, _ = f.s.pool.Exec(ctx, `DELETE FROM assignments WHERE id=$1`, bad.ID) })
	submitted, err := f.s.StartAssignment(ctx, f.other, bad.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.other, submitted.ID, map[string]any{}, now); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{bad.ID, good.ID} {
		if _, err := f.s.SetAssignmentClosed(ctx, f.user, id, true, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE assignments SET questions='{"bad":true}' WHERE id=$1`, bad.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE attempts SET questions='{"bad":true}' WHERE id=$1`, submitted.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.s.SweepAssignments(ctx, 200, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	finished := func(attemptID string) bool {
		t.Helper()
		var done bool
		if err := f.s.pool.QueryRow(ctx, `SELECT submitted_at IS NOT NULL FROM attempts WHERE id=$1`, attemptID).Scan(&done); err != nil {
			t.Fatal(err)
		}
		return done
	}
	released := func(id string) bool {
		t.Helper()
		var done bool
		if err := f.s.pool.QueryRow(ctx, `SELECT released_at IS NOT NULL FROM assignments WHERE id=$1`, id).Scan(&done); err != nil {
			t.Fatal(err)
		}
		return done
	}
	if finished(badRun.ID) || released(bad.ID) {
		t.Fatal("the bad row went through")
	}
	if !finished(goodRun.ID) || !released(good.ID) {
		t.Fatalf("the good row stayed: submitted %v, released %v", finished(goodRun.ID), released(good.ID))
	}
}

// TestDepartedAssigneeLeavesTheForm: a name who left the workspace is off the
// assignment's list, so the form saves what it was given.
func TestDepartedAssigneeLeavesTheForm(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-departed")
	ctx := context.Background()
	now := time.Now().UTC()
	form := f.form(t, now.Add(time.Hour))
	form.AssignAll, form.Assignees = false, []string{f.viewer, f.other}
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, f.ws.ID, f.other); err != nil {
		t.Fatal(err)
	}
	read, err := f.s.GetAssignment(ctx, f.user, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(read.Manage.Assignees, []string{f.viewer}) {
		t.Fatalf("assignees = %v, want the viewer alone", read.Manage.Assignees)
	}
	form.Assignees = read.Manage.Assignees
	if _, err := f.s.UpdateAssignment(ctx, f.user, created.ID, form, now); err != nil {
		t.Fatalf("saving the form: %v", err)
	}
}

// TestPersonalWorkspaceStartsNoAssignment: after a switch to personal a start
// answers not found before any clock begins, and a tick too. Back in a class both
// work.
func TestPersonalWorkspaceStartsNoAssignment(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-personal-start")
	ctx := context.Background()
	now := time.Now().UTC()
	marked, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	unmarked, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, AssignmentForm{Kind: AssignmentUnmarked, Title: "Read it", Attempts: 1,
		AssignAll: true, Assignees: []string{}, Files: []AssignmentFileRef{}}, now)
	if err != nil {
		t.Fatal(err)
	}
	setKind := func(kind WorkspaceKind) {
		t.Helper()
		if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind=$2 WHERE id=$1`, f.ws.ID, kind); err != nil {
			t.Fatal(err)
		}
	}
	setKind(WorkspacePersonal)
	if _, err := f.s.StartAssignment(ctx, f.viewer, marked.ID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a start in a personal workspace = %v", err)
	}
	var attempts int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM attempts WHERE assignment_id=$1`, marked.ID).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != 0 {
		t.Fatal("the refused start began an attempt")
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, unmarked.ID, true, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a tick in a personal workspace = %v", err)
	}
	setKind(WorkspaceClass)
	if _, err := f.s.StartAssignment(ctx, f.viewer, marked.ID, now); err != nil {
		t.Fatalf("a start back in a class: %v", err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, unmarked.ID, true, now); err != nil {
		t.Fatalf("a tick back in a class: %v", err)
	}
}

// TestPublishingRefusesKeptCopiesAndDrainsTheRoom (security regression): once a
// draft is published its assignee's device may keep no copy of the quiz and its
// live room drains, so one already reading is refused on reconnecting, while an
// unassigned member and staff keep it. After closing the assignee has it back.
// Fails without the assigned rule in ReadableMaterialIDs or the eviction in
// publishAssignmentTx; rooms.rs holds the room's own refusal.
func TestPublishingRefusesKeptCopiesAndDrainsTheRoom(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-publish-room")
	ctx := context.Background()
	now := time.Now().UTC()
	form := f.form(t, now.Add(time.Hour))
	form.AssignAll, form.Assignees = false, []string{f.viewer}
	form.Draft, form.Questions = true, nil
	draft, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	keeps := func(user string) bool {
		t.Helper()
		ids, err := f.s.ReadableMaterialIDs(ctx, user, []string{f.quiz.ID})
		if err != nil {
			t.Fatal(err)
		}
		return slices.Contains(ids, f.quiz.ID)
	}
	drains := func() int {
		t.Helper()
		return f.quizDrains(t)
	}
	if !keeps(f.viewer) || drains() != 0 {
		t.Fatalf("under a draft: viewer keeps %v, %d drains", keeps(f.viewer), drains())
	}
	if _, err := f.s.PublishAssignment(ctx, f.user, draft.ID, frozenFixture(t), now); err != nil {
		t.Fatal(err)
	}
	if keeps(f.viewer) {
		t.Fatal("the assignee's device keeps the published quiz")
	}
	if drains() != 1 {
		t.Fatalf("publishing drained the room %d times, want once", drains())
	}
	for _, user := range []string{f.other, f.editor, f.user} {
		if !keeps(user) {
			t.Fatalf("%s lost the quiz", user)
		}
	}
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, draft.ID, true, now); err != nil {
		t.Fatal(err)
	}
	if !keeps(f.viewer) {
		t.Fatal("after closing the assignee's copy is refused")
	}
}

// quizDrains counts the notices that drain the quiz's live rooms.
func (f assignmentFixture) quizDrains(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.s.pool.QueryRow(context.Background(), `SELECT count(*) FROM collaboration_eviction_outbox
		WHERE payload->>'materialId'=$1 AND payload->>'mode'='drain'`, f.quiz.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// keepsQuiz: whether the user's device may keep a copy of the quiz, the refusal
// the room's own rule (rooms.rs) holds too.
func (f assignmentFixture) keepsQuiz(t *testing.T, user string) bool {
	t.Helper()
	ids, err := f.s.ReadableMaterialIDs(context.Background(), user, []string{f.quiz.ID})
	if err != nil {
		t.Fatal(err)
	}
	return slices.Contains(ids, f.quiz.ID)
}

// TestReopeningDrainsTheRoom (security regression, Q616): closing gives the
// assignee the quiz back, so they may be in its room when it reopens. Fails
// without the eviction in SetAssignmentClosed.
func TestReopeningDrainsTheRoom(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-reopen-room")
	ctx := context.Background()
	now := time.Now().UTC()
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, true, now); err != nil {
		t.Fatal(err)
	}
	if !f.keepsQuiz(t, f.viewer) {
		t.Fatal("closed: the assignee's quiz is refused")
	}
	before := f.quizDrains(t)
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, false, now); err != nil {
		t.Fatal(err)
	}
	if f.keepsQuiz(t, f.viewer) {
		t.Fatal("reopened: the assignee keeps the quiz")
	}
	if got := f.quizDrains(t) - before; got != 1 {
		t.Fatalf("reopening drained the room %d times, want once", got)
	}
}

// TestAddingAViewerDrainsTheRoom (security regression, Q616): a viewer not on the
// list reads the quiz until a save adds them. Fails without the eviction in
// UpdateAssignment.
func TestAddingAViewerDrainsTheRoom(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-add-room")
	ctx := context.Background()
	now := time.Now().UTC()
	form := f.form(t, now.Add(time.Hour))
	form.AssignAll, form.Assignees = false, []string{f.viewer}
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if !f.keepsQuiz(t, f.other) {
		t.Fatal("off the list: the member's quiz is refused")
	}
	before := f.quizDrains(t)
	form.Assignees = []string{f.viewer, f.other}
	if _, err := f.s.UpdateAssignment(ctx, f.user, created.ID, form, now); err != nil {
		t.Fatal(err)
	}
	if f.keepsQuiz(t, f.other) {
		t.Fatal("added: the member keeps the quiz")
	}
	if got := f.quizDrains(t) - before; got != 1 {
		t.Fatalf("adding a viewer drained the room %d times, want once", got)
	}
}

// TestMovingANoLateDueDateForwardDrainsTheRoom (security regression, Q616): past
// its due date a No late submissions assignment gives the quiz back, until a save
// moves the date on. Fails without the eviction in UpdateAssignment.
func TestMovingANoLateDueDateForwardDrainsTheRoom(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-due-room")
	ctx := context.Background()
	now := time.Now().UTC()
	form := f.form(t, now.Add(-time.Hour))
	form.NoLate = true
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if !f.keepsQuiz(t, f.viewer) {
		t.Fatal("past its due date: the assignee's quiz is refused")
	}
	before := f.quizDrains(t)
	later := now.Add(time.Hour)
	form.DueAt = &later
	if _, err := f.s.UpdateAssignment(ctx, f.user, created.ID, form, now); err != nil {
		t.Fatal(err)
	}
	if f.keepsQuiz(t, f.viewer) {
		t.Fatal("due date moved forward: the assignee keeps the quiz")
	}
	if got := f.quizDrains(t) - before; got != 1 {
		t.Fatalf("moving the date drained the room %d times, want once", got)
	}
}

// TestSwitchingBackToClassDrainsTheRooms (security regression, Q616): a personal
// workspace gives every quiz back, so its open assignments' rooms drain on the way
// back, a quiz under two assignments once, and a save that stays a class leaves
// them. Fails without the eviction in UpdateWorkspace.
func TestSwitchingBackToClassDrainsTheRooms(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-kind-room")
	ctx := context.Background()
	now := time.Now().UTC()
	for range 2 {
		if _, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now); err != nil {
			t.Fatal(err)
		}
	}
	switchTo := func(kind WorkspaceKind) {
		t.Helper()
		if _, err := f.s.UpdateWorkspace(ctx, f.user, f.ws.ID, WorkspacePatch{Kind: &kind}); err != nil {
			t.Fatal(err)
		}
	}
	switchTo(WorkspacePersonal)
	if !f.keepsQuiz(t, f.viewer) {
		t.Fatal("personal: the assignee's quiz is refused")
	}
	before := f.quizDrains(t)
	switchTo(WorkspaceClass)
	if f.keepsQuiz(t, f.viewer) {
		t.Fatal("back in a class: the assignee keeps the quiz")
	}
	if got := f.quizDrains(t) - before; got != 1 {
		t.Fatalf("the switch drained the room %d times, want once", got)
	}
	switchTo(WorkspaceClass)
	if got := f.quizDrains(t) - before; got != 1 {
		t.Fatalf("a save that stays a class drained it again: %d", got)
	}
}

// TestPastedImagesFollowTheReadRule (security regression): pasting an image's id
// into one's own note copies it only for who may read it, as resolving it does:
// neither a hidden quiz's image for a viewer, nor a frozen copy's for a member it
// did not go to. Fails if adopting goes back to workspace access.
func TestPastedImagesFollowTheReadRule(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-paste")
	ctx := context.Background()
	now := time.Now().UTC()
	asset := func(materialID string) string {
		t.Helper()
		id := uid("asset")
		if _, err := f.s.pool.Exec(ctx, `INSERT INTO editor_assets
			(id, workspace_id, material_id, user_id, created_by, name, purpose, object_path, content_type, size_bytes, status, completed_at)
			VALUES ($1,$2,$3,$4,$4,'figure.png','image',$5,'image/png',10,'ready',now())`,
			id, f.ws.ID, materialID, f.user, "editor-assets/assignment-paste/"+uid("blob")); err != nil {
			t.Fatal(err)
		}
		return id
	}
	hiddenQuiz, err := f.s.CreateMaterialDraft(ctx, MaterialDraft{
		ActorUserID: f.user, WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Kind: MaterialQuiz, Title: "Hidden", Hidden: true,
		Questions: json.RawMessage(assignmentQuestions),
	})
	if err != nil {
		t.Fatal(err)
	}
	hiddenAsset, shownAsset := asset(hiddenQuiz.ID), asset(f.quiz.ID)

	questions := frozenFixture(t)
	questions[0]["stem"] = []any{map[string]any{"type": "image", "image": map[string]any{"assetId": shownAsset}, "width": 10, "height": 10, "description": "Figure"}}
	form := f.form(t, now.Add(time.Hour))
	form.AssignAll, form.Assignees, form.Questions = false, []string{f.viewer}, questions
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	var frozen string
	if err := f.s.pool.QueryRow(ctx, `SELECT id FROM editor_assets WHERE assignment_id=$1`, created.ID).Scan(&frozen); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, true, now); err != nil {
		t.Fatal(err)
	}

	// The other viewer's own workspace and note, where the id gets pasted.
	own, err := f.s.CreateWorkspace(ctx, f.other, WorkspaceCreate{Name: "Mine", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	note, err := f.s.CreateMaterial(ctx, Material{CreatedBy: f.other, WorkspaceID: own.ID, WorkspaceName: own.Name,
		Kind: "note", Title: "Mine", Content: noteWithImages(t)})
	if err != nil {
		t.Fatal(err)
	}
	adopted, _, err := f.s.AdoptEditorAssets(ctx, f.other, own.ID, note.ID, []string{hiddenAsset, shownAsset, frozen},
		planlimits.Limits{ImageBytes: 2 << 20, SourceFileBytes: 10 << 20})
	if err != nil {
		t.Fatal(err)
	}
	if adopted[hiddenAsset] != "" || adopted[frozen] != "" {
		t.Fatalf("the viewer pasted what it cannot read: %v", adopted)
	}
	if adopted[shownAsset] == "" {
		t.Fatalf("the viewer cannot paste the visible quiz's image: %v", adopted)
	}
}

// TestChangedMarkCountsOnce: a changed mark replaces the earlier one, so a zero
// corrected to full marks leaves no wrong answer behind in the topic's label.
func TestChangedMarkCountsOnce(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-changed-mark")
	ctx := context.Background()
	now := time.Now().UTC()
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{"p1": []any{float64(1)}, "p2": "wrong", "p3": "because"}, now); err != nil {
		t.Fatal(err)
	}
	mark := func(at time.Time, items ...float64) {
		t.Helper()
		if _, err := f.s.MarkAssignmentAnswer(ctx, f.user, run.ID, AssignmentMark{
			QuestionID: "q3", Parts: []AssignmentPartMark{{PartID: "p3", Items: items}},
		}, at); err != nil {
			t.Fatal(err)
		}
	}
	mark(now.Add(time.Minute), 0, 0)
	mark(now.Add(2*time.Minute), 2, 1)
	topics, err := f.s.topicStandings(ctx, f.viewer, f.ws.ID, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(topics) != 1 || topics[0].Right != 2 || topics[0].Wrong != 1 || topics[0].Label != review.LabelFamiliar {
		t.Fatalf("the topic = %+v, want two right of three, familiar", topics)
	}
}

// TestAssignmentChargesItsFrozenQuestions: the frozen question JSON is charged to
// whoever published, not who drafted (Epo 2026-11-05), is refused past the limit
// with no images in it, and leaves the meter with the assignment or its workspace;
// a purge ends the charge and the class keeps the paper. The recount agrees at
// every step.
func TestAssignmentChargesItsFrozenQuestions(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-charge")
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
	owner, editor := used(f.user), used(f.editor)

	form := f.form(t, now.Add(time.Hour))
	form.Draft, form.Questions = true, nil
	draft, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	if used(f.user) != owner || used(f.editor) != editor {
		t.Fatal("a draft was charged")
	}
	if _, err := f.s.PublishAssignment(ctx, f.editor, draft.ID, frozenFixture(t), now); err != nil {
		t.Fatal(err)
	}
	var size int64
	if err := f.s.pool.QueryRow(ctx, `SELECT octet_length(questions::text) FROM assignments WHERE id=$1`, draft.ID).Scan(&size); err != nil {
		t.Fatal(err)
	}
	if got := used(f.editor); size == 0 || got != editor+size {
		t.Fatalf("the publisher's meter = %d, want %d + %d", got, editor, size)
	}
	if used(f.user) != owner {
		t.Fatal("whoever drafted it was charged")
	}
	if err := f.s.DeleteAssignment(ctx, f.user, draft.ID); err != nil {
		t.Fatal(err)
	}
	if used(f.editor) != editor {
		t.Fatal("deleting it left its charge")
	}

	if _, err := f.s.pool.Exec(ctx, `UPDATE user_storage SET used_bytes=$2 WHERE user_id=$1`,
		f.editor, mustPlanLimits(t, f.s, PlanFree).StorageBytes-size+1); err != nil {
		t.Fatal(err)
	}
	var quota *QuotaExceededError
	if _, err := f.s.CreateAssignment(ctx, f.editor, f.ws.ID, f.form(t, now.Add(time.Hour)), now); !errors.As(err, &quota) {
		t.Fatalf("publishing past the limit = %v", err)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE user_storage SET used_bytes=$2 WHERE user_id=$1`, f.editor, editor); err != nil {
		t.Fatal(err)
	}

	if _, err := f.s.CreateAssignment(ctx, f.editor, f.ws.ID, f.form(t, now.Add(time.Hour)), now); err != nil {
		t.Fatal(err)
	}
	if err := f.s.DeleteWorkspace(ctx, f.user, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	if used(f.editor) != editor {
		t.Fatal("deleting the workspace left the charge")
	}

	// A purge of the publisher: the paper stays, charged to nobody.
	g := newAssignmentFixture(t, "assignment-charge-purge")
	kept, err := g.s.CreateAssignment(ctx, g.editor, g.ws.ID, g.form(t, now.Add(time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.s.RequestAccountDeletion(ctx, g.editor, true); err != nil {
		t.Fatal(err)
	}
	if err := g.s.PurgeUser(ctx, g.editor); err != nil {
		t.Fatal(err)
	}
	var payer *string
	var frozen []byte
	if err := g.s.pool.QueryRow(ctx, `SELECT frozen_by, questions FROM assignments WHERE id=$1`, kept.ID).Scan(&payer, &frozen); err != nil {
		t.Fatal(err)
	}
	if payer != nil || len(frozen) == 0 {
		t.Fatalf("after the purge: payer %v, %d bytes of questions", payer, len(frozen))
	}
}

// TestLockedOwnerStartsNoAssignment (security regression): the owner's account
// locked, a class is out of reach, so a start and a tick answer 404 and write
// nothing, as every other read does (assignmentStaff). Fails without the check in
// StartAssignment or SetAssignmentDone.
func TestLockedOwnerStartsNoAssignment(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-locked-owner")
	ctx := context.Background()
	now := time.Now().UTC()
	marked, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	unmarked, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, AssignmentForm{Kind: AssignmentUnmarked, Title: "Read it", Attempts: 1,
		AssignAll: true, Assignees: []string{}, Files: []AssignmentFileRef{}}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id=$1`, f.user); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.StartAssignment(ctx, f.viewer, marked.ID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a start under a locked owner = %v", err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, unmarked.ID, true, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a tick under a locked owner = %v", err)
	}
	var written int
	if err := f.s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM attempts WHERE assignment_id=$1)
		+ (SELECT count(*) FROM assignment_done WHERE assignment_id=$2)`, marked.ID, unmarked.ID).Scan(&written); err != nil {
		t.Fatal(err)
	}
	if written != 0 {
		t.Fatalf("the refused requests wrote %d rows", written)
	}
}

// TestFrozenImagesPasteForNobody (security regression): a frozen copy's image
// reads for who it went to and staff, and pastes for neither; the quiz's own image
// pastes for staff and not for an assignee it is refused to. Fails without the
// frozen check in AdoptEditorAssets.
func TestFrozenImagesPasteForNobody(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-frozen-paste")
	ctx := context.Background()
	now := time.Now().UTC()
	source := uid("asset")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO editor_assets
		(id, workspace_id, material_id, user_id, created_by, name, purpose, object_path, content_type, size_bytes, status, completed_at)
		VALUES ($1,$2,$3,$4,$4,'figure.png','image',$5,'image/png',10,'ready',now())`,
		source, f.ws.ID, f.quiz.ID, f.user, "editor-assets/frozen-paste/"+uid("blob")); err != nil {
		t.Fatal(err)
	}
	questions := frozenFixture(t)
	questions[0]["stem"] = []any{map[string]any{"type": "image", "image": map[string]any{"assetId": source}, "width": 10, "height": 10, "description": "Figure"}}
	form := f.form(t, now.Add(time.Hour))
	form.Questions = questions
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	frozen, err := scanEditorAsset(f.s.pool.QueryRow(ctx, `SELECT `+editorAssetCols+` FROM editor_assets WHERE assignment_id=$1`, created.ID))
	if err != nil {
		t.Fatal(err)
	}
	limits := planlimits.Limits{ImageBytes: 2 << 20, SourceFileBytes: 10 << 20}

	// The assignee reads it and pastes neither it nor the quiz's own image.
	if readable, err := f.s.EditorAssetReadable(ctx, f.viewer, frozen); err != nil || !readable {
		t.Fatalf("the assignee reads the frozen image: %v, %v", readable, err)
	}
	own, err := f.s.CreateWorkspace(ctx, f.viewer, WorkspaceCreate{Name: "Mine", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	note, err := f.s.CreateMaterial(ctx, Material{CreatedBy: f.viewer, WorkspaceID: own.ID, WorkspaceName: own.Name,
		Kind: "note", Title: "Mine", Content: noteWithImages(t)})
	if err != nil {
		t.Fatal(err)
	}
	adopted, _, err := f.s.AdoptEditorAssets(ctx, f.viewer, own.ID, note.ID, []string{frozen.ID, source}, limits)
	if err != nil {
		t.Fatal(err)
	}
	if len(adopted) != 0 {
		t.Fatalf("the assignee pasted %v", adopted)
	}

	// Staff read it and paste only the quiz's.
	staffNote, err := f.s.CreateMaterial(ctx, Material{CreatedBy: f.user, WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name,
		Kind: "note", Title: "Staff", Content: noteWithImages(t)})
	if err != nil {
		t.Fatal(err)
	}
	adopted, _, err = f.s.AdoptEditorAssets(ctx, f.user, f.ws.ID, staffNote.ID, []string{frozen.ID, source}, limits)
	if err != nil {
		t.Fatal(err)
	}
	if adopted[frozen.ID] != "" || adopted[source] == "" {
		t.Fatalf("staff pasted %v", adopted)
	}
}

// TestMovingAFileLeavesItsAssignments: an assignment's files are its workspace's,
// so one moved elsewhere goes off the list.
func TestMovingAFileLeavesItsAssignments(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-moved-file")
	ctx := context.Background()
	now := time.Now().UTC()
	file := uploadWorkspaceFile(t, f.s, f.user, f.ws.ID)
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, AssignmentForm{Kind: AssignmentUnmarked, Title: "Read it", Attempts: 1,
		AssignAll: true, Assignees: []string{}, Files: []AssignmentFileRef{{FileID: file.ID}}}, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(created.Files) != 1 {
		t.Fatalf("files = %+v", created.Files)
	}
	target, err := f.s.CreateWorkspace(ctx, f.user, WorkspaceCreate{Name: "Elsewhere", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.MoveFiles(ctx, f.user, []string{file.ID}, MoveTarget{WorkspaceID: target.ID}); err != nil {
		t.Fatal(err)
	}
	var left int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM assignment_files WHERE file_id=$1`, file.ID).Scan(&left); err != nil {
		t.Fatal(err)
	}
	read, err := f.s.GetAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if left != 0 || len(read.Files) != 0 {
		t.Fatalf("after the move: %d rows, files %+v", left, read.Files)
	}
}
