//! A collection in place, as the tombstone prototype measured it (edge +
//! map cut): at a window W (a state vector and delete set), every unit
//! deleted at W that is not the first or last unit of its deleted run, not
//! held by an open session and not named by a kept item becomes GC; a key's
//! value current at W drops its origin when nothing behind it stays. Kept
//! items keep their origins. The room's own collection replaces this at
//! integration.

use std::collections::HashSet;

use yrs::block::{ClientID, ItemContent, ItemPtr};
use yrs::branch::{BranchID, BranchPtr};
use yrs::encoding::write::Write;
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};
use yrs::{Doc, ID, IdSet, ReadTxn, StateVector, Transact};

/// The collected state of `doc` at window (`sv`, `ds`), keeping `held`.
pub fn collect(doc: &Doc, sv: &StateVector, ds: &IdSet, held: &IdSet) -> Vec<u8> {
    let (edges, cut) = at_window(doc, sv, ds, held);
    let eligible = |id: ID, len: u32| {
        (0..len).all(|o| {
            let u = ID::new(id.client, id.clock + o);
            ds.contains(&u) && !held.contains(&u) && !edges.contains(&u)
        })
    };
    discard(doc, &eligible, &cut)
}

/// Every item in a live list or map chain, live or deleted, depth first.
fn items(branch: BranchPtr, out: &mut Vec<ItemPtr>) {
    let mut next = branch.start();
    while let Some(item) = next {
        out.push(item);
        if !item.is_deleted()
            && let ItemContent::Type(inner) = item.content()
        {
            items(BranchPtr::from(inner.as_ref()), out);
        }
        next = item.right();
    }
    for (_, current) in branch.map_items() {
        let mut cur = Some(current);
        while let Some(item) = cur {
            out.push(item);
            if !item.is_deleted()
                && let ItemContent::Type(inner) = item.content()
            {
                items(BranchPtr::from(inner.as_ref()), out);
            }
            cur = item.left();
        }
    }
}

fn roots(txn: &impl ReadTxn) -> Vec<BranchPtr> {
    let mut names: Vec<String> = txn.root_refs().map(|(name, _)| name.to_string()).collect();
    names.sort();
    names
        .iter()
        .filter_map(|name| BranchID::get_root(txn, name.as_str()))
        .collect()
}

/// Discards every tombstone `eligible` accepts unless a kept item names it
/// (transitively); everything outside live parents is GC as before. Values
/// in `cut` are written without their origin.
fn discard(doc: &Doc, eligible: &dyn Fn(ID, u32) -> bool, cut: &HashSet<ID>) -> Vec<u8> {
    let txn = doc.transact();
    let store = txn.store();
    let mut all = Vec::new();
    for root in roots(&txn) {
        items(root, &mut all);
    }
    let mut kept: HashSet<ID> = HashSet::new();
    let mut work: Vec<ItemPtr> = Vec::new();
    for item in &all {
        if !item.is_deleted() || !eligible(*item.id(), item.len()) {
            kept.insert(*item.id());
            work.push(*item);
        }
    }
    let block_of = |id: &ID| -> Option<ItemPtr> {
        store
            .blocks_in(&id.client, id.clock..id.clock + 1)
            .next()
            .and_then(|(_, item)| item)
    };
    while let Some(item) = work.pop() {
        let origin = if cut.contains(item.id()) {
            None
        } else {
            item.origin().copied()
        };
        for target in [origin, item.right_origin().copied()].into_iter().flatten() {
            if let Some(b) = block_of(&target)
                && kept.insert(*b.id())
            {
                work.push(b);
            }
        }
    }
    let sv = txn.state_vector();
    let mut clients: Vec<(ClientID, u32)> = sv.iter().map(|(c, k)| (*c, *k)).collect();
    clients.sort_by_key(|a| std::cmp::Reverse(a.0));
    enum S {
        Keep(ItemPtr),
        Gc(u32, u32),
    }
    let mut enc = EncoderV1::new();
    let mut deleted = IdSet::new();
    enc.write_var(clients.len());
    for (client, clock) in clients {
        let mut structs: Vec<S> = Vec::new();
        for (range, item) in store.blocks_in(&client, 0..clock) {
            match item {
                Some(item) if kept.contains(item.id()) => {
                    if item.is_deleted() {
                        deleted.insert(*item.id(), item.len());
                    }
                    structs.push(S::Keep(item))
                }
                _ => {
                    deleted.insert(ID::new(client, range.clock), range.len);
                    match structs.last_mut() {
                        Some(S::Gc(start, len)) if *start + *len == range.clock => {
                            *len += range.len
                        }
                        _ => structs.push(S::Gc(range.clock, range.len)),
                    }
                }
            }
        }
        enc.write_var(structs.len());
        enc.write_client(client);
        enc.write_var(0u32);
        for s in structs {
            match s {
                S::Gc(_, len) => {
                    enc.write_info(0);
                    enc.write_len(len);
                }
                S::Keep(item) => {
                    let o = if cut.contains(item.id()) {
                        None
                    } else {
                        item.origin().copied()
                    };
                    let r = item.right_origin().copied();
                    let sub = item.parent_sub();
                    let info = if o.is_some() { 0x80 } else { 0 }
                        | if r.is_some() { 0x40 } else { 0 }
                        | if sub.is_some() { 0x20 } else { 0 }
                        | (item.content().get_ref_number() & 0x1f);
                    enc.write_info(info);
                    if let Some(o) = &o {
                        enc.write_left_id(o);
                    }
                    if let Some(r) = &r {
                        enc.write_right_id(r);
                    }
                    if o.is_none() && r.is_none() {
                        match item.parent_branch().map(|b| b.id()) {
                            Some(BranchID::Root(name)) => {
                                enc.write_parent_info(true);
                                enc.write_string(&name);
                            }
                            Some(BranchID::Nested(pid)) => {
                                enc.write_parent_info(false);
                                enc.write_left_id(&pid);
                            }
                            None => unreachable!("an integrated item has a parent"),
                        }
                        if let Some(sub) = sub {
                            enc.write_string(sub);
                        }
                    }
                    item.content().encode(&mut enc);
                }
            }
        }
    }
    let mut state = enc.to_vec();
    state.extend_from_slice(&deleted.encode_v1());
    state
}

/// Every live list and key chain (in document order), depth first.
fn sequences(branch: BranchPtr, lists: &mut Vec<Vec<ItemPtr>>, chains: &mut Vec<Vec<ItemPtr>>) {
    let mut list = Vec::new();
    let mut next = branch.start();
    while let Some(item) = next {
        list.push(item);
        next = item.right();
    }
    for item in &list {
        if !item.is_deleted()
            && let ItemContent::Type(inner) = item.content()
        {
            sequences(BranchPtr::from(inner.as_ref()), lists, chains);
        }
    }
    lists.push(list);
    for (_, current) in branch.map_items() {
        let mut chain = Vec::new();
        let mut cur = Some(current);
        while let Some(item) = cur {
            chain.push(item);
            if !item.is_deleted()
                && let ItemContent::Type(inner) = item.content()
            {
                sequences(BranchPtr::from(inner.as_ref()), lists, chains);
            }
            cur = item.left();
        }
        chain.reverse();
        chains.push(chain);
    }
}

/// W's run edges and the heads to cut, read off the current document: its
/// lists restricted to units that existed at W keep W's order. Units an open
/// session deleted (`held`) count as live.
fn at_window(doc: &Doc, sv: &StateVector, ds: &IdSet, held: &IdSet) -> (HashSet<ID>, HashSet<ID>) {
    let txn = doc.transact();
    let (mut lists, mut chains) = (Vec::new(), Vec::new());
    for root in roots(&txn) {
        sequences(root, &mut lists, &mut chains);
    }
    let existed = |id: &ID| id.clock < sv.get(&id.client);
    let mut edges = HashSet::new();
    for list in lists {
        let units: Vec<(ID, bool)> = list
            .iter()
            .flat_map(|item| {
                (0..item.len()).map(move |o| ID::new(item.id().client, item.id().clock + o))
            })
            .filter(existed)
            .map(|u| (u, ds.contains(&u) && !held.contains(&u)))
            .collect();
        for (i, (u, dead)) in units.iter().enumerate() {
            if *dead && (i == 0 || !units[i - 1].1 || i + 1 == units.len() || !units[i + 1].1) {
                edges.insert(*u);
            }
        }
    }
    let mut cut = HashSet::new();
    for chain in chains {
        if let Some(at) = chain.iter().rposition(|i| existed(i.id())) {
            let head = chain[at];
            if ds.contains(head.id()) {
                edges.insert(*head.id());
            }
            let behind: HashSet<ID> = chain[..at]
                .iter()
                .flat_map(|i| (0..i.len()).map(move |o| ID::new(i.id().client, i.id().clock + o)))
                .collect();
            let behind_held = behind.iter().any(|u| held.contains(u));
            let behind_named = chain[at + 1..]
                .iter()
                .any(|i| i.origin().is_some_and(|o| behind.contains(o)));
            if !behind_held && !behind_named {
                cut.insert(*head.id());
            }
        }
    }
    (edges, cut)
}
