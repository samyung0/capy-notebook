-- The 2026-09 Office maintenance window's reset, from
-- templates/office_window_reset.sql: the upstream merge and the storage changes
-- changed the golden seeds of DOCX, XLSX and PPTX, so every Office room reseeds
-- on the new engine (human/frontend/office-files.md, the engine upgrade window;
-- openwiki/deployment-runbook.md, "Office maintenance window"). It refuses
-- unless Office editing is paused and nothing is unpublished or in flight.
LOCK TABLE source_documents IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM source_documents WHERE format IN ('docx','xlsx','pptx')
      AND (checkpoint > indexed_checkpoint OR pending_effects <> '[]'::jsonb OR running_job_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Office reset refused: unpublished edits or a refresh in flight; run office-maintenance publish-all until status prints zero';
  END IF;
  IF EXISTS (SELECT 1 FROM source_documents WHERE format IN ('docx','xlsx','pptx'))
      AND NOT EXISTS (SELECT 1 FROM office_editing_pause) THEN
    RAISE EXCEPTION 'Office reset refused: Office editing is not paused; run office-maintenance pause first';
  END IF;
END $$;

-- One statement: release AI edit Undo tied to the old engine's identities,
-- delete refresh candidates, then bump the epoch (old rooms and tabs can no
-- longer write), drop the state and stored baseline (rooms reseed on the new
-- engine) and empty pending effects.
WITH dropped AS (
  SELECT file_id FROM source_documents WHERE format IN ('docx','xlsx','pptx')
), released AS (
  UPDATE agent_edit_inverses i
  SET undo_status = 'unavailable', undo_reason = 'source_rebased', inverse = '[]'::jsonb,
      guards = '[]'::jsonb, inverse_bytes = 0, updated_at = now()
  FROM dropped
  WHERE i.resource_kind = 'source_file' AND i.resource_id = dropped.file_id
    AND i.undo_status = 'available'
), candidates AS (
  DELETE FROM source_refresh_candidates c USING dropped WHERE c.file_id = dropped.file_id
)
UPDATE source_documents d
SET epoch = d.epoch + 1, state = NULL, seed_bytes = 0, indexed_baseline = NULL, pending_effects = '[]'::jsonb,
    net_tokens = 0, running_job_id = NULL, desired_checkpoint = NULL, desired_manual = false,
    refresh_error = NULL, updated_at = now()
FROM dropped
WHERE d.file_id = dropped.file_id;
