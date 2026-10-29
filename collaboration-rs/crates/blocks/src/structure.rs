//! The structural half of a blocks room's growth bound ([crate::bound]): an
//! update that adds, deletes, moves or rewrites blocks (Enter, a merge, a
//! delete, a move, an indent, a paste, a prop write), read from its own
//! structs against the room and the room's parent index ([Tree]), never a
//! copy of the room.
//!
//! It proves the room's next tree passes [crate::check] while reading only
//! what the update touches:
//!
//! - each block it lists, deletes or no longer lists is listed exactly once
//!   after it (none for a deleted one), by a parent that stays: no block
//!   under two parents, no orphan, no listed id without its block;
//! - each newly listed block fits its parent's flavour and sits at most
//!   [MAX_NESTING] levels below the note, its walk up reaching the note
//!   (no cycle), with its whole subtree within the cap when it moved;
//! - a new block's `sys:*` keys and props pass the check's own rules
//!   ([check::entry]), and each prop write on a held block has its kind,
//!   with no default or text prop removed.
//!
//! A concurrent update the repair on entry would fix (D3) fails one of these
//! and goes to the exact path, which repairs it.
//!
//! Then it gives the projection's change exactly: the top-level elements
//! holding a touched block, before the update and after it. A top-level
//! element holds a block when the block is it, or sits in it below a
//! callout or a column group; paragraphs and lists flatten their children
//! into top-level elements of their own. Every other top-level element keeps
//! its props, depth and subtree, so it projects as before.
//!
//! The update's new blocks are read from a document holding the update's
//! structs alone: the room's clocks stand there as collected ranges, so what
//! the update writes into held types drops, and its new block maps
//! integrate as the room will integrate them.
//!
//! A held text whose formats change, or one a structural update trims, is
//! read whole after the update: the room's units with the update's deletes
//! left out and its new strings and formats placed where yrs places them,
//! which it proves only when each run of new items follows a held unit
//! with nothing concurrent between.
//!
//! Left to the exact path: a new type in a held block (a table row's cells),
//! a block id written again (an undone delete), a new HTML embed (the count
//! cap), a note that may end up empty, ids JS's trim would change.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use serde_json::Value;
use yrs::block::{Item, ItemContent, ItemPtr};
use yrs::branch::{BranchID, BranchPtr};
use yrs::types::TypeRef;
use yrs::updates::encoder::Encode;
use yrs::{Any, Array, ID, Map as _, MapRef, Out, ReadTxn, Transact};

use crate::bound::{Bound, Growth};
use crate::check::{self, MAX_NESTING};
use crate::schema::{self, CALLOUT, COLUMN, COLUMNS, HTML, IMAGE};
use crate::store::{self, any_value, child_array, child_ids, string, yblock};
use crate::{BLOCKS_ROOT, Block, NOTE_ID, Prop, ROOT_ID, Run, plate_in, plate_out};

/// The most blocks one structural bound reads (owners, subtrees, walks);
/// past it the caller checks exactly.
const WORK: u64 = 200_000;
/// How many of the note's children the empty-note guard looks at.
const NOTE_SCAN: usize = 64;

/// A room's parent index: each block's parent, for a tree that passed the
/// structural check. Built at an exact check and moved along by every update
/// admitted on the bound ([Tree::apply]); the room drops it with its bound.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tree {
    parents: HashMap<Box<str>, Box<str>>,
    /// Every id is one JS's `trim` leaves as it is, so top-level ids stay
    /// distinct after the store trims them.
    clean: bool,
}

impl Tree {
    /// The index of a tree that passed [crate::check].
    pub fn of<T: ReadTxn>(txn: &T) -> Tree {
        let mut tree = Tree {
            parents: HashMap::new(),
            clean: true,
        };
        let Some(blocks) = txn.get_map(BLOCKS_ROOT) else {
            return tree;
        };
        for (id, block) in blocks.iter(txn) {
            tree.clean &= clean_id(id);
            let Out::YMap(block) = block else { continue };
            for child in child_ids(txn, &block).unwrap_or_default() {
                tree.parents.insert(child.into(), id.into());
            }
        }
        tree
    }

    /// The tree after an update admitted on `growth`.
    pub fn apply(&mut self, growth: &Growth) {
        for id in &growth.deleted {
            self.parents.remove(id.as_str());
        }
        for (child, parent) in &growth.listed {
            self.parents
                .insert(child.as_str().into(), parent.as_str().into());
        }
    }

    /// Blocks with a parent (every block but the root).
    pub fn len(&self) -> usize {
        self.parents.len()
    }

    pub fn is_empty(&self) -> bool {
        self.parents.is_empty()
    }

    fn parent(&self, id: &str) -> Option<&str> {
        self.parents.get(id).map(|parent| &**parent)
    }
}

/// An id JS's `trim` leaves as it is (stricter: any Unicode white space).
fn clean_id(id: &str) -> bool {
    let trims = |c: char| c.is_whitespace() || c == '\u{feff}';
    !id.is_empty() && !id.starts_with(trims) && !id.ends_with(trims)
}

/// What an update writes outside the texts it types into.
#[derive(Default)]
pub(crate) struct Edits<'a> {
    /// New block maps at the `blocks` root: their id and item.
    new: Vec<(Arc<str>, ID)>,
    /// Prop writes into held blocks: block, key, item.
    writes: Vec<(Arc<str>, Arc<str>, &'a Item)>,
    /// Ids listed in held children arrays: the parent and the item.
    listings: Vec<(Arc<str>, &'a Item)>,
    /// Held blocks deleted.
    deleted: Vec<Arc<str>>,
    /// Held prop entries deleted: block, key.
    unset: Vec<(Arc<str>, Arc<str>)>,
    /// Held listings deleted: parent, child.
    removed: Vec<(Arc<str>, Arc<str>)>,
    /// Blocks holding another deleted item (a nested map's entry): the
    /// update must delete them too.
    inside: Vec<Arc<str>>,
    /// Held texts the update writes into or deletes from.
    texts: Vec<TextEdit<'a>>,
    text_index: HashMap<BranchID, usize>,
}

/// What an update does to one held text prop.
pub(crate) struct TextEdit<'a> {
    branch: BranchPtr,
    /// Its new strings and formats.
    pub inserts: Vec<&'a Item>,
    /// It writes or deletes a format.
    pub formats: bool,
    /// It deletes a string.
    pub trimmed: bool,
    /// Read whole after the update, not priced as typing.
    pub rewrite: bool,
}

/// What a held type is to the tree.
enum Holder {
    Root,
    Block(Arc<str>, ItemPtr),
    /// A block's `sys:children`: the block, its item and the array's.
    Children(Arc<str>, ItemPtr, ItemPtr),
    Other,
}

fn holder_of<T: ReadTxn>(bound: &Bound<'_, T>, branch: BranchPtr) -> Holder {
    if branch == bound.root {
        return Holder::Root;
    }
    let Some(item) = branch.item() else {
        return Holder::Other;
    };
    let Some(parent) = item.parent_branch() else {
        return Holder::Other;
    };
    if parent == bound.root {
        return match item.parent_sub() {
            Some(id) if matches!(branch.type_ref(), TypeRef::Map) => {
                Holder::Block(id.clone(), item)
            }
            _ => Holder::Other,
        };
    }
    if item
        .parent_sub()
        .is_some_and(|key| &**key == "sys:children")
        && matches!(branch.type_ref(), TypeRef::Array)
        && let Some(block) = parent.item()
        && block.parent_branch() == Some(bound.root)
        && let Some(id) = block.parent_sub()
    {
        return Holder::Children(id.clone(), block, item);
    }
    Holder::Other
}

/// The block a held type sits in.
fn block_of<T: ReadTxn>(bound: &Bound<'_, T>, mut branch: BranchPtr) -> Option<Arc<str>> {
    loop {
        let item = branch.item()?;
        let parent = item.parent_branch()?;
        if parent == bound.root {
            return item.parent_sub().cloned();
        }
        branch = parent;
    }
}

impl<'a> Edits<'a> {
    /// Whether the update writes anything outside the texts.
    pub fn holds_structure(&self) -> bool {
        !(self.new.is_empty()
            && self.writes.is_empty()
            && self.listings.is_empty()
            && self.deleted.is_empty()
            && self.unset.is_empty()
            && self.removed.is_empty()
            && self.inside.is_empty())
    }

    pub fn text(&mut self, branch: BranchPtr) -> &mut TextEdit<'a> {
        let at = *self.text_index.entry(branch.id()).or_insert_with(|| {
            self.texts.push(TextEdit {
                branch,
                inserts: Vec::new(),
                formats: false,
                trimmed: false,
                rewrite: false,
            });
            self.texts.len() - 1
        });
        &mut self.texts[at]
    }

    pub fn texts_mut(&mut self) -> impl Iterator<Item = &mut TextEdit<'a>> {
        self.texts.iter_mut()
    }

    pub fn rewrites(&self, branch: BranchPtr) -> bool {
        self.text_index
            .get(&branch.id())
            .is_some_and(|at| self.texts[*at].rewrite)
    }

    pub fn rewrites_any(&self) -> bool {
        self.texts.iter().any(|text| text.rewrite)
    }

    /// A new item landing in held `branch` (at `key`), outside a text.
    pub fn place<T: ReadTxn>(
        &mut self,
        bound: &Bound<'_, T>,
        branch: BranchPtr,
        key: Option<Arc<str>>,
        item: &'a Item,
    ) -> Option<()> {
        match (holder_of(bound, branch), key, item.content()) {
            (Holder::Root, Some(id), ItemContent::Type(inner))
                if matches!(inner.type_ref(), TypeRef::Map) =>
            {
                self.new.push((id, *item.id()));
            }
            // What lands in a deleted block adds nothing.
            (Holder::Block(_, block), _, _) if block.is_deleted() => {}
            (Holder::Block(id, _), Some(key), ItemContent::Any(values))
                if key.starts_with("prop:") && values.len() == 1 =>
            {
                self.writes.push((id, key, item));
            }
            (Holder::Children(_, block, array), _, _)
                if block.is_deleted() || array.is_deleted() => {}
            (Holder::Children(id, _, _), None, ItemContent::Any(values))
                if values.iter().all(|value| matches!(value, Any::String(_))) =>
            {
                self.listings.push((id, item));
            }
            _ => return None,
        }
        Some(())
    }

    /// A live held item the update deletes (units `covered` of it), outside a
    /// text's strings.
    pub fn delete<T: ReadTxn>(
        &mut self,
        bound: &Bound<'_, T>,
        branch: BranchPtr,
        item: ItemPtr,
        covered: (u32, u32),
    ) -> Option<()> {
        match holder_of(bound, branch) {
            Holder::Root => {
                if !matches!(item.content(), ItemContent::Type(_)) {
                    return None;
                }
                self.deleted.push(item.parent_sub()?.clone());
            }
            Holder::Block(id, _) => self.unset.push((id, item.parent_sub()?.clone())),
            Holder::Children(id, _, _) => {
                let ItemContent::Any(values) = item.content() else {
                    return None;
                };
                for clock in covered.0..covered.1 {
                    let Any::String(child) = values.get((clock - item.id().clock) as usize)? else {
                        return None;
                    };
                    self.removed.push((id.clone(), child.clone()));
                }
            }
            Holder::Other => self.inside.push(block_of(bound, branch)?),
        }
        Some(())
    }
}

/// A block's place in a state of the room: before the update or after it.
trait View {
    fn parent(&self, id: &str) -> Option<String>;
    fn children(&self, id: &str) -> Option<Vec<String>>;
    fn flavour(&self, id: &str) -> Option<String>;
    /// The block's props, without its children.
    fn block(&self, id: &str) -> Option<Block>;
}

/// The room as it is.
struct Before<'a, T: ReadTxn> {
    txn: &'a T,
    blocks: &'a MapRef,
    tree: &'a Tree,
}

impl<T: ReadTxn> View for Before<'_, T> {
    fn parent(&self, id: &str) -> Option<String> {
        self.tree.parent(id).map(str::to_string)
    }

    fn children(&self, id: &str) -> Option<Vec<String>> {
        child_ids(self.txn, &yblock(self.txn, self.blocks, id)?)
    }

    fn flavour(&self, id: &str) -> Option<String> {
        string(self.txn, &yblock(self.txn, self.blocks, id)?, "sys:flavour")
    }

    fn block(&self, id: &str) -> Option<Block> {
        let map = yblock(self.txn, self.blocks, id)?;
        Some(Block {
            id: id.into(),
            flavour: string(self.txn, &map, "sys:flavour")?,
            props: store::props(self.txn, id, &map).ok()?,
            children: Vec::new(),
        })
    }
}

/// A new block as the update writes it.
struct New {
    flavour: String,
}

/// The room after the update: held blocks with the update's listings,
/// deletes and prop writes, and the new blocks from the update's own
/// document.
struct After<'a, T: ReadTxn, S: ReadTxn> {
    before: Before<'a, T>,
    scratch: &'a S,
    scratch_blocks: Option<MapRef>,
    new: &'a HashMap<String, New>,
    deleted: &'a HashSet<String>,
    /// Listings deleted: child → parent.
    removed: &'a HashMap<String, String>,
    by_child: &'a HashMap<String, Vec<String>>,
    by_parent: &'a HashMap<String, Vec<String>>,
    overlay: &'a BTreeMap<String, BTreeMap<String, Option<Any>>>,
    /// Held texts read whole after the update: block → prop name → runs.
    texts: &'a BTreeMap<String, Vec<(String, Vec<Run>)>>,
}

impl<T: ReadTxn, S: ReadTxn> View for After<'_, T, S> {
    fn parent(&self, id: &str) -> Option<String> {
        if let Some(parents) = self.by_child.get(id) {
            return parents.first().cloned();
        }
        if self.new.contains_key(id) || self.deleted.contains(id) {
            return None;
        }
        let parent = self.before.tree.parent(id)?;
        let unlisted = self.removed.get(id).is_some_and(|from| from == parent);
        (!unlisted && !self.deleted.contains(parent)).then(|| parent.to_string())
    }

    fn children(&self, id: &str) -> Option<Vec<String>> {
        if self.deleted.contains(id) {
            return None;
        }
        let mut children = if self.new.contains_key(id) {
            Vec::new()
        } else {
            let mut held = self.before.children(id)?;
            held.retain(|child| self.removed.get(child).is_none_or(|from| from != id));
            held
        };
        children.extend(self.by_parent.get(id).into_iter().flatten().cloned());
        Some(children)
    }

    fn flavour(&self, id: &str) -> Option<String> {
        if let Some(new) = self.new.get(id) {
            return Some(new.flavour.clone());
        }
        if self.deleted.contains(id) {
            return None;
        }
        self.before.flavour(id)
    }

    fn block(&self, id: &str) -> Option<Block> {
        if self.new.contains_key(id) {
            let blocks = self.scratch_blocks.as_ref()?;
            let map = yblock(self.scratch, blocks, id)?;
            return Some(Block {
                id: id.into(),
                flavour: string(self.scratch, &map, "sys:flavour")?,
                props: store::props(self.scratch, id, &map).ok()?,
                children: Vec::new(),
            });
        }
        if self.deleted.contains(id) {
            return None;
        }
        let mut block = self.before.block(id)?;
        if let Some(writes) = self.overlay.get(id) {
            for (key, value) in writes {
                let name = key.strip_prefix("prop:")?;
                match value {
                    Some(value) => block.set(name, Prop::Native(any_value(value))),
                    None => block.props.retain(|(prop, _)| prop != name),
                }
            }
            block.props.sort_by(|a, b| a.0.cmp(&b.0));
        }
        for (name, runs) in self.texts.get(id).into_iter().flatten() {
            block.set(name, Prop::Text(runs.clone()));
        }
        Some(block)
    }
}

/// The top-level element holding `id` in `view`: its block and the flatten
/// depth it sits at. `Some(None)` when `id` is not in that tree; `None` for
/// a path past the cap.
fn owner(view: &impl View, id: &str) -> Option<Option<(String, usize)>> {
    // From `id` up to the note's child.
    let mut path = vec![id.to_string()];
    loop {
        let Some(parent) = view.parent(path.last()?) else {
            return Some(None);
        };
        if parent == NOTE_ID {
            break;
        }
        if parent == ROOT_ID {
            return Some(None);
        }
        if path.len() > MAX_NESTING {
            return None;
        }
        path.push(parent);
    }
    for (depth, block) in path.iter().rev().enumerate() {
        if block == id || !schema::holds_indented(&view.flavour(block)?) {
            return Some(Some((block.clone(), depth)));
        }
    }
    None
}

/// The element top-level block `id` projects to at flatten depth `depth`;
/// `Some(None)` for an image still uploading, which projects to nothing.
fn element(view: &impl View, id: &str, depth: usize, work: &mut u64) -> Option<Option<Value>> {
    let block = subtree(view, id, false, 0, work)?;
    if block.flavour == IMAGE && block.str("sourceId").is_none_or(str::is_empty) {
        return Some(None);
    }
    plate_out::element(&block, depth).ok().map(Some)
}

/// Block `id` with its children when it holds them in its own element (a
/// callout, a column group, a column; everything below one).
fn subtree(view: &impl View, id: &str, full: bool, level: usize, work: &mut u64) -> Option<Block> {
    *work += 1;
    if *work > WORK || level > MAX_NESTING + 1 {
        return None;
    }
    let mut block = view.block(id)?;
    if full || matches!(block.flavour.as_str(), CALLOUT | COLUMNS | COLUMN) {
        for child in view.children(id)? {
            block
                .children
                .push(subtree(view, &child, true, level + 1, work)?);
        }
    }
    Some(block)
}

/// Every block below `id` in `view`, with how many levels below it.
fn descendants(view: &impl View, id: &str, work: &mut u64) -> Option<Vec<(String, usize)>> {
    let mut out = Vec::new();
    let mut stack = vec![(id.to_string(), 0)];
    while let Some((at, below)) = stack.pop() {
        for child in view.children(&at)? {
            *work += 1;
            if *work > WORK || below + 1 > MAX_NESTING {
                return None;
            }
            stack.push((child.clone(), below + 1));
            out.push((child, below + 1));
        }
    }
    Some(out)
}

/// How many levels below the note `id` sits after the update; `None` past
/// the cap, or on a cycle.
fn level(view: &impl View, id: &str) -> Option<usize> {
    let mut at = id.to_string();
    for level in 1..=MAX_NESTING {
        let parent = view.parent(&at)?;
        if parent == NOTE_ID {
            return Some(level);
        }
        if parent == id {
            return None;
        }
        at = parent;
    }
    None
}

/// The runs of held text `branch` once the update's deletes and its new
/// strings and formats (`inserts`) are in. `None` unless the new items form
/// chains, each written right after a unit the room holds (or at the start),
/// before the unit the room holds next there: nothing concurrent sits
/// between, so yrs places each chain exactly there.
fn after_runs<T: ReadTxn>(
    bound: &Bound<'_, T>,
    branch: BranchPtr,
    inserts: &[&Item],
    work: &mut u64,
) -> Option<Vec<Run>> {
    let incoming = bound.incoming;
    let held = |id: &ID| id.clock < bound.state.get(&id.client);
    // Each new item after another new one, by the unit it follows.
    let mut after_new: HashMap<ID, &Item> = HashMap::new();
    let mut chains: HashMap<Option<ID>, Vec<&Item>> = HashMap::new();
    for item in inserts {
        match item.origin() {
            Some(origin) if !held(origin) => {
                if after_new.insert(*origin, item).is_some() {
                    return None;
                }
            }
            origin => {
                if chains.insert(origin.copied(), vec![item]).is_some() {
                    return None;
                }
            }
        }
    }
    let mut placed = 0;
    for chain in chains.values_mut() {
        let right = chain[0].right_origin().copied();
        loop {
            let last = chain[chain.len() - 1];
            let end = ID::new(last.id().client, last.id().clock + last.len() - 1);
            let Some(next) = after_new.get(&end) else {
                break;
            };
            if next.right_origin().copied() != right {
                return None;
            }
            chain.push(next);
        }
        placed += chain.len();
    }
    if placed != inserts.len() {
        return None;
    }

    let mut out = RunWriter::default();
    let live = |id: &ID| !incoming.deletes(&id.client, id.clock, id.clock + 1);
    let mut place = |anchor: Option<ID>, next: Option<ID>, out: &mut RunWriter| -> Option<()> {
        let Some(chain) = chains.remove(&anchor) else {
            return Some(());
        };
        if chain[0].right_origin().copied() != next {
            return None;
        }
        for item in chain {
            let codes = codes(item.content());
            for unit in 0..item.len() {
                let id = ID::new(item.id().client, item.id().clock + unit);
                if live(&id) {
                    out.unit(item.content(), &codes, unit);
                }
            }
        }
        Some(())
    };
    place(None, branch.start().map(|first| *first.id()), &mut out)?;
    let mut next = branch.start();
    while let Some(item) = next {
        next = item.right();
        let ID { client, clock } = *item.id();
        let codes = codes(item.content());
        for unit in 0..item.len() {
            *work += 1;
            if *work > WORK {
                return None;
            }
            let id = ID::new(client, clock + unit);
            if !item.is_deleted() && live(&id) {
                out.unit(item.content(), &codes, unit);
            }
            let after = if unit + 1 < item.len() {
                Some(ID::new(client, clock + unit + 1))
            } else {
                next.map(|right| *right.id())
            };
            place(Some(id), after, &mut out)?;
        }
    }
    if !chains.is_empty() {
        return None;
    }
    Some(plate_in::merge(out.finish()))
}

/// Runs written unit by unit: a string's UTF-16 units under the attributes
/// the formats before them set.
#[derive(Default)]
struct RunWriter {
    attrs: BTreeMap<String, Value>,
    units: Vec<u16>,
    runs: Vec<Run>,
}

/// A string item's UTF-16 units.
fn codes(content: &ItemContent) -> Vec<u16> {
    match content {
        ItemContent::String(text) => text.as_str().encode_utf16().collect(),
        _ => Vec::new(),
    }
}

impl RunWriter {
    /// Unit `unit` of an item with `content` (`codes`: its UTF-16 units).
    fn unit(&mut self, content: &ItemContent, codes: &[u16], unit: u32) {
        match content {
            ItemContent::String(_) => {
                if let Some(code) = codes.get(unit as usize) {
                    self.units.push(*code);
                }
            }
            ItemContent::Format(key, value) => {
                self.flush();
                if matches!(**value, Any::Null | Any::Undefined) {
                    self.attrs.remove(&**key);
                } else {
                    self.attrs.insert(key.to_string(), any_value(value));
                }
            }
            _ => {}
        }
    }

    fn flush(&mut self) {
        if !self.units.is_empty() {
            self.runs.push(Run {
                text: String::from_utf16_lossy(&self.units),
                attrs: self.attrs.clone(),
            });
            self.units.clear();
        }
    }

    fn finish(mut self) -> Vec<Run> {
        self.flush();
        self.runs
    }
}

/// A document holding only `update`'s structs: the room's clocks stand as
/// collected ranges, so what the update writes into held types (or next to
/// held items) drops, and its new types integrate as in the room.
fn update_alone<T: ReadTxn>(txn: &T, update: &yrs::Update) -> Option<yrs::Doc> {
    use yrs::encoding::write::Write as _;
    let state = txn.state_vector();
    let held: Vec<(u64, u32)> = state
        .iter()
        .filter(|(_, clock)| **clock > 0)
        .map(|(client, clock)| (client.get(), *clock))
        .collect();
    // A v1 update of one collected range per client, no deletes.
    let mut skeleton = Vec::new();
    skeleton.write_var(held.len() as u64);
    for (client, clock) in held {
        skeleton.write_var(1u32);
        skeleton.write_var(client);
        skeleton.write_var(0u32);
        skeleton.write_u8(0);
        skeleton.write_var(clock);
    }
    skeleton.write_var(0u32);
    let doc = ydoc::scratch_doc();
    {
        let mut txn = doc.transact_mut();
        txn.apply_update(ydoc::decode(&skeleton).ok()?).ok()?;
        txn.apply_update(ydoc::decode(&update.encode_v1()).ok()?)
            .ok()?;
    }
    Some(doc)
}

/// Proves the update leaves a valid tree and fills `growth`'s elements and
/// tree changes; `None` for anything it cannot prove.
pub(crate) fn bound<T: ReadTxn>(
    bound: &Bound<'_, T>,
    tree: &Tree,
    edits: Edits,
    growth: &mut Growth,
) -> Option<()> {
    let (txn, incoming) = (bound.txn, bound.incoming);
    if !tree.clean {
        return None;
    }
    let blocks = txn.get_map(BLOCKS_ROOT)?;
    let live = |item: &Item| {
        let ID { client, clock } = *item.id();
        !incoming.deletes(&client, clock, clock + item.len())
    };

    let deleted: HashSet<String> = edits.deleted.iter().map(|id| id.to_string()).collect();
    if deleted.contains(ROOT_ID) || deleted.contains(NOTE_ID) {
        return None;
    }
    if edits.inside.iter().any(|id| !deleted.contains(&**id)) {
        return None;
    }

    // Prop writes and deletes on blocks that stay: one value per key.
    let mut overlay: BTreeMap<String, BTreeMap<String, Option<Any>>> = BTreeMap::new();
    let unset: HashSet<(&str, &str)> = edits
        .unset
        .iter()
        .map(|(id, key)| (&**id, &**key))
        .collect();
    for (id, key) in &unset {
        if !deleted.contains(*id) {
            overlay
                .entry(id.to_string())
                .or_default()
                .insert(key.to_string(), None);
        }
    }
    let mut written: BTreeMap<(&str, &str), Vec<&Item>> = BTreeMap::new();
    for (id, key, item) in &edits.writes {
        if !deleted.contains(&**id) && live(item) {
            written.entry((&**id, &**key)).or_default().push(*item);
        }
    }
    for ((id, key), items) in written {
        let [item] = items.as_slice() else {
            return None;
        };
        let ItemContent::Any(values) = item.content() else {
            return None;
        };
        // A held value the update does not delete: a concurrent write, which
        // yrs orders by client id.
        let held = yblock(txn, &blocks, id)?;
        let branch: &yrs::branch::Branch = held.as_ref();
        if branch
            .entry_item(key)
            .is_some_and(|entry| !entry.is_deleted())
            && !unset.contains(&(id, key))
        {
            return None;
        }
        overlay
            .entry(id.to_string())
            .or_default()
            .insert(key.to_string(), Some(values.first()?.clone()));
    }
    for (id, keys) in &overlay {
        let flavour = string(txn, &yblock(txn, &blocks, id)?, "sys:flavour")?;
        let schema = schema::flavour(&flavour)?;
        for (key, value) in keys {
            let name = key.strip_prefix("prop:")?;
            let kind = check::kind_of(schema, name)?;
            let fits = match value {
                Some(value) => check::fits(kind, &Out::Any(value.clone())),
                None => {
                    !schema::defaults(&flavour).iter().any(|(k, _)| *k == name)
                        && !schema::text_props(&flavour).contains(&name)
                }
            };
            if !fits {
                return None;
            }
        }
    }

    // New blocks, read from the update's own document.
    let fresh: Vec<&(Arc<str>, ID)> = edits
        .new
        .iter()
        .filter(|(_, item)| incoming.item_at(item).is_some_and(live))
        .collect();
    let held_blocks: &yrs::branch::Branch = blocks.as_ref();
    for (id, _) in &fresh {
        if !clean_id(id) || held_blocks.entry_item(id).is_some() {
            return None;
        }
    }
    let alone = if fresh.is_empty() {
        ydoc::scratch_doc()
    } else {
        update_alone(txn, incoming.update())?
    };
    let scratch = alone.transact();
    let scratch_blocks = scratch.get_map(BLOCKS_ROOT);
    let mut new: HashMap<String, New> = HashMap::new();
    let mut adds: Vec<(String, String)> = Vec::new();
    for (id, item) in &fresh {
        let map = scratch_blocks.as_ref()?;
        let branch: &yrs::branch::Branch = map.as_ref();
        let entry = branch.entry_item(id)?;
        if entry.is_deleted() || entry.id() != item {
            return None;
        }
        let (flavour, children) = check::entry(&scratch, map, id).ok()?;
        if flavour == HTML {
            return None;
        }
        adds.extend(children.into_iter().map(|child| (id.to_string(), child)));
        new.insert(id.to_string(), New { flavour });
    }

    // Ids listed in held arrays.
    for (parent, item) in &edits.listings {
        if deleted.contains(&**parent) {
            continue;
        }
        let ItemContent::Any(values) = item.content() else {
            return None;
        };
        let ID { client, clock } = *item.id();
        for (offset, value) in values.iter().enumerate() {
            let unit = clock + offset as u32;
            if unit < bound.state.get(&client) || incoming.deletes(&client, unit, unit + 1) {
                continue;
            }
            let Any::String(child) = value else {
                return None;
            };
            adds.push((parent.to_string(), child.to_string()));
        }
    }
    let mut removed: HashMap<String, String> = HashMap::new();
    for (parent, child) in &edits.removed {
        if tree.parent(child) != Some(&**parent) {
            return None;
        }
        removed.insert(child.to_string(), parent.to_string());
    }
    let mut by_child: HashMap<String, Vec<String>> = HashMap::new();
    let mut by_parent: HashMap<String, Vec<String>> = HashMap::new();
    for (parent, child) in &adds {
        by_child
            .entry(child.clone())
            .or_default()
            .push(parent.clone());
        by_parent
            .entry(parent.clone())
            .or_default()
            .push(child.clone());
    }

    // Each block whose listing changes is listed once after the update, by a
    // parent that stays (none when deleted).
    let mut touched: BTreeSet<String> = adds.iter().map(|(_, child)| child.clone()).collect();
    touched.extend(removed.keys().cloned());
    touched.extend(deleted.iter().cloned());
    touched.extend(new.keys().cloned());
    for id in &deleted {
        touched.extend(child_ids(txn, &yblock(txn, &blocks, id)?)?);
    }
    for id in &touched {
        if id == ROOT_ID || id == NOTE_ID {
            return None;
        }
        let held = tree.parent(id);
        if held.is_none() && !new.contains_key(id) {
            return None;
        }
        let stays = held.is_some_and(|parent| {
            removed.get(id).is_none_or(|from| from != parent) && !deleted.contains(parent)
        });
        let listed = usize::from(stays) + by_child.get(id).map_or(0, Vec::len);
        if listed != usize::from(!deleted.contains(id)) {
            return None;
        }
    }

    // Texts read whole after the update, in blocks that stay.
    let mut work = 0;
    let mut texts: BTreeMap<String, Vec<(String, Vec<Run>)>> = BTreeMap::new();
    for text in edits.texts.iter().filter(|text| text.rewrite) {
        let item = text.branch.item()?;
        let name = item.parent_sub()?.strip_prefix("prop:")?.to_string();
        let block = item.parent_branch()?.item()?.parent_sub()?.to_string();
        if deleted.contains(&block) {
            continue;
        }
        let runs = after_runs(bound, text.branch, &text.inserts, &mut work)?;
        texts.entry(block).or_default().push((name, runs));
    }

    let before = Before {
        txn,
        blocks: &blocks,
        tree,
    };
    let after = After {
        before: Before {
            txn,
            blocks: &blocks,
            tree,
        },
        scratch: &scratch,
        scratch_blocks: scratch_blocks.clone(),
        new: &new,
        deleted: &deleted,
        removed: &removed,
        by_child: &by_child,
        by_parent: &by_parent,
        overlay: &overlay,
        texts: &texts,
    };

    // Each listing fits its parent's flavour, below the cap, with no cycle.
    let mut affected: HashSet<String> = touched.iter().cloned().collect();
    affected.extend(overlay.keys().cloned());
    affected.extend(texts.keys().cloned());
    for (parent, child) in &adds {
        if parent == ROOT_ID {
            return None;
        }
        let fits = schema::flavour(&after.flavour(child)?)?
            .parents
            .contains(&after.flavour(parent)?.as_str());
        let at = level(&after, child)?;
        if !fits {
            return None;
        }
        // A moved block brings its subtree: within the cap, and every block
        // in it changes depth.
        if !new.contains_key(child) {
            for (id, below) in descendants(&after, child, &mut work)? {
                if at + below > MAX_NESTING {
                    return None;
                }
                affected.insert(id);
            }
            for (id, _) in descendants(&before, child, &mut work)? {
                affected.insert(id);
            }
        }
    }
    affected.remove(ROOT_ID);
    affected.remove(NOTE_ID);

    // The top-level elements holding a touched block, before and after.
    let mut owners: BTreeSet<String> = BTreeSet::new();
    for id in &affected {
        if let Some((top, _)) = owner(&before, id)? {
            owners.insert(top);
        }
        if let Some((top, _)) = owner(&after, id)? {
            owners.insert(top);
        }
    }
    for id in &owners {
        if let Some((top, depth)) = owner(&before, id)?
            && top == *id
            && let Some(element) = element(&before, id, depth, &mut work)?
        {
            growth.before.push(element);
        }
        if let Some((top, depth)) = owner(&after, id)?
            && top == *id
            && let Some(element) = element(&after, id, depth, &mut work)?
        {
            growth.after.push(element);
        }
    }

    // A note child the update leaves alone keeps the projection non-empty
    // on both sides (an empty one projects to a placeholder leaf).
    let note = yblock(txn, &blocks, NOTE_ID)?;
    let stays = child_array(txn, &note)?
        .iter(txn)
        .take(NOTE_SCAN)
        .any(|child| {
            let Out::Any(Any::String(id)) = child else {
                return false;
            };
            if affected.contains(&*id) || owners.contains(&*id) {
                return false;
            }
            yblock(txn, &blocks, &id).is_some_and(|map| {
                string(txn, &map, "sys:flavour").as_deref() != Some(IMAGE)
                    || string(txn, &map, "prop:sourceId").is_some_and(|s| !s.is_empty())
            })
        });
    if !stays {
        return None;
    }

    growth.listed = adds
        .into_iter()
        .map(|(parent, child)| (child, parent))
        .collect();
    growth.deleted = deleted.into_iter().collect();
    Some(())
}
