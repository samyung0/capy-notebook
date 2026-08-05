package billing

import (
	"time"

	"github.com/stripe/stripe-go/v82"
	bportalsession "github.com/stripe/stripe-go/v82/billingportal/session"
	"github.com/stripe/stripe-go/v82/checkout/session"
	"github.com/stripe/stripe-go/v82/customer"
	"github.com/stripe/stripe-go/v82/subscription"

	"github.com/evonotes/server/internal/store"
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

func CreateCustomer(email, name, userID string) (string, error) {
	params := &stripe.CustomerParams{
		Email: stripe.String(email),
		Name:  stripe.String(name),
	}
	params.AddMetadata("user_id", userID)
	c, err := customer.New(params)
	if err != nil {
		return "", err
	}
	return c.ID, nil
}

func CreateCheckoutSession(customerID, priceID, userID, successURL, cancelURL string) (string, error) {
	params := &stripe.CheckoutSessionParams{
		Customer: stripe.String(customerID),
		Mode:     stripe.String(string(stripe.CheckoutSessionModeSubscription)),
		LineItems: []*stripe.CheckoutSessionLineItemParams{
			{Price: stripe.String(priceID), Quantity: stripe.Int64(1)},
		},
		SuccessURL: stripe.String(successURL),
		CancelURL:  stripe.String(cancelURL),
	}
	params.AddMetadata("user_id", userID)
	s, err := session.New(params)
	if err != nil {
		return "", err
	}
	return s.URL, nil
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

func ListActiveSubscription(customerID string) (*stripe.Subscription, error) {
	params := &stripe.SubscriptionListParams{Customer: stripe.String(customerID)}
	params.Filters.AddFilter("status", "", "active")
	params.Limit = stripe.Int64(1)
	iter := subscription.List(params)
	for iter.Next() {
		return iter.Subscription(), nil
	}
	if err := iter.Err(); err != nil {
		return nil, err
	}
	// try trialing
	params = &stripe.SubscriptionListParams{Customer: stripe.String(customerID)}
	params.Filters.AddFilter("status", "", "trialing")
	params.Limit = stripe.Int64(1)
	iter = subscription.List(params)
	for iter.Next() {
		return iter.Subscription(), nil
	}
	return nil, iter.Err()
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
	if len(sub.Items.Data) > 0 {
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
