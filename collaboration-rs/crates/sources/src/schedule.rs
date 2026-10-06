//! When a source room stores (sourceDebounce.ts) and when a failed store is
//! tried again (failedStoreRetry.ts). Pure timing: the server's room task and
//! retry loop own the timers and call these with the current instant.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Source rooms debounce their stores 5 s after the last change, at most
/// 30 s after the first (Epo 2026-09-28); material rooms keep 2 s / 10 s.
pub const SOURCE_DEBOUNCE: Duration = Duration::from_secs(5);
pub const SOURCE_MAX_DEBOUNCE: Duration = Duration::from_secs(30);

/// A room's debounced store: armed by the first change after a store,
/// pushed back by each later change, never past the maximum. An immediate
/// store (eviction, shutdown, an explicit save) does not wait for it.
#[derive(Clone, Copy, Debug)]
pub struct Debounce {
    pub delay: Duration,
    pub max_delay: Duration,
    first: Option<Instant>,
    last: Option<Instant>,
}

impl Debounce {
    pub fn new(delay: Duration, max_delay: Duration) -> Self {
        Self {
            delay,
            max_delay,
            first: None,
            last: None,
        }
    }

    pub fn source() -> Self {
        Self::new(SOURCE_DEBOUNCE, SOURCE_MAX_DEBOUNCE)
    }

    /// A change: when the store is due now.
    pub fn changed(&mut self, now: Instant) -> Instant {
        self.first.get_or_insert(now);
        self.last = Some(now);
        self.due().unwrap_or(now)
    }

    /// When the debounced store runs, if one waits.
    pub fn due(&self) -> Option<Instant> {
        let (first, last) = (self.first?, self.last?);
        Some((last + self.delay).min(first + self.max_delay))
    }

    /// Whether a debounced store is still waiting (storeDebounced).
    pub fn waiting(&self) -> bool {
        self.first.is_some()
    }

    /// The store started: the next change arms a new window.
    pub fn started(&mut self) {
        self.first = None;
        self.last = None;
    }
}

/// Whether a source room's checkpoint request persists now (persistsNow): an
/// explicit save does, and an idle request does when no debounced store is
/// waiting to carry its receipt.
pub fn persists_now(flush: bool, debounce: &Debounce) -> bool {
    flush || !debounce.waiting()
}

// A room's retries back off from 5 s, doubling, up to 60 s.
pub const RETRY_FIRST: Duration = Duration::from_secs(5);
pub const RETRY_MAX: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug)]
struct Wait {
    delay: Duration,
    due: Instant,
}

/// The per-room backoff of failed-store retries (FailedStoreRetryRunner): a
/// newly failed room is retried on the next pass (the store failed up to one
/// tick ago), then after 5, 10, 20, 40 and 60 s. The retry pass runs every
/// 5 s; no other retry exists.
#[derive(Debug, Default)]
pub struct RetryBackoff {
    rooms: HashMap<String, Wait>,
}

impl RetryBackoff {
    /// The rooms of `failed` due for a retry now, in the given order; rooms no
    /// longer failed are forgotten.
    pub fn due<'a>(
        &mut self,
        failed: impl IntoIterator<Item = &'a str>,
        now: Instant,
    ) -> Vec<String> {
        let failed: Vec<&str> = failed.into_iter().collect();
        self.rooms.retain(|room, _| failed.contains(&room.as_str()));
        failed
            .into_iter()
            .filter(|room| {
                let wait = self.rooms.entry((*room).to_owned()).or_insert(Wait {
                    delay: RETRY_FIRST / 2,
                    due: now,
                });
                now >= wait.due
            })
            .map(str::to_owned)
            .collect()
    }

    /// After a retry: a room still failed waits twice as long (up to 60 s), a
    /// room that saved is forgotten.
    pub fn retried(&mut self, room: &str, still_failed: bool, now: Instant) {
        if !still_failed {
            self.rooms.remove(room);
            return;
        }
        if let Some(wait) = self.rooms.get_mut(room) {
            wait.delay = (wait.delay * 2).min(RETRY_MAX);
            wait.due = now + wait.delay;
        }
    }

    /// Whether a failed room still waits out its backoff: its live saves wait
    /// too, so a state that keeps timing out in the engine is tried once per
    /// backoff step, not on every debounce.
    pub fn waiting(&self, room: &str, failed: bool, now: Instant) -> bool {
        failed && self.rooms.get(room).is_some_and(|wait| now < wait.due)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_source_store_waits_5_s_after_the_last_change_and_at_most_30_s() {
        let start = Instant::now();
        let mut debounce = Debounce::source();
        assert!(!debounce.waiting());
        assert_eq!(debounce.changed(start), start + Duration::from_secs(5));
        assert_eq!(
            debounce.changed(start + Duration::from_secs(4)),
            start + Duration::from_secs(9)
        );
        // Typing every 4 s never lets 5 s pass: the 30 s cap stores anyway.
        let mut due = start;
        for second in (8..40).step_by(4) {
            due = debounce.changed(start + Duration::from_secs(second));
        }
        assert_eq!(due, start + Duration::from_secs(30));
        debounce.started();
        assert!(debounce.due().is_none());
    }

    #[test]
    fn an_explicit_save_persists_now_an_idle_request_only_without_a_waiting_store() {
        let mut debounce = Debounce::source();
        debounce.changed(Instant::now());
        assert!(persists_now(true, &debounce));
        assert!(!persists_now(false, &debounce));
        debounce.started();
        assert!(persists_now(false, &debounce));
    }

    #[test]
    fn a_failing_room_backs_off_from_5_to_60_s() {
        let start = Instant::now();
        let mut backoff = RetryBackoff::default();
        let room = "source:f:epoch:1";
        let mut now = start;
        let mut retries = Vec::new();
        while now < start + Duration::from_secs(200) {
            if backoff.due([room], now) == [room] {
                retries.push((now - start).as_secs());
                backoff.retried(room, true, now);
            }
            now += Duration::from_secs(5);
        }
        assert_eq!(retries, [0, 5, 15, 35, 75, 135, 195]);
        // Live saves wait while it is not due; a success forgets it.
        assert!(backoff.waiting(room, true, start + Duration::from_secs(196)));
        assert!(!backoff.waiting(room, false, start + Duration::from_secs(196)));
        backoff.retried(room, false, now);
        assert!(!backoff.waiting(room, true, now));
        // A room no longer failed drops out of the next pass.
        assert!(backoff.due([room], now).contains(&room.to_owned()));
        assert!(backoff.due(std::iter::empty(), now).is_empty());
        assert!(backoff.rooms.is_empty());
    }
}
