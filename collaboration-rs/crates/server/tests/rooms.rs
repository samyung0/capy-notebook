//! Integration tests of note rooms against Postgres (migrated by the Go API)
//! and Redis: the server binary runs as a child process and two clients speak
//! capy-sync 1 to it. Set CAPY_IT_DATABASE_URL and CAPY_IT_REDIS_URL (the
//! docker e2e stack's, see DESIGN.md 11); without them every test skips.
//! CAPY_IT_API_URL names that stack's Go API (with this file's secret) for
//! the projections a command waits for.

use std::process::{Child, Command, Stdio};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as Ws;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

const SECRET: &str = "it-collaboration-secret";
const ORIGIN: &str = "http://it.test";

struct Env {
    database: String,
    redis: String,
    api: Option<String>,
}

fn env() -> Option<Env> {
    Some(Env {
        database: std::env::var("CAPY_IT_DATABASE_URL").ok()?,
        redis: std::env::var("CAPY_IT_REDIS_URL").ok()?,
        api: std::env::var("CAPY_IT_API_URL").ok(),
    })
}

struct Server {
    child: Child,
    port: u16,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
async fn start(env: &Env) -> Server {
    // A free port per server, so the tests run in parallel.
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .expect("a free port");
    let child = Command::new(env!("CARGO_BIN_EXE_capy-collaboration"))
        .env("DATABASE_URL", &env.database)
        .env("REDIS_URL", &env.redis)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .env("COLLABORATION_SECRET", SECRET)
        .env("COLLABORATION_ALLOWED_ORIGINS", ORIGIN)
        // Without the API, projections fail and are recorded.
        .env(
            "API_URL",
            env.api.as_deref().unwrap_or("http://127.0.0.1:9"),
        )
        .env("COLLABORATION_DEBOUNCE_MS", "200")
        .env("COLLABORATION_MAX_DEBOUNCE_MS", "1000")
        .env("COLLABORATION_PROJECTION_IDLE_MS", "60000")
        .env("APP_ENV", "test")
        // UAT's engine pool (no default in the server).
        .env("COLLABORATION_ENGINE_SAVE_PROCESSES", "1")
        .env("COLLABORATION_ENGINE_BACKGROUND_PROCESSES", "1")
        .env("COLLABORATION_ENGINE_MEMORY_LIMIT_BYTES", "3221225472")
        .stdout(if std::env::var_os("CAPY_IT_LOGS").is_some() {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .spawn()
        .expect("the server starts");
    for _ in 0..100 {
        if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Server { child, port };
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the server did not listen");
}

async fn db(env: &Env) -> tokio_postgres::Client {
    let (client, connection) = tokio_postgres::connect(&env.database, tokio_postgres::NoTls)
        .await
        .expect("postgres");
    tokio::spawn(connection);
    client
}

/// A note owned by a fresh user; returns (user, material).
async fn note(env: &Env, text: &str) -> (String, String) {
    let client = db(env).await;
    let suffix = uuid_like();
    let user = format!("u_it_{suffix}");
    let material = format!("m_it_{suffix}");
    client
        .execute("INSERT INTO users (id, name) VALUES ($1, 'IT')", &[&user])
        .await
        .expect("user");
    let content = serde_json::json!({
        "schemaVersion": 1,
        "value": [{ "type": "p", "id": "b1", "children": [{ "text": text }] }],
    });
    client
        .execute(
            "INSERT INTO materials (id, created_by, kind, title, content) VALUES ($1, $2, 'note', 'IT', $3)",
            &[&material, &user, &content],
        )
        .await
        .expect("material");
    (user, material)
}

fn uuid_like() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

fn token(room: &str, user: &str, access: &str) -> String {
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use hmac::{Hmac, Mac};
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    let schema: i64 = room
        .rsplit(':')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or(1);
    let claims = serde_json::json!({
        "access": access, "aud": "capy-collaboration", "exp": now + 300, "iat": now,
        "iss": "capy-api", "jti": format!("t_{now}_{user}"), "room": room, "schema": schema, "sub": user,
    });
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(SECRET.as_bytes()).expect("key");
    mac.update(format!("{header}.{payload}").as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{header}.{payload}.{signature}")
}

// ------------------------------------------------------------------ client

fn var(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn read_var(bytes: &[u8], at: &mut usize) -> u64 {
    let (mut value, mut shift) = (0u64, 0);
    loop {
        let byte = bytes[*at];
        *at += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return value;
        }
        shift += 7;
    }
}

fn varbytes(out: &mut Vec<u8>, bytes: &[u8]) {
    var(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

fn frame(channel: u64, kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    var(&mut out, channel);
    out.push(kind);
    varbytes(&mut out, payload);
    out
}

fn sync(kind: u64, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    var(&mut out, kind);
    varbytes(&mut out, body);
    out
}

#[derive(Debug)]
struct Msg {
    kind: u8,
    payload: Vec<u8>,
}

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    doc: Doc,
    inbox: Vec<Msg>,
}

impl Client {
    async fn open(port: u16) -> Self {
        let mut request = format!("ws://127.0.0.1:{port}/")
            .into_client_request()
            .expect("request");
        request
            .headers_mut()
            .insert("origin", ORIGIN.parse().expect("origin"));
        let (ws, _) = tokio_tungstenite::connect_async(request)
            .await
            .expect("connect");
        Client {
            ws,
            doc: Doc::with_options(ydoc::doc_options(0)),
            inbox: Vec::new(),
        }
    }

    async fn send(&mut self, kind: u8, payload: &[u8]) {
        self.ws
            .send(Ws::Binary(frame(1, kind, payload).into()))
            .await
            .expect("send");
    }

    async fn join(&mut self, room: &str, token: &str) {
        let mut payload = Vec::new();
        varbytes(&mut payload, room.as_bytes());
        varbytes(&mut payload, token.as_bytes());
        self.send(0, &payload).await;
    }

    /// Reads messages until one of `kind` arrives (applying syncs), or times out.
    async fn until(&mut self, kind: u8) -> Option<Vec<u8>> {
        if let Some(index) = self.inbox.iter().position(|m| m.kind == kind) {
            return Some(self.inbox.remove(index).payload);
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let next = tokio::time::timeout_at(deadline, self.ws.next())
                .await
                .ok()??
                .ok()?;
            let Ws::Binary(bytes) = next else { continue };
            let mut at = 0;
            let mut found = None;
            while at < bytes.len() {
                let _channel = read_var(&bytes, &mut at);
                let message_kind = bytes[at];
                at += 1;
                let len = read_var(&bytes, &mut at) as usize;
                let payload = bytes[at..at + len].to_vec();
                at += len;
                // Syncs apply as they arrive; they wait in the inbox only
                // when asked for.
                if message_kind == 5 {
                    self.on_sync(&payload).await;
                    if kind != 5 {
                        continue;
                    }
                }
                if message_kind == kind && found.is_none() {
                    found = Some(payload);
                } else {
                    self.inbox.push(Msg {
                        kind: message_kind,
                        payload,
                    });
                }
            }
            if found.is_some() {
                return found;
            }
        }
    }

    /// Reads (applying syncs) until `check` holds, for up to 5 s.
    async fn settle(&mut self, check: impl Fn(&Self) -> bool) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !check(self) {
            let Ok(Some(Ok(Ws::Binary(bytes)))) =
                tokio::time::timeout_at(deadline, self.ws.next()).await
            else {
                return check(self);
            };
            let mut at = 0;
            while at < bytes.len() {
                let _channel = read_var(&bytes, &mut at);
                let kind = bytes[at];
                at += 1;
                let len = read_var(&bytes, &mut at) as usize;
                let payload = bytes[at..at + len].to_vec();
                at += len;
                if kind == 5 {
                    self.on_sync(&payload).await;
                } else {
                    self.inbox.push(Msg { kind, payload });
                }
            }
        }
        true
    }

    async fn on_sync(&mut self, payload: &[u8]) {
        let mut at = 0;
        let kind = read_var(payload, &mut at);
        let len = read_var(payload, &mut at) as usize;
        let body = payload[at..at + len].to_vec();
        if kind == 0 {
            let sv = StateVector::decode_v1(&body).expect("sv");
            let diff = self.doc.transact().encode_state_as_update_v1(&sv);
            self.send(5, &sync(1, &diff)).await;
        } else {
            self.doc
                .transact_mut()
                .apply_update(Update::decode_v1(&body).expect("update"))
                .expect("apply");
        }
    }

    /// Joins and syncs; returns the JOINED access byte.
    async fn joined(&mut self, room: &str, token: &str) -> u8 {
        self.join(room, token).await;
        let joined = self.until(1).await.expect("joined");
        let sv = self.doc.transact().state_vector().encode_v1();
        self.send(5, &sync(0, &sv)).await;
        joined[0]
    }

    fn text(&self) -> String {
        let root = self.doc.get_or_insert_text("content");
        let txn = self.doc.transact();
        root.get_string(&txn)
    }

    /// Appends text to the first block (an XmlText inside `content`).
    async fn type_text(&mut self, text: &str) {
        let before = self.doc.transact().state_vector();
        {
            let root = self.doc.get_or_insert_text("content");
            let mut txn = self.doc.transact_mut();
            let diff = root.diff(&txn, yrs::types::text::YChange::identity);
            let block = diff
                .into_iter()
                .find_map(|chunk| match chunk.insert {
                    yrs::Out::YXmlText(block) => Some(block),
                    _ => None,
                })
                .expect("a block");
            let len = block.len(&txn);
            block.insert(&mut txn, len, text);
        }
        let update = self.doc.transact().encode_state_as_update_v1(&before);
        self.send(5, &sync(2, &update)).await;
    }

    fn block_text(&self) -> String {
        let root = self.doc.get_or_insert_text("content");
        let txn = self.doc.transact();
        root.diff(&txn, yrs::types::text::YChange::identity)
            .into_iter()
            .find_map(|chunk| match chunk.insert {
                yrs::Out::YXmlText(block) => Some(block.get_string(&txn)),
                _ => None,
            })
            .unwrap_or_default()
    }
}

fn text_payload(payload: &[u8]) -> String {
    let mut at = 0;
    let len = read_var(payload, &mut at) as usize;
    String::from_utf8(payload[at..at + len].to_vec()).expect("utf8")
}

// ------------------------------------------------------------------- tests

#[tokio::test]
async fn two_clients_converge_without_echo_and_the_store_appends_a_row() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "hello").await;
    let room = format!("material:{material}:schema:1");
    let mut a = Client::open(server.port).await;
    let mut b = Client::open(server.port).await;
    assert_eq!(a.joined(&room, &token(&room, &user, "write")).await, 1);
    assert_eq!(b.joined(&room, &token(&room, &user, "write")).await, 1);
    // Both receive the bootstrapped note.
    assert!(a.settle(|c| c.block_text() == "hello").await);
    assert!(b.settle(|c| c.block_text() == "hello").await);

    a.type_text(" world").await;
    // A hears its ACK, not its own update.
    let ack = a.until(6).await.expect("ack");
    assert!(!ack.is_empty());
    assert!(
        b.settle(|c| c.block_text() == "hello world").await,
        "{}",
        b.block_text()
    );

    // A receipt answers once the store committed.
    let request = serde_json::json!({ "id": "r1", "type": "checkpoint-request" }).to_string();
    let mut payload = Vec::new();
    varbytes(&mut payload, request.as_bytes());
    a.send(9, &payload).await;
    let receipt = loop {
        let message = text_payload(&a.until(9).await.expect("stateless"));
        if message.contains("checkpoint-persisted") {
            break message;
        }
    };
    assert!(receipt.contains("\"r1\""), "{receipt}");
    let client = db(&env).await;
    let rows: i64 = client
        .query_one(
            "SELECT count(*) FROM material_yjs_updates WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("rows")
        .get(0);
    assert!(rows >= 1);
    let _ = a.text();
}

#[tokio::test]
async fn a_reopened_room_replays_its_log_and_folds_it_once_empty() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    {
        let mut a = Client::open(server.port).await;
        a.joined(&room, &token(&room, &user, "write")).await;
        assert!(a.settle(|c| c.block_text() == "base").await);
        a.type_text(" plus").await;
        a.until(6).await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
    // The room unloads after its last channel left and folds its log.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let client = db(&env).await;
    let rows: i64 = client
        .query_one(
            "SELECT log_rows FROM material_yjs_documents WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("row")
        .get::<_, i32>(0)
        .into();
    assert_eq!(rows, 0);
    let mut c = Client::open(server.port).await;
    c.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        c.settle(|c| c.block_text() == "base plus").await,
        "{}",
        c.block_text()
    );
}

#[tokio::test]
async fn refusals_carry_the_reasons_the_editor_acts_on() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (_owner, material) = note(&env, "x").await;
    let (stranger, _) = note(&env, "y").await;
    let room = format!("material:{material}:schema:1");
    let mut client = Client::open(server.port).await;
    client.join(&room, &token(&room, &stranger, "write")).await;
    let reason = text_payload(&client.until(2).await.expect("refused"));
    assert_eq!(reason, "collaboration-forbidden");
    client.join(&room, "not-a-token").await;
    let reason = text_payload(&client.until(2).await.expect("refused"));
    assert_eq!(reason, "permission-denied");
}

#[tokio::test]
async fn a_read_only_channel_that_writes_is_closed() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "read").await;
    let room = format!("material:{material}:schema:1");
    let mut client = Client::open(server.port).await;
    assert_eq!(client.joined(&room, &token(&room, &user, "read")).await, 0);
    assert!(client.settle(|c| c.block_text() == "read").await);
    client.type_text("!").await;
    let closed = client.until(4).await.expect("closed");
    assert!(String::from_utf8_lossy(&closed).contains("read-only"));
}

#[tokio::test]
async fn an_update_that_panics_yrs_costs_neither_the_process_nor_the_room() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "kept").await;
    let room = format!("material:{material}:schema:1");
    let mut a = Client::open(server.port).await;
    a.join(&room, &token(&room, &user, "write")).await;
    // The room bootstraps the note as it loads.
    let client = db(&env).await;
    let mut held = None;
    for _ in 0..50 {
        let rows = client
            .query(
                "SELECT state FROM material_yjs_documents WHERE material_id=$1",
                &[&material],
            )
            .await
            .expect("state");
        if let Some(row) = rows.first() {
            let state: Vec<u8> = row.get(0);
            held = Some(Update::decode_v1(&state).expect("state").state_vector());
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let held = held.expect("the room bootstrapped the note");
    let (&held_client, _) = held
        .iter()
        .find(|(_, clock)| **clock > 0)
        .expect("a client the room holds");
    // One entry with no structs for a client the room holds: yrs
    // `BlockSet::exclude` unwraps its first struct (rust-notes REVIEW1 M3).
    // As the room's first update it is measured on a copy, where it panics.
    let mut crash = vec![1, 0];
    var(&mut crash, held_client.get());
    crash.extend([1, 0]);
    a.send(5, &sync(2, &crash)).await;
    let closed = a.until(4).await.expect("the sender's channel closes");
    assert!(
        String::from_utf8_lossy(&closed).contains("update cannot be checked"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
    // The room stays usable: a fresh client joins (once a discard, if the
    // panic came in the apply, has unloaded it) and its typing is acknowledged.
    let mut b = Client::open(server.port).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        b.join(&room, &token(&room, &user, "write")).await;
        let answered = b
            .settle(|c| c.inbox.iter().any(|m| m.kind == 1 || m.kind == 2))
            .await;
        assert!(answered, "no answer to the join");
        let joined = b.inbox.iter().any(|m| m.kind == 1);
        b.inbox.clear();
        if joined {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the room never reopened"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let sv = b.doc.transact().state_vector().encode_v1();
    b.send(5, &sync(0, &sv)).await;
    assert!(
        b.settle(|c| c.block_text() == "kept").await,
        "{}",
        b.block_text()
    );
    b.type_text(" still").await;
    assert!(b.until(6).await.is_some());
}

#[tokio::test]
async fn redis_comments_embeds_and_user_evictions_reach_the_room() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "c").await;
    let room = format!("material:{material}:schema:1");
    let mut client = Client::open(server.port).await;
    client.joined(&room, &token(&room, &user, "write")).await;
    client.until(6).await;
    let redis = redis::Client::open(env.redis.as_str()).expect("redis");
    let mut connection = redis
        .get_multiplexed_async_connection()
        .await
        .expect("redis connection");
    let comments = serde_json::json!({ "room": room, "threadId": "t1" }).to_string();
    let _: i64 = redis::cmd("PUBLISH")
        .arg("capy:collaboration:comments")
        .arg(&comments)
        .query_async(&mut connection)
        .await
        .expect("publish");
    let message = loop {
        let message = text_payload(&client.until(9).await.expect("stateless"));
        if message.contains("comments-invalidated") {
            break message;
        }
    };
    assert!(message.contains("t1"));
    // The API's embed-changed reaches the parent note's room as sent.
    let embed = serde_json::json!({
        "id": "m_quiz",
        "kind": "quiz",
        "materialId": material,
        "room": room,
        "type": "embed-changed",
    })
    .to_string();
    let _: i64 = redis::cmd("PUBLISH")
        .arg("capy:collaboration:embeds")
        .arg(&embed)
        .query_async(&mut connection)
        .await
        .expect("publish");
    let message = loop {
        let message = text_payload(&client.until(9).await.expect("stateless"));
        if message.contains("embed-changed") {
            break message;
        }
    };
    assert!(message.contains("m_quiz"));
    let evict = serde_json::json!({ "mode": "discard", "userId": user }).to_string();
    let _: i64 = redis::cmd("PUBLISH")
        .arg("capy:collaboration:user-evict")
        .arg(&evict)
        .query_async(&mut connection)
        .await
        .expect("publish");
    let closed = client.until(4).await.expect("closed");
    let mut at = 0;
    assert_eq!(read_var(&closed, &mut at), 4403);
}

/// POSTs an internal route with the service secret.
async fn internal(port: u16, path: &str, body: &serde_json::Value) -> (u16, serde_json::Value) {
    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}{path}"))
        .header("x-collaboration-secret", SECRET)
        .json(body)
        .send()
        .await
        .expect("internal request");
    let status = response.status().as_u16();
    (
        status,
        response.json().await.unwrap_or(serde_json::Value::Null),
    )
}

#[tokio::test]
async fn an_agent_edit_commits_its_row_reaches_the_live_room_and_replays_by_operation() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "hello world").await;
    let room = format!("material:{material}:schema:1");
    let mut client = Client::open(server.port).await;
    client.joined(&room, &token(&room, &user, "write")).await;
    assert!(client.settle(|c| c.block_text() == "hello world").await);
    // The writer types first: the edit merges the live room, not the stale row.
    client.type_text("!").await;
    client.until(6).await.expect("ack");

    let edit = serde_json::json!({
        "actorUserId": user,
        "commands": [{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "there" }],
        "operation": { "id": format!("op_{material}"), "requestHash": "h1", "toolVersion": 1 },
        "room": room,
        "target": { "id": material, "kind": "material" },
    });
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &edit).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["kind"], "edit_document");
    assert_eq!(receipt["effect"]["undo"]["status"], "available");
    assert!(
        client.settle(|c| c.block_text() == "hello there!").await,
        "{}",
        client.block_text()
    );
    // The same operation answers its receipt again without a second change.
    let (status, again) = internal(server.port, "/internal/documents/edit", &edit).await;
    assert_eq!(status, 200);
    assert_eq!(again["operationId"], receipt["operationId"]);
    let client_db = db(&env).await;
    let inverses: i64 = client_db
        .query_one(
            "SELECT count(*) FROM agent_edit_inverses WHERE resource_id=$1",
            &[&material],
        )
        .await
        .expect("inverses")
        .get(0);
    assert_eq!(inverses, 1);
    // A stale target refuses with its code.
    let stale = serde_json::json!({
        "actorUserId": user,
        "commands": [{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "x" }],
        "operation": { "id": format!("op2_{material}"), "requestHash": "h2" },
        "room": room,
        "target": { "id": material, "kind": "material" },
    });
    let (status, refusal) = internal(server.port, "/internal/documents/edit", &stale).await;
    assert_eq!(status, 409, "{refusal}");

    // replace-block replaces the block in the live room the same way; it
    // answers once the projection landed, so it needs the API.
    if env.api.is_none() {
        return;
    }
    let command = serde_json::json!({
        "actorUserId": user,
        "expectedBlock": { "type": "p", "id": "b1", "children": [{ "text": "hello there!" }] },
        "materialId": material,
        "replacementBlock": { "type": "p", "id": "b1", "children": [{ "text": "replaced" }] },
        "room": room,
        "type": "replace-block",
    });
    let (status, answer) = internal(server.port, "/internal/commands", &command).await;
    assert_eq!(status, 200, "{answer}");
    assert!(
        client.settle(|c| c.block_text() == "replaced").await,
        "{}",
        client.block_text()
    );
    // The inspect view reads the stored rows.
    let inspect = serde_json::json!({
        "actorUserId": user,
        "room": room,
        "target": { "id": material, "kind": "material" },
    });
    let (status, view) = internal(server.port, "/internal/documents/inspect", &inspect).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["blocks"][0]["text"], "replaced", "{view}");
}
