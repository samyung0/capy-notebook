-- When this member was told what a class workspace shares (board V1): a member
-- is told once, those already in a class included.
ALTER TABLE workspace_members ADD COLUMN sharing_notice_seen_at timestamptz;
