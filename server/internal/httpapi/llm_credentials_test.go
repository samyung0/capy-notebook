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
}
