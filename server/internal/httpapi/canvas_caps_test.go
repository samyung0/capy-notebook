package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// TestCanvasScenesAndCountAreCapped (security regression: rate-limit audit
// H6). A scene's stored JSON stops at 512 KiB (413 canvas_too_large), the
// list carries no scenes, and an account past its canvas count answers 409
// canvas_limit.
func TestCanvasScenesAndCountAreCapped(t *testing.T) {
	h, st, _ := openGradingAPI(t, "full")
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM canvases WHERE user_id='u_owner'`)
	})
	rec := doReq(t, h, http.MethodPost, "/api/thinking", "u_owner", map[string]any{"name": "Caps"})
	var canvas struct{ ID string }
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &canvas) != nil {
		t.Fatalf("create canvas → %d %s", rec.Code, rec.Body.String())
	}
	path := "/api/thinking/" + canvas.ID
	scene := func(textBytes int) map[string]any {
		return map[string]any{"scene": map[string]any{"elements": []any{map[string]any{"text": strings.Repeat("x", textBytes)}}}}
	}
	if rec := doReq(t, h, http.MethodPut, path, "u_owner", scene(500<<10)); rec.Code != http.StatusOK {
		t.Fatalf("a 500 KiB scene → %d %s", rec.Code, rec.Body.String())
	}
	if rec := doReq(t, h, http.MethodPut, path, "u_owner", scene(512<<10)); rec.Code != http.StatusRequestEntityTooLarge ||
		errorCode(t, rec) != "canvas_too_large" {
		t.Fatalf("a scene past 512 KiB → %d %.200s, want 413 canvas_too_large", rec.Code, rec.Body.String())
	}

	rec = doReq(t, h, http.MethodGet, "/api/thinking", "u_owner", nil)
	var list []map[string]any
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &list) != nil || len(list) != 1 {
		t.Fatalf("list → %d %.200s", rec.Code, rec.Body.String())
	}
	if _, ok := list[0]["scene"]; ok {
		t.Fatal("the canvas list carries scenes")
	}

	if _, err := st.Pool().Exec(context.Background(), `INSERT INTO canvases (id, user_id, name)
		SELECT 'cv_cap_' || n, 'u_owner', 'Cap ' || n FROM generate_series(2, $1::int) n`, store.CanvasesPerUser); err != nil {
		t.Fatal(err)
	}
	if rec := doReq(t, h, http.MethodPost, "/api/thinking", "u_owner", map[string]any{"name": "One more"}); rec.Code != http.StatusConflict ||
		errorCode(t, rec) != "canvas_limit" {
		t.Fatalf("a canvas past the cap → %d %s, want 409 canvas_limit", rec.Code, rec.Body.String())
	}
}
