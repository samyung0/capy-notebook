//! The HTTP listener: the WebSocket upgrade (origin checked here), health,
//! a liveness probe, metrics and the internal routes (service secret) and the
//! browser's draft send (`drafts.rs`: origin and room token).

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use serde_json::{Value, json};

use crate::app::Shared;
use crate::auth::{self, RoomName};
use crate::health;
use crate::room::RoomCmd;

pub fn router(app: Shared) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(healthz))
        .route("/livez", get(livez))
        .route("/metrics", get(metrics))
        .route("/internal/materials/{id}/project", post(project))
        .route(
            "/internal/source-changes/resolve",
            post(resolve_source_change),
        )
        .route(
            "/internal/source-refresh/publish",
            post(publish_source_refresh),
        )
        .route("/internal/documents/inspect", post(document))
        .route("/internal/documents/edit", post(document))
        .route("/internal/documents/undo", post(document))
        .route("/internal/documents/undo-status", post(document))
        .route("/internal/commands", post(command))
        .route("/internal/markdown/convert", post(markdown))
        // Reads its own body within a writer's sync cap (`drafts.rs`).
        .route(
            "/drafts",
            post(crate::drafts::send).options(crate::drafts::preflight),
        )
        .route_layer(axum::middleware::from_fn(request_trace))
        // Internal bodies reach MAX_INTERNAL_BODY; each handler refuses past it.
        .layer(axum::extract::DefaultBodyLimit::max(MAX_INTERNAL_BODY + 1))
        .fallback(any(fallback))
        .with_state(app)
}

/// Runs a request with its caller's trace id on everything it captures
/// (`observe::request_hub`); the routes' error captures happen inside it.
async fn request_trace(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
    use sentry::SentryFutureExt;
    let hub = crate::observe::request_hub(
        request
            .headers()
            .get("traceparent")
            .and_then(|value| value.to_str().ok()),
    );
    next.run(request).bind_hub(hub).await
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        value.to_string(),
    )
        .into_response()
}

/// Any path upgrades to a WebSocket, as Hocuspocus listens; plain requests 404.
async fn fallback(
    State(app): State<Shared>,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let Ok(upgrade) = upgrade else {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "text/plain")],
            "Not found",
        )
            .into_response();
    };
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if !origin.is_some_and(|origin| app.config.allowed_origins.contains(origin)) {
        return (StatusCode::FORBIDDEN, "origin is not allowed").into_response();
    }
    let max = app.config.max_frame_bytes();
    upgrade
        .read_buffer_size(READ_BUFFER)
        .max_message_size(max)
        .max_frame_size(max)
        .on_upgrade(move |socket| crate::socket::serve(app, socket))
}

/// Each socket's read buffer, allocated when it opens (tungstenite's default
/// is 128 KiB: 1.5 GiB for 10,000 idle sockets in the production capacity
/// run). Presence and keystroke frames are a few hundred bytes; a larger
/// frame reserves its own length and is read 8 KiB at a time. The write side
/// allocates nothing up front, and each send flushes, so it holds one frame,
/// and gives a large one's room back once written (the vendored tungstenite,
/// `third_party/tungstenite`).
const READ_BUFFER: usize = 8 * 1024;

async fn healthz(State(app): State<Shared>) -> Response {
    let release = std::env::var("RELEASE_SHA").unwrap_or_default();
    let db = match app.db.get().await {
        Ok(client) => client.query_one("SELECT 1", &[]).await.is_ok(),
        Err(_) => false,
    };
    let mut redis = app.redis.clone();
    let redis_ok = redis::cmd("PING")
        .query_async::<String>(&mut redis)
        .await
        .is_ok();
    let (status, body) = if db && redis_ok {
        (StatusCode::OK, json!({ "status": "ok" }))
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "status": "unavailable" }),
        )
    };
    let mut response = json_response(status, body);
    if let Ok(value) = release.parse() {
        response.headers_mut().insert("x-capy-release", value);
    }
    response
}

/// Liveness for probes from outside: answered by the event loop alone, with
/// nothing about the server in it.
async fn livez() -> &'static str {
    "ok"
}

/// The counters are the service's own (service secret): the collaboration host
/// is public for WebSockets.
async fn metrics(State(app): State<Shared>, headers: HeaderMap) -> Response {
    if !authorized(&app, &headers) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "message": "Unauthorized" }),
        );
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        health::metrics(&app).await,
    )
        .into_response()
}

fn authorized(app: &Shared, headers: &HeaderMap) -> bool {
    let provided = headers
        .get("x-collaboration-secret")
        .and_then(|value| value.to_str().ok());
    auth::secret_matches(provided, &app.config.secret)
}

/// The largest internal command body (two documents and their envelope).
pub const MAX_INTERNAL_BODY: usize = 2 * 2 * 1024 * 1024 + 1024 * 1024;

/// An internal route's JSON object body, or the 400 that answers it.
fn json_object(body: &[u8], invalid: &str) -> Result<Value, Box<Response>> {
    let refused = || {
        Box::new(json_response(
            StatusCode::BAD_REQUEST,
            json!({ "message": invalid }),
        ))
    };
    if body.len() > MAX_INTERNAL_BODY {
        return Err(refused());
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(value) if value.is_object() => Ok(value),
        _ => Err(refused()),
    }
}

/// A source operation's answer: its value, or the gateway's status (5xx
/// reported) with the message.
fn source_answer(stage: &str, result: Result<Value, sources::SourceError>) -> Response {
    match result {
        Ok(value) => json_response(StatusCode::OK, value),
        Err(error) => {
            let status = error
                .status()
                .and_then(|status| StatusCode::from_u16(status).ok())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            if status.is_server_error() {
                crate::observe::capture(&error.to_string(), None, &[("stage", stage)]);
            }
            json_response(status, json!({ "message": error.to_string() }))
        }
    }
}

/// `fileId`, `epoch` and `checkpoint` every source route names.
fn source_checkpoint(input: &Value) -> bool {
    input["fileId"].is_string() && input["epoch"].is_u64() && input["checkpoint"].is_u64()
}

/// The image of a pending effect, for the API's change review.
async fn resolve_source_change(
    State(app): State<Shared>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !authorized(&app, &headers) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "message": "Unauthorized" }),
        );
    }
    let input = match json_object(&body, "Invalid source request") {
        Ok(input) => input,
        Err(response) => return *response,
    };
    if !source_checkpoint(&input) {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "message": "Invalid source checkpoint" }),
        );
    }
    let Ok(input) = serde_json::from_value::<sources::store::ResolveInput>(input) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "message": "Invalid source image request" }),
        );
    };
    let result = app
        .sources
        .resolve(&input)
        .await
        .map(|asset| serde_json::to_value(asset).unwrap_or(Value::Null));
    source_answer("source_resolve", result)
}

/// A finalized candidate's publication (the handoff).
async fn publish_source_refresh(
    State(app): State<Shared>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !authorized(&app, &headers) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "message": "Unauthorized" }),
        );
    }
    let input = match json_object(&body, "Invalid source request") {
        Ok(input) => input,
        Err(response) => return *response,
    };
    if !source_checkpoint(&input) {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "message": "Invalid source checkpoint" }),
        );
    }
    if !(input["jobId"].is_string()
        && input["leaseToken"].is_string()
        && input["attemptId"].is_i64())
    {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "message": "Invalid source publication" }),
        );
    }
    let result = crate::source_rooms::publish(&app, input).await;
    source_answer("source_publish", result)
}

/// `/internal/documents/{inspect,edit,undo,undo-status}`: direct AI edits
/// (`edits.rs`).
async fn document(
    State(app): State<Shared>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !authorized(&app, &headers) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "message": "invalid service secret" }),
        );
    }
    if body.len() > MAX_INTERNAL_BODY {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "code": "invalid_input", "message": "command body is too large" }),
        );
    }
    match crate::edits::document(&app, uri.path(), &body).await {
        Ok(value) => json_response(StatusCode::OK, value),
        Err(error) => {
            let (status, body) = error.status_and_body();
            if let crate::edits::DocumentError::Unavailable(reason) = error {
                return unavailable(uri.path(), reason, body);
            }
            if status >= 500 {
                crate::observe::capture(error.message(), None, &[("stage", "document_request")]);
            }
            let status = StatusCode::from_u16(status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE);
            json_response(status, body)
        }
    }
}

/// An edit refused because its room is being reset or compacted: refused
/// before anything applied, so the caller may retry. An expected outcome,
/// logged and not reported.
fn unavailable(route: &str, reason: &str, body: Value) -> Response {
    crate::observe::log(
        crate::observe::Level::Info,
        "edit refused: room unavailable",
        json!({ "route": route, "reason": reason }),
    );
    json_response(StatusCode::SERVICE_UNAVAILABLE, body)
}

/// `/internal/commands`: the replace-block command.
async fn command(State(app): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&app, &headers) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "message": "invalid service secret" }),
        );
    }
    let command = match json_object(&body, "invalid collaboration command") {
        Ok(command) => command,
        Err(response) => return *response,
    };
    match crate::edits::replace_block(&app, command).await {
        Ok(()) => json_response(StatusCode::OK, json!({ "status": "applied" })),
        Err(message) if message.starts_with("invalid collaboration command") => {
            json_response(StatusCode::BAD_REQUEST, json!({ "message": message }))
        }
        Err(message)
            if message == crate::edits::ROOM_RESET || message == crate::edits::ROOM_COMPACTING =>
        {
            unavailable(
                "/internal/commands",
                &message,
                json!({ "code": "unavailable_target", "message": message }),
            )
        }
        Err(message) => {
            let conflict = message.contains("concurrently") || message.contains("no longer exists");
            if !conflict {
                crate::observe::capture(&message, None, &[("stage", "service_command")]);
            }
            let status = if conflict {
                StatusCode::CONFLICT
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            };
            json_response(status, json!({ "message": message }))
        }
    }
}

/// `/internal/markdown/convert`: agent markdown through the editor's own
/// import in V8. A refusal (a fence that does not parse, a limit) fails the
/// agent's edit as is, never retried (Epo 2026-10-07).
async fn markdown(State(app): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&app, &headers) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "message": "invalid service secret" }),
        );
    }
    let invalid = |message: &str| {
        json_response(
            StatusCode::BAD_REQUEST,
            json!({ "code": "invalid_input", "message": message }),
        )
    };
    let Ok(request) = serde_json::from_slice::<Value>(&body) else {
        return invalid("invalid JSON");
    };
    let Some(source) = request["markdown"].as_str().map(str::to_owned) else {
        return invalid("markdown is required");
    };
    let converting = app.clone();
    let converted = tokio::task::spawn_blocking(move || {
        converting
            .markdown
            .as_ref()
            .map(|converter| converter.convert(&source))
    })
    .await;
    match converted {
        Ok(Some(Ok(converted))) => json_response(
            StatusCode::OK,
            serde_json::to_value(converted).unwrap_or(Value::Null),
        ),
        Ok(Some(Err(error))) => invalid(&error.to_string()),
        Ok(None) => json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "message": "markdown conversion is not configured" }),
        ),
        Err(error) => {
            crate::observe::capture(&error.to_string(), None, &[("stage", "markdown_convert")]);
            json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "message": "markdown conversion failed" }),
            )
        }
    }
}

/// On-demand projection (DESIGN.md 5): a room loaded here persists and
/// projects; otherwise the durable rows project. Answers once
/// `materials.content` holds the stored version.
async fn project(
    State(app): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
    _body: Bytes,
) -> Response {
    if !authorized(&app, &headers) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "message": "invalid service secret" }),
        );
    }
    if RoomName::parse(&format!("material:{id}:schema:1")).is_none() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "message": "invalid material id" }),
        );
    }
    let names = app.rooms.names();
    let loaded = |prefix: String| {
        names
            .iter()
            .find(|room| room.starts_with(&prefix))
            .and_then(|room| app.rooms.get(room))
    };
    // A quiz's keys room stores first, so the projection reads both
    // documents' edits (live-items).
    let keys = loaded(format!("keys:{id}:"));
    if let Some(keys) = &keys {
        let (reply, answer) = tokio::sync::oneshot::channel();
        if keys.tx.send(RoomCmd::Persist(reply)).await.is_ok()
            && let Ok(Err(message)) = answer.await
        {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "message": message }),
            );
        }
    }
    // A room no instance has loaded here projected when it unloaded (or the
    // pending scan does): nothing to do.
    let Some(handle) = loaded(format!("material:{id}:")).or(keys) else {
        return json_response(StatusCode::OK, json!({ "projected": false }));
    };
    let (reply, answer) = tokio::sync::oneshot::channel();
    if handle.tx.send(RoomCmd::Project(reply)).await.is_err() {
        return json_response(StatusCode::OK, json!({ "projected": false }));
    }
    let result = answer.await.unwrap_or_else(|_| Err("room unloaded".into()));
    match result {
        Ok(version) => json_response(
            StatusCode::OK,
            json!({ "projected": true, "yjsVersion": version }),
        ),
        Err(message) => json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "message": message }),
        ),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    use super::*;

    /// An internal route's captures carry the caller's `traceparent` trace.
    #[test]
    fn a_routes_captures_carry_the_callers_trace() {
        let trace = "cd".repeat(16);
        let events = sentry::test::with_captured_events(|| {
            let router: Router = Router::new()
                .route(
                    "/internal/x",
                    post(|| async {
                        crate::observe::capture("in a request", None, &[]);
                        "ok"
                    }),
                )
                .route_layer(axum::middleware::from_fn(request_trace));
            let request = Request::post("/internal/x")
                .header("traceparent", format!("00-{trace}-{}-01", "e".repeat(16)))
                .body(Body::empty())
                .unwrap();
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(router.oneshot(request))
                .unwrap();
        });
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tags.get("trace_id"), Some(&trace));
    }

    /// An app whose database, Redis and gateway are never reached (lazy
    /// connections), for requests answered by their checks alone.
    pub(crate) fn offline_app() -> Shared {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let disk = std::env::temp_dir().join(format!(
            "capy-offline-app-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let config = crate::config::Config::load(
            &[
                ("COLLABORATION_ENGINE_SAVE_PROCESSES", "1"),
                ("COLLABORATION_ENGINE_BACKGROUND_PROCESSES", "1"),
                ("COLLABORATION_ENGINE_MEMORY_LIMIT_BYTES", "1"),
                ("COLLABORATION_SOURCE_DISK_DIR", disk.to_str().unwrap()),
                ("COLLABORATION_SOURCE_DISK_BYTES", "1"),
            ]
            .map(|(key, value)| (key.to_owned(), value.to_owned()))
            .into(),
        )
        .unwrap();
        let pg: tokio_postgres::Config = config.database_url.parse().unwrap();
        let db = deadpool_postgres::Pool::builder(deadpool_postgres::Manager::new(
            pg,
            tokio_postgres::NoTls,
        ))
        .runtime(deadpool_postgres::Runtime::Tokio1)
        .build()
        .unwrap();
        let redis_client = redis::Client::open(config.redis_url.as_str()).unwrap();
        let redis = redis::aio::ConnectionManager::new_lazy_with_config(
            redis_client.clone(),
            Default::default(),
        )
        .unwrap();
        let http = reqwest::Client::new();
        let sources = std::sync::Arc::new(
            sources::Sources::new(
                sources::SourcesConfig {
                    api_url: config.api_url.clone(),
                    secret: config.secret.clone(),
                    engine: sources::engine::PoolConfig {
                        program: "unused".into(),
                        args: Vec::new(),
                        save_processes: 1,
                        background_processes: 1,
                        call_timeout: sources::engine::CALL_TIMEOUT,
                        replica_budget_bytes: 0,
                        memory_limit_bytes: None,
                    },
                    disk_dir: config.source_disk_dir.clone(),
                    disk_bytes: config.source_disk_bytes,
                },
                db.clone(),
                http.clone(),
            )
            .unwrap(),
        );
        std::sync::Arc::new(crate::app::App {
            instance_id: "test".into(),
            config,
            db,
            redis,
            redis_client,
            http,
            rooms: Default::default(),
            evictions: Default::default(),
            stats: Default::default(),
            health: Default::default(),
            unplaced: Default::default(),
            projection_failures: Default::default(),
            projection_refused: Default::default(),
            pubsub: Default::default(),
            next_connection: Default::default(),
            next_channel: Default::default(),
            sources,
            handoff: Default::default(),
            source_joins: Default::default(),
            markdown: None,
            agent_steps: Default::default(),
        })
    }

    /// A room being reset (a discard, a rejected lineage) refuses an agent
    /// edit and the replace-block command before anything applies: a 503
    /// whose outcome is known (`unavailable_target` for an edit), so the
    /// caller may retry, and no Sentry event. Fails if either refusal is
    /// reported or the edit answers `outcome_unknown`.
    #[test]
    fn a_room_being_reset_refuses_edits_without_a_report() {
        let room = "material:m1:schema:1";
        let edit = json!({
            "actorUserId": "u1",
            "commands": [],
            "operation": { "id": "op1", "requestHash": "h1" },
            "room": room,
            "target": { "id": "m1", "kind": "material" },
        });
        let command = json!({
            "type": "replace-block",
            "actorUserId": "u1",
            "materialId": "m1",
            "room": room,
            "expectedBlock": {},
            "replacementBlock": {},
        });
        let mut answers = Vec::new();
        let events = sentry::test::with_captured_events(|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let app = offline_app();
                app.evictions.reject(room);
                let secret = app.config.secret.clone();
                for (path, body) in [
                    ("/internal/documents/edit", &edit),
                    ("/internal/commands", &command),
                ] {
                    let request = Request::post(path)
                        .header("x-collaboration-secret", &secret)
                        .body(Body::from(body.to_string()))
                        .unwrap();
                    let response = router(app.clone()).oneshot(request).await.unwrap();
                    let status = response.status();
                    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                        .await
                        .unwrap();
                    answers.push((status, serde_json::from_slice::<Value>(&bytes).unwrap()));
                }
                let _ = std::fs::remove_dir_all(&app.config.source_disk_dir);
            });
        });
        assert_eq!(events.len(), 0, "{events:?}");
        let [(edit_status, edit_body), (command_status, command_body)] = answers.as_slice() else {
            panic!("{answers:?}");
        };
        assert_eq!(*edit_status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            *edit_body,
            json!({ "code": "unavailable_target", "message": crate::edits::ROOM_RESET })
        );
        assert_eq!(*command_status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(*command_body, *edit_body);
    }

    /// Sockets read through 8 KiB (REVIEW5 final N4): the upgrade sets the
    /// buffer, so an idle connection costs about the runbook's 30 KiB, not
    /// tungstenite's default 128 KiB on top.
    #[test]
    fn sockets_read_through_an_8_kib_buffer() {
        assert_eq!(super::READ_BUFFER, 8 * 1024);
        let source = include_str!("http.rs");
        let code = &source[..source.find("#[cfg(test)]").unwrap()];
        assert!(code.contains(".read_buffer_size(READ_BUFFER)"));
    }
}
