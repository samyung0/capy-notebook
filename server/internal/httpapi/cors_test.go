package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
)

// Security regression (human deployment-runbook, 2026-10-21): CORS never
// falls back to "*". Without an allowlist no origin gets CORS headers; with
// one, only its origins do.
func TestCORSNeverFallsBackToAnyOrigin(t *testing.T) {
	for _, test := range []struct {
		name    string
		allowed []string
		origin  string
		want    string
	}{
		{name: "no allowlist", origin: "https://evil.test", want: ""},
		{name: "listed origin", allowed: []string{"https://app.test"}, origin: "https://app.test", want: "https://app.test"},
		{name: "other origin", allowed: []string{"https://app.test"}, origin: "https://evil.test", want: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			h := New(nil, blob.NewMemory(), nil, nil, "docling", Config{
				AllowedOrigins:      test.allowed,
				CollaborationSecret: testCollaborationSecret,
			})
			for _, method := range []string{http.MethodOptions, http.MethodGet} {
				req := httptest.NewRequest(method, "/docs", nil)
				req.Header.Set("Origin", test.origin)
				req.Header.Set("Access-Control-Request-Method", http.MethodGet)
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, req)
				if got := rec.Header().Get("Access-Control-Allow-Origin"); got != test.want {
					t.Errorf("%s from %s: Access-Control-Allow-Origin=%q, want %q", method, test.origin, got, test.want)
				}
			}
		})
	}
}
