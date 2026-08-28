package store

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestSourceImportRequestReplaysCompletedResponse(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, owner, job := newSourceImportTestJob(t, s, 10, 20)
	requestID := uid("ireq")
	if response, complete, err := s.BeginSourceImportRequest(
		ctx, owner, job.WorkspaceID, requestID, "fingerprint",
	); err != nil || complete || response != nil {
		t.Fatalf("begin response=%s complete=%v err=%v", response, complete, err)
	}
	want := json.RawMessage(`{"jobs":[],"rejected":[{"fileId":"missing","code":"unsupported_file"}]}`)
	stored, err := s.CompleteSourceImportRequest(
		ctx, owner, requestID, "fingerprint", want,
	)
	var wantValue, storedValue any
	if err == nil {
		err = json.Unmarshal(want, &wantValue)
	}
	if err == nil {
		err = json.Unmarshal(stored, &storedValue)
	}
	if err != nil || !reflect.DeepEqual(storedValue, wantValue) {
		t.Fatalf("complete response=%s err=%v", stored, err)
	}
	replayed, complete, err := s.BeginSourceImportRequest(
		ctx, owner, job.WorkspaceID, requestID, "fingerprint",
	)
	var replayedValue any
	if err == nil {
		err = json.Unmarshal(replayed, &replayedValue)
	}
	if err != nil || !complete || !reflect.DeepEqual(replayedValue, wantValue) {
		t.Fatalf("replay response=%s complete=%v err=%v", replayed, complete, err)
	}
	if _, _, err := s.BeginSourceImportRequest(
		ctx, owner, job.WorkspaceID, requestID, "different",
	); !errors.Is(err, ErrImportIdempotencyConflict) {
		t.Fatalf("fingerprint conflict err=%v", err)
	}
}

func newSourceImportTestJob(
	t *testing.T,
	s *Store,
	declaredSize, maxBytes int64,
) (context.Context, string, SourceImportJob) {
	t.Helper()
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_import")
	ws, err := s.CreateWorkspace(
		ctx, owner, "Import jobs", ColorGreen, []TagRef{},
	)
	if err != nil {
		t.Fatal(err)
	}
	uploadID := uid("up")
	jobID := uid("imp")
	created, err := s.CreateSourceImports(ctx, []NewSourceImport{{
		JobID: jobID,
		Upload: NewUploadSession{
			ID: uploadID, WorkspaceID: ws.ID, CreatedBy: owner,
			ObjectPath: "incoming/" + uploadID + "/file.pdf",
			FinalPath:  "sources/" + uid("blob") + ".pdf",
			Name:       "file.pdf", Kind: "pdf", ContentType: "application/pdf",
			DeclaredSize: declaredSize, ParseMode: "none",
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
		Provider: "google", ProviderFileID: "drive-file",
		MaxBytes: maxBytes, IdempotencyKey: uid("ireq"), TraceID: "trace",
	}})
	if err != nil {
		t.Fatal(err)
	}
	return ctx, owner, created[0]
}

func TestSourceImportOutboxLeaseAndFailureReleaseReservation(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, owner, job := newSourceImportTestJob(t, s, 1000, 2000)

	replayed, err := s.CreateSourceImports(ctx, []NewSourceImport{{
		JobID: uid("imp"),
		Upload: NewUploadSession{
			ID: uid("up"), WorkspaceID: job.WorkspaceID, CreatedBy: owner,
			ObjectPath: "incoming/replay/file.pdf", FinalPath: "sources/replay.pdf",
			Name: job.Name, Kind: job.Kind, ContentType: job.ContentType,
			DeclaredSize: job.DeclaredSize, ParseMode: "none",
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
		Provider: job.Provider, ProviderFileID: job.ProviderFileID,
		ProviderDriveID: job.ProviderDriveID, MaxBytes: job.MaxBytes,
		IdempotencyKey: job.IdempotencyKey,
	}})
	if err != nil || len(replayed) != 1 || replayed[0].ID != job.ID {
		t.Fatalf("idempotent replay=%+v err=%v", replayed, err)
	}

	dispatches, err := s.PendingSourceImportDispatches(ctx, 10)
	if err != nil || len(dispatches) != 1 || dispatches[0].JobID != job.ID {
		t.Fatalf("dispatches=%v err=%v", dispatches, err)
	}
	if err := s.MarkSourceImportEnqueued(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	dispatches, err = s.PendingSourceImportDispatches(ctx, 10)
	if err != nil || len(dispatches) != 0 {
		t.Fatalf("enqueued dispatches=%v err=%v", dispatches, err)
	}

	claimed, err := s.AcquireSourceImport(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Status != "running" || claimed.LeaseToken == "" ||
		claimed.Attempts != 1 || claimed.AttemptObjectPath == "" ||
		claimed.AttemptObjectPath == claimed.ObjectPath {
		t.Fatalf("claim=%+v", claimed)
	}
	if _, err := s.AcquireSourceImport(ctx, job.ID); !errors.Is(err, ErrImportNotReady) {
		t.Fatalf("duplicate acquire err=%v", err)
	}
	if err := s.DeadLetterSourceImport(
		ctx, job.ID, "queue_retries_exhausted", "duplicate delivery exhausted",
	); !errors.Is(err, ErrImportNotReady) {
		t.Fatalf("DLQ replaced a live attempt: %v", err)
	}
	if _, err := s.PrepareSourceImportUpload(
		ctx, job.ID, "stale-token", 400,
	); !errors.Is(err, ErrImportLeaseLost) {
		t.Fatalf("stale prepare err=%v", err)
	}
	prepared, err := s.PrepareSourceImportUpload(
		ctx, job.ID, claimed.LeaseToken, 400,
	)
	if err != nil || prepared.DeclaredSize != 400 {
		t.Fatalf("prepared=%+v err=%v", prepared, err)
	}
	usage, err := s.StorageUsage(ctx, owner)
	if err != nil || usage.ReservedBytes != 400 {
		t.Fatalf("usage=%+v err=%v", usage, err)
	}

	if err := s.MarkSourceImportFailed(
		ctx, job.ID, claimed.LeaseToken,
		"provider_download_refused", "download refused",
	); err != nil {
		t.Fatal(err)
	}
	usage, err = s.StorageUsage(ctx, owner)
	if err != nil || usage.ReservedBytes != 0 {
		t.Fatalf("released usage=%+v err=%v", usage, err)
	}
	failed, err := s.GetSourceImportByID(ctx, job.ID)
	if err != nil || failed.Status != "failed" ||
		failed.LastErrorCode != "provider_download_refused" {
		t.Fatalf("failed=%+v err=%v", failed, err)
	}
}

func TestSourceImportDeadLetterIsIdempotent(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, owner, job := newSourceImportTestJob(t, s, 800, 800)

	for range 2 {
		if err := s.DeadLetterSourceImport(
			ctx, job.ID, "queue_retries_exhausted", "retries exhausted",
		); err != nil {
			t.Fatal(err)
		}
	}
	usage, err := s.StorageUsage(ctx, owner)
	if err != nil || usage.ReservedBytes != 0 {
		t.Fatalf("usage=%+v err=%v", usage, err)
	}
	failed, err := s.GetSourceImportByID(ctx, job.ID)
	if err != nil || failed.Status != "failed" {
		t.Fatalf("failed=%+v err=%v", failed, err)
	}
}

func TestSourceImportFinalizeRejectsReplacedAttemptAtomically(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, _, job := newSourceImportTestJob(t, s, 400, 800)

	first, err := s.AcquireSourceImport(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE source_import_jobs
		SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, job.ID); err != nil {
		t.Fatal(err)
	}
	second, err := s.AcquireSourceImport(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if first.AttemptObjectPath == second.AttemptObjectPath {
		t.Fatal("replacement attempt reused the incoming object path")
	}
	if _, err := s.FenceSourceImportCompletion(
		ctx, job.ID, first.LeaseToken,
	); !errors.Is(err, ErrImportLeaseLost) {
		t.Fatalf("stale completion fence err=%v", err)
	}
	if _, err := s.FenceSourceImportCompletion(
		ctx, job.ID, second.LeaseToken,
	); err != nil {
		t.Fatalf("current completion fence err=%v", err)
	}
	if _, err := s.FinalizeSourceImport(
		ctx, job.ID, first.LeaseToken, "etag-stale", "default", "default",
	); !errors.Is(err, ErrImportLeaseLost) {
		t.Fatalf("stale finalize err=%v", err)
	}
	upload, err := s.GetUploadSession(ctx, job.UploadSessionID)
	if err != nil || upload.Status != "pending" || upload.FileID != nil {
		t.Fatalf("stale attempt mutated upload: upload=%+v err=%v", upload, err)
	}

	file, err := s.FinalizeSourceImport(
		ctx, job.ID, second.LeaseToken, "etag-current", "default", "default",
	)
	if err != nil {
		t.Fatal(err)
	}
	completed, err := s.GetSourceImportByID(ctx, job.ID)
	if err != nil || completed.Status != "succeeded" ||
		completed.FileID == nil || *completed.FileID != file.ID {
		t.Fatalf("completed=%+v file=%+v err=%v", completed, file, err)
	}
}

func TestSourceImportExpiredLeaseIsDurablyRedispatched(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, _, job := newSourceImportTestJob(t, s, 400, 800)
	if err := s.MarkSourceImportEnqueued(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	first, err := s.AcquireSourceImport(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE source_import_jobs
		SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, job.ID); err != nil {
		t.Fatal(err)
	}
	recovered, err := s.RecoverStalledSourceImports(ctx, 10)
	if err != nil || recovered != 1 {
		t.Fatalf("recovered=%d err=%v", recovered, err)
	}
	dispatches, err := s.PendingSourceImportDispatches(ctx, 10)
	if err != nil || len(dispatches) != 1 || dispatches[0].JobID != job.ID {
		t.Fatalf("dispatches=%v err=%v", dispatches, err)
	}
	second, err := s.AcquireSourceImport(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if second.AttemptObjectPath == first.AttemptObjectPath {
		t.Fatal("recovered attempt reused the expired object path")
	}
}

func TestSourceImportStalledPendingDeliveryIsRedispatched(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, _, job := newSourceImportTestJob(t, s, 400, 800)
	if err := s.MarkSourceImportEnqueued(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE source_import_jobs
		SET updated_at=now()-interval '7 hours' WHERE id=$1`, job.ID); err != nil {
		t.Fatal(err)
	}
	recovered, err := s.RecoverStalledSourceImports(ctx, 10)
	if err != nil || recovered != 1 {
		t.Fatalf("recovered=%d err=%v", recovered, err)
	}
	dispatches, err := s.PendingSourceImportDispatches(ctx, 10)
	if err != nil || len(dispatches) != 1 || dispatches[0].JobID != job.ID {
		t.Fatalf("dispatches=%v err=%v", dispatches, err)
	}
}

func TestSourceImportRunningUploadExpiryClearsAttemptObject(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, _, job := newSourceImportTestJob(t, s, 400, 800)
	if _, err := s.AcquireSourceImport(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkUploadExpired(ctx, job.UploadSessionID); err != nil {
		t.Fatal(err)
	}
	expired, err := s.GetSourceImportByID(ctx, job.ID)
	if err != nil || expired.Status != "failed" ||
		expired.AttemptObjectPath != "" {
		t.Fatalf("expired=%+v err=%v", expired, err)
	}
}
