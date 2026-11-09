-- When a member reads an assignment's keys, marking points and worked solutions
-- on their results (Epo 2026-11-08, mock C3): after it closes (by hand, or at
-- the due date under No late submissions), right after submitting, or never.
-- It replaces the Show answers switch; marks still show on submit.
ALTER TABLE assignments
  ADD COLUMN answers_shown text NOT NULL DEFAULT 'closed'
    CHECK (answers_shown IN ('closed', 'submitted', 'never'));
UPDATE assignments SET answers_shown = CASE WHEN show_answers THEN 'submitted' ELSE 'never' END;
ALTER TABLE assignments DROP COLUMN show_answers;
