package main

import (
	"context"
	"log"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Trashed files and materials expire 30 days after the trash transition. The
// sweep performs the logical SQL DELETE under the same locks as an owner purge;
// bucket objects follow through pending_blob_deletions and the blob reaper,
// exactly like a manual delete. Same cadence as the other maintenance loops.
const (
	trashSweepBatch    = 100
	trashSweepInterval = time.Minute
)

func runTrashSweep(ctx context.Context, st *store.Store) {
	sweep := func() {
		purged, err := st.SweepDueTrash(ctx, trashSweepBatch)
		if err != nil && ctx.Err() == nil {
			log.Printf("sweep due trash: %v", err)
		}
		if purged > 0 {
			log.Printf("purged %d expired trash item(s)", purged)
		}
	}
	sweep()
	ticker := time.NewTicker(trashSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			sweep()
		case <-ctx.Done():
			return
		}
	}
}
