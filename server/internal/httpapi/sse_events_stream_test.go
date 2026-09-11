package httpapi_test

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// One stream carries the user's notifications from Redis and the workspace's
// tree changes from Postgres, each named in the SSE event field.
func TestEventStreamCarriesNotificationsAndTreeChanges(t *testing.T) {
	redisURL := os.Getenv("CAPY_GO_TEST_REDIS_URL")
	if redisURL == "" {
		t.Skip("no disposable Redis; run `pnpm test:go` from the repository root")
	}
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(opt)
	defer rdb.Close()
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	const userID = "u_events"
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id, name, email) VALUES ($1, 'Events', 'events@example.test')
		ON CONFLICT (id) DO NOTHING`, userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID) })
	ws, err := st.CreateWorkspace(ctx, userID, "Events", store.ColorGreen, nil)
	if err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(httpapi.New(st, blob.NewMemory(), nil, rdb, "docling",
		httpapi.Config{AuthDisabled: true, DevUserID: userID}))
	defer srv.Close()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/stream?workspace="+ws.ID, nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	lines := make(chan string, 64)
	go func() {
		scanner := bufio.NewScanner(res.Body)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		close(lines)
	}()
	expect := func(want string) {
		t.Helper()
		deadline := time.After(5 * time.Second)
		for {
			select {
			case line, ok := <-lines:
				if !ok {
					t.Fatalf("stream ended before %q", want)
				}
				if strings.Contains(line, want) {
					return
				}
			case <-deadline:
				t.Fatalf("no line containing %q", want)
			}
		}
	}
	expect(": connected")

	// The tree listener attaches in the background; keep writing until it
	// relays the first insert.
	deadline := time.Now().Add(5 * time.Second)
	for attached := false; !attached; {
		if _, err := st.CreateSourceReady(ctx, ws.ID, userID, "notes.md", "md", nil, "", 10, "sources/"+ws.ID+"/notes.md"); err != nil {
			t.Fatal(err)
		}
		select {
		case line := <-lines:
			attached = line == "event: tree"
		case <-time.After(200 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			t.Fatal("no tree event")
		}
	}
	expect(`data: {"kind":"files"}`)

	rdb.Publish(ctx, "notif:"+userID, `{"type":"created"}`)
	expect("event: notification")
	expect(`data: {"type":"created"}`)
}
