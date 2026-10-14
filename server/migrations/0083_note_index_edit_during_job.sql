-- An edit made while a note's index job runs keeps the note due when that job
-- fails: admission clears index_dirty_at and an edit sets it again (clearing
-- index_error), so a failed job parks the note with index_error only when no
-- edit landed since its admission. Otherwise the note stays dirty with no
-- error and the scheduler admits it again. Done is unchanged from 0082.
CREATE OR REPLACE FUNCTION release_note_index_job() RETURNS trigger AS $$
BEGIN
  UPDATE materials SET
    index_job_id = NULL,
    index_error = CASE WHEN NEW.status = 'failed' AND index_dirty_at IS NULL
      THEN left(COALESCE(NEW.error, 'index job failed'), 500) END,
    index_dirty_at = CASE WHEN NEW.status = 'failed'
      THEN COALESCE(index_dirty_at, NEW.created_at) ELSE index_dirty_at END
  WHERE id = NEW.payload->>'materialId' AND index_job_id = NEW.id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
