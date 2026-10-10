-- List-card thumbnails and previews (openwiki/thumbnails.md;
-- human/authorization-permissions-lifecycles.md and
-- human/backend-storage-quota.md, 2026-10-11). Schema only: no production data.
--   files.thumbnail_key: the content-addressed page-1 WebP
--     (thumbs/{file id}/{sha256}.webp). A counted blob reference like blob_path,
--     so a key change or a row delete releases the old object through
--     blob_unref and pending_blob_deletions, and a clone may share it.
--     Thumbnails are a platform cost: the storage triggers ignore them.
--   files.preview: {text} for text sources, the opening characters.
--   materials.preview: the list-card preview the Go writers derive from
--     content on every content write.
ALTER TABLE files ADD COLUMN thumbnail_key text, ADD COLUMN preview jsonb;
ALTER TABLE materials ADD COLUMN preview jsonb;

DROP TRIGGER files_blob_refs_after ON files;
CREATE TRIGGER files_blob_refs_after
AFTER INSERT OR UPDATE OF blob_path, thumbnail_key OR DELETE ON files
FOR EACH ROW EXECUTE FUNCTION account_blob_refs('blob_path', 'thumbnail_key');

-- A capture lands after the file is ready, so it raises its own tree event for
-- open lists to pick the thumbnail up.
DROP TRIGGER files_tree_notify_after ON files;
CREATE TRIGGER files_tree_notify_after
AFTER INSERT OR DELETE OR UPDATE OF chapter_id, position, name, kind, size_bytes,
  status, indexed, blob_path, revision, trashed_at, thumbnail_key, preview ON files
FOR EACH ROW EXECUTE FUNCTION notify_workspace_tree('files');
