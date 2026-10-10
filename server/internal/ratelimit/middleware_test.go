package ratelimit

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestCollaborationBypassesExhaustedAnonymousBudget(t *testing.T) {
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
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		t.Fatal(err)
	}
	const key = "capy:rl:ip:base:ip:192.0.2.71"
	if err := rdb.Del(context.Background(), key).Err(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rdb.Del(context.Background(), key).Err() })
	handler := Middleware(New(rdb, Config{
		Anonymous: Rule{Limit: 1, Window: time.Hour},
	}), func(*http.Request) string { return "" })(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	request := func(path string, want int) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = "192.0.2.71:1234"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("%s: status %d, want %d", path, rec.Code, want)
		}
	}
	request("/api/public/workspaces/ws_1", http.StatusNoContent)
	request("/api/public/workspaces/ws_1", http.StatusTooManyRequests)
	for _, path := range []string{
		"/internal/collaboration/files/f_1/bootstrap",
		"/internal/collaboration/files/f_1/access",
		"/internal/collaboration/files/f_1/checkpoint",
		"/internal/collaboration/files/f_1/refresh-candidate",
		"/internal/collaboration/materials/m_1/projection",
		"/api/internal/materials",
	} {
		request(path, http.StatusNoContent)
	}
	request("/api/public/workspaces/ws_1", http.StatusTooManyRequests)
}

// TestThumbnailCapturesStopAt60AnHour (security regression: review T3 S5,
// Epo's 60 captures an hour per user). With the default budgets the 61st
// capture in a burst is refused before the handler, and another route of the
// same user still passes; without the thumbnail class the general budget lets
// it through.
func TestThumbnailCapturesStopAt60AnHour(t *testing.T) {
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
	keys := []string{"capy:rl:user:base:user:u_thumbs", "capy:rl:thumbnail:user:u_thumbs"}
	if err := rdb.Del(context.Background(), keys...).Err(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rdb.Del(context.Background(), keys...).Err() })
	handled := 0
	handler := Middleware(New(rdb, DefaultConfig()), func(*http.Request) string { return "u_thumbs" })(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			handled++
			w.WriteHeader(http.StatusNoContent)
		}))
	post := func(path string) int {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, nil))
		return rec.Code
	}
	for i := 1; i <= 60; i++ {
		if code := post("/api/files/f_" + string(rune('a'+i%26)) + "/thumbnail"); code != http.StatusNoContent {
			t.Fatalf("capture %d: status %d", i, code)
		}
	}
	if code := post("/api/files/f_z/thumbnail"); code != http.StatusTooManyRequests {
		t.Fatalf("capture 61: status %d, want 429", code)
	}
	if code := post("/api/files/f_z"); code != http.StatusNoContent {
		t.Fatalf("another route: status %d", code)
	}
	if handled != 61 {
		t.Fatalf("handler ran %d times, want 61", handled)
	}
}
