package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/store"
)

func TestUsageEventsZeroLLMCreditsForUserKey(t *testing.T) {
	u := pipeUsage{InputTokens: 10, OutputTokens: 4, EmbedTokens: 20, Calls: 2}
	rates := store.TokenRates{
		ModelKey:             "gpt-5.6-sol",
		ModelVersion:         1,
		MicrosPerInputToken:  250,
		MicrosPerOutputToken: 1000,
	}
	embed := store.TokenRates{
		ModelKey:            "qwen-embed",
		ModelVersion:        1,
		MicrosPerInputToken: 50,
	}
	events := u.events("u_1", "ws_1", store.SurfaceChat, rates, embed, models.PaidByUser)
	if len(events) != 2 {
		t.Fatalf("events: %d", len(events))
	}
	if events[0].Kind != store.KindLLM || events[0].CreditMicros != 0 {
		t.Fatalf("llm event %#v", events[0])
	}
	if events[0].Metadata["paidBy"] != models.PaidByUser {
		t.Fatalf("paidBy: %#v", events[0].Metadata)
	}
	if events[1].Kind != store.KindEmbedding || events[1].CreditMicros != 0 {
		t.Fatalf("embed event %#v", events[1])
	}
}

func TestUsageEventsDoNotInventEmbedRates(t *testing.T) {
	u := pipeUsage{EmbedTokens: 100}
	events := u.events("u_1", "ws_1", store.SurfaceChat, store.TokenRates{}, store.TokenRates{}, models.PaidByPlatform)
	if len(events) != 1 {
		t.Fatalf("events: %d", len(events))
	}
	if events[0].Kind != store.KindEmbedding {
		t.Fatalf("kind %#v", events[0])
	}
	if events[0].ModelKey != "" || events[0].CreditMicros != 0 {
		t.Fatalf("invented embed rates: %#v", events[0])
	}
}

func TestUsageEventsEmptyPaidByDoesNotInventRates(t *testing.T) {
	u := pipeUsage{InputTokens: 10, OutputTokens: 4}
	events := u.events("u_1", "ws_1", store.SurfaceChat, store.TokenRates{}, store.TokenRates{}, "")
	if len(events) != 1 {
		t.Fatalf("events: %d", len(events))
	}
	if events[0].CreditMicros != 0 {
		t.Fatalf("empty rates must stay zero, got %#v", events[0])
	}
	if events[0].Metadata["paidBy"] != "" {
		t.Fatalf("paidBy should stay empty, got %#v", events[0].Metadata)
	}
}

func TestResolveEmbeddingRequiresStore(t *testing.T) {
	a := &api{}
	_, err := a.resolveEmbedding(context.Background(), "ws_1")
	if !errors.Is(err, store.ErrModelUnavailable) {
		t.Fatalf("err = %v", err)
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

func TestUsageEventsZeroQueryEmbedCredits(t *testing.T) {
	u := pipeUsage{InputTokens: 8, OutputTokens: 2, EmbedTokens: 1_000_000}
	embed := store.TokenRates{
		ModelKey:            "qwen-embed",
		ModelVersion:        1,
		MicrosPerInputToken: 50,
	}
	llm := store.TokenRates{MicrosPerInputToken: 250, MicrosPerOutputToken: 1000, ModelKey: "deepseek-flash", ModelVersion: 1}
	events := u.events("u_1", "ws_1", store.SurfaceChat, llm, embed, models.PaidByPlatform)
	if len(events) != 2 {
		t.Fatalf("events: %d", len(events))
	}
	if events[0].Kind != store.KindLLM || events[0].CreditMicros == 0 {
		t.Fatalf("llm event %#v", events[0])
	}
	if events[1].Kind != store.KindEmbedding || events[1].CreditMicros != 0 {
		t.Fatalf("query embed must not bill, got %#v", events[1])
	}
	if events[1].ModelKey != "qwen-embed" {
		t.Fatalf("query embed pin: %#v", events[1])
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
	if randID("x") == randID("x") {
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
		"u",
		store.Conversation{ID: "c", WorkspaceID: "w"},
		resolvedLLM{},
		"hello?",
		func(string) { n++ },
		func(pipeChatEvent) {},
	)
	if !errors.Is(err, errAIUnavailable) {
		t.Fatalf("err = %v", err)
	}
	if n != 0 {
		t.Fatalf("emitted %d tokens", n)
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
