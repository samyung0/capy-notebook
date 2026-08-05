// Command reconcile syncs Stripe subscription state with the local database daily.
package main

import (
	"context"
	"log"
	"os"

	"github.com/evonotes/server/internal/billing"
	"github.com/evonotes/server/internal/store"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	dsn := env("DATABASE_URL", "postgres://evo:evo@localhost:5432/evo?sslmode=disable")
	stripeKey := env("STRIPE_SECRET_KEY", "")
	pricePro := env("STRIPE_PRICE_PRO", "")

	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer st.Close()

	repaired, err := st.ReconcileStorage(ctx)
	if err != nil {
		log.Fatalf("storage reconciliation: %v", err)
	}
	log.Printf("storage reconciliation repaired %d user(s)", repaired)

	if stripeKey == "" {
		log.Println("reconcile complete (Stripe disabled)")
		return
	}
	billing.Init(billing.Config{SecretKey: stripeKey})

	rows, err := st.ListStripeCustomers(ctx)
	if err != nil {
		log.Fatalf("list customers: %v", err)
	}

	drifted := 0
	for _, row := range rows {
		sub, err := billing.ListActiveSubscription(row.CustomerID)
		if err != nil {
			log.Printf("customer %s: stripe error: %v", row.CustomerID, err)
			continue
		}
		// Reconcile the subscription table rather than users.plan_tier: the tier
		// column is a projection of it now, so writing the column directly would
		// be undone by the next webhook.
		var live *store.Subscription
		if sub != nil {
			record := billing.SubscriptionRecord(sub, row.UserID, pricePro, 0)
			live = &record
		}
		changed, err := st.SyncSubscriptionsFromStripe(ctx, row.UserID, live)
		if err != nil {
			log.Printf("fix user %s: %v", row.UserID, err)
			continue
		}
		if changed {
			drifted++
			log.Printf("drift repaired user=%s customer=%s", row.UserID, row.CustomerID)
		}
	}
	log.Printf("reconcile complete (%d subscription drift(s) repaired)", drifted)
}
