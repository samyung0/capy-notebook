package main

import (
	"context"
	"log"
	"time"

	"github.com/evonotes/server/internal/integrations"
	"github.com/evonotes/server/internal/store"
)

// runAccountPurgeWorker permanently destroys accounts whose purge_after has
// elapsed. Content deletion and PII scrub run in PurgeUser; Clerk identity
// deletion happens afterwards so a crash mid-purge leaves a row the next tick
// can finish, rather than an orphaned Clerk user with no local account.
func runAccountPurgeWorker(ctx context.Context, st *store.Store, clerkEnabled bool) {
	tick := func() {
		ids, err := st.ClaimUsersDueForPurge(ctx, 10)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("purge claim: %v", err)
			}
			return
		}
		for _, id := range ids {
			if err := st.PurgeUser(ctx, id); err != nil {
				if ctx.Err() == nil {
					log.Printf("purge user %s: %v", id, err)
				}
				continue
			}
			if clerkEnabled {
				if err := integrations.DeleteIdentity(ctx, id); err != nil {
					// Local tombstone is already committed. A failed Clerk
					// delete is retried on the next user.deleted webhook (no-op)
					// or by ops; do not undo the scrub.
					log.Printf("purge clerk identity %s: %v", id, err)
				}
			}
			log.Printf("purged account %s", id)
		}
	}
	tick()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			tick()
		case <-ctx.Done():
			return
		}
	}
}

// runOverQuotaNoticeWorker sends the lapse / T-7 / T-3 / frozen reminders.
func runOverQuotaNoticeWorker(ctx context.Context, st *store.Store) {
	tick := func() {
		n, err := st.SweepOverQuotaNotices(ctx)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("over-quota notices: %v", err)
			}
			return
		}
		if n > 0 {
			log.Printf("sent %d over-quota lifecycle notice(s)", n)
		}
	}
	tick()
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			tick()
		case <-ctx.Done():
			return
		}
	}
}
