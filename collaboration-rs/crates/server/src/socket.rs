//! One task per WebSocket (DESIGN.md 1.3, 4): channels authenticate on their
//! own (JOIN runs every `onAuthenticate` check, which a draft send runs too),
//! their messages queue until JOINED and then go to the room in order; a
//! writer's access is rechecked at most every 5 s before its updates go on;
//! tokens refresh in band. A user over their allowance (`rate.rs`), or
//! sending an update over `ydoc::MAX_UPDATE_BYTES`, is in a timeout: their
//! SYNC, awareness, query and stateless messages are dropped on every socket
//! until it ends, and each joined channel of theirs hears it (on join too)
//! with only the time left (`update-timeout`); their editors pause, then
//! join again on the same socket and resync. A JOIN costs one message of the
//! allowance. A large step 1 answer or an awareness query waits in its room
//! while its user's open budget is spent (`room.rs`). A socket must join a room within
//! [JOIN_DEADLINE]; a client address holds a capped number of sockets, and a
//! user's join past their cap closes their oldest joined channel
//! (`seats.rs`). An embedded quiz's or set's channel joins inside its note's
//! channel on the same socket (Epo 2026-10-20): its token names the note, it
//! takes no place among the user's joined channels, a note holds a capped
//! number of them, and they close with it.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message as WsMessage, WebSocket};
use bytes::Bytes;
use futures::FutureExt;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{mpsc, oneshot};

use crate::access::{self, AccessError};
use crate::app::{Out, Outbox, RoomHandle, Shared};
use crate::auth::{self, Access, Context, RoomName};
use crate::drafts::Class;
use crate::incidents::{self, Cause, Incident, Kind as IncidentKind};
use crate::observe::{Level, log};
use crate::protocol::{self, Kind, Message};
use crate::rate::{TimedOut, Verdict};
use crate::room::{self, RoomCmd};
use crate::seats::{Closing, Membership, Seat, Sending, Sent};

/// A writer's access is revalidated at most this often per channel.
const RECHECK: Duration = Duration::from_secs(5);
/// A channel asks its client for a fresh token this long before expiry.
const TOKEN_LEAD: Duration = Duration::from_secs(60);
/// Queued messages before JOINED, per socket (Hocuspocus's unauthenticated queue).
const MAX_QUEUED_MESSAGES: usize = 1000;
/// The largest frame a socket may send before any of its rooms joined: a
/// client sends only JOINs then (a room name and a token).
const PRE_JOIN_MAX_FRAME: usize = 16 * 1024;
const MAX_QUEUED_BYTES: usize = 512 * 1024;
/// Channels authenticating at once per socket.
const MAX_PENDING_JOINS: usize = 8;
/// The reason a refusal without its own carries; the client retries.
pub const DEFAULT_REFUSAL: &str = "permission-denied";
/// A client protocol its room family no longer (or not yet) accepts: the
/// client stops and asks for a reload.
pub const OUTDATED_REASON: &str = "collaboration-outdated";
/// A socket with no room joined (and none authenticating) after this long
/// closes (Epo 2026-10-19): a client joins as soon as it opens one.
const JOIN_DEADLINE: Duration = Duration::from_secs(10);
/// Every socket is pinged this often (`COLLABORATION_PING_SECONDS`), and one
/// that sends nothing for [SILENT_CLOSE] (`COLLABORATION_SILENT_SECONDS`;
/// any frame counts, the browser's automatic pong too) closes, freeing its
/// places (Epo 2026-10-20): a dead connection would hold its user's caps.
pub const PING_EVERY: Duration = Duration::from_secs(30);
pub const SILENT_CLOSE: Duration = Duration::from_secs(60);
/// What a timed-out user's channels hear (`update-timeout` in
/// src/features/collaboration/roomProvider.ts).
pub const TIMEOUT_TYPE: &str = "update-timeout";
/// Why a channel closed as its user's oldest when they joined one past their
/// cap (`OLDEST_CLOSED_REASON` in src/features/collaboration/roomProvider.ts):
/// the client joins it again only once the user comes back to it.
pub const OLDEST_CLOSED_REASON: &str = "collaboration-oldest-closed";
/// Embed channels one note channel holds at once (Epo 2026-10-20).
pub const EMBEDS_PER_NOTE: usize = 64;
/// Why an embed channel closed: its note joined one past [EMBEDS_PER_NOTE]
/// (`EMBED_CLOSED_REASON` in src/features/collaboration/roomProvider.ts); the
/// client joins it again once it is near the screen again.
pub const EMBED_CLOSED_REASON: &str = "collaboration-embed-closed";
/// Why an embed channel closed, or its JOIN was refused: its note's channel
/// is not joined on this socket (`NOTE_CLOSED_REASON`, same file); the client
/// joins it again when its note joins.
pub const NOTE_CLOSED_REASON: &str = "collaboration-note-closed";

enum Channel {
    /// Queued messages, the JOIN attempt (a later JOIN on the channel makes
    /// an earlier attempt's answers stale) and, for an embed, its note's
    /// channel and that channel's attempt.
    Authenticating(VecDeque<Message>, u64, Option<(u64, u64)>),
    Joined {
        room: RoomHandle,
        name: RoomName,
        context: Context,
        checked: Option<Instant>,
        /// The JOIN attempt it joined with.
        attempt: u64,
        /// Its places among its user's channels.
        places: Box<Places>,
        /// An embed's note channel.
        parent: Option<u64>,
        /// A note channel's embed channels, oldest first.
        embeds: VecDeque<u64>,
    },
}

/// A joined channel's places (`seats.rs`), given back when it goes.
struct Places {
    /// Among its user's joined channels (an embed has none), held for its
    /// drop.
    _joined: Option<Membership>,
    /// Among its user's channels to this document or embed.
    document: Membership,
}

pub struct Refusal {
    reason: String,
    pub message: String,
    /// What a draft send answers with (`drafts.rs`); a socket sends `reason`.
    pub class: Class,
    /// Counted and logged as an authentication failure: every refusal but a
    /// full source disk store's, which its room load logs and counts.
    authentication: bool,
    /// The user is in a timeout, with this long left: a channel hears it
    /// and joins again once it ends; a draft send answers too-fast.
    pub remaining: Option<Duration>,
}

impl Refusal {
    /// A refusal the client retries (the room is busy, a lookup failed).
    fn plain(message: impl Into<String>) -> Self {
        Refusal {
            reason: DEFAULT_REFUSAL.into(),
            message: message.into(),
            class: Class::Unavailable,
            authentication: true,
            remaining: None,
        }
    }

    /// An embed's note channel is not joined on its socket.
    fn note_closed() -> Self {
        Refusal {
            reason: NOTE_CLOSED_REASON.into(),
            authentication: false,
            ..Refusal::plain("the embed's note is not joined on this socket")
        }
    }

    fn timed_out(user: &str, remaining: Duration) -> Self {
        Refusal {
            class: Class::TooFast,
            authentication: false,
            remaining: Some(remaining),
            ..Refusal::plain(format!("{user} is in a timeout"))
        }
    }

    fn access(error: &AccessError) -> Self {
        Refusal {
            reason: error.reason().unwrap_or(DEFAULT_REFUSAL).into(),
            message: error.to_string(),
            class: match error {
                AccessError::Database(_) => Class::Unavailable,
                _ => Class::Permission,
            },
            authentication: true,
            remaining: None,
        }
    }

    /// A token for another room names another lineage than the request's.
    fn token(error: &auth::TokenError) -> Self {
        Refusal {
            class: match error {
                auth::TokenError::Room => Class::Lineage,
                _ => Class::Permission,
            },
            ..Refusal::plain(error.to_string())
        }
    }
}

/// An authentication answered: channel, attempt, and the room, the
/// context and the session's client id from the JOIN, or the refusal.
type AuthResult = (u64, u64, Result<(RoomName, Context, Option<u64>), Refusal>);
/// A join's answer: channel, attempt, and the joined room or the refusal.
type JoinResult = (u64, u64, RoomName, Context, Result<RoomHandle, Refusal>);

/// Joins `name`'s room (loading it if need be). A room that just unloaded
/// fails the send or the join: look up again once.
#[allow(clippy::too_many_arguments)]
async fn join_room(
    app: &Shared,
    name: &RoomName,
    context: &Context,
    client: Option<u64>,
    key: (u64, u64),
    out: Outbox,
    socket: String,
    inside: bool,
) -> Result<RoomHandle, Refusal> {
    for _ in 0..2 {
        let room_name = name.to_string();
        let handle = app.rooms.get_or_spawn(&room_name, |id| {
            room::spawn(app, name, id, &context.user_id)
        });
        let (reply, answer) = oneshot::channel();
        let join = RoomCmd::Join {
            key,
            context: context.clone(),
            client,
            out: out.clone(),
            socket: socket.clone(),
            inside,
            reply,
        };
        if handle.tx.send(join).await.is_err() {
            continue;
        }
        match answer.await {
            Ok(Ok(())) => return Ok(handle),
            Ok(Err(error)) if error == "room unloaded" => continue,
            Ok(Err(error)) if error == room::DISK_FULL => {
                return Err(Refusal {
                    authentication: false,
                    ..Refusal::plain(error)
                });
            }
            // The browser joins again with a fresh token (Q213), or, for an
            // id the room holds no more, opens a new document.
            Ok(Err(error))
                if error == crate::client_ids::REFUSED_REASON
                    || error == crate::client_ids::UNASSIGNED_REASON =>
            {
                return Err(Refusal {
                    reason: error.clone(),
                    ..Refusal::plain(error)
                });
            }
            Ok(Err(error)) => return Err(Refusal::plain(error)),
            Err(_) => continue,
        }
    }
    Err(Refusal::plain("collaboration room unavailable"))
}

/// Whether a room is under the eviction lease (compaction or a publication).
pub async fn room_evicting(app: &Shared, room: &str) -> Result<bool, String> {
    let mut redis = app.redis.clone();
    let key = format!("capy:collaboration:evicting:{room}");
    redis::cmd("EXISTS")
        .arg(&key)
        .query_async::<i64>(&mut redis)
        .await
        .map(|found| found == 1)
        .map_err(|error| error.to_string())
}

/// `onAuthenticate` for one channel or draft send; `protocol` is the
/// client's (`protocol::CLIENT_PROTOCOL`), checked before any lookup.
pub async fn authenticate(
    app: Shared,
    room: String,
    token: String,
    protocol: Option<u32>,
) -> Result<(RoomName, Context), Refusal> {
    let Some(name) = RoomName::parse(&room) else {
        return Err(Refusal {
            class: Class::Malformed,
            ..Refusal::plain("invalid collaboration room")
        });
    };
    if protocol::outdated(name.minimum_protocol(), protocol) {
        let family = usize::from(matches!(name, RoomName::Source { .. }));
        app.stats.outdated_refusals[family].fetch_add(1, Ordering::Relaxed);
        return Err(Refusal {
            reason: OUTDATED_REASON.into(),
            message: format!(
                "client protocol {} outside {}..={} for {} rooms",
                protocol.unwrap_or(0),
                name.minimum_protocol(),
                protocol::CLIENT_PROTOCOL,
                name.family()
            ),
            class: Class::Outdated,
            authentication: true,
            remaining: None,
        });
    }
    if app.evictions.blocks(&room, false) {
        return Err(Refusal::plain("collaboration room is being reset"));
    }
    // The token first (CPU only), then the user's timeout: a bad token or a
    // timed-out user costs no lookup.
    let claims = auth::verify(&token, &app.config.secret, &room, auth::now_seconds())
        .map_err(|error| Refusal::token(&error))?;
    if let Some(remaining) = app.allowances.remaining(&claims.sub, Instant::now()) {
        return Err(Refusal::timed_out(&claims.sub, remaining));
    }
    if room_evicting(&app, &room).await.map_err(Refusal::plain)? {
        return Err(match name {
            RoomName::Source { .. } => Refusal {
                reason: "source-publishing".into(),
                ..Refusal::plain("Source room is locked for a publication")
            },
            RoomName::Material { .. } => Refusal::plain("collaboration room is being compacted"),
        });
    }
    let mut viewer = false;
    match &name {
        RoomName::Material {
            material_id, keys, ..
        } => {
            // A quiz's keys go only to editors who can write (Epo 2026-10-10):
            // a read token, a viewer, a narrowed editor are refused.
            if *keys && claims.access != Access::Write {
                return Err(Refusal::access(&AccessError::ReadOnly(
                    "a quiz's keys need write access".into(),
                )));
            }
            let client = app
                .db
                .get()
                .await
                .map_err(|error| Refusal::plain(error.to_string()))?;
            let live = access::assert_access(&client, material_id, &claims.sub, claims.access)
                .await
                .map_err(|error| Refusal::access(&error))?;
            viewer = !live.editor;
        }
        RoomName::Source { .. } => {
            let source = name
                .source_room()
                .ok_or_else(|| Refusal::plain("invalid collaboration room"))?;
            // The maintenance pause refuses writers; viewing keeps working.
            if claims.access == Access::Write
                && app
                    .sources
                    .editing_paused(&source)
                    .await
                    .map_err(|error| Refusal::plain(error.to_string()))?
            {
                return Err(Refusal {
                    reason: sources::handoff::OFFICE_EDITING_PAUSED_REASON.into(),
                    ..Refusal::plain("Office editing is paused")
                });
            }
            app.sources
                .assert_access(&source, &claims.sub, claims.access == Access::Write)
                .await
                .map_err(|error| {
                    let mut refusal = Refusal::access(&AccessError::from_source(&error));
                    // The gateway's conflict: the epoch (or its base) is not current.
                    if error.status() == Some(409) {
                        refusal.class = Class::Lineage;
                    }
                    refusal
                })?;
        }
    }
    // A reset that began during the checks admits no one.
    if app.evictions.blocks(&room, false) {
        return Err(Refusal::plain("collaboration room is being reset"));
    }
    Ok((
        name,
        Context {
            viewer,
            ..Context::from(&claims)
        },
    ))
}

/// The writer recheck of `accessRecheck`.
async fn recheck(app: &Shared, name: &RoomName, context: &Context) -> Result<(), AccessError> {
    match name {
        RoomName::Material { material_id, .. } => {
            let client = app
                .db
                .get()
                .await
                .map_err(|error| AccessError::Database(error.to_string()))?;
            access::assert_access(&client, material_id, &context.user_id, Access::Write)
                .await
                .map(|_| ())
        }
        RoomName::Source { .. } => {
            let Some(source) = name.source_room() else {
                return Err(AccessError::NotFound("invalid source room".into()));
            };
            app.sources
                .assert_access(&source, &context.user_id, true)
                .await
                .map_err(|error| AccessError::from_source(&error))
        }
    }
}

/// `assertConnectionAccess` for a token refresh.
async fn token_access(
    app: &Shared,
    name: &RoomName,
    user: &str,
    access: Access,
) -> Result<(), String> {
    match name {
        RoomName::Material {
            material_id, keys, ..
        } => {
            if *keys && access != Access::Write {
                return Err("a quiz's keys need write access".into());
            }
            let client = app.db.get().await.map_err(|error| error.to_string())?;
            access::assert_access(&client, material_id, user, access)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        RoomName::Source { .. } => {
            let source = name
                .source_room()
                .ok_or_else(|| "invalid source room".to_owned())?;
            app.sources
                .assert_access(&source, user, access == Access::Write)
                .await
                .map_err(|error| error.to_string())
        }
    }
}

struct Connection {
    app: Shared,
    id: u64,
    socket_id: String,
    outbox: Outbox,
    channels: HashMap<u64, Channel>,
    queued: (usize, usize),
    auth_tx: mpsc::UnboundedSender<AuthResult>,
    join_tx: mpsc::UnboundedSender<JoinResult>,
    attempts: u64,
    /// One of this socket's rooms joined (frames may grow past a JOIN's).
    joined_once: bool,
    /// Token deadlines: (when, channel, expiry instead of refresh).
    timers: BTreeMap<(Instant, u64), bool>,
    /// When the socket closes unless a room joined by then.
    join_deadline: Option<Instant>,
    /// What this socket hears when one of its channels is its user's oldest
    /// past their cap.
    closing_tx: mpsc::UnboundedSender<Closing>,
}

/// Serves one socket; `_address` is its place among its client address's
/// sockets, given back when it closes, and `sent` says when its connection
/// last moved bytes out.
pub async fn serve(app: Shared, socket: WebSocket, _address: Seat, sent: Arc<Sent>) {
    let id = app.next_connection.fetch_add(1, Ordering::Relaxed);
    app.stats.connections.fetch_add(1, Ordering::Relaxed);
    let (outbox, mut out_rx) = Outbox::new();
    let overflow = outbox.overflow();
    let (auth_tx, mut auth_rx) = mpsc::unbounded_channel();
    let (join_tx, mut join_rx) = mpsc::unbounded_channel();
    let (closing_tx, mut closing_rx) = mpsc::unbounded_channel();
    let mut timeouts = app.allowances.subscribe();
    let mut connection = Connection {
        socket_id: format!("{}-{id}", app.instance_id),
        app: app.clone(),
        id,
        outbox,
        channels: HashMap::new(),
        queued: (0, 0),
        auth_tx,
        join_tx,
        attempts: 0,
        joined_once: false,
        timers: BTreeMap::new(),
        join_deadline: Some(Instant::now() + JOIN_DEADLINE),
        closing_tx,
    };
    let mut socket = socket;
    let (ping_every, silent) = (app.config.ping_every, app.config.silent_close);
    let mut ping = tokio::time::interval_at((Instant::now() + ping_every).into(), ping_every);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut heard = Instant::now();
    loop {
        let next_timer = connection.timers.keys().next().map(|(at, _)| *at);
        tokio::select! {
            incoming = socket.recv() => {
                heard = Instant::now();
                if !connection.received(incoming).await {
                    break;
                }
            }
            _ = ping.tick() => {
                let message = WsMessage::Ping(Default::default());
                if !send(&mut socket, message, &sent, silent, &connection.socket_id).await {
                    break;
                }
            }
            () = tokio::time::sleep_until((heard + silent).into()) => {
                // A frame that arrived while this task was busy in another
                // arm counts (rate-limit review r7 N-1).
                if let Some(incoming) = socket.recv().now_or_never() {
                    heard = Instant::now();
                    if !connection.received(incoming).await {
                        break;
                    }
                    continue;
                }
                log(Level::Info, "silent socket closed", json!({ "socket_id": connection.socket_id }));
                let close = WsMessage::Close(Some(CloseFrame { code: 1001, reason: "silent".into() }));
                send(&mut socket, close, &sent, silent, &connection.socket_id).await;
                break;
            }
            Some(out) = out_rx.recv() => match out {
                Out::Frame(frame) => {
                    let len = frame.len();
                    let frame = WsMessage::Binary(frame);
                    let delivered = send(&mut socket, frame, &sent, silent, &connection.socket_id).await;
                    connection.outbox.sent(len);
                    if !delivered {
                        break;
                    }
                }
                Out::ChannelClosed(channel) => {
                    connection.remove_joined(channel).await;
                }
            },
            Some((channel, attempt, result)) = auth_rx.recv() => {
                connection.authenticated(channel, attempt, result);
            }
            Some((channel, attempt, name, context, result)) = join_rx.recv() => {
                // Its queued messages go to the room now, and count.
                connection.joined(channel, attempt, name, context, result).await;
            }
            timeout = timeouts.recv() => match timeout {
                Ok(timeout) => connection.timed_out(&timeout),
                // Too many users timed out at once: this socket missed some
                // announcements (their channels learn at their next join).
                Err(RecvError::Lagged(missed)) => log(
                    Level::Warn,
                    "timeout announcements missed",
                    json!({ "missed": missed, "socket_id": connection.socket_id }),
                ),
                Err(RecvError::Closed) => {}
            },
            Some((channel, id)) = closing_rx.recv() => connection.close_oldest(channel, id).await,
            () = overflow.notified() => {
                log(Level::Warn, "slow connection closed", json!({ "socket_id": connection.socket_id }));
                break;
            }
            () = sleep_until(next_timer) => connection.on_timers().await,
            () = sleep_until(connection.join_deadline) => {
                if !connection.join_overdue() {
                    continue;
                }
                log(Level::Warn, "socket closed before any join", json!({ "socket_id": connection.socket_id }));
                let close = WsMessage::Close(Some(CloseFrame { code: 1008, reason: "no room joined".into() }));
                send(&mut socket, close, &sent, silent, &connection.socket_id).await;
                break;
            }
        }
    }
    connection.close_all().await;
    app.stats.connections.fetch_sub(1, Ordering::Relaxed);
}

/// Sends `message`: false when the socket must close, the send having failed
/// or moved no bytes for the silent window (logged like the silent close;
/// Epo 2026-10-20, rate-limit review r7).
async fn send(
    socket: &mut WebSocket,
    message: WsMessage,
    sent: &Sent,
    silent: Duration,
    socket_id: &str,
) -> bool {
    match crate::seats::watched(socket.send(message), sent, silent).await {
        Sending::Sent => true,
        Sending::Failed => false,
        Sending::Stalled => {
            log(
                Level::Info,
                "stalled socket closed",
                json!({ "socket_id": socket_id }),
            );
            false
        }
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
        None => std::future::pending().await,
    }
}

impl Connection {
    fn send(&self, channel: u64, kind: Kind, payload: &[u8]) {
        self.outbox.frame(protocol::message(channel, kind, payload));
    }

    fn refuse(&mut self, channel: u64, refusal: &Refusal) {
        if refusal.authentication {
            self.app
                .stats
                .authentication_failures
                .fetch_add(1, Ordering::Relaxed);
            // Expected and frequent (expired tokens, stale tabs): logged, not reported.
            log(
                Level::Warn,
                "authentication rejected",
                json!({ "error": refusal.message }),
            );
        }
        self.send(channel, Kind::Refused, &protocol::text(&refusal.reason));
        self.forget(channel);
    }

    fn forget(&mut self, channel: u64) {
        crate::source_rooms::end_join(&self.app, (self.id, channel));
        if let Some(Channel::Authenticating(queue, ..)) = self.channels.remove(&channel) {
            self.queued.0 -= queue.len();
            self.queued.1 -= queue
                .iter()
                .map(|message| message.payload.len())
                .sum::<usize>();
        }
        self.timers
            .retain(|(_, timer_channel), _| *timer_channel != channel);
    }

    /// What the socket received: false when it must close.
    async fn received(&mut self, incoming: Option<Result<WsMessage, axum::Error>>) -> bool {
        match incoming {
            Some(Ok(WsMessage::Binary(frame))) => self.on_frame(frame).await,
            Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => false,
            Some(Ok(_)) => true,
        }
    }

    /// Returns false when the socket must close.
    async fn on_frame(&mut self, frame: Bytes) -> bool {
        if !self.joined_once && frame.len() > PRE_JOIN_MAX_FRAME {
            log(
                Level::Warn,
                "frame before any join too large",
                json!({ "bytes": frame.len(), "socket_id": self.socket_id }),
            );
            return false;
        }
        let Ok(messages) = protocol::decode_frame(&frame) else {
            return false;
        };
        for message in messages {
            if !self.on_message(message).await {
                return false;
            }
        }
        true
    }

    /// The join deadline passed: true when the socket must close (no room
    /// joined, none authenticating); a join still authenticating (its token
    /// held, `on_message`) gets another [JOIN_DEADLINE].
    fn join_overdue(&mut self) -> bool {
        let authenticating = self
            .channels
            .values()
            .any(|channel| matches!(channel, Channel::Authenticating(..)));
        if self.joined_once || authenticating {
            self.join_deadline = (!self.joined_once).then(|| Instant::now() + JOIN_DEADLINE);
            return false;
        }
        true
    }

    /// A user's timeout began: each of their joined channels hears it.
    fn timed_out(&self, timeout: &TimedOut) {
        let remaining = timeout.until.saturating_duration_since(Instant::now());
        for (channel, state) in &self.channels {
            if let Channel::Joined { context, .. } = state
                && *context.user_id == *timeout.user
            {
                self.send_timeout(*channel, remaining);
            }
        }
    }

    /// Only that the user is in a timeout and how long it has left (never
    /// the allowance's numbers).
    fn send_timeout(&self, channel: u64, remaining: Duration) {
        let payload = json!({
            "remainingMs": remaining.as_micros().div_ceil(1000) as u64,
            "type": TIMEOUT_TYPE,
        });
        self.send(
            channel,
            Kind::Stateless,
            &protocol::text(&payload.to_string()),
        );
    }

    async fn on_message(&mut self, message: Message) -> bool {
        let channel = message.channel;
        if message.kind == Kind::Join {
            let Ok(protocol::Join {
                room,
                token,
                protocol: client,
                client: session,
                parent,
            }) = protocol::decode_join(&message.payload)
            else {
                return false;
            };
            if let Some(joined) = self.remove_joined(channel).await {
                let _ = joined
                    .tx
                    .send(RoomCmd::Leave((self.id, channel), false))
                    .await;
            }
            self.forget(channel);
            // A bad token is refused here, before any lookup, so it never
            // holds the join deadline open.
            if let Err(error) =
                auth::verify(&token, &self.app.config.secret, &room, auth::now_seconds())
            {
                self.refuse(channel, &Refusal::token(&error));
                return true;
            }
            let pending = self
                .channels
                .values()
                .filter(|c| matches!(c, Channel::Authenticating(..)))
                .count();
            if pending >= MAX_PENDING_JOINS {
                log(
                    Level::Warn,
                    "too many pending joins",
                    json!({ "socket_id": self.socket_id }),
                );
                return false;
            }
            // An embed joins inside its note's channel, joined on this socket
            // now (Epo 2026-10-20).
            let parent = match parent {
                None => None,
                Some(note) => match self.channels.get(&note) {
                    Some(Channel::Joined {
                        attempt,
                        parent: None,
                        name: RoomName::Material { keys: false, .. },
                        ..
                    }) if note != channel => Some((note, *attempt)),
                    _ => {
                        self.refuse(channel, &Refusal::note_closed());
                        return true;
                    }
                },
            };
            self.attempts += 1;
            let attempt = self.attempts;
            self.channels.insert(
                channel,
                Channel::Authenticating(VecDeque::new(), attempt, parent),
            );
            // A source join counts as in the room until it joins or fails.
            if room.starts_with("source:") {
                crate::source_rooms::start_join(&self.app, (self.id, channel), &room);
            }
            let (app, tx) = (self.app.clone(), self.auth_tx.clone());
            tokio::spawn(async move {
                let result = authenticate(app, room, token, client)
                    .await
                    .map(|(name, context)| (name, context, session));
                let _ = tx.send((channel, attempt, result));
            });
            return true;
        }
        match self.channels.get_mut(&channel) {
            None => true,
            Some(Channel::Authenticating(queue, ..)) => {
                self.queued.0 += 1;
                self.queued.1 += message.payload.len();
                queue.push_back(message);
                self.queued.0 <= MAX_QUEUED_MESSAGES && self.queued.1 <= MAX_QUEUED_BYTES
            }
            Some(Channel::Joined { .. }) => {
                self.forward(message).await;
                true
            }
        }
    }

    /// A joined channel's message goes to its room, after the writer recheck
    /// for updates. SYNC, awareness and query messages take from the user's
    /// allowance; in a timeout they and stateless messages are dropped.
    async fn forward(&mut self, message: Message) {
        let channel = message.channel;
        let Some(Channel::Joined {
            room,
            name,
            context,
            checked,
            ..
        }) = self.channels.get(&channel)
        else {
            return;
        };
        let (room, name, context, checked) =
            (room.clone(), name.clone(), context.clone(), *checked);
        let key = (self.id, channel);
        let now = Instant::now();
        let decoded = (message.kind == Kind::Sync)
            .then(|| protocol::sync::decode(&message.payload))
            .and_then(Result::ok);
        let allowances = &self.app.allowances;
        let user = &context.user_id;
        let verdict = match message.kind {
            Kind::Sync => match decoded {
                Some((_, body)) if body.len() > ydoc::MAX_UPDATE_BYTES => {
                    Some(allowances.time_out(user, now))
                }
                // An update is charged by its body, which the cap bounds, so
                // every update fits a full allowance.
                Some((_, body)) => Some(allowances.take(user, body.len(), now)),
                None => Some(allowances.take(user, message.payload.len(), now)),
            },
            Kind::Awareness => Some(allowances.take(user, message.payload.len(), now)),
            Kind::QueryAwareness => Some(allowances.take(user, 0, now)),
            Kind::Stateless => allowances
                .remaining(user, now)
                .map(|remaining| Verdict::TimedOut {
                    remaining,
                    started: false,
                }),
            _ => None,
        };
        if let Some(Verdict::TimedOut { started, .. }) = verdict {
            if started {
                self.app.stats.timeouts.fetch_add(1, Ordering::Relaxed);
                // Expected only from a runaway or hostile client: logged, not reported.
                log(
                    Level::Warn,
                    "user timed out",
                    json!({ "room": name.to_string(), "socket_id": self.socket_id, "user_id": context.user_id }),
                );
            }
            return;
        }
        let step1 = decoded.is_some_and(|(kind, _)| kind == protocol::sync::STEP1);
        let command = match message.kind {
            Kind::Sync => {
                let writes = decoded.is_some() && !step1;
                if writes
                    && context.access == Access::Write
                    && checked.is_none_or(|at| at.elapsed() >= RECHECK)
                {
                    match recheck(&self.app, &name, &context).await {
                        Ok(()) => {
                            if let Some(Channel::Joined { checked, .. }) =
                                self.channels.get_mut(&channel)
                            {
                                *checked = Some(Instant::now());
                            }
                        }
                        Err(error) => {
                            self.recheck_refused(
                                channel,
                                &room,
                                &name,
                                &context,
                                &error,
                                message.payload.len(),
                            )
                            .await;
                            return;
                        }
                    }
                }
                RoomCmd::Sync(key, message.payload)
            }
            Kind::Awareness => RoomCmd::Awareness(key, message.payload),
            Kind::QueryAwareness => RoomCmd::QueryAwareness(key),
            Kind::Stateless => match protocol::decode_text(&message.payload) {
                Ok(text) => RoomCmd::Stateless(key, text),
                Err(_) => return,
            },
            Kind::Leave => {
                self.remove_joined(channel).await;
                self.timers
                    .retain(|(_, timer_channel), _| *timer_channel != channel);
                // One byte: 0 when the tab holds no unsent edits for the
                // document (Q236); anything else keeps its rows.
                RoomCmd::Leave(key, message.payload.as_ref() == [0])
            }
            Kind::Token => {
                self.token(channel, &message.payload).await;
                return;
            }
            _ => return,
        };
        let _ = room.tx.send(command).await;
    }

    /// One of this socket's channels was its user's oldest when they joined
    /// one past their cap (Epo 2026-10-19), or their oldest to its document
    /// when they joined it once past [crate::seats::CONNECTIONS_PER_DOCUMENT]
    /// (Epo 2026-10-20): it closes, unless it joined again since.
    async fn close_oldest(&mut self, channel: u64, id: u64) {
        let Some(Channel::Joined { places, .. }) = self.channels.get(&channel) else {
            return;
        };
        // Both places share the channel's membership id.
        if places.document.id != id {
            return;
        }
        self.app.stats.oldest_closed.fetch_add(1, Ordering::Relaxed);
        self.send(
            channel,
            Kind::Closed,
            &protocol::closed(0, OLDEST_CLOSED_REASON),
        );
        let room = self.remove_joined(channel).await;
        self.forget(channel);
        if let Some(room) = room {
            let _ = room
                .tx
                .send(RoomCmd::Leave((self.id, channel), false))
                .await;
        }
    }

    /// A writer whose access changed: `room-read-only` for a read-only
    /// refusal, then the channel closes; lost write access is an incident.
    async fn recheck_refused(
        &mut self,
        channel: u64,
        room: &RoomHandle,
        name: &RoomName,
        context: &Context,
        error: &AccessError,
        bytes: usize,
    ) {
        if matches!(error, AccessError::ReadOnly(_)) {
            let payload = json!({ "room": name.to_string(), "type": "room-read-only" }).to_string();
            self.send(channel, Kind::Stateless, &protocol::text(&payload));
        }
        if error.lost_write() {
            incidents::record(
                &self.app,
                vec![Incident {
                    cause: Cause::new(IncidentKind::DiscardUnsaved, error.incident_reason()),
                    room: name.to_string(),
                    size_bytes: Some(bytes as u64),
                    user_id: Some(context.user_id.clone()),
                }],
            );
        }
        self.send(
            channel,
            Kind::Closed,
            &protocol::closed(0, &error.to_string()),
        );
        self.remove_joined(channel).await;
        self.timers
            .retain(|(_, timer_channel), _| *timer_channel != channel);
        let _ = room
            .tx
            .send(RoomCmd::Leave((self.id, channel), false))
            .await;
    }

    /// Takes a joined channel off this socket and gives back its room (the
    /// caller leaves it, unless the room closed the channel itself): an
    /// embed comes off its note's list, and a note's embed channels close
    /// with it (Epo 2026-10-20), each hearing [NOTE_CLOSED_REASON].
    async fn remove_joined(&mut self, channel: u64) -> Option<RoomHandle> {
        if !matches!(self.channels.get(&channel), Some(Channel::Joined { .. })) {
            return None;
        }
        let Some(Channel::Joined {
            room,
            parent,
            embeds,
            ..
        }) = self.channels.remove(&channel)
        else {
            return None;
        };
        if let Some(Channel::Joined { embeds, .. }) =
            parent.and_then(|note| self.channels.get_mut(&note))
        {
            embeds.retain(|embed| *embed != channel);
        }
        for embed in embeds {
            self.close_embed(embed, NOTE_CLOSED_REASON).await;
        }
        Some(room)
    }

    /// Closes an embed channel, telling its client why, and leaves its room.
    async fn close_embed(&mut self, embed: u64, reason: &str) {
        if !matches!(self.channels.get(&embed), Some(Channel::Joined { .. })) {
            return;
        }
        let Some(Channel::Joined { room, .. }) = self.channels.remove(&embed) else {
            return;
        };
        self.send(embed, Kind::Closed, &protocol::closed(0, reason));
        self.forget(embed);
        let _ = room.tx.send(RoomCmd::Leave((self.id, embed), false)).await;
    }

    /// An embed of `name` joins inside `note`: the note's earlier channel of
    /// that room closes (rate-limit review r5 S-a: a note channel never
    /// takes one room's updates twice), before the new one takes its places.
    async fn close_twin(&mut self, note: u64, name: &RoomName) {
        let twin = match self.channels.get(&note) {
            Some(Channel::Joined { embeds, .. }) => embeds.iter().copied().find(|other| {
                matches!(
                    self.channels.get(other),
                    Some(Channel::Joined { name: joined, .. }) if joined == name
                )
            }),
            _ => None,
        };
        let Some(twin) = twin else {
            return;
        };
        if let Some(Channel::Joined { embeds, .. }) = self.channels.get_mut(&note) {
            embeds.retain(|other| *other != twin);
        }
        self.close_embed(twin, EMBED_CLOSED_REASON).await;
    }

    /// An embed channel joined inside its note's: past [EMBEDS_PER_NOTE] the
    /// note's oldest embed channel closes.
    async fn add_embed(&mut self, note: u64, embed: u64) {
        let oldest = match self.channels.get_mut(&note) {
            Some(Channel::Joined { embeds, .. }) => {
                embeds.push_back(embed);
                if embeds.len() > EMBEDS_PER_NOTE {
                    embeds.pop_front()
                } else {
                    None
                }
            }
            _ => None,
        };
        if let Some(oldest) = oldest {
            self.close_embed(oldest, EMBED_CLOSED_REASON).await;
        }
    }

    /// Whether `note` is still the joined channel an embed named at its JOIN.
    fn note_joined(&self, note: u64, attempt: u64) -> bool {
        matches!(
            self.channels.get(&note),
            Some(Channel::Joined { attempt: current, .. }) if *current == attempt
        )
    }

    fn authenticating(&self, channel: u64, attempt: u64) -> bool {
        matches!(
            self.channels.get(&channel),
            Some(Channel::Authenticating(_, current, _)) if *current == attempt
        )
    }

    /// An authentication answered: the join (which waits for the room's
    /// load, an Office seed perhaps) runs apart, so this socket keeps serving
    /// its other rooms meanwhile.
    fn authenticated(
        &mut self,
        channel: u64,
        attempt: u64,
        result: Result<(RoomName, Context, Option<u64>), Refusal>,
    ) {
        if !self.authenticating(channel, attempt) {
            return;
        }
        let (name, context, client) = match result {
            Ok(joined) => joined,
            Err(Refusal {
                remaining: Some(remaining),
                ..
            }) => {
                self.send_timeout(channel, remaining);
                self.forget(channel);
                return;
            }
            Err(refusal) => {
                self.refuse(channel, &refusal);
                return;
            }
        };
        // An embed's token names its note (Go knows the material's parent):
        // it joins only inside that note's channel, of the same user.
        if let Some(Channel::Authenticating(_, _, Some((note, note_attempt)))) =
            self.channels.get(&channel)
        {
            let (note, note_attempt) = (*note, *note_attempt);
            let refusal = match self.channels.get(&note) {
                Some(Channel::Joined {
                    attempt,
                    name: RoomName::Material { material_id, .. },
                    context: note_context,
                    ..
                }) if *attempt == note_attempt => (context.parent.as_deref()
                    != Some(material_id.as_str())
                    || note_context.user_id != context.user_id)
                    .then(|| {
                        Refusal::access(&AccessError::Forbidden(
                            "the material is not this note's embed".into(),
                        ))
                    }),
                _ => Some(Refusal::note_closed()),
            };
            if let Some(refusal) = refusal {
                self.refuse(channel, &refusal);
                return;
            }
        }
        // A JOIN costs one message of the allowance (Epo 2026-10-19), so a
        // join loop runs into a timeout like any other.
        let verdict = self
            .app
            .allowances
            .take(&context.user_id, 0, Instant::now());
        if let Verdict::TimedOut { remaining, started } = verdict {
            if started {
                self.app.stats.timeouts.fetch_add(1, Ordering::Relaxed);
                log(
                    Level::Warn,
                    "user timed out",
                    json!({ "room": name.to_string(), "socket_id": self.socket_id, "user_id": context.user_id }),
                );
            }
            self.send_timeout(channel, remaining);
            self.forget(channel);
            return;
        }
        let key = (self.id, channel);
        let inside = matches!(
            self.channels.get(&channel),
            Some(Channel::Authenticating(_, _, Some(_)))
        );
        let (app, tx, out, socket) = (
            self.app.clone(),
            self.join_tx.clone(),
            self.outbox.clone(),
            self.socket_id.clone(),
        );
        tokio::spawn(async move {
            let result = join_room(&app, &name, &context, client, key, out, socket, inside).await;
            if let Err(unsent) = tx.send((channel, attempt, name, context, result)) {
                // The socket closed meanwhile: leave the room it joined.
                if let (.., Ok(handle)) = unsent.0 {
                    let _ = handle.tx.send(RoomCmd::Leave(key, false)).await;
                }
            }
        });
    }

    /// A join answered: the channel serves its room, unless a LEAVE or a new
    /// JOIN on it made this attempt stale (then the room is left at once).
    async fn joined(
        &mut self,
        channel: u64,
        attempt: u64,
        name: RoomName,
        context: Context,
        result: Result<RoomHandle, Refusal>,
    ) {
        let current = self.authenticating(channel, attempt);
        let handle = match result {
            Ok(joined) => joined,
            Err(refusal) => {
                if current {
                    self.refuse(channel, &refusal);
                }
                return;
            }
        };
        if !current {
            let _ = handle
                .tx
                .send(RoomCmd::Leave((self.id, channel), false))
                .await;
            return;
        }
        // An embed's note may have left while its room loaded.
        let parent = match self.channels.get(&channel) {
            Some(Channel::Authenticating(_, _, parent)) => *parent,
            _ => None,
        };
        if let Some((note, note_attempt)) = parent
            && !self.note_joined(note, note_attempt)
        {
            let _ = handle
                .tx
                .send(RoomCmd::Leave((self.id, channel), false))
                .await;
            self.refuse(channel, &Refusal::note_closed());
            return;
        }
        crate::source_rooms::end_join(&self.app, (self.id, channel));
        let Some(Channel::Authenticating(queue, ..)) = self.channels.remove(&channel) else {
            return;
        };
        self.queued.0 -= queue.len();
        self.queued.1 -= queue
            .iter()
            .map(|message| message.payload.len())
            .sum::<usize>();
        self.joined_once = true;
        self.join_deadline = None;
        self.arm_token(channel, &context);
        // An embed's earlier channel of the same room under its note closes
        // first, giving its places back (rate-limit review r6 S-3).
        if let Some((note, _)) = parent {
            self.close_twin(note, &name).await;
        }
        // Every channel, an embed's too, takes a place among the user's to
        // its document: a fifth closes their oldest one (Epo 2026-10-20).
        let id = crate::seats::membership_id();
        let (document, freed) = self.app.per_document.join(
            &format!("{} {name}", context.user_id),
            id,
            channel,
            &self.closing_tx,
            None,
        );
        // Only a note's (or any other document's) channel takes a place among
        // the user's joined channels, never an embed's. When the per-document
        // close above ends a channel holding one, its place is this join's;
        // otherwise (an embed's, which holds none) the oldest closes (rate-
        // limit review r6 S-3, r7 B-1).
        let joined = parent.is_none().then(|| {
            let user = &context.user_id;
            self.app
                .joined
                .join(user, id, channel, &self.closing_tx, freed)
                .0
        });
        // A user in a timeout hears it on each channel they join.
        let timeout = self
            .app
            .allowances
            .remaining(&context.user_id, Instant::now());
        self.channels.insert(
            channel,
            Channel::Joined {
                room: handle,
                name,
                context,
                checked: None,
                attempt,
                places: Box::new(Places {
                    _joined: joined,
                    document,
                }),
                parent: parent.map(|(note, _)| note),
                embeds: VecDeque::new(),
            },
        );
        if let Some((note, _)) = parent {
            self.add_embed(note, channel).await;
        }
        if let Some(remaining) = timeout {
            self.send_timeout(channel, remaining);
        }
        for message in queue {
            self.forward(message).await;
        }
    }

    fn arm_token(&mut self, channel: u64, context: &Context) {
        self.timers
            .retain(|(_, timer_channel), _| *timer_channel != channel);
        let left = Duration::from_secs((context.expires_at - auth::now_seconds()).max(0) as u64);
        let now = Instant::now();
        self.timers
            .insert((now + left.saturating_sub(TOKEN_LEAD), channel), false);
        self.timers.insert((now + left, channel), true);
    }

    async fn on_timers(&mut self) {
        let now = Instant::now();
        let due: Vec<((Instant, u64), bool)> = self
            .timers
            .range(..=(now, u64::MAX))
            .map(|(key, expiry)| (*key, *expiry))
            .collect();
        for (key, expiry) in due {
            self.timers.remove(&key);
            let channel = key.1;
            if expiry {
                self.send(
                    channel,
                    Kind::Closed,
                    &protocol::closed(4401, "collaboration token expired"),
                );
                if let Some(room) = self.remove_joined(channel).await {
                    let _ = room.tx.try_send(RoomCmd::Leave((self.id, channel), false));
                }
            } else {
                self.send(channel, Kind::TokenRequest, &[]);
            }
        }
    }

    /// `onTokenSync`: verify the fresh token, recheck access, re-arm.
    async fn token(&mut self, channel: u64, payload: &[u8]) {
        let Some(Channel::Joined {
            room,
            name,
            context: joined,
            ..
        }) = self.channels.get(&channel)
        else {
            return;
        };
        let (room, name, user) = (room.clone(), name.clone(), joined.user_id.clone());
        let Ok(token) = protocol::decode_text(payload) else {
            return;
        };
        let room_name = name.to_string();
        let verified = auth::verify(
            &token,
            &self.app.config.secret,
            &room_name,
            auth::now_seconds(),
        );
        let result = match verified {
            // A channel stays its user's: another user's token, even for the
            // same room, is refused (r2 S4).
            Ok(claims) if claims.sub != user => Err("the token names another user".to_owned()),
            Ok(claims) => token_access(&self.app, &name, &claims.sub, claims.access)
                .await
                .map(|()| Context::from(&claims)),
            Err(error) => Err(error.to_string()),
        };
        match result {
            Ok(context) => {
                self.arm_token(channel, &context);
                if let Some(Channel::Joined {
                    context: current, ..
                }) = self.channels.get_mut(&channel)
                {
                    *current = context.clone();
                }
                let _ = room
                    .tx
                    .send(RoomCmd::Token((self.id, channel), context))
                    .await;
            }
            Err(error) => {
                // The channel closes at expiry as armed; the client reconnects.
                log(
                    Level::Warn,
                    "token refresh refused",
                    json!({ "error": error, "room": room_name }),
                );
            }
        }
    }

    async fn close_all(&mut self) {
        for (channel, state) in self.channels.drain() {
            if let Channel::Joined { room, .. } = state {
                let _ = room
                    .tx
                    .send(RoomCmd::Leave((self.id, channel), false))
                    .await;
            }
        }
    }
}
