package obs

import (
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
