package store

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// newBlobTestUser creates a user that is torn down at the end of the test,
// taking its workspaces and files with it through the cascade.
func newBlobTestUser(t *testing.T, s *Store, label string) string {
	t.Helper()
	ctx := context.Background()
	id := uid(label)
	if _, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email)
		VALUES ($1, 'Blob Test', $2)`, id, fmt.Sprintf("%s@example.test", id)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, id)
	})
	return id
}

func blobRefCount(t *testing.T, s *Store, path string) int {
	t.Helper()
	var count int
	err := s.pool.QueryRow(context.Background(),
		`SELECT COALESCE((SELECT ref_count FROM blobs WHERE object_path=$1), 0)`,
		path).Scan(&count)
	if err != nil {
		t.Fatal(err)
	}
	return count
}

func blobQueued(t *testing.T, s *Store, path string) bool {
	t.Helper()
	var queued bool
	err := s.pool.QueryRow(context.Background(),
		`SELECT EXISTS (SELECT 1 FROM pending_blob_deletions WHERE object_path=$1)`,
		path).Scan(&queued)
	if err != nil {
		t.Fatal(err)
	}
	return queued
}

// TestBlobRefcountQueuesOnlyUnreferencedObjects pins the invariant the whole blob
// layer exists for: an object is queued for deletion exactly when its last
// database reference disappears, no matter how it disappeared. The interesting
// deletions happen through FK cascades where no handler runs, and a shared path
// must survive the loss of one of its holders.
func TestBlobRefcountQueuesOnlyUnreferencedObjects(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_blob")

	ws, err := s.CreateWorkspace(ctx, ownerID, "Blob workspace", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	sharedPath := "sources/" + uid("blob")
	soloPath := "sources/" + uid("blob")

	// Two files naming the same source object, as a workspace clone produces.
	first, err := s.CreateSourceReady(ctx, ws.ID, ownerID, "first.pdf", "pdf",
		nil, "", 100, sharedPath)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateSourceReady(ctx, ws.ID, ownerID, "second.pdf", "pdf",
		nil, "", 100, sharedPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := blobRefCount(t, s, sharedPath); got != 2 {
		t.Fatalf("shared path refs = %d, want 2", got)
	}

	if _, err := s.pool.Exec(ctx, `UPDATE files
		SET blob_path=$2 WHERE id=$1`,
		second.ID, soloPath); err != nil {
		t.Fatal(err)
	}
	// Repointing a file dereferences the old path and references the new one.
	if got := blobRefCount(t, s, sharedPath); got != 1 {
		t.Errorf("shared path refs after repoint = %d, want 1", got)
	}
	if got := blobRefCount(t, s, soloPath); got != 1 {
		t.Errorf("solo path refs = %d, want 1", got)
	}
	if blobQueued(t, s, sharedPath) {
		t.Error("shared path was queued while another file still references it")
	}

	if err := s.DeleteFile(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	if got := blobRefCount(t, s, sharedPath); got != 0 {
		t.Errorf("shared path refs after last holder deleted = %d, want 0", got)
	}
	if !blobQueued(t, s, sharedPath) {
		t.Error("shared path was not queued after its last reference was deleted")
	}

	// A workspace delete is a bare DELETE plus FK cascade: no handler sees the
	// files at all, so the row triggers are the only thing that can queue their
	// objects.
	if err := s.DeleteWorkspace(ctx, ownerID, ws.ID); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{soloPath} {
		if got := blobRefCount(t, s, path); got != 0 {
			t.Errorf("%s refs after workspace delete = %d, want 0", path, got)
		}
		if !blobQueued(t, s, path) {
			t.Errorf("%s was not queued by the workspace cascade", path)
		}
	}
}

func TestArtifactCacheRefsSurviveFileDelete(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_art")
	ws, err := s.CreateWorkspace(ctx, ownerID, "Cache workspace", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	sourcePath := "sources/" + uid("blob")
	captionPath := "captions/" + uid("blob")
	file, err := s.CreateSourceReady(ctx, ws.ID, ownerID, "doc.pdf", "pdf",
		nil, "", 100, sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO artifact_cache
		(object_path, kind, source_sha256) VALUES ($1, 'captions', $2)`,
		captionPath, "abc"); err != nil {
		t.Fatal(err)
	}
	if got := blobRefCount(t, s, captionPath); got != 1 {
		t.Fatalf("caption refs = %d, want 1", got)
	}
	if err := s.DeleteFile(ctx, file.ID); err != nil {
		t.Fatal(err)
	}
	if got := blobRefCount(t, s, captionPath); got != 1 {
		t.Errorf("caption refs after file delete = %d, want 1", got)
	}
	if blobQueued(t, s, captionPath) {
		t.Error("caption cache was queued when its file was deleted")
	}
	n, err := s.SweepArtifactCache(ctx, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	_ = n
	// TTL of 0 is clamped to defaults; force expiry by backdating.
	if _, err := s.pool.Exec(ctx, `UPDATE artifact_cache SET last_used_at = now() - interval '200 days'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SweepArtifactCache(ctx, 90, 6); err != nil {
		t.Fatal(err)
	}
	if got := blobRefCount(t, s, captionPath); got != 0 {
		t.Errorf("caption refs after GC = %d, want 0", got)
	}
	if !blobQueued(t, s, captionPath) {
		t.Error("caption cache was not queued by GC")
	}
}

// TestBlobReferenceCancelsQueuedDeletion pins the resurrection case. A queued
// path can come back into use before the reaper runs, and deleting a live object
// is unrecoverable.
func TestBlobReferenceCancelsQueuedDeletion(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_requeue")

	ws, err := s.CreateWorkspace(ctx, ownerID, "Requeue workspace", ColorBlue, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	path := "sources/" + uid("blob")
	file, err := s.CreateSourceReady(ctx, ws.ID, ownerID, "only.pdf", "pdf",
		nil, "", 10, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteFile(ctx, file.ID); err != nil {
		t.Fatal(err)
	}
	if !blobQueued(t, s, path) {
		t.Fatal("path was not queued after its only reference was deleted")
	}

	if _, err := s.CreateSourceReady(ctx, ws.ID, ownerID, "again.pdf", "pdf",
		nil, "", 10, path); err != nil {
		t.Fatal(err)
	}
	if blobQueued(t, s, path) {
		t.Error("queued deletion survived the path being referenced again")
	}

	// The reaper's own guard is the second line of defence: even a stale queue
	// entry must not take a live object with it.
	if _, err := s.pool.Exec(ctx, `INSERT INTO pending_blob_deletions (object_path)
		VALUES ($1) ON CONFLICT DO NOTHING`, path); err != nil {
		t.Fatal(err)
	}
	claimed, err := s.ClaimBlobDeletions(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, got := range claimed {
		if got == path {
			t.Error("reaper claimed a path that is still referenced")
		}
	}
}

// TestCloneThenDeleteKeepsTheSurvivingCopy pins the leak the refcount was added
// for. Cloning a workspace shares blob objects instead of duplicating them, so
// before the refcount existed a clone-then-delete either leaked the object (no
// handler knew another row still wanted it) or would have destroyed the survivor's
// bytes if the delete had been eager.
func TestCloneThenDeleteKeepsTheSurvivingCopy(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_clonesrc")
	clonerID := newBlobTestUser(t, s, "u_clonedst")

	source, err := s.CreateWorkspace(ctx, ownerID, "Cloneable", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	// Cloning requires read access, which for a non-member means public/link.
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public' WHERE id=$1`,
		source.ID); err != nil {
		t.Fatal(err)
	}
	path := "sources/" + uid("blob")
	if _, err := s.CreateSourceReady(ctx, source.ID, ownerID, "shared.pdf", "pdf",
		nil, "", 2048, path); err != nil {
		t.Fatal(err)
	}

	clone, err := s.CloneWorkspace(ctx, clonerID, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := blobRefCount(t, s, path); got != 2 {
		t.Fatalf("refs after clone = %d, want the original and the clone", got)
	}

	if err := s.DeleteWorkspace(ctx, ownerID, source.ID); err != nil {
		t.Fatal(err)
	}
	if got := blobRefCount(t, s, path); got != 1 {
		t.Errorf("refs after deleting the original = %d, want the clone's", got)
	}
	if blobQueued(t, s, path) {
		t.Error("the clone's object was queued for deletion with the original")
	}

	if err := s.DeleteWorkspace(ctx, clonerID, clone.ID); err != nil {
		t.Fatal(err)
	}
	if !blobQueued(t, s, path) {
		t.Error("object was not queued once no workspace referenced it")
	}
}

// TestAbandonedUploadQueuesBothPaths pins upload cleanup. An expired reservation
// has to release its bytes and hand over both the incoming and the promoted path,
// since a presigned PUT can land on either one after the session is written off.
func TestAbandonedUploadQueuesBothPaths(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_upload")

	ws, err := s.CreateWorkspace(ctx, ownerID, "Upload workspace", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	session, err := s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), WorkspaceID: ws.ID, CreatedBy: ownerID,
		ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "abandoned.pdf", Kind: "pdf", ContentType: "application/pdf",
		DeclaredSize: 4096, ParseMode: "none",
		// Already past its window, so the sweep picks it up immediately.
		ExpiresAt: time.Now().UTC().Add(-time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	before, err := s.StorageUsage(ctx, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	if before.ReservedBytes != 4096 {
		t.Fatalf("reserved bytes = %d, want the declared 4096", before.ReservedBytes)
	}

	swept, err := s.SweepExpiredUploads(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if swept != 1 {
		t.Fatalf("swept = %d, want 1", swept)
	}
	after, err := s.StorageUsage(ctx, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	if after.ReservedBytes != 0 {
		t.Errorf("reserved bytes after sweep = %d, want 0", after.ReservedBytes)
	}
	for _, path := range []string{session.ObjectPath, session.FinalPath} {
		if !blobQueued(t, s, path) {
			t.Errorf("%s was not queued for an abandoned upload", path)
		}
	}
	// Queued behind the presign window, so a PUT still in flight is collected
	// rather than left behind as an untracked object.
	claimed, err := s.ClaimBlobDeletions(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, got := range claimed {
		if got == session.ObjectPath || got == session.FinalPath {
			t.Errorf("%s was claimed before its presign window closed", got)
		}
	}
}
