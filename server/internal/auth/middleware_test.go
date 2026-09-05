package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type lockedSessionStore struct{ code string }

func (s lockedSessionStore) AccountSessionAllowed(context.Context, string) (bool, string, error) {
	return false, s.code, nil
}
func (lockedSessionStore) UpsertUserFromClerk(context.Context, string, string, string, string) (bool, error) {
	return false, nil
}
func (lockedSessionStore) CreateDefaultWorkspace(context.Context, string) error { return nil }
func (lockedSessionStore) UserProvisioned(context.Context, string) (bool, error) {
	return true, nil
}

type unavailableSessionStore struct{}

func (unavailableSessionStore) AccountSessionAllowed(context.Context, string) (bool, string, error) {
	return false, "", errors.New("database unavailable")
}
func (unavailableSessionStore) UpsertUserFromClerk(context.Context, string, string, string, string) (bool, error) {
	return false, nil
}
func (unavailableSessionStore) CreateDefaultWorkspace(context.Context, string) error { return nil }
func (unavailableSessionStore) UserProvisioned(context.Context, string) (bool, error) {
	return true, nil
}

type provisioningStore struct {
	provisioned           bool
	provisionErr          error
	upsertErr             error
	upsertCalls           int
	needsDefaultWorkspace bool
	defaultWorkspaceErr   error
	defaultWorkspaceCalls int
}

func (s *provisioningStore) AccountSessionAllowed(context.Context, string) (bool, string, error) {
	return true, "", nil
}
func (s *provisioningStore) UpsertUserFromClerk(context.Context, string, string, string, string) (bool, error) {
	s.upsertCalls++
	return s.needsDefaultWorkspace, s.upsertErr
}
func (s *provisioningStore) CreateDefaultWorkspace(context.Context, string) error {
	s.defaultWorkspaceCalls++
	if s.defaultWorkspaceErr == nil {
		s.needsDefaultWorkspace = false
	}
	return s.defaultWorkspaceErr
}
func (s *provisioningStore) UserProvisioned(context.Context, string) (bool, error) {
	return s.provisioned, s.provisionErr
}

func TestClerkProfileFailureSkipsSyncForExistingAccount(t *testing.T) {
	store := &provisioningStore{provisioned: true}
	err := syncClerkAccount(context.Background(), store, "u_existing",
		func(context.Context, string) (string, string, string, error) {
			return "", "", "", errors.New("Clerk unavailable")
		})
	if err != nil {
		t.Fatalf("existing account profile refresh: %v", err)
	}
	if store.upsertCalls != 0 {
		t.Fatalf("failed profile fetch performed %d upserts, want 0", store.upsertCalls)
	}
	if store.defaultWorkspaceCalls != 1 {
		t.Fatalf("failed profile fetch performed %d starter checks, want 1", store.defaultWorkspaceCalls)
	}
}

func TestClerkProfileFailureRefusesUnknownIdentity(t *testing.T) {
	store := &provisioningStore{}
	err := syncClerkAccount(context.Background(), store, "u_unknown",
		func(context.Context, string) (string, string, string, error) {
			return "", "", "", errors.New("Clerk unavailable")
		})
	if !errors.Is(err, errAccountNotProvisioned) {
		t.Fatalf("profile failure = %v, want account-not-provisioned", err)
	}
	if store.upsertCalls != 0 {
		t.Fatalf("failed profile fetch performed %d upserts, want 0", store.upsertCalls)
	}
}

func TestClerkProvisioningFailureRequiresKnownLocalAccount(t *testing.T) {
	fetch := func(context.Context, string) (string, string, string, error) {
		return "User", "user@example.test", "", nil
	}
	for _, tc := range []struct {
		name        string
		provisioned bool
		wantErr     bool
	}{
		{name: "concurrent request already provisioned", provisioned: true},
		{name: "identity remains unknown", provisioned: false, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &provisioningStore{
				provisioned: tc.provisioned,
				upsertErr:   errors.New("model defaults unavailable"),
			}
			err := syncClerkAccount(context.Background(), store, "u_first", fetch)
			if tc.wantErr && !errors.Is(err, errAccountNotProvisioned) {
				t.Fatalf("provisioning error = %v, want account-not-provisioned", err)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("concurrent provisioning returned %v", err)
			}
		})
	}
}

func TestClerkStarterWorkspaceFailureIsRetryable(t *testing.T) {
	fetch := func(context.Context, string) (string, string, string, error) {
		return "User", "user@example.test", "", nil
	}
	store := &provisioningStore{
		provisioned:           true,
		needsDefaultWorkspace: true,
		defaultWorkspaceErr:   errors.New("workspace insert unavailable"),
	}
	if err := syncClerkAccount(context.Background(), store, "u_first", fetch); err == nil {
		t.Fatal("starter workspace failure was ignored")
	}
	if store.defaultWorkspaceCalls != 1 || !store.needsDefaultWorkspace {
		t.Fatalf("first attempt calls=%d pending=%v", store.defaultWorkspaceCalls, store.needsDefaultWorkspace)
	}

	store.defaultWorkspaceErr = nil
	if err := syncClerkAccount(context.Background(), store, "u_first", fetch); err != nil {
		t.Fatalf("starter workspace retry: %v", err)
	}
	if store.defaultWorkspaceCalls != 2 || store.needsDefaultWorkspace {
		t.Fatalf("retry calls=%d pending=%v", store.defaultWorkspaceCalls, store.needsDefaultWorkspace)
	}
}

func TestPublicReadPrefixOnlyBypassesReads(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if UserID(r.Context()) != "" {
			t.Fatalf("anonymous public read unexpectedly had user %q", UserID(r.Context()))
		}
		w.WriteHeader(http.StatusNoContent)
	})
	handler := Middleware(Config{
		SecretKey:        "test-secret",
		PublicReadPrefix: []string{"/api/workspaces/"},
	})(next)

	get := httptest.NewRecorder()
	handler.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/workspaces/ws_shared", nil))
	if get.Code != http.StatusNoContent {
		t.Fatalf("shared GET returned %d", get.Code)
	}

	post := httptest.NewRecorder()
	handler.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/api/workspaces/ws_shared", nil))
	if post.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous write returned %d", post.Code)
	}
}

func TestDisabledAuthUsesDevUserForAllAPIReads(t *testing.T) {
	var seen string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = UserID(r.Context())
		w.WriteHeader(http.StatusNoContent)
	})
	handler := Middleware(Config{
		Disabled:         true,
		DevUserID:        "u_owner",
		PublicReadPrefix: []string{"/api/workspaces/"},
	})(next)

	seen = "unset"
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/workspaces/ws_1", nil))
	if seen != "u_owner" {
		t.Fatalf("public GET user = %q, want u_owner", seen)
	}

	seen = "unset"
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/me", nil))
	if seen != "u_owner" {
		t.Fatalf("protected GET user = %q, want u_owner", seen)
	}
}

func TestMissingClerkSecretDoesNotEnableDevelopmentIdentity(t *testing.T) {
	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	})
	rec := httptest.NewRecorder()
	Middleware(Config{DevUserID: "u_owner"})(next).ServeHTTP(
		rec,
		httptest.NewRequest(http.MethodGet, "/api/me", nil),
	)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing Clerk secret returned %d, want 401", rec.Code)
	}
	if called {
		t.Fatal("missing Clerk secret reached the handler as the development user")
	}
}

func TestDevAndE2EIdentitiesHonorLockedAccountBoundary(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	for _, tc := range []struct {
		name string
		cfg  Config
		req  func() *http.Request
	}{
		{
			name: "development",
			cfg: Config{Disabled: true, DevUserID: "u_locked",
				Store: lockedSessionStore{code: "account_suspended"}},
			req: func() *http.Request {
				return httptest.NewRequest(http.MethodGet, "/api/me", nil)
			},
		},
		{
			name: "e2e",
			cfg: Config{Disabled: true, E2EAuth: true, E2ESecret: "secret",
				E2EUserIDs: []string{"u_locked"},
				Store:      lockedSessionStore{code: "account_deletion_pending"}},
			req: func() *http.Request {
				req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
				req.Header.Set(HeaderE2EUserID, "u_locked")
				req.Header.Set(HeaderE2ESecret, "secret")
				return req
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			Middleware(tc.cfg)(next).ServeHTTP(rec, tc.req())
			if rec.Code != http.StatusForbidden {
				t.Fatalf("locked identity returned %d, want 403", rec.Code)
			}
		})
	}
}

func TestAccountStateLookupFailureFailsClosed(t *testing.T) {
	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	})
	rec := httptest.NewRecorder()
	Middleware(Config{
		Disabled:  true,
		DevUserID: "u_unknown",
		Store:     unavailableSessionStore{},
	})(next).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/me", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("lookup failure returned %d, want 503", rec.Code)
	}
	if called {
		t.Fatal("request reached handler when account state was unknown")
	}
}

func TestE2EAuthPropagatesIdentityOnPublicReads(t *testing.T) {
	var seen string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = UserID(r.Context())
		w.WriteHeader(http.StatusNoContent)
	})
	handler := Middleware(Config{
		Disabled:         true,
		E2EAuth:          true,
		E2ESecret:        "s3cret",
		E2EUserIDs:       []string{"u_owner"},
		PublicReadPrefix: []string{"/api/workspaces/"},
	})(next)

	req := httptest.NewRequest(http.MethodGet, "/api/workspaces/ws_private", nil)
	req.Header.Set(HeaderE2EUserID, "u_owner")
	req.Header.Set(HeaderE2ESecret, "s3cret")
	handler.ServeHTTP(httptest.NewRecorder(), req)
	if seen != "u_owner" {
		t.Fatalf("E2E public GET user = %q, want u_owner", seen)
	}
}

func TestE2EAuthRejectsInvalidSecret(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	handler := Middleware(Config{
		Disabled:   true,
		E2EAuth:    true,
		E2ESecret:  "s3cret",
		E2EUserIDs: []string{"u_owner"},
	})(next)

	req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	req.Header.Set(HeaderE2EUserID, "u_owner")
	req.Header.Set(HeaderE2ESecret, "wrong")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("invalid E2E secret returned %d", rec.Code)
	}
}

func TestE2EAuthFailClosedWithoutHeaders(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	handler := Middleware(Config{
		Disabled:   true,
		DevUserID:  "u_1",
		E2EAuth:    true,
		E2ESecret:  "s3cret",
		E2EUserIDs: []string{"u_owner"},
	})(next)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/me", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("E2E protected route without headers returned %d", rec.Code)
	}
}

func TestE2EAuthRejectsUnallowlistedUser(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	handler := Middleware(Config{
		Disabled:   true,
		E2EAuth:    true,
		E2ESecret:  "s3cret",
		E2EUserIDs: []string{"u_owner"},
	})(next)

	req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	req.Header.Set(HeaderE2EUserID, "u_attacker")
	req.Header.Set(HeaderE2ESecret, "s3cret")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unallowlisted E2E user returned %d", rec.Code)
	}
}

func TestE2EHeadersRejectedWhenDisabled(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	handler := Middleware(Config{
		Disabled:  true,
		DevUserID: "u_1",
	})(next)

	req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	req.Header.Set(HeaderE2EUserID, "u_attacker")
	req.Header.Set(HeaderE2ESecret, "anything")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("E2E headers outside E2E mode returned %d", rec.Code)
	}
}
