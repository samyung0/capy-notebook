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

async fn start(env: &Env) -> Server {
    start_with(env, env.api.as_deref()).await
}

/// The server with `api` as its gateway (a stand-in for source rooms).
#[allow(clippy::zombie_processes)]
async fn start_with(env: &Env, api: Option<&str>) -> Server {
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
        .env("API_URL", api.unwrap_or("http://127.0.0.1:9"))
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
    // The debug build's stand-in for an update that panics yrs: the
    // hardened fork answers REVIEW1's inputs (an empty client, a deep Any)
    // without panicking, and a 30k-mutation fuzz found no other.
    a.send(5, &sync(2, b"capy-it-panic")).await;
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
async fn a_note_room_caps_a_sync_message_at_4_mib_and_takes_a_near_2_mib_reconnect() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "cap").await;
    let room = format!("material:{material}:schema:1");
    // An offline editor's reconnect: up to 2 MiB of unsaved edits in one
    // step 2 goes in.
    let mut a = Client::open(server.port).await;
    a.joined(&room, &token(&room, &user, "write")).await;
    assert!(a.settle(|c| c.block_text() == "cap").await);
    a.type_text(&"x".repeat(1_900_000)).await;
    // A second editor receives it from the room.
    let mut b = Client::open(server.port).await;
    b.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        b.settle(|c| c.block_text().len() == 1_900_003).await,
        "{} bytes",
        b.block_text().len()
    );
    // One byte past 4 MiB is refused before it is read (y-sync step 2: its
    // type, a 4-byte length and the body).
    let body = vec![0u8; 4 * 1024 * 1024 - 4];
    let message = sync(2, &body);
    assert_eq!(message.len(), 4 * 1024 * 1024 + 1);
    b.send(5, &message).await;
    let closed = b.until(4).await.expect("the channel closes");
    assert!(
        String::from_utf8_lossy(&closed).contains("malformed update"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
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

// ------------------------------------------------------------ source rooms

/// A stand-in for the Go API's internal source routes, text files only: the
/// session, access, the base bytes and the delta-save checkpoint.
#[derive(Clone)]
struct Gateway {
    database: String,
    url: String,
    blobs: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>>,
}

async fn gateway_db(gateway: &Gateway) -> tokio_postgres::Client {
    let (client, connection) = tokio_postgres::connect(&gateway.database, tokio_postgres::NoTls)
        .await
        .expect("postgres");
    tokio::spawn(connection);
    client
}

async fn gateway_get(
    axum::extract::State(gateway): axum::extract::State<Gateway>,
    axum::extract::Path((id, endpoint)): axum::extract::Path<(String, String)>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    use base64::Engine;
    if endpoint == "access" {
        return axum::http::StatusCode::NO_CONTENT.into_response();
    }
    if endpoint != "bootstrap" {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    let row = gateway_db(&gateway)
        .await
        .query_one(
            "SELECT d.format,d.epoch,d.checkpoint,d.indexed_checkpoint,d.base_revision,d.base_source_sha256,d.state,d.state_seed_sha256,d.pending_effects,d.net_tokens,d.rebuild_pending,f.workspace_id FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.file_id=$1",
            &[&id],
        )
        .await
        .expect("source row");
    let epoch: i64 = row.get(1);
    let state: Option<Vec<u8>> = row.get(6);
    axum::Json(serde_json::json!({
        "access": "write",
        "baseRevision": row.get::<_, i64>(4),
        "baseSourceSHA256": row.get::<_, String>(5),
        "checkpoint": row.get::<_, i64>(2),
        "epoch": epoch,
        "fileId": id,
        "format": row.get::<_, String>(0),
        "indexedCheckpoint": row.get::<_, i64>(3),
        "netTokens": row.get::<_, i64>(9),
        "pendingEffects": row.get::<_, serde_json::Value>(8),
        "rebuildPending": row.get::<_, bool>(10),
        "room": format!("source:{id}:epoch:{epoch}"),
        "sourceURL": format!("{}/blob/{id}", gateway.url),
        "state": state.map(|state| base64::engine::general_purpose::STANDARD.encode(state)),
        "stateSeedSHA256": row.get::<_, Option<String>>(7),
        "workspaceId": row.get::<_, String>(11),
    }))
    .into_response()
}

/// Go's SaveSourceCheckpoint under the delta-save contract.
async fn gateway_post(
    axum::extract::State(gateway): axum::extract::State<Gateway>,
    axum::extract::Path((id, endpoint)): axum::extract::Path<(String, String)>,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    use base64::Engine;
    if endpoint != "checkpoint" {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    let mut client = gateway_db(&gateway).await;
    let txn = client.transaction().await.expect("transaction");
    let row = txn
        .query_one(
            "SELECT epoch,checkpoint FROM source_documents WHERE file_id=$1 FOR UPDATE",
            &[&id],
        )
        .await
        .expect("source row");
    let (epoch, checkpoint): (i64, i64) = (row.get(0), row.get(1));
    if checkpoint != body["expectedCheckpoint"].as_i64().unwrap_or(-1) {
        let refusal = serde_json::json!({ "errors": [{ "message": "checkpoint_moved" }] });
        return (axum::http::StatusCode::CONFLICT, axum::Json(refusal)).into_response();
    }
    let update = base64::engine::general_purpose::STANDARD
        .decode(body["update"].as_str().unwrap_or_default())
        .expect("update");
    let next = checkpoint + 1;
    txn.execute(
        "INSERT INTO source_document_updates(file_id,epoch,checkpoint,update) VALUES($1,$2,$3,$4)",
        &[&id, &epoch, &next, &update],
    )
    .await
    .expect("row");
    txn.execute(
        "UPDATE source_documents SET checkpoint=$2,pending_effects=$3,net_tokens=$4,log_bytes=log_bytes+$5,log_rows=log_rows+1,seed_bytes=COALESCE($6,seed_bytes),base_source_sha256=COALESCE($7,base_source_sha256),last_edited_at=now() WHERE file_id=$1",
        &[
            &id,
            &next,
            &body["pendingEffects"],
            &body["netTokens"].as_i64().unwrap_or(0),
            &(update.len() as i64),
            &body["seedBytes"].as_i64(),
            &body["baseSourceSHA256"].as_str(),
        ],
    )
    .await
    .expect("checkpoint");
    txn.commit().await.expect("commit");
    axum::Json(serde_json::json!({ "checkpoint": next })).into_response()
}

async fn gateway_blob(
    axum::extract::State(gateway): axum::extract::State<Gateway>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let bytes = gateway.blobs.lock().expect("blobs").get(&id).cloned();
    match bytes {
        Some(bytes) => bytes.into_response(),
        None => axum::http::StatusCode::NOT_FOUND.into_response(),
    }
}

/// The stand-in gateway, listening.
async fn gateway(env: &Env) -> Gateway {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listen");
    let gateway = Gateway {
        database: env.database.clone(),
        url: format!("http://{}", listener.local_addr().expect("address")),
        blobs: Default::default(),
    };
    let app = axum::Router::new()
        .route(
            "/internal/collaboration/files/{id}/{endpoint}",
            axum::routing::get(gateway_get).post(gateway_post),
        )
        .route("/blob/{id}", axum::routing::get(gateway_blob))
        .with_state(gateway.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
    gateway
}

/// A text file owned by a fresh user; returns (user, file id).
async fn text_file(env: &Env, gateway: &Gateway, text: &str) -> (String, String) {
    let client = db(env).await;
    let suffix = uuid_like();
    let (user, workspace, file) = (
        format!("u_it_{suffix}"),
        format!("ws_it_{suffix}"),
        format!("f_it_{suffix}"),
    );
    client
        .execute("INSERT INTO users (id, name) VALUES ($1, 'IT')", &[&user])
        .await
        .expect("user");
    client
        .execute(
            "INSERT INTO workspaces (id,user_id,name,privacy) VALUES ($1,$2,'IT','private')",
            &[&workspace, &user],
        )
        .await
        .expect("workspace");
    let sha: String = {
        use sha2::Digest;
        sha2::Sha256::digest(text.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    };
    client
        .execute(
            "INSERT INTO files (id,workspace_id,user_id,name,kind,size_bytes,status,blob_path) VALUES ($1,$2,$3,'it.md','text',$4,'ready','p/'||$1)",
            &[&file, &workspace, &user, &(text.len() as i64)],
        )
        .await
        .expect("file");
    client
        .execute(
            "INSERT INTO source_documents (file_id,user_id,format,base_revision,base_blob_path,base_source_sha256) VALUES ($1,$2,'text',1,'p/'||$1,$3)",
            &[&file, &user, &sha],
        )
        .await
        .expect("source document");
    gateway
        .blobs
        .lock()
        .expect("blobs")
        .insert(file.clone(), text.as_bytes().to_vec());
    (user, file)
}

/// Sends a checkpoint request and waits for the receipt naming it.
async fn source_receipt(client: &mut Client, id: &str) -> Option<serde_json::Value> {
    let request = serde_json::json!({ "flush": true, "id": id, "type": "checkpoint-request" });
    let mut payload = Vec::new();
    varbytes(&mut payload, request.to_string().as_bytes());
    client.send(9, &payload).await;
    loop {
        let message = text_payload(&client.until(9).await?);
        let receipt: serde_json::Value = serde_json::from_str(&message).ok()?;
        if receipt["type"] == "checkpoint-persisted"
            && receipt["checkpointIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|known| known == id))
        {
            return Some(receipt);
        }
    }
}

#[tokio::test]
async fn a_clean_source_room_answers_a_checkpoint_request_after_a_reload() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "hello").await;
    let room = format!("source:{file}:epoch:1");

    // An Edit open with no edit: the receipt names the base (checkpoint 0).
    let mut a = Client::open(server.port).await;
    assert_eq!(a.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(
        a.settle(|c| source_text(c) == "hello").await,
        "{}",
        source_text(&a)
    );
    let receipt = source_receipt(&mut a, "open").await.expect("a receipt");
    assert_eq!(receipt["checkpoint"], 0);

    // A saved edit, then the socket goes and the room unloads.
    let before = a.doc.transact().state_vector();
    {
        let text = a.doc.get_or_insert_text("source");
        let mut txn = a.doc.transact_mut();
        let end = text.len(&txn);
        text.insert(&mut txn, end, " world");
    }
    let update = a.doc.transact().encode_state_as_update_v1(&before);
    a.send(5, &sync(2, &update)).await;
    let saved = source_receipt(&mut a, "edit")
        .await
        .expect("the edit's receipt");
    assert_eq!(saved["checkpoint"], 1);
    drop(a);
    tokio::time::sleep(Duration::from_millis(1500)).await;

    // The reconnect finds nothing to store and still gets its receipt.
    let mut b = Client::open(server.port).await;
    assert_eq!(b.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(
        b.settle(|c| source_text(c) == "hello world").await,
        "{}",
        source_text(&b)
    );
    let receipt = source_receipt(&mut b, "reconnect")
        .await
        .expect("a receipt for a clean room");
    assert_eq!(receipt["checkpoint"], 1);
}

fn source_text(client: &Client) -> String {
    let root = client.doc.get_or_insert_text("source");
    let txn = client.doc.transact();
    root.get_string(&txn)
}
