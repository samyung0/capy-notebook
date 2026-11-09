-- Make a quiz (todo-study-tracking.md §8): questions read from the selected
-- pages of uploaded files into a new quiz, as a background job. The row is the
-- job's state while it runs and its outcome afterwards. It keeps no link to
-- the files or pages it read (Epo 2026-11-02, §8 item 7): those travel only
-- in the request to the retrieval service.
CREATE TABLE question_extractions (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Who started it and pays for it; account purge deletes the rows.
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  status       text NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'done', 'failed')),
  -- Every question recorded so far, saved after each page window, before the
  -- mark scheme is paired.
  questions    jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(questions) = 'array'),
  -- The finished run's completeness report (expected, missing and unanswered
  -- labels, figures left out, why it stopped early).
  report       jsonb,
  quiz_id      text REFERENCES materials(id) ON DELETE SET NULL,
  error_code   text,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  CONSTRAINT question_extractions_finished_check
    CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX question_extractions_user_idx ON question_extractions (user_id, created_at DESC);
CREATE INDEX question_extractions_workspace_idx ON question_extractions (workspace_id);
