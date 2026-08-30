package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	appmodels "github.com/evonotes/server/internal/models"
)

func TestFileReplacementReusesIngestPolicy(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	registry, err := appmodels.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(registry)
	ownerID := newBlobTestUser(t, s, "u_replace_ingest")
	workspace, err := s.CreateWorkspace(
		ctx, ownerID, "Replacement ingest workspace", ColorGreen, []TagRef{},
	)
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.CreateSourceReady(
		ctx, workspace.ID, ownerID, "lesson.pptx", "slides", nil, "", 100,
		"sources/old-presentation",
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE files SET parse_mode='fast',
		caption_images=true WHERE id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	oldJobID := uid("job")
	oldReservationID := uid("cr")
	if _, err := s.pool.Exec(ctx, `INSERT INTO provider_sessions
		(id, actor_user_id, workspace_id, surface, expires_at)
		VALUES ($1,$2,$3,'ingest',now()+interval '1 hour')`,
		oldReservationID, ownerID, workspace.ID); err != nil {
		t.Fatal(err)
	}
	oldPayload, err := json.Marshal(map[string]any{
		"fileId": file.ID, "workspaceId": workspace.ID,
		"sourceRevision": file.Revision, "sourceETag": "old-etag",
		"reservationId": oldReservationID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO jobs
		(id,type,payload,status,attempts,lease_expires_at)
		VALUES ($1,'ingest',$2,'running',1,now()+interval '5 minutes')`,
		oldJobID, oldPayload); err != nil {
		t.Fatal(err)
	}
	audioID := uid("at")
	if _, err := s.pool.Exec(ctx, `INSERT INTO audio_transcriptions
		(id,job_id,file_id,source_sha256,provider_transcription_id,
		 duration_seconds,billable_seconds,concurrency_units,rate_version,
		 credit_micros_per_second,provider_call_id,status)
		VALUES ($1,$2,$3,'old-source','provider-old',10,10,1,1,250000,$4,'pending')`,
		audioID, oldJobID, file.ID, uid("pc")); err != nil {
		t.Fatal(err)
	}
	session, err := s.CreateReplacementUploadSession(ctx, NewReplacementUploadSession{
		ID: uid("up"), FileID: file.ID, CreatedBy: ownerID,
		ObjectPath: "incoming/new-presentation", FinalPath: "sources/new-presentation",
		ContentType:  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		DeclaredSize: 120, ExpectedRevision: file.Revision,
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	replaced, err := s.FinalizeReplacementUploadSession(
		ctx, session.ID, "presentation-etag", "parser", "engine",
	)
	if err != nil {
		t.Fatal(err)
	}
	if replaced.Status != FilePending || replaced.Revision != 2 {
		t.Fatalf("replacement state = %#v", replaced)
	}
	var oldJobStatus, oldJobError, oldReservationStatus string
	if err := s.pool.QueryRow(ctx, `SELECT status, error FROM jobs WHERE id=$1`,
		oldJobID).Scan(&oldJobStatus, &oldJobError); err != nil {
		t.Fatal(err)
	}
	if oldJobStatus != "failed" || oldJobError != "superseded by file replacement" {
		t.Fatalf("old ingest job = %q %q", oldJobStatus, oldJobError)
	}
	if err := s.pool.QueryRow(ctx, `SELECT status FROM provider_sessions WHERE id=$1`,
		oldReservationID).Scan(&oldReservationStatus); err != nil {
		t.Fatal(err)
	}
	if oldReservationStatus != "released" {
		t.Fatalf("old ingest reservation = %q, want released", oldReservationStatus)
	}
	var audioStatus string
	var cleanupRequested bool
	if err := s.pool.QueryRow(ctx, `SELECT status, cleanup_requested
		FROM audio_transcriptions WHERE id=$1`, audioID).Scan(
		&audioStatus, &cleanupRequested,
	); err != nil {
		t.Fatal(err)
	}
	if audioStatus != "failed" || !cleanupRequested {
		t.Fatalf("old audio cleanup = status %q requested %t", audioStatus, cleanupRequested)
	}
	var raw []byte
	if err := s.pool.QueryRow(ctx, `SELECT payload FROM jobs
		WHERE type='ingest' AND payload->>'fileId'=$1 AND status='pending'`, file.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["parseMode"] != "fast" || payload["captionImages"] != true ||
		payload["sourceRevision"] != float64(2) {
		t.Fatalf("replacement ingest payload = %#v", payload)
	}
	plan, ok := payload["processingPlan"].(map[string]any)
	if !ok || plan["version"] != float64(1) || plan["route"] != "document_parse" ||
		plan["captionMode"] != "embedded" || plan["officePreview"] != true {
		t.Fatalf("replacement processing plan = %#v", payload["processingPlan"])
	}
}

func TestFileReplacementPreservesIdentityAndRejectsStaleEditor(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_replace")
	workspace, err := s.CreateWorkspace(
		ctx, ownerID, "Replacement workspace", ColorGreen, []TagRef{},
	)
	if err != nil {
		t.Fatal(err)
	}
	oldPath := "sources/" + uid("old")
	oldPreviewPath := "previews/" + uid("old") + ".pdf"
	file, err := s.CreateSourceReady(
		ctx, workspace.ID, ownerID, "budget.xlsx", "sheet", nil, "", 100, oldPath,
	)
	if err != nil {
		t.Fatal(err)
	}
	contentID := uid("content")
	if _, err := s.pool.Exec(ctx, `UPDATE files SET indexed=true,
		source_sha256='old-source', content_hash='old-content', preview_blob_path=$2
		WHERE id=$1`, file.ID, oldPreviewPath); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO artifact_cache
		(object_path, kind, source_sha256) VALUES ($1, 'office_preview', 'old-source')`,
		oldPreviewPath); err != nil {
		t.Fatal(err)
	}
	if got := blobRefCount(t, s, oldPreviewPath); got != 2 {
		t.Fatalf("preview refs before replacement = %d, want file plus cache", got)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO rag_contents
		(id, workspace_id, content_hash, status) VALUES ($1,$2,'old-content','ready')`,
		contentID, workspace.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO rag_file_contents
		(file_id, workspace_id, content_id) VALUES ($1,$2,$3)`,
		file.ID, workspace.ID, contentID); err != nil {
		t.Fatal(err)
	}

	newReplacement := func(label string) UploadSession {
		t.Helper()
		session, err := s.CreateReplacementUploadSession(ctx, NewReplacementUploadSession{
			ID: uid("up"), FileID: file.ID, CreatedBy: ownerID,
			ObjectPath: "incoming/" + uid(label), FinalPath: "sources/" + uid(label),
			ContentType:  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			DeclaredSize: 150, ExpectedRevision: file.Revision,
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		})
		if err != nil {
			t.Fatal(err)
		}
		return session
	}
	first := newReplacement("first")
	stale := newReplacement("stale")
	usage, err := s.StorageUsage(ctx, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	if usage.ReservedBytes != 100 {
		t.Fatalf("reserved bytes = %d, want two 50-byte growth reservations", usage.ReservedBytes)
	}

	replaced, err := s.FinalizeReplacementUploadSession(
		ctx, first.ID, "new-etag", "parser", "engine",
	)
	if err != nil {
		t.Fatal(err)
	}
	if replaced.ID != file.ID || replaced.Revision != 2 {
		t.Fatalf("replacement identity = %s revision %d", replaced.ID, replaced.Revision)
	}
	if replaced.SizeBytes != 150 || replaced.Indexed || replaced.Status != FileReady {
		t.Fatalf("replacement state = %#v", replaced)
	}
	if replaced.PreviewURL != nil {
		t.Fatalf("replacement retained stale preview URL %q", *replaced.PreviewURL)
	}
	if got := blobRefCount(t, s, oldPreviewPath); got != 1 {
		t.Errorf("preview refs after replacement = %d, want cache only", got)
	}
	if blobQueued(t, s, oldPreviewPath) {
		t.Error("replacement queued a preview still owned by the shared cache")
	}
	blobPath, _, _, _, err := s.FileBlob(ctx, file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if blobPath != first.FinalPath {
		t.Errorf("blob path = %q, want %q", blobPath, first.FinalPath)
	}
	var aliases, contents int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM rag_file_contents WHERE file_id=$1`,
		file.ID).Scan(&aliases); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM rag_contents WHERE id=$1`,
		contentID).Scan(&contents); err != nil {
		t.Fatal(err)
	}
	if aliases != 0 || contents != 0 {
		t.Errorf("old retrieval rows remain: aliases=%d contents=%d", aliases, contents)
	}

	if _, err := s.FinalizeReplacementUploadSession(
		ctx, stale.ID, "stale-etag", "parser", "engine",
	); !errors.Is(err, ErrFileRevisionConflict) {
		t.Fatalf("stale finalize error = %v, want revision conflict", err)
	}
	if err := s.MarkUploadExpired(ctx, stale.ID); err != nil {
		t.Fatal(err)
	}
	usage, err = s.StorageUsage(ctx, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	if usage.UsedBytes != 150 || usage.ReservedBytes != 0 {
		t.Errorf("storage after replacement = used %d reserved %d", usage.UsedBytes, usage.ReservedBytes)
	}
	if !blobQueued(t, s, oldPath) {
		t.Error("replaced source blob was not queued for deletion")
	}
}
