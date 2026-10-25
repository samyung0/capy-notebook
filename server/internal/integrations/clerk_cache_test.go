package integrations

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/clerk/clerk-sdk-go/v2"
)

// countingClerk answers every Clerk Backend API call with body and counts them.
func countingClerk(t *testing.T, body func() string) *int {
	t.Helper()
	previous := clerk.GetBackend()
	t.Cleanup(func() { clerk.SetBackend(previous) })
	calls := 0
	clerk.SetBackend(clerk.NewBackend(&clerk.BackendConfig{
		Key: clerk.String("test-key"),
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			calls++
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body())),
				Header: http.Header{"Content-Type": {"application/json"}}}, nil
		})},
	}))
	return &calls
}

// TestClerkTokensAreCachedShortOfTheirExpiry (security regression: rate-limit
// audit M12). A token Clerk dates is served from memory until a minute before
// it expires (at most a few minutes); one near its expiry, or undated, is
// fetched again every time.
func TestClerkTokensAreCachedShortOfTheirExpiry(t *testing.T) {
	var expiresAt string
	calls := countingClerk(t, func() string {
		return `{"data":[{"object":"oauth_access_token","token":"tok","provider":"oauth_google","scopes":["s"]` +
			expiresAt + `}],"total_count":1}`
	})
	for _, tc := range []struct {
		name, expiresAt string
		wantCalls       int
	}{
		{"an hour left", fmt.Sprintf(`,"expires_at":%d`, time.Now().Add(time.Hour).Unix()), 1},
		{"an hour left in milliseconds", fmt.Sprintf(`,"expires_at":%d`, time.Now().Add(time.Hour).UnixMilli()), 1},
		{"thirty seconds left", fmt.Sprintf(`,"expires_at":%d`, time.Now().Add(30*time.Second).Unix()), 3},
		{"undated", "", 3},
	} {
		ForgetClerkUser("user_tokens")
		*calls, expiresAt = 0, tc.expiresAt
		for range 3 {
			token, _, err := ClerkAccessTokenScopes(context.Background(), "user_tokens", ProviderGoogle)
			if err != nil || token != "tok" {
				t.Fatalf("%s: token %q, %v", tc.name, token, err)
			}
		}
		if *calls != tc.wantCalls {
			t.Errorf("%s: %d Clerk calls, want %d", tc.name, *calls, tc.wantCalls)
		}
	}
}

// TestClerkProvidersAreCachedUntilForgotten (security regression: rate-limit
// audit M12). The connected providers are read from Clerk once for a few
// minutes, and again after the user is forgotten (a disconnect or a Clerk
// user webhook).
func TestClerkProvidersAreCachedUntilForgotten(t *testing.T) {
	calls := countingClerk(t, func() string {
		return `{"id":"user_providers","external_accounts":[{"provider":"oauth_google","approved_scopes":"openid","verification":{"status":"verified"}}]}`
	})
	ForgetClerkUser("user_providers")
	for range 3 {
		if status, err := ClerkConnectedProviders(context.Background(), "user_providers"); err != nil || !status["google"] {
			t.Fatalf("providers = %v, %v", status, err)
		}
	}
	if *calls != 1 {
		t.Fatalf("Clerk calls = %d, want 1", *calls)
	}
	ForgetClerkUser("user_providers")
	if _, err := ClerkConnectedProviders(context.Background(), "user_providers"); err != nil || *calls != 2 {
		t.Fatalf("after forgetting: %d Clerk calls (%v), want 2", *calls, err)
	}
}
