//! The placement work an update would cost yrs (Epo, 2026-10-08): how far
//! each new item's integration scans (YATA's conflict scan between its origin
//! and right origin, past the room's items and the update's earlier ones, and
//! the walk to the first value of a map key). The check replays yrs's
//! integration over a light overlay of the room's sequences, in yrs's own
//! order, counting the steps yrs takes, and stops as soon as the total passes
//! the budget: O(update + budget) whatever the update.
//!
//! Mirrors yrs `Update::integrate` (`BlockPicker` order, `missing_dependency`,
//! the origin and parent repair), `TransactionMut::integrate_item` and
//! `Item::resolve_conflict` (`third_party/yrs/src/update.rs`, `block.rs`).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use yrs::block::{ClientID, Item, ItemContent, ItemPtr, UpdateParent};
use yrs::branch::BranchPtr;
use yrs::{BranchID, ID, ReadTxn, UpdateBlock};

use crate::Incoming;

/// The placement steps one update may cost (Epo, 2026-10-08).
pub const MAX_PLACEMENT_STEPS: u64 = 100_000;

/// A sequence or map: the room's (its branch), one the update creates (the
/// id of the item holding it), or a root the room does not hold yet.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Parent {
    Room(BranchPtr),
    New(ID),
    NewRoot(usize),
}

/// What the overlay knows of a placed new item (keyed by its first unit as
/// the update names it).
struct Placed {
    /// The first unit placed (later than the item's own when the room held
    /// its start already).
    from: u32,
    len: u32,
    origin: Option<ID>,
    right_origin: Option<ID>,
    parent: Parent,
    parent_sub: Option<Arc<str>>,
}

#[derive(Clone, Copy)]
enum Owner {
    Room(ItemPtr),
    /// The update's item (its own id).
    New(ID),
}

/// A piece of an owner: the id of its first unit.
type Key = ID;

/// A piece's origin, right origin, parent and map key.
struct Links {
    origin: Option<ID>,
    right_origin: Option<ID>,
    parent: Parent,
    parent_sub: Option<Arc<str>>,
}

/// The budget was passed.
pub(crate) struct Over;

struct Sim<'a, T: ReadTxn> {
    txn: &'a T,
    incoming: &'a Incoming<'a>,
    state: yrs::StateVector,
    clocks: HashMap<ClientID, u32>,
    placed: HashMap<ID, Placed>,
    /// Split clocks inside each owner, by the owner's first unit.
    splits: HashMap<ID, Vec<u32>>,
    right: HashMap<Key, Option<Key>>,
    left: HashMap<Key, Option<Key>>,
    starts: HashMap<Parent, Option<Key>>,
    entries: HashMap<(Parent, Arc<str>), Option<Key>>,
    roots: HashMap<Arc<str>, usize>,
    steps: u64,
    budget: u64,
}

impl<T: ReadTxn> Sim<'_, T> {
    fn held(&self, id: &ID) -> bool {
        id.clock < self.state.get(&id.client)
    }

    fn clock(&self, client: &ClientID) -> u32 {
        self.clocks
            .get(client)
            .copied()
            .unwrap_or_else(|| self.state.get(client))
    }

    /// yrs's `is_missing`: a unit neither the room nor the overlay holds.
    fn missing(&self, id: &ID) -> bool {
        id.clock >= self.clock(&id.client)
    }

    /// The owner of `id`, its first unit and length.
    fn owner(&self, id: &ID) -> Option<(Owner, ID, u32)> {
        if self.held(id) {
            let item = self.txn.store().get_item(id)?;
            return Some((Owner::Room(item), *item.id(), item.len()));
        }
        let item = self.incoming.item_at(id)?;
        let placed = self.placed.get(item.id())?;
        (id.clock >= placed.from).then(|| {
            (
                Owner::New(*item.id()),
                ID::new(id.client, placed.from),
                placed.len,
            )
        })
    }

    /// The piece of an owner holding `clock`, and where that piece ends.
    fn piece(&self, start: ID, len: u32, clock: u32) -> (Key, u32) {
        let (mut from, mut to) = (start.clock, start.clock + len);
        for &split in self.splits.get(&start).into_iter().flatten() {
            if split <= clock {
                from = from.max(split);
            } else {
                to = to.min(split);
            }
        }
        (ID::new(start.client, from), to)
    }

    fn last_piece(&self, item: &ItemPtr) -> Key {
        let start = *item.id();
        let last = self
            .splits
            .get(&start)
            .and_then(|splits| splits.iter().max().copied())
            .unwrap_or(start.clock);
        ID::new(start.client, last)
    }

    fn right_of(&self, key: &Key) -> Option<Key> {
        if let Some(right) = self.right.get(key) {
            return *right;
        }
        let (owner, start, len) = self.owner(key)?;
        let (_, end) = self.piece(start, len, key.clock);
        if end < start.clock + len {
            return Some(ID::new(start.client, end));
        }
        match owner {
            Owner::Room(item) => item.right().map(|next| *next.id()),
            Owner::New(_) => None,
        }
    }

    fn left_of(&self, key: &Key) -> Option<Key> {
        if let Some(left) = self.left.get(key) {
            return *left;
        }
        let (owner, start, len) = self.owner(key)?;
        if key.clock > start.clock {
            return Some(self.piece(start, len, key.clock - 1).0);
        }
        match owner {
            Owner::Room(item) => item.left().map(|prev| self.last_piece(&prev)),
            Owner::New(_) => None,
        }
    }

    /// A piece's origin, right origin, parent and map key (a split piece's
    /// origin is the unit before it, as yrs's splice sets it).
    fn links(&self, key: &Key) -> Option<Links> {
        let (owner, start, _) = self.owner(key)?;
        let split = key.clock > start.clock;
        let first = |origin: Option<ID>| {
            if split {
                Some(ID::new(key.client, key.clock - 1))
            } else {
                origin
            }
        };
        match owner {
            Owner::Room(item) => Some(Links {
                origin: first(item.origin().copied()),
                right_origin: item.right_origin().copied(),
                parent: Parent::Room(item.parent_branch()?),
                parent_sub: item.parent_sub().cloned(),
            }),
            Owner::New(id) => {
                let placed = self.placed.get(&id)?;
                Some(Links {
                    origin: first(placed.origin),
                    right_origin: placed.right_origin,
                    parent: placed.parent,
                    parent_sub: placed.parent_sub.clone(),
                })
            }
        }
    }

    fn split_at(&mut self, start: ID, piece: Key, at: u32) -> Key {
        let tail = ID::new(start.client, at);
        let old_right = self.right_of(&piece);
        self.splits.entry(start).or_default().push(at);
        self.right.insert(piece, Some(tail));
        self.left.insert(tail, Some(piece));
        self.right.insert(tail, old_right);
        if let Some(right) = old_right {
            self.left.insert(right, Some(tail));
        }
        tail
    }

    /// `get_item_clean_end`: the piece ending at `id` (none for a collected
    /// unit).
    fn clean_end(&mut self, id: &ID) -> Option<Key> {
        let (_, start, len) = self.owner(id)?;
        let (piece, end) = self.piece(start, len, id.clock);
        if id.clock + 1 < end {
            self.split_at(start, piece, id.clock + 1);
        }
        Some(piece)
    }

    /// `get_item_clean_start`: the piece starting at `id`.
    fn clean_start(&mut self, id: &ID) -> Option<Key> {
        let (_, start, len) = self.owner(id)?;
        let (piece, _) = self.piece(start, len, id.clock);
        if id.clock > piece.clock {
            return Some(self.split_at(start, piece, id.clock));
        }
        Some(piece)
    }

    fn start_of(&self, parent: Parent) -> Option<Key> {
        if let Some(start) = self.starts.get(&parent) {
            return *start;
        }
        match parent {
            Parent::Room(branch) => branch.start().map(|item| *item.id()),
            _ => None,
        }
    }

    fn entry(&self, parent: Parent, key: &Arc<str>) -> Option<Key> {
        if let Some(entry) = self.entries.get(&(parent, key.clone())) {
            return *entry;
        }
        match parent {
            Parent::Room(branch) => branch.entry_item(key).map(|item| self.last_piece(&item)),
            _ => None,
        }
    }

    fn step(&mut self) -> Result<(), Over> {
        self.steps += 1;
        if self.steps > self.budget {
            Err(Over)
        } else {
            Ok(())
        }
    }

    /// The first value of a map key, walking left from its current one, a
    /// step per value (yrs walks it in `resolve_conflict` and again when it
    /// links an entry without a left neighbour).
    fn leftmost(&mut self, parent: Parent, key: &Arc<str>) -> Result<Option<Key>, Over> {
        let mut current = self.entry(parent, key);
        while let Some(at) = current {
            let Some(left) = self.left_of(&at) else {
                break;
            };
            self.step()?;
            current = Some(left);
        }
        Ok(current)
    }

    /// The type a parent id names (none when collected: yrs places the
    /// struct as GC).
    fn parent_of_id(&self, id: &ID) -> Option<Parent> {
        if self.held(id) {
            let item = self.txn.store().get_item(id)?;
            return match item.content() {
                ItemContent::Type(branch) => Some(Parent::Room(BranchPtr::from(&**branch))),
                _ => None,
            };
        }
        match self.owner(id)? {
            (Owner::New(item), _, _) => Some(Parent::New(item)),
            (Owner::Room(_), _, _) => None,
        }
    }

    /// One new item through yrs's repair, conflict scan and linking.
    fn integrate(&mut self, item: &Item) -> Result<(), Over> {
        let id = *item.id();
        let mut origin = item.origin().copied();
        let mut len = item.len();
        let mut key = id;
        // A struct partly placed already is trimmed, as yrs trims it.
        let placed_to = self.clock(&id.client);
        if placed_to > id.clock {
            let offset = placed_to - id.clock;
            if offset >= len {
                return Ok(());
            }
            key = ID::new(id.client, placed_to);
            len -= offset;
            origin = Some(ID::new(id.client, placed_to - 1));
        }
        let right_origin = item.right_origin().copied();
        let left = origin.and_then(|origin| self.clean_end(&origin));
        let right = right_origin.and_then(|right| self.clean_start(&right));
        let (parent, mut parent_sub) = match item.update_parent() {
            UpdateParent::Root(name) => {
                let parent = match BranchID::get_root(self.txn, &**name) {
                    Some(branch) => Parent::Room(branch),
                    None => {
                        let next = self.roots.len();
                        Parent::NewRoot(*self.roots.entry(name.clone()).or_insert(next))
                    }
                };
                (Some(parent), item.parent_sub().cloned())
            }
            UpdateParent::Item(parent) => (self.parent_of_id(parent), item.parent_sub().cloned()),
            UpdateParent::Branch(branch) => {
                (Some(Parent::Room(branch)), item.parent_sub().cloned())
            }
            UpdateParent::Unknown => {
                let from_left = left.and_then(|left| self.links(&left));
                let from_right = right.and_then(|right| self.links(&right));
                match from_left.or(from_right) {
                    Some(links) => (Some(links.parent), links.parent_sub),
                    None => (None, None),
                }
            }
        };
        let placed_end = id.clock + item.len();
        let Some(parent) = parent else {
            // A parent yrs cannot place: the struct becomes GC, no scan.
            self.clocks.insert(id.client, placed_end);
            return Ok(());
        };
        // integrate_item takes the key from a neighbour first.
        let neighbour_sub = left
            .and_then(|left| self.links(&left))
            .and_then(|links| links.parent_sub)
            .or_else(|| {
                right
                    .and_then(|right| self.links(&right))
                    .and_then(|links| links.parent_sub)
            });
        if neighbour_sub.is_some() {
            parent_sub = neighbour_sub;
        }

        // detect_conflict, resolve_conflict.
        let conflict = match (&left, &right) {
            (None, None) => true,
            (None, Some(right)) => self.left_of(right).is_some(),
            (Some(left), _) => self.right_of(left) != right,
        };
        let mut new_left = left;
        if conflict {
            let mut o = match (&left, &parent_sub) {
                (Some(left), _) => self.right_of(left),
                (None, Some(sub)) => self.leftmost(parent, sub)?,
                (None, None) => self.start_of(parent),
            };
            let mut conflicting: HashSet<Key> = HashSet::new();
            let mut before_origin: HashSet<Key> = HashSet::new();
            while let Some(at) = o {
                if right == Some(at) {
                    break;
                }
                self.step()?;
                before_origin.insert(at);
                conflicting.insert(at);
                let Some(Links {
                    origin: at_origin,
                    right_origin: at_right_origin,
                    ..
                }) = self.links(&at)
                else {
                    break;
                };
                if origin == at_origin {
                    if at.client < id.client {
                        new_left = Some(at);
                        conflicting.clear();
                    } else if right_origin == at_right_origin {
                        break;
                    }
                } else if let Some(origin_left) = at_origin.and_then(|origin| {
                    self.owner(&origin)
                        .map(|(_, start, len)| self.piece(start, len, origin.clock).0)
                }) {
                    if before_origin.contains(&origin_left) {
                        if !conflicting.contains(&origin_left) {
                            new_left = Some(at);
                            conflicting.clear();
                        }
                    } else {
                        break;
                    }
                } else {
                    break;
                }
                o = self.right_of(&at);
            }
        }

        // Link the new piece in, as integrate_item does.
        let new_right = match (&new_left, &parent_sub) {
            (Some(left), _) => {
                let right = self.right_of(left);
                self.right.insert(*left, Some(key));
                right
            }
            (None, Some(sub)) => self.leftmost(parent, sub)?,
            (None, None) => {
                let right = self.start_of(parent);
                self.starts.insert(parent, Some(key));
                right
            }
        };
        self.left.insert(key, new_left);
        self.right.insert(key, new_right);
        match (&new_right, &parent_sub) {
            (Some(right), _) => {
                self.left.insert(*right, Some(key));
            }
            (None, Some(sub)) => {
                self.entries.insert((parent, sub.clone()), Some(key));
            }
            (None, None) => {}
        }
        self.placed.insert(
            id,
            Placed {
                from: key.clock,
                len,
                origin,
                right_origin,
                parent,
                parent_sub,
            },
        );
        self.clocks.insert(id.client, placed_end);
        Ok(())
    }

    /// yrs's `missing_dependency`: the client of a reference not placed yet.
    fn missing_dependency(&self, item: &Item) -> Option<ClientID> {
        let parent = match item.update_parent() {
            UpdateParent::Item(parent) => Some(*parent),
            _ => None,
        };
        [item.origin().copied(), item.right_origin().copied(), parent]
            .into_iter()
            .flatten()
            .find(|id| self.missing(id))
            .map(|id| id.client)
    }
}

/// yrs's `BlockPicker` over the update's structs.
struct Picker<'a> {
    queues: HashMap<ClientID, VecDeque<UpdateBlock<'a>>>,
    clients: Vec<ClientID>,
    latest: VecDeque<UpdateBlock<'a>>,
    stack: Vec<UpdateBlock<'a>>,
}

impl<'a> Picker<'a> {
    fn new(incoming: &'a Incoming<'a>) -> Self {
        let mut queues: HashMap<ClientID, VecDeque<UpdateBlock<'a>>> = HashMap::new();
        for block in incoming.update().blocks() {
            queues
                .entry(client_of(&block))
                .or_default()
                .push_back(block);
        }
        let mut clients: Vec<ClientID> = queues.keys().copied().collect();
        clients.sort();
        Picker {
            queues,
            clients,
            latest: VecDeque::new(),
            stack: Vec::new(),
        }
    }

    fn next(&mut self) -> Option<UpdateBlock<'a>> {
        if let Some(block) = self.stack.pop() {
            return Some(block);
        }
        loop {
            if let Some(block) = self.latest.pop_front() {
                return Some(block);
            }
            let client = self.clients.pop()?;
            self.latest = self.queues.remove(&client).unwrap_or_default();
        }
    }

    fn drop_stack(&mut self) {
        for waiting in self.stack.drain(..) {
            let client = client_of(&waiting);
            self.queues.remove(&client);
            if self.latest.front().is_some_and(|b| client_of(b) == client) {
                self.latest.clear();
            }
        }
    }
}

fn client_of(block: &UpdateBlock) -> ClientID {
    match block {
        UpdateBlock::Item(item) => item.id().client,
        UpdateBlock::Gc(range) | UpdateBlock::Skip(range) => range.client,
    }
}

/// The placement steps `incoming` costs on the room, or `Err` past `budget`.
/// Any update: a struct past a gap in its client is placed as yrs places it
/// (after a skip), and one waiting on a struct the update lacks stays pending.
pub(crate) fn placement_steps<T: ReadTxn>(
    txn: &T,
    incoming: &Incoming,
    budget: u64,
) -> Result<u64, Over> {
    let mut sim = Sim {
        txn,
        incoming,
        state: txn.state_vector(),
        clocks: HashMap::new(),
        placed: HashMap::new(),
        splits: HashMap::new(),
        right: HashMap::new(),
        left: HashMap::new(),
        starts: HashMap::new(),
        entries: HashMap::new(),
        roots: HashMap::new(),
        steps: 0,
        budget,
    };
    // BlockPicker: each client's structs in clock order, clients from the
    // highest id down, switching to the client whose struct a reference needs;
    // what waits on a struct the update lacks stays pending.
    let mut picker = Picker::new(incoming);
    let mut current = picker.next();
    while let Some(block) = current {
        if let UpdateBlock::Item(item) = block {
            if let Some(missing) = sim.missing_dependency(item) {
                picker.stack.push(block);
                let waiting = picker.stack.iter().any(|b| client_of(b) == missing);
                let dependency = if waiting {
                    None
                } else {
                    picker
                        .queues
                        .get_mut(&missing)
                        .and_then(|queue| queue.pop_front())
                };
                if dependency.is_some() {
                    current = dependency;
                    continue;
                }
                // Pending in yrs: the stack and the rest of its clients wait.
                picker.drop_stack();
            } else {
                sim.integrate(item)?;
            }
        } else if let UpdateBlock::Gc(range) = block {
            let end = range.clock + range.len;
            if end > sim.clock(&range.client) {
                sim.clocks.insert(range.client, end);
            }
        }
        current = picker.next();
    }
    Ok(sim.steps)
}
