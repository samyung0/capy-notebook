-- A deferred publication's rebuild whose rebase the engine refused
-- (RebaseError, "Office rebase:") stops retrying and leaves the file due again
-- (human/frontend/office-files.md, 2026-10-02). rebuild_refusal holds the
-- refusal: the collaboration service skips that rebuild, and the refresh
-- scheduler treats the file as due whatever its tokens, so the next automatic
-- publication captures the room's latest state. Every publication clears it.
ALTER TABLE source_documents
  ADD COLUMN rebuild_refusal text,
  ADD CONSTRAINT source_documents_rebuild_refusal_check CHECK (
    rebuild_refusal IS NULL OR rebuild_pending);
