package httpapi_test

import (
	"net/http"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/pipeline"
)

// TestTodoRouteIsTheCallersOwn: it needs a session, and answers with the list.
func TestTodoRouteIsTheCallersOwn(t *testing.T) {
	h := openShareAPI(t, pipeline.New("http://127.0.0.1:1", ""))
	if rec := doReq(t, h, http.MethodGet, "/api/todo", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no session: status = %d", rec.Code)
	}
	if rec := doReq(t, h, http.MethodGet, "/api/todo", "u_owner", nil); rec.Code != http.StatusOK {
		t.Fatalf("signed in: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doReq(t, h, http.MethodGet, "/api/todo/done?dir=asc&type=quiz", "u_owner", nil); rec.Code != http.StatusOK {
		t.Fatalf("Done tab: status = %d body=%s", rec.Code, rec.Body.String())
	}
	// A To do tick needs a session, and answers not found for an assignment
	// that isn't there.
	if rec := doReq(t, h, http.MethodPut, "/api/assignments/as_missing/todo-check", "", map[string]any{"checked": true}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("tick without a session: status = %d", rec.Code)
	}
	if rec := doReq(t, h, http.MethodPut, "/api/assignments/as_missing/todo-check", "u_owner", map[string]any{"checked": true}); rec.Code != http.StatusNotFound {
		t.Fatalf("tick on a missing assignment: status = %d body=%s", rec.Code, rec.Body.String())
	}
	// Removing rows from Done skips ids that aren't the caller's.
	if rec := doReq(t, h, http.MethodPost, "/api/todo/done/hide", "u_owner", map[string]any{"ids": []string{"as_missing"}}); rec.Code != http.StatusNoContent {
		t.Fatalf("remove from Done: status = %d body=%s", rec.Code, rec.Body.String())
	}
}
