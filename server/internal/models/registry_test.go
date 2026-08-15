package models

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func openRegistry(t *testing.T) (*pgxpool.Pool, *Registry) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	reg, err := New(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	return pool, reg
}

func TestGetLoadsPinnedVersionOnMissAndNeverFallsBack(t *testing.T) {
	pool, reg := openRegistry(t)
	ctx := context.Background()
	key := fmt.Sprintf("miss-%d", time.Now().UnixNano())
	_, err := pool.Exec(ctx, `
		INSERT INTO model_configs (
			model_key, version, display_name, provider_slug, base_url, provider_model_id,
			params, surfaces, micros_per_input_token, micros_per_output_token,
			usd_micros_per_input_token, usd_micros_per_output_token, enabled, is_default_for
		) VALUES ($1, 7, 'Miss Test', 'deepseek', 'https://example.test', 'miss-model',
			'{}'::jsonb, ARRAY['chat'], 250, 1000, 0, 0, true, ARRAY[]::text[])`, key)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM model_configs WHERE model_key=$1`, key)
	})

	got, err := reg.Get(ctx, key, 7)
	if err != nil {
		t.Fatalf("load-on-miss: %v", err)
	}
	if got.ProviderModelID != "miss-model" || got.Version != 7 {
		t.Fatalf("loaded %#v", got)
	}

	_, err = reg.Get(ctx, "deepseek-flash", 9999)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing pin must be an error, not a default, got %v", err)
	}
	def, err := reg.Default(ctx, SurfaceChat)
	if err != nil {
		t.Fatal(err)
	}
	if def.Version == 9999 || def.Key != "deepseek-flash" {
		t.Fatalf("default mutated by a miss: %#v", def)
	}
}

func TestOldVersionStaysResolvableAfterNewerDefault(t *testing.T) {
	pool, reg := openRegistry(t)
	ctx := context.Background()
	flash, err := reg.Get(ctx, "deepseek-flash", 1)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO model_configs (
			model_key, version, display_name, provider_slug, base_url, provider_model_id,
			params, surfaces, micros_per_input_token, micros_per_output_token,
			usd_micros_per_input_token, usd_micros_per_output_token, enabled, is_default_for
		) VALUES ('deepseek-flash', 2, 'Flash v2', 'deepseek', 'https://example.test', 'flash-v2',
			'{}'::jsonb, ARRAY['chat','generate','editor','ingest'], 250, 1000, 0, 0, true, ARRAY['chat'])`)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM model_configs WHERE model_key='deepseek-flash' AND version=2`)
	})
	old, err := reg.Get(ctx, "deepseek-flash", 1)
	if err != nil {
		t.Fatal(err)
	}
	if old.ProviderModelID != flash.ProviderModelID {
		t.Fatalf("v1 changed after v2 landed: %q vs %q", old.ProviderModelID, flash.ProviderModelID)
	}
}

func TestResolveUserRequiresAnEnabledPreference(t *testing.T) {
	_, reg := openRegistry(t)
	ctx := context.Background()
	_, err := reg.ResolveUser(ctx, "", SurfaceChat)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty pref: %v", err)
	}
	_, err = reg.ResolveUser(ctx, "not-a-model", SurfaceChat)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown pref: %v", err)
	}
	got, err := reg.ResolveUser(ctx, "deepseek-flash", SurfaceChat)
	if err != nil {
		t.Fatal(err)
	}
	if got.Key != "deepseek-flash" {
		t.Fatalf("got %#v", got)
	}
}
