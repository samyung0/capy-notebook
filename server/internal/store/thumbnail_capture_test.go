package store

import (
	"context"
	"testing"
	"time"
)

// A browser capture lands on a live file only: a file trashed after the
// bucket write takes nothing, and the new key goes to the deletion outbox at
// once instead of waiting for the orphan sweep.
func TestSetFileThumbnailQueuesAKeyNoFileTakes(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_capture")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Captures", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.createReadyFile(ctx, ws.ID, ownerID, "deck.pptx", "slides", nil, "", 100,
		"sources/"+uid("blob"))
	if err != nil {
		t.Fatal(err)
	}
	live := "thumbs/" + file.ID + "/" + uid("sha") + ".webp"
	if err := s.SetFileThumbnail(ctx, file.ID, live); err != nil {
		t.Fatal(err)
	}
	if got := blobRefCount(t, s, live); got != 1 {
		t.Fatalf("live capture refs = %d, want 1", got)
	}
	if _, err := s.TrashFile(ctx, ownerID, file.ID, AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	late := "thumbs/" + file.ID + "/" + uid("sha") + ".webp"
	if err := s.SetFileThumbnail(ctx, file.ID, late); err != nil {
		t.Fatal(err)
	}
	if !blobQueued(t, s, late) {
		t.Fatal("a capture of a trashed file was not queued for deletion")
	}
	if blobQueued(t, s, live) {
		t.Fatal("the trashed file's own thumbnail was queued")
	}
}

// Open lists pick a capture up through the workspace tree event on
// thumbnail_key (migration 0073); claiming the capture interval stays silent.
func TestThumbnailCaptureRaisesOneTreeEvent(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ownerID := newBlobTestUser(t, s, "u_capture_event")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Capture events", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.createReadyFile(ctx, ws.ID, ownerID, "sheet.xlsx", "sheet", nil, "", 100,
		"sources/"+uid("blob"))
	if err != nil {
		t.Fatal(err)
	}
	events := make(chan string, 8)
	listening := make(chan struct{})
	failed := make(chan error, 1)
	go func() {
		failed <- s.ListenWorkspaceTree(ctx, func() { close(listening) }, func(workspaceID, kind string) {
			if workspaceID == ws.ID {
				events <- kind
			}
		})
	}()
	select {
	case <-listening:
	case err := <-failed:
		t.Fatal(err)
	}
	if err := s.ClaimThumbnailCapture(ctx, file.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.SetFileThumbnail(ctx, file.ID, "thumbs/"+file.ID+"/"+uid("sha")+".webp"); err != nil {
		t.Fatal(err)
	}
	select {
	case kind := <-events:
		if kind != "files" {
			t.Fatalf("tree event kind = %q", kind)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no tree event for the capture")
	}
	select {
	case kind := <-events:
		t.Fatalf("a second tree event (%q): the interval claim is not silent", kind)
	case <-time.After(300 * time.Millisecond):
	}
}

// An Office file's card is stale once a saved change is newer than its last
// accepted capture; with no capture yet (ingest's render of the upload), once
// any change is saved. An open session without a saved change is not.
func TestThumbnailStaleFollowsTheLastSavedChange(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "stale_owner")
	_, file := sourceTestFile(t, s, owner, "plan.docx", "doc")
	stale := func(want bool, what string) {
		t.Helper()
		if got, err := s.ThumbnailStale(ctx, file.ID); err != nil || got != want {
			t.Fatalf("%s: stale = %v %v, want %v", what, got, err, want)
		}
	}
	stale(false, "never opened")
	doc := sourceTestSeed(t, s, owner, file.ID)
	stale(false, "opened, nothing saved")
	save := func() {
		t.Helper()
		if _, err := s.SaveSourceCheckpoint(ctx, file.ID, sourceTestSave(doc, owner, "state-"+uid("s"))); err != nil {
			t.Fatal(err)
		}
		var err error
		if doc, err = s.SourceSession(ctx, owner, file.ID); err != nil {
			t.Fatal(err)
		}
	}
	save()
	stale(true, "no capture, a saved change")
	if err := s.ClaimThumbnailCapture(ctx, file.ID); err != nil {
		t.Fatal(err)
	}
	stale(false, "captured after the last change")
	save()
	stale(true, "a change saved after the capture")
}
