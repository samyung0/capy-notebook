// Command reconcile enqueues and drains the daily storage and Stripe jobs.
package main

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/evonotes/server/internal/reconcile"
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

	runner := reconcile.NewRunner(st, reconcile.Config{
		StripeSecretKey: stripeKey,
		StripePricePro:  pricePro,
	})
	if err := runner.EnqueueDaily(ctx, time.Now()); err != nil {
		log.Fatalf("enqueue reconciliation: %v", err)
	}
	if err := runner.Drain(ctx); err != nil {
		log.Fatalf("run reconciliation: %v", err)
	}
	log.Println("reconciliation queue drained")
}
