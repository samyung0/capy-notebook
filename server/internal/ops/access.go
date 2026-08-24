package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	jose "github.com/go-jose/go-jose/v3"
	"github.com/go-jose/go-jose/v3/jwt"
)

const AccessJWTHeader = "Cf-Access-Jwt-Assertion"

type AccessConfig struct {
	Issuer, Audience, JWKSURL string
	TTL                       time.Duration
	Client                    *http.Client
}

type AccessIdentity struct{ Email string }

type AccessVerifier struct {
	issuer, audience, jwksURL string
	ttl                       time.Duration
	client                    *http.Client
	mu                        sync.Mutex
	keys                      jose.JSONWebKeySet
	fetchedAt                 time.Time
}

func NewAccessVerifier(config AccessConfig) (*AccessVerifier, error) {
	config.Issuer = strings.TrimSpace(config.Issuer)
	config.Audience = strings.TrimSpace(config.Audience)
	config.JWKSURL = strings.TrimSpace(config.JWKSURL)
	if config.Issuer == "" || config.Audience == "" {
		return nil, errors.New("Cloudflare Access issuer and audience are required")
	}
	issuerURL, err := url.Parse(config.Issuer)
	if err != nil || issuerURL.Scheme != "https" || issuerURL.Host == "" ||
		issuerURL.Path != "" || issuerURL.RawQuery != "" || issuerURL.Fragment != "" {
		return nil, errors.New("Cloudflare Access issuer must be an HTTPS origin")
	}
	if config.JWKSURL == "" {
		config.JWKSURL = config.Issuer + "/cdn-cgi/access/certs"
	}
	if config.TTL <= 0 {
		config.TTL = 15 * time.Minute
	}
	if config.TTL > time.Hour {
		config.TTL = time.Hour
	}
	if config.Client == nil {
		config.Client = &http.Client{Timeout: 10 * time.Second}
	}
	return &AccessVerifier{
		issuer: config.Issuer, audience: config.Audience, jwksURL: config.JWKSURL,
		ttl: config.TTL, client: config.Client,
	}, nil
}

func (v *AccessVerifier) Verify(ctx context.Context, raw string) (AccessIdentity, error) {
	token, err := jwt.ParseSigned(strings.TrimSpace(raw))
	if err != nil || len(token.Headers) != 1 {
		return AccessIdentity{}, errors.New("invalid Cloudflare Access token")
	}
	header := token.Headers[0]
	if header.Algorithm != string(jose.RS256) || header.KeyID == "" {
		return AccessIdentity{}, errors.New("unsupported Cloudflare Access token signature")
	}
	keys, err := v.keysFor(ctx, header.KeyID, false)
	if err != nil {
		return AccessIdentity{}, err
	}
	if len(keys) == 0 {
		keys, err = v.keysFor(ctx, header.KeyID, true)
		if err != nil {
			return AccessIdentity{}, err
		}
	}
	if len(keys) == 0 {
		return AccessIdentity{}, errors.New("Cloudflare Access signing key not found")
	}
	type accessClaims struct {
		jwt.Claims
		Email string `json:"email"`
	}
	lastErr := errors.New("signature rejected")
	for _, key := range keys {
		var claims accessClaims
		if err := token.Claims(key.Key, &claims); err != nil {
			lastErr = err
			continue
		}
		if claims.Expiry == nil || claims.IssuedAt == nil {
			lastErr = errors.New("Cloudflare Access token needs issued-at and expiry claims")
			continue
		}
		if len(claims.Audience) != 1 || claims.Audience[0] != v.audience {
			lastErr = errors.New("Cloudflare Access token has wrong audience")
			continue
		}
		if err := claims.ValidateWithLeeway(jwt.Expected{
			Issuer: v.issuer, Audience: jwt.Audience{v.audience}, Time: time.Now(),
		}, 30*time.Second); err != nil {
			lastErr = err
			continue
		}
		return AccessIdentity{Email: claims.Email}, nil
	}
	return AccessIdentity{}, fmt.Errorf("verify Cloudflare Access token: %w", lastErr)
}

func (v *AccessVerifier) keysFor(
	ctx context.Context,
	kid string,
	force bool,
) ([]jose.JSONWebKey, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if force || v.fetchedAt.IsZero() || time.Since(v.fetchedAt) >= v.ttl {
		if err := v.refreshLocked(ctx); err != nil {
			return nil, err
		}
	}
	return v.keys.Key(kid), nil
}

func (v *AccessVerifier) refreshLocked(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return err
	}
	response, err := v.client.Do(req)
	if err != nil {
		return fmt.Errorf("fetch Cloudflare Access JWKS: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch Cloudflare Access JWKS: status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read Cloudflare Access JWKS: %w", err)
	}
	var keys jose.JSONWebKeySet
	if err := json.Unmarshal(body, &keys); err != nil {
		return fmt.Errorf("decode Cloudflare Access JWKS: %w", err)
	}
	if len(keys.Keys) == 0 {
		return errors.New("Cloudflare Access JWKS is empty")
	}
	v.keys, v.fetchedAt = keys, time.Now()
	return nil
}

func AccessMiddleware(verifier *AccessVerifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/healthz" {
				next.ServeHTTP(w, r)
				return
			}
			if verifier == nil {
				writeError(
					w, http.StatusServiceUnavailable, "access_not_configured",
					"access gate unavailable",
				)
				return
			}
			if _, err := verifier.Verify(
				r.Context(), r.Header.Get(AccessJWTHeader),
			); err != nil {
				writeError(
					w, http.StatusUnauthorized, "access_denied",
					"Cloudflare Access token rejected",
				)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
