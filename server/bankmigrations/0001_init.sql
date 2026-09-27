CREATE TABLE exams (id text PRIMARY KEY, label text NOT NULL, position int NOT NULL);
CREATE TABLE subjects (id text PRIMARY KEY, exam_id text NOT NULL REFERENCES exams, label text NOT NULL, position int NOT NULL);
CREATE TABLE topics (id text PRIMARY KEY, subject_id text NOT NULL REFERENCES subjects, label text NOT NULL, position int NOT NULL);
CREATE TABLE questions (
  id text PRIMARY KEY,
  topic_id text NOT NULL REFERENCES topics,
  position int NOT NULL,
  content jsonb NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]',
  run text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  reviewed_at timestamptz,
  reviewed_by text,
  UNIQUE (topic_id, position)
);
CREATE INDEX subjects_exam ON subjects (exam_id, position);
CREATE INDEX topics_subject ON topics (subject_id, position);
