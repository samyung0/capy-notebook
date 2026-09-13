package store

import (
	"context"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/testdb"
	"github.com/samyung0/capy-notebook/server/migrations"
)

func TestMigrationFilesAreNumbered(t *testing.T) {
	names, err := listMigrationFiles()
	if err != nil {
		t.Fatal(err)
	}
	if len(names) == 0 {
		t.Fatal("no numbered migration files embedded")
	}
	for _, name := range names {
		if !migrationFileName.MatchString(name) {
			t.Fatalf("embedded migration %q is not numbered", name)
		}
		if name == "dev_seed.sql" {
			t.Fatal("dev_seed.sql must not be a numbered migration")
		}
	}
}

func TestShouldApplyDevSeed(t *testing.T) {
	if !ShouldApplyDevSeed("development") || !ShouldApplyDevSeed("") {
		t.Fatal("local/dev must seed")
	}
	if ShouldApplyDevSeed("production") || ShouldApplyDevSeed("e2e") {
		t.Fatal("prod and e2e must not seed")
	}
}

func openMigrateTestStore(t *testing.T) *Store {
	t.Helper()
	dsn := testdb.URL(t)
	ctx := context.Background()
	s, err := Open(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

func TestMigrateIsApplyOnce(t *testing.T) {
	s := openMigrateTestStore(t)
	ctx := context.Background()
	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("first migrate: %v", err)
	}
	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	status, err := s.MigrationStatus(ctx)
	if err != nil {
		t.Fatal(err)
	}
	applied := 0
	for _, row := range status {
		if row.Applied {
			applied++
		}
	}
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != applied {
		t.Fatalf("schema_migrations rows = %d, want %d", n, applied)
	}
}

func TestApplyDevSeedMatchesSchemaInvariants(t *testing.T) {
	s := openMigrateTestStore(t)
	ctx := context.Background()
	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := s.ApplyDevSeed(ctx); err != nil {
		t.Fatalf("first seed: %v", err)
	}
	if err := s.ApplyDevSeed(ctx); err != nil {
		t.Fatalf("second seed: %v", err)
	}
	var privacy Privacy
	if err := s.pool.QueryRow(ctx, `SELECT privacy FROM materials WHERE id='qz_3'`).Scan(&privacy); err != nil {
		t.Fatal(err)
	}
	if privacy != PrivacyPrivate {
		t.Fatalf("workspace seed material privacy=%q, want private", privacy)
	}
}

func TestMigrateRejectsEditedChecksum(t *testing.T) {
	s := openMigrateTestStore(t)
	ctx := context.Background()
	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	files, err := listMigrationFiles()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, name := range files {
			body, readErr := migrations.FS.ReadFile(name)
			if readErr != nil {
				t.Errorf("restore read %s: %v", name, readErr)
				continue
			}
			if _, err := s.pool.Exec(ctx,
				`UPDATE schema_migrations SET checksum=$2 WHERE filename=$1`,
				name, checksumSQL(body),
			); err != nil {
				t.Errorf("restore %s: %v", name, err)
			}
		}
	})
	if _, err := s.pool.Exec(ctx, `UPDATE schema_migrations SET checksum='deadbeef'`); err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(ctx); err == nil {
		t.Fatal("expected checksum mismatch")
	}
}

// The page-rate and default-pin files are the two forward migrations that
// write seed state; re-applying their bodies must leave the database as it is.
func TestForwardSeedMigrationsAreRerunnable(t *testing.T) {
	s := openMigrateTestStore(t)
	ctx := context.Background()
	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	for _, name := range []string{"0008_parse_page_rates.sql", "0009_default_chat_model.sql"} {
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, string(body)); err != nil {
			t.Fatalf("re-apply %s: %v", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	for _, key := range []string{"digital_parse_page", "ocr_parse_page"} {
		var version int
		var micros int64
		err := s.pool.QueryRow(ctx,
			`SELECT version, credit_micros_per_unit FROM resource_credit_rates WHERE resource_key=$1 AND active`, key,
		).Scan(&version, &micros)
		if err != nil {
			t.Fatalf("%s: exactly one active row expected: %v", key, err)
		}
		if version != 2 || micros != 1_000_000 {
			t.Fatalf("%s active row = v%d %d micros, want v2 1000000", key, version, micros)
		}
	}
	var captionActive int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM resource_credit_rates WHERE resource_key='figure_caption_call' AND active`,
	).Scan(&captionActive); err != nil {
		t.Fatal(err)
	}
	if captionActive != 0 {
		t.Fatalf("figure_caption_call still active")
	}
	var provider, model string
	if err := s.pool.QueryRow(ctx,
		`SELECT provider_slug, model_slug FROM model_configs WHERE 'chat' = ANY(is_default_for)`,
	).Scan(&provider, &model); err != nil {
		t.Fatalf("exactly one chat slot default expected: %v", err)
	}
	if provider != "zai" || model != "glm-5.3-flash" {
		t.Fatalf("chat slot default = %s/%s, want zai/glm-5.3-flash", provider, model)
	}
}

// 0009 must never clear the chat slot default without assigning the new one:
// with the GLM row disabled the file fails as a whole and Flash keeps the slot.
func TestDefaultChatModelMigrationRefusesWithoutAnEnabledGLMRow(t *testing.T) {
	s := openMigrateTestStore(t)
	ctx := context.Background()
	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	body, err := migrations.FS.ReadFile("0009_default_chat_model.sql")
	if err != nil {
		t.Fatal(err)
	}
	outer, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = outer.Rollback(ctx) }() // leaves the shared database untouched
	for _, stmt := range []string{
		`UPDATE model_configs SET is_default_for = array_remove(is_default_for, 'chat')
		   WHERE provider_slug='zai' AND model_slug='glm-5.3-flash'`,
		`UPDATE model_configs SET is_default_for = array_append(is_default_for, 'chat')
		   WHERE provider_slug='deepseek' AND model_slug='deepseek-flash' AND version=1`,
		`UPDATE model_configs SET enabled=false WHERE provider_slug='zai' AND model_slug='glm-5.3-flash'`,
	} {
		if _, err := outer.Exec(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	inner, err := outer.Begin(ctx) // savepoint: the failed file rolls back alone
	if err != nil {
		t.Fatal(err)
	}
	_, err = inner.Exec(ctx, string(body))
	_ = inner.Rollback(ctx)
	if err == nil || !strings.Contains(err.Error(), "no enabled catalog row") {
		t.Fatalf("0009 on a disabled GLM row: err = %v, want the enabled-row refusal", err)
	}
	var provider, model string
	if err := outer.QueryRow(ctx,
		`SELECT provider_slug, model_slug FROM model_configs WHERE 'chat' = ANY(is_default_for)`,
	).Scan(&provider, &model); err != nil {
		t.Fatalf("exactly one chat slot default expected after the refusal: %v", err)
	}
	if provider != "deepseek" || model != "deepseek-flash" {
		t.Fatalf("chat slot default = %s/%s, want it untouched on Flash", provider, model)
	}
}
