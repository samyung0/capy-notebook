//! Shared server state: clients, the room registry, room eviction flags,
//! counters for `collab_health` and `/metrics`.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::sync::mpsc;

use crate::config::Config;
use crate::room::RoomCmd;
use crate::seats::Traffic;

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
    /// What the socket's connection moved: a room reads whether a message
    /// is still arriving on it (round 4, finding 9).
    traffic: Arc<Traffic>,
}

/// The least a socket's outgoing queue holds before its reader counts as
/// too slow (Epo 2026-10-08).
pub const OUTBOX_FLOOR: usize = 4 * 1024 * 1024;

impl Outbox {
    pub fn new(traffic: Arc<Traffic>) -> (Self, mpsc::UnboundedReceiver<Out>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Outbox {
                tx,
                queued: Arc::default(),
                largest: Arc::default(),
                overflow: Arc::default(),
                dropped: Arc::default(),
                traffic,
            },
            rx,
        )
    }

    pub fn traffic(&self) -> &Traffic {
        &self.traffic
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
    pub draft_refusals: [AtomicU64; crate::drafts::Class::ALL.len()],
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
    /// Each quiz room's bound on its document while it or its other room is
    /// loaded (`QuizBounds`).
    pub quiz_bounds: QuizBounds,
    /// Each user's one unfinished group of pieces (`GroupSlots`).
    pub group_slots: GroupSlots,
}

/// Each user's one unfinished group of pieces in this process, across rooms
/// and paths: a channel's update or step 2 in pieces, or a draft send's (Epo
/// 2026-11-23, in place of a 100 MiB hold per user; review of 43fae032a,
/// finding 1: a reader with 22 channels on 27 MiB DOCX rooms pinned about
/// 600 MiB with groups it never finished). A different group's first piece
/// meanwhile is answered busy, with no timeout, so the most a user holds is
/// one group, which its room's group cap bounds. The group holding the slot
/// claiming it again (a draft resend under the same name, a channel's
/// session on its next connection) takes its place.
/// Busy groups wait their turn first come, first served (review round 3,
/// finding 8: a tab starting groups one after another starved a busy one,
/// which re-uploads the whole group each try): each is queued once, only
/// the head takes a freed slot, and one not back within its patience leaves
/// the queue ([GroupClaim::channel], [GroupClaim::draft]); a channel's also
/// when it leaves (round 4, finding 2: an orphaned head held up every group
/// of its user's for up to 100 s). A user's draft send waits once a room: a
/// newer busy draft group of theirs for the room takes the older one's place
/// (its page names a group by its rows, so new edits make a new group), and
/// one refused for good waits no more (round 5, finding 4). A user holding no
/// slot and no waiter has no entry. Each slot is a [GroupClaim], given back
/// however its group ends. Per server process, as the rooms are.
#[derive(Default)]
pub struct GroupSlots(Mutex<Slots>);

/// How long the browser waits to send a busy group again (Epo 2026-11-23:
/// `GROUP_BUSY_RETRY_MS` and `BUSY_RETRY_MS` in the browser).
pub const BUSY_RETRY: Duration = Duration::from_secs(10);

#[derive(Default)]
struct Slots {
    users: HashMap<String, Slot>,
    last: u64,
    /// When each waiter's place lapses, soonest first, so a claim looks at
    /// the users whose places are due, never at every user (round 5,
    /// finding 4). A renewed place leaves its older entry, which then finds
    /// its user's places current.
    due: BinaryHeap<Reverse<(Instant, String)>>,
}

/// The group slot of a draft group of `room`'s named `id`.
pub fn draft_slot(room: &str, id: &str) -> String {
    format!("{room}\ndraft:{id}")
}

/// The room of a [draft_slot]; none for a channel's.
fn draft_room(slot: &str) -> Option<&str> {
    slot.split_once("\ndraft:").map(|(room, _)| room)
}

/// One user's slot: the group holding it and its claim's number, and the
/// busy groups waiting, each until when it keeps its place.
#[derive(Default)]
struct Slot {
    holder: Option<(String, u64)>,
    waiting: VecDeque<(String, Instant)>,
}

impl GroupSlots {
    fn slots(&self) -> std::sync::MutexGuard<'_, Slots> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `user`'s slot for `group` (its room and channel session, or its room
    /// and draft id) at `now`: the claim's number, or none while another
    /// group holds it or waits before it (`group` then keeps its place in
    /// line for `patience`).
    fn claim(&self, user: &str, group: &str, now: Instant, patience: Duration) -> Option<u64> {
        let mut slots = self.slots();
        slots.expire(user, now);
        let Slots { users, last, due } = &mut *slots;
        let slot = users.entry(user.to_owned()).or_default();
        // A draft group stands in for its room's draft waiting already: the
        // older edits of its page, or another lineage of the same document
        // (round 6, finding 1: two of a room's drafts replacing each other
        // at the head kept both waiting for good).
        let room = draft_room(group);
        let ours =
            |waiting: &str| waiting == group || room.is_some() && draft_room(waiting) == room;
        let holds = slot.holder.as_ref().map(|(held, _)| held == group);
        let first = slot.waiting.front().is_none_or(|(next, _)| ours(next));
        if holds == Some(true) || (holds.is_none() && first) {
            slot.waiting.retain(|(waiting, _)| !ours(waiting));
            *last += 1;
            slot.holder = Some((group.to_owned(), *last));
            return Some(*last);
        }
        let until = now + patience;
        let place = slot.waiting.iter_mut().find(|(waiting, _)| ours(waiting));
        match place {
            Some(place) => *place = (group.to_owned(), until),
            None => slot.waiting.push_back((group.to_owned(), until)),
        }
        due.push(Reverse((until, user.to_owned())));
        None
    }

    /// Gives `user`'s slot back, unless a later claim of it took its place.
    fn give(&self, user: &str, claim: u64) {
        let mut slots = self.slots();
        if let Some(slot) = slots.users.get_mut(user)
            && slot.holder.as_ref().is_some_and(|(_, held)| *held == claim)
        {
            slot.holder = None;
        }
        slots.expire(user, Instant::now());
    }

    /// `group` waits no more: its channel left (round 4, finding 2), or its
    /// draft group was refused for good (round 5, finding 4).
    pub fn leave(&self, user: &str, group: &str) {
        let mut slots = self.slots();
        if let Some(slot) = slots.users.get_mut(user) {
            slot.waiting.retain(|(waiting, _)| waiting != group);
        }
        slots.expire(user, Instant::now());
    }
}

impl Slots {
    /// Lets go of the waiters past their patience, `user`'s and those whose
    /// places are due, and of the users left with no slot and no waiter.
    fn expire(&mut self, user: &str, now: Instant) {
        self.tidy(user, now);
        while let Some(Reverse((until, _))) = self.due.peek()
            && *until < now
        {
            if let Some(Reverse((_, due))) = self.due.pop() {
                self.tidy(&due, now);
            }
        }
    }

    fn tidy(&mut self, user: &str, now: Instant) {
        let Some(slot) = self.users.get_mut(user) else {
            return;
        };
        slot.waiting.retain(|(_, until)| *until >= now);
        if slot.holder.is_none() && slot.waiting.is_empty() {
            self.users.remove(user);
        }
    }
}

/// A user's one group slot in [GroupSlots], given back when it drops.
pub struct GroupClaim {
    app: Shared,
    user: String,
    claim: u64,
}

impl GroupClaim {
    /// A channel's slot for `group`, or none while another of its user's
    /// groups is unfinished or waits before it (busy). A busy channel keeps
    /// its place twice the [BUSY_RETRY] its client waits to join again
    /// ([GroupClaim::channel_patience]).
    pub fn channel(app: &Shared, user: &str, group: &str) -> Option<Self> {
        Self::take(app, user, group, Self::channel_patience(&app.config))
    }

    /// A draft send's slot for `group`, as [GroupClaim::channel]: a busy
    /// draft keeps its place for the [BUSY_RETRY] its page waits and the
    /// group slack ([GroupClaim::draft_patience]).
    pub fn draft(app: &Shared, user: &str, group: &str) -> Option<Self> {
        Self::take(app, user, group, Self::draft_patience(&app.config))
    }

    /// A busy group's next claim comes once its first piece arrived again,
    /// so each keeps its place one piece at the slowest uplink longer too
    /// (round 6, finding 2: a slow uplink lost its place in line while its
    /// piece came).
    fn channel_patience(config: &Config) -> Duration {
        2 * BUSY_RETRY + config.slowest_piece()
    }

    fn draft_patience(config: &Config) -> Duration {
        BUSY_RETRY + config.group_slack + config.slowest_piece()
    }

    fn take(app: &Shared, user: &str, group: &str, patience: Duration) -> Option<Self> {
        let claim = app
            .group_slots
            .claim(user, group, Instant::now(), patience)?;
        Some(GroupClaim {
            app: app.clone(),
            user: user.to_owned(),
            claim,
        })
    }
}

impl Drop for GroupClaim {
    fn drop(&mut self) {
        self.app.group_slots.give(&self.user, self.claim);
    }
}

/// A quiz's two documents count together against the material's limits
/// (REVIEW1 S3). Each loaded quiz room keeps its document's bound here,
/// under its room name, and a room admitting growth takes its new bound
/// against the other room's as it stands, under this one lock: two writers
/// growing both documents at once never pass the limits the two share, as
/// they did when each room read the other's bound from a message a flush
/// late. A room that unloads while the other is loaded leaves its bound
/// (it stored everything, so the bound holds for the stored document); the
/// last of the two to unload takes both away. The in-place collection runs
/// one process per database, so both rooms of a quiz are loaded in it.
#[derive(Default)]
pub struct QuizBounds(Mutex<HashMap<String, notes::limits::Metrics>>);

impl QuizBounds {
    fn bounds(&self) -> std::sync::MutexGuard<'_, HashMap<String, notes::limits::Metrics>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn get(&self, room: &str) -> Option<notes::limits::Metrics> {
        self.bounds().get(room).copied()
    }

    pub fn set(&self, room: &str, bound: notes::limits::Metrics) {
        self.bounds().insert(room.to_owned(), bound);
    }

    /// `room` unloaded: its bound stays for its other room while that one
    /// is loaded (`peer_loaded`); otherwise neither is read again until a
    /// load sets it, and both go.
    pub fn unloaded(&self, room: &str, peer: &str, peer_loaded: bool) {
        if !peer_loaded {
            let mut bounds = self.bounds();
            bounds.remove(room);
            bounds.remove(peer);
        }
    }

    /// `own`, `room`'s bound with an update admitted, is taken unless the
    /// other room's bound moved since admission read it (`read`) and, with
    /// it as it stands now (`peer`'s, else `unloaded`: what was last read of
    /// it), the two pass a limit while the update grew this room past
    /// `before` (its bound before the update; unknown, the bound the other
    /// room counted for it). An update admitted against the other's bound as
    /// it still stands is taken as admission took it, a shrink past a limit
    /// included (review of 43fae032a, finding 5). Refused: the limit and the
    /// two documents' metrics together.
    pub fn take(
        &self,
        room: &str,
        peer: &str,
        own: notes::limits::Metrics,
        read: Option<notes::limits::Metrics>,
        before: Option<notes::limits::Metrics>,
        unloaded: Option<notes::limits::Metrics>,
    ) -> Result<(), (notes::limits::LimitCode, notes::limits::Metrics)> {
        let mut bounds = self.bounds();
        let other = bounds.get(peer).copied().or(unloaded);
        if other != read {
            let combined = items::combine(&own, other.as_ref());
            let before = before.or_else(|| bounds.get(room).copied());
            if let Some(code) = notes::limits::limit_code(&combined)
                && before.is_none_or(|before| !notes::limits::recovers(&own, Some(&before)))
            {
                return Err((code, combined));
            }
        }
        bounds.insert(room.to_owned(), own);
        Ok(())
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

    /// Why another collaboration process may be live: one heartbeat within
    /// the last minute, a heartbeat that cannot be read, or a registry that
    /// cannot be read (the cause and its detail); none when this one is
    /// alone. The in-place collection requires one process per database
    /// (Q400, review r3 L1). Each value is read on its own, as the source
    /// handoff reads the registry.
    pub async fn another_instance(&self) -> Option<(&'static str, String)> {
        let mut redis = self.redis.clone();
        let entries = match redis::AsyncCommands::hgetall::<_, HashMap<String, String>>(
            &mut redis,
            INSTANCE_REGISTRY,
        )
        .await
        {
            Ok(entries) => entries,
            Err(error) => return Some(("registry unreadable", error.to_string())),
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);
        let cutoff = now.saturating_sub(INSTANCE_LIVE_FOR.as_millis() as u64);
        entries
            .iter()
            .filter(|(id, _)| **id != self.instance_id)
            .find_map(|(id, at)| match at.parse::<u64>() {
                Ok(at) if at >= cutoff => Some(("another process live", id.clone())),
                Ok(_) => None,
                Err(_) => Some(("heartbeat unreadable", id.clone())),
            })
    }
}

pub type Shared = Arc<App>;

#[cfg(test)]
mod group_tests {
    use super::*;
    use notes::limits::Metrics;

    const MIB: u64 = 1024 * 1024;

    fn metrics(mib: u64) -> Metrics {
        Metrics {
            content_bytes: mib * MIB,
            max_depth: 4,
            node_count: 100,
        }
    }

    /// Epo 2026-11-23: a user holds one unfinished group at a time, across
    /// rooms; another of theirs is busy until it is given back, while another
    /// user's is not. A claim of the same group takes its place, so the
    /// earlier claim given back afterwards frees nothing. Fails with a second
    /// group claimed beside the first.
    #[test]
    fn a_user_holds_one_unfinished_group_at_a_time() {
        let slots = GroupSlots::default();
        let (now, patience) = (Instant::now(), Duration::from_secs(100));
        let first = slots.claim("u_writer", "a\n1:1", now, patience).unwrap();
        assert_eq!(slots.claim("u_writer", "b\n1:2", now, patience), None);
        assert!(slots.claim("u_other", "b\n2:1", now, patience).is_some());
        let again = slots.claim("u_writer", "a\n1:1", now, patience).unwrap();
        slots.give("u_writer", first);
        assert_eq!(slots.claim("u_writer", "b\n1:2", now, patience), None);
        slots.give("u_writer", again);
        assert!(slots.claim("u_writer", "b\n1:2", now, patience).is_some());
    }

    /// Review round 3, finding 8: busy groups take a freed slot first come,
    /// first served, each queued once; one that did not ask again within its
    /// patience leaves the line. Fails when any group may take a freed slot.
    #[test]
    fn busy_groups_take_a_freed_slot_in_their_order() {
        let slots = GroupSlots::default();
        let (now, patience) = (Instant::now(), Duration::from_secs(20));
        let held = slots.claim("u_writer", "a", now, patience).unwrap();
        assert_eq!(slots.claim("u_writer", "b", now, patience), None);
        assert_eq!(slots.claim("u_writer", "c", now, patience), None);
        assert_eq!(slots.claim("u_writer", "b", now, patience), None);
        slots.give("u_writer", held);
        assert_eq!(slots.claim("u_writer", "c", now, patience), None);
        let second = slots.claim("u_writer", "b", now, patience).unwrap();
        slots.give("u_writer", second);
        // "c" asked last at `now`; "d" comes past its patience and takes it.
        let later = now + Duration::from_secs(21);
        assert!(slots.claim("u_writer", "d", later, patience).is_some());
    }

    /// Round 4, finding 2: each waiter keeps its place for its own patience,
    /// a channel's shorter than a draft's, so an orphaned channel stops
    /// holding up a draft behind it once its patience is past. Fails with
    /// one patience for the whole line.
    #[test]
    fn each_busy_group_keeps_its_place_for_its_own_patience() {
        let slots = GroupSlots::default();
        let now = Instant::now();
        let (channel, draft) = (Duration::from_secs(20), Duration::from_secs(100));
        let held = slots.claim("u_writer", "a", now, channel).unwrap();
        assert_eq!(slots.claim("u_writer", "tab", now, channel), None);
        assert_eq!(slots.claim("u_writer", "draft", now, draft), None);
        slots.give("u_writer", held);
        let later = now + Duration::from_secs(21);
        assert!(slots.claim("u_writer", "draft", later, draft).is_some());
    }

    /// Round 4, finding 2: a channel that left waits no more, so the group
    /// after it takes the freed slot at once. Fails with the waiter kept.
    #[test]
    fn a_busy_channel_that_left_holds_up_no_one() {
        let slots = GroupSlots::default();
        let (now, patience) = (Instant::now(), Duration::from_secs(20));
        let held = slots.claim("u_writer", "a", now, patience).unwrap();
        assert_eq!(slots.claim("u_writer", "gone", now, patience), None);
        slots.leave("u_writer", "gone");
        slots.give("u_writer", held);
        assert!(slots.claim("u_writer", "next", now, patience).is_some());
    }

    /// Round 5, finding 4: a newer busy draft group of a user's for a room
    /// takes the place of the older one waiting for it (the page's earlier
    /// edits, which it sends no more), so the freed slot goes to the newer.
    /// A draft of another room keeps its own place. Fails with the older
    /// waiter holding the line.
    #[test]
    fn a_newer_draft_group_for_a_room_takes_the_older_ones_place() {
        let slots = GroupSlots::default();
        let (now, patience) = (Instant::now(), Duration::from_secs(100));
        let held = slots.claim("u_writer", "a\n1:1", now, patience).unwrap();
        let (old, new) = (draft_slot("r1", "old"), draft_slot("r1", "new"));
        assert_eq!(slots.claim("u_writer", &old, now, patience), None);
        assert_eq!(
            slots.claim("u_writer", &draft_slot("r2", "x"), now, patience),
            None
        );
        assert_eq!(slots.claim("u_writer", &new, now, patience), None);
        slots.give("u_writer", held);
        assert!(slots.claim("u_writer", &new, now, patience).is_some());
    }

    /// Round 6, finding 1: two draft groups of one room (a document's rows
    /// of two lineages, which one sweep sends) waiting behind another group
    /// stand in for each other at the head, so the first of them back once
    /// the slot is free claims it. Fails with each replacing the other at
    /// the head, neither ever first.
    #[test]
    fn two_draft_groups_of_a_room_do_not_block_each_other() {
        let slots = GroupSlots::default();
        let (now, patience) = (Instant::now(), Duration::from_secs(100));
        let held = slots.claim("u_writer", "a\n1:1", now, patience).unwrap();
        let (one, two) = (draft_slot("r1", "one"), draft_slot("r1", "two"));
        for _ in 0..3 {
            assert_eq!(slots.claim("u_writer", &one, now, patience), None);
            assert_eq!(slots.claim("u_writer", &two, now, patience), None);
        }
        slots.give("u_writer", held);
        assert!(slots.claim("u_writer", &one, now, patience).is_some());
    }

    /// Round 6, finding 2: a busy group keeps its place while its first piece
    /// comes again at the slowest uplink, a channel's and a draft's: its next
    /// claim comes its retry and one whole piece later, and a group asking
    /// meanwhile waits behind it. Fails with patience for the retry alone
    /// (the later group takes the slot).
    #[tokio::test]
    async fn a_busy_group_on_the_slowest_uplink_keeps_its_place() {
        let app = crate::http::tests::offline_app();
        let back = BUSY_RETRY + app.config.slowest_piece();
        for patience in [
            GroupClaim::channel_patience(&app.config),
            GroupClaim::draft_patience(&app.config),
        ] {
            let slots = GroupSlots::default();
            let now = Instant::now();
            let held = slots.claim("u_writer", "a", now, patience).unwrap();
            assert_eq!(slots.claim("u_writer", "slow", now, patience), None);
            slots.give("u_writer", held);
            let meanwhile = now + back - Duration::from_secs(1);
            assert_eq!(slots.claim("u_writer", "later", meanwhile, patience), None);
            assert!(
                slots
                    .claim("u_writer", "slow", now + back, patience)
                    .is_some()
            );
        }
    }

    /// Round 4, finding 2: a user whose waiters all passed their patience
    /// and who holds no slot has no entry left. Fails with the entry kept.
    #[test]
    fn a_user_holding_nothing_has_no_entry() {
        let slots = GroupSlots::default();
        let (now, patience) = (Instant::now(), Duration::from_secs(20));
        let held = slots.claim("u_writer", "a", now, patience).unwrap();
        assert_eq!(slots.claim("u_writer", "b", now, patience), None);
        slots.give("u_writer", held);
        let later = now + Duration::from_secs(21);
        let other = slots.claim("u_other", "c", later, patience).unwrap();
        assert!(!slots.slots().users.contains_key("u_writer"));
        slots.give("u_other", other);
        assert!(slots.slots().users.is_empty());
    }

    /// Finding 5: a quiz room whose validator lost its bound (an agent edit
    /// in between) still takes a shrink of a document past the shared limit
    /// when the other room's bound is the one admission read. Fails with an
    /// unknown bound counted as growth.
    #[test]
    fn a_shrink_admitted_against_the_other_rooms_bound_as_it_stands_is_taken() {
        let bounds = QuizBounds::default();
        bounds.set("material:q:schema:1", metrics(2));
        bounds.set("keys:q:schema:1", metrics(2));
        // Together still past 2 MiB after the shrink.
        let taken = bounds.take(
            "material:q:schema:1",
            "keys:q:schema:1",
            metrics(1),
            Some(metrics(2)),
            None,
            None,
        );
        assert_eq!(taken, Ok(()));
        assert_eq!(bounds.get("material:q:schema:1"), Some(metrics(1)));
    }

    /// REVIEW1 S3 with finding 5: once the other room took growth since
    /// admission read its bound, growth past the shared limit is refused,
    /// and a shrink against the bound the other room counted is still taken.
    #[test]
    fn growth_past_the_shared_limit_is_refused_once_the_other_room_moved() {
        let bounds = QuizBounds::default();
        bounds.set("material:q:schema:1", metrics(1));
        bounds.set("keys:q:schema:1", metrics(1));
        let (content, keys) = ("material:q:schema:1", "keys:q:schema:1");
        let read = Some(metrics(0));
        let grown = bounds.take(content, keys, metrics(2), read, Some(metrics(1)), None);
        assert!(grown.is_err());
        assert_eq!(bounds.get(content), Some(metrics(1)));
        let shrunk = bounds.take(
            content,
            keys,
            Metrics {
                content_bytes: MIB + 1,
                ..metrics(1)
            },
            read,
            None,
            None,
        );
        assert!(
            shrunk.is_err(),
            "grew past the bound the other room counted"
        );
        bounds.set(keys, metrics(2));
        let shrunk = bounds.take(
            content,
            keys,
            Metrics {
                content_bytes: MIB - 1,
                ..metrics(1)
            },
            read,
            None,
            None,
        );
        assert_eq!(shrunk, Ok(()));
    }

    /// Finding 4: a quiz room that unloads leaves its bound while its other
    /// room is loaded, and the last of the two to unload takes both away.
    /// Fails when an unload forgets its bound, leaving the other room the
    /// one it read at its load.
    #[test]
    fn an_unloaded_quiz_rooms_bound_stays_while_its_other_room_is_loaded() {
        let bounds = QuizBounds::default();
        let (content, keys) = ("material:q:schema:1", "keys:q:schema:1");
        bounds.set(content, metrics(1));
        bounds.set(keys, metrics(1));
        bounds.unloaded(keys, content, true);
        assert_eq!(bounds.get(keys), Some(metrics(1)));
        bounds.unloaded(content, keys, false);
        assert_eq!((bounds.get(content), bounds.get(keys)), (None, None));
    }
}

#[cfg(test)]
mod outbox_tests {
    use super::*;
    use futures::FutureExt;

    fn overflowed(outbox: &Outbox) -> bool {
        outbox.overflow().notified().now_or_never().is_some()
    }

    #[test]
    fn a_backlog_past_the_floor_or_the_largest_frame_closes_the_reader() {
        let (outbox, _rx) = Outbox::new(Arc::default());
        // A joiner's whole-state answer always goes out.
        outbox.frame(Bytes::from(vec![0; 10 * 1024 * 1024]));
        assert!(!overflowed(&outbox));
        // The backlog may reach that frame's size, then the reader is too slow.
        outbox.frame(Bytes::from(vec![0; 1024]));
        assert!(!overflowed(&outbox));
        outbox.frame(Bytes::from(vec![0; 1024]));
        assert!(overflowed(&outbox));
        let (small, _rx) = Outbox::new(Arc::default());
        for _ in 0..4 {
            small.frame(Bytes::from(vec![0; 1024 * 1024]));
        }
        assert!(!overflowed(&small));
        small.frame(Bytes::from(vec![0; 1]));
        small.frame(Bytes::from(vec![0; 1]));
        assert!(overflowed(&small));
        // What the writer sent leaves the backlog.
        let (draining, _rx) = Outbox::new(Arc::default());
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
        let (outbox, mut rx) = Outbox::new(Arc::default());
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
