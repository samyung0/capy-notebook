package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSourceAnalysisContentCannotExecuteOnTheAppOrigin(t *testing.T) {
	recorder := httptest.NewRecorder()
	payload := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)

	writeSourceAnalysisContent(recorder, payload)

	response := recorder.Result()
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if got := response.Header.Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("content type = %q", got)
	}
	if got := response.Header.Get("Content-Disposition"); got != `attachment; filename="source-analysis.bin"` {
		t.Fatalf("content disposition = %q", got)
	}
	if got := response.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("nosniff = %q", got)
	}
	if got := response.Header.Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("cache control = %q", got)
	}
}
