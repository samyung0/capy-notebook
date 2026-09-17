-- Files carry the same attribution record as materials, for files a curate
-- turn generates from the shared knowledge library. Null for an upload.
ALTER TABLE files ADD COLUMN provenance jsonb;
