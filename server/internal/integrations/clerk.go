package integrations

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	clerkuser "github.com/clerk/clerk-sdk-go/v2/user"
)

// Clerk owns the OAuth lifecycle for provider integrations (Google Drive,
// OneDrive): users link external accounts through Clerk's account
// portal / frontend SDK, and the backend pulls fresh access tokens from
// Clerk's token wallet. No provider tokens are stored or refreshed locally.

// ErrNotConnected means the Clerk user has no verified external account (or
// no stored OAuth token) for the provider.
var ErrNotConnected = errors.New("provider not connected")
var ErrGoogleDriveScopeRequired = errors.New("Google Drive folder import requires reconnecting with read access")

const GoogleDriveReadonlyScope = "https://www.googleapis.com/auth/drive.readonly"

func HasGoogleDriveReadScope(scopes []string) bool {
	return slices.Contains(scopes, GoogleDriveReadonlyScope) || slices.Contains(scopes, "https://www.googleapis.com/auth/drive")
}

// clerkStrategy maps our provider ids ("google") to Clerk strategy names
// ("oauth_google").
func clerkStrategy(provider string) string { return "oauth_" + provider }

// ClerkAccessToken returns a provider access token from Clerk's OAuth token
// wallet, cached short of its expiry (clerk_cache.go). Clerk refreshes expired
// tokens transparently.
func ClerkAccessToken(ctx context.Context, userID, provider string) (string, error) {
	token, _, err := ClerkAccessTokenScopes(ctx, userID, provider)
	return token, err
}

func ClerkAccessTokenScopes(ctx context.Context, userID, provider string) (string, []string, error) {
	now := time.Now()
	if cached, ok := cachedAccessToken(userID, provider, now); ok {
		return cached.token, cached.scopes, nil
	}
	list, err := clerkuser.ListOAuthAccessTokens(ctx, &clerkuser.ListOAuthAccessTokensParams{
		ID:       userID,
		Provider: clerkStrategy(provider),
	})
	if err != nil {
		return "", nil, fmt.Errorf("clerk oauth token (%s): %w", provider, err)
	}
	var expiries []time.Time
	if list.Response != nil {
		expiries = tokenExpiries(list.Response.RawJSON)
	}
	for i, t := range list.OAuthAccessTokens {
		if t != nil && t.Token != "" {
			if i < len(expiries) {
				keepAccessToken(userID, provider, t.Token, t.Scopes, expiries[i], now)
			}
			return t.Token, t.Scopes, nil
		}
	}
	return "", nil, ErrNotConnected
}

// ClerkConnectedProviders reports external-account links and import grants
// separately: signing in with a provider does not grant access to its files.
func ClerkConnectedProviders(ctx context.Context, userID string) (map[string]bool, error) {
	if cached, ok := cachedConnectedProviders(userID, time.Now()); ok {
		return cached, nil
	}
	u, err := clerkuser.Get(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("clerk user: %w", err)
	}
	out := map[string]bool{}
	for _, acc := range u.ExternalAccounts {
		if acc == nil {
			continue
		}
		if acc.Verification != nil && acc.Verification.Status != "verified" {
			continue
		}
		provider := strings.TrimPrefix(acc.Provider, "oauth_")
		out[provider] = true
		if provider == ProviderGoogle {
			out["googleDriveReadonly"] = HasGoogleDriveReadScope(strings.Fields(acc.ApprovedScopes))
		}
		if provider == ProviderMicrosoft {
			out["microsoftFilesRead"] = slices.Contains(strings.Fields(acc.ApprovedScopes), "Files.Read")
		}
	}
	keepConnectedProviders(userID, out, time.Now())
	return out, nil
}

// ClerkDisconnect unlinks the provider's external account from the Clerk user.
func ClerkDisconnect(ctx context.Context, userID, provider string) error {
	defer ForgetClerkUser(userID)
	u, err := clerkuser.Get(ctx, userID)
	if err != nil {
		return fmt.Errorf("clerk user: %w", err)
	}
	for _, acc := range u.ExternalAccounts {
		if acc == nil || strings.TrimPrefix(acc.Provider, "oauth_") != provider {
			continue
		}
		if _, err := clerkuser.DeleteExternalAccount(ctx, &clerkuser.DeleteExternalAccountParams{
			UserID: userID,
			ID:     acc.ID,
		}); err != nil {
			return fmt.Errorf("clerk unlink %s: %w", provider, err)
		}
		return nil
	}
	return ErrNotConnected
}
