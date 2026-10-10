//! Structured logging and error reporting (the Node server's `observability.ts`):
//! one JSON line per event with the gateway's field names, and Sentry for
//! failures nobody would otherwise see. Every capture also logs its cause.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

pub const ERROR_EVENT_HEADER: &str = "x-sentry-event-id";
pub const RETRY_EVENT_HEADER: &str = "x-sentry-retry-event-id";

struct Settings {
    app_env: String,
    text: bool,
}

static SETTINGS: OnceLock<Settings> = OnceLock::new();
/// The engine subcommand logs to stderr: its stdout carries answer frames.
static TO_STDERR: AtomicBool = AtomicBool::new(false);

pub fn log_to_stderr() {
    TO_STDERR.store(true, Ordering::Relaxed);
}

/// The sources crate's lines and reports, through this logger and Sentry.
pub fn install_for_sources() {
    sources::observe::install(sources::observe::Observer {
        log: |level, message, fields| {
            let level = match level {
                "error" => Level::Error,
                "warn" => Level::Warn,
                _ => Level::Info,
            };
            log(level, message, fields);
        },
        capture: |message, tags| {
            capture(message, None, tags);
        },
    });
}

fn settings() -> &'static Settings {
    SETTINGS.get_or_init(|| {
        let app_env = std::env::var("APP_ENV").unwrap_or_else(|_| "development".into());
        let format = std::env::var("LOG_FORMAT").unwrap_or_else(|_| {
            if app_env == "development" {
                "text"
            } else {
                "json"
            }
            .into()
        });
        Settings {
            text: format == "text",
            app_env,
        }
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

/// `new Date().toISOString()`.
pub fn iso_now() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = elapsed.as_secs() as i64;
    let millis = elapsed.subsec_millis();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// One structured line: `env, level, msg, service, time` and the fields.
pub fn log(level: Level, msg: &str, fields: Value) {
    let settings = settings();
    let fields = match fields {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        other => {
            let mut map = Map::new();
            map.insert("value".into(), other);
            map
        }
    };
    if settings.text {
        let suffix = if fields.is_empty() {
            String::new()
        } else {
            format!(" {}", Value::Object(fields))
        };
        eprintln!("{} {msg}{suffix}", level.as_str());
        return;
    }
    let mut line = Map::new();
    line.insert("env".into(), json!(settings.app_env));
    line.insert("level".into(), json!(level.as_str()));
    line.insert("msg".into(), json!(msg));
    line.insert("service".into(), json!("collaboration"));
    line.insert("time".into(), json!(iso_now()));
    line.extend(fields);
    if TO_STDERR.load(Ordering::Relaxed) {
        eprintln!("{}", Value::Object(line));
        return;
    }
    // stdout, as the Node service's console.info.
    #[allow(clippy::print_stdout)]
    {
        println!("{}", Value::Object(line));
    }
}

/// Initializes Sentry before any connection is accepted. The guard flushes
/// pending events when dropped at shutdown.
pub fn init() -> Option<sentry::ClientInitGuard> {
    let dsn = std::env::var("SENTRY_DSN").unwrap_or_default();
    if dsn.is_empty() {
        log(Level::Info, "sentry disabled (no SENTRY_DSN)", Value::Null);
        return None;
    }
    // Not APP_ENV: UAT runs with APP_ENV=production and still reports as its own environment.
    let environment = std::env::var("SENTRY_ENVIRONMENT")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| settings().app_env.clone());
    let release = std::env::var("RELEASE_SHA")
        .ok()
        .filter(|value| !value.is_empty());
    let mut options = client_options();
    options.environment = Some(environment.clone().into());
    options.release = release.map(Into::into);
    let guard = sentry::init((dsn, options));
    log(
        Level::Info,
        "sentry enabled",
        json!({ "environment": environment }),
    );
    Some(guard)
}

/// What every event of this service carries. Tracing stays off (the default
/// rate is 0): every connection is a long-lived socket, so transactions would
/// measure session length.
fn client_options() -> sentry::ClientOptions {
    let mut options = sentry::ClientOptions::default();
    options.send_default_pii = false;
    // The same tag the gateway, retrieval and workers set.
    options.before_send = Some(std::sync::Arc::new(|mut event| {
        event
            .tags
            .entry("service".into())
            .or_insert_with(|| "collaboration".into());
        Some(event)
    }));
    options
}

/// The W3C trace id of a `traceparent` header (`00-<trace>-<span>-<flags>`),
/// none when malformed or all zero.
pub fn trace_id(traceparent: Option<&str>) -> Option<String> {
    let value = traceparent?.trim().to_ascii_lowercase();
    let parts: Vec<&str> = value.split('-').collect();
    let hex = |part: &str, len: usize| {
        part.len() == len
            && part
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    match parts.as_slice() {
        ["00", trace, span, flags]
            if hex(trace, 32)
                && hex(span, 16)
                && hex(flags, 2)
                && trace.bytes().any(|b| b != b'0') =>
        {
            Some((*trace).to_owned())
        }
        _ => None,
    }
}

/// A hub for one internal request: every event it captures carries the
/// caller's trace id (the gateway sends `traceparent`) as `trace_id`, as the
/// gateway tags its own, so one id finds a failure in both services.
pub fn request_hub(traceparent: Option<&str>) -> std::sync::Arc<sentry::Hub> {
    let hub = std::sync::Arc::new(sentry::Hub::new_from_top(sentry::Hub::current()));
    if let Some(trace) = trace_id(traceparent) {
        hub.configure_scope(|scope| scope.set_tag("trace_id", trace));
    }
    hub
}

fn valid_event_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Accepts an event id only from trusted internal responses.
pub fn event_id(value: Option<&str>) -> Option<String> {
    value
        .filter(|value| valid_event_id(value))
        .map(str::to_owned)
}

/// `captureError`: logs `captured error` with the tags, and reports to Sentry
/// unless `existing` already names its event. Returns the event id.
pub fn capture(message: &str, existing: Option<&str>, tags: &[(&str, &str)]) -> Option<String> {
    let mut fields = Map::new();
    for (key, value) in tags {
        fields.insert((*key).into(), json!(value));
    }
    fields.insert("error".into(), json!(message));
    if let Some(existing) = existing {
        fields.insert("event_id".into(), json!(existing));
    }
    log(Level::Error, "captured error", Value::Object(fields));
    if let Some(existing) = existing {
        return Some(existing.to_owned());
    }
    sentry::Hub::current()
        .client()
        .filter(|client| client.is_enabled())?;
    let id = sentry::with_scope(
        |scope| {
            for (key, value) in tags {
                scope.set_tag(key, value);
            }
        },
        || sentry::capture_message(message, sentry::Level::Error),
    );
    Some(id.simple().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_traceparent_names_its_trace_unless_malformed_or_zero() {
        let trace = "ab".repeat(16);
        let header = format!("00-{trace}-{}-01", "c".repeat(16));
        assert_eq!(trace_id(Some(&header)).as_deref(), Some(trace.as_str()));
        assert_eq!(
            trace_id(Some(&format!(" {} ", header.to_uppercase()))).as_deref(),
            Some(trace.as_str())
        );
        for refused in [
            format!("00-{}-{}-01", "0".repeat(32), "c".repeat(16)),
            format!("01-{trace}-{}-01", "c".repeat(16)),
            format!("00-{trace}-{}-1", "c".repeat(16)),
            format!("00-{}-{}-01", "g".repeat(32), "c".repeat(16)),
            "garbage".to_owned(),
        ] {
            assert_eq!(trace_id(Some(&refused)), None, "{refused}");
        }
        assert_eq!(trace_id(None), None);
    }

    /// A request's captures carry its trace id, every capture the service
    /// tag; an all-zero trace tags nothing.
    #[test]
    fn captures_carry_the_service_and_the_request_trace() {
        let trace = "ab".repeat(16);
        let events = sentry::test::with_captured_events_options(
            || {
                let tagged = request_hub(Some(&format!("00-{trace}-{}-01", "c".repeat(16))));
                sentry::Hub::run(tagged, || capture("publish failed", None, &[]));
                let untagged = request_hub(Some(&format!(
                    "00-{}-{}-01",
                    "0".repeat(32),
                    "c".repeat(16)
                )));
                sentry::Hub::run(untagged, || capture("no trace", None, &[]));
            },
            client_options(),
        );
        assert_eq!(events.len(), 2);
        let tags = |message: &str| {
            events
                .iter()
                .find(|event| event.message.as_deref() == Some(message))
                .map(|event| event.tags.clone())
                .unwrap()
        };
        let tagged = tags("publish failed");
        assert_eq!(tagged.get("trace_id"), Some(&trace));
        assert_eq!(
            tagged.get("service").map(String::as_str),
            Some("collaboration")
        );
        let untagged = tags("no trace");
        assert_eq!(untagged.get("trace_id"), None);
        assert_eq!(
            untagged.get("service").map(String::as_str),
            Some("collaboration")
        );
    }

    #[test]
    fn iso_time_has_the_javascript_shape() {
        let now = iso_now();
        assert_eq!(now.len(), 24);
        assert!(now.ends_with('Z'));
        assert_eq!(&now[4..5], "-");
        assert_eq!(&now[10..11], "T");
    }

    #[test]
    fn event_ids_are_32_lowercase_hex() {
        assert_eq!(
            event_id(Some("0123456789abcdef0123456789abcdef")).as_deref(),
            Some("0123456789abcdef0123456789abcdef")
        );
        assert!(event_id(Some("0123456789ABCDEF0123456789abcdef")).is_none());
        assert!(event_id(Some("short")).is_none());
        assert!(event_id(None).is_none());
    }

    #[test]
    fn a_reported_error_is_not_sent_again() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            capture("boom", Some(id), &[("stage", "test")]).as_deref(),
            Some(id)
        );
    }
}
