-- A note's editing sessions (in-place Yjs collection, step 1; Epo 2026-10-23;
-- openwiki/backend-storage-quota.md "Yjs storage growth"): a session is one
-- editor's Y.Doc, named by its client id, so its state extends that id's
-- row. The collaboration server writes these columns with the stores of a
-- note's content document: the stored version the session last
-- acknowledged, when it was last seen (NULL: no session, or it ended), and
-- the deletions its own updates made that an Undo may still restore, each
-- with its arrival time (Yjs delete sets; released 25 h after arrival). A
-- session counts while connected and for 24 h after it was last seen.
ALTER TABLE material_yjs_client_ids
  ADD COLUMN acked_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN seen_at timestamptz,
  ADD COLUMN held bytea;

-- The deletions of agent steps whose Undo or Redo may still bring them back
-- (review r1 M3), in the same encoding as `held`, each batch released 24 h
-- after it arrived. NULL: none.
ALTER TABLE material_yjs_documents ADD COLUMN agent_held bytea;
