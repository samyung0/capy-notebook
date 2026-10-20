-- Note pending effects (Epo 2026-10-17): chat reads a note's changes since its
-- last index as the index text per top-level block now against what that index
-- job chunked. indexed_blocks is that baseline (materialdoc.NoteBlock list),
-- written when the job ends; NULL means never indexed (every block is new).
-- pending_tokens caches the change's net tokens for the reindex threshold:
-- NULL means not yet measured since the last content write.
ALTER TABLE materials
  ADD COLUMN indexed_blocks jsonb,
  ADD COLUMN pending_tokens bigint CHECK (pending_tokens >= 0);

-- A note whose index job fails is retried at most twice, then left until its
-- content changes (Epo 2026-10-20). index_failures counts failed jobs since
-- the note's last content write or successful index: a failed job with no
-- edit since its admission counts one and leaves the note dirty, so the
-- scheduler admits it again; the third parks it with index_error. A done job
-- and a content write (noteIndexDirtySQL) reset the count. Replaces 0083's
-- function.
ALTER TABLE materials
  ADD COLUMN index_failures smallint NOT NULL DEFAULT 0 CHECK (index_failures >= 0);

CREATE OR REPLACE FUNCTION release_note_index_job() RETURNS trigger AS $$
BEGIN
  UPDATE materials SET
    index_job_id = NULL,
    index_failures = CASE
      WHEN NEW.status = 'done' THEN 0
      WHEN index_dirty_at IS NULL THEN index_failures + 1
      ELSE index_failures END,
    index_error = CASE WHEN NEW.status = 'failed' AND index_dirty_at IS NULL AND index_failures >= 2
      THEN left(COALESCE(NEW.error, 'index job failed'), 500) END,
    index_dirty_at = CASE WHEN NEW.status = 'failed'
      THEN COALESCE(index_dirty_at, NEW.created_at) ELSE index_dirty_at END
  WHERE id = NEW.payload->>'materialId' AND index_job_id = NEW.id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
