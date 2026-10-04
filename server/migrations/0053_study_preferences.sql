-- The learner's study preferences (todo-learning.md, 1.4 and 2.4): how the
-- agent builds explainers and practice. Missing fields take the pipeline's
-- defaults (pipeline/prompts/preferences.py).
ALTER TABLE users ADD COLUMN study_preferences jsonb NOT NULL DEFAULT '{}'::jsonb;
