// Package ratelimit is the gateway's request limiter: per user, per route
// class, and per client address (IPv6 by its /56) for signed-out callers.
//
// The edge adds one rule only (deploy/cloudflare/rules.json, Free plan): per IP
// over ten seconds on /api/public/. Everything else, chat and uploads included,
// is bounded here or not at all, and the edge never sees the Clerk identity.
//
// Spend is limited elsewhere. The credits ledger in internal/store gates model
// usage by cost; this package only bounds request volume.
package ratelimit

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// Rule is a token bucket: Limit requests per Window, with Burst tokens
// available immediately. Burst defaults to Limit when zero.
type Rule struct {
	Limit  int
	Window time.Duration
	Burst  int
}

func (r Rule) enabled() bool { return r.Limit > 0 && r.Window > 0 }

func (r Rule) burst() int {
	if r.Burst > 0 {
		return r.Burst
	}
	return r.Limit
}

// Config is the full set of limits. A zero Rule disables that class.
type Config struct {
	// Disabled turns the middleware into a passthrough. Set for e2e, where
	// tests fire hundreds of requests in seconds.
	Disabled bool
	// Anonymous applies to unauthenticated requests, keyed by client IP.
	Anonymous Rule
	// Authenticated applies to ordinary API traffic, keyed by user id.
	Authenticated Rule
	// AI applies to the expensive model-backed routes (chat, generate,
	// plate command) on top of Authenticated.
	AI Rule
	// AIBurst is a short-window guard so a scripted loop trips something
	// immediately even when the hourly budget still has room.
	AIBurst Rule
	// Editor applies to cheap inline editor completions so typing in the
	// note does not consume the chat allowance.
	Editor Rule
	// Upload applies to upload tickets and import routes, which are cheap
	// to call but expensive downstream once ingest picks them up.
	Upload Rule
	// Incident applies to the browser's editing incident reports, a few an
	// hour from a working client; each one is a row kept 90 days.
	Incident Rule
	// Thumbnail applies to browser thumbnail captures of edited Office files,
	// on top of the per-file minimum interval the handler enforces.
	Thumbnail Rule
	// Integration applies to the routes that call Clerk's Backend API
	// (integrations, Drive/OneDrive imports, a profile save), whose limit the
	// whole instance shares.
	Integration Rule
	// StripeSession counts the Stripe Checkout and portal sessions one user's
	// requests create; a reused open Checkout takes none.
	StripeSession Rule
	// SharePage applies per visitor and share token to every GET or HEAD
	// under /api/public/{kind}/{token}/, from a browser or through the site
	// Worker (whose ShareReadHeader signs the visitor's address), instead of
	// the base bucket.
	SharePage Rule
	// ShareReadSecret is SHARE_LINK_SECRET, which signs ShareReadHeader.
	// Empty sends every signed-out read to the anonymous bucket.
	ShareReadSecret []byte
	// Clock is nil for real time; tests set one so waits take no time.
	Clock Clock
	// Voice applies to chat voice input, a few recordings a minute from a
	// person talking; it leaves the chat allowance to the turns they send.
	Voice Rule
}

// DefaultConfig is tuned for a single-seat free tier: generous enough that
// normal interactive use never notices, tight enough that a script cannot loop
// the chat endpoint. Pro tiers are not separated yet; when they are, the
// per-tier rules belong here rather than at the call sites.
func DefaultConfig() Config {
	return Config{
		Anonymous:     Rule{Limit: 60, Window: time.Minute},
		Authenticated: Rule{Limit: 300, Window: time.Minute},
		AI:            Rule{Limit: 200, Window: time.Hour, Burst: 15},
		AIBurst:       Rule{Limit: 15, Window: time.Minute, Burst: 15},
		Editor:        Rule{Limit: 120, Window: time.Minute, Burst: 30},
		Upload:        Rule{Limit: 120, Window: time.Hour, Burst: 20},
		Incident:      Rule{Limit: 60, Window: time.Hour, Burst: 20},
		// Epo 2026-10-11: 60 captures an hour per user.
		Thumbnail:     Rule{Limit: 60, Window: time.Hour},
		Integration:   Rule{Limit: 30, Window: time.Minute},
		StripeSession: Rule{Limit: 10, Window: time.Hour},
		// Per visitor and shared page (Epo 2026-10-24, Q244): a cold page
		// with a few hundred images.
		SharePage: Rule{Limit: 300, Window: time.Minute},
		Voice:     Rule{Limit: 60, Window: time.Hour, Burst: 6},
	}
}

// ErrDisabled is returned by Limiter constructors when there is no Redis to
// count in. Callers treat it as "run without limits" rather than as fatal.
var ErrDisabled = errors.New("ratelimit: disabled")

// Limiter counts against Redis so limits hold across gateway replicas. The
// in-process counters this replaces only ever worked with a single replica.
type Limiter struct {
	rdb *redis.Client
	cfg Config
}

func New(rdb *redis.Client, cfg Config) *Limiter {
	if rdb == nil || cfg.Disabled {
		return nil
	}
	return &Limiter{rdb: rdb, cfg: cfg}
}

func (l *Limiter) Config() Config {
	if l == nil {
		return Config{Disabled: true}
	}
	return l.cfg
}

// gcra is the generic cell rate algorithm: a leaky bucket expressed as a single
// "theoretical arrival time" value, which makes the whole decision one atomic
// Redis round trip with no per-request bookkeeping to clean up.
//
// KEYS[1] bucket   ARGV[1] now_ms   ARGV[2] emission_interval_ms   ARGV[3] tolerance_ms
// Returns {allowed, retry_after_ms}.
var gcra = redis.NewScript(`
local key = KEYS[1]
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local tolerance = tonumber(ARGV[3])

local tat = tonumber(redis.call('GET', key))
if not tat or tat < now then
  tat = now
end

local new_tat = tat + interval
local allow_at = new_tat - tolerance

if now < allow_at then
  return {0, math.ceil(allow_at - now)}
end

redis.call('SET', key, new_tat, 'PX', math.ceil(new_tat - now) + interval)
return {1, 0}
`)

// Allow reports whether one request against key is permitted. err is non-nil
// when Redis could not decide; the caller chooses whether that allows the
// request (Middleware fails closed only for the AI and upload classes).
func (l *Limiter) Allow(ctx context.Context, key string, rule Rule) (bool, time.Duration, error) {
	if l == nil || !rule.enabled() {
		return true, 0, nil
	}
	interval := rule.Window.Milliseconds() / int64(rule.Limit)
	if interval <= 0 {
		interval = 1
	}
	tolerance := interval * int64(rule.burst())

	res, err := gcra.Run(ctx, l.rdb,
		[]string{"capy:rl:" + key},
		l.clock().Now().UnixMilli(), interval, tolerance,
	).Int64Slice()
	if err == nil && len(res) != 2 {
		err = errors.New("ratelimit: unexpected script reply")
	}
	if err != nil {
		return true, 0, err
	}
	if res[0] == 1 {
		return true, 0, nil
	}
	return false, time.Duration(res[1]) * time.Millisecond, nil
}
