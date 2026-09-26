-- TEMPLATE, not a migration: this folder is outside the embedded *.sql set.
--
-- The Office maintenance window's reset (human/frontend/office-files.md, the
-- engine upgrade window; openwiki/deployment-runbook.md, "Office maintenance
-- window"). The window's pin bump copies it to the next numbered migration and
-- fills the placeholder:
--   {{FORMATS}}  formats whose golden seeds changed, e.g. 'docx','xlsx','pptx'
-- Written for the NULL-state model the window ships with: a NULL state is
-- seed(base), a NULL indexed_baseline is derived from the base, and
-- storage_bytes counts a NULL column as 0. Checked once against that schema.
--
-- The deploy runs it only after `office-maintenance status` prints zero:
-- editing paused, no Office source with unpublished edits, no source_refresh,
-- parse or ingest job in flight. The guard below is the only protection: no
-- dropped state is kept, so it refuses while editing is live or any file of
-- the reset formats is unpublished or has a refresh in flight, under a lock
-- that holds writers off until the migration's transaction ends (the pattern
-- of 0015_source_semantic_baseline.sql). A fresh database has no rows and
-- passes. A file that cannot publish keeps the pause on until an operator
-- fixes it on the old engine; no engine ever holds another engine's state.
LOCK TABLE source_documents IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM source_documents WHERE format IN ({{FORMATS}})
      AND (checkpoint > indexed_checkpoint OR pending_effects <> '[]'::jsonb OR running_job_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Office reset refused: unpublished edits or a refresh in flight; run office-maintenance publish-all until status prints zero';
  END IF;
  IF EXISTS (SELECT 1 FROM source_documents WHERE format IN ({{FORMATS}}))
      AND NOT EXISTS (SELECT 1 FROM office_editing_pause) THEN
    RAISE EXCEPTION 'Office reset refused: Office editing is not paused; run office-maintenance pause first';
  END IF;
END $$;

-- One statement: release AI edit Undo tied to the old engine's identities,
-- delete refresh candidates, then bump the epoch (old rooms and tabs can no
-- longer write), drop the state and stored baseline (rooms reseed on the new
-- engine) and empty pending effects.
WITH dropped AS (
  SELECT file_id FROM source_documents WHERE format IN ({{FORMATS}})
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
SET epoch = d.epoch + 1, state = NULL, indexed_baseline = NULL, pending_effects = '[]'::jsonb,
    net_tokens = 0, running_job_id = NULL, desired_checkpoint = NULL, desired_manual = false,
    refresh_error = NULL, updated_at = now()
FROM dropped
WHERE d.file_id = dropped.file_id;
