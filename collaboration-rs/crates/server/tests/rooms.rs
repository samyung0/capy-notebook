//! Integration tests of note rooms against Postgres (migrated by the Go API)
//! and Redis: the server binary runs as a child process and two clients speak
//! capy-sync 1 to it. Set CAPY_IT_DATABASE_URL and CAPY_IT_REDIS_URL (the
//! docker e2e stack's, see DESIGN.md 11); without them every test skips.

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
}

fn env() -> Option<Env> {
    Some(Env {
        database: std::env::var("CAPY_IT_DATABASE_URL").ok()?,
        redis: std::env::var("CAPY_IT_REDIS_URL").ok()?,
    })
}

struct Server {
    child: Child,
    port: u16,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

async fn start(env: &Env) -> Server {
    let port = 46_000 + (std::process::id() % 1000) as u16;
    let child = Command::new(env!("CARGO_BIN_EXE_capy-collaboration"))
        .env("DATABASE_URL", &env.database)
        .env("REDIS_URL", &env.redis)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .env("COLLABORATION_SECRET", SECRET)
        .env("COLLABORATION_ALLOWED_ORIGINS", ORIGIN)
        // Nothing answers projections here; they fail and are recorded.
        .env("API_URL", "http://127.0.0.1:9")
        .env("COLLABORATION_DEBOUNCE_MS", "200")
        .env("COLLABORATION_MAX_DEBOUNCE_MS", "1000")
        .env("COLLABORATION_PROJECTION_IDLE_MS", "60000")
        .env("APP_ENV", "test")
        .stdout(Stdio::null())
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
            "INSERT INTO materials (id, owner_user_id, kind, title, content) VALUES ($1, $2, 'note', 'IT', $3)",
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
    let schema: i64 = room.rsplit(':').next().and_then(|n| n.parse().ok()).unwrap_or(1);
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
        let mut request = format!("ws://127.0.0.1:{port}/").into_client_request().expect("request");
        request.headers_mut().insert("origin", ORIGIN.parse().expect("origin"));
        let (ws, _) = tokio_tungstenite::connect_async(request).await.expect("connect");
        Client {
            ws,
            doc: Doc::with_options(ydoc::doc_options(0)),
            inbox: Vec::new(),
        }
    }

    async fn send(&mut self, kind: u8, payload: &[u8]) {
        self.ws.send(Ws::Binary(frame(1, kind, payload).into())).await.expect("send");
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
            let next = tokio::time::timeout_at(deadline, self.ws.next()).await.ok()??.ok()?;
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
                if message_kind == 5 {
                    self.on_sync(&payload).await;
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
            self.doc.transact_mut().apply_update(Update::decode_v1(&body).expect("update")).expect("apply");
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
        let out = root.get_string(&txn);
        out
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
    a.until(6).await;
    assert_eq!(a.block_text(), "hello");

    a.type_text(" world").await;
    // A hears its ACK, not its own update.
    let ack = a.until(6).await.expect("ack");
    assert!(!ack.is_empty());
    tokio::time::sleep(Duration::from_millis(200)).await;
    b.until(5).await;
    assert_eq!(b.block_text(), "hello world");

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
        .query_one("SELECT count(*) FROM material_yjs_updates WHERE material_id=$1", &[&material])
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
        a.until(6).await;
        a.type_text(" plus").await;
        a.until(6).await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
    // The room unloads after its last channel left and folds its log.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let client = db(&env).await;
    let rows: i64 = client
        .query_one("SELECT log_rows FROM material_yjs_documents WHERE material_id=$1", &[&material])
        .await
        .expect("row")
        .get::<_, i32>(0)
        .into();
    assert_eq!(rows, 0);
    let mut c = Client::open(server.port).await;
    c.joined(&room, &token(&room, &user, "write")).await;
    c.until(6).await;
    assert_eq!(c.block_text(), "base plus");
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
    client.until(6).await;
    client.type_text("!").await;
    let closed = client.until(4).await.expect("closed");
    assert!(String::from_utf8_lossy(&closed).contains("read-only"));
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
    let mut connection = redis.get_multiplexed_async_connection().await.expect("redis connection");
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
