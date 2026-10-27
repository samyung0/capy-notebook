package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
)

// countingBody is a request body of size bytes opening a JSON object: the
// rest is a marker (malformed) or, with spaces, whitespace a JSON decoder
// keeps reading. read counts what a handler consumed.
type countingBody struct {
	size, read int
	spaces     bool
}

const bodyMarker = "echo-marker-"

func (b *countingBody) Read(p []byte) (int, error) {
	if b.read >= b.size {
		return 0, io.EOF
	}
	n := min(len(p), b.size-b.read)
	for i := range n {
		p[i] = ' '
		if !b.spaces {
			p[i] = bodyMarker[(b.read+i)%len(bodyMarker)]
		}
	}
	if b.read == 0 {
		p[0] = '{'
	}
	b.read += n
	return n, nil
}

const (
	testCollaborationSecret = "collab-test-secret"
	testPipelineSecret      = "pipe-test-secret"
)

func internalTestRouter() http.Handler {
	return New(nil, blob.NewMemory(), nil, nil, "docling", Config{
		CollaborationSecret: testCollaborationSecret,
		PipelineSecret:      testPipelineSecret,
	})
}

// Security regression: /internal/collaboration/* and /api/internal/* refuse a
// caller without the prefix's own service secret (none, a wrong one, or the
// other prefix's) before anything reads the body, so a malformed or oversized
// anonymous body is neither decoded nor echoed.
func TestInternalRoutesRefuseWithoutTheSecretBeforeReadingTheBody(t *testing.T) {
	h := internalTestRouter()
	collaboration := []string{"/internal/collaboration/files/f_1/checkpoint", "/internal/collaboration/materials/m_1/children"}
	pipeline := []string{"/api/internal/trash", "/api/internal/documents/list", "/api/internal/source-changes"}
	for _, tc := range []struct {
		paths         []string
		header, value string
	}{
		{collaboration, "", ""},
		{collaboration, "X-Collaboration-Secret", "guess"},
		{collaboration, "X-Pipeline-Secret", testPipelineSecret},
		{pipeline, "", ""},
		{pipeline, "X-Pipeline-Secret", "guess"},
		{pipeline, "X-Collaboration-Secret", testCollaborationSecret},
	} {
		for _, path := range tc.paths {
			body := &countingBody{size: 2 << 20}
			req := httptest.NewRequest(http.MethodPost, path, body)
			req.Header.Set("Content-Type", "application/json")
			if tc.header != "" {
				req.Header.Set(tc.header, tc.value)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized || body.read != 0 || strings.Contains(rec.Body.String(), bodyMarker) {
				t.Errorf("%s with %q: status %d, read %d bytes, body %.200s", path, tc.header, rec.Code, body.read, rec.Body.String())
			}
		}
	}
}

// Security regression: a caller holding the pipeline secret is read at most
// internalBodyMaxBytes on an internal route without a bound of its own.
func TestInternalRoutesCapTheBodyOfSecretHolders(t *testing.T) {
	body := &countingBody{size: internalBodyMaxBytes + 1<<20, spaces: true}
	req := httptest.NewRequest(http.MethodPost, "/api/internal/provider-calls", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Pipeline-Secret", testPipelineSecret)
	rec := httptest.NewRecorder()
	internalTestRouter().ServeHTTP(rec, req)
	if body.read > internalBodyMaxBytes+1 {
		t.Fatalf("read %d bytes past the %d byte cap (status %d)", body.read, internalBodyMaxBytes, rec.Code)
	}
}
