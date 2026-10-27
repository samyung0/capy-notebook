package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
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

// The chat's Undo endpoint walks a created file's chain: Undo trashes it, the
// returned step's Undo (Redo) restores it, and a used step answers with its
// receipt (live-Undo review H1: a retry or a second click).
func TestUndoEndpointWalksACreatedFilesChain(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	userID := fmt.Sprintf("u_undo_chain_%d", time.Now().UnixNano())
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id,name,email) VALUES ($1,'Undo',$2)`,
		userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})
	ws, err := st.CreateWorkspace(ctx, userID, store.WorkspaceCreate{Name: "Undo chain", Tags: []store.TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	created, _, err := st.CreateMaterialOperation(ctx, store.MaterialDraft{
		ID: "mat_" + userID, ActorUserID: userID, WorkspaceID: ws.ID, Kind: "flashcards", Title: "Cells",
		Cards: [][2]string{{"Cell", "Unit of life"}},
	}, store.AgentOperation{ID: "op_" + userID, RequestHash: "c1", ActorUserID: userID, WorkspaceID: ws.ID})
	if err != nil {
		t.Fatal(err)
	}
	handler := func(user string) http.Handler {
		return httpapi.New(st, blob.NewMemory(), nil, nil, "docling",
			httpapi.Config{AuthDisabled: true, DevUserID: user})
	}
	h := handler(userID)
	undoAs := func(h http.Handler, operationID, requestID string, want int) store.AgentOperation {
		t.Helper()
		rec := doReq(t, h, http.MethodPost, "/api/chat/edit-operations/"+operationID+"/undo", "",
			map[string]string{"requestId": requestID})
		if rec.Code != want {
			t.Fatalf("undo %s: status %d, want %d: %s", operationID, rec.Code, want, rec.Body.String())
		}
		var receipt store.AgentOperation
		_ = json.Unmarshal(rec.Body.Bytes(), &receipt)
		return receipt
	}
	undo := func(operationID, requestID string, want int) store.AgentOperation {
		t.Helper()
		return undoAs(h, operationID, requestID, want)
	}

	// Security regression (chat Undo access): only the step's actor with
	// current edit access may run it. A workspace editor who is not the actor
	// gets not found and the file stays; so does the actor of an edit who is
	// now a viewer, refused before the collaboration service (none is set up
	// here, which would answer 503).
	other := userID + "_other"
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id,name,email) VALUES ($1,'Other',$2)`,
		other, other+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, other)
	})
	if _, err := st.Pool().Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor')`,
		ws.ID, other); err != nil {
		t.Fatal(err)
	}
	undoAs(handler(other), created.ID, "x1", http.StatusNotFound)
	edit := "op_edit_" + userID
	if _, err := st.Pool().Exec(ctx, `INSERT INTO agent_operations (id,kind,request_hash,actor_user_id,workspace_id,outcome,effect)
		VALUES ($1,'edit_document','e1',$2,$3,'succeeded',$4)`, edit, other, ws.ID,
		fmt.Sprintf(`{"operation":"edited","resource":{"kind":"material","id":%q},"undo":{"operationId":%q,"status":"available"}}`,
			created.Effect.Resource.ID, edit)); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE workspace_members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2`,
		ws.ID, other); err != nil {
		t.Fatal(err)
	}
	// With the step's own signed payload, so only the role refuses it.
	payload := signedUndoPayload(t, st, edit, created.Effect.Resource.ID, other)
	rec := doReq(t, handler(other), http.MethodPost, "/api/chat/edit-operations/"+edit+"/undo", "",
		map[string]any{"requestId": "x2", "payload": payload})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("a viewer's Undo of their edit: %d %s", rec.Code, rec.Body.String())
	}

	trashed := undo(created.ID, "r1", http.StatusOK)
	if trashed.Effect == nil || trashed.Effect.Operation != "trashed" || trashed.Effect.Undo == nil {
		t.Fatalf("undo of create = %+v", trashed.Effect)
	}
	restored := undo(trashed.Effect.Undo.OperationID, "r2", http.StatusOK)
	if restored.Effect == nil || restored.Effect.Operation != "restored" || restored.Effect.Undo == nil {
		t.Fatalf("redo = %+v", restored.Effect)
	}
	// The same request replays its receipt; another request for the used
	// step gets that receipt too.
	if again := undo(created.ID, "r1", http.StatusOK); again.ID != trashed.ID {
		t.Fatalf("replay = %+v", again)
	}
	if again := undo(created.ID, "r3", http.StatusOK); again.ID != trashed.ID {
		t.Fatalf("used step = %+v", again)
	}
}

// A chat Undo whose client goes away while its payload is written still
// records its receipt (the work runs uncancelled), and a second request for
// the step under another request id (a second click) answers with that
// receipt without asking the collaboration service again (live-Undo review
// H1: fails if the endpoint drops the work with the request or runs two at
// once).
func TestUndoEndpointKeepsOneReceiptPerStep(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	userID := fmt.Sprintf("u_undo_once_%d", time.Now().UnixNano())
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id,name,email) VALUES ($1,'Undo',$2)`,
		userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})
	ws, err := st.CreateWorkspace(ctx, userID, store.WorkspaceCreate{Name: "Undo once", Tags: []store.TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	created, _, err := st.CreateMaterialOperation(ctx, store.MaterialDraft{
		ID: "mat_" + userID, ActorUserID: userID, WorkspaceID: ws.ID, Kind: "flashcards", Title: "Cells",
		Cards: [][2]string{{"Cell", "Unit of life"}},
	}, store.AgentOperation{ID: "op_" + userID, RequestHash: "c1", ActorUserID: userID, WorkspaceID: ws.ID})
	if err != nil {
		t.Fatal(err)
	}
	edit := "op_edit_" + userID
	if _, err := st.Pool().Exec(ctx, `INSERT INTO agent_operations (id,kind,request_hash,actor_user_id,workspace_id,outcome,effect)
		VALUES ($1,'edit_document','e1',$2,$3,'succeeded',$4)`, edit, userID, ws.ID,
		fmt.Sprintf(`{"operation":"edited","resource":{"kind":"material","id":%q},"undo":{"operationId":%q,"status":"available"}}`,
			created.Effect.Resource.ID, edit)); err != nil {
		t.Fatal(err)
	}
	payload := signedUndoPayload(t, st, edit, created.Effect.Resource.ID, userID)
	// The collaboration service: the Undo lands after the client left, its
	// receipt committed with the write (r1 M2).
	started := make(chan struct{}, 1)
	var undos atomic.Int32
	authority := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		undos.Add(1)
		started <- struct{}{}
		time.Sleep(300 * time.Millisecond)
		var body struct {
			Operation store.DocumentOperation `json:"operation"`
			UndoOf    string                  `json:"undoOf"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		effect := fmt.Sprintf(`{"operation":"edit_undone","operationId":%q,"resource":{"kind":"material","id":%q}}`,
			body.Operation.ID, created.Effect.Resource.ID)
		if _, err := st.Pool().Exec(context.Background(), `INSERT INTO agent_operations (id,kind,request_hash,actor_user_id,workspace_id,outcome,effect,undo_of)
			VALUES ($1,'undo_edit',$2,$3,$4,'succeeded',$5,$6)`, body.Operation.ID, body.Operation.RequestHash, userID, ws.ID, effect, body.UndoOf); err != nil {
			t.Error(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"operationId": body.Operation.ID, "outcome": "succeeded", "effect": json.RawMessage(effect)})
	}))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")
	h := httpapi.New(st, blob.NewMemory(), nil, nil, "docling",
		httpapi.Config{AuthDisabled: true, DevUserID: userID})
	path := "/api/chat/edit-operations/" + edit + "/undo"

	gone, leave := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		raw, _ := json.Marshal(map[string]any{"requestId": "r1", "payload": payload})
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw)).WithContext(gone)
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(httptest.NewRecorder(), req)
	}()
	<-started
	// The second click arrives while the room is still reverting the first.
	second := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		second <- doReq(t, h, http.MethodPost, path, "", map[string]any{"requestId": "r2", "payload": payload})
	}()
	leave()
	<-done
	rec := <-second
	receipt, err := st.UndoReceipt(ctx, edit)
	if err != nil {
		t.Fatalf("the left request's receipt: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("second request: %d %s", rec.Code, rec.Body.String())
	}
	var again store.AgentOperation
	_ = json.Unmarshal(rec.Body.Bytes(), &again)
	if again.ID != receipt.ID || undos.Load() != 1 {
		t.Fatalf("second request answered %s (first %s) after %d room calls", again.ID, receipt.ID, undos.Load())
	}
}

// signedUndoPayload asks the store to sign `step`'s payload the way an edit's
// receipt gets it: through EditDocument, against an authority answering the
// edit with that payload.
func signedUndoPayload(t *testing.T, st *store.Store, step, materialID, actor string) *store.UndoPayload {
	t.Helper()
	authority := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"operationId": step, "outcome": "succeeded",
			"undoPayload": map[string]any{"epoch": 1, "issuedAt": time.Now().Unix(), "updates": map[string]string{"content": "dW5kbw=="}},
		})
	}))
	defer authority.Close()
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")
	receipt, err := st.EditDocument(context.Background(), actor,
		store.DocumentTarget{Kind: "material", ID: materialID}, nil, nil, store.DocumentOperation{ID: step})
	if err != nil || receipt.UndoPayload == nil {
		t.Fatalf("signing: %+v %v", receipt.UndoPayload, err)
	}
	return receipt.UndoPayload
}

// Q403 (Epo 2026-10-26): an agent edit's Undo clicked before its room
// stored the edit has no stored receipt yet; it goes to the room on its
// signed payload, the document the signature names, and the room (which
// holds the step) checks the rest. A payload not this server's signature is
// refused before the room. Fails if the Undo needs the stored receipt.
func TestUndoEndpointSendsAnUnstoredStepToItsRoom(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	userID := fmt.Sprintf("u_undo_unstored_%d", time.Now().UnixNano())
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id,name,email) VALUES ($1,'Undo',$2)`,
		userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})
	ws, err := st.CreateWorkspace(ctx, userID, store.WorkspaceCreate{Name: "Undo unstored", Tags: []store.TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	created, _, err := st.CreateMaterialOperation(ctx, store.MaterialDraft{
		ID: "mat_" + userID, ActorUserID: userID, WorkspaceID: ws.ID, Kind: "flashcards", Title: "Cells",
		Cards: [][2]string{{"Cell", "Unit of life"}},
	}, store.AgentOperation{ID: "op_" + userID, RequestHash: "c1", ActorUserID: userID, WorkspaceID: ws.ID})
	if err != nil {
		t.Fatal(err)
	}
	material := created.Effect.Resource.ID
	edit := "op_edit_" + userID
	payload := signedUndoPayload(t, st, edit, material, userID)
	forged := *payload
	forged.MAC = strings.Repeat("0", 64)
	var asked []map[string]any
	authority := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		asked = append(asked, body)
		op, _ := body["operation"].(map[string]any)
		_ = json.NewEncoder(w).Encode(map[string]any{"operationId": op["id"], "outcome": "succeeded",
			"effect": map[string]any{"operation": "edit_undone", "resource": map[string]any{"kind": "material", "id": material}}})
	}))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")
	h := httpapi.New(st, blob.NewMemory(), nil, nil, "docling",
		httpapi.Config{AuthDisabled: true, DevUserID: userID})
	path := "/api/chat/edit-operations/" + edit + "/undo"
	if rec := doReq(t, h, http.MethodPost, path, "", map[string]any{"requestId": "r0", "payload": forged}); rec.Code != http.StatusNotFound || len(asked) != 0 {
		t.Fatalf("a forged payload: %d %s, %d room calls", rec.Code, rec.Body.String(), len(asked))
	}
	rec := doReq(t, h, http.MethodPost, path, "", map[string]any{"requestId": "r1", "payload": payload})
	if rec.Code != http.StatusOK || len(asked) != 1 {
		t.Fatalf("the unstored step's Undo: %d %s, %d room calls", rec.Code, rec.Body.String(), len(asked))
	}
	target, _ := asked[0]["target"].(map[string]any)
	if asked[0]["undoOf"] != edit || target["kind"] != "material" || target["id"] != material {
		t.Fatalf("the room was sent %v", asked[0])
	}
}
