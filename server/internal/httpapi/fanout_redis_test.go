package httpapi

import (
	"context"
	"errors"
	"net"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// One PSUBSCRIBE must route by channel name to the right streams, and must hold
// exactly one Redis connection no matter how many streams are open.
func TestFanoutRoutesByChannelOnOneConnection(t *testing.T) {
	url := os.Getenv("CAPY_GO_TEST_REDIS_URL")
	if url == "" {
		t.Skip("no disposable Redis; run `pnpm test:go` from the repository root")
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(opt)
	defer rdb.Close()
	ctx := context.Background()
	if err := rdb.Ping(ctx).Err(); err != nil {
		t.Fatal(err)
	}

	broker := newChannelBroker(rdb, "ingest:*", "notif:*")
	ws1, err := broker.subscribe(ctx, "ingest:ws_1")
	if err != nil {
		t.Fatal(err)
	}
	ws2, err := broker.subscribe(ctx, "ingest:ws_2")
	if err != nil {
		t.Fatal(err)
	}
	user, err := broker.subscribe(ctx, "notif:u_1")
	if err != nil {
		t.Fatal(err)
	}

	rdb.Publish(ctx, "ingest:ws_1", `{"fileId":"f_1"}`)
	rdb.Publish(ctx, "notif:u_1", `{"type":"created"}`)

	want := func(name string, sub *subscription, payload string) {
		t.Helper()
		select {
		case got := <-sub.events:
			if got != payload {
				t.Fatalf("%s got %q, want %q", name, got, payload)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("%s received nothing", name)
		}
	}
	want("ws_1", ws1, `{"fileId":"f_1"}`)
	want("u_1", user, `{"type":"created"}`)

	// A message for another workspace must not reach this one.
	select {
	case got := <-ws2.events:
		t.Fatalf("ws_2 received a message meant for another channel: %q", got)
	case <-time.After(300 * time.Millisecond):
	}

	// Redis itself must see one pattern subscriber, not one per stream. Adding
	// many more streams must not add a single connection.
	patterns, err := rdb.Do(ctx, "pubsub", "numpat").Int()
	if err != nil {
		t.Fatal(err)
	}
	if patterns != 2 {
		t.Fatalf("pattern subscriptions = %d, want 2", patterns)
	}
	before := connectedClients(t, rdb, ctx)
	for i := 0; i < 200; i++ {
		if _, err := broker.subscribe(ctx, "notif:bulk"); err != nil {
			t.Fatal(err)
		}
	}
	after := connectedClients(t, rdb, ctx)
	t.Logf("connected_clients before=%d after 200 more streams=%d", before, after)
	if after != before {
		t.Fatalf("connections grew from %d to %d across 200 streams", before, after)
	}
}

func connectedClients(t *testing.T, rdb *redis.Client, ctx context.Context) int {
	t.Helper()
	info, err := rdb.Info(ctx, "clients").Result()
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(info, "\n") {
		if strings.HasPrefix(line, "connected_clients:") {
			n, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "connected_clients:")))
			if err != nil {
				t.Fatal(err)
			}
			return n
		}
	}
	t.Fatal("connected_clients missing from INFO")
	return 0
}

func TestFanoutRecoversAfterInitialSubscribeFailure(t *testing.T) {
	url := os.Getenv("CAPY_GO_TEST_REDIS_URL")
	if url == "" {
		t.Skip("no disposable Redis; run `pnpm test:go` from the repository root")
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	var unavailable atomic.Bool
	unavailable.Store(true)
	opt.Dialer = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if unavailable.Load() {
			return nil, errors.New("Redis initially unavailable")
		}
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	}
	rdb := redis.NewClient(opt)
	defer rdb.Close()
	broker := newChannelBroker(rdb, "ingest:*", "notif:*")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := broker.subscribe(ctx, "ingest:ws_recovery"); err == nil {
		t.Fatal("first subscription unexpectedly succeeded")
	}
	unavailable.Store(false)
	sub, err := broker.subscribe(ctx, "ingest:ws_recovery")
	if err != nil {
		t.Fatalf("subscription after Redis recovery: %v", err)
	}
	defer broker.unsubscribe(sub)
	if err := rdb.Publish(ctx, "ingest:ws_recovery", "ready").Err(); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-sub.events:
		if got != "ready" {
			t.Fatalf("received %q, want ready", got)
		}
	case <-ctx.Done():
		t.Fatal("no event after Redis recovery")
	}
}
