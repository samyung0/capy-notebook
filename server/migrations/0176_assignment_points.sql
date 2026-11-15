-- Graded assignments (Epo 2026-11-14, todo-graded-quizzes.md, after Canvas): a
-- class's Assignment (the unmarked kind) may be graded on points, none meaning
-- not graded, and its staff enter each member's grade. A task one sets oneself
-- has no points.
ALTER TABLE assignments ADD COLUMN points int CHECK (points BETWEEN 1 AND 1000);
ALTER TABLE assignments ADD CONSTRAINT assignments_points_kind
  CHECK (points IS NULL OR (kind = 'unmarked' AND NOT own));

-- The late penalty comes off a graded assignment's grade as it does off a
-- graded quiz's mark.
ALTER TABLE assignments DROP CONSTRAINT assignments_late_policy;
ALTER TABLE assignments ADD CONSTRAINT assignments_late_policy CHECK (
  (NOT no_late OR due_at IS NOT NULL)
  AND (late_penalty_pct = 0 OR ((kind = 'marked' OR points IS NOT NULL) AND due_at IS NOT NULL)));

-- A member's grade, in half points from 0 to the assignment's points (checked
-- on write), apart from their tick or hand-in: staff may grade anyone it went
-- to, and Undo hand in keeps it. It is read only while the assignment has
-- points.
CREATE TABLE assignment_grades (
  assignment_id text NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  points        numeric NOT NULL CHECK (points >= 0),
  graded_by     text REFERENCES users(id) ON DELETE SET NULL,
  graded_at     timestamptz NOT NULL,
  PRIMARY KEY (assignment_id, user_id)
);
CREATE INDEX assignment_grades_user_idx ON assignment_grades(user_id);
