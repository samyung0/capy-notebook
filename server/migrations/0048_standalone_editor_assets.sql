-- Standalone materials (quizzes outside a workspace) upload editor assets for
-- question images (human/question-bank.md, 2026-10-02). Such an upload is
-- scoped to the material instead of a workspace and charged to the material
-- owner, matching editor_assets' existing workspace-or-material ownership.
ALTER TABLE upload_sessions
  ALTER COLUMN workspace_id DROP NOT NULL,
  ADD COLUMN material_id text REFERENCES materials(id) ON DELETE CASCADE,
  ADD CONSTRAINT upload_sessions_scope_check CHECK (
    CASE WHEN target = 'editor_asset'
      THEN (workspace_id IS NOT NULL) <> (material_id IS NOT NULL)
      ELSE workspace_id IS NOT NULL AND material_id IS NULL
    END);

-- Deleting a standalone asset row takes its reservation with it, exactly like
-- the (asset_id, workspace_id) key does for workspace uploads.
ALTER TABLE editor_assets
  ADD CONSTRAINT editor_assets_id_material_key UNIQUE (id, material_id);
ALTER TABLE upload_sessions
  ADD CONSTRAINT upload_sessions_asset_material_fkey
    FOREIGN KEY (asset_id, material_id)
    REFERENCES editor_assets(id, material_id) ON DELETE CASCADE;
CREATE INDEX upload_sessions_material_idx
  ON upload_sessions(material_id) WHERE material_id IS NOT NULL;

CREATE OR REPLACE FUNCTION set_upload_storage_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workspace_id IS NOT NULL THEN
    SELECT w.user_id INTO NEW.user_id
    FROM workspaces w
    WHERE w.id = NEW.workspace_id;
  ELSE
    SELECT m.owner_user_id INTO NEW.user_id
    FROM materials m
    WHERE m.id = NEW.material_id AND m.workspace_id IS NULL;
  END IF;
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'upload % has no storage owner', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS upload_sessions_storage_owner_before ON upload_sessions;
CREATE TRIGGER upload_sessions_storage_owner_before
BEFORE INSERT OR UPDATE OF workspace_id, material_id ON upload_sessions
FOR EACH ROW EXECUTE FUNCTION set_upload_storage_owner();
