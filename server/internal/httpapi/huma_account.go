package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/billing"
	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/integrations"
)

type meOutput struct {
	Body apimodel.User
}
type searchInput struct {
	Q string `query:"q"`
}
type searchOutput struct {
	Body []apimodel.SearchResult
}
type notificationsOutput struct {
	Body []apimodel.Notification
}
type billingOutput struct {
	Body apimodel.BillingInfo
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
type recentFilesOutput struct {
	Body []apimodel.RecentFile
}
type providerInput struct {
	Provider string `path:"provider"`
}
type publicWorkspacesOutput struct {
	Body []apimodel.PublicWorkspace
}
type publicQuizzesOutput struct {
	Body []apimodel.PublicQuiz
}

func (a *api) registerAccount(api huma.API) {
	const tag = "Account"
	reg(api, http.MethodGet, "/api/me", "getMe", tag, "Current user", http.StatusOK, a.getMe)
	reg(api, http.MethodGet, "/api/search", "search", tag, "Global search", http.StatusOK, a.searchAll)
	reg(api, http.MethodGet, "/api/notifications", "listNotifications", tag, "List notifications", http.StatusOK, a.listNotifications)
	reg(api, http.MethodPost, "/api/notifications/read", "readNotifications", tag, "Mark notifications read", http.StatusNoContent, a.readNotifications)
}

func (a *api) registerExplore(api huma.API) {
	const tag = "Explore"
	reg(api, http.MethodGet, "/api/explore/workspaces", "exploreWorkspaces", tag, "Public workspaces", http.StatusOK, a.exploreWorkspaces)
	reg(api, http.MethodGet, "/api/explore/quizzes", "exploreQuizzes", tag, "Public quizzes", http.StatusOK, a.exploreQuizzes)
}

func (a *api) registerBillingIntegrations(api huma.API) {
	const tag = "Billing & integrations"
	reg(api, http.MethodGet, "/api/billing", "getBilling", tag, "Billing info", http.StatusOK, a.getBilling)
	reg(api, http.MethodPost, "/api/billing/checkout", "billingCheckout", tag, "Start checkout", http.StatusOK, a.billingCheckout)
	reg(api, http.MethodPost, "/api/billing/portal", "billingPortal", tag, "Open billing portal", http.StatusOK, a.billingPortal)
	reg(api, http.MethodGet, "/api/integrations", "getIntegrations", tag, "Integration status", http.StatusOK, a.getIntegrations)
	reg(api, http.MethodGet, "/api/integrations/microsoft/recent", "microsoftRecent", tag, "Recent OneDrive files", http.StatusOK, a.microsoftRecent)
	reg(api, http.MethodGet, "/api/integrations/google/picker-token", "googlePickerToken", tag, "Google picker token", http.StatusOK, a.googlePickerTokenH)
	reg(api, http.MethodDelete, "/api/integrations/{provider}", "deleteIntegration", tag, "Disconnect a provider", http.StatusNoContent, a.deleteIntegrationH)
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

func (a *api) listNotifications(ctx context.Context, _ *struct{}) (*notificationsOutput, error) {
	res, err := a.s.Notifications(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &notificationsOutput{Body: res}, nil
}

func (a *api) readNotifications(ctx context.Context, _ *struct{}) (*Empty, error) {
	if err := a.s.MarkNotificationsRead(ctx, userID(ctx)); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
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

func (a *api) billingCheckout(ctx context.Context, in *billingCheckoutInput) (*urlOutput, error) {
	uid := userID(ctx)
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
	if customerID == "" {
		customerID, err = billing.CreateCustomer(u.Email, u.Name, uid)
		if err != nil {
			return nil, hErr(err)
		}
		if err := a.s.SetStripeCustomerID(ctx, uid, customerID); err != nil {
			return nil, hErr(err)
		}
	}
	successURL := a.cfg.AppURL + "/subscription?success=1"
	cancelURL := a.cfg.AppURL + "/subscription"
	url, err := billing.CreateCheckoutSession(customerID, priceID, uid, successURL, cancelURL)
	if err != nil {
		return nil, hErr(err)
	}
	return &urlOutput{Body: apimodel.URLResp{URL: url}}, nil
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
	url, err := billing.CreatePortalSession(customerID, a.cfg.AppURL+"/subscription")
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

func (a *api) microsoftRecent(ctx context.Context, _ *struct{}) (*recentFilesOutput, error) {
	tok, err := integrations.ClerkAccessToken(ctx, userID(ctx), integrations.ProviderMicrosoft)
	if errors.Is(err, integrations.ErrNotConnected) {
		return nil, huma.Error404NotFound("microsoft account not connected")
	}
	if err != nil {
		return nil, hErr(err)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://graph.microsoft.com/v1.0/me/drive/recent", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, hErr(err)
	}
	defer resp.Body.Close()
	var out struct {
		Value []apimodel.RecentFile `json:"value"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, hErr(err)
	}
	if out.Value == nil {
		out.Value = []apimodel.RecentFile{}
	}
	return &recentFilesOutput{Body: out.Value}, nil
}

func (a *api) deleteIntegrationH(ctx context.Context, in *providerInput) (*Empty, error) {
	switch in.Provider {
	case integrations.ProviderGoogle, integrations.ProviderMicrosoft, integrations.ProviderNotion:
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
