-- Yjs client ids the collaboration server assigned (Epo 2026-10-23, Q213,
-- openwiki/frontend/plate-editor.md "Client ids"): a Y.Doc takes the id its
-- first write join's token offers and keeps it, the server stores here which
-- user it was assigned to at that join (one row per Y.Doc, keyed by document
-- and id, so later per-session bookkeeping extends these rows), and a room
-- admits document changes under an id only from that user (stored drafts of
-- earlier sessions included). A quiz's content and keys documents are two
-- documents. Only the collaboration server reads and writes these rows;
-- readers never learn them.
CREATE TABLE material_yjs_client_ids (
  material_id text NOT NULL REFERENCES material_yjs_documents(material_id) ON DELETE CASCADE,
  document    text NOT NULL CHECK (document IN ('content', 'keys')),
  client_id   bigint NOT NULL CHECK (client_id BETWEEN 1 AND 4294967295),
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (material_id, document, client_id)
);

CREATE TABLE source_document_client_ids (
  file_id    text NOT NULL REFERENCES source_documents(file_id) ON DELETE CASCADE,
  client_id  bigint NOT NULL CHECK (client_id BETWEEN 1 AND 4294967295),
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, client_id)
);
