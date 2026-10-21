-- How the app looks for this account (style, theme, page frame), saved only
-- when the user presses Sync; NULL until then. Devices keep their own copy and
-- adopt this one when another device syncs (openwiki/frontend/appearance.md).
-- The API validates every field before it is stored.
ALTER TABLE users ADD COLUMN customization jsonb;
