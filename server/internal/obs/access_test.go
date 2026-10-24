package obs

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/getsentry/sentry-go"
)

// Share and invite tokens open what they name, so logs and Sentry keep only a
// hash of them (security review J-F1, Sam 2026-10-19 13a).
func TestLogPathHashesTokenSegments(t *testing.T) {
	token := "qz_0123456789.AbCdEfGhIjKlMnOp"
	for _, path := range []string{
		"/api/public/quizzes/" + token,
		"/api/public/notes/" + token + "/quizzes/q1/grade",
		"/api/public/workspaces/" + token + "/summary",
		"/api/workspace-invites/" + token + "/accept",
	} {
		got := LogPath(path)
		if strings.Contains(got, token) || !strings.Contains(got, "/h_") || LogPath(path) != got {
			t.Fatalf("LogPath(%q) = %q, want the token as a stable hash", path, got)
		}
	}
	for _, path := range []string{"/api/workspaces/ws_1", "/api/public/", "/healthz"} {
		if got := LogPath(path); got != path {
			t.Fatalf("LogPath(%q) = %q, want it unchanged", path, got)
		}
	}
	event := scrubEvent(&sentry.Event{
		Message:     "GET /api/public/quizzes/" + token + ": HTTP 500",
		Transaction: "GET /api/workspace-invites/" + token + "/accept",
		Request:     &sentry.Request{URL: "https://api.example.test/api/public/notes/" + token + "?x=1", QueryString: "token=secret"},
		Exception:   []sentry.Exception{{Value: "POST /api/public/quizzes/" + token + "/grade: HTTP 502"}},
	})
	for _, text := range []string{event.Message, event.Transaction, event.Request.URL, event.Request.QueryString, event.Exception[0].Value} {
		if strings.Contains(text, token) || strings.Contains(text, "secret") {
			t.Fatalf("scrubbed event still holds a token: %q", text)
		}
	}
}

// Performance transactions pass the same scrub as errors, and the calling
// page's Referer and Origin never leave (security review B1, B2).
func TestSentryTransactionsAndRefererAreScrubbed(t *testing.T) {
	token := "qz_0123456789.AbCdEfGhIjKlMnOp"
	invite := "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFi"
	options := sentryOptions(SentryConfig{Service: "api"}, 0.1)
	event := func() *sentry.Event {
		return &sentry.Event{
			Type:        "transaction",
			Transaction: "GET /api/public/quizzes/" + token,
			Request: &sentry.Request{
				URL: "https://api.example.test/api/public/quizzes/" + token,
				Headers: map[string]string{
					"Referer":    "https://app.example.test/workspace-invites/" + invite,
					"Origin":     "https://app.example.test",
					"User-Agent": "test",
				},
			},
			Spans: []*sentry.Span{{Description: "POST /api/workspace-invites/" + invite + "/accept"}},
		}
	}
	for name, send := range map[string]func(*sentry.Event, *sentry.EventHint) *sentry.Event{
		"transaction": options.BeforeSendTransaction,
		"error":       options.BeforeSend,
	} {
		out := send(event(), nil)
		text := out.Transaction + out.Request.URL + out.Spans[0].Description
		for header, value := range out.Request.Headers {
			text += header + value
		}
		if strings.Contains(text, token) || strings.Contains(text, invite) || strings.Contains(text, "Referer") ||
			out.Request.Headers["User-Agent"] != "test" || out.Tags["service"] != "api" {
			t.Fatalf("%s left %q (headers %v)", name, text, out.Request.Headers)
		}
	}
}

// TestClientAddressFoldsIPv6To56 (security regression: rate-limit audit M6,
// Q246). Every address of one IPv6 /56 is one limiter, grading and share-read
// key; IPv4 stays whole.
func TestClientAddressFoldsIPv6To56(t *testing.T) {
	for ip, want := range map[string]string{
		"2001:db8:1:200:aaaa::1":   "2001:db8:1:200::/56",
		"2001:db8:1:2ff:bbbb::fff": "2001:db8:1:200::/56",
		"2001:db8:1:300::1":        "2001:db8:1:300::/56",
		"::ffff:192.0.2.7":         "192.0.2.7",
		"192.0.2.7":                "192.0.2.7",
	} {
		r := httptest.NewRequest(http.MethodGet, "/api/public/quizzes/x", nil)
		r.Header.Set("CF-Connecting-IP", ip)
		if got := ClientAddress(r); got != want {
			t.Errorf("ClientAddress(%q) = %q, want %q", ip, got, want)
		}
	}
}

// TestAccessLogClientAbortedFailureIsAWarning (rate-limit audit client
// aborts): a 5xx written after the client left logs below ERROR.
func TestAccessLogClientAbortedFailureIsAWarning(t *testing.T) {
	var out bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&out, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	handler := AccessLog(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/me", nil).WithContext(ctx))
	if !strings.Contains(out.String(), `"level":"WARN"`) || !strings.Contains(out.String(), `"client_aborted":true`) {
		t.Fatalf("log = %s, want a WARN line marked client_aborted", out.String())
	}
}
