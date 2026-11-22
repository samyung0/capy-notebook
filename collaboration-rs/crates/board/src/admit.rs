//! The canvas room's check of a writer's update against the board's rules
//! (RULES.md "The room only", Epo 2026-11-22 "sure A then"), after the room
//! placed it within its work budget (`ydoc::inspect_bounded`).
//!
//! Every new struct is placed ([Locator]) and every live room item the update
//! deletes is found by walking its delete ranges over the room (what the room
//! holds deleted already costs a step and nothing more: a reconnect repeats
//! its whole delete set). Both are grouped by the entity (element or block)
//! they sit in. Each touched entity live after the update is read once over
//! its direct keys, from the room's trial copy when admission made one, else
//! from the room's value overlaid with the update's writes and deletions (a
//! small edit: one client, each map write placed after its key's live value,
//! its writes at one key chained as `Map.set` writes them, so the overlay is
//! exact), and checked whole ([rules::element_fits], [rules::block_fits]),
//! unless it misfit before the update: then each key the update writes on it
//! is held to that key's own rule. Each new item inside its nested types is
//! checked on its own; each keyed list the update adds to is counted after
//! it.
//!
//! Cost: linear in the update, plus the touched entities' direct keys and
//! values and the keyed lists it adds to, every step counted
//! (`Walk::Board`). Never a copy of the room.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use yrs::block::{Item, ItemContent, ItemPtr};
use yrs::branch::{Branch, BranchPtr};
use yrs::types::TypeRef;
use yrs::{Any, Doc, ID, Map, Out, ReadTxn, StateVector, Store, Transact, Transaction};

use ydoc::Incoming;
use ydoc::locate::{Locator, Place};
use ydoc::steps::{Walk, step};

use crate::rules::{
    self, Keyed, Keys, NOTE_FLAVOUR, OUTSIDE, PAGE_FLAVOUR, SURFACE_FLAVOUR, Stored,
};

/// The one root a board's editors write: BlockSuite's map of blocks by id.
pub const ROOT: &str = "blocks";
/// The canvas block's key holding its elements: `{type, value}`, `value` the
/// map of elements by id.
const ELEMENTS: &str = "prop:elements";
const VALUE: &str = "value";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Which {
    Block,
    Element,
}

impl Which {
    fn name(self) -> &'static str {
        match self {
            Which::Block => "block",
            Which::Element => "canvas element",
        }
    }

    /// The key holding its type or flavour.
    fn kind_key(self) -> &'static str {
        match self {
            Which::Block => "sys:flavour",
            Which::Element => "type",
        }
    }

    /// The whole rule over its direct keys, under its key `id`.
    fn fits(self, id: &str, keys: &Keys) -> Result<(), String> {
        match self {
            Which::Block => rules::block_fits(id, keys),
            Which::Element => rules::element_fits(id, keys),
        }
    }

    /// The keys never written again on an entity the room holds.
    fn fixed(self, key: &str) -> bool {
        match self {
            Which::Block => matches!(key, "sys:flavour" | "sys:children"),
            Which::Element => matches!(key, "type" | "id"),
        }
    }
}

/// Where a struct sits in the board's shape.
enum Spot<'p> {
    /// An entity's own entry: a block in the root (`parent` none), an
    /// element in the canvas's value map.
    Entry {
        which: Which,
        parent: Option<ID>,
        key: Arc<str>,
    },
    /// A direct key of the entity whose map is `entity`, held under `id`.
    Key {
        which: Which,
        entity: ID,
        id: Arc<str>,
        key: Arc<str>,
    },
    /// Inside one of the entity's nested types: `rest` the keys below the
    /// entity's, `container` the type holding the struct.
    Nested {
        which: Which,
        entity: ID,
        id: Arc<str>,
        rest: &'p [Arc<str>],
        key: Option<Arc<str>>,
        container: ID,
    },
    /// The canvas's elements holder, or one of its own keys.
    Holder,
}

/// The spot of a struct at `path` (`holders` the types along it) under
/// `key`. `surface` says whether the block whose map is that id is the
/// canvas.
fn spot<'p>(
    path: &'p [Arc<str>],
    holders: &[ID],
    key: Option<&Arc<str>>,
    mut surface: impl FnMut(ID) -> bool,
) -> Result<Spot<'p>, String> {
    let keys: Vec<&str> = path.iter().map(|key| &**key).collect();
    let holder = |at: usize| holders.get(at).copied().ok_or_else(|| OUTSIDE.to_owned());
    let canvas = keys.len() >= 3 && keys[2] == ELEMENTS && surface(holder(0)?);
    let at = |index: usize| path.get(index).cloned().ok_or_else(|| OUTSIDE.to_owned());
    let last = || holders.last().copied().ok_or_else(|| OUTSIDE.to_owned());
    Ok(match (keys.as_slice(), key) {
        ([ROOT], Some(key)) => Spot::Entry {
            which: Which::Block,
            parent: None,
            key: key.clone(),
        },
        ([ROOT, _, ELEMENTS], _) if canvas => Spot::Holder,
        ([ROOT, _, ELEMENTS, VALUE], Some(key)) if canvas => Spot::Entry {
            which: Which::Element,
            parent: Some(holder(2)?),
            key: key.clone(),
        },
        ([ROOT, _, ELEMENTS, VALUE, _], Some(key)) if canvas => Spot::Key {
            which: Which::Element,
            entity: holder(3)?,
            id: at(4)?,
            key: key.clone(),
        },
        ([ROOT, _, ELEMENTS, VALUE, _, _, ..], key) if canvas => Spot::Nested {
            which: Which::Element,
            entity: holder(3)?,
            id: at(4)?,
            rest: &path[5..],
            key: key.cloned(),
            container: last()?,
        },
        ([ROOT, _, ELEMENTS, ..], _) if canvas => return Err(OUTSIDE.into()),
        ([ROOT, _], Some(key)) if &**key == ELEMENTS && surface(holder(0)?) => Spot::Holder,
        ([ROOT, _], Some(key)) => Spot::Key {
            which: Which::Block,
            entity: holder(0)?,
            id: at(1)?,
            key: key.clone(),
        },
        ([ROOT, _, _, ..], key) => Spot::Nested {
            which: Which::Block,
            entity: holder(0)?,
            id: at(1)?,
            rest: &path[2..],
            key: key.cloned(),
            container: last()?,
        },
        _ => return Err(OUTSIDE.into()),
    })
}

/// Which board an entity is read from: the room's as it stands, the trial
/// copy past the update, or the room's overlaid with a small edit.
#[derive(Clone, Copy)]
enum Read<'t, 'doc> {
    Room,
    Trial(&'t Transaction<'doc>),
    Overlay,
}

/// A new struct inside an entity's nested types.
struct Nested<'a> {
    rest: Vec<Arc<str>>,
    key: Option<Arc<str>>,
    container: ID,
    item: &'a Item,
}

/// An entity an update creates, writes or deletes anything inside.
struct Entity<'a> {
    which: Which,
    /// Its key: the block's or element's id.
    id: Arc<str>,
    /// The update writes its entry, under this parent (none: the root).
    created: Option<Option<ID>>,
    /// The update writes it over a live entry (an erase and its undo, two
    /// undos of one erase, `Map.set` over it), whose type or flavour it
    /// keeps.
    replaces: Option<Option<Arc<str>>>,
    /// The update's writes to its direct keys.
    writes: Vec<(Arc<str>, &'a Item)>,
    nested: Vec<Nested<'a>>,
}

/// A keyed list the update adds an entry to, and its writes there.
struct Counted<'a> {
    list: Keyed,
    what: String,
    writes: Vec<(Arc<str>, &'a Item)>,
}

/// Checks `incoming` against the board's rules, as the room holds it (`room`)
/// and, past a small edit, as `trial` (the room's copy with the update
/// applied, `ydoc::Inspection::trial`) holds it after. A small edit has no
/// trial: its overlay on the room is exact only for one (`trial` must be
/// given for any other update). The reason names the rule broken.
pub fn admit_shapes<T: ReadTxn>(
    room: &T,
    incoming: &Incoming,
    trial: Option<&Doc>,
) -> Result<(), String> {
    let mut check = Check {
        room,
        incoming,
        state: room.state_vector(),
        locator: Locator::new(room, incoming),
        entities: HashMap::new(),
        surfaces: HashMap::new(),
        entries: HashMap::new(),
        at_keys: HashMap::new(),
    };
    check.structs()?;
    if trial.is_none() {
        check.chains()?;
    }
    check.deletions()?;
    let after = trial.map(|doc| doc.transact());
    check.entities(after.as_ref())
}

struct Check<'a, T: ReadTxn> {
    room: &'a T,
    incoming: &'a Incoming<'a>,
    state: StateVector,
    locator: Locator<'a, T>,
    /// By the item of the entity's map.
    entities: HashMap<ID, Entity<'a>>,
    /// Whether a held block's map is the canvas's.
    surfaces: HashMap<ID, bool>,
    /// The update's last new entry at each entity key (parent, id).
    entries: HashMap<(Option<ID>, Arc<str>), ID>,
    /// The update's map writes by key: the map's item (none: the root) and
    /// the key.
    at_keys: HashMap<(Option<ID>, Arc<str>), Vec<&'a Item>>,
}

/// The branch an item holds, when it is a type.
fn branch_of(item: &Item) -> Option<BranchPtr> {
    match item.content() {
        ItemContent::Type(branch) => Some(BranchPtr::from(branch.as_ref())),
        _ => None,
    }
}

/// The string a live map entry holds.
fn entry_string(branch: &Branch, key: &str) -> Option<Arc<str>> {
    let item = branch.entry_item(key)?;
    if item.is_deleted() {
        return None;
    }
    match item.content() {
        ItemContent::Any(values) => match values.last() {
            Some(Any::String(text)) => Some(text.clone()),
            _ => None,
        },
        _ => None,
    }
}

impl<'a, T: ReadTxn> Check<'a, T> {
    fn held(&self, id: &ID) -> bool {
        id.clock < self.state.get(&id.client)
    }

    /// Whether the update deletes the whole of `item`.
    fn deleted(&self, item: &Item) -> bool {
        let id = item.id();
        self.incoming
            .deletes(&id.client, id.clock, id.clock.saturating_add(item.len()))
    }

    fn entity(&mut self, which: Which, map: ID, id: Arc<str>) -> &mut Entity<'a> {
        self.entities.entry(map).or_insert_with(|| Entity {
            which,
            id,
            created: None,
            replaces: None,
            writes: Vec::new(),
            nested: Vec::new(),
        })
    }

    /// Whether the room's block whose map is `map` is the canvas: only the
    /// first state's is (a canvas is never created).
    fn surface(room: &T, state: &StateVector, memo: &mut HashMap<ID, bool>, map: ID) -> bool {
        if map.clock >= state.get(&map.client) {
            return false;
        }
        *memo.entry(map).or_insert_with(|| {
            step(Walk::Board);
            room.store()
                .get_item(&map)
                .and_then(|item| branch_of(&item))
                .and_then(|block| entry_string(&block, "sys:flavour"))
                .is_some_and(|flavour| &*flavour == SURFACE_FLAVOUR)
        })
    }

    /// Every new struct, placed and grouped by its entity; what never
    /// depends on the entity's type refused here.
    fn structs(&mut self) -> Result<(), String> {
        let (room, incoming) = (self.room, self.incoming);
        for item in incoming.items() {
            step(Walk::Board);
            let id = item.id();
            if id.clock.saturating_add(item.len()) <= self.state.get(&id.client) {
                continue;
            }
            let (path, holders, key) = match self.locator.place(item) {
                Place::Gone => continue,
                Place::Unknown => return Err(OUTSIDE.into()),
                Place::At { path, holders, key } => (path, holders, key),
            };
            if let Some(name) = &key {
                // Yjs's `Map.set` never writes one: a write placed before a
                // key's live value would hide itself.
                if item.right_origin().is_some() {
                    return Err("a map entry written before its key's live value".into());
                }
                // A run of values (Yjs merges a client's overwritten values
                // at a key when its history keeps them) holds the last, which
                // its key's rule reads; the overwritten ones are still plain.
                if let ItemContent::Any(values) = item.content()
                    && let Some((_, overwritten)) = values.split_last()
                    && !overwritten.iter().all(rules::is_plain)
                {
                    return Err("a map write holding a value that is not plain".into());
                }
                let at = (holders.last().copied(), name.clone());
                self.at_keys.entry(at).or_default().push(item);
            }
            let (state, surfaces) = (&self.state, &mut self.surfaces);
            let surface = |map| Self::surface(room, state, surfaces, map);
            match spot(&path, &holders, key.as_ref(), surface)? {
                Spot::Holder => {
                    return Err("the canvas's elements holder is never written again".into());
                }
                Spot::Entry { which, parent, key } => self.entry(which, parent, key, item)?,
                Spot::Key {
                    which,
                    entity,
                    id,
                    key,
                } => {
                    if self.held(&entity) && which.fixed(&key) {
                        return Err(format!("a {}'s {key} is never written again", which.name()));
                    }
                    self.entity(which, entity, id).writes.push((key, item));
                }
                Spot::Nested {
                    which,
                    entity,
                    id,
                    rest,
                    key,
                    container,
                } => {
                    let nested = Nested {
                        rest: rest.to_vec(),
                        key,
                        container,
                        item,
                    };
                    self.entity(which, entity, id).nested.push(nested);
                }
            }
        }
        Ok(())
    }

    /// A small edit's writes at each map key chain as Yjs's `Map.set`
    /// writes them: the first after the key's current item (none on a key
    /// with no item), each later one after the one before. Two written from
    /// one place end with the earlier live (yrs places the later left of it,
    /// `Item::integrate`), where the overlay reads the last.
    fn chains(&self) -> Result<(), String> {
        for ((map, key), writes) in &self.at_keys {
            let mut writes = writes.clone();
            writes.sort_unstable_by_key(|item| item.id().clock);
            let mut after = self.current(*map, key);
            for item in writes {
                step(Walk::Board);
                if item.origin().copied() != after {
                    return Err("a map key written twice from one place".into());
                }
                after = Some(item.last_id());
            }
        }
        Ok(())
    }

    /// The last id of the room's current item at `key` of the map whose
    /// item is `map` (none: the root).
    fn current(&self, map: Option<ID>, key: &str) -> Option<ID> {
        let branch = match map {
            None => {
                let root = self.room.get_map(ROOT)?;
                BranchPtr::from(AsRef::<Branch>::as_ref(&root))
            }
            Some(map) if self.held(&map) => branch_of(&*self.room.store().get_item(&map)?)?,
            Some(_) => return None,
        };
        branch.entry_item(key).map(|item| item.last_id())
    }

    /// A new entry of an entity, a map. Over a live entry (an erase and its
    /// undo sent as one update, two people undoing the same erase) it keeps
    /// the live one's type or flavour; it is checked whole either way.
    fn entry(
        &mut self,
        which: Which,
        parent: Option<ID>,
        key: Arc<str>,
        item: &'a Item,
    ) -> Result<(), String> {
        let holder = match parent {
            None => self
                .room
                .get_map(ROOT)
                .map(|root| BranchPtr::from(AsRef::<Branch>::as_ref(&root))),
            Some(map) if self.held(&map) => self
                .room
                .store()
                .get_item(&map)
                .and_then(|item| branch_of(&item)),
            Some(_) => return Err(OUTSIDE.into()),
        };
        let replaces = holder
            .and_then(|holder| holder.entry_item(&key))
            .filter(|live| !live.is_deleted())
            .map(|live| branch_of(&live).and_then(|map| entry_string(&map, which.kind_key())));
        let last = self
            .entries
            .entry((parent, key.clone()))
            .or_insert(*item.id());
        if item.id().clock > last.clock {
            *last = *item.id();
        }
        match item.content() {
            ItemContent::Deleted(_) => Ok(()),
            // Its key is checked with the rest of it ([rules::element_fits]).
            ItemContent::Type(branch) if matches!(branch.type_ref(), TypeRef::Map) => {
                let entity = self.entity(which, *item.id(), key);
                entity.created = Some(parent);
                entity.replaces = replaces;
                Ok(())
            }
            _ => Err(format!("a {} that is not a map", which.name())),
        }
    }

    /// Every live room item the update deletes, grouped by its entity: the
    /// page, the canvas and its elements holder are never deleted.
    fn deletions(&mut self) -> Result<(), String> {
        let (room, incoming) = (self.room, self.incoming);
        let store = room.store();
        // A range may cover a client's whole history: the walk is held to
        // the work budget as placing the update is.
        let mut walked = 0u64;
        for (client, ranges) in incoming.delete_ranges() {
            let end = self.state.get(client);
            for &(from, to) in ranges {
                let until = to.min(end);
                let mut clock = from;
                while clock < until {
                    step(Walk::Board);
                    walked += 1;
                    if walked > ydoc::MAX_WORK {
                        return Err(ydoc::UpdateError::Costly.to_string());
                    }
                    let Some((range, item)) = store.get_block_range(&ID::new(*client, clock))
                    else {
                        break;
                    };
                    clock = range.clock + range.len;
                    let Some(item) = item else { continue };
                    if item.is_deleted() {
                        continue;
                    }
                    let Place::At { path, holders, key } = self.locator.held_place(&item) else {
                        continue;
                    };
                    // The room's own markers are not the board's.
                    if path.first().is_none_or(|root| &**root != ROOT) {
                        continue;
                    }
                    let (state, surfaces) = (&self.state, &mut self.surfaces);
                    let surface = |map| Self::surface(room, state, surfaces, map);
                    match spot(&path, &holders, key.as_ref(), surface)? {
                        Spot::Holder => {
                            return Err("the canvas's elements holder is never deleted".into());
                        }
                        Spot::Entry {
                            which: Which::Block,
                            ..
                        } => {
                            let flavour = branch_of(&item)
                                .and_then(|block| entry_string(&block, "sys:flavour"));
                            if flavour
                                .is_some_and(|f| matches!(&*f, PAGE_FLAVOUR | SURFACE_FLAVOUR))
                            {
                                return Err("the page and canvas blocks are never deleted".into());
                            }
                        }
                        Spot::Entry { .. } => {}
                        Spot::Key {
                            which, entity, id, ..
                        }
                        | Spot::Nested {
                            which, entity, id, ..
                        } => {
                            self.entity(which, entity, id);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Each touched entity live after the update checked whole (one that
    /// misfit before it, key by key written), then each new item inside it,
    /// then the keyed lists it adds to.
    fn entities(&self, after: Option<&Transaction>) -> Result<(), String> {
        // A live entity's type or flavour (none: a misfit without one), by
        // its map; created blocks' flavours by id, for the tree rule without
        // a trial.
        let mut kinds: HashMap<ID, Option<Arc<str>>> = HashMap::new();
        let mut created: HashMap<Arc<str>, Arc<str>> = HashMap::new();
        for (map, entity) in &self.entities {
            let view = match after {
                Some(txn) => Self::read(txn.store().get_item(map).as_deref()),
                None => self.overlay(*map, entity),
            };
            let Some(keys) = view else { continue };
            let kind = plain_string(&keys, entity.which.kind_key());
            // Else one update could, say, put a note where a paragraph sat
            // under a note, which the children check never sees.
            if entity.replaces.as_ref().is_some_and(|old| *old != kind) {
                return Err(match entity.which {
                    Which::Element => "a replaced canvas element keeps its type".into(),
                    Which::Block => "a replaced block keeps its flavour".into(),
                });
            }
            let read = after.map_or(Read::Overlay, Read::Trial);
            if let Err(reason) = self.whole(read, *map, entity, &keys) {
                if !self.misfit_before(*map, entity) {
                    return Err(reason);
                }
                Self::keys_fit(entity, kind.as_deref())?;
            }
            if entity.which == Which::Block && !self.held(map) {
                if kind
                    .as_deref()
                    .is_some_and(|f| matches!(f, PAGE_FLAVOUR | SURFACE_FLAVOUR))
                {
                    return Err("the page and canvas blocks are never created".into());
                }
                if let Some(flavour) = &kind {
                    created.insert(entity.id.clone(), flavour.clone());
                }
            }
            kinds.insert(*map, kind);
        }
        let mut counted: HashMap<ID, Counted> = HashMap::new();
        for (map, entity) in &self.entities {
            let Some(kind) = kinds.get(map) else { continue };
            for nested in &entity.nested {
                step(Walk::Board);
                match kind {
                    Some(kind) => {
                        self.nested(entity.which, kind, nested, after, &created, &mut counted)?;
                    }
                    // A misfit with no type or flavour: no rule takes
                    // anything new inside it.
                    None if matches!(nested.item.content(), ItemContent::Deleted(_)) => {}
                    None => return Err(OUTSIDE.into()),
                }
            }
        }
        for (container, counted) in counted {
            let added = counted
                .writes
                .iter()
                .any(|(_, item)| !matches!(item.content(), ItemContent::Deleted(_)));
            if !added {
                continue;
            }
            let count = match after {
                Some(txn) => Self::live_len(txn.store().get_item(&container).as_deref()),
                None => self.overlay_len(container, &counted.writes),
            };
            if count.is_some_and(|count| count > rules::merged_cap(counted.list.cap)) {
                return Err(format!(
                    "{} holds more than {} entries",
                    counted.what,
                    rules::merged_cap(counted.list.cap)
                ));
            }
        }
        Ok(())
    }

    /// Whether the room's entity whose map is `map` misfit before the update
    /// (one the update creates never did).
    fn misfit_before(&self, map: ID, entity: &Entity) -> bool {
        if !self.held(&map) {
            return false;
        }
        Self::read(self.room.store().get_item(&map).as_deref())
            .is_some_and(|keys| self.whole(Read::Room, map, entity, &keys).is_err())
    }

    /// The whole rule over an entity whose map is `map` and direct keys
    /// `keys`, as `read` holds it, with what it reads below them: a note's
    /// background map is a colour, its `edgeless` holds its `style`.
    fn whole(&self, read: Read, map: ID, entity: &Entity, keys: &Keys) -> Result<(), String> {
        entity.which.fits(&entity.id, keys)?;
        let note = entity.which == Which::Block
            && matches!(keys.get("sys:flavour"), Some(Stored::Plain(Any::String(f))) if &**f == NOTE_FLAVOUR);
        if note && matches!(keys.get("prop:background"), Some(Stored::Map)) {
            let colour = self.entry_in(read, map, "prop:background").map(|(_, map)| {
                let at = |key| self.entry_in(read, map, key).map(|(stored, _)| stored);
                (at("dark"), at("light"), at("normal"))
            });
            let string =
                |stored: &Option<Stored>| matches!(stored, Some(Stored::Plain(Any::String(_))));
            // As a colour object: `dark` and `light` both when both are set,
            // else `normal`.
            let fits = colour.is_some_and(|(dark, light, normal)| match (&dark, &light) {
                (Some(_), Some(_)) => string(&dark) && string(&light),
                _ => string(&normal),
            });
            if !fits {
                return Err(format!(
                    "block {NOTE_FLAVOUR}: prop:background is not what it holds"
                ));
            }
        }
        if note && matches!(keys.get("prop:edgeless"), Some(Stored::Map)) {
            let style = self
                .entry_in(read, map, "prop:edgeless")
                .and_then(|(_, edgeless)| self.entry_in(read, edgeless, "style"));
            if !matches!(style, Some((Stored::Map, _))) {
                return Err(format!(
                    "block {NOTE_FLAVOUR}: prop:edgeless.style is required"
                ));
            }
        }
        Ok(())
    }

    /// The value at `key` of the map whose item is `map`, as `read` holds
    /// it, and the item holding it (none: unset).
    fn entry_in(&self, read: Read, map: ID, key: &str) -> Option<(Stored, ID)> {
        step(Walk::Board);
        let live = |item: ItemPtr, overlay: bool| {
            (!item.is_deleted() && !(overlay && self.deleted(&item)))
                .then(|| Stored::of(item.content()).map(|stored| (stored, *item.id())))
                .flatten()
        };
        let held = |store: &Store, overlay: bool| {
            let item = store.get_item(&map)?;
            let entry = branch_of(&item)?.entry_item(key)?;
            live(entry, overlay)
        };
        match read {
            Read::Room => held(self.room.store(), false),
            Read::Trial(txn) => held(txn.store(), false),
            Read::Overlay => match self.at_keys.get(&(Some(map), Arc::from(key))) {
                // A small edit's writes at a key chain: the last is live.
                Some(writes) => {
                    let last = writes.iter().max_by_key(|item| item.id().clock)?;
                    (!self.deleted(last))
                        .then(|| Stored::of(last.content()).map(|stored| (stored, *last.id())))
                        .flatten()
                }
                None if self.held(&map) => held(self.room.store(), true),
                None => None,
            },
        }
    }

    /// Each direct key the update writes on an entity that misfit before
    /// it, by that key's own rule.
    fn keys_fit(entity: &Entity, kind: Option<&str>) -> Result<(), String> {
        for (key, item) in &entity.writes {
            step(Walk::Board);
            let Some(stored) = Stored::of(item.content()) else {
                continue;
            };
            match entity.which {
                Which::Element => rules::element_key_fits(kind, key, &stored)?,
                Which::Block => rules::block_key_fits(&entity.id, kind, key, &stored)?,
            }
        }
        Ok(())
    }

    /// A live map's direct keys (none: deleted, or no map).
    fn read(item: Option<&Item>) -> Option<Keys> {
        let item = item.filter(|item| !item.is_deleted())?;
        let branch = branch_of(item)?;
        let mut keys = Keys::new();
        for (key, value) in branch.map_items() {
            step(Walk::Board);
            if !value.is_deleted()
                && let Some(stored) = Stored::of(value.content())
            {
                keys.insert(key.clone(), stored);
            }
        }
        Some(keys)
    }

    /// A small edit's entity as it leaves it: the room's live keys less what
    /// the update deletes, then each key's last write (none: not live after).
    fn overlay(&self, map: ID, entity: &Entity) -> Option<Keys> {
        let mut keys = Keys::new();
        if self.held(&map) {
            let item = self.room.store().get_item(&map)?;
            if item.is_deleted() || self.deleted(&item) {
                return None;
            }
            for (key, value) in branch_of(&item)?.map_items() {
                step(Walk::Board);
                if !value.is_deleted()
                    && !self.deleted(&value)
                    && let Some(stored) = Stored::of(value.content())
                {
                    keys.insert(key.clone(), stored);
                }
            }
        } else {
            let item = self.incoming.item_at(&map)?;
            let parent = entity.created?;
            let last = self.entries.get(&(parent, entity.id.clone()));
            if branch_of(item).is_none() || self.deleted(item) || last != Some(&map) {
                return None;
            }
        }
        for (key, item) in last_writes(&entity.writes) {
            match Stored::of(item.content()).filter(|_| !self.deleted(item)) {
                Some(stored) => keys.insert(key.clone(), stored),
                None => keys.remove(key),
            };
        }
        Some(keys)
    }

    /// A live map's live entries.
    fn live_len(item: Option<&Item>) -> Option<usize> {
        let item = item.filter(|item| !item.is_deleted())?;
        let branch = branch_of(item)?;
        Some(
            branch
                .map_items()
                .filter(|(_, value)| {
                    step(Walk::Board);
                    !value.is_deleted()
                })
                .count(),
        )
    }

    /// A small edit's keyed list's live entries after it.
    fn overlay_len(&self, container: ID, writes: &[(Arc<str>, &Item)]) -> Option<usize> {
        let mut live: HashSet<Arc<str>> = HashSet::new();
        if self.held(&container) {
            let item = self.room.store().get_item(&container)?;
            if item.is_deleted() || self.deleted(&item) {
                return None;
            }
            for (key, value) in branch_of(&item)?.map_items() {
                step(Walk::Board);
                if !value.is_deleted() && !self.deleted(&value) {
                    live.insert(key.clone());
                }
            }
        } else if self
            .incoming
            .item_at(&container)
            .is_none_or(|item| branch_of(item).is_none() || self.deleted(item))
        {
            return None;
        }
        for (key, item) in last_writes(writes) {
            if matches!(item.content(), ItemContent::Deleted(_)) || self.deleted(item) {
                live.remove(key);
            } else {
                live.insert(key.clone());
            }
        }
        Some(live.len())
    }

    /// A new item inside an entity of type or flavour `kind`, by its own
    /// rule.
    fn nested(
        &self,
        which: Which,
        kind: &str,
        nested: &Nested<'a>,
        after: Option<&Transaction>,
        created: &HashMap<Arc<str>, Arc<str>>,
        counted: &mut HashMap<ID, Counted<'a>>,
    ) -> Result<(), String> {
        let rest: Vec<&str> = nested.rest.iter().map(|key| &**key).collect();
        let content = nested.item.content();
        let stored = Stored::of(content);
        match (which, rest.as_slice(), nested.key.as_ref()) {
            (Which::Element, [key], Some(entry)) => {
                if let Some(list) = rules::keyed(kind, key) {
                    counted
                        .entry(nested.container)
                        .or_insert_with(|| Counted {
                            list,
                            what: format!("canvas element {kind}: {key}"),
                            writes: Vec::new(),
                        })
                        .writes
                        .push((entry.clone(), nested.item));
                }
                match stored {
                    Some(stored) => rules::element_entry_fits(kind, key, entry, &stored),
                    None => Ok(()),
                }
            }
            (Which::Element, [key], None) if rules::element_text(kind, key) => {
                rules::text_content_fits(content)
            }
            (Which::Block, ["sys:children"], None) => self.children(kind, nested, after, created),
            (Which::Block, [key], None) if rules::block_text(kind, key) => {
                rules::text_content_fits(content)
            }
            (Which::Block, path, Some(entry)) => match stored {
                Some(stored) => rules::block_entry_fits(kind, path, entry, &stored),
                None => Ok(()),
            },
            _ if matches!(content, ItemContent::Deleted(_)) => Ok(()),
            _ => Err(OUTSIDE.into()),
        }
    }

    /// New child ids of a block of flavour `parent`: ids, and a child that
    /// exists after the update has a flavour that may sit under it (a
    /// missing child is a relation, not refused).
    fn children(
        &self,
        parent: &str,
        nested: &Nested,
        after: Option<&Transaction>,
        created: &HashMap<Arc<str>, Arc<str>>,
    ) -> Result<(), String> {
        let values = match nested.item.content() {
            ItemContent::Deleted(_) => return Ok(()),
            ItemContent::Any(values) => values,
            _ => return Err(OUTSIDE.into()),
        };
        let start = nested.item.id();
        for (offset, value) in (0u32..).zip(values) {
            step(Walk::Board);
            let Any::String(child) = value else {
                return Err(format!("block {parent}: a child that is not an id"));
            };
            if !rules::is_id(child) {
                return Err(format!("block {parent}: a child that is not an id"));
            }
            let at = ID::new(start.client, start.clock.saturating_add(offset));
            let live = match after {
                Some(txn) => txn
                    .store()
                    .get_item(&at)
                    .is_some_and(|item| !item.is_deleted()),
                None => !self.incoming.deletes(&at.client, at.clock, at.clock + 1),
            };
            if !live {
                continue;
            }
            let flavour = match after {
                Some(txn) => Self::flavour_after(txn, child),
                None => created
                    .get(child)
                    .cloned()
                    .or_else(|| self.held_flavour(child)),
            };
            if let Some(flavour) = flavour
                && !rules::child_fits(parent, &flavour)
            {
                return Err(format!(
                    "block {flavour} under a block {parent}, which it may not sit under"
                ));
            }
        }
        Ok(())
    }

    /// The flavour of block `id` in the room's trial copy, when it is live.
    fn flavour_after(txn: &Transaction, id: &str) -> Option<Arc<str>> {
        let Some(Out::YMap(block)) = txn.get_map(ROOT)?.get(txn, id) else {
            return None;
        };
        match block.get(txn, "sys:flavour") {
            Some(Out::Any(Any::String(flavour))) => Some(flavour),
            _ => None,
        }
    }

    /// The flavour of the room's live block `id` the update leaves live (a
    /// held block's flavour is never written again).
    fn held_flavour(&self, id: &str) -> Option<Arc<str>> {
        let root = self.room.get_map(ROOT)?;
        let item = AsRef::<Branch>::as_ref(&root).entry_item(id)?;
        if item.is_deleted() || self.deleted(&item) {
            return None;
        }
        let block = branch_of(&item)?;
        entry_string(&block, "sys:flavour")
    }
}

/// The last of the update's writes at each key: a small edit's own writes
/// at a key chain one after another in clock order.
fn last_writes<'w, 'a>(writes: &'w [(Arc<str>, &'a Item)]) -> HashMap<&'w Arc<str>, &'a Item> {
    let mut last: HashMap<&Arc<str>, &Item> = HashMap::new();
    for (key, item) in writes {
        let slot = last.entry(key).or_insert(item);
        if item.id().clock > slot.id().clock {
            *slot = item;
        }
    }
    last
}

fn plain_string(keys: &Keys, key: &str) -> Option<Arc<str>> {
    match keys.get(key) {
        Some(Stored::Plain(Any::String(text))) => Some(text.clone()),
        _ => None,
    }
}
