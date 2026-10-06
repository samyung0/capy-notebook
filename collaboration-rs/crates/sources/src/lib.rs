//! Office and text source rooms (track rust-sources), over the fork's native
//! Office engines (`office-service`, track office-native). The per-update
//! admission is pure; the rest owns the source-only I/O (gateway calls,
//! bases, uploads, engine pools) and reaches the room layer through [`Rooms`],
//! which `crates/server` implements. Contract: DESIGN.md section 6.3.

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
    pub fn parse(_name: &str) -> Option<Self> {
        todo!("rust-sources")
    }
}

/// Why a writer's update may not enter a source room.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `Source checkpoint exceeds byte limit` (incident `over_limit/source_state_bytes`).
    StateBytes,
    /// `officeUpdateViolation`'s message (incident `save_refused/office_update`).
    OfficeUpdate(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Admission {
    Accept,
    /// The room cannot place it yet: the server drops it and resyncs.
    Unheld,
    Refuse(Refusal),
}

/// Per-update admission on the room task (`updateFitsRoom`,
/// `officeUpdateViolation`, `sourceUpdateUnheld`). `estimate` is the room's
/// running byte estimate, reset by an exact measure near the cap.
pub fn admit_update(
    _doc: &yrs::Doc,
    _format: SourceFormat,
    _update: &[u8],
    _estimate: &mut u64,
) -> Admission {
    todo!("rust-sources")
}

/// A channel (one room on one socket) as the server numbers it.
pub type ChannelId = u64;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// What source rooms (the publication handoff, the maintenance pause, the
/// rebuild) ask of the server's room layer.
pub trait Rooms: Send + Sync + 'static {
    fn broadcast(&self, room: &str, payload: String);
    /// The room's live write channels.
    fn writers(&self, room: &str) -> Vec<ChannelId>;
    fn set_read_only(&self, room: &str, channel: ChannelId);
    /// Closes one channel, or every channel of the room when `None`.
    fn close(&self, room: &str, channel: Option<ChannelId>, code: u16, reason: &str);
    /// Stores the room now (its save queue), as `persistSource`.
    fn persist(&self, room: &str) -> BoxFuture<Result<(), String>>;
    /// Loaded, loading, a socket joining, or a store running or awaiting retry.
    fn busy(&self, room: &str) -> bool;
    fn unload(&self, room: &str) -> BoxFuture<()>;
}
