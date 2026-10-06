-- DOCX seeds now keep paragraph properties the model doesn't hold, more frame
-- attributes, and deleted text inside fields and links. Run the Office
-- maintenance window before deployment; the template guards retained edits.
LOCK TABLE source_documents IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM source_documents WHERE format IN ('docx')
      AND (checkpoint > indexed_checkpoint OR pending_effects <> '[]'::jsonb OR running_job_id IS NOT NULL OR rebuild_pending)) THEN
    RAISE EXCEPTION 'Office reset refused: unpublished edits, a refresh in flight or a rebuild pending; run office-maintenance publish-all until status prints zero';
  END IF;
  IF EXISTS (SELECT 1 FROM source_documents WHERE format IN ('docx'))
      AND NOT EXISTS (SELECT 1 FROM office_editing_pause) THEN
    RAISE EXCEPTION 'Office reset refused: Office editing is not paused; run office-maintenance pause first';
  END IF;
END $$;

-- One statement: release AI edit Undo tied to the old engine's identities,
-- delete refresh candidates, then bump the epoch (old rooms and tabs can no
-- longer write), drop the state (rooms reseed on the new engine) and empty
-- pending effects.
WITH dropped AS (
  SELECT file_id FROM source_documents WHERE format IN ('docx')
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
SET epoch = d.epoch + 1, state = NULL, state_seed_sha256 = NULL, seed_bytes = 0, pending_effects = '[]'::jsonb,
    net_tokens = 0, running_job_id = NULL, desired_checkpoint = NULL, desired_manual = false,
    refresh_error = NULL, updated_at = now()
FROM dropped
WHERE d.file_id = dropped.file_id;
