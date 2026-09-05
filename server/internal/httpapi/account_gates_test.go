package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/evonotes/server/internal/blob"
	"github.com/evonotes/server/internal/httpapi"
	"github.com/evonotes/server/internal/store"
	"github.com/evonotes/server/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
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
	workspaceID string
	material    store.Material
}

// overQuotaFixture builds an API surface for one throwaway user who has lapsed
// while over the free limit, plus a workspace they own. The user is created and
// dropped by this test alone, so the over-quota state cannot leak into the
// seeded e2e actors that the rest of the package shares.
func overQuotaFixture(t *testing.T) quotaFixture {
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

	ownerHandler := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", "evo",
		httpapi.Config{AuthDisabled: true, DevUserID: userID})
	memberHandler := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", "evo",
		httpapi.Config{
			AuthDisabled: true, E2EAuth: true, E2ESecret: "e2e-test-secret",
			E2EUserIDs: []string{"u_editor"},
		})

	ws, err := st.CreateWorkspace(ctx, userID, "Quota gate", store.ColorGreen, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role)
		VALUES ($1,'u_editor','editor')`, ws.ID); err != nil {
		t.Fatal(err)
	}
	// Content that predates the lapse. Creating it afterwards is impossible by
	// design, and what happens to already-stored content is the whole question.
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
	lapsed := time.Now().Add(-2 * 24 * time.Hour).UTC()
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
	if !status.ShrinkOnly() {
		t.Fatalf("setup did not reach an over-quota state, got %s", status.State)
	}
	return quotaFixture{
		owner: ownerHandler, member: memberHandler, workspaceID: ws.ID, material: material,
	}
}

// An over-quota account is under a creation gate, not a read-only lock. It has
// to keep the size-neutral edits it needs in order to find and remove content,
// while publishing stays blocked because a public material is an Explore
// surface whose clones are charged to whoever clones it.
func TestOverQuotaOwnerKeepsSizeNeutralEditsButCannotPublish(t *testing.T) {
	f := overQuotaFixture(t)
	h, workspaceID, material := f.owner, f.workspaceID, f.material

	rec := doReq(t, h, http.MethodPost, "/api/workspaces/"+workspaceID+"/materials", "",
		map[string]any{"kind": "note", "title": "Blocked"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("an over-quota account must not create, got %d body=%s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, h, http.MethodPatch, "/api/materials/"+material.ID+"/metadata", "", map[string]any{
		"title":            "After",
		"expectedRevision": material.Revision,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("an over-quota owner must still be able to rename their own material, "+
			"got %d body=%s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, h, http.MethodPatch, "/api/materials/"+material.ID+"/sharing", "", map[string]any{
		"privacy": "public",
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("publishing while over quota = %d body=%s", rec.Code, rec.Body.String())
	}
}

// A member's client has to be able to explain why writes into somebody else's
// workspace are refused. The bytes land on the owner, so the workspace reports
// the owner's lifecycle state and name rather than the reader's — a healthy
// editor reading an over-quota owner's workspace must still see the warning.
func TestWorkspaceReportsTheStorageOwnersStateNotTheReaders(t *testing.T) {
	f := overQuotaFixture(t)

	read := func(h http.Handler, actor string) (string, string) {
		t.Helper()
		rec := doReq(t, h, http.MethodGet, "/api/workspaces/"+f.workspaceID, actor, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("get workspace as %q = %d body=%s", actor, rec.Code, rec.Body.String())
		}
		var body struct {
			IsOwner           bool   `json:"isOwner"`
			StorageOwnerState string `json:"storageOwnerState"`
			StorageOwnerName  string `json:"storageOwnerName"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if actor != "" && body.IsOwner {
			t.Fatalf("%q must not read as the owner", actor)
		}
		return body.StorageOwnerState, body.StorageOwnerName
	}

	ownerState, ownerName := read(f.owner, "")
	if ownerState != string(store.AccountOverQuotaGrace) {
		t.Fatalf("owner's own read = %q, want %q", ownerState, store.AccountOverQuotaGrace)
	}
	if ownerName != "Quota Gate Test" {
		t.Errorf("owner name = %q, want the workspace owner's display name", ownerName)
	}

	memberState, memberName := read(f.member, "u_editor")
	if memberState != ownerState {
		t.Errorf("editor sees storageOwnerState %q, want the owner's %q — keying this on "+
			"the reader hides the only account whose limit blocks the workspace",
			memberState, ownerState)
	}
	if memberName != ownerName {
		t.Errorf("editor sees storageOwnerName %q, want %q", memberName, ownerName)
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

			revs := doReq(t, h, http.MethodGet, "/api/materials/"+id+"/revisions", "u_editor", nil)
			if revs.Code != http.StatusOK {
				t.Fatalf("revisions = %d body=%s", revs.Code, revs.Body.String())
			}
			var revisions []struct {
				CreatedBy *string `json:"createdBy"`
			}
			if err := json.Unmarshal(revs.Body.Bytes(), &revisions); err != nil {
				t.Fatal(err)
			}
			if len(revisions) == 0 {
				t.Fatal("creating a material must record its first revision")
			}
			author := "<null>"
			if recorded := revisions[len(revisions)-1].CreatedBy; recorded != nil {
				author = *recorded
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
