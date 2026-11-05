package store

import (
	"context"
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
	if items := mine.Workspaces[0].Items; len(items) != 1 || items[0].ID != created.ID || items[0].Mine == nil || items[0].Manage != nil {
		t.Fatalf("a member's rows = %+v", items)
	}

	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{"p3": "Water moves in"}, now); err != nil {
		t.Fatal(err)
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
}
