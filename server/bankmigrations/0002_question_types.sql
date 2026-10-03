-- Task types a question contains, from the subject's vocabulary in the
-- syllabus file (IELTS Academic Reading lists its eleven official types).
-- Empty for subjects without one. Written only by publication.
ALTER TABLE questions ADD COLUMN question_types text[] NOT NULL DEFAULT '{}';
CREATE INDEX questions_question_types ON questions USING gin (question_types);
