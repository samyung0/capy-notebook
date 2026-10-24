-- Uploaded audio is transcribed again (Alibaba Model Studio Filetrans).
-- Transcribed seconds are priced per resource rate: audio_transcription_second
-- for uploads, voice_input_second for chat voice input. An upload longer than
-- the provider's two-hour limit stays ready and unindexed with
-- audio_duration_limit, and one with no speech with no_speech. Provider calls
-- carry their non-token units again.
-- audio_transcription_second is version 2: 0001 seeded version 1 at another
-- price, which 0079 deleted.
INSERT INTO resource_credit_rates
  (resource_key, version, unit, credit_micros_per_unit, active)
VALUES
  ('audio_transcription_second', 2, 'second', 16667, true),
  ('voice_input_second', 1, 'second', 16667, true)
ON CONFLICT (resource_key, version) DO NOTHING;

ALTER TABLE files DROP CONSTRAINT files_index_limit_check;
ALTER TABLE files ADD CONSTRAINT files_index_limit_check CHECK (index_limit IN (
  'page_limit', 'scanned_page_limit', 'element_limit', 'image_pixel_limit',
  'audio_duration_limit', 'tabular_column_limit', 'tabular_text_limit',
  'no_speech'
));

ALTER TABLE provider_calls
  ADD COLUMN IF NOT EXISTS units bigint NOT NULL DEFAULT 0 CHECK (units >= 0),
  ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT '';

-- An audio job that re-pends to poll its transcription task again records
-- its own attempt outcome, apart from capacity waits.
ALTER TABLE ingest_job_attempts DROP CONSTRAINT ingest_job_attempts_status_check;
ALTER TABLE ingest_job_attempts ADD CONSTRAINT ingest_job_attempts_status_check CHECK (status IN (
  'running', 'succeeded', 'retrying', 'failed', 'superseded',
  'lease_expired', 'capacity_wait', 'provider_busy', 'transcription_poll'
));

-- A job that ends with a transcription task stored (cancelled by a deletion
-- or lifecycle cascade, failed, out of attempts, refused) frees the task's
-- gate lease and abandons its call at once, so no slot waits out the hour.
-- A settled call stays settled. Calls before leases, the order every renewal
-- takes them in.
CREATE OR REPLACE FUNCTION end_job_filetrans_call()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  call_id text := NEW.payload->'filetrans'->>'callId';
BEGIN
  UPDATE provider_calls SET status='abandoned', abandoned_at=now(),
    error_category='lifecycle', error_code='job_ended'
   WHERE id=call_id AND status='open';
  DELETE FROM provider_capacity_leases WHERE id=call_id;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION end_job_filetrans_call() FROM PUBLIC;

DROP TRIGGER IF EXISTS jobs_end_filetrans_call ON jobs;
CREATE TRIGGER jobs_end_filetrans_call
  AFTER UPDATE OF status ON jobs
  FOR EACH ROW
  WHEN (OLD.status IN ('pending', 'running')
        AND NEW.status NOT IN ('pending', 'running')
        AND NEW.payload->'filetrans' ? 'callId')
  EXECUTE FUNCTION end_job_filetrans_call();
