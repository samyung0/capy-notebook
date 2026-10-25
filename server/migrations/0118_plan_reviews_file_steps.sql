-- Plan review sessions (human/study-progress.md 2026-10-25): a whole plan's
-- review draws from every workspace in the plan. workspace_id stays the plan's
-- parent workspace (its access check); plan_name keeps the session named once
-- the plan is deleted.
ALTER TABLE review_sessions DROP CONSTRAINT review_sessions_group_kind_check;
ALTER TABLE review_sessions ADD CONSTRAINT review_sessions_group_kind_check
  CHECK (group_kind IN ('chapter','others','workspace','plan'));
ALTER TABLE review_sessions
  ADD COLUMN plan_id text REFERENCES study_plans(id) ON DELETE SET NULL,
  ADD COLUMN plan_name text;
ALTER TABLE review_sessions ADD CONSTRAINT review_sessions_plan_check
  CHECK ((group_kind = 'plan') = (plan_name IS NOT NULL));
CREATE INDEX review_sessions_plan_idx ON review_sessions(plan_id) WHERE plan_id IS NOT NULL;

-- File steps (human/study-progress.md 2026-10-25): a plan's steps are single
-- files and materials; adding a chapter, Others or a whole workspace adds its
-- files. The broad step kinds go with their rows (UAT test plans only; no
-- production data).
DELETE FROM study_plan_steps WHERE kind IN ('workspace','unfiled','chapter');
ALTER TABLE study_plan_steps DROP COLUMN chapter_id;
ALTER TABLE study_plan_steps DROP CONSTRAINT study_plan_steps_kind_check;
ALTER TABLE study_plan_steps ADD CONSTRAINT study_plan_steps_kind_check
  CHECK (kind IN ('file','material'));
CREATE UNIQUE INDEX study_plan_steps_target_idx ON study_plan_steps
  (plan_id, workspace_id, coalesce(file_id, material_id));
