//! The server's start against the Office engine sandbox's host check.

#![allow(clippy::unwrap_used)]

use std::process::Command;

/// The server's exit code and log lines with Landlock reported missing
/// (`CAPY_TEST_NO_LANDLOCK`, honoured by debug builds only) and nothing else
/// configured.
fn start_without_landlock(app_env: &str) -> (Option<i32>, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_capy-collaboration"))
        .env_clear()
        .env("APP_ENV", app_env)
        .env("LOG_FORMAT", "json")
        .env("CAPY_TEST_NO_LANDLOCK", "1")
        .output()
        .unwrap();
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    )
}

/// Security regression (the Office engine sandbox, Epo 2026-10-20): a
/// production server on a host without Landlock does not start; development
/// logs the gap once and goes on (here to its missing configuration).
#[test]
fn production_does_not_start_without_landlock() {
    let (code, log) = start_without_landlock("production");
    assert_eq!(code, Some(1), "{log}");
    assert!(log.contains("does not start without Landlock"), "{log}");

    let (code, log) = start_without_landlock("development");
    assert_eq!(code, Some(1), "{log}");
    assert_eq!(
        log.matches("office engine sandbox incomplete").count(),
        1,
        "{log}"
    );
    assert!(!log.contains("does not start without Landlock"), "{log}");
}
