-- Capacity runs, after e2e/fixtures/seed.sql: the owner on Pro (the 24 MB
-- PPTX is over the free plan's 10 MiB source cap) and one editable workspace
-- per generator (ws_cap_1..4), so no workspace nears its 100-file cap.
BEGIN;
UPDATE users SET plan_tier = 'pro', subscription_status = 'active' WHERE id = 'u_owner';
INSERT INTO workspaces (id, user_id, name, privacy, share_role, created_at)
SELECT 'ws_cap_' || g, 'u_owner', 'Capacity ' || g, 'link', 'editor', now()
FROM generate_series(1, 4) AS g;
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT 'ws_cap_' || g, 'u_owner', 'owner' FROM generate_series(1, 4) AS g;
INSERT INTO chapters (id, workspace_id, name, position)
SELECT 'ch_cap_' || g, 'ws_cap_' || g, 'Capacity chapter', 0 FROM generate_series(1, 4) AS g;
COMMIT;
