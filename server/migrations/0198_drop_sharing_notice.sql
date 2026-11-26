-- The invite page asks a class member to agree to what they share before
-- Accept, so opening a class no longer tells them in a dialog (Epo 2026-11-25).
ALTER TABLE workspace_members DROP COLUMN sharing_notice_seen_at;
