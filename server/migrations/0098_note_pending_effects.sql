-- Note pending effects (Epo 2026-10-17): chat reads a note's changes since its
-- last index as the index text per top-level block now against what that index
-- job chunked. indexed_blocks is that baseline (materialdoc.NoteBlock list),
-- written when the job ends; NULL means never indexed (every block is new).
-- pending_tokens caches the change's net tokens for the reindex threshold:
-- NULL means not yet measured since the last content write.
ALTER TABLE materials
  ADD COLUMN indexed_blocks jsonb,
  ADD COLUMN pending_tokens bigint CHECK (pending_tokens >= 0);
