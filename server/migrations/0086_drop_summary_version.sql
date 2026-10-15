-- A stored descriptor lives until the 2% net text change gate (or a missing
-- descriptor) regenerates it; a prompt or model change no longer does.
ALTER TABLE rag_content_summaries DROP COLUMN IF EXISTS summary_version;
