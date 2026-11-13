package httpapi_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

// A workspace's canvases (Epo 2026-11-12): a member lists and makes any number
// there, and opens each by id; a non-member reaches none of them.
func TestWorkspaceCanvasesFollowTheMembership(t *testing.T) {
	h := openShareHTTP(t)
	var ids []string
	for _, title := range []string{"Plan", "Scratch"} {
		rec := doReq(t, h, http.MethodPost, "/api/canvases", "u_owner",
			map[string]any{"title": title, "workspaceId": "ws_e2e_private"})
		if rec.Code != http.StatusCreated {
			t.Fatalf("make %s → %d %s", title, rec.Code, rec.Body)
		}
		var made struct{ ID string }
		if err := json.Unmarshal(rec.Body.Bytes(), &made); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, made.ID)
	}
	rec := doReq(t, h, http.MethodGet, "/api/canvases?workspaceId=ws_e2e_private", "u_owner", nil)
	var page struct {
		Items []struct{ ID, WorkspaceID string }
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("list → %d %s", rec.Code, rec.Body)
	}
	if len(page.Items) != 2 || page.Items[0].WorkspaceID != "ws_e2e_private" {
		t.Fatalf("the workspace's canvases = %+v", page.Items)
	}
	if rec := doReq(t, h, http.MethodGet, "/api/canvases/"+ids[0], "u_owner", nil); rec.Code != http.StatusOK {
		t.Fatalf("open by id → %d", rec.Code)
	}
	for _, call := range []struct{ method, path string }{
		{http.MethodGet, "/api/canvases?workspaceId=ws_e2e_private"},
		{http.MethodPost, "/api/canvases"},
		{http.MethodGet, "/api/canvases/" + ids[0]},
	} {
		var body any
		if call.method == http.MethodPost {
			body = map[string]any{"title": "Mine", "workspaceId": "ws_e2e_private"}
		}
		if rec := doReq(t, h, call.method, call.path, "u_other", body); rec.Code != http.StatusNotFound {
			t.Errorf("non-member %s %s → %d, want 404", call.method, call.path, rec.Code)
		}
	}
}
