-- files.content held inline text bodies; every source now lives in the blob
-- store and is read through GET /api/files/{id}/links.
ALTER TABLE files DROP COLUMN IF EXISTS content;
