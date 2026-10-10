-- A file whose content is over an ingest limit stays usable: it finishes
-- ready and unindexed, and index_limit names the limit so the app can say why
-- it is not searchable. NULL for every other file. A later successful index
-- or a new published source clears it.
ALTER TABLE files ADD COLUMN index_limit text CHECK (index_limit IN (
  'page_limit', 'scanned_page_limit', 'image_pixel_limit',
  'audio_duration_limit', 'tabular_cell_limit', 'tabular_text_limit'
));
