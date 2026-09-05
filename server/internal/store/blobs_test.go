package store

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
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

	if err := s.DeleteFile(ctx, ownerID, first.ID); err != nil {
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
	parseBundlePath := "parse-bundles/" + uid("blob") + ".zip"
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
	if _, err := s.pool.Exec(ctx, `INSERT INTO artifact_cache
		(object_path, kind, source_sha256) VALUES ($1, 'parse_bundle', $2)`,
		parseBundlePath, "abc"); err != nil {
		t.Fatal(err)
	}
	if got := blobRefCount(t, s, captionPath); got != 1 {
		t.Fatalf("caption refs = %d, want 1", got)
	}
	if got := blobRefCount(t, s, parseBundlePath); got != 1 {
		t.Fatalf("parse bundle refs = %d, want 1", got)
	}
	if err := s.DeleteFile(ctx, ownerID, file.ID); err != nil {
		t.Fatal(err)
	}
	if got := blobRefCount(t, s, captionPath); got != 1 {
		t.Errorf("caption refs after file delete = %d, want 1", got)
	}
	if blobQueued(t, s, captionPath) {
		t.Error("caption cache was queued when its file was deleted")
	}
	if blobQueued(t, s, parseBundlePath) {
		t.Error("parse bundle cache was queued when its file was deleted")
	}
	n, err := s.SweepArtifactCache(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	_ = n
	// TTL of 0 is clamped to defaults; force expiry by backdating.
	if _, err := s.pool.Exec(ctx, `UPDATE artifact_cache SET last_used_at = now() - interval '200 days'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SweepArtifactCache(ctx, 90); err != nil {
		t.Fatal(err)
	}
	if got := blobRefCount(t, s, captionPath); got != 0 {
		t.Errorf("caption refs after GC = %d, want 0", got)
	}
	if !blobQueued(t, s, captionPath) {
		t.Error("caption cache was not queued by GC")
	}
	if got := blobRefCount(t, s, parseBundlePath); got != 0 {
		t.Errorf("parse bundle refs after GC = %d, want 0", got)
	}
	if !blobQueued(t, s, parseBundlePath) {
		t.Error("parse bundle cache was not queued by GC")
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
	if err := s.DeleteFile(ctx, ownerID, file.ID); err != nil {
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
	defer s.ReleaseBlobDeletionClaims(claimed)
	for _, got := range claimed {
		if got.ObjectPath == path {
			t.Error("reaper claimed a path that is still referenced")
		}
	}
}

func TestExpiredBlobDeletionClaimCannotBeResurrected(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_claimed_blob")
	workspace, err := s.CreateWorkspace(ctx, ownerID, "Claimed blob", ColorBlue, nil)
	if err != nil {
		t.Fatal(err)
	}
	path := "sources/" + uid("claimed")
	if _, err := s.pool.Exec(ctx, `INSERT INTO pending_blob_deletions
		(object_path,not_before) VALUES ($1,now()-interval '100 years')`, path); err != nil {
		t.Fatal(err)
	}
	claims, err := s.ClaimBlobDeletions(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || claims[0].ObjectPath != path {
		t.Fatalf("claims = %#v, want %q", claims, path)
	}
	if err := s.RecordBlobDeletionUncertain(ctx, claims, "response lost"); err != nil {
		t.Fatal(err)
	}
	var retainedToken *string
	if err := s.pool.QueryRow(ctx, `SELECT claim_token
		FROM pending_blob_deletions WHERE object_path=$1`, path).Scan(&retainedToken); err != nil {
		t.Fatal(err)
	}
	if retainedToken == nil || *retainedToken != claims[0].Token {
		t.Fatalf("uncertain delete cleared claim fence: token=%v", retainedToken)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE pending_blob_deletions
		SET claim_expires_at=now()-interval '1 second', not_before=now()-interval '100 years'
		WHERE object_path=$1`, path); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateSourceReady(ctx, workspace.ID, ownerID, "missing.pdf", "pdf",
		nil, "", 10, path); err == nil {
		t.Fatal("expired claimed path was allowed to become live again")
	}
	reclaimed, err := s.ClaimBlobDeletions(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(reclaimed) != 1 || reclaimed[0].ObjectPath != path ||
		reclaimed[0].Token == claims[0].Token {
		t.Fatalf("reclaimed = %#v, want a fresh claim for %q", reclaimed, path)
	}
	s.ReleaseBlobDeletionClaims(reclaimed)
}

func TestBlobDeletionClaimHoldsPathLockThroughSettlement(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	path := "sources/" + uid("locked-delete")
	if _, err := s.pool.Exec(ctx, `INSERT INTO pending_blob_deletions
		(object_path,not_before) VALUES ($1,now()-interval '1 day')`, path); err != nil {
		t.Fatal(err)
	}
	claims, err := s.ClaimBlobDeletions(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || claims[0].ObjectPath != path {
		t.Fatalf("claims = %#v, want %q", claims, path)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout='100ms'`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT blob_ref($1)`, path); err == nil {
		t.Fatal("blob_ref did not wait for the reaper's path lock")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	if err := s.RecordBlobDeletionUncertain(ctx, claims, "response lost"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `SELECT blob_ref($1)`, path); err == nil {
		t.Fatal("uncertain remote delete allowed the path to become live")
	}
}

func TestBlobDeletionClaimSkipsReferenceTransactionAlreadyInFlight(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	path := "sources/" + uid("inflight-ref")
	if _, err := s.pool.Exec(ctx, `INSERT INTO pending_blob_deletions
		(object_path,not_before) VALUES ($1,now()-interval '1 day')`, path); err != nil {
		t.Fatal(err)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, path); err != nil {
		t.Fatal(err)
	}
	claims, err := s.ClaimBlobDeletions(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 0 {
		s.ReleaseBlobDeletionClaims(claims)
		t.Fatalf("reaper claimed path locked by an in-flight reference: %#v", claims)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	claims, err = s.ClaimBlobDeletions(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || claims[0].ObjectPath != path {
		s.ReleaseBlobDeletionClaims(claims)
		t.Fatalf("claims after reference transaction ended = %#v, want %q", claims, path)
	}
	if err := s.FinishBlobDeletions(ctx, claims); err != nil {
		t.Fatal(err)
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
	previewPath := "previews/" + uid("blob") + ".pdf"
	file, err := s.CreateSourceReady(ctx, source.ID, ownerID, "shared.pptx", "slides",
		nil, "", 2048, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE files SET preview_blob_path=$2 WHERE id=$1`,
		file.ID, previewPath); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO artifact_cache
		(object_path, kind, source_sha256) VALUES ($1, 'office_preview', 'clone-source')`,
		previewPath); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"pending", "processing", "failed"} {
		if _, err := s.pool.Exec(ctx, `INSERT INTO files
			(id, workspace_id, user_id, created_by, name, status, size_bytes)
			VALUES ($1,$2,$3,$3,$4,$5,0)`, uid("f"), source.ID, ownerID,
			status+".pdf", status); err != nil {
			t.Fatal(err)
		}
	}
	readyAssetID := uid("asset")
	pendingAssetID := uid("asset")
	if _, err := s.pool.Exec(ctx, `INSERT INTO editor_assets
		(id,workspace_id,user_id,created_by,name,purpose,object_path,content_type,
		 size_bytes,status,completed_at)
		VALUES
		($1,$3,$4,$4,'ready.png','image',$5,'image/png',10,'ready',now()),
		($2,$3,$4,$4,'pending.png','image',$6,'image/png',10,'pending',NULL)`,
		readyAssetID, pendingAssetID, source.ID, ownerID,
		"editor/"+readyAssetID, "editor/"+pendingAssetID); err != nil {
		t.Fatal(err)
	}
	materialContent, err := materialdoc.Marshal(materialdoc.Envelope{
		SchemaVersion: materialdoc.SchemaVersion,
		Value: []map[string]any{
			{"type": "p", "id": "text", "children": []any{map[string]any{"text": "kept"}}},
			{"type": "img", "id": "ready-media", "assetId": readyAssetID,
				"children": []any{map[string]any{"text": ""}}},
			{"type": "img", "id": "pending-media", "assetId": pendingAssetID,
				"children": []any{map[string]any{"text": ""}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: source.ID, WorkspaceName: source.Name,
		Kind: "note", Title: "Clone history boundary",
		Content: materialContent,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE material_revisions
		SET version_date=current_date-1, created_at=now()-interval '1 day'
		WHERE material_id=$1`, material.ID); err != nil {
		t.Fatal(err)
	}
	updatedDocument, err := materialdoc.Parse(materialContent)
	if err != nil {
		t.Fatal(err)
	}
	updatedDocument.Value[0]["children"] = []any{map[string]any{"text": "updated"}}
	updatedContent, err := materialdoc.Marshal(updatedDocument)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateMaterial(ctx, material.ID, MaterialPatch{
		Content: &updatedContent, UpdatedBy: ownerID,
	}); err != nil {
		t.Fatal(err)
	}

	clone, err := s.CloneWorkspace(ctx, clonerID, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := blobRefCount(t, s, path); got != 2 {
		t.Fatalf("refs after clone = %d, want the original and the clone", got)
	}
	if got := blobRefCount(t, s, previewPath); got != 3 {
		t.Fatalf("preview refs after clone = %d, want cache plus both files", got)
	}
	var clonedPreview *string
	if err := s.pool.QueryRow(ctx, `SELECT preview_blob_path FROM files
		WHERE workspace_id=$1 AND preview_blob_path IS NOT NULL`, clone.ID).Scan(&clonedPreview); err != nil {
		t.Fatal(err)
	}
	if clonedPreview == nil || *clonedPreview != previewPath {
		t.Fatalf("clone preview = %v, want %q", clonedPreview, previewPath)
	}
	var clonedFileCount, unfinishedFileCount int
	if err := s.pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (
		WHERE status IN ('pending','processing')) FROM files WHERE workspace_id=$1`,
		clone.ID).Scan(&clonedFileCount, &unfinishedFileCount); err != nil {
		t.Fatal(err)
	}
	if clonedFileCount != 1 || unfinishedFileCount != 0 {
		t.Fatalf("clone files = %d with %d unfinished, want ready only",
			clonedFileCount, unfinishedFileCount)
	}
	var clonedMaterialID string
	var clonedRevision int64
	if err := s.pool.QueryRow(ctx, `SELECT id, revision FROM materials
		WHERE workspace_id=$1 AND title='Clone history boundary'`, clone.ID).
		Scan(&clonedMaterialID, &clonedRevision); err != nil {
		t.Fatal(err)
	}
	var clonedHistory int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM material_revisions
		WHERE material_id=$1`, clonedMaterialID).Scan(&clonedHistory); err != nil {
		t.Fatal(err)
	}
	if clonedRevision != 2 || clonedHistory != 2 {
		t.Fatalf("cloned material revision=%d history=%d, want retained source history",
			clonedRevision, clonedHistory)
	}
	var clonedAssetID string
	if err := s.pool.QueryRow(ctx, `SELECT id FROM editor_assets WHERE workspace_id=$1`,
		clone.ID).Scan(&clonedAssetID); err != nil {
		t.Fatal(err)
	}
	var clonedContent string
	if err := s.pool.QueryRow(ctx, `SELECT content::text FROM materials WHERE id=$1`,
		clonedMaterialID).Scan(&clonedContent); err != nil {
		t.Fatal(err)
	}
	if clonedAssetID == readyAssetID || !strings.Contains(clonedContent, clonedAssetID) {
		t.Fatalf("ready editor asset was not cloned and rewritten: id=%q content=%s",
			clonedAssetID, clonedContent)
	}
	if strings.Contains(clonedContent, pendingAssetID) || strings.Contains(clonedContent, "pending-media") {
		t.Fatalf("pending editor asset reference survived clone: %s", clonedContent)
	}
	rows, err := s.pool.Query(ctx, `SELECT content::text FROM material_revisions
		WHERE material_id=$1 ORDER BY version_date`, clonedMaterialID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var historyContent string
		if err := rows.Scan(&historyContent); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(historyContent, clonedAssetID) ||
			strings.Contains(historyContent, readyAssetID) ||
			strings.Contains(historyContent, pendingAssetID) {
			t.Fatalf("cloned history asset rewrite failed: %s", historyContent)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
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
	if got := blobRefCount(t, s, previewPath); got != 2 {
		t.Errorf("preview refs after deleting original = %d, want cache plus clone", got)
	}

	if err := s.DeleteWorkspace(ctx, clonerID, clone.ID); err != nil {
		t.Fatal(err)
	}
	if !blobQueued(t, s, path) {
		t.Error("object was not queued once no workspace referenced it")
	}
	if got := blobRefCount(t, s, previewPath); got != 1 {
		t.Errorf("preview refs after deleting clone = %d, want cache only", got)
	}
	if blobQueued(t, s, previewPath) {
		t.Error("preview was queued while its cache reference remained")
	}
	if _, err := s.pool.Exec(ctx, `UPDATE artifact_cache
		SET last_used_at=now() - interval '200 days' WHERE object_path=$1`,
		previewPath); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SweepArtifactCache(ctx, 90); err != nil {
		t.Fatal(err)
	}
	if got := blobRefCount(t, s, previewPath); got != 0 {
		t.Errorf("preview refs after cache expiry = %d, want 0", got)
	}
	if !blobQueued(t, s, previewPath) {
		t.Error("preview was not queued after its file and cache references expired")
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
	defer s.ReleaseBlobDeletionClaims(claimed)
	for _, got := range claimed {
		if got.ObjectPath == session.ObjectPath || got.ObjectPath == session.FinalPath {
			t.Errorf("%s was claimed before its presign window closed", got.ObjectPath)
		}
	}
}
