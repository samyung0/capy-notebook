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
	h := httpapi.New(st, blob.NewMemory(), nil, nil, "docling",
		httpapi.Config{AuthDisabled: true, DevUserID: userID})
	undo := func(operationID, requestID string, want int) store.AgentOperation {
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
