package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/getsentry/sentry-go"
	"github.com/go-chi/chi/v5"

	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A cause that must never reach a response body.
const leakedSecret = "postgres://capy:s3cr3t-password@10.0.0.5:5432/capy"

type failingBody struct{}

func (failingBody) Read([]byte) (int, error) { return 0, errors.New(leakedSecret) }

// Unexpected server errors answer a fixed message and the request's trace
// id, never the cause's text; typed refusals keep their codes and carry no
// cause's text either.
func TestUnexpectedErrorsAnswerTraceIDNotCause(t *testing.T) {
	r := chi.NewRouter()
	r.Use(obs.Middleware)
	h := humachi.New(r, humaConfig())
	fail := func(err error) func(context.Context, *struct{}) (*Empty, error) {
		return func(context.Context, *struct{}) (*Empty, error) { return nil, err }
	}
	reg(h, http.MethodPost, "/mapped", "mapped", "test", "test", 200, fail(hErr(errors.New(leakedSecret))))
	reg(h, http.MethodPost, "/raw", "raw", "test", "test", 200, fail(errors.New(leakedSecret)))
	reg(h, http.MethodPost, "/uncoded", "uncoded", "test", "test", 200, fail(huma.Error503ServiceUnavailable(leakedSecret)))
	reg(h, http.MethodPost, "/detailed", "detailed", "test", "test", 200,
		fail(huma.Error503ServiceUnavailable("unavailable", errors.New(leakedSecret))))
	// A one-word cause looks like a code but is not a typed one.
	reg(h, http.MethodPost, "/oneword", "oneword", "test", "test", 200,
		fail(huma.Error503ServiceUnavailable("unavailable", errors.New("timeout"))))
	reg(h, http.MethodPost, "/bank", "bank", "test", "test", 200, fail(bankHTTPError(errors.New(leakedSecret))))
	reg(h, http.MethodPost, "/authority", "authority", "test", "test", 200,
		fail(hErr(errors.Join(store.ErrAuthorityUnavailable, errors.New(leakedSecret)))))
	reg(h, http.MethodPost, "/busy", "busy", "test", "test", 200, fail(hErr(&providerBusyError{RetryAfterSeconds: 10})))
	reg(h, http.MethodPost, "/conflict", "conflict", "test", "test", 200, fail(hErr(store.ErrTitleTaken)))
	reg(h, http.MethodPost, "/paused", "paused", "test", "test", 200,
		fail(hErr(fmt.Errorf("%s: %w", leakedSecret, store.ErrOfficeEditingPaused))))
	reg(h, http.MethodPost, "/unreadable", "unreadable", "test", "test", 200,
		fail(materialContentError(context.Background(), "m1", errors.New(leakedSecret))))
	type bodyInput struct {
		Body struct {
			Name string `json:"name"`
		}
	}
	reg(h, http.MethodPost, "/body", "body", "test", "test", 200, func(context.Context, *bodyInput) (*Empty, error) { return &Empty{}, nil })
	huma.Register(h, huma.Operation{OperationID: "middleware", Method: http.MethodPost, Path: "/middleware",
		Middlewares: huma.Middlewares{func(ctx huma.Context, _ func(huma.Context)) {
			writeStatusErr(h, ctx, errors.New(leakedSecret))
		}}}, fail(nil))
	huma.Register(h, huma.Operation{OperationID: "typed-middleware", Method: http.MethodPost, Path: "/typed-middleware",
		Middlewares: huma.Middlewares{func(ctx huma.Context, _ func(huma.Context)) {
			writeStatusErr(h, ctx, hErr(errAIUnavailable))
		}}}, fail(nil))
	r.Post("/raw-handler", func(w http.ResponseWriter, _ *http.Request) { (&api{}).fail(w, errors.New(leakedSecret)) })

	for _, tc := range []struct {
		path   string
		status int
		code   string
	}{
		{"/mapped", 500, ""},
		{"/raw", 500, ""},
		{"/uncoded", 503, ""},
		{"/detailed", 503, ""},
		{"/oneword", 503, ""},
		{"/authority", 503, ""},
		{"/body", 500, ""},
		{"/middleware", 500, ""},
		{"/raw-handler", 500, ""},
		{"/busy", 503, "provider_busy"},
		{"/bank", 503, "bank_unavailable"},
		{"/typed-middleware", 503, "ai_unavailable"},
		{"/conflict", 409, "title_taken"},
		{"/paused", 423, "office_editing_paused"},
		{"/unreadable", 422, "material_content_unreadable"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, tc.path, nil)
			if tc.path == "/body" {
				request = httptest.NewRequest(http.MethodPost, tc.path, failingBody{})
				request.Header.Set("Content-Type", "application/json")
			}
			response := httptest.NewRecorder()
			r.ServeHTTP(response, request)
			text := response.Body.String()
			if response.Code != tc.status || strings.Contains(text, "s3cr3t") || strings.Contains(text, `"timeout"`) {
				t.Fatalf("status=%d body=%s", response.Code, text)
			}
			var body struct {
				Detail  string `json:"detail"`
				TraceID string `json:"traceId"`
				Errors  []struct {
					Message string `json:"message"`
				} `json:"errors"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatalf("body=%s: %v", text, err)
			}
			if tc.code != "" {
				if len(body.Errors) != 1 || body.Errors[0].Message != tc.code || body.TraceID != "" {
					t.Fatalf("typed refusal changed: %s", text)
				}
				return
			}
			traceID := response.Header().Get(obs.HeaderRequestID)
			if body.Detail != "Something went wrong" || traceID == "" || body.TraceID != traceID || len(body.Errors) != 0 {
				t.Fatalf("body=%s, request id %q", text, traceID)
			}
		})
	}
}

// The cause of a failure huma answers itself, and of a panic, still reaches
// Sentry while the body stays generic.
func TestUnexpectedErrorsKeepTheirCause(t *testing.T) {
	previous := sentry.CurrentHub().Client()
	defer sentry.CurrentHub().BindClient(previous)
	transport := &sentryTestTransport{}
	if err := sentry.Init(sentry.ClientOptions{Dsn: "https://test@example.invalid/1", Transport: transport}); err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	r.Use(obs.Middleware, obs.AccessLog, recoverer, obs.SentryMiddleware)
	h := humachi.New(r, humaConfig())
	type bodyInput struct {
		Body struct {
			Name string `json:"name"`
		}
	}
	reg(h, http.MethodPost, "/body", "body", "test", "test", 200, func(context.Context, *bodyInput) (*Empty, error) { return &Empty{}, nil })
	r.Post("/panic", func(http.ResponseWriter, *http.Request) { panic(leakedSecret) })

	for _, path := range []string{"/body", "/panic"} {
		t.Run(path, func(t *testing.T) {
			transport.events = nil
			request := httptest.NewRequest(http.MethodPost, path, failingBody{})
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			r.ServeHTTP(response, request)
			var body struct {
				Detail  string `json:"detail"`
				TraceID string `json:"traceId"`
			}
			_ = json.Unmarshal(response.Body.Bytes(), &body)
			if response.Code != 500 || body.Detail != "Something went wrong" ||
				body.TraceID == "" || body.TraceID != response.Header().Get(obs.HeaderRequestID) ||
				strings.Contains(response.Body.String(), "s3cr3t") {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if len(transport.events) != 1 || !strings.Contains(eventText(transport.events[0]), "s3cr3t") {
				t.Fatalf("events=%d, cause not captured", len(transport.events))
			}
		})
	}
}

func eventText(event *sentry.Event) string {
	text := event.Message
	for _, exception := range event.Exception {
		text += " " + exception.Value
	}
	return text
}
