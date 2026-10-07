-- Delta saves for notes (human/editor-perf.md, 2026-10-06): a store appends
-- the update since the room's durable state instead of rewriting the whole
-- state. material_yjs_documents.state stays the base (a full state); the rows
-- below follow it in seq order. A load replays base + rows and checks them; a
-- fold (the collaboration service, when the room is empty or the log passes a
-- size) merges the rows into the base and deletes them in one transaction.
CREATE TABLE material_yjs_updates (
  material_id text NOT NULL REFERENCES material_yjs_documents(material_id) ON DELETE CASCADE,
  -- The stored_version the row made.
  seq         bigint NOT NULL CHECK (seq > 0),
  update      bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (material_id, seq)
);

-- What the rows hold, kept by the appending transaction and reset by a fold.
ALTER TABLE material_yjs_documents
  ADD COLUMN log_bytes bigint NOT NULL DEFAULT 0 CHECK (log_bytes >= 0),
  ADD COLUMN log_rows integer NOT NULL DEFAULT 0 CHECK (log_rows >= 0);

-- Delta saves for source documents (DESIGN 3.1/3.6).
-- source_documents.state stays the base: an Office change over seed(base)
-- (NULL: the seed) or a whole text state. Each checkpoint appends the room's
-- update since its durable state as one row; a fold merges rows into the base.
CREATE TABLE source_document_updates (
  file_id text NOT NULL REFERENCES source_documents(file_id) ON DELETE CASCADE,
  epoch bigint NOT NULL,
  checkpoint bigint NOT NULL CHECK (checkpoint > 0),
  update bytea NOT NULL,
  PRIMARY KEY (file_id, epoch, checkpoint)
);

CREATE TEMP TABLE source_storage_before_delta ON COMMIT DROP AS
  SELECT file_id, user_id, storage_bytes FROM source_documents;
ALTER TABLE source_documents DROP COLUMN storage_bytes;
ALTER TABLE source_documents
  ADD COLUMN log_bytes bigint NOT NULL DEFAULT 0 CHECK (log_bytes >= 0),
  ADD COLUMN log_rows integer NOT NULL DEFAULT 0 CHECK (log_rows >= 0);
-- A NULL base with rows over it names its seed too (the first append sets it).
ALTER TABLE source_documents DROP CONSTRAINT source_documents_state_seed_check;
ALTER TABLE source_documents ADD CONSTRAINT source_documents_state_seed_check
  CHECK (state_seed_sha256 IS NULL OR format <> 'text');
ALTER TABLE source_documents DROP CONSTRAINT source_documents_office_state_seed_check;
ALTER TABLE source_documents ADD CONSTRAINT source_documents_office_state_seed_check
  CHECK (format = 'text' OR (state IS NULL AND log_rows = 0) OR state_seed_sha256 IS NOT NULL);
-- Stored bytes are charged: the base plus the unfolded rows (a fold lowers it).
ALTER TABLE source_documents ADD COLUMN storage_bytes bigint GENERATED ALWAYS AS
  (COALESCE(octet_length(NULLIF(pending_effects, '[]'::jsonb)::text), 0)::bigint
   + CASE WHEN format = 'text' THEN GREATEST(0, COALESCE(octet_length(state), 0) + log_bytes - seed_bytes)
          WHEN rebuild_pending THEN GREATEST(0, COALESCE(octet_length(state), 0) + log_bytes - COALESCE(octet_length(published_state), 0))
          ELSE COALESCE(octet_length(state), 0) + log_bytes END) STORED;
SELECT append_user_storage_delta(d.user_id, d.storage_bytes - b.storage_bytes)
FROM source_documents d JOIN source_storage_before_delta b ON b.file_id = d.file_id
WHERE d.storage_bytes <> b.storage_bytes;
