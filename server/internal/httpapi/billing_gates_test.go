package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/planlimits"
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

// Audio the browser read as longer than two hours, or with no length read
// (no credit estimate is possible), is refused before its bytes are stored;
// the worker checks the measured duration again.
func TestUploadPolicyServesAudioLimitAndUploadEnforcesIt(t *testing.T) {
	fx := openBilling(t)
	rec := doReq(t, fx.handler, http.MethodGet, "/api/source-upload-policy", fx.actorID, nil)
	var policy apimodel.SourceUploadPolicy
	if err := json.Unmarshal(rec.Body.Bytes(), &policy); err != nil {
		t.Fatal(err)
	}
	if policy.AudioMaxDurationSeconds != 7200 || policy.AudioSecondCreditMicros != 16_667 {
		t.Fatalf("audio policy: %d s at %d micros", policy.AudioMaxDurationSeconds, policy.AudioSecondCreditMicros)
	}
	upload := func(seconds int) *httptest.ResponseRecorder {
		return postUpload(t, fx.handler,
			"/api/workspaces/"+fx.workspaceID+"/sources/uploads", fx.actorID, map[string]any{
				"name": "lecture.mp3", "kind": "audio", "sizeBytes": 1024, "contentType": "audio/mpeg",
				"durationSeconds": seconds, "batchId": fx.workspaceID, "batchTotal": 2,
			}, "audio/mpeg", make([]byte, 1024))
	}
	if missing := upload(0); missing.Code != http.StatusBadRequest ||
		!strings.Contains(missing.Body.String(), "need their duration") {
		t.Fatalf("audio without a duration: %d %s", missing.Code, missing.Body.String())
	}
	if over := upload(7201); over.Code != http.StatusBadRequest ||
		!strings.Contains(over.Body.String(), "at most 2 hours") {
		t.Fatalf("audio over the limit: %d %s", over.Code, over.Body.String())
	}
	if ok := upload(7200); ok.Code != http.StatusCreated {
		t.Fatalf("audio at the limit: %d %s", ok.Code, ok.Body.String())
	}
}

// The material response carries the reader's own editor caps, since what they
// add is charged to them (M16; Epo 2026-10-22: the browser checks a note image
// or audio against them before it uploads): a Free co-editor of a Pro owner's
// note reads the Free caps, and the other way round. The image cap is the
// same on every plan (Epo 2026-10-24), so the audio cap tells them apart.
func TestMaterialCarriesTheReadersEditorCaps(t *testing.T) {
	fx := openBilling(t)
	ctx := context.Background()
	free, pro := mustPlanLimits(t, fx.store, store.PlanFree), mustPlanLimits(t, fx.store, store.PlanPro)
	if free.EditorAssetBytes("audio") == pro.EditorAssetBytes("audio") {
		t.Fatal("the Free and Pro audio caps must differ for this test")
	}
	note, err := fx.store.CreateMaterial(ctx, store.Material{CreatedBy: fx.ownerID, WorkspaceID: fx.workspaceID,
		Kind: "note", Title: "Caps", Content: noteTestContent(t, "")})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, fx.store, note.ID)
	for _, tc := range []struct {
		owner, reader string
		want          planlimits.Limits
	}{{"pro", "free", free}, {"free", "pro", pro}} {
		for user, tier := range map[string]string{fx.ownerID: tc.owner, fx.actorID: tc.reader} {
			if _, err := fx.pool.Exec(ctx, `UPDATE users SET plan_tier=$2 WHERE id=$1`, user, tier); err != nil {
				t.Fatal(err)
			}
		}
		rec := doReq(t, fx.handler, http.MethodGet, "/api/materials/"+note.ID, fx.actorID, nil)
		expectStatus(t, rec, http.StatusOK, "the co-editor's read")
		var caps struct{ AudioMaxBytes, ImageMaxBytes int64 }
		if err := json.Unmarshal(rec.Body.Bytes(), &caps); err != nil {
			t.Fatal(err)
		}
		if caps.AudioMaxBytes != tc.want.EditorAssetBytes("audio") || caps.ImageMaxBytes != tc.want.EditorAssetBytes("image") {
			t.Fatalf("a %s reader of a %s owner's note reads audio %d and image %d", tc.reader, tc.owner,
				caps.AudioMaxBytes, caps.ImageMaxBytes)
		}
	}
}

// A member removed from a workspace finds the image it still pays for in the
// owner's note on its Files page and deletes it there; nobody else can. The
// note then names it as removed to its readers, and an embedded quiz names its
// own removed image in its own response (M16).
func TestRemovedMemberDeletesItsMediaOverHTTP(t *testing.T) {
	fx := openBilling(t)
	ctx := context.Background()
	assetID := fmt.Sprintf("asset_m16_%d", time.Now().UnixNano())
	content, err := materialdoc.Marshal(materialdoc.Envelope{SchemaVersion: materialdoc.SchemaVersion, Value: []map[string]any{
		materialdoc.ParagraphNode("Look."),
		{"type": "img", "id": "img-1", "assetId": assetID, "children": []any{map[string]any{"text": ""}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	note, err := fx.store.CreateMaterial(ctx, store.Material{CreatedBy: fx.ownerID, WorkspaceID: fx.workspaceID,
		Kind: "note", Title: "Owner's note", Content: noteTestContent(t, "")})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, fx.store, note.ID)
	quiz, err := fx.store.CreateEmbeddedMaterial(ctx, fx.ownerID, note.ID, store.EmbeddedDraft{Kind: "quiz",
		Questions: json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`)})
	if err != nil {
		t.Fatal(err)
	}
	quizAssetID := assetID + "_quiz"
	quizContent, err := materialdoc.QuizDocument(json.RawMessage(`[{"id":"q1","stem":[{"type":"image","image":{"assetId":"`+quizAssetID+`"},"width":10,"height":10,"description":"Figure"}],
		"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ assetID, materialID, content string }{{assetID, note.ID, content}, {quizAssetID, quiz.ID, quizContent}} {
		_, upload, err := fx.store.CreateEditorAssetReservation(ctx, store.NewEditorAssetReservation{
			AssetID: item.assetID, UploadID: item.assetID + "_up", WorkspaceID: fx.workspaceID, MaterialID: item.materialID,
			CreatedBy: fx.actorID, Name: "figure.png", Purpose: "image", ObjectPath: "editor-assets/" + item.assetID + "/blob.png",
			ContentType: "image/png", DeclaredSize: 100, ExpiresAt: time.Now().Add(time.Hour),
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fx.store.FinalizeEditorAssetUpload(ctx, upload.ID, "etag"); err != nil {
			t.Fatal(err)
		}
		if _, err := fx.pool.Exec(ctx, `UPDATE materials SET content=$2 WHERE id=$1`, item.materialID, item.content); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fx.pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`,
		fx.workspaceID, fx.actorID); err != nil {
		t.Fatal(err)
	}

	rec := doReq(t, fx.handler, http.MethodGet, "/api/editor-assets?access=lost", fx.actorID, nil)
	expectStatus(t, rec, http.StatusOK, "the removed member's lost media")
	var lost store.EditorAssetPage
	if err := json.Unmarshal(rec.Body.Bytes(), &lost); err != nil {
		t.Fatal(err)
	}
	if len(lost.Items) != 2 {
		t.Fatalf("lost media = %+v, want both images", lost.Items)
	}
	// One per page: the cursor reaches the second and the end.
	var paged []string
	for path := "/api/editor-assets?access=lost&limit=1"; path != ""; {
		rec := doReq(t, fx.handler, http.MethodGet, path, fx.actorID, nil)
		expectStatus(t, rec, http.StatusOK, path)
		var page store.EditorAssetPage
		if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil || len(page.Items) != 1 || len(paged) > 1 {
			t.Fatalf("%s = %s, %v", path, rec.Body.String(), err)
		}
		paged = append(paged, page.Items[0].ID)
		path = ""
		if page.NextCursor != "" {
			path = "/api/editor-assets?access=lost&limit=1&cursor=" + page.NextCursor
		}
	}
	if len(paged) != 2 || paged[0] != lost.Items[0].ID || paged[1] != lost.Items[1].ID {
		t.Fatalf("paged %v, want %s then %s", paged, lost.Items[0].ID, lost.Items[1].ID)
	}
	for _, item := range lost.Items {
		if item.MaterialTitle != note.Title || !item.LostAccess || item.MaterialID != "" {
			t.Fatalf("lost image %s is under %q, want the note's title %q", item.ID, item.MaterialTitle, note.Title)
		}
	}
	for _, id := range []string{assetID, quizAssetID} {
		path := "/api/editor-assets/" + id
		expectStatus(t, doReq(t, fx.handler, http.MethodDelete, path, fx.ownerID, nil), http.StatusNotFound, "the owner deleting it")
		expectStatus(t, doReq(t, fx.handler, http.MethodDelete, path, fx.actorID, nil), http.StatusNoContent, "its payer deleting it")
	}

	for _, read := range []struct{ path, want string }{
		{"/api/materials/" + note.ID, assetID}, {"/api/quizzes/" + quiz.ID, quizAssetID},
	} {
		rec = doReq(t, fx.handler, http.MethodGet, read.path, fx.ownerID, nil)
		expectStatus(t, rec, http.StatusOK, "the owner's read")
		var body struct{ RemovedAssetIDs []string }
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(body.RemovedAssetIDs, []string{read.want}) {
			t.Fatalf("%s removedAssetIds = %v, want only its own deleted image %s", read.path, body.RemovedAssetIDs, read.want)
		}
	}
}

// Study names the card images their uploader deleted, as the editor does
// (Epo 2026-10-24, M16): the set read flashcard study uses, a new review
// session and the items a continued one has still to answer list the removed
// image. Answered items and a session's result are graded copies, which keep
// the plain empty box (Q270), so they name none.
func TestStudyReadsNameRemovedImages(t *testing.T) {
	fx := openBilling(t)
	ctx := context.Background()
	assetID := fmt.Sprintf("asset_m16_study_%d", time.Now().UnixNano())
	card := materialdoc.Card{ID: "c1", Front: "Cell", Back: "Unit of life"}
	other := materialdoc.Card{ID: "c2", Front: "Atom", Back: "Unit of matter"}
	plain, err := materialdoc.FlashcardsDocument([]materialdoc.Card{card, other})
	if err != nil {
		t.Fatal(err)
	}
	set, err := fx.store.CreateMaterial(ctx, store.Material{CreatedBy: fx.ownerID, WorkspaceID: fx.workspaceID,
		Kind: "flashcards", Title: "Cells", Content: plain})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, fx.store, set.ID)
	_, upload, err := fx.store.CreateEditorAssetReservation(ctx, store.NewEditorAssetReservation{
		AssetID: assetID, UploadID: assetID + "_up", WorkspaceID: fx.workspaceID, MaterialID: set.ID, CreatedBy: fx.actorID,
		Name: "cell.png", Purpose: "image", ObjectPath: "editor-assets/" + assetID + "/blob.png",
		ContentType: "image/png", DeclaredSize: 100, ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fx.store.FinalizeEditorAssetUpload(ctx, upload.ID, "etag"); err != nil {
		t.Fatal(err)
	}
	card.Image = &materialdoc.CardImage{AssetID: assetID}
	cards, err := materialdoc.FlashcardsDocument([]materialdoc.Card{card, other})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fx.pool.Exec(ctx, `UPDATE materials SET content=$2 WHERE id=$1`, set.ID, cards); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, doReq(t, fx.handler, http.MethodDelete, "/api/editor-assets/"+assetID, fx.actorID, nil),
		http.StatusNoContent, "its payer deleting it")

	removed := func(path string, want ...string) {
		t.Helper()
		rec := doReq(t, fx.handler, http.MethodGet, path, fx.ownerID, nil)
		expectStatus(t, rec, http.StatusOK, path)
		var body struct{ RemovedAssetIDs []string }
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(body.RemovedAssetIDs, want) {
			t.Fatalf("%s removedAssetIds = %v, want %v; %s", path, body.RemovedAssetIDs, want, rec.Body.String())
		}
	}
	rate := func(session, itemID string, items ...string) {
		t.Helper()
		refs := make([]any, len(items))
		for i, id := range items {
			refs[i] = map[string]any{"materialId": set.ID, "itemId": id}
		}
		expectStatus(t, doReq(t, fx.handler, http.MethodPost, "/api/review/ratings", fx.ownerID, map[string]any{
			"materialId": set.ID, "itemId": itemID, "rating": 1,
			"session": map[string]any{"id": session, "workspaceId": fx.workspaceID, "group": "workspace", "items": refs},
		}), http.StatusNoContent, "rating "+itemID)
	}
	removed("/api/flashcards/"+set.ID, assetID)
	// One session answers the other card first, with the imaged one still to
	// answer; another answers the imaged card.
	const pending, answered = "2b6f7c1d-4e5a-4b3c-9d8e-0f1a2b3c4d5e", "7c1d2b6f-5a4e-4c3b-8e9d-1a0f2b3c4d5e"
	rate(pending, "c2", "c1", "c2")
	rate(answered, "c1", "c1")
	removed("/api/review/sessions/"+pending, assetID)
	removed("/api/review/sessions/" + answered)
	removed("/api/review/sessions/" + answered + "/result")
	// Rated cards are due: a new session has the imaged card to answer.
	removed("/api/workspaces/"+fx.workspaceID+"/review", assetID)
}

// An editor that still edits the owner's note deletes its image from its
// Embeds tab (Q273): the note's content keeps the node, and the owner's next
// read names it as removed. The owner, who did not add it, cannot delete it.
func TestEditorDeletesItsImageInANoteItStillEdits(t *testing.T) {
	fx := openBilling(t)
	ctx := context.Background()
	assetID := fmt.Sprintf("asset_q273_%d", time.Now().UnixNano())
	note, err := fx.store.CreateMaterial(ctx, store.Material{CreatedBy: fx.ownerID, WorkspaceID: fx.workspaceID,
		Kind: "note", Title: "Shared note", Content: noteTestContent(t, "")})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, fx.store, note.ID)
	_, upload, err := fx.store.CreateEditorAssetReservation(ctx, store.NewEditorAssetReservation{
		AssetID: assetID, UploadID: assetID + "_up", WorkspaceID: fx.workspaceID, MaterialID: note.ID, CreatedBy: fx.actorID,
		Name: "figure.png", Purpose: "image", ObjectPath: "editor-assets/" + assetID + "/blob.png",
		ContentType: "image/png", DeclaredSize: 100, ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fx.store.FinalizeEditorAssetUpload(ctx, upload.ID, "etag"); err != nil {
		t.Fatal(err)
	}
	content, err := materialdoc.Marshal(materialdoc.Envelope{SchemaVersion: materialdoc.SchemaVersion, Value: []map[string]any{
		{"type": "img", "id": "img-1", "assetId": assetID, "children": []any{map[string]any{"text": ""}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fx.pool.Exec(ctx, `UPDATE materials SET content=$2 WHERE id=$1`, note.ID, content); err != nil {
		t.Fatal(err)
	}
	path := "/api/editor-assets/" + assetID
	expectStatus(t, doReq(t, fx.handler, http.MethodDelete, path, fx.ownerID, nil), http.StatusNotFound, "the owner deleting it")
	expectStatus(t, doReq(t, fx.handler, http.MethodDelete, path, fx.actorID, nil), http.StatusNoContent, "its payer deleting it")
	rec := doReq(t, fx.handler, http.MethodGet, "/api/materials/"+note.ID, fx.ownerID, nil)
	expectStatus(t, rec, http.StatusOK, "the owner's read")
	var read struct{ RemovedAssetIDs []string }
	if err := json.Unmarshal(rec.Body.Bytes(), &read); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(read.RemovedAssetIDs, []string{assetID}) || !strings.Contains(rec.Body.String(), `"assetId":"`+assetID+`"`) {
		t.Fatalf("owner's read = %s; want the node kept and named as removed", rec.Body.String())
	}
}

// The upload checks again what its ticket checked: a file within the cap when
// its ticket was issued but over it when it uploads (the payer's plan fell),
// and a reservation over the storage that filled while it waited, are refused
// at the upload with nothing held: both for sources, the storage for editor
// assets (security regression: human backend-storage-quota 2026-10-22 gateway
// uploads).
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
	// The image cap is the same on every plan (Epo 2026-10-24): only the
	// storage can change between an image's ticket and its upload.
	png := testPNG(108)
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
