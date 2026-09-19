-- Workspace notes are indexed for retrieval alongside files. A note aliases
-- the same canonical rag_contents row files use, through rag_material_contents,
-- and carries its own scheduler state: projection marks it dirty when its
-- content changes, the collaboration scheduler turns a dirty idle note into
-- one ingest job, and the worker clears the job column when it is done.
-- Standalone materials have no workspace and are never indexed.
ALTER TABLE materials ADD CONSTRAINT materials_id_workspace_key UNIQUE (id, workspace_id);

CREATE TABLE rag_material_contents (
  material_id  text PRIMARY KEY,
  workspace_id text NOT NULL,
  content_id   text NOT NULL,
  FOREIGN KEY (material_id, workspace_id) REFERENCES materials(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (content_id, workspace_id) REFERENCES rag_contents(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX rag_material_contents_content_idx ON rag_material_contents(content_id);

-- Canonical content lives while any file, note or refresh candidate references it.
CREATE OR REPLACE FUNCTION delete_unreferenced_rag_content() RETURNS trigger AS $$
BEGIN
  DELETE FROM rag_contents c
  WHERE c.id = OLD.content_id
    AND NOT EXISTS (SELECT 1 FROM rag_file_contents fc WHERE fc.content_id = OLD.content_id)
    AND NOT EXISTS (SELECT 1 FROM rag_material_contents mc WHERE mc.content_id = OLD.content_id)
    AND NOT EXISTS (SELECT 1 FROM source_refresh_candidates sc WHERE sc.content_id = OLD.content_id);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER rag_material_contents_delete_orphan
  AFTER DELETE OR UPDATE OF content_id ON rag_material_contents
  FOR EACH ROW EXECUTE FUNCTION delete_unreferenced_rag_content();

ALTER TABLE materials
  ADD COLUMN index_dirty_at timestamptz,
  ADD COLUMN index_job_id text REFERENCES jobs(id) ON DELETE SET NULL,
  ADD COLUMN index_error text;
CREATE INDEX materials_index_pending_idx ON materials(updated_at)
  WHERE index_dirty_at IS NOT NULL;

-- Existing workspace notes get indexed on the first scheduler pass.
UPDATE materials SET index_dirty_at = now()
  WHERE kind = 'note' AND workspace_id IS NOT NULL AND trashed_at IS NULL;
