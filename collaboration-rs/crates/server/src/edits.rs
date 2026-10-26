//! The gateway's internal document routes (`server.ts` handleDocumentRequest,
//! handleServiceCommandRequest, handleMarkdownRequest): direct AI edits of a
//! material or a source, their Undo, the inspect view, the replace-block
//! command and agent markdown. A material edit runs on an isolated document
//! (the durable base and rows merged with this instance's live room) under
//! the material lock, and commits its row with the receipt in one
//! transaction; only the committed change then reaches the live room, whose
//! durable cover takes it in (DESIGN.md 3.2). An edit made while its room was
//! loaded returns its Undo payload (`ydoc::undo`, Epo 2026-10-21), which the
//! chat keeps and sends back: the Undo (and Redo) is written exactly as an
//! edit is, on the stored state merged with the live room when one is loaded.

use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use notes::edit::{DocumentCommand, EditError, EditOutcome};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use ydoc::undo::Captured;
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, Snapshot, StateVector, Transact, WriteTxn};

use crate::access::{self, AccessError};
use crate::app::Shared;
use crate::auth::RoomName;
use crate::markers;
use crate::model::Model;
use crate::note_store;
use crate::observe;
use crate::projection;
use crate::room::{RoomCmd, ServiceEdit};
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
    /// 503 `unavailable_target`: the room is being reset. The edit was
    /// refused before anything applied, so the outcome is known and the
    /// caller may retry; logged, not reported.
    Unavailable(&'static str),
    /// 503 `outcome_unknown` (reported).
    Unknown(String),
}

/// An edit's refusal while its room is reset or discarded ([DocumentError::Unavailable]).
pub const ROOM_RESET: &str = "collaboration room is being reset";
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
    /// `/internal/documents/undo`: the Undo (or Redo) payload sent back.
    pub undo: Option<UndoPayload>,
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

/// An Undo payload as this server builds it and takes it back (Epo
/// 2026-10-21): per document the write changed ("content", a quiz's "keys",
/// a source's "source"), the update that reverses it, base64, and the
/// lineage it was made in (a material's room schema, a source's epoch).
/// Never stored here: the gateway signs it and the chat keeps it for a day.
#[derive(Clone, Debug, Deserialize, serde::Serialize)]
pub struct UndoPayload {
    pub epoch: i64,
    pub updates: BTreeMap<String, String>,
}

/// A material document's name in a payload.
fn doc_name(doc: note_store::Doc) -> &'static str {
    match doc {
        note_store::Doc::Content => "content",
        note_store::Doc::Keys => "keys",
    }
}

impl UndoPayload {
    fn of(epoch: i64, updates: Vec<(note_store::Doc, Vec<u8>)>) -> Self {
        UndoPayload {
            epoch,
            updates: updates
                .into_iter()
                .map(|(doc, update)| (doc_name(doc).to_owned(), BASE64.encode(update)))
                .collect(),
        }
    }

    /// The updates' bytes by document name; refused when one does not decode
    /// or all together pass the 8 MiB update cap (what an Undo may send).
    fn bytes(&self) -> Result<Vec<(&str, Vec<u8>)>, DocumentError> {
        let mut out = Vec::new();
        let mut total = 0usize;
        for (name, update) in &self.updates {
            let bytes = BASE64
                .decode(update)
                .map_err(|_| DocumentError::Invalid("invalid undo payload".into()))?;
            total = total.saturating_add(bytes.len());
            out.push((name.as_str(), bytes));
        }
        if total > ydoc::MAX_UPDATE_BYTES {
            return Err(undo_unavailable("this edit is too large to undo"));
        }
        Ok(out)
    }

    /// A material's updates by document; a name it does not have is
    /// invalid.
    fn material(
        &self,
        docs: &[note_store::Doc],
    ) -> Result<Vec<(note_store::Doc, Vec<u8>)>, DocumentError> {
        let invalid = || DocumentError::Invalid("invalid undo payload".into());
        let mut out = Vec::new();
        for (name, bytes) in self.bytes()? {
            let doc = docs
                .iter()
                .copied()
                .find(|doc| doc_name(*doc) == name)
                .ok_or_else(invalid)?;
            out.push((doc, bytes));
        }
        if out.is_empty() {
            return Err(invalid());
        }
        Ok(out)
    }
}

/// The Undo ref an agent step's receipt carries.
fn undo_ref(operation_id: &str) -> Value {
    json!({ "operationId": operation_id, "status": "available" })
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

/// One document a server edit changed: its row, the cover it makes and what
/// its live room lacks of it.
struct Write {
    doc: note_store::Doc,
    row: Vec<u8>,
    durable: ydoc::Durable,
    live_update: Option<Vec<u8>>,
}

/// What a server write of a material applies: the agent's commands, or an
/// Undo payload sent back (Epo 2026-10-21), its update per document.
enum Change {
    Commands(Vec<DocumentCommand>),
    Undo(Vec<(note_store::Doc, Vec<u8>)>),
}

/// What an edit computed on its isolated documents.
struct Computed {
    /// One per changed document (a quiz may change both). None for an Undo
    /// payload applied before.
    writes: Vec<Write>,
    value: Vec<Value>,
    /// A quiz: every editor asset its documents reference (REVIEW1 S4).
    asset_ids: Option<Vec<String>>,
    outcome: EditOutcome,
    /// What the edit's Undo may send ([undo_cost]).
    undo_cost: usize,
    /// The payload that reverses this write, by document: an edit's Undo, an
    /// Undo's Redo ([undo_payload]).
    undo: Option<Vec<(note_store::Doc, Vec<u8>)>>,
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

/// The payload reversing a write: each changed document's revert, made on
/// its working copy after its write was encoded (`ydoc::undo::payload`).
/// None when nothing reverts, or past the 8 MiB update cap in all.
fn undo_payload(
    parts: Vec<(note_store::Doc, &yrs::Doc, Captured)>,
) -> Option<Vec<(note_store::Doc, Vec<u8>)>> {
    let updates: Vec<_> = parts
        .into_iter()
        .filter_map(|(name, doc, captured)| Some((name, ydoc::undo::payload(doc, captured)?)))
        .collect();
    let total: usize = updates.iter().map(|(_, update)| update.len()).sum();
    (!updates.is_empty() && total <= ydoc::MAX_UPDATE_BYTES).then_some(updates)
}

/// A payload sent back, applied to `doc` (`ydoc::undo::apply_payload`): the
/// change it made, or None when it was applied before. Refused when nothing
/// of the edit is left or it names items this document does not hold.
fn sent_back(doc: &yrs::Doc, update: &[u8]) -> Result<Option<Captured>, DocumentError> {
    let update =
        ydoc::decode(update).map_err(|_| DocumentError::Invalid("invalid undo payload".into()))?;
    match ydoc::undo::apply_payload(doc, update).map_err(|_| undo_unavailable(UNDO_GONE))? {
        ydoc::undo::Applied::Changed(change) => Ok(Some(change)),
        ydoc::undo::Applied::Before => Ok(None),
        ydoc::undo::Applied::Nothing => {
            Err(undo_unavailable("nothing of this edit is left to undo"))
        }
        ydoc::undo::Applied::Unheld => Err(undo_unavailable(UNDO_GONE)),
    }
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
    fn write(&self, doc: note_store::Doc) -> Option<Write> {
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
        })
    }
}

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

/// A quiz's keys document base and log, under the caller's snapshot.
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

/// What a quiz write did to its two documents: the outcome and each
/// document's change (an Undo payload applied before: none).
type QuizChanged = (EditOutcome, Option<(Captured, Captured)>);

/// A server write of a quiz (an agent edit, an Undo, the save API): `edit`
/// runs on both documents; caps hold for each and the limits for both
/// together (REVIEW1 S3); the projection is the complete questions.
fn compute_quiz(
    content: &Scratch,
    keys: &Scratch,
    edit: impl FnOnce(&yrs::Doc, &yrs::Doc) -> Result<QuizChanged, DocumentError>,
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
    let (outcome, changes) = edit(&content.doc, &keys.doc)?;
    let Some((content_items, keys_items)) = changes else {
        return Ok(Computed {
            writes: Vec::new(),
            value: Vec::new(),
            asset_ids: None,
            outcome,
            undo_cost: 0,
            undo: None,
        });
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
    let writes: Vec<Write> = [
        content.write(note_store::Doc::Content),
        keys.write(note_store::Doc::Keys),
    ]
    .into_iter()
    .flatten()
    .collect();
    let written = |doc| writes.iter().any(|write| write.doc == doc);
    let parts = [
        (note_store::Doc::Content, &content.doc, content_items),
        (note_store::Doc::Keys, &keys.doc, keys_items),
    ]
    .into_iter()
    .filter(|(doc, _, _)| written(*doc))
    .collect();
    Ok(Computed {
        undo: undo_payload(parts),
        writes,
        value,
        asset_ids,
        outcome,
        undo_cost: 0,
    })
}

/// The quiz commands on both documents, keeping what they delete for the
/// Undo payload.
fn quiz_commands(
    content: &yrs::Doc,
    keys: &yrs::Doc,
    commands: &[DocumentCommand],
) -> Result<QuizChanged, DocumentError> {
    let (_content, _keys) = (ydoc::undo::keep(content), ydoc::undo::keep(keys));
    let mut content_txn = content.transact_mut_with(ydoc::undo::ORIGIN);
    let mut keys_txn = keys.transact_mut_with(ydoc::undo::ORIGIN);
    items::quiz::apply_commands(&mut content_txn, &mut keys_txn, commands)?;
    Ok((
        EditOutcome::default(),
        Some((Captured::of(&mut content_txn), Captured::of(&mut keys_txn))),
    ))
}

/// The edit itself, on a document of the durable state plus the live room
/// (a quiz: on both its documents). An agent edit builds its Undo payload
/// when its estimate fits the update cap; an Undo always builds its Redo
/// payload.
fn compute(
    base: Vec<u8>,
    rows: Vec<Vec<u8>>,
    live: Option<Vec<u8>>,
    kind: String,
    change: Change,
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
        let computed = match change {
            Change::Commands(commands) => {
                let cost = undo_cost(
                    &commands,
                    &[
                        &items::Kind::Quiz.document_value(&scratch.doc.transact()),
                        &items::Kind::QuizKeys.document_value(&keys.doc.transact()),
                    ],
                );
                let mut computed = compute_quiz(&scratch, &keys, |content, keys| {
                    quiz_commands(content, keys, &commands)
                })?;
                computed.undo_cost = cost;
                if cost > ydoc::MAX_UPDATE_BYTES {
                    computed.undo = None;
                }
                computed
            }
            Change::Undo(updates) => compute_quiz(&scratch, &keys, |content, keys| {
                let mut changes = (Captured::default(), Captured::default());
                for (doc, update) in updates {
                    let (target, slot) = match doc {
                        note_store::Doc::Content => (content, &mut changes.0),
                        note_store::Doc::Keys => (keys, &mut changes.1),
                    };
                    match sent_back(target, &update)? {
                        Some(change) => *slot = change,
                        None => return Ok((EditOutcome::default(), None)),
                    }
                }
                Ok((EditOutcome::default(), Some(changes)))
            })?,
        };
        return Ok(computed);
    }
    let doc = &scratch.doc;
    let model = Model::of(&kind);
    let before = model.document_value(&doc.transact()).map_err(unknown)?;
    let previous = notes::limits::measure_value(&before);
    // Every edit's Undo payload is built here, from its working copy, whether
    // or not a room is loaded (Epo 2026-10-22), when its estimate fits the
    // update cap; an Undo's Redo payload always.
    let (outcome, captured, cost, offered) = match change {
        Change::Commands(commands) => {
            let cost = undo_cost(&commands, &[&before]);
            let _keep = ydoc::undo::keep(doc);
            let mut txn = doc.transact_mut_with(ydoc::undo::ORIGIN);
            let outcome = match model {
                Model::Item(item) => {
                    item.apply_commands(&mut txn, &commands)?;
                    EditOutcome::default()
                }
                Model::Note => {
                    let root = txn.get_or_insert_text(notes::plate::CONTENT_ROOT);
                    let outcome = notes::edit::apply_material_commands(&mut txn, &root, &commands)?;
                    // A note the edit emptied gets its empty paragraph in the
                    // same transaction, so no editor sees it empty and its
                    // Undo takes the paragraph out again (Epo 2026-10-21).
                    // Other kinds require their block: the check below
                    // refuses one left without it.
                    notes::repair::emptied(&mut txn, &kind);
                    outcome
                }
            };
            let offered = cost <= ydoc::MAX_UPDATE_BYTES;
            (outcome, Some(Captured::of(&mut txn)), cost, offered)
        }
        Change::Undo(updates) => {
            let mut captured = None;
            for (_, update) in updates {
                captured = sent_back(doc, &update)?;
            }
            if captured.is_none() {
                return Ok(Computed {
                    writes: Vec::new(),
                    value: Vec::new(),
                    asset_ids: None,
                    outcome: EditOutcome::default(),
                    undo_cost: 0,
                    undo: None,
                });
            }
            // An Undo or Redo that leaves a note with no block gets its empty
            // paragraph, the repair every writer gets (Epo 2026-10-22), in a
            // transaction of its own: the Redo payload holds only the revert,
            // so a Redo neither fails nor takes the paragraph out.
            if model == Model::Note {
                notes::repair::emptied(&mut doc.transact_mut(), &kind);
            }
            (EditOutcome::default(), captured, 0, true)
        }
    };
    if let Model::Item(item) = model {
        item.check_caps(&doc.transact())
            .map_err(|error| DocumentError::edit("invalid_input", &error))?;
    }
    let document = model.document_value(&doc.transact()).map_err(unknown)?;
    // A whole document the check refuses (an 11th interactive block across a
    // note) is a refusal naming the rule; logged, since a command that built
    // a wrong document refuses the same way.
    notes::material::assert_canonical(&document, &kind).map_err(|error| {
        observe::log(
            observe::Level::Warn,
            "agent edit refused by the material check",
            json!({ "error": error.0, "kind": kind }),
        );
        DocumentError::edit("invalid_input", error.to_string())
    })?;
    let metrics = notes::limits::measure_value(&document);
    if let Some(code) = notes::limits::limit_code(&metrics)
        && !notes::limits::recovers(&metrics, Some(&previous))
    {
        return Err(DocumentError::Quota(code.as_str().into()));
    }
    let value = model.value(&doc.transact()).map_err(unknown)?;
    // An agent edit always writes (its markers at least), as before.
    let hidden = markers::live_items(doc);
    let (row, durable) = ydoc::delta_update(&doc.transact(), &scratch.durable, &hidden);
    let live_update = scratch
        .live
        .as_ref()
        .map(|vector| doc.transact().encode_state_as_update_v1(vector));
    let undo = captured
        .filter(|_| offered)
        .and_then(|captured| undo_payload(vec![(note_store::Doc::Content, doc, captured)]));
    Ok(Computed {
        writes: vec![Write {
            doc: note_store::Doc::Content,
            row,
            durable,
            live_update,
        }],
        value,
        asset_ids: None,
        outcome,
        undo_cost: cost,
        undo,
    })
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
/// live room, the children pass and the projection follow. With `undo` the
/// write is an Undo (or Redo) payload sent back: checked and committed as an
/// agent edit is, under the same locks and access, with no receipt (Go
/// records it) and its Redo payload as the answer.
pub async fn edit_material(
    app: &Shared,
    request: &DocumentRequest,
) -> Result<Value, DocumentError> {
    let (room, material_id, schema) = material_room(request)?;
    let operation = request
        .operation
        .clone()
        .ok_or_else(|| DocumentError::edit("invalid_input", "operation identity is required"))?;
    let undo = request.undo.as_ref();
    if let Some(undo) = undo
        && ydoc::undo::refused_across_compaction(undo.epoch, schema)
    {
        return Err(undo_unavailable(UNDO_GONE));
    }
    if app.evictions.blocks(&room, false) {
        return Err(DocumentError::Unavailable(ROOM_RESET));
    }
    let change = match undo {
        Some(undo) => {
            Change::Undo(undo.material(&[note_store::Doc::Content, note_store::Doc::Keys])?)
        }
        None => Change::Commands(parse::<Vec<DocumentCommand>>(
            Value::Array(request.commands.clone()),
            "commands",
        )?),
    };
    let live = live_state(app, &room).await;
    let actor = request.actor_user_id.clone();
    let mut client = app
        .db
        .get()
        .await
        .map_err(|error| DocumentError::Unknown(error.to_string()))?;
    let tx = client.transaction().await?;
    if undo.is_none() {
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
    }
    access::lock_material(&tx, &material_id).await?;
    access::lock_boundary(&tx, &material_id, std::slice::from_ref(&actor), &[]).await?;
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
    if undo.is_some() && ydoc::undo::refused_across_compaction(schema, rebuilt) {
        return Err(undo_unavailable(UNDO_GONE));
    }
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
        compute(base, rows, live, kind, change, quiz, &assigned)
    })
    .await
    .map_err(|error| DocumentError::Unknown(error.to_string()))??;
    // A payload applied before (a retry whose answer was lost): done, with
    // no Redo, since what it removed is collected.
    if computed.writes.is_empty() && undo.is_some() {
        tx.commit().await?;
        return Ok(json!({ "undo": null }));
    }
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
    let payload = computed
        .undo
        .map(|updates| UndoPayload::of(schema, updates));
    let mut receipt = match undo {
        Some(_) => json!({ "undo": payload }),
        None => {
            insert_receipt(
                &tx,
                request,
                &operation,
                &material_id,
                &computed.outcome,
                payload.is_some(),
            )
            .await?
        }
    };
    tx.commit().await?;
    drop(client);
    if undo.is_none()
        && let Some(payload) = payload
    {
        receipt["undoPayload"] = json!(payload);
    }
    // An AI edit or its Undo can bring back a quiz or image the note had
    // trashed (restored) or one purged since (dropped).
    if let Some(write) = computed
        .writes
        .iter()
        .find(|write| write.doc == note_store::Doc::Content)
    {
        crate::children::queue(app, &room, &actor, write.row.clone());
    }
    // The committed changes go to the live rooms, whose durable covers take
    // them.
    send_writes(app, &room, &keys_room, computed.writes, &versions).await;
    let content = json!({ "schemaVersion": 1, "value": computed.value });
    match projection::project(app, &material_id, version, &content, computed.asset_ids).await {
        Ok(()) => {
            if undo.is_none() {
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
            }
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

/// An agent edit's receipt, written with its row: `edited`, its block
/// moves, and its Undo ref when it has a payload. The payload itself is
/// never stored.
async fn insert_receipt(
    tx: &deadpool_postgres::Transaction<'_>,
    request: &DocumentRequest,
    operation: &Operation,
    material_id: &str,
    outcome: &EditOutcome,
    undoable: bool,
) -> Result<Value, DocumentError> {
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
    if !outcome.relocated.is_empty() {
        effect["relocated"] = json!(outcome.relocated);
    }
    if undoable {
        effect["undo"] = undo_ref(&operation.id);
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
            &request.actor_user_id,
            &workspace_id,
            &operation.conversation_id.clone().unwrap_or_default(),
            &operation.message_id.clone().unwrap_or_default(),
            &operation.call_id.clone().unwrap_or_default(),
            &effect,
        ],
    )
    .await?;
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
        &[],
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
    send_writes(app, &room, &keys_room, computed.writes, &versions).await;
    let content = json!({ "schemaVersion": 1, "value": computed.value });
    projection::project(app, &material_id, version, &content, computed.asset_ids).await?;
    if let Some(handle) = app.rooms.get(&room) {
        let _ = handle.tx.send(RoomCmd::Projected(version, Ok(()))).await;
    }
    Ok(())
}

/// Each write to its live room (the content room, or a quiz's keys room)
/// with the version its row took.
async fn send_writes(
    app: &Shared,
    room: &str,
    keys_room: &str,
    writes: Vec<Write>,
    versions: &[i64],
) {
    for (write, version) in writes.into_iter().zip(versions) {
        let (name, other) = match write.doc {
            note_store::Doc::Content => (room, keys_room),
            note_store::Doc::Keys => (keys_room, room),
        };
        match app.rooms.get(name) {
            Some(handle) => {
                let edit = ServiceEdit {
                    update: write.live_update.unwrap_or_else(|| write.row.clone()),
                    durable: write.durable,
                    version: *version as u64,
                    row_bytes: write.row.len(),
                };
                let _ = handle.tx.send(RoomCmd::ServiceEdit(Box::new(edit))).await;
            }
            // A quiz document whose room is not loaded changed: the other
            // one's room reads it (its metrics; the keys' readers' lists).
            None => {
                if let Some(handle) = app.rooms.get(other) {
                    let _ = handle.tx.send(RoomCmd::PeerReload).await;
                }
            }
        }
    }
}

/// The Undo ref of a source edit with a payload, stored on Go's receipt (the
/// checkpoint wrote it), then shown on it (a receipt whose ref did not store
/// has none, and gets no payload).
async fn offer_undo(app: &Shared, operation_id: &str, receipt: &mut Value) -> bool {
    let undo = undo_ref(operation_id);
    let Ok(client) = app.db.get().await else {
        return false;
    };
    let stored = client
        .execute(
            "UPDATE agent_operations SET effect = jsonb_set(effect, '{undo}', $2)
             WHERE id=$1 AND effect IS NOT NULL",
            &[&operation_id, &undo],
        )
        .await;
    let offered = matches!(stored, Ok(1));
    if offered {
        receipt["effect"]["undo"] = undo;
    }
    offered
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
            let mut content_txn = content.transact_mut();
            let mut keys_txn = keys.transact_mut();
            items::quiz::set_questions(&mut content_txn, &mut keys_txn, &questions)
                .map_err(|error| DocumentError::edit("invalid_input", error))?;
            Ok((
                EditOutcome::default(),
                Some((Captured::default(), Captured::default())),
            ))
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
            .write(note_store::Doc::Content)
            .into_iter()
            .collect(),
        value,
        asset_ids: None,
        outcome: EditOutcome::default(),
        undo_cost: 0,
        undo: None,
    }))
}

/// Inspect or edit of a source file (the sources crate), with the committed
/// change fanned into the live room. With `undo`, an Undo (or Redo) payload
/// sent back, written as an edit is; its answer is the Redo payload.
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
    let undo = match &request.undo {
        Some(undo) => {
            let mut bytes = undo.bytes()?;
            let invalid = || DocumentError::Invalid("invalid undo payload".into());
            let (name, update) = bytes.pop().ok_or_else(invalid)?;
            if name != "source" || !bytes.is_empty() {
                return Err(invalid());
            }
            Some(sources::edit::SentBack {
                epoch: undo.epoch,
                update,
            })
        }
        None => None,
    };
    let undoing = undo.is_some();
    let input = sources::edit::EditInput {
        actor_user_id: request.actor_user_id.clone(),
        commands: request.commands.clone(),
        file_id: request.target.id.clone(),
        operation: serde_json::to_value(&operation).unwrap_or(Value::Null),
        undo,
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
    if let (Some(handle), Some(update)) = (app.rooms.get(&result.room), result.update) {
        let edit = ServiceEdit {
            update,
            durable: result.durable,
            version: result.checkpoint,
            row_bytes: result.row_bytes,
        };
        let _ = handle.tx.send(RoomCmd::ServiceEdit(Box::new(edit))).await;
    }
    let payload = result.undo.map(|update| UndoPayload {
        epoch: result.epoch,
        updates: BTreeMap::from([("source".to_owned(), BASE64.encode(update))]),
    });
    if undoing {
        return Ok(json!({ "undo": payload }));
    }
    // Go passes the engine's note on the characters the agent's text lost
    // on to the tool result (Epo 2026-10-15).
    let mut receipt = result.receipt;
    if let Some(payload) = payload
        && offer_undo(app, &operation.id, &mut receipt).await
    {
        receipt["undoPayload"] = json!(payload);
    }
    if let Some(notice) = result.notice {
        receipt["notice"] = json!(notice);
    }
    Ok(receipt)
}

/// The refusal of an Undo whose payload can no longer apply.
const UNDO_GONE: &str = "this edit can no longer be undone";

fn undo_unavailable(message: &str) -> DocumentError {
    DocumentError::edit("undo_unavailable", message)
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

/// `/internal/documents/{create,inspect,edit,undo}` after the secret check.
/// An Undo carries its payload (`undo`); an edit never does.
pub async fn document(app: &Shared, path: &str, body: &[u8]) -> Result<Value, DocumentError> {
    if path.ends_with("/create") {
        return create(app, body).await;
    }
    let invalid = || DocumentError::Invalid("invalid document request".into());
    let request: DocumentRequest = serde_json::from_slice(body).map_err(|_| invalid())?;
    if request.target.kind != "material" && request.target.kind != "source_file" {
        return Err(invalid());
    }
    if path.ends_with("/undo") != request.undo.is_some() {
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

    use super::{
        Change, DocumentError, Model, Scratch, Write, compute, compute_quiz, over_update_cap,
    };

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
            Change::Commands(vec![insert]),
            None,            &HashSet::new(),
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
                Change::Commands(vec![notes::edit::DocumentCommand::RemoveBlock {
                    block_id: id,
                    expected_text: expected,
                }]),
                None,                &HashSet::new(),
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
                Ok((
                    notes::edit::EditOutcome::default(),
                    Some(Default::default()),
                ))
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
            super::quiz_commands(content, keys, &[remove])
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

    /// The Redo payload's size of `undo`, a document's Undo payload, sent
    /// back to `base` with the edit's write applied (the stored document).
    fn redo_sent(base: &[u8], write: &Write, undo: &[u8]) -> usize {
        let room = ydoc::scratch_doc();
        ydoc::apply(&room, ydoc::decode(base).unwrap()).unwrap();
        let update = write.live_update.as_ref().unwrap();
        ydoc::apply(&room, ydoc::decode(update).unwrap()).unwrap();
        match ydoc::undo::apply_payload(&room, ydoc::decode(undo).unwrap()).unwrap() {
            ydoc::undo::Applied::Changed(change) => {
                ydoc::undo::payload(&room, change).map_or(0, |redo| redo.len())
            }
            other => panic!("{other:?}"),
        }
    }

    /// `commands` computed as an agent edit of a loaded room (a quiz: with
    /// its keys room): the edit's Undo cost and the most any of its
    /// documents' Undo or Redo payload sends; none when the commands are
    /// refused.
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
            Change::Commands(commands),
            quiz,            &HashSet::new(),
        )
        .ok()?;
        let cost = computed.undo_cost;
        let sent = computed
            .undo
            .expect("an accepted edit of a loaded room offers its payload")
            .into_iter()
            .map(|(doc, undo)| {
                let base = match doc {
                    crate::note_store::Doc::Keys => keys.unwrap(),
                    crate::note_store::Doc::Content => base,
                };
                let write = computed
                    .writes
                    .iter()
                    .find(|write| write.doc == doc)
                    .unwrap();
                undo.len().max(redo_sent(base, write, &undo))
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
    /// (`sources::undo_cost`) before its payload is built. On the notes
    /// corpus's seeded notes (paragraphs, lists, tables, math), a Mermaid
    /// block with a long caption rewritten as a small one (the kept caption
    /// rides its Redo), a card set and a quiz, every material command's cost
    /// is at least what the edit's Undo payload and its Redo payload send
    /// for each of its documents. The lowest and highest ratio per command
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
