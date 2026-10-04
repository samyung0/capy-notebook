-- Edits a published file already holds are charged once, in the file's bytes
-- (human/backend-storage-quota.md, 2026-10-05).
--   Office, while a deferred publication waits for its rebuild
--     (rebuild_pending): the state still holds the published capture
--     (published_state, both changes over seed(old base)) plus later edits, so
--     it is charged only beyond the capture. The rebuild's state, a change
--     over seed(published), is charged as stored again.
--   Text: a publication moves seed_bytes by the change in the file's size
--     (PublishSourceRefresh), so the state is charged its growth beyond the
--     published text: its Yjs history and edits after the capture.
CREATE TEMP TABLE source_storage_before_0054 ON COMMIT DROP AS
  SELECT file_id, user_id, storage_bytes FROM source_documents;
ALTER TABLE source_documents DROP COLUMN storage_bytes;
ALTER TABLE source_documents ADD COLUMN storage_bytes bigint GENERATED ALWAYS AS
  (COALESCE(octet_length(NULLIF(pending_effects, '[]'::jsonb)::text), 0)::bigint
   + CASE WHEN format = 'text' THEN GREATEST(0, COALESCE(octet_length(state), 0) - seed_bytes)
          WHEN rebuild_pending THEN GREATEST(0, COALESCE(octet_length(state), 0) - COALESCE(octet_length(published_state), 0))
          ELSE COALESCE(octet_length(state), 0) END) STORED;
-- The storage trigger does not see DDL, so the ledger takes each row's change.
SELECT append_user_storage_delta(d.user_id, d.storage_bytes - b.storage_bytes)
FROM source_documents d JOIN source_storage_before_0054 b ON b.file_id = d.file_id
WHERE d.storage_bytes <> b.storage_bytes;

-- A text row published before this kept the seed size of the text it started
-- from (0 when first saved before 0033 recorded one). A text row's base is its
-- file, and seed(text of n bytes) encodes as n + 14 bytes plus the varUint
-- length of n (one Yjs item under client 0; 2 bytes when empty), which a row
-- never published already holds, so only the others change. The storage
-- trigger books each change.
UPDATE source_documents d
SET seed_bytes = s.seed
FROM files f, LATERAL (SELECT CASE WHEN f.size_bytes = 0 THEN 2
    ELSE f.size_bytes + 14 + CASE WHEN f.size_bytes < 128 THEN 1 WHEN f.size_bytes < 16384 THEN 2
                                  WHEN f.size_bytes < 2097152 THEN 3 ELSE 4 END END AS seed) s
WHERE f.id = d.file_id AND d.format = 'text' AND d.state IS NOT NULL AND d.seed_bytes <> s.seed;
