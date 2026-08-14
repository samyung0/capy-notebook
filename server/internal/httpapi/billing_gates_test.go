package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/evonotes/server/internal/auth"
	"github.com/evonotes/server/internal/blob"
	"github.com/evonotes/server/internal/httpapi"
	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

type billingFixture struct {
	handler     http.Handler
	pool        *pgxpool.Pool
	store       *store.Store
	registry    *models.Registry
	ownerID     string
	actorID     string
	workspaceID string
}

func openBilling(t *testing.T) billingFixture {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	reg, err := models.New(ctx, st.Pool())
	if err != nil {
		t.Fatal(err)
	}
	st.SetModelRegistry(reg)

	ownerID := fmt.Sprintf("u_bill_own_%d", time.Now().UnixNano())
	actorID := fmt.Sprintf("u_bill_act_%d", time.Now().UnixNano())
	for _, id := range []string{ownerID, actorID} {
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, name, email, plan_tier)
			VALUES ($1, 'Billing Test', $2, 'free')`, id, id+"@example.test"); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1 OR id=$2`, ownerID, actorID)
	})

	ws, err := st.CreateWorkspace(ctx, ownerID, "Billing", store.ColorGreen, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1, $2, 'editor')`, ws.ID, actorID); err != nil {
		t.Fatal(err)
	}

	h := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", "evo", httpapi.Config{
		E2EAuth:       true,
		E2ESecret:     "e2e-test-secret",
		E2EUserIDs:    []string{ownerID, actorID},
		ModelRegistry: reg,
	})
	return billingFixture{
		handler: h, pool: pool, store: st, registry: reg,
		ownerID: ownerID, actorID: actorID, workspaceID: ws.ID,
	}
}

func exhaustCredits(t *testing.T, pool *pgxpool.Pool, userID string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO user_credits (user_id, used_micros, reserved_micros, period_start)
		VALUES ($1, $2, 0, date_trunc('month', timezone('utc', now()))::date)
		ON CONFLICT (user_id) DO UPDATE
		  SET used_micros = EXCLUDED.used_micros,
		      reserved_micros = 0,
		      period_start = EXCLUDED.period_start`,
		userID, store.CreditLimitMicros(store.PlanFree))
	if err != nil {
		t.Fatal(err)
	}
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if code, ok := body["code"].(string); ok {
		return code
	}
	return rec.Body.String()
}

func TestCreditsExhaustedOnChatGenerateEditorTranscribe(t *testing.T) {
	fx := openBilling(t)
	exhaustCredits(t, fx.pool, fx.actorID)
	ws := fx.workspaceID

	chat := doReq(t, fx.handler, http.MethodPost, "/api/workspaces/"+ws+"/chat/stream", fx.actorID,
		map[string]any{"text": "hello", "model": "deepseek-pro"})
	if chat.Code != http.StatusForbidden || errorCode(t, chat) != "llm_credits_exhausted" {
		t.Fatalf("chat: %d %s", chat.Code, chat.Body.String())
	}

	gen := doReq(t, fx.handler, http.MethodPost, "/api/workspaces/"+ws+"/generate", fx.actorID,
		map[string]any{"kind": "quiz", "title": "Credits quiz"})
	if gen.Code != http.StatusForbidden || errorCode(t, gen) != "llm_credits_exhausted" {
		t.Fatalf("generate: %d %s", gen.Code, gen.Body.String())
	}

	complete := doReq(t, fx.handler, http.MethodPost, "/api/workspaces/"+ws+"/complete/stream", fx.actorID,
		map[string]any{"mode": "command", "prompt": "rewrite"})
	if complete.Code != http.StatusForbidden || errorCode(t, complete) != "llm_credits_exhausted" {
		t.Fatalf("complete: %d %s", complete.Code, complete.Body.String())
	}

	copilot := doReq(t, fx.handler, http.MethodPost, "/api/workspaces/"+ws+"/ai/copilot", fx.actorID,
		map[string]any{"prompt": "continue this sentence."})
	if copilot.Code != http.StatusForbidden || errorCode(t, copilot) != "llm_credits_exhausted" {
		t.Fatalf("copilot: %d %s", copilot.Code, copilot.Body.String())
	}

	command := doReq(t, fx.handler, http.MethodPost, "/api/workspaces/"+ws+"/ai/command", fx.actorID,
		map[string]any{
			"messages": []any{map[string]any{
				"role": "user", "parts": []any{map[string]any{"type": "text", "text": "summarize"}},
			}},
			"ctx": map[string]any{"children": []any{}},
		})
	if command.Code != http.StatusForbidden || errorCode(t, command) != "llm_credits_exhausted" {
		t.Fatalf("command: %d %s", command.Code, command.Body.String())
	}

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", "clip.webm")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(part, strings.NewReader("not-really-audio"))
	_ = mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/transcribe", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set(auth.HeaderE2EUserID, fx.actorID)
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	rec := httptest.NewRecorder()
	fx.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || errorCode(t, rec) != "llm_credits_exhausted" {
		t.Fatalf("transcribe: %d %s", rec.Code, rec.Body.String())
	}
}

func TestChatStreamIgnoresClientModelAndPinsConversation(t *testing.T) {
	fx := openBilling(t)
	rest := doReq(t, fx.handler, http.MethodPost,
		"/api/workspaces/"+fx.workspaceID+"/conversations", fx.actorID,
		map[string]any{"title": "Pinned"})
	if rest.Code != http.StatusCreated {
		t.Fatalf("REST create: %d %s", rest.Code, rest.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rest.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	stream := doReq(t, fx.handler, http.MethodPost,
		"/api/workspaces/"+fx.workspaceID+"/chat/stream", fx.actorID,
		map[string]any{"text": "hello", "model": "deepseek-pro"})
	if stream.Code != http.StatusOK {
		t.Fatalf("stream: %d %s", stream.Code, stream.Body.String())
	}

	ctx := context.Background()
	rows, err := fx.pool.Query(ctx,
		`SELECT metadata->>'modelKey', metadata->>'modelVersion' FROM conversations WHERE workspace_id=$1`,
		fx.workspaceID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var keys []string
	var versions []string
	for rows.Next() {
		var key, ver string
		if err := rows.Scan(&key, &ver); err != nil {
			t.Fatal(err)
		}
		keys = append(keys, key)
		versions = append(versions, ver)
	}
	if len(keys) < 2 {
		t.Fatalf("expected two conversations, got %v", keys)
	}
	if keys[0] != keys[1] || versions[0] != versions[1] {
		t.Fatalf("pins diverged: %v %v", keys, versions)
	}
	if keys[0] == "deepseek-pro" {
		t.Fatal("client-supplied model overrode the pin")
	}
	_ = created
}

func TestUploadRefusesActorCreditsAndOwnerStorageSeparately(t *testing.T) {
	fx := openBilling(t)
	body := map[string]any{
		"name": "notes.pdf", "kind": "pdf", "parseMode": "fast",
		"sizeBytes": 1024, "contentType": "application/pdf",
	}

	exhaustCredits(t, fx.pool, fx.actorID)
	credits := doReq(t, fx.handler, http.MethodPost,
		"/api/workspaces/"+fx.workspaceID+"/sources/uploads", fx.actorID, body)
	if credits.Code != http.StatusForbidden || errorCode(t, credits) != "llm_credits_exhausted" {
		t.Fatalf("actor credits: %d %s", credits.Code, credits.Body.String())
	}

	fx2 := openBilling(t)
	if _, err := fx2.store.CreateSourceReady(context.Background(), fx2.workspaceID, fx2.ownerID,
		"ballast.pdf", "pdf", nil, "", store.FreeStorageLimitBytes, "sources/"+fx2.ownerID); err != nil {
		t.Fatal(err)
	}
	storage := doReq(t, fx2.handler, http.MethodPost,
		"/api/workspaces/"+fx2.workspaceID+"/sources/uploads", fx2.actorID, body)
	if storage.Code != http.StatusForbidden || errorCode(t, storage) != "storage_quota_exceeded" {
		t.Fatalf("owner storage: %d %s", storage.Code, storage.Body.String())
	}
}
