package store

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"
)

// TestListTodo: a member's section holds what was given to them until it
// closes; staff's holds an assignment once an answer waits for them.
func TestListTodo(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-todo")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(24*time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	mine, err := f.s.ListTodo(ctx, f.viewer, now)
	if err != nil || len(mine.Workspaces) != 1 || mine.Workspaces[0].Manages || mine.Workspaces[0].WorkspaceID != f.ws.ID {
		t.Fatalf("a member's To do = %+v, err %v", mine, err)
	}
	// Out of the class there is nothing, and in it with nothing assigned too.
	stranger := newBlobTestUser(t, f.s, "assignment-todo-stranger")
	if none, err := f.s.ListTodo(ctx, stranger, now); err != nil || len(none.Workspaces) != 0 {
		t.Fatalf("a non-member's To do = %+v, err %v", none, err)
	}
	if none, err := f.s.ListTodo(ctx, f.editor, now); err != nil || len(none.Workspaces) != 0 {
		t.Fatalf("an editor with nothing assigned or waiting = %+v, err %v", none, err)
	}
	if items := mine.Workspaces[0].Items; len(items) != 1 || items[0].ID != created.ID || items[0].Mine == nil || items[0].Manage != nil {
		t.Fatalf("a member's rows = %+v", items)
	}

	// Its change reaches the member it went to and the class's staff.
	members, audience, err := f.s.TodoAudience(ctx, created.ID)
	if err != nil || !slices.Contains(members, f.viewer) || slices.Contains(members, f.user) || !slices.Contains(audience, f.user) || !slices.Contains(audience, f.editor) {
		t.Fatalf("audience = %v / %v, err %v", members, audience, err)
	}

	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, false, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{"p3": "Water moves in"}, now); err != nil {
		t.Fatal(err)
	}
	// Submitted, it is on the Done tab while still open.
	if done, err := f.s.ListTodoDone(ctx, f.viewer, now, TodoDoneParams{Limit: 30}); err != nil || len(done.Workspaces) != 1 || !done.Workspaces[0].Items[0].Mine.Done {
		t.Fatalf("a member's Done = %+v, err %v", done, err)
	}
	staff, err := f.s.ListTodo(ctx, f.user, now)
	if err != nil || len(staff.Workspaces) != 1 || !staff.Workspaces[0].Manages || staff.Workspaces[0].Items[0].Manage.ToApprove != 1 {
		t.Fatalf("staff's To do = %+v, err %v", staff, err)
	}

	if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, true, now); err != nil {
		t.Fatal(err)
	}
	closed, err := f.s.ListTodo(ctx, f.viewer, now)
	if err != nil || len(closed.Workspaces) != 0 {
		t.Fatalf("a closed assignment stayed: %+v, err %v", closed, err)
	}

	// Closed with nothing done, another member finds it on the Done tab.
	other, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(24*time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, other.ID, true, now.Add(time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	// One a page: the closed one first (closed after the other was submitted),
	// then the submitted one.
	first, err := f.s.ListTodoDone(ctx, f.viewer, now.Add(time.Second), TodoDoneParams{Limit: 1})
	if err != nil || len(first.Workspaces) != 1 || first.NextCursor != "1" {
		t.Fatalf("Done page 1 = %+v, err %v", first, err)
	}
	if a := first.Workspaces[0].Items[0]; a.ID != other.ID || a.Mine.Done || a.ClosedAt == nil {
		t.Fatalf("Done page 1 row = %+v", a)
	}
	second, err := f.s.ListTodoDone(ctx, f.viewer, now.Add(time.Second), TodoDoneParams{Offset: 1, Limit: 1})
	if err != nil || second.NextCursor != "" || second.Workspaces[0].Items[0].ID != created.ID {
		t.Fatalf("Done page 2 = %+v, err %v", second, err)
	}
	// The type filter keeps quizzes only; the fixture's are all quizzes.
	if none, err := f.s.ListTodoDone(ctx, f.viewer, now, TodoDoneParams{Kinds: []string{AssignmentUnmarked}, Limit: 30}); err != nil || len(none.Workspaces) != 0 {
		t.Fatalf("Done tasks = %+v, err %v", none, err)
	}
}

// TestTodoChecks (Epo 2026-11-10): a member ticks a quiz off To do without
// submitting, which leaves it not done and missing past its due date; a plain
// task is ticked with done instead. Staff tick the answers waiting off, and a
// later submission brings them back.
func TestTodoChecks(t *testing.T) {
	f := newAssignmentFixture(t, "assignment-todo-checks")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	quiz, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	mineOf := func(at time.Time) *AssignmentMine {
		t.Helper()
		list, err := f.s.ListTodo(ctx, f.viewer, at)
		if err != nil || len(list.Workspaces) != 1 {
			t.Fatalf("To do = %+v, err %v", list, err)
		}
		return list.Workspaces[0].Items[0].Mine
	}
	if err := f.s.SetAssignmentTodoCheck(ctx, f.viewer, quiz.ID, false, true, now); err != nil {
		t.Fatal(err)
	}
	if m := mineOf(now); !m.CheckedOff || m.CheckedAt == nil || m.Done {
		t.Fatalf("ticked quiz = %+v", m)
	}
	// Done for them is done: it is on the Done tab while still open.
	if done, err := f.s.ListTodoDone(ctx, f.viewer, now, TodoDoneParams{Limit: 30}); err != nil || len(done.Workspaces) != 1 || done.Workspaces[0].Items[0].ID != quiz.ID {
		t.Fatalf("Done with a ticked quiz = %+v, err %v", done, err)
	}
	// Removed from Done, it stays off until finished again.
	doneCount := func() int {
		t.Helper()
		done, err := f.s.ListTodoDone(ctx, f.viewer, now, TodoDoneParams{Limit: 30})
		if err != nil {
			t.Fatal(err)
		}
		return len(done.Workspaces)
	}
	if err := f.s.HideTodoDone(ctx, f.viewer, []string{quiz.ID}, now); err != nil || doneCount() != 0 {
		t.Fatalf("Done after removing it: %d, err %v", doneCount(), err)
	}
	if err := f.s.SetAssignmentTodoCheck(ctx, f.viewer, quiz.ID, false, true, now.Add(time.Second)); err != nil || doneCount() != 1 {
		t.Fatalf("Done after ticking it again: %d, err %v", doneCount(), err)
	}
	if m := mineOf(now.Add(2 * time.Hour)); !m.CheckedOff || !m.Missing {
		t.Fatalf("ticked quiz past its due date = %+v", m)
	}
	if err := f.s.SetAssignmentTodoCheck(ctx, f.viewer, quiz.ID, false, false, now); err != nil {
		t.Fatal(err)
	}
	if m := mineOf(now); m.CheckedOff {
		t.Fatalf("unticked quiz = %+v", m)
	}
	// Someone it didn't go to, and staff on their own work, have nothing to tick.
	if err := f.s.SetAssignmentTodoCheck(ctx, f.editor, quiz.ID, false, true, now); err != ErrNotFound {
		t.Fatalf("an editor's tick: %v", err)
	}
	if err := f.s.SetAssignmentTodoCheck(ctx, f.viewer, quiz.ID, true, true, now); err != ErrNotFound {
		t.Fatalf("a member's tick on the approvals: %v", err)
	}
	task, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, AssignmentForm{Kind: AssignmentUnmarked, Title: "Read it", Attempts: 1,
		AssignAll: true, Assignees: []string{}, Marking: MarkingAIApprove, ShowAnswers: AnswersAfterClose, ShowGrades: GradesAutomatic,
		Files: []AssignmentFileRef{}}, now)
	if err != nil {
		t.Fatal(err)
	}
	var input *AssignmentInputError
	if err := f.s.SetAssignmentTodoCheck(ctx, f.viewer, task.ID, false, true, now); !errors.As(err, &input) {
		t.Fatalf("a task's tick here: %v", err)
	}

	// Staff: answers wait once the viewer submits; ticked, they stay off until
	// the other viewer's submission.
	submit := func(user string, at time.Time) {
		t.Helper()
		run, err := f.s.StartAssignment(ctx, user, quiz.ID, false, at)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.s.SubmitAssignmentAttempt(ctx, user, run.ID, map[string]any{"p3": "Water moves in"}, at); err != nil {
			t.Fatal(err)
		}
	}
	manageOf := func() *AssignmentManage {
		t.Helper()
		list, err := f.s.ListTodo(ctx, f.user, now)
		if err != nil || len(list.Workspaces) != 1 {
			t.Fatalf("staff's To do = %+v, err %v", list, err)
		}
		for _, a := range list.Workspaces[0].Items {
			if a.ID == quiz.ID {
				return a.Manage
			}
		}
		t.Fatalf("staff's To do has no %s: %+v", quiz.ID, list)
		return nil
	}
	submit(f.viewer, now)
	if err := f.s.SetAssignmentTodoCheck(ctx, f.user, quiz.ID, true, true, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if m := manageOf(); m.ToApprove != 1 || !m.ApprovalsCheckedOff {
		t.Fatalf("ticked approvals = %+v", m)
	}
	submit(f.other, now.Add(2*time.Second))
	if m := manageOf(); m.ToApprove != 2 || m.ApprovalsCheckedOff {
		t.Fatalf("approvals after a later submission = %+v", m)
	}
}

// TestOwnTasks: anyone but a class's staff makes a task for themself, theirs
// alone to read, tick, change and delete, on To do and Done. In a personal
// workspace what the class gave out stays hidden beside it; in a class its
// staff neither list it nor reach it.
func TestOwnTasks(t *testing.T) {
	f := newAssignmentFixture(t, "own-tasks")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	given, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(24*time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	form := f.form(t, now.Add(24*time.Hour))
	form.Kind, form.QuizID, form.Questions, form.Title = AssignmentUnmarked, "", nil, "Read chapter 4"
	// A class's viewer member: only a task for themself is taken.
	var refused *AssignmentInputError
	if _, err := f.s.CreateAssignment(ctx, f.viewer, f.ws.ID, form, now); !errors.As(err, &refused) {
		t.Fatalf("a viewer's task for all members: %v", err)
	}
	form.AssignAll, form.Assignees = false, []string{f.viewer}
	mine, err := f.s.CreateAssignment(ctx, f.viewer, f.ws.ID, form, now)
	if err != nil || !mine.Own || mine.Mine == nil || mine.Manage == nil {
		t.Fatalf("a viewer's own task = %+v, err %v", mine, err)
	}
	todo, err := f.s.ListTodo(ctx, f.viewer, now)
	if err != nil || len(todo.Workspaces) != 1 || len(todo.Workspaces[0].Items) != 2 {
		t.Fatalf("a viewer's To do = %+v, err %v", todo, err)
	}
	staff, err := f.s.ListAssignments(ctx, f.user, f.ws.ID, now)
	if err != nil || len(staff.Items) != 1 || staff.Items[0].ID != given.ID {
		t.Fatalf("staff's list = %+v, err %v", staff, err)
	}
	if _, err := f.s.GetAssignment(ctx, f.user, mine.ID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("staff read a member's task: %v", err)
	}
	if _, err := f.s.SetAssignmentClosed(ctx, f.user, mine.ID, true, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("staff closed a member's task: %v", err)
	}

	// A personal workspace: an editor's, with the class's work hidden.
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='personal' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	form.Assignees = []string{f.editor}
	task, err := f.s.CreateAssignment(ctx, f.editor, f.ws.ID, form, now)
	if err != nil || !task.Own || task.Mine == nil || task.Manage == nil {
		t.Fatalf("an editor's own task = %+v, err %v", task, err)
	}
	todo, err = f.s.ListTodo(ctx, f.editor, now)
	if err != nil || len(todo.Workspaces) != 1 || todo.Workspaces[0].Manages ||
		len(todo.Workspaces[0].Items) != 1 || todo.Workspaces[0].Items[0].ID != task.ID {
		t.Fatalf("its maker's To do = %+v, err %v", todo, err)
	}
	if none, err := f.s.ListTodo(ctx, f.user, now); err != nil || len(none.Workspaces) != 0 {
		t.Fatalf("the owner's To do = %+v, err %v", none, err)
	}
	if only, err := f.s.ListTodo(ctx, f.viewer, now); err != nil || len(only.Workspaces) != 1 ||
		len(only.Workspaces[0].Items) != 1 || only.Workspaces[0].Items[0].ID != mine.ID {
		t.Fatalf("the viewer's To do in a personal workspace = %+v, err %v", only, err)
	}

	form.Title = "Read chapters 4 and 5"
	if changed, err := f.s.UpdateAssignment(ctx, f.editor, task.ID, form, now); err != nil || changed.Title != form.Title {
		t.Fatalf("changed = %+v, err %v", changed, err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.editor, task.ID, true, now); err != nil {
		t.Fatal(err)
	}
	done, err := f.s.ListTodoDone(ctx, f.editor, now, TodoDoneParams{Limit: 30})
	if err != nil || len(done.Workspaces) != 1 || len(done.Workspaces[0].Items) != 1 || !done.Workspaces[0].Items[0].Mine.Done {
		t.Fatalf("its maker's Done = %+v, err %v", done, err)
	}
	if err := f.s.DeleteAssignment(ctx, f.editor, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.GetAssignment(ctx, f.editor, task.ID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a deleted task read: %v", err)
	}
}

// TestTasksWithoutWorkspace: a task made with no workspace (Epo 2026-11-11) is
// its maker's alone, first on To do and on Done, and holds files from anywhere
// its maker can open, each for as long as they can.
func TestTasksWithoutWorkspace(t *testing.T) {
	f := newAssignmentFixture(t, "loose-tasks")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	standalone, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.viewer, Name: "Mine",
		Questions: json.RawMessage(assignmentQuestions), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	hide := func(hidden bool) {
		t.Helper()
		if _, err := f.s.pool.Exec(ctx, `UPDATE materials SET hidden=$2 WHERE id=$1`, f.quiz.ID, hidden); err != nil {
			t.Fatal(err)
		}
	}
	form := AssignmentForm{Kind: AssignmentUnmarked, Title: "Revise", Attempts: 1, Assignees: []string{f.viewer},
		Marking: MarkingAIApprove, ShowAnswers: AnswersAfterSubmit, ShowGrades: GradesAutomatic,
		Files: []AssignmentFileRef{{MaterialID: f.quiz.ID}, {MaterialID: standalone.ID}}}
	// A quiz hidden from members is not a member's to pick.
	hide(true)
	var refused *AssignmentInputError
	if _, err := f.s.CreateAssignment(ctx, f.viewer, "", form, now); !errors.As(err, &refused) {
		t.Fatalf("a task with a file its maker cannot open: %v", err)
	}
	hide(false)
	task, err := f.s.CreateAssignment(ctx, f.viewer, "", form, now)
	if err != nil || !task.Own || task.WorkspaceID != "" || task.Mine == nil || len(task.Files) != 2 ||
		task.Files[0].WorkspaceID == nil || *task.Files[0].WorkspaceID != f.ws.ID || task.Files[1].WorkspaceID != nil {
		t.Fatalf("a task with no workspace = %+v, err %v", task, err)
	}
	todo, err := f.s.ListTodo(ctx, f.viewer, now)
	if err != nil || len(todo.Workspaces) != 1 || todo.Workspaces[0].WorkspaceID != "" ||
		len(todo.Workspaces[0].Items) != 1 || todo.Workspaces[0].Items[0].ID != task.ID {
		t.Fatalf("its maker's To do = %+v, err %v", todo, err)
	}
	if _, err := f.s.GetAssignment(ctx, f.user, task.ID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("someone else read it: %v", err)
	}
	// A file its maker can no longer open leaves the task.
	hide(true)
	if left, err := f.s.GetAssignment(ctx, f.viewer, task.ID, now); err != nil || len(left.Files) != 1 {
		t.Fatalf("after the quiz was hidden = %+v, err %v", left, err)
	}
	form.Title, form.Files = "Revise again", []AssignmentFileRef{{MaterialID: standalone.ID}}
	if changed, err := f.s.UpdateAssignment(ctx, f.viewer, task.ID, form, now); err != nil || changed.Title != form.Title {
		t.Fatalf("changed = %+v, err %v", changed, err)
	}
	if err := f.s.SetAssignmentDone(ctx, f.viewer, task.ID, true, now); err != nil {
		t.Fatal(err)
	}
	done, err := f.s.ListTodoDone(ctx, f.viewer, now, TodoDoneParams{Limit: 30})
	if err != nil || len(done.Workspaces) != 1 || done.Workspaces[0].WorkspaceID != "" ||
		len(done.Workspaces[0].Items) != 1 || !done.Workspaces[0].Items[0].Mine.Done {
		t.Fatalf("its maker's Done = %+v, err %v", done, err)
	}
	if err := f.s.DeleteAssignment(ctx, f.viewer, task.ID); err != nil {
		t.Fatal(err)
	}
}

// TestOwnMarkedTask: a task someone sets themself takes a quiz, from anywhere
// they can open (Epo 2026-11-11). Its maker runs it as staff do and takes it as
// a member does; its frozen images name the task alone; nobody else reaches it;
// and it leaves a workspace with its maker.
func TestOwnMarkedTask(t *testing.T) {
	f := newAssignmentFixture(t, "own-marked")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	due := now.Add(24 * time.Hour)
	assetID := uid("asset")
	var qs []map[string]any
	if err := json.Unmarshal([]byte(assignmentQuestions), &qs); err != nil {
		t.Fatal(err)
	}
	qs[0]["stem"] = []any{map[string]any{"type": "image", "image": map[string]any{"assetId": assetID}, "width": 10, "height": 10, "description": "Figure"}}
	raw, err := json.Marshal(qs)
	if err != nil {
		t.Fatal(err)
	}
	quiz, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.viewer, Name: "Mine", Questions: raw, Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO editor_assets
		(id, material_id, user_id, created_by, name, purpose, object_path, content_type, size_bytes, status, completed_at)
		VALUES ($1,$2,$3,$3,'figure.png','image',$4,'image/png',10,'ready',now())`, assetID, quiz.ID, f.viewer, "editor-assets/own-marked/"+uid("blob")); err != nil {
		t.Fatal(err)
	}
	form := AssignmentForm{Kind: AssignmentMarked, Title: "Mock paper", QuizID: quiz.ID, Questions: qs, DueAt: &due, Attempts: 2,
		Assignees: []string{f.viewer}, Marking: MarkingManual, ShowAnswers: AnswersAfterSubmit, ShowGrades: GradesAutomatic}

	// A quiz the class gave them and still holds back is not theirs to freeze.
	given, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, due), now)
	if err != nil {
		t.Fatal(err)
	}
	held := form
	held.QuizID, held.Questions = f.quiz.ID, frozenFixture(t)
	var refused *AssignmentInputError
	if _, err := f.s.CreateAssignment(ctx, f.viewer, "", held, now); !errors.As(err, &refused) {
		t.Fatalf("a task from an assigned quiz: %v", err)
	}
	if err := f.s.DeleteAssignment(ctx, f.user, given.ID); err != nil {
		t.Fatal(err)
	}

	// In the class, from their own quiz: the class's staff do not reach it.
	task, err := f.s.CreateAssignment(ctx, f.viewer, f.ws.ID, form, now)
	if err != nil || !task.Own || task.Manage == nil || task.Mine == nil || task.Questions != 3 || task.Marks != 6 {
		t.Fatalf("a marked task = %+v, err %v", task, err)
	}
	if _, err := f.s.GetAssignmentReport(ctx, f.user, task.ID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("staff read a member's task report: %v", err)
	}
	if _, err := f.s.StartAssignment(ctx, f.user, task.ID, false, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("staff started a member's task: %v", err)
	}
	frozen, err := scanEditorAsset(f.s.pool.QueryRow(ctx, `SELECT `+editorAssetCols+` FROM editor_assets WHERE assignment_id=$1`, task.ID))
	if err != nil || frozen.ID == assetID || frozen.WorkspaceID != "" || frozen.MaterialID != "" {
		t.Fatalf("its frozen image = %+v, err %v", frozen, err)
	}
	if ok, err := f.s.EditorAssetReadable(ctx, f.viewer, frozen); err != nil || !ok {
		t.Fatalf("its maker reads its image: %v, err %v", ok, err)
	}
	if ok, err := f.s.EditorAssetReadable(ctx, f.user, frozen); err != nil || ok {
		t.Fatalf("staff read its image: %v, err %v", ok, err)
	}

	// Its maker takes it, then marks the open part as its staff.
	run, err := f.s.StartAssignment(ctx, f.viewer, task.ID, false, now)
	if err != nil || run.Status != "running" {
		t.Fatalf("run = %+v, err %v", run, err)
	}
	if err := f.s.SaveAssignmentAnswers(ctx, f.viewer, run.ID, map[string]any{"p2": "osmosis"}, now); err != nil {
		t.Fatal(err)
	}
	done, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{
		"p1": []any{float64(1)}, "p2": "osmosis", "p3": "Water moves in",
	}, now.Add(time.Minute))
	if err != nil || done.Status != "submitted" || done.Correct != 3 || done.WaitingAnswers != 1 {
		t.Fatalf("submitted = %+v, err %v", done, err)
	}
	report, err := f.s.GetAssignmentReport(ctx, f.viewer, task.ID, now.Add(time.Minute))
	if err != nil || len(report.Members) != 1 || len(report.Answers) != 1 {
		t.Fatalf("its maker's report = %+v, err %v", report, err)
	}
	marked, err := f.s.MarkAssignmentAnswer(ctx, f.viewer, run.ID, AssignmentMark{
		QuestionID: "q3", Parts: []AssignmentPartMark{{PartID: "p3", Items: []float64{2, 1}}},
	}, now.Add(2*time.Minute))
	if err != nil || marked.Correct != 6 || marked.WaitingAnswers != 0 {
		t.Fatalf("marked = %+v, err %v", marked, err)
	}
	if _, err := f.s.MarkAssignmentAnswer(ctx, f.user, run.ID, AssignmentMark{
		QuestionID: "q3", Parts: []AssignmentPartMark{{PartID: "p3", Items: []float64{0, 0}}},
	}, now.Add(2*time.Minute)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("staff marked a member's task: %v", err)
	}
	// The answers are logged against the quiz, which sits in no workspace.
	var events int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM answer_events WHERE attempt_id=$1 AND workspace_id IS NULL`, run.ID).Scan(&events); err != nil || events != 3 {
		t.Fatalf("answer events = %d, err %v", events, err)
	}

	// Leaving the class, it stays theirs, in no workspace, and still runs.
	if _, _, err := f.s.RemoveWorkspaceMemberWithResult(ctx, f.viewer, f.ws.ID, f.viewer); err != nil {
		t.Fatal(err)
	}
	loose, err := f.s.GetAssignment(ctx, f.viewer, task.ID, now.Add(3*time.Minute))
	if err != nil || loose.WorkspaceID != "" || loose.Mine == nil || !loose.Mine.Done || loose.Mine.AttemptsUsed != 1 {
		t.Fatalf("after leaving = %+v, err %v", loose, err)
	}
	again, err := f.s.StartAssignment(ctx, f.viewer, task.ID, false, now.Add(3*time.Minute))
	if err != nil || again.ID == run.ID {
		t.Fatalf("a second attempt = %+v, err %v", again.ID, err)
	}
	if _, err := f.s.RepublishAssignment(ctx, f.viewer, task.ID, qs, now.Add(4*time.Minute)); err != nil {
		t.Fatal(err)
	}
	closed, err := f.s.SetAssignmentClosed(ctx, f.viewer, task.ID, true, now.Add(5*time.Minute))
	if err != nil || !closed.Closed {
		t.Fatalf("closed = %+v, err %v", closed, err)
	}
	if _, released, err := f.s.SweepAssignments(ctx, 100, now.Add(6*time.Minute)); err != nil || released < 1 {
		t.Fatalf("released = %d, err %v", released, err)
	}
	if err := f.s.DeleteAssignment(ctx, f.viewer, task.ID); err != nil {
		t.Fatal(err)
	}
	var left int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM editor_assets WHERE id=$1`, frozen.ID).Scan(&left); err != nil || left != 0 {
		t.Fatalf("deleting the task left %d frozen images, err %v", left, err)
	}
}

// TestOwnTaskFromClassQuiz (Epo 2026-11-11): a member's task on a quiz of their
// class is refused while the class has that quiz out, holds the quiz back from
// nobody, logs its answers under the class, and is no assignment of the class's
// in Practice. What they can no longer open leaves their tasks when they leave,
// and a workspace that is deleted leaves its members their tasks.
func TestOwnTaskFromClassQuiz(t *testing.T) {
	f := newAssignmentFixture(t, "own-class-quiz")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	due := now.Add(24 * time.Hour)
	form := AssignmentForm{Kind: AssignmentMarked, Title: "Mock paper", QuizID: f.quiz.ID, Questions: frozenFixture(t), DueAt: &due,
		Attempts: 1, Assignees: []string{f.viewer}, Marking: MarkingManual, ShowAnswers: AnswersAfterSubmit, ShowGrades: GradesAutomatic}
	answers := map[string]any{"p1": []any{float64(1)}, "p2": "osmosis", "p3": "Water moves in"}
	take := func(taskID string) string {
		t.Helper()
		run, err := f.s.StartAssignment(ctx, f.viewer, taskID, false, now)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, answers, now.Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
		return run.ID
	}
	logged := func(attemptID string) (count int) {
		t.Helper()
		if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM answer_events WHERE attempt_id=$1 AND workspace_id=$2`, attemptID, f.ws.ID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}

	// While the class has the quiz out, even to someone else, it is held from a
	// viewer member, so it cannot be their task's quiz.
	named := f.form(t, due)
	named.AssignAll, named.Assignees = false, []string{f.other}
	given, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, named, now)
	if err != nil {
		t.Fatal(err)
	}
	var refused *AssignmentInputError
	if _, err := f.s.CreateAssignment(ctx, f.viewer, "", form, now); !errors.As(err, &refused) {
		t.Fatalf("a task from a quiz the class has out: %v", err)
	}
	if err := f.s.DeleteAssignment(ctx, f.user, given.ID); err != nil {
		t.Fatal(err)
	}

	// In the class and with no workspace, the quiz stays its maker's to open and
	// the answers count where the quiz sits.
	task, err := f.s.CreateAssignment(ctx, f.viewer, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	loose, err := f.s.CreateAssignment(ctx, f.viewer, "", form, now)
	if err != nil || loose.Manage == nil || loose.Manage.QuizWorkspaceID == nil || *loose.Manage.QuizWorkspaceID != f.ws.ID {
		t.Fatalf("a loose task on a class quiz = %+v, err %v", loose, err)
	}
	if !f.keepsQuiz(t, f.viewer) || !f.inPractice(t, f.viewer, now) {
		t.Fatal("their own task took the quiz from its maker")
	}
	// The open part waits for its mark, so two answers are logged so far.
	if got := logged(take(task.ID)); got != 2 {
		t.Fatalf("the class task logged %d answers under the class", got)
	}
	if got := logged(take(loose.ID)); got != 2 {
		t.Fatalf("the loose task logged %d answers under the class", got)
	}

	// Once the class gives them the quiz, it is not theirs to freeze again.
	given, err = f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, due), now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.RepublishAssignment(ctx, f.viewer, task.ID, frozenFixture(t), now); !errors.As(err, &refused) {
		t.Fatalf("republishing a task whose quiz the class gave out: %v", err)
	}
	if err := f.s.DeleteAssignment(ctx, f.user, given.ID); err != nil {
		t.Fatal(err)
	}

	// Closed and released, it is no closed assignment of the class's.
	if _, err := f.s.SetAssignmentClosed(ctx, f.viewer, task.ID, true, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, released, err := f.s.SweepAssignments(ctx, 100, now.Add(3*time.Minute)); err != nil || released < 1 {
		t.Fatalf("released = %d, err %v", released, err)
	}
	practice, err := f.s.WorkspacePractice(ctx, f.user, f.ws.ID, true, now.Add(4*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range practice.Quizzes {
		if q.ID == f.quiz.ID && q.AssignmentClosedAt != nil {
			t.Fatalf("a member's task closed the class's quiz at %v", q.AssignmentClosedAt)
		}
	}

	// A quiz they pay for in the class is not theirs to open once they leave.
	note, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: "My class quiz", WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name,
		Questions: json.RawMessage(assignmentQuestions), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE materials SET owner_user_id=$2 WHERE id=$1`, note.ID, f.viewer); err != nil {
		t.Fatal(err)
	}
	plain := AssignmentForm{Kind: AssignmentUnmarked, Title: "Revise", Attempts: 1, Assignees: []string{f.viewer},
		Marking: MarkingAIApprove, ShowAnswers: AnswersAfterSubmit, ShowGrades: GradesAutomatic, Files: []AssignmentFileRef{{MaterialID: note.ID}}}
	revise, err := f.s.CreateAssignment(ctx, f.viewer, f.ws.ID, plain, now)
	if err != nil || len(revise.Files) != 1 {
		t.Fatalf("a task with their class quiz = %+v, err %v", revise, err)
	}
	if _, _, err := f.s.RemoveWorkspaceMemberWithResult(ctx, f.viewer, f.ws.ID, f.viewer); err != nil {
		t.Fatal(err)
	}
	revise, err = f.s.GetAssignment(ctx, f.viewer, revise.ID, now)
	if err != nil || revise.WorkspaceID != "" || len(revise.Files) != 0 {
		t.Fatalf("after leaving = %+v, err %v", revise, err)
	}
	if _, err := f.s.CreateAssignment(ctx, f.viewer, "", plain, now); !errors.As(err, &refused) {
		t.Fatalf("a task with a file in a class they left: %v", err)
	}

	// A workspace that is deleted leaves its members the tasks they set themselves.
	plain.Assignees, plain.Files = []string{f.other}, nil
	kept, err := f.s.CreateAssignment(ctx, f.other, f.ws.ID, plain, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.s.DeleteWorkspace(ctx, f.user, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	kept, err = f.s.GetAssignment(ctx, f.other, kept.ID, now)
	if err != nil || kept.WorkspaceID != "" || kept.Mine == nil {
		t.Fatalf("after its workspace was deleted = %+v, err %v", kept, err)
	}
}
