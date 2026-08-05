package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	clerk "github.com/clerk/clerk-sdk-go/v2"
	clerkhttp "github.com/clerk/clerk-sdk-go/v2/http"
	"github.com/clerk/clerk-sdk-go/v2/user"
)

// Header names for the E2E-only identity bypass. Enabled only when Config.E2EAuth
// is true and Config.E2ESecret is non-empty; production must leave both unset.
const (
	HeaderE2EUserID = "X-E2E-User-Id"
	HeaderE2ESecret = "X-E2E-Secret"
)

// Config drives auth middleware behaviour.
type Config struct {
	SecretKey    string
	Disabled     bool // AUTH_DISABLED=true → use DevUserID without JWT
	DevUserID    string
	Store        UserStore
	PublicPrefix []string // path prefixes that skip auth
	// Read-only resource routes may be anonymous; handlers still enforce each
	// resource's private/link/public visibility. Requests that carry credentials
	// (Authorization or E2E headers) are still authenticated so owners keep
	// their identity on private GETs.
	PublicReadPrefix []string
	// E2EAuth enables the X-E2E-User-Id / X-E2E-Secret identity headers.
	// Must only be true in the disposable E2E environment.
	E2EAuth    bool
	E2ESecret  string
	E2EUserIDs []string
}

// UserStore lazily provisions users on first authenticated request and reports
// whether the account may still hold a session.
type UserStore interface {
	// UpsertUserFromClerk returns true when a new user row was inserted.
	UpsertUserFromClerk(ctx context.Context, id, name, email, avatarURL string) (bool, error)
	CreateDefaultWorkspace(ctx context.Context, userID string) error
	// AccountSessionAllowed reports whether the account may hold a session at
	// all. code is a machine-readable reason when it may not. The verdict is
	// reduced to a bool here so this package stays free of the store types.
	AccountSessionAllowed(ctx context.Context, userID string) (allowed bool, code string, err error)
}

func isPublic(path string, prefixes []string) bool {
	for _, p := range prefixes {
		if path == p || strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

func hasBearer(r *http.Request) bool {
	auth := r.Header.Get("Authorization")
	return strings.HasPrefix(strings.ToLower(auth), "bearer ") && len(auth) > len("Bearer ")
}

func hasE2EHeaders(r *http.Request) bool {
	return r.Header.Get(HeaderE2EUserID) != "" || r.Header.Get(HeaderE2ESecret) != ""
}

// tryE2EAuth validates E2E headers when enabled. ok=true means the request is
// authenticated as userID. errWritten=true means a 401 response was already sent.
func tryE2EAuth(w http.ResponseWriter, r *http.Request, cfg Config) (userID string, ok, errWritten bool) {
	if !cfg.E2EAuth {
		if hasE2EHeaders(r) {
			writeUnauthorized(w)
			return "", false, true
		}
		return "", false, false
	}
	if cfg.E2ESecret == "" {
		writeUnauthorized(w)
		return "", false, true
	}
	secret := r.Header.Get(HeaderE2ESecret)
	userID = strings.TrimSpace(r.Header.Get(HeaderE2EUserID))
	if secret == "" && userID == "" {
		return "", false, false
	}
	if secret != cfg.E2ESecret || userID == "" {
		writeUnauthorized(w)
		return "", false, true
	}
	allowed := false
	for _, id := range cfg.E2EUserIDs {
		if userID == id {
			allowed = true
			break
		}
	}
	if !allowed {
		writeUnauthorized(w)
		return "", false, true
	}
	return userID, true, false
}

// Middleware validates Clerk JWTs (or bypasses when Disabled / E2E auth).
func Middleware(cfg Config) func(http.Handler) http.Handler {
	if cfg.DevUserID == "" {
		cfg.DevUserID = "u_1"
	}
	public := append([]string{
		"/healthz",
		"/webhooks/clerk",
		"/webhooks/stripe",
	}, cfg.PublicPrefix...)

	if cfg.SecretKey != "" {
		clerk.SetKey(cfg.SecretKey)
	}

	var clerkMW func(http.Handler) http.Handler
	if cfg.SecretKey != "" && !cfg.Disabled {
		clerkMW = clerkhttp.WithHeaderAuthorization()
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if isPublic(r.URL.Path, public) {
				next.ServeHTTP(w, r)
				return
			}

			// Only /api/* requires auth (except public prefixes above).
			if !strings.HasPrefix(r.URL.Path, "/api/") {
				next.ServeHTTP(w, r)
				return
			}

			publicRead := (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
				isPublic(r.URL.Path, cfg.PublicReadPrefix)
			wantsCredentials := hasBearer(r) || hasE2EHeaders(r)

			// Local development is a single-user authenticated environment.
			// Apply DevUserID before anonymous-public-read handling so private
			// resources remain available when Clerk is intentionally disabled.
			if (cfg.Disabled || cfg.SecretKey == "") && !cfg.E2EAuth {
				if hasE2EHeaders(r) {
					writeUnauthorized(w)
					return
				}
				next.ServeHTTP(w, r.WithContext(WithUserID(r.Context(), cfg.DevUserID)))
				return
			}

			// Anonymous public reads: no credentials → empty user id; handlers
			// enforce private/link/public themselves.
			if publicRead && !wantsCredentials {
				next.ServeHTTP(w, r)
				return
			}

			if userID, ok, written := tryE2EAuth(w, r, cfg); written {
				return
			} else if ok {
				next.ServeHTTP(w, r.WithContext(WithUserID(r.Context(), userID)))
				return
			}

			if cfg.E2EAuth {
				// Protected E2E routes require an allowlisted identity header.
				writeUnauthorized(w)
				return
			}

			if clerkMW == nil {
				writeUnauthorized(w)
				return
			}

			clerkMW(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				claims, ok := clerk.SessionClaimsFromContext(r.Context())
				if !ok || claims == nil || claims.Subject == "" {
					writeUnauthorized(w)
					return
				}
				userID := claims.Subject

				if cfg.Store != nil {
					name, email, avatar := profileFromSession(r.Context(), userID)
					if created, err := cfg.Store.UpsertUserFromClerk(r.Context(), userID, name, email, avatar); err == nil && created {
						_ = cfg.Store.CreateDefaultWorkspace(r.Context(), userID)
					}
					// A purged account is refused here rather than per handler,
					// so a Clerk token that outlived the purge cannot reach any
					// route. Store failures fail open: an unavailable database
					// is a 500 from the handler, not a spurious 403.
					allowed, code, err := cfg.Store.AccountSessionAllowed(r.Context(), userID)
					if err == nil && !allowed {
						writeAccountForbidden(w, code)
						return
					}
				}

				next.ServeHTTP(w, r.WithContext(WithUserID(r.Context(), userID)))
			})).ServeHTTP(w, r)
		})
	}
}

func profileFromSession(ctx context.Context, userID string) (name, email, avatar string) {
	u, err := user.Get(ctx, userID)
	if err != nil || u == nil {
		return "", "", ""
	}
	if u.FirstName != nil || u.LastName != nil {
		parts := []string{}
		if u.FirstName != nil {
			parts = append(parts, *u.FirstName)
		}
		if u.LastName != nil {
			parts = append(parts, *u.LastName)
		}
		name = strings.TrimSpace(strings.Join(parts, " "))
	}
	if u.Username != nil && name == "" {
		name = *u.Username
	}
	if len(u.EmailAddresses) > 0 && u.EmailAddresses[0] != nil {
		email = u.EmailAddresses[0].EmailAddress
	}
	if u.ImageURL != nil {
		avatar = *u.ImageURL
	}
	return name, email, avatar
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": "unauthorized"})
}

// writeAccountForbidden reports a valid identity whose account may not hold a
// session. The code lets the frontend route to the matching screen instead of
// treating it as a generic auth failure and looping through sign-in.
func writeAccountForbidden(w http.ResponseWriter, code string) {
	if code == "" {
		code = "account_locked"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"code":    code,
		"message": "account unavailable",
	})
}
