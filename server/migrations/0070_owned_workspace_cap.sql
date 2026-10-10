-- Owned workspace cap by plan (human/backend-storage-quota.md, 2026-10-09):
-- creating, cloning or receiving a workspace past it fails with
-- workspace_limit_exceeded. Existing workspaces over the cap are kept.
UPDATE plan_limits SET owned_workspace_limit = CASE plan_tier
  WHEN 'free' THEN 10
  WHEN 'pro' THEN 50
END;
