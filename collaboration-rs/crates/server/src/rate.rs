//! A user's update allowance (Epo 2026-10-18): a burst plus a sustained
//! rate, in messages and in their bytes, far above what a person typing or
//! pasting sends. It belongs to the user: their sockets and draft sends all
//! take from it (SYNC, awareness, awareness queries and JOINs), and it is
//! kept a minute after its last use, so a reconnect gets no fresh burst.
//!
//! Beside it, the user's open budget (Epo 2026-10-19): the full-document
//! answers their opens receive (a step 1's, an awareness query's, the
//! awareness sent on JOIN) are charged to it by their bytes once encoded. It
//! refills continuously, full again over [OPEN_REFILL] from empty; spent, the
//! user's next step 1 or query waits until it is back above zero (`socket.rs`),
//! slowed, never refused.
//!
//! A user over it, or sending an update over `ydoc::MAX_UPDATE_BYTES`, is in
//! a timeout (Epo 2026-10-18): nothing of theirs that could change a document
//! goes on, on any socket or draft send, until it ends, and each of their
//! sockets hears that it started and how long it lasts (`socket.rs`). It
//! lasts until the allowance covers the refused message, at least
//! [TIMEOUT_MIN], the least doubled for each further timeout within
//! [REPEAT_WINDOW] of the last one's end, at most [TIMEOUT_MAX]. No update
//! may be larger than the byte burst, so every update fits a full allowance.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use tokio::sync::broadcast;

/// The allowance's sizes (`COLLABORATION_UPDATE_*`) and the open budget's
/// (`COLLABORATION_OPEN_*`, `config.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub burst_updates: u64,
    pub burst_bytes: u64,
    pub updates_per_second: u64,
    pub bytes_per_second: u64,
    pub open_bytes: u64,
    /// Seconds the open budget takes to refill from empty.
    pub open_refill_seconds: u64,
}

/// The open budget (Epo 2026-10-19): about 80 MiB, enough to browse 3-4
/// large documents.
pub const OPEN_BYTES: u64 = 80 << 20;
/// The open budget refills to full over 5 minutes from empty (Epo
/// 2026-10-19), about 0.27 MiB a second.
pub const OPEN_REFILL: Duration = Duration::from_secs(300);

impl Limits {
    fn open_per_second(&self) -> f64 {
        self.open_bytes as f64 / self.open_refill_seconds as f64
    }
}

/// How long an allowance is kept after its last use (and until it has
/// refilled): a reconnect within it goes on from what was left.
const KEEP: Duration = Duration::from_secs(60);
/// The shortest timeout, so the paused editors are seen.
pub const TIMEOUT_MIN: Duration = Duration::from_secs(3);
/// The longest timeout.
pub const TIMEOUT_MAX: Duration = Duration::from_secs(300);
/// A timeout starting within this long of the last one's end doubles the
/// least length.
pub const REPEAT_WINDOW: Duration = Duration::from_secs(600);

/// What happened to a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Taken from the allowance: it goes on.
    Taken,
    /// The user is in a timeout, which this message started (`started`) or
    /// which was running: the message is dropped.
    TimedOut { remaining: Duration, started: bool },
}

/// A user's timeout began (every socket of theirs tells its client).
#[derive(Clone, Debug)]
pub struct TimedOut {
    pub user: Arc<str>,
    pub until: Instant,
}

/// Two token buckets, full when first used. A message is over the limit when
/// either bucket holds less than it costs (one message, its bytes); then
/// nothing is taken. Beside them the open budget, which an answer charged
/// after it was encoded may leave below zero.
#[derive(Debug)]
struct Allowance {
    updates: f64,
    bytes: f64,
    open: f64,
    at: Instant,
    /// The end of the user's last timeout.
    until: Option<Instant>,
    /// Further timeouts in a row, each within [REPEAT_WINDOW] of the last.
    repeats: u32,
}

impl Allowance {
    fn full(limits: &Limits, now: Instant) -> Self {
        Allowance {
            updates: limits.burst_updates as f64,
            bytes: limits.burst_bytes as f64,
            open: limits.open_bytes as f64,
            at: now,
            until: None,
            repeats: 0,
        }
    }

    fn refill(&mut self, limits: &Limits, now: Instant) {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        self.at = now;
        self.updates = (self.updates + elapsed * limits.updates_per_second as f64)
            .min(limits.burst_updates as f64);
        self.bytes =
            (self.bytes + elapsed * limits.bytes_per_second as f64).min(limits.burst_bytes as f64);
        self.open = (self.open + elapsed * limits.open_per_second()).min(limits.open_bytes as f64);
    }

    fn remaining(&self, now: Instant) -> Option<Duration> {
        self.until
            .filter(|until| now < *until)
            .map(|until| until - now)
    }

    fn take(&mut self, limits: &Limits, bytes: usize, now: Instant) -> Verdict {
        if let Some(remaining) = self.remaining(now) {
            return Verdict::TimedOut {
                remaining,
                started: false,
            };
        }
        self.refill(limits, now);
        if self.updates >= 1.0 && self.bytes >= bytes as f64 {
            self.updates -= 1.0;
            self.bytes -= bytes as f64;
            return Verdict::Taken;
        }
        let missing_updates = (1.0 - self.updates).max(0.0) / limits.updates_per_second as f64;
        let missing_bytes = (bytes as f64 - self.bytes).max(0.0) / limits.bytes_per_second as f64;
        let covered = Duration::from_secs_f64(missing_updates.max(missing_bytes));
        self.start(covered, now)
    }

    /// A timeout of at least `covered` begins now.
    fn start(&mut self, covered: Duration, now: Instant) -> Verdict {
        self.repeats = match self.until {
            Some(end) if now < end + REPEAT_WINDOW => self.repeats.saturating_add(1),
            _ => 0,
        };
        let least = TIMEOUT_MIN.saturating_mul(2u32.saturating_pow(self.repeats));
        let remaining = covered.max(least).min(TIMEOUT_MAX);
        self.until = Some(now + remaining);
        Verdict::TimedOut {
            remaining,
            started: true,
        }
    }

    /// Unused for [KEEP], refilled by `now` and with no timeout to remember:
    /// a fresh one is the same.
    fn spent(&self, limits: &Limits, now: Instant) -> bool {
        let idle = now.saturating_duration_since(self.at);
        let seconds = idle.as_secs_f64();
        idle >= KEEP
            && self.updates + seconds * limits.updates_per_second as f64
                >= limits.burst_updates as f64
            && self.bytes + seconds * limits.bytes_per_second as f64 >= limits.burst_bytes as f64
            && self.open + seconds * limits.open_per_second() >= limits.open_bytes as f64
            && self.until.is_none_or(|end| now >= end + REPEAT_WINDOW)
    }
}

/// Every user's allowance in this process.
#[derive(Debug)]
pub struct Allowances {
    limits: Limits,
    users: Mutex<Users>,
    timeouts: broadcast::Sender<TimedOut>,
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
            timeouts: broadcast::channel(256).0,
        }
    }

    /// `user`'s allowance (full when new) under the lock; unused ones are
    /// dropped at most once per [KEEP].
    fn with<T>(&self, user: &str, now: Instant, f: impl FnOnce(&mut Allowance) -> T) -> T {
        let limits = &self.limits;
        let mut users = self.users.lock().unwrap_or_else(PoisonError::into_inner);
        if now.saturating_duration_since(users.swept) >= KEEP {
            users.swept = now;
            users
                .by_user
                .retain(|_, allowance| !allowance.spent(limits, now));
        }
        let allowance = users
            .by_user
            .entry(user.to_owned())
            .or_insert_with(|| Allowance::full(limits, now));
        f(allowance)
    }

    /// Tells every socket of `user` that their timeout started.
    fn announce(&self, user: &str, verdict: Verdict, now: Instant) -> Verdict {
        if let Verdict::TimedOut {
            remaining,
            started: true,
        } = verdict
        {
            let _ = self.timeouts.send(TimedOut {
                user: user.into(),
                until: now + remaining,
            });
        }
        verdict
    }

    /// Takes one message of `bytes` from `user`'s allowance, or times the
    /// user out (nothing is taken then).
    pub fn take(&self, user: &str, bytes: usize, now: Instant) -> Verdict {
        let verdict = self.with(user, now, |allowance| {
            allowance.take(&self.limits, bytes, now)
        });
        self.announce(user, verdict, now)
    }

    /// An update over the cap: a timeout of the least length begins, unless
    /// one is running.
    pub fn time_out(&self, user: &str, now: Instant) -> Verdict {
        let verdict = self.with(user, now, |allowance| match allowance.remaining(now) {
            Some(remaining) => Verdict::TimedOut {
                remaining,
                started: false,
            },
            None => allowance.start(Duration::ZERO, now),
        });
        self.announce(user, verdict, now)
    }

    /// Charges a full-document answer's `bytes` encoded for `user` (a step
    /// 1's, an awareness query's, the awareness sent on JOIN) to their open
    /// budget, which may go below zero.
    pub fn charge_open(&self, user: &str, bytes: usize, now: Instant) {
        self.with(user, now, |allowance| {
            allowance.refill(&self.limits, now);
            allowance.open -= bytes as f64;
        });
    }

    /// How long `user`'s next step 1 or query waits: until their open budget
    /// is back above zero.
    pub fn open_wait(&self, user: &str, now: Instant) -> Option<Duration> {
        let per_second = self.limits.open_per_second();
        self.with(user, now, |allowance| {
            allowance.refill(&self.limits, now);
            (allowance.open < 0.0).then(|| Duration::from_secs_f64(-allowance.open / per_second))
        })
    }

    /// How long `user`'s running timeout has left.
    pub fn remaining(&self, user: &str, now: Instant) -> Option<Duration> {
        let users = self.users.lock().unwrap_or_else(PoisonError::into_inner);
        users.by_user.get(user)?.remaining(now)
    }

    /// Timeouts as they begin.
    pub fn subscribe(&self) -> broadcast::Receiver<TimedOut> {
        self.timeouts.subscribe()
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
        open_bytes: OPEN_BYTES,
        open_refill_seconds: OPEN_REFILL.as_secs(),
    };

    fn secs(seconds: f64) -> Duration {
        Duration::from_secs_f64(seconds)
    }

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
            .take_while(|index| {
                allowances.take(user, bytes, start + every * *index) == Verdict::Taken
            })
            .count() as u32
    }

    fn started(remaining: Duration) -> Verdict {
        Verdict::TimedOut {
            remaining,
            started: true,
        }
    }

    #[test]
    fn the_burst_goes_at_once_then_the_sustained_rate() {
        let start = Instant::now();
        let allowances = Allowances::new(LIMITS, start);
        assert_eq!(
            passed(&allowances, "u1", start, Duration::ZERO, 100, 300),
            300
        );
        // A second later, 60 more; the next is over.
        let later = start + Duration::from_secs(1);
        assert_eq!(
            passed(&allowances, "u1", later, Duration::ZERO, 100, 60),
            60
        );
        assert_eq!(allowances.take("u1", 100, later), started(TIMEOUT_MIN));
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
        assert_eq!(fresh.take("u1", 8 << 20, start), Verdict::Taken);
        assert_eq!(fresh.take("u1", 8 << 20, start + secs(4.1)), Verdict::Taken);
        assert_eq!(fresh.take("u2", 8 << 20, start), Verdict::Taken);
        assert!(matches!(
            fresh.take("u2", 8 << 20, start + secs(3.9)),
            Verdict::TimedOut { started: true, .. }
        ));
    }

    /// A timeout lasts until the refused message fits, at least 3 s, the
    /// least doubling for each further one within 10 minutes of the last
    /// one's end, at most 5 minutes (Epo 2026-10-18); nothing is taken
    /// meanwhile.
    #[test]
    fn a_timeout_lasts_until_the_message_fits_doubling_when_repeated() {
        let start = Instant::now();
        let allowances = Allowances::new(LIMITS, start);
        assert_eq!(allowances.take("u1", 8 << 20, start), Verdict::Taken);
        // The refused 8 MiB needs 4 s of refill.
        assert_eq!(allowances.take("u1", 8 << 20, start), started(secs(4.0)));
        assert_eq!(
            allowances.take("u1", 1, start + secs(1.0)),
            Verdict::TimedOut {
                remaining: secs(3.0),
                started: false
            }
        );
        assert_eq!(
            allowances.remaining("u1", start + secs(1.0)),
            Some(secs(3.0))
        );
        let end = start + secs(4.0);
        assert_eq!(allowances.remaining("u1", end), None);
        assert_eq!(allowances.take("u1", 8 << 20, end), Verdict::Taken);
        // A further one within 10 minutes: at least 6 s, then 12 s, ... up to
        // 5 minutes.
        assert_eq!(allowances.take("u1", 1, end), started(secs(6.0)));
        let mut at = end + secs(6.0);
        for least in [12.0, 24.0, 48.0, 96.0, 192.0, 300.0, 300.0] {
            assert_eq!(allowances.time_out("u1", at), started(secs(least)));
            at += secs(least);
        }
        // Ten minutes after the last one ended, the least is 3 s again.
        let quiet = at + REPEAT_WINDOW;
        assert_eq!(allowances.time_out("u1", quiet), started(TIMEOUT_MIN));
    }

    /// An update over the cap never fits: the timeout has the least length.
    #[test]
    fn an_update_over_the_cap_times_out_for_the_least_length() {
        let start = Instant::now();
        let allowances = Allowances::new(LIMITS, start);
        assert_eq!(allowances.time_out("u1", start), started(TIMEOUT_MIN));
        assert_eq!(
            allowances.time_out("u1", start + secs(1.0)),
            Verdict::TimedOut {
                remaining: secs(2.0),
                started: false
            }
        );
        assert_eq!(
            allowances.time_out("u1", start + TIMEOUT_MIN),
            started(secs(6.0))
        );
    }

    /// Full-document answers draw on the open budget, not the allowance
    /// (Epo 2026-10-19): spent, the next open waits until it is back above
    /// zero, refilling 80 MiB over 5 minutes.
    #[test]
    fn answers_spend_the_open_budget_and_the_next_open_waits_for_it() {
        let start = Instant::now();
        let allowances = Allowances::new(LIMITS, start);
        allowances.charge_open("u1", 60 << 20, start);
        assert_eq!(allowances.open_wait("u1", start), None);
        // 20 MiB below zero: 75 s at 80 MiB per 300 s.
        allowances.charge_open("u1", 40 << 20, start);
        let wait = allowances
            .open_wait("u1", start)
            .expect("the next open waits");
        assert!((wait.as_secs_f64() - 75.0).abs() < 0.01, "{wait:?}");
        assert_eq!(allowances.open_wait("u1", start + wait + secs(0.01)), None);
        // The edit allowance is untouched, and another user's budget is full.
        assert_eq!(
            passed(&allowances, "u1", start, Duration::ZERO, 10, 300),
            300
        );
        assert_eq!(allowances.open_wait("u2", start), None);
    }

    /// Every socket of the user hears that a timeout began.
    #[test]
    fn a_timeout_is_announced_once_when_it_begins() {
        let start = Instant::now();
        let allowances = Allowances::new(LIMITS, start);
        let mut heard = allowances.subscribe();
        assert_eq!(
            passed(&allowances, "u1", start, Duration::ZERO, 10, 1000),
            300
        );
        let _ = allowances.take("u1", 10, start);
        let timeout = heard.try_recv().expect("the timeout is announced");
        assert_eq!(&*timeout.user, "u1");
        assert_eq!(timeout.until, start + TIMEOUT_MIN);
        assert!(heard.try_recv().is_err());
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
    /// is the same); one still refilling, or whose timeout ended less than
    /// ten minutes ago, is kept.
    #[test]
    fn unused_allowances_go_after_a_minute_once_refilled() {
        let start = Instant::now();
        let slow = Limits {
            updates_per_second: 1,
            ..LIMITS
        };
        let allowances = Allowances::new(slow, start);
        assert_eq!(allowances.take("refilled", 10, start), Verdict::Taken);
        assert_eq!(
            allowances.time_out("timed out", start),
            started(TIMEOUT_MIN)
        );
        assert_eq!(
            passed(&allowances, "spent", start, Duration::ZERO, 10, 300),
            300
        );
        let later = start + KEEP;
        assert_eq!(allowances.take("other", 10, later), Verdict::Taken);
        // "refilled" was full again; "spent" has refilled 60 of its 300.
        assert_eq!(allowances.held(), 3);
        assert_eq!(
            passed(&allowances, "spent", later, Duration::ZERO, 10, 300),
            60
        );
    }
}
