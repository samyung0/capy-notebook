package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// Security (Q466, Epo 2026-10-28): an agent edit's signed Undo payload names
// the user whose tool call made the step, and its Undo admits only that user.
// Another editor of the same workspace holding the step's valid payload is
// refused before any lookup and without a receipt: while the step is still
// pending in its room, and again after the step's own Undo stored its receipt
// (which they must not be answered with). Fails if the route admits a
// pending step's payload for anyone with edit access.
func TestUndoEndpointAdmitsOnlyTheStepsActor(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	actor := fmt.Sprintf("u_undo_actor_%d", time.Now().UnixNano())
	other := actor + "_other"
	for _, id := range []string{actor, other} {
		if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id,name,email) VALUES ($1,'Undo',$2)`, id, id+"@example.test"); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, id) })
	}
	ws, err := st.CreateWorkspace(ctx, actor, store.WorkspaceCreate{Name: "Undo actor", Tags: []store.TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor')`, ws.ID, other); err != nil {
		t.Fatal(err)
	}
	created, _, err := st.CreateMaterialOperation(ctx, store.MaterialDraft{
		ID: "mat_" + actor, ActorUserID: actor, WorkspaceID: ws.ID, Kind: "flashcards", Title: "Cells",
		Cards: [][2]string{{"Cell", "Unit of life"}},
	}, store.AgentOperation{ID: "op_" + actor, RequestHash: "c1", ActorUserID: actor, WorkspaceID: ws.ID})
	if err != nil {
		t.Fatal(err)
	}
	material := created.Effect.Resource.ID
	// The step its room admitted and has not stored: only its signed payload.
	edit := "op_edit_" + actor
	payload := signedUndoPayload(t, st, edit, material, actor)
	var asked atomic.Int32
	authority := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked.Add(1)
		var body struct {
			ActorUserID string                  `json:"actorUserId"`
			Operation   store.DocumentOperation `json:"operation"`
			UndoOf      string                  `json:"undoOf"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		effect := fmt.Sprintf(`{"operation":"edit_undone","operationId":%q,"resource":{"kind":"material","id":%q}}`, body.Operation.ID, material)
		if _, err := st.Pool().Exec(context.Background(), `INSERT INTO agent_operations (id,kind,request_hash,actor_user_id,workspace_id,outcome,effect,undo_of)
			VALUES ($1,'undo_edit',$2,$3,$4,'succeeded',$5,$6)`, body.Operation.ID, body.Operation.RequestHash, body.ActorUserID, ws.ID, effect, body.UndoOf); err != nil {
			t.Error(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"operationId": body.Operation.ID, "outcome": "succeeded", "effect": json.RawMessage(effect)})
	}))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")
	as := func(user string) http.Handler {
		return httpapi.New(st, blob.NewMemory(), nil, nil, "docling", httpapi.Config{AuthDisabled: true, DevUserID: user})
	}
	path := "/api/chat/edit-operations/" + edit + "/undo"

	rec := doReq(t, as(other), http.MethodPost, path, "", map[string]any{"requestId": "o1", "payload": payload})
	if rec.Code != http.StatusNotFound || asked.Load() != 0 {
		t.Fatalf("another editor with the pending step's payload: %d %s, %d room calls", rec.Code, rec.Body.String(), asked.Load())
	}
	if _, err := st.UndoReceipt(ctx, edit); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a receipt after the refused Undo: %v", err)
	}

	rec = doReq(t, as(actor), http.MethodPost, path, "", map[string]any{"requestId": "a1", "payload": payload})
	if rec.Code != http.StatusOK || asked.Load() != 1 {
		t.Fatalf("the actor's Undo: %d %s", rec.Code, rec.Body.String())
	}
	receipt, err := st.UndoReceipt(ctx, edit)
	if err != nil || receipt.ActorUserID != actor {
		t.Fatalf("the actor's receipt = %+v %v", receipt, err)
	}
	rec = doReq(t, as(other), http.MethodPost, path, "", map[string]any{"requestId": "o2", "payload": payload})
	if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), receipt.ID) || asked.Load() != 1 {
		t.Fatalf("another editor after the stored Undo: %d %s, %d room calls", rec.Code, rec.Body.String(), asked.Load())
	}
}
