package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// quotaFixture is an over-quota owner's workspace seen from both sides. The two
// handlers exist because the E2E header path and the dev-user path are mutually
// exclusive in the auth middleware.
type quotaFixture struct {
	// owner acts as the throwaway over-quota user; pass "" as the actor.
	owner http.Handler
	// member acts as a seeded workspace editor whose own account is healthy;
	// pass "u_editor" as the actor.
	member      http.Handler
	store       *store.Store
	workspaceID string
	material    store.Material
}

// overQuotaFixture builds an API surface for one throwaway user who has lapsed
// while over the free limit (lapsedDays ago: 2 is grace, 20 is frozen), plus a
// workspace they own. The user is created and dropped by this test alone, so
// the over-quota state cannot leak into the seeded e2e actors that the rest of
// the package shares.
func overQuotaFixture(t *testing.T, lapsedDays int) quotaFixture {
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

	userID := fmt.Sprintf("u_quota_gate_%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx, `INSERT INTO users (id,name,email,plan_tier)
		VALUES ($1,'Quota Gate Test',$2,'free')`,
		userID, fmt.Sprintf("%s@example.test", userID)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})

	ownerHandler := httpapi.New(st, blob.NewMemory(), nil, nil, "docling",
		httpapi.Config{AuthDisabled: true, DevUserID: userID, CollaborationSecret: "collab-test-secret"})
	memberHandler := httpapi.New(st, blob.NewMemory(), nil, nil, "docling",
		httpapi.Config{
			AuthDisabled: true, E2EAuth: true, E2ESecret: "e2e-test-secret",
			E2EUserIDs: []string{"u_editor"}, CollaborationSecret: "collab-test-secret",
		})

	ws, err := st.CreateWorkspace(ctx, userID, store.WorkspaceCreate{Name: "Quota gate", Tags: nil})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role)
		VALUES ($1,'u_editor','editor')`, ws.ID); err != nil {
		t.Fatal(err)
	}
	// Content that predates the lapse; what happens to it is the question.
	material, err := st.CreateMaterial(ctx, store.Material{
		CreatedBy: userID, WorkspaceID: ws.ID, Kind: "note", Title: "Before",
	})
	if err != nil {
		t.Fatal(err)
	}

	// The only route into this state that the creation gate permits: fill past
	// the free tier while paying, then stop paying.
	live := time.Now().Add(20 * 24 * time.Hour).UTC()
	sub := store.Subscription{
		StripeSubscriptionID: "sub_" + userID,
		UserID:               userID,
		Status:               "active",
		PriceID:              "price_pro",
		PlanTier:             store.PlanPro,
		CurrentPeriodEnd:     &live,
		StripeEventCreated:   time.Now().Unix() - 1,
	}
	if err := st.UpsertSubscription(ctx, sub); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateSourceReady(ctx, ws.ID, userID, "ballast.pdf", "pdf", nil, "",
		mustPlanLimits(t, st, store.PlanFree).StorageBytes+1, "sources/"+userID); err != nil {
		t.Fatal(err)
	}
	lapsed := time.Now().AddDate(0, 0, -lapsedDays).UTC()
	sub.Status = "canceled"
	sub.PlanTier = store.PlanFree
	sub.CurrentPeriodEnd = &lapsed
	sub.StripeEventCreated = time.Now().Unix()
	if err := st.UpsertSubscription(ctx, sub); err != nil {
		t.Fatal(err)
	}

	status, err := st.AccountAccess(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if !status.OverQuota() {
		t.Fatalf("setup did not reach an over-quota state, got %s", status.State)
	}
	return quotaFixture{
		owner: ownerHandler, member: memberHandler, store: st, workspaceID: ws.ID, material: material,
	}
}

// Grace behaves like an active account at its hard quota: growth fails the
// quota check against the Free limit and the content is view-only for owner
// and member (capabilities, read room tokens, refused comments and generation),
// while renaming, ordinary chat and publishing stay open.
func TestGraceOwnerIsHeldOnlyByTheQuota(t *testing.T) {
	f := overQuotaFixture(t, 2)
	h := f.owner

	quotaDetail := func(rec *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		var body struct {
			Errors []struct {
				Value map[string]any `json:"value"`
			} `json:"errors"`
		}
		if rec.Code != http.StatusForbidden || errorCode(t, rec) != "storage_quota_exceeded" ||
			json.Unmarshal(rec.Body.Bytes(), &body) != nil || len(body.Errors) != 1 {
			t.Fatalf("grace growth = %d body=%s, want the storage quota", rec.Code, rec.Body.String())
		}
		return body.Errors[0].Value
	}
	// The charged account sees its numbers; a member gets the code alone.
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/"+f.workspaceID+"/materials", "",
		map[string]any{"kind": "note", "title": "Growth"})
	if detail := quotaDetail(rec); detail["storageLimitBytes"] == nil || detail["ownerUserId"] == nil {
		t.Fatalf("owner refusal lacks its numbers: %s", rec.Body.String())
	}
	rec = doReq(t, f.member, http.MethodPost, "/api/workspaces/"+f.workspaceID+"/materials", "u_editor",
		map[string]any{"kind": "note", "title": "Member growth"})
	if detail := quotaDetail(rec); detail != nil {
		t.Fatalf("member refusal carries the owner's numbers: %s", rec.Body.String())
	}
	comment := map[string]any{"anchorVersion": 1, "contentRich": []any{map[string]any{
		"type": "p", "children": []any{map[string]any{"text": "x"}},
	}}}
	for _, side := range []struct {
		h     http.Handler
		actor string
	}{{f.owner, ""}, {f.member, "u_editor"}} {
		rec := doReq(t, side.h, http.MethodGet, "/api/workspaces/"+f.workspaceID, side.actor, nil)
		var ws struct {
			Capabilities struct {
				CanEdit        bool `json:"canEdit"`
				CanEditContent bool `json:"canEditContent"`
			} `json:"capabilities"`
		}
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &ws) != nil ||
			!ws.Capabilities.CanEdit || ws.Capabilities.CanEditContent {
			t.Fatalf("%q workspace read = %d body=%s, want organizing without content", side.actor, rec.Code, rec.Body.String())
		}
		rec = doReq(t, side.h, http.MethodPost, "/api/materials/"+f.material.ID+"/collaboration-token", side.actor, nil)
		var token struct {
			Access string `json:"access"`
		}
		if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &token) != nil || token.Access != "read" {
			t.Fatalf("%q room token = %d body=%s, want read", side.actor, rec.Code, rec.Body.String())
		}
		rec = doReq(t, side.h, http.MethodPost, "/api/materials/"+f.material.ID+"/discussions", side.actor, comment)
		if rec.Code != http.StatusForbidden || errorCode(t, rec) != "storage_quota_exceeded" {
			t.Fatalf("%q comment = %d body=%s", side.actor, rec.Code, rec.Body.String())
		}
		// Refused before the model is even resolved, so no credits move (these
		// handlers carry no model registry at all).
		rec = doReq(t, side.h, http.MethodPost, "/api/workspaces/"+f.workspaceID+"/generate", side.actor,
			generateBody("quiz", "Grace quiz"))
		if rec.Code != http.StatusForbidden || errorCode(t, rec) != "storage_quota_exceeded" {
			t.Fatalf("%q generate = %d body=%s", side.actor, rec.Code, rec.Body.String())
		}
		rec = doReq(t, side.h, http.MethodPost, "/api/workspaces/"+f.workspaceID+"/conversations", side.actor,
			map[string]any{"title": "Ask"})
		if rec.Code != http.StatusCreated {
			t.Fatalf("%q chat thread = %d body=%s", side.actor, rec.Code, rec.Body.String())
		}
	}
	rec = doReq(t, h, http.MethodPatch, "/api/materials/"+f.material.ID+"/metadata", "",
		map[string]any{"title": "After"})
	if rec.Code != http.StatusOK {
		t.Fatalf("grace rename = %d body=%s", rec.Code, rec.Body.String())
	}
	rec = doReq(t, h, http.MethodPatch, "/api/workspaces/"+f.workspaceID+"/sharing", "",
		map[string]any{"privacy": "public"})
	if rec.Code != http.StatusOK {
		t.Fatalf("grace publishing = %d body=%s", rec.Code, rec.Body.String())
	}
}

// Frozen is read-only for everyone in the frozen owner's workspace: capability
// flags, room tokens and writes agree, while deleting and narrowing stay open.
func TestFrozenOwnersWorkspaceIsReadOnly(t *testing.T) {
	f := overQuotaFixture(t, 20)
	comment := map[string]any{"anchorVersion": 1, "contentRich": []any{map[string]any{
		"type": "p", "children": []any{map[string]any{"text": "x"}},
	}}}

	for _, side := range []struct {
		h     http.Handler
		actor string
	}{{f.owner, ""}, {f.member, "u_editor"}} {
		rec := doReq(t, side.h, http.MethodGet, "/api/workspaces/"+f.workspaceID, side.actor, nil)
		var ws struct {
			Capabilities struct {
				CanEdit bool `json:"canEdit"`
			} `json:"capabilities"`
		}
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &ws) != nil || ws.Capabilities.CanEdit {
			t.Fatalf("%q workspace read = %d body=%s, want canEdit false", side.actor, rec.Code, rec.Body.String())
		}
		rec = doReq(t, side.h, http.MethodPost, "/api/materials/"+f.material.ID+"/collaboration-token", side.actor, nil)
		var token struct {
			Access string `json:"access"`
		}
		if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &token) != nil || token.Access != "read" {
			t.Fatalf("%q room token = %d body=%s, want read", side.actor, rec.Code, rec.Body.String())
		}
		rec = doReq(t, side.h, http.MethodPatch, "/api/materials/"+f.material.ID+"/metadata", side.actor,
			map[string]any{"title": "Blocked"})
		if rec.Code != http.StatusForbidden || errorCode(t, rec) != "account_over_quota" {
			t.Fatalf("%q rename = %d body=%s", side.actor, rec.Code, rec.Body.String())
		}
		rec = doReq(t, side.h, http.MethodPost, "/api/materials/"+f.material.ID+"/discussions", side.actor, comment)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%q comment = %d body=%s", side.actor, rec.Code, rec.Body.String())
		}
		// Chat stays open.
		rec = doReq(t, side.h, http.MethodPost, "/api/workspaces/"+f.workspaceID+"/conversations", side.actor,
			map[string]any{"title": "Ask"})
		if rec.Code != http.StatusCreated {
			t.Fatalf("%q chat thread = %d body=%s", side.actor, rec.Code, rec.Body.String())
		}
	}

	rec := doReq(t, f.owner, http.MethodPatch, "/api/workspaces/"+f.workspaceID+"/sharing", "",
		map[string]any{"privacy": "private"})
	if rec.Code != http.StatusOK {
		t.Fatalf("frozen narrowing = %d body=%s", rec.Code, rec.Body.String())
	}
	rec = doReq(t, f.member, http.MethodDelete, "/api/materials/"+f.material.ID, "u_editor", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete in a frozen workspace = %d body=%s", rec.Code, rec.Body.String())
	}
}

// A member's client has to be able to explain why writes into somebody else's
// workspace are refused. The bytes land on the owner, so the workspace reports
// the owner's lifecycle state and usage level rather than the reader's, and
// /me reports the reader's own usage.
func TestWorkspaceReportsTheStorageOwnersStateNotTheReaders(t *testing.T) {
	f := overQuotaFixture(t, 2)

	read := func(h http.Handler, actor string) (string, string) {
		t.Helper()
		rec := doReq(t, h, http.MethodGet, "/api/workspaces/"+f.workspaceID, actor, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("get workspace as %q = %d body=%s", actor, rec.Code, rec.Body.String())
		}
		var body struct {
			IsOwner           bool   `json:"isOwner"`
			StorageOwnerState string `json:"storageOwnerState"`
			StorageOwnerUsage string `json:"storageOwnerUsage"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if actor != "" && body.IsOwner {
			t.Fatalf("%q must not read as the owner", actor)
		}
		return body.StorageOwnerState, body.StorageOwnerUsage
	}

	ownerState, ownerUsage := read(f.owner, "")
	if ownerState != string(store.AccountOverQuotaGrace) || ownerUsage != string(store.StorageUsageFull) {
		t.Fatalf("owner's own read = %q %q, want grace and full", ownerState, ownerUsage)
	}
	memberState, memberUsage := read(f.member, "u_editor")
	if memberState != ownerState || memberUsage != ownerUsage {
		t.Errorf("editor sees %q %q, want the owner's %q %q — keying this on the reader "+
			"hides the only account whose limit blocks the workspace",
			memberState, memberUsage, ownerState, ownerUsage)
	}

	rec := doReq(t, f.member, http.MethodGet, "/api/me", "u_editor", nil)
	var me struct {
		Account struct {
			StorageUsage      string `json:"storageUsage"`
			StorageLimitBytes int64  `json:"storageLimitBytes"`
		} `json:"account"`
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &me) != nil ||
		me.Account.StorageUsage == "" || me.Account.StorageLimitBytes <= 0 {
		t.Fatalf("/me for a healthy account = %d body=%s, want usage filled", rec.Code, rec.Body.String())
	}
}

// Flashcard creation used to resolve the workspace with `WHERE id=$1 AND user_id=$2`,
// which made flashcards the only material kind a workspace editor could not
// create in someone else's workspace. The lookup missed rather than denied, so
// the failure surfaced as a raw pgx no-rows error and a 500.
func TestWorkspaceEditorCanCreateAndRenameFlashcards(t *testing.T) {
	h := openShareHTTP(t)

	rec := doReq(t, h, http.MethodPost, "/api/flashcards", "u_editor", map[string]any{
		"name":        "Editor flashcards",
		"workspaceId": "ws_e2e_private",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("editor flashcard create = %d body=%s", rec.Code, rec.Body.String())
	}
	var flashcardSet map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &flashcardSet)
	if flashcardSet["isOwner"] != false {
		t.Errorf("an editor is not the storage owner of what they create in the owner's "+
			"workspace, isOwner = %v", flashcardSet["isOwner"])
	}
	if flashcardSet["canEdit"] != true {
		t.Errorf("workspace editor canEdit = %v, want true", flashcardSet["canEdit"])
	}
	if id, _ := flashcardSet["id"].(string); id != "" {
		t.Cleanup(func() {
			_ = doReq(t, h, http.MethodDelete, "/api/materials/"+id, "u_owner", nil)
		})
		rec = doReq(t, h, http.MethodPatch, "/api/flashcards/"+id+"/metadata", "u_editor", map[string]any{
			"name": "Renamed flashcards",
		})
		if rec.Code != http.StatusOK {
			t.Fatalf("rename workspace flashcards = %d body=%s", rec.Code, rec.Body.String())
		}
		rec = doReq(t, h, http.MethodPatch, "/api/flashcards/"+id+"/sharing", "u_editor", map[string]any{
			"privacy": "public",
		})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("workspace flashcard visibility update = %d body=%s", rec.Code, rec.Body.String())
		}
	}

	// A non-member must still be refused, and refused as a miss rather than an
	// unhandled database error.
	rec = doReq(t, h, http.MethodPost, "/api/flashcards", "u_other", map[string]any{
		"name":        "Trespassing flashcards",
		"workspaceId": "ws_e2e_private",
	})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("non-member flashcard create = %d body=%s", rec.Code, rec.Body.String())
	}
}

// Generated materials are authored by whoever ran the generation, not by the
// account that pays for the bytes. CreateMaterial falls back to the workspace
// owner when CreatedBy is empty, so a caller that forgets to pass it silently
// records the owner as the author.
func TestGeneratedMaterialsRecordTheActorAsAuthor(t *testing.T) {
	h := openShareAPI(t, stubRetrieval(t))
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	for _, kind := range []string{"mindmap", "diagram", "flashcards", "quiz"} {
		t.Run(kind, func(t *testing.T) {
			rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate",
				"u_editor", generateBody(kind, kind+" generated"))
			if rec.Code != http.StatusOK {
				t.Fatalf("editor generate %s = %d body=%s", kind, rec.Code, rec.Body.String())
			}
			id := generatedMaterialID(t, rec.Body.Bytes())
			t.Cleanup(func() {
				_ = doReq(t, h, http.MethodDelete, "/api/materials/"+id, "u_owner", nil)
			})

			var author string
			if err := pool.QueryRow(ctx, `SELECT COALESCE(created_by,'<null>')
				FROM materials WHERE id=$1`, id).Scan(&author); err != nil {
				t.Fatal(err)
			}
			if author != "u_editor" {
				t.Errorf("generated %s author = %s, want u_editor", kind, author)
			}
		})
	}
}

func TestGenerateRequiresUniqueTitle(t *testing.T) {
	h := openShareAPI(t, stubRetrieval(t))
	body := generateBody("quiz", "Shared generate name")
	first := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate",
		"u_editor", body)
	if first.Code != http.StatusOK {
		t.Fatalf("first generate = %d body=%s", first.Code, first.Body.String())
	}
	id := generatedMaterialID(t, first.Body.Bytes())
	t.Cleanup(func() {
		_ = doReq(t, h, http.MethodDelete, "/api/materials/"+id, "u_owner", nil)
	})

	dup := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate",
		"u_editor", body)
	if dup.Code != http.StatusConflict {
		t.Fatalf("duplicate generate = %d body=%s", dup.Code, dup.Body.String())
	}

	blank := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate",
		"u_editor", generateBody("quiz", "  "))
	if blank.Code != http.StatusBadRequest {
		t.Fatalf("blank title = %d body=%s", blank.Code, blank.Body.String())
	}
}

// generatedMaterialID pulls the material id out of the generate response, whose
// envelope key depends on the kind.
func generatedMaterialID(t *testing.T, body []byte) string {
	t.Helper()
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"material", "flashcardSet", "quiz"} {
		raw, ok := payload[key]
		if !ok {
			continue
		}
		var entity struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &entity); err != nil {
			t.Fatal(err)
		}
		if entity.ID != "" {
			return entity.ID
		}
	}
	t.Fatalf("generate response carried no material id: %s", body)
	return ""
}

// Chat stays open in a frozen owner's workspace and in one whose owner is at
// its storage limit (grace), but the agent loses its create and edit tools:
// an editor keeps only reading and deleting.
func TestReadOnlyWorkspaceChatKeepsReadAndDeleteTools(t *testing.T) {
	for name, lapsedDays := range map[string]int{"frozen": 20, "grace": 2} {
		t.Run(name, func(t *testing.T) { chatKeepsReadAndDeleteTools(t, lapsedDays) })
	}
}

func chatKeepsReadAndDeleteTools(t *testing.T, lapsedDays int) {
	f := overQuotaFixture(t, lapsedDays)
	ctx := context.Background()
	var operations []string
	retrieval := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Operations []string `json:"operations"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			t.Error(err)
		}
		operations = in.Operations
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"done\"}\n\n"))
	}))
	t.Cleanup(retrieval.Close)
	reg, err := models.New(ctx, f.store.Pool())
	if err != nil {
		t.Fatal(err)
	}
	f.store.SetModelRegistry(reg)
	h := httpapi.New(f.store, blob.NewMemory(), pipeline.New(retrieval.URL, ""), nil, "docling",
		httpapi.Config{
			AuthDisabled: true, E2EAuth: true, E2ESecret: "e2e-test-secret",
			E2EUserIDs: []string{"u_editor"}, ModelRegistry: reg,
		})
	rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/"+f.workspaceID+"/chat/stream", "u_editor",
		map[string]any{"text": "what is here?"})
	if rec.Code != http.StatusOK {
		t.Fatalf("chat = %d body=%s", rec.Code, rec.Body.String())
	}
	want := []string{string(agenttools.OpSourceRead), string(agenttools.OpMaterialRead), string(agenttools.OpResourceTrash)}
	if !slices.Equal(operations, want) {
		t.Fatalf("chat operations = %v, want %v", operations, want)
	}
}
