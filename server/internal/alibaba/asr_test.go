package alibaba

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fake answers every request with status and body and records the last one.
func fake(t *testing.T, status int, body string) (*Client, *http.Request, *map[string]any) {
	t.Helper()
	var got http.Request
	var sent map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = *r
		if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return New("sk-test", srv.URL+"/compatible-mode/v1/"), &got, &sent
}

// The request is the shape measured live on 2026-10-23: the native endpoint
// on the compatible-mode host, SSE off, the context message before the audio
// as a data URI, and keep_dialect.
func TestTranscribeSendsTheMeasuredRequest(t *testing.T) {
	c, got, sent := fake(t, http.StatusOK,
		`{"sentence":{"text":"細胞膜","begin_time":0,"end_time":2400},"usage":{"input_tokens":75,"output_tokens":4}}`)
	out, err := c.Transcribe(context.Background(), []byte{1, 2, 3}, "webm", "audio/webm", "Workspace: Biology")
	if err != nil {
		t.Fatal(err)
	}
	if out != (Transcript{Text: "細胞膜", EndMs: 2400, InputTokens: 75, OutputTokens: 4}) {
		t.Fatalf("transcript = %+v", out)
	}
	if got.URL.Path != path || got.Header.Get("Authorization") != "Bearer sk-test" ||
		got.Header.Get("X-DashScope-SSE") != "disable" || got.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("request %s %v", got.URL.Path, got.Header)
	}
	want := `{"input":{"messages":[{"content":[{"text":"Workspace: Biology","type":"input_text"}],"role":"user"},` +
		`{"content":[{"input_audio":{"data":"data:audio/webm;base64,AQID"},"type":"input_audio"}],"role":"user"}]},` +
		`"model":"qwen-audio-3.1-asr-flash","parameters":{"format":"webm","keep_dialect":true,"sample_rate":"16000"}}`
	if raw, _ := json.Marshal(*sent); string(raw) != want {
		t.Fatalf("body = %s", raw)
	}
}

// A 429 is ErrBusy; other refusals and unreadable answers name the status and
// the provider's code, and no error carries the answer's text.
func TestTranscribeErrorsNameStatusAndCodeOnly(t *testing.T) {
	cases := []struct {
		status int
		body   string
		busy   bool
		want   string
	}{
		{http.StatusTooManyRequests, `{"code":"Throttling.RateQuota","message":"secret words"}`, true, "status 429 Throttling.RateQuota"},
		{http.StatusBadRequest, `{"code":"InvalidParameter","message":"secret words"}`, false, "status 400 InvalidParameter"},
		{http.StatusInternalServerError, `{"code":"secret words","message":"x"}`, false, "status 500 unknown"},
		{http.StatusOK, `{"output":{"text":"secret words"}}`, false, "status 200 invalid_response"},
	}
	for _, tc := range cases {
		c, _, _ := fake(t, tc.status, tc.body)
		_, err := c.Transcribe(context.Background(), []byte{1}, "ogg", "audio/ogg", "")
		var provider *Error
		if !errors.As(err, &provider) || errors.Is(err, ErrBusy) != tc.busy ||
			!strings.Contains(err.Error(), tc.want) || strings.Contains(err.Error(), "secret") {
			t.Errorf("%d %s: %v", tc.status, tc.body, err)
		}
	}
}

func TestUnconfiguredClientRefuses(t *testing.T) {
	for _, c := range []*Client{New("", "https://example.test"), New("sk", "")} {
		if c != nil {
			t.Fatal("a client without key and URL must be nil")
		}
		if _, err := c.Transcribe(context.Background(), nil, "webm", "audio/webm", ""); !errors.Is(err, ErrNotConfigured) {
			t.Fatalf("nil client: %v", err)
		}
	}
}
