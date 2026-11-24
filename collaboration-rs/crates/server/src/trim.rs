//! Gives glibc's free memory back once a room unloads or a board's
//! whole-board work ends (`malloc_trim(0)`;
//! `bench/collaboration/reports/2026-11-23-room-memory-prod.md` and
//! `2026-11-24-room-memory-prod-2.md`). What a room's document, fold and
//! projection freed lies between chunks still in use, which glibc's own trim
//! never returns: it only shrinks a heap's top (`MALLOC_TRIM_THRESHOLD_`). A
//! trim walks every arena: after a live-built 4 MiB board unloaded, RSS went
//! from 176 to 16 MiB above idle, in 5 to 31 ms. glibc holds each arena's
//! lock while it trims it, and production runs two arenas
//! (`MALLOC_ARENA_MAX=2`), so a trim stalls allocations server-wide: trims
//! are spaced `TRIM_SPACING` apart.
//!
//! Only on Linux with glibc (`target_os = "linux"`, `target_env = "gnu"`),
//! the production image's. That is a platform cfg, not a fallback: elsewhere,
//! macOS development included, an unload trims nothing.

/// The spacing and merging of trims, for glibc's trim and the tests' own.
#[cfg(any(test, all(target_os = "linux", target_env = "gnu")))]
mod spaced {
    use std::sync::{Mutex, PoisonError};
    use std::time::Duration;

    /// The least time from one trim's end to the next one's start; unloads
    /// meanwhile ask for one trim once it passed (Epo 2026-11-24).
    pub const TRIM_SPACING: Duration = Duration::from_secs(5);

    /// Trims merged into as few as will do: one runs at a time, on a blocking
    /// thread, and the next waits out the spacing after it. A request while a
    /// trim runs or its spacing lasts marks one more as needed instead of
    /// queueing its own. When 8 rooms unloaded together, the first trim gave
    /// back about 400 MiB and the seven after it almost nothing.
    pub struct Trims<F> {
        state: Mutex<State>,
        trim: F,
        spacing: Duration,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum State {
        Idle,
        /// Trimming, or waiting out the spacing after a trim.
        Busy,
        /// Busy, and asked for again since the last trim started.
        Again,
    }

    impl<F: Fn() + Send + Sync + 'static> Trims<F> {
        pub const fn new(trim: F, spacing: Duration) -> Self {
            Trims {
                state: Mutex::new(State::Idle),
                trim,
                spacing,
            }
        }

        /// Starts a trim, or, while one runs or its spacing lasts, asks for one
        /// more once the spacing passed. The handle is the task running the
        /// trims, when this started one.
        pub fn request(&'static self) -> Option<tokio::task::JoinHandle<()>> {
            {
                let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                if *state != State::Idle {
                    *state = State::Again;
                    return None;
                }
                *state = State::Busy;
            }
            Some(tokio::spawn(async move {
                loop {
                    // A trim that panics ends its blocking task, never this one,
                    // so the state still goes back to idle below.
                    let _ = tokio::task::spawn_blocking(move || (self.trim)()).await;
                    tokio::time::sleep(self.spacing).await;
                    let again = {
                        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                        let again = *state == State::Again;
                        *state = if again { State::Busy } else { State::Idle };
                        again
                    };
                    if !again {
                        return;
                    }
                }
            }))
        }
    }
}

/// After a room unloaded and its projection and fold ended, a discard moved
/// its lineage, or a board's whole-board work freed what it built (a board
/// work permit's drop, `work.rs`): gives the memory freed back, never on a
/// room's thread.
pub fn after_unload() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    glibc::after_unload();
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
mod glibc {
    use std::time::Instant;

    use serde_json::json;

    use super::spaced::{TRIM_SPACING, Trims};
    use crate::observe::{Level, log};

    static UNLOADS: Trims<fn()> = Trims::new(trim as fn(), TRIM_SPACING);

    pub fn after_unload() {
        let _ = UNLOADS.request();
    }

    /// One trim, logged with its time and the process's RSS around it.
    fn trim() {
        let before = rss_kib();
        let started = Instant::now();
        let released = malloc_trim();
        let took = started.elapsed();
        log(
            Level::Info,
            "memory trimmed",
            json!({
                "ms": (took.as_secs_f64() * 10_000.0).round() / 10.0,
                "released": released,
                "rss_after_kib": rss_kib(),
                "rss_before_kib": before,
            }),
        );
    }

    /// The process's resident set in KiB: `VmRSS` of `/proc/self/status`,
    /// read from the kernel's counters. (`smaps_rollup` walks every page
    /// under the mmap lock, which each allocation of 128 KiB or more waits
    /// on, `MALLOC_MMAP_THRESHOLD_`.)
    fn rss_kib() -> Option<u64> {
        let status = std::fs::read_to_string("/proc/self/status").ok()?;
        status
            .lines()
            .find_map(|line| line.strip_prefix("VmRSS:"))?
            .trim()
            .trim_end_matches("kB")
            .trim()
            .parse()
            .ok()
    }

    /// glibc's `malloc_trim(0)`: every arena's free pages back to the system.
    /// True when it released some.
    #[allow(unsafe_code)]
    fn malloc_trim() -> bool {
        // SAFETY: malloc_trim takes no pointers and walks glibc's own arenas
        // under their locks; any thread may call it at any time.
        unsafe { libc::malloc_trim(0) == 1 }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tokio::sync::Notify;
    use tokio::time::Instant;

    use super::spaced::{TRIM_SPACING, Trims};

    /// A burst of unloads during a trim makes exactly one more trim, run
    /// once the spacing after the first passed; an unload within the spacing
    /// of a trim with none running asks for one too, and an unload after
    /// the spacing starts its own at once (the injected trim counts, never
    /// glibc's; paused time). Fails if each request runs a trim of its own,
    /// a request is lost, or a trim runs within the spacing.
    #[tokio::test(start_paused = true)]
    async fn unloads_ask_for_exactly_one_more_trim_spaced_apart() {
        let started = Arc::new(Notify::new());
        let running = Arc::clone(&started);
        let (go, wait) = mpsc::channel::<()>();
        let wait = Mutex::new(wait);
        let count = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&count);
        let trims: &'static Trims<_> = Box::leak(Box::new(Trims::new(
            move || {
                if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                    started.notify_one();
                    wait.lock().expect("the gate").recv().expect("go");
                }
            },
            TRIM_SPACING,
        )));
        let begun = Instant::now();
        let first = trims.request().expect("the first unload trims");
        running.notified().await;
        for _ in 0..3 {
            assert!(trims.request().is_none(), "a request queued its own trim");
        }
        go.send(()).expect("go");
        tokio::time::sleep(TRIM_SPACING - Duration::from_millis(1)).await;
        assert_eq!(count.load(Ordering::SeqCst), 1, "a trim within the spacing");
        first.await.expect("the trims ended");
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert_eq!(
            begun.elapsed(),
            TRIM_SPACING * 2,
            "the second trim's spacing"
        );

        let next = trims.request().expect("an unload after the spacing trims");
        tokio::time::sleep(TRIM_SPACING / 2).await;
        assert_eq!(count.load(Ordering::SeqCst), 3);
        assert!(trims.request().is_none(), "a request queued its own trim");
        next.await.expect("the trims ended");
        assert_eq!(count.load(Ordering::SeqCst), 4);
        assert_eq!(
            begun.elapsed(),
            TRIM_SPACING * 4,
            "the fourth trim's spacing"
        );
    }

    /// A trim that panics leaves later unloads trimming. Fails if the
    /// panic leaves the trims busy for good.
    #[tokio::test(start_paused = true)]
    async fn a_trim_that_panics_leaves_later_trims_running() {
        let count = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&count);
        let trims: &'static Trims<_> = Box::leak(Box::new(Trims::new(
            move || {
                if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                    panic!("a trim panicked");
                }
            },
            TRIM_SPACING,
        )));
        let first = trims.request().expect("the first unload trims");
        first.await.expect("the trims survive the panic");
        let next = trims.request().expect("a later unload trims");
        next.await.expect("the trims ended");
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }
}
