package integrations

import (
	"context"
	"errors"
	"fmt"
	"strings"

	clerkuser "github.com/clerk/clerk-sdk-go/v2/user"
)

// Clerk owns the OAuth lifecycle for provider integrations (Google Drive,
// OneDrive): users link external accounts through Clerk's account
// portal / frontend SDK, and the backend pulls fresh access tokens from
// Clerk's token wallet. No provider tokens are stored or refreshed locally.

// ErrNotConnected means the Clerk user has no verified external account (or
// no stored OAuth token) for the provider.
var ErrNotConnected = errors.New("provider not connected")

// clerkStrategy maps our provider ids ("google") to Clerk strategy names
// ("oauth_google").
func clerkStrategy(provider string) string { return "oauth_" + provider }

// ClerkAccessToken returns a fresh provider access token from Clerk's OAuth
// token wallet. Clerk refreshes expired tokens transparently.
func ClerkAccessToken(ctx context.Context, userID, provider string) (string, error) {
	list, err := clerkuser.ListOAuthAccessTokens(ctx, &clerkuser.ListOAuthAccessTokensParams{
		ID:       userID,
		Provider: clerkStrategy(provider),
	})
	if err != nil {
		return "", fmt.Errorf("clerk oauth token (%s): %w", provider, err)
	}
	for _, t := range list.OAuthAccessTokens {
		if t != nil && t.Token != "" {
			return t.Token, nil
		}
	}
	return "", ErrNotConnected
}

// ClerkConnectedProviders reports which providers have a verified external
// account linked on the Clerk user (keys: "google", "microsoft").
func ClerkConnectedProviders(ctx context.Context, userID string) (map[string]bool, error) {
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
		out[strings.TrimPrefix(acc.Provider, "oauth_")] = true
	}
	return out, nil
}

// ClerkDisconnect unlinks the provider's external account from the Clerk user.
func ClerkDisconnect(ctx context.Context, userID, provider string) error {
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
