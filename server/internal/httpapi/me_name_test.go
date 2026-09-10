package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// PATCH /api/me owns the display name: trimmed, non-empty, at most 60 runes.
func TestUpdateMeName(t *testing.T) {
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
	userID := fmt.Sprintf("u_me_name_%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx, `INSERT INTO users (id,name,email) VALUES ($1,'Provider Name',$2)`,
		userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})
	h := httpapi.New(st, blob.NewMemory(), nil, nil, "docling",
		httpapi.Config{AuthDisabled: true, DevUserID: userID})

	for _, bad := range []string{"", "   ", strings.Repeat("名", 61)} {
		rec := doReq(t, h, http.MethodPatch, "/api/me", "", map[string]any{"name": bad})
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("name %q: status %d, want 422", bad, rec.Code)
		}
	}

	var me struct {
		Name string `json:"name"`
	}
	rec := doReq(t, h, http.MethodPatch, "/api/me", "", map[string]any{"name": "  Padded  "})
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if me.Name != "Padded" {
		t.Fatalf("returned name = %q, want trimmed", me.Name)
	}
	rec = doReq(t, h, http.MethodPatch, "/api/me", "", map[string]any{"name": strings.Repeat("名", 60)})
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	rec = doReq(t, h, http.MethodGet, "/api/me", "", nil)
	if err := json.Unmarshal(rec.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if me.Name != strings.Repeat("名", 60) {
		t.Fatalf("GET /api/me name = %q", me.Name)
	}
}
