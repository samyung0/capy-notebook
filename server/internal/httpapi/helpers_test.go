package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/evonotes/server/internal/pipeline"
	"github.com/evonotes/server/internal/store"
)

func TestResolveEmbeddingRequiresStore(t *testing.T) {
	a := &api{}
	_, err := a.resolveEmbedding(context.Background(), "ws_1")
	if !errors.Is(err, store.ErrModelUnavailable) {
		t.Fatalf("err = %v", err)
	}
}

func TestHealthReportsReleaseRevision(t *testing.T) {
	recorder := httptest.NewRecorder()
	healthHandler("0123456789abcdef0123456789abcdef01234567").ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, "/healthz", nil),
	)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if got := recorder.Header().Get("X-Evo-Release"); got != "0123456789abcdef0123456789abcdef01234567" {
		t.Fatalf("X-Evo-Release = %q", got)
	}
}

func TestFailMapsTooManyIngestLeases(t *testing.T) {
	a := &api{}
	rec := httptest.NewRecorder()
	a.fail(rec, store.ErrTooManyIngestLeases)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != "too_many_ingest_leases" {
		t.Fatalf("code = %#v", body["code"])
	}
}

func TestFailMapsCreditsExhaustedForbidden(t *testing.T) {
	a := &api{}
	rec := httptest.NewRecorder()
	a.fail(rec, &store.CreditsExhaustedError{
		UsedMicros: 1, LimitMicros: 1, PlanTier: store.PlanFree,
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != "llm_credits_exhausted" {
		t.Fatalf("code = %#v", body["code"])
	}
}

func TestWriteRelayCapacityRetryCredits(t *testing.T) {
	rec := httptest.NewRecorder()
	writeRelayCapacityRetry(rec, &store.CreditsExhaustedError{
		UsedMicros: 1, LimitMicros: 1, PlanTier: store.PlanFree,
	})
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Retry-After") != "300" {
		t.Fatalf("Retry-After = %q", rec.Header().Get("Retry-After"))
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != "llm_credits_exhausted" {
		t.Fatalf("code = %#v", body["code"])
	}
}

func TestKindFromName(t *testing.T) {
	cases := map[string]string{
		"notes.pdf":       "pdf",
		"paper.PDF":       "pdf",
		"report.docx":     "doc",
		"report.doc":      "doc",
		"readme.md":       "md",
		"readme.markdown": "md",
		"figure.png":      "image",
		"photo.JPEG":      "image",
		"data.csv":        "sheet",
		"deck.pptx":       "slides",
		"talk.mp3":        "audio",
		"noext":           "unknown",
	}
	for name, want := range cases {
		if got := kindFromName(name); got != want {
			t.Errorf("kindFromName(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestContentType(t *testing.T) {
	cases := map[string]string{
		"pdf":     "application/pdf",
		"md":      "text/plain; charset=utf-8",
		"txt":     "text/plain; charset=utf-8",
		"doc":     "text/plain; charset=utf-8",
		"image":   "application/octet-stream",
		"unknown": "application/octet-stream",
	}
	for kind, want := range cases {
		if got := contentType(kind); got != want {
			t.Errorf("contentType(%q) = %q, want %q", kind, got, want)
		}
	}
}

func TestRandID(t *testing.T) {
	id := randID("f")
	if !strings.HasPrefix(id, "f_") {
		t.Fatalf("randID prefix missing: %q", id)
	}
	if len(id) != len("f_")+10 { // 5 bytes hex-encoded = 10 chars
		t.Fatalf("randID length = %d, want %d (%q)", len(id), len("f_")+10, id)
	}
	first := randID("x")
	second := randID("x")
	if first == second {
		t.Errorf("randID should not collide on consecutive calls")
	}
}

func TestRandInt(t *testing.T) {
	for i := 0; i < 200; i++ {
		n := randInt(200, 3200)
		if n < 200 || n >= 3200 {
			t.Fatalf("randInt out of range: %d", n)
		}
	}
}

func TestRelayChatNilPipeDoesNotInventTokens(t *testing.T) {
	a := &api{}
	var n int
	err := a.relayChat(
		context.Background(),
		"",
		store.Conversation{ID: "c", WorkspaceID: "w"},
		resolvedLLM{},
		"cr_1",
		"hello?",
		"m1",
		store.ConversationPrompt{},
		func(pipeChatEvent) { n++ },
	)
	if !errors.Is(err, errAIUnavailable) {
		t.Fatalf("err = %v", err)
	}
	if n != 0 {
		t.Fatalf("emitted %d tokens", n)
	}
}

func TestRelayChatRejectsEOFBeforeDone(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"type\":\"phase\",\"phase\":\"planning\"}\n\n")
	}))
	defer upstream.Close()
	a := &api{pipe: pipeline.New(upstream.URL, "")}
	err := a.relayChat(
		context.Background(),
		"",
		store.Conversation{ID: "c", WorkspaceID: "w"},
		resolvedLLM{},
		"cr_1",
		"hello?",
		"m1",
		store.ConversationPrompt{},
		func(pipeChatEvent) {},
	)
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("err = %v, want unexpected EOF", err)
	}
}

func TestNormalizeGenerateTitle(t *testing.T) {
	if _, err := normalizeGenerateTitle("  "); err == nil {
		t.Fatal("blank title was accepted")
	}
	if _, err := normalizeGenerateTitle(strings.Repeat("a", 201)); err == nil {
		t.Fatal("overlong title was accepted")
	}
	got, err := normalizeGenerateTitle("  Cell quiz  ")
	if err != nil {
		t.Fatal(err)
	}
	if got != "Cell quiz" {
		t.Fatalf("trimmed = %q, want Cell quiz", got)
	}
}
