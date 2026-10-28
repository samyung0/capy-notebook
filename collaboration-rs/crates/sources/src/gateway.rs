//! The Go API's internal source routes (`/internal/collaboration/files/...`)
//! as the collaboration service calls them, and the bodies they exchange.

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use office_service::NetEffect;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{SourceError, SourceFormat, SourceRoom};

/// The Sentry event a failed gateway call already reported.
pub const ERROR_EVENT_HEADER: &str = "X-Sentry-Event-Id";
/// Sent while retrying a store whose first failure was reported (the
/// gateway then reports it under that event).
pub const RETRY_EVENT_HEADER: &str = "X-Sentry-Retry-Event-Id";

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// Bytes as Go's encoding/json writes `[]byte`: base64, `null` when absent.
pub mod base64_bytes {
    use super::*;

    pub fn serialize<S: serde::Serializer>(
        bytes: &Option<Vec<u8>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(bytes) => serializer.serialize_str(&STANDARD.encode(bytes)),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Vec<u8>>, D::Error> {
        let text: Option<String> = Option::deserialize(deserializer)?;
        text.map(|text| STANDARD.decode(text).map_err(serde::de::Error::custom))
            .transpose()
    }
}

/// `GET .../bootstrap`: the room's source session (sourceDocuments.ts
/// `SourceSession`). A null `state` is seed(base) until the first save.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSession {
    pub access: String,
    pub base_revision: i64,
    #[serde(rename = "baseSourceSHA256")]
    pub base_source_sha256: String,
    pub checkpoint: u64,
    pub epoch: u64,
    pub file_id: String,
    pub format: SourceFormat,
    pub indexed_checkpoint: u64,
    pub net_tokens: i64,
    #[serde(default, rename = "publishedSourceSHA256")]
    pub published_source_sha256: Option<String>,
    #[serde(default, rename = "publishedSourceURL")]
    pub published_source_url: Option<String>,
    #[serde(default, with = "base64_bytes")]
    pub published_state: Option<Vec<u8>>,
    #[serde(default, rename = "publishedStateSeedSHA256")]
    pub published_state_seed_sha256: Option<String>,
    #[serde(default)]
    pub rebuild_pending: bool,
    pub room: String,
    #[serde(rename = "sourceURL")]
    pub source_url: String,
    #[serde(default, with = "base64_bytes")]
    pub state: Option<Vec<u8>>,
    #[serde(default, rename = "stateSeedSHA256")]
    pub state_seed_sha256: Option<String>,
    /// "" for a file with no workspace, its payer's alone (Epo 2026-10-27).
    pub workspace_id: String,
}

/// `POST .../checkpoint` with a delta save: `update` is appended to the
/// document's log (`source_document_updates`) under the checkpoint CAS.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointBody {
    pub actor_ids: Vec<String>,
    /// The workspace the saving room opened the file in, where Go checks every
    /// actor (Q459): a Move's drain stores the edits made before the Move. ""
    /// when it opened a file with no workspace: Go admits only its payer.
    pub workspace_id: String,
    pub epoch: u64,
    pub expected_checkpoint: u64,
    pub base_revision: i64,
    #[serde(with = "base64_bytes")]
    pub update: Option<Vec<u8>>,
    pub pending_effects: Vec<NetEffect>,
    pub net_tokens: u64,
    #[serde(rename = "stateSeedSHA256", skip_serializing_if = "Option::is_none")]
    pub state_seed_sha256: Option<String>,
    /// The first save over seed(base): the base SHA (and for text its seed's size).
    #[serde(rename = "baseSourceSHA256", skip_serializing_if = "Option::is_none")]
    pub base_source_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<Value>,
    /// A room store's agent steps (Q402): each written with this checkpoint,
    /// one already stored passed over, never answered in its place.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub operations: Vec<Value>,
    /// A text source's opening characters, which Go writes to the file's
    /// `preview` (`TextSave::preview`); none for an Office source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSaved {
    pub checkpoint: u64,
    #[serde(default)]
    pub operation: Option<Value>,
    /// The operation's receipt (or its step's Undo) was stored already and
    /// answered in place of this save, which wrote nothing (review r2 M1).
    #[serde(default)]
    pub replayed: bool,
}

/// `GET .../refresh-candidate?jobId`: a claimed source export.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshCandidate {
    pub base_revision: i64,
    #[serde(rename = "baseSourceSHA256")]
    pub base_source_sha256: String,
    #[serde(rename = "baseSourceURL")]
    pub base_source_url: String,
    pub checkpoint: u64,
    pub epoch: u64,
    pub file_id: String,
    pub format: SourceFormat,
    pub job_id: String,
    pub lease_token: String,
    #[serde(default)]
    pub upload_headers: std::collections::BTreeMap<String, String>,
    #[serde(rename = "uploadURL")]
    pub upload_url: String,
}

#[derive(Clone)]
pub struct Gateway {
    http: reqwest::Client,
    api_url: String,
    secret: String,
}

impl Gateway {
    pub fn new(
        http: reqwest::Client,
        api_url: impl Into<String>,
        secret: impl Into<String>,
    ) -> Self {
        Self {
            http,
            api_url: api_url.into(),
            secret: secret.into(),
        }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    fn file_path(file_id: &str, endpoint: &str) -> String {
        format!(
            "/internal/collaboration/files/{}/{endpoint}",
            encode(file_id)
        )
    }

    /// A file route; `body` makes it a POST.
    pub async fn file<T: DeserializeOwned>(
        &self,
        file_id: &str,
        endpoint: &str,
        body: Option<&(impl Serialize + ?Sized)>,
        retry_event: Option<&str>,
        timeout: Option<Duration>,
    ) -> Result<T, SourceError> {
        self.request(
            &Self::file_path(file_id, endpoint),
            body,
            retry_event,
            timeout,
        )
        .await
    }

    /// A source object's URL: a signed bucket URL as is, or a path the API
    /// serves itself (the e2e stack's memory store, `/api/e2e/blobs/`).
    pub fn object_url(&self, url: &str) -> String {
        if url.starts_with('/') {
            format!("{}{url}", self.api_url)
        } else {
            url.to_owned()
        }
    }

    pub async fn request<T: DeserializeOwned>(
        &self,
        path: &str,
        body: Option<&(impl Serialize + ?Sized)>,
        retry_event: Option<&str>,
        timeout: Option<Duration>,
    ) -> Result<T, SourceError> {
        let endpoint = path.rsplit('/').next().unwrap_or(path);
        let endpoint = endpoint.split('?').next().unwrap_or(endpoint).to_owned();
        let url = format!("{}{}", self.api_url, path);
        let mut request = match body {
            Some(body) => self.http.post(&url).json(body),
            None => self.http.get(&url),
        }
        .header("X-Collaboration-Secret", &self.secret)
        .timeout(timeout.unwrap_or(DEFAULT_TIMEOUT));
        if let Some(event) = retry_event {
            request = request.header(RETRY_EVENT_HEADER, event);
        }
        let response = request
            .send()
            .await
            .map_err(|error| SourceError::Other(format!("Source {endpoint} failed: {error}")))?;
        let status = response.status();
        if !status.is_success() {
            let event_id = response
                .headers()
                .get(ERROR_EVENT_HEADER)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let code = response
                .json::<Value>()
                .await
                .ok()
                .and_then(|body| body["errors"][0]["message"].as_str().map(str::to_owned));
            return Err(SourceError::Request {
                status: status.as_u16(),
                message: format!("Source {endpoint} failed ({})", status.as_u16()),
                code,
                event_id,
            });
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| SourceError::Other(format!("Source {endpoint} failed: {error}")))?;
        let bytes = if status == reqwest::StatusCode::NO_CONTENT || bytes.is_empty() {
            &b"null"[..]
        } else {
            &bytes[..]
        };
        serde_json::from_slice(bytes).map_err(|error| {
            SourceError::Other(format!("Source {endpoint} answered garbage: {error}"))
        })
    }

    pub async fn session(&self, file_id: &str, actor: &str) -> Result<SourceSession, SourceError> {
        self.file(
            file_id,
            &format!("bootstrap?actorId={}", encode(actor)),
            None::<&()>,
            None,
            None,
        )
        .await
    }

    /// The per-connection access verdict (204 or a refusal).
    pub async fn access(
        &self,
        room: &SourceRoom,
        actor: &str,
        write: bool,
    ) -> Result<(), SourceError> {
        let endpoint = format!(
            "access?actorId={}&epoch={}&edit={write}",
            encode(actor),
            room.epoch
        );
        let _: Value = self
            .file(&room.file_id, &endpoint, None::<&()>, None, None)
            .await?;
        Ok(())
    }

    /// Moves the file past an epoch whose discarded room threw unsaved state
    /// away; false when the epoch had moved already.
    pub async fn reset_epoch(&self, room: &SourceRoom) -> Result<bool, SourceError> {
        #[derive(Deserialize)]
        struct Moved {
            moved: bool,
        }
        let moved: Moved = self
            .file(
                &room.file_id,
                "epoch-reset",
                Some(&serde_json::json!({ "epoch": room.epoch })),
                None,
                None,
            )
            .await?;
        Ok(moved.moved)
    }
}

/// `encodeURIComponent`.
pub fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_source_object_path_is_the_apis_own() {
        let gateway = super::Gateway::new(reqwest::Client::new(), "http://server:8080", "secret");
        assert_eq!(
            gateway.object_url("/api/e2e/blobs/sources/a.md"),
            "http://server:8080/api/e2e/blobs/sources/a.md"
        );
        assert_eq!(
            gateway.object_url("https://bucket.test/a.md?signed"),
            "https://bucket.test/a.md?signed"
        );
    }
}
