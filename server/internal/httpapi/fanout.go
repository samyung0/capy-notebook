package httpapi

import (
	"context"
	"sync"

	"github.com/redis/go-redis/v9"
	"github.com/samyung0/capy-notebook/server/internal/obs"
)

// Buffered events held per stream before the fanout gives up on it. Deep enough
// to ride out a burst (an ingest job emits progress in bursts) while staying
// small enough that a thousand idle streams cost little.
const streamBuffer = 64

// channelBroker turns one Redis pattern subscription into per-stream delivery
// for every SSE handler in this process.
//
// Subscribing per stream is what forced the low ceiling on concurrent streams:
// go-redis gives every PubSub its own TCP connection (Client.pubSub →
// pubSubPool.NewConn), so N streams held N Redis connections. One PSUBSCRIBE
// plus in-process fanout makes that a constant.
//
// The cost of sharing is that a single goroutine now feeds every stream, so it
// must never block. A client whose buffer fills is evicted instead of waited
// on — see deliver.
type channelBroker struct {
	rdb      *redis.Client
	patterns []string

	mu      sync.Mutex
	subs    map[string]map[*subscription]struct{}
	started bool
	ready   chan struct{} // closed once Redis has confirmed the subscription
	failed  error
}

// subscription is one SSE stream's view of a Redis channel.
type subscription struct {
	broker  *channelBroker
	channel string
	events  chan string
	// dropped closes when the fanout evicted this stream for falling behind.
	// The handler ends the response and the client reconnects.
	dropped chan struct{}
	once    sync.Once
}

func newChannelBroker(rdb *redis.Client, patterns ...string) *channelBroker {
	return &channelBroker{
		rdb:      rdb,
		patterns: patterns,
		subs:     make(map[string]map[*subscription]struct{}),
		ready:    make(chan struct{}),
	}
}

// register adds a stream to the fanout table and starts the shared reader on
// first use. It returns the channel that closes once Redis has confirmed the
// pattern subscription.
func (b *channelBroker) register(ctx context.Context, channel string) (*subscription, chan struct{}) {
	sub := &subscription{
		broker:  b,
		channel: channel,
		events:  make(chan string, streamBuffer),
		dropped: make(chan struct{}),
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.started && b.rdb != nil {
		b.started = true
		go b.run(context.WithoutCancel(ctx))
	}
	if b.subs[channel] == nil {
		b.subs[channel] = make(map[*subscription]struct{})
	}
	b.subs[channel][sub] = struct{}{}
	return sub, b.ready
}

// subscribe registers a stream and blocks until Redis has confirmed the
// pattern subscription, so a caller that returns cannot miss an event
// published after it started listening.
func (b *channelBroker) subscribe(ctx context.Context, channel string) (*subscription, error) {
	sub, ready := b.register(ctx, channel)

	select {
	case <-ready:
		b.mu.Lock()
		err := b.failed
		b.mu.Unlock()
		if err != nil {
			b.unsubscribe(sub)
			return nil, err
		}
		return sub, nil
	case <-ctx.Done():
		b.unsubscribe(sub)
		return nil, ctx.Err()
	}
}

func (b *channelBroker) unsubscribe(sub *subscription) {
	b.mu.Lock()
	defer b.mu.Unlock()
	set := b.subs[sub.channel]
	if set == nil {
		return
	}
	delete(set, sub)
	if len(set) == 0 {
		delete(b.subs, sub.channel)
	}
}

// deliver fans one message out. Sends are non-blocking: the shared reader must
// never wait on a stream whose client has stopped reading, because every other
// stream is queued behind it.
func (b *channelBroker) deliver(ctx context.Context, channel, payload string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for sub := range b.subs[channel] {
		select {
		case sub.events <- payload:
		default:
			sub.evict()
			delete(b.subs[channel], sub)
			obs.Log(ctx).Warn("sse stream evicted for falling behind",
				"channel", channel)
		}
	}
	if len(b.subs[channel]) == 0 {
		delete(b.subs, channel)
	}
}

func (s *subscription) evict() {
	s.once.Do(func() { close(s.dropped) })
}

func (b *channelBroker) run(ctx context.Context) {
	pubsub := b.rdb.PSubscribe(ctx, b.patterns...)
	defer pubsub.Close()
	// Receive waits for Redis to confirm the patterns; only then can a
	// subscriber trust that it will see what is published next.
	if _, err := pubsub.Receive(ctx); err != nil {
		b.mu.Lock()
		b.failed = err
		b.started = false
		close(b.ready)
		b.ready = make(chan struct{})
		b.mu.Unlock()
		obs.Log(ctx).Error("sse fanout could not subscribe", "error", err)
		return
	}
	b.mu.Lock()
	b.failed = nil
	close(b.ready)
	b.mu.Unlock()

	// Channel() resubscribes on its own across connection drops.
	ch := pubsub.Channel()
	defer b.shutdown()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			b.deliver(ctx, msg.Channel, msg.Payload)
		}
	}
}

// shutdown ends every stream when the reader stops, so no handler waits on a
// channel nothing will ever write to again. Clients reconnect, which restarts
// the reader.
func (b *channelBroker) shutdown() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for channel, set := range b.subs {
		for sub := range set {
			sub.evict()
		}
		delete(b.subs, channel)
	}
	b.started = false
	b.ready = make(chan struct{})
	b.failed = nil
}
