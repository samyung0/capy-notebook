package main

import (
	"context"
	"time"

	"github.com/evonotes/server/internal/obs"
	"github.com/evonotes/server/internal/reconcile"
	"github.com/evonotes/server/internal/store"
)

const (
	// Reservations expire after 30 minutes, so sweeping every minute bounds how
	// long a crashed request's hold sits on a user's budget.
	reservationSweepInterval = time.Minute
	// Manual reconciliation should start promptly. Scheduled enqueue is
	// idempotent, so the same loop can also ensure today's runs exist.
	reconciliationPollInterval = 5 * time.Second
)

// runUsageWorkers releases dead leases and drains the reconciliation queue.
//
// Running these in-process alongside the API is a deliberate simplification.
// Reconciliation claims are replica-safe; the sweep is idempotent but still
// duplicated across replicas.
func runUsageWorkers(
	ctx context.Context,
	st *store.Store,
	reconcileConfig reconcile.Config,
) {
	go loop(ctx, reservationSweepInterval, "credit_sweeper", func(ctx context.Context) {
		released, err := st.SweepExpiredReservations(ctx)
		if err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"stage": "reservation_sweep"})
			return
		}
		if released > 0 {
			obs.Log(ctx).Info("released expired provider sessions", "count", released)
		}
	})

	runner := reconcile.NewRunner(st, reconcileConfig)
	go loop(ctx, reconciliationPollInterval, "reconciliation", func(ctx context.Context) {
		if err := runner.EnqueueDaily(ctx, time.Now()); err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"stage": "reconciliation_enqueue"})
			return
		}
		if err := runner.Drain(ctx); err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"stage": "reconciliation_run"})
		}
	})
}

// loop runs fn immediately and then on every tick, giving each pass its own
// trace so its log lines and any error it reports can be grouped.
func loop(ctx context.Context, every time.Duration, component string, fn func(context.Context)) {
	run := func() {
		if ctx.Err() != nil {
			return
		}
		fn(obs.Background(ctx, component))
	}
	run()
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			run()
		case <-ctx.Done():
			return
		}
	}
}
