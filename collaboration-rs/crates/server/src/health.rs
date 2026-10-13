//! `collab_health` (the Node server's `health.ts`): one line per interval
//! with scheduling lag, message rates, store durations per kind of room,
//! connections and rooms; `slow_save` lines at 2 s or more.

use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::app::Shared;
use crate::observe::{Level, log};

/// A save this long or longer also logs its own `slow_save` line.
pub const SLOW_SAVE: Duration = Duration::from_secs(2);

/// The value at quantile `p` (0-1), or 0 for none. Sorts in place.
pub fn percentile(values: &mut [f64], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    let rank = (p * values.len() as f64).ceil() as usize;
    values[rank.saturating_sub(1).min(values.len() - 1)]
}

#[derive(Default)]
struct Timings {
    durations: Vec<f64>,
    failures: u64,
}

/// One interval's store durations and failures for a kind of room.
#[derive(Default)]
pub struct StoreTimings {
    kind: &'static str,
    inner: Mutex<Timings>,
}

impl StoreTimings {
    fn new(kind: &'static str) -> Self {
        StoreTimings {
            kind,
            inner: Mutex::default(),
        }
    }

    #[allow(clippy::unwrap_used)]
    pub fn record(&self, elapsed: Duration, ok: bool, bytes: usize, room: &str) {
        let ms = elapsed.as_secs_f64() * 1e3;
        {
            let mut inner = self.inner.lock().unwrap();
            inner.durations.push(ms);
            if !ok {
                inner.failures += 1;
            }
        }
        if elapsed >= SLOW_SAVE {
            log(
                Level::Warn,
                "slow_save",
                json!({ "bytes": bytes, "kind": self.kind, "ms": ms.round(), "ok": ok, "room": room }),
            );
        }
    }

    #[allow(clippy::unwrap_used)]
    fn take(&self) -> serde_json::Value {
        let Timings {
            mut durations,
            failures,
        } = std::mem::take(&mut *self.inner.lock().unwrap());
        let max = durations.iter().copied().fold(0.0, f64::max);
        json!({
            "count": durations.len(),
            "failures": failures,
            "max_ms": max.round(),
            "p95_ms": percentile(&mut durations, 0.95).round(),
        })
    }
}

pub struct Health {
    pub material: StoreTimings,
    pub source: StoreTimings,
    lags: Mutex<Vec<f64>>,
}

impl Default for Health {
    fn default() -> Self {
        Health {
            material: StoreTimings::new("material"),
            source: StoreTimings::new("source"),
            lags: Mutex::default(),
        }
    }
}

const LAG_PROBE: Duration = Duration::from_millis(20);

/// Runs the lag probe (a 20 ms timer's lateness: the runtime's counterpart of
/// the event-loop delay) and logs `collab_health` every interval.
pub async fn run(app: Shared) {
    let interval = app.config.health_interval;
    let mut since = Instant::now();
    let mut next_log = since + interval;
    let mut tick = tokio::time::interval(LAG_PROBE);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut expected = Instant::now();
    loop {
        tick.tick().await;
        let now = Instant::now();
        let late = now.saturating_duration_since(expected).as_secs_f64() * 1e3;
        expected = now + LAG_PROBE;
        #[allow(clippy::unwrap_used)]
        app.health.lags.lock().unwrap().push(late);
        if now < next_log {
            continue;
        }
        let seconds = now.duration_since(since).as_secs_f64().max(1.0);
        #[allow(clippy::unwrap_used)]
        let mut lags = std::mem::take(&mut *app.health.lags.lock().unwrap());
        let max = lags.iter().copied().fold(0.0, f64::max);
        let rate = |count: u64| (count as f64 / seconds * 10.0).round() / 10.0;
        let (save, background) = app.sources.engines().take_stats();
        let render = app.sources.engines().take_render_stats();
        log(
            Level::Info,
            "collab_health",
            json!({
                "connections": app.stats.connections.load(Ordering::Relaxed),
                "rooms": app.rooms.len(),
                "awareness_per_s": rate(app.stats.awareness.swap(0, Ordering::Relaxed)),
                "lag_max_ms": max.round(),
                "lag_p99_ms": percentile(&mut lags, 0.99).round(),
                "material_stores": app.health.material.take(),
                "office": { "background": background, "render": render, "save": save },
                "source_stores": app.health.source.take(),
                "updates_per_s": rate(app.stats.updates.swap(0, Ordering::Relaxed)),
                "log_bytes": app.stats.log_bytes.load(Ordering::Relaxed),
            }),
        );
        since = now;
        next_log = now + interval;
    }
}

/// `/metrics` in the Prometheus text format, the Node server's names.
pub fn metrics(app: &Shared) -> String {
    let stats = &app.stats;
    let rss = memory_rss();
    format!(
        "capy_collaboration_active_rooms {}\ncapy_collaboration_connections {}\ncapy_collaboration_authentication_failures_total {}\ncapy_collaboration_store_failures_total {}\ncapy_collaboration_failed_store_queue {}\ncapy_collaboration_process_rss_bytes {}\ncapy_collaboration_room_log_bytes {}\n",
        app.rooms.len(),
        stats.connections.load(Ordering::Relaxed),
        stats.authentication_failures.load(Ordering::Relaxed),
        stats.store_failures.load(Ordering::Relaxed),
        stats.failed_stores.load(Ordering::Relaxed),
        rss,
        stats.log_bytes.load(Ordering::Relaxed),
    ) + &crate::drafts::Class::ALL
        .iter()
        .map(|class| {
            format!(
                "capy_collaboration_draft_refusals_total{{class=\"{}\"}} {}\n",
                class.as_str(),
                stats.draft_refusals[*class as usize].load(Ordering::Relaxed)
            )
        })
        .collect::<String>()
}

/// Resident set size from /proc (0 where there is none, as on Windows).
fn memory_rss() -> u64 {
    std::fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|statm| statm.split_whitespace().nth(1)?.parse::<u64>().ok())
        .map(|pages| pages * 4096)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_as_the_node_health_line() {
        assert_eq!(percentile(&mut [], 0.95), 0.0);
        let mut values: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(percentile(&mut values, 0.95), 95.0);
        assert_eq!(percentile(&mut [5.0, 1.0, 3.0], 0.99), 5.0);
    }

    #[test]
    fn timings_summarize_and_reset() {
        let timings = StoreTimings::new("material");
        timings.record(Duration::from_millis(10), true, 1, "r");
        timings.record(Duration::from_millis(30), false, 1, "r");
        let summary = timings.take();
        assert_eq!(summary["count"], 2);
        assert_eq!(summary["failures"], 1);
        assert_eq!(summary["max_ms"], 30.0);
        assert_eq!(timings.take()["count"], 0);
    }
}
