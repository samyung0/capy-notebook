package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/stripe/stripe-go/v82"
	"github.com/stripe/stripe-go/v82/webhook"
	svix "github.com/svix/svix-webhooks/go"

	"github.com/samyung0/capy-notebook/server/internal/billing"
	"github.com/samyung0/capy-notebook/server/internal/obs"
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
	GrantTopUp(ctx context.Context, userID, checkoutSessionID, paymentIntentID string, amountCents int64) (bool, []string, error)
	MarkReloadVoid(ctx context.Context, invoiceID string) error
	SavePaymentMethod(ctx context.Context, userID string, pm store.PaymentMethod, onlyIfNone bool) error
	MarkReloadPaid(ctx context.Context, purchaseID, invoiceID, paymentIntentID string) error
	MarkReloadFailed(ctx context.Context, purchaseID, invoiceID string, nextAttempt time.Time, declineReason string) error
	ReverseRefund(ctx context.Context, paymentIntentID string, refundedCents, chargedCents int64) (string, error)
	HoldDispute(ctx context.Context, paymentIntentID string) (string, error)
	ReleaseDispute(ctx context.Context, paymentIntentID string) (string, error)
	RetryingReloadInvoices(ctx context.Context, userID string) ([]string, error)
	ReloadRetryUnwanted(ctx context.Context, invoiceID string) (bool, error)
	ArmReload(ctx context.Context, userID string) error
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

// failWebhookClaim answers a delivery whose event another delivery is still
// processing with 409, which Svix and Stripe both retry later. It is not a
// server failure: the first delivery either completes the event, so the retry
// answers "already processed", or clears its lease on failure so the retry
// claims it. Answering 200 instead would lose the event if that first delivery
// fails after the provider stopped waiting for it.
func (a *api) failWebhookClaim(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrWebhookInProgress) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":    "webhook_in_progress",
			"message": "this event is already being processed; retry later",
		})
		return
	}
	a.fail(w, err)
}

// webhookBodyMaxBytes bounds what an unauthenticated delivery may send before
// its signature is checked; Clerk and Stripe events are far smaller.
const webhookBodyMaxBytes = 1 << 20

// readWebhookBody reads a delivery under webhookBodyMaxBytes, or answers 413
// (400, logged, for a body that could not be read) and reports false.
func readWebhookBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, webhookBodyMaxBytes))
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"message": "body too large"})
	case err != nil:
		// A dropped or stalled upload is the client's failure, not a 500; the
		// log keeps it visible and the provider retries the delivery.
		obs.Log(r.Context()).Warn("webhook body unreadable", "path", r.URL.Path, "error", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "read body"})
	default:
		return body, true
	}
	return nil, false
}

func (a *api) clerkWebhook(w http.ResponseWriter, r *http.Request) {
	if a.cfg.ClerkWebhookSecret == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"message": "webhook not configured"})
		return
	}
	body, ok := readWebhookBody(w, r)
	if !ok {
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
		a.failWebhookClaim(w, err)
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
			HasImage *bool   `json:"has_image"`
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
		if wrapper.ImageURL != nil && (wrapper.HasImage == nil || *wrapper.HasImage) {
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
	body, ok := readWebhookBody(w, r)
	if !ok {
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
		a.failWebhookClaim(w, err)
		return
	}
	if done {
		writeJSON(w, 200, map[string]string{"status": "already processed"})
		return
	}
	var procErr error
	associated := false
	switch event.Type {
	case "checkout.session.async_payment_succeeded":
		// A top-up whose payment settled after Checkout completed.
		var sess stripe.CheckoutSession
		if err := json.Unmarshal(event.Data.Raw, &sess); err != nil {
			procErr = err
			break
		}
		associated, procErr = a.creditCheckoutCompleted(r.Context(), &sess, event.ID, claim)
	case "checkout.session.completed":
		var sess stripe.CheckoutSession
		if err := json.Unmarshal(event.Data.Raw, &sess); err != nil {
			procErr = err
			break
		}
		if sess.Mode == stripe.CheckoutSessionModePayment || sess.Mode == stripe.CheckoutSessionModeSetup {
			associated, procErr = a.creditCheckoutCompleted(r.Context(), &sess, event.ID, claim)
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
	case "invoice.paid":
		var invoice stripe.Invoice
		if err := json.Unmarshal(event.Data.Raw, &invoice); err != nil {
			procErr = err
			break
		}
		if invoiceSubscriptionID(&invoice) != "" {
			procErr = a.subscriptionInvoicePaid(r.Context(), &invoice)
			break
		}
		procErr = a.reloadInvoiceChanged(r.Context(), &invoice)
	case "charge.refunded":
		var charge stripe.Charge
		if err := json.Unmarshal(event.Data.Raw, &charge); err != nil {
			procErr = err
			break
		}
		if charge.PaymentIntent != nil {
			var userID string
			userID, procErr = a.wh.ReverseRefund(r.Context(), charge.PaymentIntent.ID, charge.AmountRefunded, charge.Amount)
			a.publishBillingChanged(r.Context(), userID)
		}
	case "charge.dispute.created", "charge.dispute.closed":
		var dispute stripe.Dispute
		if err := json.Unmarshal(event.Data.Raw, &dispute); err != nil {
			procErr = err
			break
		}
		if dispute.PaymentIntent == nil {
			break
		}
		// An inquiry (warning_*) withdraws no funds, so it takes no credits.
		inquiry := strings.HasPrefix(string(dispute.Status), "warning_")
		var userID string
		switch {
		case event.Type == "charge.dispute.created" && !inquiry:
			userID, procErr = a.wh.HoldDispute(r.Context(), dispute.PaymentIntent.ID)
		case dispute.Status == stripe.DisputeStatusWon:
			userID, procErr = a.wh.ReleaseDispute(r.Context(), dispute.PaymentIntent.ID)
		}
		a.publishBillingChanged(r.Context(), userID)
	case "invoice.payment_failed":
		// The first signal that entitlement is about to lapse. Nothing used to
		// handle it, so past_due was written by subscription updates and then
		// never read for enforcement anywhere.
		var invoice stripe.Invoice
		if err := json.Unmarshal(event.Data.Raw, &invoice); err != nil {
			procErr = err
			break
		}
		if invoiceSubscriptionID(&invoice) == "" {
			procErr = a.reloadInvoiceChanged(r.Context(), &invoice)
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

// creditCheckoutCompleted handles the two credit Checkouts: a paid top-up
// (credit it, save its card when none is saved, void reloads Stripe is still
// retrying) and the setup session that saves the auto-reload card.
func (a *api) creditCheckoutCompleted(
	ctx context.Context, sess *stripe.CheckoutSession, eventID, claim string,
) (bool, error) {
	kind := sess.Metadata["kind"]
	if (kind != billing.KindTopUp && kind != billing.KindReloadMethod) || sess.Customer == nil {
		return false, nil
	}
	userID, err := a.wh.UserIDByStripeCustomer(ctx, sess.Customer.ID)
	if errors.Is(err, store.ErrNotFound) {
		// Credit Checkouts open only for a bound customer; an unknown one is
		// another lane's event.
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if meta := sess.Metadata["user_id"]; meta != "" && meta != userID {
		return false, store.ErrConflict
	}
	if err := a.wh.AssociateWebhookEvent(ctx, "stripe", eventID, claim, userID); err != nil {
		return false, err
	}
	if kind == billing.KindReloadMethod {
		if sess.SetupIntent == nil {
			return true, nil
		}
		pm, err := a.stripeSetupMethod(sess.SetupIntent.ID)
		if err != nil {
			return true, err
		}
		if err := a.wh.SavePaymentMethod(ctx, userID, pm, false); err != nil {
			return true, err
		}
		// A new card ends Stripe's retries of the old one.
		retrying, err := a.wh.RetryingReloadInvoices(ctx, userID)
		if err != nil {
			return true, err
		}
		return true, a.voidReloadsAndPublish(ctx, userID, retrying)
	}
	// Top-ups accept instant methods only, so a completed session is paid.
	if sess.PaymentStatus != stripe.CheckoutSessionPaymentStatusPaid || sess.PaymentIntent == nil {
		return true, nil
	}
	_, retrying, err := a.wh.GrantTopUp(ctx, userID, sess.ID, sess.PaymentIntent.ID, sess.AmountSubtotal)
	if err != nil {
		return true, err
	}
	pm, err := a.stripeTopUpMethod(sess.PaymentIntent.ID)
	if err != nil {
		return true, err
	}
	if err := a.wh.SavePaymentMethod(ctx, userID, pm, true); err != nil {
		return true, err
	}
	return true, a.voidReloadsAndPublish(ctx, userID, retrying)
}

// voidReloadsAndPublish ends the retries a top-up or new card replaces, then
// tells the user's open tabs to refetch billing.
func (a *api) voidReloadsAndPublish(ctx context.Context, userID string, invoiceIDs []string) error {
	if err := a.voidReloads(ctx, invoiceIDs); err != nil {
		return err
	}
	a.publishBillingChanged(ctx, userID)
	return nil
}

// voidReloads cancels Stripe's retries of reload invoices: after a top-up, a
// new card, or auto-reload turned off.
func (a *api) voidReloads(ctx context.Context, invoiceIDs []string) error {
	for _, invoiceID := range invoiceIDs {
		if err := a.stripeVoidInvoice(invoiceID); err != nil {
			return err
		}
		if err := a.wh.MarkReloadVoid(ctx, invoiceID); err != nil {
			return err
		}
	}
	return nil
}

// subscriptionInvoicePaid re-arms auto-reload after a paid Pro invoice; a
// zero-amount invoice buys nothing and arms nothing.
func (a *api) subscriptionInvoicePaid(ctx context.Context, inv *stripe.Invoice) error {
	if inv.AmountPaid <= 0 || inv.Customer == nil {
		return nil
	}
	userID, err := a.wh.UserIDByStripeCustomer(ctx, inv.Customer.ID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := a.wh.ArmReload(ctx, userID); err != nil {
		return err
	}
	a.publishBillingChanged(ctx, userID)
	return nil
}

// reloadInvoiceChanged records a reload invoice's payment state from Stripe:
// paid credits it (once), failed records Stripe's next attempt or that it
// stopped retrying.
func (a *api) reloadInvoiceChanged(ctx context.Context, inv *stripe.Invoice) error {
	if inv.Metadata["kind"] != billing.KindReload {
		return nil
	}
	outcome, err := a.stripeReloadOutcome(inv.ID)
	if err != nil {
		return err
	}
	purchaseID := inv.Metadata["purchase_id"]
	switch {
	case outcome.Paid:
		err = a.wh.MarkReloadPaid(ctx, purchaseID, inv.ID, outcome.PaymentIntentID)
	case outcome.Processing:
		return nil
	default:
		err = a.wh.MarkReloadFailed(ctx, purchaseID, inv.ID, outcome.NextAttempt, outcome.DeclineReason)
		// Turned off or given a new card while it charged: void it as they would have.
		var unwanted bool
		if err == nil {
			unwanted, err = a.wh.ReloadRetryUnwanted(ctx, inv.ID)
		}
		if unwanted {
			err = a.voidReloads(ctx, []string{inv.ID})
		}
	}
	if err != nil || inv.Customer == nil {
		return err
	}
	if userID, err := a.wh.UserIDByStripeCustomer(ctx, inv.Customer.ID); err == nil {
		a.publishBillingChanged(ctx, userID)
	}
	return nil
}
