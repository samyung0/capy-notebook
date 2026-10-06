//! Pure yrs helpers shared by note rooms (`notes`), source rooms (`sources`)
//! and the server: no I/O, no clocks. Ports of `collaboration/src/officeRoots.ts`
//! (`inspectUpdate`), `yjsUpdateMessage.ts` (`yjsUpdateContainsChanges`),
//! `guards.ts` and `scratchDoc.ts`.
//!
//! Reading a decoded update's structs and the room's items by id needs
//! read-only accessors the patched yrs does not expose yet (DESIGN.md,
//! "Needs decision": yrs inspection accessors).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use yrs::ReadTxn;

/// The server-owned contributor marker map every room carries (DESIGN.md 2.5).
pub const CONTRIBUTORS_ROOT: &str = "__capy_pending_contributors";

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("malformed yjs update: {0}")]
    Decode(String),
}

/// Where a new struct sits: its top-level root and, in a map root, its key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Container {
    pub root: Arc<str>,
    pub key: Option<Arc<str>>,
}

/// What a client update holds that the room does not (`inspectUpdate`).
#[derive(Clone, Debug, Default)]
pub struct Inspection {
    /// The container of each new struct the room can place.
    pub containers: Vec<Container>,
    /// The room cannot integrate the update yet (a gap in a client's clocks,
    /// a deletion past what is held, a reference neither side holds): the
    /// caller drops it and resyncs the connection, never refuses it.
    pub unheld: bool,
}

/// `inspectUpdate`: O(update), read against the room, never a copy of it.
pub fn inspect_update<T: ReadTxn>(_txn: &T, _update: &[u8]) -> Result<Inspection, UpdateError> {
    todo!("rust-core phase 2")
}

/// `yjsUpdateContainsChanges`: whether a read-only connection's sync frame
/// carries anything the room does not hold (a struct past the held clock, or
/// a deletion of a live or unheld unit).
pub fn contains_changes<T: ReadTxn>(_txn: &T, _update: &[u8]) -> Result<bool, UpdateError> {
    todo!("rust-core phase 2")
}

/// A working document (a merge, a measurement, a candidate): gc on, fixed guid.
pub fn scratch_doc() -> yrs::Doc {
    todo!("rust-core phase 2")
}

/// `guards.ts`: item-run signatures of a region for agent edits and their Undo.
/// Implemented by rust-notes (its first user); stored as JSON in
/// `agent_edit_inverses.guards`, same shape as today.
pub mod guards {
    use super::{Deserialize, Serialize};

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    pub struct GuardRun {
        pub client: u64,
        pub clock: u32,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        pub deleted: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        pub format: bool,
        pub len: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub nested: Option<Vec<GuardRun>>,
    }

    /// `rangeGuard`: runs of one shared type clipped to `[start, end)` plus
    /// `pad` neighbour units each side.
    pub fn range_guard<T: yrs::ReadTxn>(
        _txn: &T,
        _branch: &yrs::branch::Branch,
        _start: u32,
        _end: u32,
        _pad: u32,
    ) -> Vec<GuardRun> {
        todo!("rust-notes")
    }

    /// `fullGuard`: every run of a type, nested types included.
    pub fn full_guard<T: yrs::ReadTxn>(_txn: &T, _branch: &yrs::branch::Branch) -> Vec<GuardRun> {
        todo!("rust-notes")
    }
}
