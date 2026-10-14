//! Note persistence with delta saves (DESIGN.md 3): a base state in
//! `material_yjs_documents.state` and an append-only log in
//! `material_yjs_updates`. Every write takes the material's advisory lock, as
//! the Node server's `persistence.ts` does.

use deadpool_postgres::{Pool, Transaction};
use serde_json::Value;

use crate::access::{self, AccessError};
use crate::model::Model;

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

/// Which of a material's documents: its content, or a quiz's keys document
/// (live-items), stored in its own tables beside the content's. Both share
/// the material's `stored_version` (each append takes the next version), so
/// the projection's version and every Go rule about it stay as they were.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Doc {
    Content,
    Keys,
}

impl Doc {
    /// The base state's table and the log's.
    fn tables(self) -> (&'static str, &'static str) {
        match self {
            Doc::Content => ("material_yjs_documents", "material_yjs_updates"),
            Doc::Keys => ("material_yjs_keys", "material_yjs_key_updates"),
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
            "SELECT content, kind, trash_restores FROM materials WHERE id=$1 AND trashed_at IS NULL FOR UPDATE",
            &[&material_id],
        )
        .await?;
    let Some(row) = rows.first() else {
        // A trashed material keeps its content but nothing may open it.
        return Err(StoreError::Other("material not found".into()));
    };
    // A material without a Yjs row lives at schema 1 + trash_restores
    // (store.MaterialRoom). A token for an older room (minted before a trash
    // and restore, or before the cutover reset raised the floor) must not seed
    // a second lineage under that name (cutover-reset REVIEW1 L1).
    if schema < 1 + i64::from(row.get::<_, i32>("trash_restores")) {
        return Err(StoreError::Other("stale collaboration room schema".into()));
    }
    let content: Value = row.get("content");
    let kind: String = row.get("kind");
    let value = envelope_value(&content)?;
    // A quiz's two documents seed together from the stored questions.
    let (state, keys) = if kind == "quiz" {
        let (content, keys) = items::quiz::states_from_value(value, 0);
        (content, Some(keys))
    } else {
        (Model::of(&kind).state_from_value(value), None)
    };
    let schema = i32::try_from(schema)
        .map_err(|_| StoreError::Other("invalid collaboration room schema".into()))?;
    let inserted = tx
        .execute(
            "INSERT INTO material_yjs_documents
               (material_id, room_schema, state, stored_version, projected_version, projected_at)
             VALUES ($1,$2,$3,1,1,now())
             ON CONFLICT (material_id) DO NOTHING",
            &[&material_id, &schema, &state],
        )
        .await?;
    if let Some(keys) = keys
        && inserted > 0
    {
        tx.execute(
            "INSERT INTO material_yjs_keys (material_id, state) VALUES ($1,$2)",
            &[&material_id, &keys],
        )
        .await?;
    }
    Ok(())
}

pub(crate) async fn rows(
    tx: &Transaction<'_>,
    material_id: &str,
    through: Option<i64>,
) -> Result<Vec<(i64, Vec<u8>)>, StoreError> {
    doc_rows(tx, Doc::Content, material_id, through).await
}

pub(crate) async fn doc_rows(
    tx: &Transaction<'_>,
    doc: Doc,
    material_id: &str,
    through: Option<i64>,
) -> Result<Vec<(i64, Vec<u8>)>, StoreError> {
    let (_, log) = doc.tables();
    let found = tx
        .query(
            &format!(
                "SELECT seq, update FROM {log}
                 WHERE material_id=$1 AND ($2::bigint IS NULL OR seq <= $2)
                 ORDER BY seq"
            ),
            &[&material_id, &through],
        )
        .await?;
    Ok(found
        .iter()
        .map(|row| (row.get("seq"), row.get("update")))
        .collect())
}

/// Loads a room's base and log, bootstrapping the row on first open.
pub async fn load(
    pool: &Pool,
    material_id: &str,
    schema: i64,
    doc: Doc,
) -> Result<Loaded, StoreError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    access::lock_material(&tx, material_id).await?;
    let select = match doc {
        Doc::Content => {
            "SELECT d.state, d.room_schema, d.stored_version, d.projected_version, d.log_bytes, m.kind
             FROM material_yjs_documents d JOIN materials m ON m.id=d.material_id
             WHERE d.material_id=$1 FOR UPDATE OF d"
        }
        Doc::Keys => {
            "SELECT k.state, d.room_schema, d.stored_version, d.projected_version, k.log_bytes, m.kind
             FROM material_yjs_keys k
             JOIN material_yjs_documents d ON d.material_id=k.material_id
             JOIN materials m ON m.id=k.material_id
             WHERE k.material_id=$1 FOR UPDATE OF d"
        }
    };
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
        rows: doc_rows(&tx, doc, material_id, None)
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
    doc: Doc,
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
        access::assert_editor(&tx, material_id, actor).await?;
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
    append_row(&tx, doc, material_id, version, row).await?;
    tx.commit().await?;
    Ok(version)
}

/// Appends `row` as version `version` of `doc` under the caller's lock: the
/// material's version moves for either document, the log counters are the
/// document's own.
pub(crate) async fn append_row(
    tx: &Transaction<'_>,
    doc: Doc,
    material_id: &str,
    version: i64,
    row: &[u8],
) -> Result<(), StoreError> {
    let (_, log) = doc.tables();
    tx.execute(
        &format!("INSERT INTO {log} (material_id, seq, update) VALUES ($1,$2,$3)"),
        &[&material_id, &version, &row],
    )
    .await?;
    let bytes = row.len() as i64;
    match doc {
        Doc::Content => {
            tx.execute(
                "UPDATE material_yjs_documents
                 SET stored_version=$2, log_bytes=log_bytes+$3, log_rows=log_rows+1,
                     projection_error=NULL, updated_at=now()
                 WHERE material_id=$1",
                &[&material_id, &version, &bytes],
            )
            .await?;
        }
        Doc::Keys => {
            tx.execute(
                "UPDATE material_yjs_documents
                 SET stored_version=$2, projection_error=NULL, updated_at=now()
                 WHERE material_id=$1",
                &[&material_id, &version],
            )
            .await?;
            tx.execute(
                "UPDATE material_yjs_keys SET log_bytes=log_bytes+$2, log_rows=log_rows+1
                 WHERE material_id=$1",
                &[&material_id, &bytes],
            )
            .await?;
        }
    }
    Ok(())
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
    doc: Doc,
    through: Option<i64>,
) -> Result<Option<Folded>, StoreError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    access::lock_material(&tx, material_id).await?;
    let (state_table, log) = doc.tables();
    let current = tx
        .query(
            &format!(
                "SELECT s.state, d.room_schema, m.kind
                 FROM {state_table} s
                 JOIN material_yjs_documents d ON d.material_id=s.material_id
                 JOIN materials m ON m.id=s.material_id
                 WHERE s.material_id=$1 FOR UPDATE OF d"
            ),
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
    let model = match doc {
        Doc::Content => Model::of(current.get("kind")),
        Doc::Keys => Model::Item(items::Kind::QuizKeys),
    };
    let rows = doc_rows(&tx, doc, material_id, through).await?;
    let Some(&(last, _)) = rows.last() else {
        return Ok(None);
    };
    let folded_bytes: i64 = rows.iter().map(|(_, row)| row.len() as i64).sum();
    let count = rows.len();
    let state = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, StoreError> {
        let doc = ydoc::scratch_doc();
        let updates: Vec<Vec<u8>> = rows.into_iter().map(|(_, row)| row).collect();
        ydoc::replay(&doc, &base, &updates)
            .map_err(|error| StoreError::Other(error.to_string()))?;
        use yrs::{ReadTxn, Transact};
        let txn = doc.transact();
        model.assert_roots(&txn).map_err(StoreError::Invalid)?;
        Ok(txn.encode_state_as_update_v1(&yrs::StateVector::default()))
    })
    .await
    .map_err(|error| StoreError::Other(error.to_string()))??;
    let after_bytes = state.len() as i64;
    tx.execute(
        &format!(
            "UPDATE {state_table}
             SET state=$2, log_bytes=log_bytes-$3, log_rows=log_rows-$4
             WHERE material_id=$1"
        ),
        &[&material_id, &state, &folded_bytes, &(count as i32)],
    )
    .await?;
    tx.execute(
        &format!("DELETE FROM {log} WHERE material_id=$1 AND seq <= $2"),
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

/// A material's durable documents: the content's base and log, and a
/// quiz's keys base and log.
pub struct Durable {
    pub version: i64,
    pub base: Vec<u8>,
    pub rows: Vec<Vec<u8>>,
    pub kind: String,
    pub keys: Option<(Vec<u8>, Vec<Vec<u8>>)>,
}

/// The base and the whole log of a material, for a projection or an edit of
/// a room not loaded here. `None` when the material has no Yjs row.
pub async fn durable(pool: &Pool, material_id: &str) -> Result<Option<Durable>, StoreError> {
    let mut client = pool.get().await?;
    // One snapshot: a fold committing between the base and the rows would
    // otherwise pair the old base with no rows.
    let tx = client
        .build_transaction()
        .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .await?;
    let found = tx
        .query(
            "SELECT d.room_schema, d.stored_version, d.state, m.kind
             FROM material_yjs_documents d JOIN materials m ON m.id=d.material_id
             WHERE d.material_id=$1",
            &[&material_id],
        )
        .await?;
    let Some(row) = found.first() else {
        return Ok(None);
    };
    let version: i64 = row.get("stored_version");
    let base: Vec<u8> = row.get("state");
    let kind: String = row.get("kind");
    let log = rows(&tx, material_id, Some(version))
        .await?
        .into_iter()
        .map(|(_, update)| update)
        .collect();
    let keys = if kind == "quiz" {
        let found = tx
            .query(
                "SELECT state FROM material_yjs_keys WHERE material_id=$1",
                &[&material_id],
            )
            .await?;
        match found.first() {
            Some(row) => Some((
                row.get::<_, Vec<u8>>("state"),
                doc_rows(&tx, Doc::Keys, material_id, Some(version))
                    .await?
                    .into_iter()
                    .map(|(_, update)| update)
                    .collect(),
            )),
            None => return Err(StoreError::Other("quiz keys document missing".into())),
        }
    } else {
        None
    };
    tx.commit().await?;
    Ok(Some(Durable {
        version,
        base,
        rows: log,
        kind,
        keys,
    }))
}

/// A lineage compaction candidate.
pub struct Candidate {
    pub material_id: String,
    pub schema: i64,
    pub bytes: i64,
    pub kind: String,
}

/// Idle rooms whose stored bytes (base + log) passed
/// `max(floor, materials.size_bytes × multiplier)` and whose projection is
/// current: lineage compaction candidates, oldest first, less `skip` (quizzes
/// found unrebuildable, which would otherwise hold the head of the queue).
pub async fn compaction_candidates(
    pool: &Pool,
    idle_seconds: f64,
    floor: i64,
    multiplier: i64,
    limit: i64,
    skip: &[String],
) -> Result<Vec<Candidate>, StoreError> {
    let client = pool.get().await?;
    let rows = client
        .query(
            "SELECT d.material_id, d.room_schema, (octet_length(d.state) + d.log_bytes)::bigint AS bytes, m.kind
             FROM material_yjs_documents d JOIN materials m ON m.id=d.material_id
             WHERE d.updated_at < now() - make_interval(secs => $1)
               AND d.projected_version = d.stored_version
               AND octet_length(d.state) + d.log_bytes >= GREATEST($2, m.size_bytes * $3)
               AND NOT d.material_id = ANY($5)
             ORDER BY d.updated_at LIMIT $4",
            &[&idle_seconds, &floor, &multiplier, &limit, &skip],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| Candidate {
            material_id: row.get("material_id"),
            schema: i64::from(row.get::<_, i32>("room_schema")),
            bytes: row.get("bytes"),
            kind: row.get("kind"),
        })
        .collect())
}

/// A quiz's content and keys states.
type QuizStates = (Vec<u8>, Vec<u8>);

/// A quiz's two documents replayed from their base and log each.
fn replayed_quiz(
    content: (&[u8], &[Vec<u8>]),
    keys: (&[u8], &[Vec<u8>]),
) -> Result<(yrs::Doc, yrs::Doc), StoreError> {
    let replay = |(base, rows): (&[u8], &[Vec<u8>])| {
        let doc = ydoc::scratch_doc();
        ydoc::replay(&doc, base, rows).map_err(|error| StoreError::Other(error.to_string()))?;
        Ok::<_, StoreError>(doc)
    };
    Ok((replay(content)?, replay(keys)?))
}

/// Whether neither document holds a block this version cannot read, which a
/// rebuild would drop.
fn readable_quiz(content: &yrs::Doc, keys: &yrs::Doc) -> bool {
    use yrs::Transact;
    !items::quiz::holds_unknown_block(&content.transact())
        && !items::quiz::holds_unknown_block(&keys.transact())
}

/// A quiz's two documents rebuilt from what they hold (base and log each):
/// every question as typed with its keys, complete or not, since the
/// projection keeps only the complete ones (Epo 2026-10-14). `None` when
/// either holds a block this version cannot read ([readable_quiz]).
fn rebuilt_quiz(
    content: (&[u8], &[Vec<u8>]),
    keys: (&[u8], &[Vec<u8>]),
) -> Result<Option<QuizStates>, StoreError> {
    use yrs::Transact;
    let (content, keys) = replayed_quiz(content, keys)?;
    if !readable_quiz(&content, &keys) {
        return Ok(None);
    }
    let value = items::quiz::editor_value(&content.transact(), &keys.transact());
    Ok(Some(items::quiz::states_from_value(&value, 0)))
}

/// A quiz's content and keys logs through `stored` and its keys base, read
/// with `lock` (` FOR UPDATE` or empty) on the keys row.
async fn quiz_logs(
    tx: &Transaction<'_>,
    material_id: &str,
    stored: i64,
    lock: &str,
) -> Result<(Vec<Vec<u8>>, Vec<u8>, Vec<Vec<u8>>), StoreError> {
    let updates = |rows: Vec<(i64, Vec<u8>)>| rows.into_iter().map(|(_, update)| update).collect();
    let log = updates(rows(tx, material_id, Some(stored)).await?);
    let found = tx
        .query(
            &format!("SELECT state FROM material_yjs_keys WHERE material_id=$1{lock}"),
            &[&material_id],
        )
        .await?;
    let Some(keys) = found.first() else {
        return Err(StoreError::Other("quiz keys document missing".into()));
    };
    let key_log = updates(doc_rows(tx, Doc::Keys, material_id, Some(stored)).await?);
    Ok((log, keys.get("state"), key_log))
}

/// Whether compaction could rebuild this quiz now ([readable_quiz]), read
/// without locks or the eviction lease so its readers stay connected when it
/// cannot. A missing document counts as rebuildable: [compact] decides.
pub async fn quiz_rebuildable(pool: &Pool, material_id: &str) -> Result<bool, StoreError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let found = tx
        .query(
            "SELECT stored_version, state FROM material_yjs_documents WHERE material_id=$1",
            &[&material_id],
        )
        .await?;
    let Some(row) = found.first() else {
        return Ok(true);
    };
    let base: Vec<u8> = row.get("state");
    let (log, key_base, key_log) =
        quiz_logs(&tx, material_id, row.get("stored_version"), "").await?;
    let (content, keys) = replayed_quiz((&base, &log), (&key_base, &key_log))?;
    Ok(readable_quiz(&content, &keys))
}

/// Lineage compaction: rebuilds the document under the next room schema
/// (fresh item identities, so earlier agent edits lose their Undo) from its
/// projection, or a quiz from its own two documents ([rebuilt_quiz]). `None`
/// when the room moved or its projection lags.
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
            "SELECT room_schema, stored_version, projected_version, state FROM material_yjs_documents
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
            "SELECT content, kind FROM materials WHERE id=$1 FOR UPDATE",
            &[&material_id],
        )
        .await?;
    let Some(content) = content.first() else {
        return Err(StoreError::Other("material not found".into()));
    };
    let kind: String = content.get("kind");
    let (state, keys) = if kind == "quiz" {
        let base: Vec<u8> = row.get("state");
        let (log, key_base, key_log) = quiz_logs(&tx, material_id, stored, " FOR UPDATE").await?;
        match rebuilt_quiz((&base, &log), (&key_base, &key_log))? {
            Some((content, keys)) => (content, Some(keys)),
            None => return Ok(None),
        }
    } else {
        let content: Value = content.get("content");
        let value = envelope_value(&content)?;
        (Model::of(&kind).state_from_value(value), None)
    };
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
    if let Some(keys) = keys {
        tx.execute(
            "UPDATE material_yjs_keys SET state=$2, log_bytes=0, log_rows=0 WHERE material_id=$1",
            &[&material_id, &keys],
        )
        .await?;
        tx.execute(
            "DELETE FROM material_yjs_key_updates WHERE material_id=$1",
            &[&material_id],
        )
        .await?;
    }
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use serde_json::{Value, json};
    use yrs::{ReadTxn, StateVector, Transact};

    use super::rebuilt_quiz;

    fn question(id: &str, text: &str, answer: Value) -> Value {
        json!({
            "id": id, "labels": "letters", "layout": "paper", "stem": [],
            "parts": [{
                "id": format!("{id}p1"), "marks": 1,
                "blocks": [{ "type": "text", "text": text }],
                "answer": answer,
                "solution": [{ "type": "text", "text": "" }],
            }],
        })
    }

    fn quiz(questions: &[Value]) -> Vec<Value> {
        let children: Vec<Value> = questions
            .iter()
            .map(|q| json!({ "type": "quiz_question", "id": q["id"], "question": q, "children": [{ "text": "" }] }))
            .collect();
        vec![json!({ "type": "quiz", "id": "quiz", "children": children })]
    }

    fn doc(base: &[u8], rows: &[Vec<u8>]) -> yrs::Doc {
        let doc = ydoc::scratch_doc();
        ydoc::replay(&doc, base, rows).unwrap();
        doc
    }

    /// Compaction keeps a quiz's incomplete questions and their keys (Epo
    /// 2026-10-14): an mcq with no correct option, typed into the log after
    /// the base, whose part text and solution are blank, survives the
    /// rebuild with its options, while the projection drops it. Fails if the
    /// rebuild reads from the projection or loses a blank block or a key.
    #[test]
    fn a_quiz_rebuild_keeps_its_incomplete_questions_and_their_keys() {
        let complete = question("q1", "True?", json!({ "type": "boolean", "correct": true }));
        let (base, key_base) =
            items::quiz::states_from_value(&quiz(std::slice::from_ref(&complete)), 0);
        let (content, keys) = (doc(&base, &[]), doc(&key_base, &[]));
        let incomplete = question(
            "q2",
            "",
            json!({ "type": "mcq", "options": ["", "Paris"], "correct": [] }),
        );
        let (before, key_before) = (
            content.transact().state_vector(),
            keys.transact().state_vector(),
        );
        {
            let (mut content, mut keys) = (content.transact_mut(), keys.transact_mut());
            items::quiz::set_questions(&mut content, &mut keys, &[complete, incomplete]).unwrap();
        }
        let typed = |doc: &yrs::Doc, since: &StateVector| doc.transact().encode_diff_v1(since);
        let (row, key_row) = (typed(&content, &before), typed(&keys, &key_before));

        let typed_value = items::quiz::editor_value(&content.transact(), &keys.transact());
        let projected = items::quiz::value(&content.transact(), &keys.transact());
        assert_eq!(items::quiz::questions_from_value(&projected).len(), 1);

        let (state, key_state) = rebuilt_quiz((&base, &[row]), (&key_base, &[key_row]))
            .unwrap()
            .unwrap();
        let (content, keys) = (doc(&state, &[]), doc(&key_state, &[]));
        let rebuilt = items::quiz::editor_value(&content.transact(), &keys.transact());
        assert_eq!(rebuilt, typed_value);
        assert_eq!(items::quiz::questions_from_value(&rebuilt).len(), 2);
    }
}
