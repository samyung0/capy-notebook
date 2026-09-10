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
	// Streams no longer hold a Redis connection each (see fanout.go), so this
	// bounds only what a stream still costs this process: a goroutine, a socket
	// and a 64-slot buffer. The binding constraint is the open-file limit of
	// the container, so raising this past what `ulimit -n` allows just moves
	// the failure from a clean 429 to accept() errors.
	maxNotificationStreams = 10_000
	// One stream per tab, plus headroom for the brief overlap while a client
	// reconnects after the bounded lifetime expires.
	maxNotificationStreamsUser = 6
	notificationStreamLifetime = 30 * time.Minute
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

func (a *api) notificationEvents(w http.ResponseWriter, r *http.Request) {
	userID := uid(r)
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if a.broker == nil {
		http.Error(w, "redis not configured", http.StatusServiceUnavailable)
		return
	}
	if !a.acquireNotificationStream(userID) {
		// Refusal is invisible to the user (the client falls back to polling),
		// so it has to be visible here or the ceiling is reached silently.
		obs.Log(r.Context()).Warn("notification stream refused at capacity",
			"total", a.notificationStreamCount())
		w.Header().Set("Retry-After", "10")
		http.Error(w, "notification stream limit reached", http.StatusTooManyRequests)
		return
	}
	defer a.releaseNotificationStream(userID)

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ctx, cancel := context.WithTimeout(r.Context(), notificationStreamLifetime)
	defer cancel()
	sub, err := a.broker.subscribe(ctx, "notif:"+userID)
	if err != nil {
		if ctx.Err() == nil {
			http.Error(w, "notification stream unavailable", http.StatusServiceUnavailable)
		}
		return
	}
	defer a.broker.unsubscribe(sub)

	if _, err := fmt.Fprint(w, ": connected\n\n"); err != nil {
		return
	}
	flusher.Flush()

	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-sub.dropped:
			// Evicted for falling behind. The client reconnects, and its
			// reconcile-on-connect refetches whatever it missed from Postgres.
			return
		case payload, ok := <-sub.events:
			if !ok {
				return
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
				return
			}
			flusher.Flush()
		case <-ping.C:
			allowed, _, err := a.s.AccountSessionAllowed(ctx, userID)
			if err != nil || !allowed {
				return
			}
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (a *api) acquireNotificationStream(userID string) bool {
	a.notifMu.Lock()
	defer a.notifMu.Unlock()
	if a.notifTotal >= maxNotificationStreams ||
		a.notifByUser[userID] >= maxNotificationStreamsUser {
		return false
	}
	a.notifByUser[userID]++
	a.notifTotal++
	return true
}

func (a *api) notificationStreamCount() int {
	a.notifMu.Lock()
	defer a.notifMu.Unlock()
	return a.notifTotal
}

func (a *api) releaseNotificationStream(userID string) {
	a.notifMu.Lock()
	defer a.notifMu.Unlock()
	if a.notifByUser[userID] > 1 {
		a.notifByUser[userID]--
	} else {
		delete(a.notifByUser, userID)
	}
	if a.notifTotal > 0 {
		a.notifTotal--
	}
}
