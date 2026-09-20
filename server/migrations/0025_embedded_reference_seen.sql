-- An embedded row is reconciled against the projected note only once a
-- projection has referenced it: reference_seen_at replaces the clock window,
-- so a block removed before its first projection still trashes the row.
ALTER TABLE materials ADD COLUMN reference_seen_at timestamptz;
