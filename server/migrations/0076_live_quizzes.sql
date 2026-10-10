-- Live quizzes (live-items, Epo 2026-10-10): a quiz edits through two Yjs
-- documents, its content (which readers join too) and its keys (which only
-- editors with write access join), so answer keys never reach a reader. The
-- keys document keeps its own base and log beside the content's; every
-- append of either takes the next material_yjs_documents.stored_version, so
-- the projection's version works as before. A keys row exists exactly when
-- its quiz's content row does: both are created together, and deleting the
-- content row deletes it.
CREATE TABLE material_yjs_keys (
  material_id text PRIMARY KEY REFERENCES material_yjs_documents(material_id) ON DELETE CASCADE,
  state       bytea NOT NULL,
  log_bytes   bigint NOT NULL DEFAULT 0 CHECK (log_bytes >= 0),
  log_rows    integer NOT NULL DEFAULT 0 CHECK (log_rows >= 0)
);

CREATE TABLE material_yjs_key_updates (
  material_id text NOT NULL REFERENCES material_yjs_keys(material_id) ON DELETE CASCADE,
  -- The stored_version the row made.
  seq         bigint NOT NULL CHECK (seq > 0),
  update      bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (material_id, seq)
);

-- A quiz's Yjs rows held one Plate document. No compatibility: they go and
-- each quiz bootstraps both documents from materials.content, whose shape is
-- unchanged, on its next open. Agent Undo records over the old shape go too.
UPDATE agent_edit_inverses
  SET undo_status = 'unavailable', undo_reason = 'compacted', inverse = '[]'::jsonb,
      guards = '[]'::jsonb, inverse_bytes = 0, updated_at = now()
  WHERE resource_kind = 'material' AND undo_status = 'available'
    AND resource_id IN (SELECT id FROM materials WHERE kind = 'quiz');

DELETE FROM material_yjs_documents
  WHERE material_id IN (SELECT id FROM materials WHERE kind = 'quiz');
