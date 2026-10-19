package httpapi_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// Security regression: a source-change resolve is checked in Go before it is
// forwarded to the collaboration authority: an actor who cannot read the
// workspace, or a file outside the named workspace, is refused and nothing is
// proxied; an actor with access is forwarded.
func TestSourceChangeResolveChecksAccessBeforeTheProxy(t *testing.T) {
	h, st := openInternalHTTP(t)
	var forwarded atomic.Int32
	authority := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"bytes":"","mimeType":"image/png","sha256":""}`))
	}))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")

	resolve := func(userID, workspaceID string) *httptest.ResponseRecorder {
		return doInternal(t, h, http.MethodPost, "/api/internal/source-changes/resolve", pipeSecret, map[string]any{
			"workspaceId": workspaceID, "userId": userID, "fileId": "f_e2e_private",
			"epoch": 1, "checkpoint": 1, "changeId": "c_1",
		})
	}
	// The owner of both workspaces passes the actor check on the one that does
	// not hold the file, so that case reaches the file check.
	if _, err := st.WorkspaceEffectiveRole(context.Background(), "u_owner", "ws_e2e_link"); err != nil {
		t.Fatalf("fixture: u_owner cannot read ws_e2e_link: %v", err)
	}
	for _, tc := range []struct{ name, userID, workspaceID string }{
		{"actor without access", "u_other", "ws_e2e_private"},
		{"file outside the workspace", "u_owner", "ws_e2e_link"},
	} {
		if rec := resolve(tc.userID, tc.workspaceID); rec.Code != http.StatusNotFound || forwarded.Load() != 0 {
			t.Fatalf("%s: status %d, forwarded %d, body %s", tc.name, rec.Code, forwarded.Load(), rec.Body.String())
		}
	}
	if rec := resolve("u_editor", "ws_e2e_private"); rec.Code != http.StatusOK || forwarded.Load() != 1 {
		t.Fatalf("member: status %d, forwarded %d, body %s", rec.Code, forwarded.Load(), rec.Body.String())
	}
}
