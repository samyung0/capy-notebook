package httpapi_test

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/auth"
)

// TestChatStreamBodyCappedBeforeDecode (security regression: rate-limit audit
// H4). A chat body over 128 KiB is refused with 413 before it is decoded, and
// retrieval never sees the turn.
func TestChatStreamBodyCappedBeforeDecode(t *testing.T) {
	h, _, bodies := streamCapture(t)
	raw := `{"text":"teach me` + strings.Repeat(" ", 129<<10) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", bytes.NewReader([]byte(raw)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(auth.HeaderE2EUserID, "u_editor")
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body %s", rec.Code, rec.Body.String())
	}
	if len(*bodies) != 0 {
		t.Fatalf("retrieval saw %d turns", len(*bodies))
	}
}
