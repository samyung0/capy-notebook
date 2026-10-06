package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// The collaboration service's pass over ids an update brought into a note: the
// service secret is required, the actor must edit the note, another note's
// flashcard set the actor can read becomes a copy and an unknown id goes.
func TestAdoptMaterialChildren(t *testing.T) {
	ctx := context.Background()
	dsn := testdb.URL(t)
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
	suffix := time.Now().UnixNano()
	owner, stranger := fmt.Sprintf("u_children_%d", suffix), fmt.Sprintf("u_children_x_%d", suffix)
	for _, id := range []string{owner, stranger} {
		if _, err := pool.Exec(ctx, `INSERT INTO users (id,name,email) VALUES ($1,'Children',$2)`, id, id+"@example.test"); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1)`, []string{owner, stranger})
	})
	ws, err := st.CreateWorkspace(ctx, owner, store.WorkspaceCreate{Name: "Children"})
	if err != nil {
		t.Fatal(err)
	}
	note := func(title string) store.Material {
		mt, err := st.CreateMaterial(ctx, store.Material{CreatedBy: owner, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: title, Content: "# " + title})
		if err != nil {
			t.Fatal(err)
		}
		return mt
	}
	source, target := note("Source"), note("Target")
	set, err := st.CreateEmbeddedMaterial(ctx, owner, source.ID, store.EmbeddedDraft{Kind: "flashcards", Cards: [][2]string{{"front", "back"}}})
	if err != nil {
		t.Fatal(err)
	}
	handler := httpapi.New(st, blob.NewMemory(), nil, nil, "docling",
		httpapi.Config{AuthDisabled: true, DevUserID: owner, CollaborationSecret: "collab-test-secret"})
	call := func(secret, actor string) (int, map[string]any) {
		t.Helper()
		body, _ := json.Marshal(map[string]any{
			"actorUserId": actor, "assetIds": []string{},
			"materials": []map[string]any{{"materialId": set.ID}, {"materialId": "mat_gone"}},
		})
		request := httptest.NewRequest(http.MethodPost, "/internal/collaboration/materials/"+target.ID+"/children", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Collaboration-Secret", secret)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		var out map[string]any
		_ = json.Unmarshal(recorder.Body.Bytes(), &out)
		return recorder.Code, out
	}
	if code, _ := call("wrong", owner); code < 400 {
		t.Fatalf("wrong secret answered %d", code)
	}
	if code, _ := call("collab-test-secret", stranger); code != http.StatusNotFound {
		t.Fatalf("a stranger's update answered %d, want 404", code)
	}
	code, out := call("collab-test-secret", owner)
	if code != http.StatusOK {
		t.Fatalf("children answered %d: %v", code, out)
	}
	materials := out["materials"].([]any)
	copied := materials[0].(map[string]any)["id"].(string)
	if copied == "" || copied == set.ID || materials[1].(map[string]any)["id"] != "" {
		t.Fatalf("materials = %v, want a copy of the other note's set and the unknown id dropped", materials)
	}
	if mt, err := st.GetMaterial(ctx, copied); err != nil || mt.ParentMaterialID != target.ID {
		t.Fatalf("copy = %+v, %v", mt, err)
	}
}
