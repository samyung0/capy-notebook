//! One task per WebSocket (DESIGN.md 1.3, 4): channels authenticate on their
//! own (JOIN runs every `onAuthenticate` check), their messages queue until
//! JOINED and then go to the room in order; a writer's access is rechecked at
//! most every 5 s before its updates go on; tokens refresh in band.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message as WsMessage, WebSocket};
use bytes::Bytes;
use serde_json::json;
use tokio::sync::{mpsc, oneshot};

use crate::access::{self, AccessError};
use crate::app::{Out, Outbox, RoomHandle, Shared};
use crate::auth::{self, Access, Context, RoomName};
use crate::incidents::{self, Cause, Incident, Kind as IncidentKind};
use crate::observe::{Level, log};
use crate::protocol::{self, Kind, Message};
use crate::room::{self, RoomCmd};

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

enum Channel {
    /// Queued messages and the JOIN attempt (a later JOIN on the channel
    /// makes an earlier attempt's answers stale).
    Authenticating(VecDeque<Message>, u64),
    Joined {
        room: RoomHandle,
        name: RoomName,
        context: Context,
        checked: Option<Instant>,
    },
}

struct Refusal {
    reason: String,
    message: String,
}

impl Refusal {
    fn plain(message: impl Into<String>) -> Self {
        Refusal {
            reason: DEFAULT_REFUSAL.into(),
            message: message.into(),
        }
    }

    fn access(error: &AccessError) -> Self {
        Refusal {
            reason: error.reason().unwrap_or(DEFAULT_REFUSAL).into(),
            message: error.to_string(),
        }
    }
}

type AuthResult = (u64, u64, Result<(RoomName, Context), Refusal>);
/// A join's answer: channel, attempt, and the joined room or the refusal.
type JoinResult = (u64, u64, RoomName, Context, Result<RoomHandle, Refusal>);

/// Joins `name`'s room (loading it if need be). A room that just unloaded
/// fails the send or the join: look up again once.
async fn join_room(
    app: &Shared,
    name: &RoomName,
    context: &Context,
    key: (u64, u64),
    out: Outbox,
    socket: String,
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
            out: out.clone(),
            socket: socket.clone(),
            reply,
        };
        if handle.tx.send(join).await.is_err() {
            continue;
        }
        match answer.await {
            Ok(Ok(())) => return Ok(handle),
            Ok(Err(error)) if error == "room unloaded" => continue,
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

/// `onAuthenticate` for one channel.
async fn authenticate(
    app: Shared,
    room: String,
    token: String,
) -> Result<(RoomName, Context), Refusal> {
    let Some(name) = RoomName::parse(&room) else {
        return Err(Refusal::plain("invalid collaboration room"));
    };
    if app.evictions.blocks(&room, false) {
        return Err(Refusal::plain("collaboration room is being reset"));
    }
    if room_evicting(&app, &room).await.map_err(Refusal::plain)? {
        return Err(match name {
            RoomName::Source { .. } => Refusal {
                reason: "source-publishing".into(),
                message: "Source room is locked for a publication".into(),
            },
            RoomName::Material { .. } => Refusal::plain("collaboration room is being compacted"),
        });
    }
    let claims = auth::verify(&token, &app.config.secret, &room, auth::now_seconds())
        .map_err(|error| Refusal::plain(error.to_string()))?;
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
                    message: "Office editing is paused".into(),
                });
            }
            app.sources
                .assert_access(&source, &claims.sub, claims.access == Access::Write)
                .await
                .map_err(|error| Refusal::access(&AccessError::from_source(&error)))?;
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
}

pub async fn serve(app: Shared, socket: WebSocket) {
    let id = app.next_connection.fetch_add(1, Ordering::Relaxed);
    app.stats.connections.fetch_add(1, Ordering::Relaxed);
    let (outbox, mut out_rx) = Outbox::new();
    let overflow = outbox.overflow();
    let (auth_tx, mut auth_rx) = mpsc::unbounded_channel();
    let (join_tx, mut join_rx) = mpsc::unbounded_channel();
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
    };
    let mut socket = socket;
    loop {
        let next_timer = connection.timers.keys().next().map(|(at, _)| *at);
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(WsMessage::Binary(frame))) => {
                    if !connection.on_frame(frame).await {
                        break;
                    }
                }
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            Some(out) = out_rx.recv() => match out {
                Out::Frame(frame) => {
                    let len = frame.len();
                    let sent = socket.send(WsMessage::Binary(frame)).await;
                    connection.outbox.sent(len);
                    if sent.is_err() {
                        break;
                    }
                }
                Out::ChannelClosed(channel) => {
                    connection.channels.remove(&channel);
                }
            },
            Some((channel, attempt, result)) = auth_rx.recv() => {
                connection.authenticated(channel, attempt, result);
            }
            Some((channel, attempt, name, context, result)) = join_rx.recv() => {
                connection.joined(channel, attempt, name, context, result).await;
            }
            () = overflow.notified() => {
                log(Level::Warn, "slow connection closed", json!({ "socket_id": connection.socket_id }));
                break;
            }
            () = sleep_until(next_timer) => connection.on_timers(),
        }
    }
    connection.close_all().await;
    app.stats.connections.fetch_sub(1, Ordering::Relaxed);
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
        self.send(channel, Kind::Refused, &protocol::text(&refusal.reason));
        self.forget(channel);
    }

    fn forget(&mut self, channel: u64) {
        crate::source_rooms::end_join(&self.app, (self.id, channel));
        if let Some(Channel::Authenticating(queue, _)) = self.channels.remove(&channel) {
            self.queued.0 -= queue.len();
            self.queued.1 -= queue
                .iter()
                .map(|message| message.payload.len())
                .sum::<usize>();
        }
        self.timers
            .retain(|(_, timer_channel), _| *timer_channel != channel);
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

    async fn on_message(&mut self, message: Message) -> bool {
        let channel = message.channel;
        if message.kind == Kind::Join {
            let Ok((room, token)) = protocol::decode_join(&message.payload) else {
                return false;
            };
            if let Some(Channel::Joined { room, .. }) = self.channels.get(&channel) {
                let _ = room.tx.send(RoomCmd::Leave((self.id, channel))).await;
            }
            self.forget(channel);
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
            self.attempts += 1;
            let attempt = self.attempts;
            self.channels
                .insert(channel, Channel::Authenticating(VecDeque::new(), attempt));
            // A source join counts as in the room until it joins or fails.
            if room.starts_with("source:") {
                crate::source_rooms::start_join(&self.app, (self.id, channel), &room);
            }
            let (app, tx) = (self.app.clone(), self.auth_tx.clone());
            tokio::spawn(async move {
                let result = authenticate(app, room, token).await;
                let _ = tx.send((channel, attempt, result));
            });
            return true;
        }
        match self.channels.get_mut(&channel) {
            None => true,
            Some(Channel::Authenticating(queue, _)) => {
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
    /// for updates.
    async fn forward(&mut self, message: Message) {
        let channel = message.channel;
        let Some(Channel::Joined {
            room,
            name,
            context,
            checked,
        }) = self.channels.get(&channel)
        else {
            return;
        };
        let (room, name, context, checked) =
            (room.clone(), name.clone(), context.clone(), *checked);
        let key = (self.id, channel);
        let command = match message.kind {
            Kind::Sync => {
                let writes = protocol::sync::decode(&message.payload)
                    .map(|(kind, _)| kind != protocol::sync::STEP1)
                    .unwrap_or(false);
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
                self.channels.remove(&channel);
                self.timers
                    .retain(|(_, timer_channel), _| *timer_channel != channel);
                RoomCmd::Leave(key)
            }
            Kind::Token => {
                self.token(channel, &message.payload).await;
                return;
            }
            _ => return,
        };
        let _ = room.tx.send(command).await;
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
        self.channels.remove(&channel);
        self.timers
            .retain(|(_, timer_channel), _| *timer_channel != channel);
        let _ = room.tx.send(RoomCmd::Leave((self.id, channel))).await;
    }

    fn authenticating(&self, channel: u64, attempt: u64) -> bool {
        matches!(
            self.channels.get(&channel),
            Some(Channel::Authenticating(_, current)) if *current == attempt
        )
    }

    /// An authentication answered: the join (which waits for the room's
    /// load, an Office seed perhaps) runs apart, so this socket keeps serving
    /// its other rooms meanwhile.
    fn authenticated(
        &mut self,
        channel: u64,
        attempt: u64,
        result: Result<(RoomName, Context), Refusal>,
    ) {
        if !self.authenticating(channel, attempt) {
            return;
        }
        let (name, context) = match result {
            Ok(joined) => joined,
            Err(refusal) => {
                self.refuse(channel, &refusal);
                return;
            }
        };
        let key = (self.id, channel);
        let (app, tx, out, socket) = (
            self.app.clone(),
            self.join_tx.clone(),
            self.outbox.clone(),
            self.socket_id.clone(),
        );
        tokio::spawn(async move {
            let result = join_room(&app, &name, &context, key, out, socket).await;
            if let Err(unsent) = tx.send((channel, attempt, name, context, result)) {
                // The socket closed meanwhile: leave the room it joined.
                if let (.., Ok(handle)) = unsent.0 {
                    let _ = handle.tx.send(RoomCmd::Leave(key)).await;
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
            Ok(handle) => handle,
            Err(refusal) => {
                if current {
                    self.refuse(channel, &refusal);
                }
                return;
            }
        };
        if !current {
            let _ = handle.tx.send(RoomCmd::Leave((self.id, channel))).await;
            return;
        }
        crate::source_rooms::end_join(&self.app, (self.id, channel));
        let Some(Channel::Authenticating(queue, _)) = self.channels.remove(&channel) else {
            return;
        };
        self.queued.0 -= queue.len();
        self.queued.1 -= queue
            .iter()
            .map(|message| message.payload.len())
            .sum::<usize>();
        self.joined_once = true;
        self.arm_token(channel, &context);
        self.channels.insert(
            channel,
            Channel::Joined {
                room: handle,
                name,
                context,
                checked: None,
            },
        );
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

    fn on_timers(&mut self) {
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
                if let Some(Channel::Joined { room, .. }) = self.channels.remove(&channel) {
                    let _ = room.tx.try_send(RoomCmd::Leave((self.id, channel)));
                }
            } else {
                self.send(channel, Kind::TokenRequest, &[]);
            }
        }
    }

    /// `onTokenSync`: verify the fresh token, recheck access, re-arm.
    async fn token(&mut self, channel: u64, payload: &[u8]) {
        let Some(Channel::Joined { room, name, .. }) = self.channels.get(&channel) else {
            return;
        };
        let (room, name) = (room.clone(), name.clone());
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
                let _ = room.tx.send(RoomCmd::Leave((self.id, channel))).await;
            }
        }
    }
}
