-- The CSV/TSV ingest limit moves from raw delimiters in the whole file to
-- columns per row (pipeline/pipeline/ingest/source_text.py), so its code
-- becomes tabular_column_limit. Files over the old limit drop their code, as
-- 0079 did for audio; most of them fit the new one.
UPDATE files SET index_limit = NULL WHERE index_limit = 'tabular_cell_limit';
ALTER TABLE files DROP CONSTRAINT files_index_limit_check;
ALTER TABLE files ADD CONSTRAINT files_index_limit_check CHECK (index_limit IN (
  'page_limit', 'scanned_page_limit', 'image_pixel_limit',
  'tabular_column_limit', 'tabular_text_limit'
));
