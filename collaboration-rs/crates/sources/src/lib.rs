//! Office and text source rooms (track rust-sources), over the fork's native
//! Office engines (`office-service`, track office-native). The per-update
//! admission is pure; the rest owns the source-only I/O (gateway calls,
//! bases, uploads, engine pools) and reaches the room layer through [`Rooms`],
//! which `crates/server` implements. Contract: DESIGN.md section 6.3.

#![cfg_attr(test, allow(clippy::unwrap_used))]

pub mod admit;
mod disk;
pub mod edit;
pub mod effects;
pub mod engine;
pub mod failure;
pub mod gateway;
pub mod handoff;
pub mod observe;
pub mod refresh;
pub mod schedule;
pub mod seed_check;
pub mod store;
pub mod text;

pub use admit::{Admission, Refusal, admit_update};
pub use failure::SourceError;
pub use store::{Folded, LoadTimes, Loaded, Save, Saved, Sources, SourcesConfig};

use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};

/// The Yjs state cap of a source room (`MAX_SOURCE_STATE_BYTES`).
pub const MAX_SOURCE_STATE_BYTES: usize = 100 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceFormat {
    Docx,
    Xlsx,
    Pptx,
    Text,
}

/// `source:<fileId>:epoch:<epoch>`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SourceRoom {
    pub file_id: String,
    pub epoch: u64,
}

impl SourceRoom {
    /// `^source:([A-Za-z0-9_-]+):epoch:(\d+)$` (auth.ts SOURCE_ROOM_PATTERN).
    pub fn parse(name: &str) -> Option<Self> {
        let rest = name.strip_prefix("source:")?;
        let (file_id, epoch) = rest.split_once(":epoch:")?;
        let id_ok = !file_id.is_empty()
            && file_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
        let epoch_ok = !epoch.is_empty() && epoch.bytes().all(|byte| byte.is_ascii_digit());
        if !(id_ok && epoch_ok) {
            return None;
        }
        Some(Self {
            file_id: file_id.to_owned(),
            epoch: epoch.parse().ok()?,
        })
    }

    pub fn name(&self) -> String {
        format!("source:{}:epoch:{}", self.file_id, self.epoch)
    }
}

/// A channel (one room on one socket) as the server numbers it.
pub type ChannelId = u64;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// A channel of a loaded room as the handoff sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Channel {
    pub id: ChannelId,
    /// Its token grants write access.
    pub write: bool,
    /// It is read-only now (a read token, or a writer the handoff stopped).
    pub read_only: bool,
}

/// What source rooms (the publication handoff, the maintenance pause, the
/// rebuild) ask of the server's room layer. Changed from the 366a5e23
/// sketch: `channels` replaces `writers`, `busy` takes the pause's
/// writers-only rule, `restore_access` and `loaded` are new, and `close`
/// takes an optional code.
pub trait Rooms: Send + Sync + 'static {
    fn broadcast(&self, room: &str, payload: String);
    /// The room's channels; empty when the room is not loaded here.
    fn channels(&self, room: &str) -> Vec<Channel>;
    fn loaded(&self, room: &str) -> bool;
    fn set_read_only(&self, room: &str, channel: ChannelId);
    /// Every channel back to its token's access (a handoff that ended).
    fn restore_access(&self, room: &str);
    /// Closes one channel, or every channel of the room when `None`. Without
    /// a code the client reconnects with backoff (Hocuspocus closeConnections).
    fn close(&self, room: &str, channel: Option<ChannelId>, code: Option<u16>, reason: &str);
    /// Stores the room now (its save queue), as `persistSource`.
    fn persist(&self, room: &str) -> BoxFuture<Result<(), String>>;
    /// The room is in use here: a store running or awaiting its retry, a
    /// socket joining (forgotten after 30 s), loading, or loaded; with
    /// `writers_only` (the maintenance pause) a loaded room counts only while
    /// a channel is writable.
    fn busy(&self, room: &str, writers_only: bool) -> bool;
    fn unload(&self, room: &str) -> BoxFuture<()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_room_names_parse_and_print() {
        let room = SourceRoom::parse("source:f_1-A:epoch:12").unwrap();
        assert_eq!(
            room,
            SourceRoom {
                file_id: "f_1-A".into(),
                epoch: 12
            }
        );
        assert_eq!(room.name(), "source:f_1-A:epoch:12");
        for bad in [
            "source::epoch:1",
            "source:f.1:epoch:1",
            "source:f:epoch:",
            "source:f:epoch:-1",
            "material:m:schema:1",
            "source:f:epoch:1:x",
        ] {
            assert_eq!(SourceRoom::parse(bad), None, "{bad}");
        }
    }
}
