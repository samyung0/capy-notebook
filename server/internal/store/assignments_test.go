package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
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

// TestAssignmentRun walks a marked assignment: created with its quiz hidden,
// served from its frozen copy without keys, saved, submitted with its open part
// waiting, reported, and marked by an editor.
func TestAssignmentRun(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-run")
	ctx := context.Background()
	now := time.Now().UTC()
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
	// The quiz is no longer practice for members.
	if _, err := f.s.MaterialEffectiveRole(ctx, f.viewer, f.quiz.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("viewer reached the hidden quiz: %v", err)
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
			t.Fatal("a hidden assignment quiz listed as a member's practice")
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

// TestAssignmentBecomesPractice: at closing its quiz shows in Practice with a
// note, marked answers join reviews, the owner can hide it again, and another
// open assignment on the same quiz holds it back.
func TestAssignmentBecomesPractice(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-practice")
	ctx := context.Background()
	now := time.Now().UTC()
	due := now.Add(time.Hour)
	first, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, due), now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(3*time.Hour)), now); err != nil {
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
	// The first closed, but the second still uses the quiz.
	if _, released, err := f.s.SweepAssignments(ctx, 50, due.Add(time.Minute)); err != nil || released != 1 {
		t.Fatalf("sweep: released %d, err %v", released, err)
	}
	if shown, _ := listed(due.Add(time.Minute)); shown {
		t.Fatal("the quiz showed while another open assignment uses it")
	}
	later := now.Add(4 * time.Hour)
	if _, released, err := f.s.SweepAssignments(ctx, 50, later); err != nil || released != 1 {
		t.Fatalf("second sweep: released %d, err %v", released, err)
	}
	shown, closedAt := listed(later)
	if !shown || closedAt == nil {
		t.Fatalf("after closing: shown %v, note %v", shown, closedAt)
	}
	var rated int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM review_states WHERE user_id=$1 AND material_id=$2`, f.viewer, f.quiz.ID).Scan(&rated); err != nil {
		t.Fatal(err)
	}
	if rated != 1 {
		t.Fatalf("rated %d questions, want the marked answered one (q1)", rated)
	}
	got, err := f.s.GetAssignment(ctx, f.viewer, first.ID, later)
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

// TestAssignmentFrozenCopyAndUndo: the copy keeps its questions when the quiz
// changes, a draft freezes at publishing, and deleting shows the quiz again.
func TestAssignmentFrozenCopyAndUndo(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-frozen")
	ctx := context.Background()
	now := time.Now().UTC()
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
		t.Fatalf("undo left the quiz hidden: %v", err)
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
	const objectPath = "editor-assets/assignment-images/blob"
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
