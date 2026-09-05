package ops

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/obs"
)

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

func TestAuthenticatorVerifiesClerkTouchesAndSetsPrincipal(t *testing.T) {
	t.Parallel()
	calls := []string{}
	principal := Principal{UserID: "user_1", Role: RoleAdmin}
	authenticator := Authenticator{
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
		if !ok || !reflect.DeepEqual(got, principal) {
			t.Fatalf("principal = %+v, %v", got, ok)
		}
		if got := obs.UserID(r.Context()); got != principal.UserID {
			t.Fatalf("observability user = %q, want %q", got, principal.UserID)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	request := httptest.NewRequest(http.MethodGet, "/api/ops/session", nil)
	request.Header.Set("Authorization", "Bearer clerk-token")
	response := httptest.NewRecorder()

	authenticator.Middleware(next).ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
	}
	want := []string{
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
	request.Header.Set("Authorization", "Bearer clerk-token")
	response := httptest.NewRecorder()

	authenticator.Middleware(http.NotFoundHandler()).ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
	want := []string{
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
		Clerk: fakeClerkVerifier{
			err:   errors.New("invalid token"),
			calls: &calls,
		},
		Operators: fakeOperatorDirectory{calls: &calls},
	}
	request := httptest.NewRequest(http.MethodGet, "/api/ops/session", nil)
	request.Header.Set("Authorization", "Bearer rejected")
	response := httptest.NewRecorder()

	authenticator.Middleware(http.NotFoundHandler()).ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
	want := []string{"clerk:rejected"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("auth calls = %v, want %v", calls, want)
	}
}

func TestAuthenticatorLeavesStaticFilesForAccessMiddleware(t *testing.T) {
	t.Parallel()
	calls := []string{}
	authenticator := Authenticator{
		Clerk:     fakeClerkVerifier{calls: &calls},
		Operators: fakeOperatorDirectory{calls: &calls},
	}
	request := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	response := httptest.NewRecorder()

	authenticator.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})).ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
	}
	if len(calls) != 0 {
		t.Fatalf("static request made auth calls: %v", calls)
	}
}

func TestAuthenticatorUsesDevUserWhenAuthDisabled(t *testing.T) {
	t.Parallel()
	calls := []string{}
	principal := Principal{UserID: "u_1", Role: RoleAdmin}
	authenticator := Authenticator{
		AuthDisabled: true,
		DevUserID:    principal.UserID,
		Operators: fakeOperatorDirectory{
			principal: principal,
			calls:     &calls,
		},
	}
	request := httptest.NewRequest(http.MethodGet, "/api/ops/session", nil)
	response := httptest.NewRecorder()

	authenticator.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, ok := PrincipalFromContext(r.Context())
		if !ok || !reflect.DeepEqual(got, principal) {
			t.Fatalf("principal = %+v, %v", got, ok)
		}
		w.WriteHeader(http.StatusNoContent)
	})).ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
	}
	want := []string{"lookup:u_1", "touch:u_1"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("auth calls = %v, want %v", calls, want)
	}
}

func TestAuthenticatorReportsLastSeenFailureAndContinues(t *testing.T) {
	t.Parallel()
	calls := []string{}
	touchErr := errors.New("database unavailable")
	principal := Principal{UserID: "u_1", Role: RoleViewer}
	var captured error
	var capturedTrace string
	var capturedUser string
	var capturedTags map[string]string
	authenticator := Authenticator{
		Clerk: fakeClerkVerifier{userID: principal.UserID, calls: &calls},
		Operators: fakeOperatorDirectory{
			principal: principal,
			touchErr:  touchErr,
			calls:     &calls,
		},
		CaptureError: func(ctx context.Context, err error, tags map[string]string) {
			captured = err
			capturedTrace = obs.TraceID(ctx)
			capturedUser = obs.UserID(ctx)
			capturedTags = tags
		},
	}
	request := httptest.NewRequest(http.MethodGet, "/api/ops/session", nil)
	request = request.WithContext(obs.WithTrace(request.Context(), "trace-1", "span-1"))
	request.Header.Set("Authorization", "Bearer clerk-token")
	response := httptest.NewRecorder()

	authenticator.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})).ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
	}
	if !errors.Is(captured, touchErr) || capturedTrace != "trace-1" ||
		capturedUser != principal.UserID {
		t.Fatalf(
			"captured error = %v, trace = %q, user = %q",
			captured,
			capturedTrace,
			capturedUser,
		)
	}
	if capturedTags["component"] != "operator_last_seen" ||
		capturedTags["operation"] != "touch_operator_seen" {
		t.Fatalf("captured tags = %#v", capturedTags)
	}
}
