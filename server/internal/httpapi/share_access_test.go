package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/evonotes/server/internal/auth"
	"github.com/evonotes/server/internal/blob"
	"github.com/evonotes/server/internal/httpapi"
	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/pipeline"
	"github.com/evonotes/server/internal/store"
	"github.com/evonotes/server/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

func openShareHTTP(t *testing.T) http.Handler {
	return openShareAPI(t, nil)
}

func openShareAPI(t *testing.T, pipe *pipeline.Client) http.Handler {
	t.Helper()
	dsn := testdb.URL(t)
	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	t.Cleanup(st.Close)
	reg, err := models.New(ctx, st.Pool())
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	st.SetModelRegistry(reg)
	return httpapi.New(st, blob.NewMemory(), pipe, nil, "docling", "evo", httpapi.Config{
		AuthDisabled:  true,
		E2EAuth:       true,
		E2ESecret:     "e2e-test-secret",
		E2EUserIDs:    []string{"u_owner", "u_editor", "u_commenter", "u_viewer", "u_other"},
		ModelRegistry: reg,
	})
}

func generateBody(kind, title string) map[string]any {
	return map[string]any{
		"kind":   kind,
		"count":  1,
		"levels": []string{"recall"},
		"title":  title,
	}
}

func stubRetrieval(t *testing.T) *pipeline.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Kind string `json:"kind"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		w.Header().Set("Content-Type", "application/json")
		switch in.Kind {
		case "quiz":
			_, _ = w.Write([]byte(`{"kind":"quiz","name":"n","questions":[{"id":"q1","type":"boolean","level":"recall","prompt":"Q?","correct":true}]}`))
		case "flashcards":
			_, _ = w.Write([]byte(`{"kind":"flashcards","cards":[{"front":"a","back":"b"}]}`))
		case "mindmap", "diagram":
			_, _ = fmt.Fprintf(w, `{"kind":%q,"title":"t","content":"# t"}`, in.Kind)
		default:
			http.Error(w, "unsupported", http.StatusBadRequest)
		}
	}))
	t.Cleanup(srv.Close)
	return pipeline.New(srv.URL, "")
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

func doCollaborationReq(
	t *testing.T,
	h http.Handler,
	path, secret string,
	body any,
) *httptest.ResponseRecorder {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Collaboration-Secret", secret)
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

func TestCloudImportAuthorization(t *testing.T) {
	h := openShareHTTP(t)

	cases := []struct {
		name   string
		user   string
		body   map[string]any
		status int
	}{
		{"owner reaches request validation", "u_owner", map[string]any{}, http.StatusUnprocessableEntity},
		{"editor reaches request validation", "u_editor", map[string]any{}, http.StatusUnprocessableEntity},
		{"commenter is rejected", "u_commenter", map[string]any{"provider": "google", "fileIds": []string{"drive-file"}}, http.StatusNotFound},
		{"viewer is rejected", "u_viewer", map[string]any{"provider": "google", "fileIds": []string{"drive-file"}}, http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doReq(
				t,
				h,
				http.MethodPost,
				"/api/workspaces/ws_e2e_private/sources/import",
				tc.user,
				tc.body,
			)
			if rec.Code != tc.status {
				t.Fatalf("cloud import by %s = %d body=%s", tc.user, rec.Code, rec.Body.String())
			}
		})
	}

	for _, endpoint := range []string{
		"/api/workspaces/ws_e2e_private/sources/import-inspect",
	} {
		for _, user := range []string{"u_commenter", "u_viewer"} {
			rec := doReq(t, h, http.MethodPost, endpoint, user, map[string]any{
				"provider": "google",
				"fileIds":  []string{"drive-file"},
			})
			if rec.Code != http.StatusNotFound {
				t.Fatalf("cloud inspect by %s = %d body=%s", user, rec.Code, rec.Body.String())
			}
		}
	}
	for _, user := range []string{"u_commenter", "u_viewer"} {
		rec := doReq(
			t,
			h,
			http.MethodGet,
			"/api/workspaces/ws_e2e_private/sources/import-content?provider=google&fileId=drive-file",
			user,
			nil,
		)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("cloud content by %s = %d body=%s", user, rec.Code, rec.Body.String())
		}
	}
}

func TestFileReplacementAuthorizationAndRevisionGate(t *testing.T) {
	h := openShareHTTP(t)
	body := map[string]any{
		"contentType":      "application/octet-stream",
		"expectedRevision": 1,
		"sizeBytes":        1024,
	}

	for _, tc := range []struct {
		name   string
		user   string
		status int
	}{
		{name: "owner", user: "u_owner", status: http.StatusCreated},
		{name: "editor", user: "u_editor", status: http.StatusCreated},
		{name: "commenter", user: "u_commenter", status: http.StatusNotFound},
		{name: "viewer", user: "u_viewer", status: http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := doReq(t, h, http.MethodPost,
				"/api/files/f_e2e_private/replacement-uploads", tc.user, body)
			if rec.Code != tc.status {
				t.Fatalf("replacement reserve by %s = %d body=%s", tc.user, rec.Code, rec.Body.String())
			}
		})
	}

	stale := doReq(t, h, http.MethodPost,
		"/api/files/f_e2e_private/replacement-uploads", "u_editor", map[string]any{
			"contentType":      "application/octet-stream",
			"expectedRevision": 2,
			"sizeBytes":        1024,
		})
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale replacement reserve = %d body=%s", stale.Code, stale.Body.String())
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

func TestMaterialRevisionHTTPCapsFreeOwnerAtSevenDailyVersions(t *testing.T) {
	dsn := testdb.URL(t)
	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	userID := fmt.Sprintf("u_revision_http_%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx, `INSERT INTO users (id,name,email,plan_tier)
		VALUES ($1,'Revision HTTP Test',$2,'free')`,
		userID,
		fmt.Sprintf("%s@example.test", userID),
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})
	handler := httpapi.New(
		st,
		blob.NewMemory(),
		nil,
		nil,
		"docling",
		"evo",
		httpapi.Config{
			AuthDisabled:        true,
			DevUserID:           userID,
			CollaborationSecret: "revision-test-secret",
		},
	)

	rec := doReq(t, handler, http.MethodPost, "/api/workspaces", "", map[string]any{
		"name": "Revision HTTP Workspace",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workspace = %d %s", rec.Code, rec.Body.String())
	}
	var workspace map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &workspace); err != nil {
		t.Fatal(err)
	}
	workspaceID := workspace["id"].(string)
	content := func(text string) map[string]any {
		return map[string]any{
			"schemaVersion": 1,
			"value": []any{map[string]any{
				"type": "p", "id": "revision-http-block",
				"children": []any{map[string]any{"text": text}},
			}},
		}
	}
	rec = doReq(
		t,
		handler,
		http.MethodPost,
		"/api/workspaces/"+workspaceID+"/materials",
		"",
		map[string]any{"kind": "note", "title": "Revision cap", "content": content("revision-1")},
	)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create material = %d %s", rec.Code, rec.Body.String())
	}
	var material map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &material); err != nil {
		t.Fatal(err)
	}
	materialID := material["id"].(string)
	if _, err := pool.Exec(ctx, `INSERT INTO material_yjs_documents
		(material_id, state, stored_version)
		VALUES ($1, '\x00'::bytea, 10)`, materialID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE material_revisions
		SET version_date=CURRENT_DATE-9
		WHERE material_id=$1 AND version_date=CURRENT_DATE`, materialID); err != nil {
		t.Fatal(err)
	}

	for revision := 2; revision <= 10; revision++ {
		rec = doCollaborationReq(
			t,
			handler,
			"/internal/collaboration/materials/"+materialID+"/projection",
			"revision-test-secret",
			map[string]any{
				"content":    content(fmt.Sprintf("revision-%d", revision)),
				"yjsVersion": revision - 1,
			},
		)
		if rec.Code != http.StatusOK {
			t.Fatalf("save revision %d = %d %s", revision, rec.Code, rec.Body.String())
		}
		if revision < 10 {
			if _, err := pool.Exec(ctx, `UPDATE material_revisions
				SET version_date=CURRENT_DATE-$2::integer
				WHERE material_id=$1 AND version_date=CURRENT_DATE`,
				materialID,
				10-revision,
			); err != nil {
				t.Fatal(err)
			}
		}
	}

	rec = doReq(
		t,
		handler,
		http.MethodGet,
		"/api/materials/"+materialID+"/revisions",
		"",
		nil,
	)
	if rec.Code != http.StatusOK {
		t.Fatalf("list revisions = %d %s", rec.Code, rec.Body.String())
	}
	var revisions []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &revisions); err != nil {
		t.Fatal(err)
	}
	if len(revisions) != 7 ||
		revisions[0]["revision"] != float64(10) ||
		revisions[6]["revision"] != float64(4) {
		t.Fatalf("free revision response = %#v", revisions)
	}
}
