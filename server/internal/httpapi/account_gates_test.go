package httpapi_test

import (
	"bytes"
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
	// pass "u_editor" as the actor ("u_viewer" is a viewer member, "u_other"
	// a nonmember).
	member      http.Handler
	store       *store.Store
	workspaceID string
	material    store.Material
	// ballast is the owner's file that put it over the limit.
	ballast store.File
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

	// One bucket for both sides, holding the ballast file's bytes.
	memory := blob.NewMemory()
	if _, _, err := memory.Put("sources/"+userID, bytes.NewReader([]byte("%PDF"))); err != nil {
		t.Fatal(err)
	}
	ownerHandler := httpapi.New(st, memory, nil, nil, "docling",
		httpapi.Config{AuthDisabled: true, DevUserID: userID, CollaborationSecret: "collab-test-secret"})
	memberHandler := httpapi.New(st, memory, nil, nil, "docling",
		httpapi.Config{
			AuthDisabled: true, E2EAuth: true, E2ESecret: "e2e-test-secret",
			E2EUserIDs: []string{"u_editor", "u_viewer", "u_other"}, CollaborationSecret: "collab-test-secret",
		})

	ws, err := st.CreateWorkspace(ctx, userID, store.WorkspaceCreate{Name: "Quota gate", Tags: nil})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role)
		VALUES ($1,'u_editor','editor'), ($1,'u_viewer','viewer')`, ws.ID); err != nil {
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
	ballast, err := uploadSource(ctx, st, ws.ID, userID, "ballast.pdf",
		mustPlanLimits(t, st, store.PlanFree).StorageBytes+1, "sources/"+userID)
	if err != nil {
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
		ballast: ballast,
	}
}

// Grace behaves like an active account at its hard quota: the grace owner's
// own growth fails the quota check against the Free limit and what it pays for
// is view-only for owner and member (room tokens, refused comments, the
// storageFull strip), while a healthy member keeps adding what it pays for
// itself (uploader pays) and renaming, ordinary chat and publishing stay open.
func TestGraceOwnerIsHeldOnlyByTheQuota(t *testing.T) {
	f := overQuotaFixture(t, 2)
	h := f.owner

	rec := doReq(t, h, http.MethodPost, "/api/workspaces/"+f.workspaceID+"/materials", "",
		map[string]any{"kind": "note", "title": "Growth"})
	var body struct {
		Errors []struct {
			Value map[string]any `json:"value"`
		} `json:"errors"`
	}
	if rec.Code != http.StatusForbidden || errorCode(t, rec) != "storage_quota_exceeded" ||
		json.Unmarshal(rec.Body.Bytes(), &body) != nil || len(body.Errors) != 1 ||
		body.Errors[0].Value["storageLimitBytes"] == nil {
		t.Fatalf("grace growth = %d body=%s, want the storage quota with its numbers", rec.Code, rec.Body.String())
	}
	rec = doReq(t, f.member, http.MethodPost, "/api/workspaces/"+f.workspaceID+"/materials", "u_editor",
		map[string]any{"kind": "note", "title": "Member growth"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("member growth = %d body=%s, want created on the member's own quota", rec.Code, rec.Body.String())
	}
	comment := map[string]any{"anchorVersion": 1, "contentRich": []any{map[string]any{
		"type": "p", "children": []any{map[string]any{"text": "x"}},
	}}}
	for _, side := range []struct {
		h     http.Handler
		actor string
		full  string
	}{{f.owner, "", "self"}, {f.member, "u_editor", "payer"}} {
		rec := doReq(t, side.h, http.MethodGet, "/api/materials/"+f.material.ID, side.actor, nil)
		var material struct {
			Capabilities struct {
				CanEdit        bool `json:"canEdit"`
				CanEditContent bool `json:"canEditContent"`
			} `json:"capabilities"`
			StorageFull string `json:"storageFull"`
		}
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &material) != nil ||
			!material.Capabilities.CanEdit || material.Capabilities.CanEditContent || material.StorageFull != side.full {
			t.Fatalf("%q material read = %d body=%s, want organizing without content, full by %q",
				side.actor, rec.Code, rec.Body.String(), side.full)
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
		rec = doReq(t, side.h, http.MethodPost, "/api/workspaces/"+f.workspaceID+"/conversations", side.actor,
			map[string]any{"title": "Ask"})
		if rec.Code != http.StatusCreated {
			t.Fatalf("%q chat thread = %d body=%s", side.actor, rec.Code, rec.Body.String())
		}
	}
	// A file's links carry the payer's full storage for those who could edit
	// it; a viewer was never editing, so it gets no strip.
	for _, side := range []struct {
		h     http.Handler
		actor string
		full  string
	}{{f.owner, "", "self"}, {f.member, "u_editor", "payer"}, {f.member, "u_viewer", ""}} {
		rec := doReq(t, side.h, http.MethodGet, "/api/files/"+f.ballast.ID+"/links", side.actor, nil)
		var links struct {
			StorageFull string `json:"storageFull"`
		}
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &links) != nil || links.StorageFull != side.full {
			t.Fatalf("%q file links = %d body=%s, want full by %q", side.actor, rec.Code, rec.Body.String(), side.full)
		}
	}
	// A nonmember on a public share follows its share role the same way.
	for _, share := range []struct{ role, full string }{{"viewer", ""}, {"editor", "payer"}} {
		if _, err := f.store.Pool().Exec(context.Background(),
			`UPDATE workspaces SET privacy='public', share_role=$2 WHERE id=$1`, f.workspaceID, share.role); err != nil {
			t.Fatal(err)
		}
		rec := doReq(t, f.member, http.MethodGet, "/api/files/"+f.ballast.ID+"/links", "u_other", nil)
		var links struct {
			StorageFull string `json:"storageFull"`
		}
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &links) != nil || links.StorageFull != share.full {
			t.Fatalf("public %s visitor file links = %d body=%s, want full by %q", share.role, rec.Code, rec.Body.String(), share.full)
		}
	}
	// Refused before the model is even resolved, so no credits move (these
	// handlers carry no model registry at all).
	rec = doReq(t, h, http.MethodPost, "/api/workspaces/"+f.workspaceID+"/generate", "",
		generateBody("quiz", "Grace quiz"))
	if rec.Code != http.StatusForbidden || errorCode(t, rec) != "storage_quota_exceeded" {
		t.Fatalf("grace generate = %d body=%s", rec.Code, rec.Body.String())
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

// Frozen is read-only for what the frozen account pays for, for owner and
// member alike (room tokens, renames, comments), and the frozen owner edits
// nowhere; a healthy member keeps editing its own workspace role, and
// deleting, narrowing and chat stay open.
func TestFrozenOwnersItemsAreReadOnly(t *testing.T) {
	f := overQuotaFixture(t, 20)
	comment := map[string]any{"anchorVersion": 1, "contentRich": []any{map[string]any{
		"type": "p", "children": []any{map[string]any{"text": "x"}},
	}}}

	for _, side := range []struct {
		h       http.Handler
		actor   string
		canEdit bool
	}{{f.owner, "", false}, {f.member, "u_editor", true}} {
		rec := doReq(t, side.h, http.MethodGet, "/api/workspaces/"+f.workspaceID, side.actor, nil)
		var ws struct {
			Capabilities struct {
				CanEdit bool `json:"canEdit"`
			} `json:"capabilities"`
		}
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &ws) != nil || ws.Capabilities.CanEdit != side.canEdit {
			t.Fatalf("%q workspace read = %d body=%s, want canEdit %v", side.actor, rec.Code, rec.Body.String(), side.canEdit)
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

// Study progress is the reader's own data: a frozen account records ratings,
// marks and resets, and so does a healthy member in a frozen owner's workspace.
func TestFrozenAccountsRecordStudyProgress(t *testing.T) {
	f := overQuotaFixture(t, 20)
	ctx := context.Background()
	frozen := f.material.CreatedBy
	// A healthy editor's set the frozen account can read.
	ws, err := f.store.CreateWorkspace(ctx, "u_editor", store.WorkspaceCreate{Name: "Shared cards"})
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'viewer')`, ws.ID, frozen); err != nil {
		t.Fatal(err)
	}
	set, err := f.store.CreateFlashcardSetWithCards(ctx, "u_editor", "Cards", "blue", ws.ID,
		[][2]string{{"Golgi", "Ships proteins"}}, "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	cards, err := f.store.ListCards(ctx, set.ID)
	if err != nil {
		t.Fatal(err)
	}
	rec := doReq(t, f.owner, http.MethodPost, "/api/review/ratings", "",
		map[string]any{"materialId": set.ID, "itemId": cards[0].ID, "rating": 3})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("frozen rating = %d body=%s", rec.Code, rec.Body.String())
	}
	for _, side := range []struct {
		h     http.Handler
		actor string
	}{{f.owner, ""}, {f.member, "u_editor"}} {
		rec := doReq(t, side.h, http.MethodPut, "/api/workspaces/"+f.workspaceID+"/study/items", side.actor,
			map[string]any{"materialId": f.material.ID, "state": "done"})
		if rec.Code != http.StatusNoContent {
			t.Fatalf("%q mark as read = %d body=%s", side.actor, rec.Code, rec.Body.String())
		}
		rec = doReq(t, side.h, http.MethodPost, "/api/workspaces/"+f.workspaceID+"/study/reset", side.actor, nil)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("%q reset = %d body=%s", side.actor, rec.Code, rec.Body.String())
		}
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

// Chat stays open to a frozen or grace (at its storage limit) actor, but its
// agent loses the create and edit tools: what it would create is charged to
// it (uploader pays). A healthy member in that owner's workspace keeps them.
func TestReadOnlyWorkspaceChatKeepsReadAndDeleteTools(t *testing.T) {
	for name, lapsedDays := range map[string]int{"frozen": 20, "grace": 2} {
		t.Run(name, func(t *testing.T) { chatKeepsReadAndDeleteTools(t, lapsedDays) })
	}
}

func chatKeepsReadAndDeleteTools(t *testing.T, lapsedDays int) {
	f := overQuotaFixture(t, lapsedDays)
	ctx := context.Background()
	owner := f.material.CreatedBy
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
			E2EUserIDs: []string{"u_editor", owner}, ModelRegistry: reg,
		})
	chat := func(actor string) []string {
		t.Helper()
		rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/"+f.workspaceID+"/chat/stream", actor,
			map[string]any{"text": "what is here?"})
		if rec.Code != http.StatusOK {
			t.Fatalf("chat as %s = %d body=%s", actor, rec.Code, rec.Body.String())
		}
		return operations
	}
	// The over-quota actor (it pays for what the agent would create) keeps
	// reading and deleting; frozen also loses restoring.
	want := []string{}
	for _, op := range agenttools.OperationsForRole(string(store.RoleOwner)) {
		if op == agenttools.OpMaterialCreate || op == agenttools.OpDocumentEdit ||
			(lapsedDays > 14 && op == agenttools.OpTrashRestore) {
			continue
		}
		want = append(want, string(op))
	}
	if got := chat(owner); !slices.Equal(got, want) {
		t.Fatalf("over-quota owner's chat operations = %v, want %v", got, want)
	}
	// A healthy member creates and edits on its own quota.
	if got := chat("u_editor"); !slices.Contains(got, string(agenttools.OpMaterialCreate)) {
		t.Fatalf("healthy member's chat operations = %v, want material creation", got)
	}
}
