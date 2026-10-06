-- One notification per upload or import batch instead of one per file
-- (decision 2026-10-06). The browser names a batch and its file count on each
-- upload reservation; an import request is its own batch. Triggers settle the
-- batch as its files reach ready/failed, in the same transaction as the
-- transition, so every Go and pipeline path is covered. The API's batch worker
-- publishes the notification to Redis, deletes the row, and closes batches
-- idle for an hour.
CREATE TABLE source_batches (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The actor who started the upload or import, and the recipient.
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (source IN ('upload','import')),
  total           integer NOT NULL CHECK (total > 0),
  done            integer NOT NULL DEFAULT 0,
  failed          integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  notified_at     timestamptz,
  notification_id text
);
CREATE INDEX source_batches_open_idx ON source_batches(updated_at)
  WHERE notified_at IS NULL;
CREATE INDEX source_batches_notified_idx ON source_batches(notified_at)
  WHERE notified_at IS NOT NULL;

ALTER TABLE upload_sessions ADD COLUMN batch_id text
  REFERENCES source_batches(id) ON DELETE SET NULL;
-- Cleared when the file settles its batch, so a file counts once.
ALTER TABLE files ADD COLUMN batch_id text
  REFERENCES source_batches(id) ON DELETE SET NULL;

-- Count files into a batch; the call that brings done+failed to total writes
-- the notification once.
CREATE FUNCTION source_batch_settle(batch text, done_delta integer, failed_delta integer)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  b source_batches;
  nid text;
BEGIN
  UPDATE source_batches
  SET done=done+done_delta, failed=failed+failed_delta, updated_at=now()
  WHERE id=batch
  RETURNING * INTO b;
  IF b.id IS NULL OR b.notified_at IS NOT NULL OR b.done + b.failed < b.total THEN
    RETURN;
  END IF;
  nid := 'nt_' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
  INSERT INTO notifications (id, user_id, kind, data, href, workspace_id)
  VALUES (nid, b.user_id, 'system',
    jsonb_build_object('code', 'source_batch', 'source', b.source,
      'done', b.done, 'failed', b.failed),
    '/workspaces/' || b.workspace_id, b.workspace_id);
  UPDATE source_batches SET notified_at=now(), notification_id=nid WHERE id=batch;
END;
$$;

CREATE FUNCTION files_settle_source_batch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM source_batch_settle(NEW.batch_id,
    (NEW.status = 'ready')::integer, (NEW.status = 'failed')::integer);
  NEW.batch_id := NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER files_settle_source_batch
  BEFORE INSERT OR UPDATE OF status ON files
  FOR EACH ROW
  WHEN (NEW.batch_id IS NOT NULL AND NEW.status IN ('ready','failed'))
  EXECUTE FUNCTION files_settle_source_batch();

-- An upload or import that never produced a file (expired reservation, failed
-- import) counts as failed.
CREATE FUNCTION upload_sessions_settle_source_batch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM source_batch_settle(NEW.batch_id, 0, 1);
  RETURN NULL;
END;
$$;

CREATE TRIGGER upload_sessions_settle_source_batch
  AFTER UPDATE OF status ON upload_sessions
  FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status = 'expired' AND NEW.batch_id IS NOT NULL)
  EXECUTE FUNCTION upload_sessions_settle_source_batch();

-- Only the app's own writes (triggers and the gateway) settle batches.
REVOKE EXECUTE ON FUNCTION source_batch_settle(text, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION files_settle_source_batch() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION upload_sessions_settle_source_batch() FROM PUBLIC;
