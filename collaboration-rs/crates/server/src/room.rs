//! One task per loaded room (DESIGN.md 4): it owns the yrs document and does
//! every check that reads it, then the apply; it batches broadcasts over the
//! 30 ms flush window with no echo to the sender, acknowledges each writer's
//! messages once per window, keeps awareness as bytes, writes contributor
//! markers once per store window, stores with delta rows, projects notes on
//! idle and unloads once empty and clean.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::BytesMut;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use yrs::{Doc, ReadTxn, StateVector, Transact};

use crate::app::{Outbox, RoomHandle, Shared};
use crate::auth::{Access, Context, RoomName};
use crate::incidents::{self, Cause, Incident, Kind as IncidentKind};
use crate::markers::{self, Contributor, Markers};
use crate::note_store::{self, StoreError};
use crate::observe::{self, Level, log};
use crate::projection;
use crate::protocol::{self, Kind, awareness, sync};

/// Broadcasts merge over this window (approved by Epo, 2026-10-04).
pub const FLUSH_WINDOW: Duration = Duration::from_millis(30);
/// Checkpoint requests waiting per room.
const MAX_PENDING_CHECKPOINTS: usize = 64;
const MAX_CHECKPOINT_ID: usize = 128;
/// Consecutive unplaceable step 2 replies before a channel closes.
pub const MAX_UNPLACED_STEPS: u32 = 2;
/// Failed stores retry after 5 s, doubling to 60 s.
const RETRY_FIRST: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(60);

pub type MemberKey = (u64, u64);

/// Messages to a room task.
pub enum RoomCmd {
    Join {
        key: MemberKey,
        context: Context,
        out: Outbox,
        socket: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Leave(MemberKey),
    Sync(MemberKey, bytes::Bytes),
    Awareness(MemberKey, bytes::Bytes),
    QueryAwareness(MemberKey),
    Stateless(MemberKey, String),
    Token(MemberKey, Context),
    /// A store's I/O finished.
    Stored(Box<StoreDone>),
    /// A projection finished.
    Projected(i64, Result<(), String>),
    /// Store now (if anything is unsaved) and answer once it is durable.
    Persist(oneshot::Sender<Result<(), String>>),
    /// Persist, then project, and answer with the projected version.
    Project(oneshot::Sender<Result<i64, String>>),
    /// Send every channel a stateless message.
    Broadcast(String),
    /// An eviction (DESIGN.md 9): drain stores and closes, discard throws
    /// unsaved state away; both close every channel after `notification`.
    Evict {
        drain: bool,
        notification: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Close every channel of a user (account access changed).
    CloseUser(String, u16, String),
    /// A fold of the log finished: rows and bytes it removed, the new base size.
    Folded(Option<(i64, i64, i64)>),
}

struct Member {
    context: Context,
    read_only: bool,
    out: Outbox,
    socket: String,
    /// Awareness client ids this channel sent.
    clients: HashSet<u64>,
    /// Consecutive unplaceable step 2 replies.
    unplaced: u32,
    /// Update and step 2 messages handled since the last ACK.
    acks: u64,
}

struct AwarenessEntry {
    entry: awareness::Entry,
    owner: Option<MemberKey>,
}

/// A note room's own state.
struct Note {
    material_id: String,
    schema: i64,
    kind: String,
    validator: notes::limits::Validator,
    durable_metrics: Option<notes::limits::Metrics>,
    stored_version: i64,
    projected_version: i64,
    projecting: bool,
    project_waiters: Vec<oneshot::Sender<Result<i64, String>>>,
    log_bytes: i64,
    log_rows: i64,
    base_bytes: i64,
    folding: bool,
}

/// What a store carried, back from its I/O.
pub struct StoreDone {
    result: Result<i64, StoreError>,
    started: Instant,
    row_bytes: usize,
    contributors: Vec<Contributor>,
    claimed: Vec<String>,
    durable: ydoc::Durable,
    metrics: Option<notes::limits::Metrics>,
    limit_code: Option<notes::limits::LimitCode>,
}

enum Kindly {
    Note(Box<Note>),
}

struct Store {
    /// Content changed since the last snapshot.
    dirty: bool,
    first_change: Option<Instant>,
    last_change: Option<Instant>,
    running: bool,
    /// Store again right after the running one.
    again: bool,
    /// A failed store's retry (backoff) and its first event.
    retry_at: Option<Instant>,
    retry_delay: Duration,
    failed_event: Option<String>,
    waiters: Vec<oneshot::Sender<Result<(), String>>>,
}

pub struct Room {
    app: Shared,
    id: u64,
    name: String,
    doc: Doc,
    captured: Arc<Mutex<Vec<u8>>>,
    _subscription: yrs::Subscription,
    members: HashMap<MemberKey, Member>,
    awareness: HashMap<u64, AwarenessEntry>,
    changed_awareness: BTreeSet<u64>,
    /// This window's updates and who sent each (none: everyone gets it).
    window: Vec<(Option<MemberKey>, Vec<u8>)>,
    flush_at: Option<Instant>,
    markers: Markers,
    receipts: Vec<String>,
    durable: ydoc::Durable,
    store: Store,
    idle_at: Option<Instant>,
    kind: Kindly,
    /// A refusal for good threw the unsaved state away: the room unloads and
    /// moves its lineage before it is accepted again.
    discard_pending: Option<Cause>,
}

/// Spawns a room task; its handle goes into the registry.
pub fn spawn(app: &Shared, name: &RoomName, id: u64) -> RoomHandle {
    let (tx, rx) = mpsc::channel(4096);
    let app = app.clone();
    let name = name.clone();
    tokio::spawn(async move {
        run(app, name, id, rx).await;
    });
    RoomHandle { id, tx }
}

/// Picks a client id the loaded state does not hold (markers and server
/// edits are written under it).
fn fresh_doc(held: &StateVector) -> Doc {
    loop {
        let doc = Doc::with_options(ydoc::doc_options(0));
        if held.get(&doc.client_id()) == 0 {
            return doc;
        }
    }
}

async fn load(app: &Shared, name: &RoomName) -> Result<(Doc, Kindly, ydoc::Durable), String> {
    match name {
        RoomName::Material {
            material_id,
            schema,
        } => {
            let loaded = note_store::load(&app.db, material_id, *schema)
                .await
                .map_err(|error| error.to_string())?;
            let kind = loaded.material_kind.clone();
            let (log_rows, base_bytes) = (loaded.rows.len() as i64, loaded.base.len() as i64);
            let (stored_version, projected_version, log_bytes) = (
                loaded.stored_version,
                loaded.projected_version,
                loaded.log_bytes,
            );
            let (doc, durable, metrics) =
                tokio::task::spawn_blocking(move || -> Result<_, String> {
                    let scratch = ydoc::scratch_doc();
                    ydoc::replay(&scratch, &loaded.base, &loaded.rows)
                        .map_err(|error| error.to_string())?;
                    let held = scratch.transact().state_vector();
                    let state = scratch
                        .transact()
                        .encode_state_as_update_v1(&StateVector::default());
                    let doc = fresh_doc(&held);
                    {
                        let mut txn = doc.transact_mut();
                        txn.apply_update(ydoc::decode(&state).map_err(|error| error.to_string())?)
                            .map_err(|error| error.to_string())?;
                    }
                    let txn = doc.transact();
                    notes::validate::assert_roots(&txn).map_err(|error| error.to_string())?;
                    markers::contributors(&doc).map_err(|error| error.to_string())?;
                    let metrics =
                        notes::limits::measure(&txn).map_err(|error| error.to_string())?;
                    let durable = ydoc::Durable::of(&txn);
                    drop(txn);
                    Ok((doc, durable, metrics))
                })
                .await
                .map_err(|error| error.to_string())??;
            let note = Note {
                material_id: material_id.clone(),
                schema: *schema,
                kind,
                validator: notes::limits::Validator::default(),
                durable_metrics: Some(metrics),
                stored_version,
                projected_version,
                projecting: false,
                project_waiters: Vec::new(),
                log_bytes,
                log_rows,
                base_bytes,
                folding: false,
            };
            Ok((doc, Kindly::Note(Box::new(note)), durable))
        }
        RoomName::Source { .. } => Err("source rooms are not served yet".into()),
    }
}

async fn run(app: Shared, name: RoomName, id: u64, mut rx: mpsc::Receiver<RoomCmd>) {
    let room_name = name.to_string();
    let started = Instant::now();
    let loaded = load(&app, &name).await;
    let (doc, kind, durable) = match loaded {
        Ok(loaded) => loaded,
        Err(error) => {
            observe::capture(
                &error,
                None,
                &[("room", &room_name), ("stage", "room_load")],
            );
            // Refuse every queued join; the next join loads again.
            app.rooms.remove_if(&room_name, id, || true);
            rx.close();
            while let Some(command) = rx.recv().await {
                if let RoomCmd::Join { reply, .. } = command {
                    let _ = reply.send(Err(error.clone()));
                }
            }
            return;
        }
    };
    let captured: Arc<Mutex<Vec<u8>>> = Arc::default();
    let sink = captured.clone();
    #[allow(clippy::expect_used)]
    let subscription = doc
        .observe_update_v1(move |_, event| {
            #[allow(clippy::unwrap_used)]
            sink.lock().unwrap().extend_from_slice(&event.update);
        })
        .expect("a fresh document takes an observer");
    let bytes = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default())
        .len();
    log(
        Level::Info,
        "room_load",
        json!({ "bytes": bytes, "ms": started.elapsed().as_millis() as u64, "room": room_name }),
    );
    let mut room = Room {
        markers: Markers::new(&app.instance_id),
        app,
        id,
        name: room_name,
        doc,
        captured,
        _subscription: subscription,
        members: HashMap::new(),
        awareness: HashMap::new(),
        changed_awareness: BTreeSet::new(),
        window: Vec::new(),
        flush_at: None,
        receipts: Vec::new(),
        durable,
        store: Store {
            dirty: false,
            first_change: None,
            last_change: None,
            running: false,
            again: false,
            retry_at: None,
            retry_delay: RETRY_FIRST / 2,
            failed_event: None,
            waiters: Vec::new(),
        },
        idle_at: None,
        kind,
        discard_pending: None,
    };
    let Kindly::Note(note) = &room.kind;
    room.app
        .stats
        .log_bytes
        .fetch_add(note.log_bytes.max(0) as u64, Ordering::Relaxed);
    room.serve(&mut rx).await;
}

impl Room {
    async fn serve(&mut self, rx: &mut mpsc::Receiver<RoomCmd>) {
        loop {
            let deadline = self.next_deadline();
            tokio::select! {
                command = rx.recv() => match command {
                    Some(command) => self.handle(command).await,
                    None => return,
                },
                () = sleep_until(deadline) => self.on_timers().await,
            }
            if self.unloadable() {
                let id = self.id;
                let removed = self.app.rooms.remove_if(&self.name, id, || rx.is_empty());
                if removed {
                    rx.close();
                    // Joins that slipped in after the lookup fail and look up again.
                    while let Ok(command) = rx.try_recv() {
                        if let RoomCmd::Join { reply, .. } = command {
                            let _ = reply.send(Err("room unloaded".into()));
                        }
                    }
                    self.unload().await;
                    return;
                }
            }
        }
    }

    fn next_deadline(&self) -> Option<Instant> {
        [self.flush_at, self.store_due(), self.idle_at]
            .into_iter()
            .flatten()
            .min()
    }

    fn store_due(&self) -> Option<Instant> {
        if self.store.running {
            return None;
        }
        if let Some(retry) = self.store.retry_at {
            return Some(retry);
        }
        if !self.store.dirty {
            return None;
        }
        let (debounce, max) = (self.app.config.debounce, self.app.config.max_debounce);
        let last = self.store.last_change? + debounce;
        let first = self.store.first_change? + max;
        Some(last.min(first))
    }

    async fn on_timers(&mut self) {
        let now = Instant::now();
        if self.flush_at.is_some_and(|at| at <= now) {
            self.flush();
        }
        if self.store_due().is_some_and(|at| at <= now) {
            self.store.retry_at = None;
            self.start_store().await;
        }
        if self.idle_at.is_some_and(|at| at <= now) {
            self.idle_at = None;
            self.start_projection().await;
        }
    }

    fn unloadable(&self) -> bool {
        if self.discard_pending.is_some() {
            return self.members.is_empty() && !self.store.running;
        }
        self.members.is_empty()
            && !self.store.dirty
            && !self.store.running
            && self.store.retry_at.is_none()
            && self.store.waiters.is_empty()
            && !markers::pending(&self.doc)
    }

    async fn handle(&mut self, command: RoomCmd) {
        match command {
            RoomCmd::Join {
                key,
                context,
                out,
                socket,
                reply,
            } => {
                let _ = reply.send(self.join(key, context, out, socket));
            }
            RoomCmd::Leave(key) => self.leave(key),
            RoomCmd::Sync(key, payload) => self.on_sync(key, &payload),
            RoomCmd::Awareness(key, payload) => self.on_awareness(key, &payload),
            RoomCmd::QueryAwareness(key) => self.send_awareness_states(key),
            RoomCmd::Stateless(key, payload) => self.on_stateless(key, &payload).await,
            RoomCmd::Token(key, context) => {
                if let Some(member) = self.members.get_mut(&key) {
                    member.read_only = context.access == Access::Read;
                    member.context = context;
                }
            }
            RoomCmd::Stored(done) => self.stored(*done),
            RoomCmd::Projected(version, result) => self.projected(version, result),
            RoomCmd::Persist(reply) => {
                if !self.store.dirty
                    && !self.store.running
                    && !markers::pending(&self.doc)
                    && self.store.retry_at.is_none()
                {
                    let _ = reply.send(Ok(()));
                } else {
                    self.store.waiters.push(reply);
                    self.start_store().await;
                }
            }
            RoomCmd::Project(reply) => {
                let Kindly::Note(note) = &mut self.kind;
                note.project_waiters.push(reply);
                if self.store.dirty || markers::pending(&self.doc) {
                    self.start_store().await;
                } else {
                    self.start_projection().await;
                }
            }
            RoomCmd::Broadcast(payload) => self.broadcast_stateless(&payload),
            RoomCmd::Evict {
                drain,
                notification,
                reply,
            } => self.evict(drain, notification, reply).await,
            RoomCmd::CloseUser(user, code, reason) => {
                let keys: Vec<MemberKey> = self
                    .members
                    .iter()
                    .filter(|(_, member)| member.context.user_id == user)
                    .map(|(key, _)| *key)
                    .collect();
                for key in keys {
                    self.close_channel(key, None, code, &reason);
                }
            }
            RoomCmd::Folded(folded) => {
                let Kindly::Note(note) = &mut self.kind;
                note.folding = false;
                if let Some((rows, bytes, base)) = folded {
                    note.log_rows -= rows;
                    note.log_bytes -= bytes;
                    note.base_bytes = base;
                    self.app
                        .stats
                        .log_bytes
                        .fetch_sub(bytes.max(0) as u64, Ordering::Relaxed);
                }
            }
        }
    }

    /// Sends `notification` (if any) and CLOSED, and forgets the channel.
    fn close_channel(
        &mut self,
        key: MemberKey,
        notification: Option<&str>,
        code: u16,
        reason: &str,
    ) {
        if let Some(payload) = notification {
            self.send(key, Kind::Stateless, &protocol::text(payload));
        }
        self.send(key, Kind::Closed, &protocol::closed(code, reason));
        if let Some(member) = self.members.get(&key) {
            member.out.channel_closed(key.1);
        }
        self.leave(key);
    }

    /// `evictLocalRoom` on this room: every channel hears the notification and
    /// closes. A drain stores first and answers with the store's outcome; a
    /// discard throws unsaved state away and moves the lineage when it held
    /// any (`discardMovesLineage`).
    async fn evict(
        &mut self,
        drain: bool,
        notification: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    ) {
        let client = notification.as_deref().map(incidents::client_payload);
        let keys: Vec<MemberKey> = self.members.keys().copied().collect();
        for key in keys {
            self.close_channel(key, client.as_deref(), 0, "collaboration room evicted");
        }
        self.flush();
        if drain {
            if self.nothing_to_store() {
                let _ = reply.send(Ok(()));
            } else {
                self.store.waiters.push(reply);
                self.start_store().await;
            }
            return;
        }
        let unsaved =
            self.store.dirty || self.store.retry_at.is_some() || markers::pending(&self.doc);
        if unsaved && self.discard_pending.is_none() {
            let cause = incidents::broadcast_cause(notification.as_deref());
            self.record_room_incidents(&cause, None);
            self.app.evictions.reject(&self.name);
            self.discard_pending = Some(cause);
        }
        self.store.dirty = false;
        self.store.retry_at = None;
        self.answer_store_waiters(Err("collaboration room discarded".into()));
        let _ = reply.send(Ok(()));
    }

    /// `roomIncidents`: one incident per writer with unsaved work in the room,
    /// or one naming nobody.
    fn record_room_incidents(&self, cause: &Cause, bytes: Option<u64>) {
        let users: BTreeSet<String> = markers::contributors(&self.doc)
            .unwrap_or_default()
            .into_iter()
            .map(|c| c.user_id)
            .collect();
        let size = bytes.or_else(|| {
            Some(
                self.doc
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default())
                    .len() as u64,
            )
        });
        let list: Vec<Incident> = if users.is_empty() {
            vec![Incident {
                cause: cause.clone(),
                room: self.name.clone(),
                size_bytes: size,
                user_id: None,
            }]
        } else {
            users
                .into_iter()
                .map(|user| Incident {
                    cause: cause.clone(),
                    room: self.name.clone(),
                    size_bytes: size,
                    user_id: Some(user),
                })
                .collect()
        };
        incidents::record(&self.app, list);
    }

    /// Folds the log once it passes the configured size (DESIGN.md 3.5).
    fn maybe_fold(&mut self) {
        let (min_bytes, max_rows) = (
            self.app.config.fold_min_bytes as i64,
            self.app.config.fold_max_rows as i64,
        );
        let Kindly::Note(note) = &mut self.kind;
        if note.folding
            || (note.log_bytes < min_bytes.max(note.base_bytes) && note.log_rows < max_rows)
        {
            return;
        }
        let Some(handle) = self
            .app
            .rooms
            .get(&self.name)
            .filter(|handle| handle.id == self.id)
        else {
            return;
        };
        note.folding = true;
        let (app, material_id, schema, through) = (
            self.app.clone(),
            note.material_id.clone(),
            note.schema,
            note.stored_version,
        );
        tokio::spawn(async move {
            let folded = match note_store::fold(&app.db, &material_id, schema, Some(through)).await
            {
                Ok(folded) => folded.map(|f| (f.rows as i64, f.log_bytes, f.base_bytes)),
                Err(error) => {
                    observe::capture(
                        &error.to_string(),
                        None,
                        &[("room", &material_id), ("stage", "fold")],
                    );
                    None
                }
            };
            let _ = handle.tx.send(RoomCmd::Folded(folded)).await;
        });
    }

    // ---------------------------------------------------------------- channels

    fn send(&self, key: MemberKey, kind: Kind, payload: &[u8]) {
        if let Some(member) = self.members.get(&key) {
            member.out.frame(protocol::message(key.1, kind, payload));
        }
    }

    fn join(
        &mut self,
        key: MemberKey,
        context: Context,
        out: Outbox,
        socket: String,
    ) -> Result<(), String> {
        if self.app.evictions.blocks(&self.name, false) {
            return Err("collaboration room is being reset".into());
        }
        let read_only = context.access == Access::Read;
        out.frame(protocol::message(
            key.1,
            Kind::Joined,
            &[u8::from(!read_only)],
        ));
        self.members.insert(
            key,
            Member {
                context,
                read_only,
                out,
                socket,
                clients: HashSet::new(),
                unplaced: 0,
                acks: 0,
            },
        );
        let sv = self.doc.transact().state_vector();
        use yrs::updates::encoder::Encode;
        self.send(key, Kind::Sync, &sync::encode(sync::STEP1, &sv.encode_v1()));
        if !self.awareness.is_empty() {
            self.send_awareness_states(key);
        }
        Ok(())
    }

    fn leave(&mut self, key: MemberKey) {
        let Some(member) = self.members.remove(&key) else {
            return;
        };
        // Its awareness states go, as Hocuspocus removes a closed connection's.
        for client in member.clients {
            if let Some(state) = self.awareness.get_mut(&client) {
                if !state.entry.removed() {
                    state.entry.clock += 1;
                    state.entry.state = "null".into();
                }
                state.owner = None;
                self.changed_awareness.insert(client);
            }
        }
        if !self.changed_awareness.is_empty() {
            self.schedule_flush();
        }
    }

    /// Refuses a channel for good: it hears why (`payloads`), then CLOSED.
    fn refuse(&mut self, key: MemberKey, payloads: &[String], reason: &str) {
        for payload in payloads {
            self.send(key, Kind::Stateless, &protocol::text(payload));
        }
        self.send(key, Kind::Closed, &protocol::closed(0, reason));
        if let Some(member) = self.members.get(&key) {
            member.out.channel_closed(key.1);
        }
        self.leave(key);
    }

    fn schedule_flush(&mut self) {
        if self.flush_at.is_none() {
            self.flush_at = Some(Instant::now() + FLUSH_WINDOW);
        }
    }

    /// The window goes out: each channel gets the merge of the updates it did
    /// not send, the awareness of clients it does not own and its ACK, in one
    /// frame.
    fn flush(&mut self) {
        self.flush_at = None;
        let window = std::mem::take(&mut self.window);
        let senders: HashSet<MemberKey> = window.iter().filter_map(|(sender, _)| *sender).collect();
        let everyone = merge(window.iter().map(|(_, update)| update.as_slice()));
        let changed: Vec<u64> = std::mem::take(&mut self.changed_awareness)
            .into_iter()
            .collect();
        let keys: Vec<MemberKey> = self.members.keys().copied().collect();
        for key in keys {
            let mut frame = BytesMut::new();
            let update = if senders.contains(&key) {
                merge(
                    window
                        .iter()
                        .filter(|(sender, _)| *sender != Some(key))
                        .map(|(_, update)| update.as_slice()),
                )
            } else {
                everyone.clone()
            };
            if let Some(update) = update {
                protocol::encode(
                    &mut frame,
                    key.1,
                    Kind::Sync,
                    &sync::encode(sync::UPDATE, &update),
                );
            }
            let Some(member) = self.members.get_mut(&key) else {
                continue;
            };
            let entries: Vec<&awareness::Entry> = changed
                .iter()
                .filter(|client| !member.clients.contains(client))
                .filter_map(|client| self.awareness.get(client).map(|state| &state.entry))
                .collect();
            if !entries.is_empty() {
                protocol::encode(
                    &mut frame,
                    key.1,
                    Kind::Awareness,
                    &awareness::encode(entries.into_iter()),
                );
            }
            if member.acks > 0 {
                protocol::encode(&mut frame, key.1, Kind::Ack, &protocol::ack(member.acks));
                member.acks = 0;
            }
            if !frame.is_empty() {
                member.out.frame(frame.freeze());
            }
        }
        // Removed clients are forgotten once their removal went out.
        self.awareness
            .retain(|_, state| !(state.entry.removed() && state.owner.is_none()));
    }

    /// The bytes a transaction produced (the observer's capture).
    fn take_captured(&self) -> Vec<u8> {
        #[allow(clippy::unwrap_used)]
        std::mem::take(&mut *self.captured.lock().unwrap())
    }

    fn broadcast_update(&mut self, sender: Option<MemberKey>, update: Vec<u8>) {
        if update.is_empty() {
            return;
        }
        self.window.push((sender, update));
        self.schedule_flush();
    }

    fn broadcast_stateless(&self, payload: &str) {
        let text = protocol::text(payload);
        for key in self.members.keys() {
            self.send(*key, Kind::Stateless, &text);
        }
    }

    // ------------------------------------------------------------- sync and updates

    fn on_sync(&mut self, key: MemberKey, payload: &[u8]) {
        if !self.members.contains_key(&key) {
            return;
        }
        let Ok((kind, body)) = sync::decode(payload) else {
            self.refuse(key, &[], "malformed sync message");
            return;
        };
        if kind == sync::STEP1 {
            use yrs::updates::decoder::Decode;
            let Ok(sv) = StateVector::decode_v1(body) else {
                self.refuse(key, &[], "malformed state vector");
                return;
            };
            let diff = self.doc.transact().encode_state_as_update_v1(&sv);
            self.send(key, Kind::Sync, &sync::encode(sync::STEP2, &diff));
            return;
        }
        self.app.stats.updates.fetch_add(1, Ordering::Relaxed);
        self.on_update(key, body, kind == sync::STEP2);
    }

    fn on_update(&mut self, key: MemberKey, bytes: &[u8], step2: bool) {
        if self.app.evictions.blocks(&self.name, false) {
            self.refuse(key, &[], "collaboration room is being reset");
            return;
        }
        let Some(member) = self.members.get(&key) else {
            return;
        };
        let context = member.context.clone();
        let read_only = member.read_only;
        if context.expires_at <= crate::auth::now_seconds() {
            self.refuse(key, &[], "collaboration token expired");
            return;
        }
        let Ok(update) = ydoc::decode(bytes) else {
            self.refuse(key, &[], "malformed update");
            return;
        };
        let changes = ydoc::contains_changes(&self.doc.transact(), &update);
        if read_only {
            if changes {
                self.refuse(key, &[], "read-only connection sent a document update");
                return;
            }
            self.acked(key);
            return;
        }
        if markers::check(&self.doc.transact(), &update, self.doc.client_id()).is_err() {
            self.refuse(key, &[], "client update changed collaboration metadata");
            return;
        }
        let admission = match &mut self.kind {
            Kindly::Note(note) => note.validator.admit(&self.doc, bytes),
        };
        match admission {
            Ok(notes::limits::Admission::Unheld) => {
                self.resync(key, step2, &context);
                return;
            }
            Ok(notes::limits::Admission::Accepted) => {}
            Err(notes::limits::Refusal::Limit { code, metrics }) => {
                let payload = self.rejection_payload(code, metrics, None);
                incidents::record(
                    &self.app,
                    vec![Incident {
                        cause: Cause::new(IncidentKind::OverLimit, code.as_str()),
                        room: self.name.clone(),
                        size_bytes: Some(bytes.len() as u64),
                        user_id: Some(context.user_id.clone()),
                    }],
                );
                self.refuse(key, &[payload], "invalid material document");
                return;
            }
            Err(error) => {
                self.refuse(key, &[], &error.to_string());
                return;
            }
        }
        if let Some(member) = self.members.get_mut(&key) {
            member.unplaced = 0;
        }
        self.app.unplaced.placed(&self.name, &context.user_id);
        if !changes {
            self.acked(key);
            return;
        }
        if self.markers.write(&self.doc, &context) {
            let marker = self.take_captured();
            self.broadcast_update(None, marker);
        }
        let applied = self.doc.transact_mut().apply_update(update);
        let content = self.take_captured();
        if let Err(error) = applied {
            self.refuse(key, &[], &format!("update cannot be applied: {error}"));
            return;
        }
        self.acked(key);
        if !content.is_empty() {
            self.content_changed();
            self.broadcast_update(Some(key), content);
        }
    }

    fn acked(&mut self, key: MemberKey) {
        if let Some(member) = self.members.get_mut(&key) {
            member.acks += 1;
            self.schedule_flush();
        }
    }

    fn content_changed(&mut self) {
        let now = Instant::now();
        self.store.dirty = true;
        self.store.first_change.get_or_insert(now);
        self.store.last_change = Some(now);
        self.idle_at = None;
    }

    /// `resyncUnheld`: drop the update and send the channel step 1; the
    /// client's step 2 brings everything the room lacks. Two unplaceable step
    /// 2 replies in a row close the channel.
    fn resync(&mut self, key: MemberKey, step2: bool, context: &Context) {
        let Some(member) = self.members.get_mut(&key) else {
            return;
        };
        member.unplaced = if step2 { member.unplaced + 1 } else { 0 };
        if member.unplaced >= MAX_UNPLACED_STEPS {
            let socket = member.socket.clone();
            let kind = "note";
            let stage = format!("{kind}_step2_unplaced");
            observe::capture(
                &format!("{kind} sync step 2 cannot be placed in the room"),
                None,
                &[
                    ("room", &self.name),
                    ("socket_id", &socket),
                    ("stage", &stage),
                    ("user_id", &context.user_id),
                ],
            );
            if self.app.unplaced.first(&self.name, &context.user_id) {
                incidents::record(
                    &self.app,
                    vec![Incident {
                        cause: Cause {
                            kind: IncidentKind::Step2Unplaced,
                            reason: None,
                        },
                        room: self.name.clone(),
                        size_bytes: None,
                        user_id: Some(context.user_id.clone()),
                    }],
                );
            }
            self.refuse(key, &[], "sync step 2 cannot be placed in the room");
            return;
        }
        use yrs::updates::encoder::Encode;
        let sv = self.doc.transact().state_vector().encode_v1();
        self.send(key, Kind::Sync, &sync::encode(sync::STEP1, &sv));
        // Handled (dropped for the resync): its ACK follows the step 1.
        self.acked(key);
    }

    fn rejection_payload(
        &self,
        code: notes::limits::LimitCode,
        metrics: notes::limits::Metrics,
        eviction: Option<&str>,
    ) -> String {
        let Kindly::Note(note) = &self.kind;
        let mut payload = json!({
            "code": code.as_str(),
            "limits": {
                "maxContentBytes": notes::limits::MAX_CONTENT_BYTES,
                "maxDepth": notes::limits::MAX_DEPTH,
                "maxNodes": notes::limits::MAX_NODES,
            },
            "materialId": note.material_id,
            "metrics": metrics,
            "room": self.name,
            "type": "document-rejected",
        });
        if let Some(eviction) = eviction {
            payload["evictionId"] = json!(eviction);
        }
        payload.to_string()
    }

    // ------------------------------------------------------------------ awareness

    fn on_awareness(&mut self, key: MemberKey, payload: &[u8]) {
        self.app.stats.awareness.fetch_add(1, Ordering::Relaxed);
        let Ok(entries) = awareness::decode(payload) else {
            self.refuse(key, &[], "malformed awareness update");
            return;
        };
        let Some(member) = self.members.get_mut(&key) else {
            return;
        };
        for entry in entries {
            let current = self.awareness.get(&entry.client);
            // y-protocols: a newer clock wins; at the same clock a removal wins.
            let take = match current {
                None => !entry.removed(),
                Some(state) => {
                    state.entry.clock < entry.clock
                        || (state.entry.clock == entry.clock
                            && entry.removed()
                            && !state.entry.removed())
                }
            };
            if !take {
                continue;
            }
            if entry.removed() {
                member.clients.remove(&entry.client);
            } else {
                member.clients.insert(entry.client);
            }
            self.changed_awareness.insert(entry.client);
            self.awareness.insert(
                entry.client,
                AwarenessEntry {
                    owner: (!entry.removed()).then_some(key),
                    entry,
                },
            );
        }
        if !self.changed_awareness.is_empty() {
            self.schedule_flush();
        }
    }

    fn send_awareness_states(&self, key: MemberKey) {
        let entries: Vec<&awareness::Entry> = self
            .awareness
            .values()
            .filter(|state| !state.entry.removed())
            .map(|state| &state.entry)
            .collect();
        if !entries.is_empty() {
            self.send(
                key,
                Kind::Awareness,
                &awareness::encode(entries.into_iter()),
            );
        }
    }

    // ------------------------------------------------------------------ stateless

    async fn on_stateless(&mut self, key: MemberKey, payload: &str) {
        let Some(member) = self.members.get(&key) else {
            return;
        };
        if member.context.expires_at <= crate::auth::now_seconds() {
            self.refuse(key, &[], "collaboration token expired");
            return;
        }
        let Ok(event) = serde_json::from_str::<Value>(payload) else {
            return;
        };
        if event["type"] != "checkpoint-request" || member.read_only {
            return;
        }
        let Some(id) = event["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= MAX_CHECKPOINT_ID)
        else {
            return;
        };
        // A note room with nothing waiting to be saved answers at once.
        if self.nothing_to_store() {
            let Kindly::Note(note) = &self.kind;
            let receipt = json!({ "checkpointIds": [id], "materialId": note.material_id, "type": "checkpoint-persisted" });
            self.send(key, Kind::Stateless, &protocol::text(&receipt.to_string()));
            return;
        }
        if self.receipts.len() >= MAX_PENDING_CHECKPOINTS {
            return;
        }
        if !self.receipts.iter().any(|known| known == id) {
            self.receipts.push(id.to_owned());
        }
    }

    /// `nothingToStore`: no store due or running, no failed snapshot, and no
    /// writer's update newer than the durable state.
    fn nothing_to_store(&self) -> bool {
        !self.store.dirty
            && !self.store.running
            && self.store.retry_at.is_none()
            && !markers::pending(&self.doc)
    }

    // ---------------------------------------------------------------------- stores

    async fn start_store(&mut self) {
        if self.store.running {
            self.store.again = true;
            return;
        }
        if self.app.evictions.blocks(&self.name, true) {
            return;
        }
        if !self.store.dirty && !markers::pending(&self.doc) {
            self.answer_store_waiters(Ok(()));
            return;
        }
        let contributors = match self.markers.claim(&self.doc) {
            Ok(contributors) => contributors,
            Err(error) => {
                self.store_failed(
                    StoreError::Other(error.to_string()),
                    Instant::now(),
                    0,
                    Vec::new(),
                );
                return;
            }
        };
        let claimed = self.receipts.clone();
        self.store.dirty = false;
        self.store.first_change = None;
        let hidden = markers::live_items(&self.doc);
        let (row, durable) = ydoc::delta_update(&self.doc.transact(), &self.durable, &hidden);
        let started = Instant::now();
        let Kindly::Note(note) = &self.kind;
        let doc = self.doc.clone();
        let kind = note.kind.clone();
        let previous = note.durable_metrics;
        let validated = tokio::task::spawn_blocking(move || validate(&doc, &kind, previous))
            .await
            .unwrap_or_else(|error| Err(StoreError::Other(error.to_string())));
        let (metrics, limit_code) = match validated {
            Ok(validated) => validated,
            Err(error) => {
                self.markers.unclaim(&contributors);
                self.store.dirty = true;
                self.store.first_change.get_or_insert(started);
                self.store_failed(error, started, row.len(), claimed);
                return;
            }
        };
        self.store.running = true;
        let app = self.app.clone();
        let Kindly::Note(note) = &self.kind;
        let (material_id, schema) = (note.material_id.clone(), note.schema);
        let actors: Vec<String> = {
            let mut actors: Vec<String> = contributors.iter().map(|c| c.user_id.clone()).collect();
            actors.sort();
            actors.dedup();
            actors
        };
        let Some(handle) = self
            .app
            .rooms
            .get(&self.name)
            .filter(|handle| handle.id == self.id)
        else {
            return;
        };
        tokio::spawn(async move {
            let result = note_store::append(&app.db, &material_id, schema, &row, &actors).await;
            let done = StoreDone {
                result,
                started,
                row_bytes: row.len(),
                contributors,
                claimed,
                durable,
                metrics: Some(metrics),
                limit_code,
            };
            let _ = handle.tx.send(RoomCmd::Stored(Box::new(done))).await;
        });
    }

    fn stored(&mut self, done: StoreDone) {
        self.store.running = false;
        let StoreDone {
            result,
            started,
            row_bytes,
            contributors,
            claimed,
            durable,
            metrics,
            limit_code,
        } = done;
        match result {
            Ok(version) => {
                self.app
                    .health
                    .material
                    .record(started.elapsed(), true, row_bytes, &self.name);
                self.durable = durable;
                if self.store.failed_event.take().is_some() {
                    self.app.stats.failed_stores.fetch_sub(1, Ordering::Relaxed);
                }
                self.store.retry_delay = RETRY_FIRST / 2;
                if self.markers.clear(&self.doc, &contributors) {
                    let cleared = self.take_captured();
                    self.broadcast_update(None, cleared);
                }
                let Kindly::Note(note) = &mut self.kind;
                note.stored_version = version;
                note.durable_metrics = metrics;
                note.log_bytes += row_bytes as i64;
                note.log_rows += 1;
                self.app
                    .stats
                    .log_bytes
                    .fetch_add(row_bytes as u64, Ordering::Relaxed);
                let material_id = note.material_id.clone();
                // Claimed receipts, and every waiting one when no writer's
                // update reached the room after the snapshot.
                let mut ids: Vec<String> = Vec::new();
                let everything = !markers::pending(&self.doc) && !self.store.dirty;
                self.receipts.retain(|id| {
                    if everything || claimed.contains(id) {
                        ids.push(id.clone());
                        false
                    } else {
                        true
                    }
                });
                let receipt = json!({
                    "checkpointIds": ids,
                    "limitCode": limit_code.map(|code| code.as_str()),
                    "materialId": material_id,
                    "metrics": metrics,
                    "type": "checkpoint-persisted",
                    "yjsVersion": version,
                });
                self.broadcast_stateless(&receipt.to_string());
                if self.store.dirty || markers::pending(&self.doc) {
                    if self.store.again {
                        self.store.again = false;
                        self.store.retry_at = Some(Instant::now());
                    }
                } else {
                    self.answer_store_waiters(Ok(()));
                    let Kindly::Note(note) = &self.kind;
                    if note.project_waiters.is_empty() {
                        self.arm_idle();
                    } else {
                        self.idle_at = Some(Instant::now());
                    }
                }
                self.maybe_fold();
            }
            Err(error) => {
                self.markers.unclaim(&contributors);
                self.store.dirty = true;
                self.store.first_change.get_or_insert(started);
                self.store_failed(error, started, row_bytes, claimed);
            }
        }
    }

    fn store_failed(
        &mut self,
        error: StoreError,
        started: Instant,
        bytes: usize,
        _claimed: Vec<String>,
    ) {
        self.app
            .health
            .material
            .record(started.elapsed(), false, bytes, &self.name);
        self.app
            .stats
            .store_failures
            .fetch_add(1, Ordering::Relaxed);
        if error.permanent() {
            self.answer_store_waiters(Err(error.to_string()));
            self.reject_after_store(&error, bytes);
            return;
        }
        let Kindly::Note(note) = &self.kind;
        let material_id = note.material_id.clone();
        self.broadcast_stateless(
            &json!({ "materialId": material_id, "type": "checkpoint-failed" }).to_string(),
        );
        // Reported once per run of failures; each one still logs its cause.
        match &self.store.failed_event {
            Some(event) => log(
                Level::Warn,
                "store failed again",
                json!({ "error": error.to_string(), "event_id": event, "room": self.name }),
            ),
            None => {
                self.app.stats.failed_stores.fetch_add(1, Ordering::Relaxed);
                let event = observe::capture(
                    &error.to_string(),
                    None,
                    &[("room", &self.name), ("stage", "document_store")],
                );
                self.store.failed_event = Some(event.unwrap_or_default());
            }
        }
        self.store.retry_delay = (self.store.retry_delay * 2).clamp(RETRY_FIRST, RETRY_MAX);
        self.store.retry_at = Some(Instant::now() + self.store.retry_delay);
        if self.store.waiters.iter().any(|_| true) {
            self.answer_store_waiters(Err(error.to_string()));
        }
    }

    fn answer_store_waiters(&mut self, result: Result<(), String>) {
        for waiter in self.store.waiters.drain(..) {
            let _ = waiter.send(result.clone());
        }
    }

    /// A store refused for good discards the room: every editor drops back to
    /// the last durable state (`rejectRoom`, `rejectInvalidDocumentRoom`,
    /// `rejectAuthorizationRoom`). The discard and lineage move come with the
    /// eviction module.
    fn reject_after_store(&mut self, error: &StoreError, bytes: usize) {
        let eviction = uuid::Uuid::new_v4().to_string();
        let payload = match error {
            StoreError::Limit { code, metrics } => self.rejection_payload(*code, *metrics, Some(&eviction)),
            StoreError::Invalid(_) => {
                let Kindly::Note(note) = &self.kind;
                json!({
                    "code": "invalid_document",
                    "evictionId": eviction,
                    "materialId": note.material_id,
                    "room": self.name,
                    "type": "document-rejected",
                })
                .to_string()
            }
            _ => json!({ "evictionId": eviction, "room": self.name, "type": "authorization-revoked" }).to_string(),
        };
        let cause = match error {
            StoreError::Limit { code, .. } => Cause::new(IncidentKind::OverLimit, code.as_str()),
            StoreError::Invalid(_) => Cause::new(IncidentKind::SaveRefused, "invalid_document"),
            other => Cause::new(IncidentKind::DiscardUnsaved, &other.incident_reason()),
        };
        self.app.evictions.reject(&self.name);
        self.record_room_incidents(&cause, Some(bytes as u64));
        self.broadcast_stateless(&incidents::client_payload(&payload));
        let keys: Vec<MemberKey> = self.members.keys().copied().collect();
        for key in keys {
            self.refuse(key, &[], "collaboration room is being reset");
        }
        // The unsaved state is thrown away with the room.
        self.store.dirty = false;
        self.store.retry_at = None;
        self.discard_pending = Some(cause);
    }

    // ---------------------------------------------------------------- projection

    fn arm_idle(&mut self) {
        let Kindly::Note(note) = &self.kind;
        if note.stored_version <= note.projected_version {
            return;
        }
        let from = self.store.last_change.unwrap_or_else(Instant::now);
        self.idle_at = Some((from + self.app.config.projection_idle).max(Instant::now()));
    }

    async fn start_projection(&mut self) {
        let Kindly::Note(note) = &mut self.kind;
        if note.projecting {
            return;
        }
        if note.stored_version <= note.projected_version || self.store.dirty {
            let version = note.projected_version;
            for waiter in note.project_waiters.drain(..) {
                let _ = waiter.send(Ok(version));
            }
            return;
        }
        note.projecting = true;
        let version = note.stored_version;
        let material_id = note.material_id.clone();
        let app = self.app.clone();
        // Read here, so the content is exactly the durable state at `version`;
        // the room waits for it as for a store's validation.
        let content = projection::content_of(self.doc.clone()).await;
        let Some(handle) = self
            .app
            .rooms
            .get(&self.name)
            .filter(|handle| handle.id == self.id)
        else {
            return;
        };
        tokio::spawn(async move {
            let result = match content {
                Ok(content) => projection::project(&app, &material_id, version, &content).await,
                Err(error) => Err(error),
            };
            let _ = handle.tx.send(RoomCmd::Projected(version, result)).await;
        });
    }

    fn projected(&mut self, version: i64, result: Result<(), String>) {
        let Kindly::Note(note) = &mut self.kind;
        note.projecting = false;
        match &result {
            Ok(()) => {
                note.projected_version = note.projected_version.max(version);
                let payload = json!({ "materialId": note.material_id, "type": "projection-updated", "yjsVersion": version });
                for waiter in note.project_waiters.drain(..) {
                    let _ = waiter.send(Ok(version));
                }
                self.broadcast_stateless(&payload.to_string());
            }
            Err(error) => {
                for waiter in note.project_waiters.drain(..) {
                    let _ = waiter.send(Err(error.clone()));
                }
            }
        }
    }

    // -------------------------------------------------------------------- unload

    async fn unload(&mut self) {
        let bytes = self
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
            .len();
        log(
            Level::Info,
            "room_unload",
            json!({ "bytes": bytes, "room": self.name }),
        );
        let Kindly::Note(note) = &self.kind;
        self.app
            .stats
            .log_bytes
            .fetch_sub(note.log_bytes.max(0) as u64, Ordering::Relaxed);
        let app = self.app.clone();
        let doc = self.doc.clone();
        let (material_id, schema, stored, projected) = (
            note.material_id.clone(),
            note.schema,
            note.stored_version,
            note.projected_version,
        );
        let discarded = self.discard_pending.take();
        let room = self.name.clone();
        tokio::spawn(async move {
            if let Some(cause) = discarded {
                crate::eviction::move_lineage(&app, &room, cause).await;
                return;
            }
            if stored > projected
                && let Err(error) = projection::project_doc(&app, &material_id, stored, doc).await
            {
                log(
                    Level::Warn,
                    "unload projection failed",
                    json!({ "error": error, "room": material_id }),
                );
            }
            // Compaction while the room is empty (DESIGN.md 3.5).
            if let Err(error) = note_store::fold(&app.db, &material_id, schema, None).await {
                observe::capture(
                    &error.to_string(),
                    None,
                    &[("room", &material_id), ("stage", "fold")],
                );
            }
        });
    }
}

/// Merges the window's updates; `None` when there are none.
fn merge<'a>(updates: impl Iterator<Item = &'a [u8]>) -> Option<Vec<u8>> {
    let updates: Vec<&[u8]> = updates.collect();
    match updates.len() {
        0 => None,
        1 => Some(updates[0].to_vec()),
        _ => yrs::merge_updates_v1(updates).ok(),
    }
}

/// The store's check of the whole document (DESIGN.md 3.2): the Plate value
/// is canonical for the material's kind, and over a bound only if it shrank.
fn validate(
    doc: &Doc,
    kind: &str,
    previous: Option<notes::limits::Metrics>,
) -> Result<(notes::limits::Metrics, Option<notes::limits::LimitCode>), StoreError> {
    let txn = doc.transact();
    notes::validate::assert_roots(&txn).map_err(|error| StoreError::Invalid(error.to_string()))?;
    let value =
        notes::plate::value(&txn).map_err(|error| StoreError::Invalid(error.to_string()))?;
    // PENDING rust-notes: the canonical material check (materialDocument.ts,
    // questions.ts) for this kind; until it lands only the roots and the
    // bounds are checked here.
    let _ = kind;
    let metrics = notes::limits::measure_value(&value);
    let code = notes::limits::limit_code(&metrics);
    if let Some(code) = code
        && !notes::limits::recovers(&metrics, previous.as_ref())
    {
        return Err(StoreError::Limit { code, metrics });
    }
    Ok((metrics, code))
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
        None => std::future::pending().await,
    }
}
