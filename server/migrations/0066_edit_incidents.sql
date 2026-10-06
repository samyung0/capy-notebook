-- Editing incidents where a user lost or could lose work (human/
-- observability-metering.md, 2026-10-05): one row each, kept 90 days (the API's
-- minute sweep prunes older rows; an account purge deletes its user's rows).
-- The collaboration service writes the room incidents; the browser reports the
-- ones only it sees through POST /api/edit-incidents. Rows are operator data:
-- nothing in the app reads them, and the ops role reads them (below).
CREATE TABLE edit_incidents (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Whose work it was: the writer of an unsaved update, or the reporting
  -- browser's user. NULL when a room incident names no writer (a failed
  -- snapshot of an unloaded room, an epoch reset). The account purge keeps the
  -- user row, so it deletes these rows itself (PurgeUser).
  user_id     text REFERENCES users(id) ON DELETE CASCADE,
  -- A note (materials.id) or a source file (files.id); no foreign key, so a
  -- row outlives the file it names.
  file_id     text NOT NULL,
  file_kind   text NOT NULL CHECK (file_kind IN ('material', 'source_file')),
  kind        text NOT NULL CHECK (kind IN (
    -- Collaboration service.
    'save_refused', 'discard_unsaved', 'epoch_reset', 'over_limit',
    'slow_save_limit', 'step2_unplaced',
    -- Browser.
    'other_epoch_draft', 'draft_unrestorable', 'draft_storage_failed',
    'unconfirmed_edit', 'offline_episode'
  )),
  reason      text CHECK (reason ~ '^[a-z0-9_-]{1,64}$'),
  -- The bytes at risk: the room's state, the refused update, or the drafts.
  size_bytes  bigint CHECK (size_bytes >= 0)
);
CREATE INDEX edit_incidents_created_idx ON edit_incidents(created_at);
-- One file's history, newest last.
CREATE INDEX edit_incidents_file_idx ON edit_incidents(file_id, created_at);

-- The ops read role (deploy/ops-roles.sql creates it) reads the table, so
-- operators do not query it as the owner (Epo, 2026-10-06). An environment
-- without the role yet gets the grant when ops-roles.sql runs.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capy_ops') THEN
    GRANT SELECT ON edit_incidents TO capy_ops;
  END IF;
END
$grant$;
