package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// runIndexCopyWorker copies clones' indexes in the background
// (store.RunIndexCopy): one job at a time per gateway, back to back while
// jobs are due, else polling every second. Progress goes out on the file's
// ingest channel, as the pipeline's does.
func runIndexCopyWorker(ctx context.Context, st *store.Store, rdb *redis.Client) {
	publish := func(event store.IndexCopyEvent) {
		if rdb == nil {
			return
		}
		payload, err := json.Marshal(event)
		if err != nil {
			return
		}
		_ = rdb.Publish(ctx, "ingest:"+event.WorkspaceID, payload).Err()
	}
	for {
		ran, err := st.RunIndexCopy(ctx, publish)
		if err != nil && ctx.Err() == nil {
			log.Printf("index copy: %v", err)
		}
		if ran && err == nil {
			continue
		}
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			return
		}
	}
}
