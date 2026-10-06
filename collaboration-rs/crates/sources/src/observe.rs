//! Log lines and error reports the source code emits, through the server's
//! own logger and Sentry (`server::observe`), which it installs once at start
//! (and in the `engine` subcommand). Until then, and in tests, a line goes to
//! stderr as JSON.

use std::sync::OnceLock;

use serde_json::{Value, json};

#[derive(Clone, Copy)]
pub struct Observer {
    /// One structured line: level (`info`/`warn`/`error`), message, fields.
    pub log: fn(level: &'static str, message: &str, fields: Value),
    /// A failure nobody would otherwise see (Sentry), with its stage tags.
    pub capture: fn(message: &str, tags: &[(&str, &str)]),
}

static OBSERVER: OnceLock<Observer> = OnceLock::new();

pub fn install(observer: Observer) {
    let _ = OBSERVER.set(observer);
}

pub(crate) fn log(level: &'static str, message: &str, fields: Value) {
    match OBSERVER.get() {
        Some(observer) => (observer.log)(level, message, fields),
        None => eprintln!(
            "{}",
            json!({ "level": level, "msg": message, "fields": fields })
        ),
    }
}

pub(crate) fn capture(message: &str, tags: &[(&str, &str)]) {
    match OBSERVER.get() {
        Some(observer) => (observer.capture)(message, tags),
        None => log(
            "error",
            "captured error",
            json!({ "error": message, "tags": format!("{tags:?}") }),
        ),
    }
}
