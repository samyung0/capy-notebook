package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
)

// Security regression (human/deployment-runbook.md, 2026-10-19): deployed
// environments serve no API docs, spec or schemas, and their bodies carry no
// `$schema` link; only local development (APIDocs) serves them.
func TestAPIDocsAndSchemaLinksOnlyInLocalDevelopment(t *testing.T) {
	for _, local := range []bool{false, true} {
		h := New(nil, blob.NewMemory(), nil, nil, "docling", Config{
			APIDocs:             local,
			CollaborationSecret: testCollaborationSecret,
		})
		want := http.StatusNotFound
		if local {
			want = http.StatusOK
		}
		for _, path := range []string{"/docs", "/openapi.json", "/openapi.yaml", "/openapi-3.0.json", "/schemas/ErrorModel.json"} {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
			if rec.Code != want {
				t.Errorf("APIDocs=%v GET %s: %d, want %d", local, path, rec.Code, want)
			}
		}

		// A body Huma refuses: the error it builds itself.
		req := httptest.NewRequest(http.MethodPost, "/internal/collaboration/files/f_1/checkpoint", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Collaboration-Secret", testCollaborationSecret)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("APIDocs=%v error: %d %s", local, rec.Code, rec.Body.String())
		}
		if _, linked := body["$schema"]; linked != local {
			t.Errorf("APIDocs=%v error body $schema present = %v", local, linked)
		}
		if linked := rec.Header().Get("Link") != ""; linked != local {
			t.Errorf("APIDocs=%v error Link header present = %v", local, linked)
		}
	}
}
