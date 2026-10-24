package ratelimit

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"
)

// fakeClock moves only when the limiter sleeps.
type fakeClock struct {
	mu    sync.Mutex
	now   time.Time
	slept time.Duration
}

func newFakeClock() *fakeClock { return &fakeClock{now: time.Now()} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Sleep(_ context.Context, d time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	c.slept += d
	return nil
}

func (c *fakeClock) Slept() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.slept
}

// waitConfig allows one AI call per window and one base request per window,
// so the second of each is limited for about window.
func waitConfig(clock Clock, window time.Duration) Config {
	return Config{
		Anonymous:     Rule{Limit: 1, Window: window, Burst: 1},
		Authenticated: Rule{Limit: 1, Window: window, Burst: 1},
		AI:            Rule{Limit: 1, Window: window, Burst: 1},
		AIBurst:       Rule{Limit: 100, Window: time.Minute},
		Clock:         clock,
	}
}

// chatHandler finishes a pending chat wait the way the chat stream does and
// records whether there was one.
func chatHandler(l *Limiter, user string, waited *bool) http.Handler {
	return Middleware(l, func(*http.Request) string { return user })(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			wait := PendingWait(r.Context())
			*waited = wait != nil
			if wait != nil {
				if err := wait(r.Context()); err != nil {
					w.WriteHeader(http.StatusTooManyRequests)
					return
				}
			}
			w.WriteHeader(http.StatusNoContent)
		}))
}

// TestChatSendWaitsForAShortLimit (rate-limit audit Q268). A chat send whose
// AI bucket admits it within 10 s waits for it in its stream and goes on.
func TestChatSendWaitsForAShortLimit(t *testing.T) {
	rdb := testRedis(t, "user:base:user:u_wait_chat", "ai:user:u_wait_chat", "ai-burst:user:u_wait_chat")
	clock := newFakeClock()
	cfg := waitConfig(clock, 8*time.Second)
	cfg.Authenticated = Rule{Limit: 300, Window: time.Minute}
	var waited bool
	handler := chatHandler(New(rdb, cfg), "u_wait_chat", &waited)
	const path = "/api/workspaces/ws_1/chat/stream"
	if rec := serve(handler, http.MethodPost, path, nil); rec.Code != http.StatusNoContent || waited {
		t.Fatalf("first send: status %d waited %v, want 204 admitted outright", rec.Code, waited)
	}
	rec := serve(handler, http.MethodPost, path, nil)
	if rec.Code != http.StatusNoContent || !waited {
		t.Fatalf("second send: status %d waited %v, want a wait in the stream and 204", rec.Code, waited)
	}
	if slept := clock.Slept(); slept < 7*time.Second || slept > MaxWait {
		t.Fatalf("waited %v, want about the 8 s retry-after", slept)
	}
}

// TestChatSendOverTheWaitIsRefusedAtOnce (rate-limit audit Q268). A chat
// send whose AI bucket needs more than 10 s answers 429 without waiting.
func TestChatSendOverTheWaitIsRefusedAtOnce(t *testing.T) {
	rdb := testRedis(t, "user:base:user:u_wait_long", "ai:user:u_wait_long", "ai-burst:user:u_wait_long")
	clock := newFakeClock()
	cfg := waitConfig(clock, 20*time.Second)
	cfg.Authenticated = Rule{Limit: 300, Window: time.Minute}
	var waited bool
	handler := chatHandler(New(rdb, cfg), "u_wait_long", &waited)
	const path = "/api/workspaces/ws_1/chat/stream"
	serve(handler, http.MethodPost, path, nil)
	waited = false
	rec := serve(handler, http.MethodPost, path, nil)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "20" || waited || clock.Slept() != 0 {
		t.Fatalf("send past the wait: status %d Retry-After %q waited %v slept %v, want 429 at once",
			rec.Code, rec.Header().Get("Retry-After"), waited, clock.Slept())
	}
}

// TestAnswerChecksWaitThenProceed (rate-limit audit Q268). A limited answer
// check, signed in or signed out, waits for its buckets and is then served.
func TestAnswerChecksWaitThenProceed(t *testing.T) {
	rdb := testRedis(t, "user:base:user:u_wait_check", "ai:user:u_wait_check", "ai-burst:user:u_wait_check",
		"ip:base:ip:192.0.2.80")
	for _, c := range []struct{ user, path string }{
		{"u_wait_check", "/api/review/check"},
		{"", "/api/public/quizzes/tok_1/grade"},
	} {
		clock := newFakeClock()
		handler := passthrough(New(rdb, waitConfig(clock, 8*time.Second)), c.user)
		edit := func(r *http.Request) { r.RemoteAddr = "192.0.2.80:1234" }
		serve(handler, http.MethodPost, c.path, edit)
		if rec := serve(handler, http.MethodPost, c.path, edit); rec.Code != http.StatusNoContent {
			t.Fatalf("%s: status %d, want 204 after the wait", c.path, rec.Code)
		}
		if slept := clock.Slept(); slept < 7*time.Second || slept > MaxWait {
			t.Fatalf("%s: waited %v, want about the 8 s retry-after", c.path, slept)
		}
	}
}

// TestOtherLimitedRoutesAreRefusedAtOnce (rate-limit audit Q268). Every
// route other than a chat send or an answer check answers 429 at once.
func TestOtherLimitedRoutesAreRefusedAtOnce(t *testing.T) {
	rdb := testRedis(t, "user:base:user:u_wait_none", "ai:user:u_wait_none", "ai-burst:user:u_wait_none")
	clock := newFakeClock()
	cfg := waitConfig(clock, 8*time.Second)
	handler := passthrough(New(rdb, cfg), "u_wait_none")
	serve(handler, http.MethodGet, "/api/workspaces", nil)
	if rec := serve(handler, http.MethodGet, "/api/workspaces", nil); rec.Code != http.StatusTooManyRequests || clock.Slept() != 0 {
		t.Fatalf("base route: status %d slept %v, want 429 at once", rec.Code, clock.Slept())
	}
	cfg.Authenticated = Rule{Limit: 300, Window: time.Minute}
	handler = passthrough(New(rdb, cfg), "u_wait_none")
	serve(handler, http.MethodPost, "/api/workspaces/ws_1/generate", nil)
	if rec := serve(handler, http.MethodPost, "/api/workspaces/ws_1/generate", nil); rec.Code != http.StatusTooManyRequests || clock.Slept() != 0 {
		t.Fatalf("generate: status %d slept %v, want 429 at once", rec.Code, clock.Slept())
	}
}

// TestUploadTicketTakesTheUploadClass (rate-limit audit Q282). An upload
// ticket spends the user's upload class and, past it, learns how long until
// the class admits it, which its place in the upload line waits for.
func TestUploadTicketTakesTheUploadClass(t *testing.T) {
	rdb := testRedis(t, "upload:user:u_take_upload")
	l := New(rdb, Config{Upload: Rule{Limit: 1, Window: 8 * time.Second, Burst: 1}})
	ctx := context.Background()
	if wait, err := l.TakeUpload(ctx, "u_take_upload"); err != nil || wait != 0 {
		t.Fatalf("first ticket: wait %v err %v, want admitted", wait, err)
	}
	if wait, err := l.TakeUpload(ctx, "u_take_upload"); err != nil || wait < 7*time.Second || wait > 8*time.Second {
		t.Fatalf("second ticket: wait %v err %v, want about 8 s", wait, err)
	}
}
