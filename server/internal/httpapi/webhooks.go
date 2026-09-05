package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/stripe/stripe-go/v82"
	"github.com/stripe/stripe-go/v82/webhook"
	svix "github.com/svix/svix-webhooks/go"

	"github.com/samyung0/capy-notebook/server/internal/billing"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// webhookStore is the narrow slice of *store.Store the webhook handlers touch.
// Declaring it here lets tests inject a fake and exercise the full HTTP path
// (signature verification, idempotency, payload dispatch) without a database.
type webhookStore interface {
	ClaimWebhookEvent(ctx context.Context, id, source, eventType, userID string, payload json.RawMessage) (token string, processed bool, err error)
	AssociateWebhookEvent(ctx context.Context, source, id, token, userID string) error
	RedactWebhookEvent(ctx context.Context, source, id, token string) error
	MarkWebhookProcessed(ctx context.Context, source, id, token string, procErr error) error
	UpsertUserFromWebhook(ctx context.Context, id, name, email, avatarURL string) error
	CreateDefaultWorkspace(ctx context.Context, userID string) error
	MarkIdentityDeleted(ctx context.Context, id string) error
	UserIDByStripeCustomer(ctx context.Context, customerID string) (string, error)
	RecordStripeCheckoutCompleted(ctx context.Context, sessionID, reservationID, userID, customerID, subscriptionID string) (bool, error)
	UpsertSubscription(ctx context.Context, sub store.Subscription) error
	UpsertAttributedSubscription(ctx context.Context, customerID string, sub store.Subscription) error
	MarkSubscriptionPastDue(ctx context.Context, subscriptionID string, eventCreated int64) error
	UserIDBySubscription(ctx context.Context, subscriptionID string) (string, error)
	AccountAccess(ctx context.Context, userID string) (store.AccountStatus, error)
}

var errStripeSubscriptionNotReady = errors.New("stripe subscription mapping is not ready")

// invoiceSubscriptionID digs the subscription out of an invoice. As of API
// version 2025-xx the link moved from invoice.subscription to
// invoice.parent.subscription_details, so reading the old field silently returns
// nothing.
func invoiceSubscriptionID(invoice *stripe.Invoice) string {
	if invoice.Parent == nil || invoice.Parent.SubscriptionDetails == nil {
		return ""
	}
	if sub := invoice.Parent.SubscriptionDetails.Subscription; sub != nil {
		return sub.ID
	}
	return ""
}

func (a *api) checkoutSubscription(value *stripe.Subscription) (*stripe.Subscription, error) {
	if value == nil || value.ID == "" {
		return nil, nil
	}
	if value.Status != "" && value.Items != nil && len(value.Items.Data) > 0 {
		return value, nil
	}
	retrieve := a.stripeSubscription
	if retrieve == nil {
		retrieve = billing.RetrieveSubscription
	}
	return retrieve(value.ID)
}

// stripeSubscriptionUser resolves every available identity source before any
// webhook mutation. Customer mapping, subscription metadata, and an existing
// subscription row must agree. A mismatch stays retryable for operator repair
// instead of silently moving billing history or entitlement between users.
func (a *api) stripeSubscriptionUser(
	ctx context.Context,
	sub *stripe.Subscription,
) (string, error) {
	identities := make([]string, 0, 3)
	if sub.Customer != nil {
		userID, err := a.wh.UserIDByStripeCustomer(ctx, sub.Customer.ID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return "", err
		}
		if err == nil && userID != "" {
			identities = append(identities, userID)
		}
	}
	if metadataUserID := strings.TrimSpace(sub.Metadata["user_id"]); metadataUserID != "" {
		identities = append(identities, metadataUserID)
	}
	if sub.ID != "" {
		userID, err := a.wh.UserIDBySubscription(ctx, sub.ID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return "", err
		}
		if err == nil && userID != "" {
			identities = append(identities, userID)
		}
	}
	if len(identities) == 0 {
		return "", nil
	}
	userID := identities[0]
	for _, identity := range identities[1:] {
		if identity != userID {
			return "", store.ErrConflict
		}
	}
	account, err := a.wh.AccountAccess(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if account.State == store.AccountDeleted {
		return "", nil
	}
	return userID, nil
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
		// Clerk event bodies do not always carry a top-level id. svix-id is the
		// verified delivery identity and must be used instead of collapsing every
		// event of one type onto the same fallback key.
		eventID = r.Header.Get("svix-id")
	}
	if eventID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "missing webhook event id"})
		return
	}

	var identity struct {
		ID     string `json:"id"`
		UserID string `json:"user_id"`
	}
	_ = json.Unmarshal(evt.Data, &identity)
	eventUserID := identity.UserID
	if strings.HasPrefix(evt.Type, "user.") {
		eventUserID = identity.ID
	}
	claimUserID := eventUserID
	if strings.HasPrefix(evt.Type, "user.") {
		// The identity row may not exist until this delivery is processed. Claim
		// without the FK, then associate after the upsert or known deletion.
		claimUserID = ""
	}
	claim, done, err := a.wh.ClaimWebhookEvent(
		r.Context(), eventID, "clerk", evt.Type, claimUserID, body,
	)
	if err != nil {
		a.fail(w, err)
		return
	}
	if done {
		writeJSON(w, 200, map[string]string{"status": "already processed"})
		return
	}
	var procErr error
	associated := false
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
		if procErr == nil {
			procErr = a.wh.AssociateWebhookEvent(r.Context(), "clerk", eventID, claim, wrapper.ID)
			associated = procErr == nil
		}
		if procErr == nil && evt.Type == "user.created" {
			procErr = a.wh.CreateDefaultWorkspace(r.Context(), wrapper.ID)
		}
	case "user.deleted":
		// The identity was removed outside the app (Clerk dashboard, or our own
		// purge job finishing the job). Enter the same deletion flow with no
		// reactivation window, since the user can no longer sign in to claim it.
		var data struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(evt.Data, &data); err != nil {
			procErr = err
			break
		}
		procErr = a.wh.MarkIdentityDeleted(r.Context(), data.ID)
		if errors.Is(procErr, store.ErrNotFound) {
			// Clerk may delete an identity before its first successful app request
			// provisioned a local row. There is no local data to purge, so retrying
			// this event forever cannot improve the outcome.
			procErr = nil
		} else if procErr == nil {
			procErr = a.wh.AssociateWebhookEvent(r.Context(), "clerk", eventID, claim, data.ID)
			associated = procErr == nil
		}
	}
	if procErr == nil && !associated {
		procErr = a.wh.RedactWebhookEvent(r.Context(), "clerk", eventID, claim)
	}

	if err := a.wh.MarkWebhookProcessed(r.Context(), "clerk", eventID, claim, procErr); err != nil {
		a.fail(w, err)
		return
	}
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

	claim, done, err := a.wh.ClaimWebhookEvent(
		r.Context(), event.ID, "stripe", string(event.Type), "", event.Data.Raw,
	)
	if err != nil {
		a.fail(w, err)
		return
	}
	if done {
		writeJSON(w, 200, map[string]string{"status": "already processed"})
		return
	}
	var procErr error
	associated := false
	switch event.Type {
	case "checkout.session.completed":
		var sess stripe.CheckoutSession
		if err := json.Unmarshal(event.Data.Raw, &sess); err != nil {
			procErr = err
			break
		}
		userID := sess.Metadata["user_id"]
		customerID := ""
		if sess.Customer != nil {
			customerID = sess.Customer.ID
			mappedUserID, lookupErr := a.wh.UserIDByStripeCustomer(r.Context(), customerID)
			procErr = lookupErr
			if errors.Is(procErr, store.ErrNotFound) {
				procErr = nil
				if userID == "" {
					// Every application-created Checkout Session carries user_id. A
					// metadata-free session whose customer is unknown is not recoverable.
					break
				}
			}
			if procErr != nil {
				break
			}
			if mappedUserID != "" {
				if userID != "" && userID != mappedUserID {
					procErr = store.ErrConflict
					break
				}
				userID = mappedUserID
			}
		}
		if userID == "" {
			break
		}
		if _, accessErr := a.wh.AccountAccess(r.Context(), userID); errors.Is(accessErr, store.ErrNotFound) {
			// Application user rows are durable tombstones. Missing metadata can
			// therefore never become valid on a later delivery.
			break
		} else if accessErr != nil {
			procErr = accessErr
			break
		}
		subscriptionID := ""
		if sess.Subscription != nil {
			subscriptionID = sess.Subscription.ID
		}
		var lifecycleAllowed bool
		lifecycleAllowed, procErr = a.wh.RecordStripeCheckoutCompleted(
			r.Context(), sess.ID, sess.Metadata["checkout_reservation_id"],
			userID, customerID, subscriptionID,
		)
		if procErr != nil {
			break
		}
		if procErr = a.wh.AssociateWebhookEvent(r.Context(), "stripe", event.ID, claim, userID); procErr != nil {
			break
		}
		associated = true
		if !lifecycleAllowed {
			break
		}
		// The tier is recorded here too, not just on the subscription events.
		// Linking the customer alone used to leave a paying user on free limits
		// until customer.subscription.created happened to arrive, and Stripe does
		// not order the two.
		if sess.Subscription != nil {
			var subscription *stripe.Subscription
			subscription, procErr = a.checkoutSubscription(sess.Subscription)
			if procErr == nil && subscription != nil {
				procErr = a.wh.UpsertSubscription(r.Context(), billing.SubscriptionRecord(
					subscription, userID, a.cfg.StripePricePro, event.Created))
			}
		}
	case "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted":
		var sub stripe.Subscription
		if err := json.Unmarshal(event.Data.Raw, &sub); err != nil {
			procErr = err
			break
		}
		userID, resolveErr := a.stripeSubscriptionUser(r.Context(), &sub)
		procErr = resolveErr
		if procErr != nil {
			break
		}
		if userID == "" {
			break
		}
		record := billing.SubscriptionRecord(&sub, userID, a.cfg.StripePricePro, event.Created)
		if event.Type == "customer.subscription.deleted" {
			// Stripe reports the status at deletion, which for an immediate
			// cancellation can still read active. The event is the authority.
			record.Status = "canceled"
			// Keep the product tier on the historical subscription row. User plan
			// projection considers only live periods, while lifecycle grace needs
			// to know that the closed period was paid.
		}
		customerID := ""
		if sub.Customer != nil {
			customerID = sub.Customer.ID
		}
		procErr = a.wh.UpsertAttributedSubscription(r.Context(), customerID, record)
		if procErr == nil {
			procErr = a.wh.AssociateWebhookEvent(
				r.Context(), "stripe", event.ID, claim, userID,
			)
			associated = procErr == nil
		}
	case "invoice.payment_failed":
		// The first signal that entitlement is about to lapse. Nothing used to
		// handle it, so past_due was written by subscription updates and then
		// never read for enforcement anywhere.
		var invoice stripe.Invoice
		if err := json.Unmarshal(event.Data.Raw, &invoice); err != nil {
			procErr = err
			break
		}
		if subID := invoiceSubscriptionID(&invoice); subID != "" {
			userID, lookupErr := a.wh.UserIDBySubscription(r.Context(), subID)
			if lookupErr != nil && !errors.Is(lookupErr, store.ErrNotFound) {
				procErr = lookupErr
				break
			}
			if errors.Is(lookupErr, store.ErrNotFound) {
				// Stripe does not order invoice and subscription deliveries. A known
				// live customer can therefore be missing only the subscription row;
				// leave this event retryable until that row arrives. An unknown
				// customer has no local owner, while a purged customer is a permanent
				// tombstone, so neither can become actionable on a later delivery.
				customerID := ""
				if invoice.Customer != nil {
					customerID = invoice.Customer.ID
				}
				if customerID == "" {
					procErr = errStripeSubscriptionNotReady
					break
				}
				userID, lookupErr = a.wh.UserIDByStripeCustomer(r.Context(), customerID)
				if errors.Is(lookupErr, store.ErrNotFound) || (lookupErr == nil && userID == "") {
					break
				}
				if lookupErr != nil {
					procErr = lookupErr
					break
				}
				account, accessErr := a.wh.AccountAccess(r.Context(), userID)
				if accessErr != nil {
					procErr = accessErr
					break
				}
				if account.State == store.AccountDeleted {
					break
				}
				if procErr = a.wh.AssociateWebhookEvent(r.Context(), "stripe", event.ID, claim, userID); procErr != nil {
					break
				}
				associated = true
				procErr = errStripeSubscriptionNotReady
				break
			}
			if userID != "" {
				account, accessErr := a.wh.AccountAccess(r.Context(), userID)
				if errors.Is(accessErr, store.ErrNotFound) ||
					(accessErr == nil && account.State == store.AccountDeleted) {
					break
				}
				if accessErr != nil {
					procErr = accessErr
					break
				}
				if procErr = a.wh.AssociateWebhookEvent(r.Context(), "stripe", event.ID, claim, userID); procErr != nil {
					break
				}
				associated = true
			}
			procErr = a.wh.MarkSubscriptionPastDue(r.Context(), subID, event.Created)
		}
	}
	if procErr == nil && !associated {
		procErr = a.wh.RedactWebhookEvent(r.Context(), "stripe", event.ID, claim)
	}

	if err := a.wh.MarkWebhookProcessed(r.Context(), "stripe", event.ID, claim, procErr); err != nil {
		a.fail(w, err)
		return
	}
	if procErr != nil {
		a.fail(w, procErr)
		return
	}
	writeJSON(w, 200, map[string]string{"status": "ok"})
}
