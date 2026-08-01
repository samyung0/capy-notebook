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

	for _, row := range rows {
		sub, err := billing.ListActiveSubscription(row.CustomerID)
		wantStatus := "none"
		wantTier := "free"
		if err != nil {
			log.Printf("customer %s: stripe error: %v", row.CustomerID, err)
			continue
		}
		if sub != nil {
			wantStatus = billing.SubscriptionStatus(sub.Status)
			if len(sub.Items.Data) > 0 && sub.Items.Data[0].Price != nil {
				wantTier = billing.PlanTierFromPrice(sub.Items.Data[0].Price.ID, pricePro)
			}
		}
		if row.Status != wantStatus || row.PlanTier != wantTier {
			log.Printf("drift user=%s customer=%s db=%s/%s stripe=%s/%s",
				row.UserID, row.CustomerID, row.Status, row.PlanTier, wantStatus, wantTier)
			if err := st.UpdateSubscription(ctx, row.UserID, wantStatus, wantTier); err != nil {
				log.Printf("fix user %s: %v", row.UserID, err)
			}
		}
	}

	// reconcile complete
	log.Println("reconcile complete")
}
