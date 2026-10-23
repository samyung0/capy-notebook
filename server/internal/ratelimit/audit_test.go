package ratelimit

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// testRedis is the disposable Redis of pnpm test:go, with the keys the test
// names cleared before and after.
func testRedis(t *testing.T, keys ...string) *redis.Client {
	t.Helper()
	url := os.Getenv("CAPY_GO_TEST_REDIS_URL")
	if url == "" {
		t.Skip("run with pnpm test:go for disposable Redis")
	}
	options, err := redis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(options)
	t.Cleanup(func() { _ = rdb.Close() })
	clear := func() {
		for _, key := range keys {
			_ = rdb.Del(context.Background(), "capy:rl:"+key).Err()
		}
	}
	clear()
	t.Cleanup(clear)
	return rdb
}

func serve(handler http.Handler, method, path string, edit func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if edit != nil {
		edit(req)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func passthrough(l *Limiter, user string) http.Handler {
	return Middleware(l, func(*http.Request) string { return user })(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
}

// TestAIAndUploadRefuseWithoutRedis (security regression: rate-limit audit
// H1). While the limiter cannot reach Redis, the AI and upload classes answer
// 503 with Retry-After; the base class still lets requests through.
func TestAIAndUploadRefuseWithoutRedis(t *testing.T) {
	dead := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1", MaxRetries: -1, DialTimeout: 200 * time.Millisecond})
	t.Cleanup(func() { _ = dead.Close() })
	handler := passthrough(New(dead, DefaultConfig()), "u_1")
	for _, path := range []string{
		"/api/workspaces/ws_1/chat/stream",
		"/api/workspaces/ws_1/sources/uploads/tickets",
		"/api/workspaces/ws_1/sources/import",
	} {
		rec := serve(handler, http.MethodPost, path, nil)
		if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "5" {
			t.Errorf("%s: status %d Retry-After %q, want 503 and 5", path, rec.Code, rec.Header().Get("Retry-After"))
		}
	}
	if rec := serve(handler, http.MethodGet, "/api/workspaces", nil); rec.Code != http.StatusNoContent {
		t.Errorf("base class: status %d, want it to pass", rec.Code)
	}
}

// TestRetryAfterRoundsUp (rate-limit audit L3): a client that waits the named
// seconds is let through, so a fraction rounds up.
func TestRetryAfterRoundsUp(t *testing.T) {
	rec := httptest.NewRecorder()
	reject(rec, httptest.NewRequest(http.MethodGet, "/api/me", nil), 1500*time.Millisecond, "rate_limited")
	if got := rec.Header().Get("Retry-After"); got != "2" {
		t.Fatalf("Retry-After = %q, want 2", got)
	}
}

// TestAnonymousBucketCountsIPv6By64 (security regression: rate-limit audit
// M6). Two addresses of one IPv6 /64 share the anonymous bucket.
func TestAnonymousBucketCountsIPv6By64(t *testing.T) {
	rdb := testRedis(t, "ip:base:ip:2001:db8:7:9::/64")
	handler := passthrough(New(rdb, Config{Anonymous: Rule{Limit: 1, Window: time.Hour}}), "")
	from := func(ip string) func(*http.Request) {
		return func(r *http.Request) { r.Header.Set("CF-Connecting-IP", ip) }
	}
	if rec := serve(handler, http.MethodGet, "/api/public/notes/n", from("2001:db8:7:9::1")); rec.Code != http.StatusNoContent {
		t.Fatalf("first: status %d", rec.Code)
	}
	if rec := serve(handler, http.MethodGet, "/api/public/notes/n", from("2001:db8:7:9:ffff::2")); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("same /64: status %d, want 429", rec.Code)
	}
}

func shareRead(secret []byte, path string, at time.Time) string {
	stamp := strconv.FormatInt(at.Unix(), 10)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("share-read:v1:" + stamp + ":" + path))
	return stamp + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// TestShareReadsHaveTheirOwnBucketPerToken (security regression: rate-limit
// audit H7). The site Worker's signed reads skip the anonymous bucket they
// would all share and count per share token; an unsigned, forged or stale
// header counts as an anonymous read.
func TestShareReadsHaveTheirOwnBucketPerToken(t *testing.T) {
	const pathA, pathB = "/api/public/notes/mat_a.sigA", "/api/public/workspaces/ws_b.sigB/summary"
	rdb := testRedis(t, "share:mat_a.sigA", "share:ws_b.sigB", "ip:base:ip:192.0.2.80")
	secret := []byte("share-link-secret-for-tests-0123456789")
	handler := passthrough(New(rdb, Config{
		Anonymous:       Rule{Limit: 1, Window: time.Hour},
		SharePage:       Rule{Limit: 2, Window: time.Hour},
		ShareReadSecret: secret,
	}), "")
	get := func(path, header string) int {
		return serve(handler, http.MethodGet, path, func(r *http.Request) {
			r.Header.Set("CF-Connecting-IP", "192.0.2.80")
			if header != "" {
				r.Header.Set(ShareReadHeader, header)
			}
		}).Code
	}
	now := time.Now()
	if code := get(pathA, ""); code != http.StatusNoContent {
		t.Fatalf("anonymous read: %d", code)
	}
	for i := range 2 {
		if code := get(pathA, shareRead(secret, pathA, now)); code != http.StatusNoContent {
			t.Fatalf("signed read %d of A: %d", i+1, code)
		}
	}
	if code := get(pathA, shareRead(secret, pathA, now)); code != http.StatusTooManyRequests {
		t.Fatalf("third signed read of A: %d, want 429", code)
	}
	if code := get(pathB, shareRead(secret, pathB, now)); code != http.StatusNoContent {
		t.Fatalf("signed read of B: %d", code)
	}
	for name, header := range map[string]string{
		"other path": shareRead(secret, pathA, now),
		"stale":      shareRead(secret, pathB, now.Add(-2*time.Minute)),
		"forged":     shareRead([]byte("another-secret-of-thirty-two-chars!!"), pathB, now),
	} {
		if code := get(pathB, header); code != http.StatusTooManyRequests {
			t.Errorf("%s header: %d, want the spent anonymous bucket's 429", name, code)
		}
	}
}

// The site Worker signs this same vector (workers/site/shareRead.test.ts).
func TestShareReadHeaderMatchesTheWorker(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/public/quizzes/mat_0123456789.abc", nil)
	r.Header.Set(ShareReadHeader, "1700000000.MHKSRYRDFEWQHrCPoR1XqkymJTrqaynfXU9zZNXv9Bs")
	token, ok := shareReadToken(r, []byte("dev-share-link-secret-0123456789abcdef"), time.Unix(1700000000, 0))
	if !ok || token != "mat_0123456789.abc" {
		t.Fatalf("token %q (%v), want the Worker's header to verify", token, ok)
	}
}

// TestBankCommentEmailsAreCapped (security regression: rate-limit audit L7).
// Each bank comment sends an email; past a burst of 10 the next is refused,
// while other bank routes and discussion comments pass.
func TestBankCommentEmailsAreCapped(t *testing.T) {
	rdb := testRedis(t, "user:base:user:u_bank", "bank-comment:user:u_bank")
	handler := passthrough(New(rdb, DefaultConfig()), "u_bank")
	for i := 1; i <= 10; i++ {
		if rec := serve(handler, http.MethodPost, "/api/bank/questions/q_1/comments", nil); rec.Code != http.StatusNoContent {
			t.Fatalf("comment %d: status %d", i, rec.Code)
		}
	}
	if rec := serve(handler, http.MethodPost, "/api/bank/questions/q_2/comments", nil); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("comment 11: status %d, want 429", rec.Code)
	}
	for _, path := range []string{"/api/bank/questions/q_2/review", "/api/discussions/d_1/comments"} {
		if rec := serve(handler, http.MethodPost, path, nil); rec.Code != http.StatusNoContent {
			t.Fatalf("%s: status %d", path, rec.Code)
		}
	}
}

// TestIntegrationRoutesStopAt30AMinute (security regression: rate-limit audit
// M12). The Clerk-backed routes share one per-user bucket of 30 a minute.
func TestIntegrationRoutesStopAt30AMinute(t *testing.T) {
	rdb := testRedis(t, "user:base:user:u_clerk", "integration:user:u_clerk", "upload:user:u_clerk")
	handler := passthrough(New(rdb, DefaultConfig()), "u_clerk")
	for i := 1; i <= 29; i++ {
		if rec := serve(handler, http.MethodGet, "/api/integrations", nil); rec.Code != http.StatusNoContent {
			t.Fatalf("call %d: status %d", i, rec.Code)
		}
	}
	if rec := serve(handler, http.MethodPost, "/api/workspaces/ws_1/sources/import", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("import as call 30: status %d", rec.Code)
	}
	if rec := serve(handler, http.MethodPatch, "/api/me", nil); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("call 31: status %d, want 429", rec.Code)
	}
	if rec := serve(handler, http.MethodGet, "/api/me", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("another route: status %d", rec.Code)
	}
}
