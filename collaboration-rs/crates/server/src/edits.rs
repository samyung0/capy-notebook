//! The gateway's internal document routes (`server.ts` handleDocumentRequest,
//! handleServiceCommandRequest, handleMarkdownRequest): direct AI edits of a
//! material or a source, their Undo, the inspect view, the replace-block
//! command and agent markdown. A material edit runs on an isolated document
//! (the durable base and rows merged with this instance's live room) under
//! the material lock, and commits its row with the receipt in one
//! transaction; only the committed change then reaches the live room, whose
//! durable cover takes it in (DESIGN.md 3.2). The room keeps the edit's own
//! Yjs items while it stays loaded, and Undo and Redo revert them there
//! (`ydoc::undo`, Epo 2026-10-20); an edit made with no room loaded has no
//! Undo.

use std::collections::HashSet;
use std::time::Duration;

use notes::edit::{DocumentCommand, EditError, EditOutcome};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use ydoc::undo::Captured;
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, Snapshot, StateVector, Transact};

use crate::access::{self, AccessError};
use crate::app::Shared;
use crate::auth::RoomName;
use crate::markers;
use crate::model::Model;
use crate::note_store;
use crate::observe;
use crate::projection;
use crate::room::{AgentUndo, Reverted, RoomCmd, ServiceEdit};
/// How long a live room may take to hand over its state.
const SNAPSHOT_WAIT: Duration = Duration::from_secs(10);

/// Why a document request failed, as the gateway reads it.
#[derive(Debug)]
pub enum DocumentError {
    /// 400: the request itself.
    Invalid(String),
    /// 409 with the edit's code (`stale_target`, `unavailable_target`, ...)
    /// and, for a missed target, what it looks like now (passed through to
    /// the agent by the gateway).
    Edit {
        code: String,
        message: String,
        details: Option<Value>,
    },
    /// 403 `lifecycle_rejected`: the actor or the owner may not change it.
    Lifecycle(String),
    /// 422 `quota_rejected`: a shape bound.
    Quota(String),
    /// A source refusal: its status, its code by status.
    Source { status: u16, message: String },
    /// 503 `unavailable_target`: the room is being reset or compacted. The
    /// edit was refused before anything applied, so the outcome is known and
    /// the caller may retry; logged, not reported.
    Unavailable(&'static str),
    /// 503 `outcome_unknown` (reported).
    Unknown(String),
}

/// An edit's refusal while its room is reset or discarded ([DocumentError::Unavailable]).
pub const ROOM_RESET: &str = "collaboration room is being reset";
/// An edit's refusal while its room is under the eviction lease.
pub const ROOM_COMPACTING: &str = "collaboration room is being compacted";
/// A write whose update is over `ydoc::MAX_UPDATE_BYTES` (Epo 2026-10-18),
/// refused before anything commits: the agent's `quota_rejected` reason, the
/// replace-block command's 413.
pub const UPDATE_TOO_LARGE: &str = "update_size_exceeded";

/// Whether any of an edit's writes, as stored or as sent to the live room,
/// is over the update cap.
fn over_update_cap(writes: &[Write]) -> bool {
    writes.iter().any(|write| {
        write.row.len() > ydoc::MAX_UPDATE_BYTES
            || write
                .live_update
                .as_ref()
                .is_some_and(|update| update.len() > ydoc::MAX_UPDATE_BYTES)
    })
}

impl DocumentError {
    pub fn status_and_body(&self) -> (u16, Value) {
        match self {
            DocumentError::Invalid(message) => {
                (400, json!({ "code": "invalid_input", "message": message }))
            }
            DocumentError::Edit {
                code,
                message,
                details,
            } => {
                let mut body = json!({ "code": code, "message": message });
                if let Some(details) = details {
                    body["details"] = details.clone();
                }
                (409, body)
            }
            DocumentError::Lifecycle(message) => (
                403,
                json!({ "code": "lifecycle_rejected", "message": message }),
            ),
            DocumentError::Quota(message) => {
                (422, json!({ "code": "quota_rejected", "message": message }))
            }
            DocumentError::Source { status, message } => {
                let code = match status {
                    409 => "stale_target",
                    423 => "office_editing_paused",
                    _ => "unavailable_target",
                };
                (*status, json!({ "code": code, "message": message }))
            }
            DocumentError::Unavailable(message) => (
                503,
                json!({ "code": "unavailable_target", "message": message }),
            ),
            DocumentError::Unknown(_) => (
                503,
                json!({ "code": "outcome_unknown", "message": "document edit failed" }),
            ),
        }
    }

    /// What went wrong, for the report of an unknown outcome.
    pub fn message(&self) -> &str {
        match self {
            DocumentError::Invalid(message)
            | DocumentError::Lifecycle(message)
            | DocumentError::Quota(message)
            | DocumentError::Unknown(message) => message,
            DocumentError::Edit { message, .. } | DocumentError::Source { message, .. } => message,
            DocumentError::Unavailable(message) => message,
        }
    }

    fn edit(code: &str, message: impl Into<String>) -> Self {
        DocumentError::Edit {
            code: code.to_owned(),
            message: message.into(),
            details: None,
        }
    }
}

impl From<EditError> for DocumentError {
    fn from(error: EditError) -> Self {
        match error {
            EditError::Edit {
                code,
                message,
                details,
            } => DocumentError::Edit {
                code: serde_json::to_value(code)
                    .ok()
                    .and_then(|code| code.as_str().map(str::to_owned))
                    .unwrap_or_else(|| "invalid_input".into()),
                message,
                details,
            },
            other => DocumentError::Unknown(other.to_string()),
        }
    }
}

impl From<AccessError> for DocumentError {
    fn from(error: AccessError) -> Self {
        match error {
            AccessError::Database(message) => DocumentError::Unknown(message),
            other => DocumentError::Lifecycle(other.to_string()),
        }
    }
}

impl From<note_store::StoreError> for DocumentError {
    fn from(error: note_store::StoreError) -> Self {
        match error {
            note_store::StoreError::Access(error) => error.into(),
            note_store::StoreError::Limit { code, .. } => {
                DocumentError::Quota(code.as_str().into())
            }
            other => DocumentError::Unknown(other.to_string()),
        }
    }
}

impl From<tokio_postgres::Error> for DocumentError {
    fn from(error: tokio_postgres::Error) -> Self {
        DocumentError::Unknown(error.to_string())
    }
}

impl From<sources::SourceError> for DocumentError {
    fn from(error: sources::SourceError) -> Self {
        match error {
            sources::SourceError::Edit {
                code,
                message,
                details,
            } => DocumentError::Edit {
                code,
                message,
                details,
            },
            sources::SourceError::Request {
                status, message, ..
            } => DocumentError::Source { status, message },
            other => DocumentError::Unknown(other.to_string()),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub kind: String,
}

/// `DocumentRequest`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRequest {
    pub actor_user_id: String,
    #[serde(default)]
    pub commands: Vec<Value>,
    /// An agent's scoped Office read (`inspect_office_document`).
    pub office: Option<Value>,
    pub operation: Option<Operation>,
    pub provenance: Option<Value>,
    pub room: Option<String>,
    pub target: Target,
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    pub request_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_version: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
}

fn parse<T: serde::de::DeserializeOwned>(value: Value, what: &str) -> Result<T, DocumentError> {
    serde_json::from_value(value)
        .map_err(|error| DocumentError::edit("invalid_input", format!("invalid {what}: {error}")))
}

/// The material room a request names (its material and lineage).
fn material_room(request: &DocumentRequest) -> Result<(String, String, i64), DocumentError> {
    let room = request
        .room
        .clone()
        .ok_or_else(|| DocumentError::edit("invalid_input", "room is required"))?;
    match RoomName::parse(&room) {
        Some(RoomName::Material {
            material_id,
            schema,
            keys: false,
        }) => Ok((room, material_id, schema)),
        _ => Err(DocumentError::edit(
            "invalid_input",
            "invalid material room",
        )),
    }
}

/// `inspectMaterialDocument`: the blocks as the editors see them now, the
/// stored document with this replica's live rooms merged in (unsaved
/// typing), as an edit reads it; no room load, no bootstrap write.
pub async fn inspect_material(
    app: &Shared,
    request: &DocumentRequest,
) -> Result<Value, DocumentError> {
    let (_, material_id, schema) = material_room(request)?;
    let blocks = material_blocks(app, &material_id, schema).await?;
    Ok(json!({ "blocks": blocks, "roomSchema": schema }))
}

/// A material's blocks in the room of `schema`, as [inspect_material] shows
/// them.
async fn material_blocks(
    app: &Shared,
    material_id: &str,
    schema: i64,
) -> Result<Vec<notes::edit::InspectedBlock>, DocumentError> {
    let room = format!("material:{material_id}:schema:{schema}");
    let mut client = app
        .db
        .get()
        .await
        .map_err(|error| DocumentError::Unknown(error.to_string()))?;
    // One snapshot of the base and its rows (a fold may commit between them).
    let tx = client
        .build_transaction()
        .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
        .start()
        .await?;
    let found = tx
        .query(
            "SELECT d.state, d.room_schema, m.kind FROM material_yjs_documents d
             JOIN materials m ON m.id=d.material_id WHERE d.material_id=$1",
            &[&material_id],
        )
        .await?;
    let stored = !found.is_empty();
    let mut kind = found
        .first()
        .map(|row| row.get::<_, String>("kind"))
        .unwrap_or_default();
    let mut keys: Option<(Vec<u8>, Vec<Vec<u8>>)> = None;
    let (base, mut rows) = match found.first() {
        Some(row) => {
            if i64::from(row.get::<_, i32>("room_schema")) != schema {
                return Err(DocumentError::edit(
                    "stale_target",
                    "the material was rebuilt since it was opened",
                ));
            }
            let rows: Vec<Vec<u8>> = note_store::rows(&tx, material_id, None)
                .await?
                .into_iter()
                .map(|(_, row)| row)
                .collect();
            if kind == "quiz" {
                keys = Some(quiz_keys(&tx, material_id).await?);
            }
            (row.get::<_, Vec<u8>>("state"), rows)
        }
        None => {
            let found = tx
                .query(
                    "SELECT content, kind FROM materials WHERE id=$1 AND trashed_at IS NULL",
                    &[&material_id],
                )
                .await?;
            let Some(row) = found.first() else {
                return Err(DocumentError::edit(
                    "unavailable_target",
                    "material not found",
                ));
            };
            kind = row.get("kind");
            let content: Value = row.get("content");
            let value = note_store::envelope_value(&content).map_err(|_| {
                DocumentError::edit(
                    "unavailable_target",
                    "material content is not a valid Plate envelope",
                )
            })?;
            if kind == "quiz" {
                let (content, quiz_keys) = items::quiz::states_from_value(value, 0);
                keys = Some((quiz_keys, Vec::new()));
                (content, Vec::new())
            } else {
                (Model::of(&kind).state_from_value(value), Vec::new())
            }
        }
    };
    tx.commit().await?;
    // A live room's state replays after the rows. A room stores its document
    // when it loads, so only a stored one can have a room; with none loaded,
    // this reads nothing more.
    if stored {
        rows.extend(live_state(app, &room).await);
        if let Some((_, key_rows)) = &mut keys {
            let keys_room = format!("keys:{material_id}:schema:{schema}");
            key_rows.extend(live_state(app, &keys_room).await);
        }
    }
    tokio::task::spawn_blocking(move || -> Result<_, DocumentError> {
        let doc = ydoc::scratch_doc();
        ydoc::replay(&doc, &base, &rows)
            .map_err(|error| DocumentError::Unknown(error.to_string()))?;
        // A live item reads as the Plate value it projects to; a quiz as
        // every question with its keys (its editors' view, incomplete ones
        // too).
        let doc = match Model::of(&kind) {
            Model::Note => doc,
            model => {
                let value = match &keys {
                    Some((base, rows)) => {
                        let keys = ydoc::scratch_doc();
                        ydoc::replay(&keys, base, rows)
                            .map_err(|error| DocumentError::Unknown(error.to_string()))?;
                        items::quiz::editor_value(&doc.transact(), &keys.transact())
                    }
                    None => model
                        .value(&doc.transact())
                        .map_err(DocumentError::Unknown)?,
                };
                let plate = ydoc::scratch_doc();
                ydoc::replay(
                    &plate,
                    &notes::slate_yjs::state_from_value(&value, 0),
                    &[] as &[Vec<u8>],
                )
                .map_err(|error| DocumentError::Unknown(error.to_string()))?;
                plate
            }
        };
        Ok(notes::edit::inspect_material(&doc.transact())?)
    })
    .await
    .map_err(|error| DocumentError::Unknown(error.to_string()))?
}

/// This instance's live copy of `room`, when it has the room loaded.
async fn live_state(app: &Shared, room: &str) -> Option<Vec<u8>> {
    let handle = app.rooms.get(room)?;
    let (reply, answer) = oneshot::channel();
    handle.tx.send(RoomCmd::Snapshot(reply)).await.ok()?;
    tokio::time::timeout(SNAPSHOT_WAIT, answer).await.ok()?.ok()
}

/// The client ids bound to a loaded room's live channels (r2 N7): a
/// session's id is unrecorded until its first write, and a scratch id avoids
/// it too. An unloaded room has none.
async fn live_ids(app: &Shared, room: &str) -> HashSet<u64> {
    let Some(handle) = app.rooms.get(room) else {
        return HashSet::new();
    };
    let (reply, answer) = oneshot::channel();
    if handle.tx.send(RoomCmd::LiveIds(reply)).await.is_err() {
        return HashSet::new();
    }
    match tokio::time::timeout(SNAPSHOT_WAIT, answer).await {
        Ok(Ok(live)) => live,
        _ => HashSet::new(),
    }
}

/// One document a server edit changed: its row, the cover it makes, what
/// its live room lacks of it, and the edit's own items when that room was
/// loaded (its Undo).
struct Write {
    doc: note_store::Doc,
    row: Vec<u8>,
    durable: ydoc::Durable,
    live_update: Option<Vec<u8>>,
    captured: Option<Captured>,
}

/// What an edit computed on its isolated documents.
struct Computed {
    /// One per changed document (a quiz may change both).
    writes: Vec<Write>,
    value: Vec<Value>,
    /// A quiz: every editor asset its documents reference (REVIEW1 S4).
    asset_ids: Option<Vec<String>>,
    outcome: EditOutcome,
    /// What the edit's Undo may send ([undo_cost]).
    undo_cost: usize,
}

/// What an edit's Undo may send (`sources::undo_cost`, Epo 2026-10-21): its
/// commands read against the documents as they were (a quiz: both).
fn undo_cost(commands: &[DocumentCommand], before: &[&[Value]]) -> usize {
    commands
        .iter()
        .map(|command| sources::undo_cost::document(command, |id| touched(before, id)))
        .fold(0, usize::saturating_add)
}

/// The JSON size of the nodes with id `id` in `documents` (a quiz question
/// has one in each of its documents).
fn touched(documents: &[&[Value]], id: &str) -> usize {
    fn size(value: &Value, id: &str) -> usize {
        match value {
            Value::Object(map) if map.get("id").and_then(Value::as_str) == Some(id) => {
                serde_json::to_string(value).map_or(0, |json| json.len())
            }
            Value::Object(map) => map.values().map(|value| size(value, id)).sum(),
            Value::Array(values) => values.iter().map(|value| size(value, id)).sum(),
            _ => 0,
        }
    }
    documents
        .iter()
        .flat_map(|nodes| nodes.iter())
        .map(|node| size(node, id))
        .sum()
}

/// A document for a server edit: the durable state, then the live room
/// merged in, under a client the stored document does not hold.
struct Scratch {
    doc: yrs::Doc,
    durable: ydoc::Durable,
    live: Option<StateVector>,
    /// Inserts and deletions both: an edit that only removes moves no state
    /// vector.
    before: Snapshot,
}

impl Scratch {
    fn new(
        base: &[u8],
        rows: &[Vec<u8>],
        live: Option<&[u8]>,
        assigned: &HashSet<u64>,
    ) -> Result<Scratch, String> {
        let stored = ydoc::scratch_doc();
        ydoc::replay(&stored, base, rows).map_err(|error| error.to_string())?;
        let held = stored.transact().state_vector();
        let doc = loop {
            let doc = ydoc::scratch_doc();
            if held.get(&doc.client_id()) == 0 && !assigned.contains(&doc.client_id().get()) {
                break doc;
            }
        };
        let whole = stored
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        ydoc::apply(
            &doc,
            ydoc::decode(&whole).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let durable = ydoc::Durable::of(&doc.transact());
        let live = match live {
            Some(live) => {
                let update = yrs::Update::decode_v1(live).map_err(|error| error.to_string())?;
                let vector = update.state_vector();
                ydoc::apply(&doc, update).map_err(|error| error.to_string())?;
                Some(vector)
            }
            None => None,
        };
        let before = doc.transact().snapshot();
        Ok(Scratch {
            doc,
            durable,
            live,
            before,
        })
    }

    /// Whether the edit inserted or deleted anything.
    fn changed(&self) -> bool {
        self.doc.transact().snapshot() != self.before
    }

    /// The document's write, or none when the edit left it as it was.
    /// `captured` is kept only when a live room took part.
    fn write(&self, doc: note_store::Doc, captured: Option<Captured>) -> Option<Write> {
        if !self.changed() {
            return None;
        }
        let hidden = markers::live_items(&self.doc);
        let txn = self.doc.transact();
        let (row, durable) = ydoc::delta_update(&txn, &self.durable, &hidden);
        let live_update = self
            .live
            .as_ref()
            .map(|vector| txn.encode_state_as_update_v1(vector));
        Some(Write {
            doc,
            row,
            durable,
            live_update,
            captured: captured.filter(|_| self.live.is_some()),
        })
    }
}

/// A quiz's keys document base and log, under the caller's snapshot.
/// The client ids assigned to users in a material's documents (Q213): a
/// server edit's scratch id avoids them (Q226).
async fn assigned_ids(
    tx: &deadpool_postgres::Transaction<'_>,
    material_id: &str,
) -> Result<HashSet<u64>, DocumentError> {
    let rows = tx
        .query(
            "SELECT client_id FROM material_yjs_client_ids WHERE material_id=$1",
            &[&material_id],
        )
        .await?;
    Ok(rows.iter().map(|row| row.get::<_, i64>(0) as u64).collect())
}

async fn quiz_keys(
    tx: &deadpool_postgres::Transaction<'_>,
    material_id: &str,
) -> Result<(Vec<u8>, Vec<Vec<u8>>), DocumentError> {
    let found = tx
        .query(
            "SELECT state FROM material_yjs_keys WHERE material_id=$1",
            &[&material_id],
        )
        .await?;
    let Some(row) = found.first() else {
        return Err(DocumentError::Unknown("quiz keys document missing".into()));
    };
    let rows = note_store::doc_rows(tx, note_store::Doc::Keys, material_id, None)
        .await?
        .into_iter()
        .map(|(_, row)| row)
        .collect();
    Ok((row.get("state"), rows))
}

/// A quiz's two documents for a server edit.
struct QuizInput {
    keys: (Vec<u8>, Vec<Vec<u8>>),
    live_keys: Option<Vec<u8>>,
}

/// A server write of a quiz (an agent edit, the save API): `edit` runs on
/// both documents; caps hold for each and the limits for both together
/// (REVIEW1 S3); the projection is the complete questions.
fn compute_quiz(
    content: &Scratch,
    keys: &Scratch,
    edit: impl FnOnce(
        &mut yrs::TransactionMut,
        &mut yrs::TransactionMut,
    ) -> Result<EditOutcome, DocumentError>,
) -> Result<Computed, DocumentError> {
    let measure = || {
        let one = |kind: items::Kind, doc: &yrs::Doc| {
            notes::limits::measure_value(&kind.document_value(&doc.transact()))
        };
        items::combine(
            &one(items::Kind::Quiz, &content.doc),
            Some(&one(items::Kind::QuizKeys, &keys.doc)),
        )
    };
    let previous = measure();
    let (outcome, content_items, keys_items) = {
        let mut content_txn = content.doc.transact_mut();
        let mut keys_txn = keys.doc.transact_mut();
        let outcome = edit(&mut content_txn, &mut keys_txn)?;
        (
            outcome,
            Captured::of(&mut content_txn),
            Captured::of(&mut keys_txn),
        )
    };
    for (kind, doc) in [
        (items::Kind::Quiz, &content.doc),
        (items::Kind::QuizKeys, &keys.doc),
    ] {
        kind.check_caps(&doc.transact())
            .map_err(|error| DocumentError::edit("invalid_input", &error))?;
    }
    let metrics = measure();
    if let Some(code) = notes::limits::limit_code(&metrics)
        && !notes::limits::recovers(&metrics, Some(&previous))
    {
        return Err(DocumentError::Quota(code.as_str().into()));
    }
    // A block this version cannot read would leave the rebuilt quiz.
    if items::quiz::holds_unknown_block(&content.doc.transact())
        || items::quiz::holds_unknown_block(&keys.doc.transact())
    {
        return Err(DocumentError::edit(
            "unsupported_operation",
            "this quiz has a block this version can't edit",
        ));
    }
    let value = items::quiz::value(&content.doc.transact(), &keys.doc.transact());
    let asset_ids = Some(items::quiz::asset_ids(
        &content.doc.transact(),
        &keys.doc.transact(),
    ));
    let writes = [
        content.write(note_store::Doc::Content, Some(content_items)),
        keys.write(note_store::Doc::Keys, Some(keys_items)),
    ]
    .into_iter()
    .flatten()
    .collect();
    Ok(Computed {
        writes,
        value,
        asset_ids,
        outcome,
        undo_cost: 0,
    })
}

/// The edit itself, on a document of the durable state plus the live room
/// (a quiz: on both its documents).
fn compute(
    base: Vec<u8>,
    rows: Vec<Vec<u8>>,
    live: Option<Vec<u8>>,
    kind: String,
    commands: Vec<DocumentCommand>,
    quiz: Option<QuizInput>,
    assigned: &HashSet<u64>,
) -> Result<Computed, DocumentError> {
    let unknown = |error: String| DocumentError::Unknown(error);
    let scratch = Scratch::new(&base, &rows, live.as_deref(), assigned).map_err(unknown)?;
    if let Some(quiz) = quiz {
        let keys = Scratch::new(
            &quiz.keys.0,
            &quiz.keys.1,
            quiz.live_keys.as_deref(),
            assigned,
        )
        .map_err(unknown)?;
        let cost = undo_cost(
            &commands,
            &[
                &items::Kind::Quiz.document_value(&scratch.doc.transact()),
                &items::Kind::QuizKeys.document_value(&keys.doc.transact()),
            ],
        );
        let mut computed = compute_quiz(&scratch, &keys, |content, keys| {
            items::quiz::apply_commands(content, keys, &commands)?;
            Ok(EditOutcome::default())
        })?;
        computed.undo_cost = cost;
        return Ok(computed);
    }
    let doc = &scratch.doc;
    let (outcome, value, captured, cost) = if let Model::Item(item) = Model::of(&kind) {
        item_edit(doc, item, &kind, &commands)?
    } else {
        let root = doc.get_or_insert_text(notes::plate::CONTENT_ROOT);
        let mut txn = doc.transact_mut();
        let before = notes::plate::value(&txn).map_err(|error| unknown(error.to_string()))?;
        let previous = notes::limits::measure_value(&before);
        let cost = undo_cost(&commands, &[&before]);
        let outcome = notes::edit::apply_material_commands(&mut txn, &root, &commands)?;
        // A note the edit emptied gets its empty paragraph in the same
        // transaction, so no editor sees it empty and its Undo takes the
        // paragraph out again (Epo 2026-10-21). Other kinds require their
        // block: the check below refuses one left without it.
        notes::repair::emptied(&mut txn, &kind);
        let value = notes::plate::value(&txn).map_err(|error| unknown(error.to_string()))?;
        // A whole note the check refuses (an 11th interactive block across
        // it) is a refusal naming the rule, as for a live item; logged, since
        // a command that built a wrong document refuses the same way.
        notes::material::assert_canonical(&value, &kind).map_err(|error| {
            observe::log(
                observe::Level::Warn,
                "agent edit refused by the material check",
                json!({ "error": error.0, "kind": kind }),
            );
            DocumentError::edit("invalid_input", error.to_string())
        })?;
        let metrics = notes::limits::measure_value(&value);
        if let Some(code) = notes::limits::limit_code(&metrics)
            && !notes::limits::recovers(&metrics, Some(&previous))
        {
            return Err(DocumentError::Quota(code.as_str().into()));
        }
        (outcome, value, Captured::of(&mut txn), cost)
    };
    // An agent edit always writes (its markers at least), as before.
    let hidden = markers::live_items(doc);
    let txn = doc.transact();
    let (row, durable) = ydoc::delta_update(&txn, &scratch.durable, &hidden);
    let live_update = scratch
        .live
        .as_ref()
        .map(|vector| txn.encode_state_as_update_v1(vector));
    Ok(Computed {
        writes: vec![Write {
            doc: note_store::Doc::Content,
            row,
            durable,
            live_update,
            captured: scratch.live.is_some().then_some(captured),
        }],
        value,
        asset_ids: None,
        outcome,
        undo_cost: cost,
    })
}

/// An agent edit of a live item document: the items crate's commands, the
/// caps, the shape of everything the document holds, and the limits (refused
/// unless it shrank towards them).
fn item_edit(
    doc: &yrs::Doc,
    item: items::Kind,
    kind: &str,
    commands: &[DocumentCommand],
) -> Result<(EditOutcome, Vec<Value>, Captured, usize), DocumentError> {
    let mut txn = doc.transact_mut();
    let before = item.document_value(&txn);
    let previous = notes::limits::measure_value(&before);
    let cost = undo_cost(commands, &[&before]);
    item.apply_commands(&mut txn, commands)?;
    item.check_caps(&txn)
        .map_err(|error| DocumentError::edit("invalid_input", &error))?;
    let document = item.document_value(&txn);
    notes::material::assert_canonical(&document, kind)
        .map_err(|error| DocumentError::edit("invalid_input", &error.0))?;
    let metrics = notes::limits::measure_value(&document);
    if let Some(code) = notes::limits::limit_code(&metrics)
        && !notes::limits::recovers(&metrics, Some(&previous))
    {
        return Err(DocumentError::Quota(code.as_str().into()));
    }
    let value = item.value(&txn);
    Ok((EditOutcome::default(), value, Captured::of(&mut txn), cost))
}

/// `receiptFromRow`.
fn receipt_from_row(row: &tokio_postgres::Row) -> Value {
    let mut receipt = json!({
        "kind": row.get::<_, String>("kind"),
        "operationId": row.get::<_, String>("id"),
        "outcome": row.get::<_, String>("outcome"),
        "toolVersion": row.get::<_, i32>("tool_version"),
    });
    if let Some(call) = row.get::<_, Option<String>>("call_id") {
        receipt["callId"] = json!(call);
    }
    if let Some(effect) = row.get::<_, Option<Value>>("effect") {
        receipt["effect"] = effect;
    }
    if let Some(workspace) = row.get::<_, Option<String>>("workspace_id") {
        receipt["workspaceId"] = json!(workspace);
    }
    receipt
}

/// `applyMaterialEdit` plus its fan-out: the committed change reaches the
/// live room, the children pass and the projection follow.
pub async fn edit_material(
    app: &Shared,
    request: &DocumentRequest,
) -> Result<Value, DocumentError> {
    let (room, material_id, schema) = material_room(request)?;
    let operation = request
        .operation
        .clone()
        .ok_or_else(|| DocumentError::edit("invalid_input", "operation identity is required"))?;
    if app.evictions.blocks(&room, false) {
        return Err(DocumentError::Unavailable(ROOM_RESET));
    }
    if crate::socket::room_evicting(app, &room)
        .await
        .map_err(DocumentError::Unknown)?
    {
        return Err(DocumentError::Unavailable(ROOM_COMPACTING));
    }
    let commands =
        parse::<Vec<DocumentCommand>>(Value::Array(request.commands.clone()), "commands")?;
    let live = live_state(app, &room).await;
    let actor = request.actor_user_id.clone();
    let mut client = app
        .db
        .get()
        .await
        .map_err(|error| DocumentError::Unknown(error.to_string()))?;
    let tx = client.transaction().await?;
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        &[&format!("agent-operation:{}", operation.id)],
    )
    .await?;
    let replay = tx
        .query(
            "SELECT id, kind, tool_version, request_hash, workspace_id, call_id, outcome, effect
             FROM agent_operations WHERE id=$1",
            &[&operation.id],
        )
        .await?;
    if let Some(row) = replay.first() {
        if row.get::<_, String>("request_hash") != operation.request_hash {
            return Err(DocumentError::edit(
                "invalid_input",
                "operation id already used with a different request",
            ));
        }
        let receipt = receipt_from_row(row);
        tx.commit().await?;
        return Ok(receipt);
    }
    access::lock_material(&tx, &material_id).await?;
    access::lock_boundary(&tx, &material_id, std::slice::from_ref(&actor)).await?;
    access::assert_access(&tx, &material_id, &actor, crate::auth::Access::Write).await?;
    let select = "SELECT d.state, d.room_schema, d.stored_version, m.kind
                  FROM material_yjs_documents d JOIN materials m ON m.id=d.material_id
                  WHERE d.material_id=$1 FOR UPDATE OF d";
    let mut found = tx.query(select, &[&material_id]).await?;
    if found.is_empty() {
        note_store::bootstrap(&tx, &material_id, schema).await?;
        found = tx.query(select, &[&material_id]).await?;
    }
    let Some(current) = found.first() else {
        return Err(DocumentError::edit(
            "unavailable_target",
            "material not found",
        ));
    };
    let rebuilt = i64::from(current.get::<_, i32>("room_schema"));
    if rebuilt != schema {
        // Its blocks as they are now, as a gone block's refusal lists them,
        // so the retry needs no inspect; read after the lock is let go. The
        // refusal stands without them when they cannot be read.
        drop(tx);
        drop(client);
        return Err(DocumentError::Edit {
            code: "stale_target".into(),
            message: "the material was rebuilt since it was inspected".into(),
            details: material_blocks(app, &material_id, rebuilt)
                .await
                .ok()
                .map(|blocks| notes::edit::listing(&blocks)),
        });
    }
    let base: Vec<u8> = current.get("state");
    let kind: String = current.get("kind");
    let stored = current.get::<_, i64>("stored_version");
    let rows: Vec<Vec<u8>> = note_store::rows(&tx, &material_id, None)
        .await?
        .into_iter()
        .map(|(_, row)| row)
        .collect();
    let keys_room = format!("keys:{material_id}:schema:{schema}");
    let quiz = if kind == "quiz" {
        Some(QuizInput {
            keys: quiz_keys(&tx, &material_id).await?,
            live_keys: live_state(app, &keys_room).await,
        })
    } else {
        None
    };
    let mut assigned = assigned_ids(&tx, &material_id).await?;
    assigned.extend(live_ids(app, &room).await);
    assigned.extend(live_ids(app, &keys_room).await);
    let computed = tokio::task::spawn_blocking(move || {
        compute(base, rows, live, kind, commands, quiz, &assigned)
    })
    .await
    .map_err(|error| DocumentError::Unknown(error.to_string()))??;
    if over_update_cap(&computed.writes) {
        return Err(DocumentError::Quota(UPDATE_TOO_LARGE.into()));
    }
    let mut version = stored;
    let mut versions = Vec::new();
    for write in &computed.writes {
        version += 1;
        note_store::append_row(&tx, write.doc, &material_id, version, &write.row).await?;
        versions.push(version);
    }
    // The gateway merged this edit's books into the stored record; writing it
    // here keeps the credit and the content in one transaction.
    if let Some(provenance) = &request.provenance {
        tx.execute(
            "UPDATE materials SET provenance=$2 WHERE id=$1",
            &[&material_id, provenance],
        )
        .await?;
    }
    let material = tx
        .query(
            "SELECT title, kind, workspace_id FROM materials WHERE id=$1",
            &[&material_id],
        )
        .await?;
    let (title, material_kind, workspace): (String, String, Option<String>) = match material.first()
    {
        Some(row) => (row.get("title"), row.get("kind"), row.get("workspace_id")),
        None => (String::new(), String::new(), None),
    };
    // The edit's Undo lives in its rooms: every document it wrote had one
    // (its ref goes on the receipt once they took it, below).
    let undoable =
        !computed.writes.is_empty() && computed.writes.iter().all(|write| write.captured.is_some());
    let mut effect = json!({
        "operation": "edited",
        "operationId": operation.id,
        "projectionPending": true,
        "resource": {
            "id": material_id,
            "kind": "material",
            "materialKind": material_kind,
            "title": title,
            "workspaceId": workspace.clone().unwrap_or_default(),
        },
    });
    // Inserts whose anchor block was gone say where they landed instead.
    if !computed.outcome.relocated.is_empty() {
        effect["relocated"] = json!(computed.outcome.relocated);
    }
    let kind = "edit_document";
    let tool_version = operation.tool_version.unwrap_or(1);
    let workspace_id = workspace.clone().unwrap_or_default();
    tx.execute(
        "INSERT INTO agent_operations
         (id, kind, tool_version, request_hash, actor_user_id, workspace_id, conversation_id,
          message_id, call_id, outcome, effect)
         VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),'succeeded',$10)",
        &[
            &operation.id,
            &kind,
            &(tool_version as i32),
            &operation.request_hash,
            &actor,
            &workspace_id,
            &operation.conversation_id.clone().unwrap_or_default(),
            &operation.message_id.clone().unwrap_or_default(),
            &operation.call_id.clone().unwrap_or_default(),
            &effect,
        ],
    )
    .await?;
    tx.commit().await?;
    drop(client);
    let mut receipt = json!({
        "effect": effect,
        "kind": kind,
        "operationId": operation.id,
        "outcome": "succeeded",
        "toolVersion": tool_version,
    });
    if let Some(call) = &operation.call_id {
        receipt["callId"] = json!(call);
    }
    if let Some(workspace) = &workspace {
        receipt["workspaceId"] = json!(workspace);
    }
    // An AI edit can bring back a quiz or image the note had trashed
    // (restored) or one purged since (dropped).
    if let Some(write) = computed
        .writes
        .iter()
        .find(|write| write.doc == note_store::Doc::Content)
    {
        crate::children::queue(app, &room, &actor, write.row.clone());
    }
    // The committed changes go to the live rooms, whose durable covers take
    // them, with the edit's items for its Undo.
    let step = undoable.then_some((operation.id.as_str(), computed.undo_cost));
    if send_writes(app, &room, &keys_room, computed.writes, &versions, step).await {
        offer_undo(app, &operation.id, &mut receipt).await;
    }
    let content = json!({ "schemaVersion": 1, "value": computed.value });
    match projection::project(app, &material_id, version, &content, computed.asset_ids).await {
        Ok(()) => {
            if let Ok(client) = app.db.get().await {
                let _ = client
                    .execute(
                        "UPDATE agent_operations SET effect = effect || '{\"projectionPending\": false}'::jsonb
                         WHERE id=$1 AND effect IS NOT NULL",
                        &[&operation.id],
                    )
                    .await;
            }
            receipt["effect"]["projectionPending"] = json!(false);
            if let Some(handle) = app.rooms.get(&room) {
                let _ = handle.tx.send(RoomCmd::Projected(version, Ok(()))).await;
            }
        }
        // The change is durable; the pending scan catches the projection up
        // and the receipt keeps reporting projectionPending until then.
        Err(error) => observe::log(
            observe::Level::Warn,
            "service edit projection failed",
            json!({ "error": error, "room": room }),
        ),
    }
    Ok(receipt)
}

/// The `replace-block` command (`replaceMaterialContent` with an expected
/// revision, `executeServiceCommand` without): one stable block replaced and
/// committed as a row; the live room takes the change.
pub async fn replace_block(app: &Shared, command: Value) -> Result<(), String> {
    if command["type"] != "replace-block" {
        return Err("unsupported collaboration command".into());
    }
    let command: notes::commands::ReplaceBlock = serde_json::from_value(command)
        .map_err(|error| format!("invalid collaboration command: {error}"))?;
    let Some(RoomName::Material {
        material_id,
        schema,
        keys: false,
    }) = RoomName::parse(&command.room)
    else {
        return Err("collaboration command room does not match material".into());
    };
    if material_id != command.material_id {
        return Err("collaboration command room does not match material".into());
    }
    if app.evictions.blocks(&command.room, false) {
        return Err(ROOM_RESET.into());
    }
    if crate::socket::room_evicting(app, &command.room).await? {
        return Err(if command.expected_revision.is_some() {
            "material changed concurrently".into()
        } else {
            ROOM_COMPACTING.into()
        });
    }
    let live = live_state(app, &command.room).await;
    let mut client = app.db.get().await.map_err(|error| error.to_string())?;
    let tx = client
        .transaction()
        .await
        .map_err(|error| error.to_string())?;
    access::lock_material(&tx, &material_id)
        .await
        .map_err(|error| error.to_string())?;
    access::lock_boundary(
        &tx,
        &material_id,
        std::slice::from_ref(&command.actor_user_id),
    )
    .await
    .map_err(|error| error.to_string())?;
    access::assert_access(
        &tx,
        &material_id,
        &command.actor_user_id,
        crate::auth::Access::Write,
    )
    .await
    .map_err(|error| error.to_string())?;
    if let Some(expected) = command.expected_revision {
        let revision = tx
            .query(
                "SELECT revision FROM materials WHERE id=$1 AND trashed_at IS NULL FOR UPDATE",
                &[&material_id],
            )
            .await
            .map_err(|error| error.to_string())?;
        if revision.first().map(|row| row.get::<_, i64>(0)) != Some(expected) {
            return Err("material changed concurrently".into());
        }
    }
    let select = "SELECT d.state, d.room_schema, d.stored_version, d.projected_version, m.kind
                  FROM material_yjs_documents d JOIN materials m ON m.id=d.material_id
                  WHERE d.material_id=$1 FOR UPDATE OF d";
    let mut found = tx
        .query(select, &[&material_id])
        .await
        .map_err(|error| error.to_string())?;
    if found.is_empty() {
        note_store::bootstrap(&tx, &material_id, schema)
            .await
            .map_err(|error| error.to_string())?;
        found = tx
            .query(select, &[&material_id])
            .await
            .map_err(|error| error.to_string())?;
    }
    let Some(current) = found.first() else {
        return Err("target block no longer exists".into());
    };
    let stored: i64 = current.get("stored_version");
    if i64::from(current.get::<_, i32>("room_schema")) != schema
        || (command.expected_revision.is_some()
            && stored != current.get::<_, i64>("projected_version"))
    {
        return Err("material changed concurrently".into());
    }
    let base: Vec<u8> = current.get("state");
    let kind: String = current.get("kind");
    let rows: Vec<Vec<u8>> = note_store::rows(&tx, &material_id, None)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|(_, row)| row)
        .collect();
    let room = format!("material:{material_id}:schema:{schema}");
    let keys_room = format!("keys:{material_id}:schema:{schema}");
    let quiz = if kind == "quiz" {
        Some(QuizInput {
            keys: quiz_keys(&tx, &material_id)
                .await
                .map_err(|error| error.message().to_owned())?,
            live_keys: live_state(app, &keys_room).await,
        })
    } else {
        None
    };
    let mut assigned = assigned_ids(&tx, &material_id)
        .await
        .map_err(|error| error.message().to_owned())?;
    assigned.extend(live_ids(app, &room).await);
    assigned.extend(live_ids(app, &keys_room).await);
    let computed = tokio::task::spawn_blocking(move || -> Result<Option<Computed>, String> {
        replace_on(base, rows, live, kind, &command, quiz, &assigned)
    })
    .await
    .map_err(|error| error.to_string())??;
    // Nothing to change (the block already holds the replacement).
    let Some(computed) = computed else {
        tx.commit().await.map_err(|error| error.to_string())?;
        return Ok(());
    };
    if over_update_cap(&computed.writes) {
        return Err(UPDATE_TOO_LARGE.into());
    }
    let mut version = stored;
    let mut versions = Vec::new();
    for write in &computed.writes {
        version += 1;
        note_store::append_row(&tx, write.doc, &material_id, version, &write.row)
            .await
            .map_err(|error| error.to_string())?;
        versions.push(version);
    }
    tx.commit().await.map_err(|error| error.to_string())?;
    drop(client);
    send_writes(app, &room, &keys_room, computed.writes, &versions, None).await;
    let content = json!({ "schemaVersion": 1, "value": computed.value });
    projection::project(app, &material_id, version, &content, computed.asset_ids).await?;
    if let Some(handle) = app.rooms.get(&room) {
        let _ = handle.tx.send(RoomCmd::Projected(version, Ok(()))).await;
    }
    Ok(())
}

/// Each write to its live room (the content room, or a quiz's keys room)
/// with the version its row took, and under `step` the edit's own items
/// that room keeps for the edit's Undo. Whether every written document's room
/// took the step (none without a step).
async fn send_writes(
    app: &Shared,
    room: &str,
    keys_room: &str,
    writes: Vec<Write>,
    versions: &[i64],
    step: Option<(&str, usize)>,
) -> bool {
    let mut answers = Vec::new();
    let mut taken = step.is_some() && !writes.is_empty();
    for (write, version) in writes.into_iter().zip(versions) {
        let (name, other) = match write.doc {
            note_store::Doc::Content => (room, keys_room),
            note_store::Doc::Keys => (keys_room, room),
        };
        match app.rooms.get(name) {
            Some(handle) => {
                let step = step
                    .zip(write.captured)
                    .map(|((id, cost), items)| (id.to_owned(), items, cost));
                let (reply, answer) = oneshot::channel();
                if step.is_some() {
                    answers.push(answer);
                } else {
                    taken = false;
                }
                let edit = ServiceEdit {
                    update: write.live_update.unwrap_or_else(|| write.row.clone()),
                    durable: write.durable,
                    version: *version as u64,
                    row_bytes: write.row.len(),
                    step,
                    taken: Some(reply),
                };
                let _ = handle.tx.send(RoomCmd::ServiceEdit(Box::new(edit))).await;
            }
            // A quiz document whose room is not loaded changed: the other
            // one's room reads it (its metrics; the keys' readers' lists).
            None => {
                taken = false;
                if let Some(handle) = app.rooms.get(other) {
                    let _ = handle.tx.send(RoomCmd::PeerReload).await;
                }
            }
        }
    }
    for answer in answers {
        taken &= matches!(
            tokio::time::timeout(SNAPSHOT_WAIT, answer).await,
            Ok(Ok(true))
        );
    }
    taken
}

/// The Undo ref of an agent edit every room it wrote took: stored on the
/// receipt, then shown on it (a receipt whose ref did not store has none).
async fn offer_undo(app: &Shared, operation_id: &str, receipt: &mut Value) {
    let undo = json!({ "operationId": operation_id, "status": "available" });
    let Ok(client) = app.db.get().await else {
        return;
    };
    let stored = client
        .execute(
            "UPDATE agent_operations SET effect = jsonb_set(effect, '{undo}', $2)
             WHERE id=$1 AND effect IS NOT NULL",
            &[&operation_id, &undo],
        )
        .await;
    if matches!(stored, Ok(1)) {
        receipt["effect"]["undo"] = undo;
    }
}

/// The replace-block command on an isolated document (a quiz: both its
/// documents); `None` when the block already holds the replacement.
fn replace_on(
    base: Vec<u8>,
    rows: Vec<Vec<u8>>,
    live: Option<Vec<u8>>,
    kind: String,
    command: &notes::commands::ReplaceBlock,
    quiz: Option<QuizInput>,
    assigned: &HashSet<u64>,
) -> Result<Option<Computed>, String> {
    let scratch = Scratch::new(&base, &rows, live.as_deref(), assigned)?;
    if let Some(quiz) = quiz {
        let keys = Scratch::new(
            &quiz.keys.0,
            &quiz.keys.1,
            quiz.live_keys.as_deref(),
            assigned,
        )?;
        let questions = items::quiz::block_questions(&command.replacement_block)?;
        let computed = compute_quiz(&scratch, &keys, |content, keys| {
            items::quiz::set_questions(content, keys, &questions)
                .map_err(|error| DocumentError::edit("invalid_input", error))?;
            Ok(EditOutcome::default())
        })
        .map_err(|error| error.message().to_owned())?;
        return Ok((!computed.writes.is_empty()).then_some(computed));
    }
    let doc = &scratch.doc;
    let model = Model::of(&kind);
    let previous = notes::limits::measure_value(&model.document_value(&doc.transact())?);
    match model {
        Model::Note => {
            let root = doc.get_or_insert_text(notes::plate::CONTENT_ROOT);
            let mut txn = doc.transact_mut();
            notes::commands::replace_block(&mut txn, &root, command)
                .map_err(|error| error.to_string())?;
        }
        // The content save API: the fewest changes, no revision check (D7).
        Model::Item(item) => {
            let mut txn = doc.transact_mut();
            item.replace_block(&mut txn, &command.replacement_block)?;
        }
    }
    if !scratch.changed() {
        return Ok(None);
    }
    if let Model::Item(item) = model {
        item.check_caps(&doc.transact())?;
    }
    let value = model.value(&doc.transact())?;
    let document = model.document_value(&doc.transact())?;
    notes::material::assert_canonical(&document, &kind).map_err(|error| error.0)?;
    let metrics = notes::limits::measure_value(&document);
    if let Some(code) = notes::limits::limit_code(&metrics)
        && !notes::limits::recovers(&metrics, Some(&previous))
    {
        return Err(format!("invalid material document: {}", code.as_str()));
    }
    Ok(Some(Computed {
        writes: scratch
            .write(note_store::Doc::Content, None)
            .into_iter()
            .collect(),
        value,
        asset_ids: None,
        outcome: EditOutcome::default(),
        undo_cost: 0,
    }))
}

/// Inspect or edit of a source file (the sources crate), with the committed
/// change fanned into the live room.
pub async fn source_request(
    app: &Shared,
    request: &DocumentRequest,
    inspect: bool,
) -> Result<Value, DocumentError> {
    if inspect {
        let rooms = app.clone();
        let inspection = app
            .sources
            .inspect(
                &request.target.id,
                &request.actor_user_id,
                request.office.clone(),
                move |room| Box::pin(async move { live_state(&rooms, &room).await }),
            )
            .await?;
        return Ok(serde_json::to_value(inspection).unwrap_or(Value::Null));
    }
    let operation = request
        .operation
        .clone()
        .ok_or_else(|| DocumentError::edit("invalid_input", "operation identity is required"))?;
    let input = sources::edit::EditInput {
        actor_user_id: request.actor_user_id.clone(),
        commands: request.commands.clone(),
        file_id: request.target.id.clone(),
        operation: serde_json::to_value(&operation).unwrap_or(Value::Null),
    };
    let rooms = app.clone();
    let result = app
        .sources
        .apply_edit(input, move |room| {
            let app = rooms.clone();
            let room = room.to_owned();
            Box::pin(async move { live_state(&app, &room).await })
        })
        .await?;
    let mut taken = false;
    if let Some(handle) = app.rooms.get(&result.room) {
        let step = result
            .captured
            .map(|items| (operation.id.clone(), items, result.undo_cost));
        let offered = step.is_some();
        let (reply, answer) = oneshot::channel();
        let edit = ServiceEdit {
            update: result.update,
            durable: result.durable,
            version: result.checkpoint,
            row_bytes: result.row_bytes,
            step,
            taken: Some(reply),
        };
        let sent = handle.tx.send(RoomCmd::ServiceEdit(Box::new(edit))).await;
        taken = offered
            && sent.is_ok()
            && matches!(
                tokio::time::timeout(SNAPSHOT_WAIT, answer).await,
                Ok(Ok(true))
            );
    }
    // Go passes the engine's note on the characters the agent's text lost
    // on to the tool result (Epo 2026-10-15).
    let mut receipt = result.receipt;
    if taken {
        offer_undo(app, &operation.id, &mut receipt).await;
    }
    if let Some(notice) = result.notice {
        receipt["notice"] = json!(notice);
    }
    Ok(receipt)
}

/// What an Undo or Redo asks of the rooms holding an agent edit's items:
/// the step, the id its reverse is kept under, and the document it changes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoRequest {
    actor_user_id: String,
    operation: Operation,
    undo_of: String,
    target: Target,
}

/// How long one room may take to revert and store an Undo; two rooms (a quiz)
/// answer within the API's 20 s.
const UNDO_WAIT: Duration = Duration::from_secs(8);

fn undo_unavailable(message: &str) -> DocumentError {
    DocumentError::edit("undo_unavailable", message)
}

/// Whether `room` holds a document of `target` (a note's or quiz's content
/// or keys room, a source's room).
fn room_of(target: &Target, room: &str) -> bool {
    let prefixes: &[&str] = match target.kind.as_str() {
        "material" => &["material:", "keys:"],
        "source_file" => &["source:"],
        _ => &[],
    };
    prefixes.iter().any(|prefix| {
        room.strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix(target.id.as_str()))
            .is_some_and(|rest| rest.starts_with(':'))
    })
}

/// One room's answer to an Undo, within [UNDO_WAIT].
async fn ask_room(
    handle: &crate::app::RoomHandle,
    step: &str,
    next: &str,
    actor: &str,
) -> Result<Reverted, DocumentError> {
    let (reply, answer) = oneshot::channel();
    let command = RoomCmd::AgentUndo(Box::new(AgentUndo {
        step: step.to_owned(),
        next: next.to_owned(),
        actor: actor.to_owned(),
        reply,
    }));
    if handle.tx.send(command).await.is_err() {
        return Err(undo_unavailable("this edit can no longer be undone"));
    }
    match tokio::time::timeout(UNDO_WAIT, answer).await {
        Ok(Ok(Ok(reverted))) => Ok(reverted),
        Ok(Ok(Err(error))) => Err(DocumentError::Unknown(error)),
        Ok(Err(_)) => Err(undo_unavailable("this edit can no longer be undone")),
        Err(_) => Err(DocumentError::Unknown(
            "the Undo was not stored in time".into(),
        )),
    }
}

/// An Undo (or Redo) of a step loaded rooms hold: each room holding a part of
/// it (a quiz: content and keys) reverts it, stores it and keeps the step that
/// reverses it under the request's operation id, or under the id of an
/// earlier request whose answer was lost, which it answers with. When one
/// room fails, the rooms asked before it (and the failing one, whose answer
/// may still come) are put back, so the document is as it was and the step
/// stays. Refused once no room holds it, or when nothing of it is left. Go
/// records the receipt under the answered id, offering the step that
/// reverses it only when every room that reverted keeps that step (one whose
/// revert would be too large to send is not kept, Epo 2026-10-21).
async fn undo(app: &Shared, body: &[u8]) -> Result<Value, DocumentError> {
    let request: UndoRequest = serde_json::from_slice(body)
        .map_err(|_| DocumentError::Invalid("invalid undo request".into()))?;
    let mut rooms = app.agent_steps.rooms(&request.undo_of);
    if rooms.is_empty() {
        // Reverted already: a request repeated after a lost answer gets the
        // same answer from the rooms that reverted it.
        rooms = app.agent_steps.reverted(&request.undo_of);
    }
    if rooms.iter().any(|room| !room_of(&request.target, room)) {
        return Err(undo_unavailable("this edit can no longer be undone"));
    }
    // Every room holding a part must still be loaded before any reverts.
    let handles: Option<Vec<_>> = rooms.iter().map(|room| app.rooms.get(room)).collect();
    let Some(handles) = handles.filter(|handles| !handles.is_empty()) else {
        app.agent_steps.forget(&request.undo_of);
        return Err(undo_unavailable("this edit can no longer be undone"));
    };
    let (step, actor) = (&request.undo_of, &request.actor_user_id);
    let mut kept: Option<String> = None;
    let mut asked: Vec<(crate::app::RoomHandle, String)> = Vec::new();
    let mut reverted: Vec<&String> = Vec::new();
    for (room, handle) in rooms.iter().zip(handles) {
        match ask_room(&handle, step, &request.operation.id, actor).await {
            Ok(Reverted::Done(id)) => {
                kept.get_or_insert_with(|| id.clone());
                asked.push((handle, id));
                reverted.push(room);
            }
            Ok(Reverted::Nothing) => {}
            failure => {
                if matches!(failure, Err(DocumentError::Unknown(_))) {
                    asked.push((handle, request.operation.id.clone()));
                }
                put_back(asked, step, actor);
                return Err(match failure {
                    Ok(Reverted::Refused { code, message }) => DocumentError::edit(code, message),
                    Err(error) => error,
                    _ => undo_unavailable("this edit can no longer be undone"),
                });
            }
        }
    }
    let Some(kept) = kept else {
        return Err(undo_unavailable("nothing of this edit is left to undo"));
    };
    // The read model follows at once, as it did the edit (`edit_material`
    // projects); otherwise a diagram or mindmap, which no read projects on
    // demand, waits for its room's idle projection.
    for room in rooms.iter().filter(|room| room.starts_with("material:")) {
        if let Some(handle) = app.rooms.get(room) {
            tokio::spawn(async move {
                let (reply, answer) = oneshot::channel();
                if handle.tx.send(RoomCmd::Project(reply)).await.is_ok() {
                    let _ = answer.await;
                }
            });
        }
    }
    let holding = app.agent_steps.rooms(&kept);
    let reversible = reverted.iter().all(|room| holding.contains(room));
    Ok(json!({ "operationId": kept, "reversible": reversible }))
}

/// Reverts each room's revert again (its step under `step` once more), in
/// the background: a room answers in order, after the Undo it was asked.
fn put_back(asked: Vec<(crate::app::RoomHandle, String)>, step: &str, actor: &str) {
    for (handle, id) in asked {
        let (step, actor) = (step.to_owned(), actor.to_owned());
        tokio::spawn(async move {
            // Anything but done leaves the room reverted while the chat says
            // the Undo failed (review r3 L1): a reverse too large to keep is
            // missing, so such an Undo is not put back.
            let answer = ask_room(&handle, &id, &step, &actor).await;
            if !matches!(answer, Ok(Reverted::Done(_))) {
                observe::capture(
                    &format!("agent Undo not put back: {answer:?}"),
                    None,
                    &[("stage", "agent_undo_put_back")],
                );
            }
        });
    }
}

/// `/internal/documents/undo-status`: which of the given steps a loaded room
/// still holds, so a reopened conversation shows Undo only on those.
fn undo_status(app: &Shared, body: &[u8]) -> Result<Value, DocumentError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Status {
        operation_ids: Vec<String>,
    }
    let status: Status = serde_json::from_slice(body)
        .map_err(|_| DocumentError::Invalid("invalid undo status request".into()))?;
    let live: Vec<&String> = status
        .operation_ids
        .iter()
        .filter(|id| {
            let rooms = app.agent_steps.rooms(id);
            !rooms.is_empty() && rooms.iter().all(|room| app.rooms.get(room).is_some())
        })
        .collect();
    Ok(json!({ "live": live }))
}

/// `CreateRequest`: a new Office file for the agent's `create`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub format: Value,
    #[serde(default)]
    pub commands: Vec<Value>,
}

/// `/internal/documents/create` after the secret check: the new file's bytes
/// (base64) and the removed-characters notice. The API stores the file.
pub async fn create(app: &Shared, body: &[u8]) -> Result<Value, DocumentError> {
    use base64::Engine;
    let request: CreateRequest = serde_json::from_slice(body)
        .map_err(|_| DocumentError::Invalid("invalid create request".into()))?;
    let (bytes, notice) = app
        .sources
        .create_office(request.format, request.commands)
        .await?;
    Ok(json!({
        "content": base64::engine::general_purpose::STANDARD.encode(bytes),
        "notice": notice,
    }))
}

/// `/internal/documents/{create,inspect,edit,undo,undo-status}` after the
/// secret check.
pub async fn document(app: &Shared, path: &str, body: &[u8]) -> Result<Value, DocumentError> {
    if path.ends_with("/create") {
        return create(app, body).await;
    }
    if path.ends_with("/undo") {
        return undo(app, body).await;
    }
    if path.ends_with("/undo-status") {
        return undo_status(app, body);
    }
    let invalid = || DocumentError::Invalid("invalid document request".into());
    let request: DocumentRequest = serde_json::from_slice(body).map_err(|_| invalid())?;
    if request.target.kind != "material" && request.target.kind != "source_file" {
        return Err(invalid());
    }
    let inspect = path.ends_with("/inspect");
    if !inspect && request.operation.is_none() {
        return Err(DocumentError::edit(
            "invalid_input",
            "operation identity is required",
        ));
    }
    if request.target.kind == "source_file" {
        return source_request(app, &request, inspect).await;
    }
    if inspect {
        return inspect_material(app, &request).await;
    }
    edit_material(app, &request).await
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::collections::HashSet;

    use serde_json::json;

    use super::{DocumentError, Model, Scratch, Write, compute, compute_quiz, over_update_cap};

    /// An agent edit or content-API write whose update, stored or sent live,
    /// is over the cap is refused before it commits; one at the cap goes (Epo
    /// 2026-10-18).
    #[test]
    fn writes_over_the_update_cap_are_refused() {
        let write = |row: usize, live: Option<usize>| Write {
            doc: crate::note_store::Doc::Content,
            row: vec![0; row],
            durable: Default::default(),
            live_update: live.map(|bytes| vec![0; bytes]),
            captured: None,
        };
        let cap = ydoc::MAX_UPDATE_BYTES;
        assert!(!over_update_cap(&[write(cap, Some(cap))]));
        assert!(over_update_cap(&[write(10, None), write(cap + 1, None)]));
        assert!(over_update_cap(&[write(10, Some(cap + 1))]));
    }

    /// A text source's ambiguous span keeps the lines it occurs in on its way
    /// to the gateway: the notes refusal, the sources error, the body.
    #[test]
    fn a_text_source_refusal_keeps_its_lines() {
        use yrs::{Text, Transact};
        let doc = yrs::Doc::new();
        let root = doc.get_or_insert_text("source");
        root.insert(&mut doc.transact_mut(), 0, "a cat\na cat");
        let command = notes::edit::DocumentCommand::ReplaceText {
            block_id: None,
            expected_text: "cat".into(),
            text: "dog".into(),
        };
        let refusal = notes::edit::apply_text_commands(&mut doc.transact_mut(), &root, &[command])
            .unwrap_err();
        let (status, body) =
            DocumentError::from(sources::SourceError::from(refusal)).status_and_body();
        assert_eq!(status, 409);
        assert_eq!(
            body["details"],
            json!({ "lines": [{ "start": 0, "text": "a cat" }, { "start": 6, "text": "a cat" }] }),
            "{body}"
        );
    }

    /// A note edit whose result the whole-note check refuses (here an 11th
    /// interactive block across the note) is an `invalid_input` refusal
    /// naming the rule, not an unknown outcome the agent cannot act on.
    #[test]
    fn a_note_the_whole_note_check_refuses_is_refused_naming_the_rule() {
        let embed = |id: &str| json!({ "type": "html_embed", "id": id, "html": "<p>x</p>", "children": [{ "text": "" }] });
        let value: Vec<_> = (0..10).map(|i| embed(&format!("e{i}"))).collect();
        let insert = notes::edit::DocumentCommand::InsertBlock {
            after_block_id: Some("e9".into()),
            blocks: vec![embed("e10")],
        };
        let refusal = compute(
            Model::Note.state_from_value(&value),
            Vec::new(),
            None,
            "note".into(),
            vec![insert],
            None,
            &HashSet::new(),
        )
        .err();
        assert!(
            matches!(&refusal, Some(DocumentError::Edit { code, message, .. })
                if code == "invalid_input"
                    && message == "invalid material document: 11 interactive blocks over 10"),
            "{refusal:?}"
        );
    }

    /// A note an agent edit empties gets one empty paragraph in the edit's
    /// own transaction (Epo 2026-10-21), so no editor sees it empty and its
    /// Undo takes the paragraph out with the edit; a diagram left without
    /// its mermaid block is refused by the store's check instead. Fails if
    /// the edit refuses the removal of the last block again or stores an
    /// empty note.
    #[test]
    fn an_agent_edit_that_empties_a_note_leaves_an_empty_paragraph() {
        let remove = |kind: &str, value: serde_json::Value| {
            let id = value["id"].as_str().unwrap().to_owned();
            // As inspect shows it: the paragraph's text, the Mermaid source.
            let expected = value["source"].as_str().unwrap_or("last").to_owned();
            compute(
                Model::Note.state_from_value(&[value]),
                Vec::new(),
                None,
                kind.into(),
                vec![notes::edit::DocumentCommand::RemoveBlock {
                    block_id: id,
                    expected_text: expected,
                }],
                None,
                &HashSet::new(),
            )
        };
        let computed = remove(
            "note",
            json!({ "type": "p", "id": "b1", "children": [{ "text": "last" }] }),
        )
        .unwrap();
        assert_eq!(computed.value.len(), 1, "{:?}", computed.value);
        assert_eq!(computed.value[0]["type"], "p");
        assert_eq!(computed.value[0]["children"], json!([{ "text": "" }]));
        assert_ne!(computed.value[0]["id"], "b1");
        let diagram = remove(
            "diagram",
            json!({
                "type": "mermaid", "id": "m1", "source": "flowchart LR\n  A --> B",
                "children": [{ "type": "mermaid_caption", "children": [{ "text": "" }] }],
            }),
        );
        assert!(
            matches!(&diagram, Err(DocumentError::Edit { code, .. }) if code == "invalid_input"),
            "{:?}",
            diagram.as_ref().err()
        );
    }

    /// A server write of a quiz (an agent edit, the save API) whose documents
    /// hold a block kind its rooms do not admit is refused, so no rebuilt
    /// quiz drops the block (review M1). Fails if the quiz is rebuilt.
    #[test]
    fn a_quiz_holding_an_unknown_block_is_not_rebuilt() {
        let rebuilt = |stem: serde_json::Value| {
            let value = [json!({ "type": "quiz", "id": "quiz", "children": [{
                "type": "quiz_question", "id": "q1", "children": [{ "text": "" }],
                "question": {
                    "id": "q1", "labels": "letters", "layout": "paper", "stem": stem,
                    "parts": [{
                        "id": "q1:part:1", "marks": 1, "solution": [],
                        "blocks": [{ "type": "text", "text": "True?" }],
                        "answer": { "type": "boolean", "correct": true },
                    }],
                },
            }] })];
            let (content, keys) = items::quiz::states_from_value(&value, 0);
            let content = Scratch::new(&content, &[], None, &HashSet::new()).unwrap();
            let keys = Scratch::new(&keys, &[], None, &HashSet::new()).unwrap();
            compute_quiz(&content, &keys, |_, _| {
                Ok(notes::edit::EditOutcome::default())
            })
        };
        assert!(matches!(
            rebuilt(json!([{ "type": "timeline", "events": [] }])),
            Err(DocumentError::Edit { code, .. }) if code == "unsupported_operation"
        ));
        assert!(rebuilt(json!([{ "type": "text", "text": "Stem" }])).is_ok());
    }

    /// A quiz edit that only removes a question writes both documents, though
    /// a deletion moves neither state vector.
    #[test]
    fn a_removal_only_quiz_edit_writes_both_documents() {
        let question = |id: &str| {
            json!({
                "type": "quiz_question", "id": id, "children": [{ "text": "" }],
                "question": {
                    "id": id, "labels": "letters", "layout": "paper", "stem": [],
                    "parts": [{
                        "id": format!("{id}-p"), "marks": 1, "solution": [],
                        "blocks": [{ "type": "text", "text": "True?" }],
                        "answer": { "type": "boolean", "correct": true },
                    }],
                },
            })
        };
        let value =
            [json!({ "type": "quiz", "id": "quiz", "children": [question("q1"), question("q2")] })];
        let (content, keys) = items::quiz::states_from_value(&value, 0);
        let content = Scratch::new(&content, &[], None, &HashSet::new()).unwrap();
        let keys = Scratch::new(&keys, &[], None, &HashSet::new()).unwrap();
        let remove = notes::edit::DocumentCommand::RemoveChild {
            parent_type: "quiz".into(),
            node_id: "q2".into(),
        };
        let computed = compute_quiz(&content, &keys, |content, keys| {
            items::quiz::apply_commands(content, keys, &[remove])?;
            Ok(notes::edit::EditOutcome::default())
        })
        .unwrap();
        let docs: Vec<_> = computed.writes.iter().map(|write| write.doc).collect();
        assert_eq!(
            docs,
            [
                crate::note_store::Doc::Content,
                crate::note_store::Doc::Keys
            ]
        );
    }

    /// What a computed write's Undo and Redo send at most in a room holding
    /// `base` that took the write as a room takes it (`apply_kept`), measured
    /// on copies of the room.
    fn sent_by(base: &[u8], write: super::Write) -> usize {
        let room = ydoc::scratch_doc();
        ydoc::apply(&room, ydoc::decode(base).unwrap()).unwrap();
        let update = write.live_update.unwrap();
        ydoc::undo::apply_kept(&room, ydoc::decode(&update).unwrap()).unwrap();
        let change = write.captured.unwrap().change(&room);
        let undo = ydoc::undo::revert_len(&room, &change);
        let redo = ydoc::undo::revert(&room, change)
            .and_then(|reverted| reverted.next)
            .map_or(0, |back| ydoc::undo::revert_len(&room, &back));
        undo.max(redo)
    }

    /// `commands` computed as an agent edit of a loaded room (a quiz: with
    /// its keys room): the edit's Undo cost and the most any of its rooms'
    /// Undo or Redo sends; none when the commands are refused.
    fn cost_and_sent(
        kind: &str,
        base: &[u8],
        keys: Option<&[u8]>,
        commands: Vec<notes::edit::DocumentCommand>,
    ) -> Option<(usize, usize)> {
        let quiz = keys.map(|keys| super::QuizInput {
            keys: (keys.to_vec(), Vec::new()),
            live_keys: Some(keys.to_vec()),
        });
        let live = Some(base.to_vec());
        let computed = compute(
            base.to_vec(),
            Vec::new(),
            live,
            kind.into(),
            commands,
            quiz,
            &HashSet::new(),
        )
        .ok()?;
        let cost = computed.undo_cost;
        let sent = computed
            .writes
            .into_iter()
            .map(|write| match write.doc {
                crate::note_store::Doc::Keys => sent_by(keys.unwrap(), write),
                crate::note_store::Doc::Content => sent_by(base, write),
            })
            .max()
            .unwrap_or(0);
        Some((cost, sent))
    }

    /// Every `id` in `node` made new, for a copy to insert beside it.
    fn copy_of(node: &serde_json::Value) -> serde_json::Value {
        match node {
            serde_json::Value::Object(map) => map
                .iter()
                .map(|(key, value)| match (key.as_str(), value) {
                    ("id", serde_json::Value::String(id)) => (key.clone(), json!(format!("{id}c"))),
                    _ => (key.clone(), copy_of(value)),
                })
                .collect(),
            serde_json::Value::Array(values) => values.iter().map(copy_of).collect(),
            other => other.clone(),
        }
    }

    /// Epo 2026-10-21: an agent edit's Undo is sized from its commands
    /// (`sources::undo_cost`), never by reverting on a copy. On the notes
    /// corpus's seeded notes (paragraphs, lists, tables, math), a Mermaid
    /// block with a long caption rewritten as a small one (the kept caption
    /// rides its Redo), a card set and a quiz, every material command's cost
    /// is at least what the edit's Undo and Redo send in each of its rooms
    /// (measured on copies here). The lowest and highest ratio per command
    /// print (STATE.md keeps them).
    /// Fails if a rule under-estimates.
    #[test]
    fn every_material_command_costs_at_least_what_its_undo_and_redo_send() {
        use base64::Engine;
        use notes::edit::DocumentCommand;
        use std::io::Read;
        use yrs::Transact;
        let mut ratios: std::collections::BTreeMap<&str, (f64, f64, usize)> = Default::default();
        let mut short = Vec::new();
        let mut check = |name: &'static str, result: Option<(usize, usize)>| {
            let Some((cost, sent)) = result else { return };
            if cost < sent {
                short.push(format!("{name}: cost {cost} < sent {sent}"));
            }
            let ratio = cost as f64 / sent.max(1) as f64;
            let entry = ratios.entry(name).or_insert((f64::MAX, 0.0, 0));
            *entry = (entry.0.min(ratio), entry.1.max(ratio), entry.2 + 1);
        };

        let mut text = String::new();
        flate2::read::GzDecoder::new(
            std::fs::File::open(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../notes/tests/corpus/commands.json.gz"
            ))
            .unwrap(),
        )
        .read_to_string(&mut text)
        .unwrap();
        let corpus: serde_json::Value = serde_json::from_str(&text).unwrap();
        let mut seen = std::collections::HashSet::new();
        for case in corpus.as_array().unwrap() {
            let state = case["state"].as_str().unwrap();
            if !seen.insert(state.to_owned()) {
                continue;
            }
            let base = base64::engine::general_purpose::STANDARD
                .decode(state)
                .unwrap();
            let doc = ydoc::scratch_doc();
            ydoc::apply(&doc, ydoc::decode(&base).unwrap()).unwrap();
            let blocks = notes::edit::inspect_material(&doc.transact()).unwrap();
            let value = notes::plate::value(&doc.transact()).unwrap();
            for block in blocks {
                let Some(node) = value.iter().find(|node| node["id"] == block.id.as_str()) else {
                    continue;
                };
                let (id, expected) = (block.id.clone(), block.text.clone());
                let note = |commands| cost_and_sent("note", &base, None, commands);
                check(
                    "remove_block",
                    note(vec![DocumentCommand::RemoveBlock {
                        block_id: id.clone(),
                        expected_text: expected.clone(),
                    }]),
                );
                check(
                    "replace_block",
                    note(vec![DocumentCommand::ReplaceBlock {
                        block_id: id.clone(),
                        expected_text: expected.clone(),
                        blocks: vec![copy_of(node)],
                    }]),
                );
                check(
                    "insert_block",
                    note(vec![DocumentCommand::InsertBlock {
                        after_block_id: Some(id.clone()),
                        blocks: vec![copy_of(node)],
                    }]),
                );
                if !expected.is_empty() {
                    check(
                        "replace_text",
                        note(vec![DocumentCommand::ReplaceText {
                            block_id: Some(id),
                            text: format!("{expected} and a little more"),
                            expected_text: expected,
                        }]),
                    );
                }
            }
        }

        // A front holds at most 200 characters and a back 1000.
        let card = |id: &str, words: usize| {
            json!({
                "type": "flashcard", "id": id,
                "children": [
                    { "type": "flashcard_front", "children": [{ "text": "front ".repeat(words.min(30)) }] },
                    { "type": "flashcard_back", "children": [{ "text": "back ".repeat(words) }] },
                ],
            })
        };
        let set = items::flashcards::state_from_value(
            &[json!({
                "type": "flashcards", "id": "flashcards_1",
                "children": [card("c1", 3), card("c2", 40), card("c3", 190)],
            })],
            0,
        );
        let cards = |command| cost_and_sent("flashcards", &set, None, vec![command]);
        for (id, words) in [("c1", 3), ("c2", 40), ("c3", 190)] {
            check(
                "replace_card",
                cards(DocumentCommand::ReplaceCard {
                    card_id: id.into(),
                    front: Some("new front ".repeat(15)),
                    back: Some("new back ".repeat(60)),
                    expected_front: Some("front ".repeat(words.min(30))),
                    expected_back: Some("back ".repeat(words)),
                }),
            );
            check(
                "remove_child",
                cards(DocumentCommand::RemoveChild {
                    parent_type: "flashcards".into(),
                    node_id: id.into(),
                }),
            );
            check(
                "insert_child",
                cards(DocumentCommand::InsertChild {
                    parent_type: "flashcards".into(),
                    after_node_id: Some(id.into()),
                    node: card(&format!("{id}n"), 100),
                }),
            );
        }

        // A rewrite keeps the old block's caption (`keep_caption`): a long
        // caption moves onto a small new block, so the Redo carries it.
        let mermaid = |id: &str, source: &str, caption: &str| {
            json!({
                "type": "mermaid", "id": id, "source": source, "width": "60%",
                "children": [{ "type": "mermaid_caption", "children": [{ "text": caption }] }],
            })
        };
        let captioned = Model::Note.state_from_value(&[mermaid(
            "m1",
            "flowchart LR\n  A --> B",
            &"A long caption. ".repeat(4000),
        )]);
        let kept = cost_and_sent(
            "note",
            &captioned,
            None,
            vec![DocumentCommand::ReplaceBlock {
                block_id: "m1".into(),
                expected_text: "flowchart LR\n  A --> B".into(),
                blocks: vec![mermaid("m2", "flowchart LR\n  A --> C", "")],
            }],
        );
        assert!(kept.is_some(), "the captioned rewrite was refused");
        check("replace_block", kept);

        let question = |id: &str, words: usize| {
            json!({
                "type": "quiz_question", "id": id, "children": [{ "text": "" }],
                "question": {
                    "id": id, "labels": "letters", "layout": "paper",
                    "stem": [{ "type": "text", "text": "Why is that so? ".repeat(words) }],
                    "parts": [{
                        "id": format!("{id}-p"), "marks": 2,
                        "solution": [{ "type": "text", "text": "Because. ".repeat(words) }],
                        "blocks": [{ "type": "text", "text": "True? ".repeat(words) }],
                        "answer": { "type": "boolean", "correct": true },
                    }],
                },
            })
        };
        let (content, keys) = items::quiz::states_from_value(
            &[
                json!({ "type": "quiz", "id": "quiz", "children": [question("q1", 2), question("q2", 80)] }),
            ],
            0,
        );
        let quiz = |command| cost_and_sent("quiz", &content, Some(&keys), vec![command]);
        for id in ["q1", "q2"] {
            check(
                "quiz replace_child",
                quiz(DocumentCommand::ReplaceChild {
                    parent_type: "quiz".into(),
                    node_id: id.into(),
                    node: question(id, 50),
                }),
            );
            check(
                "quiz remove_child",
                quiz(DocumentCommand::RemoveChild {
                    parent_type: "quiz".into(),
                    node_id: id.into(),
                }),
            );
            check(
                "quiz insert_child",
                quiz(DocumentCommand::InsertChild {
                    parent_type: "quiz".into(),
                    after_node_id: Some(id.into()),
                    node: question(&format!("{id}n"), 50),
                }),
            );
        }

        for (name, (lowest, highest, count)) in &ratios {
            eprintln!(
                "undo_cost {name}: {count} cases, cost/sent from {lowest:.1} to {highest:.1}"
            );
        }
        for name in [
            "remove_block",
            "replace_block",
            "insert_block",
            "replace_text",
            "replace_card",
            "remove_child",
            "insert_child",
            "quiz replace_child",
            "quiz remove_child",
            "quiz insert_child",
        ] {
            assert!(ratios.contains_key(name), "no {name} case ran");
        }
        assert!(short.is_empty(), "{short:#?}");
    }
}
