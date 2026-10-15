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

// An Office edit's note on the characters the agent's text lost (Epo
// 2026-10-15) is read with the receipt and written back beside it, so the
// gateway's answer carries it to the tool result.
func TestAuthorityEditNoticeTravelsWithTheReceipt(t *testing.T) {
	const notice = "Removed 1 character Office files cannot store (U+0001)."
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"operationId":"op_1","kind":"edit_document","outcome":"succeeded","effect":{"operation":"edited","resource":{"kind":"source_file","id":"f1","title":"a.docx"}},"notice":"` + notice + `"}`))
	}))
	defer srv.Close()
	s := &Store{collaborationHTTP: srv.Client()}
	var out DocumentEdit
	if err := s.postCollaboration(t.Context(), srv.URL, "secret", "/internal/documents/edit", map[string]any{}, &out); err != nil {
		t.Fatal(err)
	}
	if out.Notice != notice || out.ID != "op_1" || out.Effect == nil || out.Effect.Resource.ID != "f1" {
		t.Fatalf("read %+v", out)
	}
	written, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	var answer struct {
		OperationID string `json:"operationId"`
		Notice      string `json:"notice"`
	}
	if err := json.Unmarshal(written, &answer); err != nil || answer.OperationID != "op_1" || answer.Notice != notice {
		t.Fatalf("wrote %s", written)
	}
}
