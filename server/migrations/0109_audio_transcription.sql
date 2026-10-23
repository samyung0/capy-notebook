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
