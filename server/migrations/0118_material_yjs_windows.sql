-- Window snapshots of the in-place Yjs collection (openwiki/backend-storage-quota.md
-- "Yjs storage growth"): with the collection on, each fold stores the folded
-- document's state vector and delete set at its stored_version as a later
-- collection's window candidate, and keeps the newest four per document. A
-- quiz's content and keys documents are two documents. They hold ids only, no
-- content; only the collaboration server reads and writes them, and like the
-- rest of a material's Yjs history they are not charged to storage.
CREATE TABLE material_yjs_windows (
  material_id    text NOT NULL REFERENCES material_yjs_documents(material_id) ON DELETE CASCADE,
  document       text NOT NULL CHECK (document IN ('content', 'keys')),
  stored_version bigint NOT NULL,
  state_vector   bytea NOT NULL,
  delete_set     bytea NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (material_id, document, stored_version)
);
