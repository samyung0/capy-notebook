-- Office storage (human/backend-storage-quota.md, the 2026-09-25 quota rule;
-- human/frontend/office-files.md, Office editing state stores only what users
-- changed). A source is charged its pending effects plus the growth of its
-- editing state beyond the seed it started from, plus a stored baseline when
-- one exists; the engine's representation of the file is a platform cost.
-- An empty effect list ('[]') costs nothing, so opening a file charges only
-- its source.
--   state NULL: seed(base) until the first save, which stores the state and
--     its seed size (seed_bytes).
--   indexed_baseline NULL: derived from the base; only a publication that
--     rebased later edits stores one.
-- A refresh candidate is uncharged while transient (publication gates the net
-- growth) and keeps no baseline. Its state stays NULL, meaning the source's
-- state at the candidate's checkpoint, until a save lands during the refresh
-- and copies it (SaveSourceCheckpoint). Of the export's seed it keeps only the
-- size (seed_bytes, set by finalize): a publication that rebases later edits
-- records it as the new state's seed size.
-- The storage trigger does not see DDL, so the ledger takes each row's change.
CREATE TEMP TABLE source_storage_before ON COMMIT DROP AS
  SELECT file_id, user_id, storage_bytes FROM source_documents;
ALTER TABLE source_documents DROP COLUMN storage_bytes;
ALTER TABLE source_documents
  ALTER COLUMN state DROP NOT NULL, ALTER COLUMN state DROP DEFAULT,
  ALTER COLUMN indexed_baseline DROP NOT NULL, ALTER COLUMN indexed_baseline DROP DEFAULT,
  ADD COLUMN seed_bytes bigint NOT NULL DEFAULT 0 CHECK (seed_bytes >= 0);
ALTER TABLE source_documents ADD COLUMN storage_bytes bigint GENERATED ALWAYS AS
  (COALESCE(octet_length(NULLIF(pending_effects, '[]'::jsonb)::text), 0)::bigint
   + GREATEST(0, COALESCE(octet_length(state), 0) - seed_bytes)
   + COALESCE(octet_length(indexed_baseline), 0)) STORED;
SELECT append_user_storage_delta(d.user_id, d.storage_bytes - b.storage_bytes)
FROM source_documents d JOIN source_storage_before b ON b.file_id = d.file_id;
-- An empty value is NULL now, and a text baseline is its base blob decoded.
UPDATE source_documents
SET state = NULLIF(state, ''::bytea),
    indexed_baseline = CASE WHEN format = 'text' THEN NULL ELSE NULLIF(indexed_baseline, ''::bytea) END
WHERE octet_length(state) = 0 OR format = 'text' OR octet_length(indexed_baseline) = 0;

SELECT append_user_storage_delta(user_id, -storage_bytes) FROM source_refresh_candidates;
DROP TRIGGER source_refresh_candidates_storage_after ON source_refresh_candidates;
DROP TRIGGER source_refresh_candidates_owner_before ON source_refresh_candidates;
ALTER TABLE source_refresh_candidates
  DROP COLUMN storage_bytes, DROP COLUMN baseline, DROP COLUMN user_id, DROP COLUMN seed,
  ADD COLUMN seed_bytes bigint CHECK (seed_bytes >= 0),
  ALTER COLUMN state DROP NOT NULL;
CREATE OR REPLACE FUNCTION transfer_source_storage_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE source_documents SET user_id=NEW.user_id WHERE file_id=NEW.id;
  RETURN NULL;
END;
$$;
