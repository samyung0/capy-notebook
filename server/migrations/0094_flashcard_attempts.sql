-- Studying a workspace flashcard set records an attempt beside quiz attempts
-- (human/study-progress.md, 2026-10-19): kind says which, a flashcard
-- attempt's cards and ratings sit in questions, and started_at gives the
-- minutes taken for both kinds.
ALTER TABLE attempts
  ADD COLUMN kind text NOT NULL DEFAULT 'quiz' CHECK (kind IN ('quiz', 'flashcards')),
  ADD COLUMN started_at timestamptz;

-- The progress page reads each item's latest attempts.
CREATE INDEX attempts_user_material_idx ON attempts(user_id, material_id, taken_at DESC);
