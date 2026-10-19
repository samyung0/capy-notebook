package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
)

// countingBody is a request body of size bytes of malformed JSON carrying a
// marker; read counts what a handler consumed.
type countingBody struct {
	size, read int
}

const bodyMarker = "echo-marker-"

func (b *countingBody) Read(p []byte) (int, error) {
	if b.read >= b.size {
		return 0, io.EOF
	}
	n := min(len(p), b.size-b.read)
	for i := range n {
		p[i] = bodyMarker[(b.read+i)%len(bodyMarker)]
	}
	if b.read == 0 {
		p[0] = '{'
	}
	b.read += n
	return n, nil
}

// Security regression: /internal/collaboration/* and /api/internal/* refuse a
// caller without the prefix's service secret before anything reads the body,
// so a malformed or oversized anonymous body is neither decoded nor echoed.
func TestInternalRoutesRefuseWithoutTheSecretBeforeReadingTheBody(t *testing.T) {
	h := New(nil, blob.NewMemory(), nil, nil, "docling", Config{
		CollaborationSecret: "collab-test-secret",
		PipelineSecret:      "pipe-test-secret",
	})
	for _, path := range []string{
		"/internal/collaboration/files/f_1/checkpoint",
		"/internal/collaboration/materials/m_1/children",
		"/api/internal/trash",
		"/api/internal/documents/list",
	} {
		for _, header := range []string{"", "X-Collaboration-Secret", "X-Pipeline-Secret"} {
			body := &countingBody{size: 2 << 20}
			req := httptest.NewRequest(http.MethodPost, path, body)
			req.Header.Set("Content-Type", "application/json")
			if header != "" {
				req.Header.Set(header, "guess")
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized || body.read != 0 || strings.Contains(rec.Body.String(), bodyMarker) {
				t.Errorf("%s with %q: status %d, read %d bytes, body %.200s", path, header, rec.Code, body.read, rec.Body.String())
			}
		}
	}
}
