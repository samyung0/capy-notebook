-- Office editing state as its change over the seed (human/frontend/office-files.md
-- and human/backend-storage-quota.md, 2026-09-28).
--   state_seed_sha256 set: the state is the Yjs change over seed(base), and this
--     is the SHA-256 of that seed; the collaboration service rebuilds seed(base)
--     and refuses the state when the hash differs.
--   state_seed_sha256 NULL: the state is a full Yjs state (text, and a DOCX or
--     PPTX state rebased by a publication, which keeps its stored baseline).
-- An Office row is charged its stored bytes; text keeps seed_bytes and its
-- growth-over-seed charge. A refresh candidate's captured copy keeps its kind,
-- and a finalized candidate is the one with a source SHA.
-- Blob references change only with their path, so the reference trigger no
-- longer serializes whole rows (a source's full editing state) on every save.
DROP TRIGGER source_documents_blob_refs_after ON source_documents;
CREATE TRIGGER source_documents_blob_refs_after
AFTER INSERT OR UPDATE OF base_blob_path OR DELETE ON source_documents
FOR EACH ROW EXECUTE FUNCTION account_blob_refs('base_blob_path');
DROP TRIGGER source_refresh_candidates_blob_refs_after ON source_refresh_candidates;
CREATE TRIGGER source_refresh_candidates_blob_refs_after
AFTER INSERT OR UPDATE OF source_blob_path OR DELETE ON source_refresh_candidates
FOR EACH ROW EXECUTE FUNCTION account_blob_refs('source_blob_path');
DROP TRIGGER image_caption_associations_blob_refs_after ON image_caption_associations;
CREATE TRIGGER image_caption_associations_blob_refs_after
AFTER INSERT OR UPDATE OF caption_blob_path OR DELETE ON image_caption_associations
FOR EACH ROW EXECUTE FUNCTION account_blob_refs('caption_blob_path');

-- The storage trigger does not see DDL, so the ledger takes each row's change.
CREATE TEMP TABLE source_storage_before ON COMMIT DROP AS
  SELECT file_id, user_id, storage_bytes FROM source_documents;
ALTER TABLE source_documents DROP COLUMN storage_bytes;
ALTER TABLE source_documents
  ADD COLUMN state_seed_sha256 text CHECK (state_seed_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT source_documents_state_seed_check
    CHECK (state_seed_sha256 IS NULL OR (state IS NOT NULL AND format <> 'text'));
ALTER TABLE source_documents ADD COLUMN storage_bytes bigint GENERATED ALWAYS AS
  (COALESCE(octet_length(NULLIF(pending_effects, '[]'::jsonb)::text), 0)::bigint
   + CASE WHEN format = 'text' THEN GREATEST(0, COALESCE(octet_length(state), 0) - seed_bytes)
          ELSE COALESCE(octet_length(state), 0) END
   + COALESCE(octet_length(indexed_baseline), 0)) STORED;
SELECT append_user_storage_delta(d.user_id, d.storage_bytes - b.storage_bytes)
FROM source_documents d JOIN source_storage_before b ON b.file_id = d.file_id
WHERE d.storage_bytes <> b.storage_bytes;
-- Office charges ignore seed_bytes now, so this changes no storage_bytes.
UPDATE source_documents SET seed_bytes = 0 WHERE format <> 'text' AND seed_bytes <> 0;
ALTER TABLE source_documents ADD CONSTRAINT source_documents_seed_bytes_text_check
  CHECK (format = 'text' OR seed_bytes = 0);

ALTER TABLE source_refresh_candidates
  DROP COLUMN seed_bytes,
  ADD COLUMN state_seed_sha256 text CHECK (state_seed_sha256 ~ '^[0-9a-f]{64}$');
