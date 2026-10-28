-- Passages, vectors and content summaries are scoped through their content row
-- (Epo 2026-10-28): only rag_contents and the aliases name a workspace (or, on
-- rag_contents, an owner). Search reaches passages and vectors by content id,
-- so a Move re-tags one content row and its alias instead of rewriting every
-- vector, which re-entered the HNSW index at the cost of a copy
-- (bench/clone/reports/2026-10-28-index-copy-parts.md). Deleting a workspace
-- or an owner still drops the index: rag_contents cascades to its passages,
-- and passages to their vectors.

-- Vector rows carry their passage's content id (never changed after insert),
-- so the vector scan filters by the scope's contents without a join.
ALTER TABLE rag_chunk_vectors_2560 ADD COLUMN content_id text;
UPDATE rag_chunk_vectors_2560 v SET content_id = c.content_id
FROM rag_chunks c WHERE c.id = v.chunk_id;
ALTER TABLE rag_chunk_vectors_2560 ALTER COLUMN content_id SET NOT NULL;
CREATE INDEX rag_chunk_vectors_2560_content_idx ON rag_chunk_vectors_2560 (content_id);
ALTER TABLE rag_chunk_vectors_2560 DROP COLUMN workspace_id;

ALTER TABLE rag_chunks DROP COLUMN workspace_id;
ALTER TABLE rag_content_summaries DROP COLUMN workspace_id;

-- A Move re-tags the content row, the alias and the file in one transaction;
-- the alias's two (…, workspace_id) keys are checked at its commit.
ALTER TABLE rag_file_contents
  ALTER CONSTRAINT rag_file_contents_file_id_workspace_id_fkey DEFERRABLE,
  ALTER CONSTRAINT rag_file_contents_content_id_workspace_id_fkey DEFERRABLE;
