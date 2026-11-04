-- Hidden from members (todo-study-tracking.md §7, Epo 2026-11-03): a
-- workspace file or material that only the workspace's owners and editors
-- (effective role, so a share-role editor too) can list, open or search;
-- viewers, members or not, cannot. A quiz made from files and the files it was
-- read from start hidden; owners and editors switch it from the item's menu.
-- A standalone item has no members, and an embedded quiz or set follows its
-- note, so the flag is read only on a top-level workspace item.
ALTER TABLE files ADD COLUMN hidden boolean NOT NULL DEFAULT false;
ALTER TABLE materials ADD COLUMN hidden boolean NOT NULL DEFAULT false;

-- Whether viewer may see an item with this flag in this workspace: always
-- when it is not hidden or has no workspace, else only when viewer's
-- effective role on the workspace is owner or editor (Go's workspaceRoles and
-- RoleCanEdit: membership, or a link/public workspace's editor share role
-- reached publicly, as a member or through a redeemed link). The lists and
-- searches that serve readers call it; single-item access checks it in Go.
CREATE OR REPLACE FUNCTION workspace_item_visible(
  item_hidden boolean,
  item_workspace_id text,
  viewer text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NOT item_hidden OR item_workspace_id IS NULL OR EXISTS (
    SELECT 1
    FROM workspaces w
    LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = viewer
    WHERE w.id = item_workspace_id
      AND (
        w.user_id = viewer
        OR wm.role IN ('owner', 'editor')
        OR (
          w.share_role = 'editor'
          AND (
            w.privacy = 'public'
            OR (
              w.privacy = 'link'
              AND (
                wm.user_id IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM workspace_link_grants g
                  WHERE g.workspace_id = w.id AND g.user_id = viewer
                )
              )
            )
          )
        )
      )
  )
$$;
