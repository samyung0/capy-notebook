-- Study plans are gone (Epo 2026-11-04, human/study-progress.md), with their
-- review sessions. No legacy data: other review sessions stay as they are.
DELETE FROM review_sessions WHERE group_kind = 'plan';
ALTER TABLE review_sessions DROP CONSTRAINT review_sessions_plan_check;
ALTER TABLE review_sessions DROP COLUMN plan_id, DROP COLUMN plan_name;
ALTER TABLE review_sessions DROP CONSTRAINT review_sessions_group_kind_check;
ALTER TABLE review_sessions ADD CONSTRAINT review_sessions_group_kind_check
  CHECK (group_kind IN ('topic','others','workspace'));
DROP TABLE study_plan_steps;
DROP TABLE study_plans;
