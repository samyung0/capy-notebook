package store

import (
	"context"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// treeEvents listens for one workspace's tree events: next returns the kind of
// the next one, quiet fails on any within 300 ms.
func treeEvents(t *testing.T, s *Store, workspaceID string) (next func() string, quiet func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	// NOTIFY is database-wide, so only this workspace's events count: another
	// package's test may be writing (or cleaning up) rows on the same
	// disposable database at the same time.
	events := make(chan string, 16)
	listening := make(chan struct{})
	go func() {
		_ = s.ListenWorkspaceTree(ctx, func() { close(listening) }, func(wsID, kind string) {
			if wsID == workspaceID {
				events <- kind
			}
		})
	}()
	select {
	case <-listening:
	case <-time.After(5 * time.Second):
		t.Fatal("listener never attached")
	}
	next = func() string {
		t.Helper()
		select {
		case kind := <-events:
			return kind
		case <-time.After(5 * time.Second):
			t.Fatal("no tree event")
			return ""
		}
	}
	quiet = func() {
		t.Helper()
		select {
		case kind := <-events:
			t.Fatalf("unexpected %s tree event", kind)
		case <-time.After(300 * time.Millisecond):
		}
	}
	return next, quiet
}

// The triggers must raise one event per list-visible write on either table
// and stay silent for a content-only material save, which is what every
// collaboration checkpoint is.
func TestWorkspaceTreeNotifiesListVisibleWrites(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_tree")
	workspace, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Tree events", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(context.Background(), ownerID, workspace.ID) })
	next, quiet := treeEvents(t, s, workspace.ID)

	// Blob paths are reference-counted across the shared test database; a
	// path another test released may still be mid-deletion.
	file, err := s.createReadyFile(ctx, workspace.ID, ownerID, "notes.md", "md", nil, "", 10, "sources/"+workspace.ID+"/notes.md")
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
		Content: materialTestContent(t, "# n"), Privacy: "private",
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

// Hiding an item from members or showing it again, and sharing a canvas or
// taking it back, change who lists it, so each raises its workspace's event:
// a file's as `files`, a material's and a canvas's (which sits in no
// workspace, migration 0189) as `materials`.
func TestWorkspaceTreeNotifiesHidingAndCanvasSharing(t *testing.T) {
	f := newCanvasFixture(t, "tree-access")
	ctx := context.Background()
	next, _ := treeEvents(t, f.s, f.ws.ID)
	expect := func(want, what string) {
		t.Helper()
		if got := next(); got != want {
			t.Fatalf("%s raised %q, want %q", what, got, want)
		}
	}

	file, err := f.s.createReadyFile(ctx, f.ws.ID, f.user, "hide.md", "md", nil, "", 10, "sources/"+f.ws.ID+"/hide.md")
	if err != nil {
		t.Fatal(err)
	}
	expect("files", "the file's insert")
	material, err := f.s.CreateMaterial(ctx, Material{
		CreatedBy: f.user, WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Kind: "note", Title: "hide",
		Content: materialTestContent(t, "# hide"), Privacy: "private",
	})
	if err != nil {
		t.Fatal(err)
	}
	expect("materials", "the note's insert")
	for _, hidden := range []bool{true, false} {
		if err := f.s.SetItemHidden(ctx, f.editor, agenttools.KindSourceFile, file.ID, hidden); err != nil {
			t.Fatal(err)
		}
		expect("files", "a file's hidden switch")
		if err := f.s.SetItemHidden(ctx, f.editor, agenttools.KindMaterial, material.ID, hidden); err != nil {
			t.Fatal(err)
		}
		expect("materials", "a note's hidden switch")
	}

	canvas := f.canvas(t, f.editor, false)
	expect("materials", "the canvas's insert")
	for _, shared := range []bool{true, false} {
		if _, err := f.s.SetCanvasShared(ctx, f.editor, canvas.ID, shared); err != nil {
			t.Fatal(err)
		}
		expect("materials", "a canvas's sharing")
	}
}
