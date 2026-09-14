-- Schema-only change: no production data exists and UAT data was cleared.
DROP TRIGGER files_blob_refs_after ON files;
CREATE TRIGGER files_blob_refs_after
AFTER INSERT OR UPDATE OF blob_path OR DELETE ON files
FOR EACH ROW EXECUTE FUNCTION account_blob_refs('blob_path');
DROP TRIGGER source_refresh_candidates_blob_refs_after ON source_refresh_candidates;
CREATE TRIGGER source_refresh_candidates_blob_refs_after
AFTER INSERT OR UPDATE OR DELETE ON source_refresh_candidates
FOR EACH ROW EXECUTE FUNCTION account_blob_refs('source_blob_path');
DROP TRIGGER files_tree_notify_after ON files;
CREATE TRIGGER files_tree_notify_after
AFTER INSERT OR DELETE OR UPDATE OF chapter_id, position, name, kind, size_bytes,
  status, indexed, blob_path, revision, trashed_at ON files
FOR EACH ROW EXECUTE FUNCTION notify_workspace_tree('files');

ALTER TABLE artifact_cache DROP CONSTRAINT artifact_cache_kind_check;
ALTER TABLE artifact_cache ADD CONSTRAINT artifact_cache_kind_check
  CHECK (kind IN ('captions', 'derived_text', 'parse_bundle'));
ALTER TABLE files DROP COLUMN preview_blob_path;
ALTER TABLE source_refresh_candidates DROP COLUMN preview_blob_path;

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
    UPDATE files f SET status='failed', indexed=false
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
  USING workspaces w
  WHERE us.workspace_id=w.id AND us.status='pending'
    AND (
      us.created_by=target_user_id OR w.user_id=target_user_id OR EXISTS (
        SELECT 1 FROM source_import_jobs sij
        WHERE sij.upload_session_id=us.id AND sij.actor_user_id=target_user_id
      )
    );

  DELETE FROM source_import_requests WHERE actor_user_id=target_user_id;
END;
$$;
