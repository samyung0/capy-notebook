package httpapi

import (
	"bytes"
	"cmp"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// The projection route skips Huma's body validation and decodes the body
// itself (human/frontend/plate-editor.md, 2026-10-08): it must refuse what the
// schema refused, with the same codes. Each body is also sent to a twin route
// that keeps Huma's validation and stops where the real one reaches the store.
func TestProjectionBodyRefusalsMatchHumaValidation(t *testing.T) {
	router := chi.NewRouter()
	api := humachi.New(router, humaConfig())
	(&api2{cfg: Config{CollaborationSecret: "secret"}}).registerCollaboration(api)
	type validatedInput struct {
		ID   string `path:"id"`
		Body projectMaterialReq
	}
	regWithMaxBody(api, http.MethodPost, "/validated/{id}", "validatedProjection", "Test", "Test", http.StatusOK, materialRequestMaxBytes,
		func(_ context.Context, in *validatedInput) (*struct{}, error) {
			if _, err := materialdoc.NewProjection(in.Body.Content); err != nil {
				return nil, collaborationError(err)
			}
			return nil, huma.Error500InternalServerError("reached the store")
		})
	send := func(path, body, contentType string) int {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader([]byte(body)))
		if contentType != "-" {
			req.Header.Set("Content-Type", cmp.Or(contentType, "application/json"))
		}
		req.Header.Set("X-Collaboration-Secret", "secret")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec.Code
	}
	// An element without children: the document check refuses it (400), so a
	// body that gets that far passed every envelope check.
	const node = `{"type":"p","id":"x","children":[]}`
	valid := func(yjsVersion string) string {
		return `{"content":{"schemaVersion":1,"value":[` + node + `]},"yjsVersion":` + yjsVersion + `}`
	}
	for _, tc := range []struct {
		name, body string
		status     int
		// "" sends application/json and "-" no Content-Type.
		contentType string
	}{
		{"malformed JSON", `{`, 400, ""},
		{"malformed after a mistyped field", `{"yjsVersion":"1","content":`, 400, ""},
		{"data after the object", `{"content":{"schemaVersion":1,"value":[` + node + `]},"yjsVersion":1} {}`, 400, ""},
		{"empty body", ``, 400, ""},
		{"body not an object", `[]`, 422, ""},
		{"content missing", `{"yjsVersion":1}`, 422, ""},
		{"content null", `{"content":null,"yjsVersion":1}`, 422, ""},
		{"schemaVersion missing", `{"content":{"value":[` + node + `]},"yjsVersion":1}`, 422, ""},
		{"schemaVersion null", `{"content":{"schemaVersion":null,"value":[` + node + `]},"yjsVersion":1}`, 422, ""},
		{"schemaVersion 2", `{"content":{"schemaVersion":2,"value":[` + node + `]},"yjsVersion":1}`, 400, ""},
		{"value missing", `{"content":{"schemaVersion":1},"yjsVersion":1}`, 422, ""},
		{"value null", `{"content":{"schemaVersion":1,"value":null},"yjsVersion":1}`, 400, ""},
		{"value not an array", `{"content":{"schemaVersion":1,"value":{}},"yjsVersion":1}`, 422, ""},
		{"value empty", `{"content":{"schemaVersion":1,"value":[]},"yjsVersion":1}`, 400, ""},
		{"node not an object", `{"content":{"schemaVersion":1,"value":[1]},"yjsVersion":1}`, 422, ""},
		{"node null", `{"content":{"schemaVersion":1,"value":[null]},"yjsVersion":1}`, 422, ""},
		{"invalid node", `{"content":{"schemaVersion":1,"value":[` + node + `]},"yjsVersion":1}`, 400, ""},
		{"unknown top-level field", `{"content":{"schemaVersion":1,"value":[` + node + `]},"yjsVersion":1,"extra":1}`, 422, ""},
		{"unknown content field", `{"content":{"schemaVersion":1,"value":[` + node + `],"extra":1},"yjsVersion":1}`, 422, ""},
		{"names in another case", `{"Content":{"SchemaVersion":1,"VALUE":[` + node + `]},"YjsVersion":1}`, 400, ""},
		{"$schema link", `{"$schema":"https://example.com/s.json","content":{"schemaVersion":1,"value":[` + node + `]},"yjsVersion":1}`, 400, ""},
		{"$schema not a string", `{"$schema":1,"content":{"schemaVersion":1,"value":[` + node + `]},"yjsVersion":1}`, 400, ""},
		{"yjsVersion missing", `{"content":{"schemaVersion":1,"value":[` + node + `]}}`, 422, ""},
		{"yjsVersion null", `{"content":{"schemaVersion":1,"value":[` + node + `]},"yjsVersion":null}`, 422, ""},
		{"yjsVersion 0", `{"content":{"schemaVersion":1,"value":[` + node + `]},"yjsVersion":0}`, 422, ""},
		{"yjsVersion a string", `{"content":{"schemaVersion":1,"value":[` + node + `]},"yjsVersion":"1"}`, 422, ""},
		{"yjsVersion a fraction", `{"content":{"schemaVersion":1,"value":[` + node + `]},"yjsVersion":1.5}`, 422, ""},
		{"whitespace only", `   `, 400, ""},
		{"number out of float64 range", valid(`1e400`), 400, ""},
		{"number out of int64 range", valid(`1e20`), 422, ""},
		{"out-of-range number in a node", `{"content":{"schemaVersion":1,"value":[{"type":"p","id":"x","n":1e400,"children":[]}]},"yjsVersion":1}`, 400, ""},
		{"out-of-range number after a mistyped field", `{"content":{"schemaVersion":1,"value":[{"type":"p","id":"x","n":1e400,"children":[]}]},"yjsVersion":"1"}`, 400, ""},
		{"out-of-range $schema with a field error", `{"$schema":1e400,"content":{"schemaVersion":1,"value":[` + node + `]},"yjsVersion":0}`, 400, ""},
		{"text/plain", valid(`1`), 415, "text/plain"},
		{"application/cbor", valid(`1`), 415, "application/cbor"},
		{"JSON with a charset", valid(`1`), 400, "application/json; charset=utf-8"},
		{"a +json type", valid(`1`), 400, "application/merge-patch+json"},
		{"no Content-Type", valid(`1`), 400, "-"},
		{"over the size limit", `{"content":{"schemaVersion":1,"value":[{"type":"p","id":"x","children":[{"text":"` + strings.Repeat("x", materialRequestMaxBytes) + `"}]}]},"yjsVersion":1}`, 413, ""},
	} {
		got, huma := send("/internal/collaboration/materials/m/projection", tc.body, tc.contentType), send("/validated/m", tc.body, tc.contentType)
		if got != tc.status || huma != tc.status {
			t.Errorf("%s: route %d, Huma validation %d, want %d", tc.name, got, huma, tc.status)
		}
	}
}

// Security regression (plate REVIEW3 S2, the projection route's own body
// decoding): the route checks the collaboration service secret before it
// reads the body, so a caller without it gets 401 whatever it sends, and a
// server without a configured secret refuses every call.
func TestProjectionRouteChecksTheSecretBeforeTheBody(t *testing.T) {
	const invalid = `{"content":{"schemaVersion":1,"value":[{"type":"p","id":"x","children":[]}]},"yjsVersion":1}`
	for _, tc := range []struct {
		name, configured, sent, body string
	}{
		{"wrong secret", "secret", "guess", invalid},
		{"wrong secret, malformed body", "secret", "guess", `{`},
		{"no secret", "secret", "", invalid},
		{"no secret configured", "", "", invalid},
	} {
		router := chi.NewRouter()
		api := humachi.New(router, humaConfig())
		(&api2{cfg: Config{CollaborationSecret: tc.configured}}).registerCollaboration(api)
		req := httptest.NewRequest(http.MethodPost, "/internal/collaboration/materials/m/projection", strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		if tc.sent != "" {
			req.Header.Set("X-Collaboration-Secret", tc.sent)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: %d, want 401", tc.name, rec.Code)
		}
	}
}
