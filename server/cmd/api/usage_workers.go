package main

import (
	"context"
	"time"

	"github.com/evonotes/server/internal/obs"
	"github.com/evonotes/server/internal/store"
)

const (
	// Reservations expire after 30 minutes, so sweeping every minute bounds how
	// long a crashed request's hold sits on a user's budget.
	reservationSweepInterval = time.Minute
	// The rollup only feeds the operator dashboard, which nobody watches
	// second by second.
	usageRollupInterval = 5 * time.Minute
	// Reconciliation is a repair pass, not a hot path; it rewrites every
	// current-period counter from the ledger.
	creditReconcileInterval = 6 * time.Hour
)

// runUsageWorkers keeps the credit ledger honest. Each pass is independent and
// idempotent, so a failure is retried on the next tick rather than escalated.
//
// Running these in-process alongside the API is a deliberate simplification for
// the current single-replica deployment. With several replicas they would each
// run on every one; the sweeps are idempotent so the result stays correct, but
// the work is wasted and should move behind a leader lock before scaling out.
func runUsageWorkers(ctx context.Context, st *store.Store) {
	go loop(ctx, reservationSweepInterval, "credit_sweeper", func(ctx context.Context) {
		released, err := st.SweepExpiredReservations(ctx)
		if err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"stage": "reservation_sweep"})
			return
		}
		if released > 0 {
			obs.Log(ctx).Info("released expired credit reservations", "count", released)
		}
	})

	go loop(ctx, usageRollupInterval, "usage_rollup", func(ctx context.Context) {
		rows, err := st.RollupUsage(ctx)
		if err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"stage": "usage_rollup"})
			return
		}
		if rows > 0 {
			obs.Log(ctx).Info("rolled up usage", "rows", rows)
		}
	})

	go loop(ctx, creditReconcileInterval, "credit_reconcile", func(ctx context.Context) {
		repaired, err := st.ReconcileCredits(ctx)
		if err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"stage": "credit_reconcile"})
			return
		}
		obs.Log(ctx).Info("reconciled credit counters", "users", repaired)
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
