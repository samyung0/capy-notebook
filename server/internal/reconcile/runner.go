package reconcile

import (
	"context"
	"errors"
	"time"

	"github.com/stripe/stripe-go/v82"

	"github.com/samyung0/capy-notebook/server/internal/billing"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

const leaseDuration = time.Hour
const leaseHeartbeatInterval = 5 * time.Minute

type Config struct {
	StripeSecretKey string
	StripePricePro  string
}

type Runner struct {
	store  *store.Store
	config Config
}

type subscriptionCleanupDecision struct {
	suppress bool
	refund   bool
	cancel   bool
}

func decideSubscriptionCleanup(canceled, cancelAtPeriodEnd bool) subscriptionCleanupDecision {
	if canceled && cancelAtPeriodEnd {
		// Stripe can retain cancel_at_period_end on an already-canceled
		// subscription. That is terminal provider truth, not a reason to suppress
		// the local tombstone or refund a period the customer already consumed.
		return subscriptionCleanupDecision{}
	}
	if cancelAtPeriodEnd {
		return subscriptionCleanupDecision{suppress: true}
	}
	return subscriptionCleanupDecision{refund: true, cancel: !canceled}
}

func NewRunner(st *store.Store, config Config) *Runner {
	if config.StripeSecretKey != "" {
		billing.Init(billing.Config{SecretKey: config.StripeSecretKey})
	}
	return &Runner{store: st, config: config}
}

func (r *Runner) EnqueueDaily(ctx context.Context, now time.Time) error {
	slot := time.Date(
		now.UTC().Year(), now.UTC().Month(), now.UTC().Day(),
		0, 0, 0, 0, time.UTC,
	)
	if _, _, err := r.store.EnqueueScheduledReconciliation(
		ctx, store.ReconcileJobStorage, slot,
	); err != nil {
		return err
	}
	if r.config.StripeSecretKey != "" {
		if _, _, err := r.store.EnqueueScheduledReconciliation(
			ctx, store.ReconcileJobStripe, slot,
		); err != nil {
			return err
		}
	}
	return nil
}

// RunNext claims and executes one pending run. The boolean is false when the
// queue is empty.
func (r *Runner) RunNext(ctx context.Context) (bool, error) {
	run, err := r.store.ClaimReconciliationRun(ctx, leaseDuration)
	if err != nil || run == nil {
		return false, err
	}

	runCtx, cancel := context.WithCancel(ctx)
	heartbeatDone := make(chan error, 1)
	go func() {
		err := r.heartbeat(runCtx, *run)
		if err != nil {
			cancel()
		}
		heartbeatDone <- err
	}()
	result, runErr := r.execute(runCtx, *run)
	cancel()
	if heartbeatErr := <-heartbeatDone; heartbeatErr != nil {
		runErr = heartbeatErr
	}
	if runErr != nil {
		eventID := obs.CaptureErr(ctx, runErr, map[string]string{
			"stage": "reconciliation",
			"job":   run.JobType,
		})
		runErr = obs.WithEventID(runErr, eventID)
		result.Status = store.ReconcileStatusFailed
		result.ErrorCount++
		result.Error = "reconciliation failed"
	}
	if err := r.store.FinishReconciliationRun(ctx, *run, result); err != nil {
		return true, err
	}
	return true, runErr
}

func (r *Runner) heartbeat(ctx context.Context, run store.ReconcileRun) error {
	ticker := time.NewTicker(leaseHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := r.store.RenewReconciliationLease(
				ctx,
				run,
				leaseDuration,
			); err != nil {
				return err
			}
		}
	}
}

func (r *Runner) Drain(ctx context.Context) error {
	var joined error
	for {
		ran, err := r.RunNext(ctx)
		if err != nil {
			joined = errors.Join(joined, err)
		}
		if !ran {
			return joined
		}
	}
}

func (r *Runner) execute(
	ctx context.Context,
	run store.ReconcileRun,
) (store.ReconcileResult, error) {
	switch run.JobType {
	case store.ReconcileJobStorage:
		scanned, repaired, errorCount, err := r.store.ReconcileStorage(ctx, run)
		result := store.ReconcileResult{
			Status:        store.ReconcileStatusSucceeded,
			ScannedCount:  scanned,
			RepairedCount: repaired,
			ErrorCount:    errorCount,
		}
		if errorCount > 0 {
			result.Status = store.ReconcileStatusPartial
		}
		return result, err
	case store.ReconcileJobStripe:
		return r.reconcileStripe(ctx, run)
	default:
		return store.ReconcileResult{}, errors.New("unsupported reconciliation job")
	}
}

func (r *Runner) reconcileStripe(
	ctx context.Context,
	run store.ReconcileRun,
) (store.ReconcileResult, error) {
	result := store.ReconcileResult{Status: store.ReconcileStatusSucceeded}
	if r.config.StripeSecretKey == "" {
		return result, errors.New("Stripe reconciliation is not configured")
	}
	customers, err := r.store.ListStripeCustomers(ctx)
	if err != nil {
		return result, err
	}
	if err := r.reconcileCredits(ctx, run, &result); err != nil {
		return result, err
	}
	for _, customer := range customers {
		result.ScannedCount++
		changed, live, err := r.reconcileStripeCustomer(ctx, run, customer)
		if err != nil {
			result.ErrorCount++
			result.Status = store.ReconcileStatusPartial
			obs.CaptureErr(ctx, err, map[string]string{
				"stage":  "stripe_reconciliation_sync",
				"userId": customer.UserID,
			})
			if reportErr := r.store.InsertReconciliationReport(
				ctx, run, "stripe_customer_error", "user",
				customer.UserID, customer.UserID,
				map[string]any{"outcome": "error", "stage": "read_or_sync"},
			); reportErr != nil {
				return result, reportErr
			}
			continue
		}
		if !changed {
			continue
		}
		result.RepairedCount++
		metadata := map[string]any{
			"outcome":           "repaired",
			"customerId":        customer.CustomerID,
			"subscriptionCount": len(live),
		}
		if len(live) == 0 {
			metadata["subscriptionStatus"] = "none"
		} else {
			subscriptionIDs := make([]string, 0, len(live))
			for _, subscription := range live {
				subscriptionIDs = append(subscriptionIDs, subscription.StripeSubscriptionID)
			}
			metadata["subscriptionIds"] = subscriptionIDs
		}
		if err := r.store.InsertReconciliationReport(
			ctx, run, "stripe_subscription_drift", "user",
			customer.UserID, customer.UserID, metadata,
		); err != nil {
			return result, err
		}
	}
	return result, nil
}

// topUpLookback covers Stripe's own webhook redelivery window (3 days) with
// room for a missed daily run.
const topUpLookback = 7 * 24 * time.Hour

// reconcileCredits settles credit purchases whose webhooks never arrived:
// reload invoices are re-read and recorded paid, void, retrying or failed, and
// paid top-up Checkouts are credited (GrantTopUp is idempotent per session).
// A per-purchase failure is reported and the run carries on.
func (r *Runner) reconcileCredits(
	ctx context.Context,
	run store.ReconcileRun,
	result *store.ReconcileResult,
) error {
	// fail reports per user, or per payment when the user is unknown.
	fail := func(err error, userID, purchase string) error {
		result.ErrorCount++
		result.Status = store.ReconcileStatusPartial
		obs.CaptureErr(ctx, err, map[string]string{"stage": "stripe_credit_reconciliation", "userId": userID})
		subjectType, subjectID := "user", userID
		if userID == "" {
			subjectType, subjectID = "payment", purchase
		}
		return r.store.InsertReconciliationReport(ctx, run, "stripe_credit_error", subjectType,
			subjectID, userID, map[string]any{"outcome": "error", "purchase": purchase})
	}
	repaired := func(userID string, metadata map[string]any) error {
		result.RepairedCount++
		metadata["outcome"] = "repaired"
		return r.store.InsertReconciliationReport(ctx, run, "stripe_credit_drift", "user",
			userID, userID, metadata)
	}

	reloads, err := r.store.UnsettledReloads(ctx)
	if err != nil {
		return err
	}
	for _, p := range reloads {
		result.ScannedCount++
		out, err := billing.ReloadOutcome(p.InvoiceID)
		status := p.Status
		switch {
		case err != nil:
		case out.Paid:
			status, err = "paid", r.store.MarkReloadPaid(ctx, p.ID, p.InvoiceID, out.PaymentIntentID)
		case out.Void:
			status, err = "void", r.store.MarkReloadVoid(ctx, p.InvoiceID)
		case out.Processing:
		case out.NextAttempt.IsZero():
			status, err = "failed", r.store.MarkReloadFailed(ctx, p.ID, p.InvoiceID, out.NextAttempt, out.DeclineReason)
		default:
			status, err = "retrying", r.store.MarkReloadFailed(ctx, p.ID, p.InvoiceID, out.NextAttempt, out.DeclineReason)
		}
		if err != nil {
			if reportErr := fail(err, p.UserID, p.ID); reportErr != nil {
				return reportErr
			}
			continue
		}
		if status != p.Status {
			if err := repaired(p.UserID, map[string]any{
				"purchase": p.ID, "kind": "reload", "from": p.Status, "to": status,
			}); err != nil {
				return err
			}
		}
	}

	topUps, err := billing.ListPaidTopUps(time.Now().Add(-topUpLookback))
	if err != nil {
		return err
	}
	for _, t := range topUps {
		result.ScannedCount++
		userID, err := r.store.UserIDByStripeCustomer(ctx, t.CustomerID)
		if errors.Is(err, store.ErrNotFound) {
			continue // another lane's customer
		}
		if err == nil && t.UserID != "" && t.UserID != userID {
			err = store.ErrConflict
		}
		var granted bool
		var retrying []string
		if err == nil {
			granted, retrying, err = r.store.GrantTopUp(ctx, userID, t.SessionID, t.PaymentIntentID, t.AmountCents)
		}
		for _, invoiceID := range retrying {
			if !granted || err != nil {
				break
			}
			if err = billing.VoidInvoice(invoiceID); err == nil {
				err = r.store.MarkReloadVoid(ctx, invoiceID)
			}
		}
		if err != nil {
			if reportErr := fail(err, userID, t.SessionID); reportErr != nil {
				return reportErr
			}
			continue
		}
		if granted {
			if err := repaired(userID, map[string]any{"session": t.SessionID, "kind": "topup"}); err != nil {
				return err
			}
		}
	}

	// After the grants above, so a purchase recorded late is there to adjust.
	reversals, err := billing.ListReversals(time.Now().Add(-topUpLookback))
	if err != nil {
		return err
	}
	for _, v := range reversals {
		var userID string
		// The same calls the webhooks make; an inquiry moves no funds.
		switch v.Dispute {
		case "":
			userID, err = r.store.ReverseRefund(ctx, v.PaymentIntentID, v.RefundedCents, v.ChargedCents)
		case stripe.DisputeStatusNeedsResponse, stripe.DisputeStatusUnderReview, stripe.DisputeStatusLost:
			userID, err = r.store.HoldDispute(ctx, v.PaymentIntentID)
		case stripe.DisputeStatusWon:
			userID, err = r.store.ReleaseDispute(ctx, v.PaymentIntentID)
		default:
			continue
		}
		result.ScannedCount++
		if err != nil {
			if reportErr := fail(err, "", v.PaymentIntentID); reportErr != nil {
				return reportErr
			}
			continue
		}
		if userID != "" {
			if err := repaired(userID, map[string]any{
				"paymentIntent": v.PaymentIntentID, "kind": "reversal", "dispute": string(v.Dispute),
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

func (r *Runner) reconcileStripeCustomer(
	ctx context.Context,
	run store.ReconcileRun,
	customer store.StripeCustomer,
) (bool, []store.Subscription, error) {
	for range 3 {
		version, err := r.store.SubscriptionVersion(ctx, customer.UserID)
		if err != nil {
			return false, nil, err
		}
		readStartedAt := time.Now().UTC()
		subscriptions, err := billing.ListEntitlingSubscriptions(customer.CustomerID)
		if err != nil {
			return false, nil, err
		}
		live := make([]store.Subscription, 0, len(subscriptions))
		for _, subscription := range subscriptions {
			live = append(live, billing.SubscriptionRecord(
				subscription,
				customer.UserID,
				r.config.StripePricePro,
				readStartedAt.Unix(),
			))
		}
		changed, err := r.store.SyncSubscriptionsFromStripe(
			ctx,
			customer.UserID,
			live,
			version,
			readStartedAt.Unix(),
			&run,
		)
		if errors.Is(err, store.ErrReconciliationStale) {
			continue
		}
		return changed, live, err
	}
	return false, nil, store.ErrReconciliationStale
}

// RunNextStripeCompensation executes one durable remote cleanup. Each remote
// mutation is idempotent (or preceded by a state read), and failures are put
// back with backoff by FinishStripeCompensation.
func (r *Runner) RunNextStripeCompensation(ctx context.Context) (bool, error) {
	if r.config.StripeSecretKey == "" {
		return false, nil
	}
	job, err := r.store.ClaimStripeCompensation(ctx, time.Minute)
	if err != nil || job == nil {
		return false, err
	}
	release, allowed, err := r.store.BeginStripeCompensation(ctx, *job)
	if err != nil {
		return true, err
	}
	if !allowed {
		return true, nil
	}
	defer release()
	var runErr error
	advanceRefundGeneration := false
	refundPending := false
	switch job.Action {
	case store.StripeRecoverCheckout:
		var recovery store.StripeCheckoutRecovery
		recovery, runErr = r.store.StripeCheckoutRecovery(ctx, job.ObjectID)
		if runErr == nil && recovery.CustomerID == "" {
			recovery.CustomerID, runErr = billing.CreateCustomer(
				recovery.Email,
				recovery.Name,
				recovery.UserID,
				"checkout-customer-"+recovery.ID,
			)
		}
		var session billing.CheckoutSession
		if runErr == nil {
			session, runErr = billing.CreateCheckoutSession(
				recovery.CustomerID,
				recovery.PriceID,
				recovery.UserID,
				recovery.SuccessURL,
				recovery.CancelURL,
				recovery.ID,
				"checkout-session-"+recovery.ID,
			)
		}
		if runErr == nil {
			runErr = billing.ExpireCheckoutSession(session.ID)
		}
		if runErr == nil {
			runErr = r.store.CompleteStripeCheckoutRecovery(
				ctx,
				recovery.ID,
				recovery.CustomerID,
				session.ID,
			)
		}
	case store.StripeExpireCheckout:
		runErr = billing.ExpireCheckoutSession(job.ObjectID)
	case store.StripeCancelSubscription:
		var action store.StripeCompensationAction
		var objectID string
		var canceled, cancelAtPeriodEnd bool
		runErr = r.store.MarkStripeCompensationProviderStarted(ctx, *job)
		if runErr == nil {
			action, objectID, canceled, cancelAtPeriodEnd, runErr =
				billing.SubscriptionRefundTarget(job.ObjectID)
		}
		decision := decideSubscriptionCleanup(canceled, cancelAtPeriodEnd)
		// The provider read is authoritative here. A delayed webhook may leave
		// cancel_at_period_end=false locally even though Stripe already accepted
		// an end-of-period cancellation on a still-live subscription. Do not turn
		// that harmless lag into an immediate cancellation, refund, or terminal
		// local tombstone.
		if runErr == nil && decision.suppress {
			runErr = r.store.SuppressStripeCancellationAtPeriodEnd(ctx, *job)
			if runErr == nil {
				return true, nil
			}
		}
		if runErr == nil && decision.refund && objectID != "" {
			runErr = r.store.EnqueueStripeCompensation(ctx, job.UserID, action, objectID)
		}
		if runErr == nil && decision.cancel {
			runErr = billing.CancelSubscription(job.ObjectID)
		}
	case store.StripeRefundPayment, store.StripeRefundCharge:
		var result billing.RefundResult
		if job.ProviderResultID == "" {
			result, runErr = billing.CreateRefund(job.Action, job.ObjectID, job.Generation)
			if runErr == nil {
				runErr = r.store.SetStripeCompensationProviderResult(ctx, *job, result.ID)
			}
		} else {
			result, runErr = billing.GetRefund(job.ProviderResultID)
		}
		if runErr == nil {
			switch result.Status {
			case "succeeded":
			case "failed", "canceled":
				runErr = errors.New("Stripe refund reached a failed terminal state")
				advanceRefundGeneration = true
			case "pending":
				runErr = errors.New("Stripe refund is not terminal")
				refundPending = true
			default:
				runErr = errors.New("Stripe refund requires operator attention")
			}
		}
	default:
		runErr = errors.New("unsupported Stripe compensation action")
	}
	if runErr != nil && !refundPending {
		eventID := obs.CaptureErr(ctx, runErr, map[string]string{
			"stage":  "stripe_compensation",
			"action": string(job.Action),
			"userId": job.UserID,
		})
		runErr = obs.WithEventID(runErr, eventID)
	}
	if advanceRefundGeneration {
		if finishErr := r.store.AdvanceStripeRefundGeneration(ctx, *job, runErr); finishErr != nil {
			return true, finishErr
		}
	} else if finishErr := r.store.FinishStripeCompensation(ctx, *job, runErr); finishErr != nil {
		return true, finishErr
	}
	if refundPending {
		return true, nil
	}
	return true, runErr
}

func (r *Runner) DrainStripeCompensations(ctx context.Context) error {
	var joined error
	for {
		ran, err := r.RunNextStripeCompensation(ctx)
		if err != nil {
			joined = errors.Join(joined, err)
		}
		if !ran {
			return joined
		}
	}
}
