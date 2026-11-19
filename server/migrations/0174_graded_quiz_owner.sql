-- A graded quiz owns its quiz (Epo 2026-11-14, todo-graded-quizzes.md): the
-- quiz is made in the New graded quiz dialog and belongs to its assignment
-- alone. It never lists anywhere (Files, Practice, Study, Recent, search,
-- pickers), only the assignment's staff open it (Edit assignment), it is
-- hidden from members, and deleting the assignment deletes it.
ALTER TABLE materials ADD COLUMN assignment_id text REFERENCES assignments(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX materials_assignment_idx ON materials(assignment_id) WHERE assignment_id IS NOT NULL;

-- A quiz made in the New graded quiz dialog waits for its assignment
-- (Epo 2026-11-14): only such a quiz, by the same maker, can be taken by
-- CreateAssignment, and one never taken goes to the trash after a day
-- (SweepPendingGradedQuizzes).
ALTER TABLE materials ADD COLUMN graded_pending boolean NOT NULL DEFAULT false;
CREATE INDEX materials_graded_pending_idx ON materials(created_at) WHERE graded_pending;
-- A Convert run started in that dialog saves its quiz so.
ALTER TABLE question_extractions ADD COLUMN graded_quiz boolean NOT NULL DEFAULT false;

-- Turn to practice is gone (Epo 2026-11-14): a graded quiz's quiz stays held
-- for good.
ALTER TABLE assignments DROP COLUMN practice_at;

-- No production data (no-legacy-data): each existing marked assignment's quiz
-- becomes owned by the earliest assignment made from it in the same workspace
-- (a task's only when its maker owns the quiz); a quiz in the trash stays
-- unowned. Any other assignment of that quiz keeps its frozen copy and loses
-- the link, as when a quiz is deleted, and a draft left with neither a quiz
-- nor questions is deleted.
WITH owner AS (
  SELECT DISTINCT ON (a.source_quiz_id) a.source_quiz_id AS quiz_id, a.id
  FROM assignments a
  JOIN materials m ON m.id=a.source_quiz_id
  WHERE a.kind='marked' AND m.kind='quiz' AND m.parent_material_id IS NULL AND m.trashed_at IS NULL
    AND m.workspace_id IS NOT DISTINCT FROM a.workspace_id
    AND (NOT a.own OR m.owner_user_id=a.created_by)
  ORDER BY a.source_quiz_id, a.created_at, a.id
)
UPDATE materials m SET assignment_id=owner.id, hidden=true
FROM owner WHERE m.id=owner.quiz_id;

UPDATE assignments a SET source_quiz_id=NULL
WHERE a.source_quiz_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM materials m WHERE m.id=a.source_quiz_id AND m.assignment_id=a.id);

DELETE FROM assignments WHERE kind='marked' AND draft AND source_quiz_id IS NULL AND questions IS NULL;

-- One quiz, one assignment.
DROP INDEX assignments_source_idx;
CREATE UNIQUE INDEX assignments_source_idx ON assignments(source_quiz_id) WHERE source_quiz_id IS NOT NULL;
