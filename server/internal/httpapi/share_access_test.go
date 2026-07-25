package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/evonotes/server/internal/auth"
	"github.com/evonotes/server/internal/blob"
	"github.com/evonotes/server/internal/httpapi"
	"github.com/evonotes/server/internal/store"
)

func openShareHTTP(t *testing.T) http.Handler {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	st, err := store.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	t.Cleanup(st.Close)
	return httpapi.New(st, blob.NewMemory(), nil, nil, "docling", "linearrag", httpapi.Config{
		AuthDisabled: true,
		E2EAuth:      true,
		E2ESecret:    "e2e-test-secret",
		E2EUserIDs:   []string{"u_owner", "u_editor", "u_commenter", "u_viewer", "u_other"},
	})
}

func doReq(t *testing.T, h http.Handler, method, path, userID string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, rdr)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if userID != "" {
		req.Header.Set(auth.HeaderE2EUserID, userID)
		req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestShareHTTPReads(t *testing.T) {
	h := openShareHTTP(t)

	cases := []struct {
		name   string
		user   string
		path   string
		status int
	}{
		{"owner private ws", "u_owner", "/api/workspaces/ws_e2e_private", 200},
		{"editor private ws", "u_editor", "/api/workspaces/ws_e2e_private", 200},
		{"other private ws", "u_other", "/api/workspaces/ws_e2e_private", 404},
		{"anon private ws", "", "/api/workspaces/ws_e2e_private", 404},
		{"anon link ws", "", "/api/workspaces/ws_e2e_link", 200},
		{"anon public ws", "", "/api/workspaces/ws_e2e_public", 200},
		{"anon private quiz", "", "/api/quizzes/qz_e2e_private", 404},
		{"anon link quiz", "", "/api/quizzes/qz_e2e_link", 200},
		{"anon link deck", "", "/api/decks/dk_e2e_link", 200},
		{"anon link cards", "", "/api/decks/dk_e2e_link/cards", 200},
		{"anon link chapters", "", "/api/workspaces/ws_e2e_link/chapters", 200},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doReq(t, h, http.MethodGet, tc.path, tc.user, nil)
			if rec.Code != tc.status {
				t.Fatalf("%s %s → %d body=%s", tc.user, tc.path, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestShareHTTPCapabilities(t *testing.T) {
	h := openShareHTTP(t)

	rec := doReq(t, h, http.MethodGet, "/api/workspaces/ws_e2e_link", "", nil)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	var anon map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &anon)
	caps := anon["capabilities"].(map[string]any)
	if caps["canView"] != true || caps["canEdit"] != false || caps["canManageMembers"] != false {
		t.Fatalf("anon caps = %#v", caps)
	}

	rec = doReq(t, h, http.MethodGet, "/api/workspaces/ws_e2e_private", "u_editor", nil)
	var editor map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &editor)
	caps = editor["capabilities"].(map[string]any)
	if caps["canEdit"] != true || caps["canManageMembers"] != false {
		t.Fatalf("editor caps = %#v", caps)
	}

	rec = doReq(t, h, http.MethodGet, "/api/workspaces/ws_e2e_private", "u_owner", nil)
	var owner map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &owner)
	caps = owner["capabilities"].(map[string]any)
	if caps["canManageMembers"] != true {
		t.Fatalf("owner caps = %#v", caps)
	}
}

func TestShareHTTPWritesAndClone(t *testing.T) {
	h := openShareHTTP(t)

	rec := doReq(t, h, http.MethodPost, "/api/workspaces", "u_owner", map[string]any{
		"name":    "Private-by-default workspace",
		"privacy": "public",
	})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("workspace create with unsupported privacy = %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, h, http.MethodPost, "/api/workspaces", "u_owner", map[string]any{
		"name": "Private-by-default workspace",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("workspace create = %d %s", rec.Code, rec.Body.String())
	}
	var createdWorkspace map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &createdWorkspace)
	if createdWorkspace["privacy"] != "private" {
		t.Fatalf("created workspace privacy = %q, want private", createdWorkspace["privacy"])
	}
	if id, _ := createdWorkspace["id"].(string); id != "" {
		t.Cleanup(func() {
			_ = doReq(t, h, http.MethodDelete, "/api/workspaces/"+id, "u_owner", nil)
		})
	}

	rec = doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_link/clone", "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anon clone = %d", rec.Code)
	}

	rec = doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/clone", "u_other", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("private clone by other = %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, h, http.MethodPost, "/api/quizzes/qz_e2e_link/clone", "u_other", nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("link quiz clone = %d %s", rec.Code, rec.Body.String())
	}
	var quiz map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &quiz)
	if quiz["privacy"] != "private" || quiz["isOwner"] != true {
		t.Fatalf("cloned quiz = %#v", quiz)
	}
	if id, _ := quiz["id"].(string); id != "" {
		_ = doReq(t, h, http.MethodDelete, "/api/quizzes/"+id, "u_other", nil)
	}

	rec = doReq(t, h, http.MethodPatch, "/api/workspaces/ws_e2e_mutate/sharing", "u_other", map[string]any{
		"privacy": "link",
	})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("non-owner privacy patch = %d", rec.Code)
	}

	rec = doReq(t, h, http.MethodPatch, "/api/workspaces/ws_e2e_mutate/sharing", "u_owner", map[string]any{
		"privacy": "link",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("owner privacy patch = %d %s", rec.Code, rec.Body.String())
	}
	// Restore private so other tests stay stable.
	_ = doReq(t, h, http.MethodPatch, "/api/workspaces/ws_e2e_mutate/sharing", "u_owner", map[string]any{
		"privacy": "private",
	})
}

func TestShareHTTPExploreAndAttempts(t *testing.T) {
	h := openShareHTTP(t)

	rec := doReq(t, h, http.MethodGet, "/api/explore/workspaces", "", nil)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	var workspaces []map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &workspaces)
	names := map[string]bool{}
	for _, ws := range workspaces {
		if n, ok := ws["name"].(string); ok {
			names[n] = true
		}
	}
	if !names["E2E Public Workspace"] {
		t.Fatalf("public workspace missing from explore: %#v", names)
	}
	if names["E2E Link Workspace"] {
		t.Fatal("link workspace must not appear on explore")
	}

	rec = doReq(t, h, http.MethodPost, "/api/quizzes/qz_e2e_link/attempts", "", map[string]any{
		"correct": 1, "total": 1, "wrong": []any{}, "answers": map[string]any{}, "questions": []any{},
	})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anon attempt = %d", rec.Code)
	}

	rec = doReq(t, h, http.MethodPost, "/api/quizzes/qz_e2e_private/attempts", "u_other", map[string]any{
		"correct": 0, "total": 1, "wrong": []any{}, "answers": map[string]any{}, "questions": []any{},
	})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("private attempt by other = %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, h, http.MethodPost, "/api/quizzes/qz_e2e_link/attempts", "u_other", map[string]any{
		"correct": 1, "total": 1, "wrong": []any{}, "answers": map[string]any{}, "questions": []any{},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("link attempt = %d %s", rec.Code, rec.Body.String())
	}

	// Flashcard material IDs must not accept quiz attempts.
	rec = doReq(t, h, http.MethodPost, "/api/quizzes/dk_e2e_link/attempts", "u_other", map[string]any{
		"correct": 1, "total": 1, "wrong": []any{}, "answers": map[string]any{}, "questions": []any{},
	})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("non-quiz attempt = %d %s", rec.Code, rec.Body.String())
	}
}

func TestCollaborationHTTPRolePermissionsAndRevisionLineage(t *testing.T) {
	h := openShareHTTP(t)
	content := map[string]any{
		"schemaVersion": 1,
		"value": []any{
			map[string]any{
				"type": "p", "id": "permission-block",
				"children": []any{map[string]any{"text": ""}},
			},
		},
	}
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/materials", "u_owner", map[string]any{
		"kind": "note", "title": "Collaboration permission matrix", "content": content,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create collaboration material = %d %s", rec.Code, rec.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	materialID := created["id"].(string)
	t.Cleanup(func() {
		_ = doReq(t, h, http.MethodDelete, "/api/materials/"+materialID, "u_owner", nil)
	})

	commentBody := map[string]any{
		"blockId": "permission-block",
		"anchor":  map[string]any{"blockId": "permission-block"},
		"contentRich": []any{
			map[string]any{"type": "p", "children": []any{map[string]any{"text": "feedback"}}},
		},
	}
	rec = doReq(t, h, http.MethodPost, "/api/materials/"+materialID+"/discussions",
		"u_viewer", commentBody)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer comment = %d %s, want 403", rec.Code, rec.Body.String())
	}
	rec = doReq(t, h, http.MethodPost, "/api/materials/"+materialID+"/discussions",
		"u_commenter", commentBody)
	if rec.Code != http.StatusCreated {
		t.Fatalf("commenter comment = %d %s", rec.Code, rec.Body.String())
	}

	marked := map[string]any{
		"schemaVersion": 1,
		"value": []any{
			map[string]any{
				"type": "p", "id": "permission-block",
				"children": []any{
					map[string]any{
						"text": "suggested", "suggestion": true,
						"suggestion_permission": map[string]any{
							"id": "permission-plate-id", "type": "insert",
						},
					},
				},
			},
		},
	}
	commitBody := map[string]any{"content": marked, "expectedRevision": 1}
	rec = doReq(t, h, http.MethodPost, "/api/materials/"+materialID+"/suggestion-commits",
		"u_viewer", commitBody)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer suggestion commit = %d %s, want 403", rec.Code, rec.Body.String())
	}
	rec = doReq(t, h, http.MethodPost, "/api/materials/"+materialID+"/suggestion-commits",
		"u_commenter", commitBody)
	if rec.Code != http.StatusCreated {
		t.Fatalf("commenter suggestion commit = %d %s", rec.Code, rec.Body.String())
	}

	reviewBody := map[string]any{
		"decision": "accept", "suggestionIds": []string{"permission-plate-id"},
		"expectedRevision": 2,
	}
	rec = doReq(t, h, http.MethodPost, "/api/materials/"+materialID+"/suggestions/review",
		"u_commenter", reviewBody)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("commenter review = %d %s, want 403", rec.Code, rec.Body.String())
	}
	rec = doReq(t, h, http.MethodPost, "/api/materials/"+materialID+"/suggestions/review",
		"u_editor", reviewBody)
	if rec.Code != http.StatusOK {
		t.Fatalf("editor review = %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, h, http.MethodGet, "/api/materials/"+materialID+"/revisions", "u_viewer", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("viewer revision history = %d %s", rec.Code, rec.Body.String())
	}
	var revisions []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &revisions); err != nil {
		t.Fatal(err)
	}
	if len(revisions) != 3 ||
		revisions[0]["eventType"] != "suggestion_accept" ||
		revisions[0]["parentRevision"] != float64(2) ||
		revisions[1]["eventType"] != "suggestion_commit" ||
		revisions[1]["parentRevision"] != float64(1) ||
		revisions[2]["eventType"] != "create" ||
		revisions[2]["parentRevision"] != nil {
		t.Fatalf("unexpected HTTP revision lineage: %#v", revisions)
	}
}
