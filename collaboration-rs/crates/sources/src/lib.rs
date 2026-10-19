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

pub use admit::{Admission, Estimate, Refusal, admit_update};
pub use disk::Hold;
pub use failure::SourceError;
pub use store::{Folded, LoadTimes, Loaded, Save, Saved, Sources, SourcesConfig};

use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};

/// The ceiling on any source state: WebSocket frames, downloads and the
/// offline drafts a device holds, and on a published source file. A room's
/// own cap is [`state_cap`]. IMPORTANT: KEEP IN SYNC WITH sourceCeilingBytes
/// IN server/internal/store/source_documents.go
pub const MAX_SOURCE_STATE_BYTES: usize = 100 * 1024 * 1024;

/// What a room's growth stays under its export cap by, so the export's own
/// overhead never takes an accepted state past publication.
/// IMPORTANT: KEEP IN SYNC WITH sourceGrowthMarginBytes IN
/// server/internal/store/source_documents.go
pub const STATE_GROWTH_MARGIN_BYTES: u64 = 1024 * 1024;

/// A room's state cap: its seed plus the export cap (the largest plan source
/// file) less the base file and a margin, within [`MAX_SOURCE_STATE_BYTES`]
/// (Epo 2026-10-17). Pictures that came with the file are references in the
/// seed but bytes in the export; inserted images are bytes in both. So a
/// room's edits keep its export under the plan limit. Publication still
/// takes an export over it, up to the ceiling (Epo 2026-10-19); its base
/// then leaves the room no growth, and the file opens at its size limit.
pub fn state_cap(seed_bytes: u64, base_bytes: u64, export_cap: u64) -> u64 {
    let growth = export_cap.saturating_sub(base_bytes + STATE_GROWTH_MARGIN_BYTES);
    (seed_bytes + growth).min(MAX_SOURCE_STATE_BYTES as u64)
}

/// What admission keeps free under a room's cap (Epo 2026-10-17): the
/// contributor marker the room writes after an update always fits, so the
/// save's check against the cap itself stays exact. A writer's update an
/// agent edit did not see fits only while it is under the reserve too; a
/// larger one racing an agent edit near the cap can still take the save past
/// it. Go's growth budget subtracts it (KEEP IN SYNC WITH
/// sourceWriteReserveBytes in server/internal/store/source_documents.go).
pub const STATE_WRITE_RESERVE_BYTES: u64 = 64 * 1024;

/// The most an update or an agent edit may take a room's state to.
pub fn admission_cap(state_cap: u64) -> u64 {
    state_cap.saturating_sub(STATE_WRITE_RESERVE_BYTES)
}

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

    #[test]
    fn a_rooms_cap_is_its_seed_plus_the_export_cap_less_its_base() {
        const MIB: u64 = 1024 * 1024;
        assert_eq!(state_cap(2 * MIB, 4 * MIB, 30 * MIB), 27 * MIB);
        // A base at the export cap leaves the seed alone.
        assert_eq!(state_cap(2 * MIB, 30 * MIB, 30 * MIB), 2 * MIB);
        // So does a base published over it.
        assert_eq!(state_cap(2 * MIB, 40 * MIB, 30 * MIB), 2 * MIB);
        // Never past the ceiling every room shares.
        assert_eq!(
            state_cap(90 * MIB, MIB, 30 * MIB),
            MAX_SOURCE_STATE_BYTES as u64
        );
    }
}
