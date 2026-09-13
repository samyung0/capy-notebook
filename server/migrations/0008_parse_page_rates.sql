-- OpenDataLoader parses a page for a fraction of what the MinerU pipeline cost,
-- and an OCR page (one routed to RapidOCR) is only a few extra seconds of CPU:
-- both bill 1.0 credit per page. Figure captions are no longer produced, so
-- that rate is retired. Queued jobs keep the rate snapshot they were enqueued
-- with; new work reads the active version.
--
-- Re-runnable: only the version-1 page rows are deactivated, so a version-2
-- (or later) row an operator already activated through Ops stays the single
-- active row per key instead of being switched off by the blanket update.
UPDATE resource_credit_rates SET active = false
WHERE resource_key IN ('digital_parse_page', 'ocr_parse_page') AND version = 1 AND active;
UPDATE resource_credit_rates SET active = false
WHERE resource_key = 'figure_caption_call' AND active;
INSERT INTO resource_credit_rates
  (resource_key, version, unit, credit_micros_per_unit, active)
VALUES
  ('digital_parse_page', 2, 'page', 1000000, true),
  ('ocr_parse_page', 2, 'page', 1000000, true)
ON CONFLICT (resource_key, version) DO NOTHING;
