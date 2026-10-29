-- Editor image thumbnails for the Embeds tab (openwiki/thumbnails.md, Sam
-- 2026-10-29). Schema only: no production data.
--   editor_assets.thumbnail_key: the content-addressed 200 px JPEG
--     (thumbs/{asset id}/{sha256}.jpg). A counted blob reference like
--     object_path, so the row's purge, a day after its node left the note
--     (undo keeps it until then), releases it; copies of the row share it as
--     they share object_path. A platform cost: the storage triggers ignore it.
ALTER TABLE editor_assets ADD COLUMN thumbnail_key text;

DROP TRIGGER editor_assets_blob_refs_after ON editor_assets;
CREATE TRIGGER editor_assets_blob_refs_after
AFTER INSERT OR UPDATE OF object_path, thumbnail_key OR DELETE ON editor_assets
FOR EACH ROW EXECUTE FUNCTION account_blob_refs('object_path', 'thumbnail_key');
