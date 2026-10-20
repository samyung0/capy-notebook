package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// The chat's Undo endpoint walks a created file's chain: Undo trashes it, the
// returned step's Undo (Redo) restores it, and a used step is refused.
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
	undoAs(handler(other), edit, "x2", http.StatusNotFound)

	trashed := undo(created.ID, "r1", http.StatusOK)
	if trashed.Effect == nil || trashed.Effect.Operation != "trashed" || trashed.Effect.Undo == nil {
		t.Fatalf("undo of create = %+v", trashed.Effect)
	}
	restored := undo(trashed.Effect.Undo.OperationID, "r2", http.StatusOK)
	if restored.Effect == nil || restored.Effect.Operation != "restored" || restored.Effect.Undo == nil {
		t.Fatalf("redo = %+v", restored.Effect)
	}
	// The same request replays its receipt; the used step is refused.
	if again := undo(created.ID, "r1", http.StatusOK); again.ID != trashed.ID {
		t.Fatalf("replay = %+v", again)
	}
	undo(created.ID, "r3", http.StatusConflict)
}
