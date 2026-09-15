ALTER TABLE workspaces DROP COLUMN color;
ALTER TABLE workspaces ALTER COLUMN icon_id SET DEFAULT
    ('waves-' || lpad((1 + floor(random() * 11))::int::text, 2, '0'));
UPDATE workspaces SET icon_id = DEFAULT WHERE icon_id LIKE 'slice-%';
UPDATE users SET avatar_icon_id = 'waves-' || lpad((1 + floor(random() * 11))::int::text, 2, '0')
    WHERE avatar_icon_id LIKE 'slice-%';
ALTER TABLE workspaces DROP CONSTRAINT workspaces_icon_id_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_icon_id_check CHECK (icon_id ~ '^((sprouts|notionists)-(0[1-9]|1[0-2])|critters-(0[1-9]|1[0-6])|avataaars-(0[1-9]|1[0-9]|2[0-4])|waves-(0[1-9]|1[01]))$');
ALTER TABLE users DROP CONSTRAINT users_avatar_icon_id_check;
ALTER TABLE users ADD CONSTRAINT users_avatar_icon_id_check CHECK (avatar_icon_id = '' OR avatar_icon_id ~ '^((sprouts|notionists)-(0[1-9]|1[0-2])|critters-(0[1-9]|1[0-6])|avataaars-(0[1-9]|1[0-9]|2[0-4])|waves-(0[1-9]|1[01]))$');
