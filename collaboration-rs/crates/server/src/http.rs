//! The HTTP listener: the WebSocket upgrade (origin checked here), health,
//! metrics and the internal routes (service secret).

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
        .fallback(any(fallback))
        .with_state(app)
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
        .max_message_size(max)
        .max_frame_size(max)
        .on_upgrade(move |socket| crate::socket::serve(app, socket))
}

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

async fn metrics(State(app): State<Shared>) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        health::metrics(&app),
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
    let prefix = format!("material:{id}:");
    let loaded = app
        .rooms
        .names()
        .into_iter()
        .find(|room| room.starts_with(&prefix));
    // A room no instance has loaded here projected when it unloaded (or the
    // pending scan does): nothing to do.
    let Some(handle) = loaded.and_then(|room| app.rooms.get(&room)) else {
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
