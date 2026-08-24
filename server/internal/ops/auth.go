package ops

import (
	"context"
	"errors"
	"net/http"
	"strings"

	clerk "github.com/clerk/clerk-sdk-go/v2"
	clerkjwt "github.com/clerk/clerk-sdk-go/v2/jwt"
	"github.com/evonotes/server/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

type CloudflareVerifier interface {
	Verify(context.Context, string) (AccessIdentity, error)
}

type ClerkVerifier interface {
	Verify(context.Context, string) (string, error)
}

type OperatorDirectory interface {
	Lookup(context.Context, string) (Principal, error)
	Touch(context.Context, string) error
}

type clerkVerifier struct{}

func NewClerkVerifier(secretKey string) (ClerkVerifier, error) {
	secretKey = strings.TrimSpace(secretKey)
	if secretKey == "" {
		return nil, errors.New("Clerk secret key is required")
	}
	clerk.SetKey(secretKey)
	return clerkVerifier{}, nil
}

func (clerkVerifier) Verify(ctx context.Context, token string) (string, error) {
	claims, err := clerkjwt.Verify(ctx, &clerkjwt.VerifyParams{Token: token})
	if err != nil {
		return "", err
	}
	if claims == nil || claims.Subject == "" {
		return "", errors.New("Clerk token has no subject")
	}
	return claims.Subject, nil
}

type databaseOperators struct {
	read  *ReadStore
	touch *AuthStore
}

type AuthStore struct{ pool *pgxpool.Pool }

func NewAuthStore(pool *pgxpool.Pool) *AuthStore { return &AuthStore{pool: pool} }

func (s *AuthStore) Touch(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx, `SELECT touch_operator_seen($1)`, userID)
	return err
}

func NewOperatorDirectory(read *ReadStore, touch *AuthStore) OperatorDirectory {
	return &databaseOperators{read: read, touch: touch}
}

func (d *databaseOperators) Lookup(ctx context.Context, userID string) (Principal, error) {
	session, err := d.read.Operator(ctx, userID)
	if err != nil {
		if errors.Is(err, store.ErrForbidden) {
			return Principal{}, ErrForbidden
		}
		return Principal{}, err
	}
	return Principal{UserID: session.UserID, Role: session.Role}, nil
}

func (d *databaseOperators) Touch(ctx context.Context, userID string) error {
	return d.touch.Touch(ctx, userID)
}

type Authenticator struct {
	Cloudflare CloudflareVerifier
	Clerk      ClerkVerifier
	Operators  OperatorDirectory
}

type principalContextKey struct{}

func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalContextKey{}).(Principal)
	return principal, ok
}

func (a Authenticator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		if a.Cloudflare == nil || a.Clerk == nil || a.Operators == nil {
			writeError(w, http.StatusServiceUnavailable, "auth_unavailable", "authentication unavailable")
			return
		}
		assertion := strings.TrimSpace(r.Header.Get(AccessJWTHeader))
		if assertion == "" {
			writeError(w, http.StatusUnauthorized, "access_denied", "Cloudflare Access token required")
			return
		}
		if _, err := a.Cloudflare.Verify(r.Context(), assertion); err != nil {
			writeError(w, http.StatusUnauthorized, "access_denied", "Cloudflare Access token rejected")
			return
		}
		bearer, ok := bearerToken(r.Header.Get("Authorization"))
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Clerk bearer token required")
			return
		}
		userID, err := a.Clerk.Verify(r.Context(), bearer)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Clerk bearer token rejected")
			return
		}
		principal, err := a.Operators.Lookup(r.Context(), userID)
		if errors.Is(err, ErrForbidden) {
			writeError(w, http.StatusForbidden, "not_operator", "operator membership required")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "operator_lookup_failed", "operator lookup failed")
			return
		}
		if err := a.Operators.Touch(r.Context(), userID); err != nil {
			writeError(w, http.StatusInternalServerError, "last_seen_failed", "operator session update failed")
			return
		}
		ctx := context.WithValue(r.Context(), principalContextKey{}, principal)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func bearerToken(value string) (string, bool) {
	parts := strings.Fields(value)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return "", false
	}
	return parts[1], true
}
