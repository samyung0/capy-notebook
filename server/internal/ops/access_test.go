package ops

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v3"
	"github.com/go-jose/go-jose/v3/jwt"
)

func TestAccessVerifierChecksSignatureIssuerAudienceAndExpiry(t *testing.T) {
	t.Parallel()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const keyID = "access-key"
	public := jose.JSONWebKey{Key: &key.PublicKey, KeyID: keyID, Algorithm: string(jose.RS256)}
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if err := json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{public}}); err != nil {
			t.Error(err)
		}
	}))
	defer jwks.Close()

	const issuer = "https://team.cloudflareaccess.com"
	const audience = "ops-audience"
	verifier, err := NewAccessVerifier(AccessConfig{
		Issuer: issuer, Audience: audience, JWKSURL: jwks.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	type accessClaims struct {
		jwt.Claims
		Email string `json:"email"`
	}
	sign := func(claims jwt.Claims) string {
		t.Helper()
		signer, err := jose.NewSigner(
			jose.SigningKey{Algorithm: jose.RS256, Key: key},
			&jose.SignerOptions{ExtraHeaders: map[jose.HeaderKey]any{jose.HeaderKey("kid"): keyID}},
		)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := jwt.Signed(signer).Claims(accessClaims{
			Claims: claims,
			Email:  "operator@example.com",
		}).CompactSerialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	now := time.Now()
	valid := jwt.Claims{
		Issuer: issuer, Audience: jwt.Audience{audience},
		IssuedAt: jwt.NewNumericDate(now.Add(-time.Minute)),
		Expiry:   jwt.NewNumericDate(now.Add(time.Minute)),
	}
	identity, err := verifier.Verify(context.Background(), sign(valid))
	if err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	if identity.Email != "operator@example.com" {
		t.Fatalf("email = %q", identity.Email)
	}

	wrongAudience := valid
	wrongAudience.Audience = jwt.Audience{"other-audience"}
	if _, err := verifier.Verify(context.Background(), sign(wrongAudience)); err == nil {
		t.Fatal("token with wrong audience accepted")
	}
	wrongIssuer := valid
	wrongIssuer.Issuer = issuer + "/"
	if _, err := verifier.Verify(context.Background(), sign(wrongIssuer)); err == nil {
		t.Fatal("token with non-exact issuer accepted")
	}
	expired := valid
	expired.Expiry = jwt.NewNumericDate(now.Add(-time.Minute))
	if _, err := verifier.Verify(context.Background(), sign(expired)); err == nil {
		t.Fatal("expired token accepted")
	}
	otherKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	originalKey := key
	key = otherKey
	if _, err := verifier.Verify(context.Background(), sign(valid)); err == nil {
		t.Fatal("token with invalid signature accepted")
	}
	key = originalKey
}

func TestAccessVerifierRefreshesJWKSForUnknownKeyID(t *testing.T) {
	t.Parallel()
	oldKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	newKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const oldKeyID = "old-key"
	const newKeyID = "new-key"
	current := jose.JSONWebKey{
		Key: &oldKey.PublicKey, KeyID: oldKeyID, Algorithm: string(jose.RS256),
	}
	var currentMu sync.RWMutex
	var requests atomic.Int32
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		currentMu.RLock()
		defer currentMu.RUnlock()
		if err := json.NewEncoder(w).Encode(
			jose.JSONWebKeySet{Keys: []jose.JSONWebKey{current}},
		); err != nil {
			t.Error(err)
		}
	}))
	defer jwks.Close()
	verifier, err := NewAccessVerifier(AccessConfig{
		Issuer: "https://team.cloudflareaccess.com", Audience: "ops",
		JWKSURL: jwks.URL, TTL: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	sign := func(key *rsa.PrivateKey, keyID string) string {
		t.Helper()
		signer, err := jose.NewSigner(
			jose.SigningKey{Algorithm: jose.RS256, Key: key},
			&jose.SignerOptions{ExtraHeaders: map[jose.HeaderKey]any{
				jose.HeaderKey("kid"): keyID,
			}},
		)
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now()
		raw, err := jwt.Signed(signer).Claims(jwt.Claims{
			Issuer:   "https://team.cloudflareaccess.com",
			Audience: jwt.Audience{"ops"},
			IssuedAt: jwt.NewNumericDate(now.Add(-time.Minute)),
			Expiry:   jwt.NewNumericDate(now.Add(time.Minute)),
		}).CompactSerialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	if _, err := verifier.Verify(
		context.Background(), sign(oldKey, oldKeyID),
	); err != nil {
		t.Fatal(err)
	}
	currentMu.Lock()
	current = jose.JSONWebKey{
		Key: &newKey.PublicKey, KeyID: newKeyID, Algorithm: string(jose.RS256),
	}
	currentMu.Unlock()
	if _, err := verifier.Verify(
		context.Background(), sign(newKey, newKeyID),
	); err != nil {
		t.Fatalf("rotated key rejected: %v", err)
	}
	if requests.Load() != 2 {
		t.Fatalf(
			"JWKS requests = %d, want initial fetch plus unknown-kid refresh",
			requests.Load(),
		)
	}
}

func TestAccessMiddlewareOnlyBypassesHealth(t *testing.T) {
	t.Parallel()
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	handler := AccessMiddleware(nil)(next)

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusNoContent {
		t.Fatalf("health status = %d", health.Code)
	}
	protected := httptest.NewRecorder()
	handler.ServeHTTP(protected, httptest.NewRequest(http.MethodGet, "/", nil))
	if protected.Code != http.StatusServiceUnavailable {
		t.Fatalf("protected status = %d", protected.Code)
	}
}
