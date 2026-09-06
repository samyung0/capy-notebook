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
	"github.com/samyung0/capy-notebook/server/internal/store"
)

func TestSourceContextErrorsRelay(t *testing.T) {
	for _, tc := range []struct {
		code   string
		status int
	}{
		{"context_too_large", http.StatusBadRequest},
		{"source_changed", http.StatusConflict},
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
				if !errors.As(keyErrorFromEvent(tc.code, "source request failed"), &event) || event.Code != tc.code {
					t.Fatalf("chat lost source error: %#v", event)
				}
			}
		})
	}
}

func TestPipelineLLMError(t *testing.T) {
	invalid := &pipeline.Error{
		Status: 400,
		Body:   []byte(`{"code":"invalid_key","message":"The provider rejected this key."}`),
	}
	if !errors.Is(pipelineLLMError(invalid), store.ErrInvalidLLMKey) {
		t.Fatalf("invalid_key: %v", pipelineLLMError(invalid))
	}
	failed := &pipeline.Error{
		Status: 400,
		Body:   []byte(`{"detail":{"code":"key_failed","message":"check the key"}}`),
	}
	if !errors.Is(pipelineLLMError(failed), store.ErrLLMKeyFailed) {
		t.Fatalf("key_failed: %v", pipelineLLMError(failed))
	}
	if pipelineLLMError(&pipeline.Error{Status: 503, Body: []byte(`{"message":"down"}`)}) != nil {
		t.Fatal("unrelated pipeline error must not map to a key error")
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

func TestKeyErrorFromEvent(t *testing.T) {
	if !errors.Is(keyErrorFromEvent("invalid_key", "x"), store.ErrInvalidLLMKey) {
		t.Fatal("invalid_key")
	}
	if !errors.Is(keyErrorFromEvent("key_failed", "x"), store.ErrLLMKeyFailed) {
		t.Fatal("key_failed")
	}
	if keyErrorFromEvent("", "") != nil {
		t.Fatal("empty")
	}
	var eventErr *chatEventError
	if !errors.As(
		keyErrorFromEvent("context_too_large", "too large"),
		&eventErr,
	) || eventErr.Code != "context_too_large" {
		t.Fatalf("context event did not retain its code: %#v", eventErr)
	}
	if !errors.As(
		keyErrorFromEvent("invalid_scope", "invalid"),
		&eventErr,
	) || eventErr.Code != "invalid_scope" {
		t.Fatalf("scope event did not retain its code: %#v", eventErr)
	}
}
