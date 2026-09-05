package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/evonotes/server/internal/store"
	"github.com/redis/go-redis/v9"
)

const collaborationEvictionLease = 30 * time.Second
const collaborationEvictionDeliveredChannel = "evo:collaboration:eviction-delivered"
const collaborationInstanceRegistry = "evo:collaboration:instances"

type collaborationEvictionAck struct {
	EvictionID string `json:"evictionId"`
	InstanceID string `json:"instanceId"`
	OK         bool   `json:"ok"`
}

func consumeCollaborationEvictionAck(
	payload string,
	evictionID string,
	expected map[string]struct{},
) (bool, error) {
	var ack collaborationEvictionAck
	if json.Unmarshal([]byte(payload), &ack) != nil ||
		ack.EvictionID != evictionID {
		return false, nil
	}
	if _, waiting := expected[ack.InstanceID]; !waiting {
		return false, nil
	}
	if !ack.OK {
		return false, fmt.Errorf(
			"collaboration instance %s rejected eviction delivery",
			ack.InstanceID,
		)
	}
	delete(expected, ack.InstanceID)
	return len(expected) == 0, nil
}

func activeCollaborationInstances(
	ctx context.Context,
	rdb *redis.Client,
) (map[string]struct{}, error) {
	entries, err := rdb.HGetAll(ctx, collaborationInstanceRegistry).Result()
	if err != nil {
		return nil, err
	}
	cutoff := time.Now().Add(-time.Minute).UnixMilli()
	active := make(map[string]struct{}, len(entries))
	for id, timestamp := range entries {
		heartbeat, err := strconv.ParseInt(timestamp, 10, 64)
		if err == nil && heartbeat >= cutoff {
			active[id] = struct{}{}
		}
	}
	return active, nil
}

func publishCollaborationEviction(
	ctx context.Context,
	rdb *redis.Client,
	acks *redis.PubSub,
	item store.CollaborationEviction,
) error {
	expected, err := activeCollaborationInstances(ctx, rdb)
	if err != nil {
		return err
	}
	if len(expected) == 0 {
		return errors.New("no active collaboration instances")
	}
	subscribers, err := rdb.Publish(ctx, item.Channel, item.Payload).Result()
	if err != nil {
		return err
	}
	if subscribers == 0 {
		return errors.New("collaboration eviction had no subscribers")
	}
	ackCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		message, err := acks.ReceiveMessage(ackCtx)
		if err != nil {
			return err
		}
		done, err := consumeCollaborationEvictionAck(
			message.Payload, item.ID, expected,
		)
		if err != nil {
			return err
		}
		if done {
			return nil
		}
	}
}

func runCollaborationEvictionWorker(
	ctx context.Context,
	s *store.Store,
	rdb *redis.Client,
) {
	if rdb == nil {
		return
	}
	acks := rdb.Subscribe(ctx, collaborationEvictionDeliveredChannel)
	defer acks.Close()
	if _, err := acks.Receive(ctx); err != nil {
		if ctx.Err() == nil {
			log.Printf("subscribe collaboration eviction acknowledgements: %v", err)
		}
		return
	}
	deliver := func() {
		for range 100 {
			items, err := s.ClaimCollaborationEvictions(
				ctx, 1, collaborationEvictionLease,
			)
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("claim collaboration evictions: %v", err)
				}
				return
			}
			if len(items) == 0 {
				return
			}
			item := items[0]
			err = publishCollaborationEviction(ctx, rdb, acks, item)
			if err != nil {
				delay := time.Duration(1<<min(item.Attempts, 6)) * time.Second
				if retryErr := s.RetryCollaborationEviction(
					ctx, item.ID, item.LeaseID, err.Error(), delay,
				); retryErr != nil && ctx.Err() == nil {
					log.Printf("release collaboration eviction %s: %v", item.ID, retryErr)
				}
				return
			}
			if err := s.CompleteCollaborationEviction(
				ctx, item.ID, item.LeaseID,
			); err != nil && ctx.Err() == nil {
				log.Printf("complete collaboration eviction %s: %v", item.ID, err)
			}
		}
	}

	deliver()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			deliver()
		case <-ctx.Done():
			return
		}
	}
}
