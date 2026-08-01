package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/stripe/stripe-go/v82"
	"github.com/stripe/stripe-go/v82/webhook"
	svix "github.com/svix/svix-webhooks/go"

	"github.com/evonotes/server/internal/billing"
)

// webhookStore is the narrow slice of *store.Store the webhook handlers touch.
// Declaring it here lets tests inject a fake and exercise the full HTTP path
// (signature verification, idempotency, payload dispatch) without a database.
type webhookStore interface {
	WebhookProcessed(ctx context.Context, id string) (bool, error)
	RecordWebhookEvent(ctx context.Context, id, source, eventType string, payload json.RawMessage) error
	MarkWebhookProcessed(ctx context.Context, id string, procErr error) error
	UpsertUserFromWebhook(ctx context.Context, id, name, email, avatarURL string) error
	CreateDefaultWorkspace(ctx context.Context, userID string) error
	MarkUserDeleted(ctx context.Context, id string) error
	UserIDByStripeCustomer(ctx context.Context, customerID string) (string, error)
	SetStripeCustomerID(ctx context.Context, userID, customerID string) error
	UpdateSubscriptionByCustomerID(ctx context.Context, customerID, status, planTier string) error
}

func (a *api) clerkWebhook(w http.ResponseWriter, r *http.Request) {
	if a.cfg.ClerkWebhookSecret == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "webhook not configured"})
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, 400, map[string]string{"message": "read body"})
		return
	}
	wh, err := svix.NewWebhook(a.cfg.ClerkWebhookSecret)
	if err != nil {
		a.fail(w, err)
		return
	}
	if err := wh.Verify(body, r.Header); err != nil {
		writeJSON(w, 401, map[string]string{"message": "invalid signature"})
		return
	}

	var evt struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &evt); err != nil {
		a.fail(w, err)
		return
	}

	var envelope struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(body, &envelope)
	eventID := envelope.ID
	if eventID == "" {
		eventID = "clerk_" + evt.Type
	}

	done, _ := a.wh.WebhookProcessed(r.Context(), eventID)
	if done {
		writeJSON(w, 200, map[string]string{"status": "already processed"})
		return
	}
	_ = a.wh.RecordWebhookEvent(r.Context(), eventID, "clerk", evt.Type, body)

	var procErr error
	switch evt.Type {
	case "user.created", "user.updated":
		var wrapper struct {
			ID             string  `json:"id"`
			FirstName      *string `json:"first_name"`
			LastName       *string `json:"last_name"`
			EmailAddresses []struct {
				EmailAddress string `json:"email_address"`
			} `json:"email_addresses"`
			ImageURL *string `json:"image_url"`
		}
		if err := json.Unmarshal(evt.Data, &wrapper); err != nil {
			procErr = err
			break
		}
		name := ""
		if wrapper.FirstName != nil {
			name = *wrapper.FirstName
		}
		if wrapper.LastName != nil {
			if name != "" {
				name += " "
			}
			name += *wrapper.LastName
		}
		email := ""
		if len(wrapper.EmailAddresses) > 0 {
			email = wrapper.EmailAddresses[0].EmailAddress
		}
		avatar := ""
		if wrapper.ImageURL != nil {
			avatar = *wrapper.ImageURL
		}
		procErr = a.wh.UpsertUserFromWebhook(r.Context(), wrapper.ID, name, email, avatar)
		if procErr == nil && evt.Type == "user.created" {
			_ = a.wh.CreateDefaultWorkspace(r.Context(), wrapper.ID)
		}
	case "user.deleted":
		var data struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(evt.Data, &data); err != nil {
			procErr = err
			break
		}
		procErr = a.wh.MarkUserDeleted(r.Context(), data.ID)
	}

	_ = a.wh.MarkWebhookProcessed(r.Context(), eventID, procErr)
	if procErr != nil {
		a.fail(w, procErr)
		return
	}
	writeJSON(w, 200, map[string]string{"status": "ok"})
}

func (a *api) stripeWebhook(w http.ResponseWriter, r *http.Request) {
	if a.cfg.StripeWebhookSecret == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "webhook not configured"})
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		a.fail(w, err)
		return
	}
	event, err := webhook.ConstructEvent(body, r.Header.Get("Stripe-Signature"), a.cfg.StripeWebhookSecret)
	if err != nil {
		writeJSON(w, 400, map[string]string{"message": "invalid signature"})
		return
	}

	done, _ := a.wh.WebhookProcessed(r.Context(), event.ID)
	if done {
		writeJSON(w, 200, map[string]string{"status": "already processed"})
		return
	}
	_ = a.wh.RecordWebhookEvent(r.Context(), event.ID, "stripe", string(event.Type), event.Data.Raw)

	var procErr error
	switch event.Type {
	case "checkout.session.completed":
		var sess stripe.CheckoutSession
		if err := json.Unmarshal(event.Data.Raw, &sess); err != nil {
			procErr = err
			break
		}
		userID := sess.Metadata["user_id"]
		if userID == "" && sess.Customer != nil {
			userID, _ = a.wh.UserIDByStripeCustomer(r.Context(), sess.Customer.ID)
		}
		if userID != "" && sess.Customer != nil {
			_ = a.wh.SetStripeCustomerID(r.Context(), userID, sess.Customer.ID)
		}
	case "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted":
		var sub stripe.Subscription
		if err := json.Unmarshal(event.Data.Raw, &sub); err != nil {
			procErr = err
			break
		}
		customerID := ""
		if sub.Customer != nil {
			customerID = sub.Customer.ID
		}
		status := billing.SubscriptionStatus(sub.Status)
		planTier := "free"
		if len(sub.Items.Data) > 0 && sub.Items.Data[0].Price != nil {
			planTier = billing.PlanTierFromPrice(sub.Items.Data[0].Price.ID, a.cfg.StripePricePro)
		}
		if event.Type == "customer.subscription.deleted" {
			status = "canceled"
			planTier = "free"
		}
		if customerID != "" {
			procErr = a.wh.UpdateSubscriptionByCustomerID(r.Context(), customerID, status, planTier)
		}
	}

	_ = a.wh.MarkWebhookProcessed(r.Context(), event.ID, procErr)
	if procErr != nil {
		a.fail(w, procErr)
		return
	}
	writeJSON(w, 200, map[string]string{"status": "ok"})
}
