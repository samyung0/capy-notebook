-- A Word submission's PDF copy (Epo 2026-11-25, mock B6H1Z7o4byVFBVyCRSUK3B
-- C1): staff mark a .docx hand-in or graded-quiz upload on a PDF the first
-- staff browser to open it draws with the Office viewer, stored once. A
-- counted blob reference like blob_path, so the file's delete releases it
-- through blob_unref; no storage trigger charges it. Schema only: no
-- production data.
ALTER TABLE files ADD COLUMN marked_copy_path text;

DROP TRIGGER files_blob_refs_after ON files;
CREATE TRIGGER files_blob_refs_after
AFTER INSERT OR UPDATE OF blob_path, thumbnail_key, marked_copy_path OR DELETE ON files
FOR EACH ROW EXECUTE FUNCTION account_blob_refs('blob_path', 'thumbnail_key', 'marked_copy_path');
