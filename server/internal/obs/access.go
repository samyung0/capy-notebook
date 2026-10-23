package obs

import (
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
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
				slog.String("path", LogPath(r.URL.Path)),
				slog.Int("status", ww.Status()),
				slog.Int64("duration_ms", time.Since(start).Milliseconds()),
				slog.Int("bytes", ww.BytesWritten()),
				slog.String("ip", ClientIP(r)),
			}
			aborted := ctx.Err() != nil
			if aborted {
				attrs = append(attrs, slog.Bool("client_aborted", true))
			}
			logger := Log(ctx)
			switch {
			// A 5xx written after the client left reached no one (Sentry
			// drops it too, sentry.go), so it logs as a warning.
			case ww.Status() >= 500 && !aborted:
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

// tokenSegments names, per path prefix, the segment index (in the path split
// on "/") that carries a bearer token: a share token ({id}.{signature}) or an
// invite token. Either opens what it names, so the log keeps only a hash.
var tokenSegments = []struct {
	prefix string
	index  int
}{
	{"/api/public/", 4},            // /api/public/{kind}/{token}/...
	{"/api/workspace-invites/", 3}, // /api/workspace-invites/{token}/accept
}

// LogPath is the request path as logs and telemetry record it: token
// segments become "h_" plus 12 hex of their SHA-256, stable enough to
// correlate one link's requests and useless to open it.
func LogPath(path string) string {
	for _, t := range tokenSegments {
		if !strings.HasPrefix(path, t.prefix) {
			continue
		}
		parts := strings.Split(path, "/")
		if len(parts) > t.index && parts[t.index] != "" {
			sum := sha256.Sum256([]byte(parts[t.index]))
			parts[t.index] = "h_" + hex.EncodeToString(sum[:6])
		}
		return strings.Join(parts, "/")
	}
	return path
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
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ClientAddress is ClientIP as limits count it: an IPv6 address by its /64,
// the block one host is given, as the collaboration server counts sockets
// (collaboration-rs/crates/server/src/http.rs client_address).
func ClientAddress(r *http.Request) string {
	return FoldAddress(ClientIP(r))
}

// FoldAddress turns an IPv6 address into its /64 ("2001:db8:1:2::/64") and
// leaves IPv4 (also IPv4-mapped IPv6) and unparsable values as they are.
func FoldAddress(ip string) string {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	addr = addr.Unmap().WithZone("")
	if addr.Is4() {
		return addr.String()
	}
	prefix, err := addr.Prefix(64)
	if err != nil {
		return ip
	}
	return prefix.String()
}
