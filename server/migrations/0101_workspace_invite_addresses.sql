-- Every typed invite address keeps its own pending row, listed for the owner
-- exactly as typed whether or not it reaches an account (human authorization,
-- 2026-10-21). `email` now holds that typed address; `invited_user_id` is set
-- only while the row reaches one eligible account, and a row without it is
-- inert: no notification, no email, never acceptable.
--
-- Earlier pending rows hold the resolved account email (empty for an account
-- without one), not what was typed, so they are cleared rather than migrated
-- (no production data yet); their notifications go with them and their queued
-- emails are cancelled at send.
DELETE FROM workspace_invites WHERE accepted_at IS NULL AND revoked_at IS NULL;
DROP INDEX IF EXISTS workspace_invites_pending_user_idx;
CREATE UNIQUE INDEX workspace_invites_pending_address_idx
  ON workspace_invites (workspace_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
