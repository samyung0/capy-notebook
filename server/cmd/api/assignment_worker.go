package main

import (
	"context"
	"log"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A closed tab cannot submit, so the server does it: attempts past their time
// submit what they saved, a paper so submitted starts its read
// (store.OnPaperHandedIn), and a closed assignment's quiz shows as practice.
const (
	assignmentSweepBatch    = 200
	assignmentSweepInterval = time.Minute
)

func runAssignmentSweep(ctx context.Context, st *store.Store, rdb *redis.Client) {
	sweep := func() {
		finished, released, err := st.SweepAssignments(ctx, assignmentSweepBatch, time.Now())
		if err != nil && ctx.Err() == nil {
			log.Printf("sweep assignments: %v", err)
		}
		if len(finished) > 0 || released > 0 {
			log.Printf("assignments: submitted %d attempt(s), released %d quiz(zes) as practice", len(finished), released)
		}
		publishSweptTodo(ctx, st, rdb, finished)
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

// publishSweptTodo tells the class's staff, whose answers to approve may have
// grown, and each member submitted for to refetch To do (Epo 2026-11-08), as
// httpapi's publishTodo does for a submit. Best effort.
func publishSweptTodo(ctx context.Context, st *store.Store, rdb *redis.Client, swept []store.SweptAttempt) {
	if rdb == nil || len(swept) == 0 {
		return
	}
	users := map[string]bool{}
	staffOf := map[string][]string{}
	for _, t := range swept {
		staff, read := staffOf[t.AssignmentID]
		if !read {
			_, s, err := st.TodoAudience(ctx, t.AssignmentID)
			if err != nil {
				log.Printf("sweep: to do audience of %s: %v", t.AssignmentID, err)
			}
			staff = s
			staffOf[t.AssignmentID] = s
		}
		users[t.UserID] = true
		for _, u := range staff {
			users[u] = true
		}
	}
	for user := range users {
		_ = rdb.Publish(ctx, "notif:"+user, `{"type":"todo"}`).Err()
	}
}
