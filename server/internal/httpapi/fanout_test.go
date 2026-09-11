package httpapi

import (
	"context"
	"testing"
	"time"
)

// The whole point of sharing one Redis subscription is that a single goroutine
// now feeds every stream. If it ever waited on a client that stopped reading,
// every other client's events would queue behind that one socket. A stream that
// falls behind is evicted instead; ending its response is the recovery, because
// the client reconnects and reconciles.
func TestFanoutEvictsSlowStreamAndKeepsDeliveringToOthers(t *testing.T) {
	broker := newChannelBroker(nil, "notif:*")
	ctx := context.Background()
	const channel = "notif:u_1"
	slow, _ := broker.register(ctx, channel)
	fast, _ := broker.register(ctx, channel)

	// Neither stream reads, so both buffers fill to the brim.
	for i := 0; i < streamBuffer; i++ {
		broker.deliver(ctx, channel, "burst")
	}
	// The attentive stream drains; the stalled one stays full.
	for i := 0; i < streamBuffer; i++ {
		<-fast.events
	}

	done := make(chan struct{})
	go func() {
		broker.deliver(ctx, channel, "next")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("deliver blocked on the stalled stream")
	}

	select {
	case <-slow.dropped:
	default:
		t.Fatal("stalled stream was not evicted")
	}
	select {
	case got := <-fast.events:
		if got != "next" {
			t.Fatalf("fast stream got %q, want %q", got, "next")
		}
	default:
		t.Fatal("attentive stream missed the message")
	}

	// The evicted stream is gone from the table, so it costs nothing further.
	broker.mu.Lock()
	remaining := len(broker.subs[channel])
	broker.mu.Unlock()
	if remaining != 1 {
		t.Fatalf("subscribers after eviction = %d, want 1", remaining)
	}
}

// A reader that stops must not leave handlers parked on a channel nothing will
// write to again.
func TestFanoutShutdownEndsEveryStream(t *testing.T) {
	broker := newChannelBroker(nil, "ingest:*")
	ctx := context.Background()
	a, _ := broker.register(ctx, "ingest:ws_1")
	b, _ := broker.register(ctx, "ingest:ws_2")

	broker.shutdown()

	for name, sub := range map[string]*subscription{"ws_1": a, "ws_2": b} {
		select {
		case <-sub.dropped:
		default:
			t.Fatalf("%s stream still waiting after shutdown", name)
		}
	}
	if len(broker.subs) != 0 {
		t.Fatalf("subs after shutdown = %d, want 0", len(broker.subs))
	}
}

// A lost Postgres LISTEN ends only the tree streams; notification and ingest
// streams fed by Redis stay attached.
func TestFanoutEvictPrefixLeavesOtherChannelsAttached(t *testing.T) {
	broker := newChannelBroker(nil, "notif:*")
	ctx := context.Background()
	tree, _ := broker.register(ctx, "tree:ws_1")
	notif, _ := broker.register(ctx, "notif:u_1")

	broker.evictPrefix("tree:")

	select {
	case <-tree.dropped:
	default:
		t.Fatal("tree stream was not evicted")
	}
	select {
	case <-notif.dropped:
		t.Fatal("notification stream was evicted")
	default:
	}
	broker.deliver(ctx, "notif:u_1", "still here")
	if got := <-notif.events; got != "still here" {
		t.Fatalf("notification stream got %q", got)
	}
}
