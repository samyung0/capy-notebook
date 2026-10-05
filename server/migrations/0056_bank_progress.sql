-- Question-bank progress keeps only each learner's latest result per bank
-- question, with no FSRS state or review queue (human/question-bank.md,
-- 2026-10-06). question_id and topic_id name rows in the separate bank
-- database, so there is no foreign key; bank questions are retracted, never
-- deleted. item_hash is review.QuestionHash of the question when it was
-- answered: a mismatch means the question is not answered. last_score is the
-- answer's share of the marks. Rows are never charged to storage or copied.
CREATE TABLE bank_progress (
  user_id     text NOT NULL REFERENCES users(id),
  question_id text NOT NULL,
  topic_id    text NOT NULL,
  item_hash   text NOT NULL,
  last_score  double precision NOT NULL CHECK (last_score BETWEEN 0 AND 1),
  answered_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, question_id)
);
CREATE INDEX bank_progress_topic_idx ON bank_progress(user_id, topic_id);

INSERT INTO bank_progress (user_id, question_id, topic_id, item_hash, last_score, answered_at)
SELECT user_id, question_id, topic_id, item_hash, last_score, last_review FROM bank_review_states;
DROP TABLE bank_review_states;
