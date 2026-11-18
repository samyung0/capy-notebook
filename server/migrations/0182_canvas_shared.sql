-- A canvas shared with its workspace (Epo 2026-11-18, decision 1): the row
-- stays a standalone material linked by canvas_workspace_id, and this flag says
-- the workspace's members hold it by their workspace role (owners and editors
-- draw, viewers watch). A canvas of one's own, in no workspace, is never
-- shared. Go's materialAccessRow.role and the collaboration server's
-- access::live_role read it.
ALTER TABLE materials ADD COLUMN canvas_shared boolean NOT NULL DEFAULT false;
ALTER TABLE materials ADD CONSTRAINT materials_canvas_shared_check
  CHECK (NOT canvas_shared OR (kind = 'canvas' AND canvas_workspace_id IS NOT NULL));

-- A workspace's canvases are read by its id: its Canvas tab's list and the
-- evictions below.
CREATE INDEX materials_canvas_workspace_idx ON materials (canvas_workspace_id)
  WHERE canvas_workspace_id IS NOT NULL;

-- Unsharing takes the canvas from the other members: `revoke`, so the room
-- stays loaded, its creator stays joined and only the channels whose role no
-- longer covers them close (0152). Sharing widens and queues nothing.
CREATE FUNCTION canvas_unshared_eviction_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM enqueue_material_collaboration_eviction(NEW.id, 'access-changed', 'revoke');
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION canvas_unshared_eviction_trigger() FROM PUBLIC;

CREATE TRIGGER materials_canvas_unshared_eviction
AFTER UPDATE OF canvas_shared ON materials
FOR EACH ROW
WHEN (OLD.canvas_shared AND NOT NEW.canvas_shared)
EXECUTE FUNCTION canvas_unshared_eviction_trigger();

-- A canvas follows its workspace's roles while it sits in none (workspace_id is
-- NULL), so a membership, role or sharing change there rechecks its channels
-- too. The rest is unchanged from 0001.
CREATE OR REPLACE FUNCTION enqueue_workspace_collaboration_evictions(
  target_workspace_id text,
  eviction_mode text DEFAULT 'discard'
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  material_row record;
BEGIN
  FOR material_row IN
    SELECT id FROM materials WHERE workspace_id=target_workspace_id
    UNION ALL
    SELECT id FROM materials WHERE kind='canvas' AND canvas_workspace_id=target_workspace_id
  LOOP
    PERFORM enqueue_material_collaboration_eviction(
      material_row.id, 'access-changed', eviction_mode
    );
  END LOOP;
  FOR material_row IN SELECT id FROM files WHERE workspace_id=target_workspace_id LOOP
    PERFORM enqueue_source_collaboration_eviction(material_row.id,eviction_mode);
  END LOOP;
END;
$$;
