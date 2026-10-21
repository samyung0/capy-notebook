-- The DOCX engine round changes every DOCX seed (no placeholder paragraph mark
-- per story), so Word rooms reset once on this deploy
-- (human/frontend/office-files.md, 2026-10-20 engine round).
-- Built from templates/office_window_reset.sql for 'docx' without the window's
-- guard: while Capy has no users, seed-changing pin bumps deploy without a
-- maintenance window and reset the rooms whose seed changed, dropping their
-- unpublished edits (2026-10-18). Work the window would have finished first is
-- settled here: a refresh captured under the old epoch is superseded, as an
-- epoch reset supersedes it, and a deferred publication's pending rebuild ends
-- as its rebuild of an empty state would, on the published bytes. The reset
-- rows end published: the NULL state is seed(base), which is what is indexed.
-- The collaboration server of the old engine must be stopped before this runs
-- (openwiki/deployment-runbook.md, "Seed-changing pins without a window").
LOCK TABLE source_documents IN SHARE ROW EXCLUSIVE MODE;

SELECT cancel_pipeline_jobs(
  ARRAY(SELECT c.job_id FROM source_refresh_candidates c JOIN source_documents d ON d.file_id = c.file_id
        WHERE d.format = 'docx'),
  'superseded', 'superseded', 'source_superseded', 'Editing moved to a new epoch');

-- The bases a pending rebuild leaves behind, whose cached artifacts go below
-- once nothing names them (RebuildSource's releaseArtifactCacheTx).
CREATE TEMP TABLE docx_rebuilt_bases ON COMMIT DROP AS
SELECT DISTINCT d.base_source_sha256 AS sha FROM source_documents d JOIN files f ON f.id = d.file_id
WHERE d.format = 'docx' AND d.rebuild_pending AND d.base_source_sha256 <> ''
  AND d.base_source_sha256 IS DISTINCT FROM f.source_sha256;

-- One statement: release AI edit Undo tied to the old engine's identities,
-- delete refresh candidates and saved rows, then bump the epoch (old rooms,
-- tabs and browser drafts can no longer write), drop the state (rooms reseed
-- on the new engine) and empty pending effects.
WITH dropped AS (
  SELECT file_id FROM source_documents WHERE format = 'docx'
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
SET epoch = d.epoch + 1, indexed_checkpoint = d.checkpoint, state = NULL, state_seed_sha256 = NULL, seed_bytes = 0, log_bytes = 0, log_rows = 0,
    pending_effects = '[]'::jsonb,
    net_tokens = 0, running_job_id = NULL, desired_checkpoint = NULL, desired_manual = false,
    refresh_error = NULL,
    base_blob_path = CASE WHEN d.rebuild_pending THEN f.blob_path ELSE d.base_blob_path END,
    base_source_sha256 = CASE WHEN d.rebuild_pending THEN f.source_sha256 ELSE d.base_source_sha256 END,
    rebuild_pending = false, rebuild_refusal = NULL, published_state = NULL, published_state_seed_sha256 = NULL,
    updated_at = now()
FROM dropped, files f
WHERE d.file_id = dropped.file_id AND f.id = d.file_id;

DELETE FROM artifact_cache a USING docx_rebuilt_bases r
WHERE a.source_sha256 = r.sha
  AND NOT EXISTS (SELECT 1 FROM files f WHERE f.source_sha256 = r.sha)
  AND NOT EXISTS (SELECT 1 FROM source_documents d WHERE d.base_source_sha256 = r.sha)
  AND NOT EXISTS (SELECT 1 FROM source_refresh_candidates c WHERE c.source_sha256 = r.sha);
