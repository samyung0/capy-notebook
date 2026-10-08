//! The per-update growth bound (`materialUpdateGrowth`, capy-side/plate
//! `collaboration/src/limits.ts`): an upper bound on what one update adds to
//! the room's measured Plate value, read from the update's own structs
//! against the room, never a copy of it.
//!
//! What it relies on: a Plate leaf is a run of strings in one Y.XmlText with
//! no format item or embed between them (slate-yjs merges equal neighbours),
//! so deleting strings, embeds or attributes never grows the value; a string
//! typed next to a visible string joins that leaf and adds only its escaped
//! bytes; anything else that touches a text's formatting is bounded by
//! re-pricing that text's leaves at their largest possible attributes; a new
//! block is priced from its own structs.
//!
//! Cost: O(update) plus one walk of each text it re-prices. The delete set is
//! indexed once (sorted, merged ranges, binary search), and a text whose own
//! block or an ancestor is deleted (already, or by this update) is skipped: it
//! leaves the value, whatever the update writes into it (plate REVIEW1 M1, as
//! capy-side/plate 3ed9e16a fixed the JS bound).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use yrs::block::{Item, ItemContent, ItemPtr, UpdateParent};
use yrs::branch::{BranchID, BranchPtr};
use yrs::types::TypeRef;
use yrs::{Any, ID, ReadTxn, StateVector};

use crate::json;
use crate::limits::{DEPTH_CEILING, Metrics};
use crate::plate;
use ydoc::Incoming;
use ydoc::steps::step;

// JSON bytes an update can add on top of its own strings and attributes: a
// text leaf `{"text":""}` and a block `{"children":[]}`, each with its comma;
// and the split of a surrogate pair at an inserted item's two sides, which
// turns each half into U+FFFD (4 bytes become 6 per side).
const LEAF_BYTES: u64 = 12;
const ELEMENT_BYTES: u64 = 16;
const SPLIT_BYTES: u64 = 4;
/// The most hidden items one side check walks: a text full of tombstones
/// would otherwise be walked again for every new item (notes REVIEW3 M8).
const HIDDEN_WALK: u32 = 32;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    String,
    Format,
    Element,
    Deleted,
    /// Content slate-yjs never writes in a text.
    Other,
}

fn kind_of(content: &ItemContent) -> Kind {
    match content {
        ItemContent::String(_) => Kind::String,
        ItemContent::Format(..) => Kind::Format,
        ItemContent::Deleted(_) => Kind::Deleted,
        ItemContent::Type(branch) if matches!(branch.type_ref(), TypeRef::XmlText) => Kind::Element,
        _ => Kind::Other,
    }
}

/// Where a new item lands: a held type or a new block (by its id).
#[derive(Clone, Copy)]
enum Target {
    Held(BranchPtr),
    New(ID),
}

#[derive(Clone)]
enum Place {
    At {
        key: Option<Arc<str>>,
        parent: Target,
    },
    Gone,
    Unknown,
}

#[derive(Default)]
struct Children<'a> {
    attributes: u64,
    items: Vec<(&'a Item, Kind)>,
}

/// Unencodable JSON or something the bound does not model: measure exactly.
struct Unbounded;

/// `"key":value,` in a Plate node.
fn attribute_bytes(key: &str, value: &Any) -> Result<u64, Unbounded> {
    let value = json::any_len(value).map_err(|_| Unbounded)?.unwrap_or(0);
    Ok((json::escaped_len(key) + 2 + value + 2) as u64)
}

fn text_bytes(text: &str) -> u64 {
    json::escaped_len(text) as u64
}

/// `materialUpdateGrowth(content, update)`: the bound, or `None` when the
/// update holds something the bound does not model (the caller measures
/// exactly). Call it only for an update the room can place.
pub fn update_growth<T: ReadTxn>(txn: &T, update: &[u8]) -> Option<Metrics> {
    let update = ydoc::decode(update).ok()?;
    growth(txn, &Incoming::new(&update))
}

pub fn growth<T: ReadTxn>(txn: &T, decoded: &Incoming) -> Option<Metrics> {
    Bound::new(txn, decoded)?.run().ok()
}

struct Bound<'a, T: ReadTxn> {
    txn: &'a T,
    decoded: &'a Incoming<'a>,
    state: StateVector,
    content: BranchPtr,
    /// [Bound::held_side] per new item and side: a pasted run chains each
    /// item to the one before, so unmemoized walks are quadratic.
    sides: RefCell<HashMap<(ID, bool), Option<ID>>>,
}

impl<'a, T: ReadTxn> Bound<'a, T> {
    fn new(txn: &'a T, decoded: &'a Incoming<'a>) -> Option<Self> {
        Some(Bound {
            txn,
            decoded,
            state: txn.state_vector(),
            content: plate::content_root(txn)?,
            sides: RefCell::new(HashMap::new()),
        })
    }

    fn held(&self, id: &ID) -> bool {
        id.clock < self.state.get(&id.client)
    }

    fn held_item(&self, id: &ID) -> Option<ItemPtr> {
        self.txn.store().get_item(id)
    }

    fn deletes(&self, item: ItemPtr) -> bool {
        let id = item.id();
        self.decoded
            .deletes(&id.client, id.clock, id.clock + item.len())
    }

    fn hidden(&self, item: ItemPtr) -> bool {
        item.is_deleted() || self.deletes(item)
    }

    fn is_text(&self, branch: BranchPtr) -> bool {
        branch == self.content || matches!(branch.type_ref(), TypeRef::XmlText)
    }

    /// Where a held type sits: its depth (the content root is -1, a
    /// top-level block 0), and whether it is in the value: under content, no
    /// block on the way deleted, before or by this update.
    fn ancestry(&self, branch: BranchPtr) -> (i64, bool) {
        let mut level = -1;
        let mut top = branch;
        let mut visible = true;
        while let Some(item) = top.item() {
            step();
            level += 1;
            visible &= !self.hidden(item);
            match item.parent_branch() {
                Some(parent) => top = parent,
                None => return (level, false),
            }
        }
        (level, visible && top == self.content)
    }

    /// Where each new item lands. An item without a parent takes its
    /// origin's, else its right origin's.
    fn place_of(&self, start: &'a Item, places: &mut HashMap<ID, Place>) -> Place {
        let mut chain = Vec::new();
        let mut item = start;
        let found = loop {
            step();
            if let Some(known) = places.get(item.id()) {
                break known.clone();
            }
            places.insert(*item.id(), Place::Unknown); // a reference cycle stays unknown
            chain.push(*item.id());
            // Yjs drops an item next to a garbage-collected struct.
            let sides = [item.origin(), item.right_origin()];
            if sides
                .iter()
                .flatten()
                .any(|id| self.held(id) && self.held_item(id).is_none())
            {
                break Place::Gone;
            }
            match item.update_parent() {
                UpdateParent::Root(name) => {
                    break match BranchID::get_root(self.txn, name.as_ref()) {
                        Some(root) => Place::At {
                            key: item.parent_sub().cloned(),
                            parent: Target::Held(root),
                        },
                        None => Place::Unknown,
                    };
                }
                UpdateParent::Item(parent) => {
                    if self.held(parent) {
                        // Yjs also drops an item whose parent block was deleted
                        // and collected, as after a writer deletes a block
                        // another one is still editing.
                        break match self.held_item(parent) {
                            Some(holder) => match holder.content() {
                                ItemContent::Deleted(_) => Place::Gone,
                                ItemContent::Type(branch) => Place::At {
                                    key: item.parent_sub().cloned(),
                                    parent: Target::Held(BranchPtr::from(branch.as_ref())),
                                },
                                _ => Place::Unknown,
                            },
                            None => Place::Gone,
                        };
                    }
                    break match self.decoded.item_at(parent) {
                        Some(holder) => Place::At {
                            key: item.parent_sub().cloned(),
                            parent: Target::New(*holder.id()),
                        },
                        None => Place::Unknown,
                    };
                }
                UpdateParent::Branch(_) => break Place::Unknown,
                UpdateParent::Unknown => {
                    let Some(&sibling) = item.origin().or(item.right_origin()) else {
                        break Place::Unknown;
                    };
                    if self.held(&sibling) {
                        let Some(held) = self.held_item(&sibling) else {
                            break Place::Unknown;
                        };
                        break match held.parent_branch() {
                            Some(parent) => Place::At {
                                key: held.parent_sub().cloned(),
                                parent: Target::Held(parent),
                            },
                            None => Place::Unknown,
                        };
                    }
                    match self.decoded.item_at(&sibling) {
                        Some(next) => item = next,
                        None => break Place::Unknown,
                    }
                }
            }
        };
        for id in chain {
            places.insert(id, found.clone());
        }
        found
    }

    fn run(&self) -> Result<Metrics, Unbounded> {
        let mut places = HashMap::new();
        let mut bytes: u64 = 0;
        let mut nodes: u64 = 0;
        let mut depth: u32 = 0;
        // New children of each held text (in first-seen order) and of each
        // new block.
        let mut texts: Vec<(BranchPtr, Children)> = Vec::new();
        let mut text_index: HashMap<BranchID, usize> = HashMap::new();
        let mut blocks: HashMap<ID, Children> = HashMap::new();
        let mut text_entry =
            |texts: &mut Vec<(BranchPtr, Children<'a>)>, branch: BranchPtr| -> usize {
                *text_index.entry(branch.id()).or_insert_with(|| {
                    texts.push((branch, Children::default()));
                    texts.len() - 1
                })
            };

        for item in self.decoded.items() {
            if item.id().clock + item.len() <= self.state.get(&item.id().client) {
                continue;
            }
            let (key, parent) = match self.place_of(item, &mut places) {
                Place::Gone => continue,
                Place::Unknown => return Err(Unbounded),
                Place::At { key, parent } => (key, parent),
            };
            let kind = kind_of(item.content());
            if let Some(key) = key {
                // An attribute: `"key":value,` at most (it may replace a longer one).
                let added = match item.content() {
                    ItemContent::Deleted(_) => continue,
                    ItemContent::Any(values) => {
                        attribute_bytes(&key, values.last().unwrap_or(&Any::Undefined))?
                    }
                    _ => return Err(Unbounded),
                };
                match parent {
                    Target::New(block) => blocks.entry(block).or_default().attributes += added,
                    Target::Held(branch) => {
                        if !self.ancestry(branch).1 {
                            continue;
                        }
                        // The content root takes no attributes; the exact check refuses it.
                        if branch == self.content {
                            return Err(Unbounded);
                        }
                        bytes += added;
                    }
                }
                continue;
            }
            match kind {
                Kind::Other => return Err(Unbounded),
                Kind::Deleted => continue,
                _ => {}
            }
            match parent {
                Target::New(block) => {
                    let holder = self.decoded.item_at(&block).ok_or(Unbounded)?;
                    if kind_of(holder.content()) != Kind::Element {
                        return Err(Unbounded);
                    }
                    blocks.entry(block).or_default().items.push((item, kind));
                }
                Target::Held(branch) => {
                    if !self.ancestry(branch).1 {
                        continue;
                    }
                    if !self.is_text(branch) {
                        return Err(Unbounded);
                    }
                    let index = text_entry(&mut texts, branch);
                    texts[index].1.items.push((item, kind));
                }
            }
        }

        // Deleting a visible format item can widen another one's reach: such
        // a text is re-priced below.
        let mut reformatted: HashSet<BranchID> = HashSet::new();
        let store = self.txn.store();
        for (client, ranges) in self.decoded.delete_ranges() {
            let end = self.state.get(client);
            for &(from, to) in ranges {
                let until = to.min(end);
                let mut clock = from;
                while clock < until {
                    step();
                    let Some((range, item)) = store.get_block_range(&ID::new(*client, clock))
                    else {
                        break;
                    };
                    clock = range.clock + range.len;
                    let Some(item) = item else { continue };
                    if item.is_deleted() || !matches!(item.content(), ItemContent::Format(..)) {
                        continue;
                    }
                    let Some(parent) = item.parent_branch() else {
                        continue;
                    };
                    if self.is_text(parent)
                        && self.ancestry(parent).1
                        && reformatted.insert(parent.id())
                    {
                        text_entry(&mut texts, parent);
                    }
                }
            }
        }

        for (text, Children { items, .. }) in &texts {
            let (level, _) = self.ancestry(*text);
            let mut retext = reformatted.contains(&text.id())
                || items.iter().any(|(_, k)| *k == Kind::Format)
                || (items.iter().any(|(_, k)| *k == Kind::String)
                    && items.iter().any(|(_, k)| *k == Kind::Element));
            for (item, kind) in items {
                if retext {
                    break;
                }
                let left = self.held_side(item.origin().copied(), Side::Origin)?;
                let right = self.held_side(item.right_origin().copied(), Side::Right)?;
                retext = if !self.adjacent(*text, left, right) {
                    true
                } else if *kind == Kind::String {
                    // Typed next to a visible string, it joins that leaf; into
                    // an empty text, it replaces the empty leaf.
                    !(left.is_some_and(|id| self.visible_string(&id))
                        || right.is_some_and(|id| self.visible_string(&id))
                        || self.adjacent(*text, None, None))
                } else {
                    // A block between two strings of one leaf splits it.
                    self.string_beside(left, Side::Origin) && self.string_beside(right, Side::Right)
                };
            }
            // Re-price the text's leaves: each run of visible held strings
            // between two boundaries, plus one per new item, at the largest
            // attributes its formats can give.
            let mut leaves: u64 = 1;
            let mut widest: HashMap<Arc<str>, u64> = HashMap::new();
            if retext {
                let mut run = false;
                let mut next = text.start();
                while let Some(item) = next {
                    step();
                    next = item.right();
                    if self.hidden(item) {
                        continue;
                    }
                    match item.content() {
                        ItemContent::String(_) => {
                            if !run {
                                leaves += 1;
                            }
                            run = true;
                            continue;
                        }
                        ItemContent::Format(key, value) => widen(&mut widest, key, value)?,
                        _ => {}
                    }
                    run = false;
                }
            }
            for (item, kind) in items {
                bytes += SPLIT_BYTES;
                match (item.content(), kind) {
                    (ItemContent::String(text), _) => bytes += text_bytes(text.as_str()),
                    (ItemContent::Format(key, value), _) => widen(&mut widest, key, value)?,
                    (_, Kind::Element) => {
                        let block = subtree(&blocks, *item.id(), level + 1)?;
                        bytes += block.bytes;
                        nodes += block.nodes;
                        depth = depth.max(block.depth);
                    }
                    _ => {}
                }
                if retext {
                    leaves += 1;
                }
            }
            if retext {
                let attributes: u64 = widest.values().sum();
                bytes += leaves * (LEAF_BYTES + attributes);
                nodes += leaves;
            }
        }
        Ok(Metrics {
            content_bytes: bytes,
            max_depth: depth,
            node_count: nodes,
        })
    }

    /// The held item on one side of a new item: its origin, followed through
    /// other new items, each resolved once per update. `Err` when the chain
    /// leaves both update and room, or loops.
    fn held_side(&self, start: Option<ID>, side: Side) -> Result<Option<ID>, Unbounded> {
        let key = |item: &Item| (*item.id(), matches!(side, Side::Origin));
        let mut chain: Vec<(ID, bool)> = Vec::new();
        let mut seen: HashSet<(ID, bool)> = HashSet::new();
        let mut id = start;
        let found = loop {
            step();
            let Some(current) = id else { break None };
            if self.held(&current) {
                break Some(current);
            }
            let next = self.decoded.item_at(&current).ok_or(Unbounded)?;
            if let Some(known) = self.sides.borrow().get(&key(next)) {
                break *known;
            }
            // A cycle check per step, not a scan of the chain (REVIEW3 M7). Its
            // cost also stays bounded because a long chain cannot get here
            // untried: the trial sizing counts every struct the room lacks, and
            // the trial refuses chains of about 13,000 clients and more
            // (ydoc `a_chain_of_clients_applies_on_a_task_stack`,
            // admit_cost's chained clients).
            if !seen.insert(key(next)) {
                return Err(Unbounded);
            }
            chain.push(key(next));
            id = match side {
                Side::Origin => next.origin(),
                Side::Right => next.right_origin(),
            }
            .copied();
        };
        let mut sides = self.sides.borrow_mut();
        for step in chain {
            sides.insert(step, found);
        }
        Ok(found)
    }

    fn visible_string(&self, id: &ID) -> bool {
        self.held_item(id).is_some_and(|item| {
            matches!(item.content(), ItemContent::String(_))
                && !item.is_deleted()
                && !self.decoded.deletes(&id.client, id.clock, id.clock + 1)
        })
    }

    /// Whether every held unit strictly between two held positions of a text
    /// ends up invisible, so new items land next to the two positions.
    fn adjacent(&self, text: BranchPtr, left: Option<ID>, right: Option<ID>) -> bool {
        let mut item = match left {
            Some(left) => {
                let Some(held) = self.held_item(&left) else {
                    return false;
                };
                if held.parent_branch() != Some(text) {
                    return false;
                }
                let end = held.id().clock + held.len();
                if left.clock + 1 < end {
                    if right.is_some_and(|r| r.client == left.client && r.clock == left.clock + 1) {
                        return true;
                    }
                    if !held.is_deleted()
                        && !self.decoded.deletes(&left.client, left.clock + 1, end)
                    {
                        return false;
                    }
                }
                held.right()
            }
            None => text.start(),
        };
        let mut budget = HIDDEN_WALK;
        while let Some(current) = item {
            step();
            let ID { client, clock } = *current.id();
            if let Some(right) = right
                && right.client == client
                && right.clock >= clock
                && right.clock < clock + current.len()
            {
                return right.clock == clock
                    || current.is_deleted()
                    || self.decoded.deletes(&client, clock, right.clock);
            }
            // Past the budget the sides count as apart: the caller re-prices
            // the text once instead of walking its tombstones per new item.
            if !self.hidden(current) || budget == 0 {
                return false;
            }
            budget -= 1;
            item = current.right();
        }
        right.is_none()
    }

    /// The nearest visible held item that is not a format, from a position on.
    /// Whether the first visible item from `id` towards `side`, past
    /// hidden items and formats, is a string. Past [HIDDEN_WALK] items it
    /// answers yes: the caller then re-prices the text, an upper bound.
    fn string_beside(&self, id: Option<ID>, side: Side) -> bool {
        let mut item = id.and_then(|id| self.held_item(&id));
        let mut budget = HIDDEN_WALK;
        while let Some(current) = item {
            step();
            if !(self.hidden(current) || matches!(current.content(), ItemContent::Format(..))) {
                break;
            }
            if budget == 0 {
                return true;
            }
            budget -= 1;
            item = match side {
                Side::Origin => current.left(),
                Side::Right => current.right(),
            };
        }
        item.is_some_and(is_string)
    }
}

#[derive(Clone, Copy)]
enum Side {
    Origin,
    Right,
}

fn is_string(item: ItemPtr) -> bool {
    matches!(item.content(), ItemContent::String(_))
}

fn widen(
    widest: &mut HashMap<Arc<str>, u64>,
    key: &Arc<str>,
    value: &Any,
) -> Result<(), Unbounded> {
    if !matches!(value, Any::Null) {
        let size = attribute_bytes(key, value)?;
        let entry = widest.entry(key.clone()).or_insert(0);
        *entry = (*entry).max(size);
    }
    Ok(())
}

struct Subtree {
    bytes: u64,
    depth: u32,
    nodes: u64,
}

/// A new block and everything in it, all new: its attributes, its strings,
/// and one leaf per boundary at the largest attributes its formats give.
fn subtree(blocks: &HashMap<ID, Children>, block: ID, level: i64) -> Result<Subtree, Unbounded> {
    // Deeper than any structurally valid document: measure exactly.
    if level > DEPTH_CEILING as i64 {
        return Err(Unbounded);
    }
    let empty = Children::default();
    let children = blocks.get(&block).unwrap_or(&empty);
    let mut widest = HashMap::new();
    let mut size = ELEMENT_BYTES + children.attributes;
    let mut count: u64 = 1;
    let mut deepest = (level + 1) as u32;
    let mut boundaries: u64 = 0;
    for (item, kind) in &children.items {
        size += SPLIT_BYTES;
        match (item.content(), kind) {
            (ItemContent::String(text), _) => {
                size += text_bytes(text.as_str());
                continue;
            }
            (ItemContent::Format(key, value), _) => {
                boundaries += 1;
                widen(&mut widest, key, value)?;
            }
            (_, Kind::Element) => {
                boundaries += 1;
                let child = subtree(blocks, *item.id(), level + 1)?;
                size += child.bytes;
                count += child.nodes;
                deepest = deepest.max(child.depth);
            }
            _ => boundaries += 1,
        }
    }
    let leaf_attributes: u64 = widest.values().sum();
    let leaves = boundaries + 1;
    Ok(Subtree {
        bytes: size + leaves * (LEAF_BYTES + leaf_attributes),
        depth: deepest,
        nodes: count + leaves,
    })
}
