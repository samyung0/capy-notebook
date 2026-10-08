//! The gateway's internal document routes (`server.ts` handleDocumentRequest,
//! handleServiceCommandRequest, handleMarkdownRequest): direct AI edits of a
//! material or a source, their Undo, the inspect view, the replace-block
//! command and agent markdown. A material edit runs on an isolated document
//! (the durable base and rows merged with this instance's live room) under
//! the material lock, and commits its row with the receipt and the inverse in
//! one transaction; only the committed change then reaches the live room,
//! whose durable cover takes it in (DESIGN.md 3.2).

use std::time::Duration;

use notes::edit::{DocumentCommand, EditError, EditOutcome, GuardTarget};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, StateVector, Transact};

use crate::access::{self, AccessError};
use crate::app::Shared;
use crate::auth::RoomName;
use crate::markers;
use crate::note_store;
use crate::observe;
use crate::projection;
use crate::room::{RoomCmd, ServiceEdit};

/// `MAX_EDIT_INVERSE_BYTES`: an edit's stored inverse and guards.
const MAX_EDIT_INVERSE_BYTES: usize = 256 * 1024;
/// How long a live room may take to hand over its state.
const SNAPSHOT_WAIT: Duration = Duration::from_secs(10);

/// Why a document request failed, as the gateway reads it.
#[derive(Debug)]
pub enum DocumentError {
    /// 400: the request itself.
    Invalid(String),
    /// 409 with the edit's code (`stale_target`, `unavailable_target`, ...).
    Edit { code: String, message: String },
    /// 403 `lifecycle_rejected`: the actor or the owner may not change it.
    Lifecycle(String),
    /// 422 `quota_rejected`: a shape bound.
    Quota(String),
    /// A source refusal: its status, its code by status.
    Source { status: u16, message: String },
    /// 503 `outcome_unknown` (reported).
    Unknown(String),
}

impl DocumentError {
    pub fn status_and_body(&self) -> (u16, Value) {
        match self {
            DocumentError::Invalid(message) => {
                (400, json!({ "code": "invalid_input", "message": message }))
            }
            DocumentError::Edit { code, message } => {
                (409, json!({ "code": code, "message": message }))
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
        }
    }

    fn edit(code: &str, message: impl Into<String>) -> Self {
        DocumentError::Edit {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

impl From<EditError> for DocumentError {
    fn from(error: EditError) -> Self {
        match error {
            EditError::Edit { code, message } => DocumentError::Edit {
                code: serde_json::to_value(code)
                    .ok()
                    .and_then(|code| code.as_str().map(str::to_owned))
                    .unwrap_or_else(|| "invalid_input".into()),
                message,
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
            sources::SourceError::Edit { code, message } => DocumentError::Edit { code, message },
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
    pub epoch: Option<u64>,
    pub guards: Option<Value>,
    pub inverse: Option<Value>,
    pub operation: Option<Operation>,
    pub provenance: Option<Value>,
    pub room: Option<String>,
    pub target: Target,
    pub undo_of: Option<String>,
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

/// An Undo: the stored inverse and the guards it must still match.
pub struct Undo {
    pub undo_of: String,
    pub inverse: Value,
    pub guards: Value,
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
        }) => Ok((room, material_id, schema)),
        _ => Err(DocumentError::edit(
            "invalid_input",
            "invalid material room",
        )),
    }
}

/// `inspectMaterialDocument`: the durable document's blocks (no room, no
/// bootstrap write).
pub async fn inspect_material(
    app: &Shared,
    request: &DocumentRequest,
) -> Result<Value, DocumentError> {
    let (_, material_id, schema) = material_room(request)?;
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
            "SELECT state, room_schema FROM material_yjs_documents WHERE material_id=$1",
            &[&material_id],
        )
        .await?;
    let (base, rows) = match found.first() {
        Some(row) => {
            if i64::from(row.get::<_, i32>("room_schema")) != schema {
                return Err(DocumentError::edit(
                    "stale_target",
                    "the material was rebuilt since it was opened",
                ));
            }
            let rows: Vec<Vec<u8>> = note_store::rows(&tx, &material_id, None)
                .await?
                .into_iter()
                .map(|(_, row)| row)
                .collect();
            (row.get::<_, Vec<u8>>("state"), rows)
        }
        None => {
            let found = tx
                .query(
                    "SELECT content FROM materials WHERE id=$1 AND trashed_at IS NULL",
                    &[&material_id],
                )
                .await?;
            let Some(row) = found.first() else {
                return Err(DocumentError::edit(
                    "unavailable_target",
                    "material not found",
                ));
            };
            let content: Value = row.get("content");
            let value = note_store::envelope_value(&content).map_err(|_| {
                DocumentError::edit(
                    "unavailable_target",
                    "material content is not a valid Plate envelope",
                )
            })?;
            (notes::slate_yjs::state_from_value(value, 0), Vec::new())
        }
    };
    tx.commit().await?;
    let blocks = tokio::task::spawn_blocking(move || -> Result<Value, DocumentError> {
        let doc = ydoc::scratch_doc();
        ydoc::replay(&doc, &base, &rows)
            .map_err(|error| DocumentError::Unknown(error.to_string()))?;
        let blocks = notes::edit::inspect_material(&doc.transact())?;
        Ok(serde_json::to_value(blocks).unwrap_or(Value::Null))
    })
    .await
    .map_err(|error| DocumentError::Unknown(error.to_string()))??;
    Ok(json!({ "blocks": blocks, "roomSchema": schema }))
}

/// This instance's live copy of `room`, when it has the room loaded.
async fn live_state(app: &Shared, room: &str) -> Option<Vec<u8>> {
    let handle = app.rooms.get(room)?;
    let (reply, answer) = oneshot::channel();
    handle.tx.send(RoomCmd::Snapshot(reply)).await.ok()?;
    tokio::time::timeout(SNAPSHOT_WAIT, answer).await.ok()?.ok()
}

/// What an edit computed on its isolated document.
struct Computed {
    row: Vec<u8>,
    durable: ydoc::Durable,
    /// What the live room lacks of the result.
    live_update: Option<Vec<u8>>,
    value: Vec<Value>,
    outcome: EditOutcome,
}

/// The edit itself, on a document of the durable state plus the live room.
fn compute(
    base: Vec<u8>,
    rows: Vec<Vec<u8>>,
    live: Option<Vec<u8>>,
    kind: String,
    commands: Vec<DocumentCommand>,
    guards: Option<Vec<GuardTarget>>,
) -> Result<Computed, DocumentError> {
    let unknown = |error: String| DocumentError::Unknown(error);
    // Server edits go under a client the stored document does not hold.
    let stored = ydoc::scratch_doc();
    ydoc::replay(&stored, &base, &rows).map_err(|error| unknown(error.to_string()))?;
    let held = stored.transact().state_vector();
    let doc = loop {
        let doc = ydoc::scratch_doc();
        if held.get(&doc.client_id()) == 0 {
            break doc;
        }
    };
    let whole = stored
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    ydoc::apply(
        &doc,
        ydoc::decode(&whole).map_err(|error| unknown(error.to_string()))?,
    )
    .map_err(|error| unknown(error.to_string()))?;
    let durable = ydoc::Durable::of(&doc.transact());
    let live_vector = match &live {
        Some(live) => {
            let update =
                yrs::Update::decode_v1(live).map_err(|error| unknown(error.to_string()))?;
            let vector = update.state_vector();
            ydoc::apply(&doc, update).map_err(|error| unknown(error.to_string()))?;
            Some(vector)
        }
        None => None,
    };
    let root = doc.get_or_insert_text(notes::plate::CONTENT_ROOT);
    let (outcome, value) = {
        let mut txn = doc.transact_mut();
        let previous = notes::limits::measure_value(
            &notes::plate::value(&txn).map_err(|error| unknown(error.to_string()))?,
        );
        if let Some(guards) = &guards {
            notes::edit::verify_material_guards(&mut txn, &root, guards)?;
        }
        let outcome = notes::edit::apply_material_commands(&mut txn, &root, &commands)?;
        let value = notes::plate::value(&txn).map_err(|error| unknown(error.to_string()))?;
        notes::material::assert_canonical(&value, &kind).map_err(|error| unknown(error.0))?;
        let metrics = notes::limits::measure_value(&value);
        if let Some(code) = notes::limits::limit_code(&metrics)
            && !notes::limits::recovers(&metrics, Some(&previous))
        {
            return Err(DocumentError::Quota(code.as_str().into()));
        }
        (outcome, value)
    };
    let hidden = markers::live_items(&doc);
    let txn = doc.transact();
    let (row, durable) = ydoc::delta_update(&txn, &durable, &hidden);
    let live_update = live_vector.map(|vector| txn.encode_state_as_update_v1(&vector));
    Ok(Computed {
        row,
        durable,
        live_update,
        value,
        outcome,
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
/// live room, the children pass and the projection follow.
pub async fn edit_material(
    app: &Shared,
    request: &DocumentRequest,
    undo: Option<Undo>,
) -> Result<Value, DocumentError> {
    let (room, material_id, schema) = material_room(request)?;
    let operation = request
        .operation
        .clone()
        .ok_or_else(|| DocumentError::edit("invalid_input", "operation identity is required"))?;
    if app.evictions.blocks(&room, false) {
        return Err(DocumentError::Unknown(
            "collaboration room is being reset".into(),
        ));
    }
    if crate::socket::room_evicting(app, &room)
        .await
        .map_err(DocumentError::Unknown)?
    {
        return Err(DocumentError::Unknown(
            "collaboration room is being compacted".into(),
        ));
    }
    let (commands, guards) = match &undo {
        Some(undo) => (
            parse::<Vec<DocumentCommand>>(undo.inverse.clone(), "inverse")?,
            Some(parse::<Vec<GuardTarget>>(undo.guards.clone(), "guards")?),
        ),
        None => (
            parse::<Vec<DocumentCommand>>(Value::Array(request.commands.clone()), "commands")?,
            None,
        ),
    };
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
    let boundary = access::lock_boundary(&tx, &material_id, std::slice::from_ref(&actor)).await?;
    access::assert_access(&tx, &material_id, &actor, crate::auth::Access::Write).await?;
    if boundary.owner_locked() {
        return Err(DocumentError::Lifecycle(
            "material owner account is locked".into(),
        ));
    }
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
    if i64::from(current.get::<_, i32>("room_schema")) != schema {
        return Err(DocumentError::edit(
            "stale_target",
            "the material was rebuilt since it was inspected",
        ));
    }
    let base: Vec<u8> = current.get("state");
    let kind: String = current.get("kind");
    let version = current.get::<_, i64>("stored_version") + 1;
    let rows: Vec<Vec<u8>> = note_store::rows(&tx, &material_id, None)
        .await?
        .into_iter()
        .map(|(_, row)| row)
        .collect();
    let computed =
        tokio::task::spawn_blocking(move || compute(base, rows, live, kind, commands, guards))
            .await
            .map_err(|error| DocumentError::Unknown(error.to_string()))??;
    tx.execute(
        "INSERT INTO material_yjs_updates (material_id, seq, update) VALUES ($1,$2,$3)",
        &[&material_id, &version, &computed.row],
    )
    .await?;
    tx.execute(
        "UPDATE material_yjs_documents
         SET stored_version=$2, log_bytes=log_bytes+$3, log_rows=log_rows+1,
             projection_error=NULL, updated_at=now()
         WHERE material_id=$1",
        &[&material_id, &version, &(computed.row.len() as i64)],
    )
    .await?;
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
        "operation": if undo.is_some() { "edit_undone" } else { "edited" },
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
    if undo.is_none() {
        effect["undo"] = json!({ "operationId": operation.id, "status": "available" });
    }
    let kind = if undo.is_some() {
        "undo_edit"
    } else {
        "edit_document"
    };
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
    match &undo {
        Some(undo) => {
            let consumed = tx
                .execute(
                    "UPDATE agent_edit_inverses
                     SET undo_status='undone', undone_by=$2, inverse='[]'::jsonb, guards='[]'::jsonb,
                         inverse_bytes=0, updated_at=now()
                     WHERE operation_id=$1 AND undo_status='available'",
                    &[&undo.undo_of, &operation.id],
                )
                .await?;
            if consumed == 0 {
                return Err(DocumentError::edit(
                    "unavailable_target",
                    "undo is no longer available for this edit",
                ));
            }
        }
        None => {
            let inverse = json!({ "commands": computed.outcome.inverse });
            let guards = serde_json::to_value(&computed.outcome.guards).unwrap_or(Value::Null);
            let inverse_bytes = inverse.to_string().len() + guards.to_string().len();
            if inverse_bytes > MAX_EDIT_INVERSE_BYTES {
                return Err(DocumentError::Quota("undo_payload_exceeded".into()));
            }
            tx.execute(
                "INSERT INTO agent_edit_inverses
                 (operation_id, resource_kind, resource_id, actor_user_id, owner_user_id, workspace_id,
                  incarnation, revision, inverse, guards, inverse_bytes)
                 VALUES ($1,'material',$2,$3,$4,NULLIF($5,''),$6,$7,$8,$9,$10)",
                &[
                    &operation.id,
                    &material_id,
                    &actor,
                    &boundary.owner_user_id,
                    &workspace_id,
                    &schema,
                    &version,
                    &inverse,
                    &guards,
                    &(inverse_bytes as i64),
                ],
            )
            .await?;
        }
    }
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
    // The committed change goes to the live room, whose durable cover takes it.
    if let Some(handle) = app.rooms.get(&room) {
        let edit = ServiceEdit {
            update: computed
                .live_update
                .clone()
                .unwrap_or_else(|| computed.row.clone()),
            durable: computed.durable,
            version: version as u64,
            row_bytes: computed.row.len(),
        };
        let _ = handle.tx.send(RoomCmd::ServiceEdit(Box::new(edit))).await;
    }
    // An AI edit or its Undo can bring back a quiz or image the note had
    // trashed (restored) or one purged since (dropped).
    crate::children::queue(app, &room, &actor, computed.row.clone());
    let content = json!({ "schemaVersion": 1, "value": computed.value });
    match projection::project(app, &material_id, version, &content).await {
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
    }) = RoomName::parse(&command.room)
    else {
        return Err("collaboration command room does not match material".into());
    };
    if material_id != command.material_id {
        return Err("collaboration command room does not match material".into());
    }
    if app.evictions.blocks(&command.room, false) {
        return Err("collaboration room is being reset".into());
    }
    if crate::socket::room_evicting(app, &command.room).await? {
        return Err(if command.expected_revision.is_some() {
            "material changed concurrently".into()
        } else {
            "collaboration room is being compacted".into()
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
    let boundary = access::lock_boundary(
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
    if boundary.owner_locked() {
        return Err("material owner account is locked".into());
    }
    let base: Vec<u8> = current.get("state");
    let kind: String = current.get("kind");
    let rows: Vec<Vec<u8>> = note_store::rows(&tx, &material_id, None)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|(_, row)| row)
        .collect();
    let computed = tokio::task::spawn_blocking(move || -> Result<Option<Computed>, String> {
        replace_on(base, rows, live, kind, &command)
    })
    .await
    .map_err(|error| error.to_string())??;
    // Nothing to change (the block already holds the replacement).
    let Some(computed) = computed else {
        tx.commit().await.map_err(|error| error.to_string())?;
        return Ok(());
    };
    let version = stored + 1;
    tx.execute(
        "INSERT INTO material_yjs_updates (material_id, seq, update) VALUES ($1,$2,$3)",
        &[&material_id, &version, &computed.row],
    )
    .await
    .map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE material_yjs_documents
         SET stored_version=$2, log_bytes=log_bytes+$3, log_rows=log_rows+1,
             projection_error=NULL, updated_at=now()
         WHERE material_id=$1",
        &[&material_id, &version, &(computed.row.len() as i64)],
    )
    .await
    .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    drop(client);
    let room = format!("material:{material_id}:schema:{schema}");
    if let Some(handle) = app.rooms.get(&room) {
        let edit = ServiceEdit {
            update: computed.live_update.unwrap_or_else(|| computed.row.clone()),
            durable: computed.durable,
            version: version as u64,
            row_bytes: computed.row.len(),
        };
        let _ = handle.tx.send(RoomCmd::ServiceEdit(Box::new(edit))).await;
    }
    let content = json!({ "schemaVersion": 1, "value": computed.value });
    projection::project(app, &material_id, version, &content).await?;
    if let Some(handle) = app.rooms.get(&room) {
        let _ = handle.tx.send(RoomCmd::Projected(version, Ok(()))).await;
    }
    Ok(())
}

/// The replace-block command on an isolated document; `None` when the block
/// already holds the replacement.
fn replace_on(
    base: Vec<u8>,
    rows: Vec<Vec<u8>>,
    live: Option<Vec<u8>>,
    kind: String,
    command: &notes::commands::ReplaceBlock,
) -> Result<Option<Computed>, String> {
    let doc = ydoc::scratch_doc();
    ydoc::replay(&doc, &base, &rows).map_err(|error| error.to_string())?;
    let held = doc.transact().state_vector();
    let doc = {
        let fresh = loop {
            let fresh = ydoc::scratch_doc();
            if held.get(&fresh.client_id()) == 0 {
                break fresh;
            }
        };
        let whole = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        ydoc::apply(
            &fresh,
            ydoc::decode(&whole).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        fresh
    };
    let durable = ydoc::Durable::of(&doc.transact());
    let live_vector = match &live {
        Some(live) => {
            let update = yrs::Update::decode_v1(live).map_err(|error| error.to_string())?;
            let vector = update.state_vector();
            ydoc::apply(&doc, update).map_err(|error| error.to_string())?;
            Some(vector)
        }
        None => None,
    };
    let before = doc.transact().state_vector();
    let previous = notes::limits::measure_value(
        &notes::plate::value(&doc.transact()).map_err(|error| error.to_string())?,
    );
    let root = doc.get_or_insert_text(notes::plate::CONTENT_ROOT);
    {
        let mut txn = doc.transact_mut();
        notes::commands::replace_block(&mut txn, &root, command)
            .map_err(|error| error.to_string())?;
    }
    if doc.transact().state_vector() == before {
        return Ok(None);
    }
    let value = notes::plate::value(&doc.transact()).map_err(|error| error.to_string())?;
    notes::material::assert_canonical(&value, &kind).map_err(|error| error.0)?;
    let metrics = notes::limits::measure_value(&value);
    if let Some(code) = notes::limits::limit_code(&metrics)
        && !notes::limits::recovers(&metrics, Some(&previous))
    {
        return Err(format!("invalid material document: {}", code.as_str()));
    }
    let hidden = markers::live_items(&doc);
    let txn = doc.transact();
    let (row, durable) = ydoc::delta_update(&txn, &durable, &hidden);
    let live_update = live_vector.map(|vector| txn.encode_state_as_update_v1(&vector));
    Ok(Some(Computed {
        row,
        durable,
        live_update,
        value,
        outcome: EditOutcome::default(),
    }))
}

/// Inspect, edit or undo of a source file (the sources crate), with the
/// committed change fanned into the live room.
pub async fn source_request(
    app: &Shared,
    request: &DocumentRequest,
    inspect: bool,
    undo: Option<Undo>,
) -> Result<Value, DocumentError> {
    if inspect {
        let inspection = app
            .sources
            .inspect(&request.target.id, &request.actor_user_id)
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
        epoch: request.epoch,
        file_id: request.target.id.clone(),
        operation: serde_json::to_value(&operation).unwrap_or(Value::Null),
        undo: undo.map(|undo| sources::edit::EditUndo {
            undo_of: undo.undo_of,
            inverse: undo.inverse,
            guards: undo.guards,
        }),
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
    if let Some(handle) = app.rooms.get(&result.room) {
        let edit = ServiceEdit {
            update: result.update,
            durable: result.durable,
            version: result.checkpoint,
            row_bytes: result.row_bytes,
        };
        let _ = handle.tx.send(RoomCmd::ServiceEdit(Box::new(edit))).await;
    }
    Ok(result.receipt)
}

/// `/internal/documents/{inspect,edit,undo}` after the secret check.
pub async fn document(app: &Shared, path: &str, body: &[u8]) -> Result<Value, DocumentError> {
    let invalid = || DocumentError::Invalid("invalid document request".into());
    let request: DocumentRequest = serde_json::from_slice(body).map_err(|_| invalid())?;
    if request.target.kind != "material" && request.target.kind != "source_file" {
        return Err(invalid());
    }
    let inspect = path.ends_with("/inspect");
    let undo = if path.ends_with("/undo") {
        let undo_of = request.undo_of.clone().unwrap_or_default();
        if undo_of.is_empty() {
            return Err(DocumentError::edit("invalid_input", "undoOf is required"));
        }
        Some(Undo {
            undo_of,
            inverse: request.inverse.clone().unwrap_or(Value::Array(Vec::new())),
            guards: request.guards.clone().unwrap_or(Value::Array(Vec::new())),
        })
    } else {
        None
    };
    if !inspect && request.operation.is_none() {
        return Err(DocumentError::edit(
            "invalid_input",
            "operation identity is required",
        ));
    }
    if request.target.kind == "source_file" {
        return source_request(app, &request, inspect, undo).await;
    }
    if inspect {
        return inspect_material(app, &request).await;
    }
    edit_material(app, &request, undo).await
}
