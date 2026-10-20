package httpapi

import (
	"context"
	"errors"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/stripe/stripe-go/v82"

	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/billing"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// fakeCheckouts stands in for Stripe's Checkout Sessions.
type fakeCheckouts struct {
	sessions map[string]billing.CheckoutSession
	created  int
	expired  []string
}

func (f *fakeCheckouts) wire(a *api) {
	a.stripeEntitlements = func(string) ([]*stripe.Subscription, error) { return nil, nil }
	a.stripeNewCheckout = func(_, _, _, _, _, reservationID, _ string) (billing.CheckoutSession, error) {
		f.created++
		s := billing.CheckoutSession{
			ID:     "cs_" + reservationID,
			URL:    "https://checkout.stripe.test/" + reservationID,
			Status: "open",
		}
		f.sessions[s.ID] = s
		return s, nil
	}
	a.stripeGetCheckout = func(id string) (billing.CheckoutSession, error) {
		return f.sessions[id], nil
	}
	a.stripeExpireCheckout = func(id string) error {
		f.expired = append(f.expired, id)
		s := f.sessions[id]
		s.Status = "expired"
		f.sessions[id] = s
		return nil
	}
}

func checkoutTestAPI(t *testing.T) (*api, *fakeCheckouts, context.Context) {
	t.Helper()
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	userID := randID("u_checkout")
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id,name,email,stripe_customer_id)
		VALUES ($1,'Checkout Test',$2,$3)`, userID, userID+"@example.test", "cus_"+userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})
	a := &api{s: st, cfg: Config{StripePricePro: "price_pro", AppURL: "https://app.test"}}
	f := &fakeCheckouts{sessions: map[string]billing.CheckoutSession{}}
	f.wire(a)
	return a, f, auth.WithUserID(ctx, userID)
}

func subscribe(a *api, ctx context.Context) (string, error) {
	out, err := a.billingCheckout(ctx, &billingCheckoutInput{Body: apimodel.BillingCheckoutReq{PlanTier: "pro"}})
	if err != nil {
		return "", err
	}
	return out.Body.URL, nil
}

func conflictCode(err error) string {
	var model *huma.ErrorModel
	if errors.As(err, &model) && len(model.Errors) > 0 {
		return model.Errors[0].Message
	}
	return ""
}

// Epo 2026-10-21: going back from Stripe and pressing Subscribe again opens
// the same Checkout page instead of answering subscription_exists.
func TestSubscribeAgainReusesTheOpenCheckout(t *testing.T) {
	a, f, ctx := checkoutTestAPI(t)
	first, err := subscribe(a, ctx)
	if err != nil {
		t.Fatal(err)
	}
	again, err := subscribe(a, ctx)
	if err != nil {
		t.Fatalf("second subscribe: %v (%s)", err, conflictCode(err))
	}
	if again != first || f.created != 1 {
		t.Fatalf("second subscribe url=%q created=%d, want %q and one Checkout", again, f.created, first)
	}
}

// Epo 2026-10-21: an open Checkout for another plan is expired at Stripe and a
// new one starts.
func TestSubscribeToAnotherPlanExpiresTheOpenCheckout(t *testing.T) {
	a, f, ctx := checkoutTestAPI(t)
	first, err := subscribe(a, ctx)
	if err != nil {
		t.Fatal(err)
	}
	a.cfg.StripePricePro = "price_pro_2"
	next, err := subscribe(a, ctx)
	if err != nil {
		t.Fatalf("subscribe to another plan: %v (%s)", err, conflictCode(err))
	}
	if next == first || f.created != 2 || len(f.expired) != 1 {
		t.Fatalf("url=%q (first %q) created=%d expired=%v", next, first, f.created, f.expired)
	}
	var open, expired int
	if err := a.s.Pool().QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE status='open' AND price_id='price_pro_2'),
		count(*) FILTER (WHERE status='expired' AND provider_session_id=$2)
		FROM stripe_checkout_sessions WHERE user_id=$1`, auth.UserID(ctx), f.expired[0]).
		Scan(&open, &expired); err != nil {
		t.Fatal(err)
	}
	if open != 1 || expired != 1 {
		t.Fatalf("checkout rows open=%d expired=%d, want 1 and 1", open, expired)
	}
}

// subscription_exists answers only a real subscription.
func TestSubscribeWithASubscriptionAnswersSubscriptionExists(t *testing.T) {
	a, f, ctx := checkoutTestAPI(t)
	if _, err := a.s.Pool().Exec(ctx, `INSERT INTO user_subscriptions
		(stripe_subscription_id,user_id,status,price_id,plan_tier,current_period_end)
		VALUES ($1,$2,'active','price_pro','pro',now()+interval '30 days')`,
		"sub_"+auth.UserID(ctx), auth.UserID(ctx)); err != nil {
		t.Fatal(err)
	}
	if _, err := subscribe(a, ctx); conflictCode(err) != "subscription_exists" {
		t.Fatalf("subscribe with a subscription: %v, want subscription_exists", err)
	}
	if f.created != 0 {
		t.Fatalf("created %d Checkouts", f.created)
	}
}

// A double click that meets the first request's Checkout still being created
// gets its own code, not subscription_exists.
func TestSubscribeWhileACheckoutIsStartingAnswersCheckoutStarting(t *testing.T) {
	a, f, ctx := checkoutTestAPI(t)
	if _, err := a.s.Pool().Exec(ctx, `INSERT INTO stripe_checkout_sessions
		(id,user_id,customer_id,price_id,status) VALUES ($1,$2,$3,'price_pro','creating')`,
		randID("checkout"), auth.UserID(ctx), "cus_"+auth.UserID(ctx)); err != nil {
		t.Fatal(err)
	}
	if _, err := subscribe(a, ctx); conflictCode(err) != "checkout_starting" {
		t.Fatalf("subscribe while starting: %v (%s), want checkout_starting", err, conflictCode(err))
	}
	if f.created != 0 {
		t.Fatalf("created %d Checkouts", f.created)
	}
}
