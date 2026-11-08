-- Answering an assignment on paper (Epo 2026-11-08, todo-file-submissions.md).
-- The owner allows it per assignment; a member then picks Upload file in Before
-- you start and hands in one paper: their own standalone uploads, through the
-- normal upload, linked to the attempt.
ALTER TABLE assignments ADD COLUMN allow_uploads boolean NOT NULL DEFAULT false;

-- An attempt answered on paper: 'upload' while it runs, 'reading' once
-- submitted until its pages are read, then 'read'. NULL: answered in the app.
ALTER TABLE attempts ADD COLUMN paper text
  CHECK (paper IN ('upload', 'reading', 'read'));

-- A paper's files, in order. They go with the attempt (and so with its
-- assignment), and never sit in a workspace.
ALTER TABLE files
  ADD COLUMN attempt_id text REFERENCES attempts(id) ON DELETE CASCADE,
  ADD COLUMN attempt_position int,
  ADD CONSTRAINT files_attempt_standalone
    CHECK (attempt_id IS NULL OR (workspace_id IS NULL AND attempt_position IS NOT NULL));
CREATE INDEX files_attempt_idx ON files (attempt_id, attempt_position) WHERE attempt_id IS NOT NULL;

-- An upload reserved for a paper, which its finalize links to the attempt. SET
-- NULL, not CASCADE: the session's expiry releases its storage reservation.
ALTER TABLE upload_sessions ADD COLUMN attempt_id text REFERENCES attempts(id) ON DELETE SET NULL;
