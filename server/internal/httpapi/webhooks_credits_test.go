package httpapi

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/billing"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// newCreditTestServer stubs the Stripe reads and the void the credit
// webhooks make; voided collects the invoices voided.
func newCreditTestServer(t *testing.T, f *fakeStore, outcome billing.ReloadResult) (*httptest.Server, *[]string) {
	t.Helper()
	voided := &[]string{}
	a := &api{
		wh:  f,
		cfg: Config{StripeWebhookSecret: testStripeSecret},
		stripeTopUpMethod: func(string) (store.PaymentMethod, error) {
			return store.PaymentMethod{ID: "pm_topup", Type: "card"}, nil
		},
		stripeSetupMethod: func(string) (store.PaymentMethod, error) {
			return store.PaymentMethod{ID: "pm_setup", Type: "card"}, nil
		},
		stripeVoidInvoice: func(id string) error {
			*voided = append(*voided, id)
			return nil
		},
		stripeReloadOutcome: func(string) (billing.ReloadResult, error) { return outcome, nil },
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/webhooks/stripe", a.stripeWebhook)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, voided
}

func sendStripe(t *testing.T, srv *httptest.Server, id, evtType string, object map[string]any) {
	t.Helper()
	body := stripeBody(t, id, evtType, object)
	resp := post(t, srv.URL+"/webhooks/stripe", signStripe(t, testStripeSecret, body), body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("%s status = %d, want 200", evtType, resp.StatusCode)
	}
}

func TestStripeWebhook_TopUpCreditsSavesCardAndVoidsRetryingReloads(t *testing.T) {
	f := newFakeStore()
	f.stripeCustomers["cus_1"] = "user_1"
	f.retryingReloads = []string{"in_reload"}
	srv, voided := newCreditTestServer(t, f, billing.ReloadResult{})

	sendStripe(t, srv, "evt_topup", "checkout.session.completed", map[string]any{
		"id":              "cs_topup",
		"mode":            "payment",
		"customer":        "cus_1",
		"payment_status":  "paid",
		"payment_intent":  "pi_topup",
		"amount_subtotal": 2000,
		"metadata":        map[string]string{"kind": "topup", "user_id": "user_1"},
	})
	want := []string{
		"grant user_1 cs_topup pi_topup 2000",
		"method user_1 pm_topup true",
		"void in_reload",
	}
	if !slices.Equal(f.creditCalls, want) {
		t.Fatalf("calls = %q, want %q", f.creditCalls, want)
	}
	if !slices.Equal(*voided, []string{"in_reload"}) {
		t.Fatalf("voided = %q", *voided)
	}
}

func TestStripeWebhook_SetupCheckoutReplacesTheReloadCard(t *testing.T) {
	f := newFakeStore()
	f.stripeCustomers["cus_1"] = "user_1"
	f.retryingReloads = []string{"in_old_card"}
	srv, voided := newCreditTestServer(t, f, billing.ReloadResult{})

	sendStripe(t, srv, "evt_setup", "checkout.session.completed", map[string]any{
		"id":           "cs_setup",
		"mode":         "setup",
		"customer":     "cus_1",
		"setup_intent": "seti_1",
		"metadata":     map[string]string{"kind": "reload_method", "user_id": "user_1"},
	})
	// The new card ends Stripe's retries of the old one.
	if !slices.Equal(f.creditCalls, []string{"method user_1 pm_setup false", "void in_old_card"}) ||
		!slices.Equal(*voided, []string{"in_old_card"}) {
		t.Fatalf("calls = %q voided = %q", f.creditCalls, *voided)
	}
}

func TestStripeWebhook_ReloadInvoiceOutcomes(t *testing.T) {
	reload := map[string]any{
		"id":       "in_reload",
		"metadata": map[string]string{"kind": "reload", "purchase_id": "cp_1"},
	}
	cases := []struct {
		name, event string
		outcome     billing.ReloadResult
		want        string
	}{
		{"paid", "invoice.paid",
			billing.ReloadResult{Paid: true, PaymentIntentID: "pi_r"}, "paid cp_1 in_reload pi_r"},
		{"retrying", "invoice.payment_failed",
			billing.ReloadResult{NextAttempt: time.Now().Add(time.Hour), DeclineReason: "card_declined"},
			"failed cp_1 in_reload false card_declined"},
		{"stopped", "invoice.payment_failed",
			billing.ReloadResult{DeclineReason: "expired_card"}, "failed cp_1 in_reload true expired_card"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeStore()
			srv, _ := newCreditTestServer(t, f, tc.outcome)
			sendStripe(t, srv, "evt_"+tc.name, tc.event, reload)
			if !slices.Equal(f.creditCalls, []string{tc.want}) {
				t.Fatalf("calls = %q, want %q", f.creditCalls, tc.want)
			}
		})
	}
}

func TestStripeWebhook_ReloadStillProcessingStaysCharging(t *testing.T) {
	f := newFakeStore()
	srv, _ := newCreditTestServer(t, f, billing.ReloadResult{Processing: true})
	sendStripe(t, srv, "evt_processing", "invoice.payment_failed", map[string]any{
		"id":       "in_reload",
		"metadata": map[string]string{"kind": "reload", "purchase_id": "cp_1"},
	})
	if len(f.creditCalls) != 0 {
		t.Fatalf("calls = %q, want none", f.creditCalls)
	}
}

func TestStripeWebhook_RefundsAndDisputesReachThePurchase(t *testing.T) {
	f := newFakeStore()
	srv, _ := newCreditTestServer(t, f, billing.ReloadResult{})

	sendStripe(t, srv, "evt_refund", "charge.refunded", map[string]any{
		"id": "ch_1", "payment_intent": "pi_1", "amount": 2000, "amount_refunded": 500,
	})
	sendStripe(t, srv, "evt_inquiry", "charge.dispute.created", map[string]any{
		"id": "dp_0", "payment_intent": "pi_0", "status": "warning_needs_response",
	})
	sendStripe(t, srv, "evt_dispute", "charge.dispute.created", map[string]any{
		"id": "dp_1", "payment_intent": "pi_1", "status": "needs_response",
	})
	sendStripe(t, srv, "evt_dispute_lost", "charge.dispute.closed", map[string]any{
		"id": "dp_1", "payment_intent": "pi_1", "status": "lost",
	})
	sendStripe(t, srv, "evt_dispute_won", "charge.dispute.closed", map[string]any{
		"id": "dp_2", "payment_intent": "pi_2", "status": "won",
	})
	want := []string{"refund pi_1 500/2000", "hold pi_1", "release pi_2"}
	if !slices.Equal(f.creditCalls, want) {
		t.Fatalf("calls = %q, want %q", f.creditCalls, want)
	}
}

func TestStripeWebhook_PaidProInvoiceRearmsAutoReload(t *testing.T) {
	f := newFakeStore()
	f.stripeCustomers["cus_1"] = "user_1"
	srv, _ := newCreditTestServer(t, f, billing.ReloadResult{})
	pro := func(id string, paid int64) map[string]any {
		return map[string]any{
			"id": id, "customer": "cus_1", "amount_paid": paid,
			"parent": map[string]any{
				"type":                 "subscription_details",
				"subscription_details": map[string]any{"subscription": map[string]any{"id": "sub_1"}},
			},
		}
	}
	sendStripe(t, srv, "evt_free_month", "invoice.paid", pro("in_zero", 0))
	sendStripe(t, srv, "evt_renewal", "invoice.paid", pro("in_paid", 1000))
	if !slices.Equal(f.creditCalls, []string{"arm user_1"}) {
		t.Fatalf("calls = %q, want one arm for the paid invoice", f.creditCalls)
	}
}
