-- The chat's Steps setting defaults to verbose, and every account moves to it
-- (no production data; Epo 2026-10-30).
ALTER TABLE users ALTER COLUMN chat_steps SET DEFAULT 'verbose';
UPDATE users SET chat_steps = 'verbose' WHERE chat_steps <> 'verbose';
