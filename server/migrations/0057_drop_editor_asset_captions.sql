-- Only image-file ingest attaches captions (human/agentic-retrieval.md,
-- 2026-10-06), so editor assets hold none: the column, its exactly-one check
-- and its unique key go, and every association names a file. No editor-asset
-- caption exists; a stray one names no file and goes with the column.
DELETE FROM image_caption_associations WHERE editor_asset_id IS NOT NULL;
ALTER TABLE image_caption_associations DROP COLUMN editor_asset_id;
ALTER TABLE image_caption_associations ALTER COLUMN file_id SET NOT NULL;
