-- Apply the role removal to databases that already ran the original schema.
-- Existing unsupported roles must be resolved explicitly; do not remap grants.
ALTER TABLE workspaces DROP CONSTRAINT workspaces_share_role_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_share_role_check
  CHECK (share_role IN ('viewer', 'editor'));

ALTER TABLE workspace_members DROP CONSTRAINT workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('owner', 'editor', 'viewer'));

ALTER TABLE workspace_invites DROP CONSTRAINT workspace_invites_role_check;
ALTER TABLE workspace_invites ADD CONSTRAINT workspace_invites_role_check
  CHECK (role IN ('editor', 'viewer'));

CREATE OR REPLACE FUNCTION workspace_acl_eviction_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  eviction_mode text := 'discard';
BEGIN
  IF OLD.user_id=NEW.user_id
    AND (
      -- A private workspace has no nonmember grant, so its dormant share role
      -- cannot turn a privacy widening into a destructive reset.
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
    eviction_mode := 'drain';
  END IF;
  PERFORM enqueue_workspace_collaboration_evictions(NEW.id, eviction_mode);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION workspace_member_acl_eviction_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  eviction_mode text := 'discard';
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
    eviction_mode := 'drain';
  END IF;
  PERFORM enqueue_workspace_collaboration_evictions(
    CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END,
    eviction_mode
  );
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
