package httpapi_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/ratelimit"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// limitClock moves only when the limiter sleeps.
type limitClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *limitClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *limitClock) Sleep(_ context.Context, d time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	return nil
}

// TestChatSendShowsItsLimitWait (rate-limit audit Q268). A chat send its AI
// bucket admits within 10 s opens its stream, says it is waiting with the
// waiting_limit phase, and then runs the turn.
func TestChatSendShowsItsLimitWait(t *testing.T) {
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
	keys := []string{"capy:rl:user:base:user:u_editor", "capy:rl:ai:user:u_editor", "capy:rl:ai-burst:user:u_editor"}
	rdb.Del(context.Background(), keys...)
	t.Cleanup(func() { rdb.Del(context.Background(), keys...) })

	turns := 0
	retrieval := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		turns++
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"done\"}\n\n"))
	}))
	t.Cleanup(retrieval.Close)
	h, st, _, _ := openInternalHTTPWithRedis(t, pipeline.New(retrieval.URL, ""), rdb, func(_ *store.Store, cfg *httpapi.Config) {
		cfg.RateLimit = ratelimit.Config{
			Authenticated: ratelimit.Rule{Limit: 300, Window: time.Minute},
			AI:            ratelimit.Rule{Limit: 1, Window: 8 * time.Second, Burst: 1},
			AIBurst:       ratelimit.Rule{Limit: 100, Window: time.Minute},
			Clock:         &limitClock{now: time.Now()},
		}
	})
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(),
			`DELETE FROM conversations WHERE workspace_id='ws_e2e_private' AND title LIKE 'teach me%'`)
	})
	send := func() string {
		rec := doAsUser(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/chat/stream", "u_editor",
			map[string]any{"text": "teach me while waiting"})
		if rec.Code != http.StatusOK {
			t.Fatalf("send: status %d body=%s", rec.Code, rec.Body.String())
		}
		return rec.Body.String()
	}
	if first := send(); strings.Contains(first, "waiting_limit") {
		t.Fatal("an admitted send said it was waiting")
	}
	second := send()
	phase := strings.Index(second, `"phase":"waiting_limit"`)
	if phase < 0 || phase > strings.Index(second, `"type":"done"`) || strings.Contains(second, `"type":"error"`) || turns != 2 {
		t.Fatalf("limited send: turns %d stream %s, want the waiting_limit phase and then the turn", turns, second)
	}
}
