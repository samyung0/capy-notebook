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
    /// A collecting server's own Redis database (`redis_db`), given back
    /// once the server is gone.
    redis: Option<RedisDb>,
}

/// The collaboration processes' heartbeat registry (`app.rs`).
const INSTANCE_REGISTRY: &str = "capy:collaboration:instances";

/// Redis databases 1-15 for collecting servers (every other server uses the
/// stack's): a fold collects nothing while another collaboration process's
/// heartbeat is in its registry (Q400, review r3 L1), and the tests run
/// servers side by side.
static REDIS_DBS: std::sync::LazyLock<std::sync::Mutex<Vec<u8>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new((1..16).collect()));

/// A Redis database a collecting server has to itself.
struct RedisDb {
    index: u8,
    url: String,
}

impl Drop for RedisDb {
    fn drop(&mut self) {
        REDIS_DBS.lock().expect("databases").push(self.index);
    }
}

/// A free Redis database, its registry emptied (a server stopped before
/// keeps its last heartbeat there for a minute). Pub/sub crosses databases,
/// but keys the test API writes (in the stack's database 0, eviction
/// requests and the like) are not seen by a server in one of these.
async fn redis_db(env: &Env) -> RedisDb {
    let index = loop {
        if let Some(index) = REDIS_DBS.lock().expect("databases").pop() {
            break index;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    let base = match env.redis.rsplit_once('/') {
        Some((base, db)) if db.parse::<u8>().is_ok() => base,
        _ => env.redis.as_str(),
    };
    let db = RedisDb {
        index,
        url: format!("{base}/{index}"),
    };
    let mut redis = redis_at(&db.url).await;
    let _: () = redis::AsyncCommands::del(&mut redis, INSTANCE_REGISTRY)
        .await
        .expect("registry");
    db
}

async fn redis_at(url: &str) -> redis::aio::MultiplexedConnection {
    redis::Client::open(url)
        .expect("redis url")
        .get_multiplexed_async_connection()
        .await
        .expect("redis")
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(disk_dir(self.port));
    }
}

/// A server's disk store folder, one per port (removed with the server).
fn disk_dir(port: u16) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("disk-{port}"))
}

async fn start(env: &Env) -> Server {
    start_with(env, env.api.as_deref()).await
}

/// The server with `api` as its gateway (a stand-in for source rooms).
async fn start_with(env: &Env, api: Option<&str>) -> Server {
    start_configured(env, api, &[]).await
}

/// The server with `api` as its gateway and `extra` settings.
async fn start_configured(env: &Env, api: Option<&str>, extra: &[(&str, &str)]) -> Server {
    let stdout = if std::env::var_os("CAPY_IT_LOGS").is_some() {
        Stdio::inherit()
    } else {
        Stdio::null()
    };
    launch(env, api, extra, stdout).await
}

/// The server, its log lines kept for the test to read (`Logs`).
async fn start_logged(env: &Env) -> (Server, Logs) {
    start_logged_with(env, &[]).await
}

/// `start_logged` with `extra` settings.
async fn start_logged_with(env: &Env, extra: &[(&str, &str)]) -> (Server, Logs) {
    let mut server = launch(env, env.api.as_deref(), extra, Stdio::piped()).await;
    let logs = Logs::default();
    let stdout = server.child.stdout.take().expect("piped output");
    let lines = logs.0.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            lines.lock().expect("logs").push(line);
        }
    });
    (server, logs)
}

/// A server's log lines (`start_logged`).
#[derive(Default)]
struct Logs(std::sync::Arc<std::sync::Mutex<Vec<String>>>);

impl Logs {
    /// How many lines so far hold every one of `parts`.
    fn count(&self, parts: &[&str]) -> usize {
        self.0
            .lock()
            .expect("logs")
            .iter()
            .filter(|line| parts.iter().all(|part| line.contains(part)))
            .count()
    }

    /// Whether a line holding every one of `parts` comes within 10 s.
    async fn has(&self, parts: &[&str]) -> bool {
        for _ in 0..100 {
            let found = self
                .0
                .lock()
                .expect("logs")
                .iter()
                .any(|line| parts.iter().all(|part| line.contains(part)));
            if found {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    }
}

#[allow(clippy::zombie_processes)]
async fn launch(env: &Env, api: Option<&str>, extra: &[(&str, &str)], stdout: Stdio) -> Server {
    // A free port per server, so the tests run in parallel.
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .expect("a free port");
    let redis = if extra.contains(&("COLLABORATION_GC_COLLECT", "true")) {
        Some(redis_db(env).await)
    } else {
        None
    };
    let child = Command::new(env!("CARGO_BIN_EXE_capy-collaboration"))
        .env("DATABASE_URL", &env.database)
        .env(
            "REDIS_URL",
            redis
                .as_ref()
                .map_or(env.redis.as_str(), |db| db.url.as_str()),
        )
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
        // A disk store per server (it wipes its folder at start), UAT's cap.
        .env("COLLABORATION_SOURCE_DISK_DIR", disk_dir(port))
        .env("COLLABORATION_SOURCE_DISK_BYTES", "5368709120")
        .envs(extra.iter().copied())
        .stdout(stdout)
        .spawn()
        .expect("the server starts");
    for _ in 0..100 {
        if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Server { child, port, redis };
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

/// Another note of `user`'s, holding `text`.
async fn note_for(env: &Env, user: &str, text: &str) -> String {
    let material = format!("m_it_{}", uuid_like());
    let content = serde_json::json!({
        "schemaVersion": 1,
        "value": [{ "type": "p", "id": "b1", "children": [{ "text": text }] }],
    });
    db(env)
        .await
        .execute(
            "INSERT INTO materials (id, created_by, kind, title, content) VALUES ($1, $2, 'note', 'IT', $3)",
            &[&material, &user, &content],
        )
        .await
        .expect("material");
    material
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
    signed_token(room, user, access, ttl, None)
}

/// An embedded item's token, naming its note as Go does.
fn embed_token(room: &str, user: &str, note: &str) -> String {
    signed_token(room, user, "write", 300, Some(note))
}

fn signed_token(room: &str, user: &str, access: &str, ttl: i64, parent: Option<&str>) -> String {
    let mut claims = token_claims(room, user, access, ttl);
    if let Some(parent) = parent {
        claims["parent"] = parent.into();
    }
    sign_claims(&claims)
}

/// A token naming who the connection is, as Go mints one (Epo 2026-10-20):
/// the user's name alone, nothing about the device.
fn identity_token(room: &str, user: &str, access: &str, name: &str) -> String {
    let mut claims = token_claims(room, user, access, 300);
    claims["name"] = name.into();
    sign_claims(&claims)
}

/// A token offering the client id `client`.
fn token_offering(room: &str, user: &str, access: &str, client: u64) -> String {
    let mut claims = token_claims(room, user, access, 300);
    claims["clientId"] = client.into();
    sign_claims(&claims)
}

/// A write token offering `client`, issued `age` seconds ago (and valid for
/// an hour from then).
fn token_issued(room: &str, user: &str, client: u64, age: i64) -> String {
    let mut claims = token_claims(room, user, "write", 300);
    let issued = claims["iat"].as_i64().expect("iat") - age;
    claims["clientId"] = client.into();
    claims["iat"] = issued.into();
    claims["exp"] = (issued + 3600).into();
    sign_claims(&claims)
}

/// A write token offering `client` and, for a DOCX session's resident
/// layout worker, `worker` (Q219).
fn token_with_worker(room: &str, user: &str, client: u64, worker: u64) -> String {
    let mut claims = token_claims(room, user, "write", 300);
    claims["clientId"] = client.into();
    claims["workerClientId"] = worker.into();
    sign_claims(&claims)
}

fn token_claims(room: &str, user: &str, access: &str, ttl: i64) -> serde_json::Value {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    let schema: i64 = room
        .rsplit(':')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or(1);
    serde_json::json!({
        "access": access, "aud": "capy-collaboration", "clientId": fresh_client_id(), "exp": now + ttl,
        "iat": now, "iss": "capy-api", "jti": format!("t_{now}_{user}"), "room": room, "schema": schema,
        "sub": user,
    })
}

/// A Yjs client id as Go mints one per token: random, 1..2^32.
fn fresh_client_id() -> u64 {
    u64::from(uuid::Uuid::new_v4().as_u128() as u32 | 1)
}

/// The client id a token offers (`clientId`); none for a junk token.
fn token_client_id(token: &str) -> Option<u64> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let claims: serde_json::Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .ok()?,
    )
    .ok()?;
    claims["clientId"].as_u64()
}

fn sign_claims(claims: &serde_json::Value) -> String {
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use hmac::{Hmac, Mac};
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

/// The client protocol an up-to-date browser sends: the server's own
/// (`CLIENT_PROTOCOL` in `protocol.rs`).
fn client_protocol() -> u64 {
    protocol_constant("CLIENT_PROTOCOL")
}

/// A `pub const <name>: u32` of `protocol.rs`, so the tests follow a bump.
fn protocol_constant(name: &str) -> u64 {
    let prefix = format!("pub const {name}: u32 = ");
    include_str!("../src/protocol.rs")
        .lines()
        .find_map(|line| {
            line.strip_prefix(prefix.as_str())?
                .strip_suffix(';')?
                .parse()
                .ok()
        })
        .unwrap_or_else(|| panic!("{name} in protocol.rs"))
}

/// A token for a fresh session (a new Y.Doc): `token` itself, or, when a
/// session of this process already took the id it offers, the same claims
/// re-signed with a fresh id. A browser fetches a token per JOIN, so a new
/// Y.Doc never reuses another's id (the server refuses an id offered again,
/// Q213); tests reuse token strings freely.
fn session_token(token: &str) -> String {
    static TAKEN: std::sync::Mutex<std::collections::BTreeSet<u64>> =
        std::sync::Mutex::new(std::collections::BTreeSet::new());
    let Some(offered) = token_client_id(token) else {
        return token.to_owned();
    };
    let mut taken = TAKEN.lock().expect("taken ids");
    if taken.insert(offered) {
        return token.to_owned();
    }
    use base64::Engine;
    let payload = token.split('.').nth(1).expect("claims");
    let mut claims: serde_json::Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .expect("base64"),
    )
    .expect("json");
    let fresh = fresh_client_id();
    taken.insert(fresh);
    claims["clientId"] = fresh.into();
    sign_claims(&claims)
}

/// A JOIN's payload for a fresh session: the room, the token and the client
/// protocol (none from a tab before the version gate), then the session's
/// client id, the one its token offers (Q213).
fn join_payload(room: &str, token: &str, protocol: Option<u64>) -> Vec<u8> {
    let token = session_token(token);
    let client = token_client_id(&token).unwrap_or(0);
    join_payload_as(room, &token, protocol, client)
}

/// A JOIN's payload naming the session's client id `client`, a new session
/// holding no stored version.
fn join_payload_as(room: &str, token: &str, protocol: Option<u64>, client: u64) -> Vec<u8> {
    join_payload_at(room, token, protocol, client, 0)
}

/// A JOIN's payload naming the session's client id and the stored version
/// it holds (in-place collection).
fn join_payload_at(
    room: &str,
    token: &str,
    protocol: Option<u64>,
    client: u64,
    version: u64,
) -> Vec<u8> {
    let mut payload = Vec::new();
    varbytes(&mut payload, room.as_bytes());
    varbytes(&mut payload, token.as_bytes());
    if let Some(protocol) = protocol {
        var(&mut payload, protocol);
        var(&mut payload, client);
        var(&mut payload, version);
    }
    payload
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
    /// The channel it speaks on: a remount opens the next.
    channel: u64,
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
        // A browser takes any frame; the server's ceiling is a whole source
        // state (tungstenite's own default is 16 MiB a frame).
        let limit = Some(sources::MAX_SOURCE_STATE_BYTES + 1024 * 1024);
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_frame_size(limit)
            .max_message_size(limit);
        let (ws, _) = tokio_tungstenite::connect_async_with_config(request, Some(config), false)
            .await
            .expect("connect");
        Client {
            ws,
            channel: 1,
            doc: Doc::with_options(ydoc::doc_options(0)),
            inbox: Vec::new(),
            received: Vec::new(),
        }
    }

    async fn send(&mut self, kind: u8, payload: &[u8]) {
        self.ws
            .send(Ws::Binary(frame(self.channel, kind, payload).into()))
            .await
            .expect("send");
    }

    /// Sends JOIN as a browser session does (Q213): a document that wrote
    /// nothing yet takes the token's client id; one that wrote keeps its own.
    async fn join(&mut self, room: &str, token: &str) {
        let own = self.doc.client_id();
        let fresh = self.doc.transact().state_vector().get(&own) == 0;
        let token = if fresh {
            session_token(token)
        } else {
            token.to_owned()
        };
        let token = token.as_str();
        if fresh
            && let Some(offered) = token_client_id(token)
            && offered != own.get()
        {
            let state = self
                .doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            let doc = Doc::with_options(ydoc::doc_options(offered));
            doc.transact_mut()
                .apply_update(Update::decode_v1(&state).expect("state"))
                .expect("apply");
            self.doc = doc;
        }
        let client = self.doc.client_id().get();
        self.send(
            0,
            &join_payload_as(room, token, Some(client_protocol()), client),
        )
        .await;
    }

    /// The session's client id (its document's).
    fn id(&self) -> u64 {
        self.doc.client_id().get()
    }

    /// Leaves its channel as a browser tab does (Q236): `unsent` when it
    /// still holds unsent edits for the document, naming its session. Later
    /// JOINs go on the next channel of the same socket.
    async fn leave(&mut self, unsent: bool) {
        let session = self.id();
        self.leave_naming(unsent, session).await;
    }

    /// A Leave naming the session `session`.
    async fn leave_naming(&mut self, unsent: bool, session: u64) {
        let mut payload = vec![u8::from(unsent)];
        var(&mut payload, session);
        self.send(3, &payload).await;
        self.channel += 1;
        self.inbox.clear();
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

    /// What an editor does when the room refuses its document: a fresh
    /// document joins on a new channel of the same socket, and syncs.
    async fn remount(&mut self, room: &str, token: &str) {
        self.channel += 1;
        self.doc = Doc::with_options(ydoc::doc_options(0));
        self.inbox.clear();
        self.joined(room, token).await;
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
        let update = self.typed(text);
        self.send(5, &sync(2, &update)).await;
    }

    /// Inserts `text` at `index` of the first block.
    async fn type_at(&mut self, index: u32, text: &str) {
        let before = self.doc.transact().state_vector();
        {
            let root = self.doc.get_or_insert_text("content");
            let mut txn = self.doc.transact_mut();
            let block = root
                .diff(&txn, yrs::types::text::YChange::identity)
                .into_iter()
                .find_map(|chunk| match chunk.insert {
                    yrs::Out::YXmlText(block) => Some(block),
                    _ => None,
                })
                .expect("a block");
            block.insert(&mut txn, index, text);
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

    /// An update typing `text` into the first block, not sent.
    fn typed(&mut self, text: &str) -> Vec<u8> {
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
        self.doc.transact().encode_state_as_update_v1(&before)
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
    // The in-place collection is off by default: no fold stored a window.
    assert_eq!(windows(&env, &material).await, 0);
    let mut c = Client::open(server.port).await;
    c.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        c.settle(|c| c.block_text() == "base plus").await,
        "{}",
        c.block_text()
    );
}

/// How many window snapshots a material's folds keep.
async fn windows(env: &Env, material: &str) -> i64 {
    db(env)
        .await
        .query_one(
            "SELECT count(*) FROM material_yjs_windows WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("windows")
        .get(0)
}

/// Asks for a receipt and waits for the one naming `id` (other members'
/// receipts reach every channel).
async fn persisted(client: &mut Client, id: &str) {
    checkpoint_requested(client, id).await;
    checkpoint_persisted(client, id).await;
}

/// Asks the room to store now, under checkpoint `id`.
async fn checkpoint_requested(client: &mut Client, id: &str) {
    let request = serde_json::json!({ "id": id, "type": "checkpoint-request" }).to_string();
    let mut payload = Vec::new();
    varbytes(&mut payload, request.as_bytes());
    client.send(9, &payload).await;
}

/// Waits for checkpoint `id`'s receipt.
async fn checkpoint_persisted(client: &mut Client, id: &str) {
    loop {
        let (receipt, _) = client.stateless("checkpoint-persisted").await;
        if receipt["checkpointIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|known| known == id))
        {
            return;
        }
    }
}

/// Waits up to 10 s for a material's log to be folded (empty).
async fn log_folded(env: &Env, material: &str) -> bool {
    let client = db(env).await;
    for _ in 0..100 {
        let rows: i32 = client
            .query_one(
                "SELECT log_rows FROM material_yjs_documents WHERE material_id=$1",
                &[&material],
            )
            .await
            .expect("row")
            .get(0);
        if rows == 0 {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Whether the stored base holds `unit` collected (no row folded since
/// counts).
async fn collected_in_base(env: &Env, material: &str, unit: yrs::ID) -> bool {
    let state: Vec<u8> = db(env)
        .await
        .query_one(
            "SELECT state FROM material_yjs_documents WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("base")
        .get(0);
    let doc = Doc::with_options(ydoc::doc_options(0));
    doc.transact_mut()
        .apply_update(Update::decode_v1(&state).expect("base decodes"))
        .expect("base applies");
    collected_in(&doc, unit)
}

/// Whether `doc` holds `unit` collected.
fn collected_in(doc: &Doc, unit: yrs::ID) -> bool {
    matches!(
        doc.transact().store().get_block_range(&unit),
        Some((_, None))
    )
}

/// The material's stored version.
async fn stored_version(env: &Env, material: &str) -> i64 {
    db(env)
        .await
        .query_one(
            "SELECT stored_version FROM material_yjs_documents WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("document")
        .get(0)
}

/// The material's `collected_window`: the window version of its latest
/// collection.
async fn collected_window(env: &Env, material: &str) -> i64 {
    db(env)
        .await
        .query_one(
            "SELECT collected_window FROM material_yjs_documents WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("document")
        .get(0)
}

/// The server with the collection on and `extra` settings.
async fn start_collecting(env: &Env, extra: &[(&str, &str)]) -> Server {
    let mut settings = vec![("COLLABORATION_GC_COLLECT", "true")];
    settings.extend_from_slice(extra);
    start_configured(env, env.api.as_deref(), &settings).await
}

/// An editor's Undo over the edits `doc` makes with `origin`.
fn own_undo(doc: &Doc, origin: &str) -> yrs::undo::UndoManager<()> {
    let mut undo = yrs::undo::UndoManager::with_options(yrs::undo::Options {
        capture_timeout_millis: 0,
        tracked_origins: std::collections::HashSet::from([yrs::Origin::from(origin)]),
        ..Default::default()
    });
    undo.expand_scope(doc, &doc.get_or_insert_text("content"));
    undo
}

/// The note's first block (an XmlText inside `content`), read with no
/// transaction open (taking the root may write).
fn first_block(doc: &Doc) -> yrs::XmlTextRef {
    let root = doc.get_or_insert_text("content");
    root.diff(&doc.transact(), yrs::types::text::YChange::identity)
        .into_iter()
        .find_map(|chunk| match chunk.insert {
            yrs::Out::YXmlText(block) => Some(block),
            _ => None,
        })
        .expect("a block")
}

/// Removes `len` units at `index` of the first block in a transaction with
/// `origin` (an editor's own edit, which its Undo tracks).
fn remove_as(doc: &Doc, origin: &str, index: u32, len: u32) {
    let block = first_block(doc);
    block.remove_range(&mut doc.transact_mut_with(origin), index, len);
}

/// Inserts `text` at `index` of the first block, without sending it.
fn insert_unsent(doc: &Doc, index: u32, text: &str) {
    let block = first_block(doc);
    block.insert(&mut doc.transact_mut(), index, text);
}

impl Client {
    /// Acknowledges the room's latest stored version (the room counts it at
    /// most at its own), as a tab holding everything it heard does.
    async fn ack_all(&mut self) {
        self.ack_version(i64::MAX).await;
    }

    /// The unit at visible `index` of the first block.
    fn unit_at(&self, index: u32) -> yrs::ID {
        let block = first_block(&self.doc);
        let _txn = self.doc.transact();
        let mut next = yrs::branch::BranchPtr::from(block.as_ref() as &yrs::branch::Branch).start();
        let mut left = index;
        while let Some(item) = next {
            if !item.is_deleted() && item.is_countable() {
                if left < item.len() {
                    return yrs::ID::new(item.id().client, item.id().clock + left);
                }
                left -= item.len();
            }
            next = item.right();
        }
        panic!("no unit at {index}");
    }
}

/// A tab with its own document `doc` joining `room` again on a new socket
/// (its token offering the document's client id), naming `version`, and
/// syncing: what it typed while away goes in its step 2.
async fn returning(port: u16, doc: Doc, room: &str, user: &str, version: u64) -> Client {
    let mut client = Client::open(port).await;
    let id = doc.client_id().get();
    client.doc = doc;
    client
        .rejoin_at(room, &token_offering(room, user, "write", id), version)
        .await;
    client
}

/// A fresh tab with an offered client id, joined (naming no version) and
/// synced.
async fn tab(port: u16, room: &str, user: &str) -> Client {
    let mut client = Client::open(port).await;
    let id = fresh_client_id();
    client.doc = Doc::with_options(ydoc::doc_options(id));
    client
        .rejoin_at(room, &token_offering(room, user, "write", id), 0)
        .await;
    client
}

/// The in-place collection at a room's folds (switch on, every store folds),
/// with its sessions: while the room stays open, a fold whose window holds a
/// run that an ended session deleted collects the run's middle items, but
/// not a deletion inside a run that a counted session's Undo may restore
/// (held), in the stored base and in the open room's own document (Q401). A
/// tab joining then loads the collected state; the open tab, which keeps its
/// tombstones, and the joined one type next to the run's edge and converge;
/// the counted tab's Undo restores the letter, and the next load holds it
/// all. Fails if nothing is collected, stored or live, or if the held
/// deletion is (the restored letter is then lost).
#[tokio::test]
async fn folds_collect_the_stored_and_open_documents_and_an_undo_after_them_restores_the_text() {
    let Some(env) = env() else { return };
    let (server, logs) = start_logged_with(
        &env,
        &[
            ("COLLABORATION_GC_COLLECT", "true"),
            ("COLLABORATION_FOLD_MAX_ROWS", "1"),
        ],
    )
    .await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let mut a = tab(server.port, &room, &user).await;
    let mut b = tab(server.port, &room, &user).await;
    assert!(a.settle(|c| c.block_text() == "base").await);
    let mut undo = own_undo(&a.doc, "a");
    // "rtpq", then "s" and "X" typed inside it: items nothing names (the
    // collection takes whole items).
    a.write(|doc| {
        insert_unsent(doc, 4, "rtpq");
        insert_unsent(doc, 5, "s");
        insert_unsent(doc, 8, "X");
    })
    .await;
    persisted(&mut a, "typed").await;
    assert!(log_folded(&env, &material).await);
    a.ack_all().await;
    let (s, x) = (a.unit_at(5), a.unit_at(8));
    // A deletes X, which its Undo may restore.
    a.write(|doc| remove_as(doc, "a", 8, 1)).await;
    persisted(&mut a, "x").await;
    assert!(log_folded(&env, &material).await);
    a.ack_all().await;
    // B deletes the other letters around it; its session then ends.
    assert!(b.settle(|c| c.block_text() == "baserstpq").await);
    b.write(|doc| remove_as(doc, "b", 4, 5)).await;
    persisted(&mut b, "cut").await;
    assert!(log_folded(&env, &material).await);
    b.leave(false).await;
    a.ack_all().await;
    // A types; once it has acknowledged B's cut, a fold's window holds it.
    for mark in ["!", "?"] {
        a.type_at(0, mark).await;
        persisted(&mut a, mark).await;
        assert!(log_folded(&env, &material).await);
        a.ack_all().await;
    }
    assert!(
        collected_in_base(&env, &material, s).await,
        "the ended session's run kept its middle"
    );
    assert!(
        !collected_in_base(&env, &material, x).await,
        "a deletion a counted session may undo was collected"
    );
    // The open room collected its own document too: a tab joining loads it.
    assert!(logs.has(&["live document collected", &material]).await);
    let mut joined = tab(server.port, &room, &user).await;
    assert!(joined.settle(|c| c.block_text() == "?!base").await);
    assert!(
        collected_in(&joined.doc, s),
        "a joining tab got the open room's uncollected document"
    );
    assert!(!collected_in(&joined.doc, x));
    // A (holding the tombstones) and the joined tab type at the end, after
    // q, the last deleted letter (an edge both keep).
    a.type_at(6, "w").await;
    assert!(joined.settle(|c| c.block_text() == "?!basew").await);
    joined.type_at(7, "v").await;
    assert!(a.settle(|c| c.block_text() == "?!basewv").await);
    // A's Undo brings X back, naming X itself and "p", the edge of B's run.
    a.write(|_| assert!(undo.undo_blocking())).await;
    assert_eq!(a.block_text(), "?!baseXwv");
    assert!(
        joined.settle(|c| c.block_text() == "?!baseXwv").await,
        "{}",
        joined.block_text()
    );
    persisted(&mut a, "undo").await;
    assert!(log_folded(&env, &material).await);
    drop((a, joined));
    wait_unloaded(server.port).await;
    let mut fresh = Client::open(server.port).await;
    fresh.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        fresh.settle(|c| c.block_text() == "?!baseXwv").await,
        "{}",
        fresh.block_text()
    );
}

/// Q443 (Epo 2026-10-27, gc_views seed 8462): a session holds only the
/// deletions new to the room, so a tab that deleted offline a letter
/// another tab then deleted first, in a run it cut, holds nothing once it
/// sends; with the cutting tab's session ended, a fold collects the run's
/// middle, and the first tab's Undo restores its letter anchored on that
/// collected history. The room answers the Undo's update late
/// (`collaboration-late`) instead of applying it; the tab's late merge (the
/// late-merge crate, as the browser runs it) places it on the room's current
/// document from a new session, and a reload shows the letter. Fails if the
/// room applies the update (the letter integrates as collected, lost).
#[tokio::test]
async fn an_update_naming_collected_history_is_answered_late_and_merged() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[("COLLABORATION_FOLD_MAX_ROWS", "1")]).await;
    collected_history_answered_late(&env, &server, Back::Live).await;
}

/// The same, with the tab away while the room unloads: it undoes offline
/// and comes back raw, and the next room life, loading the collection's
/// window with the document, answers its step 2 late. Q446 tells collected
/// history (inside that window's deletions) from what yrs dropped under a
/// block deleted since, so this fails if the loaded room reads the
/// collected letter as the latter and applies the Undo.
#[tokio::test]
async fn an_update_naming_collected_history_is_answered_late_after_a_reload() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[("COLLABORATION_FOLD_MAX_ROWS", "1")]).await;
    collected_history_answered_late(&env, &server, Back::Reload).await;
}

/// Q449 (Epo 2026-10-27): the open room's live pass of the collecting fold is
/// refused (debug builds: a material whose id holds `capy-it-refuse-live`),
/// so the room would keep the letter its stored copy collected and admit an
/// update anchored on it. It drain-closes instead: the tab's channel closes
/// as the room is reset, the room unloads, and the next room, loading the
/// collected copy, answers the tab's Undo (its step 2 on coming back) late.
/// Fails if a refused live pass leaves the room open.
#[tokio::test]
async fn a_refused_live_collection_drain_closes_its_room() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[("COLLABORATION_FOLD_MAX_ROWS", "1")]).await;
    collected_history_answered_late(&env, &server, Back::Closed("capy-it-refuse-live")).await;
}

/// Q449: the same with the live pass panicking (`capy-it-panic-live`).
#[tokio::test]
async fn a_panicking_live_collection_drain_closes_its_room() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[("COLLABORATION_FOLD_MAX_ROWS", "1")]).await;
    collected_history_answered_late(&env, &server, Back::Closed("capy-it-panic-live")).await;
}

/// How the undoing tab of `collected_history_answered_late` reaches the room.
#[derive(Clone, Copy, PartialEq)]
enum Back {
    /// Connected: its Undo goes live.
    Live,
    /// Away while the room unloads: its Undo goes as its step 2.
    Reload,
    /// Closed by the room's drain-close after a failed live pass (Q449; the
    /// material id holds the debug hook), then as `Reload`.
    Closed(&'static str),
}

/// `an_update_naming_collected_history_is_answered_late_and_merged`, the tab
/// coming back as `back` says.
async fn collected_history_answered_late(env: &Env, server: &Server, back: Back) {
    let prefix = match back {
        Back::Closed(hook) => hook,
        Back::Live | Back::Reload => "m_it",
    };
    let (user, material) = note_named(env, "base", prefix).await;
    let room = format!("material:{material}:schema:1");
    let mut a = tab(server.port, &room, &user).await;
    let mut b = tab(server.port, &room, &user).await;
    assert!(a.settle(|c| c.block_text() == "base").await);
    let mut undo = own_undo(&a.doc, "a");
    // "rtpq", then "s" and "X" typed inside it: items nothing names.
    a.write(|doc| {
        insert_unsent(doc, 4, "rtpq");
        insert_unsent(doc, 5, "s");
        insert_unsent(doc, 8, "X");
    })
    .await;
    persisted(&mut a, "typed").await;
    assert!(log_folded(env, &material).await);
    a.ack_all().await;
    let x = a.unit_at(8);
    // A deletes X and keeps it unsent; B cuts the run around it, X too,
    // and its session ends.
    remove_as(&a.doc, "a", 8, 1);
    assert!(b.settle(|c| c.block_text() == "baserstpXq").await);
    b.write(|doc| remove_as(doc, "b", 4, 6)).await;
    persisted(&mut b, "cut").await;
    assert!(log_folded(env, &material).await);
    b.leave(false).await;
    // A sends its deletion, which the room holds already: its session
    // holds nothing. Once A acknowledged the cut, a fold collects the
    // run's middle.
    assert!(a.settle(|c| c.block_text() == "base").await);
    for mark in ["!", "?"] {
        a.type_at(0, mark).await;
        persisted(&mut a, mark).await;
        assert!(log_folded(env, &material).await);
        a.ack_all().await;
    }
    assert!(collected_in_base(env, &material, x).await);
    // A's Undo restores X, naming the collected X: answered late, live or
    // as the step 2 of A coming back to the room's next life.
    if let Back::Closed(_) = back {
        let closed = a.until(4).await.expect("the room closes the tab's channel");
        let closed = String::from_utf8_lossy(&closed);
        assert!(closed.contains("being reset"), "{closed}");
    }
    if back != Back::Live {
        let version = stored_version(env, &material).await as u64;
        let doc = a.doc.clone();
        drop(a);
        wait_unloaded(server.port).await;
        assert!(undo.undo_blocking());
        a = returning(server.port, doc, &room, &user, version).await;
    } else {
        a.write(|_| assert!(undo.undo_blocking())).await;
    }
    assert_eq!(a.block_text(), "?!baseX");
    let refusal = a.until(2).await.expect("the room answers the update");
    assert_eq!(text_payload(&refusal), "collaboration-late");
    // The late merge: A's document onto the room's current one, sent from
    // a new session of A's user.
    let mut merged_by = tab(server.port, &room, &user).await;
    assert!(merged_by.settle(|c| c.block_text() == "?!base").await);
    let old = a
        .doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let current = merged_by
        .doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let merged = late_merge::merge(&old, &current).expect("the late merge");
    merged_by
        .write(|doc| {
            doc.transact_mut()
                .apply_update(Update::decode_v1(&merged.update).expect("merged"))
                .expect("apply");
        })
        .await;
    assert_eq!(merged_by.block_text(), "?!baseX");
    persisted(&mut merged_by, "merged").await;
    drop((a, merged_by));
    wait_unloaded(server.port).await;
    let mut fresh = Client::open(server.port).await;
    fresh.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        fresh.settle(|c| c.block_text() == "?!baseX").await,
        "{}",
        fresh.block_text()
    );
}

/// A tab away from the room holds the window back at the version it
/// acknowledged: it drops and types offline after a letter in the middle of
/// a run that another session then deletes before it leaves; the
/// folds after that (each store's while the room stays open, or the unload
/// fold's) keep that letter, deleted after the window, so the tab's draft
/// lands when it returns and the next load holds it. Fails if a fold's
/// window passes the away tab (its draft names a collected letter and is
/// lost on load).
async fn an_away_tab_holds_the_window_back(env: &Env, server: &Server, every_store_folds: bool) {
    let (user, material) = note(env, "base").await;
    let room = format!("material:{material}:schema:1");
    let mut t = tab(server.port, &room, &user).await;
    let mut b = tab(server.port, &room, &user).await;
    assert!(b.settle(|c| c.block_text() == "base").await);
    // "wz", then "x" typed between: an item nothing names.
    b.write(|doc| {
        insert_unsent(doc, 4, "wz");
        insert_unsent(doc, 5, "x");
    })
    .await;
    persisted(&mut b, "typed").await;
    // T writes too, so its session has a row and counts in the next room
    // life (one that never wrote counts only in its own).
    assert!(t.settle(|c| c.block_text() == "basewxz").await);
    t.type_at(7, "~").await;
    persisted(&mut t, "own").await;
    t.ack_all().await;
    b.ack_all().await;
    // T drops (no Leave: its session still counts) and types after x.
    let doc = t.doc.clone();
    drop(t);
    insert_unsent(&doc, 6, "T");
    // B deletes the three letters and leaves (the room unloads; the next
    // life loads T's session from its row).
    assert!(b.settle(|c| c.block_text() == "basewxz~").await);
    b.write(|doc| remove_as(doc, "b", 4, 3)).await;
    persisted(&mut b, "cut").await;
    b.leave(false).await;
    // C stores twice, acknowledging each: B's cut would be in a window that
    // ignored T.
    let mut c = tab(server.port, &room, &user).await;
    assert!(c.settle(|c| c.block_text() == "base~").await);
    c.ack_all().await;
    for mark in ["!", "?"] {
        c.type_at(0, mark).await;
        persisted(&mut c, mark).await;
        assert!(!every_store_folds || log_folded(env, &material).await);
        c.ack_all().await;
    }
    // The room unloads with T still away, and folds.
    c.leave(false).await;
    wait_unloaded(server.port).await;
    assert!(log_folded(env, &material).await);
    // T returns: its draft lands.
    let mut t = returning(server.port, doc, &room, &user, 3).await;
    assert!(
        t.settle(|c| c.block_text() == "?!baseT~").await,
        "{}",
        t.block_text()
    );
    persisted(&mut t, "back").await;
    t.leave(false).await;
    wait_unloaded(server.port).await;
    let mut fresh = Client::open(server.port).await;
    fresh.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        fresh.settle(|c| c.block_text() == "?!baseT~").await,
        "{}",
        fresh.block_text()
    );
}

/// `an_away_tab_holds_the_window_back` with every store folding while the
/// room is open.
#[tokio::test]
async fn an_away_tab_holds_the_open_rooms_folds_back() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[("COLLABORATION_FOLD_MAX_ROWS", "1")]).await;
    an_away_tab_holds_the_window_back(&env, &server, true).await;
}

/// `an_away_tab_holds_the_window_back` with the room folding only when it
/// unloads.
#[tokio::test]
async fn an_away_tab_holds_the_unload_fold_back() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[]).await;
    an_away_tab_holds_the_window_back(&env, &server, false).await;
}

/// The unload fold keeps what a tab away from the room may still undo
/// (switch on, folds only at unload): the tab dropped without a Leave, so
/// its session counts and holds its deletion; the next life's unload fold,
/// whose window holds another session's deleted run around that deletion,
/// collects the run's middle items but not the deletion, and the tab's Undo
/// once it returns restores the letter. Fails if the unload fold holds
/// nothing (the letter is lost on load).
#[tokio::test]
async fn an_unload_fold_keeps_what_an_away_tab_may_undo() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[]).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let mut a = tab(server.port, &room, &user).await;
    let mut b = tab(server.port, &room, &user).await;
    assert!(a.settle(|c| c.block_text() == "base").await);
    let mut undo = own_undo(&a.doc, "a");
    // "rtpq", then "s" and "X" typed inside it: items nothing names (the
    // collection takes whole items).
    a.write(|doc| {
        insert_unsent(doc, 4, "rtpq");
        insert_unsent(doc, 5, "s");
        insert_unsent(doc, 8, "X");
    })
    .await;
    persisted(&mut a, "typed").await;
    let (s, x) = (a.unit_at(5), a.unit_at(8));
    a.write(|doc| remove_as(doc, "a", 8, 1)).await;
    persisted(&mut a, "x").await;
    assert!(b.settle(|c| c.block_text() == "baserstpq").await);
    b.write(|doc| remove_as(doc, "b", 4, 5)).await;
    persisted(&mut b, "cut").await;
    b.leave(false).await;
    assert!(a.settle(|c| c.block_text() == "base").await);
    a.ack_all().await;
    // A drops; the first unload stores the first window candidate.
    let doc = a.doc.clone();
    drop(a);
    wait_unloaded(server.port).await;
    assert!(log_folded(&env, &material).await);
    // A comes back, types and drops again: this unload's window holds B's cut.
    let mut a = returning(server.port, doc, &room, &user, 4).await;
    assert!(a.settle(|c| c.block_text() == "base").await);
    a.type_at(0, "!").await;
    persisted(&mut a, "bang").await;
    a.ack_all().await;
    let doc = a.doc.clone();
    drop(a);
    wait_unloaded(server.port).await;
    assert!(log_folded(&env, &material).await);
    assert!(
        collected_in_base(&env, &material, s).await,
        "the unload fold kept the ended session's run whole"
    );
    assert!(
        !collected_in_base(&env, &material, x).await,
        "the unload fold collected a deletion an away tab may undo"
    );
    // A returns and undoes its deletion.
    let mut a = returning(server.port, doc, &room, &user, 5).await;
    assert!(a.settle(|c| c.block_text() == "!base").await);
    a.write(|_| assert!(undo.undo_blocking())).await;
    persisted(&mut a, "undo").await;
    a.leave(false).await;
    wait_unloaded(server.port).await;
    let mut fresh = Client::open(server.port).await;
    fresh.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        fresh.settle(|c| c.block_text() == "!baseX").await,
        "{}",
        fresh.block_text()
    );
}

/// The live agent Undo after a fold that collects (switch on, every store
/// folds): what an agent step deleted is held (`sessions.rs`, Q385), so a
/// fold whose window holds the deletion keeps it, and the Undo, which
/// re-creates each deleted item naming the item itself, restores the whole
/// text and the next load holds it. A fourth writer's cut run makes the
/// folds discard something, and the open room, which keeps the agent step,
/// keeps its own document whole meanwhile (Q401: a reload of it would drop
/// the deleted text the step's Undo restores). Fails if the folds do not
/// hold the agent step's deletions (the middle writer's letter is collected
/// and lost on load), or if the open room collects its document while it
/// keeps the step (the Undo restores no text).
#[tokio::test]
async fn an_agent_undo_after_a_collecting_fold_restores_the_text() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[("COLLABORATION_FOLD_MAX_ROWS", "1")]).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let mut a = tab(server.port, &room, &user).await;
    // Three writers type a, c, then b between them (three items, the middle
    // one named by nothing), each leaving after its store (kept open: a
    // socket closed with unread messages may lose its Leave).
    let mut middle = None;
    let mut writers = Vec::new();
    for (at, letter, before) in [(4, "a", "base"), (5, "c", "basea"), (5, "b", "baseac")] {
        let mut writer = tab(server.port, &room, &user).await;
        assert!(writer.settle(|c| c.block_text() == before).await);
        writer.type_at(at, letter).await;
        persisted(&mut writer, letter).await;
        assert!(log_folded(&env, &material).await);
        writer.leave(false).await;
        middle = Some(yrs::ID::new(writer.doc.client_id(), 0));
        writers.push(writer);
    }
    let middle = middle.expect("the middle letter");
    // The fourth types "xz" and "y" between in front, cuts them and leaves.
    let mut cutter = tab(server.port, &room, &user).await;
    assert!(cutter.settle(|c| c.block_text() == "baseabc").await);
    cutter
        .write(|doc| {
            insert_unsent(doc, 0, "xz");
            insert_unsent(doc, 1, "y");
        })
        .await;
    persisted(&mut cutter, "xyz").await;
    assert!(log_folded(&env, &material).await);
    let y = cutter.unit_at(1);
    cutter.write(|doc| remove_as(doc, "c", 0, 3)).await;
    persisted(&mut cutter, "cut").await;
    assert!(log_folded(&env, &material).await);
    cutter.leave(false).await;
    writers.push(cutter);
    assert!(a.settle(|c| c.block_text() == "baseabc").await);
    a.ack_all().await;
    let (edit, undo) = (format!("e_{material}"), format!("u_{material}"));
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &serde_json::json!({
            "actorUserId": user,
            "commands": [{ "type": "replace_text", "blockId": "b1", "expectedText": "abc", "text": "Z" }],
            "operation": { "id": edit, "requestHash": edit },
            "room": room,
            "target": { "id": material, "kind": "material" },
        }),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["effect"]["undo"]["operationId"], edit.as_str());
    assert!(a.settle(|c| c.block_text() == "baseZ").await);
    assert!(log_folded(&env, &material).await);
    // Once A has acknowledged the agent's row, a fold's window holds its
    // deletion.
    for mark in ["!", "?"] {
        a.type_at(0, mark).await;
        persisted(&mut a, mark).await;
        assert!(log_folded(&env, &material).await);
        a.ack_all().await;
    }
    assert!(
        !collected_in_base(&env, &material, middle).await,
        "the agent step's deletion was collected while its Undo is live"
    );
    assert!(collected_in_base(&env, &material, y).await);
    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &undo, &material, &receipt),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert!(
        a.settle(|c| c.block_text() == "?!baseabc").await,
        "{}",
        a.block_text()
    );
    drop(a);
    wait_unloaded(server.port).await;
    assert!(log_folded(&env, &material).await);
    let mut fresh = Client::open(server.port).await;
    fresh.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        fresh.settle(|c| c.block_text() == "?!baseabc").await,
        "{}",
        fresh.block_text()
    );
}

/// Q432 (agent-edits-room item 3): live collection no longer skips a room
/// holding agent steps. An agent step admitted while a store runs (each
/// store of this note commits a second late, a debug hook) is pending: its
/// row and agent holds come with the next store. The running store's fold
/// collects the cut letters, and the open room collects its own document at
/// that fold's window meanwhile; the step's deletions, newer than any stored
/// window, are kept, and the step's Undo restores the text. Fails if the
/// pending step's deletions are collected.
#[tokio::test]
async fn an_agent_step_pending_its_store_survives_a_live_collection() {
    let Some(env) = env() else { return };
    let (server, logs) = start_logged_with(
        &env,
        &[
            ("COLLABORATION_GC_COLLECT", "true"),
            ("COLLABORATION_FOLD_MAX_ROWS", "1"),
        ],
    )
    .await;
    let (user, material) = note_named(&env, "base", "capy-it-slow-store").await;
    let room = format!("material:{material}:schema:1");
    let mut a = tab(server.port, &room, &user).await;
    // Three writers type a, c, then b between them (the middle one named by
    // nothing), each leaving after its store.
    let mut writers = Vec::new();
    for (at, letter, before) in [(4, "a", "base"), (5, "c", "basea"), (5, "b", "baseac")] {
        let mut writer = tab(server.port, &room, &user).await;
        assert!(writer.settle(|c| c.block_text() == before).await);
        writer.type_at(at, letter).await;
        persisted(&mut writer, letter).await;
        assert!(log_folded(&env, &material).await);
        writer.leave(false).await;
        writers.push(writer);
    }
    // The fourth types "xz" and "y" between in front, cuts them and leaves.
    let mut cutter = tab(server.port, &room, &user).await;
    assert!(cutter.settle(|c| c.block_text() == "baseabc").await);
    cutter
        .write(|doc| {
            insert_unsent(doc, 0, "xz");
            insert_unsent(doc, 1, "y");
        })
        .await;
    persisted(&mut cutter, "xyz").await;
    assert!(log_folded(&env, &material).await);
    let y = cutter.unit_at(1);
    cutter.write(|doc| remove_as(doc, "c", 0, 3)).await;
    persisted(&mut cutter, "cut").await;
    assert!(log_folded(&env, &material).await);
    cutter.leave(false).await;
    writers.push(cutter);
    assert!(a.settle(|c| c.block_text() == "baseabc").await);
    a.ack_all().await;
    assert!(!collected_in_base(&env, &material, y).await);
    // A's store of "!" runs (after the 200 ms debounce); the agent step is
    // admitted meanwhile.
    let live = ["live document collected", material.as_str()];
    let lives = logs.count(&live);
    a.type_at(0, "!").await;
    checkpoint_requested(&mut a, "!").await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let (edit, undo) = (format!("e_{material}"), format!("u_{material}"));
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &serde_json::json!({
            "actorUserId": user,
            "commands": [{ "type": "replace_text", "blockId": "b1", "expectedText": "abc", "text": "Z" }],
            "operation": { "id": edit, "requestHash": edit },
            "room": room,
            "target": { "id": material, "kind": "material" },
        }),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    checkpoint_persisted(&mut a, "!").await;
    for _ in 0..50 {
        if logs.count(&live) > lives {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(logs.count(&live) > lives, "the open room collected");
    assert!(collected_in_base(&env, &material, y).await);
    assert_eq!(
        receipts_now(&env, &edit).await,
        0,
        "the live collection ran after the step's store"
    );
    assert!(a.settle(|c| c.block_text() == "!baseZ").await);
    assert!(receipt_stored(&env, &edit).await, "the step's store");
    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &undo, &material, &receipt),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert!(
        a.settle(|c| c.block_text() == "!baseabc").await,
        "{}",
        a.block_text()
    );
    drop(a);
    wait_unloaded(server.port).await;
    let mut fresh = Client::open(server.port).await;
    fresh.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        fresh.settle(|c| c.block_text() == "!baseabc").await,
        "{}",
        fresh.block_text()
    );
}

/// A collection that panics (debug builds: a material id holding
/// `capy-it-panic-collection`) is a refusal, through the fold itself: every
/// fold still stores the folded document, uncollected, and deletes its rows,
/// and the next load holds the text. Fails if a refused or panicking
/// collection fails the fold (the log is never folded).
#[tokio::test]
async fn a_panicking_collection_still_folds_uncollected() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[("COLLABORATION_FOLD_MAX_ROWS", "1")]).await;
    let (user, material) = note_named(&env, "base", "capy-it-panic-collection").await;
    let room = format!("material:{material}:schema:1");
    let mut a = tab(server.port, &room, &user).await;
    // Three writers' letters (b last, between a and c), each store folded,
    // each writer leaving: from the second fold on a window qualifies and
    // the collection panics.
    let mut middle = None;
    let mut writers = Vec::new();
    for (at, letter, before) in [(4, "a", "base"), (5, "c", "basea"), (5, "b", "baseac")] {
        let mut writer = tab(server.port, &room, &user).await;
        assert!(writer.settle(|c| c.block_text() == before).await);
        writer.type_at(at, letter).await;
        persisted(&mut writer, letter).await;
        assert!(log_folded(&env, &material).await, "the fold after {letter}");
        writer.leave(false).await;
        middle = Some(yrs::ID::new(writer.doc.client_id(), 0));
        writers.push(writer);
    }
    let middle = middle.expect("the middle letter");
    assert!(a.settle(|c| c.block_text() == "baseabc").await);
    a.ack_all().await;
    // A deletes the letters, then types twice: a fold whose window holds
    // the deletion would drop b.
    a.write(|doc| remove_as(doc, "a", 4, 3)).await;
    persisted(&mut a, "cut").await;
    assert!(log_folded(&env, &material).await);
    a.ack_all().await;
    for mark in ["!", "?"] {
        a.type_at(0, mark).await;
        persisted(&mut a, mark).await;
        assert!(log_folded(&env, &material).await);
        a.ack_all().await;
    }
    assert!(windows(&env, &material).await > 0);
    assert_eq!(collected_window(&env, &material).await, 0);
    assert!(
        !collected_in_base(&env, &material, middle).await,
        "a panicking collection stored a collected base"
    );
    a.leave(false).await;
    wait_unloaded(server.port).await;
    assert!(log_folded(&env, &material).await);
    let mut fresh = Client::open(server.port).await;
    fresh.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        fresh.settle(|c| c.block_text() == "?!base").await,
        "{}",
        fresh.block_text()
    );
}

/// The latest collection's window makes older JOINs late (switch on, every
/// store folds): once a fold collected at a window, a session naming a
/// version below it is refused late (`collaboration-late`), in the room that
/// folded (it raised its window for the fold) and after the room reloads (the
/// window is stored with the document), while one naming the window's
/// version joins. Fails if the room's own folds leave its window behind, or
/// the window is not loaded.
#[tokio::test]
async fn a_join_older_than_the_collected_window_is_late() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[("COLLABORATION_FOLD_MAX_ROWS", "1")]).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let mut a = tab(server.port, &room, &user).await;
    let mut b = tab(server.port, &room, &user).await;
    assert!(b.settle(|c| c.block_text() == "base").await);
    // B types "xz" and "y" between (version 2), deletes them (3) and leaves.
    b.write(|doc| {
        insert_unsent(doc, 4, "xz");
        insert_unsent(doc, 5, "y");
    })
    .await;
    persisted(&mut b, "typed").await;
    assert!(log_folded(&env, &material).await);
    b.write(|doc| remove_as(doc, "b", 4, 3)).await;
    persisted(&mut b, "cut").await;
    assert!(log_folded(&env, &material).await);
    b.leave(false).await;
    assert!(a.settle(|c| c.block_text() == "base").await);
    a.ack_all().await;
    a.type_text("1").await;
    persisted(&mut a, "1").await;
    assert!(log_folded(&env, &material).await);
    // A fresh note is at version 1: that fold collected B's cut at the
    // window of the cut's store, version 3.
    assert_eq!(collected_window(&env, &material).await, 3);
    let port = server.port;
    let join_at = |version: u64| {
        let (room, user) = (room.clone(), user.clone());
        async move {
            let mut client = Client::open(port).await;
            let id = fresh_client_id();
            let join = token_offering(&room, &user, "write", id);
            client
                .send(
                    0,
                    &join_payload_at(&room, &join, Some(client_protocol()), id, version),
                )
                .await;
            client
        }
    };
    let refusal = |client: Client| async move {
        let mut client = client;
        text_payload(&client.until(2).await.expect("refused"))
    };
    let mut current = join_at(3).await;
    current
        .until(1)
        .await
        .expect("joined at the window's version");
    assert_eq!(
        refusal(join_at(2).await).await,
        "collaboration-late",
        "late in the room that folded"
    );
    for client in [&mut a, &mut current] {
        client.leave(false).await;
    }
    wait_unloaded(server.port).await;
    assert_eq!(
        refusal(join_at(2).await).await,
        "collaboration-late",
        "late after the room reloaded"
    );
}

/// Q436 (Epo 2026-10-27): a late draft group (made below the collected
/// window) is tried clean first. Typing that names a unit the room collected
/// answers `late` (409, counted) before admission, never `hidden` (merge view
/// V-N1: the late check stays first), and nothing of it is admitted; typing
/// that names nothing collected is admitted as an ordinary draft, stored, and
/// a reload shows it. Both groups go to the open room after its own document
/// was collected (Q401). Fails if late groups skip the check, or if a group
/// naming a collected unit is admitted.
#[tokio::test]
async fn a_late_draft_group_is_admitted_clean_unless_it_names_a_collected_unit() {
    let Some(env) = env() else { return };
    let (server, logs) = start_logged_with(
        &env,
        &[
            ("COLLABORATION_GC_COLLECT", "true"),
            ("COLLABORATION_FOLD_MAX_ROWS", "1"),
        ],
    )
    .await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let mut a = tab(server.port, &room, &user).await;
    let mut b = tab(server.port, &room, &user).await;
    assert!(b.settle(|c| c.block_text() == "base").await);
    // B types "xz" and "y" between (version 2).
    b.write(|doc| {
        insert_unsent(doc, 4, "xz");
        insert_unsent(doc, 5, "y");
    })
    .await;
    persisted(&mut b, "typed").await;
    assert!(log_folded(&env, &material).await);
    let y = b.unit_at(5);
    // Closed tabs offline at version 2, each under its own unrecorded id
    // (granted by its stored token): typing after "y" (which the collection
    // drops below) and typing after "base" (live).
    let offline = |at: u32, text: &str| {
        let id = fresh_client_id();
        let doc = Doc::with_options(ydoc::doc_options(id));
        let state = b
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        doc.transact_mut()
            .apply_update(Update::decode_v1(&state).expect("state"))
            .expect("apply");
        insert_unsent(&doc, at, text);
        let body = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        (token_offering(&room, &user, "write", id), body)
    };
    let (named_grant, named) = offline(6, "W");
    let (clean_grant, clean) = offline(4, "Q");
    // B deletes "xyz" (version 3) and leaves; A's next store collects "y".
    b.write(|doc| remove_as(doc, "b", 4, 3)).await;
    persisted(&mut b, "cut").await;
    assert!(log_folded(&env, &material).await);
    b.leave(false).await;
    assert!(a.settle(|c| c.block_text() == "base").await);
    a.ack_all().await;
    a.type_text("1").await;
    persisted(&mut a, "1").await;
    assert!(log_folded(&env, &material).await);
    assert_eq!(collected_window(&env, &material).await, 3);
    assert!(collected_in_base(&env, &material, y).await);
    assert!(logs.has(&["live document collected", &material]).await);
    let mut joined = tab(server.port, &room, &user).await;
    assert!(joined.settle(|c| c.block_text().contains("base")).await);
    assert!(collected_in(&joined.doc, y), "the open room collected y");
    let token = token(&room, &user, "write");
    let late = |grant: &str| {
        [
            ("x-capy-grants", grant.to_owned()),
            ("x-capy-version", "2".into()),
        ]
    };
    let headers = late(&named_grant);
    let headers: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let (status, answer) = send_drafts_over(
        server.port,
        &room,
        Some(&token),
        Some(ORIGIN),
        &headers,
        named,
    )
    .await;
    assert_eq!(
        (status, answer["class"].as_str()),
        (409, Some("late")),
        "{answer}"
    );
    let line = "capy_collaboration_draft_refusals_total{class=\"late\"} 1";
    let metrics = metrics_text(server.port).await;
    assert!(
        metrics.lines().any(|known| known == line),
        "{line} in {metrics}"
    );
    let headers = late(&clean_grant);
    let headers: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let (status, answer) = send_drafts_over(
        server.port,
        &room,
        Some(&token),
        Some(ORIGIN),
        &headers,
        clean,
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert!(a.settle(|c| c.block_text().contains('Q')).await);
    assert!(!a.block_text().contains('W'));
    for client in [&mut a, &mut joined] {
        client.leave(false).await;
    }
    wait_unloaded(server.port).await;
    let mut reloaded = tab(server.port, &room, &user).await;
    assert!(reloaded.settle(|c| c.block_text().contains('Q')).await);
    assert!(!reloaded.block_text().contains('W'));
}

/// Where an agent Undo meets a collection of the unit it names.
#[derive(Clone, Copy, PartialEq)]
enum UndoRoom {
    /// No room loaded: the stored document is checked (`apply_payload`).
    Unloaded,
    /// The open room, told of the fold that collected 3 s after it
    /// committed (debug builds: a material whose id holds
    /// `capy-it-folded-later`), so it still holds the unit the stored base
    /// dropped: the stored check on the room path. (A refused live pass
    /// drain-closes the room since Q449.)
    FoldedLater,
    /// The open room, collecting between the Undo's snapshot and its
    /// admission (debug builds: `capy-it-slow-compute` computes 3 s late):
    /// the room's check at admission.
    CollectedMeanwhile,
}

/// Q419 (Undo's collected-names check): an agent step deletes three items,
/// the middle one named by nothing; its agent holds then cannot be read, so
/// a fold drops them (Q386) and collects the middle item. The step's Undo,
/// which names it, is refused `undo_unavailable` wherever the collection
/// meets it, and a reload shows the note as it was: never a partial restore.
/// Each case fails with its own check removed.
async fn an_undo_naming_a_collected_unit_is_refused(case: UndoRoom) {
    let Some(env) = env() else { return };
    let (server, logs) = start_logged_with(
        &env,
        &[
            ("COLLABORATION_GC_COLLECT", "true"),
            ("COLLABORATION_FOLD_MAX_ROWS", "1"),
        ],
    )
    .await;
    let prefix = match case {
        UndoRoom::Unloaded => "m_it",
        UndoRoom::FoldedLater => "capy-it-folded-later",
        UndoRoom::CollectedMeanwhile => "capy-it-slow-compute",
    };
    let (user, material) = note_named(&env, "base", prefix).await;
    let room = format!("material:{material}:schema:1");
    // A fold that discarded units (contributor markers too) tells the room
    // 3 s late in the FoldedLater case: a store meanwhile starts no fold, so
    // each waits that out but the last.
    let told = || async {
        if case == UndoRoom::FoldedLater {
            tokio::time::sleep(Duration::from_millis(3500)).await;
        }
    };
    let mut a = tab(server.port, &room, &user).await;
    let mut middle = None;
    let mut writers = Vec::new();
    for (at, letter, before) in [(4, "a", "base"), (5, "c", "basea"), (5, "b", "baseac")] {
        let mut writer = tab(server.port, &room, &user).await;
        assert!(writer.settle(|c| c.block_text() == before).await);
        writer.type_at(at, letter).await;
        persisted(&mut writer, letter).await;
        assert!(log_folded(&env, &material).await);
        told().await;
        writer.leave(false).await;
        middle = Some(yrs::ID::new(writer.doc.client_id(), 0));
        writers.push(writer);
    }
    let middle = middle.expect("the middle letter");
    assert!(a.settle(|c| c.block_text() == "baseabc").await);
    a.ack_all().await;
    let (edit, undo) = (format!("e_{material}"), format!("u_{material}"));
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &serde_json::json!({
            "actorUserId": user,
            "commands": [{ "type": "replace_text", "blockId": "b1", "expectedText": "abc", "text": "Z" }],
            "operation": { "id": edit, "requestHash": edit },
            "room": room,
            "target": { "id": material, "kind": "material" },
        }),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert!(a.settle(|c| c.block_text() == "baseZ").await);
    assert!(log_folded(&env, &material).await);
    told().await;
    db(&env)
        .await
        .execute(
            "UPDATE material_yjs_documents SET agent_held='	'::bytea WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("unreadable agent holds");
    let port = server.port;
    let request = undo_step(&user, &undo, &material, &receipt);
    let sent = (case == UndoRoom::CollectedMeanwhile).then(|| {
        let request = request.clone();
        tokio::spawn(async move { internal(port, "/internal/documents/undo", &request).await })
    });
    for mark in ["!", "?"] {
        a.type_at(0, mark).await;
        persisted(&mut a, mark).await;
        assert!(log_folded(&env, &material).await);
        a.ack_all().await;
        if mark == "!" {
            told().await;
        }
    }
    assert!(
        collected_in_base(&env, &material, middle).await,
        "the fold collected the middle letter"
    );
    let live = ["live document collected", material.as_str()];
    if case == UndoRoom::FoldedLater {
        assert_eq!(logs.count(&live), 0, "the open room holds the unit");
    } else {
        assert!(logs.has(&live).await, "the open room collected the unit");
    }
    if case == UndoRoom::Unloaded {
        a.leave(false).await;
        wait_unloaded(server.port).await;
    }
    let (status, refusal) = match sent {
        Some(sent) => sent.await.expect("undo"),
        None => internal(server.port, "/internal/documents/undo", &request).await,
    };
    assert_eq!(
        (status, refusal["code"].as_str()),
        (409, Some("undo_unavailable")),
        "{refusal}"
    );
    if case == UndoRoom::FoldedLater {
        assert!(logs.has(&live).await, "the open room collects once told");
    }
    if case != UndoRoom::Unloaded {
        drop(a);
        wait_unloaded(server.port).await;
    }
    let mut fresh = Client::open(server.port).await;
    fresh.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        fresh.settle(|c| c.block_text() == "?!baseZ").await,
        "{}",
        fresh.block_text()
    );
}

#[tokio::test]
async fn an_undo_naming_a_collected_unit_is_refused_with_no_room() {
    an_undo_naming_a_collected_unit_is_refused(UndoRoom::Unloaded).await;
}

#[tokio::test]
async fn an_undo_naming_a_collected_unit_is_refused_when_collected_after_its_snapshot() {
    an_undo_naming_a_collected_unit_is_refused(UndoRoom::CollectedMeanwhile).await;
}

#[tokio::test]
async fn an_undo_naming_a_collected_unit_is_refused_before_its_room_collects() {
    an_undo_naming_a_collected_unit_is_refused(UndoRoom::FoldedLater).await;
}

/// A fold collects only while no other life of its room is loaded (debug
/// builds: the folds of a material whose id holds `capy-it-fold-later` wait
/// 2 s first): an unload fold running after the next room loaded folds
/// uncollected, since that room checks JOINs against the window it loaded;
/// the next room's own unload fold collects. Fails if the late fold collects
/// anyway (the stored window then passes the one the loaded room holds).
#[tokio::test]
async fn a_fold_collects_nothing_while_a_later_room_life_is_loaded() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[]).await;
    let (user, material) = note_named(&env, "base", "capy-it-fold-later").await;
    let room = format!("material:{material}:schema:1");
    let mut a = tab(server.port, &room, &user).await;
    assert!(a.settle(|c| c.block_text() == "base").await);
    // "xz", then "y" typed between: an item nothing names.
    a.write(|doc| {
        insert_unsent(doc, 4, "xz");
        insert_unsent(doc, 5, "y");
    })
    .await;
    persisted(&mut a, "typed").await;
    let y = a.unit_at(5);
    a.write(|doc| remove_as(doc, "a", 4, 3)).await;
    persisted(&mut a, "cut").await;
    a.leave(false).await;
    // The room unloads; its fold waits while the next room loads.
    wait_unloaded(server.port).await;
    let mut b = tab(server.port, &room, &user).await;
    assert!(b.settle(|c| c.block_text() == "base").await);
    assert!(log_folded(&env, &material).await);
    assert!(!collected_in_base(&env, &material, y).await);
    assert_eq!(collected_window(&env, &material).await, 0);
    // That room's own unload fold collects.
    b.type_at(0, "!").await;
    persisted(&mut b, "bang").await;
    b.leave(false).await;
    wait_unloaded(server.port).await;
    assert!(log_folded(&env, &material).await);
    assert!(collected_in_base(&env, &material, y).await);
    assert!(collected_window(&env, &material).await > 0);
}

/// A note whose id holds `capy-it-store-later` (debug builds: every store
/// waits 3 s): an ended session's run "xyz" with a closed tab's draft group
/// typed inside it before the cut ("D" after x, naming y), and a tab A
/// counted at the cut's version.
/// Debug builds only: a server edit of a material whose id holds this
/// reaches its open room 3 s after its row committed (a gap, audit B1).
const SERVICE_LATER: &str = "capy-it-service-later";

/// A second block, which a replace-block server edit then replaces.
fn second_block(text: &str) -> serde_json::Value {
    serde_json::json!({ "type": "p", "id": "second", "children": [{ "text": text }] })
}

/// Replaces the second block's "second" with "SECOND" by a replace-block
/// server edit (sent to the open room as a service edit), in a task:
/// (status, answer).
fn replace_second(
    port: u16,
    owner: &str,
    material: &str,
    room: &str,
) -> tokio::task::JoinHandle<(u16, serde_json::Value)> {
    let command = serde_json::json!({
        "actorUserId": owner,
        "expectedBlock": second_block("second"),
        "materialId": material,
        "replacementBlock": second_block("SECOND"),
        "room": room,
        "type": "replace-block",
    });
    tokio::spawn(async move { internal(port, "/internal/commands", &command).await })
}

/// A note holding "base" and the second block, whose material id starts
/// with `prefix`.
async fn note_with_second(env: &Env, prefix: &str) -> (String, String) {
    let (user, material) = note_named(env, "base", prefix).await;
    let content = serde_json::json!({
        "schemaVersion": 1,
        "value": [
            { "type": "p", "id": "b1", "children": [{ "text": "base" }] },
            second_block("second"),
        ],
    });
    db(env)
        .await
        .execute(
            "UPDATE materials SET content=$2 WHERE id=$1",
            &[&material, &content],
        )
        .await
        .expect("second block");
    (user, material)
}

/// Whether the room holds the second block as `text`.
fn second_reads(client: &Client, text: &str) -> bool {
    client.block("second") == Some(second_block(text))
}

/// A material's log rows not folded yet.
async fn log_rows(env: &Env, material: &str) -> i32 {
    db(env)
        .await
        .query_one(
            "SELECT log_rows FROM material_yjs_documents WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("row")
        .get(0)
}

/// Waits up to 3 s for a material's stored version to pass `before`.
async fn stored_past_version(env: &Env, material: &str, before: i64) -> i64 {
    for _ in 0..30 {
        let now = stored_version(env, material).await;
        if now > before {
            return now;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    stored_version(env, material).await
}

struct DraftInCut {
    user: String,
    material: String,
    room: String,
    a: Client,
    /// The group, the stored token that grants its id, and its version.
    group: Vec<u8>,
    grant: String,
    version: i64,
    /// The run's middle letter, which the group names.
    y: yrs::ID,
}

async fn draft_in_a_cut(env: &Env, server: &Server) -> DraftInCut {
    draft_in_a_cut_named(env, server, "capy-it-store-later").await
}

/// [draft_in_a_cut] on a material whose id starts with `prefix`; one a
/// service edit replaces into (`SERVICE_LATER`) holds the second block too.
async fn draft_in_a_cut_named(env: &Env, server: &Server, prefix: &str) -> DraftInCut {
    let (user, material) = if prefix.contains(SERVICE_LATER) {
        note_with_second(env, prefix).await
    } else {
        note_named(env, "base", prefix).await
    };
    let room = format!("material:{material}:schema:1");
    let mut a = tab(server.port, &room, &user).await;
    let mut b = tab(server.port, &room, &user).await;
    assert!(b.settle(|c| c.block_text() == "base").await);
    // "xz", then "y" typed between: an item nothing names.
    b.write(|doc| {
        insert_unsent(doc, 4, "xz");
        insert_unsent(doc, 5, "y");
    })
    .await;
    persisted(&mut b, "typed").await;
    assert!(log_folded(env, &material).await);
    let y = b.unit_at(5);
    let mut d = tab(server.port, &room, &user).await;
    assert!(d.settle(|c| c.block_text() == "basexyz").await);
    let version = stored_version(env, &material).await;
    let id = d.doc.client_id().get();
    let group = drafted(&d.doc, |doc| insert_unsent(doc, 5, "D"));
    d.leave(false).await;
    // B cuts the letters and leaves: nothing holds them. A acknowledges.
    b.write(|doc| remove_as(doc, "b", 4, 3)).await;
    persisted(&mut b, "cut").await;
    assert!(log_folded(env, &material).await);
    b.leave(false).await;
    assert!(a.settle(|c| c.block_text() == "base").await);
    a.ack_all().await;
    DraftInCut {
        grant: token_offering(&room, &user, "write", id),
        user,
        material,
        room,
        a,
        group,
        version,
        y,
    }
}

/// Sends the closed tab's group as the sweep does: (status, answer).
fn send_group(
    port: u16,
    cut: &DraftInCut,
) -> impl Future<Output = (u16, serde_json::Value)> + use<> {
    let (room, write) = (cut.room.clone(), token(&cut.room, &cut.user, "write"));
    let (grant, version, group) = (
        cut.grant.clone(),
        cut.version.to_string(),
        cut.group.clone(),
    );
    async move {
        send_drafts_over(
            port,
            &room,
            Some(&write),
            Some(ORIGIN),
            &[("x-capy-grants", &grant), ("x-capy-version", &version)],
            group,
        )
        .await
    }
}

/// After the group's store: the run's middle letter was never collected, and
/// once the room unloads a fresh load shows `text`, the group's "D" in it.
async fn the_group_survives(env: &Env, server: &Server, cut: DraftInCut, text: &str) {
    assert!(log_folded(env, &cut.material).await);
    assert!(
        !collected_in_base(env, &cut.material, cut.y).await,
        "a fold collected a letter the unstored group names"
    );
    drop(cut.a);
    wait_unloaded(server.port).await;
    let mut fresh = Client::open(server.port).await;
    fresh
        .joined(&cut.room, &token(&cut.room, &cut.user, "write"))
        .await;
    assert!(
        fresh.settle(|c| c.block_text() == text).await,
        "{}",
        fresh.block_text()
    );
}

/// Q400 (review r3 M1): a fold never collects past a draft group the room
/// admitted but has not stored. A's store waits 3 s; the closed tab's group
/// arrives meanwhile, so its row comes after that store's. That store's fold
/// must keep the letter the group names: the room counts no session for the
/// group, and A acknowledged the cut. Fails if the floor is not kept (the
/// fold collects y and a reload loses the group's "D").
#[tokio::test]
async fn a_draft_group_admitted_during_a_store_holds_that_stores_fold_back() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[("COLLABORATION_FOLD_MAX_ROWS", "1")]).await;
    let mut cut = draft_in_a_cut(&env, &server).await;
    cut.a.type_at(0, "!").await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let (status, answer) = send_group(server.port, &cut).await;
    assert_eq!(status, 200, "{answer}");
    the_group_survives(&env, &server, cut, "!baseD").await;
}

/// The draft floor holds back a service edit's fold too (audit A1). A
/// server edit (a replace-block) computes against the room's live state, so
/// its row carries every group the room admitted before it; the race is a
/// group admitted after the edit read that state and before the edit
/// reaches the room (debug builds: a material whose id holds
/// `capy-it-service-later` hears of a server edit 3 s after its row
/// committed). The group's own store waits 3 s, so the edit's fold comes
/// first, and must not collect past the group. Fails if the floor is not
/// kept, or is consulted only after the room's own stores.
#[tokio::test]
async fn a_draft_group_holds_back_a_service_edits_fold() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[("COLLABORATION_FOLD_MAX_ROWS", "1")]).await;
    if env.api.is_none() {
        return;
    }
    let mut cut = draft_in_a_cut_named(
        &env,
        &server,
        &format!("capy-it-store-later-{SERVICE_LATER}"),
    )
    .await;
    let before = stored_version(&env, &cut.material).await;
    let edit = replace_second(server.port, &cut.user, &cut.material, &cut.room);
    assert_eq!(
        stored_past_version(&env, &cut.material, before).await,
        before + 1
    );
    // The edit's row committed; its room hears of it in 3 s. The group
    // arrives a second later, and its store commits a second after that.
    tokio::time::sleep(Duration::from_secs(1)).await;
    let sent = tokio::spawn(send_group(server.port, &cut));
    let (status, answer) = edit.await.expect("edit");
    assert_eq!(status, 200, "{answer}");
    let (status, answer) = sent.await.expect("sent");
    assert_eq!(status, 200, "{answer}");
    assert!(cut.a.settle(|c| second_reads(c, "SECOND")).await);
    the_group_survives(&env, &server, cut, "baseD").await;
}

/// Audit B1 with Q419: a room never folds while a committed row has not
/// reached it. A replace-block reaches the room only 3 s after its row
/// committed (debug builds: a material whose id holds
/// `capy-it-service-later`); a closed tab's group stored meanwhile commits
/// after it, a gap the room's stored version skips. With no session counted
/// (a viewer keeps the room open), nothing folds while the gap is open; once
/// the row arrives the room folds every stored row, and a reload shows both
/// edits. Fails if a fold runs while the room lacks the row.
#[tokio::test]
async fn a_fold_stops_before_a_row_the_open_room_has_not_applied() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[("COLLABORATION_FOLD_MAX_ROWS", "1")]).await;
    if env.api.is_none() {
        return;
    }
    let (owner, material) = note_with_second(&env, SERVICE_LATER).await;
    let room = format!("material:{material}:schema:1");
    db(&env)
        .await
        .execute(
            "UPDATE materials SET privacy='link' WHERE id=$1",
            &[&material],
        )
        .await
        .expect("link share");
    let reader = user(&env).await;
    redeem(&env, &material, &reader).await;
    let mut viewer = Client::open(server.port).await;
    viewer.joined(&room, &token(&room, &reader, "read")).await;
    assert!(viewer.settle(|c| second_reads(c, "second")).await);
    let before = stored_version(&env, &material).await;
    let edit = replace_second(server.port, &owner, &material, &room);
    assert_eq!(
        stored_past_version(&env, &material, before).await,
        before + 1
    );
    // A closed tab's group, typed at the start, is stored after that row.
    let id = fresh_client_id();
    let from = Doc::with_options(ydoc::doc_options(id));
    from.transact_mut()
        .apply_update(
            Update::decode_v1(
                &viewer
                    .doc
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default()),
            )
            .expect("state"),
        )
        .expect("apply");
    let (status, answer) = send_drafts_over(
        server.port,
        &room,
        Some(&token(&room, &owner, "write")),
        Some(ORIGIN),
        &[
            ("x-capy-grants", &token_offering(&room, &owner, "write", id)),
            ("x-capy-version", &before.to_string()),
        ],
        drafted(&from, |doc| insert_unsent(doc, 0, "!")),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    // The group's store committed behind the gap: no fold until the row.
    assert_eq!(stored_version(&env, &material).await, before + 2);
    assert!(
        log_rows(&env, &material).await > 0,
        "a fold ran while the room lacked a committed row"
    );
    let (status, answer) = edit.await.expect("edit");
    assert_eq!(status, 200, "{answer}");
    assert!(viewer.settle(|c| second_reads(c, "SECOND")).await);
    assert!(viewer.settle(|c| c.block_text() == "!base").await);
    assert!(log_folded(&env, &material).await);
    drop(viewer);
    wait_unloaded(server.port).await;
    let mut fresh = Client::open(server.port).await;
    fresh.joined(&room, &token(&room, &owner, "write")).await;
    assert!(
        fresh
            .settle(|c| c.block_text() == "!base" && second_reads(c, "SECOND"))
            .await
    );
}

/// Q419 (review r4 M1): a store that commits behind a gap (a committed row
/// the room has not applied) clears the draft floor of the group it holds,
/// so no fold runs until the gap closes; the fold then takes that store's
/// row with the rest. A closed tab's group types "D" inside "xyz", which a
/// counted tab then cuts before it leaves, so no session counts (a viewer
/// keeps the room open). A replace-block of a second block commits a row the
/// room hears of 3 s later (debug builds: a material whose id holds
/// `capy-it-service-later`); the group, sent meanwhile, is stored behind it,
/// at the third row since the last fold. A reload shows "D". Fails if a
/// fold runs up to the gap (it collects y, which the group names, and its
/// row loads collected).
#[tokio::test]
async fn a_store_behind_a_gap_is_folded_with_the_gaps_row() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[("COLLABORATION_FOLD_MAX_ROWS", "3")]).await;
    if env.api.is_none() {
        return;
    }
    let (owner, material) = note_with_second(&env, SERVICE_LATER).await;
    let room = format!("material:{material}:schema:1");
    db(&env)
        .await
        .execute(
            "UPDATE materials SET privacy='link' WHERE id=$1",
            &[&material],
        )
        .await
        .expect("link share");
    let reader = user(&env).await;
    redeem(&env, &material, &reader).await;
    let mut viewer = Client::open(server.port).await;
    viewer.joined(&room, &token(&room, &reader, "read")).await;
    let mut b = tab(server.port, &room, &owner).await;
    assert!(b.settle(|c| c.block_text() == "base").await);
    b.write(|doc| {
        insert_unsent(doc, 4, "xz");
        insert_unsent(doc, 5, "y");
    })
    .await;
    persisted(&mut b, "typed").await;
    let y = b.unit_at(5);
    let mut d = tab(server.port, &room, &owner).await;
    assert!(d.settle(|c| c.block_text() == "basexyz").await);
    let version = stored_version(&env, &material).await;
    let id = d.doc.client_id().get();
    let group = drafted(&d.doc, |doc| insert_unsent(doc, 5, "D"));
    d.leave(false).await;
    b.write(|doc| remove_as(doc, "b", 4, 3)).await;
    persisted(&mut b, "cut").await;
    b.leave(false).await;
    assert!(viewer.settle(|c| c.block_text() == "base").await);
    let before = stored_version(&env, &material).await;
    let edit = replace_second(server.port, &owner, &material, &room);
    assert_eq!(
        stored_past_version(&env, &material, before).await,
        before + 1
    );
    let (status, answer) = send_drafts_over(
        server.port,
        &room,
        Some(&token(&room, &owner, "write")),
        Some(ORIGIN),
        &[
            ("x-capy-grants", &token_offering(&room, &owner, "write", id)),
            ("x-capy-version", &version.to_string()),
        ],
        group,
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let (status, answer) = edit.await.expect("edit");
    assert_eq!(status, 200, "{answer}");
    assert!(viewer.settle(|c| second_reads(c, "SECOND")).await);
    assert!(
        viewer.settle(|c| c.block_text() == "baseD").await,
        "{}",
        viewer.block_text()
    );
    // The edit's arrival folds every row, the group's store's among them.
    let folded = log_folded(&env, &material).await;
    drop(viewer);
    wait_unloaded(server.port).await;
    let mut fresh = Client::open(server.port).await;
    fresh.joined(&room, &token(&room, &owner, "write")).await;
    fresh.settle(|c| c.block_text() == "baseD").await;
    assert_eq!(
        (folded, fresh.block_text().as_str()),
        (true, "baseD"),
        "folded once the edit arrived; the reload's text"
    );
    assert!(!collected_in_base(&env, &material, y).await);
}

/// Q400 (review r3 L2): window snapshots are kept one per hour, the newest
/// of each, for the latest 25 hours that have one, so a fold reaches back to
/// a tab that acknowledged a version many folds ago. Each fold's snapshot is
/// moved an hour back before the next; once a lagging tab acknowledges the
/// cut's version, five folds later, the next fold collects at that version's
/// window. With thirty older snapshots (two in one hour) the fold keeps 25,
/// one per hour, the cut's among them. Fails if only the newest few are kept
/// (no window at the tab's version is left), or the per-hour or 25-hour rule
/// goes.
#[tokio::test]
async fn window_snapshots_are_kept_hourly_for_a_day() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[("COLLABORATION_FOLD_MAX_ROWS", "1")]).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let client = db(&env).await;
    // Every window stored so far moves an hour back.
    async fn an_hour_back(client: &tokio_postgres::Client, material: &str) {
        client
            .execute(
                "UPDATE material_yjs_windows SET created_at=created_at - interval '1 hour'
                 WHERE material_id=$1",
                &[&material],
            )
            .await
            .expect("an hour back");
    }
    // A lags: synced, it acknowledges nothing until told.
    let mut a = tab(server.port, &room, &user).await;
    let mut b = tab(server.port, &room, &user).await;
    assert!(b.settle(|c| c.block_text() == "base").await);
    b.write(|doc| {
        insert_unsent(doc, 4, "xz");
        insert_unsent(doc, 5, "y");
    })
    .await;
    persisted(&mut b, "typed").await;
    assert!(log_folded(&env, &material).await);
    let y = b.unit_at(5);
    b.write(|doc| remove_as(doc, "b", 4, 3)).await;
    persisted(&mut b, "cut").await;
    assert!(log_folded(&env, &material).await);
    b.leave(false).await;
    let cut = stored_version(&env, &material).await;
    an_hour_back(&client, &material).await;
    let mut c = tab(server.port, &room, &user).await;
    assert!(c.settle(|c| c.block_text() == "base").await);
    for mark in ["1", "2", "3", "4", "5"] {
        c.ack_all().await;
        c.type_at(0, mark).await;
        persisted(&mut c, mark).await;
        assert!(log_folded(&env, &material).await);
        an_hour_back(&client, &material).await;
    }
    assert!(!collected_in_base(&env, &material, y).await);
    a.ack_version(cut).await;
    c.ack_all().await;
    let empty = (
        StateVector::default().encode_v1(),
        yrs::IdSet::new().encode_v1(),
    );
    for k in 0i64..31 {
        let (version, hours) = (1_000_000 + k, if k == 30 { 10 } else { 10 + k });
        client
            .execute(
                "INSERT INTO material_yjs_windows
                   (material_id, document, stored_version, state_vector, delete_set, created_at)
                 VALUES ($1, 'content', $2, $3, $4, now() - make_interval(hours => $5::int))",
                &[&material, &version, &empty.0, &empty.1, &(hours as i32)],
            )
            .await
            .expect("an older window");
    }
    c.type_at(0, "6").await;
    persisted(&mut c, "6").await;
    assert!(log_folded(&env, &material).await);
    assert!(
        collected_in_base(&env, &material, y).await,
        "no window at the lagging tab's version was left"
    );
    assert_eq!(collected_window(&env, &material).await, cut);
    let kept = client
        .query_one(
            "SELECT count(*), count(DISTINCT date_trunc('hour', created_at)),
                    count(*) FILTER (WHERE stored_version=$2)
             FROM material_yjs_windows WHERE material_id=$1",
            &[&material, &cut],
        )
        .await
        .expect("windows");
    assert_eq!(
        (
            kept.get::<_, i64>(0),
            kept.get::<_, i64>(1),
            kept.get::<_, i64>(2)
        ),
        (25, 25, 1)
    );
}

/// Q400 (review r3 L1) and Q419: a fold collects nothing while another
/// collaboration process may be live: a heartbeat in the instance registry
/// that cannot be read, or another one within the last minute (the
/// collection requires one process per database). Each value is read on its
/// own, as the source handoff reads them, and each cause is logged (and
/// reported) once, tagged with the note. With such a heartbeat in the
/// server's registry, folds whose window holds an ended session's cut store
/// their windows but collect nothing; once it is gone, the next fold
/// collects. Fails if a fold ignores the other process, if one unreadable
/// value makes the whole registry unreadable, or if the cause goes unsaid,
/// is said at every fold or names no note.
#[tokio::test]
async fn a_fold_collects_nothing_while_another_process_may_be_live() {
    let Some(env) = env() else { return };
    let (server, logs) = start_logged_with(
        &env,
        &[
            ("COLLABORATION_GC_COLLECT", "true"),
            ("COLLABORATION_FOLD_MAX_ROWS", "1"),
        ],
    )
    .await;
    let mut redis = redis_at(&server.redis.as_ref().expect("its own database").url).await;
    let _: () = redis::AsyncCommands::hset(&mut redis, INSTANCE_REGISTRY, "it-other", "soon")
        .await
        .expect("heartbeat");
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let mut a = tab(server.port, &room, &user).await;
    let mut b = tab(server.port, &room, &user).await;
    assert!(b.settle(|c| c.block_text() == "base").await);
    b.write(|doc| {
        insert_unsent(doc, 4, "xz");
        insert_unsent(doc, 5, "y");
    })
    .await;
    persisted(&mut b, "typed").await;
    assert!(log_folded(&env, &material).await);
    let y = b.unit_at(5);
    b.write(|doc| remove_as(doc, "b", 4, 3)).await;
    persisted(&mut b, "cut").await;
    assert!(log_folded(&env, &material).await);
    b.leave(false).await;
    assert!(a.settle(|c| c.block_text() == "base").await);
    let now = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis() as u64
    };
    for (mark, cause) in [("!", "heartbeat unreadable"), ("?", "another process live")] {
        a.ack_all().await;
        a.type_at(0, mark).await;
        persisted(&mut a, mark).await;
        assert!(log_folded(&env, &material).await);
        // Tagged with the note whose fold saw it, as Sentry gets it.
        let file = format!("\"file_id\":\"{material}\"");
        assert!(
            logs.has(&["in-place collection withheld", cause, "it-other", &file])
                .await,
            "{cause}"
        );
        let _: () = redis::AsyncCommands::hset(&mut redis, INSTANCE_REGISTRY, "it-other", now())
            .await
            .expect("heartbeat");
    }
    // Three folds saw the unreadable heartbeat: said once.
    assert_eq!(
        logs.count(&["in-place collection withheld", "heartbeat unreadable"]),
        1
    );
    assert!(windows(&env, &material).await > 0);
    assert!(!collected_in_base(&env, &material, y).await);
    assert_eq!(collected_window(&env, &material).await, 0);
    let _: () = redis::AsyncCommands::hdel(&mut redis, INSTANCE_REGISTRY, "it-other")
        .await
        .expect("gone");
    a.ack_all().await;
    a.type_at(0, ".").await;
    persisted(&mut a, ".").await;
    assert!(log_folded(&env, &material).await);
    assert!(collected_in_base(&env, &material, y).await);
}

/// Item rooms keep their whole history (Q274: the collection covers notes
/// only): with the switch on and every store folding, a flashcard set's
/// folds store no window candidate and collect nothing. Fails if an item
/// room's fold takes holds.
#[tokio::test]
async fn item_rooms_fold_without_collecting() {
    let Some(env) = env() else { return };
    let server = start_collecting(&env, &[("COLLABORATION_FOLD_MAX_ROWS", "1")]).await;
    let owner = user(&env).await;
    let set = flashcard_set(&env, &owner, None, &[("c1", "front", "back")]).await;
    let room = format!("material:{set}:schema:1");
    let mut writer = Client::open(server.port).await;
    writer.joined(&room, &token(&room, &owner, "write")).await;
    assert!(writer.settle(|c| !c.cards().is_empty()).await);
    writer
        .write(|doc| {
            let face = card_face(doc, "c1", "front").expect("front");
            face.insert(&mut doc.transact_mut(), 5, "xyz");
        })
        .await;
    persisted(&mut writer, "typed").await;
    assert!(log_folded(&env, &set).await);
    writer
        .write(|doc| {
            let face = card_face(doc, "c1", "front").expect("front");
            face.remove_range(&mut doc.transact_mut(), 5, 3);
        })
        .await;
    persisted(&mut writer, "cut").await;
    assert!(log_folded(&env, &set).await);
    writer.leave(false).await;
    wait_unloaded(server.port).await;
    assert_eq!(windows(&env, &set).await, 0);
    assert_eq!(collected_window(&env, &set).await, 0);
}

/// A stop (SIGTERM, what Docker sends before the compose file's 60 s grace
/// period) stores every room's unsaved edits before the process exits: a new
/// server opens the room with the typed text. The debounce here is a minute,
/// so only the stop's flush can store the edit; fails if the server exits
/// without it.
#[cfg(unix)]
#[tokio::test]
async fn a_stop_stores_each_rooms_unsaved_edits_before_exiting() {
    let Some(env) = env() else { return };
    let mut server = start_configured(
        &env,
        env.api.as_deref(),
        &[
            ("COLLABORATION_DEBOUNCE_MS", "60000"),
            ("COLLABORATION_MAX_DEBOUNCE_MS", "60000"),
        ],
    )
    .await;
    let (user, room, mut client) = writer(&env, server.port, "kept").await;
    client.type_text(" too").await;
    client.until(6).await.expect("ack");
    // Its heartbeat, under an id starting with its process id (Q419).
    async fn beating(url: &str, pid: u32) -> bool {
        let mut redis = redis_at(url).await;
        let ids: Vec<String> = redis::AsyncCommands::hkeys(&mut redis, INSTANCE_REGISTRY)
            .await
            .expect("registry");
        ids.iter().any(|id| id.starts_with(&format!("{pid}-")))
    }
    let pid = server.child.id();
    assert!(beating(&env.redis, pid).await);
    let signalled = Command::new("kill")
        .args(["-TERM", &server.child.id().to_string()])
        .status()
        .expect("kill");
    assert!(signalled.success());
    let mut exited = false;
    for _ in 0..300 {
        if server
            .child
            .try_wait()
            .expect("the server's status")
            .is_some()
        {
            exited = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(exited, "the server did not stop");
    assert!(
        !beating(&env.redis, pid).await,
        "the stopped server's heartbeat stayed"
    );
    let again = start(&env).await;
    let mut reader = Client::open(again.port).await;
    reader.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        reader.settle(|c| c.block_text() == "kept too").await,
        "{}",
        reader.block_text()
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

/// The version gate: a JOIN or draft send without the client protocol (a tab
/// from before the gate), below its family's minimum (`MIN_MATERIAL`,
/// `MIN_SOURCE`, read from `protocol.rs`) or above the server's own (a
/// rollback) is refused as `collaboration-outdated` before any lookup; the
/// family's minimum itself still joins a material room. A refused draft send
/// stores nothing and is counted by family.
#[tokio::test]
async fn a_client_outside_the_protocol_range_is_refused_as_outdated() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let write = token(&room, &user, "write");
    let mut client = Client::open(server.port).await;
    for protocol in [
        None,
        Some(protocol_constant("MIN_MATERIAL") - 1),
        Some(client_protocol() + 1),
    ] {
        client.send(0, &join_payload(&room, &write, protocol)).await;
        let reason = text_payload(&client.until(2).await.expect("refused"));
        assert_eq!(reason, "collaboration-outdated", "{protocol:?}");
    }
    // Before the gateway is asked about a file it does not know.
    let source = "source:file_outdated:epoch:1";
    for protocol in [None, Some(protocol_constant("MIN_SOURCE") - 1)] {
        client
            .send(
                0,
                &join_payload(source, &token(source, &user, "write"), protocol),
            )
            .await;
        let reason = text_payload(&client.until(2).await.expect("refused"));
        assert_eq!(reason, "collaboration-outdated", "{protocol:?}");
    }
    let mut previous = Client::open(server.port).await;
    let protocol = protocol_constant("MIN_MATERIAL");
    previous
        .send(0, &join_payload(&room, &write, Some(protocol)))
        .await;
    let material_refusals = if protocol >= protocol_constant("MIN_MATERIAL") {
        assert!(
            previous.until(1).await.is_some(),
            "protocol {protocol} joins a material room"
        );
        4
    } else {
        let reason = text_payload(&previous.until(2).await.expect("refused"));
        assert_eq!(reason, "collaboration-outdated", "protocol {protocol}");
        5
    };
    // The current protocol joins.
    assert_eq!(client.joined(&room, &write).await, 1);
    assert!(client.settle(|c| c.block_text() == "base").await);

    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{}/drafts", server.port))
        .header("content-type", "application/octet-stream")
        .header("x-capy-room", &room)
        .header("origin", ORIGIN)
        .bearer_auth(&write)
        .body(drafted(&client.doc, typed_into_note(" stale")))
        .send()
        .await
        .expect("draft send");
    assert_eq!(response.status().as_u16(), 426);
    assert_eq!(
        response.json::<serde_json::Value>().await.expect("answer"),
        serde_json::json!({ "class": "outdated" })
    );
    assert!(
        !client.settle(|c| c.block_text() != "base").await,
        "the refused send reached the room: {}",
        client.block_text()
    );
    let metrics = metrics_text(server.port).await;
    for line in [
        format!(
            "capy_collaboration_outdated_refusals_total{{family=\"material\"}} {material_refusals}"
        ),
        "capy_collaboration_outdated_refusals_total{family=\"source\"} 2".to_owned(),
        "capy_collaboration_draft_refusals_total{class=\"outdated\"} 1".to_owned(),
    ] {
        assert!(
            metrics.lines().any(|known| known == line),
            "{line} in {metrics}"
        );
    }
}

/// Security regression (Epo 2026-10-16): a suspended owner's note is not
/// found for a reader or a workspace editor, as a deleted owner's is, even
/// with tokens minted before the suspension, while the owner joining is
/// refused as a locked account (their drafts kept). Fails if the room still
/// admits the others, or answers the owner not found.
#[tokio::test]
async fn a_suspended_owners_note_is_not_found_for_its_readers() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let client = db(&env).await;
    let (owner, editor, reader) = (user(&env).await, user(&env).await, user(&env).await);
    let workspace = format!("ws_it_{}", uuid_like());
    client
        .execute(
            "INSERT INTO workspaces (id,user_id,name,privacy) VALUES ($1,$2,'IT','public')",
            &[&workspace, &owner],
        )
        .await
        .expect("workspace");
    client
        .execute(
            "INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor')",
            &[&workspace, &editor],
        )
        .await
        .expect("member");
    let material = format!("m_it_{}", uuid_like());
    let content = serde_json::json!({
        "schemaVersion": 1,
        "value": [{ "type": "p", "id": "b1", "children": [{ "text": "shared" }] }],
    });
    client
        .execute(
            "INSERT INTO materials (id, created_by, workspace_id, workspace_name, kind, title, content) VALUES ($1, $2, $3, 'IT', 'note', 'IT', $4)",
            &[&material, &owner, &workspace, &content],
        )
        .await
        .expect("material");
    let room = format!("material:{material}:schema:1");
    let read = token(&room, &reader, "read");
    let write = token(&room, &editor, "write");
    let mut before = Client::open(server.port).await;
    assert_eq!(before.joined(&room, &read).await, 0);
    let mut writer = Client::open(server.port).await;
    assert_eq!(writer.joined(&room, &write).await, 1);
    client
        .execute(
            "UPDATE users SET suspended_at=now(), suspended_reason='it' WHERE id=$1",
            &[&owner],
        )
        .await
        .expect("suspend");
    for (who, joining, want) in [
        ("reader", read, "collaboration-not-found"),
        ("editor", write, "collaboration-not-found"),
        (
            "owner",
            token(&room, &owner, "write"),
            "collaboration-forbidden",
        ),
    ] {
        let mut after = Client::open(server.port).await;
        after.join(&room, &joining).await;
        let reason = text_payload(&after.until(2).await.expect("refused"));
        assert_eq!(reason, want, "{who}");
    }
}

/// Security regression (uploader-pays review M4, N4): an agent edit charges
/// the note's payer (its creator), so it stops once only the payer is being
/// deleted, the workspace owner and the actor staying healthy. Fails if the
/// edit lands on the deleting payer.
#[tokio::test]
async fn an_agent_edit_stops_for_a_deleting_payer() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let client = db(&env).await;
    let (owner, payer) = (user(&env).await, user(&env).await);
    let workspace = format!("ws_it_{}", uuid_like());
    client
        .execute(
            "INSERT INTO workspaces (id,user_id,name) VALUES ($1,$2,'IT')",
            &[&workspace, &owner],
        )
        .await
        .expect("workspace");
    client
        .execute(
            "INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor')",
            &[&workspace, &payer],
        )
        .await
        .expect("member");
    let material = format!("m_it_{}", uuid_like());
    let content = serde_json::json!({
        "schemaVersion": 1,
        "value": [{ "type": "p", "id": "b1", "children": [{ "text": "hello world" }] }],
    });
    client
        .execute(
            "INSERT INTO materials (id, created_by, workspace_id, workspace_name, kind, title, content) VALUES ($1, $2, $3, 'IT', 'note', 'IT', $4)",
            &[&material, &payer, &workspace, &content],
        )
        .await
        .expect("material");
    let room = format!("material:{material}:schema:1");
    let edit = |id: &str, expected: &str, text: &str| {
        serde_json::json!({
            "actorUserId": owner,
            "commands": [{ "type": "replace_text", "blockId": "b1", "expectedText": expected, "text": text }],
            "operation": { "id": format!("{id}_{material}"), "requestHash": id, "toolVersion": 1 },
            "room": room,
            "target": { "id": material, "kind": "material" },
        })
    };
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &edit("op1", "world", "there"),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    // The deletion request holds the payer's row while the edit arrives: the
    // edit waits on that row (lock_boundary locks the payer), then sees the
    // payer locked. Without the lock it would land and charge the payer while
    // the deletion commits.
    let deleting = db(&env).await;
    deleting.batch_execute("BEGIN").await.expect("begin");
    deleting
        .execute(
            "UPDATE users SET deletion_requested_at=now(), purge_after=now()+interval '30 days' WHERE id=$1",
            &[&payer],
        )
        .await
        .expect("deletion");
    let late = edit("op2", "there", "again");
    let port = server.port;
    let edited =
        tokio::spawn(async move { internal(port, "/internal/documents/edit", &late).await });
    tokio::time::sleep(Duration::from_millis(500)).await;
    deleting.batch_execute("COMMIT").await.expect("commit");
    let (status, refusal) = edited.await.expect("edit");
    assert_ne!(status, 200, "{refusal}");
    let landed: i64 = client
        .query_one(
            "SELECT count(*) FROM agent_operations WHERE id=$1",
            &[&format!("op2_{material}")],
        )
        .await
        .expect("receipts")
        .get(0);
    assert_eq!(landed, 0, "the late edit left no receipt");
}

/// `viewer` presented the link of a link-shared standalone material once
/// (POST /api/share/redeem): a link reaches a signed-in nonmember only then
/// (Sam 2026-10-18).
async fn redeem(env: &Env, material: &str, viewer: &str) {
    db(env)
        .await
        .execute(
            "INSERT INTO material_link_grants (material_id, user_id) VALUES ($1, $2)",
            &[&material, &viewer],
        )
        .await
        .expect("link grant");
}

/// Security regression (uploader-pays review N4, B5): a locked owner, payer or
/// actor refuses an agent edit before it waits on the material row, which a
/// purge of that account holds while it waits on the account's row. With the
/// material row held elsewhere, the refusal still answers at once. Fails if the
/// check moves after the material lock (the edit would wait for the holder).
#[tokio::test]
async fn a_locked_account_refuses_before_the_material_lock() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let client = db(&env).await;
    for locked in ["payer", "actor"] {
        let (owner, payer, editor) = (user(&env).await, user(&env).await, user(&env).await);
        let workspace = format!("ws_it_{}", uuid_like());
        client
            .execute(
                "INSERT INTO workspaces (id,user_id,name) VALUES ($1,$2,'IT')",
                &[&workspace, &owner],
            )
            .await
            .expect("workspace");
        client
            .execute(
                "INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor'),($1,$3,'editor')",
                &[&workspace, &payer, &editor],
            )
            .await
            .expect("members");
        let material = format!("m_it_{}", uuid_like());
        let content = serde_json::json!({
            "schemaVersion": 1,
            "value": [{ "type": "p", "id": "b1", "children": [{ "text": "hello world" }] }],
        });
        client
            .execute(
                "INSERT INTO materials (id, created_by, workspace_id, workspace_name, kind, title, content) VALUES ($1, $2, $3, 'IT', 'note', 'IT', $4)",
                &[&material, &payer, &workspace, &content],
            )
            .await
            .expect("material");
        let account = if locked == "payer" { &payer } else { &editor };
        client
            .execute(
                "UPDATE users SET deletion_requested_at=now(), purge_after=now()+interval '30 days' WHERE id=$1",
                &[account],
            )
            .await
            .expect("deletion");
        let holder = db(&env).await;
        holder.batch_execute("BEGIN").await.expect("begin");
        holder
            .execute(
                "SELECT 1 FROM materials WHERE id=$1 FOR UPDATE",
                &[&material],
            )
            .await
            .expect("hold the material");
        let edit = serde_json::json!({
            "actorUserId": editor,
            "commands": [{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "there" }],
            "operation": { "id": format!("op_{material}"), "requestHash": "h", "toolVersion": 1 },
            "room": format!("material:{material}:schema:1"),
            "target": { "id": material, "kind": "material" },
        });
        let answered = tokio::time::timeout(
            Duration::from_secs(5),
            internal(server.port, "/internal/documents/edit", &edit),
        )
        .await;
        holder.batch_execute("ROLLBACK").await.expect("release");
        let (status, refusal) =
            answered.unwrap_or_else(|_| panic!("{locked}: the edit waited on the material"));
        assert_ne!(status, 200, "{locked}: {refusal}");
    }
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

/// Decision 5 (Epo 2026-10-13): a stored note holding a block the embed
/// catalog does not list stays readable while no writer edits it. A writer
/// joins read-only and hears why (`room-read-only` with the code the browser
/// shows), a draft and an update from it are refused, and a reader reads the
/// note. Fails if the room loads such a note writable.
#[tokio::test]
async fn a_note_holding_a_block_this_version_cannot_edit_loads_read_only() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "kept").await;
    let content = serde_json::json!({ "schemaVersion": 1, "value": [
        { "type": "p", "id": "b1", "children": [{ "text": "kept" }] },
        { "type": "toggle", "id": "t1", "children": [{ "text": "Later" }] },
    ] });
    db(&env)
        .await
        .execute(
            "UPDATE materials SET content = $2 WHERE id = $1",
            &[&material, &content],
        )
        .await
        .expect("content");
    let room = format!("material:{material}:schema:1");
    let write = token(&room, &user, "write");
    let mut writer = Client::open(server.port).await;
    assert_eq!(writer.joined(&room, &write).await, 0);
    let (notice, _) = writer.stateless("room-read-only").await;
    assert_eq!(notice["code"], "unsupported_block", "{notice}");
    assert!(writer.settle(|c| c.block_text() == "kept").await);
    let (status, answer) = send_drafts(
        server.port,
        &room,
        Some(&write),
        Some(ORIGIN),
        drafted(&writer.doc, typed_into_note("!")),
    )
    .await;
    assert_eq!(answer["class"], "permission", "{status} {answer}");
    writer.type_text("!").await;
    let closed = writer.until(4).await.expect("closed");
    assert!(String::from_utf8_lossy(&closed).contains("read-only"));
    let mut reader = Client::open(server.port).await;
    assert_eq!(reader.joined(&room, &token(&room, &user, "read")).await, 0);
    assert!(reader.settle(|c| c.block_text() == "kept").await);
}

/// Security regression (live-items REVIEW5, now failing closed as Go does):
/// a stored note whose reference still carries an imported fence body (the
/// quiz's answer keys) is never served. A reader's join is refused and no
/// frame it receives holds the body. Fails if the room strips nothing and
/// loads it.
#[tokio::test]
async fn a_stored_fence_body_is_never_served() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "kept").await;
    let content = serde_json::json!({ "schemaVersion": 1, "value": [
        { "type": "p", "id": "b1", "children": [{ "text": "kept" }] },
        { "type": "material_ref", "id": "f1", "materialId": "", "refKind": "quiz",
          "pending": "answer: SECRET-KEY", "children": [{ "text": "" }] },
    ] });
    db(&env)
        .await
        .execute(
            "UPDATE materials SET content = $2 WHERE id = $1",
            &[&material, &content],
        )
        .await
        .expect("content");
    let room = format!("material:{material}:schema:1");
    let mut reader = Client::open(server.port).await;
    reader.join(&room, &token(&room, &user, "read")).await;
    assert!(reader.until(2).await.is_some(), "the join is refused");
    assert!(
        !String::from_utf8_lossy(&reader.received).contains("SECRET-KEY"),
        "a frame holds the fence body"
    );
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

/// One struct under `client` (the writer's own id, from its first clock)
/// after a unit no one holds: an update the room cannot place.
fn unplaceable(client: u64) -> Vec<u8> {
    use yrs::encoding::write::Write;
    let mut update: Vec<u8> = Vec::new();
    update.write_var(1u32);
    update.write_var(1u32);
    update.write_var(client);
    update.write_var(0u32);
    update.write_u8(0x80 | 4);
    update.write_var(998u64);
    update.write_var(3u32);
    update.write_string("x");
    update.write_var(0u32);
    update
}

/// Security regression (edit-incidents REVIEW2 m-A): a client whose sync
/// step 2 the room cannot place is closed after two tries, and the incident
/// is written once per user and room, however often it reconnects.
#[tokio::test]
async fn an_unplaceable_step_2_is_recorded_once_per_user_and_room() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "placed").await;
    let room = format!("material:{material}:schema:1");
    for _ in 0..3 {
        let mut client = Client::open(server.port).await;
        client.joined(&room, &token(&room, &user, "write")).await;
        let unplaceable = unplaceable(client.id());
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

/// A panic discards the room and moves its lineage; the old lineage's
/// sessions end with it (review r2 L3: their tabs never rejoin the new one).
#[tokio::test]
async fn a_panic_inside_a_transaction_discards_the_room_and_moves_its_lineage() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "xdurable").await;
    let room = format!("material:{material}:schema:1");
    let mut a = Client::open(server.port).await;
    a.joined(&room, &token(&room, &user, "write")).await;
    assert!(a.settle(|c| c.block_text() == "xdurable").await);
    let answered = a.stored_past(0).await;
    a.delete_in_block(0, 1, true).await;
    a.stored_past(answered).await;
    assert!(session_row(&env, &material, a.id()).await.1);
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
    let (_, seen, held) = session_row(&env, &material, a.id()).await;
    assert_eq!((seen, held.is_empty()), (false, true));
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

/// A small update allowance (40 messages, then 20 a second; the 8 MiB byte
/// burst, refilled 1 byte a second), so a test can spend it.
const SMALL_ALLOWANCE: [(&str, &str); 4] = [
    ("COLLABORATION_UPDATE_BURST", "40"),
    ("COLLABORATION_UPDATES_PER_SECOND", "20"),
    ("COLLABORATION_UPDATE_BURST_BYTES", "8388608"),
    ("COLLABORATION_UPDATE_BYTES_PER_SECOND", "1"),
];

/// The same burst refilled one message a second: what a test spent stays
/// spent for its few seconds.
const SLOW_ALLOWANCE: [(&str, &str); 4] = [
    ("COLLABORATION_UPDATE_BURST", "40"),
    ("COLLABORATION_UPDATES_PER_SECOND", "1"),
    ("COLLABORATION_UPDATE_BURST_BYTES", "8388608"),
    ("COLLABORATION_UPDATE_BYTES_PER_SECOND", "1"),
];

/// A writer of a fresh note of its own, joined and synced: (user, room, client).
async fn writer(env: &Env, port: u16, text: &str) -> (String, String, Client) {
    let (user, material) = note(env, text).await;
    let room = format!("material:{material}:schema:1");
    let mut client = Client::open(port).await;
    client.joined(&room, &token(&room, &user, "write")).await;
    assert!(client.settle(|c| c.block_text() == text).await);
    (user, room, client)
}

impl Client {
    /// Sends `count` one-letter updates at once.
    async fn flood(&mut self, count: usize) {
        for _ in 0..count {
            let update = self.typed("b");
            self.send(5, &sync(2, &update)).await;
        }
    }

    /// The next `update-timeout` notice: its time left in ms. It says
    /// nothing else (never the allowance's numbers).
    async fn timeout_notice(&mut self) -> u64 {
        let (notice, _) = self.stateless("update-timeout").await;
        let keys: Vec<&String> = notice.as_object().expect("an object").keys().collect();
        assert_eq!(keys, ["remainingMs", "type"], "{notice}");
        notice["remainingMs"].as_u64().expect("the time left")
    }
}

/// Security regression (Epo 2026-10-18): a user past their allowance is put
/// in a timeout instead of disconnected. Every socket of theirs hears it,
/// with only the time left; nothing of theirs reaches the room until it
/// ends; a channel joining meanwhile hears it instead of joining; afterwards
/// a channel joined again on the same socket resyncs what its client held. Another
/// user typing at a person's pace is untouched. Fails if the allowance is
/// not enforced, if a timeout reaches only the socket that began it, or if
/// updates sent during it are applied.
#[tokio::test]
async fn a_user_past_their_allowance_is_timed_out_on_every_socket() {
    let Some(env) = env() else { return };
    let server = start_configured(&env, env.api.as_deref(), &SMALL_ALLOWANCE).await;
    let (typist_user, typist_room, mut typist) = writer(&env, server.port, "rate").await;
    // Ten keys a second for three seconds: under the sustained rate.
    for _ in 0..30 {
        typist.type_text("a").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        typist
            .settle(|c| c.block_text().ends_with(&"a".repeat(30)))
            .await
    );

    // Another user's two sockets (each join takes three: JOIN, step 1, step
    // 2); a flood of small updates on the first runs out of the 40-message
    // burst.
    let (user, room, mut first) = writer(&env, server.port, "flood").await;
    let mut second = Client::open(server.port).await;
    second.joined(&room, &token(&room, &user, "write")).await;
    assert!(second.settle(|c| c.block_text() == "flood").await);
    first.flood(300).await;
    let remaining = first.timeout_notice().await;
    assert!((1..=3000).contains(&remaining), "{remaining}");
    assert!((1..=3000).contains(&second.timeout_notice().await));
    // The second socket's edit meanwhile is dropped (it never resyncs), and
    // so is its checkpoint request: no receipt answers it.
    second.type_text("z").await;
    let request = serde_json::json!({ "id": "in-timeout", "type": "checkpoint-request" });
    let mut payload = Vec::new();
    varbytes(&mut payload, request.to_string().as_bytes());
    second.send(9, &payload).await;
    let quiet = tokio::time::Instant::now() + Duration::from_secs(1);
    while let Ok(Some(Ok(Ws::Binary(bytes)))) =
        tokio::time::timeout_at(quiet, second.ws.next()).await
    {
        assert!(
            !String::from_utf8_lossy(&bytes).contains("in-timeout"),
            "a checkpoint request went on in the timeout"
        );
    }
    let mut third = Client::open(server.port).await;
    third.join(&room, &token(&room, &user, "write")).await;
    assert!((1..=3000).contains(&third.timeout_notice().await));
    assert!(third.inbox.iter().all(|message| message.kind != 1));

    // Once it ends, the first socket joins its room again and resyncs the
    // whole flood; a reader sees it, and no "z".
    tokio::time::sleep(Duration::from_millis(remaining + 200)).await;
    first.drain().await;
    first.joined(&room, &token(&room, &user, "write")).await;
    // Its step 2 answers the room's step 1, and is acknowledged.
    assert!(first.until(6).await.is_some(), "the resync is acknowledged");
    let mut reader = Client::open(server.port).await;
    reader.joined(&room, &token(&room, &user, "read")).await;
    let flooded = format!("flood{}", "b".repeat(300));
    assert!(
        reader.settle(|c| c.block_text() == flooded).await,
        "{}",
        reader.block_text()
    );

    // The typist was never timed out: its next update reaches a reader.
    typist.type_text("c").await;
    let mut typist_reader = Client::open(server.port).await;
    typist_reader
        .joined(&typist_room, &token(&typist_room, &typist_user, "read"))
        .await;
    assert!(
        typist_reader
            .settle(|c| c.block_text().ends_with('c'))
            .await
    );
    let metrics = metrics_text(server.port).await;
    assert!(
        metrics
            .lines()
            .any(|line| line == "capy_collaboration_timeouts_total 1"),
        "{metrics}"
    );
}

/// Security regression (Epo 2026-10-18): the allowance is the user's, not
/// the socket's. A socket that spent most of it, closed, leaves its user a
/// reconnect that goes on from what was left: the second socket is timed out
/// within a few updates, not after a fresh burst. Fails if each socket (or
/// each reconnect) gets its own allowance.
#[tokio::test]
async fn a_users_allowance_is_shared_by_their_sockets_and_reconnects() {
    let Some(env) = env() else { return };
    let server = start_configured(&env, env.api.as_deref(), &SLOW_ALLOWANCE).await;
    let (user, room, mut first) = writer(&env, server.port, "shared").await;
    // Its join took three (JOIN, step 1, step 2); 34 more leave three.
    first.flood(34).await;
    assert!(first.until(6).await.is_some());
    drop(first);
    let mut second = Client::open(server.port).await;
    second.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        second
            .settle(|c| c.block_text().starts_with("shared"))
            .await
    );
    // A fresh allowance would take 30 more after the join's three.
    second.flood(30).await;
    assert!(second.timeout_notice().await > 0);
}

/// Security regression (Epo 2026-10-18): a draft send takes from the same
/// allowance as its user's sockets, and is refused while the user is in a
/// timeout: 429 `too_fast` with the time left, counted; nothing reaches the
/// room. Fails if draft sends bypass the allowance or the timeout.
#[tokio::test]
async fn a_draft_send_takes_from_the_users_allowance() {
    let Some(env) = env() else { return };
    let server = start_configured(&env, env.api.as_deref(), &SLOW_ALLOWANCE).await;
    let (user, room, mut editor) = writer(&env, server.port, "drafts").await;
    editor.flood(100).await;
    assert!(editor.timeout_notice().await > 0);
    let (status, answer) = send_drafts(
        server.port,
        &room,
        Some(&token(&room, &user, "write")),
        Some(ORIGIN),
        drafted(&editor.doc, typed_into_note(" late")),
    )
    .await;
    assert_eq!(
        (status, &answer["class"]),
        (429, &serde_json::json!("too_fast"))
    );
    let remaining = answer["remainingMs"].as_u64().expect("the time left");
    assert!((1..=300_000).contains(&remaining), "{answer}");
    let metrics = metrics_text(server.port).await;
    assert!(
        metrics
            .lines()
            .any(|line| line == "capy_collaboration_draft_refusals_total{class=\"too_fast\"} 1"),
        "{metrics}"
    );
}

/// Epo 2026-10-24 (Q321): a draft group the room already holds in full is
/// accepted as a no-op, with no allowance charge and no store, so the page
/// sweep, an opening editor and other tabs may send it without a lock. With
/// an allowance of five messages, the writer's join takes three: the same
/// group sent back to back and then again goes in every time, as one row.
/// Fails if a held group is charged (the third send would be refused as too
/// fast) or stored again.
#[tokio::test]
async fn a_draft_group_the_room_holds_is_stored_and_charged_once() {
    let Some(env) = env() else { return };
    let allowance = [
        ("COLLABORATION_UPDATE_BURST", "5"),
        ("COLLABORATION_UPDATES_PER_SECOND", "1"),
    ];
    let server = start_configured(&env, env.api.as_deref(), &allowance).await;
    let (user, room, editor) = writer(&env, server.port, "drafts").await;
    let material = material_of(&room).to_owned();
    let rows = || async {
        db(&env)
            .await
            .query_one(
                "SELECT count(*) FROM material_yjs_updates WHERE material_id=$1",
                &[&material],
            )
            .await
            .expect("rows")
            .get::<_, i64>(0)
    };
    let before = rows().await;
    let group = drafted(&editor.doc, typed_into_note(" once"));
    let send = || {
        let (room, write, body) = (room.clone(), token(&room, &user, "write"), group.clone());
        async move { send_drafts(server.port, &room, Some(&write), Some(ORIGIN), body).await }
    };
    let (first, second) = tokio::join!(send(), send());
    assert_eq!((first.0, second.0), (200, 200), "{} {}", first.1, second.1);
    let (again, answer) = send().await;
    assert_eq!(again, 200, "a held group is charged nothing: {answer}");
    assert_eq!(rows().await, before + 1, "stored once");
}

/// Epo 2026-10-25 (Q360, r4 B1): a duplicate draft send answers only once
/// the room's pending store of that group committed, since the browser
/// deletes its rows on the answer. With the updates table locked, neither of
/// two back-to-back sends of a group answers; once the lock goes both do,
/// stored once. Fails if the duplicate's no-op answers before the store.
#[tokio::test]
async fn a_duplicate_draft_send_answers_only_after_the_store_commits() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, editor) = writer(&env, server.port, "drafts").await;
    let material = material_of(&room).to_owned();
    let rows = || async {
        db(&env)
            .await
            .query_one(
                "SELECT count(*) FROM material_yjs_updates WHERE material_id=$1",
                &[&material],
            )
            .await
            .expect("rows")
            .get::<_, i64>(0)
    };
    let before = rows().await;
    let group = drafted(&editor.doc, typed_into_note(" held"));
    let mut lock = db(&env).await;
    let held = lock.transaction().await.expect("transaction");
    held.batch_execute("LOCK TABLE material_yjs_updates IN EXCLUSIVE MODE")
        .await
        .expect("lock");
    let send = || {
        let (room, write, body) = (room.clone(), token(&room, &user, "write"), group.clone());
        let port = server.port;
        tokio::spawn(
            async move { send_drafts(port, &room, Some(&write), Some(ORIGIN), body).await },
        )
    };
    let started = std::time::Instant::now();
    let (first, second) = (send(), send());
    // The admitted send's store waits on the lock; the other send, started
    // with it, has had as long again to reach the room (r5 N7).
    let deadline = started + Duration::from_secs(30);
    loop {
        let waiting = db(&env)
            .await
            .query_one(
                "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' \
                 AND query ILIKE '%material_yjs_updates%'",
                &[],
            )
            .await
            .expect("activity")
            .get::<_, i64>(0);
        if waiting > 0 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the store never reached the lock"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(started.elapsed().max(Duration::from_millis(500))).await;
    assert!(
        !first.is_finished() && !second.is_finished(),
        "no answer before the store commits"
    );
    held.rollback().await.expect("release");
    let (first, second) = (first.await.expect("first"), second.await.expect("second"));
    assert_eq!((first.0, second.0), (200, 200), "{} {}", first.1, second.1);
    assert_eq!(rows().await, before + 1, "stored once");
}

/// Security regression (Epo 2026-10-25, Q360, r4 S2): a user's draft sends
/// are limited to 60 a minute apart from the byte charge, which a group the
/// room holds skips (Q321): the 61st send of one group within the minute is
/// answered 429 `too_fast` before any lookup. Fails if the request limit is
/// removed (every send would go in as a no-op).
#[tokio::test]
async fn a_users_61st_draft_send_in_a_minute_is_refused_too_fast() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, editor) = writer(&env, server.port, "drafts").await;
    let group = drafted(&editor.doc, typed_into_note(" again"));
    let write = token(&room, &user, "write");
    for sent in 0..60 {
        let (status, answer) = send_drafts(
            server.port,
            &room,
            Some(&write),
            Some(ORIGIN),
            group.clone(),
        )
        .await;
        assert_eq!(status, 200, "send {sent}: {answer}");
    }
    let (status, answer) = send_drafts(server.port, &room, Some(&write), Some(ORIGIN), group).await;
    assert_eq!(
        (status, answer["class"].as_str()),
        (429, Some("too_fast")),
        "{answer}"
    );
}

/// Security regression (Epo 2026-10-18): no room takes an update over 8 MiB;
/// its sender is timed out. A socket sending one hears the timeout (and stays
/// open) before the room reads it, and a text source's draft send over it is
/// answered 413 `too_large` (never sendable as it is, so the page stops
/// retrying it, rate-limit review r3 S8) before the body is read past the
/// cap, its user timed out too. Fails if either cap is removed (a note room
/// would answer its own 4 MiB refusal on the channel; the source send would
/// reach the room).
#[tokio::test]
async fn an_update_over_8_mib_times_its_user_out_and_a_draft_over_it_answers_too_large() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    // A byte burst past the cap, so the cap alone refuses the update.
    let server = start_configured(
        &env,
        Some(&gateway.url),
        &[("COLLABORATION_UPDATE_BURST_BYTES", "67108864")],
    )
    .await;
    let (_, _, mut sender) = writer(&env, server.port, "cap").await;
    sender
        .send(5, &sync(2, &vec![0u8; 8 * 1024 * 1024 + 1]))
        .await;
    assert!((1..=3000).contains(&sender.timeout_notice().await));
    let (user, file) = text_file(&env, &gateway, "hello").await;
    let room = format!("source:{file}:epoch:1");
    let (status, answer) = send_drafts(
        server.port,
        &room,
        Some(&token(&room, &user, "write")),
        Some(ORIGIN),
        vec![0u8; 8 * 1024 * 1024 + 1],
    )
    .await;
    assert_eq!(
        (status, &answer["class"]),
        (413, &serde_json::json!("too_large"))
    );
    let metrics = metrics_text(server.port).await;
    assert!(
        metrics
            .lines()
            .any(|line| line == "capy_collaboration_timeouts_total 2"),
        "{metrics}"
    );
}

/// Security regression (Epo 2026-10-19): awareness updates and awareness
/// queries take from their user's allowance like SYNC messages: a flood of
/// either times the user out. Fails if either is forwarded uncounted.
#[tokio::test]
async fn awareness_and_its_queries_take_from_the_users_allowance() {
    let Some(env) = env() else { return };
    let server = start_configured(&env, env.api.as_deref(), &SMALL_ALLOWANCE).await;
    let (_, _, mut presence) = writer(&env, server.port, "presence").await;
    let id = presence.id();
    for clock in 1..=100 {
        presence
            .send(7, &awareness_update(id, clock, "{\"cursor\":1}"))
            .await;
    }
    assert!(presence.timeout_notice().await > 0);
    let (_, _, mut asker) = writer(&env, server.port, "asker").await;
    for _ in 0..100 {
        asker.send(8, &[]).await;
    }
    assert!(asker.timeout_notice().await > 0);
}

/// What came of asking for a room's whole state.
#[derive(Debug, PartialEq)]
enum Answer {
    Answered,
    TimedOut,
    Silent,
}

impl Client {
    /// Asks for the room's whole state (a step 1 with an empty state vector)
    /// and waits up to `wait` for its step 2 or a timeout notice.
    async fn whole_state_within(&mut self, wait: Duration) -> Answer {
        self.send(5, &sync(0, &StateVector::default().encode_v1()))
            .await;
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let Ok(Some(Ok(Ws::Binary(bytes)))) =
                tokio::time::timeout_at(deadline, self.ws.next()).await
            else {
                return Answer::Silent;
            };
            let mut at = 0;
            while at < bytes.len() {
                let _channel = read_var(&bytes, &mut at);
                let kind = bytes[at];
                at += 1;
                let len = read_var(&bytes, &mut at) as usize;
                let payload = &bytes[at..at + len];
                at += len;
                if kind == 9 && text_payload(payload).contains("update-timeout") {
                    return Answer::TimedOut;
                }
                if kind == 5 && payload.first() == Some(&1) {
                    return Answer::Answered;
                }
            }
        }
    }

    /// Reads (applying syncs) until nothing arrives for 300 ms, then forgets
    /// what was read.
    async fn drain(&mut self) {
        while let Ok(Some(Ok(Ws::Binary(bytes)))) =
            tokio::time::timeout(Duration::from_millis(300), self.ws.next()).await
        {
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
                }
            }
        }
        self.inbox.clear();
    }
}

/// The byte allowance refilled 1 byte a second, and an 8 MiB open budget
/// full again over 84 s (about 0.1 MB a second).
const OPEN_BUDGET: [(&str, &str); 4] = [
    ("COLLABORATION_UPDATE_BURST_BYTES", "8388608"),
    ("COLLABORATION_UPDATE_BYTES_PER_SECOND", "1"),
    ("COLLABORATION_OPEN_BYTES", "8388608"),
    ("COLLABORATION_OPEN_REFILL_SECONDS", "84"),
];

/// Security regression (Epo 2026-10-19): full-document answers (a step 1's)
/// draw on their user's open budget by their bytes, not on the update
/// allowance. With a 1.5 MB note and an 8 MiB budget the join's answer and
/// five more go at once; the next waits until the budget is back (slowed,
/// never refused), and the user is never timed out. Fails if answers go
/// uncharged (the sixth answers at once) or are charged to the update
/// allowance (a timeout).
#[tokio::test]
async fn full_document_answers_draw_on_the_open_budget_and_slow_when_it_is_spent() {
    let Some(env) = env() else { return };
    let server = start_configured(&env, env.api.as_deref(), &OPEN_BUDGET).await;
    let text = "w".repeat(1_500_000);
    let (_, _, mut asker) = writer(&env, server.port, &text).await;
    for answer in 1..=5 {
        assert_eq!(
            asker.whole_state_within(Duration::from_secs(5)).await,
            Answer::Answered,
            "answer {answer}"
        );
    }
    let asked = tokio::time::Instant::now();
    assert_eq!(
        asker.whole_state_within(Duration::from_secs(20)).await,
        Answer::Answered
    );
    assert!(
        asked.elapsed() >= Duration::from_millis(500),
        "{:?}",
        asked.elapsed()
    );
}

impl Client {
    /// Sends `count` step 1s with an empty state vector in one frame (the
    /// socket reads them all before the room answers the first).
    async fn ask_whole_state(&mut self, count: usize) {
        let message = frame(1, 5, &sync(0, &StateVector::default().encode_v1()));
        let burst: Vec<u8> = message.repeat(count);
        self.ws.send(Ws::Binary(burst.into())).await.expect("send");
    }

    /// When each step 2 arrived in the next `window`, and the stateless
    /// messages read meanwhile.
    async fn step2_arrivals(&mut self, window: Duration) -> (Vec<Duration>, Vec<String>) {
        let start = tokio::time::Instant::now();
        let deadline = start + window;
        let (mut arrivals, mut notices) = (Vec::new(), Vec::new());
        while let Ok(Some(Ok(Ws::Binary(bytes)))) =
            tokio::time::timeout_at(deadline, self.ws.next()).await
        {
            let mut at = 0;
            while at < bytes.len() {
                let _channel = read_var(&bytes, &mut at);
                let kind = bytes[at];
                at += 1;
                let len = read_var(&bytes, &mut at) as usize;
                let payload = &bytes[at..at + len];
                at += len;
                if kind == 5 && payload.first() == Some(&1) {
                    arrivals.push(start.elapsed());
                }
                if kind == 9 {
                    notices.push(text_payload(payload));
                }
            }
        }
        (arrivals, notices)
    }
}

/// Another note of `user`'s: its material id.
async fn note_of(env: &Env, user: &str, text: &str) -> String {
    let material = format!("m_it_{}", uuid_like());
    let content = serde_json::json!({
        "schemaVersion": 1,
        "value": [{ "type": "p", "id": "b1", "children": [{ "text": text }] }],
    });
    db(env)
        .await
        .execute(
            "INSERT INTO materials (id, created_by, kind, title, content) VALUES ($1, $2, 'note', 'IT', $3)",
            &[&material, &user, &content],
        )
        .await
        .expect("material");
    material
}

/// Another note of `user`'s, joined and synced on a socket of its own.
async fn second_note(env: &Env, port: u16, user: &str, text: &str) -> Client {
    let material = note_of(env, user, text).await;
    let room = format!("material:{material}:schema:1");
    let mut client = Client::open(port).await;
    client.joined(&room, &token(&room, user, "write")).await;
    assert!(client.settle(|c| c.block_text() == text).await);
    client
}

/// Security regression (rate-limit review r4 B1, Epo 2026-10-20): the open
/// budget is checked where the answer is charged, so a burst of step 1s
/// read before the first answer is charged is not answered in full each.
/// With 1 MB of a 2.5 MB budget left, 20 whole-state step 1s at once get
/// one answer, then, the budget spent, wait as one (the channel's latest)
/// and hear that the open is slowed. Fails if the budget is checked only
/// before the room (20 answers) or waiting step 1s are not merged (a third
/// answer).
#[tokio::test]
async fn a_burst_of_step_1s_gets_one_answer_while_the_open_budget_is_spent() {
    let Some(env) = env() else { return };
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[
            ("COLLABORATION_OPEN_BYTES", "2500000"),
            ("COLLABORATION_OPEN_REFILL_SECONDS", "3"),
        ],
    )
    .await;
    let (_, _, mut asker) = writer(&env, server.port, &"w".repeat(1_500_000)).await;
    asker.ask_whole_state(20).await;
    let (arrivals, notices) = asker.step2_arrivals(Duration::from_secs(4)).await;
    assert_eq!(arrivals.len(), 2, "{arrivals:?}");
    assert!(
        arrivals[1] - arrivals[0] >= Duration::from_millis(300),
        "{arrivals:?}"
    );
    assert!(
        notices.iter().any(|notice| notice.contains("open-slowed")),
        "{notices:?}"
    );
}

/// Security regression (Epo 2026-10-20): a step 1 whose answer is under
/// 256 KiB (a returning member's resync) skips the wait on a spent open
/// budget while its user owes less than a full budget, while a whole-state
/// one waits. Fails if small answers wait too (the resync would wait about
/// 150 s) or a spent budget lets the whole state through.
#[tokio::test]
async fn a_resync_skips_the_wait_within_a_full_budget_of_debt() {
    let Some(env) = env() else { return };
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[
            ("COLLABORATION_OPEN_BYTES", "1000000"),
            ("COLLABORATION_OPEN_REFILL_SECONDS", "300"),
        ],
    )
    .await;
    // The join's answer spent the budget: 0.5 MB below zero.
    let (_, _, mut asker) = writer(&env, server.port, &"w".repeat(1_500_000)).await;
    let held = asker.doc.transact().state_vector().encode_v1();
    asker.send(5, &sync(0, &held)).await;
    let (arrivals, _) = asker.step2_arrivals(Duration::from_secs(2)).await;
    assert_eq!(arrivals.len(), 1, "the resync answered at once");
    assert_eq!(
        asker.whole_state_within(Duration::from_secs(2)).await,
        Answer::Silent
    );
}

/// Security regression (rate-limit review r5 B-1, Epo 2026-10-20): answers
/// under 256 KiB are charged and skip the wait only while their user owes
/// less than a full budget. With 0.5 MB of a 1 MB budget owed, six resyncs
/// each answered by the note's last 200 KB get three answers (the third
/// takes the debt past 1 MB) and the rest wait, slowed. Fails if small
/// answers never wait.
#[tokio::test]
async fn a_burst_of_small_answers_waits_past_a_full_budget_of_debt() {
    let Some(env) = env() else { return };
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[
            ("COLLABORATION_OPEN_BYTES", "1000000"),
            ("COLLABORATION_OPEN_REFILL_SECONDS", "300"),
        ],
    )
    .await;
    // The join's answer spent the budget: 0.5 MB below zero.
    let (_, _, mut asker) = writer(&env, server.port, &"w".repeat(1_500_000)).await;
    let held = asker.doc.transact().state_vector();
    let (author, clock) = held
        .iter()
        .map(|(client, clock)| (*client, *clock))
        .max_by_key(|(_, clock)| *clock)
        .expect("the note's text");
    let since: StateVector = held
        .iter()
        .map(|(client, at)| {
            (
                *client,
                if *client == author {
                    clock - 200_000
                } else {
                    *at
                },
            )
        })
        .collect();
    let step1 = sync(0, &since.encode_v1());
    for _ in 0..6 {
        asker.send(5, &step1).await;
    }
    let (arrivals, notices) = asker.step2_arrivals(Duration::from_secs(3)).await;
    assert_eq!(arrivals.len(), 3, "{arrivals:?}");
    assert!(
        notices.iter().any(|notice| notice.contains("open-slowed")),
        "{notices:?}"
    );
}

/// Security regression (rate-limit review r4 B1, Epo 2026-10-20): large
/// answers waiting in two rooms for one user's budget are released one at a
/// time as it refills, each charged before the next is looked at. Fails if
/// both go once the budget is back above zero.
#[tokio::test]
async fn waiting_large_answers_are_released_one_at_a_time() {
    let Some(env) = env() else { return };
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[
            ("COLLABORATION_OPEN_BYTES", "2000000"),
            ("COLLABORATION_OPEN_REFILL_SECONDS", "4"),
        ],
    )
    .await;
    let text = "w".repeat(1_500_000);
    let (user, _, mut first) = writer(&env, server.port, &text).await;
    // Two joins' answers: 1 MB below zero, about 2 s to refill.
    let mut second = second_note(&env, server.port, &user, &text).await;
    first.ask_whole_state(1).await;
    second.ask_whole_state(1).await;
    let (a, b) = tokio::join!(
        first.step2_arrivals(Duration::from_secs(4)),
        second.step2_arrivals(Duration::from_secs(4)),
    );
    assert_eq!(a.0.len() + b.0.len(), 1, "{a:?} {b:?}");
}

/// Security regression (rate-limit review r3 S5): the awareness a JOIN sends
/// draws on the joiner's open budget like an awareness query, so joining
/// again and again does not fetch a crowded room's presence for free. Two
/// more joins of a room holding about 240 KB of presence spend a 300 KB
/// budget, and the user's next query waits. Fails if the join's awareness is
/// sent uncharged (the query answers at once).
#[tokio::test]
async fn the_awareness_sent_on_join_draws_on_the_open_budget() {
    let Some(env) = env() else { return };
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[
            ("COLLABORATION_OPEN_BYTES", "300000"),
            ("COLLABORATION_OPEN_REFILL_SECONDS", "1000000"),
            ("COLLABORATION_CONNECTIONS_PER_DOCUMENT", "100"),
        ],
    )
    .await;
    let (user, room, mut client) = writer(&env, server.port, "crowd").await;
    let state = format!("{{\"n\":\"{}\"}}", "p".repeat(60_000));
    // Four sessions' presence (a channel writes only its session's id),
    // joined while the room holds none.
    let mut sessions = vec![(1, client.id())];
    for channel in 2..=4 {
        let session = token(&room, &user, "write");
        client
            .send_on(
                channel,
                0,
                &join_payload(&room, &session, Some(client_protocol())),
            )
            .await;
        assert!(client.until(1).await.is_some(), "channel {channel} joined");
        sessions.push((channel, token_client_id(&session).expect("client id")));
    }
    for (channel, id) in sessions {
        client
            .send_on(channel, 7, &awareness_update(id, 1, &state))
            .await;
    }
    let write = token(&room, &user, "write");
    for channel in 5..=6 {
        client
            .send_on(
                channel,
                0,
                &join_payload(&room, &write, Some(client_protocol())),
            )
            .await;
        assert!(client.until(1).await.is_some(), "channel {channel} joined");
    }
    client.drain().await;
    client.send_on(1, 8, &[]).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while let Ok(Some(Ok(Ws::Binary(bytes)))) =
        tokio::time::timeout_at(deadline, client.ws.next()).await
    {
        let mut at = 0;
        while at < bytes.len() {
            let _channel = read_var(&bytes, &mut at);
            let kind = bytes[at];
            at += 1;
            let len = read_var(&bytes, &mut at) as usize;
            at += len;
            assert_ne!(kind, 7, "the query answered at once");
        }
    }
}

/// Security regression (Epo 2026-10-20, rate-limit review r6 S-1): the
/// awareness a JOIN sends counts against the open budget and, past the
/// small-answer floor, waits like an awareness query. Two re-JOINs of a room
/// holding about 480 KB of presence (eight sessions on another socket) take a 300 KB
/// budget 360 KB past its floor (300 KB owed); the next re-JOIN joins but
/// hears no awareness until the budget refills (100 KB a second), and its
/// step 1, waiting with it, hears that the open is slowed (review r7 S-1).
/// Fails if the JOIN's awareness never waits, or its wait keeps the notice
/// from the step 1.
#[tokio::test]
async fn re_joins_past_the_floor_hear_no_awareness_until_the_budget_refills() {
    let Some(env) = env() else { return };
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[
            ("COLLABORATION_OPEN_BYTES", "300000"),
            ("COLLABORATION_OPEN_REFILL_SECONDS", "3"),
            ("COLLABORATION_CONNECTIONS_PER_DOCUMENT", "100"),
            ("COLLABORATION_JOINED_PER_USER", "100"),
        ],
    )
    .await;
    let (user, room, mut client) = writer(&env, server.port, "crowd").await;
    let write = token(&room, &user, "write");
    // Channel 2's session: each re-JOIN names its id with a token that
    // offers it again (Q236: it never wrote).
    let rejoin = token(&room, &user, "write");
    let rejoined = token_client_id(&rejoin).expect("client id");
    let join = || {
        join_payload_as(
            &room,
            &token_offering(&room, &user, "write", rejoined),
            Some(client_protocol()),
            rejoined,
        )
    };
    let mut first = Some(join_payload(&room, &rejoin, Some(client_protocol())));
    // A second socket of eight presence sessions (a channel writes only its
    // session's id), its first synced (so its channels serve) while the room
    // holds none.
    let mut other = Client::open(server.port).await;
    other.joined(&room, &write).await;
    assert!(other.settle(|c| c.block_text() == "crowd").await);
    let mut sessions = vec![(1, other.id())];
    for channel in 2..=8 {
        let session = token(&room, &user, "write");
        other
            .send_on(
                channel,
                0,
                &join_payload(&room, &session, Some(client_protocol())),
            )
            .await;
        assert!(other.until(1).await.is_some(), "channel {channel} joined");
        sessions.push((channel, token_client_id(&session).expect("client id")));
    }
    let state = format!("{{\"n\":\"{}\"}}", "p".repeat(60_000));
    // All eight in one frame: once the first reaches this client, the room
    // holds all of them.
    let mut batch = Vec::new();
    for (channel, id) in sessions {
        batch.extend(frame(channel, 7, &awareness_update(id, 1, &state)));
    }
    other.ws.send(Ws::Binary(batch.into())).await.expect("send");
    assert!(client.heard_within(1, 7, Duration::from_secs(5)).await);
    for round in 0..2 {
        client
            .send_on(2, 0, &first.take().unwrap_or_else(join))
            .await;
        assert!(
            client
                .awareness_after_join(2, Duration::from_secs(2))
                .await
                .0,
            "re-JOIN {round} hears the presence"
        );
    }
    client.send_on(2, 0, &join()).await;
    // A client's step 1 follows its JOIN.
    client
        .send_on(2, 5, &sync(0, &StateVector::default().encode_v1()))
        .await;
    let (heard, notices) = client.awareness_after_join(2, Duration::from_secs(2)).await;
    assert!(!heard, "past the floor the JOIN's awareness waits");
    assert!(
        notices.iter().any(|notice| notice.contains("open-slowed")),
        "{notices:?}"
    );
    assert!(
        client.heard_within(2, 7, Duration::from_secs(12)).await,
        "and comes once the budget refills"
    );
}

/// Security regression (Epo 2026-10-20, rate-limit review r6 N-5): the server
/// pings every socket and closes one that sends nothing for the silent
/// window (here 1 s pings and 2 s of silence), freeing its places; any frame
/// counts, a pong too. With two connections to a note allowed, a socket that
/// stops reading is closed while one that only answers pings stays open, and
/// a third connection then closes nothing. Fails if silent sockets keep their
/// places (the third connection closes the oldest) or pongs do not count.
#[tokio::test]
async fn a_silent_socket_closes_and_frees_its_places_while_an_answering_one_stays() {
    let Some(env) = env() else { return };
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[
            ("COLLABORATION_PING_SECONDS", "1"),
            ("COLLABORATION_SILENT_SECONDS", "2"),
            ("COLLABORATION_CONNECTIONS_PER_DOCUMENT", "2"),
        ],
    )
    .await;
    let (user, room, mut answering) = writer(&env, server.port, "pinged").await;
    let write = token(&room, &user, "write");
    let mut silent = Client::open(server.port).await;
    silent.joined(&room, &write).await;
    // The silent socket reads nothing from here on; the answering one only
    // reads, so pongs are all it sends.
    assert!(
        answering.still_open(Duration::from_millis(3500)).await,
        "a socket that answers pings stays open"
    );
    let mut third = Client::open(server.port).await;
    third.joined(&room, &write).await;
    let closes = answering.closes_within(Duration::from_millis(500)).await;
    assert!(closes.is_empty(), "{closes:?}");
    assert!(
        !silent.still_open(Duration::from_secs(2)).await,
        "the silent socket was closed"
    );
}

/// Security regression (rate-limit review r7 B-1): a join the per-document
/// cap makes room for by closing an embed's channel, which holds no place
/// among the user's joined documents, still closes their oldest joined
/// document. With two of each allowed, a user holding note N with set S in
/// it (S's oldest connection) and S on its own opens S on its own again: the
/// embed closes, and so does N. Fails if any per-document close skips the
/// joined cap's (a user could then hold any number of documents).
#[tokio::test]
async fn a_join_that_closes_an_embed_still_closes_the_users_oldest_document() {
    let Some(env) = env() else { return };
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[
            ("COLLABORATION_JOINED_PER_USER", "2"),
            ("COLLABORATION_CONNECTIONS_PER_DOCUMENT", "2"),
        ],
    )
    .await;
    let (user, room, mut note) = writer(&env, server.port, "a note").await;
    let material = material_of(&room).to_owned();
    let [set] = embedded_sets(&env, &user, &material, 1)
        .await
        .try_into()
        .expect("one set");
    let embed = embed_token(&set, &user, &material);
    assert_eq!(note.join_embed(2, &set, &embed).await.0, 1);
    // Two tabs, so two sessions: each its own token and client id.
    let alone = || join_payload(&set, &token(&set, &user, "write"), Some(client_protocol()));
    let mut first = Client::open(server.port).await;
    first.send(0, &alone()).await;
    assert!(first.until(1).await.is_some(), "joined on its own");
    let mut second = Client::open(server.port).await;
    second.send(0, &alone()).await;
    assert!(second.until(1).await.is_some(), "joined on its own again");
    let closes = note.closes_within(Duration::from_secs(1)).await;
    let closed: Vec<u64> = closes.iter().map(|(channel, _)| *channel).collect();
    assert!(closed.contains(&2), "the embed closes: {closes:?}");
    assert!(closed.contains(&1), "and the oldest document: {closes:?}");
    let closes = first.closes_within(Duration::from_millis(300)).await;
    assert!(closes.is_empty(), "{closes:?}");
}

/// Security regression (Epo 2026-10-20, rate-limit review r7): a socket
/// whose send moves no bytes for the silent window (here 2 s) closes, freeing
/// its places, though a send has no total time limit (`seats.rs` tests a slow
/// peer). With two connections to a 1.5 MB note allowed, a socket that asks
/// for the whole state 20 times and reads none of it (far more than the
/// buffers between them hold) is closed, so a third connection closes
/// nothing. Fails if a stalled send holds the socket open.
#[tokio::test]
async fn a_socket_whose_send_moves_no_bytes_closes_and_frees_its_place() {
    let Some(env) = env() else { return };
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[
            ("COLLABORATION_PING_SECONDS", "1"),
            ("COLLABORATION_SILENT_SECONDS", "2"),
            ("COLLABORATION_CONNECTIONS_PER_DOCUMENT", "2"),
            ("COLLABORATION_OPEN_BYTES", "500000000"),
        ],
    )
    .await;
    let (user, room, mut reader) = writer(&env, server.port, &"w".repeat(1_500_000)).await;
    let write = token(&room, &user, "write");
    let mut stopped = Client::open(server.port).await;
    stopped.joined(&room, &write).await;
    stopped.ask_whole_state(20).await;
    assert!(
        reader.still_open(Duration::from_secs(5)).await,
        "the reading socket stays open"
    );
    let mut third = Client::open(server.port).await;
    third.joined(&room, &write).await;
    let closes = reader.closes_within(Duration::from_millis(500)).await;
    assert!(closes.is_empty(), "{closes:?}");
}

/// Security regression (Epo 2026-10-19): a JOIN costs one message of its
/// user's allowance, so a join loop runs into a timeout like any other flood
/// (a JOIN on a joined channel leaves and joins again, reloading what the
/// room sends a joiner). Fails if JOINs go uncounted.
#[tokio::test]
async fn a_join_costs_one_message_of_the_users_allowance() {
    let Some(env) = env() else { return };
    let server = start_configured(&env, env.api.as_deref(), &SLOW_ALLOWANCE).await;
    let (user, room, mut client) = writer(&env, server.port, "joins").await;
    // One session joining again and again, its id with a token that offers
    // it again each time (Q236: it never wrote).
    let first = token(&room, &user, "write");
    let id = token_client_id(&first).expect("client id");
    let mut first = Some(join_payload(&room, &first, Some(client_protocol())));
    let mut timed_out = false;
    'joins: for _ in 0..100 {
        let join = first.take().unwrap_or_else(|| {
            join_payload_as(
                &room,
                &token_offering(&room, &user, "write", id),
                Some(client_protocol()),
                id,
            )
        });
        client.send_on(2, 0, &join).await;
        // Its answer, read as it comes: nothing else is sent (no step 2).
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let Ok(Some(Ok(Ws::Binary(bytes)))) =
                tokio::time::timeout_at(deadline, client.ws.next()).await
            else {
                panic!("no answer to a JOIN");
            };
            let (mut at, mut joined) = (0, false);
            while at < bytes.len() {
                let _channel = read_var(&bytes, &mut at);
                let kind = bytes[at];
                at += 1;
                let len = read_var(&bytes, &mut at) as usize;
                let payload = &bytes[at..at + len];
                at += len;
                if kind == 9 && text_payload(payload).contains("update-timeout") {
                    timed_out = true;
                    break 'joins;
                }
                joined |= kind == 1;
            }
            if joined {
                break;
            }
        }
    }
    assert!(timed_out, "a hundred JOINs went uncounted");
}

/// A note in a workspace of `owner`'s that `editor` edits too: (owner,
/// editor, room).
async fn shared_note(env: &Env, text: &str) -> (String, String, String) {
    shared_note_named(env, text, "m_it").await
}

/// [shared_note] whose id starts with `prefix`.
async fn shared_note_named(env: &Env, text: &str, prefix: &str) -> (String, String, String) {
    let client = db(env).await;
    let (owner, editor) = (user(env).await, user(env).await);
    let workspace = format!("ws_it_{}", uuid_like());
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
            &[&workspace, &editor],
        )
        .await
        .expect("member");
    let material = format!("{prefix}_{}", uuid_like());
    let content = serde_json::json!({
        "schemaVersion": 1,
        "value": [{ "type": "p", "id": "b1", "children": [{ "text": text }] }],
    });
    client
        .execute(
            "INSERT INTO materials (id, created_by, workspace_id, workspace_name, kind, title, content) VALUES ($1, $2, $3, 'IT', 'note', 'IT', $4)",
            &[&material, &owner, &workspace, &content],
        )
        .await
        .expect("material");
    (owner, editor, format!("material:{material}:schema:1"))
}

impl Client {
    async fn send_on(&mut self, channel: u64, kind: u8, payload: &[u8]) {
        self.ws
            .send(Ws::Binary(frame(channel, kind, payload).into()))
            .await
            .expect("send");
    }

    /// Asks the room for its awareness states: (client, state) of each.
    async fn awareness_states(&mut self, channel: u64) -> Vec<(u64, String)> {
        self.drain().await;
        self.send_on(channel, 8, &[]).await;
        awareness_entries(&self.until(7).await.expect("awareness states"))
    }
}

/// Security regression (Q213, Epo 2026-10-23): a channel's awareness goes
/// only under the client id its JOIN bound. Another member can neither set
/// nor remove that id's entry, nor write any other id. Fails if a channel
/// may write awareness under an id its JOIN did not bind.
#[tokio::test]
async fn a_member_writes_awareness_only_under_its_own_client_id() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note(&env, "presence").await;
    let mut victim = Client::open(server.port).await;
    victim.joined(&room, &token(&room, &owner, "write")).await;
    assert!(victim.settle(|c| c.block_text() == "presence").await);
    victim.type_text("!").await;
    victim.until(6).await.expect("ack");
    let victim_id = victim.doc.client_id().get();
    let mut claimer = Client::open(server.port).await;
    claimer.joined(&room, &token(&room, &editor, "write")).await;
    let claimer_id = claimer.doc.client_id().get();
    claimer
        .send(7, &awareness_update(victim_id, 9, "{\"name\":\"claimer\"}"))
        .await;
    claimer
        .send(7, &awareness_update(4242, 1, "{\"name\":\"stray\"}"))
        .await;
    claimer
        .send(7, &awareness_update(claimer_id, 1, "{\"name\":\"own\"}"))
        .await;
    // Ordered after the claimer's messages on the room's queue.
    claimer.awareness_states(1).await;
    victim
        .send(7, &awareness_update(victim_id, 1, "{\"name\":\"victim\"}"))
        .await;
    victim.awareness_states(1).await;
    claimer
        .send(7, &awareness_update(victim_id, 10, "null"))
        .await;
    claimer.awareness_states(1).await;
    let mut watcher = Client::open(server.port).await;
    watcher.joined(&room, &token(&room, &owner, "write")).await;
    let mut states = watcher.awareness_states(1).await;
    states.sort();
    let mut expected = vec![
        (victim_id, "{\"name\":\"victim\"}".to_owned()),
        (claimer_id, "{\"name\":\"own\"}".to_owned()),
    ];
    expected.sort();
    assert_eq!(states, expected);
}

/// Security regression (Q213, Q236): a Y.Doc that wrote keeps its client id
/// across reconnects: naming it with a fresh token, or with a token that
/// offers it again (a reconnect presenting its previous token), binds it
/// unchanged, and the next edit lands. Fails if a reconnect of a writer
/// needs a new id.
#[tokio::test]
async fn a_session_keeps_its_client_id_across_reconnects() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "kept").await;
    let room = format!("material:{material}:schema:1");
    let mut session = Client::open(server.port).await;
    session.joined(&room, &token(&room, &user, "write")).await;
    assert!(session.settle(|c| c.block_text() == "kept").await);
    session.type_text("-a").await;
    session.until(6).await.expect("ack");
    let kept = session.id();
    // A reconnect with a fresh token names the kept id.
    session.leave(true).await;
    assert_eq!(
        session.joined(&room, &token(&room, &user, "write")).await,
        1
    );
    assert_eq!(session.id(), kept);
    session.type_text("-b").await;
    session.until(6).await.expect("ack after the reconnect");
    // A reconnect whose token offers the kept id again.
    session.leave(true).await;
    assert_eq!(
        session
            .joined(&room, &token_offering(&room, &user, "write", kept))
            .await,
        1
    );
    session.type_text("-c").await;
    session
        .until(6)
        .await
        .expect("ack after the second reconnect");
    let mut reader = Client::open(server.port).await;
    reader.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        reader.settle(|c| c.block_text() == "kept-a-b-c").await,
        "{}",
        reader.block_text()
    );
}

/// Security regression (Q236): a session's id is recorded at the first
/// accepted write under it, not at its JOIN. Fails if a JOIN records it, or
/// a write does not.
#[tokio::test]
async fn a_client_id_is_recorded_at_its_first_accepted_write_not_at_join() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut writer) = writer(&env, server.port, "base").await;
    let id = writer.id();
    // A JOIN alone: its writable join and sync went through, nothing written.
    let mut other = Client::open(server.port).await;
    other.joined(&room, &token(&room, &user, "write")).await;
    assert!(other.settle(|c| c.block_text() == "base").await);
    assert_eq!(id_rows(&env, &room, id).await, 0, "a JOIN records nothing");
    writer.type_text("-a").await;
    writer.until(6).await.expect("ack");
    assert!(
        id_rows_reach(&env, &room, id, 1).await,
        "the first accepted write records the id"
    );
    assert_eq!(id_rows(&env, &room, other.id()).await, 0);
}

/// Security regression (r2 S1): an update the room refuses (here its
/// validator) records nothing, even under the writer's own bound id: an id
/// is recorded once an update is accepted and applied. Fails if a refused
/// write records its id.
#[tokio::test]
async fn a_refused_update_records_no_client_id() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut refused) = writer(&env, server.port, "hello").await;
    refused
        .write(|doc| {
            let root = doc.get_or_insert_text("content");
            let mut txn = doc.transact_mut();
            let diff = root.diff(&txn, yrs::types::text::YChange::identity);
            let Some(yrs::Out::YXmlText(block)) = diff.into_iter().map(|chunk| chunk.insert).next()
            else {
                panic!("no block");
            };
            let mut attrs = yrs::types::Attrs::new();
            attrs.insert("type".into(), yrs::Any::from("timeline"));
            block.format(&mut txn, 0, 2, attrs);
        })
        .await;
    let (rejected, _) = refused.stateless("document-rejected").await;
    assert_eq!(rejected["code"], "invalid_document");
    // A room writes its rows in order: once a later write's row is in, a
    // refused write's would be too.
    let mut later = Client::open(server.port).await;
    later.joined(&room, &token(&room, &user, "write")).await;
    assert!(later.settle(|c| c.block_text() == "hello").await);
    later.type_text("-b").await;
    later.until(6).await.expect("ack");
    assert!(id_rows_reach(&env, &room, later.id(), 1).await);
    assert_eq!(id_rows(&env, &room, refused.id()).await, 0);
}

/// r2 S3 (Q322 N1): a client-id row write the database refuses is tried
/// again: the first insert fails once (a trigger on this note's rows) and
/// the row lands on the retry. Fails if the room writes its rows once.
#[tokio::test]
async fn a_client_id_row_write_that_fails_lands_on_its_retry() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (_, room, mut session) = writer(&env, server.port, "base").await;
    let material = material_of(&room).to_owned();
    let tag = material.replace(|c: char| !c.is_ascii_alphanumeric(), "_");
    let admin = db(&env).await;
    admin
        .batch_execute(&format!(
            "CREATE SEQUENCE once_{tag};
             CREATE FUNCTION once_{tag}() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.material_id = '{material}' AND nextval('once_{tag}') = 1 THEN
                 RAISE EXCEPTION 'refused once';
               END IF;
               RETURN NEW;
             END $$;
             CREATE TRIGGER once_{tag} BEFORE INSERT ON material_yjs_client_ids
               FOR EACH ROW EXECUTE FUNCTION once_{tag}();"
        ))
        .await
        .expect("trigger");
    session.type_text("-a").await;
    session.until(6).await.expect("ack");
    let landed = id_rows_reach(&env, &room, session.id(), 1).await;
    admin
        .batch_execute(&format!(
            "DROP TRIGGER once_{tag} ON material_yjs_client_ids;
             DROP FUNCTION once_{tag}();
             DROP SEQUENCE once_{tag};"
        ))
        .await
        .expect("cleanup");
    assert!(landed, "the row landed on its retry");
}

/// r2 S3: a room writes its client-id rows in order and unloads only once
/// they are in: a room its last session left right after a first write
/// stays loaded while the row waits on the database, and the row lands.
/// Fails if a room may unload with rows unwritten.
#[tokio::test]
async fn a_room_left_right_after_a_first_write_unloads_once_its_row_is_in() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (_, room, mut session) = writer(&env, server.port, "base").await;
    let mut locker = db(&env).await;
    let lock = locker.transaction().await.expect("transaction");
    lock.batch_execute("LOCK TABLE material_yjs_client_ids IN EXCLUSIVE MODE")
        .await
        .expect("lock");
    session.type_text("-a").await;
    session.until(6).await.expect("ack");
    let id = session.id();
    drop(session);
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            active_rooms(server.port).await,
            1,
            "unloaded before its row"
        );
    }
    lock.rollback().await.expect("unlock");
    wait_unloaded(server.port).await;
    assert_eq!(id_rows(&env, &room, id).await, 1);
    // Its session, which the store passed over while the row was queued, is
    // written once the row is in (review r1: no deadlock with that insert).
    assert!(session_row(&env, material_of(&room), id).await.1);
}

/// Security regression (r2 S4): a channel stays its user's: a token refresh
/// naming another user, even one who may edit the same room, is refused,
/// and the channel closes at its token's expiry. Fails if a refresh may
/// change a channel's user.
#[tokio::test]
async fn a_token_refresh_naming_another_user_is_refused() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note(&env, "base").await;
    let mut client = Client::open(server.port).await;
    client
        .joined(&room, &token_for(&room, &owner, "write", 2))
        .await;
    client.until(10).await.expect("a token request");
    let mut refresh = Vec::new();
    varbytes(&mut refresh, token(&room, &editor, "write").as_bytes());
    client.send(11, &refresh).await;
    let closed = client.until(4).await.expect("closed at expiry");
    assert!(
        String::from_utf8_lossy(&closed).contains("token expired"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
}

/// r2 N6: a clean Leave expires only the ids its token offered: a channel
/// that bound another tab's recorded id (its user's) leaves it bindable.
/// Fails if a clean Leave expires an id its token did not offer.
#[tokio::test]
async fn a_clean_leave_keeps_an_id_its_token_did_not_offer() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut first) = writer(&env, server.port, "base").await;
    first.type_text("-a").await;
    first.until(6).await.expect("ack");
    let id = first.id();
    assert!(id_rows_reach(&env, &room, id, 1).await);
    // Another channel of the user names the tab's id; its token offers
    // another.
    let join = join_payload_as(
        &room,
        &token(&room, &user, "write"),
        Some(client_protocol()),
        id,
    );
    let mut second = Client::open(server.port).await;
    second.send(0, &join).await;
    assert_eq!(second.until(1).await.expect("binds the tab's id"), [1]);
    second.leave(false).await;
    second.send(0, &join).await;
    assert_eq!(
        second.until(1).await.expect("the id still binds"),
        [1],
        "the clean Leave expired another tab's id"
    );
}

/// Security regression (Q236): an Office session (its editor's id, and a
/// DOCX layout worker's) that wrote nothing keeps both ids after its room
/// unloaded when its reconnect's token offers them again, as Go re-grants
/// them from the previous token, so the editor needs no reload; the edits
/// under both land and record them. Fails if such a reconnect is refused or
/// its edits are.
#[tokio::test]
async fn a_session_that_never_wrote_keeps_its_regranted_ids_after_its_room_unloaded() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "base").await;
    let room = format!("source:{file}:epoch:1");
    let (client_id, worker) = (fresh_client_id(), fresh_client_id());
    let mut first = Client::open(server.port).await;
    let grant = token_with_worker(&room, &user, client_id, worker);
    assert_eq!(first.joined(&room, &grant).await, 1);
    assert!(first.settle(|c| source_text(c) == "base").await);
    assert_eq!(first.id(), client_id);
    drop(first);
    wait_unloaded(server.port).await;
    let mut back = Client::open(server.port).await;
    back.send(
        0,
        &join_payload_as(
            &room,
            &token_with_worker(&room, &user, client_id, worker),
            Some(client_protocol()),
            client_id,
        ),
    )
    .await;
    assert_eq!(back.until(1).await.expect("the reconnect joins"), [1]);
    let sv = back.doc.transact().state_vector().encode_v1();
    back.send(5, &sync(0, &sv)).await;
    assert!(back.settle(|c| source_text(c) == "base").await);
    for (id, text) in [(worker, "w-"), (client_id, "c-")] {
        let edit = typed_as(&back, id, text);
        back.doc
            .transact_mut()
            .apply_update(Update::decode_v1(&edit).expect("edit"))
            .expect("apply");
        back.send(5, &sync(2, &edit)).await;
        back.until(6).await.expect("the edit is acknowledged");
        assert!(id_rows_reach(&env, &room, id, 1).await, "{text} recorded");
    }
    let mut reader = Client::open(server.port).await;
    assert_eq!(reader.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(
        reader.settle(|c| source_text(c) == "c-w-base").await,
        "{}",
        source_text(&reader)
    );
}

/// Security regression (Q236): a session that typed but never had a write
/// accepted, reconnecting after its room unloaded, gets its id back with a
/// token that offers it again and its edit lands; with a fresh token instead
/// (its previous one too old or refused) its JOIN is refused as
/// `collaboration-unassigned-id`, never retried. Fails if either answer
/// changes.
#[tokio::test]
async fn a_typed_but_unaccepted_session_gets_its_id_back_only_with_a_regrant() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut session) = writer(&env, server.port, "base").await;
    let id = session.id();
    let unsent = session.typed("-offline");
    session.leave(true).await;
    wait_unloaded(server.port).await;
    let fresh = token(&room, &user, "write");
    session
        .send(
            0,
            &join_payload_as(&room, &fresh, Some(client_protocol()), id),
        )
        .await;
    let reason = text_payload(&session.until(2).await.expect("refused"));
    assert_eq!(reason, "collaboration-unassigned-id");
    session.channel += 1;
    session.inbox.clear();
    assert_eq!(
        session
            .joined(&room, &token_offering(&room, &user, "write", id))
            .await,
        1
    );
    assert_eq!(session.id(), id);
    session.send(5, &sync(2, &unsent)).await;
    session.until(6).await.expect("the offline edit lands");
    let mut reader = Client::open(server.port).await;
    reader.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        reader.settle(|c| c.block_text() == "base-offline").await,
        "{}",
        reader.block_text()
    );
}

/// Security regression (Q236): two sessions presenting the same previous
/// token are offered the same unrecorded id; the first JOIN binds it and the
/// second is refused as `collaboration-client-id` while the first is live,
/// so two documents never write under one id. Fails if both bind.
#[tokio::test]
async fn one_regranted_id_binds_one_live_session() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let id = fresh_client_id();
    let grant = token_offering(&room, &user, "write", id);
    let mut first = Client::open(server.port).await;
    first
        .send(
            0,
            &join_payload_as(&room, &grant, Some(client_protocol()), id),
        )
        .await;
    assert_eq!(first.until(1).await.expect("the first joins"), [1]);
    let mut second = Client::open(server.port).await;
    second
        .send(
            0,
            &join_payload_as(&room, &grant, Some(client_protocol()), id),
        )
        .await;
    let reason = text_payload(&second.until(2).await.expect("refused"));
    assert_eq!(reason, "collaboration-client-id");
}

/// Security regression (Q236): a clean Leave (the tab holds no unsent edits)
/// expires the session's row, so its id never binds again and the next room
/// load clears the row; a Leave with unsent edits keeps it. Fails if a clean
/// Leave leaves the id bindable or its row in place, or if an unclean one
/// expires it.
#[tokio::test]
async fn a_clean_leave_expires_the_sessions_row() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut clean) = writer(&env, server.port, "base").await;
    clean.type_text("-a").await;
    clean.until(6).await.expect("ack");
    let mut kept = Client::open(server.port).await;
    kept.joined(&room, &token(&room, &user, "write")).await;
    assert!(kept.settle(|c| c.block_text() == "base-a").await);
    kept.type_text("-b").await;
    kept.until(6).await.expect("ack");
    let (gone, stays) = (clean.id(), kept.id());
    assert!(id_rows_reach(&env, &room, gone, 1).await);
    assert!(id_rows_reach(&env, &room, stays, 1).await);
    clean.leave(false).await;
    kept.leave(true).await;
    // The expired id no longer binds, even offered again.
    clean
        .send(
            0,
            &join_payload_as(
                &room,
                &token_offering(&room, &user, "write", gone),
                Some(client_protocol()),
                gone,
            ),
        )
        .await;
    let reason = text_payload(&clean.until(2).await.expect("refused"));
    assert_eq!(reason, "collaboration-unassigned-id");
    assert_eq!(
        kept.joined(&room, &token(&room, &user, "write")).await,
        1,
        "a Leave with unsent edits keeps the id"
    );
    kept.leave(true).await;
    wait_unloaded(server.port).await;
    let mut opener = Client::open(server.port).await;
    opener.joined(&room, &token(&room, &user, "read")).await;
    assert!(opener.settle(|c| c.block_text() == "base-a-b").await);
    assert_eq!(
        id_rows(&env, &room, gone).await,
        0,
        "the expired row cleared"
    );
    assert_eq!(id_rows(&env, &room, stays).await, 1);
}

/// An update over `from`'s state appending `text` to its first block under
/// `client`.
fn forged(from: &Doc, client: u64, text: &str) -> Vec<u8> {
    let doc = Doc::with_options(ydoc::doc_options(client));
    let state = from
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    doc.transact_mut()
        .apply_update(Update::decode_v1(&state).expect("state"))
        .expect("apply");
    typed_into_note(text)(&doc);
    doc.transact()
        .encode_state_as_update_v1(&from.transact().state_vector())
}

/// Security regression (Q213, Epo 2026-10-23): an update under a client id
/// the server did not assign to the writer's user is refused, and the next
/// edit of the session the id was assigned to lands. Fails if a connection
/// may write under any client id.
#[tokio::test]
async fn a_writer_cannot_write_under_another_writers_client_id() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note(&env, "base").await;
    let mut victim = Client::open(server.port).await;
    victim.joined(&room, &token(&room, &owner, "write")).await;
    assert!(victim.settle(|c| c.block_text() == "base").await);
    victim.type_text("-a").await;
    victim.until(6).await.expect("ack");
    let mut forger = Client::open(server.port).await;
    forger.joined(&room, &token(&room, &editor, "write")).await;
    assert!(forger.settle(|c| c.block_text() == "base-a").await);
    // An update under another user's id is refused; the edit the id's own
    // session made meanwhile lands.
    let pending = victim.typed("-b");
    let forgery = forged(&forger.doc, victim.doc.client_id().get(), "-forged");
    forger.send(5, &sync(2, &forgery)).await;
    let closed = forger.until(4).await.expect("the forger's channel closes");
    assert!(
        String::from_utf8_lossy(&closed).contains("client id"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
    let (rejected, _) = forger.stateless("document-rejected").await;
    assert_eq!(rejected["code"], "unassigned");
    victim.send(5, &sync(2, &pending)).await;
    victim.until(6).await.expect("ack");
    let mut reader = Client::open(server.port).await;
    reader.joined(&room, &token(&room, &owner, "write")).await;
    assert!(
        reader.settle(|c| c.block_text() == "base-a-b").await,
        "{}",
        reader.block_text()
    );
}

/// Epo 2026-10-24 (L3): edits made before a document had its assigned id,
/// under an id nobody was assigned, are refused as they are with the
/// `unassigned` code, and the room is not left stuck: another session of
/// the user joins and writes. The id is never recorded, and a JOIN naming it
/// hears `collaboration-unassigned-id`, so no retry binds it. Fails if such
/// edits are admitted or the refusal loses its code.
#[tokio::test]
async fn edits_under_an_unassigned_client_id_are_refused_with_their_own_code() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut early) = writer(&env, server.port, "base").await;
    let unassigned = fresh_client_id();
    early
        .send(5, &sync(2, &forged(&early.doc, unassigned, "-early")))
        .await;
    let closed = early.until(4).await.expect("the channel closes");
    assert!(
        String::from_utf8_lossy(&closed).contains("client id"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
    let (rejected, _) = early.stateless("document-rejected").await;
    assert_eq!(rejected["code"], "unassigned");
    let mut next = Client::open(server.port).await;
    assert_eq!(next.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(next.settle(|c| c.block_text() == "base").await);
    next.type_text("-next").await;
    next.until(6).await.expect("the next session writes");
    let rows: i64 = db(&env)
        .await
        .query_one(
            "SELECT count(*) FROM material_yjs_client_ids WHERE material_id=$1 AND client_id=$2",
            &[&material_of(&room), &(unassigned as i64)],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(rows, 0, "an unassigned id is never recorded");
    let mut retry = Client::open(server.port).await;
    retry
        .send(
            0,
            &join_payload_as(
                &room,
                &token(&room, &user, "write"),
                Some(client_protocol()),
                unassigned,
            ),
        )
        .await;
    let reason = text_payload(&retry.until(2).await.expect("refused"));
    assert_eq!(reason, "collaboration-unassigned-id");
}

/// Security regression (Q226, binding review M2): every JOIN guard of the
/// client-id binding refuses: a JOIN naming an id a live read channel holds,
/// or a write token whose worker id one holds, as `collaboration-client-id`,
/// and an id stored as another user's or one its token does not offer that
/// no user holds as `collaboration-unassigned-id`. Fails if any of those
/// guards is removed.
#[tokio::test]
async fn every_join_guard_refuses_a_client_id_it_may_not_bind() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note(&env, "base").await;
    let mut first = Client::open(server.port).await;
    first.joined(&room, &token(&room, &owner, "write")).await;
    assert!(first.settle(|c| c.block_text() == "base").await);
    first.type_text("-a").await;
    first.until(6).await.expect("ack");
    let owners = first.id();
    let refused_as = async |payload: Vec<u8>, why: &str, expected: &str| {
        let mut client = Client::open(server.port).await;
        client.send(0, &payload).await;
        let reason = text_payload(&client.until(2).await.expect(why));
        assert_eq!(reason, expected, "{why}");
    };
    let refused = async |payload: Vec<u8>, why: &str| {
        refused_as(payload, why, "collaboration-client-id").await
    };
    // Another user's stored id, named with the joiner's own fresh token.
    let editors = token(&room, &editor, "write");
    refused_as(
        join_payload_as(&room, &editors, Some(client_protocol()), owners),
        "another user's id",
        "collaboration-unassigned-id",
    )
    .await;
    // A free id other than the one the token offers.
    refused_as(
        join_payload_as(&room, &editors, Some(client_protocol()), fresh_client_id()),
        "an id the token does not offer",
        "collaboration-unassigned-id",
    )
    .await;
    // An id a live read channel holds, though a token offers it.
    let mut reader = Client::open(server.port).await;
    assert_eq!(
        reader.joined(&room, &token(&room, &editor, "read")).await,
        0
    );
    let readers = reader.id();
    refused(
        join_payload_as(
            &room,
            &token_offering(&room, &editor, "write", readers),
            Some(client_protocol()),
            readers,
        ),
        "a read channel's id",
    )
    .await;
    // A worker id that is taken (here the live read channel's).
    let session = fresh_client_id();
    refused(
        join_payload_as(
            &room,
            &token_with_worker(&room, &owner, session, readers),
            Some(client_protocol()),
            session,
        ),
        "a taken worker id",
    )
    .await;
}

/// Security regression (Q226, binding review M1): a channel that joined
/// with a read token and whose refreshed token is writable writes under its
/// bound id, its first write records it, and a reconnect naming the id
/// joins. Fails if the refreshed channel's edits are refused.
#[tokio::test]
async fn a_channel_whose_token_turns_writable_stores_its_id_and_its_edits_land() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "base").await;
    let room = format!("source:{file}:epoch:1");
    let mut client = Client::open(server.port).await;
    assert_eq!(client.joined(&room, &token(&room, &user, "read")).await, 0);
    assert!(client.settle(|c| source_text(c) == "base").await);
    let id = client.id();
    let mut refresh = Vec::new();
    varbytes(&mut refresh, token(&room, &user, "write").as_bytes());
    client.send(11, &refresh).await;
    // The refresh lands before the edit.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let before = client.doc.transact().state_vector();
    client
        .doc
        .get_or_insert_text("source")
        .insert(&mut client.doc.transact_mut(), 0, "w-");
    let edit = client.doc.transact().encode_state_as_update_v1(&before);
    client.send(5, &sync(2, &edit)).await;
    client.until(6).await.expect("the edit is acknowledged");
    // A reconnect names the stored id with a fresh token.
    client.channel += 1;
    client.inbox.clear();
    client
        .send(
            0,
            &join_payload_as(
                &room,
                &token(&room, &user, "write"),
                Some(client_protocol()),
                id,
            ),
        )
        .await;
    assert_eq!(client.until(1).await.expect("the reconnect joins"), [1]);
    let mut reader = Client::open(server.port).await;
    assert_eq!(reader.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(
        reader.settle(|c| source_text(c) == "w-base").await,
        "{}",
        source_text(&reader)
    );
}

/// Security regression (Q226, binding review M4; Q236): a session's id is
/// recorded at its first accepted write off the room's task, so while that
/// insert waits on the database (held here by a table lock) the write is
/// acknowledged and reaches the room's other members, and the row appears
/// once the lock goes. Fails if the room waits on the insert.
#[tokio::test]
async fn a_held_client_id_insert_stalls_no_channel() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note(&env, "base").await;
    let mut a = Client::open(server.port).await;
    a.joined(&room, &token(&room, &owner, "write")).await;
    assert!(a.settle(|c| c.block_text() == "base").await);
    let mut b = Client::open(server.port).await;
    b.joined(&room, &token(&room, &editor, "write")).await;
    assert!(b.settle(|c| c.block_text() == "base").await);
    let lock = db(&env).await;
    lock.batch_execute("BEGIN; LOCK TABLE material_yjs_client_ids IN SHARE MODE")
        .await
        .expect("lock");
    a.type_text("-a").await;
    a.until(6).await.expect("ack while the insert waits");
    assert!(
        b.settle(|c| c.block_text() == "base-a").await,
        "{}",
        b.block_text()
    );
    assert_eq!(id_rows(&env, &room, a.id()).await, 0);
    lock.batch_execute("ROLLBACK").await.expect("unlock");
    assert!(id_rows_reach(&env, &room, a.id(), 1).await);
}

/// Security regression (Q226 M3, Epo 2026-10-24): a room's first write
/// under an id refreshes its row's last write time, a room load clears rows
/// unwritten for 7 days, and an id in the document's history is never bound
/// again though its row is gone. Fails if the first write leaves the row's
/// time alone (a writing session's row would be cleared), if a load clears
/// nothing, or if a cleared id can be bound.
#[tokio::test]
async fn unused_client_id_rows_clear_at_a_room_load_and_their_ids_stay_taken() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note(&env, "base").await;
    let material = material_of(&room).to_owned();
    let pg = db(&env).await;
    let age = async |id: u64| {
        pg.execute(
            "UPDATE material_yjs_client_ids SET last_write_at = now() - interval '8 days'
             WHERE material_id=$1 AND client_id=$2",
            &[&material, &(id as i64)],
        )
        .await
        .expect("age the row");
    };
    let reload = async || {
        wait_unloaded(server.port).await;
        let mut opener = Client::open(server.port).await;
        opener.joined(&room, &token(&room, &editor, "read")).await;
        assert!(opener.settle(|c| c.block_text().starts_with("base")).await);
    };
    let mut first = Client::open(server.port).await;
    first.joined(&room, &token(&room, &owner, "write")).await;
    assert!(first.settle(|c| c.block_text() == "base").await);
    let id = first.id();
    first.type_text("-a").await;
    first.until(6).await.expect("ack");
    assert!(id_rows_reach(&env, &room, id, 1).await);
    first.leave(true).await;
    reload().await;
    // Aged while the room is loaded, the row is refreshed by its first write
    // in this room life.
    first.joined(&room, &token(&room, &owner, "write")).await;
    assert!(first.settle(|c| c.block_text() == "base-a").await);
    age(id).await;
    first.type_text("-b").await;
    first.until(6).await.expect("ack");
    first.leave(true).await;
    reload().await;
    assert_eq!(
        id_rows(&env, &room, id).await,
        1,
        "a row written to in its room's life is kept"
    );
    // Unwritten for 8 days: the next load clears it.
    age(id).await;
    reload().await;
    assert_eq!(
        id_rows(&env, &room, id).await,
        0,
        "a row unwritten for 7 days is cleared"
    );
    // Its id stays in the document's history: no JOIN binds it again,
    // whether its token offers it or not.
    for (user, offer) in [
        (&editor, token_offering(&room, &editor, "write", id)),
        (&owner, token(&room, &owner, "write")),
    ] {
        let mut later = Client::open(server.port).await;
        later
            .send(
                0,
                &join_payload_as(&room, &offer, Some(client_protocol()), id),
            )
            .await;
        let reason = text_payload(&later.until(2).await.expect("refused"));
        assert_eq!(reason, "collaboration-unassigned-id", "{user}");
    }
}

/// A client id in the range reserved for override-seed copies (M5).
const RESERVED_ID: u64 = (1 << 32) + 7;

/// Security regression (r2 N8): until override-seed copies exist, no room
/// admits structs under the range reserved for them (2^32 up to the PPTX
/// bootstrap id), not even from a source file's editor: the source room
/// refuses them as under any unassigned id, and so does a note room. Fails if
/// either room admits a reserved id.
#[tokio::test]
async fn reserved_copy_ids_are_refused_until_override_seeds_exist() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "base").await;
    let room = format!("source:{file}:epoch:1");
    let mut editor = Client::open(server.port).await;
    assert_eq!(editor.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(editor.settle(|c| source_text(c) == "base").await);
    editor
        .send(5, &sync(2, &typed_as(&editor, RESERVED_ID, "r-")))
        .await;
    let closed = editor.until(4).await.expect("the editor's write closes");
    assert!(
        String::from_utf8_lossy(&closed).contains("client id"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
    let (failed, _) = editor.stateless("source-checkpoint-failed").await;
    assert_eq!(failed["code"], "unassigned");
    let (_, _, mut writer) = writer(&env, server.port, "note").await;
    writer
        .send(5, &sync(2, &forged(&writer.doc, RESERVED_ID, "-copy")))
        .await;
    let closed = writer.until(4).await.expect("the note refuses it");
    assert!(
        String::from_utf8_lossy(&closed).contains("client id"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
}

/// Security regression (Epo 2026-10-19): a room keeps at most 256 awareness
/// client ids: 257 sessions, each writing its own id, leave 256 in its
/// states. A removed id counts until its removal went out (rate-limit review
/// r3 S6): a removal and a new session's id in one frame leave 255. Fails if
/// the room keeps every id its members send, or counts only live ids.
#[tokio::test]
async fn a_room_keeps_at_most_256_awareness_client_ids() {
    let Some(env) = env() else { return };
    // One user's 258 channels, past the 22 joined documents a user holds and
    // the 4 connections to one document.
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[
            ("COLLABORATION_JOINED_PER_USER", "300"),
            ("COLLABORATION_CONNECTIONS_PER_DOCUMENT", "300"),
        ],
    )
    .await;
    let (user, room, mut client) = writer(&env, server.port, "crowd").await;
    let mut sessions = vec![(1, client.id())];
    for channel in 2..=258u64 {
        let session = token(&room, &user, "write");
        client
            .send_on(
                channel,
                0,
                &join_payload(&room, &session, Some(client_protocol())),
            )
            .await;
        assert!(client.until(1).await.is_some(), "channel {channel} joined");
        sessions.push((channel, token_client_id(&session).expect("client id")));
    }
    for (channel, id) in &sessions[..257] {
        let entry = awareness_update(*id, 1, "{\"n\":1}");
        client.send_on(*channel, 7, &entry).await;
    }
    assert_eq!(client.awareness_states(1).await.len(), 256);
    let ((removed_channel, removed), (new_channel, new)) = (sessions[1], sessions[257]);
    let mut churn = frame(removed_channel, 7, &awareness_update(removed, 2, "null"));
    churn.extend(frame(
        new_channel,
        7,
        &awareness_update(new, 1, "{\"n\":1}"),
    ));
    client
        .ws
        .send(Ws::Binary(churn.into()))
        .await
        .expect("send");
    assert_eq!(client.awareness_states(1).await.len(), 255);
}

/// Security regression (Epo 2026-10-19): a socket that has joined no room
/// within about 10 s is closed, while one that joined stays open. Fails if
/// an idle socket is kept.
#[tokio::test]
async fn a_socket_that_joins_no_room_closes() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (_, _, mut joined) = writer(&env, server.port, "joined").await;
    let mut idle = Client::open(server.port).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let closed = loop {
        match tokio::time::timeout_at(deadline, idle.ws.next()).await {
            Ok(Some(Ok(Ws::Close(frame)))) => {
                break frame.map(|frame| (u16::from(frame.code), frame.reason.to_string()));
            }
            Ok(Some(Ok(_))) => {}
            _ => break None,
        }
    };
    assert_eq!(closed, Some((1008, "no room joined".into())));
    joined.type_text("!").await;
    assert!(
        joined.until(6).await.is_some(),
        "the joined socket still serves"
    );
}

/// A socket from 127.0.0.1, or from `address` behind Cloudflare.
async fn connect(
    port: u16,
    address: Option<&str>,
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>, tokio_tungstenite::tungstenite::Error> {
    let mut request = format!("ws://127.0.0.1:{port}/")
        .into_client_request()
        .expect("request");
    request
        .headers_mut()
        .insert("origin", ORIGIN.parse().expect("origin"));
    if let Some(address) = address {
        request
            .headers_mut()
            .insert("cf-connecting-ip", address.parse().expect("address"));
    }
    tokio_tungstenite::connect_async(request)
        .await
        .map(|(ws, _)| ws)
}

/// Security regression (Epo 2026-10-19): a client address holds a capped
/// number of sockets (Cloudflare's `CF-Connecting-IP` when present); one more
/// is refused before the upgrade, and a closed one frees its place. Fails if
/// sockets are not counted per address.
#[tokio::test]
async fn a_client_address_holds_a_capped_number_of_sockets() {
    let Some(env) = env() else { return };
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[("COLLABORATION_SOCKETS_PER_ADDRESS", "2")],
    )
    .await;
    let first = connect(server.port, None).await.expect("first");
    let _second = connect(server.port, None).await.expect("second");
    let refused = connect(server.port, None).await;
    assert!(
        matches!(
            &refused,
            Err(tokio_tungstenite::tungstenite::Error::Http(response))
                if response.status() == 429
        ),
        "{refused:?}"
    );
    assert!(connect(server.port, Some("203.0.113.7")).await.is_ok());
    drop(first);
    let mut reopened = None;
    for _ in 0..50 {
        if let Ok(ws) = connect(server.port, None).await {
            reopened = Some(ws);
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(reopened.is_some(), "a closed socket frees its place");
}

/// Security regression (Epo 2026-10-20, rate-limit review r5 S-a): a user
/// holds at most four connections to one document over all their sockets; a
/// fifth closes their oldest one to it (`collaboration-oldest-closed`) and
/// the other four stay. Fails without the per-document cap.
#[tokio::test]
async fn a_fifth_connection_to_one_note_closes_the_users_oldest_to_it() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut oldest) = writer(&env, server.port, "connections").await;
    let write = token(&room, &user, "write");
    let mut others = Vec::new();
    for _ in 0..4 {
        let mut client = Client::open(server.port).await;
        client.joined(&room, &write).await;
        others.push(client);
    }
    let closed = oldest.until(4).await.expect("the oldest closes");
    assert!(
        String::from_utf8_lossy(&closed).contains("collaboration-oldest-closed"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
    for client in &mut others {
        let closes = client.closes_within(Duration::from_millis(300)).await;
        assert!(closes.is_empty(), "{closes:?}");
    }
}

/// Security regression (Epo 2026-10-20): embed channels count toward their
/// own room's four connections, apart from their note's. Four sockets each
/// holding the note and its set inside it keep all eight channels; a fifth
/// connection to the set (a token naming no note, joined on its own) closes
/// the user's oldest embed channel of it, not that socket's note channel.
/// Fails if embed channels are not counted.
#[tokio::test]
async fn embed_channels_count_toward_their_own_rooms_four_connections() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut first) = writer(&env, server.port, "a note").await;
    let note = material_of(&room).to_owned();
    let [set] = embedded_sets(&env, &user, &note, 1)
        .await
        .try_into()
        .expect("one set");
    let write = token(&room, &user, "write");
    let embed = embed_token(&set, &user, &note);
    assert_eq!(first.join_embed(2, &set, &embed).await.0, 1);
    let mut others = Vec::new();
    for _ in 0..3 {
        let mut client = Client::open(server.port).await;
        client.joined(&room, &write).await;
        assert_eq!(client.join_embed(2, &set, &embed).await.0, 1);
        others.push(client);
    }
    let closes = first.closes_within(Duration::from_millis(300)).await;
    assert!(closes.is_empty(), "{closes:?}");
    let mut fifth = Client::open(server.port).await;
    fifth
        .send(
            0,
            &join_payload(&set, &token(&set, &user, "write"), Some(client_protocol())),
        )
        .await;
    assert!(fifth.until(1).await.is_some(), "the fifth connection joins");
    let closes = first.closes_within(Duration::from_secs(1)).await;
    assert_eq!(closes.len(), 1, "{closes:?}");
    assert_eq!(closes[0].0, 2);
    assert!(
        closes[0].1.contains("collaboration-oldest-closed"),
        "{closes:?}"
    );
}

/// Rate-limit review r6 S-3: a join closes only what its caps need. A note's
/// second copy of a set closes the first (its twin) before taking a place
/// among the user's connections to the set, so with four connections to it
/// (two tabs and a phone on their own, the first copy in the note) only the
/// first copy closes. Fails if the twin closes after the places are taken
/// (the oldest tab's connection closes too).
#[tokio::test]
async fn a_twin_embed_closes_before_its_places_are_taken() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut note) = writer(&env, server.port, "a note").await;
    let material = material_of(&room).to_owned();
    let [set] = embedded_sets(&env, &user, &material, 1)
        .await
        .try_into()
        .expect("one set");
    let alone = token(&set, &user, "write");
    let join_alone = |client: Client| {
        let (set, alone) = (set.clone(), alone.clone());
        async move {
            let mut client = client;
            client
                .send(0, &join_payload(&set, &alone, Some(client_protocol())))
                .await;
            assert!(client.until(1).await.is_some(), "joined on its own");
            client
        }
    };
    let mut tabs = vec![
        join_alone(Client::open(server.port).await).await,
        join_alone(Client::open(server.port).await).await,
    ];
    let embed = embed_token(&set, &user, &material);
    assert_eq!(note.join_embed(2, &set, &embed).await.0, 1);
    tabs.push(join_alone(Client::open(server.port).await).await);
    let mut payload = join_payload(&set, &embed, Some(client_protocol()));
    var(&mut payload, 1);
    note.send_on(3, 0, &payload).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut closes = Vec::new();
    'joined: loop {
        for (heard, kind, payload) in note.raw_until(deadline).await {
            if kind == 4 {
                closes.push((heard, String::from_utf8_lossy(&payload).into_owned()));
            }
            if heard == 3 && kind == 1 {
                break 'joined;
            }
        }
    }
    closes.extend(note.closes_within(Duration::from_millis(300)).await);
    assert_eq!(closes.len(), 1, "{closes:?}");
    assert_eq!(closes[0].0, 2);
    assert!(
        closes[0].1.contains("collaboration-embed-closed"),
        "{closes:?}"
    );
    for tab in &mut tabs {
        let closes = tab.closes_within(Duration::from_millis(300)).await;
        assert!(closes.is_empty(), "{closes:?}");
    }
}

/// Rate-limit review r6 S-3: a join past both caps closes one channel. With
/// three joined documents allowed and two connections to one document, a
/// user holding another note and two connections to note N who opens N a
/// third time closes their oldest connection to N, which frees a place among
/// their documents too, so the other note stays. Fails if the joined-documents
/// cap also closes its oldest.
#[tokio::test]
async fn a_join_past_both_caps_closes_only_the_oldest_connection_to_its_document() {
    let Some(env) = env() else { return };
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[
            ("COLLABORATION_JOINED_PER_USER", "3"),
            ("COLLABORATION_CONNECTIONS_PER_DOCUMENT", "2"),
        ],
    )
    .await;
    let (user, _, mut other) = writer(&env, server.port, "another note").await;
    let note = note_of(&env, &user, "note n").await;
    let room = format!("material:{note}:schema:1");
    let write = token(&room, &user, "write");
    let mut connections = Vec::new();
    for _ in 0..3 {
        let mut client = Client::open(server.port).await;
        client.joined(&room, &write).await;
        connections.push(client);
    }
    let closed = connections[0]
        .until(4)
        .await
        .expect("the oldest to N closes");
    assert!(
        String::from_utf8_lossy(&closed).contains("collaboration-oldest-closed"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
    let closes = other.closes_within(Duration::from_millis(500)).await;
    assert!(closes.is_empty(), "{closes:?}");
}

/// Security regression (Epo 2026-10-19): a user holds a capped number of
/// joined documents over all their sockets (22); one more join closes their
/// oldest joined channel instead of being refused, and a channel left frees
/// its place. Fails if joined channels are not counted per user.
#[tokio::test]
async fn a_join_past_the_users_cap_closes_their_oldest_channel() {
    let Some(env) = env() else { return };
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[("COLLABORATION_JOINED_PER_USER", "2")],
    )
    .await;
    let (user, room, mut oldest) = writer(&env, server.port, "channels").await;
    let write = token(&room, &user, "write");
    let mut other = Client::open(server.port).await;
    other.joined(&room, &write).await;
    other
        .send_on(2, 0, &join_payload(&room, &write, Some(client_protocol())))
        .await;
    assert!(other.until(1).await.is_some(), "the new join goes in");
    let closed = oldest.until(4).await.expect("the oldest closes");
    assert!(
        String::from_utf8_lossy(&closed).contains("collaboration-oldest-closed"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
    // The other socket's two channels are the user's two: leaving one makes
    // room for a third without closing the other.
    other.send_on(2, 3, &[]).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    oldest.joined(&room, &write).await;
    assert!(
        oldest.settle(|c| c.block_text() == "channels").await,
        "joined again"
    );
    other.drain().await;
    assert!(other.inbox.iter().all(|message| message.kind != 4));
    let metrics = metrics_text(server.port).await;
    assert!(
        metrics
            .lines()
            .any(|line| line == "capy_collaboration_oldest_closed_total 1"),
        "{metrics}"
    );
}

impl Client {
    /// Joins an embedded set's room on `channel` inside the note channel 1
    /// (Epo 2026-10-20), and waits for the answer to that channel: JOINED
    /// (1), REFUSED (2) or CLOSED (4), with its payload. Nothing read is
    /// applied: the embeds' documents are not this client's.
    async fn join_embed(&mut self, channel: u64, room: &str, token: &str) -> (u8, Vec<u8>) {
        let mut payload = join_payload(room, token, Some(client_protocol()));
        var(&mut payload, 1);
        self.send_on(channel, 0, &payload).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            for (heard, kind, payload) in self.raw_until(deadline).await {
                if heard == channel && matches!(kind, 1 | 2 | 4) {
                    return (kind, payload);
                }
            }
        }
    }

    /// The next frame's messages as (channel, kind, payload), unapplied;
    /// panics at `deadline`.
    async fn raw_until(&mut self, deadline: tokio::time::Instant) -> Vec<(u64, u8, Vec<u8>)> {
        let Ok(Some(Ok(Ws::Binary(bytes)))) =
            tokio::time::timeout_at(deadline, self.ws.next()).await
        else {
            panic!("nothing arrived in time");
        };
        let (mut at, mut messages) = (0, Vec::new());
        while at < bytes.len() {
            let channel = read_var(&bytes, &mut at);
            let kind = bytes[at];
            at += 1;
            let len = read_var(&bytes, &mut at) as usize;
            messages.push((channel, kind, bytes[at..at + len].to_vec()));
            at += len;
        }
        messages
    }

    /// Whether a `kind` message arrives on `channel` within `window`
    /// (answering pings meanwhile).
    async fn heard_within(&mut self, channel: u64, kind: u8, window: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, self.ws.next()).await
            else {
                return false;
            };
            let Ws::Binary(bytes) = message else { continue };
            let mut at = 0;
            while at < bytes.len() {
                let heard = read_var(&bytes, &mut at);
                let heard_kind = bytes[at];
                at += 1;
                let len = read_var(&bytes, &mut at) as usize;
                at += len;
                if (heard, heard_kind) == (channel, kind) {
                    return true;
                }
            }
        }
    }

    /// After a JOIN on `channel`: whether awareness reaches it within `window`
    /// of its JOINED, and the stateless notices it heard after the JOINED
    /// meanwhile; what came before the JOINED (an earlier join's) is skipped.
    async fn awareness_after_join(
        &mut self,
        channel: u64,
        window: Duration,
    ) -> (bool, Vec<String>) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut joined: Option<tokio::time::Instant> = None;
        let mut notices = Vec::new();
        loop {
            let limit = joined.map_or(deadline, |at| at + window);
            let Ok(Some(Ok(message))) = tokio::time::timeout_at(limit, self.ws.next()).await else {
                assert!(joined.is_some(), "channel {channel} joined");
                return (false, notices);
            };
            let Ws::Binary(bytes) = message else { continue };
            let mut at = 0;
            while at < bytes.len() {
                let heard = read_var(&bytes, &mut at);
                let kind = bytes[at];
                at += 1;
                let len = read_var(&bytes, &mut at) as usize;
                let payload = &bytes[at..at + len];
                at += len;
                if heard != channel {
                    continue;
                }
                if kind == 1 {
                    joined = Some(tokio::time::Instant::now());
                } else if kind == 7 && joined.is_some() {
                    return (true, notices);
                } else if kind == 9 && joined.is_some() {
                    notices.push(text_payload(payload));
                }
            }
        }
    }

    /// Whether the socket stays open for `window`, reading (and so answering
    /// pings) meanwhile.
    async fn still_open(&mut self, window: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Err(_) => return true,
                Ok(Some(Ok(Ws::Close(_)))) | Ok(Some(Err(_))) | Ok(None) => return false,
                Ok(Some(Ok(_))) => {}
            }
        }
    }

    /// Every CLOSED heard in the next `window`, as (channel, payload)
    /// (answering pings meanwhile).
    async fn closes_within(&mut self, window: Duration) -> Vec<(u64, String)> {
        let deadline = tokio::time::Instant::now() + window;
        let mut closes = Vec::new();
        while let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, self.ws.next()).await {
            let Ws::Binary(bytes) = message else { continue };
            let mut at = 0;
            while at < bytes.len() {
                let channel = read_var(&bytes, &mut at);
                let kind = bytes[at];
                at += 1;
                let len = read_var(&bytes, &mut at) as usize;
                if kind == 4 {
                    closes.push((
                        channel,
                        String::from_utf8_lossy(&bytes[at..at + len]).into_owned(),
                    ));
                }
                at += len;
            }
        }
        closes
    }
}

/// `count` sets embedded in `note`, owned by `user`: their room names.
async fn embedded_sets(env: &Env, user: &str, note: &str, count: usize) -> Vec<String> {
    let mut rooms = Vec::new();
    for _ in 0..count {
        let set = flashcard_set(env, user, Some(note), &[("c1", "front", "back")]).await;
        rooms.push(format!("material:{set}:schema:1"));
    }
    rooms
}

/// The material id in a `material:<id>:schema:<n>` room name.
fn material_of(room: &str) -> &str {
    room.split(':').nth(1).expect("a material room")
}

/// Security regression (Epo 2026-10-20): an embedded quiz's or set's channel
/// joins inside its note's channel on the same socket and takes no place
/// among the user's joined documents. With a cap of two, a note with 30
/// embeds joined and another document joined keep the note's channel open.
/// Fails if embed channels count toward the cap (the note closes as the
/// oldest).
#[tokio::test]
async fn a_note_with_30_embeds_never_closes_its_own_channel() {
    let Some(env) = env() else { return };
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[("COLLABORATION_JOINED_PER_USER", "2")],
    )
    .await;
    let (user, room, mut client) = writer(&env, server.port, "a note").await;
    let note = material_of(&room).to_owned();
    for (at, set) in embedded_sets(&env, &user, &note, 30)
        .await
        .iter()
        .enumerate()
    {
        let (kind, payload) = client
            .join_embed(at as u64 + 2, set, &embed_token(set, &user, &note))
            .await;
        assert_eq!(kind, 1, "embed {at}: {}", String::from_utf8_lossy(&payload));
    }
    // The user's second document, on a socket of their own: two with the note.
    let _second = second_note(&env, server.port, &user, "second").await;
    let closes = client.closes_within(Duration::from_secs(1)).await;
    assert!(closes.is_empty(), "{closes:?}");
}

/// Security regression (Epo 2026-10-20): the server checks from an embed's
/// token that its material belongs to the note whose channel it names. An
/// embed of another note is refused as forbidden, and naming a channel that
/// is not a joined note is refused as `collaboration-note-closed`. Fails if
/// the token's note is not compared with the channel's.
#[tokio::test]
async fn an_embed_token_for_another_note_is_refused() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, _, mut client) = writer(&env, server.port, "a note").await;
    let other_note = note_of(&env, &user, "another note").await;
    let [set] = embedded_sets(&env, &user, &other_note, 1)
        .await
        .try_into()
        .expect("one set");
    let (kind, payload) = client
        .join_embed(2, &set, &embed_token(&set, &user, &other_note))
        .await;
    assert_eq!(kind, 2);
    assert!(String::from_utf8_lossy(&payload).contains("collaboration-forbidden"));
    // Its own note's channel is not joined here: not a note channel.
    let mut payload = join_payload(
        &set,
        &embed_token(&set, &user, &other_note),
        Some(client_protocol()),
    );
    var(&mut payload, 9);
    client.send_on(3, 0, &payload).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let refused = loop {
        if let Some((_, _, payload)) = client
            .raw_until(deadline)
            .await
            .into_iter()
            .find(|(channel, kind, _)| *channel == 3 && *kind == 2)
        {
            break payload;
        }
    };
    assert!(String::from_utf8_lossy(&refused).contains("collaboration-note-closed"));
}

/// Security regression (rate-limit review r5 S-b): an embed whose note's
/// channel leaves after the embed authenticated but while its room loads is
/// refused `collaboration-note-closed` when the load ends, never joined
/// without its note (it would take no place among the user's documents and
/// never close with a note). The test holds the set's material lock so the
/// load waits. Fails without the note re-check after the load.
#[tokio::test]
async fn an_embed_whose_note_leaves_while_its_room_loads_is_refused() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut client) = writer(&env, server.port, "a note").await;
    let note = material_of(&room).to_owned();
    let [set] = embedded_sets(&env, &user, &note, 1)
        .await
        .try_into()
        .expect("one set");
    let mut db = db(&env).await;
    let lock = db.transaction().await.expect("transaction");
    lock.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        &[&material_of(&set)],
    )
    .await
    .expect("lock");
    let mut payload = join_payload(
        &set,
        &embed_token(&set, &user, &note),
        Some(client_protocol()),
    );
    var(&mut payload, 1);
    client.send_on(2, 0, &payload).await;
    // The embed authenticated once its room's load waits on the lock.
    let mut waiting = false;
    for _ in 0..250 {
        let row = lock
            .query_one(
                "SELECT count(*) FROM pg_locks
                 WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
                   AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)",
                &[&material_of(&set)],
            )
            .await
            .expect("locks");
        if row.get::<_, i64>(0) > 0 {
            waiting = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(waiting, "the embed's room load waits on the lock");
    // The note leaves; a junk JOIN after it answers once the LEAVE is read.
    client.send_on(1, 3, &[]).await;
    client
        .send_on(3, 0, &join_payload(&set, "junk", Some(client_protocol())))
        .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut heard = Vec::new();
    while !heard.iter().any(|(channel, _, _)| *channel == 3) {
        heard.extend(client.raw_until(deadline).await);
    }
    lock.rollback().await.expect("unlock");
    // The room may announce JOINED before the socket hears that the load
    // ended; the socket then refuses the channel.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let refusal = loop {
        if let Some((_, _, payload)) = heard
            .iter()
            .find(|(channel, kind, _)| *channel == 2 && matches!(kind, 2 | 4))
        {
            break Some(String::from_utf8_lossy(payload).into_owned());
        }
        let Ok(Some(Ok(Ws::Binary(bytes)))) =
            tokio::time::timeout_at(deadline, client.ws.next()).await
        else {
            break None;
        };
        let mut at = 0;
        while at < bytes.len() {
            let channel = read_var(&bytes, &mut at);
            let kind = bytes[at];
            at += 1;
            let len = read_var(&bytes, &mut at) as usize;
            heard.push((channel, kind, bytes[at..at + len].to_vec()));
            at += len;
        }
    };
    let refusal = refusal.expect("the embed is refused once its room loaded");
    assert!(refusal.contains("collaboration-note-closed"), "{refusal}");
}

/// Security regression (rate-limit review r5 S-a): a note channel holds an
/// embed's room once. Joining the same set again under it closes the earlier
/// channel (`collaboration-embed-closed`, the client joins it again when near
/// the screen), so one note channel cannot take a room's updates many times
/// over. Fails if both channels stay joined.
#[tokio::test]
async fn joining_an_embed_again_under_its_note_closes_the_earlier_channel() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut client) = writer(&env, server.port, "a note").await;
    let note = material_of(&room).to_owned();
    let [set] = embedded_sets(&env, &user, &note, 1)
        .await
        .try_into()
        .expect("one set");
    let embed = embed_token(&set, &user, &note);
    assert_eq!(client.join_embed(2, &set, &embed).await.0, 1);
    let mut payload = join_payload(&set, &embed, Some(client_protocol()));
    var(&mut payload, 1);
    client.send_on(3, 0, &payload).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut closes = Vec::new();
    'joined: loop {
        for (heard, kind, payload) in client.raw_until(deadline).await {
            if kind == 4 {
                closes.push((heard, String::from_utf8_lossy(&payload).into_owned()));
            }
            if heard == 3 && kind == 1 {
                break 'joined;
            }
        }
    }
    closes.extend(client.closes_within(Duration::from_millis(500)).await);
    assert_eq!(closes.len(), 1, "{closes:?}");
    assert_eq!(closes[0].0, 2);
    assert!(
        closes[0].1.contains("collaboration-embed-closed"),
        "{closes:?}"
    );
}

/// Security regression (Epo 2026-10-20): a note channel holds at most 64
/// embed channels: the 65th closes its oldest (`collaboration-embed-closed`,
/// the client joins it again when near the screen), and leaving the note
/// closes every embed channel it holds (`collaboration-note-closed`). Fails
/// without the per-note cap or if embeds outlive their note.
#[tokio::test]
async fn a_notes_65th_embed_closes_its_oldest_and_leaving_the_note_closes_them_all() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut client) = writer(&env, server.port, "a note").await;
    let note = material_of(&room).to_owned();
    let sets = embedded_sets(&env, &user, &note, 65).await;
    let mut closes = Vec::new();
    for (at, set) in sets.iter().enumerate() {
        let channel = at as u64 + 2;
        let mut payload = join_payload(
            set,
            &embed_token(set, &user, &note),
            Some(client_protocol()),
        );
        var(&mut payload, 1);
        client.send_on(channel, 0, &payload).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        'joined: loop {
            for (heard, kind, payload) in client.raw_until(deadline).await {
                if kind == 4 {
                    closes.push((heard, String::from_utf8_lossy(&payload).into_owned()));
                }
                if heard == channel && kind == 1 {
                    break 'joined;
                }
            }
        }
    }
    closes.extend(client.closes_within(Duration::from_millis(500)).await);
    assert_eq!(closes.len(), 1, "{closes:?}");
    assert_eq!(closes[0].0, 2);
    assert!(
        closes[0].1.contains("collaboration-embed-closed"),
        "{closes:?}"
    );
    client.send_on(1, 3, &[]).await;
    let mut closed: Vec<u64> = client
        .closes_within(Duration::from_secs(2))
        .await
        .into_iter()
        .inspect(|(_, reason)| assert!(reason.contains("collaboration-note-closed"), "{reason}"))
        .map(|(channel, _)| channel)
        .collect();
    closed.sort_unstable();
    assert_eq!(closed, (3..=66).collect::<Vec<u64>>());
}

/// Security regression (rate-limit review r3 S9): a JOIN's token is checked
/// before any lookup, so a junk token costs no Redis round trip (a room under
/// its eviction lease answers a bad token as a bad token, not as busy; a
/// draft send too), and a socket sending only such JOINs still closes at the
/// join deadline. Fails if the lease is looked up first (the source answers
/// `source-publishing`, the draft send 503).
#[tokio::test]
async fn a_join_with_a_bad_token_is_refused_before_any_lookup() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let room = "source:junk:epoch:1";
    let redis = redis::Client::open(env.redis.as_str()).expect("redis");
    let mut connection = redis
        .get_multiplexed_async_connection()
        .await
        .expect("redis connection");
    let lease = format!("capy:collaboration:evicting:{room}");
    let _: () = redis::cmd("SET")
        .arg(&lease)
        .arg("test")
        .arg("EX")
        .arg(60)
        .query_async(&mut connection)
        .await
        .expect("lease");
    let mut socket = Client::open(server.port).await;
    let junk = join_payload(room, "junk", Some(client_protocol()));
    socket.send(0, &junk).await;
    let refused = text_payload(&socket.until(2).await.expect("refused"));
    // A draft send runs the same checks.
    let (status, answer) =
        send_drafts(server.port, room, Some("junk"), Some(ORIGIN), vec![0]).await;
    let _: i64 = redis::cmd("DEL")
        .arg(&lease)
        .query_async(&mut connection)
        .await
        .expect("release");
    assert_eq!(refused, "permission-denied");
    assert_eq!(
        (status, &answer["class"]),
        (403, &serde_json::json!("permission"))
    );
    // Junk JOINs every half second do not hold the deadline open.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(14);
    let closed = loop {
        socket.send(0, &junk).await;
        match tokio::time::timeout(Duration::from_millis(500), socket.ws.next()).await {
            Ok(Some(Ok(Ws::Close(frame)))) => {
                break frame.map(|frame| u16::from(frame.code));
            }
            Ok(Some(Ok(_))) | Err(_) => {}
            Ok(_) => break None,
        }
        assert!(tokio::time::Instant::now() < deadline, "still open");
    };
    assert_eq!(closed, Some(1008));
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
    // Its Undo takes the relocated block out of the live room again.
    assert!(client.settle(|c| c.block("b9").is_some()).await);
    let (status, undone) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &format!("op4_{material}"), &material, &landed),
    )
    .await;
    assert_eq!(status, 200, "{undone}");
    assert!(client.settle(|c| c.block("b9").is_none()).await);

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

/// The Undo (or Redo) Go sends once the payload's signature checked: the
/// actor, the new step's id, the step it reverses and the document (a
/// material's room), with the payload `step` carried (the edit's receipt or
/// the last Undo's answer, each with its `undoPayload`).
fn undo_request(
    user: &str,
    id: &str,
    kind: &str,
    target: &str,
    step: &serde_json::Value,
) -> serde_json::Value {
    let undo_of = step["operationId"].as_str().expect("the step's id");
    sent_back(user, id, undo_of, kind, target, &step["undoPayload"])
}

/// [undo_request] with a payload of the test's own: this internal route
/// comes after the gateway's signature check, which these tests bypass.
fn sent_back(
    user: &str,
    id: &str,
    undo_of: &str,
    kind: &str,
    target: &str,
    payload: &serde_json::Value,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "actorUserId": user,
        "operation": { "id": id, "requestHash": id },
        "target": { "id": target, "kind": kind },
        "undo": payload,
        "undoOf": undo_of,
    });
    if kind == "material" {
        body["room"] = serde_json::json!(format!("material:{target}:schema:1"));
    }
    body
}

/// A note's step: [undo_request] for the material.
fn undo_step(user: &str, id: &str, material: &str, step: &serde_json::Value) -> serde_json::Value {
    undo_request(user, id, "material", material, step)
}

/// Unix seconds now.
fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_secs() as i64
}

/// Waits until the server holds no room: the last editor left and the room
/// stored, folded its log and unloaded.
async fn unloaded(port: u16) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while active_rooms(port).await != 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "a room stayed loaded"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// A note's blocks as the agent reads them (stored state, and a live room's
/// when loaded): (id, text) in order.
async fn note_blocks(port: u16, user: &str, material: &str) -> Vec<(String, String)> {
    let inspect = serde_json::json!({
        "actorUserId": user,
        "room": format!("material:{material}:schema:1"),
        "target": { "id": material, "kind": "material" },
    });
    let (status, view) = internal(port, "/internal/documents/inspect", &inspect).await;
    assert_eq!(status, 200, "{view}");
    view["blocks"]
        .as_array()
        .expect("blocks")
        .iter()
        .map(|block| {
            let text = |key: &str| block[key].as_str().unwrap_or_default().to_owned();
            (text("id"), text("text"))
        })
        .collect()
}

/// An agent edit of a note as Go sends it.
fn note_edit(
    user: &str,
    material: &str,
    id: &str,
    commands: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "actorUserId": user,
        "commands": commands,
        "operation": { "id": id, "requestHash": id },
        "room": format!("material:{material}:schema:1"),
        "target": { "id": material, "kind": "material" },
    })
}

/// Epo 2026-10-20: an agent edit's Undo reverts exactly its own Yjs items,
/// as the editor's undo does: a person's typing inside the agent's text and
/// beside it stays, both peers converge, and Redo puts the agent's text back.
/// The Undo is the payload the edit's receipt carried (Epo 2026-10-21); the
/// stored receipt holds its ref only. A payload sent twice changes nothing
/// the second time. Fails if Undo applies inverse commands under guards
/// again (the typing inside would refuse it).
#[tokio::test]
async fn an_agent_edit_undo_keeps_a_persons_typing_and_redo_restores_it() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "hello world").await;
    let room = format!("material:{material}:schema:1");
    let mut agent_view = Client::open(server.port).await;
    agent_view
        .joined(&room, &token(&room, &user, "write"))
        .await;
    let mut person = Client::open(server.port).await;
    person.joined(&room, &token(&room, &user, "write")).await;
    assert!(person.settle(|c| c.block_text() == "hello world").await);
    let (edit, undo, redo) = (
        format!("e_{material}"),
        format!("u_{material}"),
        format!("r_{material}"),
    );
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(
            &user,
            &material,
            &edit,
            serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "there" }]),
        ),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["effect"]["undo"]["operationId"], edit.as_str());
    let payload = receipt["undoPayload"].clone();
    assert_eq!(payload["epoch"], 1, "{receipt}");
    let update = payload["updates"]["content"]
        .as_str()
        .expect("the content update")
        .to_owned();
    // Editor 2026-10-22: the payload passes through; the receipt row keeps
    // the ref alone (written by the room's store, Q402).
    assert!(receipt_stored(&env, &edit).await);
    let stored: String = db(&env)
        .await
        .query_one(
            "SELECT row_to_json(a)::text FROM agent_operations a WHERE id=$1",
            &[&edit],
        )
        .await
        .expect("receipt")
        .get(0);
    assert!(
        !stored.contains(&update) && !stored.contains("undoPayload"),
        "{stored}"
    );
    assert!(person.settle(|c| c.block_text() == "hello there").await);
    person.type_at(8, "X").await;
    person.type_at(0, "Hi ").await;
    assert!(
        agent_view
            .settle(|c| c.block_text() == "Hi hello thXere")
            .await,
        "{}",
        agent_view.block_text()
    );

    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &undo, &material, &receipt),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["kind"], "undo_edit", "{answer}");
    assert_eq!(answer["effect"]["operation"], "edit_undone", "{answer}");
    let undone = |c: &Client| {
        let text = c.block_text();
        text.contains('X') && text.replace('X', "") == "Hi hello world"
    };
    assert!(person.settle(undone).await, "{}", person.block_text());
    assert!(
        agent_view.settle(undone).await,
        "{}",
        agent_view.block_text()
    );
    // Review r1 M2: the step again under another request (a retry whose
    // answer was lost) answers with the receipt its Undo committed and
    // changes nothing.
    let (status, again) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &format!("u2_{material}"), &material, &receipt),
    )
    .await;
    assert_eq!(
        (status, again["operationId"].as_str()),
        (200, Some(undo.as_str())),
        "{again}"
    );
    let _ = person.hears(200, 300).await;
    assert!(undone(&person), "{}", person.block_text());

    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &redo, &material, &answer),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["effect"]["operation"], "edited", "{answer}");
    let redone = |c: &Client| c.block_text().replace('X', "") == "Hi hello there";
    assert!(person.settle(redone).await, "{}", person.block_text());
    assert!(agent_view.settle(redone).await);
    assert_eq!(agent_view.block_text(), person.block_text());
}

/// Epo 2026-10-21 and 2026-10-22: an agent edit's Undo survives the room
/// closing, and an edit of a note nobody has open gets one too. An insert
/// made with no editor in the note is undone through storage; a removal made
/// in a live room is undone after the room stored, folded its log (the
/// removed block's content collected, its tombstone kept) and unloaded, and
/// that Undo's Redo payload removes it again with no room loaded. Fails if
/// the Undo needs the room that took the edit.
#[tokio::test]
async fn an_agent_edit_undo_survives_the_room_closing() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let p = |id: &str, text: &str| serde_json::json!({ "type": "p", "id": id, "children": [{ "text": text }] });
    let (user, material) = note_with(
        &env,
        serde_json::json!([p("b1", "first"), p("b2", "second")]),
    )
    .await;
    let ids = |blocks: Vec<(String, String)>| -> Vec<String> {
        blocks.into_iter().map(|(id, _)| id).collect()
    };

    // Nobody has the note open: the insert still offers its payload, and its
    // Undo reads and writes the stored state.
    let insert = format!("e1_{material}");
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(
            &user,
            &material,
            &insert,
            serde_json::json!([{ "type": "insert_block", "afterBlockId": "b1", "blocks": [p("n1", "inserted")] }]),
        ),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["effect"]["undo"]["operationId"], insert.as_str());
    assert_eq!(
        ids(note_blocks(server.port, &user, &material).await),
        ["b1", "n1", "b2"]
    );
    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &format!("u1_{material}"), &material, &receipt),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(
        ids(note_blocks(server.port, &user, &material).await),
        ["b1", "b2"]
    );
    // Review r1 M2, L9: an insert-only edit's payload has nothing left to do
    // once applied; the step's retry still answers its Undo's receipt.
    let (status, again) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &format!("u1b_{material}"), &material, &receipt),
    )
    .await;
    assert_eq!(
        (status, again["operationId"].as_str()),
        (200, Some(format!("u1_{material}").as_str())),
        "{again}"
    );

    // A removal in a live room, then the room closes.
    let room = format!("material:{material}:schema:1");
    let removal = format!("e2_{material}");
    let payload = {
        let mut editor = Client::open(server.port).await;
        editor.joined(&room, &token(&room, &user, "write")).await;
        assert!(editor.settle(|c| c.block("b2").is_some()).await);
        let (status, receipt) = internal(
            server.port,
            "/internal/documents/edit",
            &note_edit(
                &user,
                &material,
                &removal,
                serde_json::json!([{ "type": "remove_block", "blockId": "b2", "expectedText": "second" }]),
            ),
        )
        .await;
        assert_eq!(status, 200, "{receipt}");
        assert!(editor.settle(|c| c.block("b2").is_none()).await);
        receipt
    };
    unloaded(server.port).await;
    // The fold runs after the unload.
    let client = db(&env).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let rows: i32 = client
            .query_one(
                "SELECT log_rows FROM material_yjs_documents WHERE material_id=$1",
                &[&material],
            )
            .await
            .expect("row")
            .get(0);
        if rows == 0 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the log stayed unfolded"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &format!("u2_{material}"), &material, &payload),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let mut reader = Client::open(server.port).await;
    reader.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        reader
            .settle(|c| c
                .block("b2")
                .is_some_and(|block| block["children"][0]["text"] == "second"))
            .await,
        "the removed block came back"
    );
    drop(reader);
    unloaded(server.port).await;

    // Redo after the durable Undo, with no room loaded.
    let (status, redone) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &format!("r2_{material}"), &material, &answer),
    )
    .await;
    assert_eq!(status, 200, "{redone}");
    assert_eq!(
        ids(note_blocks(server.port, &user, &material).await),
        ["b1"]
    );
}

/// Q122 (Epo 2026-10-22): today's compaction rebuilds a note with new ids
/// in the next room schema, so a payload made before it is refused with
/// `undo_unavailable` (the chat hides its Undo), sent under the old room or
/// the new one, and the note stays as it is. Fails if the lineage check goes.
#[tokio::test]
async fn a_payload_from_before_a_compaction_is_refused() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "hello world").await;
    let edit = format!("e_{material}");
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(
            &user,
            &material,
            &edit,
            serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "there" }]),
        ),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    db(&env)
        .await
        .execute(
            "UPDATE material_yjs_documents SET room_schema=2 WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("next schema");
    for room in [1, 2] {
        let mut undo = undo_step(&user, &format!("u{room}_{material}"), &material, &receipt);
        undo["room"] = serde_json::json!(format!("material:{material}:schema:{room}"));
        let (status, refusal) = internal(server.port, "/internal/documents/undo", &undo).await;
        assert_eq!(
            (status, refusal["code"].as_str()),
            (409, Some("undo_unavailable")),
            "schema {room}: {refusal}"
        );
    }
}

/// Security regression (durable Undo, Epo 2026-10-21): a payload comes back
/// from the browser, so the server takes nothing from it on trust beyond its
/// signature (checked in Go). One naming items this note does not hold
/// (the same user's other note's payload, so the step's actor check passes,
/// Q432; changed ids) is refused as unheld and nothing is
/// written; one over the 8 MiB update cap is refused before it is read; one
/// that is not base64 is invalid. Fails if a payload is applied unchecked
/// (it would leave the stored note pending, unloadable).
#[tokio::test]
async fn a_tampered_or_oversized_payload_is_refused() {
    use base64::Engine;
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "hello world").await;
    let other = note_for(&env, &user, "hello world").await;
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(
            &user,
            &other,
            &format!("e_{other}"),
            serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": "hello", "text": "howdy" }]),
        ),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    let now = unix_now();
    let cases = [
        (
            "another note's",
            receipt["undoPayload"].clone(),
            409,
            "undo_unavailable",
        ),
        (
            "oversized",
            serde_json::json!({ "epoch": 1, "issuedAt": now, "updates": { "content": encode(&vec![0; ydoc::MAX_UPDATE_BYTES + 1]) } }),
            409,
            "undo_unavailable",
        ),
        (
            "not base64",
            serde_json::json!({ "epoch": 1, "issuedAt": now, "updates": { "content": "%%%" } }),
            400,
            "invalid_input",
        ),
        (
            "another document's name",
            serde_json::json!({ "epoch": 1, "issuedAt": now, "updates": { "source": encode(b"x") } }),
            400,
            "invalid_input",
        ),
    ];
    for (case, payload, status, code) in cases {
        let (answer, refusal) = internal(
            server.port,
            "/internal/documents/undo",
            &sent_back(
                &user,
                &format!("u_{case}_{material}"),
                &format!("e_{other}"),
                "material",
                &material,
                &payload,
            ),
        )
        .await;
        assert_eq!(
            (answer, refusal["code"].as_str()),
            (status, Some(code)),
            "{case}: {refusal}"
        );
    }
    assert_eq!(
        note_blocks(server.port, &user, &material).await,
        [("b1".to_owned(), "hello world".to_owned())]
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
    assert_eq!(rows, 0, "a refused payload wrote nothing");
}

/// Security regression (durable Undo, Epo 2026-10-21): an Undo is written as
/// an edit by its actor, under the actor's current access. An editor whose
/// agent edit offered a payload, then made a viewer, is refused, and the
/// note keeps the edit. Fails if the Undo skips the edit's access check.
#[tokio::test]
async fn an_undo_by_an_actor_who_lost_edit_access_is_refused() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (_, editor, room) = shared_note(&env, "hello world").await;
    let material = material_of(&room).to_owned();
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(
            &editor,
            &material,
            &format!("e_{material}"),
            serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "there" }]),
        ),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    db(&env)
        .await
        .execute(
            "UPDATE workspace_members SET role='viewer' WHERE user_id=$1",
            &[&editor],
        )
        .await
        .expect("demoted");
    let (status, refusal) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&editor, &format!("u_{material}"), &material, &receipt),
    )
    .await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (403, Some("lifecycle_rejected")),
        "{refusal}"
    );
    assert_eq!(
        note_blocks(server.port, &editor, &material).await,
        [("b1".to_owned(), "hello there".to_owned())]
    );
}

/// A source edit as Go sends it.
fn source_edit(user: &str, file: &str, id: &str, commands: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "actorUserId": user,
        "commands": commands,
        "operation": { "id": id, "requestHash": id },
        "target": { "id": file, "kind": "source_file" },
    })
}

/// A source's saved checkpoint.
async fn stored_checkpoint(env: &Env, file: &str) -> i64 {
    db(env)
        .await
        .query_one(
            "SELECT checkpoint FROM source_documents WHERE file_id=$1",
            &[&file],
        )
        .await
        .expect("source row")
        .get(0)
}

/// A receipt's stored Undo ref.
async fn stored_undo(env: &Env, operation: &str) -> Option<String> {
    db(env)
        .await
        .query_one(
            "SELECT effect->'undo'->>'operationId' FROM agent_operations WHERE id=$1",
            &[&operation],
        )
        .await
        .expect("receipt")
        .get(0)
}

/// A source step's Undo: [undo_request] for the file.
fn source_undo(user: &str, id: &str, file: &str, step: &serde_json::Value) -> serde_json::Value {
    undo_request(user, id, "source_file", file, step)
}

/// Review r2 M2, kept for the payload (Epo 2026-10-21): a text source's
/// Undo is written as an edit, through the checkpoint, while a person keeps
/// typing and every store moves the checkpoint (each takes 700 ms here). It
/// lands, and the person's typing stays. Fails if an Undo cannot commit past
/// a busy room.
#[tokio::test]
async fn a_source_undo_lands_while_a_person_keeps_typing() {
    use std::sync::atomic::Ordering::Relaxed;
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "hello world").await;
    let room = format!("source:{file}:epoch:1");
    let mut client = Client::open(server.port).await;
    client.joined(&room, &token(&room, &user, "write")).await;
    assert!(client.settle(|c| source_text(c) == "hello world").await);
    let edit = format!("e_{file}");
    let commands = serde_json::json!([
        { "type": "replace_text", "expectedText": "world", "text": "there" }
    ]);
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &source_edit(&user, &file, &edit, commands),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    // The room's checkpoint writes the receipt with its ref (Q402).
    assert!(receipt_stored(&env, &edit).await);
    assert_eq!(
        (
            receipt["effect"]["undo"]["operationId"].as_str(),
            stored_undo(&env, &edit).await.as_deref()
        ),
        (Some(edit.as_str()), Some(edit.as_str())),
        "{receipt}"
    );
    assert_eq!(receipt["undoPayload"]["epoch"], 1, "{receipt}");
    assert!(client.settle(|c| source_text(c) == "hello there").await);

    gateway.checkpoint_delay.store(700, Relaxed);
    let (port, body) = (
        server.port,
        source_undo(&user, &format!("u_{file}"), &file, &receipt),
    );
    let undo = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        internal(port, "/internal/documents/undo", &body).await
    });
    let started = std::time::Instant::now();
    while !undo.is_finished() && started.elapsed() < Duration::from_secs(15) {
        type_at_start(&mut client, "x").await;
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let (status, answer) = undo.await.expect("the Undo request");
    gateway.checkpoint_delay.store(0, Relaxed);
    assert_eq!(status, 200, "{answer}");
    assert!(
        client
            .settle(|c| source_text(c).trim_start_matches('x') == "hello world")
            .await,
        "{}",
        source_text(&client)
    );
}

/// Epo 2026-10-21: an agent edit whose Undo would send more than the room
/// may take offers no Undo, judged by its commands' estimate
/// (`sources::undo_cost`: three bytes per byte removed or inserted). A
/// removal is a small update whose Undo brings the text back: here past a
/// source room's admission headroom. An edit whose Undo fitted when it
/// landed is refused once a person filled the room past the payload's own
/// size (the payload is checked as an edit is); one that does not fit when
/// it lands gets no Undo ref and no payload. Fails if the estimate is not
/// checked at the edit or the payload's size at the Undo.
#[tokio::test]
async fn an_undo_too_large_for_the_room_is_not_offered() {
    let Some(env) = env() else { return };
    let _cap = ExportCap::lower(&env).await;
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    // 600 KiB of room past the write reserve; the agent removes a 150 KB span
    // (its Undo estimated at 450 KB), then a 140 KB one (420 KB).
    let first = format!("<{}>", "x".repeat(150_000));
    let second = format!("{{{}}}", "y".repeat(140_000));
    let growth = sources::STATE_WRITE_RESERVE_BYTES as usize + 600 * 1024;
    let rest = LOWERED_EXPORT_CAP as usize
        - sources::STATE_GROWTH_MARGIN_BYTES as usize
        - growth
        - first.len()
        - second.len();
    let base = format!("{first}{second}{}", "a".repeat(rest));
    let (user, file) = text_file(&env, &gateway, &base).await;
    let room = format!("source:{file}:epoch:1");
    let mut client = Client::open(server.port).await;
    client.joined(&room, &token(&room, &user, "write")).await;
    assert!(client.settle(|c| source_text(c).len() == base.len()).await);
    let remove = |id: &str, span: &str| {
        let commands = serde_json::json!([
            { "type": "replace_text", "expectedText": span, "text": "" }
        ]);
        source_edit(&user, &file, id, commands)
    };
    let edit = format!("e1_{file}");
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &remove(&edit, &first),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(
        receipt["effect"]["undo"]["operationId"],
        edit.as_str(),
        "{receipt}"
    );
    // The removal freed its 150 KB; a person's 680 KiB fits the room after
    // it and leaves about 66 KiB, less than the 150 KB the Undo brings back.
    type_at_start(&mut client, &"p".repeat(680 * 1024)).await;
    source_receipt(&mut client, "filled")
        .await
        .expect("the person's text stored");
    let (status, refusal) = internal(
        server.port,
        "/internal/documents/undo",
        &source_undo(&user, &format!("u_{file}"), &file, &receipt),
    )
    .await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (409, Some("undo_unavailable")),
        "{refusal}"
    );
    let late = format!("e2_{file}");
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &remove(&late, &second),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert!(
        receipt["effect"]["undo"].is_null() && receipt["undoPayload"].is_null(),
        "{receipt}"
    );
    assert!(
        client
            .settle(|c| source_text(c).trim_start_matches('p').len() == rest)
            .await
    );
}

/// Epo 2026-10-21, a DOCX end to end through the room: an agent's
/// insert_paragraph reaches the open editor; the editor leaves and the room
/// unloads; the Undo, from the payload alone, takes the paragraph out of the
/// stored file; its Redo payload puts it back. Fails if an Office Undo needs
/// the room that took the edit.
#[tokio::test]
async fn a_docx_undo_and_redo_survive_the_room_closing() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    const INSERTED: &str = "Inserted by the agent";
    let (user, file, _) = office_file(&env, &gateway, "docx").await;
    let room = format!("source:{file}:epoch:1");
    let inspect = serde_json::json!({
        "actorUserId": user,
        "office": { "start": 0, "count": 200 },
        "target": { "id": file, "kind": "source_file" },
    });
    let (_, before) = office_entries(server.port, &inspect).await;
    let (anchor, _) = before
        .iter()
        .find(|(_, text)| text.starts_with("Owner sentence"))
        .cloned()
        .expect("the owner sentence");
    let texts = |entries: &[(String, String)]| -> Vec<String> {
        entries.iter().map(|(_, text)| text.clone()).collect()
    };
    let payload = {
        let mut client = Client::open(server.port).await;
        assert_eq!(client.joined(&room, &token(&room, &user, "write")).await, 1);
        let (status, receipt) = internal(
            server.port,
            "/internal/documents/edit",
            &source_edit(
                &user,
                &file,
                &format!("e_{file}"),
                serde_json::json!([{ "type": "insert_paragraph", "afterId": anchor, "text": INSERTED }]),
            ),
        )
        .await;
        assert_eq!(status, 200, "{receipt}");
        assert!(
            client
                .settle(|c| String::from_utf8_lossy(&c.received).contains(INSERTED))
                .await,
            "the writer receives the inserted paragraph"
        );
        receipt
    };
    unloaded(server.port).await;
    let (_, edited) = office_entries(server.port, &inspect).await;
    assert!(texts(&edited).contains(&INSERTED.to_owned()));

    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &source_undo(&user, &format!("u_{file}"), &file, &payload),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let (_, undone) = office_entries(server.port, &inspect).await;
    assert_eq!(
        texts(&undone),
        texts(&before),
        "the Undo takes the paragraph out"
    );

    let (status, redone) = internal(
        server.port,
        "/internal/documents/undo",
        &source_undo(&user, &format!("r_{file}"), &file, &answer),
    )
    .await;
    assert_eq!(status, 200, "{redone}");
    let (_, again) = office_entries(server.port, &inspect).await;
    assert_eq!(texts(&again), texts(&edited), "the Redo puts it back");
}

/// Review M2, kept for the payload: a quiz edit writes its content and keys
/// documents, and its payload reverts both in one commit, after both rooms
/// unloaded. Fails if a quiz's Undo leaves a document behind.
#[tokio::test]
async fn a_quiz_undo_reverts_both_its_documents_after_the_rooms_close() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let quiz = quiz_material(&env, &owner, "private").await;
    let content_room = format!("material:{quiz}:schema:1");
    let keys_room = format!("keys:{quiz}:schema:1");
    let has_q3 = |c: &Client| map_at(&c.doc, &["questions", "q3"]).is_some();
    let has_keys = |c: &Client| map_at(&c.doc, &["keys", "q3-p"]).is_some();
    let question = serde_json::json!({
        "type": "quiz_question", "id": "q3", "children": [{ "text": "" }],
        "question": {
            "id": "q3", "layout": "paper", "labels": "letters", "stem": [],
            "parts": [{
                "id": "q3-p", "blocks": [{ "type": "text", "text": "Order these." }],
                "answer": { "type": "ordering", "items": ["a", "b"] }, "marks": 1, "solution": [],
            }],
        },
    });
    let payload = {
        let mut content = Client::open(server.port).await;
        let mut keys = Client::open(server.port).await;
        content
            .joined(&content_room, &token(&content_room, &owner, "write"))
            .await;
        keys.joined(&keys_room, &token(&keys_room, &owner, "write"))
            .await;
        let (status, receipt) = internal(
            server.port,
            "/internal/documents/edit",
            &note_edit(
                &owner,
                &quiz,
                &format!("e_{quiz}"),
                serde_json::json!([{ "type": "insert_child", "parentType": "quiz", "afterNodeId": "q2", "node": question }]),
            ),
        )
        .await;
        assert_eq!(status, 200, "{receipt}");
        assert!(content.settle(has_q3).await);
        assert!(keys.settle(has_keys).await);
        let payload = &receipt["undoPayload"];
        assert!(
            payload["updates"]["content"].is_string()
                && payload["updates"]["keys"].is_string()
                && payload["issuedAt"].is_i64(),
            "{receipt}"
        );
        receipt
    };
    unloaded(server.port).await;
    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&owner, &format!("u_{quiz}"), &quiz, &payload),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let mut content = Client::open(server.port).await;
    let mut keys = Client::open(server.port).await;
    content
        .joined(&content_room, &token(&content_room, &owner, "write"))
        .await;
    keys.joined(&keys_room, &token(&keys_room, &owner, "write"))
        .await;
    assert!(
        content
            .settle(|c| map_at(&c.doc, &["questions", "q2"]).is_some() && !has_q3(c))
            .await
    );
    assert!(
        keys.settle(|c| map_at(&c.doc, &["keys", "q2-p"]).is_some() && !has_keys(c))
            .await
    );
}

/// A note holding `value`, owned by a fresh user; returns (user, material).
async fn note_with(env: &Env, value: serde_json::Value) -> (String, String) {
    let (user, material) = note(env, "").await;
    db(env)
        .await
        .execute(
            "UPDATE materials SET content=$2 WHERE id=$1",
            &[
                &material,
                &serde_json::json!({ "schemaVersion": 1, "value": value }),
            ],
        )
        .await
        .expect("content");
    (user, material)
}

/// Review M4, kept for the payload: an Undo whose result the note's check
/// would refuse (an earlier removal of an interactive block undone after a
/// later edit brought the note back to ten) answers `invalid_input`, writes
/// nothing, and the same payload lands once the note has room again.
#[tokio::test]
async fn an_undo_the_note_check_refuses_writes_nothing() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let embed = |id: &str| {
        serde_json::json!({
            "id": id, "type": "html_embed", "caption": "Snippet",
            "html": "<div>snippet</div>", "children": [{ "text": "" }],
        })
    };
    let mut value: Vec<serde_json::Value> = (0..10).map(|n| embed(&format!("h{n}"))).collect();
    value.push(serde_json::json!({ "type": "p", "id": "p1", "children": [{ "text": "end" }] }));
    let (user, material) = note_with(&env, serde_json::Value::Array(value)).await;
    let room = format!("material:{material}:schema:1");
    let mut client = Client::open(server.port).await;
    client.joined(&room, &token(&room, &user, "write")).await;
    assert!(client.settle(|c| c.block("h9").is_some()).await);
    let text = note_blocks(server.port, &user, &material)
        .await
        .into_iter()
        .find(|(id, _)| id == "h0")
        .map(|(_, text)| text)
        .expect("h0");
    let (status, removal) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(
            &user,
            &material,
            &format!("e1_{material}"),
            serde_json::json!([{ "type": "remove_block", "blockId": "h0", "expectedText": text }]),
        ),
    )
    .await;
    assert_eq!(status, 200, "{removal}");
    assert!(client.settle(|c| c.block("h0").is_none()).await);
    let (status, insert) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(
            &user,
            &material,
            &format!("e2_{material}"),
            serde_json::json!([{ "type": "insert_block", "afterBlockId": "p1", "blocks": [embed("h10")] }]),
        ),
    )
    .await;
    assert_eq!(status, 200, "{insert}");
    assert!(client.settle(|c| c.block("h10").is_some()).await);

    let (status, refusal) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &format!("u1_{material}"), &material, &removal),
    )
    .await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (409, Some("invalid_input")),
        "{refusal}"
    );
    let _ = client.hears(200, 500).await;
    assert!(client.block("h0").is_none() && client.block("h10").is_some());

    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &format!("u2_{material}"), &material, &insert),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &format!("u3_{material}"), &material, &removal),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert!(
        client
            .settle(|c| c.block("h0").is_some() && c.block("h10").is_none())
            .await
    );
}

#[tokio::test]
async fn an_edit_of_a_rebuilt_material_lists_its_blocks() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "hello world").await;
    let edit = |operation: &str| {
        serde_json::json!({
            "actorUserId": user,
            "commands": [{ "type": "replace_text", "blockId": "b1", "expectedText": "hello", "text": "hi" }],
            "operation": { "id": format!("{operation}_{material}"), "requestHash": operation },
            "room": format!("material:{material}:schema:1"),
            "target": { "id": material, "kind": "material" },
        })
    };
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &edit("op1")).await;
    assert_eq!(status, 200, "{receipt}");
    db(&env)
        .await
        .execute(
            "UPDATE material_yjs_documents SET room_schema=2 WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("rebuild");
    let (status, refusal) = internal(server.port, "/internal/documents/edit", &edit("op2")).await;
    assert_eq!(status, 409, "{refusal}");
    assert_eq!(refusal["code"], "stale_target", "{refusal}");
    assert_eq!(
        refusal["details"],
        serde_json::json!({ "blocks": [{ "id": "b1", "text": "hi world", "type": "p" }], "total": 1 }),
        "{refusal}"
    );
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

/// A text source's edit whose expected text occurs more than once refuses
/// with the line of each occurrence, through the sources crate to the
/// gateway (Epo 2026-10-14).
#[tokio::test]
async fn an_ambiguous_text_source_edit_lists_its_lines() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "the cat\nthe dog\n").await;
    let edit = serde_json::json!({
        "actorUserId": user,
        "commands": [{ "type": "replace_text", "expectedText": "the", "text": "a" }],
        "operation": { "id": format!("op_{file}"), "requestHash": "h1" },
        "target": { "id": file, "kind": "source_file" },
    });
    let (status, refusal) = internal(server.port, "/internal/documents/edit", &edit).await;
    assert_eq!(status, 409, "{refusal}");
    assert_eq!(refusal["code"], "invalid_input", "{refusal}");
    assert_eq!(
        refusal["details"],
        serde_json::json!({ "lines": [
            { "start": 0, "text": "the cat" },
            { "start": 8, "text": "the dog" },
        ] }),
        "{refusal}"
    );
}

// ------------------------------------------------------------ source rooms

/// A stand-in for the Go API's internal source routes: the session, access,
/// the base bytes and the delta-save checkpoint (an Office save's seed SHA
/// too).
#[derive(Clone)]
struct Gateway {
    database: String,
    url: String,
    blobs: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>>,
    /// How long a base download takes (a slow room load).
    delay: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// Base downloads started.
    downloads: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// How long a checkpoint takes (a slow store), and the ones started.
    checkpoint_delay: std::sync::Arc<std::sync::atomic::AtomicU64>,
    checkpoints: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// The workspace each checkpoint named (Q459).
    saved_in: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
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
    gateway
        .checkpoints
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    gateway
        .saved_in
        .lock()
        .expect("saved in")
        .push(body["workspaceId"].as_str().unwrap_or("<none>").to_owned());
    let delay = gateway
        .checkpoint_delay
        .load(std::sync::atomic::Ordering::Relaxed);
    tokio::time::sleep(Duration::from_millis(delay)).await;
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
    // A direct edit's operation stored already: its receipt answers, and
    // nothing is saved (Go's replay, review r2 M1).
    if let Some(id) = body["operation"]["receipt"]["id"].as_str()
        && let Some(stored) = txn
            .query_opt(
                "SELECT kind, effect FROM agent_operations WHERE id=$1",
                &[&id],
            )
            .await
            .expect("receipt")
    {
        let saved = serde_json::json!({
            "checkpoint": checkpoint,
            "operation": {
                "effect": stored.get::<_, serde_json::Value>(1),
                "kind": stored.get::<_, String>(0),
                "operationId": id,
                "outcome": "succeeded",
            },
            "replayed": true,
        });
        return axum::Json(saved).into_response();
    }
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
        "UPDATE source_documents SET checkpoint=$2,pending_effects=$3,net_tokens=$4,log_bytes=log_bytes+$5,log_rows=log_rows+1,seed_bytes=COALESCE($6,seed_bytes),base_source_sha256=COALESCE($7,base_source_sha256),state_seed_sha256=COALESCE($8,state_seed_sha256),last_edited_at=now() WHERE file_id=$1",
        &[
            &id,
            &next,
            &body["pendingEffects"],
            &body["netTokens"].as_i64().unwrap_or(0),
            &(update.len() as i64),
            &body["seedBytes"].as_i64(),
            &body["baseSourceSHA256"].as_str(),
            &body["stateSeedSHA256"].as_str(),
        ],
    )
    .await
    .expect("checkpoint");
    // A text save's list-card text, as Go writes it.
    if let Some(preview) = body["preview"].as_str() {
        txn.execute(
            "UPDATE files SET preview=jsonb_build_object('text',$2::text) WHERE id=$1",
            &[&id, &preview],
        )
        .await
        .expect("preview");
    }
    // An agent edit's receipt commits with its checkpoint and comes back
    // with it, as Go stores it (no Undo ref: the collaboration service adds
    // it with the payload); an Undo's names the step it reverses (r1 M2).
    let mut saved = serde_json::json!({ "checkpoint": next });
    // A room save's agent steps (Q402) go in as the direct edit's does, each
    // with its Undo ref; one stored already is passed over.
    let mut operations: Vec<&serde_json::Value> = body["operations"]
        .as_array()
        .map(|operations| operations.iter().collect())
        .unwrap_or_default();
    let direct = body
        .get("operation")
        .filter(|operation| !operation.is_null());
    operations.extend(direct);
    for operation_body in operations {
        let receipt = &operation_body["receipt"];
        let operation = receipt["id"].as_str().unwrap_or_default().to_owned();
        let undo_of = operation_body["undoOf"].as_str();
        let (kind, done) = match undo_of {
            Some(step) => {
                let undone: Option<String> = txn
                    .query_one(
                        "SELECT effect->>'operation' FROM agent_operations WHERE id=$1",
                        &[&step],
                    )
                    .await
                    .expect("step")
                    .get(0);
                let done = if undone.as_deref() == Some("edit_undone") {
                    "edited"
                } else {
                    "edit_undone"
                };
                ("undo_edit", done)
            }
            None => ("edit_document", "edited"),
        };
        let mut effect = serde_json::json!({
            "operation": done, "operationId": operation,
            "resource": { "id": id, "kind": "source_file" },
        });
        if !operation_body["undo"].is_null() {
            effect["undo"] = operation_body["undo"].clone();
        }
        txn.execute(
            "INSERT INTO agent_operations (id,kind,request_hash,actor_user_id,outcome,effect,undo_of)
             VALUES ($1,$2,$3,$4,'succeeded',$5,$6) ON CONFLICT DO NOTHING",
            &[
                &operation,
                &kind,
                &receipt["requestHash"].as_str().unwrap_or_default(),
                &receipt["actorUserId"].as_str(),
                &effect,
                &undo_of,
            ],
        )
        .await
        .expect("receipt");
        if direct == Some(operation_body) {
            saved["operation"] = serde_json::json!({
                "effect": effect, "kind": kind, "operationId": operation,
                "outcome": "succeeded",
            });
        }
    }
    txn.commit().await.expect("commit");
    axum::Json(saved).into_response()
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
        checkpoint_delay: Default::default(),
        checkpoints: Default::default(),
        saved_in: Default::default(),
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

/// Q459 (Epo 2026-10-28, with Q447): a source room's save names the
/// workspace its room opened the file in, which Go checks every contributor
/// against. A Move (the file's row names another workspace) and its drain:
/// the final save, the only one under a minute's debounce, still names the
/// old workspace, and the room reopens on the new one with the edit. Fails
/// if a save names the file's current workspace or none.
#[tokio::test]
async fn a_moved_files_drain_save_names_the_workspace_its_room_opened() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_configured(
        &env,
        Some(&gateway.url),
        &[
            ("COLLABORATION_DEBOUNCE_MS", "60000"),
            ("COLLABORATION_MAX_DEBOUNCE_MS", "60000"),
        ],
    )
    .await;
    let (user, file) = text_file(&env, &gateway, "base").await;
    let client_db = db(&env).await;
    let opened: String = client_db
        .query_one("SELECT workspace_id FROM files WHERE id=$1", &[&file])
        .await
        .expect("file")
        .get(0);
    let room = format!("source:{file}:epoch:1");
    let mut writer = Client::open(server.port).await;
    assert_eq!(writer.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(writer.settle(|c| source_text(c) == "base").await);
    let edit = typed_as(&writer, writer.id(), "moved-");
    writer
        .doc
        .transact_mut()
        .apply_update(Update::decode_v1(&edit).expect("edit"))
        .expect("apply");
    writer.send(5, &sync(2, &edit)).await;
    writer.until(6).await.expect("the edit is acknowledged");
    let target = format!("ws_it_moved_{}", uuid_like());
    client_db
        .execute(
            "INSERT INTO workspaces (id,user_id,name,privacy) VALUES ($1,$2,'IT','private')",
            &[&target, &user],
        )
        .await
        .expect("target");
    client_db
        .execute(
            "UPDATE files SET workspace_id=$2 WHERE id=$1",
            &[&file, &target],
        )
        .await
        .expect("moved");
    let redis = redis::Client::open(env.redis.as_str()).expect("redis");
    let mut connection = redis
        .get_multiplexed_async_connection()
        .await
        .expect("redis connection");
    let event = serde_json::json!({
        "evictionId": format!("cev_{}", uuid_like()),
        "fileId": file,
        "room": room,
        "type": "file-moved",
        "mode": "drain",
        "workspaceId": target,
    });
    let _: i64 = redis::cmd("PUBLISH")
        .arg("capy:collaboration:evict")
        .arg(event.to_string())
        .query_async(&mut connection)
        .await
        .expect("publish");
    let mut saved = Vec::new();
    for _ in 0..100 {
        saved = gateway.saved_in.lock().expect("saved in").clone();
        if !saved.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(saved, vec![opened], "the drain's save");
    wait_unloaded(server.port).await;
    let mut reader = Client::open(server.port).await;
    assert_eq!(reader.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(
        reader.settle(|c| source_text(c) == "moved-base").await,
        "{}",
        source_text(&reader)
    );
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

/// Lowers every plan's source file cap, the export cap a source room reads at
/// load, for one test so its base stays small; restores it when dropped,
/// panics included. Tests that lower it take turns, but it edits the whole
/// test database's `plan_limits`: a source room another test loads meanwhile
/// gets the lowered cap, so the suite needs `--test-threads=1` (as CI runs it)
/// once such a test holds a base past 1 MiB.
struct ExportCap {
    database: String,
    before: Vec<(String, i64)>,
    _turn: tokio::sync::MutexGuard<'static, ()>,
}

static EXPORT_CAP_TURN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The lowered cap: 1 MiB of growth for a small base, under the 1 MiB margin.
const LOWERED_EXPORT_CAP: i64 = 2 * 1024 * 1024;

impl ExportCap {
    async fn lower(env: &Env) -> Self {
        let turn = EXPORT_CAP_TURN.lock().await;
        let client = db(env).await;
        let before = client
            .query(
                "SELECT plan_tier, source_file_max_bytes FROM plan_limits",
                &[],
            )
            .await
            .expect("plan limits")
            .iter()
            .map(|row| (row.get(0), row.get(1)))
            .collect();
        client
            .execute(
                "UPDATE plan_limits SET source_file_max_bytes=$1",
                &[&LOWERED_EXPORT_CAP],
            )
            .await
            .expect("lower the cap");
        ExportCap {
            database: env.database.clone(),
            before,
            _turn: turn,
        }
    }
}

impl Drop for ExportCap {
    fn drop(&mut self) {
        let (database, before) = (self.database.clone(), std::mem::take(&mut self.before));
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime")
                .block_on(async move {
                    let (client, connection) =
                        tokio_postgres::connect(&database, tokio_postgres::NoTls)
                            .await
                            .expect("postgres");
                    tokio::spawn(connection);
                    for (tier, bytes) in before {
                        client
                            .execute(
                                "UPDATE plan_limits SET source_file_max_bytes=$2 WHERE plan_tier=$1",
                                &[&tier, &bytes],
                            )
                            .await
                            .expect("restore the cap");
                    }
                });
        })
        .join()
        .expect("restore the plan limits");
    }
}

/// A text source of `growth` bytes of room under the lowered export cap
/// (less the margin), joined by a writer; returns the writer, user and file.
async fn capped_text_source(
    env: &Env,
    gateway: &Gateway,
    server: &Server,
    growth: usize,
) -> (Client, String, String, String) {
    let base = format!(
        "{}END",
        "a".repeat(
            LOWERED_EXPORT_CAP as usize - sources::STATE_GROWTH_MARGIN_BYTES as usize - growth - 3
        )
    );
    let (user, file) = text_file(env, gateway, &base).await;
    let room = format!("source:{file}:epoch:1");
    let mut client = Client::open(server.port).await;
    assert_eq!(client.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(client.settle(|c| source_text(c).len() == base.len()).await);
    (client, user, file, base)
}

/// Types `text` at the start of the writer's source and sends it.
async fn type_at_start(client: &mut Client, text: &str) {
    let before = client.doc.transact().state_vector();
    client
        .doc
        .get_or_insert_text("source")
        .insert(&mut client.doc.transact_mut(), 0, text);
    let update = client.doc.transact().encode_state_as_update_v1(&before);
    client.send(5, &sync(2, &update)).await;
}

fn closed_for_size(closed: Option<Vec<u8>>) {
    let closed = closed.expect("closed");
    assert!(
        String::from_utf8_lossy(&closed).contains("exceeds byte limit"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
}

/// Epo 2026-10-17: a source room grows by at most the export cap (the
/// largest plan source file) less its base file and a margin, not up to the
/// ceiling every room shares. A base that leaves no room refuses the first
/// keystroke.
#[tokio::test]
async fn a_source_room_refuses_growth_past_its_export_cap() {
    let Some(env) = env() else { return };
    let _cap = ExportCap::lower(&env).await;
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (mut client, ..) = capped_text_source(&env, &gateway, &server, 0).await;
    type_at_start(&mut client, "x").await;
    closed_for_size(client.until(4).await);
}

/// Security regression (Q213): a source room admits structs only under the
/// writer's assigned client ids, like a note. An update under an id nobody
/// was assigned closes the writer's channel, the room reports its checkpoint
/// failed for good (the page shows recovery instead of sending it again) and
/// keeps nothing of it. Fails if a source room skips the binding.
#[tokio::test]
async fn a_source_room_refuses_an_update_under_an_unassigned_client_id() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "base").await;
    let room = format!("source:{file}:epoch:1");
    let mut client = Client::open(server.port).await;
    assert_eq!(client.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(client.settle(|c| source_text(c) == "base").await);
    let stray = Doc::with_options(ydoc::doc_options(fresh_client_id()));
    let state = client
        .doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    stray
        .transact_mut()
        .apply_update(Update::decode_v1(&state).expect("state"))
        .expect("apply");
    stray
        .get_or_insert_text("source")
        .insert(&mut stray.transact_mut(), 0, "x");
    let update = stray
        .transact()
        .encode_state_as_update_v1(&client.doc.transact().state_vector());
    client.send(5, &sync(2, &update)).await;
    let closed = client.until(4).await.expect("the writer's channel closes");
    assert!(
        String::from_utf8_lossy(&closed).contains("client id"),
        "{}",
        String::from_utf8_lossy(&closed)
    );
    let (failed, _) = client.stateless("source-checkpoint-failed").await;
    assert_eq!(failed["recoverable"], false);
    let mut reader = Client::open(server.port).await;
    assert_eq!(reader.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(
        reader.settle(|c| source_text(c) == "base").await,
        "{}",
        source_text(&reader)
    );
}

/// `client`'s source text with `text` typed at its start under `id`, as an
/// update over `client`'s state.
fn typed_as(client: &Client, id: u64, text: &str) -> Vec<u8> {
    let doc = Doc::with_options(ydoc::doc_options(id));
    let state = client
        .doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    doc.transact_mut()
        .apply_update(Update::decode_v1(&state).expect("state"))
        .expect("apply");
    doc.get_or_insert_text("source")
        .insert(&mut doc.transact_mut(), 0, text);
    doc.transact()
        .encode_state_as_update_v1(&client.doc.transact().state_vector())
}

/// Security regression (Q219, Q236): a DOCX session's second id, for its
/// editor's resident layout worker, binds with the session's own at its
/// JOIN, so the worker's edits land, and its first write records it while
/// the session's id, unwritten, stays unrecorded. Fails if a worker's edits
/// are refused (every DOCX keystroke) or its id is not recorded.
#[tokio::test]
async fn a_sessions_worker_client_id_binds_with_its_own_and_is_recorded_when_it_writes() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "base").await;
    let room = format!("source:{file}:epoch:1");
    let (client_id, worker) = (fresh_client_id(), fresh_client_id());
    let mut client = Client::open(server.port).await;
    let first = token_with_worker(&room, &user, client_id, worker);
    assert_eq!(client.joined(&room, &first).await, 1);
    assert!(client.settle(|c| source_text(c) == "base").await);
    assert_eq!(client.id(), client_id);
    let edit = typed_as(&client, worker, "w-");
    client
        .doc
        .transact_mut()
        .apply_update(Update::decode_v1(&edit).expect("edit"))
        .expect("apply");
    client.send(5, &sync(2, &edit)).await;
    client
        .until(6)
        .await
        .expect("the worker's edit is acknowledged");
    assert!(id_rows_reach(&env, &room, worker, 1).await);
    assert_eq!(id_rows(&env, &room, client_id).await, 0);
    let mut reader = Client::open(server.port).await;
    assert_eq!(reader.joined(&room, &token(&room, &user, "write")).await, 1);
    assert!(
        reader.settle(|c| source_text(c) == "w-base").await,
        "{}",
        source_text(&reader)
    );
}

/// Epo 2026-10-17: an agent's edit counts toward the room's running size, so
/// a writer's update that fits only beside an uncounted agent edit takes the
/// exact measure and is refused.
#[tokio::test]
async fn an_agent_edit_counts_toward_a_source_rooms_cap() {
    let Some(env) = env() else { return };
    let _cap = ExportCap::lower(&env).await;
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    // 100 KiB of room past the write reserve.
    let growth = sources::STATE_WRITE_RESERVE_BYTES as usize + 100 * 1024;
    let (mut client, user, file, base) = capped_text_source(&env, &gateway, &server, growth).await;
    let appended = "b".repeat(80 * 1024);
    let edit = serde_json::json!({
        "actorUserId": user,
        "commands": [{
            "type": "replace_text",
            "expectedText": "END",
            "offset": base.len() - 3,
            "text": format!("END{appended}"),
        }],
        "operation": { "id": format!("op_{file}"), "requestHash": "h1" },
        "target": { "id": file, "kind": "source_file" },
    });
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &edit).await;
    assert_eq!(status, 200, "{receipt}");
    let grown = base.len() + appended.len();
    assert!(client.settle(|c| source_text(c).len() == grown).await);
    type_at_start(&mut client, &"x".repeat(40 * 1024)).await;
    closed_for_size(client.until(4).await);
}

/// A text source the agent edited before its room ever saved: the edit's
/// checkpoint carried the seed, so the room's own first save (a person typing
/// inside the agent's text) must not carry it again. Fails if the room still
/// counts itself unsaved: that save merges the seed, refers to the edit's
/// items the seed lacks and discards the room, so no receipt comes.
#[tokio::test]
async fn a_text_sources_first_save_after_an_agent_edit_carries_no_seed() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "hello world").await;
    let room = format!("source:{file}:epoch:1");
    let mut client = Client::open(server.port).await;
    client.joined(&room, &token(&room, &user, "write")).await;
    assert!(client.settle(|c| source_text(c) == "hello world").await);
    let edit = serde_json::json!({
        "actorUserId": user,
        "commands": [{ "type": "replace_text", "expectedText": "world", "text": "there" }],
        "operation": { "id": format!("op_{file}"), "requestHash": "h1" },
        "target": { "id": file, "kind": "source_file" },
    });
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &edit).await;
    assert_eq!(status, 200, "{receipt}");
    assert!(client.settle(|c| source_text(c) == "hello there").await);
    let before = client.doc.transact().state_vector();
    client
        .doc
        .get_or_insert_text("source")
        .insert(&mut client.doc.transact_mut(), 8, "X");
    let update = client.doc.transact().encode_state_as_update_v1(&before);
    client.send(5, &sync(2, &update)).await;
    source_receipt(&mut client, "inside")
        .await
        .expect("the room's first save stored");
    assert_eq!(source_text(&client), "hello thXere");
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
    // The save carried the file's list-card text.
    let preview: Option<serde_json::Value> = db(&env)
        .await
        .query_one("SELECT preview FROM files WHERE id=$1", &[&file])
        .await
        .expect("file")
        .get(0);
    assert_eq!(preview, Some(serde_json::json!({ "text": "hello world" })));
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

/// Epo 2026-10-17: a source room load is refused only while loaded rooms'
/// files fill the disk store. The JOIN gets the refusal the editor retries
/// (it shows collaboration unavailable), the refusal is counted as such and
/// not as an authentication failure, and once the open room unloads its
/// idle files make way for the next load.
#[tokio::test]
async fn a_source_room_is_refused_while_loaded_rooms_fill_the_disk_store() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let (first_text, second_text) = ("a".repeat(100), "b".repeat(100));
    // One room's base and seed fit; a second base does not.
    let held = first_text.len()
        + sources::text::text_seed(first_text.as_bytes())
            .unwrap()
            .len();
    let cap = (held + second_text.len() - 1).to_string();
    let server = start_configured(
        &env,
        Some(&gateway.url),
        &[("COLLABORATION_SOURCE_DISK_BYTES", cap.as_str())],
    )
    .await;
    let (first_user, first) = text_file(&env, &gateway, &first_text).await;
    let (second_user, second) = text_file(&env, &gateway, &second_text).await;
    let (first_room, second_room) = (
        format!("source:{first}:epoch:1"),
        format!("source:{second}:epoch:1"),
    );
    let mut a = Client::open(server.port).await;
    assert_eq!(
        a.joined(&first_room, &token(&first_room, &first_user, "write"))
            .await,
        1
    );
    assert!(a.settle(|c| source_text(c) == first_text).await);
    let metrics = metrics_text(server.port).await;
    assert!(
        metrics.contains(&format!(
            "capy_collaboration_source_disk_held_bytes {held}\n"
        )),
        "{metrics}"
    );
    let mut b = Client::open(server.port).await;
    let second_token = token(&second_room, &second_user, "write");
    b.join(&second_room, &second_token).await;
    let reason = text_payload(&b.until(2).await.expect("refused"));
    assert_eq!(reason, "permission-denied");
    // Counted as a disk refusal, never as an authentication failure.
    let metrics = metrics_text(server.port).await;
    assert!(
        metrics.contains("capy_collaboration_source_disk_refusals_total 1\n")
            && metrics.contains("capy_collaboration_authentication_failures_total 0\n"),
        "{metrics}"
    );
    // The first room unloads; its files are idle and go for the second.
    drop(a);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        tokio::time::sleep(Duration::from_millis(200)).await;
        b.inbox.clear();
        b.join(&second_room, &second_token).await;
        let answered = b
            .settle(|c| c.inbox.iter().any(|m| m.kind == 1 || m.kind == 2))
            .await;
        assert!(answered, "no answer to the join");
        if b.inbox.iter().any(|m| m.kind == 1) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the second room never loaded"
        );
    }
    let sv = b.doc.transact().state_vector().encode_v1();
    b.send(5, &sync(0, &sv)).await;
    assert!(b.settle(|c| source_text(c) == second_text).await);
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
        frame(
            channel,
            0,
            &join_payload(room, token, Some(client_protocol())),
        )
    };
    // The note channel's session id, which its cursor goes under.
    let note_token = token(&note_room, &user, "write");
    let session = token_client_id(&note_token).expect("client id");
    ws.send(Ws::Binary(
        frame(
            1,
            0,
            &join_payload_as(&note_room, &note_token, Some(client_protocol()), session),
        )
        .into(),
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
    var(&mut cursor, session);
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
        "/internal/documents/create",
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

/// Security regression: the public host serves its counters only with the
/// service secret; the liveness probe answers without saying anything about
/// the server.
#[tokio::test]
async fn metrics_need_the_service_secret_and_livez_says_nothing() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let client = reqwest::Client::new();
    let url = |path: &str| format!("http://127.0.0.1:{}{path}", server.port);
    for secret in [None, Some("not-the-secret")] {
        let mut request = client.get(url("/metrics"));
        if let Some(secret) = secret {
            request = request.header("x-collaboration-secret", secret);
        }
        let status = request.send().await.expect("metrics request").status();
        assert_eq!(status.as_u16(), 401, "metrics with {secret:?}");
    }
    let metrics = client
        .get(url("/metrics"))
        .header("x-collaboration-secret", SECRET)
        .send()
        .await
        .expect("metrics request");
    assert_eq!(metrics.status().as_u16(), 200);
    assert!(
        metrics
            .text()
            .await
            .unwrap()
            .contains("capy_collaboration_connections")
    );
    let live = client
        .get(url("/livez"))
        .send()
        .await
        .expect("livez request");
    assert_eq!(live.status().as_u16(), 200);
    assert!(live.headers().get("x-capy-release").is_none());
    assert_eq!(live.text().await.unwrap(), "ok");
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

async fn asset_trashed(client: &tokio_postgres::Client, id: &str) -> bool {
    client
        .query_one(
            "SELECT trashed_at IS NOT NULL FROM editor_assets WHERE id=$1",
            &[&id],
        )
        .await
        .expect("asset")
        .get(0)
}

fn image_block(id: &str, asset: &str) -> serde_json::Value {
    serde_json::json!({ "type": "img", "id": id, "assetId": asset, "children": [{ "text": "" }] })
}

/// An agent edit may remove a block holding media (Epo 2026-10-21): the
/// image leaves the open note, the room's projection (asked for here; it
/// runs once the note idles) trashes its asset like a person's deletion
/// does (`pruneMaterialAssetsTx`, the asset completed over a minute ago),
/// and the edit's Undo, admitted by the room (Q402), brings the block back
/// with its asset out of the trash through its children pass: the editor
/// hears `children-ready` naming the asset (PENDING 2026-10-23). Fails if
/// the media refusal comes back or the Undo leaves the asset trashed.
#[tokio::test]
async fn an_image_the_agent_removes_is_trashed_and_its_undo_restores_it() {
    let Some(env) = env() else { return };
    if env.api.is_none() {
        return;
    }
    let server = start(&env).await;
    let (user, material) = note(&env, "intro").await;
    let client = db(&env).await;
    let asset = format!("asset_it_removed_{}", uuid_like());
    image_asset(&client, &user, &asset, &material).await;
    client
        .execute(
            "UPDATE materials SET content=$2 WHERE id=$1",
            &[
                &material,
                &serde_json::json!({ "schemaVersion": 1, "value": [
                    { "type": "p", "id": "b1", "children": [{ "text": "intro" }] },
                    image_block("img1", &asset),
                ] }),
            ],
        )
        .await
        .expect("content");
    let room = format!("material:{material}:schema:1");
    let mut person = Client::open(server.port).await;
    person.joined(&room, &token(&room, &user, "write")).await;
    assert!(person.settle(|c| c.block("img1").is_some()).await);
    assert!(!asset_trashed(&client, &asset).await);

    let operation = format!("e_{material}");
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &serde_json::json!({
            "actorUserId": user,
            "commands": [{ "type": "remove_block", "blockId": "img1", "expectedText": "" }],
            "operation": { "id": operation, "requestHash": operation },
            "room": room,
            "target": { "id": material, "kind": "material" },
        }),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(
        receipt["effect"]["undo"]["status"], "available",
        "{receipt}"
    );
    assert!(person.settle(|c| c.block("img1").is_none()).await);
    let (status, body) = internal(
        server.port,
        &format!("/internal/materials/{material}/project"),
        &serde_json::json!({}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !asset_trashed(&client, &asset).await {
        assert!(tokio::time::Instant::now() < deadline, "the asset stayed");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &format!("u_{material}"), &material, &receipt),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert!(
        person
            .settle(|c| c
                .block("img1")
                .is_some_and(|block| block["assetId"] == asset.as_str()))
            .await,
        "{:?}",
        person.block("img1")
    );
    let (ready, _) = person.stateless("children-ready").await;
    assert_eq!(ready["assetIds"], serde_json::json!([asset]), "{ready}");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while asset_trashed(&client, &asset).await {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the asset stayed trashed"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
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
    let (viewer_id, writer_id) = (viewer.id(), writer.id());
    // A channel writes only its session's id: each state goes once the one
    // before it reached the observer.
    let state = r#"{"cursor":{"anchor":1},"uploads":["block-a"]}"#;
    viewer.send(7, &awareness_update(viewer_id, 1, state)).await;
    let from_viewer = observer.states_of(viewer_id, |_| true).await.remove(0);
    let from_viewer: serde_json::Value = serde_json::from_str(&from_viewer).expect("json");
    assert!(from_viewer.get("uploads").is_none(), "{from_viewer}");
    assert_eq!(from_viewer["cursor"]["anchor"], 1);
    let escaped = r#"{"cursor":null,"uploads":["block-b"]}"#;
    viewer
        .send(7, &awareness_update(viewer_id, 2, escaped))
        .await;
    let escaped_key = observer.states_of(viewer_id, |_| true).await.remove(0);
    let escaped_key: serde_json::Value = serde_json::from_str(&escaped_key).expect("json");
    assert!(escaped_key.get("uploads").is_none(), "{escaped_key}");
    // serde_json refuses an unpaired surrogate escape; JSON.parse takes it
    // and would read the list (REVIEW5 R1b). The empty state sent after it
    // marks that the room has handled it.
    let unparsed = r#"{"cursor":null,"uploads":["block-c"],"x":"\ud800"}"#;
    viewer
        .send(7, &awareness_update(viewer_id, 3, unparsed))
        .await;
    viewer.send(7, &awareness_update(viewer_id, 4, "{}")).await;
    let mut seen = observer.states_of(viewer_id, |state| state == "{}").await;
    seen.pop();
    assert!(seen.iter().all(|state| state == "null"), "{seen:?}");
    writer.send(7, &awareness_update(writer_id, 1, state)).await;
    let from_writer = observer.states_of(writer_id, |_| true).await.remove(0);
    let from_writer: serde_json::Value = serde_json::from_str(&from_writer).expect("json");
    assert_eq!(from_writer["uploads"][0], "block-a");
}

impl Client {
    /// The states the room sends for `client`, through the first `done`
    /// accepts.
    async fn states_of(&mut self, client: u64, done: impl Fn(&str) -> bool) -> Vec<String> {
        let mut seen = Vec::new();
        loop {
            let payload = self.until(7).await.expect("awareness");
            for (id, state) in awareness_entries(&payload) {
                if id == client {
                    let finished = done(&state);
                    seen.push(state);
                    if finished {
                        return seen;
                    }
                }
            }
        }
    }
}

impl Client {
    /// Reads the room's presence until it lists connections `check` accepts.
    async fn presence(
        &mut self,
        check: impl Fn(&[serde_json::Value]) -> bool,
    ) -> Vec<serde_json::Value> {
        loop {
            let (message, _) = self.stateless("room-presence").await;
            let connections = message["connections"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if check(&connections) {
                return connections;
            }
        }
    }
}

/// Security regression (Epo 2026-10-20): the room's presence lists the
/// people who can edit (an editor's reading tab too), each by its signed
/// token's name with the awareness client ids it holds, never by what its
/// awareness says, and never a viewer; a person is a number in the room,
/// never a user id; nothing about a device is listed; a member hears every
/// connection but its own (its user's other tabs included), and a viewer
/// hears none. Fails if viewers are listed, a viewer hears it, a member hears
/// its own connection, or an entry names a device.
#[tokio::test]
async fn the_rooms_presence_lists_editors_by_their_tokens_and_never_viewers() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note(&env, "presence").await;
    let viewer = member(&env, &room, "viewer").await;
    drop_queued_evictions(&env, &room).await;
    let mut desk = Client::open(server.port).await;
    desk.joined(&room, &identity_token(&room, &owner, "write", "Olive"))
        .await;
    // What its awareness claims is never its label.
    let desk_id = desk.id();
    desk.send(
        7,
        &awareness_update(desk_id, 1, "{\"data\":{\"name\":\"Mallory\"}}"),
    )
    .await;
    let mut ed = Client::open(server.port).await;
    ed.joined(&room, &identity_token(&room, &editor, "write", "Eddie"))
        .await;
    let mut phone = Client::open(server.port).await;
    phone
        .joined(&room, &identity_token(&room, &owner, "write", "Olive"))
        .await;
    let mut reader = Client::open(server.port).await;
    reader
        .joined(&room, &identity_token(&room, &editor, "read", "Eddie"))
        .await;
    let mut watcher = Client::open(server.port).await;
    watcher
        .joined(&room, &identity_token(&room, &viewer, "read", "Vic"))
        .await;

    let seen = ed
        .presence(|connections| {
            connections.len() == 3 && connections.iter().any(|c| c["clients"][0] == desk_id)
        })
        .await;
    let desk_entry = seen
        .iter()
        .find(|c| c["clients"][0] == desk_id)
        .expect("the desk");
    assert_eq!(desk_entry["name"], "Olive");
    let names = |connections: &[serde_json::Value]| {
        let mut names: Vec<String> = connections
            .iter()
            .map(|c| c["name"].as_str().unwrap_or("").to_owned())
            .collect();
        names.sort_unstable();
        names
    };
    let persons = |connections: &[serde_json::Value], name: &str| {
        let mut persons: Vec<u64> = connections
            .iter()
            .filter(|c| c["name"] == name)
            .filter_map(|c| c["person"].as_u64())
            .collect();
        persons.dedup();
        persons
    };
    // The desk hears the editor, the editor's reading tab and its own user's
    // phone (one person per user), never itself.
    let at_desk = desk.presence(|connections| connections.len() == 3).await;
    assert_eq!(names(&at_desk), ["Eddie", "Eddie", "Olive"]);
    assert_eq!(persons(&at_desk, "Eddie").len(), 1);
    assert_eq!(
        persons(&at_desk, "Olive"),
        [desk_entry["person"].as_u64().unwrap()]
    );
    assert_ne!(persons(&at_desk, "Eddie"), persons(&at_desk, "Olive"));
    let at_reader = reader.presence(|connections| connections.len() == 3).await;
    assert_eq!(names(&at_reader), ["Eddie", "Olive", "Olive"]);
    for id in [&owner, &editor] {
        assert!(
            !String::from_utf8_lossy(&reader.received).contains(id.as_str()),
            "a reader learned a user id"
        );
    }
    assert!(!watcher.hears(255, 1500).await);
    assert!(
        watcher
            .inbox
            .iter()
            .all(|m| m.kind != 9 || !text_payload(&m.payload).contains("room-presence")),
        "a viewer heard the room's presence"
    );
    for connections in [&seen, &at_desk, &at_reader] {
        for connection in connections.iter() {
            assert_ne!(connection["name"], "Vic", "{connections:?}");
            let mut fields: Vec<&String> =
                connection.as_object().expect("an entry").keys().collect();
            fields.sort_unstable();
            assert_eq!(
                fields,
                ["avatar", "clients", "name", "person"],
                "{connection}"
            );
        }
    }
}

/// Drops the evictions that inserting `room`'s workspace, members and
/// material queued: the API's worker delivers them whenever it gets to them,
/// and one landing after a join drains the room, closing its channels. The
/// room is not loaded yet, so they have nothing to do.
async fn drop_queued_evictions(env: &Env, room: &str) {
    db(env)
        .await
        .execute(
            "DELETE FROM collaboration_eviction_outbox WHERE payload->>'room' = $1",
            &[&room],
        )
        .await
        .expect("outbox");
}

/// A fresh user with `role` in the workspace of `room`'s material.
async fn member(env: &Env, room: &str, role: &str) -> String {
    let user = user(env).await;
    db(env)
        .await
        .execute(
            "INSERT INTO workspace_members (workspace_id,user_id,role)
             SELECT workspace_id, $2, $3 FROM materials WHERE id = $1",
            &[&material_of(room), &user, &role],
        )
        .await
        .expect("member");
    user
}

/// Security regression (header-presence review S2): the presence shrinks as
/// connections go: a channel that leaves, then a socket that closes, each
/// leave the next presence. Fails if a leave or a close sends none.
#[tokio::test]
async fn the_rooms_presence_drops_a_channel_that_leaves_and_a_socket_that_closes() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note(&env, "presence").await;
    let third = member(&env, &room, "editor").await;
    drop_queued_evictions(&env, &room).await;
    let mut olive = Client::open(server.port).await;
    olive
        .joined(&room, &identity_token(&room, &owner, "write", "Olive"))
        .await;
    let mut bea = Client::open(server.port).await;
    bea.joined(&room, &identity_token(&room, &editor, "write", "Bea"))
        .await;
    let mut cal = Client::open(server.port).await;
    cal.joined(&room, &identity_token(&room, &third, "write", "Cal"))
        .await;
    olive.presence(|connections| connections.len() == 2).await;
    bea.send(3, &[]).await;
    let left = olive.presence(|connections| connections.len() == 1).await;
    assert_eq!(left[0]["name"], "Cal");
    cal.ws.close(None).await.ok();
    drop(cal);
    olive.presence(|connections| connections.is_empty()).await;
}

/// Security regression (header-presence review S2, Epo 2026-10-20): a source
/// (Office or text) room knows only a token's access, so its presence lists
/// write channels only; a read channel, which a viewer holds, is neither
/// listed nor hears it. Fails if a source room lists or tells its readers.
#[tokio::test]
async fn a_source_rooms_presence_lists_its_writers_and_never_a_reader() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (owner, file) = text_file(&env, &gateway, "hello").await;
    let (second, viewer) = (user(&env).await, user(&env).await);
    let room = format!("source:{file}:epoch:1");
    drop_queued_evictions(&env, &room).await;
    let mut reader = Client::open(server.port).await;
    reader
        .joined(&room, &identity_token(&room, &viewer, "read", "Rae"))
        .await;
    let mut bea = Client::open(server.port).await;
    bea.joined(&room, &identity_token(&room, &second, "write", "Bea"))
        .await;
    let mut wes = Client::open(server.port).await;
    wes.joined(&room, &identity_token(&room, &owner, "write", "Wes"))
        .await;
    // Everyone joined before Wes: its first presence is the whole room.
    let (first, _) = wes.stateless("room-presence").await;
    let names: Vec<&serde_json::Value> = first["connections"]
        .as_array()
        .expect("connections")
        .iter()
        .map(|c| &c["name"])
        .collect();
    assert_eq!(names, ["Bea"], "{first}");
    assert!(!reader.hears(255, 1500).await);
    assert!(
        reader
            .inbox
            .iter()
            .all(|m| m.kind != 9 || !text_payload(&m.payload).contains("room-presence")),
        "a reader heard the room's presence"
    );
}

/// Security regression (header-presence review S2): an embed's channel
/// inside its note's is listed in the embed room's presence but hears none
/// (its page's header shows the note's). Fails if an embed channel hears it.
#[tokio::test]
async fn an_embed_channel_is_listed_but_hears_no_presence() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut note) = writer(&env, server.port, "a note").await;
    let note_id = material_of(&room).to_owned();
    let [set] = embedded_sets(&env, &user, &note_id, 1)
        .await
        .try_into()
        .expect("one set");
    drop_queued_evictions(&env, &set).await;
    let (kind, _) = note
        .join_embed(2, &set, &embed_token(&set, &user, &note_id))
        .await;
    assert_eq!(kind, 1);
    let mut page = Client::open(server.port).await;
    page.joined(&set, &identity_token(&set, &user, "write", "Pat"))
        .await;
    page.presence(|connections| connections.len() == 1).await;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
    while tokio::time::Instant::now() < deadline {
        let Ok(Some(Ok(Ws::Binary(bytes)))) =
            tokio::time::timeout_at(deadline, note.ws.next()).await
        else {
            break;
        };
        let mut at = 0;
        while at < bytes.len() {
            let channel = read_var(&bytes, &mut at);
            let kind = bytes[at];
            at += 1;
            let len = read_var(&bytes, &mut at) as usize;
            let payload = &bytes[at..at + len];
            at += len;
            assert!(
                !(channel == 2 && kind == 9 && text_payload(payload).contains("room-presence")),
                "an embed channel heard its room's presence"
            );
        }
    }
}

/// Security regression (header-presence review S1, Q213): an awareness
/// client id its user released is never another user's, so another user's
/// cursor is never drawn under the departed user's verified name. Another
/// editor claims a departed editor's id again and again from the moment it
/// leaves; the observer never hears the claim. Fails if a released id is
/// free to another user.
#[tokio::test]
async fn a_released_client_id_is_never_drawn_under_its_users_name() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note(&env, "presence").await;
    let other = member(&env, &room, "editor").await;
    drop_queued_evictions(&env, &room).await;
    let mut observer = Client::open(server.port).await;
    observer
        .joined(&room, &identity_token(&room, &owner, "write", "Olive"))
        .await;
    let mut taker = Client::open(server.port).await;
    taker
        .joined(&room, &identity_token(&room, &other, "write", "Mal"))
        .await;
    let mut leaver = Client::open(server.port).await;
    leaver
        .joined(&room, &identity_token(&room, &editor, "write", "Eddie"))
        .await;
    let released = leaver.id();
    leaver
        .send(7, &awareness_update(released, 1, "{\"by\":\"eddie\"}"))
        .await;
    observer
        .presence(|connections| {
            connections
                .iter()
                .any(|c| c["clients"][0] == released && c["name"] == "Eddie")
        })
        .await;
    leaver.ws.close(None).await.ok();
    drop(leaver);
    let claims = async {
        for clock in 10..50 {
            taker
                .send(7, &awareness_update(released, clock, "{\"by\":\"mal\"}"))
                .await;
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    };
    let watch = async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let mut claimed = false;
        while let Ok(Some(Ok(message))) =
            tokio::time::timeout_at(deadline, observer.ws.next()).await
        {
            let Ws::Binary(bytes) = message else { continue };
            let mut at = 0;
            while at < bytes.len() {
                let _channel = read_var(&bytes, &mut at);
                let kind = bytes[at];
                at += 1;
                let len = read_var(&bytes, &mut at) as usize;
                let payload = &bytes[at..at + len];
                at += len;
                claimed |= kind == 7
                    && awareness_entries(payload)
                        .iter()
                        .any(|(client, state)| *client == released && state.contains("mal"));
            }
        }
        claimed
    };
    let (_, claimed) = tokio::join!(claims, watch);
    assert!(!claimed, "another user took a released client id");
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

/// replace_card fills the side it leaves out from the live set (Epo
/// 2026-10-21): a person types in a card's back after the agent inspected
/// the card, the agent replaces its front, and the back keeps the typing; a
/// back it expects as inspected is stale and refuses with the card's sides
/// as they read now. Fails if a left-out side is written from the stored
/// set, which reverted the typing.
#[tokio::test]
async fn replace_card_keeps_the_typing_since_the_agents_inspection() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let set = flashcard_set(&env, &owner, None, &[("c1", "Cell", "unit of life")]).await;
    let room = format!("material:{set}:schema:1");
    let mut person = Client::open(server.port).await;
    assert_eq!(
        person.joined(&room, &token(&room, &owner, "write")).await,
        1
    );
    assert!(person.settle(|c| c.cards().len() == 1).await);
    let inspect = serde_json::json!({
        "actorUserId": owner, "room": room, "target": { "id": set, "kind": "material" },
    });
    let (status, view) = internal(server.port, "/internal/documents/inspect", &inspect).await;
    assert_eq!(status, 200, "{view}");
    let card = notes::edit::card_text("Cell", "unit of life");
    assert_eq!(
        view["blocks"][0]["children"][0]["text"],
        card.as_str(),
        "{view}"
    );

    person
        .write(|doc| {
            let back = card_face(doc, "c1", "back").expect("back");
            yrs::Text::insert(&back, &mut doc.transact_mut(), 12, ", smallest");
        })
        .await;
    assert!(person.until(6).await.is_some(), "the person's ack");
    let edit = |id: &str, command: serde_json::Value| {
        serde_json::json!({
            "actorUserId": owner,
            "commands": [command],
            "operation": { "id": id, "requestHash": id },
            "room": room,
            "target": { "id": set, "kind": "material" },
        })
    };
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &edit(
            &format!("e1_{set}"),
            serde_json::json!({ "type": "replace_card", "cardId": "c1", "front": "Cell (biology)", "expectedFront": "Cell" }),
        ),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    let sides = |c: &Client| {
        let doc = &c.doc;
        let read = |face: &str| {
            card_face(doc, "c1", face)
                .map(|text| text.get_string(&doc.transact()))
                .unwrap_or_default()
        };
        (read("front"), read("back"))
    };
    let now = (
        "Cell (biology)".to_owned(),
        "unit of life, smallest".to_owned(),
    );
    assert!(
        person.settle(|c| sides(c) == now).await,
        "{:?}",
        sides(&person)
    );

    let (status, refusal) = internal(
        server.port,
        "/internal/documents/edit",
        &edit(
            &format!("e2_{set}"),
            serde_json::json!({ "type": "replace_card", "cardId": "c1", "back": "the smallest unit", "expectedBack": "unit of life" }),
        ),
    )
    .await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (409, Some("stale_target")),
        "{refusal}"
    );
    assert_eq!(
        refusal["details"],
        serde_json::json!({ "block": {
            "id": "c1",
            "text": notes::edit::card_text("Cell (biology)", "unit of life, smallest"),
            "type": "flashcard",
        } }),
        "{refusal}"
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

/// A writer's update outside a set's shape is refused on entry (Epo
/// 2026-10-18): the writer hears `document-rejected` and its channel
/// closes, the other writer receives nothing of it, the room keeps its state
/// and lineage, and the writer's editor
/// remounts on a fresh document on the same socket, whose edit goes in.
#[tokio::test]
async fn a_flashcard_set_refuses_another_shape_and_keeps_the_writer() {
    use yrs::{Map, Text};
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let set = flashcard_set(&env, &owner, None, &[("c1", "Cell", "")]).await;
    let room = format!("material:{set}:schema:1");
    let write = token(&room, &owner, "write");
    let mut a = Client::open(server.port).await;
    let mut b = Client::open(server.port).await;
    a.joined(&room, &write).await;
    b.joined(&room, &write).await;
    assert!(a.settle(|c| c.cards().len() == 1).await);
    assert!(b.settle(|c| c.cards().len() == 1).await);
    // A note's content root in a set.
    a.write(|doc| {
        let content = doc.get_or_insert_text("content");
        content.insert(&mut doc.transact_mut(), 0, "note text");
    })
    .await;
    let (rejected, _) = a.stateless("document-rejected").await;
    assert_eq!(rejected["code"], "invalid_document");
    assert!(
        a.until(4).await.is_some(),
        "the refused channel did not close"
    );
    // The other writer receives nothing of it and keeps its channel.
    assert!(!b.hears(4, 300).await, "the other writer's channel closed");
    assert!(
        b.text().is_empty(),
        "the other writer received the refused update"
    );
    // A key no card has.
    b.write(|doc| {
        let root = doc.get_or_insert_map(items::flashcards::ROOT);
        let mut txn = doc.transact_mut();
        if let Some(yrs::Out::YMap(card)) = root.get(&txn, "c1") {
            card.insert(&mut txn, "answer", "leaked");
        }
    })
    .await;
    let (rejected, _) = b.stateless("document-rejected").await;
    assert_eq!(rejected["code"], "invalid_document");
    assert!(
        b.until(4).await.is_some(),
        "the refused channel did not close"
    );
    // Both remount; B's edit on its fresh document reaches A's.
    a.remount(&room, &write).await;
    b.remount(&room, &write).await;
    assert!(a.settle(|c| c.cards().len() == 1).await);
    assert!(b.settle(|c| c.cards().len() == 1).await);
    b.write(|doc| {
        if let Some(front) = card_face(doc, "c1", "front") {
            front.insert(&mut doc.transact_mut(), 4, "s");
        }
    })
    .await;
    assert!(
        a.settle(|c| c.cards() == [("c1".to_owned(), "Cells".to_owned())])
            .await
    );
    assert_eq!(room_schema(&env, &set).await, 1);
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
    redeem(&env, &note, &viewer).await;
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
    let editor_id = editor.id();
    editor
        .send(7, &awareness_update(editor_id, 1, r#"{"user":"owner"}"#))
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
        .send(7, &awareness_update(editor_id, 2, r#"{"user":"owner2"}"#))
        .await;
    let watcher_id = watcher.id();
    watcher
        .send(7, &awareness_update(watcher_id, 1, r#"{"user":"viewer"}"#))
        .await;
    watcher.send(8, &[]).await;
    assert!(!watcher.hears(7, 1500).await, "a viewer heard awareness");
    assert!(!editor.hears(7, 500).await, "an editor heard a viewer");
}

/// A quiz owned by `owner` (live-items) with an mcq and an ordering
/// question; `privacy` link lets any signed-in user read it.
async fn quiz_material(env: &Env, owner: &str, privacy: &str) -> String {
    quiz_material_as(env, owner, privacy, format!("qz_it_{}", uuid_like())).await
}

/// [quiz_material] under the id `material`.
async fn quiz_material_as(env: &Env, owner: &str, privacy: &str, material: String) -> String {
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

/// Decision 5 for quizzes (review M1): a stored quiz whose stem holds a block
/// kind its rooms do not admit loads both rooms read-only, the keys room
/// too though its own document holds no such block, so no save rebuilds the
/// quiz without it. Fails if either room takes a writer.
#[tokio::test]
async fn a_quiz_holding_a_block_this_version_cannot_read_loads_both_rooms_read_only() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let quiz = quiz_material(&env, &owner, "private").await;
    db(&env)
        .await
        .execute(
            "UPDATE materials SET content = jsonb_set(content,
               '{value,0,children,0,question,stem}', '[{\"type\":\"timeline\",\"events\":[]}]')
             WHERE id = $1",
            &[&quiz],
        )
        .await
        .expect("content");
    for room in [
        format!("keys:{quiz}:schema:1"),
        format!("material:{quiz}:schema:1"),
    ] {
        let mut writer = Client::open(server.port).await;
        assert_eq!(
            writer.joined(&room, &token(&room, &owner, "write")).await,
            0,
            "{room}"
        );
        let (notice, _) = writer.stateless("room-read-only").await;
        assert_eq!(notice["code"], "unsupported_block", "{room}: {notice}");
    }
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
        let ticks = map_at(doc, &["keys", "q1-p", "correct"]).expect("ticks");
        let mut txn = doc.transact_mut();
        ticks.remove(&mut txn, "o0");
        ticks.insert(&mut txn, "o1", true);
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

/// Stored update rows of a material's document (`material_yjs_updates`, or
/// a quiz's `material_yjs_key_updates`).
async fn update_rows(env: &Env, table: &str, material: &str) -> i64 {
    db(env)
        .await
        .query_one(
            &format!("SELECT count(*) FROM {table} WHERE material_id=$1"),
            &[&material],
        )
        .await
        .expect("rows")
        .get(0)
}

/// A quiz's stored keys document as it stands, its base and its log: a
/// store changes it whether or not an unload folded the row since.
async fn stored_keys(env: &Env, quiz: &str) -> String {
    db(env)
        .await
        .query_one(
            "SELECT md5(k.state) || ':' || (SELECT count(*) FROM material_yjs_key_updates u
               WHERE u.material_id=k.material_id)
             FROM material_yjs_keys k WHERE k.material_id=$1",
            &[&quiz],
        )
        .await
        .expect("keys")
        .get(0)
}

/// Whether a quiz's stored keys document, its base and its log read in one
/// statement (an unload's fold between two reads would hide the row), holds
/// the key of `part`.
async fn stored_keys_hold(env: &Env, quiz: &str, part: &str) -> bool {
    let Some(row) = db(env)
        .await
        .query_opt(
            "SELECT k.state, ARRAY(SELECT u.update FROM material_yjs_key_updates u
               WHERE u.material_id=k.material_id ORDER BY u.seq)
             FROM material_yjs_keys k WHERE k.material_id=$1",
            &[&quiz],
        )
        .await
        .expect("keys")
    else {
        return false;
    };
    let state: Vec<u8> = row.get(0);
    let rows: Vec<Vec<u8>> = row.get(1);
    let doc = Doc::with_options(ydoc::doc_options(0));
    {
        let mut txn = doc.transact_mut();
        txn.apply_update(Update::decode_v1(&state).expect("base decodes"))
            .expect("base applies");
        for update in rows {
            txn.apply_update(Update::decode_v1(&update).expect("row decodes"))
                .expect("row applies");
        }
    }
    map_at(&doc, &["keys", part]).is_some()
}

/// Waits until a material document has more than `rows` stored update rows,
/// at most 10 s: a loaded room stores an agent edit after admitting it.
async fn rows_past(env: &Env, table: &str, material: &str, rows: i64) -> bool {
    for _ in 0..100 {
        if update_rows(env, table, material).await > rows {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// An agent edit that only removes (a deletion moves no state vector) is
/// committed and fanned into the live room like any other: a quiz's
/// `remove_child` stores both its documents and the open editor loses the
/// question; the stored quiz projects without it.
#[tokio::test]
async fn a_removal_only_agent_edit_of_a_quiz_is_stored_and_reaches_the_room() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let quiz = quiz_material(&env, &owner, "private").await;
    let room = format!("material:{quiz}:schema:1");
    let mut client = Client::open(server.port).await;
    client.joined(&room, &token(&room, &owner, "write")).await;
    assert!(
        client
            .settle(|c| map_at(&c.doc, &["questions", "q2"]).is_some())
            .await
    );
    let content_rows = update_rows(&env, "material_yjs_updates", &quiz).await;
    let keys = stored_keys(&env, &quiz).await;
    let edit = serde_json::json!({
        "actorUserId": owner,
        "commands": [{ "type": "remove_child", "parentType": "quiz", "nodeId": "q2" }],
        "operation": { "id": format!("op_{quiz}"), "requestHash": "h1", "toolVersion": 1 },
        "room": room,
        "target": { "id": quiz, "kind": "material" },
    });
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &edit).await;
    assert_eq!(status, 200, "{receipt}");
    // Both rooms admit it (the keys room loads for it) and store it (Q403);
    // the keys room, with no one in it, may fold its row as it unloads.
    assert!(rows_past(&env, "material_yjs_updates", &quiz, content_rows).await);
    let mut stored = keys.clone();
    for _ in 0..100 {
        stored = stored_keys(&env, &quiz).await;
        if stored != keys {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_ne!(stored, keys, "the keys were not stored");
    assert!(
        client
            .settle(|c| map_at(&c.doc, &["questions", "q2"]).is_none())
            .await,
        "the room kept q2"
    );
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
    let ids: Vec<&str> = stored["value"][0]["children"]
        .as_array()
        .expect("questions")
        .iter()
        .filter_map(|question| question["id"].as_str())
        .collect();
    assert_eq!(ids, ["q1"], "{stored}");
}

/// A set's removal-only change is stored and reaches the open editor, by an
/// agent edit (`remove_child`) and by the content save API (a replace-block
/// holding fewer cards).
#[tokio::test]
async fn a_removal_only_change_of_a_flashcard_set_is_stored_and_reaches_the_room() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let set = flashcard_set(
        &env,
        &owner,
        None,
        &[
            ("c1", "Cell", ""),
            ("c2", "Nucleus", ""),
            ("c3", "Ribosome", ""),
        ],
    )
    .await;
    let room = format!("material:{set}:schema:1");
    let mut client = Client::open(server.port).await;
    client.joined(&room, &token(&room, &owner, "write")).await;
    assert!(client.settle(|c| c.cards().len() == 3).await);
    let rows = update_rows(&env, "material_yjs_updates", &set).await;
    let edit = serde_json::json!({
        "actorUserId": owner,
        "commands": [{ "type": "remove_child", "parentType": "flashcards", "nodeId": "c3" }],
        "operation": { "id": format!("op_{set}"), "requestHash": "h1", "toolVersion": 1 },
        "room": room,
        "target": { "id": set, "kind": "material" },
    });
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &edit).await;
    assert_eq!(status, 200, "{receipt}");
    // The room's store writes it (Q402).
    assert!(rows_past(&env, "material_yjs_updates", &set, rows).await);
    let two = vec![
        ("c1".to_owned(), "Cell".to_owned()),
        ("c2".to_owned(), "Nucleus".to_owned()),
    ];
    assert!(
        client.settle(|c| c.cards() == two).await,
        "{:?}",
        client.cards()
    );

    // replace-block answers once the projection landed, so it needs the API.
    if env.api.is_none() {
        return;
    }
    let card = |id: &str, front: &str| {
        items::flashcards::card_node(&items::flashcards::Card {
            id: id.into(),
            order: String::new(),
            front: front.into(),
            back: String::new(),
            image: None,
        })
    };
    let rows = update_rows(&env, "material_yjs_updates", &set).await;
    let command = serde_json::json!({
        "actorUserId": owner,
        "expectedBlock": {},
        "materialId": set,
        "replacementBlock": { "type": "flashcards", "id": "flashcards", "children": [card("c1", "Cell")] },
        "room": room,
        "type": "replace-block",
    });
    let (status, answer) = internal(server.port, "/internal/commands", &command).await;
    assert_eq!(status, 200, "{answer}");
    assert!(update_rows(&env, "material_yjs_updates", &set).await > rows);
    let one = vec![("c1".to_owned(), "Cell".to_owned())];
    assert!(
        client.settle(|c| c.cards() == one).await,
        "{:?}",
        client.cards()
    );
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
    redeem(&env, &quiz, &viewer).await;
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
/// characters (shape A merges per character). An agent changes the diagram
/// through replace_block (Epo 2026-10-21, set_mermaid gone): both writers
/// get the new block, whose source they type into again, and the edit's
/// Undo puts the typed source back.
#[tokio::test]
async fn two_writers_type_in_one_mermaid_source_and_an_agent_replaces_it() {
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

    // The agent's ```mermaid fence, converted, replaces the block whole,
    // expecting the source both typed (Epo 2026-10-22).
    let rewritten = "flowchart LR\n  A --> B --> C";
    let operation = format!("op_{material}");
    let edit = serde_json::json!({
        "actorUserId": owner,
        "commands": [{
            "type": "replace_block",
            "blockId": "d1",
            "expectedText": merged,
            "blocks": [{
                "children": [{ "children": [{ "text": "" }], "type": "mermaid_caption" }],
                "id": "d2",
                "source": rewritten,
                "type": "mermaid",
            }],
        }],
        "operation": { "id": operation, "requestHash": "h1", "toolVersion": 1 },
        "room": room,
        "target": { "id": material, "kind": "material" },
    });
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &edit).await;
    assert_eq!(status, 200, "{receipt}");
    assert!(
        a.settle(|c| c.source() == rewritten).await,
        "{}",
        a.source()
    );
    assert!(
        b.settle(|c| c.source() == rewritten).await,
        "{}",
        b.source()
    );
    let typed = a.type_source(rewritten.len() as u32, " --> D");
    a.send(5, &sync(2, &typed)).await;
    let both = "flowchart LR\n  A --> B --> C --> D";
    assert!(b.settle(|c| c.source() == both).await, "{}", b.source());

    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&owner, &format!("u_{material}"), &material, &receipt),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert!(a.settle(|c| c.source() == merged).await, "{}", a.source());
    assert!(b.settle(|c| c.source() == merged).await, "{}", b.source());
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
    redeem(&env, &note, &viewer).await;
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
    send_drafts_over(port, room, token, origin, &[], body).await
}

/// `send_drafts` with more headers (a source's base, stored tokens, the
/// drafts' version: 1 unless given, none when given empty).
async fn send_drafts_over(
    port: u16,
    room: &str,
    token: Option<&str>,
    origin: Option<&str>,
    headers: &[(&str, &str)],
    body: Vec<u8>,
) -> (u16, serde_json::Value) {
    let mut request = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/drafts"))
        .header("content-type", "application/octet-stream")
        .header("x-capy-room", room)
        .header("x-capy-protocol", client_protocol().to_string())
        .body(body);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(origin) = origin {
        request = request.header("origin", origin);
    }
    if !headers.iter().any(|(name, _)| *name == "x-capy-version") {
        request = request.header("x-capy-version", "1");
    }
    for (name, value) in headers.iter().filter(|(_, value)| !value.is_empty()) {
        request = request.header(*name, *value);
    }
    let response = request.send().await.expect("draft send");
    let status = response.status().as_u16();
    (
        status,
        response.json().await.unwrap_or(serde_json::Value::Null),
    )
}

/// What a closed tab's drafts hold: the document as `from` holds it, with
/// `edit` made after it by the same session (under its client id, which the
/// room recorded when it joined, Q213), merged into one update (the state row
/// and the updates after it).
fn drafted(from: &Doc, edit: impl FnOnce(&Doc)) -> Vec<u8> {
    let doc = Doc::with_options(ydoc::doc_options(from.client_id().get()));
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

/// The server's counters, read with the service secret `/metrics` requires.
async fn metrics_text(port: u16) -> String {
    reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/metrics"))
        .header("x-collaboration-secret", SECRET)
        .send()
        .await
        .expect("metrics")
        .text()
        .await
        .expect("metrics text")
}

async fn active_rooms(port: u16) -> u64 {
    metrics_text(port)
        .await
        .lines()
        .find_map(|line| line.strip_prefix("capy_collaboration_active_rooms "))
        .and_then(|value| value.parse().ok())
        .expect("active rooms")
}

/// Security regression (Q236, r2 N3): a draft send writes under an id bound
/// to a live channel of its user (the tab, still joined, never wrote), and
/// its write records the id. Fails if such a send is refused or records
/// nothing.
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
    assert!(
        id_rows_reach(&env, &room, editor.id(), 1).await,
        "the draft's write records the tab's id"
    );
}

#[tokio::test]
async fn a_draft_send_loads_an_unloaded_room_which_unloads_after_its_store() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let (drafts, id) = {
        let reader = synced(server.port, &room, &user, "base").await;
        (drafted(&reader.doc, typed_into_note(" sent")), reader.id())
    };
    // The tab's room unloads (nothing to store); the send loads it again.
    for _ in 0..50 {
        if active_rooms(server.port).await == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(active_rooms(server.port).await, 0);
    // The tab's id is its user's, as a first accepted write would have
    // recorded it (Q236).
    db(&env)
        .await
        .execute(
            "INSERT INTO material_yjs_client_ids (material_id, document, client_id, user_id)
             VALUES ($1, 'content', $2, $3)",
            &[&material, &(id as i64), &user],
        )
        .await
        .expect("record the id");
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
/// Security regression (Q213): stored drafts under a client id nobody was
/// assigned (a tab from before the binding, or a forged one) are refused as
/// `unassigned` (409, Epo 2026-10-24), which the page does not send again,
/// and the room keeps nothing of them.
/// Fails if a draft send may write under any client id.
#[tokio::test]
async fn a_draft_under_a_client_id_nobody_was_assigned_is_refused() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let reader = synced(server.port, &room, &user, "base").await;
    let stray = Doc::with_options(ydoc::doc_options(fresh_client_id()));
    let state = reader
        .doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    stray
        .transact_mut()
        .apply_update(Update::decode_v1(&state).expect("state"))
        .expect("apply");
    let (status, answer) = send_drafts(
        server.port,
        &room,
        Some(&token(&room, &user, "write")),
        Some(ORIGIN),
        drafted(&stray, typed_into_note(" stray")),
    )
    .await;
    assert_eq!(
        (status, answer["class"].as_str()),
        (409, Some("unassigned")),
        "{answer}"
    );
    synced(server.port, &room, &user, "base").await;
}

/// Security regression (Epo 2026-10-24, Q288): a closed tab whose edits
/// never reached the room (its id recorded for no one) has its drafts
/// accepted from another page under its old id when the send presents the
/// tab's stored token, and the write records the id. A token issued more
/// than 7 days ago, another user's token offering the id, and the user's own
/// token offering an id recorded to another user grant nothing: the drafts
/// are refused as `unassigned`. Fails if stored tokens are ignored, or if
/// any of those re-grants an id.
#[tokio::test]
async fn drafts_of_a_closed_tab_go_in_under_its_id_with_its_stored_token() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note(&env, "base").await;
    // The other user's session wrote: its id is recorded to them.
    let mut theirs = synced(server.port, &room, &editor, "base").await;
    theirs.type_text("-e").await;
    theirs.until(6).await.expect("ack");
    let their_id = theirs.id();
    assert!(id_rows_reach(&env, &room, their_id, 1).await);
    let stolen = drafted(&theirs.doc, typed_into_note(" stolen"));
    drop(theirs);
    let id = fresh_client_id();
    let stored = token_offering(&room, &owner, "write", id);
    let mut tab = Client::open(server.port).await;
    assert_eq!(tab.joined(&room, &stored).await, 1);
    assert_eq!(tab.id(), id);
    assert!(tab.settle(|c| c.block_text() == "base-e").await);
    // Typed offline, then closed with its edits unsent.
    let drafts = drafted(&tab.doc, typed_into_note(" offline"));
    tab.leave(true).await;
    drop(tab);
    wait_unloaded(server.port).await;
    let fresh = token(&room, &owner, "write");
    let send = |grant: String, body: Vec<u8>| {
        let (room, fresh) = (room.clone(), fresh.clone());
        async move {
            send_drafts_over(
                server.port,
                &room,
                Some(&fresh),
                Some(ORIGIN),
                &[("x-capy-grants", &grant)],
                body,
            )
            .await
        }
    };
    let week = 7 * 24 * 60 * 60;
    for (grant, body, case) in [
        (
            token_issued(&room, &owner, id, week + 60),
            drafts.clone(),
            "over 7 days old",
        ),
        (
            token_offering(&room, &editor, "write", id),
            drafts.clone(),
            "another user's token",
        ),
        (
            token_offering(&room, &owner, "write", their_id),
            stolen,
            "an id recorded to another user",
        ),
    ] {
        let (status, answer) = send(grant, body).await;
        assert_eq!(
            (status, answer["class"].as_str()),
            (409, Some("unassigned")),
            "{case}: {answer}"
        );
    }
    assert_eq!(id_rows(&env, &room, id).await, 0);
    let (status, answer) = send(stored, drafts).await;
    assert_eq!(status, 200, "{answer}");
    assert!(
        id_rows_reach(&env, &room, id, 1).await,
        "the id is recorded"
    );
    synced(server.port, &room, &owner, "base-e offline").await;
}

#[tokio::test]
async fn draft_sends_are_refused_with_their_class() {
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
    let (status, answer) = send(unplaceable(reader.id())).await;
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
    let metrics = metrics_text(server.port).await;
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

/// Typing into a block someone deleted since (Q237, Q443, Q444, Q446): yrs
/// drops a deleted block's contents, so a closed tab's drafts typing after
/// its letters name collected history and are answered late (409 `late`,
/// counted), and the tab's late merge (the late-merge crate, as the browser
/// runs it) reports the block as hidden, which the editor keeps as
/// hidden-typing pieces; drafts that name only the deleted block itself
/// (typing into an empty block) are refused `hidden` (409, counted). The
/// same typing over a connected tab's socket is admitted as plain Yjs admits
/// it and goes with the block: no `collaboration-late`, nothing of it in the
/// room's text, and the tab converges with a fresh one. Fails if drafts into
/// a deleted block are admitted or answered hidden, the hidden class goes, or
/// a connected tab's typing there is answered late.
#[tokio::test]
async fn typing_into_a_deleted_block_is_late_as_drafts_and_plain_yjs_live() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let mut peer = synced(server.port, &room, &user, "base").await;
    peer.insert_blocks(
        1,
        &[
            serde_json::json!({ "type": "p", "id": "empty", "children": [{ "text": "" }] }),
            serde_json::json!({ "type": "p", "id": "second", "children": [{ "text": "second" }] }),
        ],
    )
    .await;
    assert!(peer.until(6).await.is_some(), "the peer's ack");
    let mut writer = synced(server.port, &room, &user, "base").await;
    assert!(writer.settle(|c| c.block("second").is_some()).await);
    let mut other = synced(server.port, &room, &user, "base").await;
    assert!(other.settle(|c| c.block("second").is_some()).await);
    let deleted = {
        let root = writer.doc.get_or_insert_text("content");
        let txn = writer.doc.transact();
        root.diff(&txn, yrs::types::text::YChange::identity)
            .into_iter()
            .find_map(|chunk| match chunk.insert {
                yrs::Out::YXmlText(block) => {
                    let branch =
                        yrs::branch::BranchPtr::from(block.as_ref() as &yrs::branch::Branch);
                    branch.item().map(|item| *item.id())
                }
                _ => None,
            })
            .expect("the first block")
    };
    // Typed while offline: after "base", and into the empty block (naming
    // only that block); the peer then deletes both blocks.
    let named = drafted(&writer.doc, typed_into_note(" hidden"));
    let block_only = drafted(&other.doc, typed_into_block_start(1, "x"));
    peer.write(|doc| {
        let root = doc.get_or_insert_text("content");
        root.remove_range(&mut doc.transact_mut(), 0, 2);
    })
    .await;
    assert!(peer.until(6).await.is_some(), "the peer's ack");

    let write = token(&room, &user, "write");
    let (status, answer) = send_drafts(
        server.port,
        &room,
        Some(&write),
        Some(ORIGIN),
        named.clone(),
    )
    .await;
    assert_eq!(
        (status, answer["class"].as_str()),
        (409, Some("late")),
        "{answer}"
    );
    let (status, answer) =
        send_drafts(server.port, &room, Some(&write), Some(ORIGIN), block_only).await;
    assert_eq!(
        (status, answer["class"].as_str()),
        (409, Some("hidden")),
        "{answer}"
    );
    let metrics = metrics_text(server.port).await;
    for class in ["late", "hidden"] {
        let line = format!("capy_collaboration_draft_refusals_total{{class=\"{class}\"}} 1");
        assert!(
            metrics.lines().any(|known| known == line),
            "{line} in {metrics}"
        );
    }
    let fresh = synced(server.port, &room, &user, "second").await;
    for id in [writer.id(), other.id()] {
        assert_eq!(
            fresh
                .doc
                .transact()
                .state_vector()
                .get(&yrs::block::ClientID::new(id)),
            0,
            "nothing of the drafts is stored"
        );
    }
    // Live (Q446): the same typing over the writer's socket is admitted and
    // goes with the block.
    writer.send(5, &sync(2, &named)).await;
    assert!(writer.until(6).await.is_some(), "the typing's ack");
    assert!(
        writer.settle(|c| c.block_text() == "second").await,
        "{}",
        writer.block_text()
    );
    persisted(&mut writer, "live").await;
    let later = synced(server.port, &room, &user, "second").await;
    let value = |c: &Client| notes::plate::value(&c.doc.transact()).expect("the value");
    assert_eq!(value(&later), value(&writer));
    let text = serde_json::to_string(&value(&later)).expect("json");
    assert!(!text.contains("hidden"), "{text}");
    // The late merge keeps the typing in the deleted block's tombstone and
    // reports that block hidden: the editor's hidden-typing pieces.
    let current = fresh
        .doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let merged = late_merge::merge(&named, &current).expect("the late merge");
    assert_eq!(merged.hidden, vec![deleted]);
}

/// Inserts `text` at the start of the note's top-level block `index`.
fn typed_at_start(doc: &Doc, index: usize, text: &str) {
    let root = doc.get_or_insert_text("content");
    let mut txn = doc.transact_mut();
    let block = root
        .diff(&txn, yrs::types::text::YChange::identity)
        .into_iter()
        .filter_map(|chunk| match chunk.insert {
            yrs::Out::YXmlText(block) => Some(block),
            _ => None,
        })
        .nth(index)
        .expect("the block");
    block.insert(&mut txn, 0, text);
}

/// [typed_at_start] as a [drafted] edit.
fn typed_into_block_start(index: usize, text: &str) -> impl FnOnce(&Doc) + '_ {
    move |doc| typed_at_start(doc, index, text)
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
    // Review r2 N2: an unreadable version is refused, not taken as none;
    // audit N1: so are a missing one and 0 (a new tab's, never late), which
    // no browser sends (a group's rows are made at version 1 or later).
    // "" leaves the header out (`send_drafts_over` sends none for it).
    for version in ["seven", "", "0"] {
        let (got, answer) = send_drafts_over(
            server.port,
            &room,
            Some(&write),
            Some(ORIGIN),
            &[("x-capy-version", version)],
            drafted(&reader.doc, typed_into_note(" late")),
        )
        .await;
        assert_eq!(
            (got, answer["class"].as_str()),
            (400, Some("malformed")),
            "{version:?}: {answer}"
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

/// Rows recording `id` for the document of `room` (a material's content or
/// a source file's).
async fn id_rows(env: &Env, room: &str, id: u64) -> i64 {
    let (query, document) = match room.split(':').next() {
        Some("source") => (
            "SELECT count(*) FROM source_document_client_ids WHERE file_id=$1 AND client_id=$2",
            room.split(':').nth(1).expect("a file"),
        ),
        _ => (
            "SELECT count(*) FROM material_yjs_client_ids WHERE material_id=$1 AND client_id=$2",
            material_of(room),
        ),
    };
    db(env)
        .await
        .query_one(query, &[&document, &(id as i64)])
        .await
        .expect("count")
        .get(0)
}

/// Waits for `id`'s rows to reach `want` (rows are written off the room's
/// task).
async fn id_rows_reach(env: &Env, room: &str, id: u64, want: i64) -> bool {
    for _ in 0..50 {
        if id_rows(env, room, id).await == want {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
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
                "authorization,content-type,x-capy-room,x-capy-base,x-capy-protocol",
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
        "x-capy-protocol",
        "x-capy-grants",
        "x-capy-version",
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
/// publication holds a source room's eviction lease, also when its body
/// arrives only after the lease was taken (the JOIN checks ran before).
#[tokio::test]
async fn a_draft_send_is_refused_while_an_eviction_lease_is_held() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "hello").await;
    let room = format!("source:{file}:epoch:1");
    let drafts = {
        let mut writer = Client::open(server.port).await;
        assert_eq!(writer.joined(&room, &token(&room, &user, "write")).await, 1);
        assert!(writer.settle(|c| source_text(c) == "hello").await);
        drafted(&writer.doc, |doc| {
            let text = doc.get_or_insert_text("source");
            let mut txn = doc.transact_mut();
            text.insert(&mut txn, 5, " late");
        })
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
        "POST /drafts HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: {ORIGIN}\r\nAuthorization: Bearer {write}\r\nX-Capy-Room: {room}\r\nX-Capy-Protocol: {}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        client_protocol(),
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
            "SELECT count(*) FROM source_document_updates WHERE file_id=$1",
            &[&file],
        )
        .await
        .expect("rows")
        .get(0);
    assert_eq!(rows, 0, "nothing was stored");
}

/// An Office file over the engine tests' `lesson.<format>` fixture (docx or
/// pptx), owned by a fresh user; returns (user, file, the base's SHA-256).
async fn office_file(env: &Env, gateway: &Gateway, format: &str) -> (String, String, String) {
    office_file_named(env, gateway, format, "f_it").await
}

/// [office_file] with an id starting with `prefix` (a debug hook).
async fn office_file_named(
    env: &Env,
    gateway: &Gateway,
    format: &str,
    prefix: &str,
) -> (String, String, String) {
    let bytes = std::fs::read(format!(
        "{}/../../../e2e/fixtures/files/basic/lesson.{format}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .expect("the Office fixture");
    let client = db(env).await;
    let suffix = uuid_like();
    let (user, workspace, file) = (
        format!("u_it_{suffix}"),
        format!("ws_it_{suffix}"),
        format!("{prefix}_{suffix}"),
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
            "INSERT INTO files (id,workspace_id,user_id,name,kind,size_bytes,status,blob_path) VALUES ($1,$2,$3,'it.'||$5,$5,$4,'ready','p/'||$1)",
            &[&file, &workspace, &user, &(bytes.len() as i64), &format],
        )
        .await
        .expect("file");
    client
        .execute(
            "INSERT INTO source_documents (file_id,user_id,format,base_revision,base_blob_path,base_source_sha256) VALUES ($1,$2,$4,1,'p/'||$1,$3)",
            &[&file, &user, &sha, &format],
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

/// The agent's paragraph commands land on a live Office room (Epo
/// 2026-10-21): a joined writer receives the inserted paragraph, its
/// Undo takes it out again, and the agent's next read, the room merged in,
/// shows a second insert after its anchor and the deleted paragraph gone. A
/// DOCX read lists the file's paragraph styles.
#[tokio::test]
async fn agent_paragraph_commands_apply_on_a_live_office_room() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    const INSERTED: &str = "Inserted by the agent";
    for format in ["docx", "pptx"] {
        let (user, file, _) = office_file(&env, &gateway, format).await;
        let room = format!("source:{file}:epoch:1");
        let mut client = Client::open(server.port).await;
        assert_eq!(client.joined(&room, &token(&room, &user, "write")).await, 1);
        let mut inspect = serde_json::json!({
            "actorUserId": user,
            "target": { "id": file, "kind": "source_file" },
        });
        if format == "docx" {
            inspect["office"] = serde_json::json!({ "start": 0, "count": 200 });
        }
        let (view, before) = office_entries(server.port, &inspect).await;
        if format == "docx" {
            assert!(
                view["scoped"]["styles"]
                    .as_array()
                    .is_some_and(|styles| !styles.is_empty()),
                "{view}"
            );
        }
        let (anchor, owner) = before
            .iter()
            .find(|(_, text)| text.starts_with("Owner sentence"))
            .cloned()
            .expect("the owner sentence");
        let edit = |operation: &str, command: serde_json::Value| {
            serde_json::json!({
                "actorUserId": user,
                "commands": [command],
                "operation": { "id": format!("op_{operation}_{file}"), "requestHash": operation },
                "target": { "id": file, "kind": "source_file" },
            })
        };
        let insert = |operation: &str| {
            edit(
                operation,
                serde_json::json!({ "type": "insert_paragraph", "afterId": anchor, "text": INSERTED }),
            )
        };
        let (status, receipt) =
            internal(server.port, "/internal/documents/edit", &insert("insert")).await;
        assert_eq!(status, 200, "{format}: {receipt}");
        let operation = format!("op_insert_{file}");
        assert_eq!(
            receipt["effect"]["undo"]["operationId"],
            operation.as_str(),
            "{format}: {receipt}"
        );
        assert!(
            client
                .settle(|c| String::from_utf8_lossy(&c.received).contains(INSERTED))
                .await,
            "{format}: the writer receives the inserted paragraph"
        );
        let undo = source_undo(&user, &format!("op_undo_{file}"), &file, &receipt);
        let (status, answer) = internal(server.port, "/internal/documents/undo", &undo).await;
        assert_eq!(status, 200, "{format}: {answer}");
        let (_, undone) = office_entries(server.port, &inspect).await;
        assert_eq!(undone, before, "{format}: the Undo takes the paragraph out");
        let (status, receipt) =
            internal(server.port, "/internal/documents/edit", &insert("insert2")).await;
        assert_eq!(status, 200, "{format}: {receipt}");
        // The owner sentence is not its story's last any more.
        let delete = edit(
            "delete",
            serde_json::json!({ "type": "delete_paragraph", "targetId": anchor, "expectedText": owner }),
        );
        let (status, receipt) = internal(server.port, "/internal/documents/edit", &delete).await;
        assert_eq!(status, 200, "{format}: {receipt}");
        let (_, after) = office_entries(server.port, &inspect).await;
        let texts: Vec<&str> = after.iter().map(|(_, text)| text.as_str()).collect();
        assert!(
            texts.contains(&INSERTED) && !texts.contains(&owner.as_str()),
            "{format}: {texts:?}"
        );
        assert!(after.iter().all(|(id, _)| *id != anchor), "{format}");
    }
}

/// An agent's read of an Office file: the answer and its paragraphs as
/// (id, text), a DOCX's from its scoped page.
async fn office_entries(
    port: u16,
    inspect: &serde_json::Value,
) -> (serde_json::Value, Vec<(String, String)>) {
    let (status, view) = internal(port, "/internal/documents/inspect", inspect).await;
    assert_eq!(status, 200, "{view}");
    let (entries, value) = match &view["scoped"] {
        scoped if scoped.is_object() => (&scoped["paragraphs"], "text"),
        _ => (&view["entries"], "value"),
    };
    let entries = entries
        .as_array()
        .expect("entries")
        .iter()
        .map(|entry| {
            let text = |key: &str| entry[key].as_str().unwrap_or_default().to_owned();
            (text("id"), text(value))
        })
        .collect();
    (view, entries)
}

/// Review r1 H1 (Q435): the store's clear of the contributor markers is no
/// edit, so an Office room is saved once its writer's typing stores: the
/// next `/internal/source-changes` read writes the cache, and the read after
/// it answers from that cache (a planted label), with no engine call.
#[tokio::test]
async fn an_office_room_reads_its_cache_once_a_writers_edit_stores() {
    use yrs::{Map, Out};
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_configured(
        &env,
        Some(&gateway.url),
        &[
            ("COLLABORATION_SOURCE_DEBOUNCE_MS", "200"),
            ("COLLABORATION_SOURCE_MAX_DEBOUNCE_MS", "1000"),
        ],
    )
    .await;
    let (user, file, _) = office_file(&env, &gateway, "docx").await;
    let room = format!("source:{file}:epoch:1");
    let mut client = Client::open(server.port).await;
    client.joined(&room, &token(&room, &user, "write")).await;
    let body = |c: &Client| {
        let txn = c.doc.transact();
        match txn.get_map("stories")?.get(&txn, "body") {
            Some(Out::YText(text)) => Some(text),
            _ => None,
        }
    };
    assert!(client.settle(|c| body(c).is_some()).await, "the body story");
    let before = client.doc.transact().state_vector();
    let story = body(&client).expect("the body story");
    story.insert(&mut client.doc.transact_mut(), 0, "Typed ");
    let update = client.doc.transact().encode_state_as_update_v1(&before);
    client.send(5, &sync(2, &update)).await;
    let mut stored = false;
    for _ in 0..100 {
        if stored_checkpoint(&env, &file).await > 0 {
            stored = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(stored, "the writer's edit never stored");
    // The store's marker clear follows it: the writer's marker is gone.
    let cleared = |c: &Client| {
        let txn = c.doc.transact();
        txn.get_map(ydoc::CONTRIBUTORS_ROOT)
            .is_some_and(|markers| markers.len(&txn) == 0)
    };
    assert!(client.settle(cleared).await, "the markers were not cleared");

    let changes = serde_json::json!({
        "workspaceId": file.replacen("f_it_", "ws_it_", 1),
        "fileIds": [file],
    });
    let (status, read) = internal(server.port, "/internal/source-changes", &changes).await;
    assert_eq!(status, 200, "{read}");
    assert_eq!(read["failed"], serde_json::json!([]), "{read}");
    assert!(
        read["files"][0]["changes"].to_string().contains("Typed"),
        "{read}"
    );
    let client_db = db(&env).await;
    let at: Option<serde_json::Value> = client_db
        .query_one(
            "SELECT effects_cache->'at' FROM source_documents WHERE file_id=$1",
            &[&file],
        )
        .await
        .expect("source row")
        .get(0);
    assert_eq!(
        at.map(|at| at["checkpoint"].clone()),
        Some(serde_json::json!(stored_checkpoint(&env, &file).await)),
        "the saved room's read writes the cache"
    );
    client_db
        .execute(
            "UPDATE source_documents SET effects_cache=jsonb_set(effects_cache,'{effects,0,label}','\"planted\"') WHERE file_id=$1",
            &[&file],
        )
        .await
        .expect("plant");
    let (status, read) = internal(server.port, "/internal/source-changes", &changes).await;
    assert_eq!(status, 200, "{read}");
    assert_eq!(
        read["files"][0]["changes"][0]["label"], "planted",
        "the next read answers from the cache: {read}"
    );
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
    let (user, file, sha) = office_file(&env, &gateway, "docx").await;
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
                base.as_deref().map(|base| ("x-capy-base", base)).as_slice(),
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
        let ticks = map_at(doc, &["keys", "q1-p", "correct"]).expect("ticks");
        ticks.insert(&mut doc.transact_mut(), "o1", true);
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
            map_at(&c.doc, &["keys", "q1-p", "correct"]).is_some_and(|ticks| {
                ticks
                    .get(&c.doc.transact(), "o1")
                    .is_some_and(|value| value.to_string(&c.doc.transact()) == "true")
            })
        })
        .await
    );
}

/// Q445 (Epo 2026-10-27): Q443's collected-history check runs in a note's
/// content room only. In a flashcard set, typing into a card a co-editor
/// just deleted (yrs collects its faces) is admitted and dropped as Yjs
/// drops it, as a draft (200) and over a live socket (acknowledged), as
/// before the release: item rooms have no late path. Fails if an item room
/// answers it late (409 `late`, `collaboration-late`).
#[tokio::test]
async fn typing_into_a_deleted_card_is_admitted_as_before() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let set = flashcard_set(
        &env,
        &owner,
        None,
        &[
            ("c1", "Cell", "unit of life"),
            ("c2", "Nucleus", "holds DNA"),
        ],
    )
    .await;
    let room = format!("material:{set}:schema:1");
    let write = token(&room, &owner, "write");
    let port = server.port;
    let mut peer = set_writer(port, &room, &write, 2).await;
    let writer = set_writer(port, &room, &write, 2).await;
    let mut other = set_writer(port, &room, &write, 2).await;
    let typed = |text: &'static str| {
        move |doc: &Doc| {
            let front = card_face(doc, "c1", "front").expect("the front");
            let len = yrs::Text::len(&front, &doc.transact());
            yrs::Text::insert(&front, &mut doc.transact_mut(), len, text);
        }
    };
    let drafts = drafted(&writer.doc, typed(" membrane"));
    let live = drafted(&other.doc, typed(" wall"));
    peer.write(|doc| {
        use yrs::Map;
        let root = doc.get_or_insert_map(items::flashcards::ROOT);
        root.remove(&mut doc.transact_mut(), "c1");
    })
    .await;
    assert!(peer.until(6).await.is_some(), "the peer's ack");

    let (status, answer) = send_drafts(port, &room, Some(&write), Some(ORIGIN), drafts).await;
    assert_eq!(status, 200, "{answer}");
    other.send(5, &sync(2, &live)).await;
    assert!(other.until(6).await.is_some(), "the live typing's ack");
    let fresh = set_writer(port, &room, &write, 1).await;
    assert_eq!(fresh.cards(), [("c2".to_owned(), "Nucleus".to_owned())]);
}

/// A writer joined to a flashcard set's room, synced to its `cards` cards.
async fn set_writer(port: u16, room: &str, write: &str, cards: usize) -> Client {
    let mut client = Client::open(port).await;
    client.joined(room, write).await;
    assert!(
        client.settle(|c| c.cards().len() == cards).await,
        "{:?}",
        client.cards()
    );
    client
}

// ------------------------------------------------- room reset as last resort

/// The note room's lineage (`room_schema`): 1 until a reset moves it.
async fn room_schema(env: &Env, material: &str) -> i32 {
    db(env)
        .await
        .query_one(
            "SELECT room_schema FROM material_yjs_documents WHERE material_id = $1",
            &[&material],
        )
        .await
        .expect("schema")
        .get(0)
}

/// Asks for a receipt and waits for it (a store ran); returns it and the
/// stateless messages read before it.
async fn stored(client: &mut Client, id: &str) -> (serde_json::Value, Vec<serde_json::Value>) {
    let request = serde_json::json!({ "id": id, "type": "checkpoint-request" }).to_string();
    let mut payload = Vec::new();
    varbytes(&mut payload, request.as_bytes());
    client.send(9, &payload).await;
    client.stateless("checkpoint-persisted").await
}

/// Security regression (Epo 2026-10-18): an update room admission refuses
/// (here a mark no leaf carries) is answered with `document-rejected` to its
/// writer alone, and only that channel closes; the other writer hears
/// nothing, the room keeps its state and lineage, and the writer's editor
/// remounts on a fresh document on the same socket, whose edit reaches the
/// other writer. Fails if a refusal reaches the room or resets it.
#[tokio::test]
async fn a_refused_edit_keeps_its_writer_and_the_room() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "hello").await;
    let room = format!("material:{material}:schema:1");
    let write = token(&room, &user, "write");
    let mut a = Client::open(server.port).await;
    let mut b = Client::open(server.port).await;
    a.joined(&room, &write).await;
    b.joined(&room, &write).await;
    assert!(a.settle(|c| c.block_text() == "hello").await);
    assert!(b.settle(|c| c.block_text() == "hello").await);
    a.write(|doc| {
        let root = doc.get_or_insert_text("content");
        let mut txn = doc.transact_mut();
        let diff = root.diff(&txn, yrs::types::text::YChange::identity);
        let Some(yrs::Out::YXmlText(block)) = diff.into_iter().map(|chunk| chunk.insert).next()
        else {
            panic!("no block");
        };
        let mut attrs = yrs::types::Attrs::new();
        attrs.insert("type".into(), yrs::Any::from("timeline"));
        block.format(&mut txn, 0, 2, attrs);
    })
    .await;
    let (rejected, _) = a.stateless("document-rejected").await;
    assert_eq!(rejected["code"], "invalid_document");
    assert!(rejected.get("evictionId").is_none(), "{rejected}");
    assert!(
        a.until(4).await.is_some(),
        "the refused channel did not close"
    );
    a.remount(&room, &write).await;
    assert!(a.settle(|c| c.block_text() == "hello").await);
    a.type_text(" world").await;
    assert!(b.settle(|c| c.block_text() == "hello world").await);
    let (_, before) = stored(&mut b, "r1").await;
    assert!(
        !before.iter().any(|m| m["type"] == "document-rejected"),
        "{before:?}"
    );
    assert!(!b.hears(4, 300).await, "the other writer's channel closed");
    assert_eq!(room_schema(&env, &material).await, 1);
}

/// An agent edit that removes a note's last block leaves one empty paragraph,
/// made in the edit's own transaction, and the edit's Undo takes that
/// paragraph out with the edit, bringing the removed block back alone (Epo
/// 2026-10-21, review r1 L2). Fails if the repair moves outside the edit's
/// captured items (the Undo would leave the paragraph beside the block) or
/// the removal is refused again.
#[tokio::test]
async fn an_agent_edit_emptying_a_note_leaves_a_paragraph_its_undo_takes_out() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "the only block").await;
    let room = format!("material:{material}:schema:1");
    let mut person = Client::open(server.port).await;
    person.joined(&room, &token(&room, &user, "write")).await;
    assert!(person.settle(|c| c.block_text() == "the only block").await);
    let blocks = |c: &Client| notes::plate::value(&c.doc.transact()).expect("projection");
    let operation = format!("e_{material}");
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &serde_json::json!({
            "actorUserId": user,
            "commands": [{ "type": "remove_block", "blockId": "b1", "expectedText": "the only block" }],
            "operation": { "id": operation, "requestHash": operation },
            "room": room,
            "target": { "id": material, "kind": "material" },
        }),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(
        receipt["effect"]["undo"]["status"], "available",
        "{receipt}"
    );
    let repaired = |c: &Client| {
        let value = blocks(c);
        value.len() == 1
            && value[0]["type"] == "p"
            && value[0]["id"] != "b1"
            && value[0]["children"] == serde_json::json!([{ "text": "" }])
    };
    assert!(person.settle(repaired).await, "{:?}", blocks(&person));

    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &format!("u_{material}"), &material, &receipt),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let restored = serde_json::json!([{ "type": "p", "id": "b1", "children": [{ "text": "the only block" }] }]);
    assert!(
        person
            .settle(|c| serde_json::Value::Array(blocks(c)) == restored)
            .await,
        "{:?}",
        blocks(&person)
    );
}

/// An agent Undo that would leave a note with no block gets one empty
/// paragraph instead of a refusal, the repair every writer gets (Epo
/// 2026-10-22): the agent adds a block, a person deletes the rest, and the
/// chat Undo succeeds with the note holding one empty paragraph. The
/// paragraph is outside the Undo's reverse, so the Redo puts the agent's
/// block back beside it. Fails if the Undo is refused again (the store's
/// "non-empty array") or the Redo fails.
#[tokio::test]
async fn an_agent_undo_emptying_a_note_leaves_a_paragraph_and_its_redo_restores_the_block() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "the person's block").await;
    let room = format!("material:{material}:schema:1");
    let mut person = Client::open(server.port).await;
    person.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        person
            .settle(|c| c.block_text() == "the person's block")
            .await
    );
    let blocks = |c: &Client| notes::plate::value(&c.doc.transact()).expect("projection");
    let added = serde_json::json!({ "type": "p", "id": "n1", "children": [{ "text": "the agent's block" }] });
    let (edit, undo, redo) = (
        format!("e_{material}"),
        format!("u_{material}"),
        format!("r_{material}"),
    );
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &serde_json::json!({
            "actorUserId": user,
            "commands": [{ "type": "insert_block", "afterBlockId": "b1", "blocks": [added.clone()] }],
            "operation": { "id": edit, "requestHash": edit },
            "room": room,
            "target": { "id": material, "kind": "material" },
        }),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert!(person.settle(|c| c.block("n1").is_some()).await);
    person
        .write(|doc| {
            let root = doc.get_or_insert_text("content");
            root.remove_range(&mut doc.transact_mut(), 0, 1);
        })
        .await;
    assert!(person.until(6).await.is_some(), "the person's ack");
    assert_eq!(blocks(&person), std::slice::from_ref(&added));

    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &undo, &material, &receipt),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let repaired = |c: &Client| {
        let value = blocks(c);
        value.len() == 1
            && value[0]["type"] == "p"
            && value[0]["children"] == serde_json::json!([{ "text": "" }])
    };
    assert!(person.settle(repaired).await, "{:?}", blocks(&person));

    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &redo, &material, &answer),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let redone = |c: &Client| {
        let value = blocks(c);
        value.len() == 2
            && c.block("n1") == Some(added.clone())
            && value
                .iter()
                .any(|block| block["children"] == serde_json::json!([{ "text": "" }]))
    };
    assert!(person.settle(redone).await, "{:?}", blocks(&person));
}

/// Security regression (Epo 2026-10-19): two writers each delete one of a
/// note's last two blocks at once, as people editing together do. Both
/// deletes go in, the emptied note gets an empty paragraph on entry, it
/// stores, and the room keeps its lineage, where the store used to refuse
/// the empty note and reset the room for both. Fails if the repair goes.
#[tokio::test]
async fn two_writers_emptying_a_note_get_a_paragraph_and_no_reset() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "one").await;
    let room = format!("material:{material}:schema:1");
    let mut a = Client::open(server.port).await;
    let mut b = Client::open(server.port).await;
    a.joined(&room, &token(&room, &user, "write")).await;
    b.joined(&room, &token(&room, &user, "write")).await;
    assert!(a.settle(|c| c.block_text() == "one").await);
    let second = serde_json::json!({ "type": "p", "id": "b2", "children": [{ "text": "two" }] });
    a.insert_blocks(1, &[second]).await;
    assert!(b.settle(|c| c.block("b2").is_some()).await);
    assert!(a.settle(|c| c.block("b2").is_some()).await);
    let delete = |index: u32| {
        move |doc: &Doc| {
            let root = doc.get_or_insert_text("content");
            root.remove_range(&mut doc.transact_mut(), index, 1);
        }
    };
    a.write(delete(0)).await;
    b.write(delete(1)).await;
    let repaired = |c: &Client| {
        notes::plate::value(&c.doc.transact()).is_ok_and(|value| {
            value.len() == 1 && value[0]["type"] == "p" && value[0]["children"][0]["text"] == ""
        })
    };
    assert!(a.settle(repaired).await);
    assert!(b.settle(repaired).await);
    let (_, before) = stored(&mut a, "r1").await;
    assert!(
        !before.iter().any(|m| m["type"] == "document-rejected"),
        "{before:?}"
    );
    assert_eq!(room_schema(&env, &material).await, 1);
}

/// Security regression (Epo 2026-10-19): a set whose two writers each delete
/// one of its last two cards gets a blank card on entry and stores, with no
/// reset. Fails if the repair goes.
#[tokio::test]
async fn two_writers_emptying_a_set_get_a_blank_card_and_no_reset() {
    use yrs::Map;
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let set = flashcard_set(
        &env,
        &owner,
        None,
        &[("c1", "One", "1"), ("c2", "Two", "2")],
    )
    .await;
    let room = format!("material:{set}:schema:1");
    let mut a = Client::open(server.port).await;
    let mut b = Client::open(server.port).await;
    a.joined(&room, &token(&room, &owner, "write")).await;
    b.joined(&room, &token(&room, &owner, "write")).await;
    assert!(a.settle(|c| c.cards().len() == 2).await);
    assert!(b.settle(|c| c.cards().len() == 2).await);
    let remove = |id: String| {
        move |doc: &Doc| {
            let root = doc.get_or_insert_map(items::flashcards::ROOT);
            root.remove(&mut doc.transact_mut(), &id);
        }
    };
    a.write(remove("c1".into())).await;
    b.write(remove("c2".into())).await;
    let blank = |c: &Client| c.cards().len() == 1 && c.cards()[0].1.is_empty();
    assert!(a.settle(blank).await);
    assert!(b.settle(blank).await);
    let (_, before) = stored(&mut a, "r1").await;
    assert!(
        !before.iter().any(|m| m["type"] == "document-rejected"),
        "{before:?}"
    );
    assert_eq!(room_schema(&env, &set).await, 1);
}

/// Security regression (Epo 2026-10-19): a block given an id another
/// top-level block holds (what two writers moving one block at once make)
/// is admitted; the store's check refuses it, the save gives the later one a
/// fresh id that both writers receive, and the note stores with no reset.
/// Fails if the save repair goes.
#[tokio::test]
async fn a_repeated_block_id_is_repaired_at_save_with_no_reset() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "one").await;
    let room = format!("material:{material}:schema:1");
    let mut a = Client::open(server.port).await;
    let mut b = Client::open(server.port).await;
    a.joined(&room, &token(&room, &user, "write")).await;
    b.joined(&room, &token(&room, &user, "write")).await;
    assert!(a.settle(|c| c.block("b1").is_some()).await);
    let copy = serde_json::json!({ "type": "p", "id": "b1", "children": [{ "text": "copy" }] });
    a.insert_blocks(1, &[copy]).await;
    let (_, before) = stored(&mut a, "r1").await;
    assert!(
        !before.iter().any(|m| m["type"] == "document-rejected"),
        "{before:?}"
    );
    let distinct = |c: &Client| {
        notes::plate::value(&c.doc.transact()).is_ok_and(|value| {
            value.len() == 2 && value[0]["id"] == "b1" && value[1]["id"] == "b1-2"
        })
    };
    assert!(a.settle(distinct).await);
    assert!(b.settle(distinct).await);
    assert_eq!(room_schema(&env, &material).await, 1);
}

// ------------------------------------------------- note sessions (in-place collection)

/// A note session's row (`sessions.rs`): its acknowledged version, whether
/// it is a live session (seen), and the deletions it holds.
async fn session_row(env: &Env, material: &str, client: u64) -> (i64, bool, yrs::IdSet) {
    let row = db(env)
        .await
        .query_one(
            "SELECT acked_version, seen_at IS NOT NULL, held FROM material_yjs_client_ids
             WHERE material_id=$1 AND document='content' AND client_id=$2",
            &[&material, &(client as i64)],
        )
        .await
        .expect("the session's row");
    let held: Option<Vec<u8>> = row.get(2);
    (
        row.get(0),
        row.get(1),
        held.map_or_else(yrs::IdSet::new, |bytes| held_ids(&bytes)),
    )
}

/// The deletions a stored `held` column holds: batches of an arrival time
/// and a Yjs delete set.
fn held_ids(bytes: &[u8]) -> yrs::IdSet {
    let mut at = 0;
    let mut ids = yrs::IdSet::new();
    for _ in 0..read_var(bytes, &mut at) {
        let _arrived = read_var(bytes, &mut at);
        let len = read_var(bytes, &mut at) as usize;
        ids.merge_with(yrs::IdSet::decode_v1(&bytes[at..at + len]).expect("ids"));
        at += len;
    }
    ids
}

impl Client {
    /// The next `stored` notice past `version`: the version it names.
    async fn stored_past(&mut self, version: i64) -> i64 {
        loop {
            let (notice, _) = self.stateless("stored").await;
            let stored = notice["version"].as_i64().expect("a version");
            if stored > version {
                return stored;
            }
        }
    }

    /// Acknowledges a stored version, as a tab does on each `stored`.
    async fn ack_version(&mut self, version: i64) {
        let ack = serde_json::json!({ "type": "ack", "version": version }).to_string();
        let mut payload = Vec::new();
        varbytes(&mut payload, ack.as_bytes());
        self.send(9, &payload).await;
    }

    /// Deletes `len` units at `index` of the first block, sent at once when
    /// `send`: the deletions it made.
    async fn delete_in_block(&mut self, index: u32, len: u32, send: bool) -> yrs::IdSet {
        let before = self.doc.transact().state_vector();
        let deleted = {
            let root = self.doc.get_or_insert_text("content");
            let mut txn = self.doc.transact_mut();
            let block = root
                .diff(&txn, yrs::types::text::YChange::identity)
                .into_iter()
                .find_map(|chunk| match chunk.insert {
                    yrs::Out::YXmlText(block) => Some(block),
                    _ => None,
                })
                .expect("a block");
            block.remove_range(&mut txn, index, len);
            txn.commit();
            txn.delete_set().clone()
        };
        if send {
            let update = self.doc.transact().encode_state_as_update_v1(&before);
            self.send(5, &sync(2, &update)).await;
        }
        deleted
    }

    /// Joins again as the same session (its own id, offered by `token`)
    /// naming `version`, and syncs: its step 2 carries all it holds.
    async fn rejoin_at(&mut self, room: &str, token: &str, version: u64) {
        let payload = join_payload_at(room, token, Some(client_protocol()), self.id(), version);
        self.send(0, &payload).await;
        self.until(1).await.expect("joined");
        let sv = self.doc.transact().state_vector().encode_v1();
        self.send(5, &sync(0, &sv)).await;
    }
}

/// In-place collection, step 1 (Epo 2026-10-23): a note room tells a synced
/// editor the stored version it holds once it answered its step 1 and after
/// each store; the session counts at the version its JOIN named, then at
/// each `ack` (never above the room's version), and its row keeps that with
/// the next store.
#[tokio::test]
async fn a_note_session_counts_at_its_join_and_acknowledged_versions() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "base").await;
    let room = format!("material:{material}:schema:1");
    let mut a = Client::open(server.port).await;
    let offered = fresh_client_id();
    a.doc = Doc::with_options(ydoc::doc_options(offered));
    a.rejoin_at(&room, &token_offering(&room, &user, "write", offered), 1)
        .await;
    assert!(a.settle(|c| c.block_text() == "base").await);
    assert_eq!(a.stored_past(0).await, 1, "the answer's stored version");
    a.type_text("-a").await;
    let second = a.stored_past(1).await;
    assert_eq!(session_row(&env, &material, a.id()).await.0, 1);
    // An acknowledgement above the room counts as the room's version.
    a.ack_version(second + 50).await;
    a.type_text("-b").await;
    a.stored_past(second).await;
    let (version, seen, held) = session_row(&env, &material, a.id()).await;
    assert_eq!((version, seen, held.is_empty()), (second, true, true));
}

/// In-place collection, step 1: a session holds the deletions its own
/// updates made. A reconnect's step 2 resends the whole delete set and adds
/// only what the room held undeleted: the session's offline deletions,
/// never another writer's that it heard. Fails if a held set takes the
/// resent deletions too, or the live ones go unheld.
#[tokio::test]
async fn a_step_2_holds_only_the_sessions_own_deletions() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note(&env, "abcdef").await;
    let material = material_of(&room).to_owned();
    let mut a = Client::open(server.port).await;
    let offered = fresh_client_id();
    a.doc = Doc::with_options(ydoc::doc_options(offered));
    let a_token = token_offering(&room, &owner, "write", offered);
    a.rejoin_at(&room, &a_token, 0).await;
    let mut b = Client::open(server.port).await;
    b.joined(&room, &token(&room, &editor, "write")).await;
    assert!(a.settle(|c| c.block_text() == "abcdef").await);
    assert!(b.settle(|c| c.block_text() == "abcdef").await);
    // B deletes "ab" live; A hears it.
    let bs = b.delete_in_block(0, 2, true).await;
    let stored = b.stored_past(1).await;
    assert!(a.settle(|c| c.block_text() == "cdef").await);
    // A leaves with unsent edits, deletes "ef" offline and comes back.
    a.leave(true).await;
    let a_deleted = a.delete_in_block(2, 2, false).await;
    a.rejoin_at(&room, &a_token, stored as u64).await;
    // Reading up to a sync message answers the room's step 1 (its step 2);
    // syncs never wait in the inbox, unlike the old channel's notices.
    a.until(5).await.expect("a sync");
    assert!(b.settle(|c| c.block_text() == "cd").await);
    b.stored_past(stored).await;
    assert_eq!(session_row(&env, &material, a.id()).await.2, a_deleted);
    assert_eq!(session_row(&env, &material, b.id()).await.2, bs);
}

/// Security regression (in-place collection, plan section 8): a clean Leave
/// ends only the session bound to the leaving channel. One naming another
/// user's session ends nothing, so that session stays counted and keeps the
/// deletions its Undo restores. Fails if a Leave ends whichever session it
/// names.
#[tokio::test]
async fn a_leave_ends_only_the_leaving_channels_own_session() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note(&env, "abcdef").await;
    let material = material_of(&room).to_owned();
    let mut victim = Client::open(server.port).await;
    victim.joined(&room, &token(&room, &owner, "write")).await;
    assert!(victim.settle(|c| c.block_text() == "abcdef").await);
    let held = victim.delete_in_block(0, 2, true).await;
    let stored = victim.stored_past(1).await;
    assert_eq!(session_row(&env, &material, victim.id()).await.2, held);
    let mut other = Client::open(server.port).await;
    other.joined(&room, &token(&room, &editor, "write")).await;
    assert!(other.settle(|c| c.block_text() == "cdef").await);
    other.leave_naming(false, victim.id()).await;
    // The victim's next store writes its session as it stands.
    victim.type_text("-x").await;
    victim.stored_past(stored).await;
    let (_, seen, kept) = session_row(&env, &material, victim.id()).await;
    assert!(seen, "the victim's session ended");
    assert_eq!(kept, held);
}

/// Editor 2026-10-26 (in-place collection, step 1): the version a room sends
/// after answering a step 1 is the latest one already committed. A session
/// joining while a store is pending hears the committed version, holding
/// more, and the pending one only once it commits. Fails if the notice names
/// a store that has not committed.
#[tokio::test]
async fn a_session_joining_while_a_store_is_pending_hears_the_committed_version() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut writer) = writer(&env, server.port, "base").await;
    let committed = writer.stored_past(0).await;
    let mut lock = db(&env).await;
    let held = lock.transaction().await.expect("transaction");
    held.batch_execute("LOCK TABLE material_yjs_updates IN EXCLUSIVE MODE")
        .await
        .expect("lock");
    writer.type_text("-a").await;
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let waiting = db(&env)
            .await
            .query_one(
                "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' \
                 AND query ILIKE '%material_yjs_updates%'",
                &[],
            )
            .await
            .expect("activity")
            .get::<_, i64>(0);
        if waiting > 0 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the store never reached the lock"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut joining = Client::open(server.port).await;
    joining.joined(&room, &token(&room, &user, "write")).await;
    assert!(joining.settle(|c| c.block_text() == "base-a").await);
    let (notice, _) = joining.stateless("stored").await;
    assert_eq!(notice["version"], committed, "the pending store's version");
    held.rollback().await.expect("release");
    assert_eq!(joining.stored_past(committed).await, committed + 1);
}

/// Editor 2026-10-26 (in-place collection, step 1): a session that never
/// wrote is counted in its room's memory only and gets no row, so the next
/// room life does not count it; it holds no deletions and no unsent edits,
/// so a collection passing it costs it only a remount (the late path), and
/// it comes back with its document whole. Fails if such a session gets a
/// row.
#[tokio::test]
async fn a_session_that_never_wrote_is_counted_only_while_its_room_lives() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut writer) = writer(&env, server.port, "base").await;
    let material = material_of(&room).to_owned();
    writer.type_text("-w").await;
    let stored = writer.stored_past(1).await;
    let offered = fresh_client_id();
    let mut reader = Client::open(server.port).await;
    reader.doc = Doc::with_options(ydoc::doc_options(offered));
    reader
        .rejoin_at(&room, &token_offering(&room, &user, "write", offered), 0)
        .await;
    assert!(reader.settle(|c| c.block_text() == "base-w").await);
    assert_eq!(reader.stored_past(0).await, stored);
    let kept = reader
        .doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    drop(reader);
    drop(writer);
    wait_unloaded(server.port).await;
    let rows: i64 = db(&env)
        .await
        .query_one(
            "SELECT count(*) FROM material_yjs_client_ids WHERE material_id=$1 AND client_id=$2",
            &[&material, &(offered as i64)],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(rows, 0, "a session that never wrote has no row");
    let mut back = Client::open(server.port).await;
    back.doc = Doc::with_options(ydoc::doc_options(offered));
    back.doc
        .transact_mut()
        .apply_update(Update::decode_v1(&kept).expect("state"))
        .expect("apply");
    back.rejoin_at(
        &room,
        &token_offering(&room, &user, "write", offered),
        stored as u64,
    )
    .await;
    assert!(back.settle(|c| c.block_text() == "base-w").await);
}

/// Review r1 H1 (Editor 2026-10-26, plan change): a tab keeps an edit
/// unsent until the second store's `stored` after the edit's ACK, which
/// holds only if nothing but a store announces. A server edit (the
/// replace-block command, whose row may fold the note) announces nothing;
/// the next store's notice names a version past it. Fails if a service edit
/// announces its version.
#[tokio::test]
async fn a_service_edit_announces_no_stored_version() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, mut writer) = writer(&env, server.port, "hello world").await;
    let material = material_of(&room).to_owned();
    let committed = writer.stored_past(0).await;
    // Its answer waits on the projection (the API); the room's part comes
    // first either way.
    let _ = internal(
        server.port,
        "/internal/commands",
        &replace_paragraph(&user, &material, "hello world", "hi world"),
    )
    .await;
    assert!(writer.settle(|c| c.block_text() == "hi world").await);
    while let Ok(Some(event)) =
        tokio::time::timeout(Duration::from_millis(500), writer.until(9)).await
    {
        let event = text_payload(&event);
        assert!(!event.contains("\"stored\""), "{event}");
    }
    writer.type_text("-x").await;
    assert!(writer.stored_past(committed).await > committed + 1);
}

/// Q382 (Epo 2026-10-26): a session row whose held deletions cannot be read
/// is dropped alone, as if that session had ended: the note loads, that
/// row's session columns are cleared, and another session's row stays.
/// Fails if one damaged row keeps the note from loading. Its tab returns
/// late (Q385): the JOIN is refused before it makes a session, so the next
/// store keeps the record lost (P1 review r3 N9). Its drafts are late too,
/// so the room tries them clean (Q436): naming nothing collected (nothing
/// is, here), they are admitted as ordinary drafts.
#[tokio::test]
async fn a_damaged_session_row_drops_only_that_session() {
    let Some(env) = env() else { return };
    let (server, logs) = start_logged(&env).await;
    let (user, room, mut writer) = writer(&env, server.port, "base").await;
    let material = material_of(&room).to_owned();
    let committed = writer.stored_past(0).await;
    let held = writer.delete_in_block(0, 1, true).await;
    let last = writer.stored_past(committed).await;
    let good = writer.id();
    let damaged = fresh_client_id();
    db(&env)
        .await
        .execute(
            "INSERT INTO material_yjs_client_ids
               (material_id, document, client_id, user_id, acked_version, seen_at, held)
             VALUES ($1, 'content', $2, $3, 1, now(), '\\x09'::bytea)",
            &[&material, &(damaged as i64), &user],
        )
        .await
        .expect("a damaged row");
    // Dropped, not left: the session stays counted across the unload.
    drop(writer);
    wait_unloaded(server.port).await;
    let mut reader = Client::open(server.port).await;
    reader.joined(&room, &token(&room, &user, "write")).await;
    assert!(reader.settle(|c| c.block_text() == "ase").await);
    let (version, seen, kept) = session_row(&env, &material, damaged).await;
    assert_eq!((version, seen, kept.is_empty()), (-1, false, true));
    let (_, seen, kept) = session_row(&env, &material, good).await;
    assert_eq!((seen, kept), (true, held));
    let message = format!("session {damaged}: unreadable held deletions");
    assert!(logs.has(&["captured error", &message]).await, "reported");
    // Review r2 M1: its tab returns as late, whatever version it names (its
    // record, and so its held deletions, were lost).
    let mut back = Client::open(server.port).await;
    let join = token(&room, &user, "write");
    let payload = join_payload_at(&room, &join, Some(client_protocol()), damaged, 99);
    back.send(0, &payload).await;
    let reason = text_payload(&back.until(2).await.expect("refused"));
    assert_eq!(reason, "collaboration-late");
    reader.type_text("!").await;
    reader.stored_past(last).await;
    assert_eq!(
        session_row(&env, &material, damaged).await.0,
        -1,
        "still lost"
    );
    // Review r3 L4: so is a draft group written under the lost id, which
    // the room admits through its record without any grant; it names
    // nothing collected, so it is admitted (Q436).
    let lost = Doc::with_options(ydoc::doc_options(damaged));
    let state = reader
        .doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    lost.transact_mut()
        .apply_update(Update::decode_v1(&state).expect("state"))
        .expect("apply");
    typed_into_note(" offline")(&lost);
    let body = lost
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let (status, _) = send_drafts(server.port, &room, Some(&join), Some(ORIGIN), body).await;
    assert_eq!(status, 200);
    assert!(
        reader
            .settle(|c| c.block_text().ends_with(" offline"))
            .await
    );
}

/// Q386 (Epo 2026-10-26): an agent holds record that cannot be read is
/// dropped and reported where it is read (here an agent edit's write), the
/// edit lands with its own holds written in its place, and the note keeps
/// loading. Fails if the edit fails, nothing is reported or the damaged
/// record stays.
#[tokio::test]
async fn unreadable_agent_holds_are_dropped_and_reported() {
    let Some(env) = env() else { return };
    let (server, logs) = start_logged(&env).await;
    let (user, material) = note(&env, "hello world").await;
    let edit = |id: &str, expected: &str, text: &str| {
        note_edit(
            &user,
            &material,
            id,
            serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": expected, "text": text }]),
        )
    };
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &edit(&format!("e1_{material}"), "world", "there"),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    db(&env)
        .await
        .execute(
            "UPDATE material_yjs_documents SET agent_held='\\x09'::bytea WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("damaged agent holds");
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &edit(&format!("e2_{material}"), "there", "folks"),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert!(
        logs.has(&["captured error", "unreadable agent holds"])
            .await
    );
    let batches = agent_held(&env, &material).await;
    assert!(
        batches.len() == 1 && !batches[0].1.is_empty(),
        "{batches:?}"
    );
    let room = format!("material:{material}:schema:1");
    let mut reader = Client::open(server.port).await;
    reader.joined(&room, &token(&room, &user, "write")).await;
    assert!(reader.settle(|c| c.block_text() == "hello folks").await);
}

/// Review r3 L1: a store never locks a deleting account among its session
/// users, so the purge holding that account's row (PurgeUser updates the
/// account's materials, then its row) never waits on a store that waits on
/// the material. Fails if the store share-locks the deleting account.
#[tokio::test]
async fn a_store_never_locks_a_deleting_session_user() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note(&env, "abcdef").await;
    let mut a = Client::open(server.port).await;
    a.joined(&room, &token(&room, &owner, "write")).await;
    let mut b = Client::open(server.port).await;
    b.joined(&room, &token(&room, &editor, "write")).await;
    assert!(b.settle(|c| c.block_text() == "abcdef").await);
    let answered = b.stored_past(0).await;
    b.delete_in_block(0, 1, true).await;
    let stored = b.stored_past(answered).await;
    db(&env)
        .await
        .execute(
            "UPDATE users SET deletion_requested_at=now(), purge_after=now() WHERE id=$1",
            &[&editor],
        )
        .await
        .expect("deletion");
    // The purge's lock on the account's row, held while A's store runs.
    let purge = db(&env).await;
    purge.execute("BEGIN", &[]).await.expect("begin");
    purge
        .execute("SELECT 1 FROM users WHERE id=$1 FOR UPDATE", &[&editor])
        .await
        .expect("account row");
    // B's session changes, so A's next store carries it.
    b.ack_version(stored).await;
    assert!(a.settle(|c| c.block_text() == "bcdef").await);
    a.type_text("-a").await;
    let next = tokio::time::timeout(Duration::from_secs(8), a.stored_past(stored)).await;
    purge.execute("ROLLBACK", &[]).await.expect("rollback");
    assert!(next.is_ok(), "the store waited on the deleting account");
}

/// Q389 (Epo 2026-10-26): a server edit whose committed row the open room
/// cannot apply (a debug-only failure for a note whose id holds the hook)
/// reloads the room from the stored document: its channels close as the
/// room is reset, and the next room holds the edit. Since Q402 an agent
/// edit of an open note is the room's own admission, so the server edit
/// here is the replace-block command. Fails if the room carries on without
/// it.
#[tokio::test]
async fn a_server_edit_the_room_cannot_apply_reloads_the_room() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note_named(&env, "hello world", "capy-it-fail-service-edit").await;
    let room = format!("material:{material}:schema:1");
    let mut person = Client::open(server.port).await;
    person.joined(&room, &token(&room, &user, "write")).await;
    assert!(person.settle(|c| c.block_text() == "hello world").await);
    // Its answer waits on the projection (the API); the room's part comes
    // first either way.
    let _ = internal(
        server.port,
        "/internal/commands",
        &replace_paragraph(&user, &material, "hello world", "hello there"),
    )
    .await;
    let closed = person.until(4).await.expect("the channel closes");
    let closed = String::from_utf8_lossy(&closed);
    assert!(closed.contains("being reset"), "{closed}");
    assert_eq!(person.block_text(), "hello world");
    wait_unloaded(server.port).await;
    let mut next = Client::open(server.port).await;
    next.joined(&room, &token(&room, &user, "write")).await;
    assert!(
        next.settle(|c| c.block_text() == "hello there").await,
        "{}",
        next.block_text()
    );
}

/// Q389 (Epo 2026-10-26): a quiz edit's step spans its content and keys
/// documents, and its one payload carries one edit time, so it ends as a
/// whole: past its 24 h (its time moved back here, the gateway's signature
/// bypassed) the Undo is refused and neither document changes. Fails if a
/// document's part can still be reverted alone.
#[tokio::test]
async fn a_quiz_step_ends_as_a_whole() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let owner = user(&env).await;
    let quiz = quiz_material(&env, &owner, "private").await;
    let content_room = format!("material:{quiz}:schema:1");
    let keys_room = format!("keys:{quiz}:schema:1");
    let mut content = Client::open(server.port).await;
    let mut keys = Client::open(server.port).await;
    content
        .joined(&content_room, &token(&content_room, &owner, "write"))
        .await;
    keys.joined(&keys_room, &token(&keys_room, &owner, "write"))
        .await;
    let has_q3 = |c: &Client| map_at(&c.doc, &["questions", "q3"]).is_some();
    let has_keys = |c: &Client| map_at(&c.doc, &["keys", "q3-p"]).is_some();
    let question = serde_json::json!({
        "type": "quiz_question", "id": "q3", "children": [{ "text": "" }],
        "question": {
            "id": "q3", "layout": "paper", "labels": "letters", "stem": [],
            "parts": [{
                "id": "q3-p", "blocks": [{ "type": "text", "text": "Order these." }],
                "answer": { "type": "ordering", "items": ["a", "b"] }, "marks": 1, "solution": [],
            }],
        },
    });
    let edit = format!("e_{quiz}");
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(
            &owner,
            &quiz,
            &edit,
            serde_json::json!([{ "type": "insert_child", "parentType": "quiz", "afterNodeId": "q2", "node": question }]),
        ),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert!(content.settle(has_q3).await);
    assert!(keys.settle(has_keys).await);
    let mut payload = receipt["undoPayload"].clone();
    assert!(
        payload["updates"]["content"].is_string() && payload["updates"]["keys"].is_string(),
        "{receipt}"
    );
    payload["issuedAt"] = serde_json::json!(unix_now() - 24 * 60 * 60);
    let (status, refusal) = internal(
        server.port,
        "/internal/documents/undo",
        &sent_back(
            &owner,
            &format!("u_{quiz}"),
            &edit,
            "material",
            &quiz,
            &payload,
        ),
    )
    .await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (409, Some("undo_unavailable")),
        "{refusal}"
    );
    let _ = keys.hears(200, 1000).await;
    assert!(has_q3(&content) && has_keys(&keys), "a document reverted");
}

/// Review r1 L5: a room never writes back the session row of an account
/// whose deletion began: the purge deletes the account's client-id rows, and
/// the room still holding its session writes none again. Fails if the next
/// store re-inserts it.
#[tokio::test]
async fn a_deleted_accounts_session_row_is_never_written_back() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note(&env, "abcdef").await;
    let material = material_of(&room).to_owned();
    let mut a = Client::open(server.port).await;
    a.joined(&room, &token(&room, &owner, "write")).await;
    let mut b = Client::open(server.port).await;
    b.joined(&room, &token(&room, &editor, "write")).await;
    assert!(b.settle(|c| c.block_text() == "abcdef").await);
    let answered = b.stored_past(0).await;
    b.delete_in_block(0, 1, true).await;
    let stored = b.stored_past(answered).await;
    assert!(session_row(&env, &material, b.id()).await.1);
    let client = db(&env).await;
    client
        .execute(
            "UPDATE users SET deletion_requested_at=now(), purge_after=now() WHERE id=$1",
            &[&editor],
        )
        .await
        .expect("deletion");
    client
        .execute(
            "DELETE FROM material_yjs_client_ids WHERE user_id=$1",
            &[&editor],
        )
        .await
        .expect("purge");
    // B's session changes after the purge; A's next store writes changes.
    b.ack_version(stored).await;
    assert!(a.settle(|c| c.block_text() == "bcdef").await);
    a.type_text("-a").await;
    a.stored_past(stored).await;
    let rows: i64 = client
        .query_one(
            "SELECT count(*) FROM material_yjs_client_ids WHERE material_id=$1 AND client_id=$2",
            &[&material, &(b.id() as i64)],
        )
        .await
        .expect("rows")
        .get(0);
    assert_eq!(rows, 0);
}

/// Review r1 L6: what a session did after its room's last store (an
/// acknowledgement, a departure) reaches its row when the room unloads.
/// Fails if the unload writes nothing.
#[tokio::test]
async fn an_unloading_room_writes_its_sessions_last_state() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (_, room, mut writer) = writer(&env, server.port, "base").await;
    let material = material_of(&room).to_owned();
    let committed = writer.stored_past(0).await;
    writer.delete_in_block(0, 1, true).await;
    let stored = writer.stored_past(committed).await;
    let id = writer.id();
    assert_ne!(session_row(&env, &material, id).await.0, stored);
    writer.ack_version(stored).await;
    // The acknowledgement lands before the socket goes.
    tokio::time::sleep(Duration::from_millis(300)).await;
    drop(writer);
    wait_unloaded(server.port).await;
    let (version, seen, _) = session_row(&env, &material, id).await;
    assert_eq!((version, seen), (stored, true));
}

/// Review r1 M3, Q390: what an agent edit deleted is held beside the note,
/// written in the edit's own transaction with no room loaded, and with the
/// receipt by the store of the room that admitted it (Q402), so no fold
/// collects what its Undo payload may restore. Fails if the edit's
/// deletions are not held with its write.
#[tokio::test]
async fn an_agent_edits_deletions_are_held_with_its_commit() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "hello world").await;
    let edit = |id: &str, expected: &str, text: &str| {
        note_edit(
            &user,
            &material,
            id,
            serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": expected, "text": text }]),
        )
    };
    // No room loaded.
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &edit(&format!("e1_{material}"), "world", "there"),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    let alone = all_ids(&agent_held(&env, &material).await);
    assert!(!alone.is_empty());
    // A room loaded.
    let room = format!("material:{material}:schema:1");
    let mut person = Client::open(server.port).await;
    person.joined(&room, &token(&room, &user, "write")).await;
    assert!(person.settle(|c| c.block_text() == "hello there").await);
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &edit(&format!("e2_{material}"), "there", "folks"),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    // The room's store writes them with the receipt (Q402).
    assert!(receipt_stored(&env, &format!("e2_{material}")).await);
    assert!(grew(&alone, &all_ids(&agent_held(&env, &material).await)));
}

/// The replace-block command of a note's only paragraph `b1`, a service
/// edit (Q402 leaves agent edits of an open note to the room's admission).
fn replace_paragraph(user: &str, material: &str, from: &str, to: &str) -> serde_json::Value {
    serde_json::json!({
        "actorUserId": user,
        "expectedBlock": { "type": "p", "id": "b1", "children": [{ "text": from }] },
        "materialId": material,
        "replacementBlock": { "type": "p", "id": "b1", "children": [{ "text": to }] },
        "room": format!("material:{material}:schema:1"),
        "type": "replace-block",
    })
}

/// The agent holds as stored: each batch's arrival (Unix seconds) and ids.
async fn agent_held(env: &Env, material: &str) -> Vec<(u64, yrs::IdSet)> {
    let bytes: Option<Vec<u8>> = db(env)
        .await
        .query_one(
            "SELECT agent_held FROM material_yjs_documents WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("document")
        .get(0);
    let bytes = bytes.expect("agent holds");
    let mut at = 0;
    let mut batches = Vec::new();
    for _ in 0..read_var(&bytes, &mut at) {
        let arrived = read_var(&bytes, &mut at);
        let len = read_var(&bytes, &mut at) as usize;
        let ids = yrs::IdSet::decode_v1(&bytes[at..at + len]).expect("ids");
        at += len;
        batches.push((arrived, ids));
    }
    batches
}

/// All the ids of stored agent holds.
fn all_ids(batches: &[(u64, yrs::IdSet)]) -> yrs::IdSet {
    let mut ids = yrs::IdSet::new();
    for (_, batch) in batches {
        ids.merge_with(batch.clone());
    }
    ids
}

/// Whether `inner` is inside `outer` and smaller.
fn grew(inner: &yrs::IdSet, outer: &yrs::IdSet) -> bool {
    let mut both = outer.clone();
    both.merge_with(inner.clone());
    &both == outer && inner != outer
}

/// Q385, Q390: the agent holds cover what an agent edit, its Undo and then
/// its Redo deleted, each held from the agent edit's time (an Undo or Redo
/// keeps its payload's time, so it does not restart the 24 h), with no room
/// loaded. Fails if a step's deletions are not held, or are held from their
/// own time.
#[tokio::test]
async fn an_agent_edits_undo_and_redo_are_held_from_the_edit() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "hello world").await;
    let (edit, undo, redo) = (
        format!("e_{material}"),
        format!("u_{material}"),
        format!("r_{material}"),
    );
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(
            &user,
            &material,
            &edit,
            serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "there" }]),
        ),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    let edited = unix_now() as u64 + 1;
    let after_edit = all_ids(&agent_held(&env, &material).await);
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &undo, &material, &receipt),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(
        answer["undoPayload"]["issuedAt"], receipt["undoPayload"]["issuedAt"],
        "{answer}"
    );
    let after_undo = all_ids(&agent_held(&env, &material).await);
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &redo, &material, &answer),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    let batches = agent_held(&env, &material).await;
    assert!(grew(&after_edit, &after_undo), "the Undo's deletions");
    assert!(
        grew(&after_undo, &all_ids(&batches)),
        "the Redo's deletions"
    );
    assert!(
        batches.iter().all(|(arrived, _)| *arrived <= edited),
        "held from the edit ({edited}): {:?}",
        batches
            .iter()
            .map(|(arrived, _)| arrived)
            .collect::<Vec<_>>()
    );
}

/// Q385, r1 L4: an agent edit's receipt says until when its Undo is offered
/// (24 h from the edit, the time its payload carries), and the server
/// refuses a payload past that (its time moved back here, the gateway's
/// signature bypassed): `undo_unavailable`, and the note keeps the edit.
/// Fails if the server takes a payload past its 24 h.
#[tokio::test]
async fn an_agent_edits_undo_is_refused_24_hours_after_the_edit() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "hello world").await;
    let edit = format!("e_{material}");
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(
            &user,
            &material,
            &edit,
            serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "there" }]),
        ),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    let issued = receipt["undoPayload"]["issuedAt"]
        .as_i64()
        .expect("the edit's time");
    let until = receipt["effect"]["undo"]["expiresAt"]
        .as_str()
        .expect("expiresAt");
    let day = std::time::UNIX_EPOCH + Duration::from_secs(issued as u64 + 24 * 60 * 60);
    assert_eq!(until, observe_iso(day), "{receipt}");
    let mut payload = receipt["undoPayload"].clone();
    payload["issuedAt"] = serde_json::json!(unix_now() - 24 * 60 * 60);
    let (status, refusal) = internal(
        server.port,
        "/internal/documents/undo",
        &sent_back(
            &user,
            &format!("u_{material}"),
            &edit,
            "material",
            &material,
            &payload,
        ),
    )
    .await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (409, Some("undo_unavailable")),
        "{refusal}"
    );
    assert_eq!(
        note_blocks(server.port, &user, &material).await,
        [("b1".to_owned(), "hello there".to_owned())]
    );
}

/// `time` as the server writes it (`Date.toISOString()`), whole seconds.
fn observe_iso(time: std::time::SystemTime) -> String {
    let secs = time
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// The no-room line (Epo 2026-10-22, Q165): an agent edit of plain text in
/// a note nobody has open, and its Undo, write the stored note and load no
/// room (a children pass, which loads it, runs only for a write naming
/// assets or embedded materials). Fails if either loads the note's room.
#[tokio::test]
async fn an_agent_edit_and_its_undo_load_no_room() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "hello world").await;
    let no_room = || async {
        for _ in 0..15 {
            assert_eq!(active_rooms(server.port).await, 0, "a room loaded");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(
            &user,
            &material,
            &format!("e_{material}"),
            serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "there" }]),
        ),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    no_room().await;
    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &format!("u_{material}"), &material, &receipt),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    no_room().await;
    assert_eq!(
        note_blocks(server.port, &user, &material).await,
        [("b1".to_owned(), "hello world".to_owned())]
    );
}

/// Review r1 L2: a note Undo whose result passes the note's size limits (a
/// removal undone after a later edit filled the note to its block cap) is
/// refused as an Undo too large, as a source's is, not as a quota refusal,
/// and writes nothing. Fails if it answers `quota_rejected`.
#[tokio::test]
async fn a_note_undo_past_its_limits_is_refused_as_too_large() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let p = |id: String, text: &str| serde_json::json!({ "type": "p", "id": id, "children": [{ "text": text }] });
    // 4,990 paragraphs: 9,980 of the 10,000 nodes a note may hold.
    let value: Vec<_> = (0..4990).map(|i| p(format!("b{i}"), "line")).collect();
    let (user, material) = note_with(&env, serde_json::Value::Array(value)).await;
    let removes: Vec<_> = (0..10)
        .map(|i| serde_json::json!({ "type": "remove_block", "blockId": format!("b{i}"), "expectedText": "line" }))
        .collect();
    let edit = format!("e1_{material}");
    let (status, removal) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(&user, &material, &edit, serde_json::Value::Array(removes)),
    )
    .await;
    assert_eq!(status, 200, "{removal}");
    let added: Vec<_> = (0..15).map(|i| p(format!("n{i}"), "more")).collect();
    let (status, insert) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(
            &user,
            &material,
            &format!("e2_{material}"),
            serde_json::json!([{ "type": "insert_block", "afterBlockId": "b4989", "blocks": added }]),
        ),
    )
    .await;
    assert_eq!(status, 200, "{insert}");
    let (status, refusal) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &format!("u_{material}"), &material, &removal),
    )
    .await;
    assert_eq!(
        (
            status,
            refusal["code"].as_str(),
            refusal["message"].as_str()
        ),
        (
            409,
            Some("undo_unavailable"),
            Some("this edit is too large to undo")
        ),
        "{refusal}"
    );
    let count: i64 = db(&env)
        .await
        .query_one(
            "SELECT count(*) FROM agent_operations WHERE undo_of=$1",
            &[&edit],
        )
        .await
        .expect("receipts")
        .get(0);
    assert_eq!(count, 0, "a refused Undo wrote its receipt");
}

/// Review r1 L3 (defence in depth behind the gateway's signature, which this
/// internal route comes after): an edit that only removed has a payload of
/// copies alone, anchored on ids a note seeded alike holds too. Sent to that
/// other note of the same user's (so the step's actor check passes, Q432) it
/// is refused, and the other note stays as it was. End to end
/// only: with the anchor check reverted another check still refuses it here,
/// so `ydoc::undo`'s `a_deletion_only_payload_of_a_note_seeded_alike_is_unheld`
/// is the check's revert test.
#[tokio::test]
async fn a_removal_payload_of_a_note_seeded_alike_is_refused() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let p = |id: &str, text: &str| serde_json::json!({ "type": "p", "id": id, "children": [{ "text": text }] });
    let value = serde_json::json!([p("b1", "first"), p("b2", "second")]);
    let (user, material) = note_with(&env, value.clone()).await;
    let other = note_for(&env, &user, "").await;
    db(&env)
        .await
        .execute(
            "UPDATE materials SET content=$2 WHERE id=$1",
            &[
                &other,
                &serde_json::json!({ "schemaVersion": 1, "value": value }),
            ],
        )
        .await
        .expect("content");
    let edit = format!("e_{other}");
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(
            &user,
            &other,
            &edit,
            serde_json::json!([{ "type": "remove_block", "blockId": "b2", "expectedText": "second" }]),
        ),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    let (status, refusal) = internal(
        server.port,
        "/internal/documents/undo",
        &sent_back(
            &user,
            &format!("u_{material}"),
            &edit,
            "material",
            &material,
            &receipt["undoPayload"],
        ),
    )
    .await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (409, Some("undo_unavailable")),
        "{refusal}"
    );
    assert_eq!(
        note_blocks(server.port, &user, &material).await,
        [
            ("b1".to_owned(), "first".to_owned()),
            ("b2".to_owned(), "second".to_owned())
        ]
    );
}

/// Review r1 L1: a viewer whose token turns writable (a role upgrade, then a
/// refresh) gets a session at its first write like any session: its
/// deletions are held and its id recorded. Fails if a channel that joined as
/// a viewer holds nothing.
#[tokio::test]
async fn a_viewer_whose_token_turns_writable_gets_a_session_at_its_first_write() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (_, _, room) = shared_note(&env, "abcdef").await;
    let material = material_of(&room).to_owned();
    let viewer = user(&env).await;
    let client = db(&env).await;
    client
        .execute(
            "INSERT INTO workspace_members (workspace_id, user_id, role)
             SELECT workspace_id, $2, 'viewer' FROM materials WHERE id=$1",
            &[&material, &viewer],
        )
        .await
        .expect("viewer");
    let mut v = Client::open(server.port).await;
    assert_eq!(v.joined(&room, &token(&room, &viewer, "read")).await, 0);
    assert!(v.settle(|c| c.block_text() == "abcdef").await);
    // A role change evicts the channel (its outbox row); dropped here, in
    // the same transaction, to reach a token turned writable on a live one.
    let upgrade = format!(
        "BEGIN; UPDATE workspace_members SET role='editor' WHERE user_id='{viewer}';
         DELETE FROM collaboration_eviction_outbox; COMMIT;"
    );
    client.batch_execute(&upgrade).await.expect("upgrade");
    let mut refresh = Vec::new();
    varbytes(&mut refresh, token(&room, &viewer, "write").as_bytes());
    v.send(11, &refresh).await;
    // The refresh lands before the edit.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let held = v.delete_in_block(0, 2, true).await;
    v.until(6).await.expect("the deletion is acknowledged");
    let answered = v.stored_past(0).await;
    v.stored_past(answered).await;
    assert_eq!(session_row(&env, &material, v.id()).await.2, held);
}

/// How many receipts of `operation` are stored now.
async fn receipts_now(env: &Env, operation: &str) -> i64 {
    db(env)
        .await
        .query_one(
            "SELECT count(*) FROM agent_operations WHERE id=$1",
            &[&operation],
        )
        .await
        .expect("receipts")
        .get(0)
}

/// Waits until `operation`'s receipt is stored, at most 10 s: a loaded room
/// writes it with the store it starts at admission (Q402, Q403).
async fn receipt_stored(env: &Env, operation: &str) -> bool {
    for _ in 0..100 {
        let stored: i64 = db(env)
            .await
            .query_one(
                "SELECT count(*) FROM agent_operations WHERE id=$1",
                &[&operation],
            )
            .await
            .expect("receipts")
            .get(0);
        if stored > 0 {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Q402, Q403 (Epo 2026-10-26): an open note's room admits an agent edit
/// like a person's edit and the tool hears done at admission, before the
/// store (each store of this note commits a second late, a debug hook): the
/// receipt is not stored yet, the editor already has the edit, the agent's
/// read and the note's live content show it. A retry gets the room's
/// receipt and changes nothing; an Undo clicked before the store works on
/// its payload. The receipts and the held deletions are then written by the
/// room's stores, and a retry after them still changes nothing. Fails if
/// the edit is written before its answer, a retry applies twice, the Undo
/// needs a stored step, or a store leaves the receipts or holds out.
#[tokio::test]
async fn an_open_room_admits_an_agent_edit_and_its_store_writes_the_receipt() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note_named(&env, "hello world", "capy-it-slow-store").await;
    let room = format!("material:{material}:schema:1");
    let mut person = Client::open(server.port).await;
    person.joined(&room, &token(&room, &user, "write")).await;
    assert!(person.settle(|c| c.block_text() == "hello world").await);
    let (edit, undo) = (format!("e_{material}"), format!("u_{material}"));
    let request = note_edit(
        &user,
        &material,
        &edit,
        serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "there" }]),
    );
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &request).await;
    assert_eq!(status, 200, "{receipt}");
    // The room projects it like a person's edit (Q432 L3).
    assert!(
        receipt["effect"].get("projectionPending").is_none(),
        "{receipt}"
    );
    let stored: i64 = db(&env)
        .await
        .query_one(
            "SELECT count(*) FROM agent_operations WHERE id=$1",
            &[&edit],
        )
        .await
        .expect("receipts")
        .get(0);
    assert_eq!(stored, 0, "the receipt was written before the answer");
    assert!(person.settle(|c| c.block_text() == "hello there").await);
    assert_eq!(
        note_blocks(server.port, &user, &material).await,
        [("b1".to_owned(), "hello there".to_owned())]
    );
    let (status, live) = internal(
        server.port,
        "/internal/materials/live",
        &serde_json::json!({ "room": room }),
    )
    .await;
    assert_eq!(status, 200, "{live}");
    assert_eq!(
        live["content"]["value"][0]["children"][0]["text"], "hello there",
        "{live}"
    );
    // A retry while unsaved: the room's receipt, no second change.
    let (status, again) = internal(server.port, "/internal/documents/edit", &request).await;
    assert_eq!(
        (status, again["operationId"].as_str()),
        (200, Some(edit.as_str())),
        "{again}"
    );
    assert!(again.get("undoPayload").is_none(), "{again}");
    // The Undo before the store: its step is the room's.
    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&user, &undo, &material, &receipt),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["effect"]["operation"], "edit_undone", "{answer}");
    assert!(person.settle(|c| c.block_text() == "hello world").await);
    assert!(receipt_stored(&env, &edit).await, "the edit's receipt");
    assert!(receipt_stored(&env, &undo).await, "the Undo's receipt");
    let undone_of: Option<String> = db(&env)
        .await
        .query_one("SELECT undo_of FROM agent_operations WHERE id=$1", &[&undo])
        .await
        .expect("the Undo's receipt")
        .get(0);
    assert_eq!(undone_of.as_deref(), Some(edit.as_str()));
    assert!(!all_ids(&agent_held(&env, &material).await).is_empty());
    let (status, again) = internal(server.port, "/internal/documents/edit", &request).await;
    assert_eq!(
        (status, again["operationId"].as_str()),
        (200, Some(edit.as_str())),
        "{again}"
    );
    let _ = person.hears(200, 300).await;
    assert_eq!(person.block_text(), "hello world");
}

/// A quiz owned by `owner` whose id starts with `prefix`.
async fn quiz_named(env: &Env, owner: &str, prefix: &str) -> String {
    quiz_material_as(env, owner, "private", format!("{prefix}_{}", uuid_like())).await
}

/// Q403 (Epo 2026-10-26): a quiz edit whose content room is open (a reader
/// has the quiz) loads its keys room, and both rooms admit it together:
/// the reader's room gets the question, the keys room its key, and both
/// documents are stored at once (the store debounce is a minute here). When
/// the keys room refuses its part (a debug hook for a quiz whose id holds
/// it), neither room takes any of it. Fails if a half-loaded quiz is
/// written past its open room, either room waits for its debounce, or one
/// room keeps its part of a refused edit.
#[tokio::test]
async fn a_quiz_edit_is_admitted_by_both_its_rooms_or_neither() {
    let Some(env) = env() else { return };
    let server = start_configured(
        &env,
        env.api.as_deref(),
        &[
            ("COLLABORATION_DEBOUNCE_MS", "60000"),
            ("COLLABORATION_MAX_DEBOUNCE_MS", "60000"),
        ],
    )
    .await;
    let owner = user(&env).await;
    let question = serde_json::json!({
        "type": "quiz_question", "id": "q3", "children": [{ "text": "" }],
        "question": {
            "id": "q3", "layout": "paper", "labels": "letters", "stem": [],
            "parts": [{
                "id": "q3-p", "blocks": [{ "type": "text", "text": "Order these." }],
                "answer": { "type": "ordering", "items": ["a", "b"] }, "marks": 1, "solution": [],
            }],
        },
    });
    let insert = serde_json::json!([{ "type": "insert_child", "parentType": "quiz", "afterNodeId": "q2", "node": question }]);
    let has_q3 = |c: &Client| map_at(&c.doc, &["questions", "q3"]).is_some();

    let quiz = quiz_material(&env, &owner, "private").await;
    let room = format!("material:{quiz}:schema:1");
    let mut content = Client::open(server.port).await;
    content.joined(&room, &token(&room, &owner, "write")).await;
    assert!(
        content
            .settle(|c| map_at(&c.doc, &["questions", "q2"]).is_some())
            .await
    );
    assert_eq!(active_rooms(server.port).await, 1);
    let (status, receipt) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(&owner, &quiz, &format!("e_{quiz}"), insert.clone()),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert!(content.settle(has_q3).await);
    // The keys room loaded for the edit has no member, so it may store and
    // unload before a room count is read: its part shows in its stored rows
    // and in its document once joined.
    let keys_room = format!("keys:{quiz}:schema:1");
    let mut keys = Client::open(server.port).await;
    keys.joined(&keys_room, &token(&keys_room, &owner, "write"))
        .await;
    assert!(
        keys.settle(|c| map_at(&c.doc, &["keys", "q3-p"]).is_some())
            .await
    );
    assert!(receipt_stored(&env, &format!("e_{quiz}")).await);
    // Stored well before the minute's debounce: the stored keys document
    // holds the key, whether the memberless room's unload folded its row into
    // the base or not (a row count can drop at that fold).
    let mut held = false;
    for _ in 0..50 {
        held = stored_keys_hold(&env, &quiz, "q3-p").await;
        if held {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(held, "the keys room did not store its part");

    let refused = quiz_named(&env, &owner, "capy-it-refuse-agent-keys").await;
    let room = format!("material:{refused}:schema:1");
    let mut content = Client::open(server.port).await;
    content.joined(&room, &token(&room, &owner, "write")).await;
    assert!(
        content
            .settle(|c| map_at(&c.doc, &["questions", "q2"]).is_some())
            .await
    );
    let (status, refusal) = internal(
        server.port,
        "/internal/documents/edit",
        &note_edit(&owner, &refused, &format!("e_{refused}"), insert),
    )
    .await;
    assert_ne!(status, 200, "{refusal}");
    let _ = content.hears(200, 500).await;
    assert!(!has_q3(&content), "the content room kept its part");
    let keys_room = format!("keys:{refused}:schema:1");
    let mut keys = Client::open(server.port).await;
    keys.joined(&keys_room, &token(&keys_room, &owner, "write"))
        .await;
    assert!(
        keys.settle(|c| map_at(&c.doc, &["keys", "q2-p"]).is_some())
            .await
    );
    assert!(map_at(&keys.doc, &["keys", "q3-p"]).is_none());
}

/// Q402: a text source's room refuses an agent edit it would refuse from a
/// person, as it does: an append past the room's state cap is refused
/// (`413`), nothing of it lands, and the same append typed by the person
/// closes their channel for size. Fails if the room takes an agent edit
/// past the checks a person's update gets.
#[tokio::test]
async fn an_open_room_refuses_an_agent_edit_as_it_refuses_a_persons() {
    let Some(env) = env() else { return };
    let _cap = ExportCap::lower(&env).await;
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let growth = sources::STATE_WRITE_RESERVE_BYTES as usize + 100 * 1024;
    let (mut client, user, file, base) = capped_text_source(&env, &gateway, &server, growth).await;
    let appended = "b".repeat(150 * 1024);
    let edit = serde_json::json!({
        "actorUserId": user,
        "commands": [{
            "type": "replace_text",
            "expectedText": "END",
            "offset": base.len() - 3,
            "text": format!("END{appended}"),
        }],
        "operation": { "id": format!("op_{file}"), "requestHash": "h1" },
        "target": { "id": file, "kind": "source_file" },
    });
    let (status, refusal) = internal(server.port, "/internal/documents/edit", &edit).await;
    assert_eq!(status, 413, "{refusal}");
    let _ = client.hears(200, 500).await;
    assert_eq!(source_text(&client).len(), base.len());
    // An agent's refusal loses no one's work: no edit incident (Q432 L4);
    // the person's below records one.
    assert_eq!(file_incidents(&env, &file).await, 0);
    type_at_start(&mut client, &appended).await;
    closed_for_size(client.until(4).await);
    let mut recorded = 0;
    for _ in 0..50 {
        recorded = file_incidents(&env, &file).await;
        if recorded > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(recorded > 0, "the person's refusal recorded no incident");
}

/// The edit incidents recorded for a file or material.
async fn file_incidents(env: &Env, file: &str) -> i64 {
    db(env)
        .await
        .query_one(
            "SELECT count(*) FROM edit_incidents WHERE file_id=$1",
            &[&file],
        )
        .await
        .expect("incidents")
        .get(0)
}

/// Q402, Q399 M1: the same agent edit of an open text source sent twice at
/// once (a pipeline retry while the first is still on its way) lands once:
/// the room admits the first and answers the second with its receipt, which
/// the room's checkpoint stores with its Undo ref. Fails if the second
/// applies again.
#[tokio::test]
async fn a_source_edit_retried_at_its_open_room_lands_once() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "hello world").await;
    let room = format!("source:{file}:epoch:1");
    let mut client = Client::open(server.port).await;
    client.joined(&room, &token(&room, &user, "write")).await;
    assert!(client.settle(|c| source_text(c) == "hello world").await);
    let edit = format!("e_{file}");
    let body = source_edit(
        &user,
        &file,
        &edit,
        serde_json::json!([{ "type": "replace_text", "expectedText": "world", "text": "there" }]),
    );
    let ((first, a), (second, b)) = tokio::join!(
        internal(server.port, "/internal/documents/edit", &body),
        internal(server.port, "/internal/documents/edit", &body),
    );
    assert_eq!((first, second), (200, 200), "{a} {b}");
    assert_eq!(a["operationId"], b["operationId"]);
    assert!(client.settle(|c| source_text(c) == "hello there").await);
    let _ = client.hears(200, 500).await;
    assert_eq!(source_text(&client), "hello there");
    assert!(receipt_stored(&env, &edit).await);
    assert_eq!(
        stored_undo(&env, &edit).await.as_deref(),
        Some(edit.as_str())
    );
}

/// Review r2 M1: with no room loaded, a source edit retried after its
/// checkpoint committed is answered with its stored receipt, no Undo payload
/// of its own and nothing computed or written again (the edit would still
/// apply to the text it left); two requests of one operation racing its
/// checkpoint land once, the second answered by Go's replay without a
/// payload. Fails if a retry recomputes the edit and reaches a checkpoint,
/// or a replayed retry offers its own change as the step's Undo.
#[tokio::test]
async fn a_source_edit_retried_after_its_checkpoint_is_replayed() {
    use std::sync::atomic::Ordering::Relaxed;
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "hello world").await;
    let edit = format!("e_{file}");
    let body = source_edit(
        &user,
        &file,
        &edit,
        serde_json::json!([{ "type": "replace_text", "expectedText": "world", "text": "world!" }]),
    );
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &body).await;
    assert_eq!(status, 200, "{receipt}");
    assert!(receipt["undoPayload"].is_object(), "{receipt}");
    let checkpoints = gateway.checkpoints.load(Relaxed);
    let (status, again) = internal(server.port, "/internal/documents/edit", &body).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["operationId"], receipt["operationId"]);
    assert!(again.get("undoPayload").is_none(), "{again}");
    assert_eq!(
        gateway.checkpoints.load(Relaxed),
        checkpoints,
        "answered as stored"
    );
    // Both requests pass the stored receipt check before the slow
    // checkpoint commits; the edit still applies to the committed text.
    gateway.checkpoint_delay.store(500, Relaxed);
    let body = source_edit(
        &user,
        &file,
        &format!("e2_{file}"),
        serde_json::json!([{ "type": "replace_text", "expectedText": "hello", "text": "hello!" }]),
    );
    let ((first, a), (second, b)) = tokio::join!(
        internal(server.port, "/internal/documents/edit", &body),
        internal(server.port, "/internal/documents/edit", &body),
    );
    gateway.checkpoint_delay.store(0, Relaxed);
    assert_eq!((first, second), (200, 200), "{a} {b}");
    assert_eq!(a["operationId"], b["operationId"]);
    let offered = [&a, &b]
        .iter()
        .filter(|answer| answer["undoPayload"].is_object())
        .count();
    assert_eq!(offered, 1, "{a} {b}");
}

/// Q417 (Epo 2026-10-27): a detailed read's live note content comes only
/// from a room holding edits its projected content lacks. An open note no
/// one edited answers none (no snapshot: the stored content stands); typing
/// answers the room's content with it. Fails if a clean room answers its
/// state or a typed one none.
#[tokio::test]
async fn a_live_note_read_answers_only_a_room_with_unprojected_edits() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (_, room, mut writer) = writer(&env, server.port, "hello").await;
    let body = serde_json::json!({ "room": room });
    let (status, clean) = internal(server.port, "/internal/materials/live", &body).await;
    assert_eq!(status, 200, "{clean}");
    assert!(clean["content"].is_null(), "{clean}");
    writer.type_text("!").await;
    writer.until(6).await.expect("ack");
    let (status, typed) = internal(server.port, "/internal/materials/live", &body).await;
    assert_eq!(status, 200, "{typed}");
    let text = typed["content"]["value"][0]["children"][0]["text"].as_str();
    assert!(text.is_some_and(|text| text.contains('!')), "{typed}");
}

/// Q432 (Epo 2026-10-27, review r1 M1): a room-path agent edit holds a
/// pooled connection only for its receipt checks and its admission, never
/// through its compute. Twelve agent edits computing slowly on an open note
/// (a debug hook, three seconds each), more than the pool's ten
/// connections, leave the room's store free: a person's typing meanwhile is
/// stored within two seconds, and every edit lands after. Fails if the
/// compute holds its connection.
#[tokio::test]
async fn a_slow_agent_compute_holds_no_pool_connection() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note_named(&env, "hello", "capy-it-slow-compute").await;
    let room = format!("material:{material}:schema:1");
    let mut person = Client::open(server.port).await;
    person.joined(&room, &token(&room, &user, "write")).await;
    assert!(person.settle(|c| c.block_text() == "hello").await);
    let rows = update_rows(&env, "material_yjs_updates", &material).await;
    let edits: Vec<_> = (0..12)
        .map(|i| {
            let body = note_edit(
                &user,
                &material,
                &format!("e{i}_{material}"),
                serde_json::json!([{
                    "type": "insert_block",
                    "afterBlockId": "b1",
                    "blocks": [{ "type": "p", "id": format!("n{i}"), "children": [{ "text": format!("agent {i}") }] }],
                }]),
            );
            let port = server.port;
            tokio::spawn(async move { internal(port, "/internal/documents/edit", &body).await })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(500)).await;
    person.type_text("!").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while update_rows(&env, "material_yjs_updates", &material).await <= rows {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the store waited for a connection"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for edit in edits {
        let (status, body) = edit.await.expect("edit");
        assert_eq!(status, 200, "{body}");
    }
}

/// Q446 (Epo 2026-10-27, REVIEW-final-rust L1): an agent edit computed on a
/// snapshot whose block a person deletes before its admission (a slow
/// compute, a debug hook) types among letters yrs dropped with the block
/// (`named_collected`'s `Since`): it is refused `stale_target`, so the agent
/// re-reads, never answered late or as an unknown outcome (503, reported),
/// and nothing of it lands. Fails if the room admits it or answers it
/// otherwise.
#[tokio::test]
async fn an_agent_edit_into_a_block_deleted_meanwhile_is_stale() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note_named(&env, "hello world", "capy-it-slow-compute").await;
    let room = format!("material:{material}:schema:1");
    let mut person = Client::open(server.port).await;
    person.joined(&room, &token(&room, &user, "write")).await;
    assert!(person.settle(|c| c.block_text() == "hello world").await);
    person
        .insert_blocks(
            1,
            &[serde_json::json!({ "type": "p", "id": "kept", "children": [{ "text": "kept" }] })],
        )
        .await;
    assert!(person.until(6).await.is_some(), "the block's ack");
    let operation = format!("e_{material}");
    let body = note_edit(
        &user,
        &material,
        &operation,
        serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "there" }]),
    );
    let port = server.port;
    let edit = tokio::spawn(async move { internal(port, "/internal/documents/edit", &body).await });
    tokio::time::sleep(Duration::from_millis(500)).await;
    person
        .write(|doc| {
            let root = doc.get_or_insert_text("content");
            root.remove_range(&mut doc.transact_mut(), 0, 1);
        })
        .await;
    assert!(person.until(6).await.is_some(), "the deletion's ack");
    let (status, refusal) = edit.await.expect("edit");
    assert_eq!(
        (status, refusal["code"].as_str()),
        (409, Some("stale_target")),
        "{refusal}"
    );
    let _ = person.hears(5, 300).await;
    assert_eq!(person.block_text(), "kept");
    assert!(!receipt_stored_now(&env, &operation).await);
}

/// Q456 (Epo 2026-10-27): while a room's saves fail (a trigger refuses the
/// note's update rows: its store retries after the failure), it refuses an
/// agent edit `saves_failing` (409, which the agent's tool tells the model
/// not to retry this turn) and an agent Undo `unavailable_target` (its
/// button stays), applying neither, while the person keeps typing. Once a
/// store succeeds, the same edit is admitted. Fails if the room admits agent
/// edits while its saves fail, or still refuses them after.
#[tokio::test]
async fn a_room_whose_saves_fail_refuses_agent_edits() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, material) = note(&env, "hello world").await;
    let room = format!("material:{material}:schema:1");
    let port = server.port;
    let mut person = Client::open(port).await;
    person.joined(&room, &token(&room, &user, "write")).await;
    assert!(person.settle(|c| c.block_text() == "hello world").await);
    let edit = format!("e_{material}");
    let (status, receipt) = internal(
        port,
        "/internal/documents/edit",
        &note_edit(
            &user,
            &material,
            &edit,
            serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": "hello", "text": "hi" }]),
        ),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert!(receipt_stored(&env, &edit).await);
    assert!(person.settle(|c| c.block_text() == "hi world").await);
    let trigger = fail_update_rows(&env, &material).await;
    person.type_text("!").await;
    person.stateless("checkpoint-failed").await;
    let later = format!("l_{material}");
    let body = note_edit(
        &user,
        &material,
        &later,
        serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "there" }]),
    );
    let (status, refusal) = internal(port, "/internal/documents/edit", &body).await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (409, Some("saves_failing")),
        "{refusal}"
    );
    let undo = undo_step(&user, &format!("u_{material}"), &material, &receipt);
    let (status, refusal) = internal(port, "/internal/documents/undo", &undo).await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (409, Some("unavailable_target")),
        "{refusal}"
    );
    let _ = person.hears(5, 300).await;
    assert_eq!(person.block_text(), "hi world!");
    let rows = update_rows(&env, "material_yjs_updates", &material).await;
    db(&env)
        .await
        .batch_execute(&format!("DROP TRIGGER {trigger} ON material_yjs_updates"))
        .await
        .expect("drop the trigger");
    // The retry (5 s after the failure) stores the person's typing.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while update_rows(&env, "material_yjs_updates", &material).await <= rows {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the retry never stored"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let (status, answer) = internal(port, "/internal/documents/edit", &body).await;
    assert_eq!(status, 200, "{answer}");
    assert!(person.settle(|c| c.block_text() == "hi there!").await);
}

/// Makes every update row `material`'s stores insert fail (a trigger, named
/// in the answer, dropped by the caller).
async fn fail_update_rows(env: &Env, material: &str) -> String {
    let client = db(env).await;
    client
        .batch_execute(
            "CREATE OR REPLACE FUNCTION capy_it_fail_update_row() RETURNS trigger
             LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'integration test store failure'; END $$",
        )
        .await
        .expect("the trigger function");
    let name = format!("capy_it_fail_{material}");
    client
        .batch_execute(&format!(
            "CREATE TRIGGER {name} BEFORE INSERT ON material_yjs_updates FOR EACH ROW
             WHEN (NEW.material_id = '{material}') EXECUTE FUNCTION capy_it_fail_update_row()"
        ))
        .await
        .expect("the trigger");
    name
}

/// Whether an agent operation's receipt is stored, without waiting.
async fn receipt_stored_now(env: &Env, operation: &str) -> bool {
    db(env)
        .await
        .query_one(
            "SELECT count(*) FROM agent_operations WHERE id=$1",
            &[&operation],
        )
        .await
        .expect("receipts")
        .get::<_, i64>(0)
        > 0
}

/// Q432 (review r1 M2): a receipt the room's store cannot write is passed
/// over under a savepoint and reported, and the store saves everyone's
/// edits. The agent's chat is deleted between the edit's admission and its
/// store (a second late, a debug hook): the store lands without the
/// receipt, and the person's typing after it is stored too. Fails if the
/// receipt fails the store.
#[tokio::test]
async fn a_store_passes_over_a_receipt_whose_chat_was_deleted() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, _, room) = shared_note_named(&env, "hello world", "capy-it-slow-store").await;
    let material = material_of(&room).to_owned();
    let client = db(&env).await;
    let conversation = format!("conv_it_{}", uuid_like());
    client
        .execute(
            "INSERT INTO conversations (id, user_id, workspace_id)
             SELECT $1, $2, workspace_id FROM materials WHERE id=$3",
            &[&conversation, &owner, &material],
        )
        .await
        .expect("conversation");
    let mut person = Client::open(server.port).await;
    person.joined(&room, &token(&room, &owner, "write")).await;
    assert!(person.settle(|c| c.block_text() == "hello world").await);
    let rows = update_rows(&env, "material_yjs_updates", &material).await;
    let edit = format!("e_{material}");
    let mut request = note_edit(
        &owner,
        &material,
        &edit,
        serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "there" }]),
    );
    request["operation"]["conversationId"] = serde_json::json!(conversation);
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &request).await;
    assert_eq!(status, 200, "{receipt}");
    client
        .execute("DELETE FROM conversations WHERE id=$1", &[&conversation])
        .await
        .expect("chat deleted");
    assert!(person.settle(|c| c.block_text() == "hello there").await);
    person.type_text("!").await;
    assert!(
        rows_past(&env, "material_yjs_updates", &material, rows + 1).await,
        "the stores did not land"
    );
    let receipts: i64 = client
        .query_one(
            "SELECT count(*) FROM agent_operations WHERE id=$1",
            &[&edit],
        )
        .await
        .expect("receipts")
        .get(0);
    assert_eq!(receipts, 0, "the receipt of a deleted chat was written");
}

/// Q432 (review r1 M2): a room refuses a new agent edit with
/// `unavailable_target` once 256 of its agent steps wait unstored. The
/// test holds the note's lock so the room's store cannot commit: the first
/// edit's store waits on it, 255 more edits are admitted, the next is
/// refused; once the lock goes, the store writes all 256 receipts. Fails if
/// the room keeps admitting.
#[tokio::test]
async fn a_room_refuses_agent_edits_past_256_unstored() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (user, room, _person) = writer(&env, server.port, "hello").await;
    let material = material_of(&room).to_owned();
    let mut holder = db(&env).await;
    let lock = holder.transaction().await.expect("transaction");
    lock.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        &[&material],
    )
    .await
    .expect("the note's lock");
    let insert = |i: usize| {
        note_edit(
            &user,
            &material,
            &format!("e{i}_{material}"),
            serde_json::json!([{
                "type": "insert_block",
                "afterBlockId": "b1",
                "blocks": [{ "type": "p", "id": format!("n{i}"), "children": [{ "text": "a" }] }],
            }]),
        )
    };
    // Each answers at once: an edit waiting on the held lock is a failure.
    let send = |i: usize| {
        let body = insert(i);
        let port = server.port;
        async move {
            tokio::time::timeout(
                Duration::from_secs(10),
                internal(port, "/internal/documents/edit", &body),
            )
            .await
            .unwrap_or_else(|_| panic!("edit {i} waited on the note's lock"))
        }
    };
    for i in 0..256 {
        let (status, body) = send(i).await;
        assert_eq!(status, 200, "edit {i}: {body}");
    }
    let (status, refusal) = send(256).await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (503, Some("unavailable_target")),
        "{refusal}"
    );
    lock.rollback().await.expect("lock let go");
    let mut stored = 0;
    for _ in 0..100 {
        stored = db(&env)
            .await
            .query_one(
                "SELECT count(*) FROM agent_operations WHERE actor_user_id=$1",
                &[&user],
            )
            .await
            .expect("receipts")
            .get::<_, i64>(0);
        if stored == 256 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(stored, 256);
}

/// Security regression (Q432, review r1 M3): an agent Undo or Redo is
/// refused unless its actor made the step. A's agent edit of a shared note
/// through its open room, its store a second late (a debug hook); B, an
/// editor of the note holding A's payload, sends the Undo before the store:
/// refused 403 by the room, the text unchanged. Once the room unloaded (the
/// step stored), B's Undo through the direct write is refused the same way,
/// and an Undo naming a step never stored is refused `undo_unavailable`;
/// A's own Undo then lands. Fails if the room's or the direct path's actor
/// check is removed, or the direct path takes an Undo of a missing step.
#[tokio::test]
async fn an_undo_of_another_users_agent_step_is_refused() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note_named(&env, "hello world", "capy-it-slow-store").await;
    let material = material_of(&room).to_owned();
    let mut person = Client::open(server.port).await;
    person.joined(&room, &token(&room, &owner, "write")).await;
    assert!(person.settle(|c| c.block_text() == "hello world").await);
    let edit = format!("e_{material}");
    let request = note_edit(
        &owner,
        &material,
        &edit,
        serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "there" }]),
    );
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &request).await;
    assert_eq!(status, 200, "{receipt}");
    let (status, refusal) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&editor, &format!("u1_{material}"), &material, &receipt),
    )
    .await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (403, Some("lifecycle_rejected")),
        "{refusal}"
    );
    let _ = person.hears(200, 500).await;
    assert_eq!(person.block_text(), "hello there");
    assert!(receipt_stored(&env, &edit).await);
    drop(person);
    wait_unloaded(server.port).await;
    let (status, refusal) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&editor, &format!("u2_{material}"), &material, &receipt),
    )
    .await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (403, Some("lifecycle_rejected")),
        "{refusal}"
    );
    let (status, gone) = internal(
        server.port,
        "/internal/documents/undo",
        &sent_back(
            &owner,
            &format!("u3_{material}"),
            &format!("never_{material}"),
            "material",
            &material,
            &receipt["undoPayload"],
        ),
    )
    .await;
    assert_eq!(gone["code"], "undo_unavailable", "{status} {gone}");
    assert_eq!(
        note_blocks(server.port, &owner, &material).await,
        [("b1".to_owned(), "hello there".to_owned())]
    );
    let (status, answer) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&owner, &format!("u4_{material}"), &material, &receipt),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
}

/// Security regression (Q432, review r1 M3): with no room loaded, a source
/// Undo of another user's step is refused before anything is computed or
/// written. Fails if the no-room source path skips the actor check.
#[tokio::test]
async fn a_source_undo_of_another_users_step_is_refused() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (owner, file) = text_file(&env, &gateway, "hello world").await;
    let other = user(&env).await;
    let edit = format!("e_{file}");
    let body = source_edit(
        &owner,
        &file,
        &edit,
        serde_json::json!([{ "type": "replace_text", "expectedText": "world", "text": "there" }]),
    );
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &body).await;
    assert_eq!(status, 200, "{receipt}");
    let checkpoints = gateway
        .checkpoints
        .load(std::sync::atomic::Ordering::Relaxed);
    let (status, refusal) = internal(
        server.port,
        "/internal/documents/undo",
        &source_undo(&other, &format!("u_{file}"), &file, &receipt),
    )
    .await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (403, Some("lifecycle_rejected")),
        "{refusal}"
    );
    assert_eq!(
        gateway
            .checkpoints
            .load(std::sync::atomic::Ordering::Relaxed),
        checkpoints,
        "the refused Undo reached a checkpoint"
    );
}

/// Security regression (Q451, REVIEW-final-rust L4): A's Undo of A's agent
/// step is admitted by the open room and waits for its store (a debug hook
/// delays every store a second); B, an editor holding A's payload, sends an
/// Undo of the same step meanwhile and is refused 403, never answered with
/// A's Undo receipt, and nothing of B's request is stored; so is B's Undo
/// with no room loaded, the reversal stored. Fails if the room's receipt
/// probe, or the no-room path's, answers another user's reversal.
#[tokio::test]
async fn an_undo_of_another_users_step_gets_no_receipt_of_its_reversal() {
    let Some(env) = env() else { return };
    let server = start(&env).await;
    let (owner, editor, room) = shared_note_named(&env, "hello world", "capy-it-slow-store").await;
    let material = material_of(&room).to_owned();
    let mut person = Client::open(server.port).await;
    person.joined(&room, &token(&room, &owner, "write")).await;
    assert!(person.settle(|c| c.block_text() == "hello world").await);
    let edit = format!("e_{material}");
    let request = note_edit(
        &owner,
        &material,
        &edit,
        serde_json::json!([{ "type": "replace_text", "blockId": "b1", "expectedText": "world", "text": "there" }]),
    );
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &request).await;
    assert_eq!(status, 200, "{receipt}");
    assert!(receipt_stored(&env, &edit).await);
    let ours = format!("u_a_{material}");
    let (status, undone) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&owner, &ours, &material, &receipt),
    )
    .await;
    assert_eq!(status, 200, "{undone}");
    let theirs = format!("u_b_{material}");
    let (status, refusal) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&editor, &theirs, &material, &receipt),
    )
    .await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (403, Some("lifecycle_rejected")),
        "{refusal}"
    );
    assert!(receipt_stored(&env, &ours).await);
    assert!(!receipt_stored_now(&env, &theirs).await);
    drop(person);
    wait_unloaded(server.port).await;
    let (status, refusal) = internal(
        server.port,
        "/internal/documents/undo",
        &undo_step(&editor, &format!("u_b2_{material}"), &material, &receipt),
    )
    .await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (403, Some("lifecycle_rejected")),
        "{refusal}"
    );
}

/// Security regression (Q451, REVIEW-final-rust L4): B's Undo of A's agent
/// step on an open Office room is refused 403 before anything computes: the
/// compute of a file whose id holds the debug hook waits three seconds, and
/// the refusal comes well within them. Fails if the actor check waits for
/// the room's admission, after the engine ran.
#[tokio::test]
async fn an_office_undo_of_another_users_step_is_refused_before_it_computes() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (owner, file, _) = office_file_named(&env, &gateway, "docx", "capy-it-slow-compute").await;
    let other = user(&env).await;
    let room = format!("source:{file}:epoch:1");
    let mut client = Client::open(server.port).await;
    assert_eq!(
        client.joined(&room, &token(&room, &owner, "write")).await,
        1
    );
    let inspect = serde_json::json!({
        "actorUserId": owner,
        "office": { "start": 0, "count": 200 },
        "target": { "id": file, "kind": "source_file" },
    });
    let (_, entries) = office_entries(server.port, &inspect).await;
    let (anchor, _) = entries
        .iter()
        .find(|(_, text)| text.starts_with("Owner sentence"))
        .cloned()
        .expect("the owner sentence");
    let body = source_edit(
        &owner,
        &file,
        &format!("e_{file}"),
        serde_json::json!([{ "type": "insert_paragraph", "afterId": anchor, "text": "Inserted" }]),
    );
    let (status, receipt) = internal(server.port, "/internal/documents/edit", &body).await;
    assert_eq!(status, 200, "{receipt}");
    let started = std::time::Instant::now();
    let (status, refusal) = internal(
        server.port,
        "/internal/documents/undo",
        &source_undo(&other, &format!("u_{file}"), &file, &receipt),
    )
    .await;
    assert_eq!(
        (status, refusal["code"].as_str()),
        (403, Some("lifecycle_rejected")),
        "{refusal}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "refused after {:?}: the compute ran first",
        started.elapsed()
    );
}

/// Q432 (review r1 L1): with no room loaded, a retry that passed the stored
/// receipt check while its first request was still on the way, then
/// computed on the text that request left, is refused stale and answers
/// with the first request's receipt instead. A debug hook holds both half a
/// second after that check; the retry is sent a quarter second later. Fails
/// if the refusal stands.
#[tokio::test]
async fn a_no_room_source_retry_refused_stale_answers_the_stored_receipt() {
    let Some(env) = env() else { return };
    let gateway = gateway(&env).await;
    let server = start_with(&env, Some(&gateway.url)).await;
    let (user, file) = text_file(&env, &gateway, "hello world").await;
    let edit = format!("capy-it-slow-recheck_{file}");
    let body = source_edit(
        &user,
        &file,
        &edit,
        serde_json::json!([{ "type": "replace_text", "expectedText": "world", "text": "there" }]),
    );
    let port = server.port;
    let first = {
        let body = body.clone();
        tokio::spawn(async move { internal(port, "/internal/documents/edit", &body).await })
    };
    tokio::time::sleep(Duration::from_millis(250)).await;
    let (status, again) = internal(port, "/internal/documents/edit", &body).await;
    let (first_status, receipt) = first.await.expect("first");
    assert_eq!((first_status, status), (200, 200), "{receipt} {again}");
    assert_eq!(again["operationId"], receipt["operationId"]);
    assert!(again.get("undoPayload").is_none(), "{again}");
}

/// Review r2 L1 (Q386): a fold drops an agent holds record it cannot read
/// once it reported it, so later folds read none. Fails if the record stays.
#[tokio::test]
async fn a_fold_drops_an_unreadable_agent_holds_record() {
    let Some(env) = env() else { return };
    let (server, logs) = start_logged(&env).await;
    let (_, room, mut writer) = writer(&env, server.port, "hello").await;
    let material = material_of(&room).to_owned();
    db(&env)
        .await
        .execute(
            "UPDATE material_yjs_documents SET agent_held='\\x09'::bytea WHERE material_id=$1",
            &[&material],
        )
        .await
        .expect("damaged agent holds");
    writer.type_text("!").await;
    writer.until(6).await.expect("ack");
    drop(writer);
    wait_unloaded(server.port).await;
    assert!(
        logs.has(&["captured error", "unreadable agent holds"])
            .await
    );
    let mut held: Option<Vec<u8>> = Some(Vec::new());
    for _ in 0..50 {
        held = db(&env)
            .await
            .query_one(
                "SELECT agent_held FROM material_yjs_documents WHERE material_id=$1",
                &[&material],
            )
            .await
            .expect("document")
            .get(0);
        if held.is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(held, None);
}
