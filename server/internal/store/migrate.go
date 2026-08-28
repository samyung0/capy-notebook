package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"regexp"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/evonotes/server/migrations"
)

const schemaMigrationsDDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`

// Session lock so two replicas serialize the apply loop. Unlock must run on
// the same connection that took the lock (a pool-level lock would leak).
const migrateLockKey int64 = 0x65766f6d696731 // "evomig1"

var migrationFileName = regexp.MustCompile(`^\d{4}_.+\.sql$`)

// ShouldApplyDevSeed reports whether this process should load the local demo
// rows. Production, UAT, and e2e stay empty of Kate Malone.
func ShouldApplyDevSeed(appEnv string) bool {
	return appEnv == "" || appEnv == "development"
}

// MigrationFileStatus is one numbered file in this binary versus the ledger.
type MigrationFileStatus struct {
	Filename         string
	Checksum         string
	Applied          bool
	AppliedChecksum  string
	ChecksumMismatch bool
}

// Migrate applies each numbered embedded SQL file once. A matching checksum
// skips. A recorded file whose bytes changed is an error: add a new file.
func (s *Store) Migrate(ctx context.Context) error {
	return migrateWithConn(ctx, s.pool)
}

func migrateWithConn(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("migrate: acquire: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, schemaMigrationsDDL); err != nil {
		return fmt.Errorf("migrate: create schema_migrations: %w", err)
	}
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrateLockKey); err != nil {
		return fmt.Errorf("migrate: lock: %w", err)
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, migrateLockKey)
	}()

	applied, err := loadAppliedMigrations(ctx, conn)
	if err != nil {
		return err
	}
	files, err := listMigrationFiles()
	if err != nil {
		return err
	}
	for _, name := range files {
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			return fmt.Errorf("migrate: read %s: %w", name, err)
		}
		sum := checksumSQL(body)
		if recorded, ok := applied[name]; ok {
			if recorded != sum {
				return fmt.Errorf("migrate: %s already applied with a different checksum; add a new numbered file", name)
			}
			continue
		}
		if err := applyMigration(ctx, conn, name, string(body), sum); err != nil {
			return err
		}
	}
	return nil
}

func applyMigration(ctx context.Context, conn *pgxpool.Conn, name, body, sum string) error {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("migrate: begin %s: %w", name, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, body); err != nil {
		return fmt.Errorf("migrate: apply %s: %w", name, err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)`,
		name, sum,
	); err != nil {
		return fmt.Errorf("migrate: record %s: %w", name, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("migrate: commit %s: %w", name, err)
	}
	return nil
}

func loadAppliedMigrations(ctx context.Context, conn *pgxpool.Conn) (map[string]string, error) {
	rows, err := conn.Query(ctx, `SELECT filename, checksum FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("migrate: list applied: %w", err)
	}
	defer rows.Close()
	applied := make(map[string]string)
	for rows.Next() {
		var name, sum string
		if err := rows.Scan(&name, &sum); err != nil {
			return nil, fmt.Errorf("migrate: scan applied: %w", err)
		}
		applied[name] = sum
	}
	return applied, rows.Err()
}

func listMigrationFiles() ([]string, error) {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return nil, fmt.Errorf("migrate: read embed: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !migrationFileName.MatchString(e.Name()) {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names, nil
}

func checksumSQL(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// MigrationStatus lists numbered files in this binary and whether Postgres
// already recorded them. Extra ledger rows (a newer database, older binary)
// are ignored so a rollback deploy can still serve.
func (s *Store) MigrationStatus(ctx context.Context) ([]MigrationFileStatus, error) {
	if _, err := s.pool.Exec(ctx, schemaMigrationsDDL); err != nil {
		return nil, fmt.Errorf("migrate status: %w", err)
	}
	rows, err := s.pool.Query(ctx, `SELECT filename, checksum FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("migrate status: %w", err)
	}
	defer rows.Close()
	applied := make(map[string]string)
	for rows.Next() {
		var name, sum string
		if err := rows.Scan(&name, &sum); err != nil {
			return nil, err
		}
		applied[name] = sum
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	files, err := listMigrationFiles()
	if err != nil {
		return nil, err
	}
	out := make([]MigrationFileStatus, 0, len(files))
	for _, name := range files {
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			return nil, err
		}
		sum := checksumSQL(body)
		st := MigrationFileStatus{Filename: name, Checksum: sum}
		if recorded, ok := applied[name]; ok {
			st.Applied = true
			st.AppliedChecksum = recorded
			st.ChecksumMismatch = recorded != sum
		}
		out = append(out, st)
	}
	return out, nil
}

// ApplyDevSeed loads the local demo rows. The file is not a numbered
// migration and is safe to re-run (ON CONFLICT).
func (s *Store) ApplyDevSeed(ctx context.Context) error {
	body, err := migrations.FS.ReadFile("dev_seed.sql")
	if err != nil {
		return fmt.Errorf("dev seed: %w", err)
	}
	if _, err := s.pool.Exec(ctx, string(body)); err != nil {
		return fmt.Errorf("dev seed: %w", err)
	}
	return nil
}

// AbortOrphanedStreams marks assistant rows left 'streaming' after a crash.
// This is boot cleanup, not a migration: it must run on every API start.
func (s *Store) AbortOrphanedStreams(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `UPDATE messages SET status='aborted' WHERE status='streaming'`); err != nil {
		return fmt.Errorf("abort orphaned streams: %w", err)
	}
	return nil
}
