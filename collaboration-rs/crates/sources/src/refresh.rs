//! The refresh scheduler's statements: the Go store tests run the same SQL
//! (TestRefreshSchedulerQuery, TestReprocessSelection,
//! TestStaleRefreshesNeverHoldTheExportQueue).

/// Automatic Office refresh: this many trimmed net tokens after the idle
/// window, or any saved change left unedited for the stale window. Go
/// admission (RequestSourceRefresh) applies the same values.
pub const OFFICE_REFRESH_TOKENS: i64 = 3000;
pub const OFFICE_REFRESH_IDLE: &str = "60 seconds";
pub const OFFICE_REFRESH_STALE: &str = "7 days";

/// Refresh candidates, oldest first. A text file is due once its saves have
/// paused 30 s (a note's projection idle; Go's `textRefreshIdle`). Like Go
/// admission it skips a change list worth no tokens, except an Office list of
/// moves only (0 tokens), which publishes through the stale rule. A file
/// refused because its owner is at the concurrent ingest-job limit (429) is
/// stamped by [`REFRESH_DEFER_SQL`] and orders behind the other due files. A
/// refused rebuild makes an Office file due whatever its edits weigh.
/// Store-only Office files take the same trigger whatever auto-process says;
/// Go publishes them export-only. A failed file is never picked automatically
/// unless it is partial (still indexed, a part missing: parts design Q1).
/// A `reprocess` row is a file an export-only publication left unindexed,
/// due once its owner is active and it is out of the trash; a refusal moves
/// it an hour ahead ([`REPROCESS_DEFER_SQL`]). Each branch takes its 8
/// oldest before the merge.
pub const REFRESH_CANDIDATES_SQL: &str = "
  SELECT file_id,user_id,checkpoint,reprocess FROM (
    (SELECT d.file_id,w.user_id,d.checkpoint,true AS reprocess,GREATEST(d.last_edited_at,d.last_refresh_requested_at) AS due
      FROM source_documents d JOIN files f ON f.id=d.file_id JOIN workspaces w ON w.id=f.workspace_id JOIN users u ON u.id=w.user_id
      WHERE d.reprocess_at<=now() AND d.running_job_id IS NULL AND f.trashed_at IS NULL AND NOT f.indexed
        AND d.format<>'text' AND f.ever_parsed_successfully
        AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL AND u.suspended_at IS NULL
      ORDER BY d.reprocess_at LIMIT 8)
    UNION ALL
    (SELECT d.file_id,w.user_id,d.checkpoint,false,GREATEST(d.last_edited_at,d.last_refresh_requested_at)
      FROM source_documents d JOIN files f ON f.id=d.file_id JOIN workspaces w ON w.id=f.workspace_id
      WHERE d.checkpoint>d.indexed_checkpoint AND d.running_job_id IS NULL AND f.trashed_at IS NULL AND d.refresh_error IS NULL
        AND (d.net_tokens>0 OR (d.format<>'text' AND d.pending_effects<>'[]'::jsonb) OR d.rebuild_refusal IS NOT NULL)
        AND ((d.format='text' AND ((w.auto_process AND (f.status<>'failed' OR f.indexed)) OR d.desired_manual) AND d.last_edited_at < now()-interval '30 seconds')
          OR(d.format<>'text' AND d.last_edited_at < now()-$2::text::interval AND (d.desired_manual
            OR ((f.status<>'failed' OR f.indexed) AND (d.net_tokens>=$1 OR d.last_edited_at < now()-$3::text::interval OR d.rebuild_refusal IS NOT NULL) AND ((w.auto_process AND f.ever_parsed_successfully)
              OR (f.parse_mode='none' AND NOT f.ever_parsed_successfully))))))
      ORDER BY GREATEST(d.last_edited_at,d.last_refresh_requested_at) LIMIT 8)
  ) picked ORDER BY due LIMIT 8";

/// Claimable exports, oldest first, two per pass. A refresh captured under an
/// epoch that editing left is superseded by Go (epoch reset, restore), so it
/// never holds a slot.
pub const EXPORT_JOBS_SQL: &str = "SELECT j.id,c.file_id,COALESCE((j.payload->>'exportOnly')::boolean,false) AND COALESCE(j.payload->>'paidBy','')<>'system' AS handoff FROM jobs j JOIN source_refresh_candidates c ON c.job_id=j.id WHERE j.type='source_refresh' AND (j.status='pending' OR (j.status='running' AND j.lease_expires_at<now())) ORDER BY j.created_at LIMIT 2";

pub const REFRESH_DEFER_SQL: &str =
    "UPDATE source_documents SET last_refresh_requested_at=now() WHERE file_id=$1";

pub const REPROCESS_DEFER_SQL: &str = "UPDATE source_documents SET reprocess_at=now()+interval '1 hour' WHERE file_id=$1 AND reprocess_at<=now()";

/// Automatic note reindex (Epo 2026-10-17): this many net tokens changed
/// since the last index after the idle window, or any change left unindexed
/// for the stale window. Go admission (RequestMaterialIndex) measures the
/// tokens into materials.pending_tokens and applies the same values.
/// IMPORTANT: KEEP IN SYNC WITH NoteIndexTokens AND NoteIndexStale IN server/internal/store/note_index.go
pub const NOTE_INDEX_TOKENS: i64 = 1000;
pub const NOTE_INDEX_IDLE: &str = "60 seconds";
pub const NOTE_INDEX_STALE: &str = "10 minutes";

/// Dirty workspace notes due by the rule above (one index request each). A
/// note whose change is not measured yet (pending_tokens NULL) is listed
/// once idle, so Go measures it.
pub const NOTE_INDEX_SQL: &str = "
  SELECT m.id FROM materials m JOIN workspaces w ON w.id=m.workspace_id
  WHERE m.kind='note' AND m.trashed_at IS NULL AND m.index_dirty_at IS NOT NULL
    AND m.index_job_id IS NULL AND m.index_error IS NULL AND w.auto_process
    AND ((m.updated_at < now()-$2::text::interval AND (m.pending_tokens IS NULL OR m.pending_tokens>=$1))
      OR m.index_dirty_at < now()-$3::text::interval)
  ORDER BY m.updated_at LIMIT 8";
