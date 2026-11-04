package main

import (
	"context"
	"log"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A closed tab cannot submit, so the server does it: attempts past their time
// submit what they saved, and a closed assignment's quiz shows as practice.
const (
	assignmentSweepBatch    = 200
	assignmentSweepInterval = time.Minute
)

func runAssignmentSweep(ctx context.Context, st *store.Store) {
	sweep := func() {
		finished, released, err := st.SweepAssignments(ctx, assignmentSweepBatch, time.Now())
		if err != nil && ctx.Err() == nil {
			log.Printf("sweep assignments: %v", err)
		}
		if finished > 0 || released > 0 {
			log.Printf("assignments: submitted %d attempt(s), released %d quiz(zes) as practice", finished, released)
		}
	}
	sweep()
	ticker := time.NewTicker(assignmentSweepInterval)
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
