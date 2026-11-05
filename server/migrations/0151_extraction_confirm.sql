-- Make a quiz pauses after its map for the starter to confirm the questions found
-- (Epo 2026-11-05): confirming is the wait, cancelled the starter saying no.
ALTER TABLE question_extractions
  DROP CONSTRAINT question_extractions_status_check,
  DROP CONSTRAINT question_extractions_finished_check,
  ADD CONSTRAINT question_extractions_status_check
    CHECK (status IN ('running', 'confirming', 'done', 'failed', 'cancelled')),
  ADD CONSTRAINT question_extractions_finished_check
    CHECK ((status IN ('running', 'confirming')) = (finished_at IS NULL)),
  -- Nothing reads the copies since runs count their progress (Epo 2026-11-05): the row
  -- is the run's record, with no question text.
  DROP COLUMN questions,
  -- The run's provider session, which the confirm turns into a hold of the price.
  ADD COLUMN spend_session_id text,
  -- The map's questions for the confirm dialog: label, first and last page, parts.
  -- Cleared with the file names below once the wait ends; the count stays, for analytics.
  ADD COLUMN found jsonb CHECK (found IS NULL OR jsonb_typeof(found) = 'array'),
  -- What the map call cost, read when the run paused.
  ADD COLUMN found_questions integer,
  ADD COLUMN found_credit_micros bigint,
  -- What the confirm dialog says was read: the paper, its picked pages and how many
  -- answer files went with it.
  ADD COLUMN paper_name text NOT NULL DEFAULT '',
  ADD COLUMN paper_pages integer NOT NULL DEFAULT 0,
  ADD COLUMN answer_files integer NOT NULL DEFAULT 0,
  -- Answer files left out because they failed to read: their names.
  ADD COLUMN unread_answers jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- How many questions the starter confirmed, and so pays for at most.
  ADD COLUMN confirmed integer CHECK (confirmed IS NULL OR confirmed > 0),
  ADD COLUMN copied integer NOT NULL DEFAULT 0,
  ADD COLUMN answered integer NOT NULL DEFAULT 0;
