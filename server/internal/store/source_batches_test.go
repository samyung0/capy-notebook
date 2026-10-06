package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func newBatchUpload(t *testing.T, s *Store, ws, actor, batch string, expires time.Time) UploadSession {
	t.Helper()
	session, err := s.CreateUploadSession(context.Background(), NewUploadSession{
		ID: uid("up"), WorkspaceID: ws, CreatedBy: actor,
		ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "archive.zip", Kind: "unknown", ContentType: "application/zip",
		DeclaredSize: 16, ParseMode: "none", ExpiresAt: expires, BatchID: batch,
	})
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func takeBatchNotifications(t *testing.T, s *Store, ws string) []Notification {
	t.Helper()
	all, err := s.SettleSourceBatches(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var mine []Notification
	for _, n := range all {
		if n.WorkspaceID == ws {
			mine = append(mine, n)
		}
	}
	return mine
}

func batchCounts(t *testing.T, n Notification, source string) (done, failed int) {
	t.Helper()
	var data struct {
		Code   string `json:"code"`
		Source string `json:"source"`
		Done   int    `json:"done"`
		Failed int    `json:"failed"`
	}
	if err := json.Unmarshal(n.Data, &data); err != nil {
		t.Fatal(err)
	}
	if n.Kind != "system" || data.Code != "source_batch" || data.Source != source {
		t.Fatalf("notification = %s %s", n.Kind, n.Data)
	}
	return data.Done, data.Failed
}

// A batch notifies once, when its last file settles: a stored file, an expired
// reservation and a failed parse all count, later settles add nothing.
func TestSourceBatchNotifiesOnceWhenEveryFileSettles(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_batch")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Batch", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	batch := uid("sb")
	if err := s.OpenSourceBatch(ctx, batch, ws.ID, owner, "upload", 3); err != nil {
		t.Fatal(err)
	}
	stored := newBatchUpload(t, s, ws.ID, owner, batch, time.Now().Add(time.Hour))
	file, err := s.FinalizeUploadSession(ctx, stored.ID, "etag", "")
	if err != nil {
		t.Fatal(err)
	}
	newBatchUpload(t, s, ws.ID, owner, batch, time.Now().Add(-time.Minute))
	if _, err := s.SweepExpiredUploads(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if got := takeBatchNotifications(t, s, ws.ID); len(got) != 0 {
		t.Fatalf("notified before the batch settled: %v", got)
	}
	// Stand-in for a parsed file failing in the pipeline.
	if _, err := s.pool.Exec(ctx, `UPDATE files SET status='processing', batch_id=$2 WHERE id=$1`, file.ID, batch); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE files SET status='failed' WHERE id=$1`, file.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.FailSourceBatchFile(ctx, batch); err != nil {
		t.Fatal(err)
	}

	got := takeBatchNotifications(t, s, ws.ID)
	if len(got) != 1 || got[0].UserID != owner || got[0].Href != "/workspaces/"+ws.ID {
		t.Fatalf("notifications = %+v", got)
	}
	if done, failed := batchCounts(t, got[0], "upload"); done != 1 || failed != 2 {
		t.Fatalf("done=%d failed=%d, want 1 and 2", done, failed)
	}
	if again := takeBatchNotifications(t, s, ws.ID); len(again) != 0 {
		t.Fatalf("published twice: %v", again)
	}
}

// A batch idle for an hour notifies with its unsettled files counted failed.
func TestIdleSourceBatchClosesWithUnsentFilesFailed(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_batch_idle")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Idle", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	batch := uid("sb")
	if err := s.OpenSourceBatch(ctx, batch, ws.ID, owner, "upload", 4); err != nil {
		t.Fatal(err)
	}
	stored := newBatchUpload(t, s, ws.ID, owner, batch, time.Now().Add(time.Hour))
	if _, err := s.FinalizeUploadSession(ctx, stored.ID, "etag", ""); err != nil {
		t.Fatal(err)
	}
	if got := takeBatchNotifications(t, s, ws.ID); len(got) != 0 {
		t.Fatalf("notified an active batch: %v", got)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE source_batches SET updated_at=now()-interval '61 minutes' WHERE id=$1`, batch); err != nil {
		t.Fatal(err)
	}
	got := takeBatchNotifications(t, s, ws.ID)
	if len(got) != 1 {
		t.Fatalf("notifications = %v", got)
	}
	if done, failed := batchCounts(t, got[0], "upload"); done != 1 || failed != 3 {
		t.Fatalf("done=%d failed=%d, want 1 and 3", done, failed)
	}
}

// An import submission of two picked items, the second a folder of three files
// (one rejected), notifies once with all four files, never before the second
// request arrives.
func TestImportBatchCountsEveryRequestsFiles(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_batch_import")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Import batch", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	batch := uid("sb")
	request := func(files, rejected int) []string {
		t.Helper()
		if err := s.OpenSourceBatch(ctx, batch, ws.ID, owner, "import", 2); err != nil {
			t.Fatal(err)
		}
		requestID := uid("ireq")
		if _, _, err := s.BeginSourceImportRequest(ctx, owner, ws.ID, requestID, "fp"); err != nil {
			t.Fatal(err)
		}
		imports := make([]NewSourceImport, files)
		jobs := make([]string, files)
		for i := range imports {
			uploadID := uid("up")
			jobs[i] = uid("imp")
			imports[i] = NewSourceImport{
				JobID: jobs[i],
				Upload: NewUploadSession{
					ID: uploadID, WorkspaceID: ws.ID, CreatedBy: owner,
					ObjectPath: "incoming/" + uploadID + "/f.pdf", FinalPath: "sources/" + uid("blob") + ".pdf",
					Name: "f.pdf", Kind: "pdf", ContentType: "application/pdf",
					DeclaredSize: 5, ParseMode: "none", ExpiresAt: time.Now().UTC().Add(time.Hour),
				},
				Provider: "google", ProviderFileID: uid("drive"), MaxBytes: 20,
				IdempotencyKey: requestID + ":" + jobs[i], TraceID: "trace",
			}
		}
		if _, err := s.CreateSourceImportsAndCompleteRequest(
			ctx, owner, ws.ID, requestID, "fp", imports, batch, rejected, json.RawMessage(`{}`),
		); err != nil {
			t.Fatal(err)
		}
		return jobs
	}
	fail := func(jobs []string) {
		t.Helper()
		for _, job := range jobs {
			if err := s.MarkSourceImportFailed(ctx, job, "", "provider_download_refused", "refused"); err != nil {
				t.Fatal(err)
			}
		}
	}

	fail(request(1, 0))
	if got := takeBatchNotifications(t, s, ws.ID); len(got) != 0 {
		t.Fatalf("notified before the second request: %v", got)
	}
	fail(request(2, 1))
	got := takeBatchNotifications(t, s, ws.ID)
	if len(got) != 1 {
		t.Fatalf("notifications = %v", got)
	}
	if done, failed := batchCounts(t, got[0], "import"); done != 0 || failed != 4 {
		t.Fatalf("done=%d failed=%d, want 0 and 4", done, failed)
	}
}
