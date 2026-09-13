package obs

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/getsentry/sentry-go"
	sentryhttp "github.com/getsentry/sentry-go/http"
)

type SentryConfig struct {
	DSN string
	// Environment is the Sentry tag, not APP_ENV: UAT runs with
	// APP_ENV=production to exercise production checks, and still has to
	// report as its own environment.
	Environment string
	Release     string
	// SampleRate is read as a string so it can come straight from the
	// environment without every caller re-parsing it.
	SampleRate string
	Service    string
}

// InitSentry configures error reporting and returns a flush function to defer.
// An empty DSN disables Sentry and returns a no-op, which is the normal state
// in development and e2e.
//
// Performance tracing is sampled low by default. Sentry's own distributed
// tracing is not used to stitch services together; the W3C trace id from this
// package is attached as a tag instead, so one id joins Sentry events, log
// lines, and usage_events rows rather than having two competing identifiers.
func InitSentry(cfg SentryConfig) func() {
	if cfg.DSN == "" {
		slog.Info("sentry disabled (no SENTRY_DSN)")
		return func() {}
	}
	rate, err := strconv.ParseFloat(cfg.SampleRate, 64)
	if err != nil || rate < 0 || rate > 1 {
		rate = 0.1
	}
	err = sentry.Init(sentry.ClientOptions{
		Dsn:              cfg.DSN,
		Environment:      cfg.Environment,
		Release:          cfg.Release,
		EnableTracing:    rate > 0,
		TracesSampleRate: rate,
		// Request bodies on this API carry note content and chat prompts.
		SendDefaultPII: false,
		BeforeSend: func(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
			if event.Tags == nil {
				event.Tags = map[string]string{}
			}
			event.Tags["service"] = cfg.Service
			if event.Request != nil {
				event.Request.Data = ""
				event.Request.Cookies = ""
				for name := range event.Request.Headers {
					switch strings.ToLower(name) {
					case "authorization", "cookie", "x-pipeline-secret", "x-collaboration-secret":
						delete(event.Request.Headers, name)
					}
				}
			}
			return event
		},
	})
	if err != nil {
		slog.Error("sentry init failed", "error", err)
		return func() {}
	}
	slog.Info("sentry enabled", "environment", cfg.Environment, "traces_sample_rate", rate)
	return func() { sentry.Flush(2 * time.Second) }
}

// ErrorEventHeader identifies a captured failure in internal service responses.
const ErrorEventHeader = "X-Sentry-Event-Id"
const RetryEventHeader = "X-Sentry-Retry-Event-Id"

var eventIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

func ValidEventID(id string) string {
	if eventIDPattern.MatchString(id) {
		return id
	}
	return ""
}

type reportedError struct {
	error
	id string
}

func (e *reportedError) Unwrap() error         { return e.error }
func (e *reportedError) SentryEventID() string { return e.id }

func ErrorEventID(err error) string {
	var reported interface{ SentryEventID() string }
	if errors.As(err, &reported) {
		return ValidEventID(reported.SentryEventID())
	}
	return ""
}

// WithEventID preserves a reported cause through public-error translation.
func WithEventID(err error, id string) error {
	if err == nil || ValidEventID(id) == "" {
		return err
	}
	return &reportedError{err, id}
}

type expectedError struct{ error }

func (e *expectedError) Unwrap() error { return e.error }
func ExpectedError(err error) error    { return &expectedError{err} }
func isExpected(err error) bool {
	var expected *expectedError
	return err == nil || errors.As(err, &expected) || errors.Is(err, context.Canceled) || errors.Is(err, http.ErrAbortHandler)
}

type responseErrorKey struct{}
type responseErrorState struct {
	err            error
	ctx            context.Context
	retryCandidate string
	retryEventID   string
}

// RecordHTTPError retains the original cause until the response status is known.
func RecordHTTPError(ctx context.Context, err error) {
	if state, ok := ctx.Value(responseErrorKey{}).(*responseErrorState); ok {
		state.err = err
		state.ctx = ctx
	}
}

// ContinueInternalRetry may only be called after service-secret authentication.
// A caller retrying one outstanding save carries its first failure identity.
func ContinueInternalRetry(ctx context.Context) {
	if state, ok := ctx.Value(responseErrorKey{}).(*responseErrorState); ok {
		state.retryEventID = ValidEventID(state.retryCandidate)
	}
}

// ResponseError is the raw-handler equivalent of RecordHTTPError.
func ResponseError(w http.ResponseWriter, err error) {
	for {
		if writer, ok := w.(*errorResponseWriter); ok {
			writer.state.err = err
			return
		}
		unwrapper, ok := w.(interface{ Unwrap() http.ResponseWriter })
		if !ok {
			return
		}
		w = unwrapper.Unwrap()
	}
}

type errorResponseWriter struct {
	http.ResponseWriter
	request *http.Request
	state   *responseErrorState
	status  int
}

func (w *errorResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *errorResponseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	// Informational headers do not commit the final response.
	if status < 200 {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.status = status
	if status >= 500 && w.request.URL.Path != "/healthz" && w.request.URL.Path != "/readyz" {
		err := w.state.err
		if err == nil && errors.Is(w.request.Context().Err(), context.Canceled) {
			err = context.Canceled
		}
		if err == nil {
			err = fmt.Errorf("%s %s: HTTP %d", w.request.Method, w.request.URL.Path, status)
		}
		ctx := w.state.ctx
		if ctx == nil {
			ctx = w.request.Context()
		}
		if w.state.retryEventID != "" {
			Log(ctx).Error("save retry failed", "error", err)
		}
		if id := CaptureErr(ctx, WithEventID(err, w.state.retryEventID), nil); id != "" {
			w.Header().Set(ErrorEventHeader, id)
		}
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *errorResponseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}
func (w *errorResponseWriter) Flush() {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}
func (w *errorResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(w.ResponseWriter).Hijack()
}

// Recovery surrounds this middleware. Sentry owns panic capture; the writer
// owns handled 5xx responses, so a recovered panic cannot produce a second event.
func SentryMiddleware(next http.Handler) http.Handler {
	handler := sentryhttp.New(sentryhttp.Options{Repanic: true})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := &responseErrorState{retryCandidate: r.Header.Get(RetryEventHeader)}
		r = r.WithContext(context.WithValue(r.Context(), responseErrorKey{}, state))
		handler.Handle(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if hub := sentry.GetHubFromContext(r.Context()); hub != nil {
				hub.Scope().SetTag("trace_id", TraceID(r.Context()))
				hub.Scope().AddEventProcessor(func(event *sentry.Event, hint *sentry.EventHint) *sentry.Event {
					if hint != nil && hint.RecoveredException != nil {
						if err, ok := hint.RecoveredException.(error); ok && isExpected(err) {
							return nil
						}
						// The outer recoverer has not committed its 500 yet.
						w.Header().Set(ErrorEventHeader, string(event.EventID))
					}
					return event
				})
			}
			next.ServeHTTP(&errorResponseWriter{ResponseWriter: w, request: r, state: state}, r)
		})).ServeHTTP(w, r)
	})
}

// CaptureErr returns the event identity for callers which relay this failure.
// An already-reported cause is reused; separate errors in a batch stay separate.
func CaptureErr(ctx context.Context, err error, tags map[string]string) string {
	// Inspect aggregates before sentinel matching: one cancelled or reported
	// child must not hide an independent failure in the same batch.
	for current := err; current != nil; current = errors.Unwrap(current) {
		if reported, ok := current.(interface{ SentryEventID() string }); ok {
			if id := ValidEventID(reported.SentryEventID()); id != "" {
				return id
			}
		}
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			var id string
			for _, child := range joined.Unwrap() {
				if captured := CaptureErr(ctx, child, tags); captured != "" {
					id = captured
				}
			}
			return id
		}
	}
	if isExpected(err) {
		return ""
	}
	if id := ErrorEventID(err); id != "" {
		return id
	}
	Log(ctx).Error("captured error", "error", err)
	hub := sentry.GetHubFromContext(ctx)
	if hub == nil {
		hub = sentry.CurrentHub().Clone()
	}
	var id *sentry.EventID
	hub.WithScope(func(scope *sentry.Scope) {
		if traceID := TraceID(ctx); traceID != "" {
			scope.SetTag("trace_id", traceID)
		}
		if userID := UserID(ctx); userID != "" {
			scope.SetUser(sentry.User{ID: userID})
		}
		if component := Component(ctx); component != "" {
			scope.SetTag("component", component)
		}
		for k, v := range tags {
			scope.SetTag(k, v)
		}
		id = hub.CaptureException(err)
	})
	if id == nil {
		return ""
	}
	return string(*id)
}
