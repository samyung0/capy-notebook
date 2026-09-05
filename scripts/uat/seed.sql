\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '15s';
SELECT pg_advisory_xact_lock(hashtextextended('capy:uat:authorization:v1', 0));
CREATE TEMP TABLE uat_seed_input (payload jsonb) ON COMMIT DROP;
INSERT INTO uat_seed_input VALUES (:'seed'::jsonb);
CREATE TEMP TABLE uat_seed_actors ON COMMIT DROP AS
SELECT actor.* FROM uat_seed_input,
  jsonb_to_recordset(payload->'actors') AS actor(role text, id text, email text, name text);

DO $seed$
DECLARE
  owner_id text;
  fixture_ws constant text := 'ws_uat_authorization_v1';
  fixture_note constant text := 'note_uat_authorization_v1';
  initial_content constant jsonb := '{"schemaVersion":1,"value":[{"id":"uat-paragraph-v1","type":"p","children":[{"text":"Capy Notebook UAT authorization fixture."}]}]}';
  ws workspaces%ROWTYPE;
  note materials%ROWTYPE;
  created_note boolean := false;
BEGIN
  IF (SELECT count(*) FROM uat_seed_actors) <> 5
    OR (SELECT count(DISTINCT id) FROM uat_seed_actors) <> 5
    OR (SELECT array_agg(role ORDER BY role) FROM uat_seed_actors)
      IS DISTINCT FROM ARRAY['commenter','editor','other','owner','viewer']::text[]
    OR EXISTS (SELECT 1 FROM uat_seed_actors WHERE id IS NULL OR id !~ '^user_[A-Za-z0-9]+$'
      OR name IS NULL OR btrim(name) = ''
      OR email IS DISTINCT FROM 'capy-uat-' || role || '+clerk_test@stablestudio.org') THEN
    RAISE EXCEPTION 'UAT seed requires the five approved roles, distinct Clerk IDs and exact approved emails';
  END IF;
  SELECT id INTO STRICT owner_id FROM uat_seed_actors WHERE role = 'owner';
  IF EXISTS (SELECT 1 FROM users u JOIN uat_seed_actors a ON lower(u.email) = a.email WHERE u.id <> a.id) THEN
    RAISE EXCEPTION 'UAT seed email belongs to a different database identity';
  END IF;
  INSERT INTO users (id, email, name)
    SELECT id, email, name FROM uat_seed_actors ORDER BY id ON CONFLICT (id) DO NOTHING;
  INSERT INTO workspaces (id, user_id, name, privacy, share_role)
    VALUES (fixture_ws, owner_id, 'UAT authorization fixture', 'private', 'viewer')
    ON CONFLICT (id) DO NOTHING;
  SELECT * INTO STRICT ws FROM workspaces WHERE id = fixture_ws FOR UPDATE;
  -- Match ordinary workspace mutation lock order: workspace, then actor accounts.
  PERFORM u.id FROM users u JOIN uat_seed_actors a ON a.id = u.id ORDER BY u.id FOR UPDATE OF u;
  IF EXISTS (SELECT 1 FROM users u JOIN uat_seed_actors a ON a.id = u.id
    WHERE u.email IS DISTINCT FROM a.email OR u.deleted_at IS NOT NULL
      OR u.deletion_requested_at IS NOT NULL OR u.suspended_at IS NOT NULL
      OR u.identity_deleted_at IS NOT NULL OR u.identity_delete_pending OR u.session_revoke_pending) THEN
    RAISE EXCEPTION 'UAT seed actor email or active lifecycle does not match; no account was reset';
  END IF;
  IF ws.user_id <> owner_id OR ws.privacy <> 'private' OR ws.share_role <> 'viewer' THEN
    RAISE EXCEPTION 'UAT workspace ID collision or owner/privacy/share-role drift';
  END IF;
  IF EXISTS (SELECT 1 FROM workspace_members wm LEFT JOIN uat_seed_actors a ON a.id = wm.user_id
    WHERE wm.workspace_id = fixture_ws AND (a.id IS NULL OR a.role = 'other' OR wm.role <> a.role)) THEN
    RAISE EXCEPTION 'UAT workspace membership drift; existing memberships were preserved';
  END IF;
  IF EXISTS (SELECT 1 FROM workspace_invites i JOIN uat_seed_actors a ON a.id = i.invited_user_id
    WHERE i.workspace_id = fixture_ws AND a.role = 'other'
      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) THEN
    RAISE EXCEPTION 'UAT other actor has a pending fixture invitation';
  END IF;
  INSERT INTO workspace_members (workspace_id, user_id, role)
    SELECT fixture_ws, id, role FROM uat_seed_actors WHERE role <> 'other'
    ON CONFLICT (workspace_id, user_id) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM materials WHERE id = fixture_note) THEN
    PERFORM ensure_user_storage_row(owner_id);
    PERFORM 1 FROM user_storage WHERE user_id = owner_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM user_storage s JOIN users u ON u.id = s.user_id
      JOIN plan_limits p ON p.plan_tier = CASE
        WHEN NOT EXISTS (SELECT 1 FROM user_subscriptions WHERE user_id = owner_id) THEN u.plan_tier
        ELSE COALESCE((SELECT plan_tier FROM user_subscriptions WHERE user_id = owner_id
          AND status IN ('active', 'trialing', 'past_due') AND (current_period_end IS NULL OR current_period_end > now())
          ORDER BY (plan_tier = 'pro') DESC, current_period_end DESC NULLS FIRST LIMIT 1), 'free')
        END WHERE s.user_id = owner_id
      AND s.used_bytes + s.reserved_bytes + COALESCE((SELECT sum(delta_bytes)
        FROM user_storage_deltas WHERE user_id = owner_id), 0)
        + octet_length(initial_content::text) > p.storage_limit_bytes) THEN
      RAISE EXCEPTION 'UAT fixture would exceed owner storage quota';
    END IF;
    -- Storage triggers derive owner/size and account the insertion; no manual counter writes.
    INSERT INTO materials (id, created_by, workspace_id, workspace_name, kind, title,
      content, privacy, node_count, max_depth, updated_by)
      VALUES (fixture_note, owner_id, fixture_ws, ws.name, 'note', 'UAT authorization note',
        initial_content, 'private', 2, 1, owner_id);
    created_note := true;
  END IF;
  SELECT * INTO STRICT note FROM materials WHERE id = fixture_note FOR UPDATE;
  IF note.workspace_id IS DISTINCT FROM fixture_ws OR note.created_by IS DISTINCT FROM owner_id
    OR note.owner_user_id <> owner_id OR note.kind <> 'note' OR note.privacy <> 'private' THEN
    RAISE EXCEPTION 'UAT material ID collision or ownership/type drift; content was preserved';
  END IF;
  IF created_note THEN
    INSERT INTO material_revisions (material_id, version_date, revision, parent_revision,
      event_type, title, content, event_metadata, created_by, created_at)
      VALUES (note.id, (note.created_at AT TIME ZONE 'UTC')::date, note.revision, NULL,
        'create', note.title, note.content, '{}'::jsonb, note.created_by, note.created_at);
  ELSIF NOT EXISTS (SELECT 1 FROM material_revisions WHERE material_id = fixture_note) THEN
    RAISE EXCEPTION 'Existing UAT material has no revision history; refusing to invent a snapshot';
  END IF;
END
$seed$;
COMMIT;
