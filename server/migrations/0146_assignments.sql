-- Assignments (todo-study-tracking.md §4, §5, §7): work an owner or teaching
-- assistant gives a class. Marked: a frozen copy of a quiz that members submit
-- and that is marked. Unmarked: a title and optional files that members mark
-- done. A draft is not given yet; publishing freezes a marked one's quiz.
CREATE TABLE assignments (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by       text REFERENCES users(id) ON DELETE SET NULL,
  kind             text NOT NULL CHECK (kind IN ('marked', 'unmarked')),
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  -- The quiz it was made from. Members never reach it through the assignment:
  -- they are served the frozen copy, and the quiz shows as practice at closing.
  source_quiz_id   text REFERENCES materials(id) ON DELETE SET NULL,
  -- Making the assignment hid a quiz members could see; deleting it shows it again.
  hid_source       boolean NOT NULL DEFAULT false,
  -- The frozen copy, with its keys; null until a marked assignment is published.
  questions        jsonb,
  question_count   int NOT NULL DEFAULT 0,
  total_marks      numeric NOT NULL DEFAULT 0,
  due_at           timestamptz,
  time_limit_min   int CHECK (time_limit_min BETWEEN 1 AND 1440),
  attempts_allowed int NOT NULL DEFAULT 1 CHECK (attempts_allowed BETWEEN 1 AND 10),
  -- Every viewer member, those who join later included, on top of any named
  -- assignee; else only the named ones.
  assign_all       boolean NOT NULL DEFAULT true,
  draft            boolean NOT NULL DEFAULT false,
  approve_ai_marks boolean NOT NULL DEFAULT true,
  show_answers     boolean NOT NULL DEFAULT true,
  shuffle          boolean NOT NULL DEFAULT false,
  posted_at        timestamptz NOT NULL DEFAULT now(),
  -- The owner closed it: late submissions stop, a running attempt is submitted.
  closed_at        timestamptz,
  -- When its quiz was shown as practice, once; the owner can hide it again.
  released_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'marked' OR (questions IS NULL AND source_quiz_id IS NULL)),
  CHECK (kind = 'unmarked' OR draft OR questions IS NOT NULL),
  CHECK (kind = 'unmarked' OR draft OR due_at IS NOT NULL)
);
CREATE INDEX assignments_workspace_idx ON assignments(workspace_id, posted_at DESC);
-- The sweep's marked, published assignments not yet shown as practice.
CREATE INDEX assignments_release_idx ON assignments(due_at)
  WHERE released_at IS NULL AND kind = 'marked' AND NOT draft;
CREATE INDEX assignments_source_idx ON assignments(source_quiz_id);

-- Picked names; "You" for an owner or editor who ticks themselves.
CREATE TABLE assignment_assignees (
  assignment_id text NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (assignment_id, user_id)
);
CREATE INDEX assignment_assignees_user_idx ON assignment_assignees(user_id);

-- An unmarked assignment's files and materials, in the order they were added.
CREATE TABLE assignment_files (
  assignment_id text NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  file_id       text REFERENCES files(id) ON DELETE CASCADE,
  material_id   text REFERENCES materials(id) ON DELETE CASCADE,
  position      int NOT NULL,
  PRIMARY KEY (assignment_id, position),
  CHECK ((file_id IS NULL) <> (material_id IS NULL))
);
CREATE INDEX assignment_files_file_idx ON assignment_files(file_id);
CREATE INDEX assignment_files_material_idx ON assignment_files(material_id);

-- A frozen copy's images: rows of the workspace with no material, deleted with
-- the assignment. A workspace clone leaves them out: nothing it copies names them.
ALTER TABLE editor_assets ADD COLUMN assignment_id text REFERENCES assignments(id) ON DELETE CASCADE;
CREATE INDEX editor_assets_assignment_idx ON editor_assets(assignment_id) WHERE assignment_id IS NOT NULL;

-- A member's tick on an unmarked assignment.
CREATE TABLE assignment_done (
  assignment_id text NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  done_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, user_id)
);
CREATE INDEX assignment_done_user_idx ON assignment_done(user_id);

-- A member's try at a marked assignment is an attempt of its own kind, with no
-- material: practice reads (best scores, tried by, averages, the review pool)
-- never see it, and it is read only through the assignment. Answers save into
-- `answers` while it runs; `questions` holds the graded copy from submit on.
ALTER TABLE attempts DROP CONSTRAINT attempts_kind_check;
ALTER TABLE attempts ADD CONSTRAINT attempts_kind_check
  CHECK (kind IN ('quiz', 'flashcards', 'assignment'));
ALTER TABLE attempts
  -- Deleting an assignment deletes its attempts: nothing else reads them.
  ADD COLUMN assignment_id   text REFERENCES assignments(id) ON DELETE CASCADE,
  -- started_at + the time limit, on the server's clock; null without a limit.
  ADD COLUMN deadline_at     timestamptz,
  -- Null while it runs.
  ADD COLUMN submitted_at    timestamptz,
  -- The server submitted what was saved: the time ran out, or the owner closed it.
  ADD COLUMN auto_submitted  boolean NOT NULL DEFAULT false,
  -- Marks and answers (questions with an open part) still waiting for the owner.
  ADD COLUMN waiting_marks   numeric NOT NULL DEFAULT 0,
  ADD COLUMN waiting_answers int NOT NULL DEFAULT 0,
  ADD CONSTRAINT attempts_assignment_kind_check CHECK ((kind = 'assignment') = (assignment_id IS NOT NULL));
-- One running attempt per member per assignment; also the report's reads.
CREATE UNIQUE INDEX attempts_assignment_running_idx ON attempts(assignment_id, user_id)
  WHERE assignment_id IS NOT NULL AND submitted_at IS NULL;
CREATE INDEX attempts_assignment_idx ON attempts(assignment_id, user_id, submitted_at DESC)
  WHERE assignment_id IS NOT NULL;
-- The sweep: running attempts past their time.
CREATE INDEX attempts_assignment_deadline_idx ON attempts(deadline_at)
  WHERE assignment_id IS NOT NULL AND submitted_at IS NULL;

-- The answer log takes assignment answers: closed parts at submit, open parts
-- when the owner marks them, a changed mark as a new row (the latest per
-- attempt and part stands).
ALTER TABLE answer_events DROP CONSTRAINT answer_events_grader_check;
ALTER TABLE answer_events ADD CONSTRAINT answer_events_grader_check
  CHECK (grader IN ('deterministic', 'ai', 'owner'));
ALTER TABLE answer_events DROP CONSTRAINT answer_events_source_check;
ALTER TABLE answer_events ADD CONSTRAINT answer_events_source_check
  CHECK (source IN ('quiz', 'review', 'assignment'));
