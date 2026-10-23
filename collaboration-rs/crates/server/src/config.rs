//! Environment configuration (the Node server's `config.ts`): the same names
//! and local-dev values, plus the Rust server's own (projection idle, folds,
//! the Office engine pool, the markdown bundle, the source disk store). The
//! engine pool and the disk store have no default: each environment sets
//! them (scripts/env/config.py, the compose files, the image), as Epo decided
//! their sizes per environment.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Config {
    pub allowed_origins: BTreeSet<String>,
    pub api_url: String,
    pub database_url: String,
    /// Note rooms' store debounce and its cap.
    pub debounce: Duration,
    pub max_debounce: Duration,
    pub host: String,
    pub port: u16,
    pub redis_url: String,
    pub secret: String,
    /// Source rooms' store debounce and its cap.
    pub source_debounce: Duration,
    pub source_max_debounce: Duration,
    /// UAT only: holds a publication while its file's name has the marker.
    pub uat_publication_hold: bool,
    /// A note projects after this long without a content change (Epo 2026-10-07).
    pub projection_idle: Duration,
    /// A note edited without such a pause still projects this often (Epo
    /// 2026-10-08).
    pub projection_cadence: Duration,
    /// A loaded room folds its log past `max(fold_min_bytes, base bytes)` or
    /// `fold_max_rows` rows (DESIGN.md 3.5); an unloaded one always.
    pub fold_min_bytes: u64,
    pub fold_max_rows: u64,
    /// A fold collects the tombstones no session can still name
    /// (`ydoc::gc`), in place. The kill switch, off unless exactly `true`,
    /// and refused outside tests (`APP_ENV=test`) until the collection's
    /// inputs exist: counted sessions with what each deleted, the durable
    /// Undo payloads' deletions, the merge of a tab older than the window,
    /// and the durable Undo route's refusal of payloads naming collected
    /// units. Until then the folds pass stand-ins that would drop the text of
    /// a session away from the room, an editor's Undo or an offline draft.
    pub gc_collect: bool,
    /// Office engine child processes per lane and each one's memory cap
    /// (Epo 2026-10-07: production 2 + 1 at 4 GiB, UAT 1 + 1 at 3 GiB).
    pub engine_save_processes: u64,
    pub engine_background_processes: u64,
    pub engine_memory_limit_bytes: u64,
    /// The agent markdown import bundle (`crates/notes/markdown`, built into
    /// the image). Unset: markdown conversion answers 503.
    pub markdown_bundle: Option<String>,
    /// The `collab_health` interval (capacity runs log more often).
    pub health_interval: Duration,
    /// The source rooms' disk store (Epo 2026-10-17): its folder, wiped at
    /// start (the image sets it), and its cap per environment (production
    /// 10 GiB, UAT 5 GiB). No default.
    pub source_disk_dir: std::path::PathBuf,
    pub source_disk_bytes: u64,
    /// Each user's update allowance (Epo 2026-10-18, `rate.rs`), the same
    /// everywhere: sized from what editors send
    /// (bench/collaboration/reports/2026-10-18-update-rates.md), the burst
    /// for a DOCX paste of about 5,000 paragraphs (two updates each), the
    /// rate three times the fastest key repeat. The byte burst is at least
    /// the largest update (`ydoc::MAX_UPDATE_BYTES`). The open budget beside
    /// it (Epo 2026-10-19). An operator lowering any of these makes tabs
    /// time out (the client paces by the defaults, `allowance.ts`).
    pub update_limits: crate::rate::Limits,
    /// Sockets one client address may hold, and channels one user may have
    /// joined, in all and to one document, before a join closes their oldest
    /// (`seats.rs`): stress stacks with one address and one user raise them.
    pub sockets_per_address: u64,
    pub joined_per_user: u64,
    pub connections_per_document: u64,
    /// How often every socket is pinged, and how long one may stay silent
    /// before it closes (`socket.rs`); tests shorten them.
    pub ping_every: Duration,
    pub silent_close: Duration,
}

/// Local-dev values aligned with deploy/docker-compose.yml and the Go API.
pub mod dev {
    pub const ALLOWED_ORIGINS: &str = "http://localhost:5173";
    pub const API_URL: &str = "http://localhost:8080";
    pub const DATABASE_URL: &str = "postgres://capy:capy@localhost:5432/capy?sslmode=disable";
    pub const REDIS_URL: &str = "redis://localhost:6379/0";
    pub const SECRET: &str = "dev-collaboration-secret";
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{0}")]
pub struct ConfigError(String);

fn optional(env: &HashMap<String, String>, name: &str, fallback: &str) -> String {
    match env.get(name).map(|value| value.trim()) {
        Some(value) if !value.is_empty() => value.to_owned(),
        _ => fallback.to_owned(),
    }
}

fn positive(env: &HashMap<String, String>, name: &str, fallback: u64) -> Result<u64, ConfigError> {
    match env.get(name) {
        None => Ok(fallback),
        Some(raw) => match raw.trim().parse::<u64>() {
            Ok(value) if value > 0 => Ok(value),
            _ => Err(ConfigError(format!("{name} must be a positive integer"))),
        },
    }
}

fn seconds(
    env: &HashMap<String, String>,
    name: &str,
    fallback: Duration,
) -> Result<Duration, ConfigError> {
    positive(env, name, fallback.as_secs()).map(Duration::from_secs)
}

fn millis(
    env: &HashMap<String, String>,
    name: &str,
    fallback: u64,
) -> Result<Duration, ConfigError> {
    positive(env, name, fallback).map(Duration::from_millis)
}

fn required(env: &HashMap<String, String>, name: &str) -> Result<u64, ConfigError> {
    match env.get(name) {
        None => Err(ConfigError(format!("{name} is required"))),
        Some(_) => positive(env, name, 0),
    }
}

fn flag(env: &HashMap<String, String>, name: &str) -> Result<bool, ConfigError> {
    match env.get(name).map(|value| value.trim()) {
        None | Some("") => Ok(false),
        Some("true") => Ok(true),
        Some(_) => Err(ConfigError(format!("{name} must be true or unset"))),
    }
}

/// `COLLABORATION_GC_COLLECT`, refused outside tests (see `gc_collect`).
fn collection(env: &HashMap<String, String>) -> Result<bool, ConfigError> {
    let on = flag(env, "COLLABORATION_GC_COLLECT")?;
    if on && env.get("APP_ENV").map(|value| value.trim()) != Some("test") {
        return Err(ConfigError(
            concat!(
                "COLLABORATION_GC_COLLECT=true is refused outside tests until the collection's ",
                "inputs exist (counted sessions and held deletions, the late merge, the durable ",
                "Undo refusal)"
            )
            .into(),
        ));
    }
    Ok(on)
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::load(&std::env::vars().collect())
    }

    pub fn load(env: &HashMap<String, String>) -> Result<Self, ConfigError> {
        let allowed_origins: BTreeSet<String> =
            optional(env, "COLLABORATION_ALLOWED_ORIGINS", dev::ALLOWED_ORIGINS)
                .split(',')
                .map(|origin| origin.trim().to_owned())
                .filter(|origin| !origin.is_empty())
                .collect();
        if allowed_origins.is_empty() {
            return Err(ConfigError(
                "COLLABORATION_ALLOWED_ORIGINS must contain an origin".into(),
            ));
        }
        let port = positive(env, "PORT", 1234)?;
        let update_limits = crate::rate::Limits {
            burst_updates: positive(env, "COLLABORATION_UPDATE_BURST", 10_000)?,
            burst_bytes: positive(env, "COLLABORATION_UPDATE_BURST_BYTES", 8 << 20)?,
            updates_per_second: positive(env, "COLLABORATION_UPDATES_PER_SECOND", 200)?,
            bytes_per_second: positive(env, "COLLABORATION_UPDATE_BYTES_PER_SECOND", 2 << 20)?,
            open_bytes: positive(env, "COLLABORATION_OPEN_BYTES", crate::rate::OPEN_BYTES)?,
            open_refill_seconds: positive(
                env,
                "COLLABORATION_OPEN_REFILL_SECONDS",
                crate::rate::OPEN_REFILL.as_secs(),
            )?,
        };
        let ping_every = seconds(env, "COLLABORATION_PING_SECONDS", crate::socket::PING_EVERY)?;
        let silent_close = seconds(
            env,
            "COLLABORATION_SILENT_SECONDS",
            crate::socket::SILENT_CLOSE,
        )?;
        // A silent window no longer than the pings would close quiet sockets
        // that answer every ping.
        if silent_close <= ping_every {
            return Err(ConfigError(
                "COLLABORATION_SILENT_SECONDS must be greater than COLLABORATION_PING_SECONDS"
                    .into(),
            ));
        }
        // A smaller burst would refuse an update the rooms take, every time.
        if update_limits.burst_bytes < ydoc::MAX_UPDATE_BYTES as u64 {
            return Err(ConfigError(format!(
                "COLLABORATION_UPDATE_BURST_BYTES must be at least {}",
                ydoc::MAX_UPDATE_BYTES
            )));
        }
        Ok(Config {
            allowed_origins,
            api_url: optional(env, "API_URL", dev::API_URL)
                .trim_end_matches('/')
                .to_owned(),
            database_url: optional(env, "DATABASE_URL", dev::DATABASE_URL),
            debounce: millis(env, "COLLABORATION_DEBOUNCE_MS", 2000)?,
            max_debounce: millis(env, "COLLABORATION_MAX_DEBOUNCE_MS", 10_000)?,
            host: optional(env, "HOST", "0.0.0.0"),
            port: u16::try_from(port)
                .map_err(|_| ConfigError("PORT must be a positive integer".into()))?,
            redis_url: optional(env, "REDIS_URL", dev::REDIS_URL),
            secret: optional(env, "COLLABORATION_SECRET", dev::SECRET),
            source_debounce: millis(env, "COLLABORATION_SOURCE_DEBOUNCE_MS", 5000)?,
            source_max_debounce: millis(env, "COLLABORATION_SOURCE_MAX_DEBOUNCE_MS", 30_000)?,
            uat_publication_hold: flag(env, "COLLABORATION_UAT_PUBLICATION_HOLD")?,
            projection_idle: millis(env, "COLLABORATION_PROJECTION_IDLE_MS", 30_000)?,
            projection_cadence: millis(env, "COLLABORATION_PROJECTION_CADENCE_MS", 300_000)?,
            fold_min_bytes: positive(env, "COLLABORATION_FOLD_MIN_BYTES", 256 * 1024)?,
            fold_max_rows: positive(env, "COLLABORATION_FOLD_MAX_ROWS", 1000)?,
            gc_collect: collection(env)?,
            engine_save_processes: required(env, "COLLABORATION_ENGINE_SAVE_PROCESSES")?,
            engine_background_processes: required(
                env,
                "COLLABORATION_ENGINE_BACKGROUND_PROCESSES",
            )?,
            engine_memory_limit_bytes: required(env, "COLLABORATION_ENGINE_MEMORY_LIMIT_BYTES")?,
            markdown_bundle: env
                .get("COLLABORATION_MARKDOWN_BUNDLE")
                .map(|path| path.trim().to_owned())
                .filter(|path| !path.is_empty()),
            health_interval: millis(env, "COLLAB_HEALTH_INTERVAL_MS", 60_000)?,
            source_disk_dir: match env
                .get("COLLABORATION_SOURCE_DISK_DIR")
                .map(|dir| dir.trim())
            {
                Some(dir) if !dir.is_empty() => dir.into(),
                _ => {
                    return Err(ConfigError(
                        "COLLABORATION_SOURCE_DISK_DIR is required".into(),
                    ));
                }
            },
            source_disk_bytes: required(env, "COLLABORATION_SOURCE_DISK_BYTES")?,
            update_limits,
            sockets_per_address: positive(
                env,
                "COLLABORATION_SOCKETS_PER_ADDRESS",
                crate::seats::SOCKETS_PER_ADDRESS,
            )?,
            joined_per_user: positive(
                env,
                "COLLABORATION_JOINED_PER_USER",
                crate::seats::JOINED_PER_USER,
            )?,
            connections_per_document: positive(
                env,
                "COLLABORATION_CONNECTIONS_PER_DOCUMENT",
                crate::seats::CONNECTIONS_PER_DOCUMENT,
            )?,
            ping_every,
            silent_close,
        })
    }

    /// The largest WebSocket frame a client may send: the largest update
    /// and its framing (`socket.rs` refuses an update over the cap inside it).
    pub fn max_frame_bytes(&self) -> usize {
        ydoc::MAX_UPDATE_BYTES + 64 * 1024
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `pairs` plus the engine pool and disk store every environment sets.
    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        [
            ("COLLABORATION_ENGINE_SAVE_PROCESSES", "1"),
            ("COLLABORATION_ENGINE_BACKGROUND_PROCESSES", "1"),
            ("COLLABORATION_ENGINE_MEMORY_LIMIT_BYTES", "3221225472"),
            ("COLLABORATION_SOURCE_DISK_DIR", "/var/lib/capy/sources"),
            ("COLLABORATION_SOURCE_DISK_BYTES", "5368709120"),
        ]
        .iter()
        .chain(pairs)
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
    }

    #[test]
    fn uses_local_dev_values_when_env_is_empty() {
        let config = Config::load(&env(&[])).unwrap();
        assert_eq!(
            config.allowed_origins.iter().collect::<Vec<_>>(),
            vec![dev::ALLOWED_ORIGINS]
        );
        assert_eq!(config.api_url, dev::API_URL);
        assert_eq!(config.database_url, dev::DATABASE_URL);
        assert_eq!(config.redis_url, dev::REDIS_URL);
        assert_eq!(config.secret, dev::SECRET);
        assert_eq!(config.port, 1234);
        assert_eq!(config.projection_idle, Duration::from_secs(30));
        assert_eq!(config.projection_cadence, Duration::from_secs(300));
        assert_eq!(
            config.update_limits,
            crate::rate::Limits {
                burst_updates: 10_000,
                burst_bytes: 8 << 20,
                updates_per_second: 200,
                bytes_per_second: 2 << 20,
                open_bytes: 80 << 20,
                open_refill_seconds: 300,
            }
        );
        assert_eq!(config.sockets_per_address, 500);
        assert_eq!(config.joined_per_user, 22);
        assert_eq!(config.connections_per_document, 4);
        assert_eq!(config.ping_every, Duration::from_secs(30));
        assert_eq!(config.silent_close, Duration::from_secs(60));
    }

    #[test]
    fn parses_origins_and_overrides() {
        let config = Config::load(&env(&[
            ("API_URL", "http://server:8080/"),
            (
                "COLLABORATION_ALLOWED_ORIGINS",
                "https://app.example.com, http://localhost:5173",
            ),
            ("COLLABORATION_SECRET", "prod-secret"),
            ("PORT", "2345"),
        ]))
        .unwrap();
        assert!(config.allowed_origins.contains("https://app.example.com"));
        assert!(config.allowed_origins.contains("http://localhost:5173"));
        assert_eq!(config.api_url, "http://server:8080");
        assert_eq!(config.port, 2345);
        assert_eq!(config.secret, "prod-secret");
    }

    /// Off unless exactly `true`, and refused outside tests: turned on in a
    /// deployment, the folds' stand-in inputs would drop text.
    #[test]
    fn the_collection_is_off_unless_exactly_true_and_only_in_tests() {
        let on = ("COLLABORATION_GC_COLLECT", "true");
        assert!(!Config::load(&env(&[])).unwrap().gc_collect);
        assert!(
            Config::load(&env(&[on, ("APP_ENV", "test")]))
                .unwrap()
                .gc_collect
        );
        let refused = Config::load(&env(&[on]))
            .err()
            .map(|error| error.to_string());
        assert!(refused.is_some_and(|message| message.contains("collection's inputs exist (")));
        assert!(Config::load(&env(&[on, ("APP_ENV", "production")])).is_err());
        assert!(
            Config::load(&env(&[
                ("COLLABORATION_GC_COLLECT", "on"),
                ("APP_ENV", "test")
            ]))
            .is_err()
        );
    }

    #[test]
    fn the_publication_hold_is_on_only_for_exactly_true() {
        assert!(!Config::load(&env(&[])).unwrap().uat_publication_hold);
        assert!(
            !Config::load(&env(&[("COLLABORATION_UAT_PUBLICATION_HOLD", "")]))
                .unwrap()
                .uat_publication_hold
        );
        assert!(
            Config::load(&env(&[("COLLABORATION_UAT_PUBLICATION_HOLD", "true")]))
                .unwrap()
                .uat_publication_hold
        );
        assert_eq!(
            Config::load(&env(&[("COLLABORATION_UAT_PUBLICATION_HOLD", "1")]))
                .unwrap_err()
                .to_string(),
            "COLLABORATION_UAT_PUBLICATION_HOLD must be true or unset"
        );
    }

    #[test]
    fn the_engine_pool_has_no_default() {
        let mut values = env(&[]);
        values.remove("COLLABORATION_ENGINE_SAVE_PROCESSES");
        assert_eq!(
            Config::load(&values).unwrap_err().to_string(),
            "COLLABORATION_ENGINE_SAVE_PROCESSES is required"
        );
        let config = Config::load(&env(&[])).unwrap();
        assert_eq!(
            (
                config.engine_save_processes,
                config.engine_background_processes,
                config.engine_memory_limit_bytes
            ),
            (1, 1, 3 << 30)
        );
    }

    #[test]
    fn the_source_disk_store_has_no_default() {
        for name in [
            "COLLABORATION_SOURCE_DISK_DIR",
            "COLLABORATION_SOURCE_DISK_BYTES",
        ] {
            let mut values = env(&[]);
            values.remove(name);
            assert_eq!(
                Config::load(&values).unwrap_err().to_string(),
                format!("{name} is required")
            );
        }
        let config = Config::load(&env(&[])).unwrap();
        assert_eq!(
            config.source_disk_dir,
            std::path::PathBuf::from("/var/lib/capy/sources")
        );
        assert_eq!(config.source_disk_bytes, 5 << 30);
    }

    #[test]
    fn refuses_an_empty_origin_list_and_bad_numbers() {
        assert!(
            Config::load(&env(&[("COLLABORATION_ALLOWED_ORIGINS", " , , ")]))
                .unwrap_err()
                .to_string()
                .contains("must contain an origin")
        );
        assert!(Config::load(&env(&[("PORT", "0")])).is_err());
        assert!(Config::load(&env(&[("COLLABORATION_DEBOUNCE_MS", "x")])).is_err());
        assert_eq!(
            Config::load(&env(&[("COLLABORATION_UPDATE_BURST_BYTES", "8388607")]))
                .unwrap_err()
                .to_string(),
            "COLLABORATION_UPDATE_BURST_BYTES must be at least 8388608"
        );
        assert_eq!(
            Config::load(&env(&[("COLLABORATION_PING_SECONDS", "60")]))
                .unwrap_err()
                .to_string(),
            "COLLABORATION_SILENT_SECONDS must be greater than COLLABORATION_PING_SECONDS"
        );
    }
}
