-- Pending effects caches (Epo 2026-10-27, Q415 and Q423): what the last read
-- of a note's or an Office file's pending effects computed, with the version
-- it was computed at: {"at": <version>, "effects": [...]}. A read serves it
-- while "at" names the row's current version, so a stale entry is never
-- served; the writes that move that version also clear it. NULL: not read
-- since. Neither column is charged to storage (materials charge their
-- content, source documents their generated storage_bytes).
--
-- A note's version is {"revision", "format"} (Go's noteEffectsFormat, Q435):
-- content writes clear it (noteIndexDirtySQL), and so does the index's write
-- of indexed_blocks.
ALTER TABLE materials ADD COLUMN effects_cache jsonb;

-- An Office file's is {"epoch", "checkpoint", "baseRevision", "engine"}, the
-- engine the build's hash (Q435): every save and publication clears it.
-- Unsaved edits in an open room are read live and never written here.
ALTER TABLE source_documents ADD COLUMN effects_cache jsonb;
