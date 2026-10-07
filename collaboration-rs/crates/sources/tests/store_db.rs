//! Sources against Postgres (server/migrations plus tests/sql/delta_saves.sql)
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
use sources::engine::PoolConfig;
use sources::text::{TEXT_ROOT, text_doc};
use sources::{Save, SourceError, SourceRoom, Sources, SourcesConfig};
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

#[derive(Clone)]
struct Fake {
    db: deadpool_postgres::Pool,
    url: Arc<Mutex<String>>,
    blobs: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    uploads: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    failures: Arc<Mutex<Vec<Value>>>,
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
            "SELECT d.format,d.epoch,d.checkpoint,d.indexed_checkpoint,d.base_revision,d.base_source_sha256,d.state,d.state_seed_sha256,d.pending_effects,d.net_tokens,d.rebuild_pending,f.workspace_id FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.file_id=$1 AND f.trashed_at IS NULL",
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
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The delta-save checkpoint (Go SaveSourceCheckpoint with `update`).
async fn checkpoint(fake: Fake, id: String, body: Value) -> Response {
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
        "UPDATE source_documents SET checkpoint=$2,pending_effects=$3,net_tokens=$4,log_bytes=log_bytes+$5,log_rows=log_rows+1,state_seed_sha256=COALESCE(state_seed_sha256,$6),seed_bytes=COALESCE($7,seed_bytes),base_source_sha256=COALESCE($8,base_source_sha256),last_edited_at=now() WHERE file_id=$1",
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
    txn.commit().await.unwrap();
    axum::Json(json!({ "checkpoint": next })).into_response()
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
    let sources = Arc::new(Sources::new(
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
        },
        db.clone(),
        reqwest::Client::new(),
    ));
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
    }
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
    assert_eq!(effects[0]["after"], "X");
    assert_eq!(effects[0]["label"], "Text at UTF-16 offset 0");
    // The first save over the seed reported its size; nothing else is stored.
    assert!(row.get::<_, i64>(7) > 0);
    assert!(row.get::<_, Option<Vec<u8>>>(3).is_none());

    type_into(&doc, 8, 7, "Y");
    assert_eq!(save_text(&h, &room, &doc, &mut durable).await.unwrap(), 2);
    let effects: Value = h.row(&room).await.get(5);
    assert_eq!(effects[0]["before"], "hello\n");
    assert_eq!(effects[0]["after"], "Xhello\nY");

    // A fresh load replays base and rows to the same text.
    let again = text_doc(101);
    h.sources.load(&room, &h.user, &again).await.unwrap();
    assert_eq!(text(&again), text(&doc));

    let log_bytes: i64 = h.row(&room).await.get(2);
    let before_fold: i64 = h.row(&room).await.get(8);
    assert_eq!(h.sources.fold(&room).await.unwrap(), 2);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn a_moved_checkpoint_measures_again_over_the_rows_saved_meanwhile() {
    let h = harness().await;
    let room = h.file("text", "notes.md", b"abc").await;
    let doc = text_doc(100);
    h.sources.load(&room, &h.user, &doc).await.unwrap();
    let mut durable = doc.transact().state_vector();
    // An agent edit lands first through the gateway (the room never sees it).
    let agent = text_doc(9);
    apply(&agent, &encode(&doc, &StateVector::default()));
    let before = agent.transact().state_vector();
    agent
        .get_or_insert_text(TEXT_ROOT)
        .insert(&mut agent.transact_mut(), 3, "!");
    let agent_row = encode(&agent, &before);
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
    assert_eq!(h.sources.fold(&room).await.unwrap(), 2);
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
    assert_eq!(h.sources.fold(&room).await.unwrap(), 1);
    let folded = text_doc(101);
    h.sources.load(&room, &h.user, &folded).await.unwrap();
    assert_eq!(text(&folded), "one two three four");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Postgres and Redis (docker compose -p rust-sources)"]
async fn an_office_room_appends_rows_with_engine_effects_and_checks_its_seed_on_load() {
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
                actors: vec![h.user.clone()],
                retry_event: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(saved.checkpoint, 1);
    let stored = h.row(&room).await;
    let effects: Value = stored.get(5);
    assert!(
        effects
            .as_array()
            .is_some_and(|effects| !effects.is_empty()),
        "{effects}"
    );
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
