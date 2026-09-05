package billing

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/stripe/stripe-go/v82"
	bportalsession "github.com/stripe/stripe-go/v82/billingportal/session"
	"github.com/stripe/stripe-go/v82/checkout/session"
	"github.com/stripe/stripe-go/v82/customer"
	"github.com/stripe/stripe-go/v82/refund"
	"github.com/stripe/stripe-go/v82/subscription"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Config holds Stripe settings.
type Config struct {
	SecretKey     string
	PricePro      string
	AppURL        string
	WebhookSecret string
}

func Init(cfg Config) {
	if cfg.SecretKey != "" {
		stripe.Key = cfg.SecretKey
	}
}

func PriceForTier(tier, pricePro string) string {
	switch tier {
	case "pro":
		return pricePro
	default:
		return ""
	}
}

func CreateCustomer(email, name, userID, idempotencyKey string) (string, error) {
	params := &stripe.CustomerParams{
		Email: stripe.String(email),
		Name:  stripe.String(name),
	}
	params.AddMetadata("user_id", userID)
	params.SetIdempotencyKey(idempotencyKey)
	c, err := customer.New(params)
	if err != nil {
		return "", err
	}
	return c.ID, nil
}

type CheckoutSession struct {
	ID  string
	URL string
}

func CreateCheckoutSession(
	customerID, priceID, userID, successURL, cancelURL, reservationID, idempotencyKey string,
) (CheckoutSession, error) {
	params := &stripe.CheckoutSessionParams{
		Customer: stripe.String(customerID),
		Mode:     stripe.String(string(stripe.CheckoutSessionModeSubscription)),
		LineItems: []*stripe.CheckoutSessionLineItemParams{
			{Price: stripe.String(priceID), Quantity: stripe.Int64(1)},
		},
		SuccessURL:       stripe.String(successURL),
		CancelURL:        stripe.String(cancelURL),
		SubscriptionData: &stripe.CheckoutSessionSubscriptionDataParams{},
	}
	params.AddMetadata("user_id", userID)
	params.AddMetadata("checkout_reservation_id", reservationID)
	// Stripe does not copy Checkout Session metadata to the subscription. Store
	// the same stable owner there so an early subscription webhook can resolve
	// the user before the local customer binding commits.
	params.SubscriptionData.AddMetadata("user_id", userID)
	params.SetIdempotencyKey(idempotencyKey)
	s, err := session.New(params)
	if err != nil {
		return CheckoutSession{}, err
	}
	return CheckoutSession{ID: s.ID, URL: s.URL}, nil
}

func stripeNotFound(err error) bool {
	var stripeErr *stripe.Error
	return errors.As(err, &stripeErr) && stripeErr.HTTPStatusCode == http.StatusNotFound
}

func ExpireCheckoutSession(sessionID string) error {
	remote, err := session.Get(sessionID, nil)
	if stripeNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if remote.Status != stripe.CheckoutSessionStatusOpen {
		return nil
	}
	_, err = session.Expire(sessionID, nil)
	return err
}

// SubscriptionRefundTarget returns the first paid object on the subscription's
// latest invoice. For a Checkout race this is the initial subscription charge.
// The target is persisted before cancellation so a process crash cannot lose
// the refund obligation after the subscription is already gone. The booleans
// report a fully canceled subscription and an end-of-period cancellation,
// respectively. They are independent because Stripe may retain the period-end
// flag after the subscription reaches canceled.
func SubscriptionRefundTarget(
	subscriptionID string,
) (store.StripeCompensationAction, string, bool, bool, error) {
	params := &stripe.SubscriptionParams{}
	params.AddExpand("latest_invoice.payments.data.payment.payment_intent")
	params.AddExpand("latest_invoice.payments.data.payment.charge")
	sub, err := subscription.Get(subscriptionID, params)
	if stripeNotFound(err) {
		return "", "", true, false, nil
	}
	if err != nil {
		return "", "", false, false, err
	}
	action, objectID := store.StripeCompensationAction(""), ""
	if sub.LatestInvoice != nil && sub.LatestInvoice.Payments != nil {
		for _, payment := range sub.LatestInvoice.Payments.Data {
			if payment == nil || payment.Status != "paid" || payment.AmountPaid <= 0 || payment.Payment == nil {
				continue
			}
			if payment.Payment.PaymentIntent != nil {
				action, objectID = store.StripeRefundPayment, payment.Payment.PaymentIntent.ID
			} else if payment.Payment.Charge != nil {
				action, objectID = store.StripeRefundCharge, payment.Payment.Charge.ID
			}
			if objectID != "" {
				break
			}
		}
	}
	return action, objectID, sub.Status == stripe.SubscriptionStatusCanceled,
		sub.CancelAtPeriodEnd, nil
}

func CancelSubscription(subscriptionID string) error {
	_, err := subscription.Cancel(subscriptionID, nil)
	if stripeNotFound(err) {
		return nil
	}
	return err
}

func RetrieveSubscription(subscriptionID string) (*stripe.Subscription, error) {
	return subscription.Get(subscriptionID, nil)
}

type RefundResult struct {
	ID     string
	Status stripe.RefundStatus
}

func CreateRefund(
	action store.StripeCompensationAction,
	objectID string,
	generation int,
) (RefundResult, error) {
	params := &stripe.RefundParams{Reason: stripe.String(string(stripe.RefundReasonRequestedByCustomer))}
	switch action {
	case store.StripeRefundPayment:
		params.PaymentIntent = stripe.String(objectID)
	case store.StripeRefundCharge:
		params.Charge = stripe.String(objectID)
	default:
		return RefundResult{}, errors.New("unsupported Stripe refund target")
	}
	params.SetIdempotencyKey("account-deletion-" + string(action) + "-" + objectID + "-" + strconv.Itoa(generation))
	created, err := refund.New(params)
	if err != nil {
		return RefundResult{}, err
	}
	return RefundResult{ID: created.ID, Status: created.Status}, nil
}

func GetRefund(refundID string) (RefundResult, error) {
	current, err := refund.Get(refundID, nil)
	if err != nil {
		return RefundResult{}, err
	}
	return RefundResult{ID: current.ID, Status: current.Status}, nil
}

func CreatePortalSession(customerID, returnURL string) (string, error) {
	params := &stripe.BillingPortalSessionParams{
		Customer:  stripe.String(customerID),
		ReturnURL: stripe.String(returnURL),
	}
	s, err := bportalsession.New(params)
	if err != nil {
		return "", err
	}
	return s.URL, nil
}

func PlanTierFromPrice(priceID string, pricePro string) string {
	switch priceID {
	case pricePro:
		return "pro"
	default:
		return "free"
	}
}

func SubscriptionStatus(stripeStatus stripe.SubscriptionStatus) string {
	switch stripeStatus {
	case stripe.SubscriptionStatusActive:
		return "active"
	case stripe.SubscriptionStatusPastDue:
		return "past_due"
	case stripe.SubscriptionStatusCanceled, stripe.SubscriptionStatusUnpaid:
		return "canceled"
	case stripe.SubscriptionStatusTrialing:
		return "trialing"
	default:
		return "none"
	}
}

func ListEntitlingSubscriptions(customerID string) ([]*stripe.Subscription, error) {
	var out []*stripe.Subscription
	params := &stripe.SubscriptionListParams{Customer: stripe.String(customerID)}
	params.Filters.AddFilter("status", "", "all")
	params.Limit = stripe.Int64(100)
	iter := subscription.List(params)
	for iter.Next() {
		switch iter.Subscription().Status {
		case stripe.SubscriptionStatusActive,
			stripe.SubscriptionStatusTrialing,
			stripe.SubscriptionStatusPastDue:
			out = append(out, iter.Subscription())
		}
	}
	if err := iter.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// SubscriptionRecord maps a Stripe subscription onto our record. The period
// end lives on the subscription item in the current API version, not on the
// subscription itself, which is why nothing used to persist it.
func SubscriptionRecord(
	sub *stripe.Subscription,
	userID, pricePro string,
	eventCreated int64,
) store.Subscription {
	out := store.Subscription{
		StripeSubscriptionID: sub.ID,
		UserID:               userID,
		Status:               SubscriptionStatus(sub.Status),
		PlanTier:             store.PlanFree,
		CancelAtPeriodEnd:    sub.CancelAtPeriodEnd,
		StripeEventCreated:   eventCreated,
	}
	if sub.Items != nil && len(sub.Items.Data) > 0 {
		item := sub.Items.Data[0]
		if item.Price != nil {
			out.PriceID = item.Price.ID
			out.PlanTier = store.PlanTier(PlanTierFromPrice(item.Price.ID, pricePro))
		}
		if item.CurrentPeriodEnd > 0 {
			end := time.Unix(item.CurrentPeriodEnd, 0).UTC()
			out.CurrentPeriodEnd = &end
		}
	}
	if sub.CanceledAt > 0 {
		at := time.Unix(sub.CanceledAt, 0).UTC()
		out.CanceledAt = &at
	}
	if sub.EndedAt > 0 {
		at := time.Unix(sub.EndedAt, 0).UTC()
		out.EndedAt = &at
	}
	return out
}
