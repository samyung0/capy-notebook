package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/samyung0/capy-notebook/server/internal/testdb"
	"github.com/samyung0/capy-notebook/server/migrations"
)

// Separate databases share the harness's single disposable Postgres container.
func migrationDatabase(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	ctx := context.Background()
	raw := testdb.URL(t)
	admin, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	name := "baseline_test_" + hex.EncodeToString(random[:])
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(context.Background(), "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)"); err != nil {
			t.Error(err)
		}
	})
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Path = "/" + name
	config, err := pgxpool.ParseConfig(parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, name
}

func migrationSQL(t *testing.T, pool *pgxpool.Pool, sql string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql); err != nil {
		t.Fatal(err)
	}
}

func migrationFixture() fstest.MapFS {
	return fstest.MapFS{
		"0001_initial.sql":   {Data: []byte(`CREATE TABLE catalog (id text PRIMARY KEY, price integer NOT NULL); INSERT INTO catalog VALUES ('free', 0); CREATE TABLE notes (id text PRIMARY KEY, content text NOT NULL);`)},
		"0002_kind.sql":      {Data: []byte(`ALTER TABLE notes ADD COLUMN kind text NOT NULL DEFAULT 'note'; CREATE INDEX notes_kind ON notes(kind); UPDATE catalog SET price=10 WHERE id='free';`)},
		"0003_archived.sql":  {Data: []byte(`ALTER TABLE notes ADD COLUMN archived boolean NOT NULL DEFAULT false;`)},
		"B0002_snapshot.sql": {Data: []byte(`CREATE TABLE catalog (id text PRIMARY KEY, price integer NOT NULL); INSERT INTO catalog VALUES ('free', 10); CREATE TABLE notes (id text PRIMARY KEY, content text NOT NULL, kind text NOT NULL DEFAULT 'note'); CREATE INDEX notes_kind ON notes(kind);`)},
	}
}

func TestBaselineFreshAndExistingUpgrade(t *testing.T) {
	ctx := context.Background()
	files := migrationFixture()
	fresh, _ := migrationDatabase(t)
	if err := migrateWithFS(ctx, fresh, files); err != nil {
		t.Fatal(err)
	}
	if err := migrateWithFS(ctx, fresh, files); err != nil {
		t.Fatal("repeat:", err)
	}
	var ledger []string
	if err := fresh.QueryRow(ctx, `SELECT array_agg(filename ORDER BY filename) FROM schema_migrations`).Scan(&ledger); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(ledger, []string{"0003_archived.sql", "B0002_snapshot.sql"}) {
		t.Fatalf("fresh ledger=%v", ledger)
	}
	states, err := migrationStatusWithFS(ctx, fresh, files)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range states {
		want := "applied"
		if row.Filename == "0001_initial.sql" || row.Filename == "0002_kind.sql" {
			want = "covered-by-baseline"
		}
		if row.State != want {
			t.Fatalf("%s state=%s, want %s", row.Filename, row.State, want)
		}
	}
	existing, _ := migrationDatabase(t)
	if err := migrateWithFS(ctx, existing, fstest.MapFS{"0001_initial.sql": files["0001_initial.sql"]}); err != nil {
		t.Fatal(err)
	}
	migrationSQL(t, existing, `INSERT INTO notes VALUES ('kept','Existing user content')`)
	if err := migrateWithFS(ctx, existing, files); err != nil {
		t.Fatal("upgrade:", err)
	}
	var content, kind string
	var archived bool
	if err := existing.QueryRow(ctx, `SELECT content,kind,archived FROM notes WHERE id='kept'`).Scan(&content, &kind, &archived); err != nil {
		t.Fatal(err)
	}
	if content != "Existing user content" || kind != "note" || archived {
		t.Fatal("upgrade changed existing content")
	}
	if err := existing.QueryRow(ctx, `SELECT array_agg(filename ORDER BY filename) FROM schema_migrations`).Scan(&ledger); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(ledger, []string{"0001_initial.sql", "0002_kind.sql", "0003_archived.sql"}) {
		t.Fatalf("upgrade ledger=%v", ledger)
	}
}

func TestBaselineDumpSettingsAreContained(t *testing.T) {
	ctx := context.Background()
	pool, _ := migrationDatabase(t)
	var beforePath, beforeFunctions, beforeRLS string
	if err := pool.QueryRow(ctx, `SELECT current_setting('search_path'),current_setting('check_function_bodies'),current_setting('row_security')`).Scan(&beforePath, &beforeFunctions, &beforeRLS); err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{
		"B0001_dump.sql":  {Data: []byte(`SELECT pg_catalog.set_config('search_path','',false); SET check_function_bodies=off; SET row_security=off; CREATE TABLE public.dump_notes(content text NOT NULL);`)},
		"0002_insert.sql": {Data: []byte(`INSERT INTO dump_notes VALUES ('forward migration succeeded');`)},
	}
	if err := migrateWithFS(ctx, pool, files); err != nil {
		t.Fatal(err)
	}
	var path, functions, rls, content string
	if err := pool.QueryRow(ctx, `SELECT current_setting('search_path'),current_setting('check_function_bodies'),current_setting('row_security'),content FROM dump_notes`).Scan(&path, &functions, &rls, &content); err != nil {
		t.Fatal(err)
	}
	if path != beforePath || functions != beforeFunctions || rls != beforeRLS || content != "forward migration succeeded" {
		t.Fatalf("snapshot session settings leaked: %q %q %q", path, functions, rls)
	}
}

func TestBaselineAcceptsInstalledExtension(t *testing.T) {
	pool, _ := migrationDatabase(t)
	migrationSQL(t, pool, "CREATE EXTENSION vector")
	if err := migrateWithFS(context.Background(), pool, migrationFixture()); err != nil {
		t.Fatal(err)
	}
}

func TestBaselineRefusalsPreserveDatabase(t *testing.T) {
	ctx := context.Background()
	t.Run("nonempty without ledger", func(t *testing.T) {
		for _, sql := range []string{`CREATE SCHEMA kept; CREATE TABLE kept.notes(id text)`, `CREATE FUNCTION public.kept() RETURNS integer LANGUAGE SQL AS 'SELECT 1'`, `CREATE TYPE public.kept AS ENUM ('keep')`} {
			pool, _ := migrationDatabase(t)
			migrationSQL(t, pool, sql)
			if err := migrateWithFS(ctx, pool, migrationFixture()); err == nil {
				t.Fatal("adopted a nonempty database")
			}
			var count int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&count); err != nil || count != 0 {
				t.Fatalf("ledger changed: %d %v", count, err)
			}
		}
	})
	t.Run("baseline checksum before pending writes", func(t *testing.T) {
		pool, _ := migrationDatabase(t)
		files := migrationFixture()
		delete(files, "0003_archived.sql")
		if err := migrateWithFS(ctx, pool, files); err != nil {
			t.Fatal(err)
		}
		files = migrationFixture()
		files["B0002_snapshot.sql"] = &fstest.MapFile{Data: []byte("-- edited\n" + string(files["B0002_snapshot.sql"].Data))}
		if err := migrateWithFS(ctx, pool, files); err == nil {
			t.Fatal("accepted edited baseline")
		}
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notes' AND column_name='archived')`).Scan(&exists); err != nil || exists {
			t.Fatalf("pending migration ran: %v %v", exists, err)
		}
	})
	t.Run("failed baseline rolls back", func(t *testing.T) {
		pool, _ := migrationDatabase(t)
		files := fstest.MapFS{"B0001_failure.sql": {Data: []byte(`CREATE TABLE partial(id int); SELECT missing_function();`)}}
		if err := migrateWithFS(ctx, pool, files); err == nil {
			t.Fatal("expected SQL failure")
		}
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT to_regclass('partial') IS NOT NULL OR EXISTS (SELECT 1 FROM schema_migrations)`).Scan(&exists); err != nil || exists {
			t.Fatalf("partial baseline committed: %v %v", exists, err)
		}
	})
}

// Dump schema with the server's own pg_dump, avoiding a second container or a
// host PostgreSQL dependency. Ownership is deployment-specific; grants stay.
func migrationSchemaDump(t *testing.T, name string) string {
	t.Helper()
	testdb.URL(t)
	container := os.Getenv("CAPY_GO_TEST_CONTAINER")
	if !regexp.MustCompile(`^capy-go-test-[0-9a-f]{10}$`).MatchString(container) {
		t.Fatal("schema comparison requires pnpm test:go's container")
	}
	cmd := exec.Command("docker", "exec", container, "pg_dump", "-U", "capy", "--schema-only", "--no-owner", "--exclude-table=public.schema_migrations", name)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("pg_dump: %v\n%s", err, out)
	}
	var lines []string
	for _, line := range strings.Split(string(out), "\n") {
		// New PostgreSQL patch versions randomize psql's dump protection token.
		if strings.HasPrefix(line, `\restrict `) || strings.HasPrefix(line, `\unrestrict `) {
			continue
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func migrationSeedRows(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	rows, err := pool.Query(ctx, `SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%' AND NOT (schemaname='public' AND tablename='schema_migrations') ORDER BY schemaname,tablename`)
	if err != nil {
		t.Fatal(err)
	}
	var tables [][2]string
	for rows.Next() {
		var pair [2]string
		if err := rows.Scan(&pair[0], &pair[1]); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, pair)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	var result strings.Builder
	for _, table := range tables {
		// Only audit timestamps are nondeterministic. All actual catalog values and
		// all other tables are compared, so leaked fixtures fail equivalence too.
		var data string
		sql := `SELECT COALESCE(jsonb_agg(row ORDER BY row::text), '[]'::jsonb)::text FROM (SELECT to_jsonb(t) - ARRAY['created_at','updated_at'] AS row FROM ` + pgx.Identifier{table[0], table[1]}.Sanitize() + ` t) q`
		if err := pool.QueryRow(ctx, sql).Scan(&data); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&result, "%s.%s=%s\n", table[0], table[1], data)
	}
	return result.String()
}

func migrationSequenceState(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	rows, err := pool.Query(ctx, `SELECT schemaname,sequencename FROM pg_sequences WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_%' ORDER BY schemaname,sequencename`)
	if err != nil {
		t.Fatal(err)
	}
	var sequences [][2]string
	for rows.Next() {
		var pair [2]string
		if err := rows.Scan(&pair[0], &pair[1]); err != nil {
			t.Fatal(err)
		}
		sequences = append(sequences, pair)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	var result strings.Builder
	for _, sequence := range sequences {
		var value int64
		var called bool
		if err := pool.QueryRow(ctx, "SELECT last_value,is_called FROM "+pgx.Identifier{sequence[0], sequence[1]}.Sanitize()).Scan(&value, &called); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&result, "%s.%s=%d,%t\n", sequence[0], sequence[1], value, called)
	}
	return result.String()
}

func TestBaselineComparisonDetectsSequenceDrift(t *testing.T) {
	a, _ := migrationDatabase(t)
	b, _ := migrationDatabase(t)
	for _, pool := range []*pgxpool.Pool{a, b} {
		migrationSQL(t, pool, "CREATE TABLE catalog(id serial PRIMARY KEY, name text)")
	}
	migrationSQL(t, a, "INSERT INTO catalog(name) VALUES ('free')")
	migrationSQL(t, b, "INSERT INTO catalog(id,name) VALUES (1,'free')")
	if migrationSeedRows(t, a) != migrationSeedRows(t, b) {
		t.Fatal("fixture rows should match")
	}
	if migrationSequenceState(t, a) == migrationSequenceState(t, b) {
		t.Fatal("missed sequence drift that would collide on the next insert")
	}
}

func checkMigrationEquivalence(t *testing.T, forward, baseline fs.FS) {
	t.Helper()
	ctx := context.Background()
	a, aname := migrationDatabase(t)
	b, bname := migrationDatabase(t)
	if err := migrateWithFS(ctx, a, forward); err != nil {
		t.Fatal("forward path:", err)
	}
	if err := migrateWithFS(ctx, b, baseline); err != nil {
		t.Fatal("baseline path:", err)
	}
	if migrationSchemaDump(t, aname) != migrationSchemaDump(t, bname) {
		t.Fatal("baseline schema differs from forward history")
	}
	if migrationSeedRows(t, a) != migrationSeedRows(t, b) {
		t.Fatal("baseline catalog/seed rows differ from forward history")
	}
	if migrationSequenceState(t, a) != migrationSequenceState(t, b) {
		t.Fatal("baseline sequence state differs from forward history")
	}
}

func TestEmbeddedBaselinesMatchForwardHistory(t *testing.T) {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	all := fstest.MapFS{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		body, err := migrations.FS.ReadFile(entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		all[entry.Name()] = &fstest.MapFile{Data: body}
	}
	forwardHistory := fstest.MapFS{}
	for name, file := range all {
		if migrationFileName.MatchString(name) && !strings.HasPrefix(name, "B") {
			forwardHistory[name] = file
		}
	}
	if _, err := planMigrations(forwardHistory, nil); err != nil {
		t.Fatalf("retained forward history is incomplete: %v", err)
	}
	// Exercise the real application schema through the baseline runner even
	// before the first consolidated snapshot is published. No duplicate SQL file.
	t.Run("initial_schema", func(t *testing.T) {
		checkMigrationEquivalence(t, fstest.MapFS{"0001_init.sql": all["0001_init.sql"]}, fstest.MapFS{"B0001_initial.sql": all["0001_init.sql"]})
	})
	for name, file := range all {
		if !regexp.MustCompile(`^B[0-9]{4}_.+\.sql$`).MatchString(name) {
			continue
		}
		t.Run(name, func(t *testing.T) {
			version := name[1:5]
			forward := fstest.MapFS{}
			boundaryPresent := false
			for n, f := range all {
				if migrationFileName.MatchString(n) && !strings.HasPrefix(n, "B") && n[:4] <= version {
					forward[n] = f
					boundaryPresent = boundaryPresent || n[:4] == version
				}
			}
			if !boundaryPresent {
				t.Fatal("baseline version must match a retained numbered migration")
			}
			checkMigrationEquivalence(t, forward, fstest.MapFS{name: file})
		})
	}
	t.Run("synthetic_with_later_migration", func(t *testing.T) {
		forward := migrationFixture()
		delete(forward, "B0002_snapshot.sql")
		checkMigrationEquivalence(t, forward, migrationFixture())
	})
}
