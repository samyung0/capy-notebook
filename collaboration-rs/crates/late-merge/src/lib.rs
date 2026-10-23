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
//! The browser runs this in a worker, compiled to WASM on the server's own
//! yrs (the fork's patched copy) by `scripts/build-late-merge.mjs`.

mod place;
mod write;

#[cfg(target_arch = "wasm32")]
mod wasm;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use yrs::block::{ClientID, ItemContent, ItemPtr};
use yrs::branch::{BranchID, BranchPtr};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ID, IdSet, ReadTxn, StateVector, Transact, Update};

/// Why a merge gave no update. The tab keeps its edits and says so.
#[derive(Debug, thiserror::Error)]
pub enum Refused {
    #[error("not a Yjs document or state vector: {0}")]
    Decode(String),
    /// The unsent edits name units neither document holds.
    #[error("the unsent edits need units neither document holds")]
    Unheld,
    /// The old document's edits are not what an editor writes.
    #[error("{0}")]
    Shape(&'static str),
}

/// The tab's unsent edits as one v1 update against `current`. `old`: the
/// tab's document as a v1 state; `base`: the encoded state vector it knows
/// the room acknowledged (empty for none); `current`: the room's document as
/// fetched, a v1 state.
pub fn merge(old: &[u8], base: &[u8], current: &[u8]) -> Result<Vec<u8>, Refused> {
    let base = if base.is_empty() {
        StateVector::default()
    } else {
        StateVector::decode_v1(base).map_err(|error| Refused::Decode(error.to_string()))?
    };
    merge_unsent(&load(old)?, &base, &load(current)?)
}

/// `merge` over loaded documents.
pub fn merge_unsent(old: &Doc, base: &StateVector, current: &Doc) -> Result<Vec<u8>, Refused> {
    // The room acknowledged at least what it holds now. The collection keeps
    // every client's clock, so its state vector covers the rest too.
    let mut base = base.clone();
    base.merge(current.transact().state_vector());
    let update = old.transact().encode_state_as_update_v1(&base);
    let own = own_left(old, &base);
    let view = view(old, &base, current);
    place::stable_left(&update, current, &view, &own)
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
    /// Units the room had (below the base) that the current document does
    /// not hold as items.
    removed: IdSet,
    /// Removed units that sat in a list or a key's chain the old document
    /// places: block start -> (length, redirect). Children of a removed type
    /// have no place.
    redirects: BTreeMap<(u64, u32), (u32, Redirect)>,
    /// Clients the current document lacks altogether, with the clock the
    /// room had.
    dropped: HashMap<ClientID, u32>,
}

impl View {
    /// Where an update's section for `client` starts: 0 for a dropped one.
    fn held_from(&self, client: &ClientID) -> Option<u32> {
        self.dropped.get(client).map(|_| 0)
    }

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
fn view(old: &Doc, base: &StateVector, current: &Doc) -> View {
    let ntxn = current.transact();
    let nsv = ntxn.state_vector();
    let held = |id: &ID| -> bool {
        id.clock < nsv.get(&id.client)
            && ntxn
                .store()
                .blocks_in(&id.client, id.clock..id.clock + 1)
                .next()
                .and_then(|(_, item)| item)
                .is_some()
    };
    let otxn = old.transact();
    let osv = otxn.state_vector();
    let mut removed = IdSet::new();
    let mut dropped: HashMap<ClientID, u32> = HashMap::new();
    for (c, k) in osv.iter() {
        let upto = base.get(c).min(*k);
        if upto > 0 && !nsv.contains_client(c) {
            dropped.insert(*c, upto);
        }
        for clock in 0..upto {
            let u = ID::new(*c, clock);
            if !held(&u) {
                removed.insert(u, 1);
            }
        }
    }
    let gone = |u: &ID| removed.contains(u);
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
            && gone(p)
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
        // The nearest held unit on the left, as the walk goes.
        let mut left = None;
        for item in &items {
            for offset in 0..item.len() {
                let u = ID::new(item.id().client, item.id().clock + offset);
                if held(&u) {
                    left = Some(u);
                } else if gone(&u) {
                    let redirect = Redirect {
                        left,
                        parent: parent.clone(),
                        key: None,
                    };
                    redirects.insert((u.client.get(), u.clock), (1, redirect));
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
                if gone(item.id()) {
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
    View {
        removed,
        redirects,
        dropped,
    }
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

/// The sender's own-left map: for every unit of `doc` that `base` lacks
/// (the unsent edits), the nearest such unit to its left in the same list,
/// none at the head. Map values get no entry.
fn own_left(doc: &Doc, base: &StateVector) -> HashMap<ID, Option<ID>> {
    let txn = doc.transact();
    let mut out = HashMap::new();
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
            for clock in base.get(&c).max(k)..k + n {
                let unit = ID::new(c, clock);
                out.insert(unit, last);
                last = Some(unit);
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
    out
}
