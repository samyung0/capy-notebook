-- Who can see it (Epo 2026-11-04, V1): an upload or Drive import carries the
-- uploader's choice to the file row it becomes, so a file hidden from members
-- is hidden from its first moment instead of being hidden after it lands. The
-- Make a quiz dialog's uploads always send it.
ALTER TABLE upload_sessions ADD COLUMN hidden boolean NOT NULL DEFAULT false;
