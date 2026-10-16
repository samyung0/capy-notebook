-- A PDF or Office file drawing more images, vector shapes, table rows or
-- pictures than the parser reads (parser/odl/elements.py) stays ready and
-- unindexed with element_limit.
ALTER TABLE files DROP CONSTRAINT files_index_limit_check;
ALTER TABLE files ADD CONSTRAINT files_index_limit_check CHECK (index_limit IN (
  'page_limit', 'scanned_page_limit', 'element_limit', 'image_pixel_limit',
  'tabular_column_limit', 'tabular_text_limit'
));
