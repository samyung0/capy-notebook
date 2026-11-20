-- Hiding an item from members (0140) and sharing a canvas with its workspace
-- (0182) change who sees it in the workspace's lists, so both raise the
-- workspace's tree event as any other list-visible write does (0004): every
-- member's page reads its lists again, and an item hidden from them, or shown
-- again, leaves them or joins them. The column lists are 0125's (files) and
-- 0004's (materials, chapter_id renamed topic_id by 0136) plus `hidden`.
DROP TRIGGER files_tree_notify_after ON files;
CREATE TRIGGER files_tree_notify_after
AFTER INSERT OR DELETE OR UPDATE OF workspace_id, topic_id, position, name, kind, size_bytes,
  status, indexed, blob_path, revision, trashed_at, thumbnail_key, preview, hidden ON files
FOR EACH ROW EXECUTE FUNCTION notify_workspace_tree('files');

DROP TRIGGER materials_tree_notify_after ON materials;
CREATE TRIGGER materials_tree_notify_after
AFTER INSERT OR DELETE OR UPDATE OF workspace_id, topic_id, position, title, kind, trashed_at, hidden ON materials
FOR EACH ROW EXECUTE FUNCTION notify_workspace_tree('materials');

-- A canvas sits in no workspace (workspace_id is NULL, 0164), so the trigger
-- above skips it; it is listed in the workspace it names, canvas_workspace_id.
-- Its list-visible writes (made, renamed, shared or taken back, trashed or
-- restored, deleted with a leaver) raise a `materials` event there.
CREATE FUNCTION notify_canvas_tree() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ws text;
BEGIN
  IF TG_OP = 'DELETE' THEN ws := OLD.canvas_workspace_id; ELSE ws := NEW.canvas_workspace_id; END IF;
  IF ws IS NOT NULL THEN
    PERFORM pg_notify('workspace_tree', ws || ':materials');
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION notify_canvas_tree() FROM PUBLIC;

CREATE TRIGGER materials_canvas_tree_notify_after
AFTER INSERT OR DELETE OR UPDATE OF title, canvas_shared, trashed_at ON materials
FOR EACH ROW EXECUTE FUNCTION notify_canvas_tree();
