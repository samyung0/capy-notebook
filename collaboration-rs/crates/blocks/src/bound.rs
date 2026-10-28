//! The per-update growth bound of a blocks room, the counterpart of
//! `notes::bound`: what a typing update can add to the room's projection at
//! most, read from the update's own structs against the room, never a copy
//! of it.
//!
//! It covers typing alone: new strings in a block's text props and deleted
//! strings there. Anything else (a format, a new block, a move, a prop
//! write, a Mermaid source) is `None`, and the caller checks exactly.
//! Typing leaves the tree (the `blocks` map, every `sys:children`) as it
//! was, so a room whose tree passed [crate::check] still passes it, and
//! the repair on entry has nothing to do. What typing can change:
//!
//! - Deleting strings never grows the projection: a char's attributes come
//!   from the format items before it, not from other chars, so the runs
//!   only lose chars, and neighbours that become equal merge.
//! - A new string joins a run or makes at most two new ones (its own, and the
//!   half of a run it splits). Each new run is priced as the largest shell its
//!   text's attributes can give (a leaf with every mark, an `a` element with
//!   the longest url, the separator leaves around inline elements); a string
//!   under `latex` or `mention` adds one inline element per UTF-16 unit, and a
//!   newline in a code block one code line.
//! - The new runs carry attribute values a live format item of the text
//!   holds. Only values the store already took (on a visible char, where the
//!   projection shows them) are priced: a text holding any other (a
//!   zero-width range of a value never shown) is `None`, so the store never
//!   meets a value it has not checked.
//!
//! Cost: O(update) plus one walk of each text the update types into, and of
//! the room items its deletes cover.

use std::collections::HashMap;
use std::sync::Arc;

use yrs::block::{Item, ItemContent, ItemPtr, UpdateParent};
use yrs::branch::{BranchID, BranchPtr};
use yrs::types::TypeRef;
use yrs::{Any, ID, MapRef, ReadTxn, StateVector};

use ydoc::Incoming;
use ydoc::steps::{Walk, step};

use crate::BLOCKS_ROOT;
use crate::schema::{self, MERMAID};
use crate::store::{any_value, string};

/// A run's fixed bytes on top of its attributes and owner id: an inline
/// element's `{"id":"<owner>.i<n>","type":"inline_equation","texExpression":`
/// and `,"children":[{"text":""}]}` with a ten-digit `n`, its separator leaf
/// and commas (about 110), with room to spare.
const RUN_BYTES: u64 = 192;
/// A code line's shell on top of its owner id: `{"id":"<owner>.l<n>",
/// "type":"code_line","children":[]}` with a ten-digit `n`.
const LINE_BYTES: u64 = 64;
/// The split of a surrogate pair at an inserted item's two sides (each half
/// becomes U+FFFD, 4 bytes become 6).
const SPLIT_BYTES: u64 = 4;
/// Nodes of a new run: an `a` element, its leaf, a separator leaf.
const RUN_NODES: u64 = 3;
/// Nodes of a new code line: the line, an `a` element split across it with
/// its leaf, and two separator leaves.
const LINE_NODES: u64 = 5;
/// The most room items one update's deletes may cover on the bound; past it
/// the caller checks exactly.
const DELETE_WALK: u64 = 200_000;

/// What an update adds to the room's projection, at most.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Growth {
    pub bytes: u64,
    pub nodes: u64,
    /// A string lands in a live text: its nodes sit at most one level below
    /// the deepest leaf the room's projection has (an inline element's leaf).
    pub typed: bool,
}

/// The bound of `incoming` against the room, or `None` when it holds
/// anything but typing. Call it only on a room whose tree passed the
/// structural check.
pub fn growth<T: ReadTxn>(txn: &T, incoming: &Incoming) -> Option<Growth> {
    let root = BranchID::get_root(txn, BLOCKS_ROOT)?;
    let bound = Bound {
        txn,
        incoming,
        state: txn.state_vector(),
        root,
    };
    bound.run()
}

struct Bound<'a, T: ReadTxn> {
    txn: &'a T,
    incoming: &'a Incoming<'a>,
    state: StateVector,
    root: BranchPtr,
}

/// A text a string lands in, or `Hidden` for one outside the projection's
/// reach (a deleted text or block): what lands there adds nothing.
enum Place {
    Text(BranchPtr),
    Hidden,
}

impl<'a, T: ReadTxn> Bound<'a, T> {
    fn held(&self, id: &ID) -> bool {
        id.clock < self.state.get(&id.client)
    }

    fn held_item(&self, id: &ID) -> Option<ItemPtr> {
        self.txn.store().get_item(id)
    }

    /// The block text prop `branch` is: its owner id's length, or `None`
    /// when it is anything else (a nested type, a Mermaid source, a root).
    /// `Some(Hidden)` for one deleted, or in a deleted block.
    fn text_prop(&self, branch: BranchPtr) -> Option<(Place, u64)> {
        if !matches!(branch.type_ref(), TypeRef::Text) {
            return None;
        }
        let text_item = branch.item()?;
        let key = text_item.parent_sub()?.clone();
        let name = key.strip_prefix("prop:")?;
        let block = text_item.parent_branch()?;
        let block_item = block.item()?;
        let id = block_item.parent_sub()?.clone();
        if block_item.parent_branch()? != self.root || !matches!(block.type_ref(), TypeRef::Map) {
            return None;
        }
        let flavour = string(self.txn, &MapRef::from(block), "sys:flavour")?;
        // A Mermaid source has its length cap in the store: checked exactly.
        if flavour == MERMAID && name == "source" {
            return None;
        }
        let place = if text_item.is_deleted() || block_item.is_deleted() {
            Place::Hidden
        } else {
            Place::Text(branch)
        };
        // A table cell's owner is `<row>:<column>`, inside its key.
        Some((place, escaped_len(&id) + escaped_len(&key)))
    }

    /// The held text a new string lands in: `None` when it is not a block's
    /// text prop, or the update's chain leaves update and room.
    fn place_of(&self, item: &'a Item, places: &mut HashMap<ID, Option<Place>>) -> Option<Place> {
        match self.incoming.landing(self.txn.store(), &self.state, item) {
            ydoc::Landing::Gone => return Some(Place::Hidden),
            ydoc::Landing::At(id) => {
                return Some(self.text_prop(self.held_item(&id)?.parent_branch()?)?.0);
            }
            ydoc::Landing::Chain => {}
        }
        let mut chain = Vec::new();
        let mut at = item;
        let found = loop {
            step(Walk::Placement);
            if let Some(known) = places.get(at.id()) {
                break known.as_ref().map(Place::copy);
            }
            // A reference cycle stays unplaced.
            places.insert(*at.id(), None);
            chain.push(*at.id());
            match at.update_parent() {
                UpdateParent::Item(parent) if self.held(parent) => {
                    break match self.held_item(parent)?.content() {
                        ItemContent::Deleted(_) => Some(Place::Hidden),
                        ItemContent::Type(branch) => self
                            .text_prop(BranchPtr::from(branch.as_ref()))
                            .map(|(place, _)| place),
                        _ => None,
                    };
                }
                UpdateParent::Unknown => {
                    let sibling = at.origin().or(at.right_origin())?;
                    if self.held(sibling) {
                        // Yjs drops an item next to a collected struct.
                        let Some(held) = self.held_item(sibling) else {
                            break Some(Place::Hidden);
                        };
                        break self
                            .text_prop(held.parent_branch()?)
                            .map(|(place, _)| place);
                    }
                    at = self.incoming.item_at(sibling)?;
                }
                // A parent the update creates, a root, a branch id: no typing.
                _ => break None,
            }
        };
        for id in chain {
            places.insert(id, found.as_ref().map(Place::copy));
        }
        found
    }

    fn run(&self) -> Option<Growth> {
        let mut places = HashMap::new();
        // The new strings per text, in first-seen order.
        let mut texts: Vec<(BranchPtr, Vec<&str>)> = Vec::new();
        let mut index: HashMap<BranchID, usize> = HashMap::new();
        for item in self.incoming.items() {
            if item.id().clock + item.len() <= self.state.get(&item.id().client) {
                continue;
            }
            let ItemContent::String(text) = item.content() else {
                return None;
            };
            if item.parent_sub().is_some() {
                return None;
            }
            match self.place_of(item, &mut places)? {
                Place::Hidden => {}
                Place::Text(branch) => {
                    let at = *index.entry(branch.id()).or_insert_with(|| {
                        texts.push((branch, Vec::new()));
                        texts.len() - 1
                    });
                    texts[at].1.push(text.as_str());
                }
            }
        }
        self.deletes_only_strings()?;

        let mut growth = Growth::default();
        for (branch, strings) in &texts {
            let (_, owner) = self.text_prop(*branch)?;
            let shell = run_shell(*branch, owner)?;
            growth.typed = true;
            for text in strings {
                let units = text.encode_utf16().count() as u64;
                let lines = text.matches('\n').count() as u64;
                growth.bytes += escaped_len(text)
                    + SPLIT_BYTES
                    + 2 * shell.bytes
                    + lines * (shell.bytes + LINE_BYTES + owner);
                growth.nodes += 2 * RUN_NODES + lines * LINE_NODES;
                if shell.inline {
                    growth.bytes += units * shell.bytes;
                    growth.nodes += units * RUN_NODES;
                }
            }
        }
        Some(growth)
    }

    /// Whether every live room item the update deletes is a string in a
    /// block's text prop (the update's own new items may delete anything:
    /// they are placed above).
    fn deletes_only_strings(&self) -> Option<()> {
        let store = self.txn.store();
        let mut walked: u64 = 0;
        for (client, ranges) in self.incoming.delete_ranges() {
            let end = self.state.get(client);
            for &(from, to) in ranges {
                let until = to.min(end);
                let mut clock = from;
                while clock < until {
                    step(Walk::DeleteRanges);
                    walked += 1;
                    if walked > DELETE_WALK {
                        return None;
                    }
                    let (range, item) = store.get_block_range(&ID::new(*client, clock))?;
                    clock = range.clock + range.len;
                    let Some(item) = item else { continue };
                    if item.is_deleted() {
                        continue;
                    }
                    if !matches!(item.content(), ItemContent::String(_)) {
                        return None;
                    }
                    self.text_prop(item.parent_branch()?)?;
                }
            }
        }
        Some(())
    }
}

impl Place {
    fn copy(&self) -> Place {
        match self {
            Place::Text(branch) => Place::Text(*branch),
            Place::Hidden => Place::Hidden,
        }
    }
}

struct Shell {
    /// The bytes of the largest new run the text can hold.
    bytes: u64,
    /// The text holds `latex` or `mention`: a string may land under one.
    inline: bool,
}

/// The largest run a new string can make in `text`: every live format value
/// priced at once, each also as its mark key (`strike` is `strikethrough`).
/// `None` when a live format's value shows on no visible char.
fn run_shell(text: BranchPtr, owner: u64) -> Option<Shell> {
    let mut current: HashMap<Arc<str>, Any> = HashMap::new();
    let mut shown: Vec<(Arc<str>, Any)> = Vec::new();
    let mut formats: Vec<(Arc<str>, Any)> = Vec::new();
    let mut next = text.start();
    while let Some(item) = next {
        step(Walk::Reprice);
        next = item.right();
        if item.is_deleted() {
            continue;
        }
        match item.content() {
            ItemContent::Format(key, value) => {
                if matches!(**value, Any::Null | Any::Undefined) {
                    current.remove(key);
                } else {
                    current.insert(key.clone(), (**value).clone());
                    if !formats.iter().any(|(k, v)| k == key && v == &**value) {
                        formats.push((key.clone(), (**value).clone()));
                    }
                }
            }
            ItemContent::String(_) => {
                // What the projection shows of the char's attributes: an
                // inline element drops the rest.
                let inline = ["latex", "mention"]
                    .into_iter()
                    .find(|key| current.contains_key(*key));
                for (key, value) in &current {
                    if inline.is_some_and(|inline| &**key != inline) {
                        continue;
                    }
                    if !shown.iter().any(|(k, v)| k == key && v == value) {
                        shown.push((key.clone(), value.clone()));
                    }
                }
            }
            // A text the check passed holds strings and formats alone.
            _ => return None,
        }
    }
    let mut attributes: u64 = 0;
    for (key, value) in &formats {
        if !shown.iter().any(|(k, v)| k == key && v == value) {
            return None;
        }
        let mark = schema::mark_of_attribute(key).map_or(0, escaped_len);
        let value = serde_json::to_string(&any_value(value)).ok()?.len() as u64;
        attributes += escaped_len(key) + mark + value + 8;
    }
    Some(Shell {
        bytes: RUN_BYTES + 2 * owner + 2 * attributes,
        inline: formats
            .iter()
            .any(|(key, _)| &**key == "latex" || &**key == "mention"),
    })
}

/// `JSON.stringify(text).length - 2` in UTF-8 bytes.
fn escaped_len(text: &str) -> u64 {
    let mut len = text.len() as u64;
    for byte in text.bytes() {
        if byte < 0x20 {
            len += if matches!(byte, 8 | 9 | 10 | 12 | 13) {
                1
            } else {
                5
            };
        } else if byte == b'"' || byte == b'\\' {
            len += 1;
        }
    }
    len
}
