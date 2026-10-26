//! Shared server state: clients, the room registry, room eviction flags,
//! counters for `collab_health` and `/metrics`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use bytes::Bytes;
use tokio::sync::mpsc;

use crate::config::Config;
use crate::room::RoomCmd;

/// What a room sends a connection.
#[derive(Debug)]
pub enum Out {
    /// One WebSocket frame (one or more messages).
    Frame(Bytes),
    /// The room closed this channel (a refusal, a discard): the connection
    /// forgets it.
    ChannelClosed(u64),
}

/// A connection's outgoing queue, shared by every room it joined. A
/// connection whose backlog passes its cap is too slow and is closed (it
/// reconnects).
#[derive(Clone, Debug)]
pub struct Outbox {
    tx: mpsc::UnboundedSender<Out>,
    queued: Arc<AtomicUsize>,
    /// The largest frame this socket's rooms handed it so far.
    largest: Arc<AtomicUsize>,
    overflow: Arc<tokio::sync::Notify>,
    /// A frame was dropped: nothing more goes out on this socket, which
    /// closes (review r1 M1), so no later frame (a `stored` notice) reaches
    /// a reader that lacks the dropped one.
    dropped: Arc<AtomicBool>,
}

/// The least a socket's outgoing queue holds before its reader counts as
/// too slow (Epo 2026-10-08).
pub const OUTBOX_FLOOR: usize = 4 * 1024 * 1024;

impl Outbox {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<Out>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Outbox {
                tx,
                queued: Arc::default(),
                largest: Arc::default(),
                overflow: Arc::default(),
                dropped: Arc::default(),
            },
            rx,
        )
    }

    /// Queues a frame, or flags a reader too slow: one whose backlog passed
    /// max(4 MiB, the largest frame its rooms can send, as seen so far)
    /// before this frame (Epo 2026-10-08). A frame itself always fits, so a
    /// joiner's whole-state answer goes out. Once one was dropped, every
    /// later one is too.
    pub fn frame(&self, frame: Bytes) {
        if self.dropped.load(Ordering::Relaxed) {
            return;
        }
        let largest = self
            .largest
            .fetch_max(frame.len(), Ordering::Relaxed)
            .max(frame.len());
        let backlog = self.queued.fetch_add(frame.len(), Ordering::Relaxed);
        if backlog > OUTBOX_FLOOR.max(largest) {
            self.queued.fetch_sub(frame.len(), Ordering::Relaxed);
            self.dropped.store(true, Ordering::Relaxed);
            self.overflow.notify_one();
            return;
        }
        let _ = self.tx.send(Out::Frame(frame));
    }

    pub fn channel_closed(&self, channel: u64) {
        let _ = self.tx.send(Out::ChannelClosed(channel));
    }

    /// The writer took `bytes` off the queue.
    pub fn sent(&self, bytes: usize) {
        self.queued.fetch_sub(bytes, Ordering::Relaxed);
    }

    pub fn overflow(&self) -> Arc<tokio::sync::Notify> {
        self.overflow.clone()
    }
}

#[derive(Clone)]
pub struct RoomHandle {
    pub id: u64,
    pub tx: mpsc::Sender<RoomCmd>,
    pub view: Arc<RoomView>,
}

/// What other tasks read of a room without waiting for it (the source
/// handoff's `Rooms` calls); the room task keeps it current.
#[derive(Default)]
pub struct RoomView(Mutex<ViewState>);

#[derive(Clone, Debug, Default)]
pub struct ViewState {
    /// Its document is loaded (false while it loads).
    pub loaded: bool,
    pub channels: Vec<sources::Channel>,
    /// A store running or waiting out its retry.
    pub storing: bool,
}

impl RoomView {
    #[allow(clippy::unwrap_used)]
    pub fn get(&self) -> ViewState {
        self.0.lock().unwrap().clone()
    }

    #[allow(clippy::unwrap_used)]
    pub fn set(&self, state: ViewState) {
        *self.0.lock().unwrap() = state;
    }
}

/// Loaded rooms by name. A room removes itself once empty and clean, under
/// the lock and only while nothing waits in its queue, so a handle taken from
/// here either reaches the room or fails to send (the caller looks up again).
#[derive(Default)]
pub struct Registry {
    rooms: Mutex<HashMap<String, RoomHandle>>,
    next: AtomicU64,
}

impl Registry {
    #[allow(clippy::unwrap_used)]
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, RoomHandle>> {
        self.rooms.lock().unwrap()
    }

    pub fn get(&self, name: &str) -> Option<RoomHandle> {
        self.lock().get(name).cloned()
    }

    /// The room's handle, spawning the room with `spawn` when none is loaded.
    pub fn get_or_spawn(&self, name: &str, spawn: impl FnOnce(u64) -> RoomHandle) -> RoomHandle {
        let mut rooms = self.lock();
        if let Some(handle) = rooms.get(name) {
            return handle.clone();
        }
        let handle = spawn(self.next.fetch_add(1, Ordering::Relaxed));
        rooms.insert(name.to_owned(), handle.clone());
        handle
    }

    /// Removes the room `id` if `still_idle` holds under the lock.
    pub fn remove_if(&self, name: &str, id: u64, still_idle: impl FnOnce() -> bool) -> bool {
        let mut rooms = self.lock();
        if rooms.get(name).is_some_and(|handle| handle.id == id) && still_idle() {
            rooms.remove(name);
            return true;
        }
        false
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn names(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }
}

/// Rooms being reset or drained (`RoomEvictionState`): a rejected or
/// discarding room refuses joins and messages until its discard unloads it;
/// a draining one only refuses joins.
#[derive(Default)]
pub struct Evictions {
    rooms: Mutex<HashMap<String, Flags>>,
}

#[derive(Clone, Copy, Debug, Default)]
struct Flags {
    rejected: bool,
    discarding: u32,
    draining: u32,
}

impl Evictions {
    #[allow(clippy::unwrap_used)]
    fn with<T>(&self, room: &str, f: impl FnOnce(&mut Flags) -> T) -> T {
        let mut rooms = self.rooms.lock().unwrap();
        let flags = rooms.entry(room.to_owned()).or_default();
        let out = f(flags);
        if !flags.rejected && flags.discarding == 0 && flags.draining == 0 {
            rooms.remove(room);
        }
        out
    }

    pub fn reject(&self, room: &str) {
        self.with(room, |flags| flags.rejected = true);
    }

    pub fn accept(&self, room: &str) {
        self.with(room, |flags| flags.rejected = false);
    }

    pub fn begin(&self, room: &str, drain: bool) {
        self.with(room, |flags| {
            if drain {
                flags.draining += 1
            } else {
                flags.discarding += 1
            }
        });
    }

    pub fn end(&self, room: &str, drain: bool) {
        self.with(room, |flags| {
            if drain {
                flags.draining = flags.draining.saturating_sub(1);
            } else {
                flags.discarding = flags.discarding.saturating_sub(1);
            }
        });
    }

    /// `assertRoomAvailable`: whether the room refuses traffic now. A store
    /// may still run while the room drains.
    pub fn blocks(&self, room: &str, store: bool) -> bool {
        self.with(room, |flags| {
            flags.rejected || flags.discarding > 0 || (!store && flags.draining > 0)
        })
    }
}

/// Counters behind `collab_health` and `/metrics`.
#[derive(Default)]
pub struct Stats {
    pub connections: AtomicU64,
    pub authentication_failures: AtomicU64,
    pub store_failures: AtomicU64,
    pub failed_stores: AtomicU64,
    pub updates: AtomicU64,
    pub awareness: AtomicU64,
    pub log_bytes: AtomicU64,
    /// Draft sends refused, by `drafts::Class` (its index in `Class::ALL`).
    pub draft_refusals: [AtomicU64; 10],
    /// JOINs and draft sends refused for their client protocol: material
    /// rooms, then source rooms (stale tabs left after a deploy).
    pub outdated_refusals: [AtomicU64; 2],
    /// Source room loads refused because loaded rooms' files fill the disk
    /// store (Epo 2026-10-17).
    pub source_disk_refusals: AtomicU64,
    /// Timeouts begun: a user over their allowance or sending an update
    /// over the cap (`rate.rs`).
    pub timeouts: AtomicU64,
    /// Sockets refused for their client address's cap (`seats.rs`).
    pub seat_refusals: AtomicU64,
    /// Channels closed as their user's oldest when a join passed the user's
    /// cap (`seats.rs`).
    pub oldest_closed: AtomicU64,
}

pub struct App {
    pub config: Config,
    pub instance_id: String,
    pub db: deadpool_postgres::Pool,
    pub redis: redis::aio::ConnectionManager,
    /// For the pub/sub connection.
    pub redis_client: redis::Client,
    pub http: reqwest::Client,
    pub rooms: Registry,
    pub evictions: Evictions,
    pub stats: Stats,
    /// Every user's update allowance (`rate.rs`).
    pub allowances: crate::rate::Allowances,
    /// Open sockets per client address, joined channels per user and per
    /// user and document (`seats.rs`).
    pub address_sockets: crate::seats::Seats,
    pub joined: crate::seats::Joined,
    pub per_document: crate::seats::Joined,
    pub health: crate::health::Health,
    pub unplaced: crate::incidents::UnplacedOnce,
    pub projection_failures: crate::projection::Failures,
    pub projection_refused: crate::projection::Refused,
    pub pubsub: crate::pubsub::Completed,
    pub next_connection: AtomicU64,
    /// Channel ids the source handoff names (one per room join).
    pub next_channel: AtomicU64,
    pub sources: Arc<sources::Sources>,
    /// Set once at start: it holds the room layer, which holds the app.
    pub handoff: OnceLock<Arc<sources::handoff::Handoff>>,
    /// Channels authenticating for a source room, by (connection, channel):
    /// a rebuild counts them as in the room.
    pub source_joins: Mutex<HashMap<(u64, u64), (String, Instant)>>,
    /// The agent markdown converter, when its bundle is configured.
    pub markdown: Option<notes::markdown::Converter>,
    /// Agent edits whose Undo a loaded room holds.
    pub agent_steps: AgentSteps,
}

/// The agent edits (and their Undo and Redo steps) whose Yjs items a loaded
/// room holds for the live Undo (`ydoc::undo`, Epo 2026-10-20): each step's
/// id, the rooms holding its parts (a quiz: its content and keys rooms) and
/// when it stops being offered, 24 h after its agent edit (Q385). A room's
/// steps go when it unloads.
#[derive(Default)]
pub struct AgentSteps(Mutex<Steps>);

#[derive(Default)]
struct Steps {
    held: HashMap<String, Vec<String>>,
    /// When each held step stops being offered.
    until: HashMap<String, std::time::SystemTime>,
    /// Steps rooms reverted, by those rooms: they answer a request repeated
    /// after a lost answer (`Room::agent_undo`).
    reverted: HashMap<String, Vec<String>>,
}

fn add(map: &mut HashMap<String, Vec<String>>, id: &str, room: &str) {
    let rooms = map.entry(id.to_owned()).or_default();
    if !rooms.iter().any(|held| held == room) {
        rooms.push(room.to_owned());
    }
}

impl AgentSteps {
    fn steps(&self) -> std::sync::MutexGuard<'_, Steps> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `room` holds a part of step `id`, offered until `until` (the earliest
    /// of its rooms').
    pub fn hold(&self, id: &str, room: &str, until: std::time::SystemTime) {
        let mut steps = self.steps();
        add(&mut steps.held, id, room);
        let at = steps.until.entry(id.to_owned()).or_insert(until);
        *at = (*at).min(until);
    }

    /// The rooms holding step `id` (none: no Undo, or past its 24 h: its
    /// rooms released it).
    pub fn rooms(&self, id: &str) -> Vec<String> {
        self.steps().held.get(id).cloned().unwrap_or_default()
    }

    /// When step `id` stops being offered.
    pub fn until(&self, id: &str) -> Option<std::time::SystemTime> {
        self.steps().until.get(id).copied()
    }

    /// The rooms that reverted step `id`.
    pub fn reverted(&self, id: &str) -> Vec<String> {
        self.steps().reverted.get(id).cloned().unwrap_or_default()
    }

    pub fn forget(&self, id: &str) {
        let mut steps = self.steps();
        steps.held.remove(id);
        steps.until.remove(id);
    }

    /// `room` no longer holds a part of step `id`.
    pub fn release(&self, id: &str, room: &str) {
        let mut steps = self.steps();
        if let Some(rooms) = steps.held.get_mut(id) {
            rooms.retain(|held| held != room);
            if rooms.is_empty() {
                steps.held.remove(id);
                steps.until.remove(id);
            }
        }
    }

    /// `room` reverted its part of step `id`.
    pub fn revert(&self, id: &str, room: &str) {
        self.release(id, room);
        add(&mut self.steps().reverted, id, room);
    }

    /// `room` unloaded: every step it held or reverted a part of goes.
    pub fn forget_room(&self, room: &str) {
        let mut guard = self.steps();
        let steps = &mut *guard;
        for map in [&mut steps.held, &mut steps.reverted] {
            map.retain(|_, rooms| !rooms.iter().any(|held| held == room));
        }
        let held = &steps.held;
        steps.until.retain(|id, _| held.contains_key(id));
    }
}

/// Every collaboration process's id and its last heartbeat (Unix ms), kept
/// by `main.rs`'s heartbeat; the source handoff and the API's eviction
/// worker read it too.
pub const INSTANCE_REGISTRY: &str = "capy:collaboration:instances";

/// How recent a heartbeat keeps another process live, as the source handoff
/// and the API's eviction worker read the registry.
const INSTANCE_LIVE_FOR: std::time::Duration = std::time::Duration::from_secs(60);

impl App {
    /// The source handoff (set before any connection is accepted).
    #[allow(clippy::expect_used)]
    pub fn handoff(&self) -> &Arc<sources::handoff::Handoff> {
        self.handoff.get().expect("the handoff is set at start")
    }

    /// Whether another collaboration process heartbeat within the last
    /// minute, or the registry cannot be read: the in-place collection
    /// requires one process per database (Q400, review r3 L1).
    pub async fn another_instance(&self) -> bool {
        let mut redis = self.redis.clone();
        let Ok(entries) =
            redis::AsyncCommands::hgetall::<_, HashMap<String, u64>>(&mut redis, INSTANCE_REGISTRY)
                .await
        else {
            return true;
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);
        let cutoff = now.saturating_sub(INSTANCE_LIVE_FOR.as_millis() as u64);
        entries
            .iter()
            .any(|(id, at)| *id != self.instance_id && *at >= cutoff)
    }
}

pub type Shared = Arc<App>;

#[cfg(test)]
mod outbox_tests {
    use super::*;
    use futures::FutureExt;

    fn overflowed(outbox: &Outbox) -> bool {
        outbox.overflow().notified().now_or_never().is_some()
    }

    #[test]
    fn a_backlog_past_the_floor_or_the_largest_frame_closes_the_reader() {
        let (outbox, _rx) = Outbox::new();
        // A joiner's whole-state answer always goes out.
        outbox.frame(Bytes::from(vec![0; 10 * 1024 * 1024]));
        assert!(!overflowed(&outbox));
        // The backlog may reach that frame's size, then the reader is too slow.
        outbox.frame(Bytes::from(vec![0; 1024]));
        assert!(!overflowed(&outbox));
        outbox.frame(Bytes::from(vec![0; 1024]));
        assert!(overflowed(&outbox));
        let (small, _rx) = Outbox::new();
        for _ in 0..4 {
            small.frame(Bytes::from(vec![0; 1024 * 1024]));
        }
        assert!(!overflowed(&small));
        small.frame(Bytes::from(vec![0; 1]));
        small.frame(Bytes::from(vec![0; 1]));
        assert!(overflowed(&small));
        // What the writer sent leaves the backlog.
        let (draining, _rx) = Outbox::new();
        for _ in 0..8 {
            draining.frame(Bytes::from(vec![0; 1024 * 1024]));
            draining.sent(1024 * 1024);
        }
        assert!(!overflowed(&draining));
    }

    /// Review r1 M1: once a frame was dropped, nothing later is queued,
    /// even after the writer drained, so a `stored` notice never follows a
    /// broadcast its reader missed. Fails if frames queue again.
    #[test]
    fn nothing_goes_out_after_a_dropped_frame() {
        let (outbox, mut rx) = Outbox::new();
        for _ in 0..4 {
            outbox.frame(Bytes::from(vec![0; 1024 * 1024]));
        }
        outbox.frame(Bytes::from(vec![0; 1]));
        outbox.frame(Bytes::from(vec![0; 1]));
        assert!(overflowed(&outbox));
        outbox.sent(4 * 1024 * 1024 + 1);
        outbox.frame(Bytes::from(vec![0; 1]));
        let mut queued = 0;
        while rx.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, 5);
    }
}
