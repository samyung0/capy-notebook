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
		"/api/workspaces/ws_1/sources/batches/sb_1/removed",
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

// TestAnonymousBucketCountsIPv6By56 (security regression: rate-limit audit
// M6, Q246). Two addresses of one IPv6 /56 share the anonymous bucket.
func TestAnonymousBucketCountsIPv6By56(t *testing.T) {
	rdb := testRedis(t, "ip:base:ip:2001:db8:7:900::/56")
	handler := passthrough(New(rdb, Config{Anonymous: Rule{Limit: 1, Window: time.Hour}}), "")
	from := func(ip string) func(*http.Request) {
		return func(r *http.Request) { r.Header.Set("CF-Connecting-IP", ip) }
	}
	if rec := serve(handler, http.MethodGet, "/api/me", from("2001:db8:7:900::1")); rec.Code != http.StatusNoContent {
		t.Fatalf("first: status %d", rec.Code)
	}
	if rec := serve(handler, http.MethodGet, "/api/me", from("2001:db8:7:9ff:ffff::2")); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("same /56: status %d, want 429", rec.Code)
	}
}

func shareRead(secret []byte, address, path string, at time.Time) string {
	stamp := strconv.FormatInt(at.Unix(), 10)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("share-read:v2:" + stamp + ":" + address + ":" + path))
	return stamp + "." + address + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// TestShareReadsCountPerVisitorAndPage (security regression: rate-limit audit
// H7, Q244). Share reads count per visitor and shared page together: one
// visitor on one page stops at the page budget, while another visitor on that
// page, or the same visitor on another page, has their own; the site Worker's
// reads count by the visitor address they sign, and a forged, stale,
// other-path or unsigned claim counts by the request's own address.
func TestShareReadsCountPerVisitorAndPage(t *testing.T) {
	const pageA, pageB = "/api/public/notes/mat_a.sigA", "/api/public/workspaces/ws_b.sigB/summary"
	const visitor, other, worker = "198.51.100.7", "198.51.100.8", "192.0.2.80"
	rdb := testRedis(t,
		"share:ip:"+visitor+":mat_a.sigA", "share:ip:"+visitor+":ws_b.sigB",
		"share:ip:"+other+":mat_a.sigA", "share:user:u_reader:mat_a.sigA",
		"share:ip:192.0.2.81:mat_a.sigA", "share:ip:192.0.2.82:mat_a.sigA",
		"share:ip:192.0.2.83:mat_a.sigA", "share:ip:192.0.2.84:mat_a.sigA")
	secret := []byte("share-link-secret-for-tests-0123456789")
	limiter := New(rdb, Config{
		Anonymous:       Rule{Limit: 1000, Window: time.Hour},
		Authenticated:   Rule{Limit: 1000, Window: time.Hour},
		SharePage:       Rule{Limit: 2, Window: time.Hour},
		ShareReadSecret: secret,
	})
	anonymous, signedIn := passthrough(limiter, ""), passthrough(limiter, "u_reader")
	get := func(handler http.Handler, path, from, header string) int {
		return serve(handler, http.MethodGet, path, func(r *http.Request) {
			r.Header.Set("CF-Connecting-IP", from)
			if header != "" {
				r.Header.Set(ShareReadHeader, header)
			}
		}).Code
	}
	now := time.Now()
	// The visitor's direct read and a Worker read signing their address
	// share one budget for page A.
	if code := get(anonymous, pageA, visitor, ""); code != http.StatusNoContent {
		t.Fatalf("direct read of A: %d", code)
	}
	if code := get(anonymous, pageA, worker, shareRead(secret, visitor, pageA, now)); code != http.StatusNoContent {
		t.Fatalf("Worker read of A for the visitor: %d", code)
	}
	if code := get(anonymous, pageA, worker, shareRead(secret, visitor, pageA, now)); code != http.StatusTooManyRequests {
		t.Fatalf("third read of A by the visitor: %d, want 429", code)
	}
	if code := get(anonymous, pageB, worker, shareRead(secret, visitor, pageB, now)); code != http.StatusNoContent {
		t.Fatalf("the visitor on page B: %d", code)
	}
	if code := get(anonymous, pageA, worker, shareRead(secret, other, pageA, now)); code != http.StatusNoContent {
		t.Fatalf("another visitor on page A: %d", code)
	}
	if code := get(signedIn, pageA, visitor, ""); code != http.StatusNoContent {
		t.Fatalf("a signed-in reader from the visitor's address: %d", code)
	}
	// A claim that does not verify counts by the request's own address, not
	// the visitor's spent budget for page A.
	for i, claim := range []struct{ name, header string }{
		{"other path", shareRead(secret, visitor, pageB, now)},
		{"stale", shareRead(secret, visitor, pageA, now.Add(-2*time.Minute))},
		{"forged", shareRead([]byte("another-secret-of-thirty-two-chars!!"), visitor, pageA, now)},
		{"unsigned", ""},
	} {
		if code := get(anonymous, pageA, "192.0.2."+strconv.Itoa(81+i), claim.header); code != http.StatusNoContent {
			t.Errorf("%s claim: %d, want a read counted by its own address", claim.name, code)
		}
	}
	get(anonymous, pageA, "192.0.2.81", "")
	if code := get(anonymous, pageA, "192.0.2.81", ""); code != http.StatusTooManyRequests {
		t.Fatalf("third read from the untrusted address: %d, want 429", code)
	}
}

// The site Worker signs this same vector (workers/site/shareRead.test.ts).
func TestShareReadHeaderMatchesTheWorker(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/public/quizzes/mat_0123456789.abc", nil)
	r.Header.Set(ShareReadHeader, "1700000000.2001:db8::1.6KvJLOKm7yRWTgnp0XDZW69jC4M7VfcFAO5DCi8NrNg")
	address, ok := signedVisitor(r, []byte("dev-share-link-secret-0123456789abcdef"), time.Unix(1700000000, 0))
	if !ok || address != "2001:db8::1" {
		t.Fatalf("address %q (%v), want the Worker's header to verify", address, ok)
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
