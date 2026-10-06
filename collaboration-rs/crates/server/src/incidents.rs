//! Editing incidents (`collaboration/src/editIncidents.ts`): where a user
//! lost or could lose work, written to `edit_incidents` in the background,
//! never awaited by editing and never retried.

use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;

use serde_json::Value;

use crate::app::Shared;
use crate::auth::RoomName;
use crate::observe;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    SaveRefused,
    DiscardUnsaved,
    EpochReset,
    OverLimit,
    SlowSaveLimit,
    Step2Unplaced,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::SaveRefused => "save_refused",
            Kind::DiscardUnsaved => "discard_unsaved",
            Kind::EpochReset => "epoch_reset",
            Kind::OverLimit => "over_limit",
            Kind::SlowSaveLimit => "slow_save_limit",
            Kind::Step2Unplaced => "step2_unplaced",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "save_refused" => Kind::SaveRefused,
            "discard_unsaved" => Kind::DiscardUnsaved,
            "epoch_reset" => Kind::EpochReset,
            "over_limit" => Kind::OverLimit,
            "slow_save_limit" => Kind::SlowSaveLimit,
            "step2_unplaced" => Kind::Step2Unplaced,
            _ => return None,
        })
    }
}

/// What happened and a short token why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cause {
    pub kind: Kind,
    pub reason: Option<String>,
}

impl Cause {
    pub fn new(kind: Kind, reason: &str) -> Self {
        Cause {
            kind,
            reason: Some(token(reason)),
        }
    }

    pub fn json(&self) -> Value {
        serde_json::json!({ "kind": self.kind.as_str(), "reason": self.reason })
    }
}

#[derive(Clone, Debug)]
pub struct Incident {
    pub cause: Cause,
    pub room: String,
    pub size_bytes: Option<u64>,
    pub user_id: Option<String>,
}

/// A reason token: `[a-z0-9_-]`, at most 64.
pub fn token(value: &str) -> String {
    let mut out = String::new();
    let mut underscore = false;
    for c in value.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
            out.push(c);
            underscore = false;
        } else if !underscore {
            out.push('_');
            underscore = true;
        }
    }
    out.truncate(64);
    if out.is_empty() { "error".into() } else { out }
}

/// `broadcastDiscardCause`: the incident the discarding instance put in its
/// event, a rejection's code, else the event type.
pub fn broadcast_cause(notification: Option<&str>) -> Cause {
    let event: Value = notification
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or(Value::Null);
    if let Some(kind) = event["incident"]["kind"].as_str().and_then(Kind::parse) {
        return Cause {
            kind,
            reason: event["incident"]["reason"].as_str().map(token),
        };
    }
    if event["type"] == "document-rejected" {
        if let Some(code) = event["code"].as_str() {
            return if code == "invalid_document" {
                Cause::new(Kind::SaveRefused, "invalid_document")
            } else {
                Cause::new(Kind::OverLimit, code)
            };
        }
    }
    Cause {
        kind: Kind::DiscardUnsaved,
        reason: Some(
            event["type"]
                .as_str()
                .map(token)
                .unwrap_or_else(|| "discard".into()),
        ),
    }
}

/// `clientPayload`: the eviction payload without the `incident` other
/// instances read (it may name another account's lock).
pub fn client_payload(notification: &str) -> String {
    if !notification.contains("\"incident\"") {
        return notification.to_owned();
    }
    match serde_json::from_str::<Value>(notification) {
        Ok(Value::Object(mut map)) => {
            map.shift_remove("incident");
            Value::Object(map).to_string()
        }
        _ => notification.to_owned(),
    }
}

/// `UnplacedOnce`: a stuck writer's unplaceable step 2 is recorded once per
/// room and user until one of its updates is placed. At most `cap` entries.
pub struct UnplacedOnce {
    keys: Mutex<(HashSet<(String, String)>, VecDeque<(String, String)>)>,
    cap: usize,
}

impl Default for UnplacedOnce {
    fn default() -> Self {
        UnplacedOnce {
            keys: Mutex::default(),
            cap: 10_000,
        }
    }
}

impl UnplacedOnce {
    #[allow(clippy::unwrap_used)]
    pub fn first(&self, room: &str, user: &str) -> bool {
        let mut keys = self.keys.lock().unwrap();
        let key = (room.to_owned(), user.to_owned());
        if keys.0.contains(&key) {
            return false;
        }
        if keys.0.len() >= self.cap {
            if let Some(oldest) = keys.1.pop_front() {
                keys.0.remove(&oldest);
            }
        }
        keys.0.insert(key.clone());
        keys.1.push_back(key);
        true
    }

    #[allow(clippy::unwrap_used)]
    pub fn placed(&self, room: &str, user: &str) {
        let mut keys = self.keys.lock().unwrap();
        if keys.0.is_empty() {
            return;
        }
        let key = (room.to_owned(), user.to_owned());
        if keys.0.remove(&key) {
            keys.1.retain(|entry| entry != &key);
        }
    }
}

/// Writes incidents in one statement, in the background.
pub fn record(app: &Shared, incidents: Vec<Incident>) {
    if incidents.is_empty() {
        return;
    }
    let app = app.clone();
    tokio::spawn(async move {
        if let Err(error) = write(&app, &incidents).await {
            let first = &incidents[0];
            observe::capture(
                &error,
                None,
                &[
                    ("kind", first.cause.kind.as_str()),
                    ("room", &first.room),
                    ("stage", "edit_incident_write"),
                ],
            );
        }
    });
}

async fn write(app: &Shared, incidents: &[Incident]) -> Result<(), String> {
    let client = app.db.get().await.map_err(|error| error.to_string())?;
    let mut users = Vec::new();
    let mut files = Vec::new();
    let mut kinds = Vec::new();
    let mut file_kinds = Vec::new();
    let mut reasons = Vec::new();
    let mut sizes = Vec::new();
    for incident in incidents {
        let (id, kind) = match RoomName::parse(&incident.room) {
            Some(RoomName::Source { file_id, .. }) => (file_id, "source_file"),
            Some(RoomName::Material { material_id, .. }) => (material_id, "material"),
            None => continue,
        };
        users.push(incident.user_id.clone());
        files.push(id);
        file_kinds.push(kind.to_owned());
        kinds.push(incident.cause.kind.as_str().to_owned());
        reasons.push(incident.cause.reason.clone());
        sizes.push(incident.size_bytes.map(|bytes| bytes as i64));
    }
    client
        .execute(
            "INSERT INTO edit_incidents (user_id, file_id, file_kind, kind, reason, size_bytes)
             SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[])",
            &[&users, &files, &file_kinds, &kinds, &reasons, &sizes],
        )
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reason_tokens() {
        assert_eq!(token("account_suspended"), "account_suspended");
        assert_eq!(token("HTTP 503: Bad"), "http_503_bad");
        assert_eq!(token(""), "error");
        assert_eq!(token(&"x".repeat(80)).len(), 64);
    }

    #[test]
    fn broadcast_causes() {
        let with_incident = r#"{"type":"authorization-revoked","incident":{"kind":"slow_save_limit","reason":"engine_transient"}}"#;
        assert_eq!(
            broadcast_cause(Some(with_incident)),
            Cause::new(Kind::SlowSaveLimit, "engine_transient")
        );
        assert_eq!(
            broadcast_cause(Some(
                r#"{"type":"document-rejected","code":"invalid_document"}"#
            )),
            Cause::new(Kind::SaveRefused, "invalid_document")
        );
        assert_eq!(
            broadcast_cause(Some(
                r#"{"type":"document-rejected","code":"document_size_exceeded"}"#
            )),
            Cause::new(Kind::OverLimit, "document_size_exceeded")
        );
        assert_eq!(
            broadcast_cause(Some(r#"{"type":"access-changed"}"#)),
            Cause::new(Kind::DiscardUnsaved, "access-changed")
        );
        assert_eq!(
            broadcast_cause(None),
            Cause::new(Kind::DiscardUnsaved, "discard")
        );
    }

    #[test]
    fn client_payloads_drop_the_incident() {
        let payload = r#"{"evictionId":"e","incident":{"kind":"x"},"room":"r","type":"authorization-revoked"}"#;
        assert_eq!(
            client_payload(payload),
            r#"{"evictionId":"e","room":"r","type":"authorization-revoked"}"#
        );
        assert_eq!(client_payload(r#"{"type":"x"}"#), r#"{"type":"x"}"#);
    }

    #[test]
    fn unplaced_is_recorded_once_until_placed() {
        let once = UnplacedOnce::default();
        assert!(once.first("r", "u"));
        assert!(!once.first("r", "u"));
        once.placed("r", "u");
        assert!(once.first("r", "u"));
    }
}
