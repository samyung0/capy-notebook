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
