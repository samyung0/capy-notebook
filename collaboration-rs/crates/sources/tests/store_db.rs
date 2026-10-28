//! Sources against Postgres (server/migrations, 0075 included)
//! and Redis, with a stand-in gateway that answers the internal source routes
//! as the Go API does under the delta-save contract (the checkpoint appends
//! its `update` to `source_document_updates` in the CAS transaction).
//!
//!   docker compose -p rust-sources -f <track>/compose.yml up -d
//!   SOURCES_TEST_DATABASE_URL=postgres://capy:capy@localhost:25750/capy \
//!   SOURCES_TEST_REDIS_URL=redis://localhost:26750 \
//!   cargo test -p sources --test store_db -- --ignored --test-threads=1

#![allow(clippy::unwrap_used)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use sources::edit::{EditInput, SentBack};
use sources::engine::PoolConfig;
use sources::handoff::{Handoff, PUBLICATION_HOLD_MARKER, SourcePublish};
use sources::pending::OFFICE_CHANGES_BUDGET;
use sources::store::ResolveInput;
use sources::text::{TEXT_ROOT, text_doc};
use sources::{
    BoxFuture, Channel, ChannelId, Rooms, Save, SourceError, SourceRoom, Sources, SourcesConfig,
};
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

#[derive(Clone)]
struct Fake {
    db: deadpool_postgres::Pool,
    url: Arc<Mutex<String>>,
    blobs: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    uploads: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    failures: Arc<Mutex<Vec<Value>>>,
    published: Arc<Mutex<Vec<Value>>>,
    /// Files whose checkpoint always moved: the refused CAS POSTs per file.
    moved: Arc<Mutex<HashMap<String, usize>>>,
    /// The workspace each checkpoint named (Q459), in order.
    saved_in: Arc<Mutex<Vec<Option<String>>>>,
}

fn refuse(status: u16, code: &str) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        axum::Json(json!({ "errors": [{ "message": code }] })),
    )
        .into_response()
}

async fn bootstrap(State(fake): State<Fake>, Path((id, _)): Path<(String, String)>) -> Response {
    let client = fake.db.get().await.unwrap();
    let Some(row) = client
        .query_opt(
            "SELECT d.format,d.epoch,d.checkpoint,d.indexed_checkpoint,d.base_revision,d.base_source_sha256,d.state,d.state_seed_sha256,d.pending_effects,d.net_tokens,d.rebuild_pending,COALESCE(f.workspace_id,'') FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.file_id=$1 AND f.trashed_at IS NULL",
            &[&id],
        )
        .await
        .unwrap()
    else {
        return refuse(404, "not_found");
    };
    let epoch: i64 = row.get(1);
    let url = fake.url.lock().unwrap().clone();
    axum::Json(json!({
        "access": "write",
        "baseRevision": row.get::<_, i64>(4),
        "baseSourceSHA256": row.get::<_, String>(5),
        "checkpoint": row.get::<_, i64>(2),
        "epoch": epoch,
        "fileId": id,
        "format": row.get::<_, String>(0),
        "indexedCheckpoint": row.get::<_, i64>(3),
        "netTokens": row.get::<_, i64>(9),
        "pendingEffects": row.get::<_, Value>(8),
        "rebuildPending": row.get::<_, bool>(10),
        "room": format!("source:{id}:epoch:{epoch}"),
        "sourceURL": format!("{url}/blob/{id}"),
        "state": row.get::<_, Option<Vec<u8>>>(6).map(|state| STANDARD.encode(state)),
        "stateSeedSHA256": row.get::<_, Option<String>>(7),
        "workspaceId": row.get::<_, String>(11),
    }))
    .into_response()
}

async fn route_get(state: State<Fake>, Path((id, endpoint)): Path<(String, String)>) -> Response {
    match endpoint.as_str() {
        "bootstrap" => bootstrap(state, Path((id, endpoint))).await,
        "access" => StatusCode::NO_CONTENT.into_response(),
        "refresh-candidate" => candidate(state, id).await,
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn candidate(State(fake): State<Fake>, id: String) -> Response {
    let client = fake.db.get().await.unwrap();
    let row = client
        .query_one(
            "SELECT c.job_id,c.lease_token,c.epoch,c.checkpoint,d.format,d.base_revision,d.base_source_sha256 FROM source_refresh_candidates c JOIN source_documents d ON d.file_id=c.file_id WHERE c.file_id=$1",
            &[&id],
        )
        .await
        .unwrap();
    let url = fake.url.lock().unwrap().clone();
    axum::Json(json!({
        "baseRevision": row.get::<_, i64>(5),
        "baseSourceSHA256": row.get::<_, String>(6),
        "baseSourceURL": format!("{url}/blob/{id}"),
        "checkpoint": row.get::<_, i64>(3),
        "epoch": row.get::<_, i64>(2),
        "fileId": id,
        "format": row.get::<_, String>(4),
        "jobId": row.get::<_, String>(0),
        "leaseToken": row.get::<_, String>(1),
        "uploadHeaders": {},
        "uploadURL": format!("{url}/upload/{id}"),
    }))
    .into_response()
}

async fn route_post(
    State(fake): State<Fake>,
    Path((id, endpoint)): Path<(String, String)>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    match endpoint.as_str() {
        "checkpoint" => checkpoint(fake, id, body).await,
        "epoch-reset" => {
            let client = fake.db.get().await.unwrap();
            let moved = client
                .execute(
                    "UPDATE source_documents SET epoch=epoch+1,state=NULL,state_seed_sha256=NULL,checkpoint=checkpoint WHERE file_id=$1 AND epoch=$2 AND log_rows=0",
                    &[&id, &body["epoch"].as_i64().unwrap()],
                )
                .await
                .unwrap();
            axum::Json(json!({ "moved": moved == 1 })).into_response()
        }
        "refresh-candidate" => {
            let client = fake.db.get().await.unwrap();
            let state = body["state"]
                .as_str()
                .map(|state| STANDARD.decode(state).unwrap());
            client
                .execute(
                    "UPDATE source_refresh_candidates SET state=$2,state_seed_sha256=$3,source_sha256=$4,size_bytes=$5 WHERE file_id=$1",
                    &[
                        &id,
                        &state,
                        &body["stateSeedSHA256"].as_str(),
                        &body["sourceSHA256"].as_str().unwrap(),
                        &body["sizeBytes"].as_i64().unwrap(),
                    ],
                )
                .await
                .unwrap();
            StatusCode::NO_CONTENT.into_response()
        }
        "refresh-failure" => {
            fake.failures.lock().unwrap().push(body);
            StatusCode::NO_CONTENT.into_response()
        }
        "publish" => {
            fake.published.lock().unwrap().push(body);
            axum::Json(json!({})).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The delta-save checkpoint (Go SaveSourceCheckpoint with `update`).
async fn checkpoint(fake: Fake, id: String, body: Value) -> Response {
    fake.saved_in
        .lock()
        .unwrap()
        .push(body["workspaceId"].as_str().map(str::to_owned));
    if let Some(refused) = fake.moved.lock().unwrap().get_mut(&id) {
        *refused += 1;
        return refuse(409, "checkpoint_moved");
    }
    let mut client = fake.db.get().await.unwrap();
    let txn = client.transaction().await.unwrap();
    let row = txn
        .query_one(
            "SELECT format,epoch,checkpoint,base_revision,base_source_sha256,state IS NULL AND log_rows=0,state_seed_sha256 FROM source_documents WHERE file_id=$1 FOR UPDATE",
            &[&id],
        )
        .await
        .unwrap();
    let (format, epoch, checkpoint, base_revision): (String, i64, i64, i64) =
        (row.get(0), row.get(1), row.get(2), row.get(3));
    let (seeded, stored_seed): (bool, Option<String>) = (row.get(5), row.get(6));
    if epoch != body["epoch"].as_i64().unwrap() {
        return refuse(409, "epoch_changed");
    }
    if checkpoint != body["expectedCheckpoint"].as_i64().unwrap()
        || base_revision != body["baseRevision"].as_i64().unwrap()
    {
        return refuse(409, "checkpoint_moved");
    }
    let text = format == "text";
    let seed_bytes = body["seedBytes"].as_i64();
    let base_sha = body["baseSourceSHA256"].as_str();
    if (seeded && text) != seed_bytes.is_some() || (!seeded && base_sha.is_some()) {
        return refuse(422, "invalid_checkpoint");
    }
    let seed = body["stateSeedSHA256"].as_str();
    if text == seed.is_some()
        || stored_seed
            .as_deref()
            .is_some_and(|stored| Some(stored) != seed)
    {
        return refuse(422, "invalid_checkpoint");
    }
    let update = STANDARD.decode(body["update"].as_str().unwrap()).unwrap();
    let next = checkpoint + 1;
    txn.execute(
        "INSERT INTO source_document_updates(file_id,epoch,checkpoint,update) VALUES($1,$2,$3,$4)",
        &[&id, &epoch, &next, &update],
    )
    .await
    .unwrap();
    txn.execute(
        "UPDATE source_documents SET effects_cache=NULL,checkpoint=$2,pending_effects=$3,net_tokens=$4,log_bytes=log_bytes+$5,log_rows=log_rows+1,state_seed_sha256=COALESCE(state_seed_sha256,$6),seed_bytes=COALESCE($7,seed_bytes),base_source_sha256=COALESCE($8,base_source_sha256),last_edited_at=now() WHERE file_id=$1",
        &[
            &id,
            &next,
            &body["pendingEffects"],
            &body["netTokens"].as_i64().unwrap(),
            &(update.len() as i64),
            &seed,
            &seed_bytes,
            &base_sha,
        ],
    )
    .await
    .unwrap();
    // A text save's preview goes to the file; an Office save has none.
    if !text && body["preview"].is_string() {
        return refuse(422, "invalid_checkpoint");
    }
    if let Some(preview) = body["preview"].as_str() {
        txn.execute(
            "UPDATE files SET preview=jsonb_build_object('text',$2::text) WHERE id=$1",
            &[&id, &preview],
        )
        .await
        .unwrap();
    }
    txn.commit().await.unwrap();
    // An agent edit's receipt comes back as Go records it.
    match body["operation"]["receipt"].clone() {
        Value::Null => axum::Json(json!({ "checkpoint": next })).into_response(),
        receipt => axum::Json(json!({ "checkpoint": next, "operation": receipt })).into_response(),
    }
}

async fn blob(State(fake): State<Fake>, Path(id): Path<String>) -> Response {
    match fake.blobs.lock().unwrap().get(&id) {
        Some(bytes) => bytes.clone().into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn upload(State(fake): State<Fake>, Path(id): Path<String>, bytes: Bytes) -> Response {
    fake.uploads.lock().unwrap().insert(id, bytes.to_vec());
    ([("etag", "\"etag-1\"")], StatusCode::OK).into_response()
}

struct Harness {
    fake: Fake,
    sources: Arc<Sources>,
    user: String,
    workspace: String,
    _disk: Disk,
}

/// A disk store folder under the target's temp dir, removed with the guard.
struct Disk(PathBuf);

impl Drop for Disk {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn unique(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{prefix}_{nanos}_{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

async fn harness() -> Harness {
    let url = std::env::var("SOURCES_TEST_DATABASE_URL").expect("SOURCES_TEST_DATABASE_URL");
    let mut config = deadpool_postgres::Config::new();
    config.url = Some(url);
    let db = config
        .create_pool(
            Some(deadpool_postgres::Runtime::Tokio1),
            tokio_postgres::NoTls,
        )
        .unwrap();
    let fake = Fake {
        db: db.clone(),
        url: Arc::default(),
        blobs: Arc::default(),
        uploads: Arc::default(),
        failures: Arc::default(),
        published: Arc::default(),
        moved: Arc::default(),
        saved_in: Arc::default(),
    };
    let app = Router::new()
        .route(
            "/internal/collaboration/files/{id}/{endpoint}",
            get(route_get).post(route_post),
        )
        .route("/blob/{id}", get(blob))
        .route("/upload/{id}", put(upload))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    *fake.url.lock().unwrap() = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (sources, disk) = sources_on(&fake, db.clone());
    let sources = Arc::new(sources);
    let user = unique("u");
    let workspace = unique("ws");
    let client = db.get().await.unwrap();
    client
        .execute(
            "INSERT INTO users (id,name,email) VALUES ($1,'Sources Test',$1||'@example.test')",
            &[&user],
        )
        .await
        .unwrap();
    client
        .execute(
            "INSERT INTO workspaces (id,user_id,name,privacy) VALUES ($1,$2,'Sources','private')",
            &[&workspace, &user],
        )
        .await
        .unwrap();
    Harness {
        fake,
        sources,
        user,
        workspace,
        _disk: disk,
    }
}

/// A `Sources` against the stand-in gateway on `db`, its disk store empty.
fn sources_on(fake: &Fake, db: deadpool_postgres::Pool) -> (Sources, Disk) {
    let disk = Disk(PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(unique("disk")));
    let sources = Sources::new(
        SourcesConfig {
            api_url: fake.url.lock().unwrap().clone(),
            secret: "secret".into(),
            engine: PoolConfig {
                program: PathBuf::from(env!("CARGO_BIN_EXE_sources-test-engine")),
                args: Vec::new(),
                save_processes: 1,
                background_processes: 1,
                call_timeout: Duration::from_secs(120),
                replica_budget_bytes: 1 << 30,
                memory_limit_bytes: None,
            },
            disk_dir: disk.0.clone(),
            disk_bytes: 1 << 30,
        },
        db,
        reqwest::Client::new(),
    )
    .unwrap();
    (sources, disk)
}

impl Harness {
    async fn file(&self, format: &str, name: &str, bytes: &[u8]) -> SourceRoom {
        let id = unique("f");
        let client = self.fake.db.get().await.unwrap();
        client
            .execute(
                "INSERT INTO files (id,workspace_id,user_id,name,kind,size_bytes,status,blob_path) VALUES ($1,$2,$3,$4,$5,$6,'ready','p/'||$1)",
                &[&id, &self.workspace, &self.user, &name, &format, &(bytes.len() as i64)],
            )
            .await
            .unwrap();
        client
            .execute(
                "INSERT INTO source_documents (file_id,user_id,format,base_revision,base_blob_path,base_source_sha256) VALUES ($1,$2,$3,1,'p/'||$1,$4)",
                &[&id, &self.user, &format, &office_service::sha256_hex(bytes)],
            )
            .await
            .unwrap();
        self.fake
            .blobs
            .lock()
            .unwrap()
            .insert(id.clone(), bytes.to_vec());
        SourceRoom {
            file_id: id,
            epoch: 1,
        }
    }

    async fn row(&self, room: &SourceRoom) -> tokio_postgres::Row {
        let client = self.fake.db.get().await.unwrap();
        client
            .query_one(
                "SELECT checkpoint,log_rows,log_bytes,state,state_seed_sha256,pending_effects,net_tokens,seed_bytes,storage_bytes,(SELECT count(*) FROM source_document_updates u WHERE u.file_id=d.file_id),COALESCE(octet_length(NULLIF(pending_effects,'[]'::jsonb)::text),0)::bigint FROM source_documents d WHERE file_id=$1",
                &[&room.file_id],
            )
            .await
            .unwrap()
    }
}

fn encode(doc: &Doc, since: &StateVector) -> Vec<u8> {
    doc.transact().encode_state_as_update_v1(since)
}

fn apply(doc: &Doc, update: &[u8]) {
    doc.transact_mut()
        .apply_update(Update::decode_v1(update).unwrap())
        .unwrap();
}

fn text(doc: &Doc) -> String {
    let txn = doc.transact();
    txn.get_text(TEXT_ROOT)
        .map(|text| text.get_string(&txn))
        .unwrap_or_default()
}

/// A writer's edit reaching the room, as a client update would.
fn type_into(room: &Doc, client: u64, at: u32, inserted: &str) {
    let writer = text_doc(client);
    apply(&writer, &encode(room, &StateVector::default()));
    let before = writer.transact().state_vector();
    writer
        .get_or_insert_text(TEXT_ROOT)
        .insert(&mut writer.transact_mut(), at, inserted);
    apply(room, &encode(&writer, &before));
}

async fn save_text(
    h: &Harness,
    room: &SourceRoom,
    doc: &Doc,
    durable: &mut StateVector,
) -> Result<u64, SourceError> {
    let row = encode(doc, durable);
    let effects = h.sources.text_effects(room, &doc.transact(), &row)?;
    let saved = h
        .sources
        .store(
            room,
            Save {
                row,
                state: None,
                text: Some(effects),
                actors: vec![h.user.clone()],
                retry_event: None,
                edits: None,
                operations: Vec::new(),
            },
        )
        .await?;
    *durable = doc.transact().state_vector();
    Ok(saved.checkpoint)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn a_text_room_appends_rows_reloads_and_folds() {
    let h = harness().await;
    let room = h.file("text", "notes.md", b"hello\nworld\n").await;
    let doc = text_doc(100);
    let loaded = h.sources.load(&room, &h.user, &doc).await.unwrap();
    assert_eq!(
        (loaded.checkpoint, text(&doc).as_str()),
        (0, "hello\nworld\n")
    );
    let mut durable = doc.transact().state_vector();

    type_into(&doc, 7, 0, "X");
    assert_eq!(save_text(&h, &room, &doc, &mut durable).await.unwrap(), 1);
    let row = h.row(&room).await;
    assert_eq!(
        (
            row.get::<_, i64>(0),
            row.get::<_, i32>(1),
            row.get::<_, i64>(9)
        ),
        (1, 1, 1)
    );
    let effects: Value = row.get(5);
    assert_eq!(effects[0]["after"], "Xhello");
    assert_eq!(effects[0]["label"], "Text at UTF-16 offset 0");
    // The first save over the seed reported its size; nothing else is stored.
    assert!(row.get::<_, i64>(7) > 0);
    assert!(row.get::<_, Option<Vec<u8>>>(3).is_none());

    type_into(&doc, 8, 7, "Y");
    assert_eq!(save_text(&h, &room, &doc, &mut durable).await.unwrap(), 2);
    let effects: Value = h.row(&room).await.get(5);
    assert_eq!(effects[0]["before"], "hello\nworld");
    assert_eq!(effects[0]["after"], "Xhello\nYworld");

    // A fresh load replays base and rows to the same text.
    let again = text_doc(101);
    h.sources.load(&room, &h.user, &again).await.unwrap();
    assert_eq!(text(&again), text(&doc));

    let log_bytes: i64 = h.row(&room).await.get(2);
    let before_fold: i64 = h.row(&room).await.get(8);
    assert_eq!(h.sources.fold(&room).await.unwrap().rows, 2);
    let row = h.row(&room).await;
    assert_eq!(
        (
            row.get::<_, i32>(1),
            row.get::<_, i64>(2),
            row.get::<_, i64>(9)
        ),
        (0, 0, 0)
    );
    let base = row.get::<_, Option<Vec<u8>>>(3).unwrap();
    assert!(log_bytes > 0);
    // Charged bytes follow what is stored: the fold's base for base + rows.
    let seed_bytes: i64 = row.get(7);
    let effects_bytes: i64 = row.get(10);
    assert_eq!(
        row.get::<_, i64>(8),
        effects_bytes + (base.len() as i64 - seed_bytes).max(0)
    );
    assert!(before_fold > 0);
    let folded = text_doc(102);
    h.sources.load(&room, &h.user, &folded).await.unwrap();
    assert_eq!(text(&folded), "Xhello\nYworld\n");
}

// Every text save carries the opening characters the file's list card
// shows, read as ingest reads them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn a_text_save_carries_the_files_opening_characters() {
    let h = harness().await;
    let room = h
        .file("text", "notes.md", "\u{feff}hello\r\nworld".as_bytes())
        .await;
    let preview = || async {
        let client = h.fake.db.get().await.unwrap();
        let row = client
            .query_one("SELECT preview FROM files WHERE id=$1", &[&room.file_id])
            .await
            .unwrap();
        row.get::<_, Option<Value>>(0)
    };
    let doc = text_doc(100);
    h.sources.load(&room, &h.user, &doc).await.unwrap();
    let mut durable = doc.transact().state_vector();
    type_into(&doc, 7, 1, "X");
    save_text(&h, &room, &doc, &mut durable).await.unwrap();
    assert_eq!(preview().await, Some(json!({ "text": "Xhello\nworld" })));
    // Past the first 600 characters the preview holds still.
    type_into(&doc, 8, 14, &"y".repeat(700));
    save_text(&h, &room, &doc, &mut durable).await.unwrap();
    let text = preview().await.unwrap()["text"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(text.chars().count(), 600);
    assert!(text.starts_with("Xhello\nworldyyy"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn a_moved_checkpoint_measures_again_over_the_rows_saved_meanwhile() {
    let h = harness().await;
    let room = h.file("text", "notes.md", b"abc").await;
    let doc = text_doc(100);
    h.sources.load(&room, &h.user, &doc).await.unwrap();
    let mut durable = doc.transact().state_vector();
    // An agent edit lands first through the gateway (the room never sees it):
    // a text source's first row is whole, its seed included.
    let agent = text_doc(9);
    apply(&agent, &encode(&doc, &StateVector::default()));
    agent
        .get_or_insert_text(TEXT_ROOT)
        .insert(&mut agent.transact_mut(), 3, "!");
    let agent_row = encode(&agent, &StateVector::default());
    let landed: Value = h
        .sources
        .gateway()
        .file(
            &room.file_id,
            "checkpoint",
            Some(&json!({
                "actorIds": [h.user],
                "baseRevision": 1,
                "epoch": 1,
                "expectedCheckpoint": 0,
                "netTokens": 1,
                "pendingEffects": [],
                "seedBytes": 17,
                "baseSourceSHA256": office_service::sha256_hex(b"abc"),
                "update": STANDARD.encode(&agent_row),
            })),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(landed["checkpoint"], 1);
    type_into(&doc, 7, 0, ">");
    assert_eq!(save_text(&h, &room, &doc, &mut durable).await.unwrap(), 2);
    // The effects cover both edits: measured again over base + rows + this row.
    let effects: Value = h.row(&room).await.get(5);
    assert_eq!(effects[0]["before"], "abc");
    assert_eq!(effects[0]["after"], ">abc!");
}

/// A checkpoint that keeps moving refuses the save after 3 CAS attempts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn a_checkpoint_that_keeps_moving_refuses_the_save_after_three_attempts() {
    let h = harness().await;
    let room = h.file("text", "notes.md", b"abc").await;
    let doc = text_doc(100);
    h.sources.load(&room, &h.user, &doc).await.unwrap();
    let mut durable = doc.transact().state_vector();
    h.fake.moved.lock().unwrap().insert(room.file_id.clone(), 0);
    type_into(&doc, 7, 0, ">");
    let error = save_text(&h, &room, &doc, &mut durable).await.unwrap_err();
    assert_eq!(error.status(), Some(409), "{error:?}");
    assert_eq!(h.fake.moved.lock().unwrap()[&room.file_id], 3);
}

/// An agent edit on a checkpoint that keeps moving stops after 3 attempts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn an_agent_edit_on_a_checkpoint_that_keeps_moving_stops_after_three_attempts() {
    let h = harness().await;
    let room = h.file("text", "notes.md", b"abc").await;
    h.fake.moved.lock().unwrap().insert(room.file_id.clone(), 0);
    let input = EditInput {
        actor_user_id: h.user.clone(),
        commands: vec![json!({ "type": "replace_text", "expectedText": "abc", "text": "abd" })],
        file_id: room.file_id.clone(),
        operation: json!({ "id": "op_moving", "requestHash": "h1" }),
        undo: None,
    };
    let live = |_: &str| -> BoxFuture<Option<Vec<u8>>> { Box::pin(async { None }) };
    let Err(error) = h.sources.apply_edit(input, live).await else {
        panic!("the edit committed");
    };
    assert_eq!(error.status(), Some(409), "{error:?}");
    assert_eq!(h.fake.moved.lock().unwrap()[&room.file_id], 3);
}

/// Epo 2026-10-17: a room's state cap is its seed plus the export cap (the
/// largest plan source file) less its base file and a margin. A base that
/// leaves no room refuses a growing save and a growing agent edit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn a_rooms_state_cap_is_the_export_cap_less_its_base() {
    let h = harness().await;
    let export = h
        .fake
        .db
        .get()
        .await
        .unwrap()
        .query_one("SELECT max(source_file_max_bytes) FROM plan_limits", &[])
        .await
        .unwrap()
        .get::<_, i64>(0) as u64;
    let room = h.file("text", "notes.md", b"abc").await;
    let doc = text_doc(100);
    let loaded = h.sources.load(&room, &h.user, &doc).await.unwrap();
    let seed = encode(&doc, &StateVector::default()).len() as u64;
    assert_eq!(
        loaded.state_cap,
        seed + export - 3 - sources::STATE_GROWTH_MARGIN_BYTES
    );

    let base = format!(
        "{}END",
        "a".repeat((export - sources::STATE_GROWTH_MARGIN_BYTES / 2) as usize)
    );
    let room = h.file("text", "full.md", base.as_bytes()).await;
    let doc = text_doc(100);
    let loaded = h.sources.load(&room, &h.user, &doc).await.unwrap();
    assert_eq!(
        loaded.state_cap,
        encode(&doc, &StateVector::default()).len() as u64
    );
    // The save's whole-state check is format-agnostic; only Office saves send
    // the state in production, so a text room stands in for one here.
    let durable = doc.transact().state_vector();
    type_into(&doc, 7, 0, "X");
    let row = encode(&doc, &durable);
    let effects = h
        .sources
        .text_effects(&room, &doc.transact(), &row)
        .unwrap();
    let error = h
        .sources
        .store(
            &room,
            Save {
                row,
                state: Some(encode(&doc, &StateVector::default())),
                text: Some(effects),
                actors: vec![h.user.clone()],
                edits: None,
                retry_event: None,
                operations: Vec::new(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.status(), Some(413), "{error:?}");

    let input = EditInput {
        actor_user_id: h.user.clone(),
        commands: vec![json!({
            "type": "replace_text",
            "expectedText": "END",
            "text": "END and more",
        })],
        file_id: room.file_id.clone(),
        operation: json!({ "id": "op_full", "requestHash": "h1" }),
        undo: None,
    };
    let live = |_: &str| -> BoxFuture<Option<Vec<u8>>> { Box::pin(async { None }) };
    let Err(error) = h.sources.apply_edit(input, live).await else {
        panic!("the edit committed");
    };
    assert_eq!(error.status(), Some(413), "{error:?}");
    assert_eq!(h.row(&room).await.get::<_, i64>(0), 0, "nothing was stored");
}

/// A trashed file waits for no rebuild, though its room unloading (its
/// editors closed by the trash) still schedules one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn a_trashed_file_waits_for_no_rebuild() {
    let h = harness().await;
    let room = h.file("docx", "lesson.docx", b"base").await;
    let client = h.fake.db.get().await.unwrap();
    client
        .execute(
            "UPDATE source_documents SET rebuild_pending=true WHERE file_id=$1",
            &[&room.file_id],
        )
        .await
        .unwrap();
    assert!(h.sources.rebuild_pending(&room.file_id).await.unwrap());
    client
        .execute(
            "UPDATE files SET trashed_at=now(),trash_episode_id='te_'||id,purge_after=now()+interval '30 days' WHERE id=$1",
            &[&room.file_id],
        )
        .await
        .unwrap();
    assert!(!h.sources.rebuild_pending(&room.file_id).await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn an_ended_epoch_refuses_the_save_for_good() {
    let h = harness().await;
    let room = h.file("text", "notes.md", b"abc").await;
    let doc = text_doc(100);
    h.sources.load(&room, &h.user, &doc).await.unwrap();
    let mut durable = doc.transact().state_vector();
    assert!(h.sources.reset_epoch(&room).await.unwrap());
    assert!(!h.sources.reset_epoch(&room).await.unwrap());
    type_into(&doc, 7, 0, ">");
    let error = save_text(&h, &room, &doc, &mut durable).await.unwrap_err();
    assert!(error.refused(), "{error:?}");
    assert_eq!(
        error.discard_cause(false).reason.as_deref(),
        Some("epoch_changed")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn a_fold_keeps_the_rows_an_unexported_capture_needs_and_the_export_materializes_it() {
    let h = harness().await;
    let room = h.file("text", "notes.md", b"one").await;
    let doc = text_doc(100);
    h.sources.load(&room, &h.user, &doc).await.unwrap();
    let mut durable = doc.transact().state_vector();
    type_into(&doc, 7, 3, " two");
    save_text(&h, &room, &doc, &mut durable).await.unwrap();
    type_into(&doc, 7, 7, " three");
    save_text(&h, &room, &doc, &mut durable).await.unwrap();
    // A refresh captured checkpoint 2, not exported yet.
    let job = unique("job");
    let client = h.fake.db.get().await.unwrap();
    client
        .execute(
            "INSERT INTO jobs (id,type,status,payload) VALUES ($1,'source_refresh','pending',jsonb_build_object('fileId',$2::text))",
            &[&job, &room.file_id],
        )
        .await
        .unwrap();
    client
        .execute(
            "INSERT INTO source_refresh_candidates (file_id,job_id,epoch,checkpoint,lease_token) VALUES ($1,$2,1,2,'lease')",
            &[&room.file_id, &job],
        )
        .await
        .unwrap();
    type_into(&doc, 7, 13, " four");
    save_text(&h, &room, &doc, &mut durable).await.unwrap();
    assert_eq!(h.sources.fold(&room).await.unwrap().rows, 2);
    assert_eq!(h.row(&room).await.get::<_, i64>(9), 1);
    // The export reads the capture as of checkpoint 2 and records it.
    h.sources
        .export_candidate(&room.file_id, &job, None)
        .await
        .unwrap();
    assert_eq!(
        h.fake.uploads.lock().unwrap().get(&room.file_id).cloned(),
        Some(b"one two three".to_vec())
    );
    let captured: Option<Vec<u8>> = client
        .query_one(
            "SELECT state FROM source_refresh_candidates WHERE file_id=$1",
            &[&room.file_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(
        sources::text::text_state(&captured.unwrap()).unwrap(),
        "one two three"
    );
    // Exported: nothing holds the last row back any more.
    assert_eq!(h.sources.fold(&room).await.unwrap().rows, 1);
    let folded = text_doc(101);
    h.sources.load(&room, &h.user, &folded).await.unwrap();
    assert_eq!(text(&folded), "one two three four");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn an_office_room_appends_rows_with_its_text_count_and_checks_its_seed_on_load() {
    let h = harness().await;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = std::fs::read(root.join("e2e/fixtures/files/basic/grades.xlsx")).unwrap();
    let room = h.file("xlsx", "grades.xlsx", &bytes).await;
    let doc = Doc::with_client_id(100);
    h.sources.load(&room, &h.user, &doc).await.unwrap();
    let durable = doc.transact().state_vector();
    // An edit made by the engine (as a client's would), applied to the room.
    let sha = office_service::sha256_hex(&bytes);
    let checkpoint = |state| office_service::Checkpoint {
        format: office_service::Format::Xlsx,
        schema_version: 1,
        base_sha256: &sha,
        state,
    };
    let seed = encode(&doc, &StateVector::default());
    let entries = office_service::inspect(&bytes, checkpoint(&seed)).unwrap();
    let entry = entries
        .iter()
        .find(|entry| !entry.value.is_empty())
        .unwrap();
    let (sheet, cell) = entry.position.rsplit_once(':').unwrap();
    let edited = office_service::apply_commands(
        &bytes,
        checkpoint(&seed),
        &[office_service::Command::SetCell {
            sheet: sheet.into(),
            cell: cell.into(),
            expected_value: entry.value.clone(),
            value: "changed".into(),
        }],
    )
    .unwrap();
    let edit_doc = Doc::new();
    apply(&edit_doc, &edited.state);
    let held = doc.transact().state_vector();
    apply(&doc, &encode(&edit_doc, &held));
    let row = encode(&doc, &durable);
    let saved = h
        .sources
        .store(
            &room,
            Save {
                row: row.clone(),
                state: Some(encode(&doc, &StateVector::default())),
                text: None,
                edits: h.sources.take_edits(&room),
                actors: vec![h.user.clone()],
                retry_event: None,
                operations: Vec::new(),
            },
        )
        .await
        .unwrap();
    assert_eq!(saved.checkpoint, 1);
    // Office effects are read on demand (Q405): the save stores the count of
    // the cell text it replaced and wrote.
    let stored = h.row(&room).await;
    assert_eq!(stored.get::<_, Value>(5), json!([]));
    assert!(stored.get::<_, i64>(6) >= 2, "{}", stored.get::<_, i64>(6));
    assert_eq!(stored.get::<_, i64>(2), row.len() as i64);
    let seed_sha: String = stored.get(4);
    assert_eq!(
        seed_sha,
        office_service::sha256_hex(
            office_service::seed(office_service::Format::Xlsx, &bytes).unwrap()
        )
    );
    let again = Doc::with_client_id(101);
    h.sources.load(&room, &h.user, &again).await.unwrap();
    assert_eq!(
        encode(&again, &StateVector::default()).len(),
        encode(&doc, &StateVector::default()).len()
    );
    // A change taken over another seed never loads.
    h.fake
        .db
        .get()
        .await
        .unwrap()
        .execute(
            "UPDATE source_documents SET state_seed_sha256=repeat('f',64) WHERE file_id=$1",
            &[&room.file_id],
        )
        .await
        .unwrap();
    let error = h
        .sources
        .load(&room, &h.user, &Doc::new())
        .await
        .unwrap_err();
    assert_eq!(error, SourceError::SeedChanged);
    assert!(error.refused());
}

/// A DOCX fixture loaded in a room, its first paragraph with text.
async fn docx_room(h: &Harness) -> (SourceRoom, Vec<u8>, Doc, String, String) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = std::fs::read(root.join("e2e/fixtures/files/basic/lesson.docx")).unwrap();
    let room = h.file("docx", "lesson.docx", &bytes).await;
    let doc = Doc::with_client_id(100);
    h.sources.load(&room, &h.user, &doc).await.unwrap();
    let sha = office_service::sha256_hex(&bytes);
    let state = encode(&doc, &StateVector::default());
    let entry = office_service::inspect(&bytes, docx_checkpoint(&sha, &state))
        .unwrap()
        .into_iter()
        .find(|entry| entry.value.len() > 3)
        .unwrap();
    (room, bytes, doc, entry.id, entry.value)
}

fn docx_checkpoint<'a>(sha: &'a str, state: &'a [u8]) -> office_service::Checkpoint<'a> {
    office_service::Checkpoint {
        format: office_service::Format::Docx,
        schema_version: 1,
        base_sha256: sha,
        state,
    }
}

/// The engine's edit of the room's document, reaching the room as a
/// client's would.
fn engine_edit(doc: &Doc, bytes: &[u8], command: Value) {
    let sha = office_service::sha256_hex(bytes);
    let state = encode(doc, &StateVector::default());
    let command: office_service::Command = serde_json::from_value(command).unwrap();
    let edited =
        office_service::apply_commands(bytes, docx_checkpoint(&sha, &state), &[command]).unwrap();
    let edit_doc = Doc::new();
    apply(&edit_doc, &edited.state);
    let held = doc.transact().state_vector();
    apply(doc, &encode(&edit_doc, &held));
}

async fn save_office(
    h: &Harness,
    room: &SourceRoom,
    doc: &Doc,
    durable: &mut StateVector,
) -> Result<u64, SourceError> {
    let saved = h
        .sources
        .store(
            room,
            Save {
                row: encode(doc, durable),
                state: Some(encode(doc, &StateVector::default())),
                edits: h.sources.take_edits(room),
                text: None,
                actors: vec![h.user.clone()],
                retry_event: None,
                operations: Vec::new(),
            },
        )
        .await?;
    *durable = doc.transact().state_vector();
    Ok(saved.checkpoint)
}

/// The file's stored count of edited text (`net_tokens`).
async fn net_tokens(h: &Harness, room: &SourceRoom) -> i64 {
    h.row(room).await.get(6)
}

/// Engine calls since the last look, on both lanes.
fn engine_calls(h: &Harness) -> usize {
    let (save, background) = h.sources.engines().take_stats();
    save.calls + background.calls
}

/// Q405 (Epo 2026-10-26): an Office save stores no effects, only the text its
/// edits inserted and deleted; a save that only formatted adds nothing, a
/// failed save hands its count to the next, and the scheduler takes the file
/// once the count reaches the trigger, not a token before.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn an_office_save_counts_its_edited_text_until_the_trigger() {
    let h = harness().await;
    let (room, bytes, doc, id, text) = docx_room(&h).await;
    let mut durable = doc.transact().state_vector();
    engine_edit(
        &doc,
        &bytes,
        json!({ "type": "format_text", "targetId": id, "text": text, "bold": true }),
    );
    assert!(
        encode(&doc, &durable).len() > 2,
        "the format changed the document"
    );
    save_office(&h, &room, &doc, &mut durable).await.unwrap();
    let row = h.row(&room).await;
    assert_eq!((row.get::<_, i64>(0), row.get::<_, i64>(6)), (1, 0));
    assert_eq!(row.get::<_, Value>(5), json!([]));

    // 11,996 characters (a paragraph holds at most 5,000): 2,999 tokens,
    // one short of the trigger. The save fails once (a moved checkpoint) and
    // the next one stores its count.
    for length in [5_000, 5_000, 1_996] {
        engine_edit(
            &doc,
            &bytes,
            json!({ "type": "insert_paragraph", "afterId": id, "text": "a".repeat(length) }),
        );
    }
    h.fake.moved.lock().unwrap().insert(room.file_id.clone(), 0);
    save_office(&h, &room, &doc, &mut durable)
        .await
        .unwrap_err();
    h.fake.moved.lock().unwrap().clear();
    save_office(&h, &room, &doc, &mut durable).await.unwrap();
    assert_eq!(net_tokens(&h, &room).await, 2999);
    let due = || async {
        let mut client = h.fake.db.get().await.unwrap();
        let txn = client.transaction().await.unwrap();
        // Only this file competes for the batch; the rollback restores the rest.
        for statement in [
            "UPDATE source_documents SET refresh_error='other test' WHERE file_id<>$1",
            "UPDATE source_documents SET last_edited_at=now()-interval '2 minutes' WHERE file_id=$1",
            "UPDATE files SET ever_parsed_successfully=true WHERE id=$1",
        ] {
            txn.execute(statement, &[&room.file_id]).await.unwrap();
        }
        let picked = txn
            .query(
                sources::refresh::REFRESH_CANDIDATES_SQL,
                &[
                    &sources::refresh::OFFICE_REFRESH_TOKENS,
                    &sources::refresh::OFFICE_REFRESH_IDLE,
                    &sources::refresh::OFFICE_REFRESH_STALE,
                ],
            )
            .await
            .unwrap();
        txn.rollback().await.unwrap();
        picked
            .iter()
            .any(|row| row.get::<_, String>(0) == room.file_id)
    };
    assert!(!due().await, "2,999 tokens are not due");
    engine_edit(
        &doc,
        &bytes,
        json!({ "type": "insert_paragraph", "afterId": id, "text": "abcd" }),
    );
    save_office(&h, &room, &doc, &mut durable).await.unwrap();
    assert_eq!(net_tokens(&h, &room).await, 3000);
    assert!(due().await, "3,000 tokens are due");
}

/// Q451 (Epo 2026-10-27): with no room loaded, an Office agent Undo adds the
/// text it inserts and deletes to `net_tokens`, as the edit it reverses did
/// and as a room counts every transaction it admits. Fails if the Undo
/// counts nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn an_office_undo_with_no_room_counts_its_edited_text() {
    let h = harness().await;
    let (room, _, _, id, _) = docx_room(&h).await;
    let live = |_: &str| -> BoxFuture<Option<Vec<u8>>> { Box::pin(async { None }) };
    let input = |operation: &str, commands: Vec<Value>, undo: Option<SentBack>| EditInput {
        actor_user_id: h.user.clone(),
        commands,
        file_id: room.file_id.clone(),
        operation: json!({ "id": operation, "requestHash": operation }),
        undo,
    };
    let insert = json!({ "type": "insert_paragraph", "afterId": id, "text": "a".repeat(400) });
    let edited = h
        .sources
        .apply_edit(input("op_counted", vec![insert], None), live)
        .await
        .unwrap();
    let after_edit = net_tokens(&h, &room).await;
    assert!(after_edit > 0, "the edit counted its text");
    let undo = SentBack {
        epoch: edited.epoch,
        update: edited.undo.expect("the edit's Undo payload"),
        undo_of: "op_counted".into(),
    };
    h.sources
        .apply_edit(input("op_counted_undo", Vec::new(), Some(undo)), live)
        .await
        .unwrap();
    assert_eq!(net_tokens(&h, &room).await, 2 * after_edit);
}

/// One file's Office effects as `office_changes` reads them, as JSON.
async fn office_read<F>(sources: &Sources, workspace: &str, files: &[String], live: &F) -> String
where
    F: Fn(String) -> BoxFuture<Option<Vec<u8>>>,
{
    let read = sources
        .office_changes(workspace, files, live, OFFICE_CHANGES_BUDGET)
        .await
        .unwrap();
    assert!(read.failed.is_empty(), "{:?}", read.failed);
    let [file] = <[_; 1]>::try_from(read.files).unwrap();
    serde_json::to_string(&file.changes).unwrap()
}

/// Q423 (Epo 2026-10-27): an Office file's read effects are cached on its
/// source-document row for the saved version they were read at, uncharged:
/// a cached read calls no engine, on a restarted server too; a save and a
/// publication each make the next read compute again; unsaved edits in the
/// room are computed live and never written.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn office_effects_are_cached_on_the_row_per_saved_version() {
    let h = harness().await;
    let (room, bytes, doc, id, text) = docx_room(&h).await;
    let mut durable = doc.transact().state_vector();
    engine_edit(
        &doc,
        &bytes,
        json!({ "type": "replace_text", "targetId": id, "expectedText": text, "text": format!("{text} saved") }),
    );
    save_office(&h, &room, &doc, &mut durable).await.unwrap();
    let live_doc = doc.clone();
    let live = move |_: String| -> BoxFuture<Option<Vec<u8>>> {
        let state = encode(&live_doc, &StateVector::default());
        Box::pin(async move { Some(state) })
    };
    let files = [room.file_id.clone()];
    // The row's cache: its version and effects, and the row's storage charge.
    let cached = || async {
        let row = h
            .fake
            .db
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT effects_cache->'at', (effects_cache->'effects')::text, storage_bytes, checkpoint FROM source_documents WHERE file_id=$1",
                &[&room.file_id],
            )
            .await
            .unwrap();
        (
            row.get::<_, Option<Value>>(0),
            row.get::<_, Option<String>>(1).unwrap_or_default(),
            row.get::<_, i64>(2),
            row.get::<_, i64>(3),
        )
    };
    let (none, _, charged, checkpoint) = cached().await;
    assert_eq!(none, None);
    engine_calls(&h);
    let json = office_read(&h.sources, &h.workspace, &files, &live).await;
    assert!(engine_calls(&h) > 0 && json.contains(" saved"), "{json}");
    let (at, stored, charge, _) = cached().await;
    assert_eq!(charge, charged, "the cache is not charged to storage");
    assert_eq!(
        at.unwrap()["checkpoint"],
        json!(checkpoint),
        "a cold read writes its version"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&stored).unwrap(),
        serde_json::from_str::<Value>(&json).unwrap()
    );
    office_read(&h.sources, &h.workspace, &files, &live).await;
    assert_eq!(engine_calls(&h), 0, "a cached read calls no engine");
    let (restarted, _disk) = sources_on(&h.fake, h.fake.db.clone());
    assert_eq!(
        office_read(&restarted, &h.workspace, &files, &live).await,
        json
    );
    let (save, background) = restarted.engines().take_stats();
    assert_eq!(
        save.calls + background.calls,
        0,
        "the cache survives a restart"
    );

    // An unsaved edit in the room: computed live each read, never written.
    engine_edit(
        &doc,
        &bytes,
        json!({ "type": "insert_paragraph", "afterId": id, "text": "typed live" }),
    );
    for _ in 0..2 {
        let json = office_read(&h.sources, &h.workspace, &files, &live).await;
        assert!(
            engine_calls(&h) > 0 && json.contains("typed live"),
            "{json}"
        );
    }
    let (_, stored, _, _) = cached().await;
    assert!(!stored.contains("typed live") && stored.contains(" saved"));

    // Its save moves the version: the next read computes and writes again.
    save_office(&h, &room, &doc, &mut durable).await.unwrap();
    let json = office_read(&h.sources, &h.workspace, &files, &live).await;
    assert!(engine_calls(&h) > 0 && json.contains("typed live"));
    let (at, _, _, checkpoint) = cached().await;
    assert_eq!(at.unwrap()["checkpoint"], json!(checkpoint));
    office_read(&h.sources, &h.workspace, &files, &live).await;
    assert_eq!(engine_calls(&h), 0);

    // A publication moves the base revision.
    h.fake
        .db
        .get()
        .await
        .unwrap()
        .execute(
            "UPDATE source_documents SET base_revision=base_revision+1 WHERE file_id=$1",
            &[&room.file_id],
        )
        .await
        .unwrap();
    office_read(&h.sources, &h.workspace, &files, &live).await;
    assert!(engine_calls(&h) > 0, "a publication's version is read anew");
    office_read(&h.sources, &h.workspace, &files, &live).await;
    assert_eq!(engine_calls(&h), 0);
}

/// A live-room answer of `doc`'s whole state, for `office_changes`.
fn live_of(doc: &Doc) -> impl Fn(String) -> BoxFuture<Option<Vec<u8>>> + use<> {
    let doc = doc.clone();
    move |_: String| -> BoxFuture<Option<Vec<u8>>> {
        let state = encode(&doc, &StateVector::default());
        Box::pin(async move { Some(state) })
    }
}

/// A file's `effects_cache` column.
async fn effects_cache(h: &Harness, room: &SourceRoom) -> Option<Value> {
    h.fake
        .db
        .get()
        .await
        .unwrap()
        .query_one(
            "SELECT effects_cache FROM source_documents WHERE file_id=$1",
            &[&room.file_id],
        )
        .await
        .unwrap()
        .get(0)
}

/// Q435 (Epo 2026-10-27): a save takes the room's count and version as the
/// room captures its row, so an edit the room applies while that save runs
/// stays unsaved: the next read computes it live and writes no cache.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn an_edit_applied_while_a_save_runs_stays_unsaved() {
    let h = harness().await;
    let (room, bytes, doc, id, text) = docx_room(&h).await;
    let durable = doc.transact().state_vector();
    engine_edit(
        &doc,
        &bytes,
        json!({ "type": "replace_text", "targetId": id, "expectedText": text, "text": format!("{text} captured") }),
    );
    // The room captures the row and takes its count ...
    let row = encode(&doc, &durable);
    let state = encode(&doc, &StateVector::default());
    let edits = h.sources.take_edits(&room);
    // ... and applies the next edit before the save stores.
    engine_edit(
        &doc,
        &bytes,
        json!({ "type": "insert_paragraph", "afterId": id, "text": "during the save" }),
    );
    h.sources
        .store(
            &room,
            Save {
                row,
                state: Some(state),
                edits,
                text: None,
                actors: vec![h.user.clone()],
                retry_event: None,
                operations: Vec::new(),
            },
        )
        .await
        .unwrap();
    let json = office_read(
        &h.sources,
        &h.workspace,
        std::slice::from_ref(&room.file_id),
        &live_of(&doc),
    )
    .await;
    assert!(json.contains("during the save"), "{json}");
    assert_eq!(effects_cache(&h, &room).await, None);
}

/// Q435: a cached entry carries the engine's build, its program's hash; an
/// entry of another build, or one that no longer decodes, is a miss: read
/// again and replaced.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn a_cache_entry_of_another_engine_or_unreadable_is_read_again() {
    let h = harness().await;
    let (room, bytes, doc, id, text) = docx_room(&h).await;
    let mut durable = doc.transact().state_vector();
    engine_edit(
        &doc,
        &bytes,
        json!({ "type": "replace_text", "targetId": id, "expectedText": text, "text": format!("{text} saved") }),
    );
    save_office(&h, &room, &doc, &mut durable).await.unwrap();
    let (files, live) = ([room.file_id.clone()], live_of(&doc));
    let json = office_read(&h.sources, &h.workspace, &files, &live).await;
    let program = std::fs::read(env!("CARGO_BIN_EXE_sources-test-engine")).unwrap();
    let engine = json!(office_service::sha256_hex(&program)[..16]);
    assert_eq!(
        effects_cache(&h, &room).await.unwrap()["at"]["engine"],
        engine
    );
    for (plant, entry) in [
        (
            "jsonb_set(effects_cache,'{at,engine}','\"other\"')",
            "another engine's entry",
        ),
        (
            r#"jsonb_set(effects_cache,'{effects}','[{"id":"x","kind":"text","operation":5}]')"#,
            "an unreadable entry",
        ),
    ] {
        h.fake
            .db
            .get()
            .await
            .unwrap()
            .execute(
                &format!("UPDATE source_documents SET effects_cache={plant} WHERE file_id=$1"),
                &[&room.file_id],
            )
            .await
            .unwrap();
        engine_calls(&h);
        assert_eq!(
            office_read(&h.sources, &h.workspace, &files, &live).await,
            json,
            "{entry}"
        );
        assert!(engine_calls(&h) > 0, "{entry} is read again");
        let cache = effects_cache(&h, &room).await.unwrap();
        assert_eq!(cache["at"]["engine"], engine, "{entry} is replaced");
        assert_eq!(
            cache["effects"],
            serde_json::from_str::<Value>(&json).unwrap(),
            "{entry} is replaced"
        );
    }
}

/// Q435: a read past its budget answers the files it has not read as
/// failed; the files it did read, here a cached one, still answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn files_not_read_within_the_budget_answer_failed() {
    let h = harness().await;
    let (room, bytes, doc, id, text) = docx_room(&h).await;
    let mut durable = doc.transact().state_vector();
    engine_edit(
        &doc,
        &bytes,
        json!({ "type": "replace_text", "targetId": id, "expectedText": text, "text": format!("{text} saved") }),
    );
    save_office(&h, &room, &doc, &mut durable).await.unwrap();
    let live = live_of(&doc);
    office_read(
        &h.sources,
        &h.workspace,
        std::slice::from_ref(&room.file_id),
        &live,
    )
    .await;
    let cold = h.file("docx", "cold.docx", &bytes).await;
    let read = h
        .sources
        .office_changes(
            &h.workspace,
            &[room.file_id.clone(), cold.file_id.clone()],
            &live,
            Duration::ZERO,
        )
        .await
        .unwrap();
    let read_ids: Vec<_> = read.files.iter().map(|file| &file.file_id).collect();
    assert_eq!(read_ids, [&room.file_id]);
    assert!(!read.files[0].changes.is_empty());
    assert_eq!(read.failed, [cold.file_id]);
}

/// Security regression (Q451, final review L4): `office_changes` reads only
/// the named workspace's files. Another workspace's file with a saved edit,
/// read under its own workspace, comes back neither read nor failed when
/// named under this one. Fails without the read's workspace filter.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn office_changes_read_only_the_named_workspaces_files() {
    let h = harness().await;
    let other = harness().await;
    let (room, bytes, doc, id, text) = docx_room(&other).await;
    let mut durable = doc.transact().state_vector();
    engine_edit(
        &doc,
        &bytes,
        json!({ "type": "replace_text", "targetId": id, "expectedText": text, "text": format!("{text} saved") }),
    );
    save_office(&other, &room, &doc, &mut durable)
        .await
        .unwrap();
    let live = live_of(&doc);
    let files = std::slice::from_ref(&room.file_id);
    let read = |workspace: String| {
        let (sources, live) = (other.sources.clone(), &live);
        async move {
            sources
                .office_changes(&workspace, files, live, OFFICE_CHANGES_BUDGET)
                .await
                .unwrap()
        }
    };
    let own = read(other.workspace.clone()).await;
    assert_eq!(own.files.len(), 1, "its own workspace reads it");
    let foreign = read(h.workspace.clone()).await;
    assert!(foreign.files.is_empty(), "read under another workspace");
    assert!(foreign.failed.is_empty(), "{:?}", foreign.failed);
}

/// A DOCX file with one saved edit, and its room's document.
async fn saved_docx(h: &Harness) -> (SourceRoom, Doc) {
    let (room, bytes, doc, id, text) = docx_room(h).await;
    let mut durable = doc.transact().state_vector();
    engine_edit(
        &doc,
        &bytes,
        json!({ "type": "replace_text", "targetId": id, "expectedText": text, "text": format!("{text} saved") }),
    );
    save_office(h, &room, &doc, &mut durable).await.unwrap();
    (room, doc)
}

/// Takes a file out of its workspace, as an upload with none.
async fn no_workspace(h: &Harness, room: &SourceRoom) {
    h.fake
        .db
        .get()
        .await
        .unwrap()
        .execute(
            "UPDATE files SET workspace_id=NULL WHERE id=$1",
            &[&room.file_id],
        )
        .await
        .unwrap();
}

/// Security regression (account chat): an empty workspace id reads only the
/// named files with no workspace, and a workspace id leaves those out. Fails
/// without the read's `NULLIF` filter, or while a file's owner is found only
/// through its workspace.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn an_empty_workspace_reads_only_files_with_no_workspace() {
    let h = harness().await;
    let (standalone, doc) = saved_docx(&h).await;
    no_workspace(&h, &standalone).await;
    let (filed, _) = saved_docx(&h).await;
    let files = [standalone.file_id.clone(), filed.file_id.clone()];
    let live = live_of(&doc);
    for (workspace, expected) in [("", &standalone), (h.workspace.as_str(), &filed)] {
        let read = h
            .sources
            .office_changes(workspace, &files, &live, OFFICE_CHANGES_BUDGET)
            .await
            .unwrap();
        assert!(read.failed.is_empty(), "{workspace:?}: {:?}", read.failed);
        let [file] = <[_; 1]>::try_from(read.files).unwrap();
        assert_eq!(file.file_id, expected.file_id, "{workspace:?}");
        assert!(!file.changes.is_empty(), "{workspace:?}");
    }
}

/// Account chat: a no-workspace file's image change resolves for an empty
/// workspace id, as Go sends it, and is refused under a workspace's id.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn a_no_workspace_files_image_change_resolves() {
    let h = harness().await;
    let (room, _, doc, _, _) = docx_room(&h).await;
    let mut durable = doc.transact().state_vector();
    // An image pasted in the editor.
    let image = b"\x89PNG pasted".to_vec();
    let editor = docx_edit::EditingDoc::new(7);
    editor
        .apply_update_v1(&encode(&doc, &StateVector::default()))
        .unwrap();
    let src = format!("data:image/png;base64,{}", STANDARD.encode(&image));
    editor
        .insert_embed(
            &docx_edit::EditCtx::local("test", "2026-10-28T00:00:00.000Z"),
            docx_edit::Position::new("body", 0),
            "image",
            vec![("src".into(), src.into())],
        )
        .unwrap();
    apply(&doc, &editor.encode_state_as_update_v1());
    save_office(&h, &room, &doc, &mut durable).await.unwrap();
    no_workspace(&h, &room).await;
    let read = h
        .sources
        .office_changes(
            "",
            std::slice::from_ref(&room.file_id),
            &live_of(&doc),
            OFFICE_CHANGES_BUDGET,
        )
        .await
        .unwrap();
    let [file] = <[_; 1]>::try_from(read.files).unwrap();
    let change = file
        .changes
        .iter()
        .find(|change| change.asset_ref.is_some())
        .expect("the image's change");
    let input = |workspace: &str| ResolveInput {
        file_id: room.file_id.clone(),
        workspace_id: workspace.into(),
        user_id: h.user.clone(),
        epoch: file.epoch,
        checkpoint: file.checkpoint,
        change_id: change.id.clone(),
    };
    let resolved = h.sources.resolve(&input(""), live_of(&doc)).await.unwrap();
    assert_eq!(STANDARD.decode(resolved.bytes).unwrap(), image);
    let refused = h
        .sources
        .resolve(&input(&h.workspace), live_of(&doc))
        .await
        .unwrap_err();
    assert_eq!(refused.status(), Some(409));
}

/// Standalone files (Epo 2026-10-27): the agent inspects and edits a file
/// with no workspace through its owner's session, which Go's bootstrap
/// answers with no workspace (""), and the save names none, so Go checks the
/// actor as the file's payer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn a_file_with_no_workspace_is_inspected_and_edited() {
    let h = harness().await;
    let room = h.file("text", "notes.md", b"abc").await;
    no_workspace(&h, &room).await;
    let inspect = || async {
        h.sources
            .inspect(
                &room.file_id,
                &h.user,
                None,
                |_: String| -> BoxFuture<Option<Vec<u8>>> { Box::pin(async { None }) },
            )
            .await
            .unwrap()
            .text
    };
    assert_eq!(inspect().await.as_deref(), Some("abc"));
    let live = |_: &str| -> BoxFuture<Option<Vec<u8>>> { Box::pin(async { None }) };
    let input = EditInput {
        actor_user_id: h.user.clone(),
        commands: vec![json!({ "type": "replace_text", "expectedText": "abc", "text": "abd" })],
        file_id: room.file_id.clone(),
        operation: json!({ "id": unique("op"), "requestHash": "h1" }),
        undo: None,
    };
    h.sources.apply_edit(input, live).await.unwrap();
    assert_eq!(*h.fake.saved_in.lock().unwrap(), [Some(String::new())]);
    assert_eq!(inspect().await.as_deref(), Some("abd"));
}

/// Q435: a cache write that fails is logged, and the read still answers
/// the effects it computed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn a_failed_cache_write_still_answers_the_read() {
    let h = harness().await;
    let (room, bytes, doc, id, text) = docx_room(&h).await;
    let mut durable = doc.transact().state_vector();
    engine_edit(
        &doc,
        &bytes,
        json!({ "type": "replace_text", "targetId": id, "expectedText": text, "text": format!("{text} saved") }),
    );
    save_office(&h, &room, &doc, &mut durable).await.unwrap();
    // A trigger refuses this file's cache writes.
    let refuse = format!("\"{}\"", unique("refuse"));
    let client = h.fake.db.get().await.unwrap();
    client
        .batch_execute(&format!(
            "CREATE FUNCTION {refuse}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'refused'; END$$;
             CREATE TRIGGER {refuse} BEFORE UPDATE OF effects_cache ON source_documents FOR EACH ROW
             WHEN (NEW.file_id='{}' AND NEW.effects_cache IS NOT NULL) EXECUTE FUNCTION {refuse}()",
            room.file_id
        ))
        .await
        .unwrap();
    let json = office_read(
        &h.sources,
        &h.workspace,
        std::slice::from_ref(&room.file_id),
        &live_of(&doc),
    )
    .await;
    client
        .batch_execute(&format!(
            "DROP TRIGGER {refuse} ON source_documents; DROP FUNCTION {refuse}()"
        ))
        .await
        .unwrap();
    assert!(json.contains(" saved"), "{json}");
    assert_eq!(effects_cache(&h, &room).await, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn cold_folds_outnumbering_the_pool_connections_all_finish() {
    let h = harness().await;
    let mut rooms = Vec::new();
    for n in 0..4 {
        let room = h
            .file(
                "text",
                &format!("n{n}.md"),
                format!(
                    "text {n}
"
                )
                .as_bytes(),
            )
            .await;
        let doc = text_doc(100);
        h.sources.load(&room, &h.user, &doc).await.unwrap();
        let mut durable = doc.transact().state_vector();
        type_into(&doc, 7, 0, "X");
        save_text(&h, &room, &doc, &mut durable).await.unwrap();
        rooms.push(room);
    }
    // A fresh instance (no cached base or seed) on two connections that wait
    // without limit: a fold holding one while it takes another would hang.
    let mut config = deadpool_postgres::Config::new();
    config.url = Some(std::env::var("SOURCES_TEST_DATABASE_URL").unwrap());
    config.pool = Some(deadpool_postgres::PoolConfig::new(2));
    let small = config
        .create_pool(
            Some(deadpool_postgres::Runtime::Tokio1),
            tokio_postgres::NoTls,
        )
        .unwrap();
    let (cold, _cold_disk) = sources_on(&h.fake, small);
    let folds = futures::future::join_all(rooms.iter().map(|room| cold.fold(room)));
    let folded = tokio::time::timeout(Duration::from_secs(60), folds)
        .await
        .expect("every fold finishes");
    for fold in folded {
        assert_eq!(fold.unwrap().rows, 1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn an_unloaded_room_forgets_only_its_own_record() {
    let h = harness().await;
    let room = h.file("text", "again.md", b"abc").await;
    let first = h
        .sources
        .load(&room, &h.user, &text_doc(100))
        .await
        .unwrap();
    // The room reloads before the old one's forget runs.
    let second = h
        .sources
        .load(&room, &h.user, &text_doc(101))
        .await
        .unwrap();
    h.sources.forget(&room, first.hold.generation()).await;
    assert_eq!(h.sources.known_checkpoint(&room), Some(0));
    h.sources.forget(&room, second.hold.generation()).await;
    assert_eq!(h.sources.known_checkpoint(&room), None);
}

/// No room is loaded here: a text publication never touches one.
struct NoRooms;

impl Rooms for NoRooms {
    fn broadcast(&self, _room: &str, _payload: String) {}
    fn channels(&self, _room: &str) -> Vec<Channel> {
        Vec::new()
    }
    fn loaded(&self, _room: &str) -> bool {
        false
    }
    fn set_read_only(&self, _room: &str, _channel: ChannelId) {}
    fn restore_access(&self, _room: &str) {}
    fn close(&self, _room: &str, _channel: Option<ChannelId>, _code: Option<u16>, _reason: &str) {}
    fn persist(&self, _room: &str) -> BoxFuture<Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn busy(&self, _room: &str, _writers_only: bool) -> bool {
        false
    }
    fn unload(&self, _room: &str) -> BoxFuture<()> {
        Box::pin(async {})
    }
}

/// UAT's publication hold covers text (Epo 2026-10-14): a text publication
/// waits while its file's name holds the marker, then measures what was
/// saved meanwhile as its residual.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn the_uat_hold_holds_a_text_publication_and_keeps_the_save_made_meanwhile() {
    let h = harness().await;
    let room = h
        .file(
            "text",
            &format!("notes {PUBLICATION_HOLD_MARKER}.md"),
            b"one",
        )
        .await;
    let doc = text_doc(100);
    h.sources.load(&room, &h.user, &doc).await.unwrap();
    let mut durable = doc.transact().state_vector();
    type_into(&doc, 7, 3, " two");
    save_text(&h, &room, &doc, &mut durable).await.unwrap();
    // A refresh captured checkpoint 1 and exported it.
    let job = unique("job");
    let client = h.fake.db.get().await.unwrap();
    client
        .execute(
            "INSERT INTO jobs (id,type,status,payload) VALUES ($1,'source_refresh','pending',jsonb_build_object('fileId',$2::text))",
            &[&job, &room.file_id],
        )
        .await
        .unwrap();
    client
        .execute(
            "INSERT INTO source_refresh_candidates (file_id,job_id,epoch,checkpoint,lease_token) VALUES ($1,$2,1,1,'lease')",
            &[&room.file_id, &job],
        )
        .await
        .unwrap();
    h.sources
        .export_candidate(&room.file_id, &job, None)
        .await
        .unwrap();
    let redis_url = std::env::var("SOURCES_TEST_REDIS_URL").expect("SOURCES_TEST_REDIS_URL");
    let redis = redis::Client::open(redis_url)
        .unwrap()
        .get_connection_manager()
        .await
        .unwrap();
    let handoff = Handoff::new(
        unique("instance"),
        redis,
        h.sources.clone(),
        Arc::new(NoRooms),
        true,
    );
    let input: SourcePublish = serde_json::from_value(json!({
        "attemptId": 1,
        "checkpoint": 1,
        "contentHash": "hash",
        "contentId": "content",
        "epoch": 1,
        "fileId": room.file_id,
        "jobId": job,
        "leaseToken": "lease",
        "sourceETag": "etag-1",
    }))
    .unwrap();
    let publishing = tokio::spawn({
        let handoff = handoff.clone();
        async move { handoff.publish(&input).await }
    });
    // Held: an unheld publication would have reached the gateway by now.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(h.fake.published.lock().unwrap().is_empty());
    type_into(&doc, 7, 7, " three");
    assert_eq!(save_text(&h, &room, &doc, &mut durable).await.unwrap(), 2);
    client
        .execute(
            "UPDATE files SET name='notes.md' WHERE id=$1",
            &[&room.file_id],
        )
        .await
        .unwrap();
    publishing.await.unwrap().unwrap();
    let published = h.fake.published.lock().unwrap().clone();
    assert_eq!(published.len(), 1, "{published:?}");
    assert_eq!(published[0]["expectedLatestCheckpoint"], 2);
    // The residual is the changed line against the published text (Q416).
    assert_eq!(published[0]["pendingEffects"][0]["before"], "one two");
    assert_eq!(published[0]["pendingEffects"][0]["after"], "one two three");
    assert!(published[0]["netTokens"].as_i64().unwrap() > 0);
}
