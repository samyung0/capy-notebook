-- Study plans (openwiki/study-progress.md#study-plans): a user's private,
-- ordered list of steps from any workspace they can read, kept in a parent
-- workspace. Steps hold no progress; done counts come from study_progress.
CREATE TABLE study_plans (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX study_plans_owner_idx ON study_plans(user_id, workspace_id);

-- A step is a whole workspace, its unfiled items, one chapter, one file or one
-- material; it goes with what it points at.
CREATE TABLE study_plan_steps (
  plan_id      text NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
  position     int NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('workspace','unfiled','chapter','file','material')),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chapter_id   text REFERENCES chapters(id) ON DELETE CASCADE,
  file_id      text REFERENCES files(id) ON DELETE CASCADE,
  material_id  text REFERENCES materials(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, position),
  CHECK ((chapter_id IS NOT NULL) = (kind = 'chapter')),
  CHECK ((file_id IS NOT NULL) = (kind = 'file')),
  CHECK ((material_id IS NOT NULL) = (kind = 'material'))
);
CREATE UNIQUE INDEX study_plan_steps_target_idx ON study_plan_steps
  (plan_id, kind, workspace_id, coalesce(chapter_id, file_id, material_id, ''));
CREATE INDEX study_plan_steps_workspace_idx ON study_plan_steps(workspace_id);

-- The global default is gone; a workspace without its own row shows progress.
ALTER TABLE users DROP COLUMN study_progress;
