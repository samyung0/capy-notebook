package httpapi

import (
	"errors"
	"net/http"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/stripe/stripe-go/v82"
)

func TestCheckoutEntitlementGateSkipsUnmappedCustomer(t *testing.T) {
	called := false
	a := &api{stripeEntitlements: func(string) ([]*stripe.Subscription, error) {
		called = true
		return nil, nil
	}}
	if err := a.checkoutEntitlementError(""); err != nil {
		t.Fatal(err)
	}
	if called {
		t.Fatal("Stripe was queried without a mapped customer")
	}
}

func TestCheckoutEntitlementGateFailsClosed(t *testing.T) {
	a := &api{stripeEntitlements: func(customerID string) ([]*stripe.Subscription, error) {
		if customerID != "cus_existing" {
			t.Fatalf("customer id = %q", customerID)
		}
		return nil, errors.New("stripe unavailable")
	}}
	err := a.checkoutEntitlementError("cus_existing")
	statusErr, ok := err.(huma.StatusError)
	if !ok || statusErr.GetStatus() != http.StatusServiceUnavailable {
		t.Fatalf("provider failure = %v, want 503", err)
	}
}

func TestCheckoutEntitlementGateAllowsConfirmedEmpty(t *testing.T) {
	a := &api{stripeEntitlements: func(string) ([]*stripe.Subscription, error) {
		return []*stripe.Subscription{}, nil
	}}
	if err := a.checkoutEntitlementError("cus_existing"); err != nil {
		t.Fatalf("confirmed empty Stripe result = %v", err)
	}
}

func TestCheckoutEntitlementGateRejectsLiveSubscription(t *testing.T) {
	a := &api{stripeEntitlements: func(string) ([]*stripe.Subscription, error) {
		return []*stripe.Subscription{{ID: "sub_existing"}}, nil
	}}
	err := a.checkoutEntitlementError("cus_existing")
	statusErr, ok := err.(huma.StatusError)
	if !ok || statusErr.GetStatus() != http.StatusConflict {
		t.Fatalf("live entitlement = %v, want 409", err)
	}
}

func TestInvoicesFromStripeKeepsDueDateOptional(t *testing.T) {
	got := invoicesFromStripe([]*stripe.Invoice{
		{ID: "in_paid", Created: 1_790_000_000, Total: 800, Currency: "usd", Status: stripe.InvoiceStatusPaid, HostedInvoiceURL: "https://pay.stripe.com/i"},
		{ID: "in_open", Created: 1_790_100_000, DueDate: 1_790_200_000, Total: 800, Currency: "usd", Status: stripe.InvoiceStatusOpen},
	})
	if len(got) != 2 || got[0].DueAt != nil || got[0].Total != 800 || got[0].URL == "" ||
		got[1].DueAt == nil || got[1].DueAt.Unix() != 1_790_200_000 || got[1].Status != "open" {
		t.Fatalf("invoices = %#v", got)
	}
}
