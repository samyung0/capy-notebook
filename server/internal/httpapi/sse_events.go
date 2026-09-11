package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

const (
	// Streams do not hold a Redis connection each (see fanout.go), so this
	// bounds only what a stream still costs this process: a goroutine, a socket
	// and three 64-slot buffers. The binding constraint is the open-file limit
	// of the container, so raising this past what `ulimit -n` allows just moves
	// the failure from a clean 429 to accept() errors.
	maxEventStreams = 10_000
	// One stream per tab, plus headroom for the brief overlap while a client
	// reconnects after the bounded lifetime expires.
	maxEventStreamsUser = 7
	eventStreamLifetime = 30 * time.Minute
)

type notificationEvent struct {
	Type         string              `json:"type"`
	Notification *store.Notification `json:"notification,omitempty"`
	IDs          []string            `json:"ids,omitempty"`
}

func (a *api) publishNotificationEvent(ctx context.Context, userID string, event notificationEvent) {
	if a.rdb == nil || userID == "" {
		return
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}
	_ = a.rdb.Publish(ctx, "notif:"+userID, payload).Err()
}

func (a *api) publishNotificationRemovals(ctx context.Context, removals []store.NotificationRemoval) {
	byUser := make(map[string][]string)
	for _, removal := range removals {
		if removal.UserID == "" || removal.ID == "" {
			continue
		}
		byUser[removal.UserID] = append(byUser[removal.UserID], removal.ID)
	}
	for userID, ids := range byUser {
		a.publishNotificationEvent(ctx, userID, notificationEvent{
			Type: "removed",
			IDs:  ids,
		})
	}
}

// stream is the one SSE stream a signed-in tab holds open. It always carries
// the user's notifications (`notif:{userId}`, published by this gateway and
// the Python worker). With `?workspace=` it also carries that workspace's
// ingest progress (`ingest:{workspaceId}`, published by the worker) and tree
// changes (`tree:{workspaceId}`, raised by the Postgres triggers in migration
// 0004 and relayed by listenWorkspaceTree). Each event names its source in
// the SSE `event:` field. Nothing here is durable: the browser refetches the
// affected lists on every connect, so a workspace stream is refused while
// the tree LISTEN is detached rather than opened over a silent feed.
func (a *api) stream(w http.ResponseWriter, r *http.Request) {
	userID := uid(r)
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if a.broker == nil {
		http.Error(w, "redis not configured", http.StatusServiceUnavailable)
		return
	}
	wsID := r.URL.Query().Get("workspace")
	if wsID != "" {
		if !a.assertWSRead(w, r, wsID) {
			return
		}
		if !a.treeLive.Load() {
			http.Error(w, "event stream unavailable", http.StatusServiceUnavailable)
			return
		}
	}
	if !a.acquireEventStream(userID) {
		// Refusal is invisible to the user (the banner just shows reconnecting),
		// so it has to be visible here or the ceiling is reached silently.
		obs.Log(r.Context()).Warn("event stream refused at capacity",
			"total", a.eventStreamCount())
		w.Header().Set("Retry-After", "10")
		http.Error(w, "event stream limit reached", http.StatusTooManyRequests)
		return
	}
	defer a.releaseEventStream(userID)

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), eventStreamLifetime)
	defer cancel()
	open := func(channel string) *subscription {
		sub, err := a.broker.subscribe(ctx, channel)
		if err != nil && ctx.Err() == nil {
			http.Error(w, "event stream unavailable", http.StatusServiceUnavailable)
		}
		return sub
	}
	notif := open("notif:" + userID)
	if notif == nil {
		return
	}
	defer a.broker.unsubscribe(notif)
	// Nil subscriptions leave nil channels, which a select never picks.
	var ingest, tree *subscription
	if wsID != "" {
		if ingest = open("ingest:" + wsID); ingest == nil {
			return
		}
		defer a.broker.unsubscribe(ingest)
		if tree = open("tree:" + wsID); tree == nil {
			return
		}
		defer a.broker.unsubscribe(tree)
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable proxy buffering (nginx)
	if _, err := fmt.Fprint(w, ": connected\n\n"); err != nil {
		return
	}
	flusher.Flush()

	// Keep-alive comments so idle connections aren't dropped by proxies.
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	write := func(event, payload string) bool {
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	for {
		select {
		case <-ctx.Done():
			return
		// Evicted for falling behind on any channel. Ending the response is
		// the recovery: the client reconnects and refetches every list.
		case <-notif.dropped:
			return
		case <-ingest.droppedOrNil():
			return
		case <-tree.droppedOrNil():
			return
		case payload, ok := <-notif.events:
			if !ok || !write("notification", payload) {
				return
			}
		case payload, ok := <-ingest.eventsOrNil():
			if !ok || !write("ingest", payload) {
				return
			}
		case payload, ok := <-tree.eventsOrNil():
			if !ok || !write("tree", payload) {
				return
			}
		case <-ping.C:
			// Access is re-checked at the ping cadence: a revoked session or
			// membership ends the stream within 25 s, cheap enough for every
			// idle tab where the LLM streams' 5 s live context is not.
			allowed, _, err := a.s.AccountSessionAllowed(ctx, userID)
			if err != nil || !allowed {
				return
			}
			if wsID != "" {
				if _, err := a.s.WorkspaceAccess(ctx, userID, wsID); err != nil {
					return
				}
			}
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// listenWorkspaceTree relays Postgres tree notifications into the broker for
// the life of the process. A dropped LISTEN loses whatever was raised while
// unattached, so every tree stream is ended and the client refetches, and new
// workspace streams are refused until it is attached again.
func (a *api) listenWorkspaceTree(ctx context.Context) {
	for ctx.Err() == nil {
		err := a.s.ListenWorkspaceTree(ctx, func() { a.treeLive.Store(true) }, func(wsID, kind string) {
			if kind != "files" && kind != "materials" {
				return
			}
			a.broker.deliver(ctx, "tree:"+wsID, `{"kind":"`+kind+`"}`)
		})
		a.treeLive.Store(false)
		if ctx.Err() != nil {
			return
		}
		obs.Log(ctx).Error("workspace tree listener stopped", "error", err)
		a.broker.evictPrefix("tree:")
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
	}
}

func (a *api) acquireEventStream(userID string) bool {
	a.streamMu.Lock()
	defer a.streamMu.Unlock()
	if a.streamTotal >= maxEventStreams ||
		a.streamByUser[userID] >= maxEventStreamsUser {
		return false
	}
	a.streamByUser[userID]++
	a.streamTotal++
	return true
}

func (a *api) eventStreamCount() int {
	a.streamMu.Lock()
	defer a.streamMu.Unlock()
	return a.streamTotal
}

func (a *api) releaseEventStream(userID string) {
	a.streamMu.Lock()
	defer a.streamMu.Unlock()
	if a.streamByUser[userID] > 1 {
		a.streamByUser[userID]--
	} else {
		delete(a.streamByUser, userID)
	}
	if a.streamTotal > 0 {
		a.streamTotal--
	}
}
