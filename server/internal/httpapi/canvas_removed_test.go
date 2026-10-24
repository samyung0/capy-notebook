package httpapi_test

import (
	"context"
	"net/http"
	"testing"
)

// TestThinkingCanvasIsGone (Epo 2026-10-24, Q242). The thinking canvas was
// removed whole: its routes answer 404 and its table is gone.
func TestThinkingCanvasIsGone(t *testing.T) {
	h, st, _ := openGradingAPI(t, "full")
	for _, call := range []struct{ method, path string }{
		{http.MethodGet, "/api/thinking"},
		{http.MethodPost, "/api/thinking"},
		{http.MethodGet, "/api/thinking/cv_1"},
		{http.MethodPut, "/api/thinking/cv_1"},
	} {
		if rec := doReq(t, h, call.method, call.path, "u_owner", nil); rec.Code != http.StatusNotFound {
			t.Errorf("%s %s → %d, want 404", call.method, call.path, rec.Code)
		}
	}
	var table *string
	if err := st.Pool().QueryRow(context.Background(), `SELECT to_regclass('public.canvases')::text`).Scan(&table); err != nil {
		t.Fatal(err)
	}
	if table != nil {
		t.Fatalf("table %s still exists", *table)
	}
}
