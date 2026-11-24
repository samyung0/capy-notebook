-- A deleted, deletion-pending or suspended owner's workspaces and everything
-- in them answer not found to everyone (openwiki/authorization-permissions-
-- lifecycles.md), so becoming locked now also discards the rooms of every
-- material in the workspaces they own, as 0090 does for those workspaces'
-- source files: notes, quizzes and sets other members made (and pay for), and
-- canvases drawn there. Before this only the materials the owner pays for
-- (owner_user_id) were evicted, so the rest kept their rooms open, writers
-- until their next access recheck and readers until they left.
-- The rest is unchanged from 0152.
CREATE OR REPLACE FUNCTION user_acl_eviction_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_user_id text := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  eviction_mode text := 'discard';
  material_event_type text := 'access-changed';
  eviction_id text := 'cev_' || substr(md5(
    random()::text || clock_timestamp()::text || target_user_id
  ), 1, 24);
  material_row record;
BEGIN
  IF TG_OP='UPDATE'
    AND NEW.deleted_at IS NULL
    AND NEW.deletion_requested_at IS NULL
    AND NEW.suspended_at IS NULL
  THEN
    IF ((CASE OLD.plan_tier WHEN 'free' THEN 0 WHEN 'pro' THEN 1 END)
        <= (CASE NEW.plan_tier WHEN 'free' THEN 0 WHEN 'pro' THEN 1 END)
      AND (CASE OLD.subscription_status
        WHEN 'none' THEN 0 WHEN 'canceled' THEN 0
        WHEN 'past_due' THEN 1 WHEN 'trialing' THEN 1 WHEN 'active' THEN 1
        ELSE -1
      END) <= (CASE NEW.subscription_status
        WHEN 'none' THEN 0 WHEN 'canceled' THEN 0
        WHEN 'past_due' THEN 1 WHEN 'trialing' THEN 1 WHEN 'active' THEN 1
        ELSE -1
      END)) IS NOT TRUE
    THEN
      RETURN NEW;
    END IF;
    eviction_mode := 'drain';
    material_event_type := 'account-access-restored';
  END IF;
  INSERT INTO collaboration_eviction_outbox (id, channel, payload)
  VALUES (
    eviction_id,
    'capy:collaboration:user-evict',
    jsonb_build_object(
      'evictionId', eviction_id,
      'mode', eviction_mode,
      'type', 'account-access-changed',
      'userId', target_user_id
    )
  );
  FOR material_row IN
    SELECT id FROM materials WHERE owner_user_id=target_user_id
  LOOP
    PERFORM enqueue_material_collaboration_eviction(
      material_row.id, material_event_type, eviction_mode
    );
  END LOOP;
  -- A deleted, deletion-pending or suspended owner's workspaces are not found
  -- for everyone else: discard the rooms of what others made in them (the
  -- owner's own went above) and of their source files, so open viewers
  -- reconnect through the access check.
  IF TG_OP='DELETE' OR NEW.deleted_at IS NOT NULL
    OR NEW.deletion_requested_at IS NOT NULL OR NEW.suspended_at IS NOT NULL
  THEN
    FOR material_row IN
      SELECT m.id FROM materials m JOIN workspaces w ON w.id=m.workspace_id
      WHERE w.user_id=target_user_id AND m.owner_user_id<>target_user_id
      UNION
      SELECT m.id FROM materials m JOIN workspaces w ON w.id=m.canvas_workspace_id
      WHERE m.kind='canvas' AND w.user_id=target_user_id
        AND m.owner_user_id<>target_user_id
    LOOP
      PERFORM enqueue_material_collaboration_eviction(
        material_row.id, 'access-changed', 'discard'
      );
    END LOOP;
    FOR material_row IN
      SELECT f.id FROM files f JOIN workspaces w ON w.id=f.workspace_id
      WHERE w.user_id=target_user_id
      UNION ALL
      SELECT f.id FROM files f WHERE f.workspace_id IS NULL AND f.user_id=target_user_id
    LOOP
      PERFORM enqueue_source_collaboration_eviction(material_row.id, 'discard');
    END LOOP;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
