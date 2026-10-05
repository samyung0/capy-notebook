-- IELTS task-type labels are removed (human/question-bank.md, 2026-10-06):
-- learners and the agent filter by the parts' answer types instead, read from
-- each question's content.
DROP INDEX IF EXISTS questions_question_types;
ALTER TABLE questions DROP COLUMN question_types;
