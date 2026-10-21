package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	clerk "github.com/clerk/clerk-sdk-go/v2"
	jose "github.com/go-jose/go-jose/v3"
	"github.com/go-jose/go-jose/v3/jwt"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// Security regression (human authorization, 2026-10-21): the gateway passes
// Config.AuthorizedParties to the Clerk check, so a session token minted on
// another origin (its azp) is refused through the full router.
func TestGatewayRefusesClerkTokensFromAnotherOrigin(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const kid = "kid_gateway_azp"
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/jwks" {
			// Profile reads: the account stays unprovisioned (503).
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []jose.JSONWebKey{{
			Key: &key.PublicKey, KeyID: kid, Algorithm: string(jose.RS256), Use: "sig",
		}}})
	}))
	t.Cleanup(jwks.Close)
	previous := clerk.GetBackend()
	clerk.SetBackend(clerk.NewBackend(&clerk.BackendConfig{
		HTTPClient: jwks.Client(),
		URL:        clerk.String(jwks.URL + "/v1"),
		Key:        clerk.String("sk_test_fake"),
	}))
	t.Cleanup(func() { clerk.SetBackend(previous) })

	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	h := New(st, blob.NewMemory(), nil, nil, "docling", Config{
		ClerkSecretKey:      "sk_test_fake",
		AuthorizedParties:   []string{"https://app.example.test"},
		CollaborationSecret: testCollaborationSecret,
	})
	signer, err := jose.NewSigner(jose.SigningKey{
		Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: key, KeyID: kid},
	}, (&jose.SignerOptions{}).WithType("JWT"))
	if err != nil {
		t.Fatal(err)
	}
	status := func(origin string) int {
		t.Helper()
		now := time.Now()
		token, err := jwt.Signed(signer).Claims(jwt.Claims{
			Subject: "user_gateway_azp", Issuer: "https://clerk.example.test",
			IssuedAt: jwt.NewNumericDate(now), NotBefore: jwt.NewNumericDate(now.Add(-time.Minute)),
			Expiry: jwt.NewNumericDate(now.Add(time.Hour)),
		}).Claims(map[string]any{"azp": origin}).CompactSerialize()
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	if got := status("https://evil.example"); got != http.StatusUnauthorized {
		t.Fatalf("token from another origin: %d, want 401", got)
	}
	// The listed origin passes the token check; the unknown account then
	// answers 503 while it cannot be provisioned.
	if got := status("https://app.example.test"); got == http.StatusUnauthorized {
		t.Fatalf("token from the app origin: %d, want it past the token check", got)
	}
}
