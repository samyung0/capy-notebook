package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

type notificationRemovalEvent struct {
	Type string   `json:"type"`
	IDs  []string `json:"ids"`
}

func publishNotificationRemovals(
	ctx context.Context,
	rdb *redis.Client,
	removals []store.NotificationRemoval,
) {
	if rdb == nil || len(removals) == 0 {
		return
	}
	byUser := make(map[string][]string)
	for _, removal := range removals {
		if removal.UserID == "" || removal.ID == "" {
			continue
		}
		byUser[removal.UserID] = append(byUser[removal.UserID], removal.ID)
	}
	for userID, ids := range byUser {
		payload, err := json.Marshal(notificationRemovalEvent{
			Type: "removed",
			IDs:  ids,
		})
		if err != nil {
			continue
		}
		_ = rdb.Publish(ctx, "notif:"+userID, payload).Err()
	}
}

type notificationCreatedEvent struct {
	Type         string             `json:"type"`
	Notification store.Notification `json:"notification"`
}

// runSourceBatchWorker pushes the per-upload/import batch notifications the
// database triggers wrote, and closes idle batches. One indexed query a second
// keeps the bell as live as the per-file notifications were.
func runSourceBatchWorker(ctx context.Context, st *store.Store, rdb *redis.Client) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		notifications, err := st.SettleSourceBatches(ctx)
		if err != nil && ctx.Err() == nil {
			log.Printf("settle source batches: %v", err)
		}
		for _, n := range notifications {
			if rdb == nil {
				break
			}
			payload, err := json.Marshal(notificationCreatedEvent{Type: "created", Notification: n})
			if err != nil {
				continue
			}
			_ = rdb.Publish(ctx, "notif:"+n.UserID, payload).Err()
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return
		}
	}
}
