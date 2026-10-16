-- A user who becomes deleted, deletion-pending or suspended also has the source
-- (Office and text file) rooms of the workspaces they own evicted with discard,
-- as their material rooms already were: that owner's content is not found for
-- everyone else. The rest of the trigger is unchanged from 0001.
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
    AND (CASE OLD.plan_tier WHEN 'free' THEN 0 WHEN 'pro' THEN 1 END)
      <= (CASE NEW.plan_tier WHEN 'free' THEN 0 WHEN 'pro' THEN 1 END)
    AND (CASE OLD.subscription_status
      WHEN 'none' THEN 0 WHEN 'canceled' THEN 0
      WHEN 'past_due' THEN 1 WHEN 'trialing' THEN 1 WHEN 'active' THEN 1
      ELSE -1
    END) <= (CASE NEW.subscription_status
      WHEN 'none' THEN 0 WHEN 'canceled' THEN 0
      WHEN 'past_due' THEN 1 WHEN 'trialing' THEN 1 WHEN 'active' THEN 1
      ELSE -1
    END)
  THEN
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
  -- A deleted, deletion-pending or suspended owner's source rooms are not
  -- found for everyone else, like their material rooms: discard them so open
  -- viewers reconnect through the access check.
  IF TG_OP='DELETE' OR NEW.deleted_at IS NOT NULL
    OR NEW.deletion_requested_at IS NOT NULL OR NEW.suspended_at IS NOT NULL
  THEN
    FOR material_row IN
      SELECT f.id FROM files f JOIN workspaces w ON w.id=f.workspace_id
      WHERE w.user_id=target_user_id
    LOOP
      PERFORM enqueue_source_collaboration_eviction(material_row.id, 'discard');
    END LOOP;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
