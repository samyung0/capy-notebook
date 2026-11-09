-- People who did nothing wrong no longer see a room close when access changes
-- (Epo 2026-11-05, Q634):
--   * Access widened (a member added, a role raised, sharing widened): nothing
--     is queued. Whoever gained something picks it up at their next reload.
--   * Access narrowed (a member removed, a role lowered, sharing narrowed,
--     ownership transferred): `revoke`. The room stays loaded; each collaboration
--     server checks the people connected to it and closes, with 4403 and no
--     notice, only those whose role no longer covers what they hold.
--   * A lowered plan or a lapsed subscription: nothing is queued. Frozen and the
--     storage limit are enforced at admission, so a writer the lapse narrows
--     hears room-read-only at its next update, as at the storage limit.
-- A locked account, a trashed, deleted or moved item and everything else keep
-- their discard or drain.

CREATE OR REPLACE FUNCTION enqueue_material_collaboration_eviction(
  target_material_id text,
  event_type text DEFAULT 'access-changed',
  eviction_mode text DEFAULT 'discard'
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  eviction_id text := 'cev_' || substr(md5(
    random()::text || clock_timestamp()::text || target_material_id
  ), 1, 24);
  room_schema int;
  room_name text;
BEGIN
  IF eviction_mode NOT IN ('discard', 'drain', 'revoke') THEN
    RAISE EXCEPTION 'invalid collaboration eviction mode %', eviction_mode;
  END IF;
  -- A never-bootstrapped material lives at schema 1 + its restore count, so
  -- the room name here matches store.MaterialRoom after a trash/restore cycle.
  SELECT COALESCE(d.room_schema, 1 + m.trash_restores) INTO room_schema
  FROM materials m
  LEFT JOIN material_yjs_documents d ON d.material_id=m.id
  WHERE m.id=target_material_id;
  room_name := 'material:' || target_material_id || ':schema:' || COALESCE(room_schema, 1)::text;
  INSERT INTO collaboration_eviction_outbox (id, channel, payload)
  VALUES (
    eviction_id,
    'capy:collaboration:evict',
    jsonb_build_object(
      'evictionId', eviction_id,
      'materialId', target_material_id,
      'mode', eviction_mode,
      'room', room_name,
      'type', event_type
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION material_acl_eviction_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  eviction_mode text := 'discard';
BEGIN
  -- Deleted, just trashed or moved to another workspace: discard, as ever.
  IF TG_OP='UPDATE'
    AND OLD.workspace_id IS NOT DISTINCT FROM NEW.workspace_id
    AND (OLD.trashed_at IS NOT NULL OR NEW.trashed_at IS NULL)
  THEN
    IF OLD.owner_user_id=NEW.owner_user_id
      AND (
        (OLD.privacy='private' AND NEW.privacy IN ('link','public'))
        OR (OLD.privacy='link' AND NEW.privacy='public')
      )
    THEN
      RETURN NEW;
    END IF;
    eviction_mode := 'revoke';
  END IF;
  PERFORM enqueue_material_collaboration_eviction(
    CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END,
    'access-changed',
    eviction_mode
  );
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION workspace_acl_eviction_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.user_id=NEW.user_id
    AND (
      -- A private workspace has no nonmember grant, so its dormant share role
      -- takes nothing from anyone, whatever a privacy widening sets it to.
      OLD.privacy='private'
      OR (
        (CASE OLD.privacy
          WHEN 'private' THEN 0 WHEN 'link' THEN 1 WHEN 'public' THEN 2
        END) <= (CASE NEW.privacy
          WHEN 'private' THEN 0 WHEN 'link' THEN 1 WHEN 'public' THEN 2
        END)
        AND (CASE OLD.share_role
          WHEN 'viewer' THEN 0 WHEN 'editor' THEN 1
        END) <= (CASE NEW.share_role
          WHEN 'viewer' THEN 0 WHEN 'editor' THEN 1
        END)
      )
    )
  THEN
    RETURN NEW;
  END IF;
  PERFORM enqueue_workspace_collaboration_evictions(NEW.id, 'revoke');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION workspace_member_acl_eviction_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='INSERT' OR (
    TG_OP='UPDATE'
    AND (CASE OLD.role
      WHEN 'viewer' THEN 0 WHEN 'editor' THEN 1 WHEN 'owner' THEN 2
    END) <= (CASE NEW.role
      WHEN 'viewer' THEN 0 WHEN 'editor' THEN 1 WHEN 'owner' THEN 2
    END)
  )
  THEN
    RETURN NEW;
  END IF;
  PERFORM enqueue_workspace_collaboration_evictions(
    CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END,
    'revoke'
  );
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- The rest is unchanged from 0125.
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
  -- A deleted, deletion-pending or suspended owner's source rooms are not
  -- found for everyone else, like their material rooms: discard them so open
  -- viewers reconnect through the access check.
  IF TG_OP='DELETE' OR NEW.deleted_at IS NOT NULL
    OR NEW.deletion_requested_at IS NOT NULL OR NEW.suspended_at IS NOT NULL
  THEN
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
