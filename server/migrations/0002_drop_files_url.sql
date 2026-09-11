-- files.url only ever held the gateway raw-file route, which no longer exists.
-- Browsers read bytes through GET /api/files/{id}/links; the API row now
-- exposes hasBytes computed from blob_path.
ALTER TABLE files DROP COLUMN IF EXISTS url;
