package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stripe/stripe-go/v82"

	"github.com/samyung0/capy-notebook/server/internal/billing"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/ratelimit"
)

// TestCreditCheckoutsAreReusedPerUser (security regression: rate-limit audit
// M11). A top-up for the same amount hands out the open page again instead
// of a new Stripe session; another amount, or a page its webhook finished,
// opens a new one.
func TestCreditCheckoutsAreReusedPerUser(t *testing.T) {
	a, _, ctx := checkoutTestAPI(t)
	a.cfg.StripeSecretKey = "sk_test_fake"
	created, reads := 0, 0
	status := map[string]string{}
	a.stripeTopUpCheckout = func(_, _ string, _ int64, _, _ string) (billing.CheckoutSession, error) {
		created++
		id := fmt.Sprintf("cs_topup_%s_%d", userID(ctx), created)
		status[id] = "open"
		return billing.CheckoutSession{ID: id, URL: "https://checkout.stripe.test/" + id, Status: "open",
			ExpiresAt: time.Now().Add(30 * time.Minute)}, nil
	}
	a.stripeGetCheckout = func(id string) (billing.CheckoutSession, error) {
		reads++
		return billing.CheckoutSession{ID: id, Status: status[id]}, nil
	}
	topUp := func(cents int64) string {
		t.Helper()
		out, err := a.billingTopUp(ctx, &topUpInput{Body: apimodel.TopUpReq{AmountCents: cents}})
		if err != nil {
			t.Fatal(err)
		}
		return out.Body.URL
	}
	first := topUp(800)
	if again := topUp(800); again != first || created != 1 {
		t.Fatalf("same amount: %q then %q, %d sessions", first, again, created)
	}
	if topUp(1000) == first || created != 2 {
		t.Fatalf("another amount: %d sessions, want 2", created)
	}
	if err := a.s.ForgetCreditCheckout(ctx, fmt.Sprintf("cs_topup_%s_2", userID(ctx))); err != nil {
		t.Fatal(err)
	}
	third := topUp(1000)
	if created != 3 {
		t.Fatalf("after its webhook finished the page: %d sessions, want 3", created)
	}
	// Completed with its webhook lost (review L-7): Stripe's status says so,
	// and the next click gets a new page.
	status[fmt.Sprintf("cs_topup_%s_3", userID(ctx))] = "complete"
	if again := topUp(1000); again == third || created != 4 {
		t.Fatalf("a completed page was handed out again (%d sessions)", created)
	}
	if reads != 2 {
		t.Fatalf("Stripe status reads = %d, want one per reuse (2)", reads)
	}
}

// TestStripeSessionsStopAt10AnHour (security regression: rate-limit audit
// M11). A user's requests create at most 10 Stripe sessions an hour; the
// 11th is refused with 429 checkout_limit before Stripe is called.
func TestStripeSessionsStopAt10AnHour(t *testing.T) {
	url := os.Getenv("CAPY_GO_TEST_REDIS_URL")
	if url == "" {
		t.Skip("run with pnpm test:go for disposable Redis")
	}
	options, err := redis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(options)
	t.Cleanup(func() { _ = rdb.Close() })
	a, _, ctx := checkoutTestAPI(t)
	a.limiter = ratelimit.New(rdb, ratelimit.DefaultConfig())
	portals := 0
	a.stripePortal = func(string, string, string) (string, error) {
		portals++
		return "https://billing.stripe.test/portal", nil
	}
	for i := 1; i <= 10; i++ {
		if _, err := a.billingPortal(ctx, nil); err != nil {
			t.Fatalf("portal %d: %v", i, err)
		}
	}
	_, err = a.billingPortal(ctx, nil)
	var refusal *huma.ErrorModel
	if !errors.As(err, &refusal) || refusal.Status != http.StatusTooManyRequests ||
		len(refusal.Errors) != 1 || refusal.Errors[0].Message != "checkout_limit" || portals != 10 {
		t.Fatalf("portal 11: %v after %d sessions, want 429 checkout_limit", err, portals)
	}
}

// TestInvoiceListsAreCachedAMinute (security regression: rate-limit audit
// M11). Invoice reads within a minute are answered without Stripe.
func TestInvoiceListsAreCachedAMinute(t *testing.T) {
	a, _, ctx := checkoutTestAPI(t)
	reads := 0
	a.stripeInvoices = func(string) ([]*stripe.Invoice, error) {
		reads++
		return []*stripe.Invoice{{ID: "in_1", Created: 1}}, nil
	}
	for range 3 {
		out, err := a.listInvoices(ctx, nil)
		if err != nil || len(out.Body.Items) != 1 {
			t.Fatalf("invoices = %+v, %v", out, err)
		}
	}
	if reads != 1 {
		t.Fatalf("Stripe invoice reads = %d, want 1", reads)
	}
}
