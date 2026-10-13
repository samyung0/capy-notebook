-- The Rust collaboration cutover's reset (DEPLOY-CHECKLIST "Reset UAT
-- collaboration states"; openwiki/deployment-runbook.md, "Rust collaboration
-- cutover reset"). States stored before the cutover keep base64 user ids as
-- deleted map keys in their Yjs history, their saved rows hold user ids
-- (source clones copy them), and a note's Yjs state may hold a pending quiz
-- reference, which the Rust server neither cleans on load nor stores. So every
-- live collaboration state goes: notes, mindmaps and diagrams re-seed from
-- materials.content, Office and text sources from their published bytes.
-- Live flashcard and quiz rooms stay: 0076/0077 dropped every older one and
-- only the Rust server writes them since, so none predates the cutover.
--
-- Built from templates/office_window_reset.sql, for every source format: text
-- edits publish only through auto-process or the owner's Process, never
-- through office-maintenance publish-all, so the guard refuses them too. No
-- dropped state is kept, so the guard is the only protection: it refuses while
-- any source is unpublished, has a refresh in flight or waits for its rebuild,
-- while Office editing is not paused, or while a note's projection is behind
-- its stored Yjs state (materials.content would miss those edits), under
-- locks that hold writers off until the transaction ends. A fresh database
-- has no rows and passes.
LOCK TABLE source_documents, material_yjs_documents IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM source_documents
      WHERE checkpoint > indexed_checkpoint OR pending_effects <> '[]'::jsonb OR running_job_id IS NOT NULL OR rebuild_pending) THEN
    RAISE EXCEPTION 'Cutover reset refused: a source has unpublished edits, a refresh in flight or a rebuild pending; run office-maintenance publish-all until status prints zero and publish every listed text source';
  END IF;
  IF EXISTS (SELECT 1 FROM source_documents WHERE format <> 'text')
      AND NOT EXISTS (SELECT 1 FROM office_editing_pause) THEN
    RAISE EXCEPTION 'Cutover reset refused: Office editing is not paused; run office-maintenance pause first';
  END IF;
  IF EXISTS (SELECT 1 FROM material_yjs_documents d JOIN materials m ON m.id = d.material_id
      WHERE m.kind IN ('note','mindmap','diagram') AND d.projected_version < d.stored_version) THEN
    RAISE EXCEPTION 'Cutover reset refused: a note''s projection is behind its stored Yjs state; wait for the projection or fix its projection_error';
  END IF;
END $$;

-- Sources, as the template: release AI edit Undo tied to the old identities,
-- delete refresh candidates and saved rows, then bump the epoch (old rooms,
-- tabs and browser drafts can no longer write), drop the state (rooms re-seed
-- from the base, the published bytes) and empty pending effects.
WITH dropped AS (
  SELECT file_id FROM source_documents
), released AS (
  UPDATE agent_edit_inverses i
  SET undo_status = 'unavailable', undo_reason = 'source_rebased', inverse = '[]'::jsonb,
      guards = '[]'::jsonb, inverse_bytes = 0, updated_at = now()
  FROM dropped
  WHERE i.resource_kind = 'source_file' AND i.resource_id = dropped.file_id
    AND i.undo_status = 'available'
), candidates AS (
  DELETE FROM source_refresh_candidates c USING dropped WHERE c.file_id = dropped.file_id
), saved_rows AS (
  DELETE FROM source_document_updates u USING dropped WHERE u.file_id = dropped.file_id
)
UPDATE source_documents d
SET epoch = d.epoch + 1, state = NULL, state_seed_sha256 = NULL, seed_bytes = 0, log_bytes = 0, log_rows = 0,
    pending_effects = '[]'::jsonb,
    net_tokens = 0, running_job_id = NULL, desired_checkpoint = NULL, desired_manual = false,
    refresh_error = NULL, updated_at = now()
FROM dropped
WHERE d.file_id = dropped.file_id;

-- Notes, mindmaps and diagrams, as a lineage compaction does but without the
-- state: release their AI edit Undo (fresh item identities; comment anchors
-- fall back to their block and quote), then delete the Yjs row with its log so
-- the next open, agent edit or command bootstraps it from materials.content. A
-- material with no Yjs row names its room schema 1 + trash_restores
-- (store.MaterialRoom), so raising trash_restores to the dropped room_schema
-- moves every room name past the old one: old tokens and browser drafts of the
-- old lineage open copy-only recovery instead of merging into the new state.
UPDATE agent_edit_inverses i
SET undo_status = 'unavailable', undo_reason = 'compacted', inverse = '[]'::jsonb,
    guards = '[]'::jsonb, inverse_bytes = 0, updated_at = now()
FROM material_yjs_documents d JOIN materials m ON m.id = d.material_id
WHERE m.kind IN ('note','mindmap','diagram')
  AND i.resource_kind = 'material' AND i.resource_id = d.material_id AND i.undo_status = 'available';

UPDATE materials m SET trash_restores = GREATEST(m.trash_restores, d.room_schema)
FROM material_yjs_documents d
WHERE d.material_id = m.id AND m.kind IN ('note','mindmap','diagram');

DELETE FROM material_yjs_documents d USING materials m
WHERE m.id = d.material_id AND m.kind IN ('note','mindmap','diagram');

-- A note stored before fences were resolved ahead of insertion may hold a
-- pending reference (its body the quiz's answer keys). Writes refuse them, so
-- this is the last place one can live: each becomes an empty paragraph with
-- its id, as materialdoc.DropPendingRefs and the room's bootstrap do.
UPDATE materials m
SET content = jsonb_set(m.content, '{value}', stripped.value), revision = m.revision + 1
FROM (
  SELECT e.id,
    jsonb_agg(CASE WHEN e.pending
      THEN jsonb_build_object('type', 'p', 'id', e.node->'id', 'children', jsonb_build_array(jsonb_build_object('text', '')))
      ELSE e.node END ORDER BY e.at) AS value,
    bool_or(e.pending) AS pending
  FROM (
    SELECT n.id, b.node, b.at,
      COALESCE(b.node->>'type' = 'material_ref', false)
        AND (b.node ? 'pending' OR jsonb_typeof(b.node->'materialId') IS DISTINCT FROM 'string'
             OR b.node->>'materialId' !~ '\S') AS pending
    FROM materials n, jsonb_array_elements(n.content->'value') WITH ORDINALITY AS b(node, at)
    WHERE n.kind = 'note'
  ) e
  GROUP BY e.id
) stripped
WHERE m.id = stripped.id AND stripped.pending;
