package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/getsentry/sentry-go"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

type sentryTestTransport struct{ events []*sentry.Event }

func (t *sentryTestTransport) Configure(sentry.ClientOptions)        {}
func (t *sentryTestTransport) SendEvent(e *sentry.Event)             { t.events = append(t.events, e) }
func (t *sentryTestTransport) Flush(time.Duration) bool              { return true }
func (t *sentryTestTransport) FlushWithContext(context.Context) bool { return true }
func (t *sentryTestTransport) Close()                                {}

func TestSentryHumaResponseOwnership(t *testing.T) {
	previous := sentry.CurrentHub().Client()
	defer sentry.CurrentHub().BindClient(previous)
	transport := &sentryTestTransport{}
	if err := sentry.Init(sentry.ClientOptions{Dsn: "https://test@example.invalid/1", Transport: transport}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name          string
		err           error
		status, count int
	}{
		{"create failure", errors.New("quiz insert failed"), 500, 1},
		{"generation empty", errGenerateEmpty, 502, 1},
		{"pipeline reported", obs.WithEventID(errGenerateEmpty, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), 502, 0},
		{"provider busy", &providerBusyError{RetryAfterSeconds: 10}, 503, 0},
		{"not found", store.ErrNotFound, 404, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			transport.events = nil
			r := chi.NewRouter()
			r.Use(obs.Middleware, middleware.Recoverer, obs.SentryMiddleware)
			api := humachi.New(r, humaConfig())
			reg(api, http.MethodPost, "/test", "test", "test", "test", 201, func(ctx context.Context, _ *struct{}) (*Empty, error) { return nil, hErr(tc.err) })
			response := httptest.NewRecorder()
			r.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/test", nil))
			if response.Code != tc.status || len(transport.events) != tc.count {
				t.Fatalf("status=%d events=%d body=%s", response.Code, len(transport.events), response.Body.String())
			}
			if tc.count == 1 && transport.events[0].Exception[0].Value != tc.err.Error() {
				t.Fatal("original cause missing")
			}
		})
	}
}

func TestSentryRetryRequiresServiceAuthentication(t *testing.T) {
	previous := sentry.CurrentHub().Client()
	defer sentry.CurrentHub().BindClient(previous)
	transport := &sentryTestTransport{}
	if err := sentry.Init(sentry.ClientOptions{Dsn: "https://test@example.invalid/1", Transport: transport}); err != nil {
		t.Fatal(err)
	}
	app := &api{cfg: Config{CollaborationSecret: "service-secret"}}
	r := chi.NewRouter()
	r.Use(obs.Middleware, middleware.Recoverer, obs.SentryMiddleware)
	h := humachi.New(r, humaConfig())
	type retryInput struct {
		Secret string `header:"X-Collaboration-Secret"`
	}
	reg(h, http.MethodPost, "/internal-retry", "retry", "test", "test", 200, func(ctx context.Context, in *retryInput) (*Empty, error) {
		if err := app.checkSourceSecret(ctx, in.Secret); err != nil {
			return nil, err
		}
		return nil, hErr(errors.New("save failed"))
	})
	reg(h, http.MethodPost, "/public", "public", "test", "test", 200, func(ctx context.Context, in *retryInput) (*Empty, error) { return nil, hErr(errors.New("save failed")) })
	for _, tc := range []struct {
		name, path, secret, id string
		status, count          int
	}{
		{"initial failure", "/internal-retry", "service-secret", "", 500, 1},
		{"authenticated retry", "/internal-retry", "service-secret", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 500, 0},
		{"invalid id", "/internal-retry", "service-secret", "not-an-id", 500, 1},
		{"unauthenticated", "/internal-retry", "wrong", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 401, 0},
		{"public spoof", "/public", "service-secret", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 500, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			transport.events = nil
			request := httptest.NewRequest(http.MethodPost, tc.path, nil)
			request.Header.Set("X-Collaboration-Secret", tc.secret)
			request.Header.Set(obs.RetryEventHeader, tc.id)
			response := httptest.NewRecorder()
			r.ServeHTTP(response, request)
			if response.Code != tc.status || len(transport.events) != tc.count {
				t.Fatalf("status=%d events=%d", response.Code, len(transport.events))
			}
			if tc.name == "authenticated retry" && response.Header().Get(obs.ErrorEventHeader) != tc.id {
				t.Fatal("retry identity lost")
			}
		})
	}
}
