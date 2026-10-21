package store

import (
	"context"
	"errors"
	"testing"
)

// Security regression (human frontend error-handling, 2026-10-21): Auto
// process is the owner's alone. An editor's update carrying it is refused and
// changes nothing, while the editor keeps the other settings and the owner
// keeps the switch.
func TestOnlyTheOwnerChangesAutoProcess(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_auto_owner")
	editor := newBlobTestUser(t, s, "u_auto_editor")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Auto process", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(context.Background(), owner, ws.ID) })
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor')`, ws.ID, editor); err != nil {
		t.Fatal(err)
	}
	off, renamed := false, "Renamed by the editor"
	autoProcess := func() bool {
		t.Helper()
		var on bool
		if err := s.pool.QueryRow(ctx, `SELECT auto_process FROM workspaces WHERE id=$1`, ws.ID).Scan(&on); err != nil {
			t.Fatal(err)
		}
		return on
	}
	if _, err := s.UpdateWorkspace(ctx, editor, ws.ID, WorkspacePatch{AutoProcess: &off, Name: &renamed}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("an editor's auto process update: %v, want ErrForbidden", err)
	}
	if !autoProcess() {
		t.Fatal("the refused update changed auto process")
	}
	if got, err := s.UpdateWorkspace(ctx, editor, ws.ID, WorkspacePatch{Name: &renamed}); err != nil || got.Name != renamed {
		t.Fatalf("an editor's rename: %v (%q)", err, got.Name)
	}
	if _, err := s.UpdateWorkspace(ctx, owner, ws.ID, WorkspacePatch{AutoProcess: &off}); err != nil || autoProcess() {
		t.Fatalf("the owner's auto process update: %v, on=%v", err, autoProcess())
	}
}
