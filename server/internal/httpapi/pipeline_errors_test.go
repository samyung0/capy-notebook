package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
)

func TestSourceContextErrorsRelay(t *testing.T) {
	for _, tc := range []struct {
		code   string
		status int
	}{
		{"context_too_large", http.StatusBadRequest},
	} {
		t.Run(tc.code, func(t *testing.T) {
			for _, raw := range []string{
				fmt.Sprintf(`{"code":%q}`, tc.code),
				fmt.Sprintf(`{"detail":{"code":%q}}`, tc.code),
			} {
				mapped := pipelineGenerateError(&pipeline.Error{Path: "/generate", Status: tc.status, Body: []byte(raw)})
				var model *huma.ErrorModel
				if !errors.As(hErr(mapped), &model) || model.Status != tc.status || len(model.Errors) != 1 || model.Errors[0].Message != tc.code {
					t.Fatalf("generation lost source error: %s, %#v", raw, model)
				}
				rec := httptest.NewRecorder()
				(&api{}).fail(rec, mapped)
				var body map[string]string
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || rec.Code != tc.status || body["code"] != tc.code {
					t.Fatalf("raw error lost code: %d %s", rec.Code, rec.Body.String())
				}
				var event *chatEventError
				if !errors.As(errorFromEvent(tc.code, "source request failed"), &event) || event.Code != tc.code {
					t.Fatalf("chat lost source error: %#v", event)
				}
			}
		})
	}
}

func TestChatRelaysSourceChanged(t *testing.T) {
	var event *chatEventError
	if !errors.As(errorFromEvent("source_changed", "source request failed"), &event) || event.Code != "source_changed" {
		t.Fatalf("chat lost source error: %#v", event)
	}
}

func TestPipelineLLMError(t *testing.T) {
	busy := &pipeline.Error{
		Status: 503,
		Body:   []byte(`{"code":"provider_busy","message":"busy","retryAfterSeconds":7}`),
	}
	var mapped *providerBusyError
	if !errors.As(pipelineLLMError(busy), &mapped) || mapped.retryAfter() != 7 {
		t.Fatalf("provider_busy: %v", pipelineLLMError(busy))
	}
	if pipelineLLMError(&pipeline.Error{Status: 503, Body: []byte(`{"message":"down"}`)}) != nil {
		t.Fatal("unrelated pipeline error must not map")
	}
}

func TestPipelineGenerateError(t *testing.T) {
	empty := &pipeline.Error{
		Status: 502,
		Body:   []byte(`{"code":"generate_empty","message":"The model returned no usable mindmap."}`),
	}
	if !errors.Is(pipelineGenerateError(empty), errGenerateEmpty) {
		t.Fatalf("generate_empty: %v", pipelineGenerateError(empty))
	}
	wrapped := &pipeline.Error{
		Status: 502,
		Body:   []byte(`{"detail":{"code":"generate_empty","message":"no quiz"}}`),
	}
	if !errors.Is(pipelineGenerateError(wrapped), errGenerateEmpty) {
		t.Fatalf("detail wrapper: %v", pipelineGenerateError(wrapped))
	}
	if pipelineGenerateError(&pipeline.Error{Status: 503, Body: []byte(`{"message":"down"}`)}) != nil {
		t.Fatal("unrelated pipeline error must not map to generate_empty")
	}
}

func TestErrorFromEvent(t *testing.T) {
	if errorFromEvent("", "") != nil {
		t.Fatal("empty")
	}
	var eventErr *chatEventError
	if !errors.As(
		errorFromEvent("context_too_large", "too large"),
		&eventErr,
	) || eventErr.Code != "context_too_large" {
		t.Fatalf("context event did not retain its code: %#v", eventErr)
	}
	if !errors.As(
		errorFromEvent("invalid_scope", "invalid"),
		&eventErr,
	) || eventErr.Code != "invalid_scope" {
		t.Fatalf("scope event did not retain its code: %#v", eventErr)
	}
}
