-- Uploader pays (Sam 2026-10-18): a file, editor asset, upload reservation or
-- material is charged to the account that uploads or creates it (its
-- created_by), never derived from the workspace owner, and the payer is set
-- once at insert: a workspace changing hands or a material moving moves no
-- charges. Existing rows keep their payer.
DROP TRIGGER IF EXISTS files_storage_owner_before ON files;
DROP TRIGGER IF EXISTS upload_sessions_storage_owner_before ON upload_sessions;
DROP TRIGGER IF EXISTS editor_assets_storage_owner_before ON editor_assets;
DROP FUNCTION IF EXISTS set_file_storage_owner();
DROP FUNCTION IF EXISTS set_upload_storage_owner();
DROP FUNCTION IF EXISTS set_editor_asset_storage_owner();

CREATE OR REPLACE FUNCTION set_uploader_payer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.user_id = COALESCE(NEW.user_id, NEW.created_by);
  RETURN NEW;
END;
$$;
CREATE TRIGGER files_payer_before BEFORE INSERT ON files
FOR EACH ROW EXECUTE FUNCTION set_uploader_payer();
CREATE TRIGGER upload_sessions_payer_before BEFORE INSERT ON upload_sessions
FOR EACH ROW EXECUTE FUNCTION set_uploader_payer();
CREATE TRIGGER editor_assets_payer_before BEFORE INSERT ON editor_assets
FOR EACH ROW EXECUTE FUNCTION set_uploader_payer();

CREATE OR REPLACE FUNCTION prepare_material_storage_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.owner_user_id = COALESCE(NEW.owner_user_id, NEW.created_by);
  END IF;
  -- Visibility belongs to the workspace: a material filed in one cannot carry
  -- a standalone public/link policy into it.
  IF NEW.workspace_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
    NEW.privacy = 'private';
  END IF;
  NEW.size_bytes = octet_length(NEW.content::text);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION set_uploader_payer() FROM PUBLIC;
