-- Office maintenance window (human/frontend/office-files.md, the engine
-- upgrade window; openwiki/deployment-runbook.md, "Office maintenance window").

-- A row here pauses Office editing: the gateway refuses Office edit sessions,
-- agent edits and seeding, and the collaboration service flushes open rooms
-- and refuses writers. Operators set and clear it with office-maintenance
-- pause/resume, without a deploy.
CREATE TABLE office_editing_pause (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  paused_at timestamptz NOT NULL DEFAULT now()
);

-- Set by an export-only publication (the saved edits became the file's bytes
-- and its index was dropped): from this time the refresh scheduler reprocesses
-- the file at platform cost; each attempt moves it a day ahead.
ALTER TABLE source_documents ADD COLUMN reprocess_at timestamptz;
CREATE INDEX source_documents_reprocess_idx ON source_documents(reprocess_at)
  WHERE reprocess_at IS NOT NULL;

