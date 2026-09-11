package store

import (
	"context"
	"testing"
	"time"
)

// The triggers must raise one event per list-visible write on either table
// and stay silent for a content-only material save, which is what every
// collaboration checkpoint is.
func TestWorkspaceTreeNotifiesListVisibleWrites(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ownerID := newBlobTestUser(t, s, "u_tree")
	workspace, err := s.CreateWorkspace(ctx, ownerID, "Tree events", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(context.Background(), ownerID, workspace.ID) })

	// NOTIFY is database-wide, so only this workspace's events count: another
	// package's test may be writing (or cleaning up) rows on the same
	// disposable database at the same time.
	events := make(chan string, 16)
	listening := make(chan struct{})
	go func() {
		_ = s.ListenWorkspaceTree(ctx, func() { close(listening) }, func(wsID, kind string) {
			if wsID == workspace.ID {
				events <- kind
			}
		})
	}()
	select {
	case <-listening:
	case <-time.After(5 * time.Second):
		t.Fatal("listener never attached")
	}
	next := func() string {
		t.Helper()
		select {
		case kind := <-events:
			return kind
		case <-time.After(5 * time.Second):
			t.Fatal("no tree event")
			return ""
		}
	}
	quiet := func() {
		t.Helper()
		select {
		case kind := <-events:
			t.Fatalf("unexpected %s tree event", kind)
		case <-time.After(300 * time.Millisecond):
		}
	}

	file, err := s.CreateSourceReady(ctx, workspace.ID, ownerID, "notes.md", "md", nil, "", 10, "sources/notes")
	if err != nil {
		t.Fatal(err)
	}
	if got := next(); got != "files" {
		t.Fatalf("insert raised %q", got)
	}
	name := "renamed.md"
	if _, err := s.UpdateFile(ctx, ownerID, file.ID, FilePatch{Name: &name}); err != nil {
		t.Fatal(err)
	}
	if got := next(); got != "files" {
		t.Fatalf("rename raised %q", got)
	}

	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: workspace.ID, WorkspaceName: workspace.Name, Kind: "note", Title: "n",
		Content: "# n", Privacy: "private",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := next(); got != "materials" {
		t.Fatalf("material insert raised %q", got)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET content='{"schemaVersion":1,"value":[]}', revision=revision+1 WHERE id=$1`, material.ID); err != nil {
		t.Fatal(err)
	}
	quiet()
}
