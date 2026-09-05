package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/billing"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/integrations"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

type meOutput struct {
	Body apimodel.User
}
type searchInput struct {
	Q string `query:"q"`
}
type searchOutput struct {
	Body []apimodel.SearchResult `nullable:"false"`
}
type notificationsOutput struct {
	Body apimodel.NotificationPage
}
type notificationsInput struct {
	Limit  int    `query:"limit" default:"50" minimum:"1" maximum:"100"`
	Before string `query:"before"`
}
type notificationIDInput struct {
	ID string `path:"id"`
}
type notificationCountOutput struct {
	Body struct {
		Count int `json:"count"`
	}
}
type notificationPrefsOutput struct {
	Body apimodel.NotificationPrefs
}
type notificationPrefsInput struct {
	Body apimodel.NotificationPrefs
}
type localeInput struct {
	Body struct {
		Locale string `json:"locale" enum:"en,zh"`
	}
}
type billingOutput struct {
	Body apimodel.BillingInfo
}
type usageOutput struct {
	Body apimodel.UsageReport
}
type ingestSlotsOutput struct {
	Body apimodel.IngestSlots
}
type billingCheckoutInput struct {
	Body apimodel.BillingCheckoutReq
}
type urlOutput struct {
	Body apimodel.URLResp
}
type integrationsOutput struct {
	Body apimodel.IntegrationsStatus
}
type accessTokenOutput struct {
	Body apimodel.AccessTokenResp
}
type microsoftDriveOutput struct {
	Body apimodel.MicrosoftDriveHost
}
type providerInput struct {
	Provider string `path:"provider"`
}
type publicWorkspacesOutput struct {
	Body []apimodel.PublicWorkspace `nullable:"false"`
}
type publicQuizzesOutput struct {
	Body []apimodel.PublicQuiz `nullable:"false"`
}

func (a *api) registerAccount(api huma.API) {
	const tag = "Account"
	reg(api, http.MethodGet, "/api/me", "getMe", tag, "Current user", http.StatusOK, a.getMe)
	reg(api, http.MethodGet, "/api/me/ingest-slots", "getIngestSlots", tag, "Actor ingest slot remaining", http.StatusOK, a.getIngestSlots)
	reg(api, http.MethodPatch, "/api/me/locale", "setLocale", tag, "Set account locale", http.StatusNoContent, a.setLocale)
	reg(api, http.MethodGet, "/api/search", "search", tag, "Global search", http.StatusOK, a.searchAll)
	reg(api, http.MethodGet, "/api/notifications", "listNotifications", tag, "List notifications", http.StatusOK, a.listNotifications)
	reg(api, http.MethodGet, "/api/notifications/unread-count", "getUnreadNotificationCount", tag, "Unread notification count", http.StatusOK, a.getUnreadNotificationCount)
	reg(api, http.MethodPost, "/api/notifications/{id}/read", "readNotification", tag, "Mark one notification read", http.StatusNoContent, a.readNotification)
	reg(api, http.MethodPost, "/api/notifications/read", "readNotifications", tag, "Mark notifications read", http.StatusNoContent, a.readNotifications)
	reg(api, http.MethodGet, "/api/notification-prefs", "getNotificationPrefs", tag, "Get notification preferences", http.StatusOK, a.getNotificationPrefs)
	reg(api, http.MethodPatch, "/api/notification-prefs", "setNotificationPrefs", tag, "Set notification preferences", http.StatusOK, a.setNotificationPrefs)
}

func (a *api) registerExplore(api huma.API) {
	const tag = "Explore"
	reg(api, http.MethodGet, "/api/explore/workspaces", "exploreWorkspaces", tag, "Public workspaces", http.StatusOK, a.exploreWorkspaces)
	reg(api, http.MethodGet, "/api/explore/quizzes", "exploreQuizzes", tag, "Public quizzes", http.StatusOK, a.exploreQuizzes)
}

func (a *api) registerBillingIntegrations(api huma.API) {
	const tag = "Billing & integrations"
	reg(api, http.MethodGet, "/api/billing", "getBilling", tag, "Billing info", http.StatusOK, a.getBilling)
	reg(api, http.MethodGet, "/api/usage", "getUsage", tag, "Current-period AI usage", http.StatusOK, a.getUsage)
	reg(api, http.MethodPost, "/api/billing/checkout", "billingCheckout", tag, "Start checkout", http.StatusOK, a.billingCheckout)
	reg(api, http.MethodPost, "/api/billing/portal", "billingPortal", tag, "Open billing portal", http.StatusOK, a.billingPortal)
	reg(api, http.MethodGet, "/api/integrations", "getIntegrations", tag, "Integration status", http.StatusOK, a.getIntegrations)
	reg(api, http.MethodGet, "/api/integrations/microsoft/drive", "microsoftDrive", tag, "OneDrive host for File Picker", http.StatusOK, a.microsoftDrive)
	reg(api, http.MethodGet, "/api/integrations/google/picker-token", "googlePickerToken", tag, "Google picker token", http.StatusOK, a.googlePickerTokenH)
	reg(api, http.MethodDelete, "/api/integrations/{provider}", "deleteIntegration", tag, "Disconnect a provider", http.StatusNoContent, a.deleteIntegrationH)
}

func (a *api) getIngestSlots(ctx context.Context, _ *struct{}) (*ingestSlotsOutput, error) {
	slots, err := a.s.IngestSlots(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &ingestSlotsOutput{Body: slots}, nil
}

func (a *api) getMe(ctx context.Context, _ *struct{}) (*meOutput, error) {
	u, err := a.s.Me(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &meOutput{Body: u}, nil
}

func (a *api) searchAll(ctx context.Context, in *searchInput) (*searchOutput, error) {
	q := strings.TrimSpace(in.Q)
	if q == "" {
		return &searchOutput{Body: []apimodel.SearchResult{}}, nil
	}
	res, err := a.s.Search(ctx, userID(ctx), q)
	if err != nil {
		return nil, hErr(err)
	}
	return &searchOutput{Body: res}, nil
}

func (a *api) setLocale(ctx context.Context, in *localeInput) (*Empty, error) {
	if err := a.s.SetLocale(ctx, userID(ctx), in.Body.Locale); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

func (a *api) listNotifications(ctx context.Context, in *notificationsInput) (*notificationsOutput, error) {
	res, err := a.s.ListNotifications(ctx, userID(ctx), in.Limit, in.Before)
	if err != nil {
		if strings.Contains(err.Error(), "invalid notification cursor") {
			return nil, huma.Error400BadRequest("invalid notification cursor")
		}
		return nil, hErr(err)
	}
	return &notificationsOutput{Body: res}, nil
}

func (a *api) getUnreadNotificationCount(ctx context.Context, _ *struct{}) (*notificationCountOutput, error) {
	count, err := a.s.UnreadNotificationCount(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	out := &notificationCountOutput{}
	out.Body.Count = count
	return out, nil
}

func (a *api) readNotification(ctx context.Context, in *notificationIDInput) (*Empty, error) {
	changed, err := a.s.MarkNotificationRead(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if changed {
		a.publishNotificationEvent(ctx, userID(ctx), notificationEvent{
			Type: "read",
			IDs:  []string{in.ID},
		})
	}
	return &Empty{}, nil
}

func (a *api) readNotifications(ctx context.Context, _ *struct{}) (*Empty, error) {
	ids, err := a.s.MarkAllNotificationsRead(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	if len(ids) > 0 {
		a.publishNotificationEvent(ctx, userID(ctx), notificationEvent{
			Type: "read",
			IDs:  ids,
		})
	}
	return &Empty{}, nil
}

func (a *api) getNotificationPrefs(ctx context.Context, _ *struct{}) (*notificationPrefsOutput, error) {
	prefs, err := a.s.GetNotificationPrefs(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &notificationPrefsOutput{Body: prefs}, nil
}

func (a *api) setNotificationPrefs(ctx context.Context, in *notificationPrefsInput) (*notificationPrefsOutput, error) {
	prefs, err := a.s.SetNotificationPrefs(ctx, userID(ctx), in.Body)
	if err != nil {
		return nil, hErr(err)
	}
	return &notificationPrefsOutput{Body: prefs}, nil
}

func (a *api) exploreWorkspaces(ctx context.Context, _ *struct{}) (*publicWorkspacesOutput, error) {
	res, err := a.s.ListPublicWorkspaces(ctx)
	if err != nil {
		return nil, hErr(err)
	}
	return &publicWorkspacesOutput{Body: apimodel.FromPublicWorkspaces(res)}, nil
}

func (a *api) exploreQuizzes(ctx context.Context, _ *struct{}) (*publicQuizzesOutput, error) {
	res, err := a.s.ListPublicQuizzes(ctx)
	if err != nil {
		return nil, hErr(err)
	}
	return &publicQuizzesOutput{Body: apimodel.FromPublicQuizzes(res)}, nil
}

func (a *api) getBilling(ctx context.Context, _ *struct{}) (*billingOutput, error) {
	info, err := a.s.GetBilling(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &billingOutput{Body: info}, nil
}

func (a *api) getUsage(ctx context.Context, _ *struct{}) (*usageOutput, error) {
	report, err := a.s.UserUsageReport(ctx, userID(ctx), 0)
	if err != nil {
		return nil, hErr(err)
	}
	return &usageOutput{Body: report}, nil
}

func (a *api) checkoutEntitlementError(customerID string) error {
	if customerID == "" {
		return nil
	}
	entitlements, err := a.stripeEntitlements(customerID)
	if err != nil {
		return huma.Error503ServiceUnavailable(
			"cannot confirm subscription state with Stripe right now; try again shortly",
		)
	}
	if len(entitlements) > 0 {
		return huma.Error409Conflict("an active subscription already exists")
	}
	return nil
}

func (a *api) billingCheckout(ctx context.Context, in *billingCheckoutInput) (*urlOutput, error) {
	uid := userID(ctx)
	current, err := a.s.SubscriptionForUser(ctx, uid)
	if err != nil {
		return nil, hErr(err)
	}
	if current != nil {
		return nil, huma.Error409Conflict("an active subscription already exists")
	}
	u, err := a.s.Me(ctx, uid)
	if err != nil {
		return nil, hErr(err)
	}
	priceID := billing.PriceForTier(in.Body.PlanTier, a.cfg.StripePricePro)
	if priceID == "" {
		return nil, huma.Error503ServiceUnavailable("stripe price not configured")
	}
	customerID, err := a.s.GetStripeCustomerID(ctx, uid)
	if err != nil {
		return nil, hErr(err)
	}
	if err := a.checkoutEntitlementError(customerID); err != nil {
		return nil, err
	}
	successURL := a.cfg.AppURL + "/settings?tab=subscription"
	cancelURL := a.cfg.AppURL + "/settings?tab=subscription"
	reservationID, status, err := a.s.ReserveStripeCheckout(
		ctx,
		uid,
		customerID,
		priceID,
		successURL,
		cancelURL,
	)
	if err != nil {
		return nil, hErr(err)
	}
	if reservationID == "" {
		return nil, hErr(&store.AccountLockedError{
			UserID: uid,
			State:  status.State,
			Reason: status.SuspendedReason,
		})
	}
	if customerID == "" {
		customerID, err = billing.CreateCustomer(
			u.Email,
			u.Name,
			uid,
			"checkout-customer-"+reservationID,
		)
		if err != nil {
			return nil, hErr(err)
		}
	}
	session, err := billing.CreateCheckoutSession(
		customerID,
		priceID,
		uid,
		successURL,
		cancelURL,
		reservationID,
		"checkout-session-"+reservationID,
	)
	if err != nil {
		return nil, hErr(err)
	}
	status, err = a.s.RecordStripeCheckoutSession(
		ctx,
		reservationID,
		uid,
		customerID,
		session.ID,
	)
	if err != nil {
		// The remote session exists but could not be recorded durably. Expiring it
		// synchronously is the only safe outcome; never return an untracked URL.
		if billing.ExpireCheckoutSession(session.ID) == nil {
			_ = a.s.RecordStripeCheckoutSessionExpired(
				ctx, reservationID, uid, customerID, session.ID,
			)
		}
		return nil, hErr(err)
	}
	if status.State == store.AccountDeletionPending || status.State == store.AccountDeleted || status.State == store.AccountSuspended {
		return nil, hErr(&store.AccountLockedError{
			UserID: uid,
			State:  status.State,
			Reason: status.SuspendedReason,
		})
	}
	return &urlOutput{Body: apimodel.URLResp{URL: session.URL}}, nil
}

func (a *api) billingPortal(ctx context.Context, _ *struct{}) (*urlOutput, error) {
	uid := userID(ctx)
	customerID, err := a.s.GetStripeCustomerID(ctx, uid)
	if err != nil {
		return nil, hErr(err)
	}
	if customerID == "" {
		return nil, huma.Error400BadRequest("no billing account")
	}
	url, err := billing.CreatePortalSession(customerID, a.cfg.AppURL+"/billing")
	if err != nil {
		return nil, hErr(err)
	}
	return &urlOutput{Body: apimodel.URLResp{URL: url}}, nil
}

func (a *api) getIntegrations(ctx context.Context, _ *struct{}) (*integrationsOutput, error) {
	// Without a Clerk key (local dev with auth disabled) report nothing
	// connected instead of failing the whole page.
	if a.cfg.ClerkSecretKey == "" {
		return &integrationsOutput{}, nil
	}
	provs, err := integrations.ClerkConnectedProviders(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &integrationsOutput{Body: apimodel.IntegrationsStatus{
		Google:    provs[integrations.ProviderGoogle],
		Microsoft: provs[integrations.ProviderMicrosoft],
	}}, nil
}

func (a *api) googlePickerTokenH(ctx context.Context, _ *struct{}) (*accessTokenOutput, error) {
	tok, err := integrations.ClerkAccessToken(ctx, userID(ctx), integrations.ProviderGoogle)
	if errors.Is(err, integrations.ErrNotConnected) {
		return nil, huma.Error404NotFound("google account not connected")
	}
	if err != nil {
		return nil, hErr(err)
	}
	return &accessTokenOutput{Body: apimodel.AccessTokenResp{AccessToken: tok}}, nil
}

func (a *api) microsoftDrive(ctx context.Context, _ *struct{}) (*microsoftDriveOutput, error) {
	tok, err := integrations.ClerkAccessToken(ctx, userID(ctx), integrations.ProviderMicrosoft)
	if errors.Is(err, integrations.ErrNotConnected) {
		return nil, huma.Error404NotFound("microsoft account not connected")
	}
	if err != nil {
		return nil, hErr(err)
	}
	drive, err := integrations.GetMicrosoftDrive(ctx, tok)
	if err != nil {
		return nil, hErr(err)
	}
	return &microsoftDriveOutput{Body: apimodel.MicrosoftDriveHost{
		ID:        drive.ID,
		DriveType: drive.DriveType,
		WebURL:    drive.WebURL,
	}}, nil
}

func (a *api) deleteIntegrationH(ctx context.Context, in *providerInput) (*Empty, error) {
	switch in.Provider {
	case integrations.ProviderGoogle, integrations.ProviderMicrosoft:
	default:
		return nil, huma.Error400BadRequest("unknown provider")
	}
	err := integrations.ClerkDisconnect(ctx, userID(ctx), in.Provider)
	if errors.Is(err, integrations.ErrNotConnected) {
		return &Empty{}, nil // already disconnected
	}
	if err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}
