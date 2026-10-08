-- A workspace card's cover art (human/miscellaneous.md, 2026-10-08); NULL means no
-- cover, the default. The shape is package cover's, checked by the API.
ALTER TABLE workspaces ADD COLUMN cover jsonb;
