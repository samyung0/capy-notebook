package httpapi_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// captchaCalls counts testCaptcha's checks, which never reach Cloudflare:
// "turnstile-ok" passes, "turnstile-down" is an outage, anything else is
// refused.
var captchaCalls atomic.Int32

func testCaptcha(_ context.Context, token string) error {
	captchaCalls.Add(1)
	switch token {
	case "turnstile-ok":
		return nil
	case "turnstile-down":
		return errors.New("siteverify: status 502")
	}
	return httpapi.ErrCaptchaFailed
}

func gradeSignedOut(h http.Handler, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("CF-Connecting-IP", "198.51.100.61")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestSignedOutChecksNeedATurnstileToken (security regression: rate-limit
// audit Q271). A signed-out answer check without a token or with a refused
// one is a 403 captcha_failed that never reaches Jev; one siteverify cannot
// decide is a 503 captcha_unavailable; a passing token is graded.
func TestSignedOutChecksNeedATurnstileToken(t *testing.T) {
	h, st, calls := openGradingAPI(t, "full")
	path := "/api/public/quizzes/" + store.ShareToken(nil, gradingQuiz(t, h, "link")) + "/grade"
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM anonymous_grading_usage WHERE ip_hash=$1`,
			st.AnonymousIPHash("198.51.100.61"))
	})
	answers := `"questionId":"q1","answers":{"open-a":"Because."}`
	for name, body := range map[string]string{
		"no token":  `{` + answers + `}`,
		"bad token": `{` + answers + `,"turnstileToken":"forged"}`,
	} {
		before := calls.Load()
		rec := gradeSignedOut(h, path, body)
		if rec.Code != http.StatusForbidden || errorCode(t, rec) != "captcha_failed" || calls.Load() != before {
			t.Fatalf("%s → %d %s, want 403 captcha_failed before Jev", name, rec.Code, rec.Body.String())
		}
	}
	rec := gradeSignedOut(h, path, `{`+answers+`,"turnstileToken":"turnstile-down"}`)
	if rec.Code != http.StatusServiceUnavailable || errorCode(t, rec) != "captcha_unavailable" {
		t.Fatalf("siteverify outage → %d %s, want 503 captcha_unavailable", rec.Code, rec.Body.String())
	}
	if rec := gradeSignedOut(h, path, `{`+answers+`,"turnstileToken":"turnstile-ok"}`); rec.Code != http.StatusOK {
		t.Fatalf("passing token → %d %s", rec.Code, rec.Body.String())
	}
}

// TestSignedOutChecksTakeTokensFromTheAppHosts (security regression:
// rate-limit audit r3 S-2, Q350). The Turnstile hosts in Config reach the
// siteverify client New builds: a token solved on another host is a 403
// captcha_failed, one solved on an app host is graded.
func TestSignedOutChecksTakeTokensFromTheAppHosts(t *testing.T) {
	siteverify := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := "evil.example"
		if r.FormValue("response") == "app-token" {
			host = "app.example"
		}
		_, _ = fmt.Fprintf(w, `{"success":true,"hostname":%q}`, host)
	}))
	t.Cleanup(siteverify.Close)
	httpapi.SetTurnstileVerifyURL(t, siteverify.URL)
	h, st, _ := openGradingAPIWith(t, "full", httpapi.Config{
		TurnstileSecret: "real-secret", TurnstileHosts: []string{"app.example"},
	})
	path := "/api/public/quizzes/" + store.ShareToken(nil, gradingQuiz(t, h, "link")) + "/grade"
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM anonymous_grading_usage WHERE ip_hash=$1`,
			st.AnonymousIPHash("198.51.100.61"))
	})
	answers := `{"questionId":"q1","answers":{"open-a":"Because."},"turnstileToken":`
	rec := gradeSignedOut(h, path, answers+`"other-token"}`)
	if rec.Code != http.StatusForbidden || errorCode(t, rec) != "captcha_failed" {
		t.Fatalf("token from another host → %d %s, want 403 captcha_failed", rec.Code, rec.Body.String())
	}
	if rec := gradeSignedOut(h, path, answers+`"app-token"}`); rec.Code != http.StatusOK {
		t.Fatalf("token from an app host → %d %s", rec.Code, rec.Body.String())
	}
}

// TestSignedInChecksNeedNoTurnstileToken (rate-limit audit Q271). A
// signed-in question check is graded without a token.
func TestSignedInChecksNeedNoTurnstileToken(t *testing.T) {
	h, _, _ := openGradingAPI(t, "full")
	id := gradingQuiz(t, h, "private")
	before := captchaCalls.Load()
	rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/check", "u_owner",
		map[string]any{"questionId": "q1", "answers": map[string]any{"open-a": "Because."}})
	if rec.Code != http.StatusOK || captchaCalls.Load() != before {
		t.Fatalf("signed-in check → %d %s, want graded with no check", rec.Code, rec.Body.String())
	}
}

// TestShareTokenIsCheckedBeforeTurnstile (security regression: rate-limit
// audit Q271, L6). A forged share link is refused before siteverify, so it
// costs nothing.
func TestShareTokenIsCheckedBeforeTurnstile(t *testing.T) {
	h, _, _ := openGradingAPI(t, "full")
	token := store.ShareToken(nil, gradingQuiz(t, h, "link"))
	forged := token[:len(token)-1] + "x"
	if forged == token {
		forged = token[:len(token)-1] + "y"
	}
	before := captchaCalls.Load()
	for _, path := range []string{
		"/api/public/quizzes/" + forged + "/grade",
		"/api/public/notes/" + forged + "/quizzes/q_1/grade",
	} {
		rec := gradeSignedOut(h, path, `{"questionId":"q1","answers":{"open-a":"Because."},"turnstileToken":"turnstile-ok"}`)
		if rec.Code != http.StatusNotFound || captchaCalls.Load() != before {
			t.Fatalf("%s → %d with %d checks, want 404 before any check", path, rec.Code, captchaCalls.Load()-before)
		}
	}
}
