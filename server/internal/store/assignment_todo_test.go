package store

import (
	"context"
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
