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
