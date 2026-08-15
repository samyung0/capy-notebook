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
// Embedding and vision defaults are frozen at process start. A 30s poll that
// swapped them would mix vector spaces (or caption caches) in one corpus.
// Ingest jobs pin the versions they were enqueued with.
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
	SurfaceIngest    = "ingest"
	SurfaceEmbedding = "embedding"
	SurfaceVision    = "vision"
	SurfaceSTT       = "stt"
)

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
	Key                     string
	Version                 int
	DisplayName             string
	ProviderSlug            string
	BaseURL                 string
	ProviderModelID         string
	Params                  map[string]any
	Surfaces                []string
	MicrosPerInputToken     int64
	MicrosPerOutputToken    int64
	USDMicrosPerInputToken  int64
	USDMicrosPerOutputToken int64
	Enabled                 bool
	IsDefaultFor            []string
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
	current map[string]Pin // surface -> default pin; embedding/vision frozen
	rev     int64
	frozen  map[string]Pin // embedding, vision — never updated by poll
}

func New(ctx context.Context, pool *pgxpool.Pool) (*Registry, error) {
	r := &Registry{
		pool:    pool,
		byPin:   map[cacheKey]Config{},
		current: map[string]Pin{},
		frozen:  map[string]Pin{},
	}
	if err := r.refresh(ctx); err != nil {
		return nil, err
	}
	r.mu.Lock()
	r.frozen[SurfaceEmbedding] = r.current[SurfaceEmbedding]
	r.frozen[SurfaceVision] = r.current[SurfaceVision]
	r.mu.Unlock()
	return r, nil
}

func (r *Registry) Pool() *pgxpool.Pool { return r.pool }

// Poll watches model_registry_state.version and reloads defaults when it
// changes. Embedding and vision pins stay at the process-start snapshot.
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

	rows, err := r.pool.Query(ctx, `
		SELECT model_key, version, display_name, provider_slug, base_url, provider_model_id,
		       params, surfaces, micros_per_input_token, micros_per_output_token,
		       usd_micros_per_input_token, usd_micros_per_output_token, enabled, is_default_for
		  FROM model_configs`)
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
		if surface == SurfaceEmbedding || surface == SurfaceVision {
			if _, frozen := r.frozen[surface]; frozen {
				continue
			}
		}
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
		&params, &surfaces, &c.MicrosPerInputToken, &c.MicrosPerOutputToken,
		&c.USDMicrosPerInputToken, &c.USDMicrosPerOutputToken, &c.Enabled, &defaultFor,
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
// falls back to the current default. Disabled rows still resolve: a pinned
// conversation must keep working after that version is disabled.
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
	row := r.pool.QueryRow(ctx, `
		SELECT model_key, version, display_name, provider_slug, base_url, provider_model_id,
		       params, surfaces, micros_per_input_token, micros_per_output_token,
		       usd_micros_per_input_token, usd_micros_per_output_token, enabled, is_default_for
		  FROM model_configs WHERE model_key=$1 AND version=$2`, key, version)
	cfg, err := scanConfig(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Config{}, fmt.Errorf("%w: %s v%d", ErrNotFound, key, version)
	}
	return cfg, err
}

// DefaultPin is the current default for a hot-reloadable surface, or the
// process-start snapshot for embedding/vision.
func (r *Registry) DefaultPin(surface string) (Pin, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if surface == SurfaceEmbedding || surface == SurfaceVision {
		if pin, ok := r.frozen[surface]; ok && !pin.Zero() {
			return pin, nil
		}
	}
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
	row := r.pool.QueryRow(ctx, `
		SELECT model_key, version, display_name, provider_slug, base_url, provider_model_id,
		       params, surfaces, micros_per_input_token, micros_per_output_token,
		       usd_micros_per_input_token, usd_micros_per_output_token, enabled, is_default_for
		  FROM model_configs
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

// SnapshotIngest returns the pins written onto an ingest job at enqueue.
// Embedding and vision come from the frozen snapshot; ingest LLM from the
// current (pollable) default.
func (r *Registry) SnapshotIngest(ctx context.Context) (ingest, embedding, vision Config, err error) {
	ingest, err = r.Default(ctx, SurfaceIngest)
	if err != nil {
		return
	}
	embedding, err = r.Default(ctx, SurfaceEmbedding)
	if err != nil {
		return
	}
	vision, err = r.Default(ctx, SurfaceVision)
	return
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
