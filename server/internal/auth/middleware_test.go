package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

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
