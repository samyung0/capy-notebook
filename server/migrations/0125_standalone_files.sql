-- Standalone files (Epo 2026-10-27, todo-standalone-files.md): an upload or
-- import may have no workspace. Such a file is its uploader's alone (files.user_id,
-- set at insert since 0095), never shared on its own, and ingested like any
-- other into index rows scoped to that owner instead of a workspace.
ALTER TABLE files
  ALTER COLUMN workspace_id DROP NOT NULL,
  ADD CONSTRAINT files_standalone_unfiled_check
    CHECK (workspace_id IS NOT NULL OR chapter_id IS NULL);
COMMENT ON COLUMN files.user_id IS
  'Storage owner (payer): the uploader, set once at insert (0095). A standalone file''s only reader and editor.';

-- A standalone upload reserves storage on its uploader with no workspace.
ALTER TABLE upload_sessions
  DROP CONSTRAINT upload_sessions_scope_check,
  ADD CONSTRAINT upload_sessions_scope_check CHECK (
    CASE WHEN target = 'editor_asset'
      THEN workspace_id IS NOT NULL OR material_id IS NOT NULL
      ELSE material_id IS NULL AND (workspace_id IS NOT NULL OR chapter_id IS NULL)
    END);

-- A drive import may land standalone too.
ALTER TABLE source_import_requests ALTER COLUMN workspace_id DROP NOT NULL;

-- A standalone batch's notification opens the Files page.
ALTER TABLE source_batches ALTER COLUMN workspace_id DROP NOT NULL;

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
  IF b.done + b.failed > 0 THEN
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

-- Owner-scoped index: a standalone file's content belongs to its owner, so
-- every index row holds a workspace or, on rag_contents, the owner. Children
-- reach the owner through content_id. Two standalone uploads of the same text
-- by one owner share one content row, as two in a workspace do.
ALTER TABLE rag_contents
  ALTER COLUMN workspace_id DROP NOT NULL,
  ADD COLUMN user_id text REFERENCES users(id) ON DELETE CASCADE,
  ADD CONSTRAINT rag_contents_scope_check
    CHECK ((workspace_id IS NULL) <> (user_id IS NULL));
CREATE UNIQUE INDEX rag_contents_owner_hash_key
  ON rag_contents (user_id, content_hash) WHERE workspace_id IS NULL;

-- The (id, workspace_id) foreign keys are MATCH SIMPLE: with a NULL workspace
-- Postgres checks nothing and never cascades. The single-column keys below
-- carry a standalone row's integrity and its deletion with the file.
ALTER TABLE rag_file_contents
  ALTER COLUMN workspace_id DROP NOT NULL,
  ADD CONSTRAINT rag_file_contents_file_fkey
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  ADD CONSTRAINT rag_file_contents_content_fkey
    FOREIGN KEY (content_id) REFERENCES rag_contents(id) ON DELETE CASCADE;
ALTER TABLE rag_chunks ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE rag_chunk_vectors_2560 ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE rag_content_summaries ALTER COLUMN workspace_id DROP NOT NULL;

-- Account deletion also cancels the pending uploads that have no workspace
-- (standalone files, and standalone material editor assets, which the
-- workspaces join used to miss). The rest is unchanged from 0087.
CREATE OR REPLACE FUNCTION cancel_user_async_work(target_user_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  WITH candidates AS MATERIALIZED (
    SELECT j.id, j.payload->>'reservationId' AS reservation_id,
           j.payload->>'fileId' AS file_id,
           COALESCE(j.payload->>'sourceETag', '') AS source_etag,
           CASE WHEN jsonb_typeof(j.payload->'sourceRevision')='number'
                THEN (j.payload->>'sourceRevision')::bigint END AS source_revision
    FROM jobs j
    LEFT JOIN files f ON f.id=j.payload->>'fileId'
    LEFT JOIN workspaces w ON w.id=f.workspace_id
    WHERE j.type IN ('import','parse','ingest','source_refresh')
      AND j.status IN ('pending','running')
      AND (j.payload->>'actorUserId'=target_user_id OR w.user_id=target_user_id)
    FOR UPDATE OF j SKIP LOCKED
  ), closed_attempts AS (
    UPDATE ingest_job_attempts a SET
      status='failed', stage='cancelled', error_category='lifecycle',
      error_code='account_deletion', error_detail='account deletion requested',
      retryable=false, finished_at=COALESCE(a.finished_at, now())
    FROM candidates c
    WHERE a.job_id=c.id AND a.status='running'
  ), abandoned_content AS (
    DELETE FROM rag_contents rc
    USING candidates c
    WHERE rc.claim_job_id=c.id AND rc.status='processing'
  ), failed_files AS (
    -- Still indexed while the alias serves ready content (the pipeline's
    -- db.SERVES_INDEX): a cancelled re-ingest keeps its previous index.
    UPDATE files f SET status='failed', indexed=EXISTS(
      SELECT 1 FROM rag_file_contents fc
      JOIN rag_contents rc ON rc.id=fc.content_id AND rc.status='ready'
      WHERE fc.file_id=f.id)
    FROM candidates c
    WHERE f.id=c.file_id
      AND f.status IN ('pending','processing')
      AND (c.source_revision IS NULL OR f.revision=c.source_revision)
      AND COALESCE(f.source_etag, '')=c.source_etag
  ), cancelled AS (
    UPDATE jobs j SET status='failed', error='account deletion requested',
      locked_at=NULL, lease_expires_at=NULL, updated_at=now()
    FROM candidates c WHERE j.id=c.id
    RETURNING c.reservation_id,j.id
  ), cleared_source AS (
    UPDATE source_documents d SET running_job_id=NULL,refresh_error='account deletion requested'
    FROM cancelled j WHERE d.running_job_id=j.id
  ), discarded_source AS (
    DELETE FROM source_refresh_candidates c USING cancelled j WHERE c.job_id=j.id
  ), provider_targets AS (
    SELECT reservation_id AS id FROM cancelled WHERE reservation_id IS NOT NULL
    UNION
    SELECT id FROM provider_sessions
    WHERE actor_user_id=target_user_id AND status='open'
  ), closed AS (
    UPDATE provider_sessions ps SET
      status=CASE WHEN EXISTS (
        SELECT 1 FROM usage_events ue WHERE ue.reservation_id=ps.id
      ) THEN 'settled' ELSE 'released' END,
      settled_at=now()
    FROM provider_targets p
    WHERE ps.id=p.id AND ps.status='open'
    RETURNING ps.actor_user_id, ps.reserved_micros
  ), totals AS (
    SELECT actor_user_id, sum(reserved_micros) AS reserved_micros
    FROM closed GROUP BY actor_user_id
  )
  UPDATE user_credits uc SET
    reserved_micros=GREATEST(0, uc.reserved_micros-t.reserved_micros),
    updated_at=now()
  FROM totals t WHERE uc.user_id=t.actor_user_id;

  -- Removing unfinished upload sessions releases storage reservations and the
  -- existing delete trigger cancels/clears any cloud-import lease.
  DELETE FROM upload_sessions us
  WHERE us.status='pending'
    AND (
      us.created_by=target_user_id
      OR EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.id=us.workspace_id AND w.user_id=target_user_id
      )
      OR EXISTS (
        SELECT 1 FROM source_import_jobs sij
        WHERE sij.upload_session_id=us.id AND sij.actor_user_id=target_user_id
      )
    );

  DELETE FROM source_import_requests WHERE actor_user_id=target_user_id;
END;
$$;

-- A locked owner's standalone file rooms are evicted like their workspaces'.
-- The rest is unchanged from 0090.
CREATE OR REPLACE FUNCTION user_acl_eviction_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_user_id text := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  eviction_mode text := 'discard';
  material_event_type text := 'access-changed';
  eviction_id text := 'cev_' || substr(md5(
    random()::text || clock_timestamp()::text || target_user_id
  ), 1, 24);
  material_row record;
BEGIN
  IF TG_OP='UPDATE'
    AND NEW.deleted_at IS NULL
    AND NEW.deletion_requested_at IS NULL
    AND NEW.suspended_at IS NULL
    AND (CASE OLD.plan_tier WHEN 'free' THEN 0 WHEN 'pro' THEN 1 END)
      <= (CASE NEW.plan_tier WHEN 'free' THEN 0 WHEN 'pro' THEN 1 END)
    AND (CASE OLD.subscription_status
      WHEN 'none' THEN 0 WHEN 'canceled' THEN 0
      WHEN 'past_due' THEN 1 WHEN 'trialing' THEN 1 WHEN 'active' THEN 1
      ELSE -1
    END) <= (CASE NEW.subscription_status
      WHEN 'none' THEN 0 WHEN 'canceled' THEN 0
      WHEN 'past_due' THEN 1 WHEN 'trialing' THEN 1 WHEN 'active' THEN 1
      ELSE -1
    END)
  THEN
    eviction_mode := 'drain';
    material_event_type := 'account-access-restored';
  END IF;
  INSERT INTO collaboration_eviction_outbox (id, channel, payload)
  VALUES (
    eviction_id,
    'capy:collaboration:user-evict',
    jsonb_build_object(
      'evictionId', eviction_id,
      'mode', eviction_mode,
      'type', 'account-access-changed',
      'userId', target_user_id
    )
  );
  FOR material_row IN
    SELECT id FROM materials WHERE owner_user_id=target_user_id
  LOOP
    PERFORM enqueue_material_collaboration_eviction(
      material_row.id, material_event_type, eviction_mode
    );
  END LOOP;
  -- A deleted, deletion-pending or suspended owner's source rooms are not
  -- found for everyone else, like their material rooms: discard them so open
  -- viewers reconnect through the access check.
  IF TG_OP='DELETE' OR NEW.deleted_at IS NOT NULL
    OR NEW.deletion_requested_at IS NOT NULL OR NEW.suspended_at IS NOT NULL
  THEN
    FOR material_row IN
      SELECT f.id FROM files f JOIN workspaces w ON w.id=f.workspace_id
      WHERE w.user_id=target_user_id
      UNION ALL
      SELECT f.id FROM files f WHERE f.workspace_id IS NULL AND f.user_id=target_user_id
    LOOP
      PERFORM enqueue_source_collaboration_eviction(material_row.id, 'discard');
    END LOOP;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- A file moving into a workspace (Epo 2026-10-27) changes both trees: the
-- workspace it left hears of it as well as the one it joined.
CREATE OR REPLACE FUNCTION notify_workspace_tree() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ws text;
BEGIN
  IF TG_OP = 'DELETE' THEN ws := OLD.workspace_id; ELSE ws := NEW.workspace_id; END IF;
  IF ws IS NOT NULL THEN
    PERFORM pg_notify('workspace_tree', ws || ':' || TG_ARGV[0]);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.workspace_id IS NOT NULL
     AND OLD.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    PERFORM pg_notify('workspace_tree', OLD.workspace_id || ':' || TG_ARGV[0]);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION notify_workspace_tree() FROM PUBLIC;

DROP TRIGGER files_tree_notify_after ON files;
CREATE TRIGGER files_tree_notify_after
AFTER INSERT OR DELETE OR UPDATE OF workspace_id, chapter_id, position, name, kind, size_bytes,
  status, indexed, blob_path, revision, trashed_at, thumbnail_key, preview ON files
FOR EACH ROW EXECUTE FUNCTION notify_workspace_tree('files');
