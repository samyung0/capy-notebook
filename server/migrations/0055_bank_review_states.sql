-- FSRS memory state per question-bank question, per user (todo-learning.md,
-- "Question-bank progress"). question_id and topic_id name rows in the
-- separate bank database, so there is no foreign key; bank questions are
-- retracted, never deleted. item_hash is review.QuestionHash of the question
-- when it was answered: a mismatch means the question is new. last_score is
-- the last checked answer's share of the marks, for the topic list's marks.
-- Rows are never charged to storage or copied.
CREATE TABLE bank_review_states (
  user_id     text NOT NULL REFERENCES users(id),
  question_id text NOT NULL,
  topic_id    text NOT NULL,
  item_hash   text NOT NULL,
  stability   double precision NOT NULL,
  difficulty  double precision NOT NULL,
  reps        int NOT NULL,
  lapses      int NOT NULL,
  fsrs_state  smallint NOT NULL,
  last_review timestamptz NOT NULL,
  last_score  double precision NOT NULL CHECK (last_score BETWEEN 0 AND 1),
  PRIMARY KEY (user_id, question_id)
);
CREATE INDEX bank_review_states_topic_idx ON bank_review_states(user_id, topic_id);
