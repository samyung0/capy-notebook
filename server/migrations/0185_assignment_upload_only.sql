-- A marked assignment's submission mode (Epo 2026-11-19): online assessment
-- only (allow_uploads false), upload only (both true), or either, the member
-- choosing in Before you start (allow_uploads alone).
ALTER TABLE assignments ADD COLUMN upload_only boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT assignments_upload_only CHECK (NOT upload_only OR (allow_uploads AND kind = 'marked'));
