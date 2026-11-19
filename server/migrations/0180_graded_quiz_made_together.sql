-- A graded quiz is made with its questions in one request (Epo 2026-11-16):
-- each question maker takes the graded quiz's settings and makes the quiz and
-- its assignment in one transaction, so no quiz waits to be taken any more and
-- nothing sweeps one into the trash. A Make a quiz run keeps the graded quiz's
-- form until its quiz is made.
DROP INDEX materials_graded_pending_idx;
ALTER TABLE materials DROP COLUMN graded_pending;

ALTER TABLE question_extractions DROP COLUMN graded_quiz;
ALTER TABLE question_extractions ADD COLUMN graded_quiz jsonb;
