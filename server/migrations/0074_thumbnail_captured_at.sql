-- Browser thumbnail captures (openwiki/thumbnails.md, phase 2a): when the
-- last one was accepted, so Go refuses another within 60 s of it
-- (POST /api/files/{id}/thumbnail). NULL until the first capture.
ALTER TABLE files ADD COLUMN thumbnail_captured_at timestamptz;
