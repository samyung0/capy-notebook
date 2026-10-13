//! Integration tests of note rooms against Postgres (migrated by the Go API)
//! and Redis: the server binary runs as a child process and two clients speak
//! capy-sync 1 to it. Set CAPY_IT_DATABASE_URL and CAPY_IT_REDIS_URL (the
//! docker e2e stack's); without them every test skips, unless CAPY_IT_REQUIRED
//! is set (CI), which makes a missing one (CAPY_IT_API_URL included) a failure.
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
    let found = (|| {
        Some(Env {
            database: std::env::var("CAPY_IT_DATABASE_URL").ok()?,
            redis: std::env::var("CAPY_IT_REDIS_URL").ok()?,
            api: std::env::var("CAPY_IT_API_URL").ok(),
        })
    })();
    // CI runs these against a stack: there a missing variable fails, the
    // API's too (the tests that need it would skip without it).
    assert!(
        found.as_ref().is_some_and(|env| env.api.is_some())
            || std::env::var_os("CAPY_IT_REQUIRED").is_none(),
        "CAPY_IT_REQUIRED is set but CAPY_IT_DATABASE_URL, CAPY_IT_REDIS_URL or CAPY_IT_API_URL is not"
    );
    found
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
async fn start_with(env: &Env, api: Option<&str>) -> Server {
    start_configured(env, api, &[]).await
}

/// The server with `api` as its gateway and `extra` settings.
#[allow(clippy::zombie_processes)]
async fn start_configured(env: &Env, api: Option<&str>, extra: &[(&str, &str)]) -> Server {
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
        .envs(extra.iter().copied())
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
    note_named(env, text, "m_it").await
}

/// A note whose material id starts with `prefix`.
async fn note_named(env: &Env, text: &str, prefix: &str) -> (String, String) {
    let client = db(env).await;
    let suffix = uuid_like();
    let user = format!("u_it_{suffix}");
    let material = format!("{prefix}_{suffix}");
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
    // A counter too: two tests in one clock tick (100 ns on Windows) took the
    // same user id.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let next = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{nanos:x}{next:x}")
}

fn token(room: &str, user: &str, access: &str) -> String {
    token_for(room, user, access, 300)
}

/// A token for `room` that expires `ttl` seconds from now.
fn token_for(room: &str, user: &str, access: &str, ttl: i64) -> String {
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
        "access": access, "aud": "capy-collaboration", "exp": now + ttl, "iat": now,
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
    /// Every binary frame the room sent, as received.
    received: Vec<u8>,
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
            received: Vec::new(),
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
            self.received.extend_from_slice(&bytes);
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
            self.received.extend_from_slice(&bytes);
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

    /// Inserts Slate blocks at `index` of the note, as a paste does.
    async fn insert_blocks(&mut self, index: u32, blocks: &[serde_json::Value]) {
        let before = self.doc.transact().state_vector();
        {
            let root = self.doc.get_or_insert_text("content");
            let root = yrs::branch::BranchPtr::from(root.as_ref() as &yrs::branch::Branch);
            notes::slate_yjs::insert_nodes(&mut self.doc.transact_mut(), root, index, blocks);
        }
        let update = self.doc.transact().encode_state_as_update_v1(&before);
        self.send(5, &sync(2, &update)).await;
    }

    /// The top-level block with this id, as Slate JSON.
    fn block(&self, id: &str) -> Option<serde_json::Value> {
        notes::plate::value(&self.doc.transact())
            .expect("projection")
            .into_iter()
            .find(|block| block["id"] == id)
    }

    /// The next stateless message of `kind`, and the others read before it.
    async fn stateless(&mut self, kind: &str) -> (serde_json::Value, Vec<serde_json::Value>) {
        let mut before = Vec::new();
        loop {
            let message: serde_json::Value =
                serde_json::from_str(&text_payload(&self.until(9).await.expect("stateless")))
                    .expect("json");
            if message["type"] == kind {
                return (message, before);
            }
            before.push(message);
        }
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

/// Security regression (cutover-reset REVIEW1 L1): a material without a Yjs
/// row lives at room schema 1 + trash_restores. A token naming an older room
/// (minted before a trash and restore, or before the cutover reset raised the
/// floor) is refused without seeding a row; the floor's room opens.
#[tokio::test]
async fn a_token_below_the_room_floor_seeds_no_lineage() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "floor").await;
    let client = db(&env).await;
    client
        .execute(
            "UPDATE materials SET trash_restores=1 WHERE id=$1",
            &[&material],
        )
        .await
        .expect("floor");
    let old = format!("material:{material}:schema:1");
    let mut stale = Client::open(server.port).await;
    stale.join(&old, &token(&old, &user, "write")).await;
    let reason = text_payload(&stale.until(2).await.expect("refused"));
    assert_eq!(reason, "permission-denied");
    let rows: i64 = client
        .query_one(
            "SELECT count(*) FROM material_yjs_documents WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("rows")
        .get(0);
    assert_eq!(rows, 0, "the old room seeded a row");

    let room = format!("material:{material}:schema:2");
    let mut current = Client::open(server.port).await;
    assert_eq!(
        current.joined(&room, &token(&room, &user, "write")).await,
        1
    );
    assert!(current.settle(|c| c.block_text() == "floor").await);
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

/// Security regression: a writer may not write the contributor markers the
/// server keeps in the document (who edited is the server's record).
#[tokio::test]
async fn a_writer_that_edits_the_contributor_markers_is_closed() {
    use yrs::Map;
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "marked").await;
    let room = format!("material:{material}:schema:1");
    let mut client = Client::open(server.port).await;
    client.joined(&room, &token(&room, &user, "write")).await;
    assert!(client.settle(|c| c.block_text() == "marked").await);
    let before = client.doc.transact().state_vector();
    client
        .doc
        .get_or_insert_map(ydoc::CONTRIBUTORS_ROOT)
        .insert(&mut client.doc.transact_mut(), "forged", "someone else");
    let update = client.doc.transact().encode_state_as_update_v1(&before);
    client.send(5, &sync(2, &update)).await;
    let closed = client.until(4).await.expect("closed");
    assert!(
        String::from_utf8_lossy(&closed).contains("collaboration metadata"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
}

/// Security regression (edit-incidents REVIEW2 m-A): a client whose sync
/// step 2 the room cannot place is closed after two tries, and the incident
/// is written once per user and room, however often it reconnects.
#[tokio::test]
async fn an_unplaceable_step_2_is_recorded_once_per_user_and_room() {
    use yrs::encoding::write::Write;
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "placed").await;
    let room = format!("material:{material}:schema:1");
    // One struct after a unit no one holds.
    let mut unplaceable: Vec<u8> = Vec::new();
    unplaceable.write_var(1u32);
    unplaceable.write_var(1u32);
    unplaceable.write_var(999u64);
    unplaceable.write_var(0u32);
    unplaceable.write_u8(0x80 | 4);
    unplaceable.write_var(998u64);
    unplaceable.write_var(3u32);
    unplaceable.write_string("x");
    unplaceable.write_var(0u32);
    for _ in 0..3 {
        let mut client = Client::open(server.port).await;
        client.joined(&room, &token(&room, &user, "write")).await;
        for _ in 0..2 {
            client.send(5, &sync(1, &unplaceable)).await;
        }
        let closed = client.until(4).await.expect("closed after two tries");
        assert!(
            String::from_utf8_lossy(&closed).contains("cannot be placed"),
            "{}",
            String::from_utf8_lossy(&closed)
        );
    }
    let db = db(&env).await;
    let count = || async {
        db.query_one(
            "SELECT count(*) FROM edit_incidents WHERE file_id=$1 AND kind='step2_unplaced'",
            &[&material],
        )
        .await
        .expect("incidents")
        .get::<_, i64>(0)
    };
    // The write is spawned: wait for the first, then make sure no other follows.
    for _ in 0..50 {
        if count().await > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(count().await, 1);
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
async fn a_panic_inside_a_transaction_discards_the_room_and_moves_its_lineage() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "durable").await;
    let room = format!("material:{material}:schema:1");
    let mut a = Client::open(server.port).await;
    a.joined(&room, &token(&room, &user, "write")).await;
    assert!(a.settle(|c| c.block_text() == "durable").await);
    // The debug build's panic inside an open write transaction, outside the
    // sync path: the room is discarded, not left dead in the registry.
    let request = serde_json::json!({ "type": "capy-it-panic" }).to_string();
    let mut payload = Vec::new();
    varbytes(&mut payload, request.as_bytes());
    a.send(9, &payload).await;
    let rejected = loop {
        let message = text_payload(&a.until(9).await.expect("a rejection"));
        if message.contains("document-rejected") {
            break message;
        }
    };
    assert!(rejected.contains("invalid_document"), "{rejected}");
    // Security regression (edit-incidents REVIEW2 m-B): editors hear the
    // rejection without the incident other instances read.
    assert!(!rejected.contains("incident"), "{rejected}");
    assert!(a.until(4).await.is_some(), "the channel closes");
    // The process lives on and the note opens on its next lineage.
    let next = format!("material:{material}:schema:2");
    let mut b = Client::open(server.port).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        b.join(&next, &token(&next, &user, "write")).await;
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
            "the next lineage never opened"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let sv = b.doc.transact().state_vector().encode_v1();
    b.send(5, &sync(0, &sv)).await;
    assert!(
        b.settle(|c| c.block_text() == "durable").await,
        "{}",
        b.block_text()
    );
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
async fn redis_comments_and_user_evictions_reach_the_room() {
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
    // ... and the block as it reads now, for the agent's retry.
    assert_eq!(refusal["code"], "stale_target");
    assert_eq!(
        refusal["details"],
        serde_json::json!({ "block": { "id": "b1", "text": "hello there!", "type": "p" } }),
        "{refusal}"
    );
    // An insert after a block that is gone lands at the end, and the receipt
    // says where.
    let late = serde_json::json!({
        "actorUserId": user,
        "commands": [{
            "type": "insert_block",
            "afterBlockId": "gone",
            "blocks": [{ "type": "p", "id": "b9", "children": [{ "text": "more" }] }],
        }],
        "operation": { "id": format!("op3_{material}"), "requestHash": "h3" },
        "room": room,
        "target": { "id": material, "kind": "material" },
    });
    let (status, landed) = internal(server.port, "/internal/documents/edit", &late).await;
    assert_eq!(status, 200, "{landed}");
    assert_eq!(
        landed["effect"]["relocated"],
        serde_json::json!([{ "after": "b1", "anchor": "gone", "end": true }]),
        "{landed}"
    );
    // An Undo's receipt never lists relocations, even when its inverse lands
    // an insert away from a gone anchor (a hand-written inverse here; Go
    // sends the stored one).
    let undo = serde_json::json!({
        "actorUserId": user,
        "guards": [],
        "inverse": [{
            "type": "insert_block",
            "afterBlockId": "gone_too",
            "blocks": [{ "type": "p", "id": "b10", "children": [{ "text": "back" }] }],
        }],
        "operation": { "id": format!("op4_{material}"), "requestHash": "h4" },
        "room": room,
        "target": { "id": material, "kind": "material" },
        "undoOf": format!("op3_{material}"),
    });
    let (status, undone) = internal(server.port, "/internal/documents/undo", &undo).await;
    assert_eq!(status, 200, "{undone}");
    assert_eq!(undone["effect"]["operation"], "edit_undone", "{undone}");
    assert!(undone["effect"].get("relocated").is_none(), "{undone}");

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
    // The inspect view reads the stored rows and the live room.
    let inspect = serde_json::json!({
        "actorUserId": user,
        "room": room,
        "target": { "id": material, "kind": "material" },
    });
    let (status, view) = internal(server.port, "/internal/documents/inspect", &inspect).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["blocks"][0]["text"], "replaced", "{view}");
}

/// Nothing stores while a test runs: typing stays in the live room.
const UNSAVED: [(&str, &str); 4] = [
    ("COLLABORATION_DEBOUNCE_MS", "60000"),
    ("COLLABORATION_MAX_DEBOUNCE_MS", "60000"),
    ("COLLABORATION_SOURCE_DEBOUNCE_MS", "60000"),
    ("COLLABORATION_SOURCE_MAX_DEBOUNCE_MS", "60000"),
];

/// The agent's read sees what the editors see (Epo 2026-10-13): a writer's
/// unsaved typing is in the inspect view, the live room merged into the
/// stored rows as an edit reads them. A replica holding no room (a second
/// server process) reads the stored document alone. Fails with the merge
/// removed from `inspect_material`.
#[tokio::test]
async fn an_agent_read_of_a_note_shows_unsaved_typing_and_the_stored_note_without_a_room() {
    let Some(env) = env() else { return };
    let server = start_configured(&env, env.api.as_deref(), &UNSAVED).await;
    let other = start_configured(&env, env.api.as_deref(), &UNSAVED).await;
    let (user, material) = note(&env, "hello world").await;
    let room = format!("material:{material}:schema:1");
    let mut client = Client::open(server.port).await;
    client.joined(&room, &token(&room, &user, "write")).await;
    assert!(client.settle(|c| c.block_text() == "hello world").await);
    client.type_text(" live").await;
    client.until(6).await.expect("ack");

    let inspect = serde_json::json!({
        "actorUserId": user,
        "room": room,
        "target": { "id": material, "kind": "material" },
    });
    let (status, view) = internal(server.port, "/internal/documents/inspect", &inspect).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["blocks"][0]["text"], "hello world live", "{view}");
    let (status, view) = internal(other.port, "/internal/documents/inspect", &inspect).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["blocks"][0]["text"], "hello world", "{view}");
}

/// The same for a source: the inspect view of a text source holds a
/// writer's unsaved typing; a replica with no room reads the stored text.
/// Fails with the merge removed from `Sources::inspect`.
#[tokio::test]
async fn an_agent_read_of_a_source_shows_unsaved_typing_and_the_stored_text_without_a_room() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_configured(&env, Some(&gateway.url), &UNSAVED).await;
    let other = start_configured(&env, Some(&gateway.url), &UNSAVED).await;
    let (user, file) = text_file(&env, &gateway, "hello").await;
    let room = format!("source:{file}:epoch:1");
    let mut a = Client::open(server.port).await;
    assert_eq!(a.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(a.settle(|c| source_text(c) == "hello").await);
    let before = a.doc.transact().state_vector();
    {
        let text = a.doc.get_or_insert_text("source");
        let mut txn = a.doc.transact_mut();
        let end = text.len(&txn);
        text.insert(&mut txn, end, " live");
    }
    let update = a.doc.transact().encode_state_as_update_v1(&before);
    a.send(5, &sync(2, &update)).await;
    a.until(6).await.expect("ack");

    let inspect = serde_json::json!({
        "actorUserId": user,
        "target": { "id": file, "kind": "source_file" },
    });
    let (status, view) = internal(server.port, "/internal/documents/inspect", &inspect).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["text"], "hello live", "{view}");
    let (status, view) = internal(other.port, "/internal/documents/inspect", &inspect).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["text"], "hello", "{view}");
}

// ------------------------------------------------------------ source rooms

/// A stand-in for the Go API's internal source routes, text files only: the
/// session, access, the base bytes and the delta-save checkpoint.
#[derive(Clone)]
struct Gateway {
    database: String,
    url: String,
    blobs: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>>,
    /// How long a base download takes (a slow room load).
    delay: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// Base downloads started.
    downloads: std::sync::Arc<std::sync::atomic::AtomicU64>,
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
    gateway
        .downloads
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let delay = gateway.delay.load(std::sync::atomic::Ordering::Relaxed);
    tokio::time::sleep(Duration::from_millis(delay)).await;
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
        delay: Default::default(),
        downloads: Default::default(),
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

/// Security regression (rust-core REVIEW1 N3): a writer that answered a
/// publication handoff ready is read-only until the handoff ends, and a
/// token refresh meanwhile does not give it write access back.
#[tokio::test]
async fn a_token_refresh_inside_a_handoff_keeps_the_writer_read_only() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "hello").await;
    let room = format!("source:{file}:epoch:1");
    let mut a = Client::open(server.port).await;
    assert_eq!(a.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(a.settle(|c| source_text(c) == "hello").await);
    // A publication asks the room's writers to get ready.
    let redis = redis::Client::open(env.redis.as_str()).expect("redis");
    let mut connection = redis
        .get_multiplexed_async_connection()
        .await
        .expect("redis connection");
    let prepare = serde_json::json!({
        "type": "prepare", "id": "it-handoff", "room": room, "fileId": file,
        "epoch": 1, "checkpoint": 0, "writersOnly": true,
    });
    let _: i64 = redis::cmd("PUBLISH")
        .arg(sources::handoff::SOURCE_HANDOFF_CHANNEL)
        .arg(prepare.to_string())
        .query_async(&mut connection)
        .await
        .expect("publish");
    loop {
        let payload = a.until(9).await.expect("the handoff's prepare");
        if text_payload(&payload).contains("source-handoff-prepare") {
            break;
        }
    }
    let ready = serde_json::json!({
        "type": "source-handoff-ready", "id": "it-handoff", "epoch": 1, "checkpoint": 0, "clean": true,
    });
    let mut stateless = Vec::new();
    varbytes(&mut stateless, ready.to_string().as_bytes());
    a.send(9, &stateless).await;
    // A fresh write token arrives while the handoff waits.
    let mut refresh = Vec::new();
    varbytes(&mut refresh, token(&room, &user, "write").as_bytes());
    a.send(11, &refresh).await;
    let before = a.doc.transact().state_vector();
    {
        let text = a.doc.get_or_insert_text("source");
        let mut txn = a.doc.transact_mut();
        text.insert(&mut txn, 0, "late ");
    }
    let update = a.doc.transact().encode_state_as_update_v1(&before);
    a.send(5, &sync(2, &update)).await;
    let closed = a.until(4).await.expect("the write closes the channel");
    assert!(
        String::from_utf8_lossy(&closed).contains("read-only"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
}

fn source_text(client: &Client) -> String {
    let root = client.doc.get_or_insert_text("source");
    let txn = client.doc.transact();
    root.get_string(&txn)
}

/// One message off the socket: (channel, kind, payload).
async fn next_message(
    ws: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
    pending: &mut std::collections::VecDeque<(u64, u8, Vec<u8>)>,
) -> Option<(u64, u8, Vec<u8>)> {
    loop {
        if let Some(message) = pending.pop_front() {
            return Some(message);
        }
        let Ws::Binary(bytes) = ws.next().await?.ok()? else {
            continue;
        };
        let mut at = 0;
        while at < bytes.len() {
            let channel = read_var(&bytes, &mut at);
            let kind = bytes[at];
            at += 1;
            let len = read_var(&bytes, &mut at) as usize;
            pending.push_back((channel, kind, bytes[at..at + len].to_vec()));
            at += len;
        }
    }
}

#[tokio::test]
async fn a_socket_keeps_serving_its_rooms_while_another_room_loads() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, material) = note(&env, "shared").await;
    let (owner, file) = text_file(&env, &gateway, "slow").await;
    let note_room = format!("material:{material}:schema:1");
    let source_room = format!("source:{file}:epoch:1");

    // One socket joins the note on channel 1.
    let mut request = format!("ws://127.0.0.1:{}/", server.port)
        .into_client_request()
        .expect("request");
    request
        .headers_mut()
        .insert("origin", ORIGIN.parse().expect("origin"));
    let (mut ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("connect");
    let mut pending = std::collections::VecDeque::new();
    let join = |channel: u64, room: &str, token: &str| {
        let mut payload = Vec::new();
        varbytes(&mut payload, room.as_bytes());
        varbytes(&mut payload, token.as_bytes());
        frame(channel, 0, &payload)
    };
    ws.send(Ws::Binary(
        join(1, &note_room, &token(&note_room, &user, "write")).into(),
    ))
    .await
    .expect("join");
    loop {
        let (channel, kind, _) = next_message(&mut ws, &mut pending).await.expect("joined");
        if (channel, kind) == (1, 1) {
            break;
        }
    }
    // A co-editor in the note.
    let mut b = Client::open(server.port).await;
    b.joined(&note_room, &token(&note_room, &user, "write"))
        .await;
    assert!(b.settle(|c| c.block_text() == "shared").await);
    // The same socket joins a source room whose load takes 3 s and, once
    // that load is under way, sends its cursor to the note.
    gateway
        .delay
        .store(3000, std::sync::atomic::Ordering::Relaxed);
    let downloads = || gateway.downloads.load(std::sync::atomic::Ordering::Relaxed);
    let before = downloads();
    ws.send(Ws::Binary(
        join(2, &source_room, &token(&source_room, &owner, "write")).into(),
    ))
    .await
    .expect("join");
    for _ in 0..500 {
        if downloads() > before {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(downloads() > before, "the slow load started");
    let mut cursor = Vec::new();
    var(&mut cursor, 1);
    var(&mut cursor, 42);
    var(&mut cursor, 1);
    varbytes(&mut cursor, br#"{"cursor":"a"}"#);
    ws.send(Ws::Binary(frame(1, 7, &cursor).into()))
        .await
        .expect("awareness");
    // The co-editor sees the cursor while the slow room is still loading:
    // the socket read it without waiting on the load (REVIEW1 S4), so the
    // slow room's JOINED has not been sent yet.
    assert!(b.until(7).await.is_some(), "the cursor arrives");
    while let Ok(Some((channel, kind, _))) = tokio::time::timeout(
        Duration::from_millis(500),
        next_message(&mut ws, &mut pending),
    )
    .await
    {
        assert!(
            (channel, kind) != (2, 1),
            "the slow room joined before the socket read the cursor"
        );
    }
}

#[tokio::test]
async fn oversized_frames_before_a_join_and_oversized_awareness_are_refused() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    // Before any room joined, a socket sends only JOINs: a 20 KiB frame closes it.
    let mut idle = Client::open(server.port).await;
    idle.send(8, &vec![0; 20 * 1024]).await;
    let closed = tokio::time::timeout(Duration::from_secs(5), idle.ws.next())
        .await
        .expect("the server answers");
    assert!(
        matches!(closed, None | Some(Ok(Ws::Close(_))) | Some(Err(_))),
        "{closed:?}"
    );
    // A joined channel's awareness entry over 64 KiB closes that channel.
    let (user, material) = note(&env, "aware").await;
    let room = format!("material:{material}:schema:1");
    let mut a = Client::open(server.port).await;
    a.joined(&room, &token(&room, &user, "write")).await;
    let mut update = Vec::new();
    var(&mut update, 1);
    var(&mut update, 42);
    var(&mut update, 1);
    let state = format!("{{\"cursor\":\"{}\"}}", "x".repeat(70 * 1024));
    varbytes(&mut update, state.as_bytes());
    a.send(7, &update).await;
    let closed = a.until(4).await.expect("the channel closes");
    assert!(
        String::from_utf8_lossy(&closed).contains("awareness entry too large"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
}

#[tokio::test]
async fn a_note_edited_without_a_pause_still_projects_on_the_cadence() {
    let Some(env) = env() else { return };
    if env.api.is_none() {
        return;
    }
    // The idle projection never fires here (60 s); the cadence is 2 s.
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[("COLLABORATION_PROJECTION_CADENCE_MS", "2000")],
    )
    .await;
    let (user, material) = note(&env, "start").await;
    let room = format!("material:{material}:schema:1");
    let mut a = Client::open(server.port).await;
    a.joined(&room, &token(&room, &user, "write")).await;
    assert!(a.settle(|c| c.block_text() == "start").await);
    let client = db(&env).await;
    let projected = || async {
        let content: serde_json::Value = client
            .query_one("SELECT content FROM materials WHERE id=$1", &[&material])
            .await
            .expect("content")
            .get(0);
        content.to_string()
    };
    // Typing every 300 ms for up to 8 s, never pausing.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let mut typed = 0;
    loop {
        a.type_text(&format!(" k{typed}")).await;
        typed += 1;
        tokio::time::sleep(Duration::from_millis(300)).await;
        if projected().await.contains(" k0") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no projection while edits continued: {}",
            projected().await
        );
    }
}

/// The editor's footer re-reads the note when the projection after a save
/// that changed its embeds lands, so a save's receipt must reach it before
/// the projection that covers it (as Node sent them).
#[tokio::test]
async fn a_save_receipt_reaches_the_editor_before_its_projection() {
    let Some(env) = env() else { return };
    if env.api.is_none() {
        return;
    }
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[("COLLABORATION_PROJECTION_IDLE_MS", "300")],
    )
    .await;
    let (user, material) = note(&env, "start").await;
    let room = format!("material:{material}:schema:1");
    let mut a = Client::open(server.port).await;
    a.joined(&room, &token(&room, &user, "write")).await;
    assert!(a.settle(|c| c.block_text() == "start").await);
    a.type_text(" saved").await;
    let request = serde_json::json!({ "id": "r1", "type": "checkpoint-request" }).to_string();
    let mut payload = Vec::new();
    varbytes(&mut payload, request.as_bytes());
    a.send(9, &payload).await;
    let (projection, before) = a.stateless("projection-updated").await;
    let receipt = before
        .iter()
        .find(|message| {
            message["type"] == "checkpoint-persisted"
                && message["checkpointIds"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| id == "r1"))
        })
        .unwrap_or_else(|| panic!("no receipt before {projection}: {before:?}"));
    let (saved, projected) = (
        receipt["yjsVersion"].as_i64(),
        projection["yjsVersion"].as_i64(),
    );
    assert!(
        saved
            .zip(projected)
            .is_some_and(|(saved, projected)| saved <= projected),
        "{receipt} {projection}"
    );
}

/// Security regressions: a token opens only the room it names; the server
/// asks for a fresh one before it expires and closes the channel at expiry
/// unless a valid one for the same room came back; the upgrade refuses an
/// origin outside the allowed list.
#[tokio::test]
async fn a_token_holds_only_its_room_until_it_expires_and_origins_are_checked() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "mine").await;
    let (_, other) = note(&env, "theirs").await;
    let room = format!("material:{material}:schema:1");
    let other_room = format!("material:{other}:schema:1");
    let refresh = |token: &str| {
        let mut payload = Vec::new();
        varbytes(&mut payload, token.as_bytes());
        payload
    };
    // The user may edit this room, but the token names another one.
    let mut client = Client::open(server.port).await;
    client
        .join(&room, &token(&other_room, &user, "write"))
        .await;
    let reason = text_payload(&client.until(2).await.expect("refused"));
    assert_eq!(reason, "permission-denied");
    // Two seconds from expiry the server asks for a fresh token at once; a
    // refresh naming another room does not extend the channel.
    let mut client = Client::open(server.port).await;
    client
        .joined(&room, &token_for(&room, &user, "write", 2))
        .await;
    client.until(10).await.expect("a token request");
    client
        .send(11, &refresh(&token(&other_room, &user, "write")))
        .await;
    let closed = client.until(4).await.expect("closed at expiry");
    assert!(
        String::from_utf8_lossy(&closed).contains("token expired"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
    // A fresh token for the room keeps the channel open past the expiry.
    let mut client = Client::open(server.port).await;
    client
        .joined(&room, &token_for(&room, &user, "write", 2))
        .await;
    client.until(10).await.expect("a token request");
    client
        .send(11, &refresh(&token(&room, &user, "write")))
        .await;
    assert!(
        client.until(4).await.is_none(),
        "closed after a valid refresh"
    );
    // An origin outside COLLABORATION_ALLOWED_ORIGINS gets no socket.
    let mut request = format!("ws://127.0.0.1:{}/", server.port)
        .into_client_request()
        .expect("request");
    request.headers_mut().insert(
        "origin",
        "https://elsewhere.example".parse().expect("origin"),
    );
    let refused = tokio_tungstenite::connect_async(request).await;
    assert!(
        matches!(&refused, Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == 403),
        "{refused:?}"
    );
}

/// Security regression: every internal route answers 401 without the
/// service secret or with a wrong one, before reading its body.
#[tokio::test]
async fn internal_routes_refuse_a_missing_or_wrong_service_secret() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let routes = [
        "/internal/materials/m/project",
        "/internal/source-changes/resolve",
        "/internal/source-refresh/publish",
        "/internal/documents/inspect",
        "/internal/documents/edit",
        "/internal/documents/undo",
        "/internal/commands",
        "/internal/markdown/convert",
    ];
    let client = reqwest::Client::new();
    for route in routes {
        for secret in [
            None,
            Some("not-the-secret"),
            Some(&SECRET[..SECRET.len() - 1]),
        ] {
            let mut request = client
                .post(format!("http://127.0.0.1:{}{route}", server.port))
                .json(&serde_json::json!({}));
            if let Some(secret) = secret {
                request = request.header("x-collaboration-secret", secret);
            }
            let status = request.send().await.expect("internal request").status();
            assert_eq!(status.as_u16(), 401, "{route} with {secret:?}");
        }
    }
}

/// Security regression (REVIEW5 N1: an access check that panicked failed
/// every join and store of the owner's notes). An owner over the Free limit
/// that never had Pro is full, not frozen (Go gives it no quota state): a
/// viewer joins read-only. The frozen check was
/// NULL for it and the access check panicked, so the join (and every store
/// of its notes) failed.
#[tokio::test]
async fn a_never_pro_owner_over_the_free_limit_is_full_not_frozen() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "over").await;
    let client = db(&env).await;
    client
        .execute("SELECT ensure_user_storage_row($1)", &[&user])
        .await
        .expect("storage row");
    client
        .execute(
            "UPDATE user_storage SET used_bytes=1000000000000 WHERE user_id=$1",
            &[&user],
        )
        .await
        .expect("fill");
    let room = format!("material:{material}:schema:1");
    let mut viewer = Client::open(server.port).await;
    assert_eq!(viewer.joined(&room, &token(&room, &user, "read")).await, 0);
    assert!(viewer.settle(|c| c.block_text() == "over").await);
}

/// Security regression (rust-core REVIEW1 S2): a room whose task panics
/// outside its own steps (here its first load) leaves no dead handle in the
/// registry, so the join's retry loads the room afresh and joins.
#[tokio::test]
async fn a_room_whose_load_panics_loads_afresh_on_the_next_join() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note_named(&env, "panics once", "capy-it-panic-load").await;
    let room = format!("material:{material}:schema:1");
    let mut client = Client::open(server.port).await;
    assert_eq!(client.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(client.settle(|c| c.block_text() == "panics once").await);
}

// ------------------------------------------------------------ pasted children

/// The Go API's children route behind a gate: the pass's call waits until
/// the test opens it, then goes to the real API, so a test sees the pasted
/// blocks while they are pending.
#[derive(Clone)]
struct HeldChildren {
    api: String,
    open: std::sync::Arc<tokio::sync::Semaphore>,
}

async fn held_children(
    axum::extract::State(held): axum::extract::State<HeldChildren>,
    axum::extract::Path(id): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let _open = held.open.acquire().await.expect("gate");
    let mut request = reqwest::Client::new()
        .post(format!(
            "{}/internal/collaboration/materials/{id}/children",
            held.api
        ))
        .header("content-type", "application/json")
        .body(body.to_vec());
    if let Some(secret) = headers.get("x-collaboration-secret") {
        request = request.header("x-collaboration-secret", secret.as_bytes());
    }
    let response = request.send().await.expect("api");
    let status = axum::http::StatusCode::from_u16(response.status().as_u16()).expect("status");
    (status, response.bytes().await.expect("answer")).into_response()
}

/// Listens; returns the gate's URL and the semaphore that opens it.
async fn hold_children(api: &str) -> (String, std::sync::Arc<tokio::sync::Semaphore>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listen");
    let url = format!("http://{}", listener.local_addr().expect("address"));
    let open = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
    let app = axum::Router::new()
        .route(
            "/internal/collaboration/materials/{id}/children",
            axum::routing::post(held_children),
        )
        .with_state(HeldChildren {
            api: api.to_owned(),
            open: open.clone(),
        });
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
    (url, open)
}

/// A user's charged bytes: the folded total and the deltas not folded yet.
async fn charged(client: &tokio_postgres::Client, user: &str) -> i64 {
    client
        .query_one(
            "SELECT (COALESCE((SELECT used_bytes FROM user_storage WHERE user_id=$1), 0)
                + COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas WHERE user_id=$1), 0))::bigint",
            &[&user],
        )
        .await
        .expect("charged")
        .get(0)
}

/// A ready image asset of `material`, 100 bytes, completed two minutes ago.
async fn image_asset(client: &tokio_postgres::Client, user: &str, id: &str, material: &str) {
    client
        .execute(
            "INSERT INTO editor_assets (id, material_id, user_id, created_by, name, purpose, object_path, content_type, size_bytes, status, completed_at)
             VALUES ($1, $2, $3, $3, 'fig.png', 'image', $4, 'image/png', 100, 'ready', now() - interval '2 minutes')",
            &[&id, &material, &user, &format!("it/{id}.png")],
        )
        .await
        .expect("asset");
}

fn image_block(id: &str, asset: &str) -> serde_json::Value {
    serde_json::json!({ "type": "img", "id": id, "assetId": asset, "children": [{ "text": "" }] })
}

/// Pasted children (Node `children.ts`, `server.ts` childrenPass): a block
/// pasted from another note names that note's image or flashcard set, and
/// both peers hold it so while the children pass asks the API; then the pass
/// repoints it to the note's own copy for both (a new asset row on the same
/// object and a new set under the note, charged to the note's payer). The
/// note's own trashed image (a cut whose save trashed it, then the paste or
/// an undo) keeps its id, comes out of the trash, and every editor hears
/// `children-ready` naming it. Over the payer's quota the copy is refused:
/// the block goes for both peers and only the writer hears
/// `children-refused`.
#[tokio::test]
async fn pasted_children_become_the_notes_own_for_both_peers() {
    let Some(env) = env() else { return };
    let Some(api) = env.api.clone() else { return };
    let (gate, open) = hold_children(&api).await;
    let server = start_with(&env, Some(&gate)).await;
    let (user, target) = note(&env, "target").await;
    let client = db(&env).await;
    let suffix = uuid_like();
    let source = format!("m_it_src_{suffix}");
    let content = serde_json::json!({
        "schemaVersion": 1,
        "value": [{ "type": "p", "id": "s1", "children": [{ "text": "source" }] }],
    });
    client
        .execute(
            "INSERT INTO materials (id, created_by, kind, title, content) VALUES ($1, $2, 'note', 'Source', $3)",
            &[&source, &user, &content],
        )
        .await
        .expect("source note");
    let set = format!("m_it_set_{suffix}");
    let cards = serde_json::json!({
        "schemaVersion": 1,
        "value": [{ "type": "flashcards", "id": "f1", "children": [{
            "type": "flashcard", "id": "c1", "children": [
                { "type": "flashcard_front", "children": [{ "text": "Front" }] },
                { "type": "flashcard_back", "children": [{ "text": "Back" }] },
            ],
        }] }],
    });
    client
        .execute(
            "INSERT INTO materials (id, created_by, kind, title, content, parent_material_id) VALUES ($1, $2, 'flashcards', 'Set', $3, $4)",
            &[&set, &user, &cards, &source],
        )
        .await
        .expect("source set");
    let foreign = format!("asset_it_foreign_{suffix}");
    let own = format!("asset_it_own_{suffix}");
    let over = format!("asset_it_over_{suffix}");
    image_asset(&client, &user, &foreign, &source).await;
    image_asset(&client, &user, &over, &source).await;
    image_asset(&client, &user, &own, &target).await;
    client
        .execute(
            "UPDATE editor_assets SET trashed_at=now() WHERE id=$1",
            &[&own],
        )
        .await
        .expect("trash own");
    let charged_before = charged(&client, &user).await;

    let room = format!("material:{target}:schema:1");
    let mut a = Client::open(server.port).await;
    let mut b = Client::open(server.port).await;
    a.joined(&room, &token(&room, &user, "write")).await;
    b.joined(&room, &token(&room, &user, "write")).await;
    assert!(a.settle(|c| c.block_text() == "target").await);
    assert!(b.settle(|c| c.block_text() == "target").await);
    a.insert_blocks(
        1,
        &[
            image_block("img-pasted", &foreign),
            serde_json::json!({
                "type": "material_ref", "id": "set-pasted", "materialId": set,
                "refKind": "flashcards", "children": [{ "text": "" }],
            }),
            image_block("img-own", &own),
        ],
    )
    .await;

    // Pending: the other peer holds the blocks as pasted, naming the source.
    assert!(b.settle(|c| c.block("img-own").is_some()).await);
    assert_eq!(b.block("img-pasted").unwrap()["assetId"], foreign.as_str());
    assert_eq!(b.block("set-pasted").unwrap()["materialId"], set.as_str());

    open.add_permits(1);
    let moved = |c: &Client| {
        c.block("img-pasted")
            .is_some_and(|block| block["assetId"] != foreign.as_str())
            && c.block("set-pasted")
                .is_some_and(|block| block["materialId"] != set.as_str())
    };
    assert!(a.settle(moved).await, "{:?}", a.block("img-pasted"));
    assert!(b.settle(moved).await, "{:?}", b.block("img-pasted"));
    let copy = b.block("img-pasted").unwrap()["assetId"]
        .as_str()
        .unwrap()
        .to_owned();
    let set_copy = b.block("set-pasted").unwrap()["materialId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(a.block("img-pasted").unwrap()["assetId"], copy.as_str());
    assert_eq!(b.block("img-own").unwrap()["assetId"], own.as_str());
    for peer in [&mut a, &mut b] {
        let (ready, _) = peer.stateless("children-ready").await;
        assert_eq!(ready["assetIds"], serde_json::json!([own]), "{ready}");
    }

    // The copies: the note's own rows, the image on the source's object.
    let row = client
        .query_one(
            "SELECT material_id, object_path, status, user_id FROM editor_assets WHERE id=$1",
            &[&copy],
        )
        .await
        .expect("asset copy");
    assert_eq!(row.get::<_, String>(0), target);
    assert_eq!(row.get::<_, String>(1), format!("it/{foreign}.png"));
    assert_eq!(row.get::<_, String>(2), "ready");
    assert_eq!(row.get::<_, String>(3), user);
    let row = client
        .query_one(
            "SELECT parent_material_id, kind, size_bytes FROM materials WHERE id=$1",
            &[&set_copy],
        )
        .await
        .expect("set copy");
    assert_eq!(row.get::<_, String>(0), target);
    assert_eq!(row.get::<_, String>(1), "flashcards");
    let set_bytes: i64 = row.get(2);
    let restored: bool = client
        .query_one(
            "SELECT trashed_at IS NULL FROM editor_assets WHERE id=$1",
            &[&own],
        )
        .await
        .expect("own")
        .get(0);
    assert!(restored, "the note's own image left the trash");
    assert_eq!(
        charged(&client, &user).await - charged_before,
        100 + set_bytes
    );

    // 50 bytes short of the payer's quota (under it, so the owner still
    // writes): the copy is refused and the block goes for both peers.
    let limit: i64 = client
        .query_one(
            "SELECT storage_limit_bytes FROM plan_limits WHERE plan_tier='free'",
            &[],
        )
        .await
        .expect("limit")
        .get(0);
    let fill = limit - 50 - charged(&client, &user).await;
    client
        .execute(
            "UPDATE user_storage SET used_bytes=used_bytes + $2 WHERE user_id=$1",
            &[&user, &fill],
        )
        .await
        .expect("fill");
    let held = open.clone().acquire_owned().await.expect("gate");
    a.insert_blocks(1, &[image_block("img-over", &over)]).await;
    assert!(b.settle(|c| c.block("img-over").is_some()).await);
    drop(held);
    a.stateless("children-refused").await;
    assert!(a.settle(|c| c.block("img-over").is_none()).await);
    assert!(b.settle(|c| c.block("img-over").is_none()).await);
    let (_, before) = b.stateless("children-ready").await;
    assert!(
        before
            .iter()
            .all(|message| message["type"] != "children-refused"),
        "{before:?}"
    );
}

/// Pasted children are adopted as the writer (REVIEW5 N3): a second editor
/// of a workspace note who cannot read the source note pastes its image, and
/// the pass drops the block (the owner could read the source; passing the
/// owner instead of the writer would copy it).
#[tokio::test]
async fn a_pasted_image_the_writer_cannot_read_is_dropped() {
    let Some(env) = env() else { return };
    let Some(api) = env.api.clone() else { return };
    let server = start_with(&env, Some(&api)).await;
    let client = db(&env).await;
    let suffix = uuid_like();
    let (owner, writer) = (
        format!("u_it_owner_{suffix}"),
        format!("u_it_writer_{suffix}"),
    );
    for user in [&owner, &writer] {
        client
            .execute("INSERT INTO users (id, name) VALUES ($1, 'IT')", &[user])
            .await
            .expect("user");
    }
    let workspace = format!("ws_it_{suffix}");
    client
        .execute(
            "INSERT INTO workspaces (id,user_id,name,privacy) VALUES ($1,$2,'IT','private')",
            &[&workspace, &owner],
        )
        .await
        .expect("workspace");
    client
        .execute(
            "INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor')",
            &[&workspace, &writer],
        )
        .await
        .expect("member");
    let content = serde_json::json!({
        "schemaVersion": 1,
        "value": [{ "type": "p", "id": "b1", "children": [{ "text": "target" }] }],
    });
    let (target, source) = (format!("m_it_t_{suffix}"), format!("m_it_s_{suffix}"));
    client
        .execute(
            "INSERT INTO materials (id, created_by, workspace_id, workspace_name, kind, title, content) VALUES ($1, $2, $3, 'IT', 'note', 'Target', $4)",
            &[&target, &owner, &workspace, &content],
        )
        .await
        .expect("target");
    client
        .execute(
            "INSERT INTO materials (id, created_by, kind, title, content) VALUES ($1, $2, 'note', 'Source', $3)",
            &[&source, &owner, &content],
        )
        .await
        .expect("source");
    let foreign = format!("asset_it_private_{suffix}");
    image_asset(&client, &owner, &foreign, &source).await;

    let room = format!("material:{target}:schema:1");
    let mut peer = Client::open(server.port).await;
    assert_eq!(peer.joined(&room, &token(&room, &writer, "write")).await, 1);
    assert!(peer.settle(|c| c.block_text() == "target").await);
    peer.insert_blocks(1, &[image_block("img-private", &foreign)])
        .await;
    assert!(peer.block("img-private").is_some());
    assert!(
        peer.settle(|c| c.block("img-private").is_none()).await,
        "{:?}",
        peer.block("img-private")
    );
    let copies: i64 = client
        .query_one(
            "SELECT count(*) FROM editor_assets WHERE material_id=$1",
            &[&target],
        )
        .await
        .expect("copies")
        .get(0);
    assert_eq!(copies, 0);
}

/// An awareness update: one client's entry.
fn awareness_update(client: u64, clock: u64, state: &str) -> Vec<u8> {
    let mut out = Vec::new();
    var(&mut out, 1);
    var(&mut out, client);
    var(&mut out, clock);
    varbytes(&mut out, state.as_bytes());
    out
}

// ------------------------------------------------------------- live items

/// A flashcard set owned by `owner` (live-items), embedded in `parent` when
/// given; its cards are (id, front, back).
async fn flashcard_set(
    env: &Env,
    owner: &str,
    parent: Option<&str>,
    cards: &[(&str, &str, &str)],
) -> String {
    let client = db(env).await;
    let material = format!("dk_it_{}", uuid_like());
    let children: Vec<serde_json::Value> = cards
        .iter()
        .map(|(id, front, back)| {
            items::flashcards::card_node(&items::flashcards::Card {
                id: (*id).into(),
                order: String::new(),
                front: (*front).into(),
                back: (*back).into(),
                image: None,
            })
        })
        .collect();
    let content = serde_json::json!({
        "schemaVersion": 1,
        "value": [{ "type": "flashcards", "id": "flashcards", "children": children }],
    });
    client
        .execute(
            "INSERT INTO materials (id, created_by, kind, title, content, parent_material_id)
             VALUES ($1, $2, 'flashcards', 'IT set', $3, $4)",
            &[&material, &owner, &content, &parent],
        )
        .await
        .expect("flashcard set");
    material
}

/// A fresh signed-in user with no role anywhere.
async fn user(env: &Env) -> String {
    let user = format!("u_it_{}", uuid_like());
    db(env)
        .await
        .execute("INSERT INTO users (id, name) VALUES ($1, 'IT')", &[&user])
        .await
        .expect("user");
    user
}

/// The entries of an awareness update, as (client, state).
fn awareness_entries(payload: &[u8]) -> Vec<(u64, String)> {
    let mut at = 0;
    let count = read_var(payload, &mut at);
    (0..count)
        .map(|_| {
            let client = read_var(payload, &mut at);
            let _clock = read_var(payload, &mut at);
            let len = read_var(payload, &mut at) as usize;
            let state = String::from_utf8(payload[at..at + len].to_vec()).expect("utf8");
            at += len;
            (client, state)
        })
        .collect()
}

/// Readers receive the contributor markers, so the markers name no user
/// (Epo 2026-10-12: a link-share stranger learned editors' internal ids).
/// Neither a viewer joined while a writer types nor one joined after sees the
/// user id, or its base64 (the markers' old key), in anything the room sent.
#[tokio::test]
async fn a_read_channel_receives_no_user_id() {
    use base64::Engine;
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "hello").await;
    let room = format!("material:{material}:schema:1");
    let mut viewer = Client::open(server.port).await;
    viewer.joined(&room, &token(&room, &user, "read")).await;
    let mut writer = Client::open(server.port).await;
    writer.joined(&room, &token(&room, &user, "write")).await;
    assert!(viewer.settle(|c| c.block_text() == "hello").await);
    assert!(writer.settle(|c| c.block_text() == "hello").await);
    writer.type_text(" world").await;
    assert!(viewer.settle(|c| c.block_text() == "hello world").await);
    let mut late = Client::open(server.port).await;
    late.joined(&room, &token(&room, &user, "read")).await;
    assert!(late.settle(|c| c.block_text() == "hello world").await);
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&user);
    for (name, client) in [("viewer", &viewer), ("late viewer", &late)] {
        for needle in [user.as_str(), encoded.as_str()] {
            assert!(
                !client
                    .received
                    .windows(needle.len())
                    .any(|window| window == needle.as_bytes()),
                "{name} received {needle}"
            );
        }
    }
}

/// Security regression (REVIEW5 E2, R1, R1b): a read-only channel cannot show
/// blocks as uploading to editors. Its presence reaches the room without an
/// `uploads` list, the rest of it (a cursor) intact, even under an escaped
/// key (`upl\u006fads`, which a peer's JSON.parse reads as `uploads`); an
/// entry serde_json refuses but JSON.parse takes (an unpaired surrogate
/// escape) never reaches peers as sent (R1b); a writer's list goes through.
#[tokio::test]
async fn a_read_only_channel_names_no_uploads_in_presence() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "presence").await;
    let room = format!("material:{material}:schema:1");
    let mut writer = Client::open(server.port).await;
    let mut viewer = Client::open(server.port).await;
    let mut observer = Client::open(server.port).await;
    writer.joined(&room, &token(&room, &user, "write")).await;
    viewer.joined(&room, &token(&room, &user, "read")).await;
    observer.joined(&room, &token(&room, &user, "write")).await;
    let state = r#"{"cursor":{"anchor":1},"uploads":["block-a"]}"#;
    viewer.send(7, &awareness_update(9001, 1, state)).await;
    let escaped = r#"{"cursor":null,"upl\u006fads":["block-b"]}"#;
    viewer.send(7, &awareness_update(9003, 1, escaped)).await;
    // serde_json refuses an unpaired surrogate escape; JSON.parse takes it
    // and would read the list (REVIEW5 R1b). Client 9005, sent after it on
    // the same channel, marks that the room has handled it.
    let unparsed = r#"{"cursor":null,"uploads":["block-c"],"x":"\ud800"}"#;
    viewer.send(7, &awareness_update(9004, 1, unparsed)).await;
    viewer.send(7, &awareness_update(9005, 1, "{}")).await;
    writer.send(7, &awareness_update(9002, 1, state)).await;
    let (mut from_viewer, mut from_writer, mut escaped_key) = (None, None, None);
    let (mut unparsed_seen, mut marked) = (Vec::new(), false);
    while from_viewer.is_none() || from_writer.is_none() || escaped_key.is_none() || !marked {
        let payload = observer.until(7).await.expect("awareness");
        for (client, state) in awareness_entries(&payload) {
            if client == 9004 {
                unparsed_seen.push(state);
                continue;
            }
            let state: serde_json::Value = serde_json::from_str(&state).expect("json");
            match client {
                9001 => from_viewer = Some(state),
                9002 => from_writer = Some(state),
                9003 => escaped_key = Some(state),
                9005 => marked = true,
                _ => {}
            }
        }
    }
    assert!(
        unparsed_seen.iter().all(|state| state == "null"),
        "{unparsed_seen:?}"
    );
    let from_viewer = from_viewer.unwrap();
    assert!(from_viewer.get("uploads").is_none(), "{from_viewer}");
    assert_eq!(from_viewer["cursor"]["anchor"], 1);
    assert_eq!(from_writer.unwrap()["uploads"][0], "block-a");
    let escaped_key = escaped_key.unwrap();
    assert!(escaped_key.get("uploads").is_none(), "{escaped_key}");
}

impl Client {
    fn cards(&self) -> Vec<(String, String)> {
        items::flashcards::cards(&self.doc.transact())
            .into_iter()
            .map(|card| (card.id, card.front))
            .collect()
    }

    /// Runs `edit` on the client's document and sends what it wrote.
    async fn write(&mut self, edit: impl FnOnce(&Doc)) {
        let before = self.doc.transact().state_vector();
        edit(&self.doc);
        let update = self.doc.transact().encode_state_as_update_v1(&before);
        self.send(5, &sync(2, &update)).await;
    }

    /// Whether a message of `kind` arrives within `ms` (syncs apply).
    async fn hears(&mut self, kind: u8, ms: u64) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
        loop {
            if self.inbox.iter().any(|m| m.kind == kind) {
                return true;
            }
            let Ok(Some(Ok(Ws::Binary(bytes)))) =
                tokio::time::timeout_at(deadline, self.ws.next()).await
            else {
                return false;
            };
            let mut at = 0;
            while at < bytes.len() {
                let _channel = read_var(&bytes, &mut at);
                let message_kind = bytes[at];
                at += 1;
                let len = read_var(&bytes, &mut at) as usize;
                let payload = bytes[at..at + len].to_vec();
                at += len;
                if message_kind == 5 {
                    self.on_sync(&payload).await;
                } else {
                    self.inbox.push(Msg {
                        kind: message_kind,
                        payload,
                    });
                }
            }
        }
    }
}

fn card_face(doc: &Doc, id: &str, face: &str) -> Option<yrs::TextRef> {
    use yrs::Map;
    let root = doc.get_or_insert_map(items::flashcards::ROOT);
    let txn = doc.transact();
    match root.get(&txn, id)? {
        yrs::Out::YMap(card) => match card.get(&txn, face)? {
            yrs::Out::YText(text) => Some(text),
            _ => None,
        },
        _ => None,
    }
}

fn add_card(doc: &Doc, id: &str, order: &str, front: &str) {
    use yrs::{Map, MapPrelim, TextPrelim};
    let root = doc.get_or_insert_map(items::flashcards::ROOT);
    let mut txn = doc.transact_mut();
    root.insert(
        &mut txn,
        id,
        MapPrelim::from([
            ("order", yrs::In::from(order)),
            ("front", yrs::In::from(TextPrelim::new(front))),
            ("back", yrs::In::from(TextPrelim::new(""))),
        ]),
    );
}

#[tokio::test]
async fn two_writers_converge_in_a_flashcard_set_and_it_stores() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let set = flashcard_set(&env, &owner, None, &[("c1", "Cell", "unit of life")]).await;
    let room = format!("material:{set}:schema:1");
    let mut a = Client::open(server.port).await;
    let mut b = Client::open(server.port).await;
    assert_eq!(a.joined(&room, &token(&room, &owner, "write")).await, 1);
    assert_eq!(b.joined(&room, &token(&room, &owner, "write")).await, 1);
    let seeded = vec![("c1".to_owned(), "Cell".to_owned())];
    assert!(a.settle(|c| c.cards() == seeded).await, "{:?}", a.cards());
    assert!(b.settle(|c| c.cards() == seeded).await, "{:?}", b.cards());

    a.write(|doc| {
        let face = card_face(doc, "c1", "front").expect("front");
        yrs::Text::insert(&face, &mut doc.transact_mut(), 4, " wall");
    })
    .await;
    b.write(|doc| add_card(doc, "c2", "a1", "Nucleus")).await;
    assert!(a.until(6).await.is_some(), "the first writer's ack");
    assert!(b.until(6).await.is_some(), "the second writer's ack");
    let both = vec![
        ("c1".to_owned(), "Cell wall".to_owned()),
        ("c2".to_owned(), "Nucleus".to_owned()),
    ];
    assert!(a.settle(|c| c.cards() == both).await, "{:?}", a.cards());
    assert!(b.settle(|c| c.cards() == both).await, "{:?}", b.cards());
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let rows: i64 = db(&env)
        .await
        .query_one(
            "SELECT count(*) FROM material_yjs_updates WHERE material_id=$1",
            &[&set],
        )
        .await
        .expect("rows")
        .get(0);
    assert!(rows >= 1);
    // The room unloads after its last channel and folds the set's log (the
    // fold checks the set's roots, not a note's).
    drop((a, b));
    tokio::time::sleep(Duration::from_millis(3000)).await;
    let log_rows: i32 = db(&env)
        .await
        .query_one(
            "SELECT log_rows FROM material_yjs_documents WHERE material_id=$1",
            &[&set],
        )
        .await
        .expect("row")
        .get(0);
    assert_eq!(log_rows, 0);
}

#[tokio::test]
async fn a_flashcard_set_closes_a_writer_that_writes_another_shape() {
    use yrs::{Map, Text};
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let set = flashcard_set(&env, &owner, None, &[("c1", "Cell", "")]).await;
    let room = format!("material:{set}:schema:1");
    // A note's content root in a set.
    let mut a = Client::open(server.port).await;
    a.joined(&room, &token(&room, &owner, "write")).await;
    assert!(a.settle(|c| c.cards().len() == 1).await);
    a.write(|doc| {
        let content = doc.get_or_insert_text("content");
        content.insert(&mut doc.transact_mut(), 0, "note text");
    })
    .await;
    let closed = String::from_utf8_lossy(&a.until(4).await.expect("closed")).into_owned();
    assert!(closed.contains("flashcard set cannot hold"), "{closed}");
    // A key no card has.
    let mut b = Client::open(server.port).await;
    b.joined(&room, &token(&room, &owner, "write")).await;
    assert!(b.settle(|c| c.cards().len() == 1).await);
    b.write(|doc| {
        let root = doc.get_or_insert_map(items::flashcards::ROOT);
        let mut txn = doc.transact_mut();
        if let Some(yrs::Out::YMap(card)) = root.get(&txn, "c1") {
            card.insert(&mut txn, "answer", "leaked");
        }
    })
    .await;
    let closed = String::from_utf8_lossy(&b.until(4).await.expect("closed")).into_owned();
    assert!(closed.contains("flashcard set cannot hold"), "{closed}");
}

/// Security regression (live-items, Epo 2026-10-10): a signed-in viewer of
/// a note reads its embedded set on a read channel and nothing more: no
/// write token, no writes, no set of a note it cannot see, and no presence
/// (it neither hears editors' awareness nor reaches them with its own).
#[tokio::test]
async fn a_viewer_reads_a_notes_set_without_writes_or_presence() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, note) = note(&env, "shared").await;
    db(&env)
        .await
        .execute("UPDATE materials SET privacy='link' WHERE id=$1", &[&note])
        .await
        .expect("link share");
    let set = flashcard_set(&env, &owner, Some(&note), &[("c1", "Cell", "")]).await;
    let viewer = user(&env).await;
    let set_room = format!("material:{set}:schema:1");

    let mut refused = Client::open(server.port).await;
    refused
        .join(&set_room, &token(&set_room, &viewer, "write"))
        .await;
    let reason = text_payload(&refused.until(2).await.expect("refused"));
    assert_eq!(reason, "collaboration-read-only");

    let mut reader = Client::open(server.port).await;
    assert_eq!(
        reader
            .joined(&set_room, &token(&set_room, &viewer, "read"))
            .await,
        0
    );
    assert!(reader.settle(|c| c.cards().len() == 1).await);
    reader
        .write(|doc| add_card(doc, "c9", "a5", "forged"))
        .await;
    let closed = String::from_utf8_lossy(&reader.until(4).await.expect("closed")).into_owned();
    assert!(closed.contains("read-only"), "{closed}");

    // A private note's set stays out of reach.
    let (other_owner, private_note) = note_named(&env, "private", "m_it_private").await;
    let private_set =
        flashcard_set(&env, &other_owner, Some(&private_note), &[("c1", "x", "")]).await;
    let private_room = format!("material:{private_set}:schema:1");
    let mut stranger = Client::open(server.port).await;
    stranger
        .join(&private_room, &token(&private_room, &viewer, "read"))
        .await;
    let reason = text_payload(&stranger.until(2).await.expect("refused"));
    assert_eq!(reason, "collaboration-forbidden");

    // Presence: the owner's cursor never reaches the viewer, nor the viewer's
    // the owner.
    let note_room = format!("material:{note}:schema:1");
    let mut editor = Client::open(server.port).await;
    editor
        .joined(&note_room, &token(&note_room, &owner, "write"))
        .await;
    editor
        .send(7, &awareness_update(41, 1, r#"{"user":"owner"}"#))
        .await;
    let mut watcher = Client::open(server.port).await;
    assert_eq!(
        watcher
            .joined(&note_room, &token(&note_room, &viewer, "read"))
            .await,
        0
    );
    assert!(watcher.settle(|c| c.block_text() == "shared").await);
    editor
        .send(7, &awareness_update(41, 2, r#"{"user":"owner2"}"#))
        .await;
    watcher
        .send(7, &awareness_update(42, 1, r#"{"user":"viewer"}"#))
        .await;
    watcher.send(8, &[]).await;
    assert!(!watcher.hears(7, 1500).await, "a viewer heard awareness");
    assert!(!editor.hears(7, 500).await, "an editor heard a viewer");
}

/// A quiz owned by `owner` (live-items) with an mcq and an ordering
/// question; `privacy` link lets any signed-in user read it.
async fn quiz_material(env: &Env, owner: &str, privacy: &str) -> String {
    let material = format!("qz_it_{}", uuid_like());
    let question = |id: &str, answer: serde_json::Value| {
        serde_json::json!({
            "type": "quiz_question",
            "id": id,
            "children": [{ "text": "" }],
            "question": {
                "id": id, "layout": "paper", "labels": "letters", "stem": [],
                "parts": [{
                    "id": format!("{id}-p"),
                    "blocks": [{ "type": "text", "text": "Put these in sequence." }],
                    "answer": answer, "marks": 1, "solution": [],
                }],
            },
        })
    };
    let content = serde_json::json!({
        "schemaVersion": 1,
        "value": [{ "type": "quiz", "id": "quiz", "children": [
            question("q1", serde_json::json!({ "type": "mcq", "options": ["Nucleus", "Ribosome"], "correct": [0] })),
            question("q2", serde_json::json!({ "type": "ordering", "items": ["one", "two"] })),
        ] }],
    });
    db(env)
        .await
        .execute(
            "INSERT INTO materials (id, created_by, kind, title, content, privacy)
             VALUES ($1, $2, 'quiz', 'IT quiz', $3, $4)",
            &[&material, &owner, &content, &privacy],
        )
        .await
        .expect("quiz");
    material
}

fn map_at(doc: &Doc, path: &[&str]) -> Option<yrs::MapRef> {
    use yrs::Map;
    let (root, rest) = path.split_first()?;
    let txn = doc.transact();
    let mut map = txn.get_map(*root)?;
    for key in rest {
        map = match map.get(&txn, key)? {
            yrs::Out::YMap(next) => next,
            _ => return None,
        };
    }
    Some(map)
}

#[tokio::test]
async fn two_editors_converge_across_a_quizs_content_and_keys() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let quiz = quiz_material(&env, &owner, "private").await;
    let content_room = format!("material:{quiz}:schema:1");
    let keys_room = format!("keys:{quiz}:schema:1");
    let mut a = Client::open(server.port).await;
    let mut keys = Client::open(server.port).await;
    assert_eq!(
        a.joined(&content_room, &token(&content_room, &owner, "write"))
            .await,
        1
    );
    assert_eq!(
        keys.joined(&keys_room, &token(&keys_room, &owner, "write"))
            .await,
        1
    );
    assert!(
        a.settle(|c| map_at(
            &c.doc,
            &["questions", "q1", "parts", "q1-p", "answer", "options"]
        )
        .is_some())
            .await
    );
    assert!(
        keys.settle(|c| map_at(&c.doc, &["keys", "q1-p"]).is_some())
            .await
    );
    // A types into the first option; the keys editor makes the second correct.
    a.write(|doc| {
        use yrs::Map;
        let option = map_at(
            doc,
            &[
                "questions",
                "q1",
                "parts",
                "q1-p",
                "answer",
                "options",
                "o0",
            ],
        )
        .expect("option");
        let Some(yrs::Out::YText(text)) = option.get(&doc.transact(), "text") else {
            panic!("text")
        };
        text.insert(&mut doc.transact_mut(), 7, " envelope");
    })
    .await;
    keys.write(|doc| {
        use yrs::Map;
        let key = map_at(doc, &["keys", "q1-p"]).expect("key");
        key.insert(&mut doc.transact_mut(), "correct", "o1");
    })
    .await;
    assert!(a.until(6).await.is_some(), "content ack");
    assert!(keys.until(6).await.is_some(), "keys ack");
    // Both documents store against the one material version, and the on-demand
    // projection holds both edits.
    let (status, body) = internal(
        server.port,
        &format!("/internal/materials/{quiz}/project"),
        &serde_json::json!({}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let stored: serde_json::Value = db(&env)
        .await
        .query_one("SELECT content FROM materials WHERE id=$1", &[&quiz])
        .await
        .expect("content")
        .get(0);
    let q1 = &stored["value"][0]["children"][0]["question"]["parts"][0]["answer"];
    assert_eq!(q1["options"][0], "Nucleus envelope", "{stored}");
    assert_eq!(q1["correct"], serde_json::json!([1]), "{stored}");
    let key_rows: i64 = db(&env)
        .await
        .query_one(
            "SELECT count(*) FROM material_yjs_key_updates WHERE material_id=$1",
            &[&quiz],
        )
        .await
        .expect("rows")
        .get(0);
    assert!(key_rows >= 1);
}

/// The `quiz-items` messages a channel heard so far (taken from its inbox),
/// as JSON, in order.
fn quiz_items(client: &mut Client) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    client.inbox.retain(|message| {
        if message.kind != 9 {
            return true;
        }
        let text = text_payload(&message.payload);
        match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) if value["type"] == "quiz-items" => {
                out.push(value);
                false
            }
            _ => true,
        }
    });
    out
}

/// A part's list after `messages` (a full one replaces, a partial one
/// changes the parts it names).
fn list_after(messages: &[serde_json::Value], part: &str) -> Option<Vec<String>> {
    let mut list: Option<Vec<String>> = None;
    for message in messages {
        if message["full"] == true {
            list = None;
        }
        match message["parts"].get(part) {
            Some(serde_json::Value::Null) => list = None,
            Some(value) => {
                list = Some(serde_json::from_value(value["items"].clone()).expect("items"));
            }
            None => {}
        }
    }
    list
}

/// Reads until the channel's lists for `part` hold `want` items.
async fn hear_list(
    client: &mut Client,
    heard: &mut Vec<serde_json::Value>,
    part: &str,
    want: usize,
) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        heard.extend(quiz_items(client));
        if let Some(list) = list_after(heard, part)
            && list.len() == want
        {
            return list;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no list of {want} for {part}: {heard:?}"
        );
        client.hears(9, 200).await;
    }
}

/// Security regression (live-items D1, D3 as revised by Epo 2026-10-10):
/// answer keys and typing order never reach a reader. A viewer is refused the
/// keys room with any token. Ordering items reach readers only as plain lists
/// the content room pushes, outside Yjs: while an editor types eight items
/// one by one in answer order, each list a reader hears is a fresh shuffle
/// of the items so far, never the last list with the new item appended; a
/// reader who joins afterwards hears one list, not in typing order; and no
/// reader's Yjs state holds an item or a key field. Fails if the copy goes
/// back into the content document, or the lists follow the keys' order.
#[tokio::test]
async fn neither_keys_nor_typing_order_reach_a_reader() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let viewer = user(&env).await;
    let quiz = quiz_material(&env, &owner, "link").await;
    let content_room = format!("material:{quiz}:schema:1");
    let keys_room = format!("keys:{quiz}:schema:1");
    for access in ["read", "write"] {
        let mut refused = Client::open(server.port).await;
        refused
            .join(&keys_room, &token(&keys_room, &viewer, access))
            .await;
        let reason = text_payload(&refused.until(2).await.expect("refused"));
        assert_eq!(reason, "collaboration-read-only", "{access}");
    }
    // An editor's read token for the keys room is refused too.
    let mut narrowed = Client::open(server.port).await;
    narrowed
        .join(&keys_room, &token(&keys_room, &owner, "read"))
        .await;
    assert_eq!(
        text_payload(&narrowed.until(2).await.expect("refused")),
        "collaboration-read-only"
    );

    // A reader joining before any editor hears the stored items' list.
    let mut reader = Client::open(server.port).await;
    assert_eq!(
        reader
            .joined(&content_room, &token(&content_room, &viewer, "read"))
            .await,
        0
    );
    let mut heard = Vec::new();
    let first = hear_list(&mut reader, &mut heard, "q2-p", 2).await;
    let mut sorted = first.clone();
    sorted.sort();
    assert_eq!(sorted, ["one", "two"]);

    let mut keys = Client::open(server.port).await;
    keys.joined(&keys_room, &token(&keys_room, &owner, "write"))
        .await;
    assert!(
        keys.settle(|c| map_at(&c.doc, &["keys", "q2-p", "items"]).is_some())
            .await
    );
    // The editor clears the items, then types eight in answer order.
    keys.write(|doc| {
        use yrs::Map;
        let items = map_at(doc, &["keys", "q2-p", "items"]).expect("items");
        let held: Vec<String> = items.keys(&doc.transact()).map(str::to_owned).collect();
        for id in held {
            items.remove(&mut doc.transact_mut(), &id);
        }
    })
    .await;
    assert!(keys.until(6).await.is_some(), "keys ack");
    let typed: Vec<String> = (1..=8).map(|n| format!("step {n}")).collect();
    let mut order: Option<String> = None;
    let mut lists: Vec<Vec<String>> = Vec::new();
    for (n, text) in typed.iter().enumerate() {
        let next = items::order::after(order.as_deref());
        let next_key = next.clone();
        let text = text.clone();
        keys.write(move |doc| {
            use yrs::{Map, MapPrelim, TextPrelim};
            let items = map_at(doc, &["keys", "q2-p", "items"]).expect("items");
            let entry = items.insert(
                &mut doc.transact_mut(),
                format!("t{n}"),
                MapPrelim::default(),
            );
            entry.insert(&mut doc.transact_mut(), "order", next_key.as_str());
            entry.insert(
                &mut doc.transact_mut(),
                "text",
                TextPrelim::new(text.as_str()),
            );
        })
        .await;
        order = Some(next);
        assert!(keys.until(6).await.is_some(), "keys ack {n}");
        lists.push(hear_list(&mut reader, &mut heard, "q2-p", n + 1).await);
    }
    for (n, list) in lists.iter().enumerate() {
        let mut sorted = list.clone();
        sorted.sort();
        let mut want = typed[..=n].to_vec();
        want.sort();
        assert_eq!(sorted, want, "list {n} holds the items so far once");
    }
    let appended = lists
        .windows(2)
        .filter(|pair| pair[1][..pair[0].len()] == pair[0][..])
        .count();
    assert!(appended < 6, "the lists grew by appending: {lists:?}");
    assert_ne!(
        lists.last().expect("lists"),
        &typed,
        "the list follows the typing order"
    );

    // A reader arriving afterwards hears one list, not in typing order.
    let mut late = Client::open(server.port).await;
    late.joined(&content_room, &token(&content_room, &viewer, "read"))
        .await;
    let mut late_heard = Vec::new();
    let late_list = hear_list(&mut late, &mut late_heard, "q2-p", 8).await;
    assert_eq!(late_heard.len(), 1, "a late reader hears one full list");
    assert_ne!(late_list, typed, "the late list follows the typing order");

    // Nothing of the keys document is in any reader's Yjs state.
    for client in [&reader, &late] {
        let state = client
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let held = String::from_utf8_lossy(&state);
        for secret in typed.iter().map(String::as_str).chain([
            "correct",
            "accepted",
            "markscheme",
            "solution",
            "pairs",
            "slot",
            "items",
            "keys",
            "copy",
        ]) {
            assert!(!held.contains(secret), "a reader holds {secret}");
        }
    }
}

/// Security regression (live-items D1, REVIEW1 S5): a keys room refuses a
/// read token at a refresh too, so a demoted editor's channel closes at its
/// write token's expiry instead of reading on (fails if the refresh check
/// goes: the read token re-arms the channel).
#[tokio::test]
async fn a_keys_room_refuses_a_read_token_at_refresh() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let quiz = quiz_material(&env, &owner, "private").await;
    let keys_room = format!("keys:{quiz}:schema:1");
    let mut keys = Client::open(server.port).await;
    assert_eq!(
        keys.joined(&keys_room, &token_for(&keys_room, &owner, "write", 3))
            .await,
        1
    );
    // The short token asks for a refresh at once; a read token answers.
    assert!(keys.until(10).await.is_some(), "a token request");
    let mut refresh = Vec::new();
    varbytes(&mut refresh, token(&keys_room, &owner, "read").as_bytes());
    keys.send(11, &refresh).await;
    let closed = keys.until(4).await.expect("the channel closes at expiry");
    assert!(
        String::from_utf8_lossy(&closed).contains("expired"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
}

// ------------------------------------------------------------ live Mermaid

/// A standalone diagram (one `mermaid` block) owned by a fresh user; returns
/// (user, material).
async fn diagram(env: &Env, source: &str) -> (String, String) {
    let owner = user(env).await;
    let material = format!("dg_it_{}", uuid_like());
    let content = serde_json::json!({
        "schemaVersion": 1,
        "value": [{
            "children": [{ "children": [{ "text": "" }], "type": "mermaid_caption" }],
            "id": "d1",
            "source": source,
            "type": "mermaid",
        }],
    });
    db(env)
        .await
        .execute(
            "INSERT INTO materials (id, created_by, kind, title, content) VALUES ($1, $2, 'diagram', 'IT diagram', $3)",
            &[&material, &owner, &content],
        )
        .await
        .expect("diagram");
    (owner, material)
}

/// The source text of the client's Mermaid block (shape A).
fn mermaid_source(doc: &Doc) -> Option<yrs::TextRef> {
    use yrs::Xml;
    let root = doc.get_or_insert_text("content");
    let txn = doc.transact();
    root.diff(&txn, yrs::types::text::YChange::identity)
        .into_iter()
        .find_map(|chunk| match chunk.insert {
            yrs::Out::YXmlText(block) => match block.get_attribute(&txn, "source") {
                Some(yrs::Out::YText(text)) => Some(text),
                _ => None,
            },
            _ => None,
        })
}

impl Client {
    fn source(&self) -> String {
        mermaid_source(&self.doc)
            .map(|text| text.get_string(&self.doc.transact()))
            .unwrap_or_default()
    }

    /// What typing `text` at `index` of the source sends, made now against
    /// the client's document but not sent yet.
    fn type_source(&mut self, index: u32, text: &str) -> Vec<u8> {
        let before = self.doc.transact().state_vector();
        let source = mermaid_source(&self.doc).expect("a source text");
        source.insert(&mut self.doc.transact_mut(), index, text);
        self.doc.transact().encode_state_as_update_v1(&before)
    }
}

/// Two writers typing into one Mermaid source at once both keep their
/// characters (shape A merges per character), and an agent's `set_mermaid`
/// (`set_property` of `source`) during typing is a text diff, so a writer's
/// keystroke made before it and sent after it stays too.
#[tokio::test]
async fn two_writers_type_in_one_mermaid_source_and_an_agent_edit_keeps_both() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, material) = diagram(&env, "graph TD\n  A --> B").await;
    let room = format!("material:{material}:schema:1");
    let mut a = Client::open(server.port).await;
    let mut b = Client::open(server.port).await;
    assert_eq!(a.joined(&room, &token(&room, &owner, "write")).await, 1);
    assert_eq!(b.joined(&room, &token(&room, &owner, "write")).await, 1);
    assert!(a.settle(|c| c.source() == "graph TD\n  A --> B").await);
    assert!(b.settle(|c| c.source() == "graph TD\n  A --> B").await);

    // Both type before hearing the other.
    let from_a = a.type_source(18, " --> C");
    let from_b = b.type_source(0, "%% b\n");
    a.send(5, &sync(2, &from_a)).await;
    b.send(5, &sync(2, &from_b)).await;
    let merged = "%% b\ngraph TD\n  A --> B --> C";
    assert!(a.settle(|c| c.source() == merged).await, "{}", a.source());
    assert!(b.settle(|c| c.source() == merged).await, "{}", b.source());

    // A types; before it sends, an agent rewrites the head of the source.
    let from_a = a.type_source(merged.len() as u32, " --> D");
    let edit = serde_json::json!({
        "actorUserId": owner,
        "commands": [{
            "type": "set_property",
            "nodeType": "mermaid",
            "property": "source",
            "expectedValue": merged,
            "value": "%% b\nflowchart TD\n  A --> B --> C",
        }],
        "operation": { "id": format!("op_{material}"), "requestHash": "h1", "toolVersion": 1 },
        "room": room,
        "target": { "id": material, "kind": "material" },
    });
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &edit).await;
    assert_eq!(status, 200, "{receipt}");
    a.send(5, &sync(2, &from_a)).await;
    let both = "%% b\nflowchart TD\n  A --> B --> C --> D";
    assert!(a.settle(|c| c.source() == both).await, "{}", a.source());
    assert!(b.settle(|c| c.source() == both).await, "{}", b.source());
}

// ---------------------------------------------------------- live note View

/// Security regression (live note View, Epo 2026-10-10): a signed-in viewer
/// watches a note live on a read channel. An editor's typing reaches it, its
/// write token is refused, and a write on its read channel closes the
/// channel and reaches neither the editor nor the stored rows. Fails with the
/// read-only check of `room.rs` removed.
#[tokio::test]
async fn a_viewer_watches_a_note_live_and_its_writes_never_land() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, note) = note(&env, "watched").await;
    db(&env)
        .await
        .execute("UPDATE materials SET privacy='link' WHERE id=$1", &[&note])
        .await
        .expect("link share");
    let viewer = user(&env).await;
    let room = format!("material:{note}:schema:1");

    let mut refused = Client::open(server.port).await;
    refused.join(&room, &token(&room, &viewer, "write")).await;
    let reason = text_payload(&refused.until(2).await.expect("refused"));
    assert_eq!(reason, "collaboration-read-only");

    let mut editor = Client::open(server.port).await;
    assert_eq!(
        editor.joined(&room, &token(&room, &owner, "write")).await,
        1
    );
    let mut watcher = Client::open(server.port).await;
    assert_eq!(
        watcher.joined(&room, &token(&room, &viewer, "read")).await,
        0
    );
    assert!(editor.settle(|c| c.block_text() == "watched").await);
    assert!(watcher.settle(|c| c.block_text() == "watched").await);
    editor.type_text(" live").await;
    assert!(
        watcher.settle(|c| c.block_text() == "watched live").await,
        "{}",
        watcher.block_text()
    );

    watcher.type_text(" forged").await;
    let closed = String::from_utf8_lossy(&watcher.until(4).await.expect("closed")).into_owned();
    assert!(closed.contains("read-only"), "{closed}");
    editor.type_text("!").await;
    assert!(
        editor.settle(|c| c.block_text() == "watched live!").await,
        "{}",
        editor.block_text()
    );
    // The editor's receipt answers once the store committed: no stored row
    // holds the viewer's write.
    let request = serde_json::json!({ "id": "r1", "type": "checkpoint-request" }).to_string();
    let mut payload = Vec::new();
    varbytes(&mut payload, request.as_bytes());
    editor.send(9, &payload).await;
    loop {
        let message = text_payload(&editor.until(9).await.expect("stateless"));
        if message.contains("checkpoint-persisted") {
            break;
        }
    }
    let client = db(&env).await;
    let mut stored = Vec::new();
    for sql in [
        "SELECT state AS bytes FROM material_yjs_documents WHERE material_id=$1",
        "SELECT update AS bytes FROM material_yjs_updates WHERE material_id=$1",
    ] {
        for row in client.query(sql, &[&note]).await.expect("rows") {
            stored.extend(row.get::<_, Vec<u8>>("bytes"));
        }
    }
    let stored = String::from_utf8_lossy(&stored);
    assert!(
        stored.contains(" live"),
        "the store holds the editor's typing"
    );
    assert!(
        !stored.contains("forged"),
        "the store holds the viewer's write"
    );
    assert!(!editor.block_text().contains("forged"));
}

// ------------------------------------------------------------- draft sends

/// POSTs a browser's stored drafts to `/drafts`, as the sweep in
/// `src/lib/editDrafts.ts` does: (status, JSON answer).
async fn send_drafts(
    port: u16,
    room: &str,
    token: Option<&str>,
    origin: Option<&str>,
    body: Vec<u8>,
) -> (u16, serde_json::Value) {
    send_drafts_over(port, room, token, origin, None, body).await
}

/// `send_drafts` naming the base a source's drafts grew over.
async fn send_drafts_over(
    port: u16,
    room: &str,
    token: Option<&str>,
    origin: Option<&str>,
    base: Option<&str>,
    body: Vec<u8>,
) -> (u16, serde_json::Value) {
    let mut request = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/drafts"))
        .header("content-type", "application/octet-stream")
        .header("x-capy-room", room)
        .body(body);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(origin) = origin {
        request = request.header("origin", origin);
    }
    if let Some(base) = base {
        request = request.header("x-capy-base", base);
    }
    let response = request.send().await.expect("draft send");
    let status = response.status().as_u16();
    (
        status,
        response.json().await.unwrap_or(serde_json::Value::Null),
    )
}

/// What a closed tab's drafts hold: the document as `from` holds it, with
/// `edit` made by a session of its own, merged into one update (the state row
/// and the updates after it).
fn drafted(from: &Doc, edit: impl FnOnce(&Doc)) -> Vec<u8> {
    let doc = Doc::with_options(ydoc::doc_options(0));
    let state = from
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    doc.transact_mut()
        .apply_update(Update::decode_v1(&state).expect("state"))
        .expect("apply");
    edit(&doc);
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

/// Appends `text` to a note's first block.
fn typed_into_note(text: &str) -> impl FnOnce(&Doc) + '_ {
    move |doc| {
        let root = doc.get_or_insert_text("content");
        let mut txn = doc.transact_mut();
        let block = root
            .diff(&txn, yrs::types::text::YChange::identity)
            .into_iter()
            .find_map(|chunk| match chunk.insert {
                yrs::Out::YXmlText(block) => Some(block),
                _ => None,
            })
            .expect("a block");
        let len = block.len(&txn);
        block.insert(&mut txn, len, text);
    }
}

/// A synced reader of `room`, whose document drafts are made from.
async fn synced(port: u16, room: &str, user: &str, text: &str) -> Client {
    let mut client = Client::open(port).await;
    client.joined(room, &token(room, user, "write")).await;
    assert!(
        client.settle(|c| c.block_text() == text).await,
        "{}",
        client.block_text()
    );
    client
}

async fn active_rooms(port: u16) -> u64 {
    let metrics = reqwest::get(format!("http://127.0.0.1:{port}/metrics"))
        .await
        .expect("metrics")
        .text()
        .await
        .expect("metrics text");
    metrics
        .lines()
        .find_map(|line| line.strip_prefix("capy_collaboration_active_rooms "))
        .and_then(|value| value.parse().ok())
        .expect("active rooms")
}

#[tokio::test]
async fn a_draft_send_reaches_the_open_editor_and_answers_once_stored() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let mut editor = synced(server.port, &room, &user, "base").await;
    let drafts = drafted(&editor.doc, typed_into_note(" offline"));
    let (status, receipt) = send_drafts(
        server.port,
        &room,
        Some(&token(&room, &user, "write")),
        Some(ORIGIN),
        drafts,
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["type"], "checkpoint-persisted");
    assert_eq!(receipt["room"], room.as_str());
    // The answer came after the store: the row is there at once.
    let rows: i64 = db(&env)
        .await
        .query_one(
            "SELECT count(*) FROM material_yjs_updates WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("rows")
        .get(0);
    assert!(rows >= 1);
    // The open editor receives it live.
    assert!(
        editor.settle(|c| c.block_text() == "base offline").await,
        "{}",
        editor.block_text()
    );
}

#[tokio::test]
async fn a_draft_send_loads_an_unloaded_room_which_unloads_after_its_store() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let drafts = {
        let reader = synced(server.port, &room, &user, "base").await;
        drafted(&reader.doc, typed_into_note(" sent"))
    };
    // The tab's room unloads (nothing to store); the send loads it again.
    for _ in 0..50 {
        if active_rooms(server.port).await == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(active_rooms(server.port).await, 0);
    let (status, receipt) = send_drafts(
        server.port,
        &room,
        Some(&token(&room, &user, "write")),
        Some(ORIGIN),
        drafts,
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    for _ in 0..50 {
        if active_rooms(server.port).await == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(active_rooms(server.port).await, 0, "the room unloads");
    // Reopened from storage.
    synced(server.port, &room, &user, "base sent").await;
}

/// Refusals a draft send answers with their class; the browser keeps the
/// rows, refused ones marked for the next open.
#[tokio::test]
async fn draft_sends_are_refused_with_their_class() {
    use yrs::encoding::write::Write;
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let reader = synced(server.port, &room, &user, "base").await;
    let write = token(&room, &user, "write");
    let send = |body: Vec<u8>| send_drafts(server.port, &room, Some(&write), Some(ORIGIN), body);

    // Over the content limit: refused at admission, as a socket writer's.
    let (status, answer) = send(drafted(
        &reader.doc,
        typed_into_note(&"x".repeat(2_200_000)),
    ))
    .await;
    assert_eq!(
        (status, answer["class"].as_str()),
        (422, Some("limit")),
        "{answer}"
    );

    // Needs content the room does not hold (a channel would resync).
    let mut unplaceable: Vec<u8> = Vec::new();
    unplaceable.write_var(1u32);
    unplaceable.write_var(1u32);
    unplaceable.write_var(999u64);
    unplaceable.write_var(0u32);
    unplaceable.write_u8(0x80 | 4);
    unplaceable.write_var(998u64);
    unplaceable.write_var(3u32);
    unplaceable.write_string("x");
    unplaceable.write_var(0u32);
    let (status, answer) = send(unplaceable).await;
    assert_eq!(
        (status, answer["class"].as_str()),
        (409, Some("unheld")),
        "{answer}"
    );

    // Another lineage: a token for the next schema, and a schema the note
    // moved past.
    let next = format!("material:{material}:schema:2");
    let (status, answer) = send_drafts(
        server.port,
        &room,
        Some(&token(&next, &user, "write")),
        Some(ORIGIN),
        drafted(&reader.doc, typed_into_note("!")),
    )
    .await;
    assert_eq!(
        (status, answer["class"].as_str()),
        (409, Some("lineage")),
        "{answer}"
    );
    drop(reader);
    db(&env)
        .await
        .execute(
            "UPDATE material_yjs_documents SET room_schema=2 WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("move the lineage");
    let (status, answer) = send(vec![0, 0]).await;
    assert_eq!(
        (status, answer["class"].as_str()),
        (409, Some("lineage")),
        "{answer}"
    );
    // The browser hears the class alone (REVIEW1 S5); the server counts each.
    assert_eq!(answer, serde_json::json!({ "class": "lineage" }));
    let metrics = reqwest::get(format!("http://127.0.0.1:{}/metrics", server.port))
        .await
        .expect("metrics")
        .text()
        .await
        .expect("metrics text");
    for (class, count) in [
        ("limit", 1),
        ("unheld", 1),
        ("lineage", 2),
        ("permission", 0),
    ] {
        let line = format!("capy_collaboration_draft_refusals_total{{class=\"{class}\"}} {count}");
        assert!(
            metrics.lines().any(|known| known == line),
            "{line} in {metrics}"
        );
    }
}

/// Security regression (drafts-send S1): a draft send writes only with the
/// editor's write token for a note its user may edit, from an allowed origin.
#[tokio::test]
async fn a_draft_send_needs_write_access_to_the_document() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "base").await;
    let (stranger, _) = note(&env, "other").await;
    let room = format!("material:{material}:schema:1");
    let reader = synced(server.port, &room, &user, "base").await;
    let drafts = drafted(&reader.doc, typed_into_note(" forged"));
    let port = server.port;
    let refused = |token: Option<String>, origin: Option<&'static str>| {
        let (drafts, room) = (drafts.clone(), room.clone());
        async move { send_drafts(port, &room, token.as_deref(), origin, drafts).await }
    };
    // A read-only token, another user's, none, and a bad signature.
    for token in [
        Some(token(&room, &user, "read")),
        Some(token(&room, &stranger, "write")),
        None,
        Some(format!("{}x", token(&room, &user, "write"))),
    ] {
        let (status, answer) = refused(token, Some(ORIGIN)).await;
        assert_eq!(
            (status, answer["class"].as_str()),
            (403, Some("permission")),
            "{answer}"
        );
    }
    // A page of another origin, or none.
    for origin in [Some("http://elsewhere.test"), None] {
        let (status, _) = refused(Some(token(&room, &user, "write")), origin).await;
        assert_eq!(status, 403);
    }
    // Nothing reached the note.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let rows: i64 = db(&env)
        .await
        .query_one(
            "SELECT count(*) FROM material_yjs_updates WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("rows")
        .get(0);
    assert_eq!(rows, 0);
}

/// Security regression (drafts-send S2): crafted draft bodies are refused
/// before anything reaches the room's document: not an update, past a
/// writer's 4 MiB sync cap, writing the server's contributor markers, or
/// panicking the decoder, which costs neither the process nor the room.
#[tokio::test]
async fn crafted_draft_bodies_are_refused_and_the_room_survives() {
    use yrs::Map;
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let reader = synced(server.port, &room, &user, "base").await;
    let write = token(&room, &user, "write");
    let send = |body: Vec<u8>| send_drafts(server.port, &room, Some(&write), Some(ORIGIN), body);
    for (body, status, class) in [
        (b"not an update".to_vec(), 400, "malformed"),
        // The debug build's stand-in for an update that panics yrs.
        (b"capy-it-panic".to_vec(), 400, "malformed"),
        (vec![0u8; 4 * 1024 * 1024 + 1], 413, "too_large"),
        (
            drafted(&reader.doc, |doc| {
                doc.get_or_insert_map(ydoc::CONTRIBUTORS_ROOT).insert(
                    &mut doc.transact_mut(),
                    "forged",
                    "someone else",
                );
            }),
            400,
            "malformed",
        ),
    ] {
        let (got, answer) = send(body).await;
        assert_eq!(
            (got, answer["class"].as_str()),
            (status, Some(class)),
            "{answer}"
        );
    }
    // The room still takes a writer's drafts.
    let (status, answer) = send(drafted(&reader.doc, typed_into_note(" kept"))).await;
    assert_eq!(status, 200, "{answer}");
}

#[tokio::test]
async fn a_text_source_draft_send_applies_and_answers_once_checkpointed() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "hello").await;
    let room = format!("source:{file}:epoch:1");
    let mut editor = Client::open(server.port).await;
    assert_eq!(editor.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(
        editor.settle(|c| source_text(c) == "hello").await,
        "{}",
        source_text(&editor)
    );
    let drafts = drafted(&editor.doc, |doc| {
        let text = doc.get_or_insert_text("source");
        let mut txn = doc.transact_mut();
        let end = text.len(&txn);
        text.insert(&mut txn, end, " world");
    });
    let (status, receipt) = send_drafts(
        server.port,
        &room,
        Some(&token(&room, &user, "write")),
        Some(ORIGIN),
        drafts,
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    let rows: i64 = db(&env)
        .await
        .query_one(
            "SELECT count(*) FROM source_document_updates WHERE file_id=$1",
            &[&file],
        )
        .await
        .expect("rows")
        .get(0);
    assert_eq!(rows, 1);
    assert!(
        editor.settle(|c| source_text(c) == "hello world").await,
        "{}",
        source_text(&editor)
    );
}

async fn wait_unloaded(port: u16) {
    for _ in 0..50 {
        if active_rooms(port).await == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the room did not unload");
}

/// The browser's preflight before a send: only an allowed origin hears the
/// headers a send uses, for long enough that one preflight covers a sweep
/// (the room travels in a header, so the URL is the same for every document).
#[tokio::test]
async fn a_draft_preflight_answers_an_allowed_origin_alone() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let preflight = |origin: &'static str| {
        reqwest::Client::new()
            .request(
                reqwest::Method::OPTIONS,
                format!("http://127.0.0.1:{}/drafts", server.port),
            )
            .header("origin", origin)
            .header("access-control-request-method", "POST")
            .header(
                "access-control-request-headers",
                "authorization,content-type,x-capy-room,x-capy-base",
            )
            .send()
    };
    let allowed = preflight(ORIGIN).await.expect("preflight");
    assert_eq!(allowed.status().as_u16(), 204);
    let header = |name: &str| {
        allowed
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    };
    assert_eq!(header("access-control-allow-origin"), ORIGIN);
    assert_eq!(header("access-control-allow-methods"), "POST");
    for name in [
        "authorization",
        "content-type",
        "x-capy-room",
        "x-capy-base",
    ] {
        assert!(
            header("access-control-allow-headers").contains(name),
            "{name}"
        );
    }
    assert!(
        header("access-control-max-age")
            .parse::<u64>()
            .is_ok_and(|age| age > 0)
    );
    let other = preflight("http://elsewhere.test").await.expect("preflight");
    assert_eq!(other.status().as_u16(), 403);
    assert!(other.headers().get("access-control-allow-origin").is_none());
}

/// Security regression (drafts-send REVIEW1 S2): a send is refused while a
/// compaction or publication holds the room's eviction lease, also when its
/// body arrives only after the lease was taken (the JOIN checks ran before).
#[tokio::test]
async fn a_draft_send_is_refused_while_an_eviction_lease_is_held() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let drafts = {
        let reader = synced(server.port, &room, &user, "base").await;
        drafted(&reader.doc, typed_into_note(" late"))
    };
    wait_unloaded(server.port).await;
    let write = token(&room, &user, "write");
    let redis = redis::Client::open(env.redis.as_str()).expect("redis");
    let mut connection = redis
        .get_multiplexed_async_connection()
        .await
        .expect("redis connection");
    let lease = format!("capy:collaboration:evicting:{room}");
    let take = || {
        redis::cmd("SET")
            .arg(&lease)
            .arg("it")
            .arg("PX")
            .arg(60_000)
            .clone()
    };
    let _: () = take().query_async(&mut connection).await.expect("lease");
    let (status, answer) = send_drafts(
        server.port,
        &room,
        Some(&write),
        Some(ORIGIN),
        drafts.clone(),
    )
    .await;
    assert_eq!(
        (status, answer["class"].as_str()),
        (503, Some("unavailable")),
        "{answer}"
    );
    let _: i64 = redis::cmd("DEL")
        .arg(&lease)
        .query_async(&mut connection)
        .await
        .expect("release");
    // A slow body: the checks pass, then the lease is taken before it ends.
    let mut stream = TcpStream::connect(("127.0.0.1", server.port))
        .await
        .expect("connect");
    let head = format!(
        "POST /drafts HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: {ORIGIN}\r\nAuthorization: Bearer {write}\r\nX-Capy-Room: {room}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        drafts.len()
    );
    stream.write_all(head.as_bytes()).await.expect("head");
    stream.write_all(&drafts[..1]).await.expect("first byte");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let _: () = take().query_async(&mut connection).await.expect("lease");
    stream.write_all(&drafts[1..]).await.expect("rest");
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .await
        .expect("response");
    let _: i64 = redis::cmd("DEL")
        .arg(&lease)
        .query_async(&mut connection)
        .await
        .expect("release");
    assert!(response.starts_with("HTTP/1.1 503"), "{response}");
    assert!(
        response.contains(r#"{"class":"unavailable"}"#),
        "{response}"
    );
    let rows: i64 = db(&env)
        .await
        .query_one(
            "SELECT count(*) FROM material_yjs_updates WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("rows")
        .get(0);
    assert_eq!(rows, 0, "nothing was stored");
}

/// A DOCX file over `lesson.docx` (the engine tests' fixture), owned by a
/// fresh user; returns (user, file, the base's SHA-256).
async fn office_file(env: &Env, gateway: &Gateway) -> (String, String, String) {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../e2e/fixtures/files/basic/lesson.docx"
    ))
    .expect("the DOCX fixture");
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
        sha2::Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    };
    client
        .execute(
            "INSERT INTO files (id,workspace_id,user_id,name,kind,size_bytes,status,blob_path) VALUES ($1,$2,$3,'it.docx','docx',$4,'ready','p/'||$1)",
            &[&file, &workspace, &user, &(bytes.len() as i64)],
        )
        .await
        .expect("file");
    client
        .execute(
            "INSERT INTO source_documents (file_id,user_id,format,base_revision,base_blob_path,base_source_sha256) VALUES ($1,$2,'docx',1,'p/'||$1,$3)",
            &[&file, &user, &sha],
        )
        .await
        .expect("source document");
    gateway
        .blobs
        .lock()
        .expect("blobs")
        .insert(file.clone(), bytes);
    (user, file, sha)
}

/// Security regression (drafts-send REVIEW1 S6): an Office file's drafts go
/// in only over the room's base (the editor's lineage rule), and none while
/// the Office maintenance pause holds. The pause row pauses every Office
/// file, so both run in one test.
#[tokio::test]
async fn an_office_draft_goes_in_over_the_rooms_base_alone_and_never_while_paused() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file, sha) = office_file(&env, &gateway).await;
    let room = format!("source:{file}:epoch:1");
    let write = token(&room, &user, "write");
    let send = |base: Option<String>| {
        let (room, write) = (room.clone(), write.clone());
        async move {
            send_drafts_over(
                server.port,
                &room,
                Some(&write),
                Some(ORIGIN),
                base.as_deref(),
                vec![0, 0],
            )
            .await
        }
    };
    for base in [None, Some("0".repeat(64))] {
        let (status, answer) = send(base).await;
        assert_eq!(
            (status, answer["class"].as_str()),
            (409, Some("lineage")),
            "{answer}"
        );
    }
    let (status, answer) = send(Some(sha.clone())).await;
    assert_eq!(status, 200, "{answer}");
    let pause = db(&env).await;
    pause
        .execute(
            "INSERT INTO office_editing_pause DEFAULT VALUES ON CONFLICT DO NOTHING",
            &[],
        )
        .await
        .expect("pause");
    let (status, answer) = send(Some(sha)).await;
    pause
        .execute("DELETE FROM office_editing_pause", &[])
        .await
        .expect("resume");
    assert_eq!(
        (status, answer["class"].as_str()),
        (503, Some("unavailable")),
        "{answer}"
    );
}

/// Security regression (drafts-send REVIEW1 S6): a source room takes no draft
/// while a publication handoff holds its writers read-only.
#[tokio::test]
async fn a_source_room_takes_no_draft_during_a_publication_handoff() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "hello").await;
    let room = format!("source:{file}:epoch:1");
    let mut a = Client::open(server.port).await;
    assert_eq!(a.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(a.settle(|c| source_text(c) == "hello").await);
    let redis = redis::Client::open(env.redis.as_str()).expect("redis");
    let mut connection = redis
        .get_multiplexed_async_connection()
        .await
        .expect("redis connection");
    let prepare = serde_json::json!({
        "type": "prepare", "id": "it-draft-handoff", "room": room, "fileId": file,
        "epoch": 1, "checkpoint": 0, "writersOnly": true,
    });
    let _: i64 = redis::cmd("PUBLISH")
        .arg(sources::handoff::SOURCE_HANDOFF_CHANNEL)
        .arg(prepare.to_string())
        .query_async(&mut connection)
        .await
        .expect("publish");
    loop {
        let payload = a.until(9).await.expect("the handoff's prepare");
        if text_payload(&payload).contains("source-handoff-prepare") {
            break;
        }
    }
    let drafts = drafted(&a.doc, |doc| {
        let text = doc.get_or_insert_text("source");
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 0, "late ");
    });
    let (status, answer) = send_drafts(
        server.port,
        &room,
        Some(&token(&room, &user, "write")),
        Some(ORIGIN),
        drafts,
    )
    .await;
    assert_eq!(
        (status, answer["class"].as_str()),
        (503, Some("unavailable")),
        "{answer}"
    );
    assert_eq!(source_text(&a), "hello");
}

/// Live items take drafts as notes do: a flashcard set's, and a quiz's keys
/// document's with a write token alone (a read token is refused before the
/// room), each reaching the open editor.
#[tokio::test]
async fn live_item_drafts_reach_their_rooms() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let set = flashcard_set(&env, &owner, None, &[("c1", "Cell", "unit of life")]).await;
    let set_room = format!("material:{set}:schema:1");
    let mut cards = Client::open(server.port).await;
    cards
        .joined(&set_room, &token(&set_room, &owner, "write"))
        .await;
    let seeded = vec![("c1".to_owned(), "Cell".to_owned())];
    assert!(
        cards.settle(|c| c.cards() == seeded).await,
        "{:?}",
        cards.cards()
    );
    let drafts = drafted(&cards.doc, |doc| add_card(doc, "c2", "a1", "Nucleus"));
    let (status, answer) = send_drafts(
        server.port,
        &set_room,
        Some(&token(&set_room, &owner, "write")),
        Some(ORIGIN),
        drafts,
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let both = vec![
        ("c1".to_owned(), "Cell".to_owned()),
        ("c2".to_owned(), "Nucleus".to_owned()),
    ];
    assert!(
        cards.settle(|c| c.cards() == both).await,
        "{:?}",
        cards.cards()
    );

    let quiz = quiz_material(&env, &owner, "private").await;
    let keys_room = format!("keys:{quiz}:schema:1");
    let mut keys = Client::open(server.port).await;
    keys.joined(&keys_room, &token(&keys_room, &owner, "write"))
        .await;
    assert!(
        keys.settle(|c| map_at(&c.doc, &["keys", "q1-p"]).is_some())
            .await
    );
    let drafts = drafted(&keys.doc, |doc| {
        use yrs::Map;
        let key = map_at(doc, &["keys", "q1-p"]).expect("key");
        key.insert(&mut doc.transact_mut(), "correct", "o1");
    });
    let (status, answer) = send_drafts(
        server.port,
        &keys_room,
        Some(&token(&keys_room, &owner, "read")),
        Some(ORIGIN),
        drafts.clone(),
    )
    .await;
    assert_eq!(
        (status, answer["class"].as_str()),
        (403, Some("permission")),
        "{answer}"
    );
    let (status, answer) = send_drafts(
        server.port,
        &keys_room,
        Some(&token(&keys_room, &owner, "write")),
        Some(ORIGIN),
        drafts,
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert!(
        keys.settle(|c| {
            use yrs::Map;
            map_at(&c.doc, &["keys", "q1-p"]).is_some_and(|key| {
                key.get(&c.doc.transact(), "correct")
                    .is_some_and(|value| value.to_string(&c.doc.transact()) == "o1")
            })
        })
        .await
    );
}
