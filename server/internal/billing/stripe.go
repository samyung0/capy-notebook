package billing

import (
	"github.com/stripe/stripe-go/v82"
	"github.com/stripe/stripe-go/v82/checkout/session"
	"github.com/stripe/stripe-go/v82/customer"
	bportalsession "github.com/stripe/stripe-go/v82/billingportal/session"
	"github.com/stripe/stripe-go/v82/subscription"
)

// Config holds Stripe settings.
type Config struct {
	SecretKey   string
	PricePro    string
	AppURL      string
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
