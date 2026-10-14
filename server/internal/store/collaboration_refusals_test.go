package store

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// The authority's limit refusals reach the model with a reason it can act on:
// a bare limit code becomes a sentence, and a source checkpoint over its byte
// limit (413) is a refusal, not an unknown outcome.
func TestAuthorityLimitRefusalsNameTheirReason(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		code   agenttools.ErrorCode
		want   string
	}{
		{http.StatusConflict, `{"code":"quota_rejected","message":"document_size_exceeded"}`, agenttools.ErrQuotaRejected, limitMessages["document_size_exceeded"]},
		{http.StatusRequestEntityTooLarge, `{"code":"payload_too_large"}`, agenttools.ErrQuotaRejected, "the edited file would be over its size limit; make a smaller edit"},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		s := &Store{collaborationHTTP: srv.Client()}
		err := s.postCollaboration(t.Context(), srv.URL, "secret", "/edit", map[string]any{}, nil)
		srv.Close()
		var refusal *EditRefusal
		if !errors.As(err, &refusal) || refusal.Code != tc.code || refusal.Message != tc.want {
			t.Fatalf("status %d: err = %v, want %s %q", tc.status, err, tc.code, tc.want)
		}
	}
}
