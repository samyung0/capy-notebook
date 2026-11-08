package store

import (
	"context"
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

	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{"p3": "Water moves in"}, now); err != nil {
		t.Fatal(err)
	}
	// Submitted, it is on the Done tab while still open.
	if done, err := f.s.ListTodoDone(ctx, f.viewer, now, TodoDoneParams{Sort: "done", Limit: 30}); err != nil || len(done.Workspaces) != 1 || !done.Workspaces[0].Items[0].Mine.Done {
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
	first, err := f.s.ListTodoDone(ctx, f.viewer, now.Add(time.Second), TodoDoneParams{Sort: "done", Limit: 1})
	if err != nil || len(first.Workspaces) != 1 || first.NextCursor != "1" {
		t.Fatalf("Done page 1 = %+v, err %v", first, err)
	}
	if a := first.Workspaces[0].Items[0]; a.ID != other.ID || a.Mine.Done || a.ClosedAt == nil {
		t.Fatalf("Done page 1 row = %+v", a)
	}
	second, err := f.s.ListTodoDone(ctx, f.viewer, now.Add(time.Second), TodoDoneParams{Sort: "done", Offset: 1, Limit: 1})
	if err != nil || second.NextCursor != "" || second.Workspaces[0].Items[0].ID != created.ID {
		t.Fatalf("Done page 2 = %+v, err %v", second, err)
	}
	// The type filter keeps quizzes only; the fixture's are all quizzes.
	if none, err := f.s.ListTodoDone(ctx, f.viewer, now, TodoDoneParams{Sort: "done", Kinds: []string{AssignmentUnmarked}, Limit: 30}); err != nil || len(none.Workspaces) != 0 {
		t.Fatalf("Done tasks = %+v, err %v", none, err)
	}
}
