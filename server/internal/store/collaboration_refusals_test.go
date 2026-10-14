package store

import (
	"encoding/json"
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

// The authority's edit refusals reach the model as sent: the code, the
// message naming the rule, and the target as it reads now (a block, or the
// material's blocks), which the pipeline shows for the retry.
func TestAuthorityEditRefusalsKeepTheirDetails(t *testing.T) {
	for _, body := range []string{
		`{"code":"invalid_input","message":"invalid material document: 11 interactive blocks over 10"}`,
		`{"code":"invalid_input","message":"expected text occurs 2 times; include more context","details":{"block":{"id":"b1","text":"the cell and the cell wall","type":"p"}}}`,
		`{"code":"stale_target","message":"mermaid.source changed","details":{"block":{"id":"m1","text":"graph TD","type":"mermaid"}}}`,
		`{"code":"stale_target","message":"the material was rebuilt since it was inspected","details":{"blocks":[{"id":"b1","text":"hi","type":"p"}],"total":1}}`,
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(body))
		}))
		s := &Store{collaborationHTTP: srv.Client()}
		err := s.postCollaboration(t.Context(), srv.URL, "secret", "/edit", map[string]any{}, nil)
		srv.Close()
		var refusal *EditRefusal
		if !errors.As(err, &refusal) {
			t.Fatalf("%s: err = %v", body, err)
		}
		var sent struct {
			Code    agenttools.ErrorCode `json:"code"`
			Message string               `json:"message"`
			Details json.RawMessage      `json:"details"`
		}
		_ = json.Unmarshal([]byte(body), &sent)
		if refusal.Code != sent.Code || refusal.Message != sent.Message || string(refusal.Details) != string(sent.Details) {
			t.Fatalf("got %s %q %s, want %s", refusal.Code, refusal.Message, refusal.Details, body)
		}
	}
}
