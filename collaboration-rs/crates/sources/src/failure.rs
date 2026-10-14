//! How a source save fails (storeFailure.ts, the source half of
//! editIncidents.ts and accessRecheck.ts `readOnlyRefusal`): which failures
//! always fail (the room resets and the browsers go to recovery), which are
//! slow (retried with backoff, editing continues), and the slow-save clock.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::engine::EngineError;

/// A 403 about the account itself, not the file: the browser keeps its drafts.
const ACCOUNT_LOCK_CODES: [&str; 4] = [
    "account_deleted",
    "account_deletion_pending",
    "account_locked",
    "account_suspended",
];

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SourceError {
    /// The gateway answered an error status (SourceRequestError). `code` is
    /// its error code (`epoch_changed`, `account_over_quota`, ...); `event_id`
    /// the Sentry event it already reported.
    #[error("{message}")]
    Request {
        status: u16,
        message: String,
        code: Option<String>,
        event_id: Option<String>,
    },
    /// The Office engine refused or failed the call (OfficeEngineError).
    #[error(transparent)]
    Engine(#[from] EngineError),
    /// The stored change was taken over another seed than this engine's
    /// seed(base) (SourceSeedChangedError).
    #[error(
        "The Office engine seeds this file differently from its saved changes; publish them on the previous engine (maintenance window)"
    )]
    SeedChanged,
    /// The stored state does not load: content left pending after base plus
    /// rows, or an Office state that names no seed (SourceStateRebuildError).
    #[error("{0}")]
    State(String),
    /// The live room holds an update ahead of one it depends on
    /// (SourcePendingError).
    #[error("source room holds pending updates; saved once they integrate")]
    Pending,
    /// The room waits out a failed save's backoff (SourceBackoffError).
    #[error("source room is waiting out a failed save; saved on its next retry")]
    Backoff,
    /// An agent edit refused (`EditError`): the gateway answers 409 with its
    /// code (`stale_target`, `invalid_input`, ...) and, for a missed target,
    /// what it reads now.
    #[error("{message}")]
    Edit {
        code: String,
        message: String,
        details: Option<serde_json::Value>,
    },
    /// Anything else (network, timeouts, the database): slow.
    #[error("{0}")]
    Other(String),
}

impl SourceError {
    pub fn request(status: u16, message: impl Into<String>, code: Option<&str>) -> Self {
        SourceError::Request {
            status,
            message: message.into(),
            code: code.map(str::to_owned),
            event_id: None,
        }
    }

    pub fn epoch_changed() -> Self {
        SourceError::request(409, "Source epoch changed", Some("epoch_changed"))
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            SourceError::Request { status, .. } => Some(*status),
            _ => None,
        }
    }

    fn code(&self) -> Option<&str> {
        match self {
            SourceError::Request { code, .. } => code.as_deref(),
            _ => None,
        }
    }

    /// An engine error that the same call repeats (not a timeout or a lost
    /// process): a refusal, the seed check, a stored state that does not load.
    fn engine_refused(&self) -> bool {
        match self {
            SourceError::Engine(error) => !error.transient(),
            SourceError::SeedChanged | SourceError::State(_) => true,
            _ => false,
        }
    }

    /// sourceSaveRefused: a save that will always fail, so its room resets
    /// and the browsers go to recovery at once.
    pub fn refused(&self) -> bool {
        self.engine_refused()
            || matches!(self.status(), Some(403 | 404 | 413 | 422))
            || self.code() == Some("epoch_changed")
    }

    /// readOnlyRefusal: the owner froze or reached its storage limit; the
    /// writers drop to view (their unsaved edits are discarded).
    pub fn read_only(&self) -> bool {
        matches!(
            self.code(),
            Some("account_over_quota" | "storage_quota_exceeded")
        )
    }

    /// lostSourceAccess: the writers lost access or the file is gone, not an
    /// account lock: the browser drops its drafts.
    pub fn lost_access(&self) -> bool {
        matches!(self.status(), Some(403 | 404))
            && !self
                .code()
                .is_some_and(|code| ACCOUNT_LOCK_CODES.contains(&code))
    }

    /// lostAccessField: which loss, for `source-checkpoint-failed`.
    pub fn lost_access_field(&self) -> Option<&'static str> {
        if !self.lost_access() {
            return None;
        }
        Some(if self.status() == Some(404) {
            "not_found"
        } else {
            "forbidden"
        })
    }

    /// serviceSecretRejected: a 401 from an internal route is our own secret,
    /// a slow failure logged loudly, never the user's access.
    pub fn service_secret(&self) -> bool {
        self.status() == Some(401)
    }

    /// The engine timed out or lost its process.
    pub fn transient(&self) -> bool {
        matches!(self, SourceError::Engine(error) if error.transient())
    }

    /// The `edit_incidents` reason token (editIncidents.ts `errorReason`).
    pub fn incident_reason(&self) -> String {
        match self {
            SourceError::Pending => "pending".into(),
            SourceError::Backoff => "backoff".into(),
            SourceError::Engine(error) if error.transient() => "engine_transient".into(),
            SourceError::Engine(_) | SourceError::SeedChanged | SourceError::State(_) => {
                "engine_refused".into()
            }
            SourceError::Request { status, code, .. } => token(
                code.as_deref()
                    .or(match status {
                        403 => Some("forbidden"),
                        404 => Some("not_found"),
                        _ => None,
                    })
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("http_{status}"))
                    .as_str(),
            ),
            SourceError::Edit { code, .. } => token(code),
            SourceError::Other(_) => "error".into(),
        }
    }

    /// Why a failed source save discards its room (sourceDiscardCause): lost
    /// write access, the byte limit, a refusal, or the slow-save limit.
    pub fn discard_cause(&self, slow_limit: bool) -> IncidentCause {
        let reason = Some(self.incident_reason());
        let kind = if self.read_only() || matches!(self.status(), Some(403 | 404)) {
            IncidentKind::DiscardUnsaved
        } else if self.status() == Some(413) {
            return IncidentCause {
                kind: IncidentKind::OverLimit,
                reason: Some("source_state_bytes".into()),
            };
        } else if self.refused() {
            IncidentKind::SaveRefused
        } else if slow_limit {
            IncidentKind::SlowSaveLimit
        } else {
            IncidentKind::DiscardUnsaved
        };
        IncidentCause { kind, reason }
    }
}

/// `edit_incidents.kind` (the collaboration service's kinds).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IncidentKind {
    SaveRefused,
    DiscardUnsaved,
    EpochReset,
    OverLimit,
    SlowSaveLimit,
    Step2Unplaced,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct IncidentCause {
    pub kind: IncidentKind,
    pub reason: Option<String>,
}

/// A reason token: `[a-z0-9_-]`, 64 at most.
pub fn token(value: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for character in value.to_lowercase().chars() {
        if character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || character == '_'
            || character == '-'
        {
            out.push(character);
            gap = false;
        } else if !gap {
            out.push('_');
            gap = true;
        }
    }
    let out: String = out.chars().take(64).collect();
    if out.is_empty() { "error".into() } else { out }
}

/// How long a room's saves may keep failing, without one success, before it
/// goes to the refused-save recovery path.
pub const SLOW_SAVE_LIMIT: Duration = Duration::from_secs(5 * 60);

/// When each source room's saves started failing without a success. Every
/// failed save counts, whatever the cause; a successful save clears the room.
#[derive(Debug, Default)]
pub struct SlowSaveClock {
    since: HashMap<String, Instant>,
}

impl SlowSaveClock {
    /// Records a failed save: true once the room has gone
    /// [`SLOW_SAVE_LIMIT`] without one success.
    pub fn failed(&mut self, room: &str, now: Instant) -> bool {
        let since = *self.since.entry(room.to_owned()).or_insert(now);
        now.duration_since(since) >= SLOW_SAVE_LIMIT
    }

    pub fn clear(&mut self, room: &str) {
        self.since.remove(room);
    }
}

/// What a save does with a room holding pending content (an update that
/// arrived ahead of one it depends on). Delta saves append the room's update
/// since its durable state, and a load refuses any state that leaves content
/// pending, so Office and text rooms alike wait (transient) until the
/// client's sync integrates it; the TS stored a text room whole with it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PendingSave {
    None,
    Wait,
}

pub fn pending_source_save<T: yrs::ReadTxn>(txn: &T) -> PendingSave {
    let store = txn.store();
    if store.pending_update().is_some() || store.pending_ds().is_some() {
        PendingSave::Wait
    } else {
        PendingSave::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Failure, FailureKind};

    fn request(status: u16, code: Option<&str>) -> SourceError {
        SourceError::request(status, "refused", code)
    }

    #[test]
    fn refuses_only_failures_that_will_always_fail() {
        for refused in [
            SourceError::Engine(EngineError::Refused(Failure {
                kind: FailureKind::Edit,
                message: "stale_target: changed".into(),
            })),
            request(413, None),
            request(422, None),
            request(403, None),
            request(404, None),
            SourceError::epoch_changed(),
            SourceError::SeedChanged,
            SourceError::State("The saved changes refer to content missing from the seed".into()),
        ] {
            assert!(refused.refused(), "{refused:?}");
        }
        for slow in [
            SourceError::Engine(EngineError::Transient("Office stateOf timed out".into())),
            request(409, None),
            request(503, None),
            SourceError::Other("fetch failed".into()),
            SourceError::Pending,
            SourceError::Backoff,
        ] {
            assert!(!slow.refused(), "{slow:?}");
        }
    }

    #[test]
    fn a_rejected_service_secret_is_slow_not_lost_access() {
        let secret = request(401, None);
        assert!(secret.service_secret());
        assert!(!secret.refused());
        assert!(!secret.lost_access());
        assert!(!request(403, None).service_secret());
    }

    #[test]
    fn a_lost_file_or_access_is_lost_but_not_an_account_lock() {
        assert!(request(403, None).lost_access());
        assert!(request(404, None).lost_access());
        let locked = request(403, Some("account_suspended"));
        assert!(!locked.lost_access());
        assert_eq!(request(404, None).lost_access_field(), Some("not_found"));
        assert_eq!(request(403, None).lost_access_field(), Some("forbidden"));
        assert_eq!(locked.lost_access_field(), None);
        assert!(request(403, Some("storage_quota_exceeded")).read_only());
        assert!(request(403, Some("account_over_quota")).read_only());
    }

    #[test]
    fn the_slow_save_clock_counts_every_failure_until_a_success() {
        let mut clock = SlowSaveClock::default();
        let start = Instant::now();
        let room = "source:f:epoch:1";
        assert!(!clock.failed(room, start));
        assert!(!clock.failed(room, start + SLOW_SAVE_LIMIT - Duration::from_millis(1)));
        assert!(clock.failed(room, start + SLOW_SAVE_LIMIT));
        clock.clear(room);
        assert!(!clock.failed(room, start + SLOW_SAVE_LIMIT + Duration::from_secs(1)));
    }

    #[test]
    fn discard_causes_and_reasons() {
        let cause = |error: SourceError, slow| error.discard_cause(slow);
        assert_eq!(
            cause(request(413, None), false),
            IncidentCause {
                kind: IncidentKind::OverLimit,
                reason: Some("source_state_bytes".into())
            }
        );
        assert_eq!(
            cause(request(404, None), false).kind,
            IncidentKind::DiscardUnsaved
        );
        assert_eq!(
            cause(request(404, None), false).reason.as_deref(),
            Some("not_found")
        );
        assert_eq!(
            cause(request(403, Some("storage_quota_exceeded")), false).kind,
            IncidentKind::DiscardUnsaved
        );
        assert_eq!(
            cause(SourceError::epoch_changed(), false).kind,
            IncidentKind::SaveRefused
        );
        assert_eq!(
            cause(SourceError::epoch_changed(), false).reason.as_deref(),
            Some("epoch_changed")
        );
        assert_eq!(
            cause(SourceError::Pending, true).kind,
            IncidentKind::SlowSaveLimit
        );
        assert_eq!(
            cause(SourceError::Pending, true).reason.as_deref(),
            Some("pending")
        );
        assert_eq!(
            cause(
                SourceError::Engine(EngineError::Transient("t".into())),
                true
            )
            .reason
            .as_deref(),
            Some("engine_transient")
        );
        assert_eq!(
            cause(request(503, None), true).reason.as_deref(),
            Some("http_503")
        );
        assert_eq!(token("Bad Thing!! 2"), "bad_thing_2");
    }

    #[test]
    fn a_room_with_pending_content_waits() {
        use yrs::{Doc, ReadTxn, StateVector, Text, Transact, Update, updates::decoder::Decode};
        let author = Doc::with_client_id(7);
        let text = author.get_or_insert_text("source");
        text.insert(&mut author.transact_mut(), 0, "a");
        let first = author
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let vector = author.transact().state_vector();
        text.insert(&mut author.transact_mut(), 1, "b");
        let second = author.transact().encode_state_as_update_v1(&vector);
        let room = Doc::with_client_id(1);
        room.transact_mut()
            .apply_update(Update::decode_v1(&second).unwrap())
            .unwrap();
        assert_eq!(pending_source_save(&room.transact()), PendingSave::Wait);
        room.transact_mut()
            .apply_update(Update::decode_v1(&first).unwrap())
            .unwrap();
        assert_eq!(pending_source_save(&room.transact()), PendingSave::None);
    }
}
