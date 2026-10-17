//! A connection's update allowance (Epo 2026-10-18): a burst plus a
//! sustained rate, in SYNC messages and in their bytes, far above what a
//! person typing or pasting sends. A socket over it closes as too fast and
//! its editor resyncs (`socket.rs`).

use std::time::Instant;

/// The allowance's sizes (`COLLABORATION_UPDATE_*`, `config.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub burst_updates: u64,
    pub burst_bytes: u64,
    pub updates_per_second: u64,
    pub bytes_per_second: u64,
}

/// Two token buckets, full when the socket opens. A message is over the
/// limit when either bucket is empty as it arrives; otherwise it takes one
/// update and its bytes, the byte bucket possibly going into debt, so one
/// message larger than the burst (a large paste, a resync's step 2) passes
/// when the bucket has refilled, and the next waits out the debt.
#[derive(Debug)]
pub struct Allowance {
    limits: Limits,
    updates: f64,
    bytes: f64,
    at: Instant,
}

impl Allowance {
    pub fn new(limits: Limits, now: Instant) -> Self {
        Allowance {
            limits,
            updates: limits.burst_updates as f64,
            bytes: limits.burst_bytes as f64,
            at: now,
        }
    }

    /// Takes one message of `bytes`; false when the connection is over its
    /// limit (nothing is taken then).
    pub fn take(&mut self, bytes: usize, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        self.at = now;
        let refill = |held: f64, per_second: u64, burst: u64| {
            (held + elapsed * per_second as f64).min(burst as f64)
        };
        self.updates = refill(
            self.updates,
            self.limits.updates_per_second,
            self.limits.burst_updates,
        );
        self.bytes = refill(
            self.bytes,
            self.limits.bytes_per_second,
            self.limits.burst_bytes,
        );
        if self.updates <= 0.0 || self.bytes <= 0.0 {
            return false;
        }
        self.updates -= 1.0;
        self.bytes -= bytes as f64;
        true
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// Round sizes for the arithmetic below (the defaults are in config.rs).
    const LIMITS: Limits = Limits {
        burst_updates: 300,
        burst_bytes: 8 << 20,
        updates_per_second: 60,
        bytes_per_second: 2 << 20,
    };

    /// Messages of `bytes` every `every`, from `start`, until one is over the
    /// limit or `count` went: how many passed.
    fn passed(
        allowance: &mut Allowance,
        start: Instant,
        every: Duration,
        bytes: usize,
        count: u32,
    ) -> u32 {
        (0..count)
            .take_while(|index| allowance.take(bytes, start + every * *index))
            .count() as u32
    }

    #[test]
    fn the_burst_goes_at_once_then_the_sustained_rate() {
        let start = Instant::now();
        let mut allowance = Allowance::new(LIMITS, start);
        assert_eq!(
            passed(&mut allowance, start, Duration::ZERO, 100, 1000),
            300
        );
        // A second later, 60 more.
        let later = start + Duration::from_secs(1);
        assert_eq!(passed(&mut allowance, later, Duration::ZERO, 100, 1000), 60);
    }

    #[test]
    fn a_steady_stream_below_the_rate_never_runs_out() {
        let start = Instant::now();
        let mut allowance = Allowance::new(LIMITS, start);
        // 50 a second for ten minutes.
        assert_eq!(
            passed(
                &mut allowance,
                start,
                Duration::from_millis(20),
                200,
                30_000
            ),
            30_000
        );
        // Above the rate, the burst lasts 300 / (100 - 60) s.
        let mut fast = Allowance::new(LIMITS, start);
        let gone = passed(&mut fast, start, Duration::from_millis(10), 200, 10_000);
        assert!((740..=760).contains(&gone), "{gone}");
    }

    #[test]
    fn bytes_run_out_before_updates_and_one_large_message_passes() {
        let start = Instant::now();
        let mut allowance = Allowance::new(LIMITS, start);
        // Four 2 MiB messages fill the 8 MiB burst; the fifth is over.
        assert_eq!(
            passed(&mut allowance, start, Duration::ZERO, 2 << 20, 10),
            4
        );
        // One message past the whole burst passes on a full bucket and
        // leaves a debt the sustained rate pays off (here 12 MiB: 6 s).
        let mut large = Allowance::new(LIMITS, start);
        assert!(large.take(20 << 20, start));
        assert!(!large.take(10, start + Duration::from_millis(5900)));
        assert!(large.take(10, start + Duration::from_millis(6100)));
    }
}
