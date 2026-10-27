//! `POST /drafts`: one document's stored drafts from a browser page with no
//! editor open on it (the sweep in `src/lib/editDrafts.ts`). The page sends
//! the editor's own room token (`Authorization: Bearer`), the room its rows
//! grew from (`X-Capy-Room`), its client protocol (`X-Capy-Protocol`, the
//! JOIN's) and, for a source, their base (`X-Capy-Base`), the stored version
//! their oldest row was made at (`X-Capy-Version`, in-place collection), and
//! the merged rows as one Yjs update; the URL is the same for every
//! document, so one preflight covers a sweep. The request counts against the
//! user's draft sends (60 a minute, `rate.rs`, Q360) once its token checks
//! out, runs a channel's JOIN checks (refused while the user is in a timeout,
//! before any lookup), reads the body within `ydoc::MAX_UPDATE_BYTES` (a
//! larger one is too large, which the page leaves to the editor, and times
//! the user out) and a note's sync cap, checks a source room's eviction
//! lease again, and goes to the room. There a group the room holds in full
//! is a no-op (Q321); any other is taken from the user's update allowance
//! (the one their sockets take from) and goes through the room's writer
//! admission (the room loads if need be and unloads when idle, as usual),
//! so open editors receive the update live. Either answer waits for the
//! store that holds it and is the receipt for every row the request
//! carried. The page sends a large group as pieces of at most 2 MiB, one
//! request each, in order. A refusal answers its class alone (a timeout
//! also the time it has left, `remainingMs`); its detail is logged and
//! counted by class.

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures::StreamExt;
use serde_json::json;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

use crate::app::Shared;
use crate::auth::{Access, Context, RoomName};
use crate::observe::{Level, log};
use crate::rate::Verdict;
use crate::room::{self, Draft, Durable, NOTE_MAX_SYNC_BYTES, RoomCmd};

/// The room the drafts grew from, a source's base, the client's protocol.
const ROOM_HEADER: &str = "x-capy-room";
const BASE_HEADER: &str = "x-capy-base";
const PROTOCOL_HEADER: &str = "x-capy-protocol";
/// The drafts' stored collaboration tokens, comma-separated (Q288): each may
/// re-grant the client ids it offered under the reconnect rule.
const GRANTS_HEADER: &str = "x-capy-grants";
/// The stored version the group's oldest row was made at (`sessions.rs`).
const VERSION_HEADER: &str = "x-capy-version";
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
    /// The rows grew from a state older than the room's collection window:
    /// they may name units it collected, so they wait for the editor, which
    /// merges them (the late path, `Room::late`).
    Late,
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
    /// Structs under a client id not assigned to the sender's user: the
    /// editor re-applies them under its own id (Epo 2026-10-24).
    Unassigned,
    /// A note's typing into a block the room deleted, which the room would
    /// never show (Q237): held for the editor, whose join shows it for
    /// review.
    Hidden,
    /// The room or a lookup is busy or failing: try at a later page load.
    Unavailable,
    /// The page's client protocol is outside its room family's (a stale
    /// tab): nothing more goes until the page reloads.
    Outdated,
    /// The user is in a timeout (over their update allowance, or sending an
    /// update over the cap): tried again at the sweep's next trigger.
    TooFast,
}

impl Class {
    pub const ALL: [Class; 12] = [
        Class::Lineage,
        Class::Late,
        Class::Limit,
        Class::Permission,
        Class::Malformed,
        Class::TooLarge,
        Class::Unheld,
        Class::Unassigned,
        Class::Hidden,
        Class::Unavailable,
        Class::Outdated,
        Class::TooFast,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Class::Lineage => "lineage",
            Class::Late => "late",
            Class::Limit => "limit",
            Class::Permission => "permission",
            Class::Malformed => "malformed",
            Class::TooLarge => "too_large",
            Class::Unheld => "unheld",
            Class::Unassigned => "unassigned",
            Class::Hidden => "hidden",
            Class::Unavailable => "unavailable",
            Class::Outdated => "outdated",
            Class::TooFast => "too_fast",
        }
    }

    fn status(self) -> StatusCode {
        match self {
            Class::Lineage | Class::Late | Class::Unheld | Class::Unassigned | Class::Hidden => {
                StatusCode::CONFLICT
            }
            Class::Limit => StatusCode::UNPROCESSABLE_ENTITY,
            Class::Permission => StatusCode::FORBIDDEN,
            Class::Malformed => StatusCode::BAD_REQUEST,
            Class::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Class::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            Class::Outdated => StatusCode::UPGRADE_REQUIRED,
            Class::TooFast => StatusCode::TOO_MANY_REQUESTS,
        }
    }
}

/// A draft send the room or its checks refused. `message` stays on the
/// server (the log); the browser hears the class.
#[derive(Debug)]
pub struct Refused {
    pub class: Class,
    pub message: String,
    /// A timeout's time left, which the answer carries.
    pub remaining: Option<Duration>,
}

impl Refused {
    pub fn new(class: Class, message: impl Into<String>) -> Self {
        Refused {
            class,
            message: message.into(),
            remaining: None,
        }
    }

    /// The user is in a timeout; `started` when this send began it.
    pub(crate) fn timed_out(app: &Shared, user: &str, verdict: Verdict) -> Option<Self> {
        let Verdict::TimedOut { remaining, started } = verdict else {
            return None;
        };
        if started {
            app.stats.timeouts.fetch_add(1, Ordering::Relaxed);
        }
        Some(Refused {
            remaining: Some(remaining),
            ..Refused::new(Class::TooFast, format!("{user} is in a timeout"))
        })
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
    let mut body = json!({ "class": refusal.class.as_str() });
    if let Some(remaining) = refusal.remaining {
        body["remainingMs"] = json!(remaining.as_micros().div_ceil(1000) as u64);
    }
    (
        refusal.class.status(),
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

/// The body, or none when it is longer than `cap`.
async fn read_within(body: Body, cap: usize) -> Result<Option<Bytes>, Refused> {
    let mut stream = body.into_data_stream();
    let mut read = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| Refused::new(Class::Malformed, format!("body: {error}")))?;
        if read.len() + chunk.len() > cap {
            return Ok(None);
        }
        read.extend_from_slice(&chunk);
    }
    Ok(Some(read.into()))
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
                "authorization, content-type, x-capy-room, x-capy-base, x-capy-protocol, x-capy-grants, x-capy-version",
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
    // The user's draft sends, counted before any lookup (Q360); a bad token
    // is refused below as for a JOIN.
    if let Ok(claims) =
        crate::auth::verify(token, &app.config.secret, room, crate::auth::now_seconds())
        && !app.allowances.take_draft(&claims.sub, Instant::now())
    {
        return Err(Refused::new(
            Class::TooFast,
            format!(
                "{} sent {} drafts this minute",
                claims.sub,
                crate::rate::DRAFT_REQUESTS
            ),
        ));
    }
    let (name, context) =
        crate::socket::authenticate(app.clone(), room.to_owned(), token.to_owned(), protocol)
            .await
            .map_err(|refusal| Refused {
                remaining: refusal.remaining,
                ..Refused::new(refusal.class, refusal.message)
            })?;
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
    let user = &context.user_id;
    // Never sendable as it is: too large, which the page leaves for the
    // editor to send in pieces, and the user is timed out as for any update
    // over the cap.
    let Some(update) = read_within(body, ydoc::MAX_UPDATE_BYTES).await? else {
        if let Verdict::TimedOut { started: true, .. } =
            app.allowances.time_out(user, Instant::now())
        {
            app.stats.timeouts.fetch_add(1, Ordering::Relaxed);
        }
        return Err(Refused::new(Class::TooLarge, "over the update cap"));
    };
    if matches!(name, RoomName::Material { .. }) && update.len() > NOTE_MAX_SYNC_BYTES {
        return Err(Refused::new(Class::TooLarge, "past the writer's sync cap"));
    }
    // A source room's publication lease and a local reset may have begun
    // while the body arrived: a JOIN joins at once after its checks, a send
    // only now (REVIEW1 S2).
    let evicting = matches!(name, RoomName::Source { .. })
        && crate::socket::room_evicting(app, room)
            .await
            .map_err(|error| Refused::new(Class::Unavailable, error))?;
    if evicting || app.evictions.blocks(room, false) {
        return Err(Refused::new(
            Class::Unavailable,
            "the room is being reset or published",
        ));
    }
    let base = header_text(headers, BASE_HEADER).map(str::to_owned);
    // Ids the drafts' own tokens offered: the room checks each under the
    // JOIN's rule (Q288). A token that grants nothing is ignored.
    let now = crate::auth::now_seconds();
    let granted = header_text(headers, GRANTS_HEADER)
        .map(|header| crate::auth::granted_by(header, &app.config.secret, room, user, now))
        .unwrap_or_default();
    // An unreadable version is refused, not taken as none (review r2 N2), and
    // so is a missing or zero one: a group always holds an edit, made at
    // version 1 or later, and 0 (a new tab's) is never late (audit N1).
    let version = header_text(headers, VERSION_HEADER)
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|&version| version > 0)
        .ok_or_else(|| {
            Refused::new(
                Class::Malformed,
                "the drafts' version is missing or not a stored version",
            )
        })?;
    let durable = admitted(app, &name, &context, update, base, granted, version).await?;
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
    granted: Vec<u64>,
    version: u64,
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
            granted: granted.clone(),
            version,
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
