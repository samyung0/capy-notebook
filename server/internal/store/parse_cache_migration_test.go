package store

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/samyung0/capy-notebook/server/migrations"
)

func TestParseCacheRemovalQueuesOnlyRetiredCopies(t *testing.T) {
	s := openMigrateTestStore(t)
	ctx := context.Background()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Reconstruct the prior cache kinds without changing the applied migrations.
	if _, err := tx.Exec(ctx, `ALTER TABLE artifact_cache DROP CONSTRAINT artifact_cache_kind_check;
		INSERT INTO artifact_cache (object_path,kind,source_sha256,size_bytes) VALUES
		('parse-bundles/migration-retired.zip','parse_bundle','migration-source',123),
		('derived-text/migration-kept.json','derived_text','migration-source',456),
		('captions/migration-kept.json','captions','migration-source',789);
		ALTER TABLE artifact_cache ADD CONSTRAINT artifact_cache_kind_check
		  CHECK (kind IN ('captions','derived_text','parse_bundle'));
		SELECT blob_ref('sources/migration-kept.pdf');`); err != nil {
		t.Fatal(err)
	}
	body, err := migrations.FS.ReadFile("0038_remove_durable_parse_cache.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, string(body)); err != nil {
		t.Fatal(err)
	}
	for name, query := range map[string]string{
		"retired cache removed":                     `SELECT NOT EXISTS(SELECT 1 FROM artifact_cache WHERE kind='parse_bundle')`,
		"retired blob released":                     `SELECT NOT EXISTS(SELECT 1 FROM blobs WHERE object_path='parse-bundles/migration-retired.zip')`,
		"reader grace retained":                     `SELECT not_before=now()+interval '15 minutes' FROM pending_blob_deletions WHERE object_path='parse-bundles/migration-retired.zip'`,
		"paid caches retained":                      `SELECT count(*)=2 FROM artifact_cache WHERE source_sha256='migration-source'`,
		"source and paid cache references retained": `SELECT count(*)=3 AND min(ref_count)=1 FROM blobs WHERE object_path IN ('sources/migration-kept.pdf','derived-text/migration-kept.json','captions/migration-kept.json')`,
		"only retired copy queued":                  `SELECT NOT EXISTS(SELECT 1 FROM pending_blob_deletions WHERE object_path IN ('sources/migration-kept.pdf','derived-text/migration-kept.json','captions/migration-kept.json'))`,
	} {
		var ok bool
		if err := tx.QueryRow(ctx, query).Scan(&ok); err != nil || !ok {
			t.Fatalf("%s: ok=%v err=%v", name, ok, err)
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO artifact_cache (object_path,kind,source_sha256)
		VALUES ('parse-bundles/rejected.zip','parse_bundle','new-source')`)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
		t.Fatalf("retired cache kind must be rejected, got %v", err)
	}
}
