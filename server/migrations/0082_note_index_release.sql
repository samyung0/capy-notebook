-- A note's index job releases the note when it ends, whatever ended it: the
-- worker, the lease reaper, cancel_pipeline_jobs or cancel_user_async_work.
-- Failed: the note parks (dirty, index_error set, counted in pendingNotes)
-- until its next edit clears the error. Done: the job and the error clear, and
-- a dirty mark an edit set while the job ran stays due.
CREATE OR REPLACE FUNCTION release_note_index_job() RETURNS trigger AS $$
BEGIN
  UPDATE materials SET
    index_job_id = NULL,
    index_error = CASE WHEN NEW.status = 'failed'
      THEN left(COALESCE(NEW.error, 'index job failed'), 500) END,
    index_dirty_at = CASE WHEN NEW.status = 'failed'
      THEN COALESCE(index_dirty_at, NEW.created_at) ELSE index_dirty_at END
  WHERE id = NEW.payload->>'materialId' AND index_job_id = NEW.id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
REVOKE EXECUTE ON FUNCTION release_note_index_job() FROM PUBLIC;

CREATE TRIGGER jobs_release_note_index
  AFTER UPDATE OF status ON jobs
  FOR EACH ROW
  WHEN (NEW.status IN ('done', 'failed') AND OLD.status IS DISTINCT FROM NEW.status
    AND NEW.payload ? 'materialId')
  EXECUTE FUNCTION release_note_index_job();
