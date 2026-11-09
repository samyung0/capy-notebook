-- Answering an assignment on paper (Epo 2026-11-08, todo-file-submissions.md).
-- The owner allows it per assignment; a member then picks Upload file in Before
-- you start and hands in one paper: their own standalone uploads, through the
-- normal upload, linked to the attempt.
ALTER TABLE assignments ADD COLUMN allow_uploads boolean NOT NULL DEFAULT false;

-- An attempt answered on paper: 'upload' while it runs, 'reading' once
-- submitted until its pages are read, then 'read'. NULL: answered in the app.
ALTER TABLE attempts ADD COLUMN paper text
  CHECK (paper IN ('upload', 'reading', 'read'));

-- A paper's files, in order. They go with the attempt (and so with its
-- assignment), and never sit in a workspace.
ALTER TABLE files
  ADD COLUMN attempt_id text REFERENCES attempts(id) ON DELETE CASCADE,
  ADD COLUMN attempt_position int,
  ADD CONSTRAINT files_attempt_standalone
    CHECK (attempt_id IS NULL OR (workspace_id IS NULL AND attempt_position IS NOT NULL));
CREATE INDEX files_attempt_idx ON files (attempt_id, attempt_position) WHERE attempt_id IS NOT NULL;

-- An upload reserved for a paper, which its finalize links to the attempt. SET
-- NULL, not CASCADE: the session's expiry releases its storage reservation.
ALTER TABLE upload_sessions ADD COLUMN attempt_id text REFERENCES attempts(id) ON DELETE SET NULL;

-- A paper's upload batch settles without a bell: the member is on the page.
ALTER TABLE source_batches ADD COLUMN paper boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION source_batch_settle(batch text, done_delta integer, failed_delta integer,
  removed_delta integer DEFAULT 0)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  b source_batches;
  nid text;
BEGIN
  UPDATE source_batches
  SET done=done+done_delta, failed=failed+failed_delta,
    removed=removed + CASE WHEN done + failed + removed + removed_delta <= total
      THEN removed_delta ELSE 0 END,
    updated_at=now()
  WHERE id=batch
  RETURNING * INTO b;
  IF b.id IS NULL OR b.notified_at IS NOT NULL OR b.done + b.failed + b.removed < b.total THEN
    RETURN;
  END IF;
  IF b.done + b.failed > 0 AND NOT b.paper THEN
    nid := 'nt_' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
    INSERT INTO notifications (id, user_id, kind, data, href, workspace_id)
    VALUES (nid, b.user_id, 'system',
      jsonb_build_object('code', 'source_batch', 'source', b.source,
        'done', b.done, 'failed', b.failed, 'removed', b.removed),
      COALESCE('/workspaces/' || b.workspace_id, '/files'), b.workspace_id);
  END IF;
  UPDATE source_batches SET notified_at=now(), notification_id=nid WHERE id=batch;
END;
$$;
