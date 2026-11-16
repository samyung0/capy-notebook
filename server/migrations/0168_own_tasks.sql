-- A task a member sets themself (Epo 2026-11-10: New task for a class's viewer
-- members and everyone in a personal workspace). It is its maker's alone in any
-- workspace: a class's staff neither list it nor count it among assignments.
ALTER TABLE assignments ADD COLUMN own boolean NOT NULL DEFAULT false;

-- Such a task need not sit in a workspace (Epo 2026-11-11): made on To do it
-- has none, and its files come from anywhere its maker can open. Only its maker
-- reads it, so the account purge deletes it (no workspace's cascade would).
ALTER TABLE assignments ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE assignments ADD CONSTRAINT assignments_workspace_check CHECK (workspace_id IS NOT NULL OR own);
CREATE INDEX assignments_own_idx ON assignments(created_by) WHERE own AND workspace_id IS NULL;

-- It takes everything an assignment does but who it is for (Epo 2026-11-11):
-- a marked one freezes a quiz from anywhere its maker can open, and its copies
-- of that quiz's images name the task alone, so it keeps them in no workspace
-- and when its maker leaves one.
ALTER TABLE editor_assets
  DROP CONSTRAINT editor_assets_owner_check,
  ADD CONSTRAINT editor_assets_owner_check CHECK (
    workspace_id IS NOT NULL OR material_id IS NOT NULL OR assignment_id IS NOT NULL
  );
