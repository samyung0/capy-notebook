//! Note persistence with delta saves (DESIGN.md 3): a base state in
//! `material_yjs_documents.state` and an append-only log in
//! `material_yjs_updates`. Every write takes the material's advisory lock, as
//! the Node server's `persistence.ts` does.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock, Mutex};

use deadpool_postgres::{Pool, Transaction};
use serde_json::Value;
use ydoc::gc::Window;
use yrs::block::ClientID;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{IdSet, ReadTxn, StateVector, Transact};

use crate::access::{self, AccessError};
use crate::model::Model;
use crate::observe::{self, Level, log};
use crate::sessions;

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

    /// The document's name in `material_yjs_windows`.
    fn name(self) -> &'static str {
        match self {
            Doc::Content => "content",
            Doc::Keys => "keys",
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
    /// The stored version of the latest collection's window (0: none yet).
    pub window: i64,
    /// That window's delete set: every unit a collection discarded from this
    /// document is in it (empty: none yet; Q446).
    pub collected: IdSet,
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
        let state = Model::of(&kind)
            .state_from_value(value)
            .map_err(StoreError::Invalid)?;
        (state, None)
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
            "SELECT d.state, d.room_schema, d.stored_version, d.projected_version, d.log_bytes,
                    d.collected_window, m.kind,
                    (SELECT w.delete_set FROM material_yjs_windows w
                     WHERE w.material_id=d.material_id AND w.document='content'
                       AND d.collected_window > 0 AND w.stored_version >= d.collected_window
                     ORDER BY w.stored_version LIMIT 1) AS collected
             FROM material_yjs_documents d JOIN materials m ON m.id=d.material_id
             WHERE d.material_id=$1 FOR UPDATE OF d"
        }
        Doc::Keys => {
            "SELECT k.state, d.room_schema, d.stored_version, d.projected_version, k.log_bytes,
                    d.collected_window, m.kind, NULL::bytea AS collected
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
        window: row.get("collected_window"),
        collected: collected_deletes(row, doc)?,
    };
    tx.commit().await?;
    Ok(loaded)
}

/// A content document's delete set of the window the latest collection
/// used, or of the earliest window kept after it (a superset): the fold that
/// collects stores its own later window with it, and the newest window is
/// never pruned, so one is there whenever a collection ran. Keys documents
/// are never collected (Q274).
fn collected_deletes(row: &tokio_postgres::Row, doc: Doc) -> Result<IdSet, StoreError> {
    let window: i64 = row.get("collected_window");
    match (row.get::<_, Option<Vec<u8>>>("collected"), window) {
        _ if doc == Doc::Keys => Ok(IdSet::new()),
        (Some(set), _) => IdSet::decode_v1(&set)
            .map_err(|error| StoreError::Other(format!("invalid window snapshot: {error}"))),
        (None, 0) => Ok(IdSet::new()),
        (None, window) => Err(StoreError::Other(format!(
            "no window snapshot at or after the collected window {window}"
        ))),
    }
}

/// One store: rechecks every contributor in the snapshot, then appends the
/// row and advances `stored_version`, with the note sessions' changed rows
/// (`sessions.rs`) and the agent steps the room admitted (`receipts`, Q402)
/// in the same transaction, so a held deletion and a step's receipt are
/// durable with the state that holds them. Returns the new version.
#[allow(clippy::too_many_arguments)]
pub async fn append(
    pool: &Pool,
    material_id: &str,
    schema: i64,
    doc: Doc,
    row: &[u8],
    actors: &[String],
    sessions: &sessions::Unsaved,
    receipts: &[AgentReceipt],
) -> Result<i64, StoreError> {
    if cfg!(debug_assertions) && material_id.contains(IT_STORE_LATER) {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    lock_operations(&tx, receipts.iter().map(|receipt| receipt.id.as_str())).await?;
    access::lock_material(&tx, material_id).await?;
    // The sessions' users are locked with the accounts, in their order,
    // before the material (review r2 M2); none of them refuses the store.
    let mut session_users: Vec<String> = sessions.rows.iter().map(|row| row.user.clone()).collect();
    session_users.sort();
    session_users.dedup();
    access::lock_boundary(&tx, material_id, actors, &session_users).await?;
    // Frozen is enforced at admission, so updates already admitted save even
    // if their writer froze since; a writer must still hold its role.
    for actor in actors {
        access::assert_editor(&tx, material_id, actor).await?;
    }
    let current = tx
        .query(
            // No key update: a client id's first-write insert checks its key
            // against this row (FOR KEY SHARE) and may race the sessions'
            // write below, so a stronger lock would deadlock with it (review
            // r2 M1).
            "SELECT room_schema, stored_version FROM material_yjs_documents WHERE material_id=$1 FOR NO KEY UPDATE",
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
    save_sessions(&tx, material_id, sessions).await?;
    write_receipts(&tx, material_id, receipts).await?;
    tx.commit().await?;
    Ok(version)
}

/// An agent step's receipt (`agent_operations`), written with the write that
/// holds its change: a direct write's own transaction, or the store of the
/// room that admitted it (Q402). The Undo payload itself is never stored.
#[derive(Clone, Debug)]
pub struct AgentReceipt {
    pub id: String,
    /// `edit_document`, or `undo_edit` for an Undo or Redo.
    pub kind: &'static str,
    pub tool_version: i32,
    pub request_hash: String,
    pub actor: String,
    pub workspace_id: Option<String>,
    pub conversation_id: Option<String>,
    pub message_id: Option<String>,
    pub call_id: Option<String>,
    pub effect: Value,
    /// The step an Undo or Redo reverses.
    pub undo_of: Option<String>,
    /// The books the gateway merged into the material's record (an edit's).
    pub provenance: Option<Value>,
    /// What a note's write deleted, and its agent edit's time (Q390).
    pub held: Option<(yrs::IdSet, std::time::SystemTime)>,
}

impl AgentReceipt {
    /// The receipt as the gateway reads it.
    pub fn answer(&self) -> Value {
        let mut receipt = serde_json::json!({
            "effect": self.effect,
            "kind": self.kind,
            "operationId": self.id,
            "outcome": "succeeded",
            "toolVersion": self.tool_version,
        });
        if let Some(call) = &self.call_id {
            receipt["callId"] = serde_json::json!(call);
        }
        if let Some(workspace) = &self.workspace_id {
            receipt["workspaceId"] = serde_json::json!(workspace);
        }
        receipt
    }
}

/// The agent operations' advisory locks, in id order and before any other
/// lock (the direct write takes its own first too): a retry holds its lock
/// from its receipt check to its room's answer, so a store never commits a
/// receipt between the two (Q402).
pub(crate) async fn lock_operations<'a>(
    tx: &Transaction<'_>,
    ids: impl Iterator<Item = &'a str>,
) -> Result<(), StoreError> {
    let mut ids: Vec<&str> = ids.collect();
    ids.sort_unstable();
    ids.dedup();
    for id in ids {
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&format!("agent-operation:{id}")],
        )
        .await?;
    }
    Ok(())
}

/// Writes a room store's agent receipts in its transaction, which holds the
/// material's lock, each under a savepoint: one that cannot be written (its
/// chat deleted, its actor purged) is rolled back alone, reported, and
/// passed over, so the store still saves everyone's edits (Q432).
pub(crate) async fn write_receipts(
    tx: &Transaction<'_>,
    material_id: &str,
    receipts: &[AgentReceipt],
) -> Result<(), StoreError> {
    for receipt in receipts {
        tx.batch_execute("SAVEPOINT agent_receipt").await?;
        match write_receipt(tx, material_id, receipt).await {
            Ok(()) => tx.batch_execute("RELEASE SAVEPOINT agent_receipt").await?,
            Err(error) => {
                tx.batch_execute("ROLLBACK TO SAVEPOINT agent_receipt")
                    .await?;
                crate::observe::log(
                    crate::observe::Level::Warn,
                    "agent receipt passed over",
                    serde_json::json!({
                        "error": error.to_string(),
                        "operation": receipt.id,
                        "room": material_id,
                    }),
                );
                crate::observe::capture(
                    "agent receipt passed over",
                    None,
                    &[("material_id", material_id)],
                );
            }
        }
    }
    Ok(())
}

/// One agent receipt in the caller's transaction, which holds the
/// material's lock: the provenance its edit credits, the receipt row and the
/// holds of what it deleted. One already stored, or naming a step another
/// receipt reversed, is passed over and logged.
pub(crate) async fn write_receipt(
    tx: &Transaction<'_>,
    material_id: &str,
    receipt: &AgentReceipt,
) -> Result<(), StoreError> {
    if let Some(provenance) = &receipt.provenance {
        tx.execute(
            "UPDATE materials SET provenance=$2 WHERE id=$1",
            &[&material_id, provenance],
        )
        .await?;
    }
    let written = tx
        .execute(
            "INSERT INTO agent_operations
             (id, kind, tool_version, request_hash, actor_user_id, workspace_id, conversation_id,
              message_id, call_id, outcome, effect, undo_of)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'succeeded',$10,$11)
             ON CONFLICT DO NOTHING",
            &[
                &receipt.id,
                &receipt.kind,
                &receipt.tool_version,
                &receipt.request_hash,
                &receipt.actor,
                &receipt.workspace_id,
                &receipt.conversation_id,
                &receipt.message_id,
                &receipt.call_id,
                &receipt.effect,
                &receipt.undo_of,
            ],
        )
        .await?;
    if written == 0 {
        crate::observe::log(
            crate::observe::Level::Warn,
            "agent receipt passed over",
            serde_json::json!({ "operation": receipt.id, "room": material_id }),
        );
    }
    if let Some((held, edited)) = &receipt.held
        && !held.is_empty()
    {
        hold_agent(tx, material_id, held.clone(), *edited).await?;
    }
    Ok(())
}

/// A note's sessions as stored (`sessions.rs`): those seen within the cap
/// and the ids whose records were lost. A session record that cannot be read
/// is dropped alone (Q382, Epo 2026-10-26): its row is written lost
/// (`sessions::LOST`, its tab late when it returns, Q385) and the caller
/// reports it. The agent holds are not the room's (see [hold_agent]).
pub async fn load_sessions(
    pool: &Pool,
    material_id: &str,
) -> Result<(sessions::Sessions, sessions::Damaged), StoreError> {
    let client = pool.get().await?;
    let rows = client
        .query(
            "SELECT client_id, user_id, acked_version, seen_at, held FROM material_yjs_client_ids
             WHERE material_id=$1 AND document='content' AND NOT expired
               AND seen_at > now() - make_interval(hours => $2)",
            &[
                &material_id,
                &((sessions::COUNTED_FOR.as_secs() / 3600) as i32),
            ],
        )
        .await?;
    let lost = client
        .query(
            "SELECT client_id FROM material_yjs_client_ids
             WHERE material_id=$1 AND document='content' AND acked_version=$2",
            &[&material_id, &sessions::LOST],
        )
        .await?;
    let (sessions, damaged) = sessions::Sessions::load(
        rows.iter().map(|row| {
            (
                row.get::<_, i64>(0) as u64,
                row.get(1),
                row.get(2),
                row.get(3),
                row.get(4),
            )
        }),
        lost.iter().map(|row| row.get::<_, i64>(0) as u64),
    );
    if !damaged.sessions.is_empty() {
        let clients: Vec<i64> = damaged.sessions.iter().map(|&id| id as i64).collect();
        client
            .execute(
                "UPDATE material_yjs_client_ids SET acked_version=$3, seen_at=NULL, held=NULL
                 WHERE material_id=$1 AND document='content' AND client_id = ANY($2)",
                &[&material_id, &clients, &sessions::LOST],
            )
            .await?;
    }
    Ok((sessions, damaged))
}

/// Writes what changed of a note's sessions beside their client ids'
/// records, in one statement (review r1 L2): a live session's version and
/// last seen, its held deletions only when they changed (review r2 L4), an
/// ended one's cleared (the record's row is made if its first write's has
/// not landed yet). Never for an
/// account whose deletion began or ended (review r1 L5): a store locked the
/// live ones first (`lock_boundary`'s bystanders), so a purge waits for it
/// and then deletes what it wrote; the unload write (`save_sessions_now`)
/// only leaves out the accounts whose deletion began before its statement
/// (review r3 N2).
pub(crate) async fn save_sessions(
    tx: &Transaction<'_>,
    material_id: &str,
    unsaved: &sessions::Unsaved,
) -> Result<(), StoreError> {
    if !unsaved.rows.is_empty() {
        let (mut clients, mut users, mut versions, mut seen, mut changed, mut held) = (
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        );
        for row in &unsaved.rows {
            clients.push(row.client);
            users.push(row.user.as_str());
            versions.push(row.version);
            seen.push(row.seen);
            changed.push(row.held_changed);
            held.push(row.held.as_deref());
        }
        tx.execute(
            "INSERT INTO material_yjs_client_ids
               (material_id, document, client_id, user_id, acked_version, seen_at, held)
             SELECT $1, 'content', r.client, r.user_id, r.version, r.seen, r.held
             FROM unnest($2::bigint[], $3::text[], $4::bigint[], $5::timestamptz[],
                         $6::boolean[], $7::bytea[])
               AS r(client, user_id, version, seen, changed, held)
             JOIN users u ON u.id = r.user_id
               AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL
             ON CONFLICT (material_id, document, client_id) DO UPDATE
             SET acked_version=EXCLUDED.acked_version, seen_at=EXCLUDED.seen_at,
                 held=CASE WHEN (SELECT changed FROM unnest($2::bigint[], $6::boolean[])
                                   AS c(client, changed) WHERE c.client=EXCLUDED.client_id)
                      THEN EXCLUDED.held ELSE material_yjs_client_ids.held END
             WHERE material_yjs_client_ids.user_id=EXCLUDED.user_id",
            &[
                &material_id,
                &clients,
                &users,
                &versions,
                &seen,
                &changed,
                &held,
            ],
        )
        .await?;
    }
    Ok(())
}

/// Holds what an agent edit, or its Undo or Redo, deleted in a note
/// (`sessions::agent_held`, Q390): written in the write's own transaction,
/// which holds the document row, whether or not a room is loaded, so no
/// fold collects what its Undo payload may restore (P2). `edited` is the
/// agent edit's time. A stored record that cannot be read is dropped and
/// reported, and the write goes on (Q386).
pub(crate) async fn hold_agent(
    tx: &Transaction<'_>,
    material_id: &str,
    ids: yrs::IdSet,
    edited: std::time::SystemTime,
) -> Result<(), StoreError> {
    let stored: Option<Vec<u8>> = tx
        .query_one(
            "SELECT agent_held FROM material_yjs_documents WHERE material_id=$1",
            &[&material_id],
        )
        .await?
        .get(0);
    let now = std::time::SystemTime::now();
    let (held, damaged) = sessions::agent_held(stored.as_deref(), ids, edited, now);
    if damaged {
        unreadable_agent_holds(material_id);
    }
    if held != stored {
        tx.execute(
            "UPDATE material_yjs_documents SET agent_held=$2 WHERE material_id=$1",
            &[&material_id, &held],
        )
        .await?;
    }
    Ok(())
}

/// Q386 (Epo 2026-10-26): an agent holds record that cannot be read is
/// dropped and reported; the note loads and is written as before.
fn unreadable_agent_holds(material_id: &str) {
    crate::observe::capture(
        "unreadable agent holds",
        None,
        &[("room", material_id), ("stage", "agent_holds")],
    );
}

/// The sessions' rows when a note room unloads (the acknowledgements and
/// departures after its last store): best effort, since older rows only
/// count a session for less long or at an older version.
pub async fn save_sessions_now(
    pool: &Pool,
    material_id: &str,
    unsaved: &sessions::Unsaved,
) -> Result<(), StoreError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    // The document row first, as a store takes it (review r2 L5); the
    // users are filtered, not locked, so no account lock follows it.
    tx.execute(
        "SELECT 1 FROM material_yjs_documents WHERE material_id=$1 FOR NO KEY UPDATE",
        &[&material_id],
    )
    .await?;
    save_sessions(&tx, material_id, unsaved).await?;
    tx.commit().await?;
    Ok(())
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

/// What a fold removed from the log, and the new base size; with a
/// collection, its window and held set, at which the open room collects its
/// own document (Q401).
pub struct Folded {
    pub rows: usize,
    pub log_bytes: i64,
    pub base_bytes: i64,
    pub collected: Option<(Window, IdSet)>,
}

/// What a fold's collection must keep (`ydoc::gc`), from the room's
/// sessions (`sessions::Holds`).
pub struct Holds {
    /// The oldest stored_version every counted session has reached: the
    /// window is the newest snapshot stored at or before it. None when no
    /// session is counted: the window is the folded document itself.
    pub reached: Option<i64>,
    /// H: what may still be restored, so nothing next to it is collected:
    /// what counted sessions deleted (their Undo) and what agent steps
    /// deleted (their Undo and Redo re-create it, naming the deleted items).
    pub held: IdSet,
    /// The open room's own client, whose contributor-marker chains stay.
    pub live_room: Option<ClientID>,
    /// Whether no other life of the room is loaded, asked under the
    /// material's lock: one loaded before this fold checks JOINs against
    /// the window it read, so the fold then collects nothing; one loading
    /// after it waits for the lock and reads the window this fold writes.
    /// False too while another collaboration process is seen (L1).
    pub alone: Box<dyn Fn() -> bool + Send>,
}

/// Window snapshots a document keeps (`material_yjs_windows`): the newest of
/// each hour, for the latest this many hours that have one (Q400), so a
/// collection can reach a session counted up to 24 h back.
const WINDOW_HOURS: i64 = 25;

/// Debug builds only: the integration tests' collection that panics, for a
/// material whose id holds this.
const IT_PANIC_COLLECTION: &str = "capy-it-panic-collection";

/// Debug builds only: the integration tests' fold that waits 5 s before it
/// starts, for a material whose id holds this.
const IT_FOLD_LATER: &str = "capy-it-fold-later";

/// Debug builds only: the integration tests' store that waits 3 s before it
/// starts, for a material whose id holds this.
const IT_STORE_LATER: &str = "capy-it-store-later";

/// Debug builds only: the integration tests' fold that, having discarded
/// units, returns 3 s after it committed, for a material whose id holds
/// this: its open room still holds what the stored copy collected meanwhile.
const IT_FOLDED_LATER: &str = "capy-it-folded-later";

/// Merges the base and the rows up to `through` (all when `None`) into a new
/// base after the load check (DESIGN.md 3.5). Rows appended meanwhile stay.
/// With `holds` (the collection's switch on, notes only) the new base is
/// collected in place at the window the holds choose, when one qualifies,
/// that window's version is kept as the latest (`collected_window`), and
/// the folded document is stored as a later window candidate. A collection
/// the guard refuses, or that panics, folds uncollected and is reported once
/// per material (human/ 2026-10-24); the next fold collects again.
pub async fn fold(
    pool: &Pool,
    material_id: &str,
    schema: i64,
    doc: Doc,
    through: Option<i64>,
    holds: Option<Holds>,
) -> Result<Option<Folded>, StoreError> {
    if cfg!(debug_assertions) && material_id.contains(IT_FOLD_LATER) {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    access::lock_material(&tx, material_id).await?;
    let (state_table, log) = doc.tables();
    let current = tx
        .query(
            &format!(
                "SELECT s.state, d.room_schema, d.agent_held, m.kind
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
    // What the agent holds keep, read under the document row this fold
    // holds, so it covers every row it folds: the collection's part of H
    // beside the room's session holds (never from room memory: holds of an
    // edit not stored yet belong to rows past `through`). The open room's
    // live pass takes the same H (`Folded::collected`).
    let mut holds = holds;
    if doc == Doc::Content && current.get::<_, String>("kind") == "note" {
        let stored: Option<Vec<u8>> = current.get("agent_held");
        let (held, damaged) =
            sessions::agent_holds(stored.as_deref(), std::time::SystemTime::now());
        // Dropped once reported (Q386, review r2 L1): later folds read none.
        if damaged {
            unreadable_agent_holds(material_id);
            tx.execute(
                "UPDATE material_yjs_documents SET agent_held=NULL WHERE material_id=$1",
                &[&material_id],
            )
            .await?;
        }
        if let Some(holds) = holds.as_mut() {
            holds.held.merge_with(held);
        }
    }
    let rows = doc_rows(&tx, doc, material_id, through).await?;
    let Some(&(last, _)) = rows.last() else {
        // Nothing to fold; a dropped holds record still commits.
        tx.commit().await?;
        return Ok(None);
    };
    let windows = match holds {
        Some(_) => windows(&tx, material_id, doc).await?,
        None => Vec::new(),
    };
    let alone = holds.as_ref().is_some_and(|holds| (holds.alone)());
    let folded_bytes: i64 = rows.iter().map(|(_, row)| row.len() as i64).sum();
    let count = rows.len();
    let it_panic = cfg!(debug_assertions) && material_id.contains(IT_PANIC_COLLECTION);
    // The state, the folded document as a window candidate, the window and
    // held set of a collection, why the guard refused one, and the units it
    // discarded.
    type Built = (
        Vec<u8>,
        Option<Window>,
        Option<(Window, IdSet)>,
        Option<String>,
        u64,
    );
    let (state, window, collected, refused, discarded) =
        tokio::task::spawn_blocking(move || -> Result<Built, StoreError> {
            let scratch = ydoc::scratch_doc();
            let updates: Vec<Vec<u8>> = rows.into_iter().map(|(_, row)| row).collect();
            ydoc::replay(&scratch, &base, &updates)
                .map_err(|error| StoreError::Other(error.to_string()))?;
            let txn = scratch.transact();
            model.assert_roots(&txn).map_err(StoreError::Invalid)?;
            let Some(holds) = holds else {
                return Ok((whole(&scratch), None, None, None, 0));
            };
            let now = Window::of(&txn, last);
            drop(txn);
            let window = match holds.reached {
                None => Some(&now),
                Some(reached) => ydoc::gc::window_for(&windows, reached),
            }
            .filter(|_| alone);
            let Some(window) = window else {
                return Ok((whole(&scratch), Some(now), None, None, 0));
            };
            let collected = guarded(|| {
                if it_panic {
                    panic!("integration test collection panic");
                }
                let collected = ydoc::gc::collect(&scratch, window, &holds.held, holds.live_room);
                loaded(&collected.state, &scratch, model, 0)?;
                Ok(collected)
            });
            Ok(match collected {
                Ok(collected) => {
                    let at = (window.clone(), holds.held);
                    (collected.state, Some(now), Some(at), None, collected.units)
                }
                Err(why) => (whole(&scratch), Some(now), None, Some(why), 0),
            })
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
    if let Some(window) = window {
        store_window(&tx, material_id, doc, &window).await?;
    }
    if let Some((window, _)) = &collected {
        tx.execute(
            "UPDATE material_yjs_documents SET collected_window=GREATEST(collected_window, $2)
             WHERE material_id=$1",
            &[&material_id, &window.stored_version],
        )
        .await?;
    }
    tx.commit().await?;
    if let Some(why) = refused {
        report_refusal(material_id, doc, "fold", &why);
    }
    if cfg!(debug_assertions) && discarded > 0 && material_id.contains(IT_FOLDED_LATER) {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
    Ok(Some(Folded {
        rows: count,
        log_bytes: folded_bytes,
        base_bytes: after_bytes,
        collected,
    }))
}

/// The open room's document collected at its threshold fold's window and
/// held set (Q401), loaded into a new document under the room's client id,
/// whose own marker chains stay. None when nothing was discarded; the
/// guard's reason (or the panic's) when the new document loads with
/// something pending, lacks the model's roots or holds another value.
pub fn collect_live(
    doc: &yrs::Doc,
    window: &Window,
    held: &IdSet,
    model: Model,
) -> Result<Option<(yrs::Doc, u64)>, String> {
    guarded(|| {
        let client = doc.client_id();
        let collected = ydoc::gc::collect(doc, window, held, Some(client));
        if collected.units == 0 {
            return Ok(None);
        }
        let live = loaded(&collected.state, doc, model, client.get())?;
        Ok(Some((live, collected.units)))
    })
}

fn whole(doc: &yrs::Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

/// The guard: the collected `state` loaded into a new document under
/// `client` (0: any), if it loads with nothing pending, keeps the model's
/// roots and holds the state vector and document value of `before`
/// (joiners, open tabs and the room's durable cover rely on the vector);
/// otherwise why not.
fn loaded(state: &[u8], before: &yrs::Doc, model: Model, client: u64) -> Result<yrs::Doc, String> {
    let loaded = yrs::Doc::with_options(ydoc::doc_options(client));
    ydoc::replay(&loaded, state, &[] as &[&[u8]]).map_err(|error| error.to_string())?;
    {
        let (before, after) = (before.transact(), loaded.transact());
        model.assert_roots(&after)?;
        if model.document_value(&before)? != model.document_value(&after)? {
            return Err("the collected state holds another value".into());
        }
        if before.state_vector() != after.state_vector() {
            return Err("the collected state holds another state vector".into());
        }
    }
    Ok(loaded)
}

/// `collect` (a collection and its guard) with a panic in it counted as a
/// refusal, with why. Its panic event is muted (no client on the hub it runs
/// under), so it reaches Sentry once, as a refusal.
fn guarded<T>(collect: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let muted = Arc::new(sentry::Hub::new(None, Arc::new(Default::default())));
    let ran = sentry::Hub::run(muted, || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(collect))
    });
    ran.unwrap_or_else(|panic| {
        let why = panic
            .downcast_ref::<&str>()
            .map(|why| (*why).to_owned())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_default();
        Err(format!("panicked: {why}"))
    })
}

/// Materials whose refused collection this process reported.
static REPORTED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// Reports a refused collection (`stage`: the stored fold's, or the open
/// room's live one) to Sentry the first time for its material in this
/// process, and logs every one; whether it reported.
pub fn report_refusal(material_id: &str, doc: Doc, stage: &str, why: &str) -> bool {
    let first = REPORTED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(material_id.to_owned());
    log(
        Level::Info,
        "in-place collection refused",
        serde_json::json!({
            "room": material_id,
            "document": doc.name(),
            "error": why,
            "reported": first,
            "stage": stage,
        }),
    );
    if first {
        observe::capture(
            &format!("in-place collection refused, kept uncollected: {why}"),
            None,
            &[
                ("room", material_id),
                ("file_id", material_id),
                ("document", doc.name()),
                ("stage", stage),
            ],
        );
    }
    first
}

/// A document's window snapshots.
async fn windows(
    tx: &Transaction<'_>,
    material_id: &str,
    doc: Doc,
) -> Result<Vec<Window>, StoreError> {
    let rows = tx
        .query(
            "SELECT stored_version, state_vector, delete_set FROM material_yjs_windows
             WHERE material_id=$1 AND document=$2",
            &[&material_id, &doc.name()],
        )
        .await?;
    let invalid = |error: yrs::encoding::read::Error| {
        StoreError::Other(format!("invalid window snapshot: {error}"))
    };
    rows.iter()
        .map(|row| {
            Ok(Window {
                stored_version: row.get("stored_version"),
                state_vector: StateVector::decode_v1(row.get("state_vector")).map_err(invalid)?,
                delete_set: IdSet::decode_v1(row.get("delete_set")).map_err(invalid)?,
            })
        })
        .collect()
}

/// Stores `window` as a later collection's candidate and keeps the newest of
/// each hour, for the latest [WINDOW_HOURS] hours that have one.
async fn store_window(
    tx: &Transaction<'_>,
    material_id: &str,
    doc: Doc,
    window: &Window,
) -> Result<(), StoreError> {
    tx.execute(
        "INSERT INTO material_yjs_windows
           (material_id, document, stored_version, state_vector, delete_set)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        &[
            &material_id,
            &doc.name(),
            &window.stored_version,
            &window.state_vector.encode_v1(),
            &window.delete_set.encode_v1(),
        ],
    )
    .await?;
    tx.execute(
        "DELETE FROM material_yjs_windows
         WHERE material_id=$1 AND document=$2 AND stored_version NOT IN (
           SELECT DISTINCT ON (date_trunc('hour', created_at)) stored_version
           FROM material_yjs_windows
           WHERE material_id=$1 AND document=$2
           ORDER BY date_trunc('hour', created_at) DESC, stored_version DESC
           LIMIT $3)",
        &[&material_id, &doc.name(), &WINDOW_HOURS],
    )
    .await?;
    Ok(())
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
    // The old lineage's sessions end with it: their tabs never rejoin this
    // one (review r2 L3).
    if moved > 0 {
        tx.execute(
            "UPDATE material_yjs_client_ids SET seen_at=NULL, held=NULL
             WHERE material_id=$1 AND document='content'",
            &[&material_id],
        )
        .await?;
    }
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

#[cfg(test)]
mod tests {
    use yrs::Text;

    use super::*;

    fn note(text: &str) -> yrs::Doc {
        let doc = ydoc::scratch_doc();
        let value = [serde_json::json!({"type": "p", "id": "b1", "children": [{"text": text}]})];
        ydoc::replay(
            &doc,
            &Model::Note.state_from_value(&value).unwrap(),
            &[] as &[&[u8]],
        )
        .unwrap();
        doc
    }

    fn state(doc: &yrs::Doc) -> Vec<u8> {
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// The guard (human/ 2026-10-24): a collected state passes only when it
    /// loads, with nothing pending, to the value it was collected from, under
    /// the client asked for (the open room's own, Q401); otherwise why not,
    /// and the fold writes its document whole.
    #[test]
    fn the_guard_passes_only_the_same_value_with_nothing_pending() {
        let folded = note("kept");
        let live = loaded(&state(&folded), &folded, Model::Note, 77).unwrap();
        assert_eq!(live.client_id().get(), 77);
        let lost = loaded(&state(&note("lost")), &folded, Model::Note, 0);
        assert!(lost.is_err_and(|why| why.contains("another value")));
        // An update naming structs the state does not hold.
        let later = ydoc::scratch_doc();
        ydoc::replay(&later, &state(&folded), &[] as &[&[u8]]).unwrap();
        let before = later.transact().state_vector();
        later
            .get_or_insert_text(notes::CONTENT_ROOT)
            .insert(&mut later.transact_mut(), 0, "x");
        let tail = later.transact().encode_state_as_update_v1(&before);
        assert!(loaded(&tail, &folded, Model::Note, 0).is_err());
        // The same value with a letter typed and deleted: another state vector.
        let typed = ydoc::scratch_doc();
        ydoc::replay(&typed, &state(&folded), &[] as &[&[u8]]).unwrap();
        let block = first_block(&typed);
        block.insert(&mut typed.transact_mut(), 0, "x");
        block.remove_range(&mut typed.transact_mut(), 0, 1);
        let moved = loaded(&state(&typed), &folded, Model::Note, 0);
        assert!(moved.is_err_and(|why| why.contains("state vector")));
    }

    /// The note's first block (a Plate paragraph's text).
    fn first_block(doc: &yrs::Doc) -> yrs::XmlTextRef {
        let root = doc.get_or_insert_text(notes::CONTENT_ROOT);
        root.diff(&doc.transact(), yrs::types::text::YChange::identity)
            .into_iter()
            .find_map(|chunk| match chunk.insert {
                yrs::Out::YXmlText(block) => Some(block),
                _ => None,
            })
            .unwrap()
    }

    /// The open room's own collection (Q401) keeps the room's client and its
    /// contributor-marker chain, claimed or not, while it drops a run no one
    /// holds: the room writes on under its id, against the chain the stored
    /// fold keeps too (Q419). Fails if the live pass collects as the unload
    /// fold does (no live room: the chain goes whole) or loads under another
    /// client.
    #[test]
    fn the_open_rooms_collection_keeps_its_client_and_marker_chain() {
        let client = ClientID::new(4242);
        let room = yrs::Doc::with_options(ydoc::doc_options(client.get()));
        ydoc::replay(&room, &state(&note("base")), &[] as &[&[u8]]).unwrap();
        // "xz", then "y" typed between and all three deleted: y is an item
        // nothing names.
        let block = first_block(&room);
        block.insert(&mut room.transact_mut(), 4, "xz");
        let y = yrs::ID::new(client, room.transact().state_vector().get(&client));
        block.insert(&mut room.transact_mut(), 5, "y");
        block.remove_range(&mut room.transact_mut(), 4, 3);
        // A writer's marker, written and claimed.
        let markers = room.get_or_insert_map(ydoc::CONTRIBUTORS_ROOT);
        let marker = yrs::ID::new(client, room.transact().state_vector().get(&client));
        yrs::Map::insert(&markers, &mut room.transact_mut(), "w", "write");
        yrs::Map::remove(&markers, &mut room.transact_mut(), "w");
        let window = Window::of(&room.transact(), 1);
        let (live, units) = collect_live(&room, &window, &IdSet::new(), Model::Note)
            .unwrap()
            .expect("a collection");
        assert!(units > 0);
        assert_eq!(live.client_id(), client);
        let txn = live.transact();
        assert!(matches!(txn.store().get_block_range(&y), Some((_, None))));
        assert!(
            matches!(txn.store().get_block_range(&marker), Some((_, Some(_)))),
            "the room's own marker chain was collected"
        );
    }

    /// A panic in the collection or its guard is a refusal, with why, and no
    /// Sentry event of its own (the refusal is reported once instead).
    #[test]
    fn a_panicking_collection_is_a_refusal() {
        let mut result = None;
        let events = sentry::test::with_captured_events_options(
            || result = Some(guarded::<()>(|| panic!("collector bug"))),
            sentry::ClientOptions::new()
                .add_integration(sentry::integrations::panic::PanicIntegration::new()),
        );
        assert_eq!(result.unwrap(), Err("panicked: collector bug".to_owned()));
        assert!(events.is_empty(), "{events:?}");
    }

    /// A material's refusals reach Sentry once, tagged with its id as
    /// `file_id` (what the UAT journeys' Sentry gate and operators search);
    /// another material's still do.
    #[test]
    fn a_refusal_is_reported_once_per_material() {
        let events = sentry::test::with_captured_events(|| {
            assert!(report_refusal(
                "m_refused_once",
                Doc::Content,
                "fold",
                "why"
            ));
            assert!(!report_refusal(
                "m_refused_once",
                Doc::Content,
                "live",
                "why"
            ));
            assert!(!report_refusal("m_refused_once", Doc::Keys, "fold", "why"));
            assert!(report_refusal(
                "m_refused_other",
                Doc::Content,
                "fold",
                "why"
            ));
        });
        let files: Vec<_> = events
            .iter()
            .map(|event| event.tags.get("file_id").map(String::as_str))
            .collect();
        assert_eq!(files, [Some("m_refused_once"), Some("m_refused_other")]);
    }
}
