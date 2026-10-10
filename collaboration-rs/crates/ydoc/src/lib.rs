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
    /// Placing the update would cost yrs more than [MAX_WORK] steps.
    #[error("update would take yrs more than {MAX_WORK} steps to place")]
    Costly,
}

/// The integration work, counted by yrs itself, an update may cost the room
/// (Epo, 2026-10-08): a step per item a conflict scan passes or per step of a
/// map key's walk, per 128 blocks a split or merge moves and per 64 blocks the
/// struct picker scans, about 85 ns of work each in release (the fork's
/// `TransactionMut::limit_work`): a million is about 90 ms, so large real
/// offline bundles pass (raised from 100,000 the same day).
pub const MAX_WORK: u64 = 1_000_000;

/// The steps of the walks admission takes over an update and its room
/// before yrs applies it (resolving origin chains, scanning neighbours), per
/// thread. Tests read it to catch a walk that turned quadratic by its count,
/// not its time (Epo, 2026-10-08: security regressions count work).
pub mod steps {
    use std::cell::Cell;

    /// The walk a step belongs to, so a test can floor each one: a walk
    /// whose step went missing then fails it (REVIEW3 N1).
    #[derive(Clone, Copy, Debug)]
    pub enum Walk {
        /// `inspect`'s pass over the update's structs.
        Structs,
        /// [crate::applies_inline]'s count of the update's structs.
        Inline,
        /// `inspect`'s walk from a held reference up to its root.
        Holders,
        /// `inspect`'s resolution of each new struct's container.
        Containers,
        /// The small-edit check's walk over the room blocks a deletion covers.
        Deletions,
        /// A probe of [crate::Incoming::deletes]'s binary search.
        DeleteLookup,
        /// The notes content check's resolution of each new item.
        Content,
        /// The growth bound's walk from a held type to the content root.
        Ancestry,
        /// The growth bound's placement of each new item.
        Placement,
        /// The growth bound's walk over the room blocks the update deletes.
        DeleteRanges,
        /// The growth bound's re-pricing walk over a held text.
        Reprice,
        /// The growth bound's walk to each new item's held sides.
        Sides,
        /// The growth bound's walk over hidden units between two sides.
        Adjacent,
        /// The growth bound's walk to the visible unit beside a position.
        Beside,
        /// The notes key checks' lookups of an element's entries, and their
        /// walk along the entries an update writes under one key.
        Entries,
        /// An item room's exact check and counted bounds: each entry they
        /// visit (live-items, REVIEW1 S2).
        Exact,
    }

    const WALKS: usize = Walk::Exact as usize + 1;

    thread_local!(static STEPS: [Cell<u64>; WALKS] = const { [const { Cell::new(0) }; WALKS] });

    /// Counts one step of `walk`.
    #[inline]
    pub fn step(walk: Walk) {
        STEPS.with(|steps| {
            let count = &steps[walk as usize];
            count.set(count.get().wrapping_add(1));
        });
    }

    /// The steps counted on this thread since the last call, per walk.
    pub fn take() -> Steps {
        Steps(STEPS.with(|steps| std::array::from_fn(|walk| steps[walk].replace(0))))
    }

    pub struct Steps([u64; WALKS]);

    impl Steps {
        pub fn total(&self) -> u64 {
            self.0.iter().sum()
        }

        pub fn of(&self, walk: Walk) -> u64 {
            self.0[walk as usize]
        }
    }
}

/// The most structs, and delete ranges, of a small edit.
pub const SMALL_EDIT: usize = 16;

/// Whether `incoming` is a small edit the room applies directly, without a
/// trial (Epo, 2026-10-08): structs of one client, at most [SMALL_EDIT] of
/// them and of delete ranges, each an item placed where its conflict scan can
/// pass only the edit's own items: right after its origin as the room holds
/// it (its right origin the room's next unit, or the first of a sequence with
/// no origin), into a sequence or map key the room holds empty, into a type
/// the edit creates, or after an earlier struct of the edit, before what that
/// one was written before. Its scans then pass at most [SMALL_EDIT] squared
/// items and it splits at most two held items per struct.
///
/// Only what the room lacks counts (Epo, 2026-10-08): structs it holds and
/// deletions it holds already are no work for yrs, and a reconnect's
/// catch-up repeats the document's whole delete set.
fn small_edit<T: ReadTxn>(txn: &T, incoming: &Incoming) -> bool {
    let update = incoming.update();
    let state = txn.state_vector();
    if !few_new_deletions(txn, &state, incoming) {
        return false;
    }
    let lacking = |id: &ID, len: u32| id.clock + len > state.get(&id.client);
    let mut client = None;
    let mut structs = 0;
    for block in update.blocks() {
        let UpdateBlock::Item(item) = block else {
            return false;
        };
        if !lacking(item.id(), item.len()) {
            continue;
        }
        structs += 1;
        if structs > SMALL_EDIT || client.is_some_and(|c| c != item.id().client) {
            return false;
        }
        client = Some(item.id().client);
    }
    let held = |id: &ID| id.clock < state.get(&id.client);
    let store = txn.store();
    // The unit after `id` as the room holds it (None past the end), unless
    // the room collected it.
    let room_next = |id: &ID| -> Option<Option<ID>> {
        let item = store.get_item(id)?;
        let start = item.id();
        if id.clock + 1 < start.clock + item.len() {
            return Some(Some(ID::new(id.client, id.clock + 1)));
        }
        Some(item.right().map(|right| *right.id()))
    };
    incoming.items().all(|item| {
        if !lacking(item.id(), item.len()) {
            return true;
        }
        let origin = item.origin().copied();
        let right_origin = item.right_origin().copied();
        match (origin, right_origin) {
            (Some(origin), right) if held(&origin) => {
                right.is_none_or(|right| held(&right)) && room_next(&origin) == Some(right)
            }
            // The first of a sequence (not a map key: yrs would walk its values).
            (None, Some(right)) if held(&right) => store.get_item(&right).is_some_and(|first| {
                *first.id() == right && first.left().is_none() && first.parent_sub().is_none()
            }),
            (Some(origin), right) => incoming.item_at(&origin).is_some_and(|earlier| {
                let last = earlier.id().clock + earlier.len() - 1;
                (origin.clock == last && right == earlier.right_origin().copied())
                    || right.is_some_and(|right| {
                        right.client == origin.client
                            && right.clock == origin.clock + 1
                            && right.clock <= last
                    })
            }),
            (None, Some(_)) => false,
            (None, None) => match item.update_parent() {
                UpdateParent::Item(parent) if !held(parent) => true,
                UpdateParent::Item(parent) => store
                    .get_item(parent)
                    .and_then(|parent| match parent.content() {
                        yrs::block::ItemContent::Type(branch) => Some(empty(
                            yrs::branch::BranchPtr::from(&**branch),
                            item.parent_sub(),
                        )),
                        _ => None,
                    })
                    .unwrap_or(false),
                UpdateParent::Root(name) => BranchID::get_root(txn, &**name)
                    .is_none_or(|branch| empty(branch, item.parent_sub())),
                _ => false,
            },
        }
    })
}

/// An update past this many bytes is admitted and applied off a server's
/// async workers even when it is a small edit (REVIEW3 S1): structs and
/// deletions the room holds cost no trial, but reading them does.
pub const INLINE_BYTES: usize = 64 * 1024;

/// Whether a server may admit and apply `incoming` inline on its async
/// workers: at most [INLINE_BYTES], at most [SMALL_EDIT] structs counting
/// the ones the room holds (a step each it looks at), and a small edit, so
/// no trial on a copy. Anything else goes to the blocking pool while the room
/// waits.
pub fn applies_inline<T: ReadTxn>(txn: &T, incoming: &Incoming, bytes: usize) -> bool {
    if bytes > INLINE_BYTES {
        return false;
    }
    let mut structs = 0;
    for _ in incoming.update().blocks() {
        steps::step(steps::Walk::Inline);
        structs += 1;
        if structs > SMALL_EDIT {
            return false;
        }
    }
    small_edit(txn, incoming)
}

/// Whether at most [SMALL_EDIT] of the update's delete ranges delete
/// something the room does not hold deleted already (or collected). Each
/// room block a range covers is a step; past [MAX_WORK] steps the answer is
/// no, and the update takes the trial, as any large one does.
fn few_new_deletions<T: ReadTxn>(txn: &T, state: &StateVector, incoming: &Incoming) -> bool {
    let store = txn.store();
    let (mut fresh, mut spent) = (0, 0u64);
    for (client, ranges) in incoming.delete_ranges() {
        for &(from, to) in ranges {
            let mut clock = from;
            let held = to <= state.get(client)
                && loop {
                    if clock >= to {
                        break true;
                    }
                    steps::step(steps::Walk::Deletions);
                    spent += 1;
                    if spent > MAX_WORK {
                        return false;
                    }
                    match store.get_block_range(&ID::new(*client, clock)) {
                        Some((range, item)) if item.is_none_or(|item| item.is_deleted()) => {
                            clock = range.clock + range.len;
                        }
                        _ => break false,
                    }
                };
            if !held {
                fresh += 1;
                if fresh > SMALL_EDIT {
                    return false;
                }
            }
        }
    }
    true
}

/// Whether the room holds nothing at a map key of `branch` (or, without a
/// key, in its sequence).
fn empty(branch: yrs::branch::BranchPtr, key: Option<&Arc<str>>) -> bool {
    match key {
        Some(key) => branch.entry_item(key).is_none(),
        None => branch.start().is_none(),
    }
}

/// The first unit of each struct a document holds pending.
fn pending_ids<T: ReadTxn>(txn: &T) -> Vec<ID> {
    let Some(pending) = txn.store().pending_update() else {
        return Vec::new();
    };
    pending
        .update
        .blocks()
        .map(|block| match block {
            UpdateBlock::Item(item) => *item.id(),
            UpdateBlock::Gc(range) | UpdateBlock::Skip(range) => ID::new(range.client, range.clock),
        })
        .collect()
}

/// The room copied and the update applied to the copy, with yrs counting its
/// work: past [MAX_WORK], or with structs of the update the copy still leaves
/// pending (the references [inspect] checked are all held by the room or the
/// update, so they wait on each other in a cycle), the update is refused.
fn trial<T: ReadTxn>(txn: &T, incoming: &Incoming) -> Result<Doc, UpdateError> {
    use yrs::error::UpdateError as Refused;
    let update = incoming.update();
    let doc = scratch_doc();
    let state = txn.encode_state_as_update_v1(&StateVector::default());
    doc.transact_mut()
        .apply_update(decode(&state)?)
        .map_err(|error| UpdateError::Decode(error.to_string()))?;
    let mut copy = doc.transact_mut();
    // A room never holds pending structs (it drops what it cannot place), but
    // what one holds stays its own.
    let held_pending = pending_ids(&copy);
    copy.limit_work(MAX_WORK);
    // yrs applies an update by value: the copy takes it re-encoded.
    match copy.apply_update(decode(&update.encode_v1())?) {
        Ok(()) => {}
        Err(Refused::WorkBudgetExceeded(_)) => return Err(UpdateError::Costly),
        Err(error) => return Err(UpdateError::Decode(error.to_string())),
    }
    copy.commit();
    if copy.work() > MAX_WORK {
        return Err(UpdateError::Costly);
    }
    let cycle = pending_ids(&copy)
        .iter()
        .any(|id| incoming.item_at(id).is_some() && !held_pending.contains(id));
    if cycle {
        return Err(UpdateError::Decode(
            "structs of the update wait on each other in a cycle".into(),
        ));
    }
    drop(copy);
    Ok(doc)
}

/// Decodes a v1 update once, for every check that reads it.
pub fn decode(update: &[u8]) -> Result<Update, UpdateError> {
    Update::decode_v1(update).map_err(|error| UpdateError::Decode(error.to_string()))
}

/// Options of every room and working document (the sources crate's too):
/// Yjs counts text in UTF-16 units, garbage collection on, and no formatting
/// cleanup. For Office rooms that is Epo's D3 (2026-10-09): with it on, each
/// replica deletes the format markers an update left redundant only for
/// itself, and peers read differently. Note rooms have run without it since
/// the Rust rooms began; browser peers still run Yjs's cleanup and send it,
/// and the room keeps what they send. `client_id` 0 picks a random one.
pub fn doc_options(client_id: u64) -> Options {
    let mut options = if client_id == 0 {
        Options::default()
    } else {
        Options::with_client_id(ClientID::new(client_id))
    };
    options.offset_kind = OffsetKind::Utf16;
    options.cleanup_formatting = false;
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
    /// The room with the update applied, when [inspect] tried it on a copy
    /// (any update past a small edit the room can place).
    pub trial: Option<Doc>,
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
        // A binary search, each probe a step: the growth bound asks this per
        // held item it walks (plate REVIEW1 M1 scanned the set each time).
        let (mut low, mut high) = (0, ranges.len());
        while low < high {
            steps::step(steps::Walk::DeleteLookup);
            let middle = low + (high - low) / 2;
            if ranges[middle].1 <= from {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        ranges
            .get(low)
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

/// `inspectUpdate`, read against the room, plus a trial on a copy of it past
/// a small edit (see [inspect]).
pub fn inspect_update<T: ReadTxn>(txn: &T, update: &Update) -> Result<Inspection, UpdateError> {
    inspect(txn, &Incoming::new(update))
}

/// [inspect_update] over an update already indexed (a note's admit indexes
/// it once for this and its growth bound).
///
/// An update whose struct refers (origin, right origin or parent) to the same
/// or a later clock of its own client is malformed: a client's structs
/// integrate in clock order, so it would stay pending in the room forever.
/// So is one whose structs of a client overlap or go back in clock order
/// (two sections for one client): yrs would place an overlapping struct a
/// second time and free the first while the sequence still links it. These
/// are shapes no real editor writes.
///
/// Past a small edit ([small_edit]), an update the room can place is applied
/// to a copy of the room first ([trial]): refused if yrs counts more than
/// [MAX_WORK] steps placing it, or if its structs wait on each other.
pub fn inspect<T: ReadTxn>(txn: &T, incoming: &Incoming) -> Result<Inspection, UpdateError> {
    let mut ends: HashMap<ClientID, u32> = HashMap::new();
    // A step per struct: every update admission reads walks its structs at
    // least once, which the cost tests take as their floor.
    for block in incoming.update().blocks() {
        steps::step(steps::Walk::Structs);
        let (client, clock, len) = match block {
            UpdateBlock::Item(item) => (item.id().client, item.id().clock, item.len()),
            UpdateBlock::Gc(range) | UpdateBlock::Skip(range) => {
                (range.client, range.clock, range.len)
            }
        };
        let end = ends.entry(client).or_default();
        if clock < *end {
            return Err(UpdateError::Decode(format!(
                "struct {clock} of client {client} overlaps or precedes the one before it"
            )));
        }
        *end = clock + len;
    }
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
            steps::step(steps::Walk::Holders);
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
            steps::step(steps::Walk::Containers);
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
    // So does a struct referring to a unit neither side holds. A struct the
    // trial still leaves pending then waits only on the update's own.
    for item in incoming.items() {
        if item.id().clock + item.len() <= held(&item.id().client) {
            continue;
        }
        let parent = match item.update_parent() {
            UpdateParent::Item(parent) => Some(parent),
            _ => None,
        };
        for reference in [item.origin(), item.right_origin(), parent]
            .into_iter()
            .flatten()
        {
            let until = reach
                .get(&reference.client)
                .copied()
                .unwrap_or_else(|| held(&reference.client));
            if reference.clock >= until {
                unheld = true;
            }
        }
    }
    // The trial before the containers: a costly update is refused before
    // that pass. One the pass then finds unheld drops its trial.
    let mut trial = if unheld || small_edit(txn, incoming) {
        None
    } else {
        Some(trial(txn, incoming)?)
    };
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
    if unheld {
        trial = None;
    }
    Ok(Inspection {
        containers,
        unheld,
        trial,
    })
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
