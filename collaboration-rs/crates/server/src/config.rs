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
    pub compaction_floor_bytes: u64,
    pub compaction_idle: Duration,
    pub compaction_interval: Duration,
    pub compaction_max_rooms: u64,
    pub compaction_multiplier: u64,
    pub database_url: String,
    /// Note rooms' store debounce and its cap.
    pub debounce: Duration,
    pub max_debounce: Duration,
    pub host: String,
    pub max_payload_bytes: u64,
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
        Ok(Config {
            allowed_origins,
            api_url: optional(env, "API_URL", dev::API_URL)
                .trim_end_matches('/')
                .to_owned(),
            compaction_floor_bytes: positive(
                env,
                "COLLABORATION_COMPACTION_FLOOR_BYTES",
                256 * 1024,
            )?,
            compaction_idle: millis(env, "COLLABORATION_COMPACTION_IDLE_MS", 60 * 60 * 1000)?,
            compaction_interval: millis(
                env,
                "COLLABORATION_COMPACTION_INTERVAL_MS",
                15 * 60 * 1000,
            )?,
            compaction_max_rooms: positive(env, "COLLABORATION_COMPACTION_MAX_ROOMS", 10)?,
            compaction_multiplier: positive(env, "COLLABORATION_COMPACTION_MULTIPLIER", 4)?,
            database_url: optional(env, "DATABASE_URL", dev::DATABASE_URL),
            debounce: millis(env, "COLLABORATION_DEBOUNCE_MS", 2000)?,
            max_debounce: millis(env, "COLLABORATION_MAX_DEBOUNCE_MS", 10_000)?,
            host: optional(env, "HOST", "0.0.0.0"),
            max_payload_bytes: positive(env, "COLLABORATION_MAX_PAYLOAD_BYTES", 2 * 1024 * 1024)?,
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
        })
    }

    /// The largest WebSocket frame: a whole source state fits.
    pub fn max_frame_bytes(&self) -> usize {
        let source = sources::MAX_SOURCE_STATE_BYTES as u64 + 1024;
        usize::try_from(self.max_payload_bytes.max(source)).unwrap_or(usize::MAX)
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
    }
}
