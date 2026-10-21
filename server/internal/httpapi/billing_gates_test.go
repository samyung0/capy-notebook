package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
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

	ws, err := st.CreateWorkspace(ctx, ownerID, store.WorkspaceCreate{Name: "Billing", Tags: nil})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1, $2, 'editor')`, ws.ID, actorID); err != nil {
		t.Fatal(err)
	}

	h := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", httpapi.Config{
		E2EAuth:          true,
		E2ESecret:        "e2e-test-secret",
		E2EUserIDs:       []string{ownerID, actorID},
		ModelRegistry:    reg,
		ParseMaxPages:    1400,
		ParseMaxOCRPages: 1000,
	})
	return billingFixture{
		handler: h, pool: pool, store: st, registry: reg,
		ownerID: ownerID, actorID: actorID, workspaceID: ws.ID,
	}
}

func setCreditCounters(t *testing.T, pool *pgxpool.Pool, userID string, used, reserved int64) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO user_credits
		  (user_id, used_micros, reserved_micros, purchased_micros, period_start)
		VALUES ($1, $2, $3, 0, date_trunc('month', timezone('utc', now()))::date)
		ON CONFLICT (user_id) DO UPDATE
		  SET used_micros = EXCLUDED.used_micros,
		      reserved_micros = EXCLUDED.reserved_micros,
		      purchased_micros = 0,
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
		map[string]any{"text": "hello", "model": "test-expensive-model"})
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
		map[string]any{"text": "hello", "model": "test-expensive-model"})
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
	if modelSlug == "test-expensive-model" {
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

	// An open ingest session on the actor's slots (the enqueueing paths open
	// them inside their own transactions).
	if _, err := fx.store.Pool().Exec(ctx, `INSERT INTO provider_sessions
		(id, actor_user_id, workspace_id, surface, reserved_micros, expires_at)
		VALUES ('cr_slot_test', $1, $2, $3, 0, now() + interval '1 hour')`,
		fx.actorID, fx.workspaceID, store.SurfaceIngest); err != nil {
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

// The uploader pays (Sam 2026-10-18): its own credits and its own storage
// refuse an upload; a full workspace owner does not.
func TestUploadRefusesActorCreditsAndStorageSeparately(t *testing.T) {
	fx := openBilling(t)
	body := map[string]any{
		"name": "notes.pdf", "kind": "pdf", "parseMode": "fast",
		"sizeBytes": 1024, "contentType": "application/pdf",
		"batchId": fx.workspaceID, "batchTotal": 1,
	}

	pdf := make([]byte, 1024)
	exhaustCredits(t, fx.store, fx.pool, fx.actorID)
	credits := postUpload(t, fx.handler,
		"/api/workspaces/"+fx.workspaceID+"/sources/uploads", fx.actorID, body, "application/pdf", pdf)
	if credits.Code != http.StatusForbidden || errorCode(t, credits) != "llm_credits_exhausted" {
		t.Fatalf("actor credits: %d %s", credits.Code, credits.Body.String())
	}

	fx2 := openBilling(t)
	if _, err := uploadSource(context.Background(), fx2.store, fx2.workspaceID, fx2.ownerID,
		"ballast.pdf", mustPlanLimits(t, fx2.store, store.PlanFree).StorageBytes, "sources/"+fx2.ownerID); err != nil {
		t.Fatal(err)
	}
	body["batchId"] = fx2.workspaceID
	if rec := postUpload(t, fx2.handler,
		"/api/workspaces/"+fx2.workspaceID+"/sources/uploads", fx2.actorID, body, "application/pdf", pdf); rec.Code != http.StatusCreated {
		t.Fatalf("upload beside a full owner: %d %s", rec.Code, rec.Body.String())
	}
	// The upload above already holds 1024 bytes of the actor's quota.
	if _, err := uploadSource(context.Background(), fx2.store, fx2.workspaceID, fx2.actorID,
		"ballast.pdf", mustPlanLimits(t, fx2.store, store.PlanFree).StorageBytes-1024, "sources/"+fx2.actorID); err != nil {
		t.Fatal(err)
	}
	// The ticket refuses it, before the upload waits in line.
	storage, _ := takeTicket(t, fx2.handler, "/api/workspaces/"+fx2.workspaceID+"/sources/uploads", fx2.actorID, body)
	if storage.Code != http.StatusForbidden || errorCode(t, storage) != "storage_quota_exceeded" {
		t.Fatalf("uploader storage: %d %s", storage.Code, storage.Body.String())
	}
}

func TestUploadPolicyServesParserPageCapsAndReservationEnforcesThem(t *testing.T) {
	fx := openBilling(t)
	rec := doReq(t, fx.handler, http.MethodGet, "/api/source-upload-policy", fx.actorID, nil)
	var policy apimodel.SourceUploadPolicy
	if err := json.Unmarshal(rec.Body.Bytes(), &policy); err != nil {
		t.Fatal(err)
	}
	// An unmatched extension walks every kind, so none may send null.
	for _, kind := range policy.Kinds {
		if kind.Extensions == nil {
			t.Fatalf("kind %s sends null extensions", kind.Kind)
		}
	}
	modes := map[string]apimodel.SourceUploadParseModePolicy{}
	for _, mode := range policy.ParseModes {
		modes[mode.Mode] = mode
	}
	if fast := modes["fast"]; fast.MaxPages != 1400 || fast.MaxOCRPages != 1000 {
		t.Fatalf("fast mode caps: %#v", fast)
	}
	if none := modes["none"]; none.MaxPages != 0 || none.MaxOCRPages != 0 {
		t.Fatalf("none mode caps: %#v", none)
	}

	reserve := func(parseMode string, pages int) *httptest.ResponseRecorder {
		return postUpload(t, fx.handler,
			"/api/workspaces/"+fx.workspaceID+"/sources/uploads", fx.actorID, map[string]any{
				"name": "book.pdf", "kind": "pdf", "parseMode": parseMode,
				"sizeBytes": 1024, "contentType": "application/pdf", "pageCount": pages,
				"batchId": fx.workspaceID, "batchTotal": 3,
			}, "application/pdf", make([]byte, 1024))
	}
	if over := reserve("fast", 1401); over.Code != http.StatusBadRequest ||
		!strings.Contains(over.Body.String(), "at most 1400 pages") {
		t.Fatalf("fast over the cap: %d %s", over.Code, over.Body.String())
	}
	for _, ok := range []struct {
		mode  string
		pages int
	}{{"fast", 1400}, {"none", 5000}} {
		if rec := reserve(ok.mode, ok.pages); rec.Code != http.StatusCreated {
			t.Fatalf("%s %d pages: %d %s", ok.mode, ok.pages, rec.Code, rec.Body.String())
		}
	}
}

// The upload checks again what its ticket checked: a file within the cap when
// its ticket was issued but over it when it uploads (the payer's plan fell),
// and a reservation over the storage that filled while it waited, are refused
// at the upload with nothing held, for sources and editor assets (security
// regression: human backend-storage-quota 2026-10-22 gateway uploads).
func TestUploadsRecheckTheCapAndStorageAtTheUpload(t *testing.T) {
	fx := openBilling(t)
	ctx := context.Background()
	free, pro := mustPlanLimits(t, fx.store, store.PlanFree), mustPlanLimits(t, fx.store, store.PlanPro)
	plan := func(user, tier string) {
		t.Helper()
		if _, err := fx.pool.Exec(ctx, `UPDATE users SET plan_tier=$2 WHERE id=$1`, user, tier); err != nil {
			t.Fatal(err)
		}
	}
	sources := "/api/workspaces/" + fx.workspaceID + "/sources/uploads"
	source := func(size int64) map[string]any {
		return map[string]any{
			"name": "big.pdf", "parseMode": "none", "sizeBytes": size, "contentType": "application/pdf",
			"batchId": fmt.Sprintf("sb_%d", time.Now().UnixNano()), "batchTotal": 1,
		}
	}
	// fill takes the user's storage to its limit, whatever it holds already.
	fill := func(user string) {
		t.Helper()
		usage, err := fx.store.StorageUsage(ctx, user)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := uploadSource(ctx, fx.store, fx.workspaceID, user, "ballast.pdf",
			usage.LimitBytes-usage.UsedBytes-usage.ReservedBytes, "sources/"+user); err != nil {
			t.Fatal(err)
		}
	}
	upload := func(route, user string, meta map[string]any, partType string, body []byte) *httptest.ResponseRecorder {
		t.Helper()
		rec, _ := postForm(t, fx.handler, route, user, metadataPart(t, meta),
			formPart{name: "file", contentType: partType, body: body})
		return rec
	}

	plan(fx.actorID, "pro")
	if free.SourceFileBytes >= pro.SourceFileBytes {
		t.Fatalf("free cap %d is not below pro cap %d", free.SourceFileBytes, pro.SourceFileBytes)
	}
	over := source(free.SourceFileBytes + 1)
	route := ticketed(t, fx.handler, sources, fx.actorID, over)
	plan(fx.actorID, "free")
	if rec := upload(route, fx.actorID, over, "application/pdf", make([]byte, free.SourceFileBytes+1)); rec.Code != http.StatusBadRequest {
		t.Fatalf("a source over the cap at its upload: %d %s", rec.Code, rec.Body.String())
	}

	small := source(1024)
	route = ticketed(t, fx.handler, sources, fx.actorID, small)
	fill(fx.actorID)
	if rec := upload(route, fx.actorID, small, "application/pdf", make([]byte, 1024)); rec.Code != http.StatusForbidden ||
		errorCode(t, rec) != "storage_quota_exceeded" {
		t.Fatalf("a source over the storage at its upload: %d %s", rec.Code, rec.Body.String())
	}

	note, err := fx.store.CreateMaterial(ctx, store.Material{CreatedBy: fx.ownerID, WorkspaceID: fx.workspaceID,
		Kind: "note", Title: "Figures", Content: noteTestContent(t, "")})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, fx.store, note.ID)
	assets := "/api/materials/" + note.ID + "/editor-assets/uploads"
	image := func(size int64) map[string]any {
		return map[string]any{"name": "figure.png", "purpose": "image", "sizeBytes": size, "contentType": "image/png"}
	}
	plan(fx.ownerID, "pro")
	bigImage := image(free.EditorAssetBytes("image") + 1)
	route = ticketed(t, fx.handler, assets, fx.ownerID, bigImage)
	plan(fx.ownerID, "free")
	// A real PNG's first bytes, so only the cap can refuse it.
	bigPNG := make([]byte, free.EditorAssetBytes("image")+1)
	copy(bigPNG, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'})
	if rec := upload(route, fx.ownerID, bigImage, "image/png", bigPNG); rec.Code != http.StatusBadRequest {
		t.Fatalf("an editor asset over the cap at its upload: %d %s", rec.Code, rec.Body.String())
	}

	png := append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, make([]byte, 100)...)
	smallImage := image(int64(len(png)))
	route = ticketed(t, fx.handler, assets, fx.ownerID, smallImage)
	fill(fx.ownerID)
	if rec := upload(route, fx.ownerID, smallImage, "image/png", png); rec.Code != http.StatusForbidden ||
		errorCode(t, rec) != "storage_quota_exceeded" {
		t.Fatalf("an editor asset over the storage at its upload: %d %s", rec.Code, rec.Body.String())
	}

	var held, assetRows int
	if err := fx.pool.QueryRow(ctx, `SELECT count(*) FROM upload_sessions
		WHERE created_by IN ($1,$2) AND status='pending'`, fx.actorID, fx.ownerID).Scan(&held); err != nil {
		t.Fatal(err)
	}
	if err := fx.pool.QueryRow(ctx, `SELECT count(*) FROM editor_assets WHERE material_id=$1`, note.ID).Scan(&assetRows); err != nil {
		t.Fatal(err)
	}
	if held != 0 || assetRows != 0 {
		t.Fatalf("refused uploads left %d held sessions and %d asset rows", held, assetRows)
	}
}
