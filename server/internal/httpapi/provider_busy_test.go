package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/pipeline"
)

func TestFailMapsProviderBusyWithRetryAfter(t *testing.T) {
	a := &api{}
	rec := httptest.NewRecorder()
	a.fail(rec, &providerBusyError{RetryAfterSeconds: 7})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Retry-After"); got != "7" {
		t.Fatalf("Retry-After = %q", got)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != "provider_busy" || body["retryAfterSeconds"] != float64(7) {
		t.Fatalf("body = %#v", body)
	}
}

func TestPipelineProviderBusyDecodesRetryAfter(t *testing.T) {
	// FastAPI wraps HTTPException detail; the exception handler answers flat.
	for _, raw := range []string{
		`{"detail":{"code":"provider_busy","message":"busy","retryAfterSeconds":3}}`,
		`{"code":"provider_busy","message":"busy","retryAfterSeconds":3}`,
	} {
		err := &pipeline.Error{Path: "/generate", Status: http.StatusServiceUnavailable, Body: []byte(raw)}
		var busy *providerBusyError
		if !errors.As(pipelineLLMError(err), &busy) || busy.RetryAfterSeconds != 3 {
			t.Fatalf("%s: mapped = %#v", raw, pipelineLLMError(err))
		}
	}
	if (&providerBusyError{}).retryAfter() != 5 {
		t.Fatal("a missing wait must not read as retry now")
	}
	if pipelineLLMError(&pipeline.Error{Body: []byte(`{"code":"other"}`)}) != nil {
		t.Fatal("unrelated pipeline errors must stay unmapped")
	}
}
