package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/evonotes/server/internal/store"
)

func newImportJob(
	t *testing.T,
	st *store.Store,
	workspaceID, actor string,
	payload []byte,
) store.SourceImportJob {
	t.Helper()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 10)
	uploadID := "up_imp_" + suffix
	created, err := st.CreateSourceImports(context.Background(), []store.NewSourceImport{{
		JobID: "imp_" + suffix,
		Upload: store.NewUploadSession{
			ID: uploadID, WorkspaceID: workspaceID, CreatedBy: actor,
			ObjectPath: "incoming/" + uploadID + "/notes.txt",
			FinalPath:  "sources/imp-" + suffix + ".txt",
			Name:       "notes.txt", Kind: "txt",
			ContentType:  "application/octet-stream",
			DeclaredSize: int64(len(payload)), ParseMode: "none",
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
		Provider: "google", ProviderFileID: "drive-file",
		MaxBytes: 100, IdempotencyKey: "ireq-" + suffix,
	}})
	if err != nil {
		t.Fatal(err)
	}
	return created[0]
}

func TestImportCompleteSettlesActualSizeAndRejectsOversize(t *testing.T) {
	h, st, mem := openInternalHTTPWithBlob(t)
	ctx := context.Background()
	payload := []byte("plain text that is longer than declared")
	job := newImportJob(t, st, "ws_e2e_private", "u_owner", payload[:5])
	claimed, err := st.AcquireSourceImport(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := mem.Put(claimed.AttemptObjectPath, bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}

	unauthorized := doInternal(t, h, http.MethodPost, "/api/internal/import/complete", "", map[string]any{
		"jobId": job.ID, "attemptToken": claimed.LeaseToken, "actualSize": len(payload),
	})
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated complete status=%d", unauthorized.Code)
	}
	oversize := doInternal(t, h, http.MethodPost, "/api/internal/import/complete", pipeSecret, map[string]any{
		"jobId": job.ID, "attemptToken": claimed.LeaseToken, "actualSize": 101,
	})
	if oversize.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize complete status=%d body=%s", oversize.Code, oversize.Body.String())
	}
	ok := doInternal(t, h, http.MethodPost, "/api/internal/import/complete", pipeSecret, map[string]any{
		"jobId": job.ID, "attemptToken": claimed.LeaseToken, "actualSize": len(payload),
	})
	if ok.Code != http.StatusOK {
		t.Fatalf("complete status=%d body=%s", ok.Code, ok.Body.String())
	}
	done, err := st.GetSourceImportByID(ctx, job.ID)
	if err != nil || done.Status != "succeeded" || done.FileID == nil ||
		done.DeclaredSize != int64(len(payload)) {
		t.Fatalf("completed job=%+v err=%v", done, err)
	}
}

func TestImportCompleteRetriesWhenCreditsExhausted(t *testing.T) {
	h, st, mem := openInternalHTTPWithBlob(t)
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 10)
	actor := "u_imp_cred_" + suffix
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id, name, email, plan_tier)
		VALUES ($1, 'Import Credits', $2, 'free')`, actor, actor+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, actor)
	})
	ws, err := st.CreateWorkspace(ctx, actor, "Import Credits", store.ColorGreen, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `
		INSERT INTO user_credits (user_id, used_micros, reserved_micros, period_start)
		VALUES ($1, $2, 0, date_trunc('month', timezone('utc', now()))::date)
		ON CONFLICT (user_id) DO UPDATE
		  SET used_micros = EXCLUDED.used_micros,
		      reserved_micros = 0,
		      period_start = EXCLUDED.period_start`,
		actor, mustPlanLimits(t, st, store.PlanFree).CreditMicros); err != nil {
		t.Fatal(err)
	}

	payload := []byte("plain text")
	job := newImportJob(t, st, ws.ID, actor, payload)
	claimed, err := st.AcquireSourceImport(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := mem.Put(claimed.AttemptObjectPath, bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}
	complete := func() *httptest.ResponseRecorder {
		return doInternal(t, h, http.MethodPost, "/api/internal/import/complete", pipeSecret, map[string]any{
			"jobId": job.ID, "attemptToken": claimed.LeaseToken, "actualSize": len(payload),
		})
	}

	blocked := complete()
	if blocked.Code != http.StatusTooManyRequests {
		t.Fatalf("exhausted complete status=%d body=%s", blocked.Code, blocked.Body.String())
	}
	if blocked.Header().Get("Retry-After") != "300" {
		t.Fatalf("Retry-After=%q", blocked.Header().Get("Retry-After"))
	}
	var body map[string]any
	if err := json.Unmarshal(blocked.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != "llm_credits_exhausted" {
		t.Fatalf("code=%#v body=%s", body["code"], blocked.Body.String())
	}
	pending, err := st.GetSourceImportByID(ctx, job.ID)
	if err != nil || pending.Status != "running" || pending.FileID != nil {
		t.Fatalf("blocked job=%+v err=%v", pending, err)
	}

	if _, err := st.Pool().Exec(ctx, `UPDATE user_credits
		SET used_micros=0, reserved_micros=0 WHERE user_id=$1`, actor); err != nil {
		t.Fatal(err)
	}
	ok := complete()
	if ok.Code != http.StatusOK {
		t.Fatalf("recovered complete status=%d body=%s", ok.Code, ok.Body.String())
	}
}

func TestImportConcurrentCompletionConvergesOnOneFile(t *testing.T) {
	h, st, mem := openInternalHTTPWithBlob(t)
	ctx := context.Background()
	payload := []byte("race")
	job := newImportJob(t, st, "ws_e2e_private", "u_owner", payload)
	claimed, err := st.AcquireSourceImport(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := mem.Put(claimed.AttemptObjectPath, bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}

	responses := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		go func() {
			responses <- doInternal(t, h, http.MethodPost, "/api/internal/import/complete", pipeSecret, map[string]any{
				"jobId": job.ID, "attemptToken": claimed.LeaseToken, "actualSize": len(payload),
			})
		}()
	}
	fileIDs := map[string]struct{}{}
	for range 2 {
		response := <-responses
		if response.Code != http.StatusOK {
			t.Errorf("completion status=%d body=%s", response.Code, response.Body.String())
			continue
		}
		var body struct {
			FileID string `json:"fileId"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		fileIDs[body.FileID] = struct{}{}
	}
	if len(fileIDs) != 1 {
		t.Fatalf("concurrent completions created %d files", len(fileIDs))
	}
}

func TestImportFailWithoutTokenRefusesLiveAttempt(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	job := newImportJob(t, st, "ws_e2e_private", "u_owner", []byte("x"))
	claimed, err := st.AcquireSourceImport(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	live := doInternal(t, h, http.MethodPost, "/api/internal/import/fail", pipeSecret, map[string]any{
		"jobId": job.ID, "code": "attempts_exhausted",
	})
	if live.Code != http.StatusConflict {
		t.Fatalf("tokenless fail on live attempt status=%d body=%s", live.Code, live.Body.String())
	}
	retry := doInternal(t, h, http.MethodPost, "/api/internal/import/fail", pipeSecret, map[string]any{
		"jobId": job.ID, "attemptToken": claimed.LeaseToken, "code": "provider_unavailable", "retryable": true,
	})
	if retry.Code != http.StatusNoContent {
		t.Fatalf("retry report status=%d body=%s", retry.Code, retry.Body.String())
	}
	released, err := st.GetSourceImportByID(ctx, job.ID)
	if err != nil || released.Status != "pending" || released.LeaseToken != "" {
		t.Fatalf("released job=%+v err=%v", released, err)
	}
	final := doInternal(t, h, http.MethodPost, "/api/internal/import/fail", pipeSecret, map[string]any{
		"jobId": job.ID, "code": "attempts_exhausted",
	})
	if final.Code != http.StatusNoContent {
		t.Fatalf("tokenless fail status=%d body=%s", final.Code, final.Body.String())
	}
	failed, err := st.GetSourceImportByID(ctx, job.ID)
	if err != nil || failed.Status != "failed" || failed.LastErrorCode != "attempts_exhausted" {
		t.Fatalf("failed job=%+v err=%v", failed, err)
	}
}

func TestImportAcquireReportsLeaseTerminalAndResume(t *testing.T) {
	h, st, mem := openInternalHTTPWithBlob(t)
	ctx := context.Background()
	payload := []byte("resume me")
	job := newImportJob(t, st, "ws_e2e_private", "u_owner", payload)
	acquire := func() *httptest.ResponseRecorder {
		return doInternal(t, h, http.MethodPost, "/api/internal/import/acquire", pipeSecret, map[string]any{
			"jobId": job.ID,
		})
	}
	decode := func(rec *httptest.ResponseRecorder) map[string]any {
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body
	}

	// The final object already matches: the worker skips the download.
	if _, _, err := mem.Put(job.FinalPath, bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}
	first := acquire()
	body := decode(first)
	if first.Code != http.StatusOK || body["status"] != "acquired" || body["resumeComplete"] != true ||
		body["attemptToken"] == "" || body["download"] != nil {
		t.Fatalf("resume acquire status=%d body=%s", first.Code, first.Body.String())
	}

	// A live lease is the only 409.
	held := acquire()
	if held.Code != http.StatusConflict || decode(held)["code"] != "import_not_ready" {
		t.Fatalf("held acquire status=%d body=%s", held.Code, held.Body.String())
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE source_import_jobs
		SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, job.ID); err != nil {
		t.Fatal(err)
	}
	again := acquire()
	if again.Code != http.StatusOK || decode(again)["status"] != "acquired" {
		t.Fatalf("expired-lease acquire status=%d body=%s", again.Code, again.Body.String())
	}

	// An expired upload session answers 200 "expired" even while the lease is live.
	if _, err := st.Pool().Exec(ctx, `UPDATE upload_sessions
		SET expires_at=now()-interval '1 second' WHERE id=$1`, job.UploadSessionID); err != nil {
		t.Fatal(err)
	}
	expired := acquire()
	if expired.Code != http.StatusOK || decode(expired)["status"] != "expired" {
		t.Fatalf("expired-session acquire status=%d body=%s", expired.Code, expired.Body.String())
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE upload_sessions
		SET expires_at=now()+interval '1 hour' WHERE id=$1`, job.UploadSessionID); err != nil {
		t.Fatal(err)
	}

	// A closed import answers 200 with its terminal status, never 409.
	token, _ := decode(again)["attemptToken"].(string)
	if err := st.MarkSourceImportFailed(ctx, job.ID, token, "attempts_exhausted", "done"); err != nil {
		t.Fatal(err)
	}
	closed := acquire()
	if closed.Code != http.StatusOK || decode(closed)["status"] != "failed" {
		t.Fatalf("closed acquire status=%d body=%s", closed.Code, closed.Body.String())
	}
}
