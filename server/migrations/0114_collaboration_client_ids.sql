-- Yjs client ids the collaboration server assigned (Epo 2026-10-23, Q213;
-- Q236; openwiki/frontend/plate-editor.md "Client ids"): a session's join
-- binds the id its token offers (a reconnect's token offers its previous
-- id again), the server records here which user an id belongs to at the
-- first accepted write under it (one row per id, keyed by document; the
-- account purge deletes a user's rows), and a room admits document changes
-- under an id only from that user (stored drafts of earlier sessions
-- included). A quiz's content and keys documents are two
-- documents. Only the collaboration server reads and writes these rows;
-- readers never learn them.
CREATE TABLE material_yjs_client_ids (
  material_id text NOT NULL REFERENCES material_yjs_documents(material_id) ON DELETE CASCADE,
  document    text NOT NULL CHECK (document IN ('content', 'keys')),
  client_id   bigint NOT NULL CHECK (client_id BETWEEN 1 AND 4294967295),
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- A room's first write under the id refreshes it; a room load clears rows
  -- unwritten for 7 days (Q226 M3) and rows a clean Leave expired (Q236).
  last_write_at timestamptz NOT NULL DEFAULT now(),
  expired     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (material_id, document, client_id)
);
-- The account purge deletes a user's rows (Q226).
CREATE INDEX material_yjs_client_ids_user_idx ON material_yjs_client_ids (user_id);

CREATE TABLE source_document_client_ids (
  file_id    text NOT NULL REFERENCES source_documents(file_id) ON DELETE CASCADE,
  client_id  bigint NOT NULL CHECK (client_id BETWEEN 1 AND 4294967295),
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_write_at timestamptz NOT NULL DEFAULT now(),
  expired    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (file_id, client_id)
);
CREATE INDEX source_document_client_ids_user_idx ON source_document_client_ids (user_id);
