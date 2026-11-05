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
}
