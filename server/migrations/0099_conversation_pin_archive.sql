-- Chat threads can be pinned to the top of the workspace chat list or archived
-- out of it (human/miscellaneous.md, 2026-10-20). Archiving clears the pin.
ALTER TABLE conversations
  ADD COLUMN pinned_at timestamptz,
  ADD COLUMN archived_at timestamptz;
