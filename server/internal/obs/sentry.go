package obs

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/getsentry/sentry-go"
	sentryhttp "github.com/getsentry/sentry-go/http"
)

type SentryConfig struct {
	DSN         string
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
			event.Tags["service"] = cfg.Service
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

// SentryMiddleware reports panics and makes the hub available to handlers. It
// must run inside Middleware so the trace id is already on the context.
func SentryMiddleware(next http.Handler) http.Handler {
	handler := sentryhttp.New(sentryhttp.Options{
		Repanic: true, // chi's Recoverer still owns the 500 response.
	})
	return handler.Handle(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hub := sentry.GetHubFromContext(r.Context()); hub != nil {
			hub.Scope().SetTag("trace_id", TraceID(r.Context()))
			if userID := UserID(r.Context()); userID != "" {
				hub.Scope().SetUser(sentry.User{ID: userID})
			}
		}
		next.ServeHTTP(w, r)
	}))
}

// CaptureErr reports a handled error that the user did not see as a 500 —
// background worker failures, degraded fallbacks, and anything swallowed to
// keep a request alive. Errors returned to the client as 5xx are already
// captured by the middleware.
func CaptureErr(ctx context.Context, err error, tags map[string]string) {
	if err == nil {
		return
	}
	Log(ctx).Error("captured error", "error", err)

	hub := sentry.GetHubFromContext(ctx)
	if hub == nil {
		hub = sentry.CurrentHub().Clone()
	}
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
		hub.CaptureException(err)
	})
}
