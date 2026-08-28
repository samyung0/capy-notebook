package httpapi

import (
	"errors"
	"testing"

	"github.com/evonotes/server/internal/pipeline"
	"github.com/evonotes/server/internal/store"
)

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
