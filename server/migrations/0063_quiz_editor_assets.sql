-- A workspace quiz's images follow the quiz (human/question-bank.md,
-- 2026-10-06): their rows name the quiz as well as the workspace, so purging
-- the quiz deletes them through the material_id cascade and a quiz save can
-- delete the images it no longer uses. The workspace still owns and pays for
-- them. Notes keep workspace-only assets.
ALTER TABLE editor_assets
  DROP CONSTRAINT editor_assets_exactly_one_owner_check,
  ADD CONSTRAINT editor_assets_owner_check CHECK (
    workspace_id IS NOT NULL OR material_id IS NOT NULL
  );

ALTER TABLE upload_sessions
  DROP CONSTRAINT upload_sessions_scope_check,
  ADD CONSTRAINT upload_sessions_scope_check CHECK (
    CASE WHEN target = 'editor_asset'
      THEN workspace_id IS NOT NULL OR material_id IS NOT NULL
      ELSE workspace_id IS NOT NULL AND material_id IS NULL
    END);
