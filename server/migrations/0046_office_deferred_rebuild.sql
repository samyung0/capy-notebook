-- An Office publication no longer rebases open editors onto the export
-- (human/frontend/office-files.md, 2026-09-30). It publishes the file and its
-- index at once and leaves editing on the old base; the collaboration service
-- rebuilds the editing state onto the published file once the room is empty.
-- Until then rebuild_pending is set and published_state holds the published
-- (captured) state as its change over seed(base), so pending effects are
-- measured against it on the old base. The copy is transient and uncharged,
-- like a refresh candidate's.
ALTER TABLE source_documents
  ADD COLUMN rebuild_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN published_state bytea,
  ADD COLUMN published_state_seed_sha256 text CHECK (published_state_seed_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT source_documents_rebuild_check CHECK (
    (rebuild_pending AND format <> 'text')
    OR (NOT rebuild_pending AND published_state IS NULL AND published_state_seed_sha256 IS NULL)),
  ADD CONSTRAINT source_documents_published_state_seed_check CHECK (
    published_state IS NULL OR published_state_seed_sha256 IS NOT NULL);
CREATE INDEX source_documents_rebuild_idx ON source_documents(updated_at) WHERE rebuild_pending;
