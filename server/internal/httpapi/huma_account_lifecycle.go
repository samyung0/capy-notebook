package httpapi

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/billing"
	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/integrations"
	"github.com/evonotes/server/internal/store"
)

type accountStatusOutput struct {
	Body store.AccountStatus
}
type deletionPreflightOutput struct {
	Body apimodel.DeletionPreflight
}
type requestDeletionInput struct {
	Body apimodel.RequestAccountDeletionReq
}

func (a *api) registerAccountLifecycle(api huma.API) {
	const tag = "Account"
	reg(api, http.MethodGet, "/api/account/status", "getAccountStatus", tag,
		"Resolved account lifecycle state", http.StatusOK, a.getAccountStatus)
	reg(api, http.MethodGet, "/api/account/deletion", "getDeletionPreflight", tag,
		"What account deletion would destroy, and what blocks it", http.StatusOK, a.deletionPreflight)
	reg(api, http.MethodPost, "/api/account/deletion", "requestAccountDeletion", tag,
		"Schedule account deletion", http.StatusOK, a.requestAccountDeletion)
}

func (a *api) getAccountStatus(ctx context.Context, _ *struct{}) (*accountStatusOutput, error) {
	status, err := a.s.AccountAccess(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &accountStatusOutput{Body: status}, nil
}

// liveSubscriptionBlocker asks Stripe, not the database column. The column is a
// projection kept current by webhooks, and a webhook that has not arrived yet
// would let a paying user delete an account whose subscription keeps billing.
// A subscription already set to cancel at period end is not a blocker: the user
// has done what we asked of them.
func (a *api) liveSubscriptionBlocker(ctx context.Context, uid string) (*apimodel.SubscriptionBlocker, error) {
	customerID, err := a.s.GetStripeCustomerID(ctx, uid)
	if err != nil || customerID == "" {
		return nil, err
	}
	if strings.TrimSpace(a.cfg.StripeSecretKey) == "" || a.stripeEntitlements == nil {
		return &apimodel.SubscriptionBlocker{Unavailable: true}, nil
	}
	subscriptions, err := a.stripeEntitlements(customerID)
	if err != nil {
		// Failing closed here would make the account permanently undeletable
		// during a Stripe outage, so surface it as a blocker the user can retry
		// rather than as an empty answer that lets the deletion through.
		log.Printf("deletion preflight: stripe lookup for %s: %v", uid, err)
		return &apimodel.SubscriptionBlocker{Unavailable: true}, nil
	}
	for _, sub := range subscriptions {
		if sub.CancelAtPeriodEnd {
			continue
		}
		record := billing.SubscriptionRecord(sub, uid, a.cfg.StripePricePro, 0)
		return &apimodel.SubscriptionBlocker{
			StripeSubscriptionID: record.StripeSubscriptionID,
			PlanTier:             string(record.PlanTier),
			CurrentPeriodEnd:     record.CurrentPeriodEnd,
		}, nil
	}
	return nil, nil
}

func (a *api) deletionPreflight(ctx context.Context, _ *struct{}) (*deletionPreflightOutput, error) {
	uid := userID(ctx)
	out := apimodel.DeletionPreflight{
		WorkspacesNeedingTransfer: []apimodel.Workspace{},
		WorkspacesToDestroy:       []apimodel.Workspace{},
		GraceDays:                 store.DeletionGraceDays,
	}
	var err error
	out.LifecycleGeneration, err = a.s.AccountLifecycleGeneration(ctx, uid)
	if err != nil {
		return nil, hErr(err)
	}
	doomed, err := a.s.WorkspacesDestroyedByDeletion(ctx, uid)
	if err != nil {
		return nil, hErr(err)
	}
	ownerStates, err := a.workspaceOwnerStates(ctx, doomed...)
	if err != nil {
		return nil, err
	}
	out.WorkspacesToDestroy = apimodel.FromWorkspaces(doomed, ownerStates)

	out.Subscription, err = a.liveSubscriptionBlocker(ctx, uid)
	if err != nil {
		return nil, hErr(err)
	}
	usage, err := a.s.StorageUsage(ctx, uid)
	if err != nil {
		return nil, hErr(err)
	}
	out.StorageUsedBytes = usage.UsedBytes
	out.CanDelete = out.Subscription == nil
	return &deletionPreflightOutput{Body: out}, nil
}

func (a *api) requestAccountDeletion(ctx context.Context, in *requestDeletionInput) (*accountStatusOutput, error) {
	uid := userID(ctx)
	u, err := a.s.Me(ctx, uid)
	if err != nil {
		return nil, hErr(err)
	}
	// Typing the email is the confirmation gesture. It is checked server-side
	// because this is the one irreversible endpoint in the API.
	if in.Body.ConfirmEmail == "" || !strings.EqualFold(in.Body.ConfirmEmail, u.Email) {
		return nil, huma.Error400BadRequest("confirmation does not match the account email")
	}
	blocker, err := a.liveSubscriptionBlocker(ctx, uid)
	if err != nil {
		return nil, hErr(err)
	}
	if blocker != nil {
		if blocker.Unavailable {
			return nil, huma.Error503ServiceUnavailable(
				"cannot confirm subscription state with Stripe right now; try again shortly")
		}
		return nil, huma.Error409Conflict("cancel your subscription before deleting your account")
	}
	status, err := a.s.RequestAccountDeletionAtGenerationWithSessionRevocation(
		ctx, uid, false, in.Body.LifecycleGeneration,
	)
	if errors.Is(err, store.ErrAccountLifecycleChanged) {
		return nil, huma.Error409Conflict(
			"account state changed after deletion preflight; review and try again",
		)
	}
	if err != nil {
		return nil, hErr(err)
	}
	// Middleware refuses deletion-pending sessions, but an already-issued JWT
	// would otherwise keep working until expiry. Revoke first.
	if a.cfg.ClerkSecretKey != "" {
		if err := integrations.RevokeUserSessions(ctx, uid); err != nil {
			log.Printf("deletion: revoke sessions for %s: %v", uid, err)
			if retryErr := a.s.RetrySessionRevocation(ctx, uid, err); retryErr != nil {
				log.Printf("deletion: schedule session revocation retry for %s: %v", uid, retryErr)
			}
		} else if err := a.s.MarkSessionRevocationComplete(ctx, uid); err != nil {
			log.Printf("deletion: finish session revocation for %s: %v", uid, err)
		}
	} else if err := a.s.MarkSessionRevocationComplete(ctx, uid); err != nil {
		log.Printf("deletion: finish disabled session revocation for %s: %v", uid, err)
	}
	if err := a.s.NotifyAccountDeletionRequested(ctx, uid); err != nil {
		log.Printf("deletion: notify request for %s: %v", uid, err)
	}
	return &accountStatusOutput{Body: status}, nil
}
