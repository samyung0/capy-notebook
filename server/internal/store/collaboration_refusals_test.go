package store

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/obs"
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
		{http.StatusUnprocessableEntity, `{"code":"quota_rejected","message":"update_size_exceeded"}`, agenttools.ErrQuotaRejected, limitMessages["update_size_exceeded"]},
		{http.StatusConflict, `{"code":"quota_rejected","message":"update_size_exceeded"}`, agenttools.ErrQuotaRejected, limitMessages["update_size_exceeded"]},
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

type sentryCount struct{ events atomic.Int32 }

func (t *sentryCount) Configure(sentry.ClientOptions)        {}
func (t *sentryCount) SendEvent(*sentry.Event)               { t.events.Add(1) }
func (t *sentryCount) Flush(time.Duration) bool              { return true }
func (t *sentryCount) FlushWithContext(context.Context) bool { return true }
func (t *sentryCount) Close()                                {}

// A content command whose update is over the collaboration server's 8 MiB
// cap (413) is a document limit refusal, not an unavailable authority.
func TestOversizedContentCommandIsALimitRefusal(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	current, err := materialdoc.QuizDocument(json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"Before"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`), nil)
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{CreatedBy: "u_owner", Kind: "quiz", Title: "Quiz", Content: current})
	if err != nil {
		t.Fatal(err)
	}
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		_, _ = w.Write([]byte(`{"code":"update_too_large","message":"update_size_exceeded"}`))
	}))
	t.Cleanup(sidecar.Close)
	s.ConfigureCollaboration(sidecar.URL, "command-secret")
	desired := strings.Replace(current, "Before", "After", 1)
	handled, err := s.applyAuthoritativeContentCommand(ctx, material.ID, "u_owner", current, desired, nil)
	if !handled || !errors.Is(err, materialdoc.ErrLimitExceeded) || errors.Is(err, ErrAuthorityUnavailable) {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}

// A replace-block command refused because its room is being reset (the
// authority's 503 unavailable_target) applied nothing: an
// expected outcome, so its error is not reported, while any other authority
// 503 still is. The caller's answer is the unavailable authority's either way.
func TestRoomUnavailableContentCommandIsNotReported(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	current, err := materialdoc.QuizDocument(json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"Before"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`), nil)
	if err != nil {
		t.Fatal(err)
	}
	desired := strings.Replace(current, "Before", "After", 1)
	material, err := s.CreateMaterial(ctx, Material{CreatedBy: "u_owner", Kind: "quiz", Title: "Quiz", Content: current})
	if err != nil {
		t.Fatal(err)
	}
	var answer atomic.Value
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(answer.Load().(string)))
	}))
	t.Cleanup(sidecar.Close)
	s.ConfigureCollaboration(sidecar.URL, "command-secret")
	events := &sentryCount{}
	client, err := sentry.NewClient(sentry.ClientOptions{Dsn: "https://test@example.invalid/1", Transport: events})
	if err != nil {
		t.Fatal(err)
	}
	reporting := sentry.SetHubOnContext(ctx, sentry.NewHub(client, sentry.NewScope()))

	for _, tc := range []struct {
		answer string
		events int32
	}{
		{`{"code":"unavailable_target","message":"collaboration room is being reset"}`, 0},
		{`{"message":"collaboration room unavailable"}`, 1},
	} {
		answer.Store(tc.answer)
		events.events.Store(0)
		handled, err := s.applyAuthoritativeContentCommand(ctx, material.ID, "u_owner", current, desired, nil)
		if !handled || !errors.Is(err, ErrAuthorityUnavailable) {
			t.Fatalf("%s: handled=%v err=%v", tc.answer, handled, err)
		}
		obs.CaptureErr(reporting, err, nil)
		if got := events.events.Load(); got != tc.events {
			t.Fatalf("%s: %d Sentry events, want %d", tc.answer, got, tc.events)
		}
	}
}
