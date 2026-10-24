package main

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/samyung0/capy-notebook/server/internal/obs"
)

// poolWaitInterval is the window over which waits for a pooled connection are
// summed into one log line.
const poolWaitInterval = 10 * time.Second

// runPoolWaitLog logs, per window, the acquires that found no idle connection
// and how long they waited, so a pool too small for the load shows in the logs
// rather than only as request latency at low CPU.
func runPoolWaitLog(ctx context.Context, pool *pgxpool.Pool) {
	var lastWaits int64
	var lastWait time.Duration
	go loop(ctx, poolWaitInterval, "db_pool", func(ctx context.Context) {
		s := pool.Stat()
		waits, wait := s.EmptyAcquireCount(), s.EmptyAcquireWaitTime()
		if waits > lastWaits {
			obs.Log(ctx).Info("db pool waits",
				"waits", waits-lastWaits,
				"wait_ms", (wait - lastWait).Milliseconds(),
				"acquired", s.AcquiredConns(),
				"max", s.MaxConns())
		}
		lastWaits, lastWait = waits, wait
	})
}
