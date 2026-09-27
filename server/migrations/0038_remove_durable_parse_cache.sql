-- Local parser handoffs and indexed database content remain authoritative.
-- The existing reference trigger queues these optional B2 copies for deletion
-- with its 15-minute reader grace and the bucket's noncurrent-version lifecycle.
DELETE FROM artifact_cache WHERE kind = 'parse_bundle';

ALTER TABLE artifact_cache DROP CONSTRAINT artifact_cache_kind_check;
ALTER TABLE artifact_cache ADD CONSTRAINT artifact_cache_kind_check
  CHECK (kind IN ('captions', 'derived_text'));

COMMENT ON COLUMN files.parsed_blob_path IS
  'Diagnostic identity of the temporary local parser-to-ingest handoff; never a B2 key.';
