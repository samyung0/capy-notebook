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

// PUT /api/me/customization stores a valid look, GET /api/me returns it, and
// anything out of bounds or unknown is refused.
func TestCustomization(t *testing.T) {
	dsn := testdb.URL(t)
	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	userID := fmt.Sprintf("u_customization_%d", time.Now().UnixNano())
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id,name,email) VALUES ($1,'Look',$2)`,
		userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})
	h := httpapi.New(st, blob.NewMemory(), nil, nil, "docling",
		httpapi.Config{AuthDisabled: true, DevUserID: userID})
	valid := func() map[string]any {
		return map[string]any{
			"style": "classroom",
			"theme": "mocha",
			"pageFrame": map[string]any{
				"pattern": "arc", "colours": "custom", "strength": 0.75, "grain": 0.35,
				"dots": []map[string]any{{"x": 0.9, "y": 0.25}, {"x": 0.5, "y": 0.3}},
			},
		}
	}
	bad := []func(map[string]any){
		func(b map[string]any) { b["theme"] = "neon" },
		func(b map[string]any) { b["extra"] = true },
		func(b map[string]any) { b["pageFrame"].(map[string]any)["pattern"] = "stripes" },
		func(b map[string]any) { b["pageFrame"].(map[string]any)["strength"] = 1.5 },
		func(b map[string]any) { b["pageFrame"].(map[string]any)["image"] = "https://example.test/x.png" },
		func(b map[string]any) {
			b["pageFrame"].(map[string]any)["dots"] = []map[string]any{{"x": 0, "y": 0}, {"x": 0, "y": 0}, {"x": 0, "y": 0}, {"x": 0, "y": 0}}
		},
	}
	for i, mutate := range bad {
		body := valid()
		mutate(body)
		if rec := doReq(t, h, http.MethodPut, "/api/me/customization", "", body); rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("bad body %d: status %d, want 422: %s", i, rec.Code, rec.Body.String())
		}
	}
	if rec := doReq(t, h, http.MethodPut, "/api/me/customization", "", valid()); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var me struct {
		Customization store.Customization `json:"customization"`
	}
	rec := doReq(t, h, http.MethodGet, "/api/me", "", nil)
	if err := json.Unmarshal(rec.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	got := me.Customization
	if got.Theme != "mocha" || got.PageFrame.Pattern != "arc" || len(got.PageFrame.Dots) != 2 || got.PageFrame.Grain != 0.35 {
		t.Fatalf("customization = %+v", got)
	}
}
