-- A canvas is charged for its board (Epo 2026-11-18, decisions 2 and 3): its
-- content JSON plus the Yjs bytes its room has stored (the folded state and the
-- update log), to its creator like any material's size_bytes
-- (account_material_storage), under Canvas on Billing. This trigger runs on
-- each content write, so the charge is the board's stored bytes as of its last
-- projection; a fold between projections is not charged again. Every other
-- kind keeps its content's length. The rest is unchanged from 0095.
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
  IF NEW.kind = 'canvas' THEN
    NEW.size_bytes = NEW.size_bytes + COALESCE((
      SELECT octet_length(d.state) + d.log_bytes
      FROM material_yjs_documents d WHERE d.material_id = NEW.id
    ), 0);
  END IF;
  RETURN NEW;
END;
$$;
