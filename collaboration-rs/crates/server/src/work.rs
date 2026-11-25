//! A server-wide limit on whole-board work (Epo 2026-11-24, bytes-room plan
//! step 1): a canvas room's load, its folds, its durable projection, the
//! trial of an update past a small edit and the answer to a joiner behind
//! its base each read or build the whole board in memory, up to about ten
//! times its stored state, so at most [BOARD_WORK] of them run at once in
//! this process. Office and text source rooms and notes do not take it.
//!
//! A [Permit] is taken right before the work and held until the work ends, a
//! panic included: moved into the blocking closure that does it, held across
//! a trial's or a join's `block_in_place`, or, at a fold, until its new base
//! is stored. It is never kept on
//! a room between commands; its holder never waits for another permit, never
//! sends to a socket or its room's channel, and takes it before any material
//! lock it waits for, never after. Each call site frees what its work built
//! before the permit drops, and the drop asks for a trim
//! (`trim::after_unload`'s): on glibc a whole-board operation's peak (25 to
//! 90 MiB on the prototype's Linux run) stays resident until
//! `malloc_trim(0)` runs.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::json;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

use crate::observe::{Level, log};

/// Whole-board operations at once in this process (Epo 2026-11-24: one).
pub const BOARD_WORK: usize = 1;

/// A wait this long logs a Warn while it lasts, and another once it ends;
/// there is no timeout.
const SLOW_WAIT: Duration = Duration::from_secs(5);

/// The work a permit is for, in logs.
#[derive(Clone, Copy, Debug)]
pub enum WorkKind {
    /// A board room's load: its rows merged beside its base, which it never
    /// decodes (`board::Board::load`).
    Load,
    /// A loaded board's fold of its log.
    Fold,
    /// The fold when a board room unloads.
    UnloadFold,
    /// A board's projection from its durable rows (the cadence, an asset
    /// named, the pending scan).
    Projection,
    /// A loaded board's trial of a writer's update past a small edit, or
    /// near its cap, on a replica of the whole board (`board::Check`).
    Trial,
    /// The answer to a joiner holding part of a board's base: a diff of
    /// the whole base (`board::Board::join`).
    Rejoin,
}

impl WorkKind {
    fn as_str(self) -> &'static str {
        match self {
            WorkKind::Load => "load",
            WorkKind::Fold => "fold",
            WorkKind::UnloadFold => "unload_fold",
            WorkKind::Projection => "projection",
            WorkKind::Trial => "trial",
            WorkKind::Rejoin => "rejoin",
        }
    }
}

/// A limit on one kind of whole-document work, with its waits and runs.
#[derive(Clone)]
pub struct WorkLimit {
    permits: Arc<Semaphore>,
    stats: Arc<Stats>,
}

struct Stats {
    /// Run as each permit drops, once its work is done.
    released: fn(),
    held: AtomicUsize,
    queue: AtomicUsize,
    /// Since the last `collab_health` line: permits given, and the longest
    /// wait and run (`office`'s names).
    calls: AtomicU64,
    wait_max_ms: AtomicU64,
    run_max_ms: AtomicU64,
}

/// One unit of the limit, given back when dropped.
pub struct Permit {
    _permit: OwnedSemaphorePermit,
    stats: Arc<Stats>,
    since: Instant,
}

impl Drop for Permit {
    fn drop(&mut self) {
        let ran = self.since.elapsed().as_millis() as u64;
        self.stats.run_max_ms.fetch_max(ran, Ordering::Relaxed);
        self.stats.held.fetch_sub(1, Ordering::Relaxed);
        (self.stats.released)();
    }
}

/// Counts a waiter until its acquire ends, cancelled included.
struct Queued<'a>(&'a Stats);

impl Drop for Queued<'_> {
    fn drop(&mut self) {
        self.0.queue.fetch_sub(1, Ordering::Relaxed);
    }
}

impl WorkLimit {
    /// `size` permits; `released` runs as each one drops (the server's:
    /// `trim::after_unload`).
    pub fn new(size: usize, released: fn()) -> Self {
        WorkLimit {
            permits: Arc::new(Semaphore::new(size)),
            stats: Arc::new(Stats {
                released,
                held: AtomicUsize::new(0),
                queue: AtomicUsize::new(0),
                calls: AtomicU64::new(0),
                wait_max_ms: AtomicU64::new(0),
                run_max_ms: AtomicU64::new(0),
            }),
        }
    }

    /// A permit for `kind` of work on `room` (a room or material, for the
    /// logs), once one is free, in arrival order.
    pub async fn acquire(&self, kind: WorkKind, room: &str) -> Permit {
        let started = Instant::now();
        self.stats.queue.fetch_add(1, Ordering::Relaxed);
        let queued = Queued(&self.stats);
        // Kept across the warning, so the waiter keeps its place.
        let acquire = self.permits.clone().acquire_owned();
        tokio::pin!(acquire);
        let acquired = match tokio::time::timeout(SLOW_WAIT, &mut acquire).await {
            Ok(acquired) => acquired,
            Err(_) => {
                let fields = |waited: Duration| json!({ "kind": kind.as_str(), "room": room, "waited_ms": waited.as_millis() as u64 });
                log(
                    Level::Warn,
                    "board work still waiting",
                    fields(started.elapsed()),
                );
                let acquired = acquire.await;
                log(Level::Warn, "board work waited", fields(started.elapsed()));
                acquired
            }
        };
        // Never closed, so the acquire only ends with a permit.
        #[allow(clippy::expect_used)]
        let permit = acquired.expect("the work limit is never closed");
        drop(queued);
        let stats = &self.stats;
        stats.held.fetch_add(1, Ordering::Relaxed);
        stats.calls.fetch_add(1, Ordering::Relaxed);
        let waited = started.elapsed().as_millis() as u64;
        stats.wait_max_ms.fetch_max(waited, Ordering::Relaxed);
        Permit {
            _permit: permit,
            stats: self.stats.clone(),
            since: Instant::now(),
        }
    }

    /// Permits held now.
    pub fn held(&self) -> usize {
        self.stats.held.load(Ordering::Relaxed)
    }

    /// Acquires waiting now.
    pub fn queue(&self) -> usize {
        self.stats.queue.load(Ordering::Relaxed)
    }

    /// For `collab_health`: what is held and queued now, and the permits
    /// given and the longest wait and run since the last call.
    pub fn take_stats(&self) -> serde_json::Value {
        let stats = &self.stats;
        json!({
            "calls": stats.calls.swap(0, Ordering::Relaxed),
            "held": self.held(),
            "queue": self.queue(),
            "run_max_ms": stats.run_max_ms.swap(0, Ordering::Relaxed),
            "wait_max_ms": stats.wait_max_ms.swap(0, Ordering::Relaxed),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Permits released in this module's test (its trim requests).
    static RELEASED: AtomicUsize = AtomicUsize::new(0);

    /// With a limit of one, a second and a third acquire wait for the permit
    /// before them to drop and take it in the order they asked, however long
    /// they wait (no timeout: past the 5 s warning too); each permit's drop
    /// asks for a trim once. Fails if a waiter takes a permit while one is
    /// held, out of order or after losing its place at the warning, or if a
    /// dropped permit asks for no trim.
    #[tokio::test(start_paused = true)]
    async fn a_second_acquire_waits_for_the_first_in_arrival_order() {
        let limit = WorkLimit::new(1, || {
            RELEASED.fetch_add(1, Ordering::Relaxed);
        });
        let first = limit.acquire(WorkKind::Load, "r1").await;
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut waiters = Vec::new();
        for (n, kind) in [(2, WorkKind::Fold), (3, WorkKind::Projection)] {
            let (limit, order) = (limit.clone(), order.clone());
            waiters.push(tokio::spawn(async move {
                let permit = limit.acquire(kind, &format!("r{n}")).await;
                order.lock().unwrap().push(n);
                permit
            }));
            // Each waiter asks before the next is spawned.
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(order.lock().unwrap().is_empty());
        assert_eq!((limit.held(), limit.queue()), (1, 2));
        assert_eq!(RELEASED.load(Ordering::Relaxed), 0);
        drop(first);
        let second = waiters.remove(0).await.unwrap();
        assert_eq!(RELEASED.load(Ordering::Relaxed), 1);
        assert_eq!(*order.lock().unwrap(), [2]);
        assert_eq!((limit.held(), limit.queue()), (1, 1));
        drop(second);
        let third = waiters.remove(0).await.unwrap();
        assert_eq!(*order.lock().unwrap(), [2, 3]);
        let stats = limit.take_stats();
        assert_eq!(stats["calls"], 3);
        assert!(stats["wait_max_ms"].as_u64().unwrap() >= 60_000);
        drop(third);
        assert_eq!((limit.held(), limit.queue()), (0, 0));
        assert_eq!(RELEASED.load(Ordering::Relaxed), 3);
    }
}
