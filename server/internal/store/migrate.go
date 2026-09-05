package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/samyung0/capy-notebook/server/migrations"
)

const schemaMigrationsDDL = `
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename   text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`

// Session lock so two replicas serialize the apply loop. Unlock must run on
// the same connection that took the lock (a pool-level lock would leak).
const migrateLockKey int64 = 0x65766f6d696731 // Stable advisory lock across releases.

// ShouldApplyDevSeed reports whether this process should load the local demo
// rows. Production, UAT, and e2e stay empty of Kate Malone.
func ShouldApplyDevSeed(appEnv string) bool {
	return appEnv == "" || appEnv == "development"
}

// MigrationFileStatus is one migration file in the validated execution plan.
type MigrationFileStatus struct {
	State           string
	Filename        string
	Checksum        string
	Applied         bool
	AppliedChecksum string
}

// Migrate applies the pending baseline/numbered plan once. Recorded bytes are
// immutable: checksum changes require a new numbered file.
func (s *Store) Migrate(ctx context.Context) error {
	return migrateWithConn(ctx, s.pool)
}

func migrateWithConn(ctx context.Context, pool *pgxpool.Pool) error {
	return migrateWithFS(ctx, pool, migrations.FS)
}

func migrationPlanWithConn(ctx context.Context, conn *pgxpool.Conn, fsys fs.FS) (migrationPlan, error) {
	if _, err := conn.Exec(ctx, schemaMigrationsDDL); err != nil {
		return migrationPlan{}, fmt.Errorf("migrate: create ledger: %w", err)
	}
	applied, err := loadAppliedMigrations(ctx, conn)
	if err != nil {
		return migrationPlan{}, err
	}
	plan, err := planMigrations(fsys, applied)
	if err != nil {
		return plan, err
	}
	if plan.needsEmpty {
		var occupied bool
		err = conn.QueryRow(ctx, applicationObjectsSQL).Scan(&occupied)
		if err != nil {
			return plan, fmt.Errorf("migrate: inspect empty database: %w", err)
		}
		if occupied {
			return plan, fmt.Errorf("migrate: refusing baseline on a nonempty application database with an empty ledger")
		}
	}
	return plan, nil
}

// Extension objects are infrastructure; every other user-schema relation,
// routine, or type prevents initializing an empty ledger from a snapshot.
const applicationObjectsSQL = `WITH RECURSIVE extension_objects(classid,objid) AS (
 SELECT classid,objid FROM pg_depend WHERE deptype='e'
 UNION
 SELECT d.classid,d.objid FROM pg_depend d JOIN extension_objects e
  ON d.refclassid=e.classid AND d.refobjid=e.objid WHERE d.deptype IN ('a','i')
) SELECT EXISTS (
 SELECT 1 FROM (
  SELECT 'pg_class'::regclass AS classid,c.oid,c.relnamespace AS namespace
  FROM pg_class c WHERE c.oid <> 'public.schema_migrations'::regclass
   AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid=c.oid AND i.indrelid='public.schema_migrations'::regclass)
  UNION ALL
  SELECT 'pg_proc'::regclass,p.oid,p.pronamespace FROM pg_proc p
  UNION ALL
  SELECT 'pg_type'::regclass,t.oid,t.typnamespace FROM pg_type t
   WHERE t.typrelid <> 'public.schema_migrations'::regclass
    AND t.oid <> (SELECT typarray FROM pg_type WHERE typrelid='public.schema_migrations'::regclass)
 ) obj JOIN pg_namespace n ON n.oid=obj.namespace
 WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
 AND NOT EXISTS (SELECT 1 FROM extension_objects e WHERE e.classid=obj.classid AND e.objid=obj.oid)
)`

func lockedMigrationConn(ctx context.Context, pool *pgxpool.Pool) (*pgxpool.Conn, func(), error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, nil, err
	}
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrateLockKey); err != nil {
		conn.Release()
		return nil, nil, err
	}
	return conn, func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, migrateLockKey)
		conn.Release()
	}, nil
}

func migrateWithFS(ctx context.Context, pool *pgxpool.Pool, fsys fs.FS) error {
	conn, release, err := lockedMigrationConn(ctx, pool)
	if err != nil {
		return err
	}
	defer release()
	plan, err := migrationPlanWithConn(ctx, conn, fsys)
	if err != nil {
		return err
	}
	for i, file := range plan.files {
		if plan.status[i].State == "pending" {
			if err := applyMigration(ctx, conn, file.name, string(file.body), plan.status[i].Checksum); err != nil {
				return err
			}
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
	// Snapshot session settings must not leak into later files or pooled API connections.
	if _, err := tx.Exec(ctx, `RESET ALL`); err != nil {
		return fmt.Errorf("migrate: reset session after %s: %w", name, err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)`,
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
	rows, err := conn.Query(ctx, `SELECT filename, checksum FROM public.schema_migrations`)
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
	files, err := readMigrationFiles(migrations.FS)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(files))
	for _, file := range files {
		names = append(names, file.name)
	}
	return names, nil
}

func checksumSQL(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// MigrationStatus returns the same validated plan used by Migrate.
func (s *Store) MigrationStatus(ctx context.Context) ([]MigrationFileStatus, error) {
	return migrationStatusWithFS(ctx, s.pool, migrations.FS)
}
func migrationStatusWithFS(ctx context.Context, pool *pgxpool.Pool, fsys fs.FS) ([]MigrationFileStatus, error) {
	conn, release, err := lockedMigrationConn(ctx, pool)
	if err != nil {
		return nil, err
	}
	defer release()
	plan, err := migrationPlanWithConn(ctx, conn, fsys)
	return plan.status, err
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
