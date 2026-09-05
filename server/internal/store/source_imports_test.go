package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"
)

func TestSourceImportRequestCommitsJobsAndResponseAtomically(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, owner, existing := newSourceImportTestJob(t, s, 10, 20)
	requestID := uid("ireq_atomic")
	fingerprint := "atomic-fingerprint"
	if _, complete, err := s.BeginSourceImportRequest(
		ctx, owner, existing.WorkspaceID, requestID, fingerprint,
	); err != nil || complete {
		t.Fatalf("begin complete=%v err=%v", complete, err)
	}

	newImport := func(jobID, fileID string) NewSourceImport {
		uploadID := uid("up")
		return NewSourceImport{
			JobID: jobID,
			Upload: NewUploadSession{
				ID: uploadID, WorkspaceID: existing.WorkspaceID, CreatedBy: owner,
				ObjectPath: "incoming/" + uploadID + "/file.pdf",
				FinalPath:  "sources/" + uid("blob") + ".pdf",
				Name:       "file.pdf", Kind: "pdf", ContentType: "application/pdf",
				DeclaredSize: 5, ParseMode: "none",
				ExpiresAt: time.Now().UTC().Add(time.Hour),
			},
			Provider: "google", ProviderFileID: fileID, MaxBytes: 20,
			IdempotencyKey: requestID + ":0", TraceID: "trace",
		}
	}
	first := newImport(uid("imp"), "provider-file-before-crash")
	want := json.RawMessage(fmt.Sprintf(
		`{"jobs":[{"jobId":%q,"uploadId":%q,"name":"file.pdf"}],"rejected":[]}`,
		first.JobID, first.Upload.ID,
	))

	functionName := uid("fail_import_response")
	triggerName := uid("fail_import_response")
	createFailure := fmt.Sprintf(`
		CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'injected response failure'; END $$;
		CREATE TRIGGER %s BEFORE UPDATE OF response ON source_import_requests
		FOR EACH ROW EXECUTE FUNCTION %s()`, functionName, triggerName, functionName)
	if _, err := s.pool.Exec(ctx, createFailure); err != nil {
		t.Fatal(err)
	}
	dropFailure := func() {
		_, _ = s.pool.Exec(context.Background(), fmt.Sprintf(
			"DROP TRIGGER IF EXISTS %s ON source_import_requests; DROP FUNCTION IF EXISTS %s()",
			triggerName, functionName,
		))
	}
	t.Cleanup(dropFailure)

	if _, err := s.CreateSourceImportsAndCompleteRequest(
		ctx, owner, existing.WorkspaceID, requestID, fingerprint,
		[]NewSourceImport{first}, want,
	); err == nil {
		t.Fatal("injected response failure committed")
	}
	var jobs int
	var completed bool
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM source_import_jobs
		WHERE idempotency_key=$1`, requestID+":0").Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT response IS NOT NULL
		FROM source_import_requests WHERE actor_user_id=$1 AND request_id=$2`,
		owner, requestID).Scan(&completed); err != nil {
		t.Fatal(err)
	}
	if jobs != 0 || completed {
		t.Fatalf("failed transaction left jobs=%d completed=%v", jobs, completed)
	}

	dropFailure()
	stored, err := s.CreateSourceImportsAndCompleteRequest(
		ctx, owner, existing.WorkspaceID, requestID, fingerprint,
		[]NewSourceImport{first}, want,
	)
	if err != nil {
		t.Fatal(err)
	}
	var wantValue, storedValue any
	if err := json.Unmarshal(want, &wantValue); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(stored, &storedValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(storedValue, wantValue) {
		t.Fatalf("stored response=%s want=%s", stored, want)
	}

	changed := newImport(uid("imp"), "provider-file-after-replay")
	changed.IdempotencyKey = requestID + ":1"
	changedResponse := json.RawMessage(`{"jobs":[],"rejected":[{"fileId":"provider-file-after-replay","code":"provider_file_unavailable"}]}`)
	replayed, err := s.CreateSourceImportsAndCompleteRequest(
		ctx, owner, existing.WorkspaceID, requestID, fingerprint,
		[]NewSourceImport{changed}, changedResponse,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(replayed, &storedValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(storedValue, wantValue) {
		t.Fatalf("metadata drift changed replay=%s want=%s", replayed, want)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM source_import_jobs
		WHERE idempotency_key LIKE $1`, requestID+":%").Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if jobs != 1 {
		t.Fatalf("replay created %d jobs, want 1", jobs)
	}
}

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
	stored, err := s.CreateSourceImportsAndCompleteRequest(
		ctx, owner, job.WorkspaceID, requestID, "fingerprint", nil, want,
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

func TestSourceImportRequestRechecksActorLifecycle(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, owner, job := newSourceImportTestJob(t, s, 10, 20)
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),
		suspended_reason='test suspension' WHERE id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	requestID := uid("ireq")
	if _, _, err := s.BeginSourceImportRequest(
		ctx, owner, job.WorkspaceID, requestID, "fingerprint",
	); err == nil {
		t.Fatal("suspended actor created an import request")
	} else {
		var locked *AccountLockedError
		if !errors.As(err, &locked) || locked.State != AccountSuspended {
			t.Fatalf("begin error = %v, want suspended account", err)
		}
	}
	var requests int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM source_import_requests
		WHERE actor_user_id=$1`, owner).Scan(&requests); err != nil {
		t.Fatal(err)
	}
	if requests != 0 {
		t.Fatalf("suspended actor left %d import request(s)", requests)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=NULL,
		suspended_reason=NULL WHERE id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	requestID = uid("ireq")
	if _, _, err := s.BeginSourceImportRequest(
		ctx, owner, job.WorkspaceID, requestID, "fingerprint",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),
		suspended_reason='test suspension' WHERE id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	_, err := s.CreateSourceImportsAndCompleteRequest(
		ctx, owner, job.WorkspaceID, requestID, "fingerprint", nil,
		json.RawMessage(`{"jobs":[]}`),
	)
	var locked *AccountLockedError
	if !errors.As(err, &locked) || locked.State != AccountSuspended {
		t.Fatalf("complete error = %v, want suspended account", err)
	}
	var completed bool
	if err := s.pool.QueryRow(ctx, `SELECT response IS NOT NULL
		FROM source_import_requests WHERE actor_user_id=$1 AND request_id=$2`,
		owner, requestID).Scan(&completed); err != nil {
		t.Fatal(err)
	}
	if completed {
		t.Fatal("suspended actor completed an import request")
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

func TestSourceImportLeaseAndFailureReleaseReservation(t *testing.T) {
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

	var queueType, queueStatus string
	if err := s.pool.QueryRow(ctx, `SELECT type, status FROM jobs WHERE id=$1`, job.ID).
		Scan(&queueType, &queueStatus); err != nil || queueType != "import" || queueStatus != "pending" {
		t.Fatalf("queue row type=%q status=%q err=%v", queueType, queueStatus, err)
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
	if err := s.MarkSourceImportFailed(
		ctx, job.ID, "", "attempts_exhausted", "tokenless close",
	); !errors.Is(err, ErrImportNotReady) {
		t.Fatalf("tokenless fail replaced a live attempt: %v", err)
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

func TestSourceImportTokenlessFailIsIdempotent(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, owner, job := newSourceImportTestJob(t, s, 800, 800)

	for range 2 {
		if err := s.MarkSourceImportFailed(
			ctx, job.ID, "", "attempts_exhausted", "retries exhausted",
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

func TestSourceImportExpiredLeaseCanBeReacquired(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, _, job := newSourceImportTestJob(t, s, 400, 800)
	first, err := s.AcquireSourceImport(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AcquireSourceImport(ctx, job.ID); !errors.Is(err, ErrImportNotReady) {
		t.Fatalf("live lease reacquired: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE source_import_jobs
		SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, job.ID); err != nil {
		t.Fatal(err)
	}
	second, err := s.AcquireSourceImport(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if second.AttemptObjectPath == first.AttemptObjectPath || second.Attempts != 2 {
		t.Fatalf("expired attempt not replaced: first=%+v second=%+v", first, second)
	}
}

func TestSourceImportExpiredLeaseCannotRetryOrFail(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(context.Context, *Store, SourceImportJob) error
	}{
		{
			name: "retry",
			mutate: func(ctx context.Context, s *Store, job SourceImportJob) error {
				return s.MarkSourceImportRetry(
					ctx, job.ID, job.LeaseToken, "provider_busy", "provider busy",
				)
			},
		},
		{
			name: "fail",
			mutate: func(ctx context.Context, s *Store, job SourceImportJob) error {
				return s.MarkSourceImportFailed(
					ctx, job.ID, job.LeaseToken, "provider_refused", "provider refused",
				)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := openAccessTestStore(t)
			ctx, _, job := newSourceImportTestJob(t, s, 400, 800)
			claimed, err := s.AcquireSourceImport(ctx, job.ID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.pool.Exec(ctx, `UPDATE source_import_jobs
				SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, job.ID); err != nil {
				t.Fatal(err)
			}

			if err := tt.mutate(ctx, s, claimed); !errors.Is(err, ErrImportLeaseLost) {
				t.Fatalf("expired %s err=%v", tt.name, err)
			}
			stored, err := s.GetSourceImportByID(ctx, job.ID)
			if err != nil {
				t.Fatal(err)
			}
			if stored.Status != "running" || stored.LeaseToken != claimed.LeaseToken ||
				stored.LeaseActive || stored.AttemptObjectPath != claimed.AttemptObjectPath ||
				stored.LastErrorCode != "" {
				t.Fatalf("expired %s mutated job: %+v", tt.name, stored)
			}
		})
	}
}

func TestSourceImportTokenlessFailClosesExpiredAttempt(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, _, job := newSourceImportTestJob(t, s, 400, 800)
	if _, err := s.AcquireSourceImport(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE source_import_jobs
		SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, job.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkSourceImportFailed(
		ctx, job.ID, "", "attempts_exhausted", "retries exhausted",
	); err != nil {
		t.Fatal(err)
	}
	stored, err := s.GetSourceImportByID(ctx, job.ID)
	if err != nil || stored.Status != "failed" ||
		stored.LastErrorCode != "attempts_exhausted" {
		t.Fatalf("closed=%+v err=%v", stored, err)
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
