// Package models is the hot-reloadable model registry.
//
// Rows in model_configs are immutable and versioned. The cache therefore never
// evicts a (model_key, version) pair it has loaded. Polling model_registry_state
// only teaches a replica the *current defaults*; a pinned pair this process has
// never seen is a point read of the table, cached forever afterwards.
//
// A cache miss is never allowed to fall back to the current default: that would
// quietly reprice an in-flight pin. A miss the database also cannot satisfy is
// an error. Rows are disabled rather than deleted for that reason.
//
// Nothing here is frozen at process start. Embedding and vision defaults used
// to be, so that a 30s poll could not mix vector spaces within one corpus, but
// that made the model a query was embedded with depend on when the container
// last booted and left two replicas legitimately disagreeing. The guarantee now
// comes from pins instead: embedding belongs to the workspace for its lifetime
// (workspaces.embedding_model_key), and vision is snapshotted onto each ingest
// job at enqueue.
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

const PollInterval = 30 * time.Second

const (
	SurfaceChat      = "chat"
	SurfaceGenerate  = "generate"
	SurfaceEditor    = "editor"
	SurfaceQuiz      = "quiz"
	SurfaceIngest    = "ingest"
	SurfaceEmbedding = "embedding"
	SurfaceVision    = "vision"
)

const (
	AuthPlatform       = "platform"
	AuthUserKey        = "user_key"
	AuthPlatformOrUser = "platform_or_user"
	PaidByPlatform     = "platform"
	PaidByUser         = "user"
)

const modelConfigSelect = `
		SELECT model_key, version, display_name, provider_slug, base_url, provider_model_id,
		       auth_mode, context_window_tokens, params, surfaces,
		       micros_per_input_token, micros_per_output_token, enabled, is_default_for
		  FROM model_configs`

var ErrNotFound = errors.New("model config not found")

// Pin is the (key, version) pair written onto a conversation or job. It is
// the only identifier a later request is allowed to resolve.
type Pin struct {
	Key     string `json:"modelKey"`
	Version int    `json:"modelVersion"`
}

func (p Pin) Zero() bool { return p.Key == "" || p.Version <= 0 }

// Config is one immutable model_configs row.
type Config struct {
	Key                  string
	Version              int
	DisplayName          string
	ProviderSlug         string
	BaseURL              string
	ProviderModelID      string
	AuthMode             string
	ContextWindowTokens  int
	Params               map[string]any
	Surfaces             []string
	MicrosPerInputToken  int64
	MicrosPerOutputToken int64
	Enabled              bool
	IsDefaultFor         []string
}

func (c Config) Pin() Pin { return Pin{Key: c.Key, Version: c.Version} }

func (c Config) Allows(surface string) bool {
	for _, s := range c.Surfaces {
		if s == surface {
			return true
		}
	}
	return false
}

func (c Config) DefaultFor(surface string) bool {
	for _, s := range c.IsDefaultFor {
		if s == surface {
			return true
		}
	}
	return false
}

func (c Config) Auth() string {
	if c.AuthMode == "" {
		return AuthPlatform
	}
	return c.AuthMode
}

// Available is whether this user may select the row. Platform and
// platform_or_user rows are always selectable. user_key rows need a credential.
func (c Config) Available(hasCred bool) bool {
	if c.Auth() == AuthUserKey {
		return hasCred
	}
	return true
}

// UsesUserKey is whether a request from this user should call the provider
// with their credential.
func (c Config) UsesUserKey(hasCred bool) bool {
	switch c.Auth() {
	case AuthUserKey, AuthPlatformOrUser:
		return hasCred
	default:
		return false
	}
}

var knownReasoningEfforts = map[string]struct{}{
	"low": {}, "medium": {}, "high": {}, "xhigh": {}, "max": {},
}

func IsKnownReasoningEffort(effort string) bool {
	_, ok := knownReasoningEfforts[effort]
	return ok
}

type ReasoningSpec struct {
	CanDisable    bool
	Efforts       []string
	DefaultMode   string
	DefaultEffort string
	Style         string
}

func (c Config) Reasoning() ReasoningSpec {
	spec := ReasoningSpec{CanDisable: true}
	raw, ok := c.Params["reasoning"]
	if !ok {
		spec.DefaultMode = "off"
		return spec
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		spec.DefaultMode = "off"
		return spec
	}
	if v, ok := obj["canDisable"].(bool); ok {
		spec.CanDisable = v
	}
	if v, ok := obj["defaultMode"].(string); ok && v != "" {
		spec.DefaultMode = v
	}
	if v, ok := obj["defaultEffort"].(string); ok && v != "" {
		spec.DefaultEffort = v
	}
	if v, ok := obj["style"].(string); ok {
		spec.Style = v
	}
	switch list := obj["efforts"].(type) {
	case []any:
		for _, item := range list {
			if s, ok := item.(string); ok && s != "" {
				spec.Efforts = append(spec.Efforts, s)
			}
		}
	case []string:
		spec.Efforts = append(spec.Efforts, list...)
	}
	return spec
}

// ResolveReasoning applies a user override, then the catalog default.
// An effort that this row does not list falls back to defaultEffort when
// that value is listed. Mode on with no usable effort returns empty
// effort rather than inventing medium or the first listed value.
func (c Config) ResolveReasoning(mode, effort string) (string, string) {
	spec := c.Reasoning()
	if mode == "" {
		mode = spec.DefaultMode
	}
	if mode != "on" && mode != "off" {
		mode = spec.DefaultMode
	}
	if !spec.CanDisable {
		mode = "on"
	}
	if mode == "off" {
		return "off", ""
	}
	if effort == "" {
		effort = spec.DefaultEffort
	}
	if containsString(spec.Efforts, effort) {
		return mode, effort
	}
	if spec.DefaultEffort != "" && containsString(spec.Efforts, spec.DefaultEffort) {
		return mode, spec.DefaultEffort
	}
	return mode, ""
}

// ValidateCatalogReasoning is the Go form of model_configs_reasoning_check.
// Ops should call this in the drawer; Postgres still refuses a bad insert.
func ValidateCatalogReasoning(surfaces []string, params map[string]any) error {
	hasLLM := false
	for _, surface := range surfaces {
		switch surface {
		case SurfaceChat, SurfaceGenerate, SurfaceEditor, SurfaceQuiz, SurfaceIngest:
			hasLLM = true
		}
	}
	raw, hasReasoning := params["reasoning"]
	if !hasLLM {
		if hasReasoning {
			return fmt.Errorf("embedding/vision rows must omit reasoning")
		}
		return nil
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("llm rows require params.reasoning")
	}
	mode, _ := obj["defaultMode"].(string)
	if mode != "on" && mode != "off" {
		return fmt.Errorf("reasoning.defaultMode must be on or off")
	}
	if _, ok := obj["canDisable"].(bool); !ok {
		return fmt.Errorf("reasoning.canDisable must be a boolean")
	}
	efforts := reasoningEfforts(obj["efforts"])
	if len(efforts) == 0 {
		return fmt.Errorf("reasoning.efforts must be a non-empty list")
	}
	for _, item := range efforts {
		if !IsKnownReasoningEffort(item) {
			return fmt.Errorf("unknown reasoning effort %q", item)
		}
	}
	defaultEffort, _ := obj["defaultEffort"].(string)
	if defaultEffort == "" || !containsString(efforts, defaultEffort) {
		return fmt.Errorf("reasoning.defaultEffort must be one of this row's efforts")
	}
	if style, _ := obj["style"].(string); style != "" && style != "adaptive" && style != "budget" {
		return fmt.Errorf("reasoning.style must be adaptive or budget")
	}
	return nil
}

func reasoningEfforts(raw any) []string {
	switch list := raw.(type) {
	case []any:
		out := make([]string, 0, len(list))
		for _, item := range list {
			if s, ok := item.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	case []string:
		out := make([]string, 0, len(list))
		for _, item := range list {
			if item != "" {
				out = append(out, item)
			}
		}
		return out
	default:
		return nil
	}
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
	key     string
	version int
}

// Registry caches immutable configs and the current defaults.
type Registry struct {
	pool *pgxpool.Pool

	mu      sync.RWMutex
	byPin   map[cacheKey]Config
	current map[string]Pin // surface -> default pin
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
		byPin[cacheKey{cfg.Key, cfg.Version}] = cfg
		if !cfg.Enabled {
			continue
		}
		for _, surface := range cfg.IsDefaultFor {
			prev, ok := current[surface]
			if !ok || cfg.Version >= prev.Version {
				current[surface] = cfg.Pin()
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
	for surface, pin := range current {
		r.current[surface] = pin
	}
	r.rev = rev
	return nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanConfig(row rowScanner) (Config, error) {
	var (
		c          Config
		params     []byte
		surfaces   []string
		defaultFor []string
	)
	err := row.Scan(
		&c.Key, &c.Version, &c.DisplayName, &c.ProviderSlug, &c.BaseURL, &c.ProviderModelID,
		&c.AuthMode, &c.ContextWindowTokens,
		&params, &surfaces, &c.MicrosPerInputToken, &c.MicrosPerOutputToken,
		&c.Enabled, &defaultFor,
	)
	if err != nil {
		return Config{}, err
	}
	c.Surfaces = surfaces
	c.IsDefaultFor = defaultFor
	if len(params) > 0 {
		_ = json.Unmarshal(params, &c.Params)
	}
	if c.Params == nil {
		c.Params = map[string]any{}
	}
	return c, nil
}

// Get returns the exact (key, version). Load-on-miss from the table; never
// falls back to the current default. Disabled chat/generate rows still
// resolve so a pinned conversation keeps working. Embedding rows cannot be
// disabled or rewritten onto a different model: Postgres rejects the write.
func (r *Registry) Get(ctx context.Context, key string, version int) (Config, error) {
	if key == "" || version <= 0 {
		return Config{}, ErrNotFound
	}
	ck := cacheKey{key, version}
	r.mu.RLock()
	if cfg, ok := r.byPin[ck]; ok {
		r.mu.RUnlock()
		return cfg, nil
	}
	r.mu.RUnlock()

	cfg, err := r.load(ctx, key, version)
	if err != nil {
		return Config{}, err
	}
	r.mu.Lock()
	r.byPin[ck] = cfg
	r.mu.Unlock()
	return cfg, nil
}

func (r *Registry) load(ctx context.Context, key string, version int) (Config, error) {
	row := r.pool.QueryRow(ctx, modelConfigSelect+`
		 WHERE model_key=$1 AND version=$2`, key, version)
	cfg, err := scanConfig(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Config{}, fmt.Errorf("%w: %s v%d", ErrNotFound, key, version)
	}
	return cfg, err
}

// DefaultPin is the current default for a surface. Callers that are choosing on
// somebody's behalf (enqueue, account creation, workspace creation) resolve it
// once and store the result; nothing downstream is allowed to call this again.
func (r *Registry) DefaultPin(surface string) (Pin, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	pin, ok := r.current[surface]
	if !ok || pin.Zero() {
		return Pin{}, fmt.Errorf("%w: no default for %s", ErrNotFound, surface)
	}
	return pin, nil
}

func (r *Registry) Default(ctx context.Context, surface string) (Config, error) {
	pin, err := r.DefaultPin(surface)
	if err != nil {
		return Config{}, err
	}
	return r.Get(ctx, pin.Key, pin.Version)
}

// ResolveUser returns the latest enabled config for the user's preferred key
// on this surface. The preference must be a non-empty key that still resolves;
// there is no fallback to the surface default. Account creation snapshots the
// default onto the user row so a live request always has a concrete key.
func (r *Registry) ResolveUser(ctx context.Context, prefKey, surface string) (Config, error) {
	if prefKey == "" {
		return Config{}, fmt.Errorf("%w: empty preference for %s", ErrNotFound, surface)
	}
	return r.latestEnabled(ctx, prefKey, surface)
}

func (r *Registry) latestEnabled(ctx context.Context, key, surface string) (Config, error) {
	r.mu.RLock()
	var best Config
	found := false
	for _, cfg := range r.byPin {
		if cfg.Key == key && cfg.Enabled && cfg.Allows(surface) {
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
		 WHERE model_key=$1 AND enabled AND $2 = ANY(surfaces)
		 ORDER BY version DESC LIMIT 1`, key, surface)
	cfg, err := scanConfig(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Config{}, fmt.Errorf("%w: %s", ErrNotFound, key)
	}
	if err != nil {
		return Config{}, err
	}
	r.mu.Lock()
	r.byPin[cacheKey{cfg.Key, cfg.Version}] = cfg
	r.mu.Unlock()
	return cfg, nil
}

// SnapshotIngest returns the pins written onto an ingest job at enqueue: the
// two surfaces whose defaults are hot-reloadable and whose job may still be
// queued when one moves.
//
// Embedding is deliberately absent. It comes from the workspace row instead,
// because a workspace's vector space outlives any single job and must not be
// re-decided per upload.
func (r *Registry) SnapshotIngest(ctx context.Context) (ingest, vision Config, err error) {
	ingest, err = r.Default(ctx, SurfaceIngest)
	if err != nil {
		return
	}
	vision, err = r.Default(ctx, SurfaceVision)
	return
}

// EmbeddingDim is the vector width a config emits. The vector table is chosen
// by pin, not by width; this value sizes the halfvec write. A check constraint
// in the migration requires it on every embedding row, so a zero here means
// the row was written around the schema.
func (c Config) EmbeddingDim() (int, error) {
	dim := int(c.ParamFloat("dimensions", 0))
	if dim <= 0 {
		return 0, fmt.Errorf("%w: %s v%d declares no dimensions", ErrNotFound, c.Key, c.Version)
	}
	return dim, nil
}

// ListEnabled returns enabled configs that advertise surface, newest version
// per key, for the model picker.
func (r *Registry) ListEnabled(surface string) []Config {
	r.mu.RLock()
	defer r.mu.RUnlock()
	best := map[string]Config{}
	for _, cfg := range r.byPin {
		if !cfg.Enabled || !cfg.Allows(surface) {
			continue
		}
		prev, ok := best[cfg.Key]
		if !ok || cfg.Version > prev.Version {
			best[cfg.Key] = cfg
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
