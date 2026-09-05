package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

const (
	maxNotificationStreams = 100
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
	if a.rdb == nil {
		http.Error(w, "redis not configured", http.StatusServiceUnavailable)
		return
	}
	if !a.acquireNotificationStream(userID) {
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
	sub := a.rdb.Subscribe(ctx, "notif:"+userID)
	defer sub.Close()
	if _, err := sub.Receive(ctx); err != nil {
		if ctx.Err() == nil {
			http.Error(w, "notification stream unavailable", http.StatusServiceUnavailable)
		}
		return
	}
	ch := sub.Channel()

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
		case msg, ok := <-ch:
			if !ok {
				return
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", msg.Payload); err != nil {
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
