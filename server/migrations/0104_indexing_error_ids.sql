-- A failed row in the Indexing tab shows its error id (human frontend
-- error-handling, 2026-10-21), kept with the failure it names: the trace id of
-- the failed job's last ingest attempt, which tags that attempt's logs and
-- Sentry events. A failure the gateway records itself (the collaboration
-- service's export) sets the trace of that request in the same statement;
-- a refusal before any job has none. Clearing the error clears the id.
ALTER TABLE source_documents ADD COLUMN refresh_trace_id text;
ALTER TABLE materials ADD COLUMN index_trace_id text;
ALTER TABLE files ADD COLUMN failure_trace_id text;
CREATE INDEX ingest_job_attempts_job_idx ON ingest_job_attempts (job_id, id DESC);

CREATE FUNCTION source_refresh_trace() RETURNS trigger AS $$
BEGIN
  IF NEW.refresh_error IS NULL THEN
    NEW.refresh_trace_id := NULL;
  ELSIF NEW.refresh_trace_id IS NOT DISTINCT FROM OLD.refresh_trace_id THEN
    NEW.refresh_trace_id := (SELECT trace_id FROM ingest_job_attempts
      WHERE job_id = OLD.running_job_id ORDER BY id DESC LIMIT 1);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
REVOKE EXECUTE ON FUNCTION source_refresh_trace() FROM PUBLIC;

CREATE TRIGGER source_documents_refresh_trace
  BEFORE UPDATE OF refresh_error ON source_documents
  FOR EACH ROW
  WHEN (OLD.refresh_error IS DISTINCT FROM NEW.refresh_error)
  EXECUTE FUNCTION source_refresh_trace();

CREATE FUNCTION note_index_trace() RETURNS trigger AS $$
BEGIN
  NEW.index_trace_id := CASE WHEN NEW.index_error IS NOT NULL THEN
    (SELECT trace_id FROM ingest_job_attempts
      WHERE job_id = OLD.index_job_id ORDER BY id DESC LIMIT 1) END;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
REVOKE EXECUTE ON FUNCTION note_index_trace() FROM PUBLIC;

CREATE TRIGGER materials_index_trace
  BEFORE UPDATE OF index_error ON materials
  FOR EACH ROW
  WHEN (OLD.index_error IS DISTINCT FROM NEW.index_error)
  EXECUTE FUNCTION note_index_trace();

-- A file whose processing failed (Failed files) keeps the trace of the last
-- ingest attempt of a job naming it, the one that failed it or left it
-- partial; leaving 'failed' clears it.
CREATE FUNCTION file_failure_trace() RETURNS trigger AS $$
BEGIN
  NEW.failure_trace_id := CASE WHEN NEW.status = 'failed' THEN
    (SELECT a.trace_id FROM ingest_job_attempts a JOIN jobs j ON j.id = a.job_id
      WHERE j.payload->>'fileId' = NEW.id ORDER BY a.id DESC LIMIT 1) END;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
REVOKE EXECUTE ON FUNCTION file_failure_trace() FROM PUBLIC;

CREATE TRIGGER files_failure_trace
  BEFORE UPDATE OF status ON files
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION file_failure_trace();
