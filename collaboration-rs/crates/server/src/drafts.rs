//! `POST /drafts`: one document's stored drafts from a browser page with no
//! editor open on it (the sweep in `src/lib/editDrafts.ts`). The page sends
//! the editor's own room token (`Authorization: Bearer`), the room its rows
//! grew from (`X-Capy-Room`), its client protocol (`X-Capy-Protocol`, the
//! JOIN's) and, for a source, their base (`X-Capy-Base`), and the merged rows
//! as one Yjs update; the URL is the same for every
//! document, so one preflight covers a sweep. The request runs a channel's
//! JOIN checks, reads the body within a writer's sync cap, checks the
//! eviction lease again, and goes through the room's writer admission (the
//! room loads if need be and unloads when idle, as usual), so open editors
//! receive the update live; the answer waits for the store that holds it and
//! is the receipt for every row the request carried. A refusal answers its
//! class alone; its detail is logged and counted by class. There is no rate
//! limit of its own: a socket writer has none either, the token comes from
//! the API's default class, and a room runs one store at a time.

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::sync::atomic::Ordering;
use tokio::sync::oneshot;

use crate::app::Shared;
use crate::auth::{Access, Context, RoomName};
use crate::observe::{Level, log};
use crate::room::{self, Draft, Durable, NOTE_MAX_SYNC_BYTES, RoomCmd};

/// The room the drafts grew from, a source's base, the client's protocol.
const ROOM_HEADER: &str = "x-capy-room";
const BASE_HEADER: &str = "x-capy-base";
const PROTOCOL_HEADER: &str = "x-capy-protocol";
/// How long a browser keeps the preflight's answer (Chromium caps it at 2 h).
const PREFLIGHT_MAX_AGE: &str = "7200";

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
    /// No write access: a bad, expired or read-only token, lost access, an
    /// origin the server does not serve.
    Permission,
    /// Not an update a writer may send (not Yjs, outside the document's
    /// parts, the server's markers).
    Malformed,
    /// Larger than a writer's sync message may be: sent by the editor.
    TooLarge,
    /// It needs content the room does not hold (a channel would resync).
    Unheld,
    /// The room or a lookup is busy or failing: try at a later page load.
    Unavailable,
    /// The page's client protocol is outside its room family's (a stale
    /// tab): nothing more goes until the page reloads.
    Outdated,
}

impl Class {
    pub const ALL: [Class; 8] = [
        Class::Lineage,
        Class::Limit,
        Class::Permission,
        Class::Malformed,
        Class::TooLarge,
        Class::Unheld,
        Class::Unavailable,
        Class::Outdated,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Class::Lineage => "lineage",
            Class::Limit => "limit",
            Class::Permission => "permission",
            Class::Malformed => "malformed",
            Class::TooLarge => "too_large",
            Class::Unheld => "unheld",
            Class::Unavailable => "unavailable",
            Class::Outdated => "outdated",
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
            Class::Outdated => StatusCode::UPGRADE_REQUIRED,
        }
    }
}

/// A draft send the room or its checks refused. `message` stays on the
/// server (the log); the browser hears the class.
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

/// Logs and counts a refusal; the answer names its class alone.
fn refused(app: &Shared, room: Option<&str>, refusal: &Refused) -> Response {
    app.stats.draft_refusals[refusal.class as usize].fetch_add(1, Ordering::Relaxed);
    log(
        Level::Warn,
        "draft send refused",
        json!({ "class": refusal.class.as_str(), "error": refusal.message, "room": room }),
    );
    (
        refusal.class.status(),
        [(header::CONTENT_TYPE, "application/json")],
        json!({ "class": refusal.class.as_str() }).to_string(),
    )
        .into_response()
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// The browser's preflight for the POST (it carries a token, the room and a
/// body).
pub async fn preflight(State(app): State<Shared>, headers: HeaderMap) -> Response {
    let Some(origin) = allowed_origin(&app, &headers) else {
        return (StatusCode::FORBIDDEN, "origin is not allowed").into_response();
    };
    let response = (
        StatusCode::NO_CONTENT,
        [
            (header::ACCESS_CONTROL_ALLOW_METHODS, "POST"),
            (
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                "authorization, content-type, x-capy-room, x-capy-base, x-capy-protocol",
            ),
            (header::ACCESS_CONTROL_MAX_AGE, PREFLIGHT_MAX_AGE),
        ],
    )
        .into_response();
    with_origin(response, origin)
}

pub async fn send(State(app): State<Shared>, headers: HeaderMap, body: Body) -> Response {
    let room = header_text(&headers, ROOM_HEADER).map(str::to_owned);
    let Some(origin) = allowed_origin(&app, &headers) else {
        let refusal = Refused::new(Class::Permission, "origin is not allowed");
        return refused(&app, room.as_deref(), &refusal);
    };
    let response = match stored(&app, room.as_deref(), &headers, body).await {
        Ok(()) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            json!({ "room": room, "type": "checkpoint-persisted" }).to_string(),
        )
            .into_response(),
        Err(refusal) => refused(&app, room.as_deref(), &refusal),
    };
    with_origin(response, origin)
}

/// Checks the request as a writer's JOIN, reads the body within a writer's
/// sync message cap, and answers once the room stored the update. A source
/// send counts as joining its room meanwhile, so a rebuild waits for it.
async fn stored(
    app: &Shared,
    room: Option<&str>,
    headers: &HeaderMap,
    body: Body,
) -> Result<(), Refused> {
    let Some(room) = room else {
        return Err(Refused::new(Class::Malformed, "the room is required"));
    };
    let joining = room.starts_with("source:").then(|| {
        let key = (app.next_connection.fetch_add(1, Ordering::Relaxed), 0);
        crate::source_rooms::start_join(app, key, room);
        key
    });
    let result = checked_and_stored(app, room, headers, body).await;
    if let Some(key) = joining {
        crate::source_rooms::end_join(app, key);
    }
    result
}

async fn checked_and_stored(
    app: &Shared,
    room: &str,
    headers: &HeaderMap,
    body: Body,
) -> Result<(), Refused> {
    let token = header_text(headers, header::AUTHORIZATION.as_str())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| Refused::new(Class::Permission, "a room token is required"))?;
    let protocol = header_text(headers, PROTOCOL_HEADER).and_then(|value| value.parse().ok());
    let (name, context) =
        crate::socket::authenticate(app.clone(), room.to_owned(), token.to_owned(), protocol)
            .await
            .map_err(|refusal| Refused::new(refusal.class, refusal.message))?;
    if context.access != Access::Write {
        return Err(Refused::new(Class::Permission, "the token is read-only"));
    }
    // A note's schema moves when its room is discarded; the room's load would
    // refuse the old one too, without saying why. A quiz's keys room shares
    // its material's schema.
    if let RoomName::Material {
        material_id,
        schema,
        ..
    } = &name
    {
        let current = crate::note_store::current_room(&app.db, material_id)
            .await
            .map_err(|error| Refused::new(Class::Unavailable, error.to_string()))?
            .and_then(|current| RoomName::parse(&current))
            .map(|current| current.number());
        if current.is_some_and(|current| current != *schema) {
            return Err(Refused::new(Class::Lineage, "the note's room moved on"));
        }
    }
    let cap = match name {
        RoomName::Material { .. } => NOTE_MAX_SYNC_BYTES,
        RoomName::Source { .. } => app.config.max_frame_bytes(),
    };
    let update = axum::body::to_bytes(body, cap)
        .await
        .map_err(|_| Refused::new(Class::TooLarge, "past the writer's sync cap"))?;
    // The lease and a local reset may have begun while the body arrived: a
    // JOIN joins at once after its checks, a send only now (REVIEW1 S2).
    let evicting = crate::socket::room_evicting(app, room)
        .await
        .map_err(|error| Refused::new(Class::Unavailable, error))?;
    if evicting || app.evictions.blocks(room, false) {
        return Err(Refused::new(
            Class::Unavailable,
            "the room is being reset, compacted or published",
        ));
    }
    let base = header_text(headers, BASE_HEADER).map(str::to_owned);
    let durable = admitted(app, &name, &context, update, base).await?;
    match durable.await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(Refused::new(Class::Unavailable, error)),
        Err(_) => Err(Refused::new(
            Class::Unavailable,
            "collaboration room unloaded",
        )),
    }
}

/// Hands the draft to its room (loading it if need be) and waits for the
/// admission. A room that unloaded before taking it drops the command: look
/// up again once. A room whose load failed answers the failure.
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
