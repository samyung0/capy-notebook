-- Direct file replacement (POST /api/files/{id}/replacement-uploads) is gone;
-- Office edits publish through source_refresh_candidates. Drop the
-- 'source_replace' upload target and the editor revision it guarded. Deleting
-- leftover rows releases pending reservations and queues retired objects
-- through the existing triggers; live blobs are refcount-protected.
DELETE FROM upload_sessions WHERE target='source_replace';
DROP INDEX IF EXISTS upload_sessions_replace_file_idx;
ALTER TABLE upload_sessions
  DROP CONSTRAINT IF EXISTS upload_sessions_replace_fields,
  DROP CONSTRAINT IF EXISTS upload_sessions_source_fields,
  DROP CONSTRAINT IF EXISTS upload_sessions_file_target,
  DROP CONSTRAINT IF EXISTS upload_sessions_target_check,
  DROP COLUMN IF EXISTS expected_revision,
  ADD CONSTRAINT upload_sessions_target_check
    CHECK (target IN ('source','editor_asset')),
  ADD CONSTRAINT upload_sessions_source_fields
    CHECK (target <> 'source' OR (name <> '' AND kind <> '' AND parse_mode <> '')),
  ADD CONSTRAINT upload_sessions_file_target
    CHECK (file_id IS NULL OR target = 'source');
