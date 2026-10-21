package ops

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
)

// Security regression (human authorization 2026-10-21): the Ops API accepts a
// Clerk session token only when its azp is the Ops page's own origin; a token
// minted for another origin (the main app) is refused, and one without azp
// (Backend API) stays accepted, as on the gateway.
func TestClerkVerifierChecksTheTokensOrigin(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const kid = "kid_ops_azp"
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/jwks" {
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
		HTTPClient: jwks.Client(), URL: clerk.String(jwks.URL + "/v1"), Key: clerk.String("sk_test_fake"),
	}))
	t.Cleanup(func() { clerk.SetBackend(previous) })

	signer, err := jose.NewSigner(jose.SigningKey{
		Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: key, KeyID: kid},
	}, (&jose.SignerOptions{}).WithType("JWT"))
	if err != nil {
		t.Fatal(err)
	}
	token := func(azp string) string {
		now := time.Now()
		builder := jwt.Signed(signer).Claims(jwt.Claims{
			Subject: "user_ops", Issuer: "https://clerk.example.test",
			IssuedAt: jwt.NewNumericDate(now), NotBefore: jwt.NewNumericDate(now.Add(-time.Minute)),
			Expiry: jwt.NewNumericDate(now.Add(time.Hour)),
		})
		if azp != "" {
			builder = builder.Claims(map[string]any{"azp": azp})
		}
		raw, err := builder.CompactSerialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}

	verifier, err := NewClerkVerifier("sk_test_fake", "https://ops.example.test")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		azp string
		ok  bool
	}{
		{"https://ops.example.test", true},
		{"", true},
		{"https://app.example.test", false},
	} {
		userID, err := verifier.Verify(context.Background(), token(test.azp))
		if (err == nil) != test.ok || (test.ok && userID != "user_ops") {
			t.Errorf("azp %q: user %q, err %v, want ok=%v", test.azp, userID, err, test.ok)
		}
	}
}
