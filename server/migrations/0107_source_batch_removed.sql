-- A file the user removes from the transfer panel before its upload starts
-- counts as removed in its batch, not failed, and the batch's notification
-- says so (Epo 2026-10-22, upload-limits review M2). A batch whose every file
-- was removed closes without a notification.
ALTER TABLE source_batches ADD COLUMN removed integer NOT NULL DEFAULT 0;

DROP FUNCTION source_batch_settle(text, integer, integer);
CREATE FUNCTION source_batch_settle(batch text, done_delta integer, failed_delta integer,
  removed_delta integer DEFAULT 0)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  b source_batches;
  nid text;
BEGIN
  UPDATE source_batches
  SET done=done+done_delta, failed=failed+failed_delta, removed=removed+removed_delta,
    updated_at=now()
  WHERE id=batch
  RETURNING * INTO b;
  IF b.id IS NULL OR b.notified_at IS NOT NULL OR b.done + b.failed + b.removed < b.total THEN
    RETURN;
  END IF;
  IF b.done + b.failed > 0 THEN
    nid := 'nt_' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
    INSERT INTO notifications (id, user_id, kind, data, href, workspace_id)
    VALUES (nid, b.user_id, 'system',
      jsonb_build_object('code', 'source_batch', 'source', b.source,
        'done', b.done, 'failed', b.failed, 'removed', b.removed),
      '/workspaces/' || b.workspace_id, b.workspace_id);
  END IF;
  UPDATE source_batches SET notified_at=now(), notification_id=nid WHERE id=batch;
END;
$$;

REVOKE EXECUTE ON FUNCTION source_batch_settle(text, integer, integer, integer) FROM PUBLIC;
