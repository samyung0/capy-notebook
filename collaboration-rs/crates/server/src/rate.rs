//! A user's update allowance (Epo 2026-10-18): a burst plus a sustained
//! rate, in SYNC messages and in their bytes, far above what a person typing
//! or pasting sends. It belongs to the user: their sockets and draft sends
//! all take from it, and it is kept a minute after its last use, so a
//! reconnect gets no fresh burst. A socket over it closes as too fast and its
//! editor resyncs (`socket.rs`); a draft send over it is refused
//! (`drafts.rs`). No update may be larger than the byte burst
//! (`ydoc::MAX_UPDATE_BYTES`), so every update fits a full allowance.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

/// The allowance's sizes (`COLLABORATION_UPDATE_*`, `config.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub burst_updates: u64,
    pub burst_bytes: u64,
    pub updates_per_second: u64,
    pub bytes_per_second: u64,
}

/// How long an allowance is kept after its last use (and until it has
/// refilled): a reconnect within it goes on from what was left.
const KEEP: Duration = Duration::from_secs(60);

/// Two token buckets, full when first used. A message is over the limit when
/// either bucket holds less than it costs (one update, its bytes); then
/// nothing is taken.
#[derive(Debug)]
struct Allowance {
    updates: f64,
    bytes: f64,
    at: Instant,
}

impl Allowance {
    fn full(limits: &Limits, now: Instant) -> Self {
        Allowance {
            updates: limits.burst_updates as f64,
            bytes: limits.burst_bytes as f64,
            at: now,
        }
    }

    fn refill(&mut self, limits: &Limits, now: Instant) {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        self.at = now;
        self.updates = (self.updates + elapsed * limits.updates_per_second as f64)
            .min(limits.burst_updates as f64);
        self.bytes =
            (self.bytes + elapsed * limits.bytes_per_second as f64).min(limits.burst_bytes as f64);
    }

    fn take(&mut self, limits: &Limits, bytes: usize, now: Instant) -> bool {
        self.refill(limits, now);
        if self.updates < 1.0 || self.bytes < bytes as f64 {
            return false;
        }
        self.updates -= 1.0;
        self.bytes -= bytes as f64;
        true
    }

    /// Unused for [KEEP] and refilled by `now`: a fresh one is the same.
    fn spent(&self, limits: &Limits, now: Instant) -> bool {
        let idle = now.saturating_duration_since(self.at);
        let seconds = idle.as_secs_f64();
        idle >= KEEP
            && self.updates + seconds * limits.updates_per_second as f64
                >= limits.burst_updates as f64
            && self.bytes + seconds * limits.bytes_per_second as f64 >= limits.burst_bytes as f64
    }
}

/// Every user's allowance in this process.
#[derive(Debug)]
pub struct Allowances {
    limits: Limits,
    users: Mutex<Users>,
}

#[derive(Debug)]
struct Users {
    by_user: HashMap<String, Allowance>,
    /// When unused allowances were last dropped.
    swept: Instant,
}

impl Allowances {
    pub fn new(limits: Limits, now: Instant) -> Self {
        Allowances {
            limits,
            users: Mutex::new(Users {
                by_user: HashMap::new(),
                swept: now,
            }),
        }
    }

    /// Takes one message of `bytes` from `user`'s allowance; false when the
    /// user is over it (nothing is taken then).
    pub fn take(&self, user: &str, bytes: usize, now: Instant) -> bool {
        let limits = &self.limits;
        let mut users = self.users.lock().unwrap_or_else(PoisonError::into_inner);
        if now.saturating_duration_since(users.swept) >= KEEP {
            users.swept = now;
            users
                .by_user
                .retain(|_, allowance| !allowance.spent(limits, now));
        }
        match users.by_user.get_mut(user) {
            Some(allowance) => allowance.take(limits, bytes, now),
            None => {
                let mut allowance = Allowance::full(limits, now);
                let taken = allowance.take(limits, bytes, now);
                users.by_user.insert(user.to_owned(), allowance);
                taken
            }
        }
    }

    #[cfg(test)]
    fn held(&self) -> usize {
        self.users
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .by_user
            .len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round sizes for the arithmetic below (the defaults are in config.rs).
    const LIMITS: Limits = Limits {
        burst_updates: 300,
        burst_bytes: 8 << 20,
        updates_per_second: 60,
        bytes_per_second: 2 << 20,
    };

    /// `user`'s messages of `bytes` every `every`, from `start`, until one is
    /// over the limit or `count` went: how many passed.
    fn passed(
        allowances: &Allowances,
        user: &str,
        start: Instant,
        every: Duration,
        bytes: usize,
        count: u32,
    ) -> u32 {
        (0..count)
            .take_while(|index| allowances.take(user, bytes, start + every * *index))
            .count() as u32
    }

    #[test]
    fn the_burst_goes_at_once_then_the_sustained_rate() {
        let start = Instant::now();
        let allowances = Allowances::new(LIMITS, start);
        assert_eq!(
            passed(&allowances, "u1", start, Duration::ZERO, 100, 1000),
            300
        );
        // A second later, 60 more.
        let later = start + Duration::from_secs(1);
        assert_eq!(
            passed(&allowances, "u1", later, Duration::ZERO, 100, 1000),
            60
        );
    }

    #[test]
    fn a_steady_stream_below_the_rate_never_runs_out() {
        let start = Instant::now();
        let allowances = Allowances::new(LIMITS, start);
        // 50 a second for ten minutes.
        assert_eq!(
            passed(
                &allowances,
                "u1",
                start,
                Duration::from_millis(20),
                200,
                30_000
            ),
            30_000
        );
        // Above the rate, the burst lasts 300 / (100 - 60) s.
        let gone = passed(
            &allowances,
            "u2",
            start,
            Duration::from_millis(10),
            200,
            10_000,
        );
        assert!((740..=760).contains(&gone), "{gone}");
    }

    #[test]
    fn a_message_waits_for_the_bytes_it_needs() {
        let start = Instant::now();
        let allowances = Allowances::new(LIMITS, start);
        // Four 2 MiB messages fill the 8 MiB burst; the fifth is over.
        assert_eq!(
            passed(&allowances, "u1", start, Duration::ZERO, 2 << 20, 10),
            4
        );
        // A whole burst's message needs the whole burst back: 4 s.
        let fresh = Allowances::new(LIMITS, start);
        assert!(fresh.take("u1", 8 << 20, start));
        assert!(!fresh.take("u1", 8 << 20, start + Duration::from_millis(3900)));
        assert!(fresh.take("u1", 8 << 20, start + Duration::from_millis(4100)));
    }

    /// The allowance is the user's: their second socket, or a reconnect a
    /// moment later, goes on from what the first left (Epo 2026-10-18), while
    /// another user's is their own.
    #[test]
    fn users_share_one_allowance_across_sockets_and_reconnects() {
        let start = Instant::now();
        let allowances = Allowances::new(LIMITS, start);
        assert_eq!(
            passed(&allowances, "u1", start, Duration::ZERO, 10, 300),
            300
        );
        let reconnect = start + Duration::from_millis(100);
        // Six refilled, not a fresh 300.
        assert_eq!(
            passed(&allowances, "u1", reconnect, Duration::ZERO, 10, 300),
            6
        );
        assert_eq!(
            passed(&allowances, "u2", reconnect, Duration::ZERO, 10, 300),
            300
        );
    }

    /// An allowance unused for a minute and refilled is dropped (a fresh one
    /// is the same); one still refilling is kept.
    #[test]
    fn unused_allowances_go_after_a_minute_once_refilled() {
        let start = Instant::now();
        let slow = Limits {
            updates_per_second: 1,
            ..LIMITS
        };
        let allowances = Allowances::new(slow, start);
        assert!(allowances.take("refilled", 10, start));
        assert_eq!(
            passed(&allowances, "spent", start, Duration::ZERO, 10, 300),
            300
        );
        let later = start + KEEP;
        assert!(allowances.take("other", 10, later));
        // "refilled" was full again; "spent" has refilled 60 of its 300.
        assert_eq!(allowances.held(), 2);
        assert_eq!(
            passed(&allowances, "spent", later, Duration::ZERO, 10, 300),
            60
        );
    }
}
