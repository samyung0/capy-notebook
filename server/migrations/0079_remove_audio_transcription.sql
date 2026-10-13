-- Audio transcription is gone: audio sources are stored only and never
-- indexed, so the per-second rate, the duration index limit and the
-- provider-call units (only audio seconds used them) go away.
DELETE FROM resource_credit_rates WHERE resource_key = 'audio_transcription_second';

UPDATE files SET index_limit = NULL WHERE index_limit = 'audio_duration_limit';
ALTER TABLE files DROP CONSTRAINT files_index_limit_check;
ALTER TABLE files ADD CONSTRAINT files_index_limit_check CHECK (index_limit IN (
  'page_limit', 'scanned_page_limit', 'image_pixel_limit',
  'tabular_cell_limit', 'tabular_text_limit'
));

ALTER TABLE provider_calls DROP COLUMN units, DROP COLUMN unit;
