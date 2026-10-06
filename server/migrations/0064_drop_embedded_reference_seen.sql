-- An embedded row follows its note's saves like the note's editor assets
-- (human/authorization-permissions-lifecycles.md, 2026-10-06): a save trashes
-- an unreferenced row once it is over 60 seconds old, so a row whose block
-- never landed no longer waits for a first reference.
ALTER TABLE materials DROP COLUMN reference_seen_at;
