-- The first-UAT source files were permanently removed before this format change.
-- Refuse to reinterpret a saved Yjs snapshot as a semantic baseline elsewhere.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM source_documents WHERE octet_length(state)>0 OR octet_length(indexed_state)>0)
     OR EXISTS (SELECT 1 FROM source_refresh_candidates) THEN
    RAISE EXCEPTION 'Source baseline format change requires empty source editing records; preserve/export existing edits before retrying';
  END IF;
END $$;
ALTER TABLE source_documents RENAME COLUMN indexed_state TO indexed_baseline;
ALTER TABLE source_refresh_candidates ADD COLUMN baseline bytea NOT NULL DEFAULT '';
-- Candidate baseline is part of the fixed export and is released on publication.
ALTER TABLE source_refresh_candidates DROP COLUMN storage_bytes;
ALTER TABLE source_refresh_candidates ADD COLUMN storage_bytes bigint GENERATED ALWAYS AS
  (octet_length(state)::bigint+COALESCE(octet_length(seed),0)+size_bytes+octet_length(baseline)) STORED;
