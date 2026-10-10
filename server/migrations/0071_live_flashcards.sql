-- Live flashcard sets (live-items, Epo 2026-10-09/10): a set's Yjs document
-- is now the items shape (root `cards`: card id -> order, front, back,
-- image), no longer a Plate document. No compatibility: the old rows go and
-- each set bootstraps again from materials.content, whose shape is
-- unchanged, on its next open. Agent Undo records over the old shape go too.
UPDATE agent_edit_inverses
  SET undo_status = 'unavailable', undo_reason = 'compacted', inverse = '[]'::jsonb,
      guards = '[]'::jsonb, inverse_bytes = 0, updated_at = now()
  WHERE resource_kind = 'material' AND undo_status = 'available'
    AND resource_id IN (SELECT id FROM materials WHERE kind = 'flashcards');

DELETE FROM material_yjs_documents
  WHERE material_id IN (SELECT id FROM materials WHERE kind = 'flashcards');
