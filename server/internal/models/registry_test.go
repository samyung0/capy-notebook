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
			enabled, is_default_for
		) VALUES ($1, 7, 'Miss Test', 'deepseek', 'https://example.test', 'miss-model',
			'{}'::jsonb, ARRAY['chat'], 250, 1000, true, ARRAY[]::text[])`, key)
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
		UPDATE model_configs
		   SET is_default_for = array_remove(is_default_for, 'chat')
		 WHERE model_key='deepseek-flash' AND version=1`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO model_configs (
			model_key, version, display_name, provider_slug, base_url, provider_model_id,
			params, surfaces, micros_per_input_token, micros_per_output_token,
			enabled, is_default_for
		) VALUES ('deepseek-flash', 2, 'Flash v2', 'deepseek', 'https://example.test', 'flash-v2',
			'{}'::jsonb, ARRAY['chat','generate','editor','ingest'], 250, 1000, true, ARRAY['chat'])`)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM model_configs WHERE model_key='deepseek-flash' AND version=2`)
		_, _ = pool.Exec(context.Background(), `
			UPDATE model_configs
			   SET is_default_for = ARRAY['chat','generate','editor','quiz','ingest']
			 WHERE model_key='deepseek-flash' AND version=1`)
	})
	old, err := reg.Get(ctx, "deepseek-flash", 1)
	if err != nil {
		t.Fatal(err)
	}
	if old.ProviderModelID != flash.ProviderModelID {
		t.Fatalf("v1 changed after v2 landed: %q vs %q", old.ProviderModelID, flash.ProviderModelID)
	}
}

// EmbeddingDim is the halfvec width a config emits. Guessing a width would
// write the wrong size into a table, or give a new workspace a pin it can
// never search with.
func TestEmbeddingDimRequiresADeclaredWidth(t *testing.T) {
	_, reg := openRegistry(t)
	ctx := context.Background()
	embed, err := reg.Default(ctx, SurfaceEmbedding)
	if err != nil {
		t.Fatal(err)
	}
	dim, err := embed.EmbeddingDim()
	if err != nil {
		t.Fatalf("seeded embedding default declares no dimensions: %v", err)
	}
	if dim != 2560 {
		t.Fatalf("dim %d has no vector table", dim)
	}

	chat, err := reg.Default(ctx, SurfaceChat)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := chat.EmbeddingDim(); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a non-embedding config must not report a width, got %v", err)
	}
}

func TestEmbeddingRowsAreFrozen(t *testing.T) {
	pool, _ := openRegistry(t)
	ctx := context.Background()

	_, err := pool.Exec(ctx, `
		UPDATE model_configs SET enabled=false
		 WHERE model_key='qwen-embed' AND version=1`)
	if err == nil {
		t.Fatal("disabled the seeded embedding row")
	}

	_, err = pool.Exec(ctx, `
		UPDATE model_configs SET surfaces=ARRAY['chat']
		 WHERE model_key='qwen-embed' AND version=1`)
	if err == nil {
		t.Fatal("stripped embedding from the seeded row")
	}

	_, err = pool.Exec(ctx, `
		UPDATE model_configs SET provider_model_id='other-embed'
		 WHERE model_key='qwen-embed' AND version=1`)
	if err == nil {
		t.Fatal("rewrote provider_model_id on the seeded embedding row")
	}

	_, err = pool.Exec(ctx, `
		UPDATE model_configs SET params='{"dimensions": 2560, "x": 1}'::jsonb
		 WHERE model_key='qwen-embed' AND version=1`)
	if err == nil {
		t.Fatal("rewrote params on the seeded embedding row")
	}

	_, err = pool.Exec(ctx, `
		DELETE FROM model_configs WHERE model_key='qwen-embed' AND version=1`)
	if err == nil {
		t.Fatal("deleted the seeded embedding row")
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO model_configs (
			model_key, version, display_name, provider_slug, base_url, provider_model_id,
			params, surfaces, micros_per_input_token, micros_per_output_token,
			enabled, is_default_for
		) VALUES (
			'ghost-embed', 1, 'Ghost', 'openrouter', 'https://example.test', 'ghost',
			'{"dimensions": 2560, "vector_table": "rag_chunk_vectors_2560"}'::jsonb,
			ARRAY['embedding'], 50, 50, false,
			ARRAY[]::text[])`)
	if err == nil {
		t.Fatal("inserted a disabled embedding row")
	}

	key := fmt.Sprintf("chat-disable-%d", time.Now().UnixNano())
	_, err = pool.Exec(ctx, `
		INSERT INTO model_configs (
			model_key, version, display_name, provider_slug, base_url, provider_model_id,
			params, surfaces, micros_per_input_token, micros_per_output_token,
			enabled, is_default_for
		) VALUES ($1, 1, 'Chat Disable', 'deepseek', 'https://example.test', 'chat-disable',
			'{}'::jsonb, ARRAY['chat'], 250, 1000, true, ARRAY[]::text[])`, key)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM model_configs WHERE model_key=$1`, key)
	})
	_, err = pool.Exec(ctx, `
		UPDATE model_configs
		   SET surfaces=ARRAY['chat','embedding'],
		       params='{"dimensions": 2560}'::jsonb
		 WHERE model_key=$1`, key)
	if err == nil {
		t.Fatal("added embedding to an existing chat row")
	}
	_, err = pool.Exec(ctx, `
		UPDATE model_configs SET provider_model_id='chat-disable-2' WHERE model_key=$1`, key)
	if err != nil {
		t.Fatalf("chat rows must still retarget: %v", err)
	}
	_, err = pool.Exec(ctx, `UPDATE model_configs SET enabled=false WHERE model_key=$1`, key)
	if err != nil {
		t.Fatalf("chat rows must still disable: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	embedKey := fmt.Sprintf("lock-embed-%d", time.Now().UnixNano())
	_, err = tx.Exec(ctx, `
		INSERT INTO model_configs (
			model_key, version, display_name, provider_slug, base_url, provider_model_id,
			params, surfaces, micros_per_input_token, micros_per_output_token,
			enabled, is_default_for
		) VALUES ($1, 1, 'Lock Embed', 'openrouter', 'https://example.test', 'other-2560',
			'{"dimensions": 2560, "vector_table": "rag_chunk_vectors_other_1"}'::jsonb,
			ARRAY['embedding'], 50, 50, true,
			ARRAY[]::text[])`, embedKey)
	if err != nil {
		t.Fatalf("a new same-width embedding row must insert: %v", err)
	}
	if _, err = tx.Exec(ctx, `SAVEPOINT after_insert`); err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `
		UPDATE model_configs SET provider_model_id='nope' WHERE model_key=$1`, embedKey)
	if err == nil {
		t.Fatal("rewrote provider_model_id on a new embedding row")
	}
	if _, err = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT after_insert`); err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `
		UPDATE model_configs SET base_url='https://moved.example/v1' WHERE model_key=$1`, embedKey)
	if err != nil {
		t.Fatalf("base_url must stay writable on embedding rows: %v", err)
	}
	_, err = tx.Exec(ctx, `
		UPDATE model_configs SET is_default_for=ARRAY['embedding'] WHERE model_key=$1`, embedKey)
	if err == nil {
		t.Fatal("two embedding defaults")
	}
}

func TestOneDefaultPerSurface(t *testing.T) {
	pool, _ := openRegistry(t)
	ctx := context.Background()
	key := fmt.Sprintf("dup-default-%d", time.Now().UnixNano())
	_, err := pool.Exec(ctx, `
		INSERT INTO model_configs (
			model_key, version, display_name, provider_slug, base_url, provider_model_id,
			params, surfaces, micros_per_input_token, micros_per_output_token,
			enabled, is_default_for
		) VALUES ($1, 1, 'Dup', 'deepseek', 'https://example.test', 'dup',
			'{}'::jsonb, ARRAY['chat'], 250, 1000, true, ARRAY['chat'])`, key)
	if err == nil {
		t.Fatal("two chat defaults")
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

func TestAuthRouting(t *testing.T) {
	flash := Config{AuthMode: AuthPlatformOrUser, ProviderSlug: "deepseek"}
	if !flash.Available(false) || flash.UsesUserKey(false) {
		t.Fatal("deepseek without a key stays platform")
	}
	if !flash.UsesUserKey(true) {
		t.Fatal("deepseek with a key uses the key")
	}
	gpt := Config{AuthMode: AuthUserKey, ProviderSlug: "openai"}
	if gpt.Available(false) || gpt.UsesUserKey(false) {
		t.Fatal("openai without a key is locked")
	}
	if !gpt.Available(true) || !gpt.UsesUserKey(true) {
		t.Fatal("openai with a key is selectable and billed to the user")
	}
	embed := Config{AuthMode: AuthPlatform, ProviderSlug: "openrouter"}
	if embed.UsesUserKey(true) {
		t.Fatal("platform rows never use a user key")
	}
}

func TestResolveReasoning(t *testing.T) {
	cfg := Config{Params: map[string]any{
		"reasoning": map[string]any{
			"canDisable":    true,
			"efforts":       []any{"low", "high", "max"},
			"defaultMode":   "off",
			"defaultEffort": "high",
		},
	}}
	mode, effort := cfg.ResolveReasoning("", "")
	if mode != "off" || effort != "" {
		t.Fatalf("catalog default: %s %s", mode, effort)
	}
	mode, effort = cfg.ResolveReasoning("on", "max")
	if mode != "on" || effort != "max" {
		t.Fatalf("user override: %s %s", mode, effort)
	}
	mode, effort = cfg.ResolveReasoning("on", "medium")
	if mode != "on" || effort != "high" {
		t.Fatalf("invalid effort clamps: %s %s", mode, effort)
	}
	locked := Config{Params: map[string]any{
		"reasoning": map[string]any{
			"canDisable":    false,
			"efforts":       []any{"high"},
			"defaultMode":   "on",
			"defaultEffort": "high",
		},
	}}
	mode, _ = locked.ResolveReasoning("off", "high")
	if mode != "on" {
		t.Fatalf("cannot disable: %s", mode)
	}
}
