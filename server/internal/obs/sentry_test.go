package obs

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/go-chi/chi/v5/middleware"
)

type eventTransport struct{ events []*sentry.Event }

func (t *eventTransport) Configure(sentry.ClientOptions)        {}
func (t *eventTransport) SendEvent(e *sentry.Event)             { t.events = append(t.events, e) }
func (t *eventTransport) Flush(time.Duration) bool              { return true }
func (t *eventTransport) FlushWithContext(context.Context) bool { return true }
func (t *eventTransport) Close()                                {}

func TestSentryFailureOwnership(t *testing.T) {
	previous := sentry.CurrentHub().Client()
	defer sentry.CurrentHub().BindClient(previous)
	transport := &eventTransport{}
	if err := sentry.Init(sentry.ClientOptions{Dsn: "https://test@example.invalid/1", Transport: transport}); err != nil {
		t.Fatal(err)
	}
	upstream := "0123456789abcdef0123456789abcdef"
	for _, tc := range []struct {
		name          string
		handler       http.HandlerFunc
		count, status int
		eventID       string
	}{
		{"handled original cause", func(w http.ResponseWriter, r *http.Request) {
			RecordHTTPError(r.Context(), errors.New("database failed"))
			w.WriteHeader(500)
		}, 1, 500, ""},
		{"raw handler", func(w http.ResponseWriter, r *http.Request) {
			ResponseError(w, errors.New("raw failure"))
			w.WriteHeader(502)
		}, 1, 502, ""},
		{"health probe", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }, 0, 503, ""},
		{"status fallback", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }, 1, 503, ""},
		{"client error", func(w http.ResponseWriter, r *http.Request) {
			RecordHTTPError(r.Context(), errors.New("bad input"))
			w.WriteHeader(422)
		}, 0, 422, ""},
		{"busy", func(w http.ResponseWriter, r *http.Request) {
			RecordHTTPError(r.Context(), ExpectedError(errors.New("provider busy")))
			w.WriteHeader(503)
		}, 0, 503, ""},
		{"cancelled", func(w http.ResponseWriter, r *http.Request) {
			RecordHTTPError(r.Context(), context.Canceled)
			w.WriteHeader(500)
		}, 0, 500, ""},
		{"upstream event", func(w http.ResponseWriter, r *http.Request) {
			RecordHTTPError(r.Context(), WithEventID(errors.New("upstream"), upstream))
			w.WriteHeader(502)
		}, 0, 502, upstream},
		{"panic", func(w http.ResponseWriter, r *http.Request) { panic("panic failure") }, 1, 500, ""},
		{"panic after stream starts", func(w http.ResponseWriter, r *http.Request) { w.(http.Flusher).Flush(); panic("stream panic") }, 1, 200, ""},
		{"abort handler", func(w http.ResponseWriter, r *http.Request) { panic(http.ErrAbortHandler) }, 0, 200, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			transport.events = nil
			response := httptest.NewRecorder()
			request := httptest.NewRequest("POST", "/test", nil)
			// A client cannot suppress reporting by supplying an event ID.
			request.Header.Set(ErrorEventHeader, upstream)
			if tc.name == "health probe" {
				request.URL.Path = "/healthz"
			}
			func() {
				defer func() {
					if p := recover(); p != nil && p != http.ErrAbortHandler {
						panic(p)
					}
				}()
				Middleware(middleware.Recoverer(SentryMiddleware(tc.handler))).ServeHTTP(response, request)
			}()
			if len(transport.events) != tc.count || response.Code != tc.status {
				t.Fatalf("events=%d status=%d", len(transport.events), response.Code)
			}
			if tc.eventID != "" && response.Header().Get(ErrorEventHeader) != tc.eventID {
				t.Fatal("lost upstream identity")
			}
			if tc.count == 1 && tc.status >= 500 && response.Header().Get(ErrorEventHeader) != string(transport.events[0].EventID) {
				t.Fatal("missing event identity")
			}
			if tc.name == "handled original cause" && transport.events[0].Exception[0].Value != "database failed" {
				t.Fatal("lost original error")
			}
		})
	}
	transport.events = nil
	ctx := context.Background()
	first := errors.New("primary")
	id := CaptureErr(ctx, first, nil)
	marked := WithEventID(first, id)
	CaptureErr(ctx, fmt.Errorf("batch: %w", errors.Join(marked, context.Canceled, errors.New("cleanup"))), nil)
	CaptureErr(ctx, WithEventID(errors.Join(errors.New("already captured batch"), errors.New("also captured")), id), nil)
	if len(transport.events) != 2 {
		t.Fatalf("joined independent failures: got %d events", len(transport.events))
	}
}
