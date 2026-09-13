package store

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/migrations"
)

func TestDeepSeekFlashMigrationPreservesPinsRatesAndCapacity(t *testing.T) {
	s := openMigrateTestStore(t)
	ctx := context.Background()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `ALTER TABLE users
		ADD COLUMN quiz_model_provider_slug text NOT NULL DEFAULT 'deepseek',
		ADD COLUMN quiz_model_slug text NOT NULL DEFAULT 'deepseek-flash'`); err != nil {
		t.Fatal(err)
	}
	// Reconstruct an operator-edited pre-0010 catalog inside this transaction.
	_, err = tx.Exec(ctx, `
		INSERT INTO model_configs
		SELECT (jsonb_populate_record(NULL::model_configs, to_jsonb(c) ||
		  '{"model_slug":"deepseek-v4-flash-vision-exp","enabled":false,"is_default_for":[]}'::jsonb)).*
		FROM model_configs c WHERE provider_slug='deepseek' AND model_slug='deepseek-flash';
		DELETE FROM model_configs WHERE provider_slug='deepseek' AND model_slug='deepseek-flash';
		UPDATE model_configs SET enabled=true, is_default_for=ARRAY['generate','editor','quiz','ingest'],
		  micros_per_input_token=177, micros_per_output_token=888, micros_per_cached_input_token=17
		WHERE provider_slug='deepseek' AND model_slug='deepseek-v4-flash-vision-exp';
		DELETE FROM model_capacities WHERE provider='deepseek';
		INSERT INTO model_capacities VALUES ('deepseek', 'deepseek-v4-flash-vision-exp', 91, 13);
		INSERT INTO users (id, name, chat_model_provider_slug, chat_model_slug,
		  generate_model_slug, editor_model_slug, quiz_model_provider_slug, quiz_model_slug)
		VALUES ('migration-flash-user', 'Migration', 'deepseek', 'deepseek-v4-flash-vision-exp',
		  'deepseek-v4-flash-vision-exp', 'deepseek-v4-flash-vision-exp', 'openai', 'gpt-5.6-sol');`)
	if err != nil {
		t.Fatal(err)
	}
	body, err := migrations.FS.ReadFile("0010_deepseek_flash.sql")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := tx.Exec(ctx, string(body)); err != nil {
			t.Fatalf("migration application %d: %v", i+1, err)
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO users (id, name) VALUES ('migration-flash-new-user', 'New')`)
	if err != nil {
		t.Fatal(err)
	}
	for name, query := range map[string]string{
		"selective preference remap": `SELECT chat_model_slug='deepseek-flash'
		  AND generate_model_slug='deepseek-flash' AND editor_model_slug='deepseek-flash'
		  AND quiz_model_provider_slug='openai' AND quiz_model_slug='gpt-5.6-sol' FROM users WHERE id='migration-flash-user'`,
		"new account defaults": `SELECT chat_model_provider_slug='zai' AND chat_model_slug='glm-5.3-flash'
		  AND generate_model_slug='deepseek-flash' AND editor_model_slug='deepseek-flash'
		  AND quiz_model_slug='deepseek-flash' FROM users WHERE id='migration-flash-new-user'`,
		"catalog and credit rates": `SELECT count(*)=1 FROM model_configs
		  WHERE provider_slug='deepseek' AND model_slug='deepseek-flash' AND enabled
		  AND model_name='Flash 4.1' AND capabilities=ARRAY['vision'] AND context_window_tokens=1000000
		  AND micros_per_input_token=177 AND micros_per_output_token=888 AND micros_per_cached_input_token=17
		  AND is_default_for=ARRAY['generate','editor','quiz','ingest']`,
		"historical version retained": `SELECT count(*)=1 FROM model_configs
		  WHERE provider_slug='deepseek' AND model_slug='deepseek-v4-flash-vision-exp'
		  AND NOT enabled AND is_default_for='{}' AND micros_per_input_token=177`,
		"GLM chat default retained": `SELECT count(*)=1 FROM model_configs
		  WHERE provider_slug='zai' AND model_slug='glm-5.3-flash' AND 'chat'=ANY(is_default_for)`,
		"environment capacity copied": `SELECT count(*)=1 FROM model_capacities
		  WHERE provider='deepseek' AND model='deepseek-flash' AND concurrency_total=91 AND interactive_reserve=13`,
	} {
		var ok bool
		if err := tx.QueryRow(ctx, query).Scan(&ok); err != nil || !ok {
			t.Fatalf("%s: ok=%v err=%v", name, ok, err)
		}
	}
}

func TestDeepSeekFlashMigrationRefusesConflictingCatalog(t *testing.T) {
	s := openMigrateTestStore(t)
	ctx := context.Background()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `ALTER TABLE users
		ADD COLUMN quiz_model_provider_slug text NOT NULL DEFAULT 'deepseek',
		ADD COLUMN quiz_model_slug text NOT NULL DEFAULT 'deepseek-flash'`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO model_configs
		SELECT (jsonb_populate_record(NULL::model_configs, to_jsonb(c) ||
		  '{"model_slug":"deepseek-v4-flash-vision-exp","enabled":false,"is_default_for":[]}'::jsonb)).*
		FROM model_configs c WHERE provider_slug='deepseek' AND model_slug='deepseek-flash';
		UPDATE model_configs SET enabled=true
	  WHERE provider_slug='deepseek' AND model_slug='deepseek-v4-flash-vision-exp'`); err != nil {
		t.Fatal(err)
	}
	body, err := migrations.FS.ReadFile("0010_deepseek_flash.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, string(body)); err == nil || !strings.Contains(err.Error(), "reconcile the catalog") {
		t.Fatalf("expected an explicit conflict, got %v", err)
	}
}

func TestModelCapacityBootstrapUsesTransportAndPreservesOverrides(t *testing.T) {
	s := openMigrateTestStore(t)
	ctx := context.Background()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM model_capacities;
	  INSERT INTO model_capacities VALUES ('deepseek', 'deepseek-flash', 91, 13)`); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile("../../../deploy/model-capacities.sql")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := tx.Exec(ctx, string(body)); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM model_capacities`).Scan(&count); err != nil || count != 3 {
		t.Fatalf("bootstrap rows=%d err=%v", count, err)
	}
	for _, want := range []struct {
		provider, model string
		total, reserve  int
	}{
		{"deepseek", "deepseek-flash", 91, 13},
		{"tencent", "glm-5.3-flash", 30, 24},
		{"deepinfra", "Qwen/Qwen3-Embedding-4B", 200, 80},
	} {
		var total, reserve int
		err := tx.QueryRow(ctx, `SELECT concurrency_total, interactive_reserve
		  FROM model_capacities WHERE provider=$1 AND model=$2`, want.provider, want.model).Scan(&total, &reserve)
		if err != nil || total != want.total || reserve != want.reserve {
			t.Fatalf("%s/%s: %d/%d err=%v", want.provider, want.model, total, reserve, err)
		}
	}
}
