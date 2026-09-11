-- Every writer of the workspace tree (gateway, pipeline, collaboration
-- projection, trash sweep) raises one NOTIFY per changed row; the gateway
-- LISTENs and fans "<workspaceId>:<files|materials>" out to the browser's
-- events stream, which refetches that list. Postgres collapses identical
-- payloads within a transaction, so a bulk clone or delete is one event.
-- The column lists name what the list endpoints return, so a checkpoint
-- rewriting materials.content stays silent.
CREATE OR REPLACE FUNCTION notify_workspace_tree() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ws text;
BEGIN
  IF TG_OP = 'DELETE' THEN ws := OLD.workspace_id; ELSE ws := NEW.workspace_id; END IF;
  IF ws IS NOT NULL THEN
    PERFORM pg_notify('workspace_tree', ws || ':' || TG_ARGV[0]);
  END IF;
  RETURN NULL;
END;
$$;
-- Functions default to PUBLIC execute; keep the Ops roles deny-by-default.
REVOKE EXECUTE ON FUNCTION notify_workspace_tree() FROM PUBLIC;

DROP TRIGGER IF EXISTS files_tree_notify_after ON files;
CREATE TRIGGER files_tree_notify_after
AFTER INSERT OR DELETE OR UPDATE OF chapter_id, position, name, kind, size_bytes,
  status, indexed, blob_path, preview_blob_path, revision, trashed_at ON files
FOR EACH ROW EXECUTE FUNCTION notify_workspace_tree('files');

DROP TRIGGER IF EXISTS materials_tree_notify_after ON materials;
CREATE TRIGGER materials_tree_notify_after
AFTER INSERT OR DELETE OR UPDATE OF workspace_id, chapter_id, position, title, kind, trashed_at ON materials
FOR EACH ROW EXECUTE FUNCTION notify_workspace_tree('materials');
