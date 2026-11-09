-- Handing in an unmarked assignment's work (Epo 2026-11-08, mocks S3 and T2,
-- todo-file-submissions.md). When the owner allows uploads, a member adds
-- files, as their own standalone uploads through the normal upload, and Hand in
-- ticks it (assignment_done). Nothing reads or marks them.
ALTER TABLE files
  ADD COLUMN hand_in_assignment_id text REFERENCES assignments(id) ON DELETE CASCADE;

-- A paper's or a hand-in's place among its files; set exactly on those files,
-- so "submission_position IS NULL" keeps them out of every file list.
ALTER TABLE files RENAME COLUMN attempt_position TO submission_position;
ALTER TABLE files DROP CONSTRAINT files_attempt_standalone;
ALTER TABLE files ADD CONSTRAINT files_submission_standalone CHECK (
  CASE WHEN attempt_id IS NULL AND hand_in_assignment_id IS NULL THEN submission_position IS NULL
    ELSE workspace_id IS NULL AND submission_position IS NOT NULL
      AND (attempt_id IS NULL OR hand_in_assignment_id IS NULL) END);
CREATE INDEX files_hand_in_idx ON files (hand_in_assignment_id, user_id, submission_position)
  WHERE hand_in_assignment_id IS NOT NULL;

-- An upload reserved for a hand-in, which its finalize links to the assignment.
ALTER TABLE upload_sessions
  ADD COLUMN hand_in_assignment_id text REFERENCES assignments(id) ON DELETE SET NULL;

-- No late submissions on either kind (Epo 2026-11-09, "same rules"): it needs
-- a due date; only a marked one's marks take a late penalty.
ALTER TABLE assignments DROP CONSTRAINT assignments_check3;
ALTER TABLE assignments ADD CONSTRAINT assignments_late_policy CHECK (
  (NOT no_late OR due_at IS NOT NULL)
  AND (late_penalty_pct = 0 OR (kind = 'marked' AND due_at IS NOT NULL)));
