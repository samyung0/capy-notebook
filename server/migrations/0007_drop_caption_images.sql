-- Figure captioning at ingest is gone: parsed documents keep their figures for
-- question-time page captures (capture_page), so the per-file caption choice
-- has nothing to act on. Standalone image uploads still caption through their
-- own route and need no flag.
ALTER TABLE files DROP COLUMN IF EXISTS caption_images;
ALTER TABLE upload_sessions DROP COLUMN IF EXISTS caption_images;
