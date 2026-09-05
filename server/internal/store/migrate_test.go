package store

import (
	"context"
	"testing"

	"github.com/evonotes/server/internal/testdb"
	"github.com/evonotes/server/migrations"
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
	files, err := listMigrationFiles()
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != len(files) {
		t.Fatalf("schema_migrations rows = %d, want %d", n, len(files))
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
