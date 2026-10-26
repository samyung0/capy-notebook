package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// TestTurnstileVerifierMapsSiteverifyAnswers (security regression: rate-limit
// audit r2 S-3, N-2, Q308). The real siteverify client against a local fake:
// a pass from an app host verifies, a refused token or one solved on another
// host fails the check, and Cloudflare's own errors, a refused secret, a
// non-200 and a slow answer are outages.
func TestTurnstileVerifierMapsSiteverifyAnswers(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		slow   bool
		want   string // "ok", "failed" or "outage"
	}{
		{"pass", 200, `{"success":true,"hostname":"uat-app.capynotebook.com"}`, false, "ok"},
		{"another host", 200, `{"success":true,"hostname":"evil.example"}`, false, "failed"},
		{"invalid response", 200, `{"success":false,"error-codes":["invalid-input-response"]}`, false, "failed"},
		{"spent token", 200, `{"success":false,"error-codes":["timeout-or-duplicate"]}`, false, "failed"},
		{"internal error", 200, `{"success":false,"error-codes":["internal-error"]}`, false, "outage"},
		{"refused secret", 200, `{"success":false,"error-codes":["invalid-input-secret"]}`, false, "outage"},
		{"http 500", 500, `{"success":true}`, false, "outage"},
		{"slow", 200, `{"success":true,"hostname":"uat-app.capynotebook.com"}`, true, "outage"},
	}
	release := make(chan struct{})
	defer close(release)
	var current atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := cases[current.Load()]
		if r.FormValue("secret") != "real-secret" || r.FormValue("response") != "token" {
			http.Error(w, "unexpected form", http.StatusBadRequest)
			return
		}
		if c.slow {
			select {
			case <-release:
			case <-r.Context().Done():
			}
			return
		}
		w.WriteHeader(c.status)
		_, _ = w.Write([]byte(c.body))
	}))
	defer srv.Close()
	previousURL, previousTimeout := turnstileVerifyURL, turnstileTimeout
	turnstileVerifyURL, turnstileTimeout = srv.URL, 200*time.Millisecond
	defer func() { turnstileVerifyURL, turnstileTimeout = previousURL, previousTimeout }()
	verify := newTurnstileVerifier("real-secret", []string{"uat-app.capynotebook.com", "app.uat.capynotebook.com"})

	for i, c := range cases {
		current.Store(int32(i))
		err := verify(context.Background(), "token")
		got := "outage"
		switch {
		case err == nil:
			got = "ok"
		case errors.Is(err, ErrCaptchaFailed):
			got = "failed"
		}
		if got != c.want {
			t.Errorf("%s: %v, want %s", c.name, err, c.want)
		}
	}
}
