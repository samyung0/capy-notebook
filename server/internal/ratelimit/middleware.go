package ratelimit

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"math"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/obs"
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
	// classImport is a Drive/OneDrive import route: an upload that also calls
	// Clerk, so it takes both the upload and the integration bucket.
	classImport
	classIntegration
	classIncident
	classThumbnail
	classVoice
)

// aiSuffixes are the model-backed routes. Matching by suffix rather than exact
// path keeps this correct across the {id} parameter without re-deriving chi's
// route patterns.
var aiSuffixes = []string{
	"/chat/stream",
	"/ai/command",
	"/generate",
	// Server grading, which sends open answers to Jev: a review or bank check
	// (quiz attempts are matched in classify; the signed-out grade is under
	// /api/public/), and the author's computation check.
	"/check",
	"/computation-check",
}

var editorSuffixes = []string{
	"/ai/copilot",
}

var importSuffixes = []string{
	"/sources/import",
	"/sources/import-inspect",
	"/sources/import-content",
}

// A gateway upload counts once, at its ticket: the upload itself is refused
// without a ticket whose turn has come.
var uploadSuffixes = []string{
	"/sources/uploads/tickets",
	"/editor-assets/uploads/tickets",
	// A file removed before it was sent, counted into its batch.
	"/removed",
}

// exemptPrefixes must never be limited.
//
// Webhooks are the important entry: Stripe and Clerk deliver subscription and
// identity changes here, and a 429 turns into billing state that silently
// drifts out of sync. They authenticate by signature, and both providers apply
// their own delivery rate; the edge treats any other source normally
// (deploy/cloudflare/rules.json).
var exemptPrefixes = []string{
	"/webhooks/",
	"/api/internal/",
	// Collaboration has no Clerk identity; all rooms share its service IP.
	// The gateway checks X-Collaboration-Secret before reading the body.
	"/internal/collaboration/",
}

func classify(method, path string) class {
	// Container health checks; only these exact paths.
	if path == "/healthz" || path == "/readyz" {
		return classExempt
	}
	for _, prefix := range exemptPrefixes {
		if strings.HasPrefix(path, prefix) {
			return classExempt
		}
	}
	// Signed-out share routes key on the client address, which a whole
	// classroom shares; anonymous grading is bounded by its daily caps instead
	// of the AI burst guard.
	if strings.HasPrefix(path, "/api/public/") {
		return classDefault
	}
	if path == "/api/edit-incidents" {
		return classIncident
	}
	if strings.HasPrefix(path, "/api/files/") && strings.HasSuffix(path, "/thumbnail") {
		return classThumbnail
	}
	// Clerk Backend API callers: the connected providers, picker tokens and
	// disconnects, and a profile save (which reads the Clerk photo).
	if path == "/api/integrations" || strings.HasPrefix(path, "/api/integrations/") ||
		(method == http.MethodPatch && path == "/api/me") {
		return classIntegration
	}
	if strings.HasPrefix(path, "/api/workspaces/") && strings.HasSuffix(path, "/voice-transcriptions") {
		return classVoice
	}
	for _, suffix := range editorSuffixes {
		if strings.HasSuffix(path, suffix) {
			return classEditor
		}
	}
	// POST /api/quizzes/{id}/attempts, but not the GET /api/attempts list.
	if strings.HasPrefix(path, "/api/quizzes/") && strings.HasSuffix(path, "/attempts") {
		return classAI
	}
	for _, suffix := range aiSuffixes {
		if strings.HasSuffix(path, suffix) {
			return classAI
		}
	}
	for _, suffix := range importSuffixes {
		if strings.HasSuffix(path, suffix) {
			return classImport
		}
	}
	for _, suffix := range uploadSuffixes {
		if strings.HasSuffix(path, suffix) {
			return classUpload
		}
	}
	return classDefault
}

// ShareReadHeader is the site Worker's proof on its reads of /api/public/:
// "{unix seconds}.{visitor address}.{base64url HMAC-SHA256 with
// SHARE_LINK_SECRET over "share-read:v2:{unix seconds}:{address}:{path}"}"
// (workers/site/shareRead.ts). The address is the visitor's CF-Connecting-IP,
// which a same-zone Worker subrequest does not carry on its own.
const ShareReadHeader = "X-Capy-Share-Read"

// shareReadWindow is how far a header's time may be from the gateway's: a
// header is good for one path and about a minute.
const shareReadWindow = time.Minute

// publicShareToken returns the share token of a GET or HEAD read under
// /api/public/{kind}/{token}/.
func publicShareToken(r *http.Request) (string, bool) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return "", false
	}
	parts := strings.SplitN(r.URL.Path, "/", 6)
	if len(parts) < 5 || parts[1] != "api" || parts[2] != "public" || parts[4] == "" {
		return "", false
	}
	return parts[4], true
}

// signedVisitor returns the visitor address a valid ShareReadHeader signs for
// this path, within shareReadWindow of now.
func signedVisitor(r *http.Request, secret []byte, now time.Time) (string, bool) {
	if len(secret) == 0 {
		return "", false
	}
	stamp, rest, ok := strings.Cut(r.Header.Get(ShareReadHeader), ".")
	dot := strings.LastIndex(rest, ".")
	if !ok || dot < 0 {
		return "", false
	}
	address, mac := rest[:dot], rest[dot+1:]
	if _, err := netip.ParseAddr(address); err != nil {
		return "", false
	}
	seconds, err := strconv.ParseInt(stamp, 10, 64)
	if err != nil {
		return "", false
	}
	if age := now.Sub(time.Unix(seconds, 0)); age > shareReadWindow || age < -shareReadWindow {
		return "", false
	}
	sum := hmac.New(sha256.New, secret)
	sum.Write([]byte("share-read:v2:" + stamp + ":" + address + ":" + r.URL.Path))
	want := base64.RawURLEncoding.EncodeToString(sum.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(mac)) {
		return "", false
	}
	return address, true
}

// Middleware applies per-user (or per-address when anonymous) limits. It must
// run after authentication so userFunc can name the caller; unauthenticated
// requests fall back to the client address, which is only trustworthy while
// the origin refuses non-Cloudflare traffic.
func Middleware(l *Limiter, userFunc func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if l == nil {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			routeClass := classify(r.Method, r.URL.Path)
			if routeClass == classExempt {
				next.ServeHTTP(w, r)
				return
			}

			userID := userFunc(r)
			// Share reads count per visitor and shared page together (Epo
			// 2026-10-24, Q244): a signed-in visitor by user, a signed-out one
			// by address (IPv6 by its /56), the site Worker's reads by the
			// visitor address they sign; an unsigned or forged claim counts by
			// the request's own address. The bucket replaces the base one, so
			// a read is charged once.
			if token, ok := publicShareToken(r); ok {
				visitor := "user:" + userID
				if userID == "" {
					address, signed := signedVisitor(r, l.cfg.ShareReadSecret, l.clock().Now())
					if !signed {
						address = obs.ClientIP(r)
					}
					visitor = "ip:" + obs.FoldAddress(address)
				}
				share := bucket{key: "share:" + visitor + ":" + token, rule: l.cfg.SharePage, code: "rate_limited"}
				if l.admitOrRefuse(w, r, []bucket{share}, time.Time{}) {
					next.ServeHTTP(w, r)
				}
				return
			}
			subject, scope := "ip:"+obs.ClientAddress(r), "ip"
			base := l.cfg.Anonymous
			if userID != "" {
				subject, scope = "user:"+userID, "user"
				base = l.cfg.Authenticated
			}
			buckets := append([]bucket{{key: scope + ":base:" + subject, rule: base, code: "rate_limited"}},
				l.classBuckets(routeClass, subject)...)

			switch {
			case answerCheck(r.Method, r.URL.Path):
				// An answer check waits behind its spinner, then is graded or
				// refused.
				if !l.admitOrRefuse(w, r, buckets, l.clock().Now().Add(MaxWait)) {
					return
				}
			case chatSend(r.Method, r.URL.Path):
				// A chat send whose AI buckets admit it within MaxWait waits
				// in its stream, which shows the wait (PendingWait).
				deadline := l.clock().Now().Add(MaxWait)
				if !l.admitOrRefuse(w, r, buckets[:1], time.Time{}) {
					return
				}
				rest, refusal, err := l.admit(r.Context(), buckets[1:], time.Time{})
				switch {
				case err != nil:
					unavailable(w, r, err)
					return
				case refusal != nil && refusal.RetryAfter > MaxWait:
					reject(w, r, refusal.RetryAfter, refusal.Code)
					return
				case refusal != nil:
					wait := Wait(func(ctx context.Context) error {
						_, refusal, err := l.admit(ctx, rest, deadline)
						if err != nil {
							return &Refusal{Code: "rate_limit_unavailable", RetryAfter: unavailableRetrySeconds * time.Second}
						}
						if refusal != nil {
							return refusal
						}
						return nil
					})
					r = r.WithContext(context.WithValue(r.Context(), waitKey{}, wait))
				}
			default:
				if !l.admitOrRefuse(w, r, buckets, time.Time{}) {
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// classBuckets are the tighter budgets the expensive classes carry on top of
// the general one rather than replacing it, so a caller cannot spend their
// whole general allowance on model calls. The AI and upload buckets refuse
// while Redis cannot count them.
func (l *Limiter) classBuckets(routeClass class, subject string) []bucket {
	switch routeClass {
	case classAI:
		return []bucket{
			{key: "ai:" + subject, rule: l.cfg.AI, code: "ai_rate_limited", failClosed: true},
			{key: "ai-burst:" + subject, rule: l.cfg.AIBurst, code: "ai_rate_limited", failClosed: true},
		}
	case classEditor:
		return []bucket{{key: "editor:" + subject, rule: l.cfg.Editor, code: "ai_rate_limited"}}
	case classUpload:
		return []bucket{{key: "upload:" + subject, rule: l.cfg.Upload, code: "upload_rate_limited", failClosed: true}}
	case classImport:
		return []bucket{
			{key: "upload:" + subject, rule: l.cfg.Upload, code: "upload_rate_limited", failClosed: true},
			{key: "integration:" + subject, rule: l.cfg.Integration, code: "rate_limited"},
		}
	case classIntegration:
		return []bucket{{key: "integration:" + subject, rule: l.cfg.Integration, code: "rate_limited"}}
	case classIncident:
		return []bucket{{key: "incident:" + subject, rule: l.cfg.Incident, code: "rate_limited"}}
	case classThumbnail:
		return []bucket{{key: "thumbnail:" + subject, rule: l.cfg.Thumbnail, code: "rate_limited"}}
	case classVoice:
		// Each recording is a paid transcription, so it refuses like the AI
		// class while Redis cannot count it.
		return []bucket{{key: "voice:" + subject, rule: l.cfg.Voice, code: "ai_rate_limited", failClosed: true}}
	}
	return nil
}

// admitOrRefuse admits the request through buckets by deadline, or answers
// the refusal (429, or 503 while a fail-closed bucket cannot be counted) and
// reports false.
func (l *Limiter) admitOrRefuse(w http.ResponseWriter, r *http.Request, buckets []bucket, deadline time.Time) bool {
	_, refusal, err := l.admit(r.Context(), buckets, deadline)
	switch {
	case err != nil:
		unavailable(w, r, err)
		return false
	case refusal != nil:
		reject(w, r, refusal.RetryAfter, refusal.Code)
		return false
	}
	return true
}

func reject(w http.ResponseWriter, r *http.Request, retry time.Duration, code string) {
	// Rounded up: a client that waits exactly this long is let through.
	seconds := max(int(math.Ceil(retry.Seconds())), 1)
	obs.Log(r.Context()).Warn("rate limited",
		"path", obs.LogPath(r.URL.Path),
		"code", code,
		"retry_after_s", seconds,
	)
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	_, _ = w.Write([]byte(`{"code":"` + code + `","message":"too many requests","retryAfterSeconds":` + strconv.Itoa(seconds) + `}`))
}

// unavailableRetrySeconds is the wait a fail-closed refusal names.
const unavailableRetrySeconds = 5

func unavailable(w http.ResponseWriter, r *http.Request, err error) {
	obs.Log(r.Context()).Warn("rate limiter unavailable",
		"path", obs.LogPath(r.URL.Path),
		"error", err,
	)
	w.Header().Set("Retry-After", strconv.Itoa(unavailableRetrySeconds))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write([]byte(`{"code":"rate_limit_unavailable","message":"try again shortly","retryAfterSeconds":` +
		strconv.Itoa(unavailableRetrySeconds) + `}`))
}
