// Package ratelimit implements the semantic half of the rate limiting story.
//
// The edge (Cloudflare) handles volumetric floods: it counts by IP over a ten
// second window and knows nothing about who is calling. That is deliberately
// not enough here, because the limits that matter are per user, per plan, and
// per route class — "twenty chat streams an hour for a free account, three at
// once" cannot be expressed at the edge, which never sees the Clerk identity.
//
// Spend is limited elsewhere. The credits ledger in internal/store gates model
// usage by cost; this package only bounds request volume and concurrency.
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
	// Upload applies to upload reservation and import routes, which are cheap
	// to call but expensive downstream once ingest picks them up.
	Upload Rule
	// ConcurrentStreams caps simultaneous SSE/streaming responses per user.
	// Zero disables the cap.
	ConcurrentStreams int
	// StreamLease is how long a concurrency slot survives without release,
	// bounding the damage from a crashed gateway replica.
	StreamLease time.Duration
}

// DefaultConfig is tuned for a single-seat free tier: generous enough that
// normal interactive use never notices, tight enough that a script cannot loop
// the chat endpoint. Pro tiers are not separated yet; when they are, the
// per-tier rules belong here rather than at the call sites.
func DefaultConfig() Config {
	return Config{
		Anonymous:         Rule{Limit: 60, Window: time.Minute},
		Authenticated:     Rule{Limit: 300, Window: time.Minute},
		AI:                Rule{Limit: 200, Window: time.Hour, Burst: 15},
		AIBurst:           Rule{Limit: 15, Window: time.Minute, Burst: 15},
		Editor:            Rule{Limit: 120, Window: time.Minute, Burst: 30},
		Upload:            Rule{Limit: 120, Window: time.Hour, Burst: 20},
		ConcurrentStreams: 3,
		StreamLease:       15 * time.Minute,
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
	if cfg.StreamLease <= 0 {
		cfg.StreamLease = 15 * time.Minute
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

// Allow reports whether one request against key is permitted. Redis failures
// allow the request: a limiter outage must not become an API outage, and the
// edge still bounds the blast radius.
func (l *Limiter) Allow(ctx context.Context, key string, rule Rule) (bool, time.Duration) {
	if l == nil || !rule.enabled() {
		return true, 0
	}
	interval := rule.Window.Milliseconds() / int64(rule.Limit)
	if interval <= 0 {
		interval = 1
	}
	tolerance := interval * int64(rule.burst())

	res, err := gcra.Run(ctx, l.rdb,
		[]string{"evo:rl:" + key},
		time.Now().UnixMilli(), interval, tolerance,
	).Int64Slice()
	if err != nil || len(res) != 2 {
		return true, 0
	}
	if res[0] == 1 {
		return true, 0
	}
	return false, time.Duration(res[1]) * time.Millisecond
}

// acquireStream adds a lease to the caller's active-stream set after purging
// expired ones. Expiry is what makes this self-healing: a replica that dies
// mid-stream leaves entries that age out on their own, where a plain counter
// would leak a slot forever.
//
// KEYS[1] set   ARGV[1] now_ms   ARGV[2] token   ARGV[3] limit   ARGV[4] lease_ms
// Returns 1 when the slot was taken.
var acquireStream = redis.NewScript(`
local key = KEYS[1]
local now = tonumber(ARGV[1])
local token = ARGV[2]
local limit = tonumber(ARGV[3])
local lease = tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) >= limit then
  return 0
end
redis.call('ZADD', key, now + lease, token)
redis.call('PEXPIRE', key, lease * 2)
return 1
`)

// AcquireStream reserves one concurrent-stream slot. The returned release func
// is always safe to call, including when the slot was not granted.
func (l *Limiter) AcquireStream(ctx context.Context, userID string) (bool, func()) {
	noop := func() {}
	if l == nil || l.cfg.ConcurrentStreams <= 0 || userID == "" {
		return true, noop
	}
	key := "evo:rl:streams:" + userID
	token := userID + ":" + time.Now().Format(time.RFC3339Nano)

	ok, err := acquireStream.Run(ctx, l.rdb,
		[]string{key},
		time.Now().UnixMilli(), token, l.cfg.ConcurrentStreams,
		l.cfg.StreamLease.Milliseconds(),
	).Int()
	if err != nil {
		return true, noop
	}
	if ok != 1 {
		return false, noop
	}
	return true, func() {
		// Detached: the request context is already cancelled when a client
		// disconnects, which is exactly when releasing matters most.
		rctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = l.rdb.ZRem(rctx, key, token).Err()
	}
}
