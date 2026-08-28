package ratelimit

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/evonotes/server/internal/obs"
)

// class is the route bucket a request falls into. Classes exist because a
// request's cost varies by four orders of magnitude across this API: listing
// workspaces touches one index, while a chat turn runs an agent loop of up to
// four model calls plus embeddings.
type class int

const (
	classExempt class = iota
	classDefault
	classAI
	classEditor
	classUpload
)

// aiSuffixes are the model-backed routes. Matching by suffix rather than exact
// path keeps this correct across the {id} parameter without re-deriving chi's
// route patterns.
var aiSuffixes = []string{
	"/chat/stream",
	"/ai/command",
	"/generate",
	"/quiz-grade",
}

var editorSuffixes = []string{
	"/ai/copilot",
}

var uploadSuffixes = []string{
	"/sources",
	"/sources/uploads",
	"/sources/import",
	"/editor-assets/uploads",
}

// exemptPrefixes must never be limited.
//
// Webhooks are the important entry: Stripe and Clerk deliver subscription and
// identity changes here, and a 429 turns into billing state that silently
// drifts out of sync. They authenticate by signature, and both providers apply
// their own delivery rate, so volume abuse is not a concern.
var exemptPrefixes = []string{
	"/healthz",
	"/readyz",
	"/webhooks/",
	"/api/internal/",
	"/openapi.yaml",
	"/docs",
}

func classify(path string) class {
	for _, prefix := range exemptPrefixes {
		if strings.HasPrefix(path, prefix) {
			return classExempt
		}
	}
	for _, suffix := range editorSuffixes {
		if strings.HasSuffix(path, suffix) {
			return classEditor
		}
	}
	for _, suffix := range aiSuffixes {
		if strings.HasSuffix(path, suffix) {
			return classAI
		}
	}
	for _, suffix := range uploadSuffixes {
		if strings.HasSuffix(path, suffix) {
			return classUpload
		}
	}
	return classDefault
}

// Middleware applies per-user (or per-IP when anonymous) limits. It must run
// after authentication so userFunc can name the caller; unauthenticated
// requests fall back to the client IP, which is only trustworthy while the
// origin refuses non-Cloudflare traffic.
func Middleware(l *Limiter, userFunc func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if l == nil {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			routeClass := classify(r.URL.Path)
			if routeClass == classExempt {
				next.ServeHTTP(w, r)
				return
			}

			ctx := r.Context()
			userID := userFunc(r)
			subject, scope := "ip:"+obs.ClientIP(r), "ip"
			base := l.cfg.Anonymous
			if userID != "" {
				subject, scope = "user:"+userID, "user"
				base = l.cfg.Authenticated
			}

			if ok, retry := l.Allow(ctx, scope+":base:"+subject, base); !ok {
				reject(w, r, retry, "rate_limited")
				return
			}

			// The expensive classes carry a second, tighter budget on top of
			// the general one rather than replacing it, so a caller cannot
			// spend their whole general allowance on model calls.
			switch routeClass {
			case classAI:
				if ok, retry := l.Allow(ctx, "ai:"+subject, l.cfg.AI); !ok {
					reject(w, r, retry, "ai_rate_limited")
					return
				}
				if ok, retry := l.Allow(ctx, "ai-burst:"+subject, l.cfg.AIBurst); !ok {
					reject(w, r, retry, "ai_rate_limited")
					return
				}
			case classEditor:
				if ok, retry := l.Allow(ctx, "editor:"+subject, l.cfg.Editor); !ok {
					reject(w, r, retry, "ai_rate_limited")
					return
				}
			case classUpload:
				if ok, retry := l.Allow(ctx, "upload:"+subject, l.cfg.Upload); !ok {
					reject(w, r, retry, "upload_rate_limited")
					return
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}

func reject(w http.ResponseWriter, r *http.Request, retry time.Duration, code string) {
	seconds := int(retry.Seconds())
	if seconds < 1 {
		seconds = 1
	}
	obs.Log(r.Context()).Warn("rate limited",
		"path", r.URL.Path,
		"code", code,
		"retry_after_s", seconds,
	)
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	_, _ = w.Write([]byte(`{"code":"` + code + `","message":"too many requests","retryAfterSeconds":` + strconv.Itoa(seconds) + `}`))
}
