package obs

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// quietPaths are polled by container healthchecks every few seconds and would
// otherwise dominate the log volume.
var quietPaths = map[string]bool{
	"/healthz": true,
	"/readyz":  true,
}

// AccessLog emits one structured line per request. It runs inside Middleware so
// every line carries the trace id, and it is the only place the gateway records
// that a request happened at all.
//
// Streaming responses (SSE chat, ingest events, notifications) are logged when
// the stream closes, so duration_ms is the life of the stream rather than time
// to first byte. That is the useful number for spotting streams that hang.
func AccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if quietPaths[r.URL.Path] {
			next.ServeHTTP(w, r)
			return
		}
		// chi's wrapper preserves Flusher and Hijacker, which SSE and the
		// WebSocket upgrade path both need.
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		start := time.Now()

		defer func() {
			ctx := r.Context()
			attrs := []any{
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", ww.Status()),
				slog.Int64("duration_ms", time.Since(start).Milliseconds()),
				slog.Int("bytes", ww.BytesWritten()),
				slog.String("ip", ClientIP(r)),
			}
			if ctx.Err() != nil {
				attrs = append(attrs, slog.Bool("client_aborted", true))
			}
			logger := Log(ctx)
			switch {
			case ww.Status() >= 500:
				logger.Error("http request", attrs...)
			case ww.Status() >= 400:
				logger.Warn("http request", attrs...)
			default:
				logger.Info("http request", attrs...)
			}
		}()

		next.ServeHTTP(ww, r)
	})
}

// ClientIP resolves the real client address behind Cloudflare.
//
// CF-Connecting-IP is set by Cloudflare on every proxied request and cannot be
// spoofed by the client, because Cloudflare overwrites whatever arrived. This
// is only true while the origin refuses connections that do not come from
// Cloudflare; if the origin is reachable directly, an attacker can forge this
// header and any rate limit keyed on it. See the origin lockdown step in the
// deployment runbook.
func ClientIP(r *http.Request) string {
	if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
		return ip
	}
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if first, _, ok := strings.Cut(fwd, ","); ok {
			return strings.TrimSpace(first)
		}
		return strings.TrimSpace(fwd)
	}
	host, _, found := strings.Cut(r.RemoteAddr, ":")
	if !found {
		return r.RemoteAddr
	}
	return host
}
