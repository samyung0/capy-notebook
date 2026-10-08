//! Note persistence with delta saves (DESIGN.md 3): a base state in
//! `material_yjs_documents.state` and an append-only log in
//! `material_yjs_updates`. Every write takes the material's advisory lock, as
//! the Node server's `persistence.ts` does.

use deadpool_postgres::{Pool, Transaction};
use serde_json::Value;

use crate::access::{self, AccessError};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// A shape bound the document crossed without recovering.
    #[error("invalid material document: {}", .code.as_str())]
    Limit {
        code: notes::limits::LimitCode,
        metrics: notes::limits::Metrics,
    },
    /// Not a canonical material (`MaterialDocumentValidationError`).
    #[error("invalid material document: {0}")]
    Invalid(String),
    #[error(transparent)]
    Access(AccessError),
    #[error("{0}")]
    Other(String),
}

impl From<tokio_postgres::Error> for StoreError {
    fn from(error: tokio_postgres::Error) -> Self {
        StoreError::Other(error.to_string())
    }
}

impl From<deadpool_postgres::PoolError> for StoreError {
    fn from(error: deadpool_postgres::PoolError) -> Self {
        StoreError::Other(error.to_string())
    }
}

impl From<AccessError> for StoreError {
    fn from(error: AccessError) -> Self {
        match error {
            AccessError::Database(message) => StoreError::Other(message),
            other => StoreError::Access(other),
        }
    }
}

impl StoreError {
    /// A refusal no retry can change: the room is discarded.
    pub fn permanent(&self) -> bool {
        matches!(
            self,
            StoreError::Limit { .. } | StoreError::Invalid(_) | StoreError::Access(_)
        )
    }

    /// `errorReason` for incidents.
    pub fn incident_reason(&self) -> String {
        match self {
            StoreError::Limit { code, .. } => code.as_str().to_owned(),
            StoreError::Invalid(_) => "invalid_document".into(),
            StoreError::Access(error) => error.incident_reason().into(),
            StoreError::Other(_) => "error".into(),
        }
    }
}

/// A note's durable state as a room loads it.
pub struct Loaded {
    pub base: Vec<u8>,
    pub rows: Vec<Vec<u8>>,
    pub stored_version: i64,
    pub projected_version: i64,
    pub log_bytes: i64,
    pub material_kind: String,
}

/// The Plate envelope of `materials.content`, refused unless canonical in shape.
pub(crate) fn envelope_value(content: &Value) -> Result<&Vec<Value>, StoreError> {
    match (content.get("schemaVersion"), content.get("value")) {
        (Some(version), Some(Value::Array(value))) if version.as_i64() == Some(1) => Ok(value),
        _ => Err(StoreError::Other(
            "material content is not a valid Plate envelope".into(),
        )),
    }
}

/// First open, agent edit or command on a material without a Yjs row: seed
/// the document from its projection under the lock the caller holds.
pub(crate) async fn bootstrap(
    tx: &Transaction<'_>,
    material_id: &str,
    schema: i64,
) -> Result<(), StoreError> {
    let rows = tx
        .query(
            "SELECT content FROM materials WHERE id=$1 AND trashed_at IS NULL FOR UPDATE",
            &[&material_id],
        )
        .await?;
    let Some(row) = rows.first() else {
        // A trashed material keeps its content but nothing may open it.
        return Err(StoreError::Other("material not found".into()));
    };
    let content: Value = row.get("content");
    let state = notes::slate_yjs::state_from_value(envelope_value(&content)?, 0);
    let schema = i32::try_from(schema)
        .map_err(|_| StoreError::Other("invalid collaboration room schema".into()))?;
    tx.execute(
        "INSERT INTO material_yjs_documents
           (material_id, room_schema, state, stored_version, projected_version, projected_at)
         VALUES ($1,$2,$3,1,1,now())
         ON CONFLICT (material_id) DO NOTHING",
        &[&material_id, &schema, &state],
    )
    .await?;
    Ok(())
}

pub(crate) async fn rows(
    tx: &Transaction<'_>,
    material_id: &str,
    through: Option<i64>,
) -> Result<Vec<(i64, Vec<u8>)>, StoreError> {
    let found = tx
        .query(
            "SELECT seq, update FROM material_yjs_updates
             WHERE material_id=$1 AND ($2::bigint IS NULL OR seq <= $2)
             ORDER BY seq",
            &[&material_id, &through],
        )
        .await?;
    Ok(found
        .iter()
        .map(|row| (row.get("seq"), row.get("update")))
        .collect())
}

/// Loads a room's base and log, bootstrapping the row on first open.
pub async fn load(pool: &Pool, material_id: &str, schema: i64) -> Result<Loaded, StoreError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    access::lock_material(&tx, material_id).await?;
    let select =
        "SELECT d.state, d.room_schema, d.stored_version, d.projected_version, d.log_bytes, m.kind
                  FROM material_yjs_documents d JOIN materials m ON m.id=d.material_id
                  WHERE d.material_id=$1 FOR UPDATE OF d";
    let mut found = tx.query(select, &[&material_id]).await?;
    if found.is_empty() {
        bootstrap(&tx, material_id, schema).await?;
        found = tx.query(select, &[&material_id]).await?;
    }
    let Some(row) = found.first() else {
        return Err(StoreError::Other("material not found".into()));
    };
    if i64::from(row.get::<_, i32>("room_schema")) != schema {
        return Err(StoreError::Other("stale collaboration room schema".into()));
    }
    let loaded = Loaded {
        base: row.get("state"),
        rows: rows(&tx, material_id, None)
            .await?
            .into_iter()
            .map(|(_, update)| update)
            .collect(),
        stored_version: row.get("stored_version"),
        projected_version: row.get("projected_version"),
        log_bytes: row.get("log_bytes"),
        material_kind: row.get("kind"),
    };
    tx.commit().await?;
    Ok(loaded)
}

/// One store: rechecks every contributor in the snapshot, then appends the
/// row and advances `stored_version`. Returns the new version.
pub async fn append(
    pool: &Pool,
    material_id: &str,
    schema: i64,
    row: &[u8],
    actors: &[String],
) -> Result<i64, StoreError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    access::lock_material(&tx, material_id).await?;
    let boundary = access::lock_boundary(&tx, material_id, actors).await?;
    // Frozen is enforced at admission, so updates already admitted save even
    // if their writer froze since; a writer must still hold its role.
    for actor in actors {
        access::live_access(&tx, material_id, actor).await?;
    }
    if boundary.owner_locked() {
        return Err(AccessError::Forbidden("material owner account is locked".into()).into());
    }
    let current = tx
        .query(
            "SELECT room_schema, stored_version FROM material_yjs_documents WHERE material_id=$1 FOR UPDATE",
            &[&material_id],
        )
        .await?;
    let Some(current) = current.first() else {
        return Err(StoreError::Other("material not found".into()));
    };
    if i64::from(current.get::<_, i32>("room_schema")) != schema {
        return Err(StoreError::Other("stale collaboration room schema".into()));
    }
    let version = current.get::<_, i64>("stored_version") + 1;
    tx.execute(
        "INSERT INTO material_yjs_updates (material_id, seq, update) VALUES ($1,$2,$3)",
        &[&material_id, &version, &row],
    )
    .await?;
    tx.execute(
        "UPDATE material_yjs_documents
         SET stored_version=$2, log_bytes=log_bytes+$3, log_rows=log_rows+1,
             projection_error=NULL, updated_at=now()
         WHERE material_id=$1",
        &[&material_id, &version, &(row.len() as i64)],
    )
    .await?;
    tx.commit().await?;
    Ok(version)
}

/// What a fold removed from the log, and the new base size.
pub struct Folded {
    pub rows: usize,
    pub log_bytes: i64,
    pub base_bytes: i64,
}

/// Merges the base and the rows up to `through` (all when `None`) into a new
/// base after the load check (DESIGN.md 3.5). Rows appended meanwhile stay.
pub async fn fold(
    pool: &Pool,
    material_id: &str,
    schema: i64,
    through: Option<i64>,
) -> Result<Option<Folded>, StoreError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    access::lock_material(&tx, material_id).await?;
    let current = tx
        .query(
            "SELECT state, room_schema FROM material_yjs_documents WHERE material_id=$1 FOR UPDATE",
            &[&material_id],
        )
        .await?;
    let Some(current) = current.first() else {
        return Ok(None);
    };
    if i64::from(current.get::<_, i32>("room_schema")) != schema {
        return Ok(None);
    }
    let base: Vec<u8> = current.get("state");
    let log = rows(&tx, material_id, through).await?;
    let Some(&(last, _)) = log.last() else {
        return Ok(None);
    };
    let folded_bytes: i64 = log.iter().map(|(_, row)| row.len() as i64).sum();
    let count = log.len();
    let state = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, StoreError> {
        let doc = ydoc::scratch_doc();
        let updates: Vec<Vec<u8>> = log.into_iter().map(|(_, row)| row).collect();
        ydoc::replay(&doc, &base, &updates)
            .map_err(|error| StoreError::Other(error.to_string()))?;
        use yrs::{ReadTxn, Transact};
        let txn = doc.transact();
        notes::validate::assert_roots(&txn)
            .map_err(|error| StoreError::Invalid(error.to_string()))?;
        Ok(txn.encode_state_as_update_v1(&yrs::StateVector::default()))
    })
    .await
    .map_err(|error| StoreError::Other(error.to_string()))??;
    let after_bytes = state.len() as i64;
    tx.execute(
        "UPDATE material_yjs_documents
         SET state=$2, log_bytes=log_bytes-$3, log_rows=log_rows-$4
         WHERE material_id=$1",
        &[&material_id, &state, &folded_bytes, &(count as i32)],
    )
    .await?;
    tx.execute(
        "DELETE FROM material_yjs_updates WHERE material_id=$1 AND seq <= $2",
        &[&material_id, &last],
    )
    .await?;
    tx.commit().await?;
    Ok(Some(Folded {
        rows: count,
        log_bytes: folded_bytes,
        base_bytes: after_bytes,
    }))
}

/// Moves a material to its next room schema after a discard threw unsaved
/// state away (`resetLineage`).
pub async fn reset_lineage(
    pool: &Pool,
    material_id: &str,
    schema: i64,
) -> Result<bool, StoreError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    access::lock_material(&tx, material_id).await?;
    let schema = i32::try_from(schema)
        .map_err(|_| StoreError::Other("invalid collaboration room schema".into()))?;
    let moved = tx
        .execute(
            "UPDATE material_yjs_documents SET room_schema=room_schema+1, updated_at=now()
             WHERE material_id=$1 AND room_schema=$2",
            &[&material_id, &schema],
        )
        .await?;
    tx.commit().await?;
    Ok(moved > 0)
}

/// The room a material's editors use now (`currentRoom`).
pub async fn current_room(pool: &Pool, material_id: &str) -> Result<Option<String>, StoreError> {
    let client = pool.get().await?;
    let rows = client
        .query(
            "SELECT room_schema FROM material_yjs_documents WHERE material_id=$1",
            &[&material_id],
        )
        .await?;
    Ok(rows.first().map(|row| {
        format!(
            "material:{material_id}:schema:{}",
            row.get::<_, i32>("room_schema")
        )
    }))
}

/// Records why a projection failed (`recordProjectionError`).
pub async fn record_projection_error(
    pool: &Pool,
    material_id: &str,
    version: i64,
    message: &str,
) -> Result<(), StoreError> {
    let client = pool.get().await?;
    let message: String = message.chars().take(2000).collect();
    client
        .execute(
            "UPDATE material_yjs_documents SET projection_error=$3
             WHERE material_id=$1 AND projected_version < $2 AND stored_version >= $2",
            &[&material_id, &version, &message],
        )
        .await?;
    Ok(())
}

/// Rows whose projection lags, idle for `idle_seconds`, oldest first.
pub async fn pending_projections(
    pool: &Pool,
    idle_seconds: f64,
    limit: i64,
) -> Result<Vec<(String, i64)>, StoreError> {
    let client = pool.get().await?;
    let rows = client
        .query(
            "SELECT material_id, stored_version FROM material_yjs_documents
             WHERE projected_version < stored_version AND updated_at < now() - make_interval(secs => $1)
             ORDER BY updated_at LIMIT $2",
            &[&idle_seconds, &limit],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| (row.get("material_id"), row.get("stored_version")))
        .collect())
}

/// The base and the whole log of a material, for a projection or an edit of
/// a room not loaded here. `None` when the material has no Yjs row.
pub async fn durable(
    pool: &Pool,
    material_id: &str,
) -> Result<Option<(i64, i64, Vec<u8>, Vec<Vec<u8>>)>, StoreError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let found = tx
        .query(
            "SELECT room_schema, stored_version, state FROM material_yjs_documents WHERE material_id=$1",
            &[&material_id],
        )
        .await?;
    let Some(row) = found.first() else {
        return Ok(None);
    };
    let schema = i64::from(row.get::<_, i32>("room_schema"));
    let version: i64 = row.get("stored_version");
    let base: Vec<u8> = row.get("state");
    let log = rows(&tx, material_id, Some(version))
        .await?
        .into_iter()
        .map(|(_, update)| update)
        .collect();
    tx.commit().await?;
    Ok(Some((schema, version, base, log)))
}

/// Idle rooms whose stored bytes (base + log) passed
/// `max(floor, materials.size_bytes × multiplier)` and whose projection is
/// current: lineage compaction candidates, oldest first.
pub async fn compaction_candidates(
    pool: &Pool,
    idle_seconds: f64,
    floor: i64,
    multiplier: i64,
    limit: i64,
) -> Result<Vec<(String, i64, i64)>, StoreError> {
    let client = pool.get().await?;
    let rows = client
        .query(
            "SELECT d.material_id, d.room_schema, (octet_length(d.state) + d.log_bytes)::bigint AS bytes
             FROM material_yjs_documents d JOIN materials m ON m.id=d.material_id
             WHERE d.updated_at < now() - make_interval(secs => $1)
               AND d.projected_version = d.stored_version
               AND octet_length(d.state) + d.log_bytes >= GREATEST($2, m.size_bytes * $3)
             ORDER BY d.updated_at LIMIT $4",
            &[&idle_seconds, &floor, &multiplier, &limit],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| {
            (
                row.get("material_id"),
                i64::from(row.get::<_, i32>("room_schema")),
                row.get("bytes"),
            )
        })
        .collect())
}

/// Lineage compaction: rebuilds the document from its projection under the
/// next room schema (fresh item identities, so earlier agent edits lose their
/// Undo). `None` when the room moved or its projection lags.
pub async fn compact(
    pool: &Pool,
    material_id: &str,
    schema: i64,
) -> Result<Option<(String, i64)>, StoreError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    access::lock_material(&tx, material_id).await?;
    let found = tx
        .query(
            "SELECT room_schema, stored_version, projected_version FROM material_yjs_documents
             WHERE material_id=$1 FOR UPDATE",
            &[&material_id],
        )
        .await?;
    let Some(row) = found.first() else {
        return Ok(None);
    };
    let stored: i64 = row.get("stored_version");
    if i64::from(row.get::<_, i32>("room_schema")) != schema
        || stored != row.get::<_, i64>("projected_version")
    {
        return Ok(None);
    }
    let content = tx
        .query(
            "SELECT content FROM materials WHERE id=$1 FOR UPDATE",
            &[&material_id],
        )
        .await?;
    let Some(content) = content.first() else {
        return Err(StoreError::Other("material not found".into()));
    };
    let content: Value = content.get("content");
    let state = notes::slate_yjs::state_from_value(envelope_value(&content)?, 0);
    let next_schema = i32::try_from(schema + 1)
        .map_err(|_| StoreError::Other("invalid collaboration room schema".into()))?;
    tx.execute(
        "UPDATE material_yjs_documents
         SET room_schema=$2, state=$3, stored_version=$4, projected_version=$4, log_bytes=0, log_rows=0,
             projection_error=NULL, updated_at=now(), projected_at=now()
         WHERE material_id=$1",
        &[&material_id, &next_schema, &state, &(stored + 1)],
    )
    .await?;
    tx.execute(
        "DELETE FROM material_yjs_updates WHERE material_id=$1",
        &[&material_id],
    )
    .await?;
    tx.execute(
        "UPDATE agent_edit_inverses
         SET undo_status='unavailable', undo_reason='compacted', inverse='[]'::jsonb,
             guards='[]'::jsonb, inverse_bytes=0, updated_at=now()
         WHERE resource_kind='material' AND resource_id=$1 AND undo_status='available'",
        &[&material_id],
    )
    .await?;
    tx.commit().await?;
    Ok(Some((
        format!("material:{material_id}:schema:{next_schema}"),
        state.len() as i64,
    )))
}
