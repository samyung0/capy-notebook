//! Shared server state: clients, the room registry, room eviction flags,
//! counters for `collab_health` and `/metrics`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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
/// connection whose queue passes `limit` bytes is too slow and is closed.
#[derive(Clone, Debug)]
pub struct Outbox {
    tx: mpsc::UnboundedSender<Out>,
    queued: Arc<AtomicUsize>,
    overflow: Arc<tokio::sync::Notify>,
    limit: usize,
}

impl Outbox {
    pub fn new(limit: usize) -> (Self, mpsc::UnboundedReceiver<Out>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Outbox {
                tx,
                queued: Arc::default(),
                overflow: Arc::default(),
                limit,
            },
            rx,
        )
    }

    pub fn frame(&self, frame: Bytes) {
        let queued = self.queued.fetch_add(frame.len(), Ordering::Relaxed) + frame.len();
        if queued > self.limit {
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
    pub health: crate::health::Health,
    pub unplaced: crate::incidents::UnplacedOnce,
    pub projection_failures: crate::projection::Failures,
    pub pubsub: crate::pubsub::Waiters,
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
}

impl App {
    /// The source handoff (set before any connection is accepted).
    #[allow(clippy::expect_used)]
    pub fn handoff(&self) -> &Arc<sources::handoff::Handoff> {
        self.handoff.get().expect("the handoff is set at start")
    }
}

pub type Shared = Arc<App>;
