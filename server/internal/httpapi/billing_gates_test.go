package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/evonotes/server/internal/blob"
	"github.com/evonotes/server/internal/httpapi"
	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/store"
	"github.com/evonotes/server/internal/testdb"
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
	dsn := testdb.URL(t)
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

func setCreditCounters(t *testing.T, pool *pgxpool.Pool, userID string, used, reserved int64) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO user_credits (user_id, used_micros, reserved_micros, period_start)
		VALUES ($1, $2, $3, date_trunc('month', timezone('utc', now()))::date)
		ON CONFLICT (user_id) DO UPDATE
		  SET used_micros = EXCLUDED.used_micros,
		      reserved_micros = EXCLUDED.reserved_micros,
		      period_start = EXCLUDED.period_start`,
		userID, used, reserved)
	if err != nil {
		t.Fatal(err)
	}
}

func exhaustCredits(t *testing.T, st *store.Store, pool *pgxpool.Pool, userID string) {
	t.Helper()
	setCreditCounters(t, pool, userID, mustPlanLimits(t, st, store.PlanFree).CreditMicros, 0)
}

func reserveCreditsToLimit(t *testing.T, st *store.Store, pool *pgxpool.Pool, userID string) {
	t.Helper()
	setCreditCounters(t, pool, userID, 0, mustPlanLimits(t, st, store.PlanFree).CreditMicros)
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if code, ok := body["code"].(string); ok {
		return code
	}
	if details, ok := body["errors"].([]any); ok && len(details) > 0 {
		if first, ok := details[0].(map[string]any); ok {
			if msg, ok := first["message"].(string); ok {
				return msg
			}
		}
	}
	return rec.Body.String()
}

func assertInteractiveCreditsForbidden(t *testing.T, fx billingFixture) {
	t.Helper()
	ws := fx.workspaceID

	chat := doReq(t, fx.handler, http.MethodPost, "/api/workspaces/"+ws+"/chat/stream", fx.actorID,
		map[string]any{"text": "hello", "model": "deepseek-pro"})
	if chat.Code != http.StatusForbidden || errorCode(t, chat) != "llm_credits_exhausted" {
		t.Fatalf("chat: %d %s", chat.Code, chat.Body.String())
	}

	gen := doReq(t, fx.handler, http.MethodPost, "/api/workspaces/"+ws+"/generate", fx.actorID,
		generateBody("quiz", "Credits quiz"))
	if gen.Code != http.StatusForbidden || errorCode(t, gen) != "llm_credits_exhausted" {
		t.Fatalf("generate: %d %s", gen.Code, gen.Body.String())
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
			"ctx": map[string]any{
				"children": []any{map[string]any{
					"type": "p", "children": []any{map[string]any{"text": "Draft"}},
				}},
				"toolName": "generate",
			},
		})
	if command.Code != http.StatusForbidden || errorCode(t, command) != "llm_credits_exhausted" {
		t.Fatalf("command: %d %s", command.Code, command.Body.String())
	}
}

func TestCreditsExhaustedOnChatGenerateEditor(t *testing.T) {
	fx := openBilling(t)
	exhaustCredits(t, fx.store, fx.pool, fx.actorID)
	assertInteractiveCreditsForbidden(t, fx)
}

func TestCreditsExhaustedWhenReservedAtLimit(t *testing.T) {
	fx := openBilling(t)
	reserveCreditsToLimit(t, fx.store, fx.pool, fx.actorID)
	assertInteractiveCreditsForbidden(t, fx)
}

func TestChatStreamIgnoresClientModelAndStampsTheAssistantMessage(t *testing.T) {
	fx := openBilling(t)
	rest := doReq(t, fx.handler, http.MethodPost,
		"/api/workspaces/"+fx.workspaceID+"/conversations", fx.actorID,
		map[string]any{"title": "Pinned"})
	if rest.Code != http.StatusCreated {
		t.Fatalf("REST create: %d %s", rest.Code, rest.Body.String())
	}

	stream := doReq(t, fx.handler, http.MethodPost,
		"/api/workspaces/"+fx.workspaceID+"/chat/stream", fx.actorID,
		map[string]any{"text": "hello", "model": "deepseek-pro"})
	if stream.Code != http.StatusOK {
		t.Fatalf("stream: %d %s", stream.Code, stream.Body.String())
	}

	ctx := context.Background()
	var providerSlug, modelSlug string
	var version int
	err := fx.pool.QueryRow(ctx, `
		SELECT metadata->>'providerSlug', metadata->>'modelSlug',
		       (metadata->>'modelVersion')::int
		  FROM messages
		 WHERE role = 'assistant'
		 ORDER BY created_at DESC LIMIT 1`).Scan(&providerSlug, &modelSlug, &version)
	if err != nil {
		t.Fatal(err)
	}
	if providerSlug == "" || modelSlug == "" || version <= 0 {
		t.Fatalf("assistant unpinned: %s/%s v%d", providerSlug, modelSlug, version)
	}
	if modelSlug == "deepseek-pro" {
		t.Fatal("client-supplied model overrode the pin")
	}
}

func TestIngestSlotsArePerActor(t *testing.T) {
	fx := openBilling(t)
	ctx := context.Background()

	empty := doReq(t, fx.handler, http.MethodGet, "/api/me/ingest-slots", fx.actorID, nil)
	if empty.Code != http.StatusOK {
		t.Fatalf("empty slots = %d %s", empty.Code, empty.Body.String())
	}
	var slots store.IngestSlots
	if err := json.Unmarshal(empty.Body.Bytes(), &slots); err != nil {
		t.Fatal(err)
	}
	if slots.SlotsLimit != store.ConcurrentIngestLeases || slots.SlotsUsed != 0 || slots.SlotsFree != store.ConcurrentIngestLeases {
		t.Fatalf("empty slots %#v", slots)
	}

	if _, err := fx.store.BeginIngestSpend(ctx, fx.actorID, fx.workspaceID); err != nil {
		t.Fatal(err)
	}
	held := doReq(t, fx.handler, http.MethodGet, "/api/me/ingest-slots", fx.actorID, nil)
	if err := json.Unmarshal(held.Body.Bytes(), &slots); err != nil {
		t.Fatal(err)
	}
	if slots.SlotsUsed != 1 || slots.SlotsFree != store.ConcurrentIngestLeases-1 {
		t.Fatalf("held slots %#v", slots)
	}

	owner := doReq(t, fx.handler, http.MethodGet, "/api/me/ingest-slots", fx.ownerID, nil)
	if err := json.Unmarshal(owner.Body.Bytes(), &slots); err != nil {
		t.Fatal(err)
	}
	if slots.SlotsUsed != 0 {
		t.Fatalf("owner saw actor lease: %#v", slots)
	}
}

func TestUploadRefusesActorCreditsAndOwnerStorageSeparately(t *testing.T) {
	fx := openBilling(t)
	body := map[string]any{
		"name": "notes.pdf", "kind": "pdf", "parseMode": "fast",
		"captionImages": false,
		"sizeBytes":     1024, "contentType": "application/pdf",
	}

	exhaustCredits(t, fx.store, fx.pool, fx.actorID)
	credits := doReq(t, fx.handler, http.MethodPost,
		"/api/workspaces/"+fx.workspaceID+"/sources/uploads", fx.actorID, body)
	if credits.Code != http.StatusForbidden || errorCode(t, credits) != "llm_credits_exhausted" {
		t.Fatalf("actor credits: %d %s", credits.Code, credits.Body.String())
	}

	fx2 := openBilling(t)
	if _, err := fx2.store.CreateSourceReady(context.Background(), fx2.workspaceID, fx2.ownerID,
		"ballast.pdf", "pdf", nil, "", mustPlanLimits(t, fx2.store, store.PlanFree).StorageBytes, "sources/"+fx2.ownerID); err != nil {
		t.Fatal(err)
	}
	storage := doReq(t, fx2.handler, http.MethodPost,
		"/api/workspaces/"+fx2.workspaceID+"/sources/uploads", fx2.actorID, body)
	if storage.Code != http.StatusForbidden || errorCode(t, storage) != "storage_quota_exceeded" {
		t.Fatalf("owner storage: %d %s", storage.Code, storage.Body.String())
	}
}
