//! Slate operations onto a yrs document, as `@slate-yjs/core` 1.0.2's
//! `applySlateOp` maps them (`applyToYjs/*`, `utils/location.ts`,
//! `utils/convert.ts`). Each operation is mapped against the Slate tree as it
//! was before the operation (slate-yjs stores the pre-operation document with
//! each local change), then applied to that tree.
//!
//! Stored positions (`__slateYjsStoredPosition_*` root attributes) are not
//! carried: a note's content root holds no attributes (`validate::assert_roots`).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::Value;
use yrs::block::{EmbedPrelim, ItemContent, ItemPtr, Prelim};
use yrs::branch::{Branch, BranchPtr};
use yrs::types::{Attrs, TypeRef};
use yrs::{
    Any, Array, ArrayPrelim, ArrayRef, GetString, Map, MapPrelim, MapRef, Out, ReadTxn, Text,
    TextPrelim, TextRef, TransactionMut, Xml, XmlTextRef,
};

use crate::json::value_to_any;
use crate::plate::{self, DeltaOp, Insert, ProjectionError, utf16_len};
use crate::slate::{self, Operation, Root, SlateError, len16};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MapError {
    #[error("{0}")]
    Path(String),
    #[error(transparent)]
    Projection(#[from] ProjectionError),
    #[error(transparent)]
    Slate(#[from] SlateError),
}

fn path_error<T>(message: &str) -> Result<T, MapError> {
    Err(MapError::Path(message.into()))
}

/// Where a Slate path sits in the Yjs tree (`getYTarget`).
struct YTarget<'a> {
    parent: BranchPtr,
    start: u32,
    end: u32,
    target: Option<BranchPtr>,
    slate_parent: &'a [Value],
    slate_target: Option<&'a Value>,
    target_delta: Vec<DeltaOp>,
}

/// A Slate node's length in its Yjs parent.
fn y_len(node: Option<&Value>) -> u32 {
    match node {
        None => 0,
        Some(node) if slate::is_text(node) => utf16_len(slate::text(node)),
        Some(_) => 1,
    }
}

fn y_offset(children: &[Value], index: usize) -> u32 {
    children.iter().take(index).map(|c| y_len(Some(c))).sum()
}

fn y_target<'a>(
    parent: BranchPtr,
    slate_children: &'a [Value],
    path: &[usize],
) -> Result<YTarget<'a>, MapError> {
    let Some((&index, rest)) = path.split_first() else {
        return path_error("Path has to a have a length >= 1");
    };
    let start = y_offset(slate_children, index);
    let slate_target = slate_children.get(index);
    let length = y_len(slate_target);
    let target_delta = slice_delta(plate::insert_delta(&parent)?, start, length);
    if target_delta.len() > 1 {
        return path_error("Path doesn't match yText, yTarget spans multiple nodes");
    }
    let target = match target_delta.first() {
        Some(DeltaOp {
            insert: Insert::Element(branch),
            ..
        }) => Some(*branch),
        _ => None,
    };
    if !rest.is_empty() {
        let (Some(branch), Some(node)) = (target, slate_target) else {
            return path_error("Path doesn't match yText, cannot descent into non-yText");
        };
        if slate::is_text(node) {
            return path_error("Cannot descent into slate text");
        }
        return y_target(branch, slate::children(node), rest);
    }
    Ok(YTarget {
        parent,
        start,
        end: start + length,
        target,
        slate_parent: slate_children,
        slate_target,
        target_delta,
    })
}

/// `sliceInsertDelta`.
fn slice_delta(delta: Vec<DeltaOp>, start: u32, length: u32) -> Vec<DeltaOp> {
    if length < 1 {
        return Vec::new();
    }
    let end = start + length;
    let mut offset = 0;
    let mut out = Vec::new();
    for op in delta {
        if offset >= end {
            break;
        }
        let len = op.y_len();
        if offset + len <= start {
            offset += len;
            continue;
        }
        match &op.insert {
            Insert::Element(_) => out.push(op),
            Insert::Text(text) => {
                let from = start.saturating_sub(offset) as usize;
                let to = (len as i64 - (offset as i64 + len as i64 - end as i64)).min(len as i64);
                let units: Vec<u16> = text.encode_utf16().collect();
                let to = (to.max(0) as usize).min(units.len());
                let piece = String::from_utf16_lossy(&units[from.min(to)..to]);
                out.push(DeltaOp {
                    insert: Insert::Text(piece),
                    attributes: op.attributes.clone(),
                });
            }
        }
        offset += len;
    }
    out
}

/// A Slate node's properties (`getProperties`) as Yjs attributes.
fn properties(node: &Value) -> Vec<(String, Any)> {
    let skip = if slate::is_text(node) {
        "text"
    } else {
        "children"
    };
    node.as_object()
        .map(|map| {
            map.iter()
                .filter(|(key, _)| key.as_str() != skip)
                .map(|(key, value)| (key.clone(), value_to_any(value)))
                .collect()
        })
        .unwrap_or_default()
}

fn attrs<K: AsRef<str>>(entries: impl IntoIterator<Item = (K, Any)>) -> Attrs {
    entries
        .into_iter()
        .map(|(key, value)| (Arc::from(key.as_ref()), value))
        .collect()
}

fn delta_attrs(op: &DeltaOp) -> Attrs {
    attrs(
        op.attributes
            .iter()
            .map(|a| (a.key.to_string(), a.value.clone())),
    )
}

/// A new Y.XmlText to embed, filled once integrated: properties, then its
/// children (`slateElementToYText`), or the reverse for a split's new half,
/// whose properties slate-yjs sets after its delta.
pub(crate) struct ElementPrelim {
    properties: Vec<(String, Any)>,
    children: Vec<Child>,
    properties_last: bool,
}

pub(crate) enum Child {
    Text(String, Attrs),
    Element(ElementPrelim, Attrs),
}

impl ElementPrelim {
    /// `slateElementToYText(node)`.
    pub(crate) fn from_node(node: &Value) -> Self {
        ElementPrelim {
            properties: properties(node),
            children: slate::children(node)
                .iter()
                .map(|child| {
                    if slate::is_text(child) {
                        Child::Text(slate::text(child).into(), attrs(properties(child)))
                    } else {
                        Child::Element(ElementPrelim::from_node(child), Attrs::new())
                    }
                })
                .collect(),
            properties_last: false,
        }
    }

    /// `cloneDeep(yText)`: a copy of an element with its delta.
    fn clone_of(branch: &Branch) -> Result<Self, MapError> {
        Ok(ElementPrelim {
            properties: plate::properties(branch)?
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
            children: clone_delta(&plate::insert_delta(branch)?)?,
            properties_last: false,
        })
    }
}

/// `cloneInsertDeltaDeep`.
fn clone_delta(delta: &[DeltaOp]) -> Result<Vec<Child>, MapError> {
    delta
        .iter()
        .map(|op| {
            Ok(match &op.insert {
                Insert::Text(text) => Child::Text(text.clone(), delta_attrs(op)),
                Insert::Element(branch) => {
                    Child::Element(ElementPrelim::clone_of(branch)?, delta_attrs(op))
                }
            })
        })
        .collect()
}

impl Prelim for ElementPrelim {
    type Return = XmlTextRef;

    fn into_content(self, _txn: &mut TransactionMut) -> (ItemContent, Option<Self>) {
        (ItemContent::Type(Branch::new(TypeRef::XmlText)), Some(self))
    }

    fn integrate(self, txn: &mut TransactionMut, inner_ref: BranchPtr) {
        let text = XmlTextRef::from(inner_ref);
        let kind = self
            .properties
            .iter()
            .find_map(|(key, value)| match value {
                Any::String(kind) if key == "type" => Some(kind.to_string()),
                _ => None,
            })
            .unwrap_or_default();
        let set = |txn: &mut TransactionMut, properties: Vec<(String, Any)>| {
            for (key, value) in properties {
                match value {
                    // A Mermaid block's source is a text (shape A), as the
                    // patched slate-yjs inserts and clones it.
                    Any::String(source) if plate::holds_text(&kind, &key) => {
                        text.insert_attribute(txn, key, TextPrelim::new(source.as_ref()));
                    }
                    // A figure's block is a map (Epo 2026-10-17), likewise.
                    Any::Map(block) if plate::holds_map(&kind, &key) => {
                        let map = text.insert_attribute(txn, key, MapPrelim::default());
                        edit_map(txn, &map, &block, plate::lists_of(&kind));
                    }
                    value => {
                        text.insert_attribute(txn, key, value);
                    }
                }
            }
        };
        let mut properties = Some(self.properties);
        if !self.properties_last {
            set(txn, properties.take().unwrap_or_default());
        }
        // A prelim's delta runs with Yjs's default `sanitize`, so no newline
        // is dropped here.
        insert_children(txn, inner_ref, 0, self.children, false);
        if let Some(properties) = properties {
            set(txn, properties);
        }
    }
}

impl From<ElementPrelim> for EmbedPrelim<ElementPrelim> {
    fn from(value: ElementPrelim) -> Self {
        EmbedPrelim::Shared(value)
    }
}

/// Inserts delta entries one after another from `index` (`applyDelta` after
/// a retain). `strip`: the delta is applied with `sanitize: false` to an
/// integrated type, where Yjs drops the last string's trailing newline when
/// its running position has no right neighbour.
fn insert_children(
    txn: &mut TransactionMut,
    parent: BranchPtr,
    index: u32,
    children: Vec<Child>,
    strip: bool,
) {
    let text = XmlTextRef::from(parent);
    let mut at = index;
    let count = children.len();
    let mut last: Option<ItemPtr> = None;
    for (i, child) in children.into_iter().enumerate() {
        let before = ReadTxn::store(txn).get_local_state();
        let len = match child {
            Child::Text(mut chunk, attrs) => {
                if strip
                    && i + 1 == count
                    && chunk.ends_with('\n')
                    && nothing_follows(parent, at, last)
                {
                    chunk.pop();
                }
                if chunk.is_empty() {
                    continue;
                }
                let len = utf16_len(&chunk);
                text.insert_with_attributes(txn, at, &chunk, attrs);
                len
            }
            Child::Element(prelim, attrs) => {
                text.insert_embed_with_attributes(txn, at, prelim, attrs);
                1
            }
        };
        if strip {
            last = inserted_end(txn, parent, at, before);
        }
        at += len;
    }
}

/// The last item one insert left in `parent`: its content item (at countable
/// index `at`) or the negated formats this client created right after it.
fn inserted_end(txn: &TransactionMut, parent: BranchPtr, at: u32, before: u32) -> Option<ItemPtr> {
    let client = txn.doc().client_id();
    let mut remaining = at;
    let mut next = parent.start();
    let mut content = None;
    while let Some(item) = next {
        next = item.right();
        if item.is_deleted() || !item.is_countable() {
            continue;
        }
        let len = item.content_len(yrs::OffsetKind::Utf16);
        if remaining < len {
            content = Some(item);
            break;
        }
        remaining -= len;
    }
    let mut last = content?;
    while let Some(item) = last.right() {
        let own = item.id().client == client && item.id().clock >= before;
        if own && matches!(item.content(), ItemContent::Format(..)) {
            last = item;
        } else {
            break;
        }
    }
    Some(last)
}

/// Whether Yjs's running insert position has no right neighbour: after a
/// previous insert, only deleted items follow it; before any insert, nothing
/// follows the retained units (Yjs first steps over deleted items and null
/// formats at an empty retain).
fn nothing_follows(parent: BranchPtr, at: u32, last: Option<ItemPtr>) -> bool {
    let mut next = match last {
        Some(item) => item.right(),
        None => {
            let mut remaining = at;
            let mut next = parent.start();
            if remaining == 0 {
                while let Some(item) = next {
                    let null_format = matches!(item.content(), ItemContent::Format(_, value) if matches!(**value, Any::Null));
                    if item.is_deleted() || null_format {
                        next = item.right();
                    } else {
                        break;
                    }
                }
                return next.is_none();
            }
            while let Some(item) = next {
                next = item.right();
                if !item.is_deleted() && item.is_countable() {
                    let len = item.content_len(yrs::OffsetKind::Utf16);
                    if remaining < len {
                        // Yjs splits this item: its right half follows.
                        return false;
                    }
                    remaining -= len;
                    if remaining == 0 {
                        break;
                    }
                }
            }
            return next.is_none();
        }
    };
    while let Some(item) = next {
        if !item.is_deleted() {
            return false;
        }
        next = item.right();
    }
    true
}

/// Changes a source text to `next` with the fewest edits: the common head
/// and tail stay (the slate-yjs patch's `editSharedText`), cut at character
/// boundaries.
pub fn edit_text(txn: &mut TransactionMut, text: &TextRef, next: &str) {
    let current = text.get_string(txn);
    if current == next {
        return;
    }
    let (held, wanted): (Vec<char>, Vec<char>) =
        (current.chars().collect(), next.chars().collect());
    let head = held.iter().zip(&wanted).take_while(|(a, b)| a == b).count();
    let tail = held[head..]
        .iter()
        .rev()
        .zip(wanted[head..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let units = |chars: &[char]| chars.iter().map(|c| c.len_utf16() as u32).sum::<u32>();
    let start = units(&held[..head]);
    let removed = units(&held[head..held.len() - tail]);
    if removed > 0 {
        text.remove_range(txn, start, removed);
    }
    let inserted: String = wanted[head..wanted.len() - tail].iter().collect();
    if !inserted.is_empty() {
        text.insert(txn, start, &inserted);
    }
}

/// Changes a figure's block map to `next` with the fewest writes, as the
/// slate-yjs patch's `editSharedMap` does (Epo 2026-10-17): a changed entry
/// is set whole and a gone one removed, so another writer's change to a
/// different entry stays; a list key's (`lists`: series, graph elements)
/// entries of maps are edited the same way, in key order.
pub fn edit_map(
    txn: &mut TransactionMut,
    map: &MapRef,
    next: &HashMap<String, Any>,
    lists: &[&str],
) {
    let gone: Vec<String> = map
        .keys(txn)
        .filter(|key| !next.contains_key(*key))
        .map(str::to_owned)
        .collect();
    for key in gone {
        map.remove(txn, &key);
    }
    let mut keys: Vec<&String> = next.keys().collect();
    keys.sort();
    for key in keys {
        let value = &next[key];
        let list = match value {
            Any::Array(items)
                if lists.contains(&key.as_str())
                    && items.iter().all(|item| matches!(item, Any::Map(_))) =>
            {
                Some(items)
            }
            _ => None,
        };
        match (map.get(txn, key), list) {
            (Some(Out::YArray(held)), Some(items)) => edit_list(txn, &held, items),
            (_, Some(items)) => {
                let held = map.insert(txn, key.as_str(), ArrayPrelim::default());
                edit_list(txn, &held, items);
            }
            (Some(Out::Any(held)), None) if held == *value => {}
            (_, None) => {
                map.insert(txn, key.as_str(), value.clone());
            }
        }
    }
}

/// A list of maps edited towards `items` (each an `Any::Map`): matched by
/// their `id` when every entry has one (a graph's elements), else by index
/// (series). A matched entry is edited ([edit_map]); one out of place is
/// removed and inserted anew where it now sits.
fn edit_list(txn: &mut TransactionMut, list: &ArrayRef, items: &[Any]) {
    fn id_of(entry: &Any) -> Option<String> {
        match entry {
            Any::Map(map) => match map.get("id") {
                Some(Any::String(id)) => Some(id.to_string()),
                _ => None,
            },
            _ => None,
        }
    }
    fn entries(item: &Any) -> HashMap<String, Any> {
        match item {
            Any::Map(map) => (**map).clone(),
            _ => HashMap::new(),
        }
    }
    let insert = |txn: &mut TransactionMut, at: u32, item: &Any| {
        let map = list.insert(txn, at, MapPrelim::default());
        edit_map(txn, &map, &entries(item), &[]);
    };
    let held: Vec<Option<String>> = list
        .iter(txn)
        .map(|entry| match entry {
            Out::YMap(map) => match map.get(txn, "id") {
                Some(Out::Any(Any::String(id))) => Some(id.to_string()),
                _ => None,
            },
            _ => None,
        })
        .collect();
    let wanted: Vec<Option<String>> = items.iter().map(id_of).collect();
    if wanted.iter().all(Option::is_some) && held.iter().all(Option::is_some) {
        // Entries no longer wanted (or repeated) go first, from the end.
        let names: HashSet<&str> = wanted.iter().flatten().map(String::as_str).collect();
        let mut seen = HashSet::new();
        let keep: Vec<bool> = held
            .iter()
            .flatten()
            .map(|id| names.contains(id.as_str()) && seen.insert(id.as_str()))
            .collect();
        for at in (0..keep.len()).rev() {
            if !keep[at] {
                list.remove(txn, at as u32);
            }
        }
        let mut current: Vec<String> = held
            .into_iter()
            .flatten()
            .zip(keep)
            .filter_map(|(id, kept)| kept.then_some(id))
            .collect();
        for (at, (item, id)) in items.iter().zip(wanted.into_iter().flatten()).enumerate() {
            let found = current
                .get(at..)
                .and_then(|rest| rest.iter().position(|held| *held == id))
                .map(|offset| offset + at);
            match found {
                Some(found) if found == at => {
                    if let Some(Out::YMap(map)) = list.get(txn, at as u32) {
                        edit_map(txn, &map, &entries(item), &[]);
                    }
                }
                Some(found) => {
                    list.remove(txn, found as u32);
                    current.remove(found);
                    insert(txn, at as u32, item);
                    current.insert(at, id);
                }
                None => {
                    insert(txn, at as u32, item);
                    current.insert(at, id);
                }
            }
        }
        return;
    }
    for (at, item) in items.iter().enumerate() {
        match list.get(txn, at as u32) {
            Some(Out::YMap(map)) => edit_map(txn, &map, &entries(item), &[]),
            Some(_) => {
                list.remove(txn, at as u32);
                insert(txn, at as u32, item);
            }
            None => insert(txn, at as u32, item),
        }
    }
    let len = list.len(txn);
    if len as usize > items.len() {
        list.remove_range(txn, items.len() as u32, len - items.len() as u32);
    }
}

/// `YText.delete`: Yjs deletes what is there and stops at the end (a Slate
/// tree can run ahead of its document after Yjs dropped a newline).
fn remove(txn: &mut TransactionMut, parent: BranchPtr, index: u32, len: u32) {
    let text = XmlTextRef::from(parent);
    let available = text.len(txn).saturating_sub(index);
    let len = len.min(available);
    if len > 0 {
        text.remove_range(txn, index, len);
    }
}

/// `YText.format`: past the end, Yjs pads the text with newlines carrying
/// the format (`formatText`'s Quill rule).
fn format(txn: &mut TransactionMut, parent: BranchPtr, index: u32, len: u32, attributes: Attrs) {
    let text = XmlTextRef::from(parent);
    let total = text.len(txn);
    let index = index.min(total);
    let available = len.min(total - index);
    if available > 0 || len == 0 {
        text.format(txn, index, available, attributes.clone());
    }
    if len > available {
        let padding = "
"
        .repeat((len - available) as usize);
        text.insert_with_attributes(txn, index + available, &padding, attributes);
    }
}

/// `applySlateOp`: maps one operation onto the document, against `root` as
/// it was before the operation.
pub fn apply_op(
    txn: &mut TransactionMut,
    y_root: BranchPtr,
    root: &Root,
    op: &Operation,
) -> Result<(), MapError> {
    let slate = &root.children;
    match op {
        Operation::InsertText { path, offset, text } => {
            let target = y_target(y_root, slate, path)?;
            let node = root.get(path).filter(|n| slate::is_text(n));
            let Some(node) = node else {
                return path_error("Cannot insert text into non-text node");
            };
            if !text.is_empty() {
                XmlTextRef::from(target.parent).insert_with_attributes(
                    txn,
                    target.start + *offset as u32,
                    text,
                    attrs(properties(node)),
                );
            }
        }
        Operation::RemoveText { path, offset, text } => {
            let target = y_target(y_root, slate, path)?;
            remove(
                txn,
                target.parent,
                target.start + *offset as u32,
                len16(text) as u32,
            );
        }
        Operation::InsertNode { path, node } => {
            let target = y_target(y_root, slate, path)?;
            let parent = XmlTextRef::from(target.parent);
            if slate::is_text(node) {
                let text = slate::text(node);
                if !text.is_empty() {
                    parent.insert_with_attributes(txn, target.start, text, attrs(properties(node)));
                }
            } else {
                parent.insert_embed_with_attributes(
                    txn,
                    target.start,
                    ElementPrelim::from_node(node),
                    Attrs::new(),
                );
            }
        }
        Operation::RemoveNode { path, .. } => {
            let target = y_target(y_root, slate, path)?;
            remove(txn, target.parent, target.start, target.end - target.start);
        }
        Operation::SetNode {
            path,
            properties: old,
            new_properties,
        } => {
            let target = y_target(y_root, slate, path)?;
            if let Some(element) = target.target {
                let element = XmlTextRef::from(element);
                let kind = match new_properties.get("type") {
                    Some(Value::String(kind)) => kind.clone(),
                    _ => match element.get_attribute(txn, "type") {
                        Some(Out::Any(Any::String(kind))) => kind.to_string(),
                        _ => String::new(),
                    },
                };
                for (key, value) in new_properties {
                    let held = element.get_attribute(txn, key);
                    match (held, value_to_any(value)) {
                        _ if value.is_null() => {
                            element.remove_attribute(txn, key);
                        }
                        // A source text takes the change as a text diff, so
                        // typing that reaches the room meanwhile stays.
                        (Some(Out::YText(held)), Any::String(next)) => {
                            edit_text(txn, &held, &next);
                        }
                        // A figure's block map takes it entry by entry, so a
                        // peer's change to another entry stays (Epo 2026-10-17).
                        (Some(Out::YMap(held)), Any::Map(next)) => {
                            edit_map(txn, &held, &next, plate::lists_of(&kind));
                        }
                        (_, Any::Map(next)) if plate::holds_map(&kind, key) => {
                            let map =
                                element.insert_attribute(txn, key.as_str(), MapPrelim::default());
                            edit_map(txn, &map, &next, plate::lists_of(&kind));
                        }
                        (_, value) => {
                            element.insert_attribute(txn, key.as_str(), value);
                        }
                    }
                }
                for key in old.keys() {
                    if !new_properties.contains_key(key) {
                        element.remove_attribute(txn, key);
                    }
                }
            } else {
                let mut attributes: HashMap<Arc<str>, Any> = old
                    .keys()
                    .map(|k| (Arc::from(k.as_str()), Any::Null))
                    .collect();
                for (key, value) in new_properties {
                    attributes.insert(Arc::from(key.as_str()), value_to_any(value));
                }
                format(
                    txn,
                    target.parent,
                    target.start,
                    target.end - target.start,
                    attributes,
                );
            }
        }
        Operation::MergeNode { path, .. } => {
            let target = y_target(y_root, slate, path)?;
            let Some(prev_index) = path.last().and_then(|i| i.checked_sub(1)) else {
                return path_error("Cannot get the previous path of a first child path");
            };
            let prev = y_target(target.parent, target.slate_parent, &[prev_index])?;
            if target.target.is_some() != prev.target.is_some() {
                return path_error("Cannot merge y text with y element");
            }
            match (prev.target, target.target) {
                (Some(prev_element), Some(element)) => {
                    let at = XmlTextRef::from(prev_element).len(txn);
                    let delta = clone_delta(&plate::insert_delta(&element)?)?;
                    insert_children(txn, prev_element, at, delta, true);
                    remove(txn, target.parent, target.start, target.end - target.start);
                }
                _ => {
                    let Some(node) = target.slate_target else {
                        return path_error("Expected Slate target node for merge op.");
                    };
                    let Some(prev_node) = prev.slate_target.filter(|n| slate::is_text(n)) else {
                        return path_error("Path points to Y.Text but not a Slate text node.");
                    };
                    let prev_props = properties(prev_node);
                    let mut attributes: Attrs = properties(node)
                        .into_iter()
                        .filter(|(key, _)| !prev_props.iter().any(|(k, _)| k == key))
                        .map(|(key, _)| (Arc::from(key.as_str()), Any::Null))
                        .collect();
                    for (key, value) in prev_props {
                        attributes.insert(Arc::from(key.as_str()), value);
                    }
                    format(
                        txn,
                        target.parent,
                        target.start,
                        target.end - target.start,
                        attributes,
                    );
                }
            }
        }
        Operation::SplitNode {
            path,
            position,
            properties: props,
        } => {
            let target = y_target(y_root, slate, path)?;
            let Some(node) = target.slate_target else {
                return path_error("Y target without corresponding slate node");
            };
            match target.target {
                None => {
                    if !slate::is_text(node) {
                        return path_error("Mismatch node type between y target and slate node");
                    }
                    let mut attributes: Attrs = Attrs::new();
                    for op in &target.target_delta {
                        for attr in &op.attributes {
                            attributes.insert(attr.key.clone(), Any::Null);
                        }
                    }
                    for (key, value) in props {
                        attributes.insert(Arc::from(key.as_str()), value_to_any(value));
                    }
                    format(
                        txn,
                        target.parent,
                        target.start,
                        target.end - target.start,
                        attributes,
                    );
                }
                Some(element) => {
                    if slate::is_text(node) {
                        return path_error("Mismatch node type between y target and slate node");
                    }
                    let children = slate::children(node);
                    let split_at = y_offset(children, *position);
                    let length = y_offset(children, children.len());
                    let split_delta =
                        slice_delta(plate::insert_delta(&element)?, split_at, length - split_at);
                    let prelim = ElementPrelim {
                        properties: props
                            .iter()
                            .map(|(k, v)| (k.clone(), value_to_any(v)))
                            .collect(),
                        children: clone_delta(&split_delta)?,
                        properties_last: true,
                    };
                    let element_ref = XmlTextRef::from(element);
                    let total = element_ref.len(txn);
                    if total > split_at {
                        element_ref.remove_range(txn, split_at, total - split_at);
                    }
                    XmlTextRef::from(target.parent).insert_embed_with_attributes(
                        txn,
                        target.end,
                        prelim,
                        Attrs::new(),
                    );
                }
            }
        }
        Operation::MoveNode { path, new_path } => {
            let new_parent = slate::parent(new_path);
            let Some(&new_index) = new_path.last() else {
                return path_error("Cannot move to the root");
            };
            let Some(siblings) = root.children_at(&new_parent) else {
                return path_error("Cannot move slate node into text element");
            };
            let mut normalized = new_parent.clone();
            normalized.push(new_index.min(siblings.len()));
            let origin = y_target(y_root, slate, path)?;
            let target = y_target(y_root, slate, &normalized)?;
            let delta = clone_delta(&origin.target_delta)?;
            remove(txn, origin.parent, origin.start, origin.end - origin.start);
            let target_len = XmlTextRef::from(target.parent).len(txn);
            insert_children(
                txn,
                target.parent,
                target.start.min(target_len),
                delta,
                true,
            );
        }
        Operation::SetSelection {} => {}
    }
    Ok(())
}

/// Applies operations as one flush (`flushLocalChanges`): each is mapped
/// against the tree before it, then applied to the tree.
pub fn apply_ops(
    txn: &mut TransactionMut,
    y_root: BranchPtr,
    root: &mut Root,
    ops: &[Operation],
) -> Result<(), MapError> {
    for op in ops {
        apply_op(txn, y_root, root, op)?;
        root.apply(op)?;
    }
    Ok(())
}

/// `parent.applyDelta(slateNodesToInsertDelta(nodes))` from `index`: Plate
/// nodes into a text, as the bootstrap from `materials.content` writes them.
pub fn insert_nodes(txn: &mut TransactionMut, parent: BranchPtr, index: u32, nodes: &[Value]) {
    let children = nodes
        .iter()
        .map(|node| {
            if slate::is_text(node) {
                Child::Text(slate::text(node).into(), attrs(properties(node)))
            } else {
                Child::Element(ElementPrelim::from_node(node), Attrs::new())
            }
        })
        .collect();
    insert_children(txn, parent, index, children, false);
}

/// A fresh document state (v1 update) holding `value`: the first open of a
/// note from `materials.content` (`load`'s bootstrap) and the compaction
/// rebuild. `client_id` 0 picks a random one, as the Node server's scratch
/// document does.
pub fn state_from_value(value: &[Value], client_id: u64) -> Vec<u8> {
    use yrs::{ReadTxn, Transact};
    let doc = yrs::Doc::with_options(ydoc::doc_options(client_id));
    doc.get_or_insert_text(plate::CONTENT_ROOT);
    let mut txn = doc.transact_mut();
    if let Some(root) = plate::content_root(&txn) {
        insert_nodes(&mut txn, root, 0, value);
    }
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
}
