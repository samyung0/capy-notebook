// Package models is the hot-reloadable model registry.
//
// Rows in model_configs are immutable and versioned. The cache therefore never
// evicts a (provider_slug, model_slug, version) pin it has loaded. Polling model_registry_state
// only teaches a replica the *current defaults*; a pinned pair this process has
// never seen is a point read of the table, cached forever afterwards.
//
// A cache miss is never allowed to fall back to the current default: that would
// quietly reprice an in-flight pin. A miss the database also cannot satisfy is
// an error. Rows are disabled rather than deleted for that reason.
//
// Nothing here is frozen at process start. Retrieval and captioning defaults
// used to be, so that a 30s poll could not mix vector spaces within one corpus,
// but that made the model a query was embedded with depend on when the
// container last booted and left two replicas legitimately disagreeing. The
// guarantee now comes from pins instead: the embedding model belongs to the
// workspace for its lifetime, and the captioning model is snapshotted onto each
// ingest job at enqueue.
package models

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/evonotes/server/internal/obs"
)

const PollInterval = 10 * time.Minute

const (
	AuthPlatform       = "platform"
	AuthUserKey        = "user_key"
	AuthPlatformOrUser = "platform_or_user"
	PaidByPlatform     = "platform"
	PaidByUser         = "user"
)

const modelConfigSelect = `
		SELECT version, provider_name, model_name, provider_slug, model_slug,
		       platform_enabled, byok_enabled, context_window_tokens,
		       thinking_levels, default_thinking, params, slots, capabilities,
		       micros_per_input_token, micros_per_output_token, enabled, is_default_for,
		       micros_per_cached_input_token
		  FROM model_configs`

var ErrNotFound = errors.New("model config not found")

// Ref is the natural identity of one provider model. Keep it structured rather
// than joining the slugs into an ambiguous string.
type Ref struct {
	ProviderSlug string `json:"providerSlug"`
	ModelSlug    string `json:"modelSlug"`
}

func (r Ref) Zero() bool { return r.ProviderSlug == "" || r.ModelSlug == "" }

func (r Ref) String() string { return r.ProviderSlug + "/" + r.ModelSlug }

// Pin is the provider/model/version tuple written onto a conversation or job. It is
// the only identifier a later request is allowed to resolve.
type Pin struct {
	Ref
	Version int `json:"modelVersion"`
}

func (p Pin) Zero() bool { return p.Ref.Zero() || p.Version <= 0 }

// Config is one immutable model_configs row.
type Config struct {
	Version                   int
	ProviderName              string
	ModelName                 string
	ProviderSlug              string
	ModelSlug                 string
	PlatformEnabled           bool
	ByokEnabled               bool
	ContextWindowTokens       int
	ThinkingLevels            []string
	DefaultThinking           string
	Params                    map[string]any
	Slots                     []string
	Capabilities              []string
	MicrosPerInputToken       int64
	MicrosPerOutputToken      int64
	Enabled                   bool
	IsDefaultFor              []string
	MicrosPerCachedInputToken int64
}

func (c Config) Ref() Ref { return Ref{ProviderSlug: c.ProviderSlug, ModelSlug: c.ModelSlug} }

func (c Config) Pin() Pin { return Pin{Ref: c.Ref(), Version: c.Version} }

func (c Config) DisplayName() string {
	return JoinModelLabel(c.ProviderName, c.ModelName)
}

func (c Config) Allows(slot string) bool {
	for _, s := range c.Slots {
		if s == slot {
			return true
		}
	}
	return false
}

func (c Config) DefaultFor(slot string) bool {
	for _, s := range c.IsDefaultFor {
		if s == slot {
			return true
		}
	}
	return false
}

func (c Config) Auth() string {
	switch {
	case c.PlatformEnabled && c.ByokEnabled:
		return AuthPlatformOrUser
	case c.ByokEnabled:
		return AuthUserKey
	default:
		return AuthPlatform
	}
}

// Available is whether this user may select the row. Platform rows are
// always selectable. BYOK-only rows need a credential.
func (c Config) Available(hasCred bool) bool {
	if c.PlatformEnabled {
		return true
	}
	return c.ByokEnabled && hasCred
}

// UsesUserKey is whether a request from this user should call the provider
// with their credential.
func (c Config) UsesUserKey(hasCred bool) bool {
	return c.ByokEnabled && hasCred
}

const (
	ThinkingInstant = "instant"
	ThinkingLow     = "low"
	ThinkingMid     = "mid"
	ThinkingHigh    = "high"
	ThinkingMax     = "max"
)

var knownThinkingLevels = map[string]struct{}{
	ThinkingInstant: {},
	ThinkingLow:     {},
	ThinkingMid:     {},
	ThinkingHigh:    {},
	ThinkingMax:     {},
}

func IsKnownThinking(level string) bool {
	_, ok := knownThinkingLevels[level]
	return ok
}

func (c Config) ResolveThinking(stored string) (string, error) {
	if stored == "" {
		if containsString(c.ThinkingLevels, c.DefaultThinking) {
			return c.DefaultThinking, nil
		}
		return "", fmt.Errorf("model %s has no valid default thinking", c.Ref())
	}
	if containsString(c.ThinkingLevels, stored) {
		return stored, nil
	}
	return "", fmt.Errorf("model %s does not support thinking %q", c.Ref(), stored)
}

func ValidateThinking(slots, levels []string, defaultThinking string) error {
	hasLLM := false
	hasEditor := false
	for _, slot := range slots {
		if IsLLMSlot(slot) {
			hasLLM = true
		}
		if slot == SlotEditor {
			hasEditor = true
		}
	}
	if !hasLLM {
		if len(levels) > 0 || defaultThinking != "" {
			return fmt.Errorf("retrieval/captioning rows must omit thinking")
		}
		return nil
	}
	if len(levels) == 0 {
		return fmt.Errorf("llm rows require thinking levels")
	}
	for _, item := range levels {
		if !IsKnownThinking(item) {
			return fmt.Errorf("unknown thinking level %q", item)
		}
	}
	if defaultThinking == "" || !containsString(levels, defaultThinking) {
		return fmt.Errorf("default thinking must be one of this row's levels")
	}
	if hasEditor && !containsString(levels, ThinkingInstant) {
		return fmt.Errorf("editor rows must support instant thinking")
	}
	return nil
}

func UsesResponses(providerSlug, thinking string, tools bool) bool {
	return providerSlug == "openai" && tools && thinking != "" && thinking != ThinkingInstant
}

func (c Config) UsesResponses(thinking string, tools bool) bool {
	return UsesResponses(c.ProviderSlug, thinking, tools)
}

func containsString(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

func (c Config) ParamFloat(key string, fallback float64) float64 {
	if c.Params == nil {
		return fallback
	}
	switch v := c.Params[key].(type) {
	case float64:
		return v
	case json.Number:
		f, err := v.Float64()
		if err == nil {
			return f
		}
	case int:
		return float64(v)
	case int64:
		return float64(v)
	}
	return fallback
}

type cacheKey struct {
	providerSlug string
	modelSlug    string
	version      int
}

func cacheKeyFor(ref Ref, version int) cacheKey {
	return cacheKey{providerSlug: ref.ProviderSlug, modelSlug: ref.ModelSlug, version: version}
}

// Registry caches immutable configs and the current defaults.
type Registry struct {
	pool *pgxpool.Pool

	mu      sync.RWMutex
	byPin   map[cacheKey]Config
	current map[string]Pin // slot -> default pin
	rev     int64
}

func New(ctx context.Context, pool *pgxpool.Pool) (*Registry, error) {
	r := &Registry{
		pool:    pool,
		byPin:   map[cacheKey]Config{},
		current: map[string]Pin{},
	}
	if err := r.refresh(ctx); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *Registry) Pool() *pgxpool.Pool { return r.pool }

// Poll watches model_registry_state.version and reloads defaults when it
// changes. Retargeting a default only affects work that has not been pinned
// yet: an in-flight job, an existing conversation and an existing workspace all
// keep resolving the pair they were given.
func (r *Registry) Poll(ctx context.Context) {
	ticker := time.NewTicker(PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.refresh(obs.Background(ctx, "model_registry")); err != nil {
				obs.CaptureErr(ctx, err, map[string]string{"stage": "model_registry_poll"})
			}
		}
	}
}

func (r *Registry) refresh(ctx context.Context) error {
	var rev int64
	if err := r.pool.QueryRow(ctx,
		`SELECT version FROM model_registry_state WHERE id = true`,
	).Scan(&rev); err != nil {
		return err
	}
	r.mu.RLock()
	same := r.rev == rev && rev != 0 && len(r.current) > 0
	r.mu.RUnlock()
	if same {
		return nil
	}

	rows, err := r.pool.Query(ctx, modelConfigSelect)
	if err != nil {
		return err
	}
	defer rows.Close()

	byPin := map[cacheKey]Config{}
	current := map[string]Pin{}
	for rows.Next() {
		cfg, err := scanConfig(rows)
		if err != nil {
			return err
		}
		byPin[cacheKeyFor(cfg.Ref(), cfg.Version)] = cfg
		if !cfg.Enabled {
			continue
		}
		for _, slot := range cfg.IsDefaultFor {
			prev, ok := current[slot]
			if !ok || cfg.Version >= prev.Version {
				current[slot] = cfg.Pin()
			}
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	for k, cfg := range byPin {
		r.byPin[k] = cfg
	}
	for slot, pin := range current {
		r.current[slot] = pin
	}
	r.rev = rev
	return nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanConfig(row rowScanner) (Config, error) {
	var (
		c            Config
		params       []byte
		slots        []string
		capabilities []string
		defaultFor   []string
		thinking     []string
	)
	err := row.Scan(
		&c.Version, &c.ProviderName, &c.ModelName, &c.ProviderSlug, &c.ModelSlug,
		&c.PlatformEnabled, &c.ByokEnabled, &c.ContextWindowTokens,
		&thinking, &c.DefaultThinking,
		&params, &slots, &capabilities, &c.MicrosPerInputToken, &c.MicrosPerOutputToken,
		&c.Enabled, &defaultFor, &c.MicrosPerCachedInputToken,
	)
	if err != nil {
		return Config{}, err
	}
	c.ThinkingLevels = thinking
	c.Slots = slots
	c.Capabilities = capabilities
	c.IsDefaultFor = defaultFor
	if len(params) > 0 {
		_ = json.Unmarshal(params, &c.Params)
	}
	if c.Params == nil {
		c.Params = map[string]any{}
	}
	return c, nil
}

// Get returns the exact provider/model/version pin. Load-on-miss from the table; never
// falls back to the current default. Disabled chat/generate rows still
// resolve so a pinned conversation keeps working. Retrieval rows cannot be
// disabled or rewritten onto a different model: Postgres rejects the write.
func (r *Registry) Get(ctx context.Context, ref Ref, version int) (Config, error) {
	if ref.Zero() || version <= 0 {
		return Config{}, ErrNotFound
	}
	ck := cacheKeyFor(ref, version)
	r.mu.RLock()
	if cfg, ok := r.byPin[ck]; ok {
		r.mu.RUnlock()
		return cfg, nil
	}
	r.mu.RUnlock()

	cfg, err := r.load(ctx, ref, version)
	if err != nil {
		return Config{}, err
	}
	r.mu.Lock()
	r.byPin[ck] = cfg
	r.mu.Unlock()
	return cfg, nil
}

func (r *Registry) load(ctx context.Context, ref Ref, version int) (Config, error) {
	row := r.pool.QueryRow(ctx, modelConfigSelect+`
		 WHERE provider_slug=$1 AND model_slug=$2 AND version=$3`, ref.ProviderSlug, ref.ModelSlug, version)
	cfg, err := scanConfig(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Config{}, fmt.Errorf("%w: %s v%d", ErrNotFound, ref, version)
	}
	return cfg, err
}

// DefaultPin is the current default for a slot. Callers that are choosing on
// somebody's behalf (enqueue, account creation, workspace creation) resolve it
// once and store the result; nothing downstream is allowed to call this again.
func (r *Registry) DefaultPin(slot string) (Pin, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	pin, ok := r.current[slot]
	if !ok || pin.Zero() {
		return Pin{}, fmt.Errorf("%w: no default for %s", ErrNotFound, slot)
	}
	return pin, nil
}

func (r *Registry) Default(ctx context.Context, slot string) (Config, error) {
	pin, err := r.DefaultPin(slot)
	if err != nil {
		return Config{}, err
	}
	return r.Get(ctx, pin.Ref, pin.Version)
}

// ResolveUser returns the latest enabled config for the user's preferred model
// on this slot. The preference must be a non-empty ref that still resolves;
// there is no fallback to the slot default. Account creation snapshots the
// default onto the user row so a live request always has a concrete model ref.
func (r *Registry) ResolveUser(ctx context.Context, pref Ref, slot string) (Config, error) {
	if pref.Zero() {
		return Config{}, fmt.Errorf("%w: empty preference for %s", ErrNotFound, slot)
	}
	return r.latestEnabled(ctx, pref, slot)
}

func (r *Registry) latestEnabled(ctx context.Context, ref Ref, slot string) (Config, error) {
	r.mu.RLock()
	var best Config
	found := false
	for _, cfg := range r.byPin {
		if cfg.Ref() == ref && cfg.Enabled && cfg.Allows(slot) {
			if !found || cfg.Version > best.Version {
				best = cfg
				found = true
			}
		}
	}
	r.mu.RUnlock()
	if found {
		return best, nil
	}
	row := r.pool.QueryRow(ctx, modelConfigSelect+`
		 WHERE provider_slug=$1 AND model_slug=$2 AND enabled AND $3 = ANY(slots)
		 ORDER BY version DESC LIMIT 1`, ref.ProviderSlug, ref.ModelSlug, slot)
	cfg, err := scanConfig(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Config{}, fmt.Errorf("%w: %s", ErrNotFound, ref)
	}
	if err != nil {
		return Config{}, err
	}
	r.mu.Lock()
	r.byPin[cacheKeyFor(cfg.Ref(), cfg.Version)] = cfg
	r.mu.Unlock()
	return cfg, nil
}

// SnapshotIngest returns the pins written onto an ingest job at enqueue: the
// two slots whose defaults are hot-reloadable and whose job may still be
// queued when one moves.
//
// Retrieval is deliberately absent. It comes from the workspace row instead,
// because a workspace's vector space outlives any single job and must not be
// re-decided per upload.
func (r *Registry) SnapshotIngest(ctx context.Context) (ingest, captioning Config, err error) {
	ingest, err = r.Default(ctx, SlotIngest)
	if err != nil {
		return
	}
	captioning, err = r.Default(ctx, SlotCaptioning)
	return
}

// EmbeddingDim is the vector width a config emits. The vector table is chosen
// by pin, not by width; this value sizes the halfvec write. A check constraint
// in the migration requires it on every retrieval row, so a zero here means
// the row was written around the schema.
func (c Config) EmbeddingDim() (int, error) {
	dim := int(c.ParamFloat("dimensions", 0))
	if dim <= 0 {
		return 0, fmt.Errorf("%w: %s v%d declares no dimensions", ErrNotFound, c.Ref(), c.Version)
	}
	return dim, nil
}

// ListEnabled returns enabled configs that advertise slot, newest version
// per provider/model identity, for the model picker.
func (r *Registry) ListEnabled(slot string) []Config {
	r.mu.RLock()
	defer r.mu.RUnlock()
	best := map[Ref]Config{}
	for _, cfg := range r.byPin {
		if !cfg.Enabled || !cfg.Allows(slot) {
			continue
		}
		ref := cfg.Ref()
		prev, ok := best[ref]
		if !ok || cfg.Version > prev.Version {
			best[ref] = cfg
		}
	}
	out := make([]Config, 0, len(best))
	for _, cfg := range best {
		out = append(out, cfg)
	}
	return out
}

func (r *Registry) Rev() int64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.rev
}
