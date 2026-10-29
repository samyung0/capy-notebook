//! The late merge of the in-place Yjs GC. A collection discards
//! tombstones no session inside its window can name; a tab or stored draft
//! older than the window may name one, so its unsent edits never go raw. The
//! tab fetches the room's current document and this merge places its unsent
//! edits onto it, under the tab's own item ids, as one ordinary update the
//! room admits like any other (openwiki/frontend/plate-editor.md, "The late
//! path"). The sender places, so the server only checks lateness.
//!
//! Placement (stable left): each unsent run goes right after the nearest
//! unit on its left, in the tab's old document, that the current document
//! still holds. Tombstones count as neighbours, and a run that lands after a
//! tombstone moves to the end of its deleted run, as typing does. Text the
//! tab never saw is a tie. Units the current document holds are skipped, so
//! merging or sending again is a no-op.
//!
//! Re-authored (`reauthor`): edits under a client id the room never assigned
//! or no longer holds are refused as they are, so the same placement writes
//! them as new edits under the tab's newly assigned id. Their ids are new on
//! every run, so this mode is not repeat-safe: the caller runs it once per
//! group of stored edits and replaces those rows with the result at once.
//!
//! Each merge also names the blocks holding what it would hide: anything
//! the tab shows inside a block someone deleted (still a tombstone in the
//! current document, or collected there), text, attributes and embeds
//! alike. The tab keeps those blocks of its own document for copying.
//!
//! Every walk goes by ranges, so a struct claiming millions of deleted units
//! costs what its bytes cost. The browser runs this in a worker, compiled to
//! WASM on the server's own yrs (the fork's patched copy) by
//! `scripts/build-late-merge.mjs`.

mod place;
mod write;

#[cfg(target_arch = "wasm32")]
mod wasm;

use std::collections::{BTreeMap, HashSet};
use std::ops::Range;
use std::sync::Arc;

use yrs::block::{ClientID, ItemContent, ItemPtr};
use yrs::branch::{BranchID, BranchPtr};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ID, IdSet, ReadTxn, StateVector, Transact, Update};

/// Why a merge gave no update. The tab keeps its edits and says so.
#[derive(Debug, thiserror::Error)]
pub enum Refused {
    #[error("not a Yjs document: {0}")]
    Decode(String),
    /// The unsent edits name units neither document holds.
    #[error("the unsent edits need units neither document holds")]
    Unheld,
    /// The old document's edits are not what an editor writes.
    #[error("{0}")]
    Shape(&'static str),
}

/// A merge's update and the blocks holding what it would hide.
#[derive(Debug)]
pub struct Merged {
    /// One v1 update: apply it to the current document and send it.
    pub update: Vec<u8>,
    /// The top-level blocks of the tab's document (their item ids, each
    /// once, in id order) holding something the tab shows that the merged
    /// document does not: it sits in a block someone deleted (placed into
    /// the tombstone, or left out where the block was collected).
    pub hidden: Vec<ID>,
    /// Values [merge_keyed] left out because the current document collected
    /// their key's last value, each with the values below it that the tab
    /// wrote: what the tab pastes again under fresh keys, in this order.
    pub rekeyed: Vec<Rekey>,
}

/// A value the keyed merge left out: written again with no origin it might
/// be lost on a replica still holding the key's last value, so the tab
/// writes it again under a fresh key (Epo 2026-10-29, the re-key design).
#[derive(Clone, Debug, PartialEq)]
pub struct Rekey {
    /// Its key (the block id).
    pub key: String,
    /// Its value's item in the tab's document.
    pub item: ID,
    /// The value whose children list it, and the key listed just before it
    /// there (None: first), as the tab's document had them; None when no
    /// value lists it.
    pub parent: Option<String>,
    pub left: Option<String>,
    /// The keys below it, depth first, whose values the tab wrote and the
    /// merge left out with it.
    pub subtree: Vec<String>,
}

/// The tab's unsent edits as one v1 update against `current`, under their
/// own ids. `old`: the tab's document as a v1 state; `current`: the room's
/// document as fetched, a v1 state. What `current` holds is what the room
/// acknowledged: the collection keeps every client's clock.
pub fn merge(old: &[u8], current: &[u8]) -> Result<Merged, Refused> {
    unsent(old, current, None, None)
}

/// A map whose keys are never set again by a replica lacking the key's
/// last value (`ydoc::gc::UniqueKeys`): the map's root name (None for a
/// nested map) and the key.
pub type UniqueKeys<'a> = &'a dyn Fn(Option<&str>, &str) -> bool;

/// A layout's keyed values: which keys never repeat, and the key under
/// which a value lists its children (an array of keys). The blocks
/// layout's is [BLOCKS].
#[derive(Clone, Copy)]
pub struct Keyed<'a> {
    pub unique: UniqueKeys<'a>,
    pub children: &'a str,
}

/// The blocks layout: block ids in the `blocks` root, children listed in
/// `sys:children` (`blocks::unique_key`).
pub const BLOCKS: Keyed<'static> = Keyed {
    unique: &blocks_key,
    children: "sys:children",
};

fn blocks_key(root: Option<&str>, _key: &str) -> bool {
    root == Some("blocks")
}

/// [merge], where a value for a `unique` key whose last value the current
/// document collected is left out with the values below it that the tab
/// wrote, and reported in [Merged::rekeyed] for the tab to write again
/// under fresh keys: written with no origin, a replica still holding that
/// value would order it by client id and might lose it. What else sat in
/// it (typing into a block someone deleted) stays hidden.
pub fn merge_keyed(old: &[u8], current: &[u8], keyed: &Keyed<'_>) -> Result<Merged, Refused> {
    unsent(old, current, None, Some(keyed))
}

/// `merge`, with every unsent unit written as a new one under `author` (the
/// tab's newly assigned client id), from the first clock `current` lacks
/// for it. Not repeat-safe: a second run writes the edits again.
pub fn reauthor(old: &[u8], current: &[u8], author: u64) -> Result<Merged, Refused> {
    unsent(old, current, Some(ClientID::new(author)), None)
}

/// [reauthor] with [merge_keyed]'s rule.
pub fn reauthor_keyed(
    old: &[u8],
    current: &[u8],
    author: u64,
    keyed: &Keyed<'_>,
) -> Result<Merged, Refused> {
    unsent(old, current, Some(ClientID::new(author)), Some(keyed))
}

fn unsent(
    old: &[u8],
    current: &[u8],
    author: Option<ClientID>,
    keyed: Option<&Keyed<'_>>,
) -> Result<Merged, Refused> {
    let (old, current) = (load(old)?, load(current)?);
    let held = current.transact().state_vector();
    let update = old.transact().encode_state_as_update_v1(&held);
    let own = Own::of(&old, &held);
    let view = view(&old, &current);
    let txn = old.transact();
    // The top-level block a unit of the tab's document sits in (itself, for
    // a block).
    let block_of = |id: &ID| -> Option<ID> {
        let mut item = txn.store().get_item(id)?;
        while let Some(parent) = item.parent_branch()?.item() {
            item = parent;
        }
        Some(*item.id())
    };
    let (left_out, rekeyed) = match keyed {
        Some(keyed) => rekeys(&old, &current, &view, &held, keyed),
        None => (HashSet::new(), Vec::new()),
    };
    let mut merged =
        place::stable_left(&update, &current, &view, &own, author, &block_of, &left_out)?;
    merged.rekeyed = rekeyed;
    Ok(merged)
}

/// The values [merge_keyed] leaves out (their item ids) and what it reports
/// of them. A value is left out when its key is unique, the tab wrote it
/// over a value the current document collected (the nearest value behind it
/// the room had), and the current document has no value for the key; the
/// values below it (by `keyed.children`, in the tab's document) that the tab
/// wrote go with it.
fn rekeys(
    old: &Doc,
    current: &Doc,
    view: &View,
    held: &StateVector,
    keyed: &Keyed<'_>,
) -> (HashSet<ID>, Vec<Rekey>) {
    let txn = old.transact();
    let unsent = |id: &ID| id.clock >= held.get(&id.client);
    let mut roots: Vec<String> = txn.root_refs().map(|(name, _)| name.to_string()).collect();
    roots.sort();
    let mut left_out = HashSet::new();
    let mut reports = Vec::new();
    for root in roots {
        let Some(branch) = BranchID::get_root(&txn, root.as_str()) else {
            continue;
        };
        // Each live value's item and its children's keys.
        let mut values: BTreeMap<String, (ItemPtr, Vec<String>)> = BTreeMap::new();
        for (key, item) in branch.map_items() {
            if item.is_deleted() || !(keyed.unique)(Some(root.as_str()), key) {
                continue;
            }
            values.insert(key.to_string(), (item, children(item, keyed.children)));
        }
        let parent = ParentRef::Root(Arc::from(root.as_str()));
        let dropped: Vec<String> = values
            .iter()
            .filter(|(key, (item, _))| {
                if !unsent(item.id()) {
                    return false;
                }
                // The nearest value behind it the room had.
                let mut behind = item.left();
                while let Some(b) = behind.filter(|b| unsent(b.id())) {
                    behind = b.left();
                }
                behind.is_some_and(|b| view.is_removed(b.id()))
                    && current_head(&current.transact(), &parent, &Arc::from(key.as_str()))
                        .is_none()
            })
            .map(|(key, _)| key.clone())
            .collect();
        let mut below_another = HashSet::new();
        let mut found = Vec::new();
        for key in &dropped {
            let mut subtree = Vec::new();
            let mut stack: Vec<String> = values[key].1.iter().rev().cloned().collect();
            while let Some(child) = stack.pop() {
                let Some((item, kids)) = values.get(&child) else {
                    continue;
                };
                if !unsent(item.id()) || subtree.contains(&child) {
                    continue;
                }
                subtree.push(child.clone());
                stack.extend(kids.iter().rev().cloned());
            }
            below_another.extend(subtree.iter().cloned());
            found.push((key.clone(), subtree));
        }
        for (key, subtree) in found {
            for id in std::iter::once(&key).chain(&subtree) {
                left_out.insert(*values[id].0.id());
            }
            if below_another.contains(&key) {
                continue;
            }
            let listing = values
                .iter()
                .find(|(_, (_, kids))| kids.contains(&key))
                .map(|(p, (_, kids))| (p.clone(), kids.clone()));
            let (parent, left) = match listing {
                Some((p, kids)) => {
                    let at = kids.iter().position(|k| *k == key).unwrap_or(0);
                    (Some(p), at.checked_sub(1).map(|i| kids[i].clone()))
                }
                None => (None, None),
            };
            reports.push(Rekey {
                key: key.clone(),
                item: *values[&key].0.id(),
                parent,
                left,
                subtree,
            });
        }
    }
    (left_out, reports)
}

/// The keys a value lists in its `children` array, live entries in order.
fn children(item: ItemPtr, children: &str) -> Vec<String> {
    let ItemContent::Type(inner) = item.content() else {
        return Vec::new();
    };
    let branch = BranchPtr::from(inner.as_ref());
    let Some((_, array)) = branch.map_items().find(|(k, _)| k.as_ref() == children) else {
        return Vec::new();
    };
    let ItemContent::Type(list) = array.content() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut next = BranchPtr::from(list.as_ref()).start();
    while let Some(entry) = next {
        if !entry.is_deleted()
            && let ItemContent::Any(values) = entry.content()
        {
            for value in values {
                if let yrs::Any::String(key) = value {
                    out.push(key.to_string());
                }
            }
        }
        next = entry.right();
    }
    out
}

/// A working document holding `state` (no local writes go into it).
fn load(state: &[u8]) -> Result<Doc, Refused> {
    let doc = Doc::new();
    let update = Update::decode_v1(state).map_err(|error| Refused::Decode(error.to_string()))?;
    doc.transact_mut()
        .apply_update(update)
        .map_err(|error| Refused::Decode(error.to_string()))?;
    Ok(doc)
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum ParentRef {
    Root(Arc<str>),
    Item(ID),
}

fn parent_ref(branch: BranchPtr) -> ParentRef {
    match branch.id() {
        BranchID::Root(name) => ParentRef::Root(name),
        BranchID::Nested(id) => ParentRef::Item(id),
    }
}

/// Where a unit the current document no longer holds sat in the old one.
#[derive(Clone, Debug)]
struct Redirect {
    /// A list's nearest held unit on the left (none at the list start); a
    /// map value's key's current value.
    left: Option<ID>,
    parent: ParentRef,
    /// The key, for a map value.
    key: Option<Arc<str>>,
}

/// The tab's view of what the current document dropped (collected).
struct View {
    /// Units below both documents' clocks that the current document holds as
    /// GC.
    removed: IdSet,
    /// Removed units that sat in a list or a key's chain the old document
    /// places: range start -> (length, redirect). Children of a removed type
    /// have no place.
    redirects: BTreeMap<(u64, u32), (u32, Redirect)>,
}

impl View {
    fn redirect(&self, id: &ID) -> Option<&Redirect> {
        let (&(client, start), (len, redirect)) = self
            .redirects
            .range(..=(id.client.get(), id.clock))
            .next_back()?;
        (client == id.client.get() && id.clock < start + len).then_some(redirect)
    }

    fn is_removed(&self, id: &ID) -> bool {
        self.removed.contains(id)
    }
}

/// Builds the view from the tab's own two documents: each unit the room had
/// that the current document no longer holds maps to its nearest held unit
/// on the left in the old document's list (and a map value to its key's
/// current value). No server map is needed: text the tab never saw is a tie.
fn view(old: &Doc, current: &Doc) -> View {
    let ntxn = current.transact();
    let nsv = ntxn.state_vector();
    let otxn = old.transact();
    let osv = otxn.state_vector();
    let mut removed = IdSet::new();
    for (c, k) in osv.iter() {
        let upto = nsv.get(c).min(*k);
        if upto == 0 {
            continue;
        }
        for (range, item) in ntxn.store().blocks_in(c, 0..upto) {
            let end = (range.clock + range.len).min(upto);
            if item.is_none() && range.clock < end {
                removed.insert(ID::new(*c, range.clock), end - range.clock);
            }
        }
    }
    let mut redirects: BTreeMap<(u64, u32), (u32, Redirect)> = BTreeMap::new();
    let mut roots: Vec<String> = otxn.root_refs().map(|(name, _)| name.to_string()).collect();
    roots.sort();
    let mut stack: Vec<BranchPtr> = roots
        .iter()
        .filter_map(|name| BranchID::get_root(&otxn, name.as_str()))
        .collect();
    while let Some(branch) = stack.pop() {
        let parent = parent_ref(branch);
        // A list whose parent the current document dropped has no place.
        if let ParentRef::Item(p) = &parent
            && removed.contains(p)
        {
            continue;
        }
        let mut items: Vec<ItemPtr> = Vec::new();
        let mut next = branch.start();
        while let Some(item) = next {
            items.push(item);
            if let ItemContent::Type(inner) = item.content() {
                stack.push(BranchPtr::from(inner.as_ref()));
            }
            next = item.right();
        }
        // The nearest held unit on the left, as the walk goes: each item's
        // ranges are held (an item in the current document), removed (GC
        // there) or new (past its clock).
        let mut left = None;
        for item in &items {
            let (c, k) = (item.id().client, item.id().clock);
            let end = (k + item.len()).min(nsv.get(&c));
            if k >= end {
                continue;
            }
            for (range, block) in ntxn.store().blocks_in(&c, k..end) {
                let from = range.clock.max(k);
                let to = (range.clock + range.len).min(end);
                if from >= to {
                    continue;
                }
                if block.is_some() {
                    left = Some(ID::new(c, to - 1));
                } else {
                    let redirect = Redirect {
                        left,
                        parent: parent.clone(),
                        key: None,
                    };
                    redirects.insert((c.get(), from), (to - from, redirect));
                }
            }
        }
        for (key, current) in branch.map_items() {
            let head = current_head(&ntxn, &parent, key);
            let mut cur = Some(current);
            while let Some(item) = cur {
                if let ItemContent::Type(inner) = item.content() {
                    stack.push(BranchPtr::from(inner.as_ref()));
                }
                if removed.contains(item.id()) {
                    let redirect = Redirect {
                        left: head,
                        parent: parent.clone(),
                        key: Some(key.clone()),
                    };
                    redirects.insert(
                        (item.id().client.get(), item.id().clock),
                        (item.len(), redirect),
                    );
                }
                cur = item.left();
            }
        }
    }
    View { removed, redirects }
}

/// The key's value in the current document, if it holds the parent.
fn current_head(txn: &impl ReadTxn, parent: &ParentRef, key: &Arc<str>) -> Option<ID> {
    let branch = match parent {
        ParentRef::Root(name) => BranchID::get_root(txn, name.as_ref())?,
        ParentRef::Item(id) => {
            if id.clock >= txn.state_vector().get(&id.client) {
                return None;
            }
            let item = txn
                .store()
                .blocks_in(&id.client, id.clock..id.clock + 1)
                .next()?
                .1?;
            match item.content() {
                ItemContent::Type(inner) => BranchPtr::from(inner.as_ref()),
                _ => return None,
            }
        }
    };
    branch
        .map_items()
        .find(|(k, _)| *k == key)
        .map(|(_, item)| item.last_id())
}

/// The sender's own order of its unsent list units: per list, the runs of
/// units the current document lacks, in document order. A run's first unit
/// has the previous run's last unit on its left (none at the list's head);
/// every other unit has the unit before it. Map values are in no run.
struct Own {
    /// Run start -> (length, the first unit's left, the run's place in the
    /// walk).
    runs: BTreeMap<(u64, u32), (u32, Option<ID>, usize)>,
}

impl Own {
    fn of(doc: &Doc, held: &StateVector) -> Own {
        let txn = doc.transact();
        let mut runs = BTreeMap::new();
        let mut stack: Vec<BranchPtr> = txn
            .root_refs()
            .filter_map(|(name, _)| BranchID::get_root(&txn, name))
            .collect();
        while let Some(branch) = stack.pop() {
            let mut last: Option<ID> = None;
            let mut next = branch.start();
            while let Some(item) = next {
                next = item.right();
                let (c, k, n) = (item.id().client, item.id().clock, item.len());
                let from = held.get(&c).max(k);
                if from < k + n {
                    let place = runs.len();
                    runs.insert((c.get(), from), (k + n - from, last, place));
                    last = Some(ID::new(c, k + n - 1));
                }
                if let ItemContent::Type(inner) = item.content() {
                    stack.push(BranchPtr::from(inner.as_ref()));
                }
            }
            for (_, item) in branch.map_items() {
                if let ItemContent::Type(inner) = item.content() {
                    stack.push(BranchPtr::from(inner.as_ref()));
                }
            }
        }
        Own { runs }
    }

    /// Clocks of `client` in `clocks` whose left is not the unit before.
    fn breaks(&self, client: ClientID, clocks: Range<u32>) -> Vec<u32> {
        self.runs
            .range((client.get(), clocks.start)..(client.get(), clocks.end))
            .filter(|&(&(_, start), &(_, left, _))| {
                start == 0 || left != Some(ID::new(client, start - 1))
            })
            .map(|(&(_, start), _)| start)
            .collect()
    }

    /// A unit's place in the sender's document order, comparable within one
    /// list: (its run's place in the walk, its offset in the run).
    fn order(&self, id: &ID) -> Option<(usize, u32)> {
        let (&(client, start), &(len, _, place)) = self
            .runs
            .range(..=(id.client.get(), id.clock))
            .next_back()?;
        (client == id.client.get() && id.clock < start + len).then_some((place, id.clock - start))
    }
}
