ALTER TABLE ingest_worker_samples
  DROP CONSTRAINT ingest_worker_samples_role_check,
  ADD CONSTRAINT ingest_worker_samples_role_check
    CHECK (role IN ('import', 'parse', 'ingest'));

ALTER TABLE ingest_worker_sample_rollups
  DROP CONSTRAINT ingest_worker_sample_rollups_role_check,
  ADD CONSTRAINT ingest_worker_sample_rollups_role_check
    CHECK (role IN ('import', 'parse', 'ingest'));
