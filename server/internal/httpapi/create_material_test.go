package httpapi_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// A workspace takes new notes but no new mind map (Epo 2026-11-13).
func TestCreateMaterialRefusesMindmaps(t *testing.T) {
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
	userID := fmt.Sprintf("u_create_material_%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx, `INSERT INTO users (id,name,email) VALUES ($1,'Create',$2)`, userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})
	ws, err := st.CreateWorkspace(ctx, userID, store.WorkspaceCreate{Name: "Create"})
	if err != nil {
		t.Fatal(err)
	}
	h := httpapi.New(st, blob.NewMemory(), nil, nil, "docling",
		httpapi.Config{AuthDisabled: true, DevUserID: userID, CollaborationSecret: "collab-test-secret"})
	for kind, want := range map[string]int{"note": http.StatusCreated, "mindmap": http.StatusBadRequest} {
		rec := doReq(t, h, http.MethodPost, "/api/workspaces/"+ws.ID+"/materials", "",
			map[string]any{"kind": kind, "title": "Made"})
		if rec.Code != want {
			t.Errorf("create %s = %d body=%s, want %d", kind, rec.Code, rec.Body.String(), want)
		}
	}
}
