//! `POST /drafts?room=<room>[&base=<sha>]`: one document's stored drafts from
//! a browser page with no editor open on it (the sweep in
//! `src/lib/editDrafts.ts`). The page sends the editor's own room token
//! (`Authorization: Bearer`) and the merged rows as one Yjs update. The
//! request runs a channel's JOIN checks and then the room's writer admission
//! (the room loads if need be and unloads when idle, as usual), so open
//! editors receive the update live, and the answer waits for the store that
//! holds it: that answer is the receipt for every row the request carried.
//! Refusals carry their class. There is no rate limit of its own: a socket
//! writer has none either, the token comes from the API's default class,
//! and a room runs one store at a time.

use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::oneshot;

use crate::app::Shared;
use crate::auth::{Access, Context, RoomName};
use crate::room::{self, Draft, Durable, NOTE_MAX_SYNC_BYTES, RoomCmd};

/// Why a draft send was not stored; the browser keeps the rows either way and
/// marks them refused (shown read-only at the next open) only for `Limit` and
/// `Malformed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// The rows grew from another lineage: a token for another room, a moved
    /// schema or epoch, another Office base.
    Lineage,
    /// Over a document limit (the content limits, a source's state cap).
    Limit,
    /// No write access: a bad, expired or read-only token, lost access.
    Permission,
    /// Not an update a writer may send (not Yjs, outside the document's
    /// parts, the server's markers).
    Malformed,
    /// Larger than a writer's sync message may be: sent by the editor.
    TooLarge,
    /// It needs content the room does not hold (a channel would resync).
    Unheld,
    /// The room or a lookup is busy or failing: try at the next trigger.
    Unavailable,
}

impl Class {
    pub fn as_str(self) -> &'static str {
        match self {
            Class::Lineage => "lineage",
            Class::Limit => "limit",
            Class::Permission => "permission",
            Class::Malformed => "malformed",
            Class::TooLarge => "too_large",
            Class::Unheld => "unheld",
            Class::Unavailable => "unavailable",
        }
    }

    fn status(self) -> StatusCode {
        match self {
            Class::Lineage | Class::Unheld => StatusCode::CONFLICT,
            Class::Limit => StatusCode::UNPROCESSABLE_ENTITY,
            Class::Permission => StatusCode::FORBIDDEN,
            Class::Malformed => StatusCode::BAD_REQUEST,
            Class::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Class::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}

/// A draft send the room or its checks refused.
#[derive(Debug)]
pub struct Refused {
    pub class: Class,
    pub message: String,
}

impl Refused {
    pub fn new(class: Class, message: impl Into<String>) -> Self {
        Refused {
            class,
            message: message.into(),
        }
    }
}

#[derive(Deserialize)]
pub struct Target {
    room: Option<String>,
    base: Option<String>,
}

/// The request's origin when the server allows it (the WebSocket rule).
fn allowed_origin(app: &Shared, headers: &HeaderMap) -> Option<HeaderValue> {
    let origin = headers.get(header::ORIGIN)?;
    let text = origin.to_str().ok()?;
    app.config
        .allowed_origins
        .contains(text)
        .then(|| origin.clone())
}

fn with_origin(mut response: Response, origin: HeaderValue) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.insert(header::VARY, HeaderValue::from_static("origin"));
    response
}

fn refused(refusal: &Refused) -> Response {
    (
        refusal.class.status(),
        [(header::CONTENT_TYPE, "application/json")],
        json!({ "class": refusal.class.as_str(), "message": refusal.message }).to_string(),
    )
        .into_response()
}

fn forbidden_origin() -> Response {
    (StatusCode::FORBIDDEN, "origin is not allowed").into_response()
}

/// The browser's preflight for the POST (it carries a token and a body).
pub async fn preflight(State(app): State<Shared>, headers: HeaderMap) -> Response {
    let Some(origin) = allowed_origin(&app, &headers) else {
        return forbidden_origin();
    };
    let response = (
        StatusCode::NO_CONTENT,
        [
            (header::ACCESS_CONTROL_ALLOW_METHODS, "POST"),
            (
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                "authorization, content-type",
            ),
        ],
    )
        .into_response();
    with_origin(response, origin)
}

pub async fn send(
    State(app): State<Shared>,
    Query(target): Query<Target>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let Some(origin) = allowed_origin(&app, &headers) else {
        return forbidden_origin();
    };
    let response = match stored(&app, target, &headers, body).await {
        Ok(room) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            json!({ "room": room, "type": "checkpoint-persisted" }).to_string(),
        )
            .into_response(),
        Err(refusal) => refused(&refusal),
    };
    with_origin(response, origin)
}

/// Checks the request as a writer's JOIN, reads the body within a writer's
/// sync message cap, and answers once the room stored the update.
async fn stored(
    app: &Shared,
    target: Target,
    headers: &HeaderMap,
    body: Body,
) -> Result<String, Refused> {
    let Some(room) = target.room else {
        return Err(Refused::new(Class::Malformed, "the room is required"));
    };
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| Refused::new(Class::Permission, "a room token is required"))?;
    let (name, context) = crate::socket::authenticate(app.clone(), room.clone(), token.to_owned())
        .await
        .map_err(|refusal| Refused::new(refusal.class, refusal.message))?;
    if context.access != Access::Write {
        return Err(Refused::new(Class::Permission, "the token is read-only"));
    }
    // A note's schema moves when its room is discarded; the room's load would
    // refuse the old one too, without saying why.
    if let RoomName::Material { material_id, .. } = &name {
        let current = crate::note_store::current_room(&app.db, material_id)
            .await
            .map_err(|error| Refused::new(Class::Unavailable, error.to_string()))?;
        if current.is_some_and(|current| current != room) {
            return Err(Refused::new(Class::Lineage, "the note's room moved on"));
        }
    }
    let cap = match name {
        RoomName::Material { .. } => NOTE_MAX_SYNC_BYTES,
        RoomName::Source { .. } => app.config.max_frame_bytes(),
    };
    let update = axum::body::to_bytes(body, cap)
        .await
        .map_err(|_| Refused::new(Class::TooLarge, "the drafts are larger than a sync message"))?;
    let durable = admitted(app, &name, &context, update, target.base).await?;
    match durable.await {
        Ok(Ok(())) => Ok(room),
        Ok(Err(error)) => Err(Refused::new(Class::Unavailable, error)),
        Err(_) => Err(Refused::new(
            Class::Unavailable,
            "collaboration room unloaded",
        )),
    }
}

/// Hands the draft to its room (loading it if need be) and waits for the
/// admission. A room that just unloaded drops the command: look up again once.
async fn admitted(
    app: &Shared,
    name: &RoomName,
    context: &Context,
    update: Bytes,
    base: Option<String>,
) -> Result<Durable, Refused> {
    for _ in 0..2 {
        let handle = app.rooms.get_or_spawn(&name.to_string(), |id| {
            room::spawn(app, name, id, &context.user_id)
        });
        let (reply, answer) = oneshot::channel();
        let command = RoomCmd::Draft(Box::new(Draft {
            context: context.clone(),
            update: update.clone(),
            base: base.clone(),
            reply,
        }));
        if handle.tx.send(command).await.is_err() {
            continue;
        }
        if let Ok(admission) = answer.await {
            return admission;
        }
    }
    Err(Refused::new(
        Class::Unavailable,
        "collaboration room unavailable",
    ))
}
