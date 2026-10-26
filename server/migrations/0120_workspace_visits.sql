-- Per-user opens (human/authorization-permissions-lifecycles.md 2026-10-26).
-- workspace_visits: when each signed-in user last opened a workspace. Recent
-- workspaces sort by the caller's own visit, and a link or public workspace a
-- nonmember opened lists with their own while they can still open it; Forget
-- deletes the row. item_opens: when they last opened (or created) a file or a
-- top-level material, the order of Recent Files and the quick open. The
-- per-workspace last_accessed_at, which only the owner's opens moved, goes;
-- ops reads the newest visit instead.
--
-- Deploying (UAT and prod), checked by hand on the host:
--   1. The migrator refuses a gap: 0119 (plan reviews, this release) must be
--      applied first, or land with this one. Check: SELECT version FROM
--      schema_migrations ORDER BY version DESC LIMIT 3;
--   2. Let the gateway's own migrator run this file with the release that
--      reads workspace_visits. Never apply it by hand ahead of that release:
--      the running gateway still selects workspaces.last_accessed_at, and every
--      workspace read fails once the column is gone.
--   3. Afterwards re-apply deploy/ops-roles.sql (UAT: pnpm uat:ops-roles; see
--      openwiki/deployment-runbook.md) so capy_ops gets SELECT (workspace_id,
--      opened_at) ON workspace_visits; the ops privilege check fails without
--      it. The column grant on last_accessed_at drops with the column.
CREATE TABLE workspace_visits (
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id)
);
CREATE INDEX workspace_visits_workspace_idx ON workspace_visits(workspace_id, opened_at);

-- One row per user and item, file or material. A visitor's rows outlive lost
-- access harmlessly: Recent lists only what the workspace list's set still
-- holds (a private workspace drops its visitors' visits above).
CREATE TABLE item_opens (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id     text REFERENCES files(id) ON DELETE CASCADE,
  material_id text REFERENCES materials(id) ON DELETE CASCADE,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((file_id IS NULL) <> (material_id IS NULL))
);
CREATE UNIQUE INDEX item_opens_file_key ON item_opens(user_id, file_id) WHERE file_id IS NOT NULL;
CREATE UNIQUE INDEX item_opens_material_key ON item_opens(user_id, material_id) WHERE material_id IS NOT NULL;
CREATE INDEX item_opens_recent_idx ON item_opens(user_id, opened_at DESC);
CREATE INDEX item_opens_file_idx ON item_opens(file_id) WHERE file_id IS NOT NULL;
CREATE INDEX item_opens_material_idx ON item_opens(material_id) WHERE material_id IS NOT NULL;

-- A workspace turned private loses its visitors, as it loses its link grants
-- (0096): made link or public again later, it does not come back into their
-- lists until they open it again. The owner's and members' visits stay.
CREATE OR REPLACE FUNCTION clear_workspace_visitor_visits()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM workspace_visits v
  WHERE v.workspace_id = NEW.id
    AND v.user_id <> NEW.user_id
    AND NOT EXISTS (SELECT 1 FROM workspace_members m
                    WHERE m.workspace_id = NEW.id AND m.user_id = v.user_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER workspaces_private_clears_visitor_visits
AFTER UPDATE ON workspaces
FOR EACH ROW WHEN (NEW.privacy = 'private' AND OLD.privacy <> 'private')
EXECUTE FUNCTION clear_workspace_visitor_visits();
REVOKE EXECUTE ON FUNCTION clear_workspace_visitor_visits() FROM PUBLIC;

ALTER TABLE workspaces DROP COLUMN last_accessed_at;
