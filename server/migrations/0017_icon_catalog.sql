-- Frozen curated IDs; defaults are evaluated once per workspace row.
ALTER TABLE workspaces ADD COLUMN icon_id TEXT NOT NULL DEFAULT
    ('slice-' || lpad((1 + floor(random() * 12))::int::text, 2, '0'))
    CHECK (icon_id ~ '^((slice|sprouts|notionists)-(0[1-9]|1[0-2])|critters-(0[1-9]|1[0-6])|avataaars-(0[1-9]|1[0-9]|2[0-4])|waves-(0[1-9]|1[01]))$');
ALTER TABLE users ADD COLUMN avatar_icon_id TEXT
    CHECK (avatar_icon_id = '' OR avatar_icon_id ~ '^((slice|sprouts|notionists)-(0[1-9]|1[0-2])|critters-(0[1-9]|1[0-6])|avataaars-(0[1-9]|1[0-9]|2[0-4])|waves-(0[1-9]|1[01]))$');

COMMENT ON COLUMN users.avatar_icon_id IS
    'NULL before initial profile sync; empty uses Clerk; a catalog ID overrides Clerk.';
