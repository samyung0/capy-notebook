-- Window snapshots of the in-place Yjs collection (openwiki/backend-storage-quota.md
-- "Yjs storage growth"): with the collection on, each fold of a note stores
-- the folded document's state vector and delete set at its stored_version as
-- a later collection's window candidate, and keeps the newest four per
-- document. They hold ids only, no content; only the collaboration server
-- reads and writes them, and like the rest of a material's Yjs history they
-- are not charged to storage. Notes only for now (Q274); `document` leaves
-- room for a quiz's keys.
CREATE TABLE material_yjs_windows (
  material_id    text NOT NULL REFERENCES material_yjs_documents(material_id) ON DELETE CASCADE,
  document       text NOT NULL CHECK (document IN ('content', 'keys')),
  stored_version bigint NOT NULL,
  state_vector   bytea NOT NULL,
  delete_set     bytea NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (material_id, document, stored_version)
);

-- The stored version of the window the latest collection used (0: none
-- yet): a session or draft group naming an older version missed what was
-- collected, so it takes the late path.
ALTER TABLE material_yjs_documents ADD COLUMN collected_window bigint NOT NULL DEFAULT 0;
