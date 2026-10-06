-- Role-change and removal notices are in-app only (human/miscellaneous.md,
-- 2026-10-06), so the membership email preference has nothing left to gate.
-- Unsent mails for the dropped templates and rows of the dropped kinds and
-- codes go with them.
ALTER TABLE notification_prefs DROP COLUMN email_membership;
DELETE FROM email_outbox
 WHERE template IN ('workspace-role-changed', 'workspace-member-removed', 'model-deprecated')
   AND status IN ('pending', 'sending');
DELETE FROM notifications
 WHERE kind IN ('event', 'quiz')
    OR (kind = 'system' AND data->>'code' = 'welcome');
