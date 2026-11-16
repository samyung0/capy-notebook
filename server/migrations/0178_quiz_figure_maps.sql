-- Quiz figures held as maps (Epo 2026-11-16, D2, D3, D9; collaboration
-- client protocol 30; openwiki/deployment-runbook.md, "Quiz figure maps
-- reset"). A live quiz room now holds a chart, plot or graph as a map of its
-- fields, a graph's elements keyed by id; a room stored before holds each as
-- one plain value, which the room reads as no figure, so the next save would
-- store the question without it. There is no reader for the old layout (no
-- legacy data): every quiz's Yjs rows go, and each quiz seeds both documents
-- again from materials.content (whose shape is unchanged) on its next open,
-- agent edit or command (note_store.rs bootstrap).
--
-- As 0080 does for notes: AI edit Undo over the old rows is released, and
-- trash_restores rises to the dropped room_schema, so the new room's name
-- (1 + trash_restores, store.MaterialRoom) is past the old one; old tokens and
-- browser drafts of the old lineage open copy-only recovery. The deploy stops
-- collaboration before migrate, so no room writes meanwhile. Refused while a
-- quiz's projection is behind its stored Yjs state (materials.content would
-- miss those edits). A database with no quiz rooms passes.
LOCK TABLE material_yjs_documents IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM material_yjs_documents d JOIN materials m ON m.id = d.material_id
      WHERE m.kind = 'quiz' AND d.projected_version < d.stored_version) THEN
    RAISE EXCEPTION 'Quiz figure maps reset refused: a quiz''s projection is behind its stored Yjs state; wait for the projection or fix its projection_error (openwiki/deployment-runbook.md, "Quiz figure maps reset")';
  END IF;
END $$;

UPDATE agent_edit_inverses i
SET undo_status = 'unavailable', undo_reason = 'compacted', inverse = '[]'::jsonb,
    guards = '[]'::jsonb, inverse_bytes = 0, updated_at = now()
FROM material_yjs_documents d JOIN materials m ON m.id = d.material_id
WHERE m.kind = 'quiz'
  AND i.resource_kind = 'material' AND i.resource_id = d.material_id AND i.undo_status = 'available';

UPDATE materials m SET trash_restores = GREATEST(m.trash_restores, d.room_schema)
FROM material_yjs_documents d
WHERE d.material_id = m.id AND m.kind = 'quiz';

-- The keys row and both logs go with it (ON DELETE CASCADE).
DELETE FROM material_yjs_documents d USING materials m
WHERE m.id = d.material_id AND m.kind = 'quiz';
