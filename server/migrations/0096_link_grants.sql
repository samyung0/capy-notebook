-- Link sharing as Google's "anyone with the link" plus resource key (Sam
-- 2026-10-18): a signed-in non-member holds a link workspace's (or standalone
-- link material's) share role only after presenting its signed link once; the
-- server remembers that here. Members never need it, public stays open, and
-- making the resource private clears every remembered grant.
CREATE TABLE workspace_link_grants (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_link_grants_user_idx ON workspace_link_grants(user_id);

CREATE TABLE material_link_grants (
  material_id text NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (material_id, user_id)
);
CREATE INDEX material_link_grants_user_idx ON material_link_grants(user_id);

CREATE OR REPLACE FUNCTION clear_workspace_link_grants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM workspace_link_grants WHERE workspace_id = NEW.id;
  RETURN NULL;
END;
$$;
-- Plain AFTER UPDATE, not UPDATE OF privacy: OF fires only for columns the
-- statement sets, and a material filed into a workspace turns private from
-- prepare_material_storage_fields, a BEFORE trigger. The WHEN clause reads the
-- final row either way.
CREATE TRIGGER workspaces_private_clears_link_grants
AFTER UPDATE ON workspaces
FOR EACH ROW WHEN (NEW.privacy = 'private' AND OLD.privacy <> 'private')
EXECUTE FUNCTION clear_workspace_link_grants();

CREATE OR REPLACE FUNCTION clear_material_link_grants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM material_link_grants WHERE material_id = NEW.id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER materials_private_clears_link_grants
AFTER UPDATE ON materials
FOR EACH ROW WHEN (NEW.privacy = 'private' AND OLD.privacy <> 'private')
EXECUTE FUNCTION clear_material_link_grants();

REVOKE EXECUTE ON FUNCTION clear_workspace_link_grants() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION clear_material_link_grants() FROM PUBLIC;
