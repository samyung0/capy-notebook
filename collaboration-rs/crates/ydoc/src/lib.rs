//! Pure yrs helpers shared by note rooms (`notes`), source rooms (`sources`)
//! and the server: no I/O, no clocks. Ports of `collaboration/src/officeRoots.ts`
//! (`inspectUpdate`), `yjsUpdateMessage.ts` (`yjsUpdateContainsChanges`),
//! `guards.ts` and `scratchDoc.ts`, plus the delta rows and the replay of
//! delta saves (DESIGN.md section 3).

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use yrs::block::{ClientID, Item, UpdateParent};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    BranchID, Doc, ID, IdSet, OffsetKind, Options, ReadTxn, StateVector, Transact, Update,
    UpdateBlock,
};

/// The server-owned contributor marker map every room carries (DESIGN.md 2).
pub const CONTRIBUTORS_ROOT: &str = "__capy_pending_contributors";

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("malformed yjs update: {0}")]
    Decode(String),
}

/// Decodes a v1 update once, for every check that reads it.
pub fn decode(update: &[u8]) -> Result<Update, UpdateError> {
    Update::decode_v1(update).map_err(|error| UpdateError::Decode(error.to_string()))
}

/// Options of every room and working document: Yjs counts text in UTF-16
/// units, garbage collection on. `client_id` 0 picks a random one.
pub fn doc_options(client_id: u64) -> Options {
    let mut options = if client_id == 0 {
        Options::default()
    } else {
        Options::with_client_id(ClientID::new(client_id))
    };
    options.offset_kind = OffsetKind::Utf16;
    options
}

/// A working document (a merge, a measurement, a candidate, a replay).
pub fn scratch_doc() -> Doc {
    Doc::with_options(doc_options(0))
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

enum Found {
    At(Container),
    /// A reference the room garbage-collected: Yjs drops the struct.
    Gone,
    /// A reference neither the room nor the update holds.
    Unknown,
}

impl Clone for Found {
    fn clone(&self) -> Self {
        match self {
            Found::At(container) => Found::At(container.clone()),
            Found::Gone => Found::Gone,
            Found::Unknown => Found::Unknown,
        }
    }
}

/// `inspectUpdate`: O(update), read against the room, never a copy of it.
pub fn inspect_update<T: ReadTxn>(txn: &T, update: &Update) -> Inspection {
    let state = txn.state_vector();
    let held = |client: &ClientID| state.get(client);
    let store = txn.store();
    let mut incoming: HashMap<ClientID, Vec<&Item>> = HashMap::new();
    for block in update.blocks() {
        if let UpdateBlock::Item(item) = block {
            incoming.entry(item.id().client).or_default().push(item);
        }
    }
    // Decoded structs arrive in clock order per client.
    let incoming_at = |id: &ID| -> Option<&Item> {
        let items = incoming.get(&id.client)?;
        let index = items.partition_point(|item| item.id().clock + item.len() <= id.clock);
        items
            .get(index)
            .copied()
            .filter(|item| item.id().clock <= id.clock)
    };
    let held_at = |id: &ID| -> Found {
        let Some(mut top) = store.get_item(id) else {
            return Found::Gone;
        };
        loop {
            let Some(branch) = top.parent_branch() else {
                return Found::Unknown;
            };
            match branch.item() {
                Some(holder) => top = holder,
                None => {
                    return match branch.id() {
                        BranchID::Root(root) => Found::At(Container {
                            root,
                            key: top.parent_sub().cloned(),
                        }),
                        BranchID::Nested(_) => Found::Unknown,
                    };
                }
            }
        }
    };
    let mut resolved: HashMap<ID, Found> = HashMap::new();
    // Iterative: an update typed character by character chains its origins.
    let mut container_of = |start: &Item| -> Found {
        let mut chain: Vec<ID> = Vec::new();
        let mut item = start;
        let found = loop {
            if let Some(known) = resolved.get(item.id()) {
                break known.clone();
            }
            // A reference cycle stays unknown.
            resolved.insert(*item.id(), Found::Unknown);
            chain.push(*item.id());
            let reference = match item.update_parent() {
                UpdateParent::Root(root) => {
                    break Found::At(Container {
                        root: root.clone(),
                        key: item.parent_sub().cloned(),
                    });
                }
                UpdateParent::Item(parent) => Some(*parent),
                UpdateParent::Unknown => item.origin().or(item.right_origin()).copied(),
                UpdateParent::Branch(_) => None,
            };
            let Some(reference) = reference else {
                break Found::Unknown;
            };
            if reference.clock < held(&reference.client) {
                break held_at(&reference);
            }
            match incoming_at(&reference) {
                Some(next) => item = next,
                None => break Found::Unknown,
            }
        };
        for id in chain {
            resolved.insert(id, found.clone());
        }
        found
    };

    // Yjs integrates each client's structs in clock order only, and applies a
    // deletion only once it holds the deleted range: an update that starts
    // past what the room holds of a client, skips a range, or deletes what
    // neither side holds would stay pending, and a room with pending content
    // cannot be saved.
    let mut unheld = false;
    let mut reach: HashMap<ClientID, u32> = HashMap::new();
    for block in update.blocks() {
        let (client, clock, len, skip) = match block {
            UpdateBlock::Item(item) => (item.id().client, item.id().clock, item.len(), false),
            UpdateBlock::Gc(range) => (range.client, range.clock, range.len, false),
            UpdateBlock::Skip(range) => (range.client, range.clock, range.len, true),
        };
        let from = reach.get(&client).copied().unwrap_or_else(|| held(&client));
        if skip || clock > from {
            unheld = true;
        }
        reach.insert(client, from.max(clock + len));
    }
    for (client, ranges) in update.delete_set().iter() {
        let until = reach.get(client).copied().unwrap_or_else(|| held(client));
        if ranges.iter().any(|range| range.end > until) {
            unheld = true;
        }
    }
    let mut containers = Vec::new();
    for items in incoming.values() {
        for item in items {
            if item.id().clock + item.len() <= held(&item.id().client) {
                continue;
            }
            match container_of(item) {
                Found::Gone => {}
                Found::Unknown => unheld = true,
                Found::At(container) => containers.push(container),
            }
        }
    }
    Inspection { containers, unheld }
}

/// `yjsUpdateContainsChanges`: whether a read-only connection's sync frame
/// carries anything the room does not hold (a struct past the held clock, or
/// a deletion of a live or unheld unit). O(update).
pub fn contains_changes<T: ReadTxn>(txn: &T, update: &Update) -> bool {
    let state = txn.state_vector();
    let held = |client: &ClientID| state.get(client);
    for block in update.blocks() {
        let (client, end) = match block {
            UpdateBlock::Item(item) => (item.id().client, item.id().clock + item.len()),
            UpdateBlock::Gc(range) | UpdateBlock::Skip(range) => {
                (range.client, range.clock + range.len)
            }
        };
        if end > held(&client) {
            return true;
        }
    }
    let store = txn.store();
    for (client, ranges) in update.delete_set().iter() {
        for range in ranges.iter() {
            let mut at = range.start;
            while at < range.end {
                if at >= held(client) {
                    return true;
                }
                let Some((block, item)) = store.get_block_range(&ID::new(*client, at)) else {
                    return true;
                };
                if item.is_some_and(|item| !item.is_deleted()) {
                    return true;
                }
                at = block.clock + block.len;
            }
        }
    }
    false
}

/// What a room's durable state covers, kept between stores: the delta of the
/// next store is everything beyond it.
#[derive(Clone, Debug, Default)]
pub struct Durable {
    pub state_vector: StateVector,
    pub delete_set: IdSet,
}

impl Durable {
    /// The room as it is now (after a load or a committed store).
    pub fn of<T: ReadTxn>(txn: &T) -> Self {
        let snapshot = txn.snapshot();
        Durable {
            state_vector: snapshot.state_map,
            delete_set: snapshot.delete_set,
        }
    }
}

/// One delta row (DESIGN.md 3.1): the structs beyond `durable`, the deletions
/// since it, and deletions of `hidden` items (live contributor markers, which
/// no stored row may carry live). Returns the row and the room's new durable
/// cover once that row commits.
pub fn delta_update<T: ReadTxn>(txn: &T, durable: &Durable, hidden: &[ID]) -> (Vec<u8>, Durable) {
    let snapshot = txn.snapshot();
    let full = txn.encode_state_as_update_v1(&durable.state_vector);
    // The update ends with the room's whole delete set, encoded from the same
    // store as `snapshot().delete_set` (IdSet::from_store in both).
    let whole = snapshot.delete_set.encode_v1();
    debug_assert!(full.ends_with(&whole));
    let structs = &full[..full.len() - whole.len()];
    let mut deleted = snapshot.delete_set.diff(&durable.delete_set);
    for id in hidden {
        deleted.insert(*id, 1);
    }
    let mut row = Vec::with_capacity(structs.len() + 16);
    row.extend_from_slice(structs);
    row.extend_from_slice(&deleted.encode_v1());
    (
        row,
        Durable {
            state_vector: snapshot.state_map,
            delete_set: snapshot.delete_set,
        },
    )
}

#[derive(Debug, thiserror::Error)]
pub enum ReplayError {
    #[error(transparent)]
    Update(#[from] UpdateError),
    #[error("stored state cannot be applied: {0}")]
    Apply(String),
    /// The rows refer to content the base and rows do not hold.
    #[error("stored state leaves pending content")]
    Pending,
}

/// Load-time check of a delta-saved document: base and rows applied in order
/// in one transaction, nothing left pending (DESIGN.md 3.4).
pub fn replay(doc: &Doc, base: &[u8], rows: &[impl AsRef<[u8]>]) -> Result<(), ReplayError> {
    let mut txn = doc.transact_mut();
    if !base.is_empty() {
        txn.apply_update(decode(base)?)
            .map_err(|error| ReplayError::Apply(error.to_string()))?;
    }
    for row in rows {
        txn.apply_update(decode(row.as_ref())?)
            .map_err(|error| ReplayError::Apply(error.to_string()))?;
    }
    if txn.store().pending_update().is_some() || txn.store().pending_ds().is_some() {
        return Err(ReplayError::Pending);
    }
    Ok(())
}

/// Whether a document holds content waiting on structs it never received.
pub fn has_pending<T: ReadTxn>(txn: &T) -> bool {
    txn.store().pending_update().is_some() || txn.store().pending_ds().is_some()
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

#[cfg(test)]
mod tests;
