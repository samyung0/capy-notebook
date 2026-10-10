//! Where each new struct of a writer's update lands in an item document: the
//! keys from the root down to its container, and its own key (a map entry)
//! or none (an item of a sequence, the characters of a text). The admit
//! checks every new struct's place against the document's shape.
//!
//! Cost: each struct resolves once, and each container's path once (both
//! memoized), every step counted (`ydoc::steps`). A struct that names no
//! parent takes its origin's (or right origin's) place, as Yjs does; a
//! pasted run chains each struct to the one before it, so the memo keeps
//! that linear.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use yrs::block::{Item, ItemContent, UpdateParent};
use yrs::branch::{BranchID, BranchPtr};
use yrs::{ID, ReadTxn, StateVector};

use ydoc::Incoming;
use ydoc::steps::{Walk, step};

/// A new struct's place: `path` is its container's keys from the root name
/// down; `key` is its own map key (none inside a sequence or text).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Place {
    At {
        path: Vec<Arc<str>>,
        key: Option<Arc<str>>,
    },
    /// Yjs drops it: its parent or a neighbour was garbage-collected.
    Gone,
    /// A place the shape never has (an item in a type's sequence that is not
    /// a text, a reference neither the room nor the update holds).
    Unknown,
}

/// The most types an update may create inside one another.
pub const MAX_NEW_DEPTH: usize = 16;

pub struct Locator<'a, T: ReadTxn> {
    txn: &'a T,
    incoming: &'a Incoming<'a>,
    state: StateVector,
    places: HashMap<ID, Place>,
    branches: HashMap<BranchID, Option<Vec<Arc<str>>>>,
}

impl<'a, T: ReadTxn> Locator<'a, T> {
    pub fn new(txn: &'a T, incoming: &'a Incoming<'a>) -> Self {
        Locator {
            txn,
            incoming,
            state: txn.state_vector(),
            places: HashMap::new(),
            branches: HashMap::new(),
        }
    }

    fn held(&self, id: &ID) -> bool {
        id.clock < self.state.get(&id.client)
    }

    /// The keys from the root to a type the room holds; none when a step on
    /// the way sits in a sequence (no shape nests a type there).
    fn branch_path(&mut self, branch: BranchPtr) -> Option<Vec<Arc<str>>> {
        let id = branch.id();
        if let Some(known) = self.branches.get(&id) {
            return known.clone();
        }
        let mut keys: Vec<Arc<str>> = Vec::new();
        let mut current = branch;
        let found = loop {
            step(Walk::Holders);
            match current.item() {
                None => match current.id() {
                    BranchID::Root(name) => {
                        keys.push(name);
                        keys.reverse();
                        break Some(keys);
                    }
                    BranchID::Nested(_) => break None,
                },
                Some(item) => {
                    let Some(key) = item.parent_sub().cloned() else {
                        break None;
                    };
                    keys.push(key);
                    match item.parent_branch() {
                        Some(parent) => current = parent,
                        None => break None,
                    }
                }
            }
        };
        self.branches.insert(id, found.clone());
        found
    }

    /// The place of a new struct of the update.
    pub fn place(&mut self, start: &'a Item) -> Place {
        self.place_at(start, 0)
    }

    /// `depth` counts the types the update creates around `start`: no shape
    /// nests deeper than [MAX_NEW_DEPTH], and a crafted chain of nested new
    /// types must not recurse past it.
    fn place_at(&mut self, start: &'a Item, depth: usize) -> Place {
        if depth > MAX_NEW_DEPTH {
            return Place::Unknown;
        }
        let mut chain: Vec<ID> = Vec::new();
        let mut seen: HashSet<ID> = HashSet::new();
        let mut item = start;
        let found = loop {
            step(Walk::Containers);
            if let Some(known) = self.places.get(item.id()) {
                break known.clone();
            }
            if !seen.insert(*item.id()) {
                break Place::Unknown;
            }
            chain.push(*item.id());
            // Yjs drops an item next to a garbage-collected struct.
            let sides = [item.origin(), item.right_origin()];
            if sides
                .iter()
                .flatten()
                .any(|id| self.held(id) && self.txn.store().get_item(id).is_none())
            {
                break Place::Gone;
            }
            let key = item.parent_sub().cloned();
            match item.update_parent() {
                UpdateParent::Root(name) => {
                    break Place::At {
                        path: vec![name.clone()],
                        key,
                    };
                }
                UpdateParent::Item(parent) => {
                    if self.held(parent) {
                        let Some(holder) = self.txn.store().get_item(parent) else {
                            break Place::Gone;
                        };
                        break match holder.content() {
                            ItemContent::Deleted(_) => Place::Gone,
                            ItemContent::Type(branch) => {
                                match self.branch_path(BranchPtr::from(branch.as_ref())) {
                                    Some(path) => Place::At { path, key },
                                    None => Place::Unknown,
                                }
                            }
                            _ => Place::Unknown,
                        };
                    }
                    let Some(holder) = self.incoming.item_at(parent) else {
                        break Place::Unknown;
                    };
                    if !matches!(holder.content(), ItemContent::Type(_)) {
                        break Place::Unknown;
                    }
                    // A type the update creates: its own place, then its key.
                    match self.place_at(holder, depth + 1) {
                        Place::At {
                            mut path,
                            key: Some(holder_key),
                        } => {
                            path.push(holder_key);
                            break Place::At { path, key };
                        }
                        Place::Gone => break Place::Gone,
                        _ => break Place::Unknown,
                    }
                }
                UpdateParent::Branch(_) => break Place::Unknown,
                UpdateParent::Unknown => {
                    let Some(&sibling) = item.origin().or(item.right_origin()) else {
                        break Place::Unknown;
                    };
                    if self.held(&sibling) {
                        let Some(held) = self.txn.store().get_item(&sibling) else {
                            break Place::Gone;
                        };
                        let Some(parent) = held.parent_branch() else {
                            break Place::Unknown;
                        };
                        break match self.branch_path(parent) {
                            Some(path) => Place::At {
                                path,
                                key: held.parent_sub().cloned(),
                            },
                            None => Place::Unknown,
                        };
                    }
                    match self.incoming.item_at(&sibling) {
                        Some(next) => item = next,
                        None => break Place::Unknown,
                    }
                }
            }
        };
        for id in chain {
            self.places.insert(id, found.clone());
        }
        found
    }
}
