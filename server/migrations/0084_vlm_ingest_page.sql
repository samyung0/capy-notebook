-- A text-less page is read by the VLM (GLM-5.3-Flash) in the ingest worker
-- instead of the parser's RapidOCR. It is charged per page read, under its
-- own resource key; the parse itself charges only pages with a text layer.
UPDATE resource_credit_rates SET active = false
WHERE resource_key = 'ocr_parse_page' AND active;
INSERT INTO resource_credit_rates
  (resource_key, version, unit, credit_micros_per_unit, active)
VALUES
  ('vlm_ingest_page', 1, 'page', 1000000, true)
ON CONFLICT (resource_key, version) DO NOTHING;
