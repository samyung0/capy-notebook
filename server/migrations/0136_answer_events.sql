-- Every graded part of a checked question, append-only, for the per-topic
-- mastery model (todo-study-tracking.md §5): partial credit as awarded of
-- marks, which review_log's ratings drop. One row per part of a checked
-- question not left wholly blank; the parts of one check share created_at.
-- No backfill: there is no learner data yet.
CREATE TABLE answer_events (
  id           bigserial PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id),
  -- The quiz's workspace when answered; null for a standalone quiz.
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Set null when the quiz is deleted: the log outlives its quiz, as
  -- attempts do, so deleting a quiz keeps everyone's history.
  material_id  text REFERENCES materials(id) ON DELETE SET NULL,
  question_id  text NOT NULL,
  part_id      text NOT NULL,
  -- review.QuestionHash, as in review_states: a new hash is a new item.
  item_hash    text NOT NULL,
  answer_type  text NOT NULL,
  awarded      double precision NOT NULL,
  marks        double precision NOT NULL,
  -- ai: an answered open part, marked by the model; deterministic: the rest.
  grader       text NOT NULL CHECK (grader IN ('deterministic', 'ai')),
  -- quiz: a check in a quiz attempt; review: a review session's or Quick
  -- review's check.
  source       text NOT NULL CHECK (source IN ('quiz', 'review')),
  -- The quiz attempt, with no foreign key: the log outlives attempts, which
  -- only an account purge deletes, and it deletes these rows too.
  attempt_id   text,
  -- An earlier check returned this question's key to the user: a rating of
  -- it, or another attempt holding it (a blank check included).
  key_seen     boolean NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (marks > 0 AND awarded >= 0 AND awarded <= marks)
);
-- Workspace first: member views and a workspace's replay read by workspace,
-- and the workspace cascade uses it.
CREATE INDEX answer_events_workspace_idx ON answer_events(workspace_id, user_id, created_at);
CREATE INDEX answer_events_question_idx ON answer_events(material_id, question_id);

-- The workspace an attempt was taken in; null for a standalone quiz. An
-- attempt outlives its workspace as it outlives its quiz.
ALTER TABLE attempts ADD COLUMN workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL;
CREATE INDEX attempts_workspace_idx ON attempts(workspace_id);
