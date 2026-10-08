//! Pure yrs helpers shared by note rooms (`notes`), source rooms (`sources`)
//! and the server: no I/O, no clocks. Ports of the Node server's `officeRoots.ts`
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
    /// More than [MAX_SPOT_ITEMS] items would claim one spot of a text.
    #[error("update crowds one spot of a text past {MAX_SPOT_ITEMS} items")]
    Crowded,
}

/// The most items that may claim one spot of a sequence (the same left and
/// right neighbour when written), the room's and an update's together, of
/// any clients (Epo, 2026-10-08). A real editor puts more than one item at a
/// spot only when writers insert there at once; yrs, like Yjs, integrates
/// each item at a spot by scanning those already there, so a pile of them
/// costs quadratic time.
pub const MAX_SPOT_ITEMS: usize = 64;

/// How many of the room's items the count of one spot looks at. A room
/// written before the rule may hold more than [MAX_SPOT_ITEMS] at a spot, far
/// apart: past this many items its count stops (and so may be low), which
/// keeps the check O(update).
const SPOT_WALK: usize = 4 * MAX_SPOT_ITEMS;

/// One spot of a sequence: the left and right neighbour an item names. With
/// neither, the spot is the start of an otherwise empty sequence, so its
/// parent names it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Spot {
    Between(Option<ID>, Option<ID>),
    Empty(SpotParent),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum SpotParent {
    Root(Arc<str>),
    Item(ID),
}

/// Refuses an update that would leave more than [MAX_SPOT_ITEMS] items at
/// one spot of a sequence (map entries are not sequence items). The update's
/// new items are counted per spot; for each spot it touches, the room's items
/// there are counted by a walk of at most [SPOT_WALK] items. O(update).
fn crowded<T: ReadTxn>(txn: &T, incoming: &Incoming) -> Result<(), UpdateError> {
    let state = txn.state_vector();
    let mut spots: HashMap<Spot, usize> = HashMap::new();
    for item in incoming.items() {
        let ID { client, clock } = *item.id();
        if item.parent_sub().is_some() || clock + item.len() <= state.get(&client) {
            continue;
        }
        let spot = match (item.origin(), item.right_origin(), item.update_parent()) {
            (None, None, UpdateParent::Root(root)) => Spot::Empty(SpotParent::Root(root.clone())),
            (None, None, UpdateParent::Item(parent)) => Spot::Empty(SpotParent::Item(*parent)),
            (None, None, _) => continue,
            (origin, right, _) => Spot::Between(origin.copied(), right.copied()),
        };
        *spots.entry(spot).or_default() += 1;
    }
    let store = txn.store();
    let held = |id: &ID| id.clock < state.get(&id.client);
    for (spot, count) in spots {
        if count > MAX_SPOT_ITEMS {
            return Err(UpdateError::Crowded);
        }
        // The room's items at the spot sit between its neighbours: walk from
        // the left one (or the sequence's start) towards the right one.
        let (origin, right, mut next) = match &spot {
            Spot::Between(Some(origin), right) if held(origin) => {
                let Some(left) = store.get_item(origin) else {
                    continue;
                };
                // An item names the last unit of its left neighbour; one in
                // the middle of a held item has nothing after it yet.
                if left.id().clock + left.len() - 1 != origin.clock {
                    continue;
                }
                (Some(*origin), *right, left.right())
            }
            Spot::Between(None, Some(right)) if held(right) => {
                let Some(start) = store
                    .get_item(right)
                    .and_then(|item| item.parent_branch())
                    .and_then(|parent| parent.start())
                else {
                    continue;
                };
                (None, Some(*right), Some(start))
            }
            Spot::Empty(parent) => {
                let branch = match parent {
                    SpotParent::Root(root) => BranchID::get_root(txn, &**root),
                    SpotParent::Item(id) if held(id) => match store.get_item(id) {
                        Some(holder) => match holder.content() {
                            yrs::block::ItemContent::Type(branch) => {
                                Some(yrs::branch::BranchPtr::from(&**branch))
                            }
                            _ => None,
                        },
                        None => None,
                    },
                    SpotParent::Item(_) => None,
                };
                let Some(start) = branch.and_then(|branch| branch.start()) else {
                    continue;
                };
                (None, None, Some(start))
            }
            // A neighbour the room does not hold yet: nothing of the room's
            // is there.
            Spot::Between(..) => continue,
        };
        let mut there = count;
        for _ in 0..SPOT_WALK {
            let Some(item) = next else { break };
            if right.is_some_and(|right| {
                right.client == item.id().client
                    && right.clock >= item.id().clock
                    && right.clock < item.id().clock + item.len()
            }) {
                break;
            }
            if item.origin().copied() == origin && item.right_origin().copied() == right {
                there += 1;
                if there > MAX_SPOT_ITEMS {
                    return Err(UpdateError::Crowded);
                }
            }
            next = item.right();
        }
    }
    Ok(())
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

/// A decoded update's new items and deletes, indexed once for every check
/// that reads them against the room: items per client in clock order (binary
/// search by id), deleted ranges per client sorted and merged (one range
/// holds any span the update deletes whole).
pub struct Incoming<'a> {
    update: &'a Update,
    items: HashMap<ClientID, Vec<&'a Item>>,
    deletes: HashMap<ClientID, Vec<(u32, u32)>>,
}

impl<'a> Incoming<'a> {
    pub fn new(update: &'a Update) -> Self {
        let mut items: HashMap<ClientID, Vec<&Item>> = HashMap::new();
        for block in update.blocks() {
            if let UpdateBlock::Item(item) = block {
                items.entry(item.id().client).or_default().push(item);
            }
        }
        let mut deletes = HashMap::new();
        for (client, range) in update.delete_set().iter() {
            let mut ranges: Vec<(u32, u32)> = range.iter().map(|r| (r.start, r.end)).collect();
            ranges.sort_unstable();
            let mut merged: Vec<(u32, u32)> = Vec::with_capacity(ranges.len());
            for (start, end) in ranges {
                match merged.last_mut() {
                    Some(last) if start <= last.1 => last.1 = last.1.max(end),
                    _ => merged.push((start, end)),
                }
            }
            deletes.insert(*client, merged);
        }
        Incoming {
            update,
            items,
            deletes,
        }
    }

    pub fn update(&self) -> &'a Update {
        self.update
    }

    /// The new item holding `id`, if the update has one. Decoded structs
    /// arrive in clock order per client.
    pub fn item_at(&self, id: &ID) -> Option<&'a Item> {
        let items = self.items.get(&id.client)?;
        let index = items.partition_point(|item| item.id().clock + item.len() <= id.clock);
        items
            .get(index)
            .copied()
            .filter(|item| item.id().clock <= id.clock)
    }

    /// Whether the update deletes every unit of `[from, to)` of a client.
    pub fn deletes(&self, client: &ClientID, from: u32, to: u32) -> bool {
        if from >= to {
            return true;
        }
        let Some(ranges) = self.deletes.get(client) else {
            return false;
        };
        let index = ranges.partition_point(|(_, end)| *end <= from);
        ranges
            .get(index)
            .is_some_and(|(start, end)| *start <= from && *end >= to)
    }

    pub fn items(&self) -> impl Iterator<Item = &'a Item> + '_ {
        self.items.values().flatten().copied()
    }

    pub fn delete_ranges(&self) -> impl Iterator<Item = (&ClientID, &[(u32, u32)])> {
        self.deletes
            .iter()
            .map(|(client, ranges)| (client, ranges.as_slice()))
    }
}

/// `inspectUpdate`: O(update), read against the room, never a copy of it.
pub fn inspect_update<T: ReadTxn>(txn: &T, update: &Update) -> Result<Inspection, UpdateError> {
    inspect(txn, &Incoming::new(update))
}

/// [inspect_update] over an update already indexed (a note's admit indexes
/// it once for this and its growth bound).
///
/// An update whose struct refers (origin, right origin or parent) to the same
/// or a later clock of its own client is malformed: a client's structs
/// integrate in clock order, so it would stay pending in the room forever.
/// An update that crowds one spot of a sequence is refused too (`crowded`).
/// Both are shapes no real editor writes.
pub fn inspect<T: ReadTxn>(txn: &T, incoming: &Incoming) -> Result<Inspection, UpdateError> {
    for item in incoming.items() {
        let ID { client, clock } = *item.id();
        let parent = match item.update_parent() {
            UpdateParent::Item(parent) => Some(parent),
            _ => None,
        };
        let forward = [item.origin(), item.right_origin(), parent]
            .into_iter()
            .flatten()
            .any(|reference| reference.client == client && reference.clock >= clock);
        if forward {
            return Err(UpdateError::Decode(format!(
                "struct {clock} of client {client} refers to itself or a later struct of its client"
            )));
        }
    }
    crowded(txn, incoming)?;
    let update = incoming.update();
    let state = txn.state_vector();
    let held = |client: &ClientID| state.get(client);
    let store = txn.store();
    let incoming_at = |id: &ID| incoming.item_at(id);
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
    for item in incoming.items() {
        if item.id().clock + item.len() <= held(&item.id().client) {
            continue;
        }
        match container_of(item) {
            Found::Gone => {}
            Found::Unknown => unheld = true,
            Found::At(container) => containers.push(container),
        }
    }
    Ok(Inspection { containers, unheld })
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
    /// Both covers at once: stored structs are per-client clock prefixes, so
    /// the larger clock of each client and both delete sets are stored too.
    /// A server edit committed beside the room's own stores joins its cover.
    pub fn union(&mut self, other: &Durable) {
        self.state_vector.merge(other.state_vector.clone());
        self.delete_set.merge_with(other.delete_set.clone());
    }

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

/// Commits `txn` and returns its update as an `observe_update_v1` observer
/// would see it (after garbage collection and squashing; empty when nothing
/// changed). Rooms broadcast from this instead of an observer: the Office
/// engines register observers that are not `Send`, so yrs runs without its
/// `sync` feature.
pub fn committed_update(mut txn: yrs::TransactionMut<'_>) -> Vec<u8> {
    txn.commit();
    if txn.delete_set().is_empty() && txn.after_state() == txn.before_state() {
        return Vec::new();
    }
    txn.encode_update_v1()
}

/// Applies `update` in one transaction and returns what it changed (empty
/// when nothing did).
pub fn apply(doc: &Doc, update: Update) -> Result<Vec<u8>, yrs::error::UpdateError> {
    let mut txn = doc.transact_mut();
    txn.apply_update(update)?;
    Ok(committed_update(txn))
}

/// The live contributor marker items, which a stored row carries deleted.
pub fn live_markers<T: ReadTxn>(txn: &T) -> Vec<ID> {
    let Some(map) = txn.get_map(CONTRIBUTORS_ROOT) else {
        return Vec::new();
    };
    let branch: &yrs::branch::Branch = map.as_ref();
    branch
        .map_items()
        .filter(|(_, item)| !item.is_deleted())
        .map(|(_, item)| *item.id())
        .collect()
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
    /// `pad` neighbour units each side. Gaps need a neighbour to be observable
    /// at all; a present target is guarded on its own so edits beside it keep
    /// its Undo valid. Tombstones and format items count only strictly inside
    /// the padded window; a nested type inside the target carries its full
    /// guard.
    pub fn range_guard<T: yrs::ReadTxn>(
        _txn: &T,
        branch: &yrs::branch::Branch,
        start: u32,
        end: u32,
        pad: u32,
    ) -> Vec<GuardRun> {
        let low = start as i64 - pad as i64;
        let from = low.max(0);
        let to = (end + pad) as i64;
        let mut runs = Vec::new();
        let mut index: i64 = 0;
        let mut next = branch.start();
        while let Some(item) = next {
            next = item.right();
            let id = item.id();
            if item.is_deleted() || !item.is_countable() {
                if index > low && index < to {
                    runs.push(GuardRun {
                        client: id.client.get(),
                        clock: id.clock,
                        deleted: item.is_deleted(),
                        format: !item.is_deleted(),
                        len: item.len(),
                        nested: None,
                    });
                }
                continue;
            }
            let item_start = index;
            let item_end = index + item.len() as i64;
            index = item_end;
            if item_end <= from {
                continue;
            }
            if item_start >= to {
                break;
            }
            let clip_from = from.max(item_start) - item_start;
            let clip_to = to.min(item_end) - item_start;
            // Padding neighbours count by identity only; their content is not ours.
            let nested = if item_start >= start as i64 && item_start < end as i64 {
                nested_of(item).map(|b| full_runs(&b))
            } else {
                None
            };
            runs.push(GuardRun {
                client: id.client.get(),
                clock: id.clock + clip_from as u32,
                deleted: false,
                format: false,
                len: (clip_to - clip_from) as u32,
                nested,
            });
        }
        normalize(runs)
    }

    /// `fullGuard`: every run of a type, nested types included.
    pub fn full_guard<T: yrs::ReadTxn>(_txn: &T, branch: &yrs::branch::Branch) -> Vec<GuardRun> {
        full_runs(branch)
    }

    fn nested_of(item: yrs::block::ItemPtr) -> Option<yrs::branch::BranchPtr> {
        match item.content() {
            yrs::block::ItemContent::Type(branch) => {
                Some(yrs::branch::BranchPtr::from(branch.as_ref()))
            }
            _ => None,
        }
    }

    fn full_runs(branch: &yrs::branch::Branch) -> Vec<GuardRun> {
        let mut runs = Vec::new();
        let mut next = branch.start();
        while let Some(item) = next {
            next = item.right();
            let id = item.id();
            let deleted = item.is_deleted();
            let countable = item.is_countable();
            runs.push(GuardRun {
                client: id.client.get(),
                clock: id.clock,
                deleted,
                format: !deleted && !countable,
                len: item.len(),
                nested: if !deleted && countable {
                    nested_of(item).map(|b| full_runs(&b))
                } else {
                    None
                },
            });
        }
        normalize(runs)
    }

    /// Yjs merges adjacent items of one client lazily, so two identical
    /// documents can split their runs differently: contiguous plain runs
    /// merge, which makes the signature independent of that split.
    fn normalize(runs: Vec<GuardRun>) -> Vec<GuardRun> {
        let mut out: Vec<GuardRun> = Vec::with_capacity(runs.len());
        for run in runs {
            if let Some(last) = out.last_mut()
                && last.nested.is_none()
                && run.nested.is_none()
                && last.client == run.client
                && last.clock + last.len == run.clock
                && last.deleted == run.deleted
                && last.format == run.format
            {
                last.len += run.len;
                continue;
            }
            out.push(run);
        }
        out
    }

    /// `guardsEqual`.
    pub fn guards_equal(a: &[GuardRun], b: &[GuardRun]) -> bool {
        a == b
    }
}

#[cfg(test)]
mod tests;
