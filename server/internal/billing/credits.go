package billing

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/stripe/stripe-go/v82"
	"github.com/stripe/stripe-go/v82/checkout/session"
	"github.com/stripe/stripe-go/v82/dispute"
	"github.com/stripe/stripe-go/v82/invoice"
	"github.com/stripe/stripe-go/v82/invoiceitem"
	"github.com/stripe/stripe-go/v82/paymentintent"
	"github.com/stripe/stripe-go/v82/refund"
	"github.com/stripe/stripe-go/v82/setupintent"
	"github.com/stripe/stripe-go/v82/subscription"

	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Checkout metadata kinds. Top-up sessions and their post-payment invoices
// carry KindTopUp; reload invoices carry KindReload; the setup session that
// saves the auto-reload card carries KindReloadMethod.
const (
	KindTopUp        = "topup"
	KindReload       = "reload"
	KindReloadMethod = "reload_method"
)

// instantMethodTypes are what top-ups and the auto-reload card accept: cards
// (wallets arrive as cards) and Link. Every other method settles in days.
var instantMethodTypes = []*string{stripe.String("card"), stripe.String("link")}

// checkoutTTL bounds how long an unpaid top-up can wait, so an open session
// cannot be paid long after the spending limit was checked. 30 minutes is
// Stripe's minimum.
const checkoutTTL = 30 * time.Minute

// CreateTopUpCheckout opens hosted Checkout in payment mode for one top-up and
// saves the card for off-session reuse.
func CreateTopUpCheckout(customerID, userID string, amountCents int64, successURL, cancelURL string) (CheckoutSession, error) {
	meta := map[string]string{
		"kind":    KindTopUp,
		"user_id": userID,
		"credits": strconv.FormatInt(store.CreditsMicrosForCents(amountCents)/store.MicrosPerCredit, 10),
	}
	params := &stripe.CheckoutSessionParams{
		Customer:           stripe.String(customerID),
		Mode:               stripe.String(string(stripe.CheckoutSessionModePayment)),
		PaymentMethodTypes: instantMethodTypes,
		LineItems: []*stripe.CheckoutSessionLineItemParams{{
			Quantity: stripe.Int64(1),
			PriceData: &stripe.CheckoutSessionLineItemPriceDataParams{
				Currency:   stripe.String(string(stripe.CurrencyUSD)),
				UnitAmount: stripe.Int64(amountCents),
				ProductData: &stripe.CheckoutSessionLineItemPriceDataProductDataParams{
					Name: stripe.String("Capy Notebook credits"),
				},
			},
		}},
		PaymentIntentData: &stripe.CheckoutSessionPaymentIntentDataParams{
			SetupFutureUsage: stripe.String(string(stripe.PaymentIntentSetupFutureUsageOffSession)),
			Metadata:         meta,
		},
		InvoiceCreation: &stripe.CheckoutSessionInvoiceCreationParams{
			Enabled:     stripe.Bool(true),
			InvoiceData: &stripe.CheckoutSessionInvoiceCreationInvoiceDataParams{Metadata: meta},
		},
		AutomaticTax:    &stripe.CheckoutSessionAutomaticTaxParams{Enabled: stripe.Bool(true)},
		CustomerUpdate:  &stripe.CheckoutSessionCustomerUpdateParams{Address: stripe.String("auto")},
		AdaptivePricing: &stripe.CheckoutSessionAdaptivePricingParams{Enabled: stripe.Bool(false)},
		ExpiresAt:       stripe.Int64(time.Now().Add(checkoutTTL).Unix()),
		SuccessURL:      stripe.String(successURL),
		CancelURL:       stripe.String(cancelURL),
		Metadata:        meta,
	}
	return newCreditCheckout(params)
}

// newCreditCheckout opens a credit Checkout and returns its page.
func newCreditCheckout(params *stripe.CheckoutSessionParams) (CheckoutSession, error) {
	s, err := session.New(params)
	if err != nil {
		return CheckoutSession{}, err
	}
	return CheckoutSession{ID: s.ID, URL: s.URL, Status: string(s.Status), ExpiresAt: time.Unix(s.ExpiresAt, 0)}, nil
}

// CreateReloadMethodCheckout opens hosted Checkout in setup mode to save the
// card auto-reload charges. The billing address is kept on the customer
// because reload invoices compute tax from it.
func CreateReloadMethodCheckout(customerID, userID, successURL, cancelURL string) (CheckoutSession, error) {
	meta := map[string]string{"kind": KindReloadMethod, "user_id": userID}
	params := &stripe.CheckoutSessionParams{
		Customer:                 stripe.String(customerID),
		Mode:                     stripe.String(string(stripe.CheckoutSessionModeSetup)),
		Currency:                 stripe.String(string(stripe.CurrencyUSD)),
		PaymentMethodTypes:       instantMethodTypes,
		BillingAddressCollection: stripe.String("required"),
		CustomerUpdate:           &stripe.CheckoutSessionCustomerUpdateParams{Address: stripe.String("auto")},
		SetupIntentData:          &stripe.CheckoutSessionSetupIntentDataParams{Metadata: meta},
		ExpiresAt:                stripe.Int64(time.Now().Add(checkoutTTL).Unix()),
		SuccessURL:               stripe.String(successURL),
		CancelURL:                stripe.String(cancelURL),
		Metadata:                 meta,
	}
	return newCreditCheckout(params)
}

// PaymentMethodInfo describes a payment method as the auto-reload dialog
// shows it.
func PaymentMethodInfo(pm *stripe.PaymentMethod) store.PaymentMethod {
	out := store.PaymentMethod{ID: pm.ID, Type: string(pm.Type)}
	if pm.Card != nil {
		out.Brand = string(pm.Card.Brand)
		out.Last4 = pm.Card.Last4
		out.ExpMonth = int(pm.Card.ExpMonth)
		out.ExpYear = int(pm.Card.ExpYear)
		if pm.Card.Fingerprint != "" {
			out.CardKey = "card:" + pm.Card.Fingerprint
		}
	}
	return out
}

// SubscriptionPaymentMethod reads the card a subscription Checkout saved as
// the subscription's default; empty when it saved none.
func SubscriptionPaymentMethod(subscriptionID string) (store.PaymentMethod, error) {
	params := &stripe.SubscriptionParams{}
	params.AddExpand("default_payment_method")
	sub, err := subscription.Get(subscriptionID, params)
	if err != nil || sub.DefaultPaymentMethod == nil {
		return store.PaymentMethod{}, err
	}
	return PaymentMethodInfo(sub.DefaultPaymentMethod), nil
}

// TopUpPaymentMethod reads the payment method a paid top-up used.
func TopUpPaymentMethod(paymentIntentID string) (store.PaymentMethod, error) {
	params := &stripe.PaymentIntentParams{}
	params.AddExpand("payment_method")
	pi, err := paymentintent.Get(paymentIntentID, params)
	if err != nil {
		return store.PaymentMethod{}, err
	}
	if pi.PaymentMethod == nil {
		return store.PaymentMethod{}, errors.New("top-up payment intent has no payment method")
	}
	return PaymentMethodInfo(pi.PaymentMethod), nil
}

// SetupPaymentMethod reads the payment method a setup Checkout saved.
func SetupPaymentMethod(setupIntentID string) (store.PaymentMethod, error) {
	params := &stripe.SetupIntentParams{}
	params.AddExpand("payment_method")
	si, err := setupintent.Get(setupIntentID, params)
	if err != nil {
		return store.PaymentMethod{}, err
	}
	if si.PaymentMethod == nil {
		return store.PaymentMethod{}, errors.New("setup intent has no payment method")
	}
	return PaymentMethodInfo(si.PaymentMethod), nil
}

// ReloadResult is what one reload charge left behind.
type ReloadResult struct {
	InvoiceID       string
	PaymentIntentID string
	Paid            bool
	// Processing is a payment Stripe has not settled yet: the reload stays
	// charging until invoice.paid or the next resume reads it again.
	Processing bool
	// Void is an invoice voided in Stripe (by a top-up, a new card, or by hand).
	Void bool
	// Open is an invoice Stripe can still collect; a declined one with no
	// NextAttempt waits for Stripe to schedule the retry or give up.
	Open bool
	// NextAttempt is when Stripe retries a failed charge; zero means it stopped.
	NextAttempt   time.Time
	DeclineReason string
}

// ChargeReload creates, finalizes and pays one auto-reload invoice. Every step
// is keyed by the purchase id, so a worker that resumes a crashed charge reuses
// the same Stripe objects. A declined card is a result, not an error: Stripe
// keeps retrying the invoice on its own schedule.
func ChargeReload(p store.ReloadCharge) (ReloadResult, error) {
	key := "reload-" + p.ID
	meta := map[string]string{"kind": KindReload, "user_id": p.UserID, "purchase_id": p.ID}
	invParams := &stripe.InvoiceParams{
		Customer:                    stripe.String(p.CustomerID),
		Currency:                    stripe.String(string(stripe.CurrencyUSD)),
		CollectionMethod:            stripe.String(string(stripe.InvoiceCollectionMethodChargeAutomatically)),
		AutoAdvance:                 stripe.Bool(true),
		DefaultPaymentMethod:        stripe.String(p.PaymentMethodID),
		AutomaticTax:                &stripe.InvoiceAutomaticTaxParams{Enabled: stripe.Bool(true)},
		PendingInvoiceItemsBehavior: stripe.String("exclude"),
		Description:                 stripe.String("Capy Notebook auto-reload"),
		Metadata:                    meta,
	}
	invParams.SetIdempotencyKey(key + "-invoice")
	inv, err := invoice.New(invParams)
	if err != nil {
		return ReloadResult{}, err
	}
	itemParams := &stripe.InvoiceItemParams{
		Customer:    stripe.String(p.CustomerID),
		Invoice:     stripe.String(inv.ID),
		Amount:      stripe.Int64(p.AmountCents),
		Currency:    stripe.String(string(stripe.CurrencyUSD)),
		Description: stripe.String("Capy Notebook credits"),
	}
	itemParams.SetIdempotencyKey(key + "-item")
	if _, err := invoiceitem.New(itemParams); err != nil {
		return ReloadResult{InvoiceID: inv.ID}, err
	}
	if inv.Status == stripe.InvoiceStatusDraft {
		finalize := &stripe.InvoiceFinalizeInvoiceParams{AutoAdvance: stripe.Bool(true)}
		finalize.SetIdempotencyKey(key + "-finalize")
		if _, err := invoice.FinalizeInvoice(inv.ID, finalize); err != nil {
			return ReloadResult{InvoiceID: inv.ID}, err
		}
	}
	pay := &stripe.InvoicePayParams{OffSession: stripe.Bool(true)}
	pay.SetIdempotencyKey(key + "-pay")
	_, payErr := invoice.Pay(inv.ID, pay)
	var stripeErr *stripe.Error
	if payErr != nil && !(errors.As(payErr, &stripeErr) && stripeErr.Type == stripe.ErrorTypeCard) {
		return ReloadResult{InvoiceID: inv.ID}, payErr
	}
	return ReloadOutcome(inv.ID)
}

// ReloadOutcome reads a reload invoice's payment state: paid, or failed with
// Stripe's next attempt and the decline reason.
func ReloadOutcome(invoiceID string) (ReloadResult, error) {
	params := &stripe.InvoiceParams{}
	params.AddExpand("payments.data.payment.payment_intent")
	inv, err := invoice.Get(invoiceID, params)
	if err != nil {
		return ReloadResult{InvoiceID: invoiceID}, err
	}
	out := ReloadResult{
		InvoiceID: inv.ID,
		Paid:      inv.Status == stripe.InvoiceStatusPaid,
		Void:      inv.Status == stripe.InvoiceStatusVoid,
		Open:      inv.Status == stripe.InvoiceStatusOpen,
	}
	if inv.NextPaymentAttempt > 0 {
		out.NextAttempt = time.Unix(inv.NextPaymentAttempt, 0).UTC()
	}
	if inv.Payments != nil {
		for _, p := range inv.Payments.Data {
			if p.Payment == nil || p.Payment.PaymentIntent == nil {
				continue
			}
			pi := p.Payment.PaymentIntent
			out.PaymentIntentID = pi.ID
			out.Processing = !out.Paid && pi.Status == stripe.PaymentIntentStatusProcessing
			if pi.LastPaymentError != nil {
				out.DeclineReason = string(pi.LastPaymentError.DeclineCode)
				if out.DeclineReason == "" {
					out.DeclineReason = string(pi.LastPaymentError.Code)
				}
			}
		}
	}
	return out, nil
}

// VoidInvoice cancels a failed reload invoice, which stops Stripe's retries.
func VoidInvoice(invoiceID string) error {
	inv, err := invoice.Get(invoiceID, nil)
	if err != nil {
		return err
	}
	if inv.Status != stripe.InvoiceStatusOpen {
		return nil
	}
	_, err = invoice.VoidInvoice(invoiceID, nil)
	return err
}

// InvoiceKind names an invoice for the Subscription tab's Type column.
func InvoiceKind(inv *stripe.Invoice) string {
	if kind := inv.Metadata["kind"]; kind == KindTopUp || kind == KindReload {
		return kind
	}
	return "plan"
}

// RunDueReloads starts every auto-reload that is due and charges it.
// notify tells the user's open tabs that billing changed.
func RunDueReloads(ctx context.Context, st *store.Store, notify func(userID string)) error {
	users, err := st.ReloadCandidates(ctx)
	if err != nil {
		return err
	}
	for _, userID := range users {
		charge, err := st.StartReload(ctx, userID)
		if err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"stage": "reload_start"})
			continue
		}
		if charge == nil {
			continue
		}
		if !charge.Skipped {
			ProcessReload(ctx, st, *charge)
		}
		notify(userID)
	}
	return nil
}

// errReloadStuck reports a reload still charging after 23 hours, when its
// Stripe idempotency keys have expired.
var errReloadStuck = errors.New("auto-reload left charging for 23 hours")

// ResumeStaleReloads finishes reloads a stopped worker left charging, and
// gives up on any still charging after 23 hours: its invoice is voided and it
// is marked failed.
func ResumeStaleReloads(ctx context.Context, st *store.Store, notify func(userID string)) error {
	charges, err := st.StaleReloadCharges(ctx, 2*time.Minute)
	if err != nil {
		return err
	}
	for _, charge := range charges {
		ProcessReload(ctx, st, charge)
		notify(charge.UserID)
	}
	stuck, err := st.StuckReloadCharges(ctx)
	if err != nil {
		return err
	}
	for _, r := range stuck {
		obs.CaptureErr(ctx, errReloadStuck, map[string]string{"stage": "reload_stuck", "purchase": r.ID})
		if r.InvoiceID != "" {
			if err := VoidInvoice(r.InvoiceID); err != nil {
				obs.CaptureErr(ctx, err, map[string]string{"stage": "reload_stuck_void"})
				continue
			}
		}
		if err := st.MarkReloadFailed(ctx, r.ID, r.InvoiceID, time.Time{}, "stuck"); err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"stage": "reload_stuck_record"})
		}
	}
	return nil
}

// The Stripe calls ProcessReload makes; tests replace them.
var (
	chargeReload = ChargeReload
	voidInvoice  = VoidInvoice
)

// ProcessReload charges one claimed reload and records the outcome. A Stripe
// error leaves it charging for ResumeStaleReloads; the 60-second window has
// ended by then, so new work at zero is refused meanwhile.
func ProcessReload(ctx context.Context, st *store.Store, charge store.ReloadCharge) {
	res, err := chargeReload(charge)
	if res.InvoiceID != "" {
		if linkErr := st.SetReloadInvoice(ctx, charge.ID, res.InvoiceID); linkErr != nil {
			obs.CaptureErr(ctx, linkErr, map[string]string{"stage": "reload_link_invoice"})
		}
	}
	if err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"stage": "reload_charge"})
		return
	}
	switch {
	case res.Paid:
		err = st.MarkReloadPaid(ctx, charge.ID, res.InvoiceID, res.PaymentIntentID)
	case res.Processing:
		return
	case res.Open && res.NextAttempt.IsZero():
		// Stripe schedules a decline's retry (or gives up) moments after the
		// charge: it stays charging until invoice.payment_failed or the next
		// resume reads that, so a reload Stripe retries is never first failed.
		return
	default:
		err = st.MarkReloadFailed(ctx, charge.ID, res.InvoiceID, res.NextAttempt, res.DeclineReason)
		// Turned off or given a new card while it charged: void it as they would have.
		var unwanted bool
		if err == nil {
			unwanted, err = st.ReloadRetryUnwanted(ctx, res.InvoiceID)
		}
		if unwanted {
			if err = voidInvoice(res.InvoiceID); err == nil {
				err = st.MarkReloadVoid(ctx, res.InvoiceID)
			}
		}
	}
	if err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"stage": "reload_record"})
	}
}

// PaidTopUp is a paid top-up Checkout, as the daily reconciliation reads it.
type PaidTopUp struct {
	SessionID       string
	CustomerID      string
	UserID          string
	PaymentIntentID string
	AmountCents     int64
}

// ListPaidTopUps returns paid top-up Checkouts completed since the given time,
// for the daily reconciliation to credit any whose webhook never arrived.
func ListPaidTopUps(since time.Time) ([]PaidTopUp, error) {
	params := &stripe.CheckoutSessionListParams{
		Status:       stripe.String(string(stripe.CheckoutSessionStatusComplete)),
		CreatedRange: &stripe.RangeQueryParams{GreaterThanOrEqual: since.Unix()},
	}
	var out []PaidTopUp
	iter := session.List(params)
	for iter.Next() {
		s := iter.CheckoutSession()
		if s.Mode != stripe.CheckoutSessionModePayment || s.Metadata["kind"] != KindTopUp ||
			s.PaymentStatus != stripe.CheckoutSessionPaymentStatusPaid ||
			s.Customer == nil || s.PaymentIntent == nil {
			continue
		}
		out = append(out, PaidTopUp{
			SessionID:       s.ID,
			CustomerID:      s.Customer.ID,
			UserID:          s.Metadata["user_id"],
			PaymentIntentID: s.PaymentIntent.ID,
			AmountCents:     s.AmountSubtotal,
		})
	}
	return out, iter.Err()
}

// Reversal is a refund or dispute on one payment. A refund carries the
// charge's cumulative refunded and charged cents; a dispute its status.
type Reversal struct {
	PaymentIntentID string
	RefundedCents   int64
	ChargedCents    int64
	Dispute         stripe.DisputeStatus
}

// ListReversals returns refunds and disputes created since the given time,
// for the daily reconciliation to re-apply to credit purchases (a webhook that
// arrived before its purchase was recorded found nothing to take back).
func ListReversals(since time.Time) ([]Reversal, error) {
	created := &stripe.RangeQueryParams{GreaterThanOrEqual: since.Unix()}
	var out []Reversal
	refunds := &stripe.RefundListParams{CreatedRange: created}
	refunds.AddExpand("data.charge")
	ri := refund.List(refunds)
	for ri.Next() {
		r := ri.Refund()
		if r.Charge == nil || r.Charge.PaymentIntent == nil {
			continue
		}
		out = append(out, Reversal{
			PaymentIntentID: r.Charge.PaymentIntent.ID,
			RefundedCents:   r.Charge.AmountRefunded,
			ChargedCents:    r.Charge.Amount,
		})
	}
	if err := ri.Err(); err != nil {
		return nil, err
	}
	di := dispute.List(&stripe.DisputeListParams{CreatedRange: created})
	for di.Next() {
		d := di.Dispute()
		if d.PaymentIntent == nil {
			continue
		}
		out = append(out, Reversal{PaymentIntentID: d.PaymentIntent.ID, Dispute: d.Status})
	}
	return out, di.Err()
}
