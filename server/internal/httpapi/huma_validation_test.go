package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
)

func validationRouter() http.Handler {
	router := chi.NewRouter()
	api := humachi.New(router, humaConfig())
	registerRoutes(api, &api2{})
	return router
}

func jsonRequest(router http.Handler, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestSourceCheckpointAcceptsOrdinarySavePayload(t *testing.T) {
	// Match SourceDocuments.store: seed-only fields are absent on an edit.
	body := `{"actorIds":["user_1"],"epoch":1,"expectedCheckpoint":0,"state":"AQ==","pendingEffects":[],"netTokens":0}`
	rec := jsonRequest(validationRouter(), http.MethodPost,
		"/internal/collaboration/files/file_1/checkpoint", body)
	// Reaching the handler's secret check proves request validation passed.
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d body=%s", rec.Code, http.StatusUnauthorized, rec.Body.String())
	}
}

func TestSourcePublishAcceptsOfficeAndReceiptPayload(t *testing.T) {
	// Office uses the durable candidate baseline; receipt replay needs no baseline.
	body := `{"jobId":"job_1","epoch":1,"checkpoint":1,"leaseToken":"lease_1","sourceETag":"etag","contentId":"content_1","contentHash":"hash","attemptId":1,"expectedLatestCheckpoint":1,"netTokens":0,"pendingEffects":[]}`
	rec := jsonRequest(validationRouter(), http.MethodPost, "/internal/collaboration/files/file_1/publish", body)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want handler authentication, body=%s", rec.Code, rec.Body.String())
	}
}

func TestRequestBodyValidation(t *testing.T) {
	router := validationRouter()

	cases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{
			name:   "create workspace empty name",
			method: http.MethodPost,
			path:   "/api/workspaces",
			body:   `{"name":""}`,
		},
		{
			name:   "create workspace name too long",
			method: http.MethodPost,
			path:   "/api/workspaces",
			body:   `{"name":"` + strings.Repeat("a", fieldlimits.WorkspaceName+1) + `"}`,
		},
		{
			name:   "update workspace empty name",
			method: http.MethodPatch,
			path:   "/api/workspaces/ws_1",
			body:   `{"name":""}`,
		},
		{
			name: "create workspace description too long", method: http.MethodPost, path: "/api/workspaces",
			body: `{"name":"ok","description":"` + strings.Repeat("a", fieldlimits.WorkspaceDescription+1) + `"}`,
		},
		{
			name: "create workspace invalid icon", method: http.MethodPost, path: "/api/workspaces",
			body: `{"name":"ok","iconId":"missing-icon"}`,
		},
		{
			name: "create workspace empty icon", method: http.MethodPost, path: "/api/workspaces",
			body: `{"name":"ok","iconId":""}`,
		},
		{
			name:   "create workspace too many tags",
			method: http.MethodPost,
			path:   "/api/workspaces",
			body:   `{"name":"ok","tags":[{"value":"a"},{"value":"b"},{"value":"c"},{"value":"d"},{"value":"e"},{"value":"f"}]}`,
		},
		{
			name:   "update workspace too many tags",
			method: http.MethodPatch,
			path:   "/api/workspaces/ws_1",
			body:   `{"tags":[{"value":"a"},{"value":"b"},{"value":"c"},{"value":"d"},{"value":"e"},{"value":"f"}]}`,
		},
		{
			name:   "add chapter empty name",
			method: http.MethodPost,
			path:   "/api/workspaces/ws_1/chapters",
			body:   `{"name":""}`,
		},
		{
			name:   "invite owner role",
			method: http.MethodPost,
			path:   "/api/workspaces/ws_1/invites",
			body:   `{"identifier":"user@example.com","role":"owner"}`,
		},
		{
			name:   "create card empty front",
			method: http.MethodPost,
			path:   "/api/flashcards/dk_1/cards",
			body:   `{"front":"","back":"answer"}`,
		},
		{
			name:   "create event missing title",
			method: http.MethodPost,
			path:   "/api/events",
			body:   `{"start":"2026-08-13T09:00:00Z","end":"2026-08-13T10:00:00Z"}`,
		},
		{
			name:   "create attempt total zero",
			method: http.MethodPost,
			path:   "/api/quizzes/qz_1/attempts",
			body:   `{"correct":0,"total":0}`,
		},
		{
			name:   "update label name too long",
			method: http.MethodPatch,
			path:   "/api/labels/lb_1",
			body:   `{"name":"` + strings.Repeat("a", fieldlimits.LabelName+1) + `"}`,
		},
		{
			name:   "account deletion empty email",
			method: http.MethodPost,
			path:   "/api/account/deletion",
			body:   `{"confirmEmail":""}`,
		},
		{
			name:   "generate missing kind",
			method: http.MethodPost,
			path:   "/api/workspaces/ws_1/generate",
			body:   `{"count":1,"levels":["recall"],"title":"t"}`,
		},
		{
			name:   "generate missing count",
			method: http.MethodPost,
			path:   "/api/workspaces/ws_1/generate",
			body:   `{"kind":"quiz","levels":["recall"],"title":"t"}`,
		},
		{
			name:   "generate missing levels",
			method: http.MethodPost,
			path:   "/api/workspaces/ws_1/generate",
			body:   `{"kind":"quiz","count":1,"title":"t"}`,
		},
		{
			name:   "generate count zero",
			method: http.MethodPost,
			path:   "/api/workspaces/ws_1/generate",
			body:   `{"kind":"quiz","count":0,"levels":["recall"],"title":"t"}`,
		},
		{
			name:   "generate invalid level",
			method: http.MethodPost,
			path:   "/api/workspaces/ws_1/generate",
			body:   `{"kind":"quiz","count":1,"levels":["easy"],"title":"t"}`,
		},
		{
			name:   "create material missing kind",
			method: http.MethodPost,
			path:   "/api/workspaces/ws_1/materials",
			body:   `{"title":"n"}`,
		},
		{
			name:   "create discussion omit anchorVersion",
			method: http.MethodPost,
			path:   "/api/materials/mat_1/discussions",
			body:   `{"contentRich":[{"type":"p"}]}`,
		},
		{
			name:   "create discussion anchorVersion zero",
			method: http.MethodPost,
			path:   "/api/materials/mat_1/discussions",
			body:   `{"anchorVersion":0,"contentRich":[{"type":"p"}]}`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := jsonRequest(router, tc.method, tc.path, tc.body)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want %d body=%s", rec.Code, http.StatusUnprocessableEntity, rec.Body.String())
			}
		})
	}
}
