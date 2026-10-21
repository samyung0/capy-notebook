package auth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v3"
	"github.com/go-jose/go-jose/v3/jwt"

	"github.com/samyung0/capy-notebook/server/internal/auth"
)

type liveSessionStore struct{}

func (liveSessionStore) AccountSessionAllowed(context.Context, string) (bool, string, error) {
	return true, "", nil
}
func (liveSessionStore) ClerkSession(context.Context, string) (bool, string, bool, bool, error) {
	return true, "", false, false, nil
}
func (liveSessionStore) UpsertUserFromClerk(context.Context, string, string, string, string) (bool, error) {
	return false, nil
}
func (liveSessionStore) CreateDefaultWorkspace(context.Context, string) error { return nil }
func (liveSessionStore) UserProvisioned(context.Context, string) (bool, error) {
	return true, nil
}

// tokenFor signs a session token for userID minted by the page at origin
// (Clerk's azp claim); an empty origin leaves azp out.
func (f *fakeClerk) tokenFor(t *testing.T, userID, origin string) string {
	t.Helper()
	signer, err := jose.NewSigner(jose.SigningKey{
		Algorithm: jose.RS256,
		Key:       jose.JSONWebKey{Key: f.key, KeyID: f.kid},
	}, (&jose.SignerOptions{}).WithType("JWT"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	builder := jwt.Signed(signer).Claims(jwt.Claims{
		Subject:   userID,
		Issuer:    "https://clerk.example.test",
		IssuedAt:  jwt.NewNumericDate(now),
		NotBefore: jwt.NewNumericDate(now.Add(-time.Minute)),
		Expiry:    jwt.NewNumericDate(now.Add(time.Hour)),
	})
	if origin != "" {
		builder = builder.Claims(map[string]any{"azp": origin})
	}
	raw, err := builder.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// Security regression: a Clerk session token minted for a page outside the
// app's origins (its azp claim) is refused.
func TestClerkTokenFromAnotherOriginIsRefused(t *testing.T) {
	f := startFakeClerk(t)
	handler := auth.Middleware(auth.Config{
		SecretKey:         "sk_test_fake",
		Store:             liveSessionStore{},
		AuthorizedParties: []string{"https://app.example.test"},
	})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	for _, tc := range []struct {
		origin string
		want   int
	}{
		{"https://app.example.test", http.StatusNoContent},
		{"https://evil.example", http.StatusUnauthorized},
		{"", http.StatusNoContent},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
		req.Header.Set("Authorization", "Bearer "+f.tokenFor(t, "u_azp", tc.origin))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Errorf("azp %q: status %d, want %d", tc.origin, rec.Code, tc.want)
		}
	}
}
