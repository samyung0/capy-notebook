package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"github.com/evonotes/server/internal/store"
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
