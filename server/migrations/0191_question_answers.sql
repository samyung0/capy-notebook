-- Each person's latest answer to a question, marked (Epo 2026-11-22): a
-- class's staff open it from a member's topic page or Frequently wrong. One
-- row per question, written with its answer events by every check (a quiz
-- attempt, a review, an assignment and its marking). attempt_id is the check's
-- attempt, so a later marking of an older attempt leaves a newer answer.
CREATE TABLE question_answers (
  user_id     text NOT NULL REFERENCES users(id),
  material_id text NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  question_id text NOT NULL,
  attempt_id  text,
  answers     jsonb NOT NULL,
  -- The question as checked: its key and the marks per part.
  graded      jsonb NOT NULL,
  answered_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, material_id, question_id)
);
CREATE INDEX question_answers_material_idx ON question_answers(material_id);
