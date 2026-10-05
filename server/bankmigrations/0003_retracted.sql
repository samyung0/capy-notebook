-- Published questions are retracted, never deleted, so learners' progress
-- (bank_review_states in each app database) keeps valid ids. Every read skips
-- retracted questions; only the owner sets this.
ALTER TABLE questions ADD COLUMN retracted_at timestamptz;
