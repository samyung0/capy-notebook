package main

import (
	"context"
	"log"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/integrations"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// runAccountPurgeWorker retries session revocation for deletion-pending users,
// then permanently destroys accounts whose purge_after has elapsed. Content
// deletion and PII scrub run in PurgeUser; Clerk identity deletion happens
// afterwards so a crash mid-purge leaves a row the next tick can finish.
func runAccountPurgeWorker(ctx context.Context, st *store.Store, clerkEnabled bool) {
	tick := func() {
		if clerkEnabled {
			ids, err := st.ClaimUsersDueForSessionRevocation(ctx, 10)
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("session revocation claim: %v", err)
				}
			} else {
				for _, id := range ids {
					if err := integrations.RevokeUserSessions(ctx, id); err != nil {
						log.Printf("revoke Clerk sessions %s: %v", id, err)
						if retryErr := st.RetrySessionRevocation(ctx, id, err); retryErr != nil {
							log.Printf("schedule session revocation retry %s: %v", id, retryErr)
						}
						continue
					}
					if err := st.MarkSessionRevocationComplete(ctx, id); err != nil {
						log.Printf("finish session revocation %s: %v", id, err)
					}
				}
			}
		}
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
					log.Printf("purge clerk identity %s: %v", id, err)
					if retryErr := st.RetryIdentityDeletion(ctx, id); retryErr != nil {
						log.Printf("schedule clerk identity retry %s: %v", id, retryErr)
					}
					continue
				}
			}
			if err := st.MarkIdentityDeletionComplete(ctx, id); err != nil {
				log.Printf("finish identity deletion %s: %v", id, err)
				continue
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
