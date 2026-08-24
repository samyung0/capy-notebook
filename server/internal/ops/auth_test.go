package ops

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

type fakeCloudflareVerifier struct {
	err   error
	calls *[]string
}

func (f fakeCloudflareVerifier) Verify(
	_ context.Context,
	token string,
) (AccessIdentity, error) {
	*f.calls = append(*f.calls, "cloudflare:"+token)
	return AccessIdentity{}, f.err
}

type fakeClerkVerifier struct {
	userID string
	err    error
	calls  *[]string
}

func (f fakeClerkVerifier) Verify(_ context.Context, token string) (string, error) {
	*f.calls = append(*f.calls, "clerk:"+token)
	return f.userID, f.err
}

type fakeOperatorDirectory struct {
	principal Principal
	lookupErr error
	touchErr  error
	calls     *[]string
}

func (f fakeOperatorDirectory) Lookup(
	_ context.Context,
	userID string,
) (Principal, error) {
	*f.calls = append(*f.calls, "lookup:"+userID)
	return f.principal, f.lookupErr
}

func (f fakeOperatorDirectory) Touch(_ context.Context, userID string) error {
	*f.calls = append(*f.calls, "touch:"+userID)
	return f.touchErr
}

func TestAuthenticatorVerifiesChainTouchesAndSetsPrincipal(t *testing.T) {
	t.Parallel()
	calls := []string{}
	principal := Principal{UserID: "user_1", Role: RoleAdmin}
	authenticator := Authenticator{
		Cloudflare: fakeCloudflareVerifier{calls: &calls},
		Clerk: fakeClerkVerifier{
			userID: principal.UserID,
			calls:  &calls,
		},
		Operators: fakeOperatorDirectory{
			principal: principal,
			calls:     &calls,
		},
	}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, ok := PrincipalFromContext(r.Context())
		if !ok || got != principal {
			t.Fatalf("principal = %+v, %v", got, ok)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	request := httptest.NewRequest(http.MethodGet, "/api/ops/session", nil)
	request.Header.Set(AccessJWTHeader, "access-token")
	request.Header.Set("Authorization", "Bearer clerk-token")
	response := httptest.NewRecorder()

	authenticator.Middleware(next).ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
	}
	want := []string{
		"cloudflare:access-token",
		"clerk:clerk-token",
		"lookup:user_1",
		"touch:user_1",
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("auth calls = %v, want %v", calls, want)
	}
}

func TestAuthenticatorRejectsMissingOperatorBeforeTouch(t *testing.T) {
	t.Parallel()
	calls := []string{}
	authenticator := Authenticator{
		Cloudflare: fakeCloudflareVerifier{calls: &calls},
		Clerk: fakeClerkVerifier{
			userID: "not-an-operator",
			calls:  &calls,
		},
		Operators: fakeOperatorDirectory{
			lookupErr: ErrForbidden,
			calls:     &calls,
		},
	}
	request := httptest.NewRequest(http.MethodGet, "/api/ops/session", nil)
	request.Header.Set(AccessJWTHeader, "access-token")
	request.Header.Set("Authorization", "Bearer clerk-token")
	response := httptest.NewRecorder()

	authenticator.Middleware(http.NotFoundHandler()).ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
	want := []string{
		"cloudflare:access-token",
		"clerk:clerk-token",
		"lookup:not-an-operator",
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("auth calls = %v, want %v", calls, want)
	}
}

func TestAuthenticatorStopsAtRejectedClerkToken(t *testing.T) {
	t.Parallel()
	calls := []string{}
	authenticator := Authenticator{
		Cloudflare: fakeCloudflareVerifier{calls: &calls},
		Clerk: fakeClerkVerifier{
			err:   errors.New("invalid token"),
			calls: &calls,
		},
		Operators: fakeOperatorDirectory{calls: &calls},
	}
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set(AccessJWTHeader, "access-token")
	request.Header.Set("Authorization", "Bearer rejected")
	response := httptest.NewRecorder()

	authenticator.Middleware(http.NotFoundHandler()).ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
	want := []string{"cloudflare:access-token", "clerk:rejected"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("auth calls = %v, want %v", calls, want)
	}
}
