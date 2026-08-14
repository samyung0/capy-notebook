// Package obs carries the request identity that every other signal hangs off:
// a W3C trace id shared by the gateway, the Python retrieval service, the
// collaboration server, Sentry, and the usage ledger.
//
// There is no OpenTelemetry SDK here on purpose. The wire format is W3C
// traceparent so an SDK can be dropped in later without re-plumbing callers,
// but the only thing this package does is move an id around and put it on log
// lines.
package obs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"time"
)

type ctxKey int

const (
	ctxKeyTrace ctxKey = iota
	ctxKeySpan
	ctxKeyUser
)

// HeaderTraceparent is the W3C trace context header. HeaderRequestID is echoed
// on responses so a user can quote an id from a failed request in a bug report.
const (
	HeaderTraceparent = "traceparent"
	HeaderRequestID   = "X-Request-Id"
)

// version00 is the only traceparent version defined; anything else is treated
// as absent rather than guessed at.
const version00 = "00"

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is unrecoverable for id generation; a zero id is
		// still better than panicking a request path that is otherwise fine.
		return strings.Repeat("0", n*2)
	}
	return hex.EncodeToString(b)
}

// NewTraceID returns a 16-byte trace id as 32 lowercase hex characters.
func NewTraceID() string { return randomHex(16) }

// NewSpanID returns an 8-byte span id as 16 lowercase hex characters.
func NewSpanID() string { return randomHex(8) }

// parseTraceparent extracts the trace id from a W3C traceparent header. It
// returns "" when the header is missing or malformed, in which case the caller
// mints a fresh trace rather than propagating something unparseable.
func parseTraceparent(header string) string {
	parts := strings.Split(strings.TrimSpace(header), "-")
	if len(parts) != 4 || parts[0] != version00 {
		return ""
	}
	traceID := parts[1]
	if len(traceID) != 32 || !isHex(traceID) || traceID == strings.Repeat("0", 32) {
		return ""
	}
	return strings.ToLower(traceID)
}

func isHex(s string) bool {
	_, err := hex.DecodeString(s)
	return err == nil
}

// WithTrace stores a trace and span id on the context.
func WithTrace(ctx context.Context, traceID, spanID string) context.Context {
	ctx = context.WithValue(ctx, ctxKeyTrace, traceID)
	return context.WithValue(ctx, ctxKeySpan, spanID)
}

// WithUser attaches the authenticated user id so log lines and usage rows can
// name the actor without threading it through every signature.
func WithUser(ctx context.Context, userID string) context.Context {
	if userID == "" {
		return ctx
	}
	return context.WithValue(ctx, ctxKeyUser, userID)
}

func TraceID(ctx context.Context) string { return stringValue(ctx, ctxKeyTrace) }
func SpanID(ctx context.Context) string  { return stringValue(ctx, ctxKeySpan) }
func UserID(ctx context.Context) string  { return stringValue(ctx, ctxKeyUser) }

func stringValue(ctx context.Context, key ctxKey) string {
	if ctx == nil {
		return ""
	}
	v, _ := ctx.Value(key).(string)
	return v
}

// Traceparent renders the context's trace as a header value for outbound calls
// to the pipeline and collaboration services. It returns "" when the context
// carries no trace, so callers can skip setting the header entirely.
func Traceparent(ctx context.Context) string {
	traceID := TraceID(ctx)
	if traceID == "" {
		return ""
	}
	spanID := SpanID(ctx)
	if spanID == "" {
		spanID = NewSpanID()
	}
	return version00 + "-" + traceID + "-" + spanID + "-01"
}

// Inject sets traceparent on an outbound request. Safe to call with a context
// that has no trace; it does nothing in that case.
func Inject(ctx context.Context, req *http.Request) {
	if tp := Traceparent(ctx); tp != "" {
		req.Header.Set(HeaderTraceparent, tp)
	}
}

// Middleware continues an inbound trace or starts a new one, and echoes the
// trace id back so it can be quoted in support requests.
//
// Detached work (the email dispatcher, blob reaper, the save that outlives an
// aborted chat stream) does not inherit this context, so those paths mint their
// own trace via Background.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		traceID := parseTraceparent(r.Header.Get(HeaderTraceparent))
		if traceID == "" {
			traceID = NewTraceID()
		}
		ctx := WithTrace(r.Context(), traceID, NewSpanID())
		w.Header().Set(HeaderRequestID, traceID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Background returns a context carrying a fresh trace, for goroutine workers
// and any save that must outlive a cancelled request.
func Background(ctx context.Context, component string) context.Context {
	ctx = WithTrace(ctx, NewTraceID(), NewSpanID())
	return context.WithValue(ctx, ctxKeyComponent, component)
}

// Detach keeps the identity of ctx but drops its cancellation, for work that
// must complete after the client has gone: settling a charge, saving a partial
// answer, releasing a lease. Keeping the trace is the point — otherwise the
// most interesting failures are the ones that cannot be traced back to the
// request that caused them.
func Detach(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	out := WithTrace(context.Background(), TraceID(ctx), SpanID(ctx))
	out = WithUser(out, UserID(ctx))
	if component := Component(ctx); component != "" {
		out = context.WithValue(out, ctxKeyComponent, component)
	}
	return context.WithTimeout(out, timeout)
}

const ctxKeyComponent ctxKey = 100

// Component names the worker or subsystem a background context belongs to.
func Component(ctx context.Context) string { return stringValue(ctx, ctxKeyComponent) }
