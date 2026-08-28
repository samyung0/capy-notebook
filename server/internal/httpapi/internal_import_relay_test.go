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

	"github.com/evonotes/server/internal/relayauth"
	"github.com/evonotes/server/internal/store"
)

func doImportRelay(
	t *testing.T,
	h http.Handler,
	path string,
	body any,
) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	timestamp := strconv.FormatInt(time.Now().UTC().Unix(), 10)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(relayauth.HeaderTimestamp, timestamp)
	req.Header.Set(relayauth.HeaderSignature, relayauth.Sign(
		importRelayTestSecret,
		timestamp,
		http.MethodPost,
		req.URL.RequestURI(),
		raw,
	))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestImportRelayUploadGrantUsesAttemptSpecificObject(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 10)
	jobID := "imp_relay_" + suffix
	uploadID := "up_relay_" + suffix
	basePath := "incoming/" + uploadID + "/file.pdf"
	created, err := st.CreateSourceImports(ctx, []store.NewSourceImport{{
		JobID: jobID,
		Upload: store.NewUploadSession{
			ID: uploadID, WorkspaceID: "ws_e2e_private", CreatedBy: "u_owner",
			ObjectPath: basePath, FinalPath: "sources/relay-" + suffix + ".pdf",
			Name: "file.pdf", Kind: "pdf", ContentType: "application/pdf",
			DeclaredSize: 10, ParseMode: "none",
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
		Provider: "google", ProviderFileID: "drive-file",
		MaxBytes: 100, IdempotencyKey: "ireq-relay-" + suffix,
	}})
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.AcquireSourceImport(ctx, created[0].ID)
	if err != nil {
		t.Fatal(err)
	}

	grant := func(token string) string {
		rec := doImportRelay(t, h, "/api/internal/import-relay/upload-grant", map[string]any{
			"actualSize":   10,
			"attemptToken": token,
			"jobId":        jobID,
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("grant status=%d body=%s", rec.Code, rec.Body.String())
		}
		var response struct {
			URL string `json:"url"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response.URL
	}

	firstURL := grant(first.LeaseToken)
	if firstURL != "memory-put://"+first.AttemptObjectPath {
		t.Fatalf("first grant URL does not bind the attempt: %q", firstURL)
	}
	if err := st.MarkSourceImportRetry(
		ctx, jobID, first.LeaseToken, "retry", "retry", time.Second,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE source_import_jobs
		SET next_attempt_at=now() WHERE id=$1`, jobID); err != nil {
		t.Fatal(err)
	}
	second, err := st.AcquireSourceImport(ctx, jobID)
	if err != nil {
		t.Fatal(err)
	}
	secondURL := grant(second.LeaseToken)
	if firstURL == secondURL ||
		secondURL != "memory-put://"+second.AttemptObjectPath {
		t.Fatalf("replacement grant reused object URL: first=%q second=%q", firstURL, secondURL)
	}
}

func TestImportRelayCompleteRetriesWhenCreditsExhausted(t *testing.T) {
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
		actor, store.CreditLimitMicros(store.PlanFree)); err != nil {
		t.Fatal(err)
	}

	jobID := "imp_cred_" + suffix
	uploadID := "up_cred_" + suffix
	payload := []byte("plain text")
	created, err := st.CreateSourceImports(ctx, []store.NewSourceImport{{
		JobID: jobID,
		Upload: store.NewUploadSession{
			ID: uploadID, WorkspaceID: ws.ID, CreatedBy: actor,
			ObjectPath: "incoming/" + uploadID + "/notes.txt",
			FinalPath:  "sources/cred-" + suffix + ".txt",
			Name:       "notes.txt", Kind: "txt",
			ContentType:  "application/octet-stream",
			DeclaredSize: int64(len(payload)), ParseMode: "none",
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
		Provider: "google", ProviderFileID: "drive-file",
		MaxBytes: 100, IdempotencyKey: "ireq-cred-" + suffix,
	}})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := st.AcquireSourceImport(ctx, created[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := st.PrepareSourceImportUpload(
		ctx, jobID, claimed.LeaseToken, int64(len(payload)),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := mem.Put(prepared.AttemptObjectPath, bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}

	complete := func() *httptest.ResponseRecorder {
		return doImportRelay(t, h, "/api/internal/import-relay/complete", map[string]any{
			"attemptToken": claimed.LeaseToken,
			"jobId":        jobID,
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
	pending, err := st.GetSourceImportByID(ctx, jobID)
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
