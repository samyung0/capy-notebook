package models

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/evonotes/server/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

const testLLMParams = `{"temperature":0.3}`

var (
	flashRef = Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-flash-vision-exp"}
	embedRef = Ref{ProviderSlug: "deepinfra", ModelSlug: "Qwen/Qwen3-Embedding-4B"}
)

func openRegistry(t *testing.T) (*pgxpool.Pool, *Registry) {
	t.Helper()
	dsn := testdb.URL(t)
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

func insertLLM(t *testing.T, pool *pgxpool.Pool, version int, slug string, surfaces, defaults string) Ref {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params, surfaces,
			micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
			enabled, is_default_for
		) VALUES (
			$1, 'Test', 'Model', 'deepseek', $2,
			true, false, 100000,
			ARRAY['instant','low','mid','high','max']::text[], 'instant',
			$3::jsonb, $4::text[], 250, 1000, 250, true, $5::text[]
		)`, version, slug, testLLMParams, surfaces, defaults)
	if err != nil {
		t.Fatal(err)
	}
	return Ref{ProviderSlug: "deepseek", ModelSlug: slug}
}

func TestGetLoadsPinnedVersionOnMissAndNeverFallsBack(t *testing.T) {
	pool, reg := openRegistry(t)
	ctx := context.Background()
	slug := fmt.Sprintf("miss-%d", time.Now().UnixNano())
	ref := insertLLM(t, pool, 7, slug, "{chat}", "{}")
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM model_configs WHERE provider_slug=$1 AND model_slug=$2`, ref.ProviderSlug, ref.ModelSlug)
	})

	got, err := reg.Get(ctx, ref, 7)
	if err != nil {
		t.Fatalf("load-on-miss: %v", err)
	}
	if got.ModelSlug != slug || got.Version != 7 {
		t.Fatalf("loaded %#v", got)
	}

	_, err = reg.Get(ctx, flashRef, 9999)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing pin must be an error, not a default, got %v", err)
	}
	def, err := reg.Default(ctx, SurfaceChat)
	if err != nil {
		t.Fatal(err)
	}
	if def.Version == 9999 || def.Ref() != flashRef {
		t.Fatalf("default mutated by a miss: %#v", def)
	}
}

func TestOldVersionStaysResolvableAfterNewerDefault(t *testing.T) {
	pool, reg := openRegistry(t)
	ctx := context.Background()
	flash, err := reg.Get(ctx, flashRef, 1)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		UPDATE model_configs
		   SET is_default_for = array_remove(is_default_for, 'chat')
		 WHERE provider_slug=$1 AND model_slug=$2 AND version=1`, flashRef.ProviderSlug, flashRef.ModelSlug)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params, surfaces,
			micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
			enabled, is_default_for
		) VALUES (2, 'DeepSeek', 'Flash v2', 'deepseek', 'deepseek-v4-flash-vision-exp',
			true, true, 1000000,
			ARRAY['instant','low','mid','high','max']::text[], 'instant',
			$1::jsonb, ARRAY['chat','generate','editor','ingest'], 250, 1000, 250, true, ARRAY['chat'])`, testLLMParams)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM model_configs WHERE provider_slug=$1 AND model_slug=$2 AND version=2`, flashRef.ProviderSlug, flashRef.ModelSlug)
		_, _ = pool.Exec(context.Background(), `
			UPDATE model_configs
			   SET is_default_for = ARRAY['chat','generate','editor','quiz','ingest']
			 WHERE provider_slug=$1 AND model_slug=$2 AND version=1`, flashRef.ProviderSlug, flashRef.ModelSlug)
	})
	old, err := reg.Get(ctx, flashRef, 1)
	if err != nil {
		t.Fatal(err)
	}
	if old.ModelSlug != flash.ModelSlug {
		t.Fatalf("v1 changed after v2 landed: %q vs %q", old.ModelSlug, flash.ModelSlug)
	}
}

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
		 WHERE provider_slug=$1 AND model_slug=$2 AND version=1`, embedRef.ProviderSlug, embedRef.ModelSlug)
	if err == nil {
		t.Fatal("disabled the seeded embedding row")
	}

	_, err = pool.Exec(ctx, `
		UPDATE model_configs SET surfaces=ARRAY['chat']
		 WHERE provider_slug=$1 AND model_slug=$2 AND version=1`, embedRef.ProviderSlug, embedRef.ModelSlug)
	if err == nil {
		t.Fatal("stripped embedding from the seeded row")
	}

	_, err = pool.Exec(ctx, `
		UPDATE model_configs SET model_slug='other-embed'
		 WHERE provider_slug=$1 AND model_slug=$2 AND version=1`, embedRef.ProviderSlug, embedRef.ModelSlug)
	if err == nil {
		t.Fatal("rewrote model_slug on the seeded embedding row")
	}

	_, err = pool.Exec(ctx, `
		UPDATE model_configs SET params='{"dimensions": 2560, "x": 1}'::jsonb
		 WHERE provider_slug=$1 AND model_slug=$2 AND version=1`, embedRef.ProviderSlug, embedRef.ModelSlug)
	if err == nil {
		t.Fatal("rewrote params on the seeded embedding row")
	}

	_, err = pool.Exec(ctx, `
		DELETE FROM model_configs WHERE provider_slug=$1 AND model_slug=$2 AND version=1`, embedRef.ProviderSlug, embedRef.ModelSlug)
	if err == nil {
		t.Fatal("deleted the seeded embedding row")
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params, surfaces,
			micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
			enabled, is_default_for
		) VALUES (
			1, 'Ghost', 'Ghost', 'embedtest', 'ghost',
			true, false, 0, ARRAY[]::text[], '',
			'{"dimensions": 2560, "vector_table": "rag_chunk_vectors_2560"}'::jsonb,
			ARRAY['embedding'], 50, 50, 0, false,
			ARRAY[]::text[])`)
	if err == nil {
		t.Fatal("inserted a disabled embedding row")
	}

	slug := fmt.Sprintf("chat-disable-%d", time.Now().UnixNano())
	ref := insertLLM(t, pool, 1, slug, "{chat}", "{}")
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM model_configs WHERE provider_slug=$1 AND model_slug=$2`, ref.ProviderSlug, ref.ModelSlug)
	})
	_, err = pool.Exec(ctx, `
		UPDATE model_configs
		   SET surfaces=ARRAY['chat','embedding'],
		       params='{"dimensions": 2560}'::jsonb
		 WHERE provider_slug=$1 AND model_slug=$2`, ref.ProviderSlug, ref.ModelSlug)
	if err == nil {
		t.Fatal("added embedding to an existing chat row")
	}
	_, err = pool.Exec(ctx, `
		UPDATE model_configs SET model_slug='chat-disable-2'
		 WHERE provider_slug=$1 AND model_slug=$2`, ref.ProviderSlug, ref.ModelSlug)
	if err == nil {
		t.Fatal("changed the natural identity of a chat row")
	}
	_, err = pool.Exec(ctx, `UPDATE model_configs SET enabled=false WHERE provider_slug=$1 AND model_slug=$2`, ref.ProviderSlug, ref.ModelSlug)
	if err != nil {
		t.Fatalf("chat rows must still disable: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	embedSlug := fmt.Sprintf("lock-embed-%d", time.Now().UnixNano())
	_, err = tx.Exec(ctx, `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params, surfaces,
			micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
			enabled, is_default_for
		) VALUES (1, 'Lock', 'Embed', 'embedtest', $1,
			true, false, 0, ARRAY[]::text[], '',
			'{"dimensions": 2560, "vector_table": "rag_chunk_vectors_other_1"}'::jsonb,
			ARRAY['embedding'], 50, 50, 0, true,
			ARRAY[]::text[])`, embedSlug)
	if err != nil {
		t.Fatalf("a new same-width embedding row must insert: %v", err)
	}
	if _, err = tx.Exec(ctx, `SAVEPOINT after_insert`); err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `
		UPDATE model_configs SET model_slug='nope' WHERE provider_slug='embedtest' AND model_slug=$1`, embedSlug)
	if err == nil {
		t.Fatal("rewrote model_slug on a new embedding row")
	}
	if _, err = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT after_insert`); err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `
		UPDATE model_configs SET model_name='Lock Embed Moved' WHERE provider_slug='embedtest' AND model_slug=$1`, embedSlug)
	if err != nil {
		t.Fatalf("model_name must stay writable on embedding rows: %v", err)
	}
	_, err = tx.Exec(ctx, `
		UPDATE model_configs SET is_default_for=ARRAY['embedding'] WHERE provider_slug='embedtest' AND model_slug=$1`, embedSlug)
	if err == nil {
		t.Fatal("two embedding defaults")
	}
}

func TestOneDefaultPerSurface(t *testing.T) {
	pool, _ := openRegistry(t)
	slug := fmt.Sprintf("dup-default-%d", time.Now().UnixNano())
	_, err := pool.Exec(context.Background(), `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params, surfaces,
			micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
			enabled, is_default_for
		) VALUES (1, 'Dup', 'Dup', 'deepseek', $1,
			true, false, 100000,
			ARRAY['instant']::text[], 'instant',
			$2::jsonb, ARRAY['chat'], 250, 1000, 250, true, ARRAY['chat'])`, slug, testLLMParams)
	if err == nil {
		t.Fatal("two chat defaults")
	}
}

func TestResolveUserRequiresAnEnabledPreference(t *testing.T) {
	_, reg := openRegistry(t)
	ctx := context.Background()
	_, err := reg.ResolveUser(ctx, Ref{}, SurfaceChat)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty pref: %v", err)
	}
	_, err = reg.ResolveUser(ctx, Ref{ProviderSlug: "deepseek", ModelSlug: "not-a-model"}, SurfaceChat)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown pref: %v", err)
	}
	got, err := reg.ResolveUser(ctx, flashRef, SurfaceChat)
	if err != nil {
		t.Fatal(err)
	}
	if got.Ref() != flashRef {
		t.Fatalf("got %#v", got)
	}
}

func TestAuthRouting(t *testing.T) {
	flash := Config{PlatformEnabled: true, ByokEnabled: true, ProviderSlug: "deepseek"}
	if !flash.Available(false) || flash.UsesUserKey(false) {
		t.Fatal("deepseek without a key stays platform")
	}
	if !flash.UsesUserKey(true) {
		t.Fatal("deepseek with a key uses the key")
	}
	gpt := Config{PlatformEnabled: false, ByokEnabled: true, ProviderSlug: "openai"}
	if gpt.Available(false) || gpt.UsesUserKey(false) {
		t.Fatal("openai without a key is locked")
	}
	if !gpt.Available(true) || !gpt.UsesUserKey(true) {
		t.Fatal("openai with a key is selectable and billed to the user")
	}
	embed := Config{PlatformEnabled: true, ByokEnabled: false, ProviderSlug: "deepinfra"}
	if embed.UsesUserKey(true) {
		t.Fatal("platform rows never use a user key")
	}
}

func TestResolveThinking(t *testing.T) {
	cfg := Config{ThinkingLevels: []string{"instant", "low", "high", "max"}, DefaultThinking: "instant"}
	if got, err := cfg.ResolveThinking(""); err != nil || got != ThinkingInstant {
		t.Fatalf("empty stored: %s", got)
	}
	if got, err := cfg.ResolveThinking("high"); err != nil || got != ThinkingHigh {
		t.Fatalf("user override: %s", got)
	}
	if got, err := cfg.ResolveThinking("medium"); err == nil || got != "" {
		t.Fatalf("invalid thinking accepted: %q, %v", got, err)
	}
	locked := Config{ThinkingLevels: []string{"low", "high"}, DefaultThinking: "high"}
	if got, err := locked.ResolveThinking(ThinkingInstant); err == nil || got != "" {
		t.Fatalf("unsupported instant accepted: %q, %v", got, err)
	}
	empty := Config{}
	if got, err := empty.ResolveThinking(""); err == nil || got != "" {
		t.Fatalf("invalid catalog default accepted: %q, %v", got, err)
	}
}

func TestValidateThinking(t *testing.T) {
	if err := ValidateThinking([]string{SurfaceChat}, []string{"instant", "high"}, "instant"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateThinking([]string{SurfaceEmbedding}, nil, ""); err != nil {
		t.Fatal(err)
	}
	if err := ValidateThinking([]string{SurfaceChat}, nil, ""); err == nil {
		t.Fatal("llm row without thinking")
	}
	if err := ValidateThinking([]string{SurfaceChat}, []string{"instant", "high"}, "mid"); err == nil {
		t.Fatal("default not in levels")
	}
	if err := ValidateThinking([]string{SurfaceVision}, []string{"instant"}, "instant"); err == nil {
		t.Fatal("vision row with thinking")
	}
	if err := ValidateThinking([]string{SurfaceEditor}, []string{"low", "high"}, "high"); err == nil {
		t.Fatal("editor row without instant")
	}
}

func TestCatalogRefusesBrokenThinking(t *testing.T) {
	pool, _ := openRegistry(t)
	ctx := context.Background()
	slug := fmt.Sprintf("bad-think-%d", time.Now().UnixNano())
	_, err := pool.Exec(ctx, `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params, surfaces,
			micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
			enabled, is_default_for
		) VALUES (1, 'Bad', 'Bad', 'deepseek', $1,
			true, false, 100000, ARRAY[]::text[], '',
			'{}'::jsonb, ARRAY['chat'], 250, 1000, 250, true, ARRAY[]::text[])`, slug)
	if err == nil {
		t.Fatal("chat row without thinking")
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params, surfaces,
			micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
			enabled, is_default_for
		) VALUES (1, 'Bad', 'Default', 'deepseek', $1,
			true, false, 100000, ARRAY['instant','low']::text[], 'high',
			'{}'::jsonb, ARRAY['chat'], 250, 1000, 250, true, ARRAY[]::text[])`, slug+"-default")
	if err == nil {
		t.Fatal("default thinking not in levels")
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params, surfaces,
			micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
			enabled, is_default_for
		) VALUES (1, 'Bad', 'Editor', 'deepseek', $1,
			true, false, 100000, ARRAY['low','high']::text[], 'high',
			'{}'::jsonb, ARRAY['editor'], 250, 1000, 250, true, ARRAY[]::text[])`, slug+"-editor")
	if err == nil {
		t.Fatal("editor row without instant")
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled,
			thinking_levels, default_thinking, params, surfaces,
			micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
			enabled, is_default_for
		) VALUES (1, 'Bad', 'Window', 'deepseek', $1,
			true, false, ARRAY['instant']::text[], 'instant',
			'{}'::jsonb, ARRAY['chat'], 250, 1000, 250, true, ARRAY[]::text[])`, slug+"-window")
	if err == nil {
		t.Fatal("llm row without explicit context window")
	}
}

func TestSeedOmitsAnthropicModels(t *testing.T) {
	pool, _ := openRegistry(t)
	var count int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM model_configs WHERE provider_slug='anthropic'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("seeded anthropic models = %d, want none", count)
	}
}

func TestSeededGLMKeepsZAIIdentityAndMaxChatDefault(t *testing.T) {
	pool, _ := openRegistry(t)
	var (
		platformEnabled, byokEnabled bool
		contextWindow                int
		thinkingLevels, surfaces     []string
		defaultThinking              string
	)
	if err := pool.QueryRow(context.Background(), `
		SELECT platform_enabled, byok_enabled, context_window_tokens,
		       thinking_levels, default_thinking, surfaces
		  FROM model_configs
		 WHERE provider_slug='zai' AND model_slug='glm-5.3-flash' AND version=1`).Scan(
		&platformEnabled, &byokEnabled, &contextWindow,
		&thinkingLevels, &defaultThinking, &surfaces,
	); err != nil {
		t.Fatal(err)
	}
	if !platformEnabled || byokEnabled || contextWindow != 1048576 {
		t.Fatalf("routed GLM auth/window = %v/%v/%d", platformEnabled, byokEnabled, contextWindow)
	}
	if !slices.Equal(thinkingLevels, []string{"low", "high", "max"}) || defaultThinking != "max" {
		t.Fatalf("routed GLM thinking = %v default %q", thinkingLevels, defaultThinking)
	}
	if !slices.Equal(surfaces, []string{"chat", "vision"}) {
		t.Fatalf("routed GLM surfaces = %v", surfaces)
	}
}
