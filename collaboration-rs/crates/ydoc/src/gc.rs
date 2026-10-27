//! In-place tombstone collection (openwiki/backend-storage-quota.md "Yjs
//! storage growth"): a fold writes its document's state without the deleted
//! units no replica can still name. Pure: the document D, the window W (what
//! an earlier fold stored: its state vector and delete set) and the held set
//! H in, a state out. Kept list items keep their origins, and a map value
//! drops its origin only when nothing behind it stays, so a replica holding
//! the full history and one loading this state agree on every kept item, and
//! no room or tab moves to a new lineage.
//!
//! A unit is dead when W deleted it and H does not hold it.
//! * lists: in the document's current order, each run of dead units keeps its
//!   first and last unit (Yjs typing names the last unit of a deleted run, a
//!   list insert the first). Any other unit ends a run, a unit newer than W
//!   included: a session that has seen it can type next to it. The rest of a
//!   run goes unless a kept item names it as origin or right origin, closed
//!   over that;
//! * maps: the value current at W is kept; it drops its origin, so the values
//!   behind it go, only when nothing behind it stays (a value behind it held,
//!   newer than W, or named by a value after it);
//! * contributor markers: a chain written by an ended room life goes whole
//!   (only the room writes markers, and an ended life's keys are never
//!   written again); the open room's own chains are maps as above.

use std::collections::HashSet;
use std::ops::Range;

use yrs::block::{ClientID, HAS_PARENT_SUB, HAS_RIGHT_ORIGIN, ItemPtr, UpdateParent};
use yrs::branch::{BranchID, BranchPtr};
use yrs::encoding::write::Write;
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};
use yrs::{Doc, ID, IdSet, ReadTxn, StateVector, Transact, Update, UpdateBlock};

use crate::CONTRIBUTORS_ROOT;

/// What a document held when a fold stored it: a later collection's window
/// candidate.
#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    pub stored_version: i64,
    pub state_vector: StateVector,
    pub delete_set: IdSet,
}

impl Window {
    /// The document as `txn` holds it, folded at `stored_version`.
    pub fn of<T: ReadTxn>(txn: &T, stored_version: i64) -> Self {
        let snapshot = txn.snapshot();
        Window {
            stored_version,
            state_vector: snapshot.state_map,
            delete_set: snapshot.delete_set,
        }
    }
}

/// The window a collection uses when every counted session has reached
/// `reached`: the newest of `windows` stored at or before it. None when every
/// one is newer: nothing is collected then.
pub fn window_for(windows: &[Window], reached: i64) -> Option<&Window> {
    windows
        .iter()
        .filter(|window| window.stored_version <= reached)
        .max_by_key(|window| window.stored_version)
}

/// A collected state.
pub struct Collected {
    pub state: Vec<u8>,
    /// Deleted units the state holds as collected that `doc` held as items.
    pub units: u64,
}

/// Lists in order and map chains oldest first, below a branch.
#[derive(Default)]
struct Sequences {
    lists: Vec<Vec<ItemPtr>>,
    chains: Vec<Vec<ItemPtr>>,
}

/// Every list and map chain of `branch` and the live types in them, depth
/// first. A deleted type's children are collected already.
fn walk(branch: BranchPtr, out: &mut Sequences) {
    let mut list = Vec::new();
    let mut next = branch.start();
    while let Some(item) = next {
        list.push(item);
        next = item.right();
    }
    for item in &list {
        nested(*item, out);
    }
    out.lists.push(list);
    for (_, current) in branch.map_items() {
        let mut chain = Vec::new();
        let mut at = Some(current);
        while let Some(item) = at {
            chain.push(item);
            at = item.left();
        }
        chain.reverse();
        for item in &chain {
            nested(*item, out);
        }
        out.chains.push(chain);
    }
}

fn nested(item: ItemPtr, out: &mut Sequences) {
    if let yrs::block::ItemContent::Type(inner) = item.content()
        && !item.is_deleted()
    {
        walk(BranchPtr::from(inner.as_ref()), out);
    }
}

/// The ranges of `set` for `client` that meet `span`, clipped to it, in
/// clock order.
fn clipped(set: &IdSet, client: &ClientID, span: Range<u32>) -> Vec<Range<u32>> {
    let Some(ranges) = set.get(client) else {
        return Vec::new();
    };
    let ranges = ranges.as_slice();
    let first = ranges.partition_point(|(range, _)| range.end <= span.start);
    ranges[first..]
        .iter()
        .take_while(|(range, _)| range.start < span.end)
        .map(|(range, _)| range.start.max(span.start)..range.end.min(span.end))
        .collect()
}

/// `item`'s units in clock order as stretches, each dead (W deleted it and H
/// does not hold it) or not. Read off the ranges of W's delete set and H, so
/// an item costs its ranges, however many units it claims.
fn stretches(item: &ItemPtr, window: &Window, held: &IdSet) -> Vec<(Range<u32>, bool)> {
    let id = item.id();
    let span = id.clock..id.clock + item.len();
    let mut dead = Vec::new();
    for deleted in clipped(&window.delete_set, &id.client, span.clone()) {
        let mut from = deleted.start;
        for kept in clipped(held, &id.client, deleted.clone()) {
            if from < kept.start {
                dead.push(from..kept.start);
            }
            from = kept.end;
        }
        if from < deleted.end {
            dead.push(from..deleted.end);
        }
    }
    let mut out = Vec::new();
    let mut at = span.start;
    for range in dead {
        if at < range.start {
            out.push((at..range.start, false));
        }
        at = range.end;
        out.push((range, true));
    }
    if at < span.end {
        out.push((at..span.end, false));
    }
    out
}

/// `doc`'s state without what W, H and the marker rule let go (module docs).
/// `held` is H: the deletions an open session's Undo, the open room's agent
/// steps or an unexpired durable Undo payload may still restore. `live_room`
/// is the open room's own client, whose marker chains stay; None at the
/// unload fold.
pub fn collect(doc: &Doc, window: &Window, held: &IdSet, live_room: Option<ClientID>) -> Collected {
    let txn = doc.transact();
    let store = txn.store();
    let mut seqs = Sequences::default();
    let mut markers = Sequences::default();
    for (name, _) in txn.root_refs() {
        if let Some(root) = BranchID::get_root(&txn, name) {
            walk(
                root,
                if name == CONTRIBUTORS_ROOT {
                    &mut markers
                } else {
                    &mut seqs
                },
            );
        }
    }
    seqs.lists.append(&mut markers.lists);
    // Marker chains of ended room lives go whole (never a live marker): they
    // are left out of the walk, so nothing keeps them.
    for chain in markers.chains {
        let ended = chain
            .iter()
            .all(|item| item.is_deleted() && Some(item.id().client) != live_room);
        if !ended {
            seqs.chains.push(chain);
        }
    }

    let existed = |id: &ID| id.clock < window.state_vector.get(&id.client);
    // The items holding a run's edge (its first or last unit).
    let mut edged: HashSet<ID> = HashSet::new();
    for list in &seqs.lists {
        // The item holding the last unit of the dead run being read.
        // Anything but a dead unit ends it: live, held or newer than W (a
        // session that saw a newer unit can type next to it, naming the
        // run's unit beside it).
        let mut run: Option<ItemPtr> = None;
        for item in list {
            if !item.is_deleted() {
                if let Some(last) = run.take() {
                    edged.insert(*last.id());
                }
                continue;
            }
            for (_, dead) in stretches(item, window, held) {
                if dead {
                    if run.is_none() {
                        edged.insert(*item.id());
                    }
                    run = Some(*item);
                } else if let Some(last) = run.take() {
                    edged.insert(*last.id());
                }
            }
        }
        if let Some(last) = run {
            edged.insert(*last.id());
        }
    }
    // Each key's value current at W, with the values behind it.
    let mut heads: Vec<(ItemPtr, &[ItemPtr])> = Vec::new();
    for chain in &seqs.chains {
        let Some(at) = chain.iter().rposition(|item| existed(item.id())) else {
            continue;
        };
        let head = chain[at];
        // A map set names the key's current value, deleted or not.
        if window.delete_set.contains(head.id()) {
            edged.insert(*head.id());
        }
        heads.push((head, &chain[..at]));
    }

    let mut kept: HashSet<ID> = HashSet::new();
    let mut work: Vec<ItemPtr> = Vec::new();
    for item in seqs.lists.iter().chain(&seqs.chains).flatten() {
        let eligible = item.is_deleted()
            && !edged.contains(item.id())
            && matches!(stretches(item, window, held).as_slice(), [(_, true)]);
        if !eligible && kept.insert(*item.id()) {
            work.push(*item);
        }
    }
    // First without the heads' origins, then a head behind which something
    // stays (held, newer than W, or named by a later value) keeps its origin:
    // written without it, it would load on the wrong side of what stayed.
    let mut cut: HashSet<ID> = heads
        .iter()
        .filter(|(head, _)| head.parent_branch().is_some())
        .map(|(head, _)| *head.id())
        .collect();
    close(store, &mut kept, &mut work, &cut);
    for (head, behind) in &heads {
        if behind.iter().any(|item| kept.contains(item.id())) && cut.remove(head.id()) {
            work.push(*head);
        }
    }
    close(store, &mut kept, &mut work, &cut);

    // Clients in Yjs's order (highest first), each from clock 0: kept items
    // as they are, everything else as collected runs.
    let mut clients: Vec<(ClientID, u32)> = txn
        .state_vector()
        .iter()
        .map(|(client, clock)| (*client, *clock))
        .collect();
    clients.sort_by_key(|&(client, _)| std::cmp::Reverse(client));
    let mut encoder = EncoderV1::new();
    let mut deleted = IdSet::new();
    let mut collected_units = 0u64;
    encoder.write_var(clients.len());
    enum Struct {
        Keep(ItemPtr),
        Collected(u32),
    }
    for (client, clock) in clients {
        let mut structs: Vec<Struct> = Vec::new();
        for (range, item) in store.blocks_in(&client, 0..clock) {
            match item {
                Some(item) if kept.contains(item.id()) => {
                    if item.is_deleted() {
                        deleted.insert(*item.id(), item.len());
                    }
                    structs.push(Struct::Keep(item));
                }
                _ => {
                    if item.is_some() {
                        collected_units += u64::from(range.len);
                    }
                    deleted.insert(ID::new(client, range.clock), range.len);
                    match structs.last_mut() {
                        Some(Struct::Collected(len)) => *len += range.len,
                        _ => structs.push(Struct::Collected(range.len)),
                    }
                }
            }
        }
        encoder.write_var(structs.len());
        encoder.write_client(client);
        encoder.write_var(0u32);
        for s in structs {
            match s {
                Struct::Collected(len) => {
                    encoder.write_info(0);
                    encoder.write_len(len);
                }
                Struct::Keep(item) if cut.contains(item.id()) => encode_cut(&item, &mut encoder),
                Struct::Keep(item) => item.encode(&mut encoder),
            }
        }
    }
    let mut state = encoder.to_vec();
    state.extend_from_slice(&deleted.encode_v1());
    Collected {
        state,
        units: collected_units,
    }
}

/// Keeps what the items in `work` name, transitively; a head in `cut` does
/// not name its origin.
fn close(store: &yrs::Store, kept: &mut HashSet<ID>, work: &mut Vec<ItemPtr>, cut: &HashSet<ID>) {
    while let Some(item) = work.pop() {
        let origin = if cut.contains(item.id()) {
            None
        } else {
            item.origin()
        };
        for target in [origin, item.right_origin()].into_iter().flatten() {
            if let Some((_, Some(block))) = store.get_block_range(target)
                && kept.insert(*block.id())
            {
                work.push(block);
            }
        }
    }
}

/// A map value written without its origin: its parent and key instead, as
/// Yjs writes an item with neither origin.
fn encode_cut(item: &ItemPtr, encoder: &mut EncoderV1) {
    let right = item.right_origin();
    let info = if right.is_some() { HAS_RIGHT_ORIGIN } else { 0 }
        | if item.parent_sub().is_some() {
            HAS_PARENT_SUB
        } else {
            0
        }
        | (item.content().get_ref_number() & 0b1111);
    encoder.write_info(info);
    match right {
        Some(right) => encoder.write_right_id(right),
        None => {
            match item.parent_branch().map(|branch| branch.id()) {
                Some(BranchID::Root(name)) => {
                    encoder.write_parent_info(true);
                    encoder.write_string(&name);
                }
                Some(BranchID::Nested(id)) => {
                    encoder.write_parent_info(false);
                    encoder.write_left_id(&id);
                }
                // `collect` cuts only items with a parent branch.
                None => {}
            }
            if let Some(key) = item.parent_sub() {
                encoder.write_string(key);
            }
        }
    }
    item.content().encode(encoder);
}

/// Whether an update's new items name a unit `txn`'s document holds
/// collected, as origin, right origin or parent: Yjs and yrs integrate such
/// an item as collected too, so an Undo payload naming one would restore only
/// part of its edit (the durable Undo route refuses it, `undo_unavailable`),
/// and any update naming one is answered late at a room's admission (Q436,
/// Q443). An item the document already holds names nothing new; one it
/// holds in part (a draft carries its session's whole document, where a
/// unit typed right after the session's own last one joined that item) is
/// integrated from its first unit the document lacks, whose origin is the
/// unit before. The state vector is read only for an item the document
/// holds at all, so a live edit's new items cost three lookups each.
pub fn names_collected<T: ReadTxn>(txn: &T, update: &Update) -> bool {
    let store = txn.store();
    let mut held: Option<StateVector> = None;
    update.blocks().any(|block| match block {
        UpdateBlock::Item(item) => {
            let id = *item.id();
            let origin = if store.get_block_range(&id).is_some() {
                let have = held
                    .get_or_insert_with(|| txn.state_vector())
                    .get(&id.client);
                if id.clock + item.len() <= have {
                    return false;
                }
                Some(ID::new(id.client, have - 1))
            } else {
                item.origin().copied()
            };
            let parent = match item.update_parent() {
                UpdateParent::Item(id) => Some(*id),
                _ => None,
            };
            [origin, item.right_origin().copied(), parent]
                .into_iter()
                .flatten()
                .any(|id| matches!(store.get_block_range(&id), Some((_, None))))
        }
        UpdateBlock::Gc(_) | UpdateBlock::Skip(_) => false,
    })
}

#[cfg(test)]
mod tests;
