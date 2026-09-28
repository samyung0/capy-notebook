-- DOCX and PPTX publication rebases land on seed(export) like XLSX
-- (human/frontend/office-files.md, 2026-09-28): every Office state is stored
-- as its change over the seed of its base, with that seed's SHA-256, and the
-- indexed baseline always derives from the base. No row stores a baseline any
-- more (text never did), so indexed_baseline and its storage charge go.
-- A DOCX or PPTX state a publication rebased before this is stored whole with
-- its baseline and would no longer load: publish it first (the Office
-- maintenance window's publish-all returns it to NULL). The guard refuses
-- while one exists, so dropping the column loses nothing and changes no charge.
LOCK TABLE source_documents IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM source_documents WHERE indexed_baseline IS NOT NULL
      OR (format <> 'text' AND state IS NOT NULL AND state_seed_sha256 IS NULL)) THEN
    RAISE EXCEPTION 'An Office source still holds a rebased state stored whole; publish it (office-maintenance publish-all) before this migration';
  END IF;
END $$;

ALTER TABLE source_documents DROP COLUMN storage_bytes;
ALTER TABLE source_documents DROP COLUMN indexed_baseline;
ALTER TABLE source_documents ADD COLUMN storage_bytes bigint GENERATED ALWAYS AS
  (COALESCE(octet_length(NULLIF(pending_effects, '[]'::jsonb)::text), 0)::bigint
   + CASE WHEN format = 'text' THEN GREATEST(0, COALESCE(octet_length(state), 0) - seed_bytes)
          ELSE COALESCE(octet_length(state), 0) END) STORED;
-- An Office state names the seed it is a change over (0039 keeps text states whole).
ALTER TABLE source_documents ADD CONSTRAINT source_documents_office_state_seed_check
  CHECK (format = 'text' OR state IS NULL OR state_seed_sha256 IS NOT NULL);
