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
use crate::room::RoomCmd;
use crate::{health, projection};

pub fn router(app: Shared) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(healthz))
        .route("/metrics", get(metrics))
        .route("/internal/materials/{id}/project", post(project))
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
    let result = match loaded.and_then(|room| app.rooms.get(&room)) {
        Some(handle) => {
            let (reply, answer) = tokio::sync::oneshot::channel();
            if handle.tx.send(RoomCmd::Project(reply)).await.is_err() {
                projection::project_durable(&app, &id).await
            } else {
                answer.await.unwrap_or_else(|_| Err("room unloaded".into()))
            }
        }
        None => projection::project_durable(&app, &id).await,
    };
    match result {
        Ok(version) => json_response(StatusCode::OK, json!({ "yjsVersion": version })),
        Err(message) => json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "message": message }),
        ),
    }
}
