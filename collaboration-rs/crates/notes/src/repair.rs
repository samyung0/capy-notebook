//! Canonical repairs the server writes into a note (Epo 2026-10-19): a rule
//! an edit breaks is first repaired cheaply on entry, else refused on entry
//! (`limits::Validator::admit`), else repaired at save, otherwise the room
//! resets. Each repair is a server transaction every editor receives.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::json;
use yrs::block::ItemContent;
use yrs::branch::BranchPtr;
use yrs::types::TypeRef;
use yrs::{Any, ReadTxn, Text, TransactionMut, Update, Xml, XmlTextRef};

use crate::plate::{self, Insert};
use crate::questions::js_trim;
use crate::{catalog, slate_yjs};

/// What [on_entry] and [repair] report for an emptied note.
pub const EMPTIED: &str = "an empty paragraph in an emptied note";
/// What [on_entry] reports for keys it removed.
pub const STRIPPED: &str = "element keys no node carries";
/// What [repair] reports for repeated top-level ids.
pub const REPEATED_IDS: &str = "fresh ids for repeated top-level ids";

/// An element key no stored node carries that may sit in the room until the
/// entry repair removes it (peers seeing it meanwhile is harmless): `text`,
/// which would make the element read as a leaf, and the obsolete
/// suggestions. Keys whose value must never reach a peer are refused at
/// admission instead.
pub fn stripped_key(key: &str) -> bool {
    key == "text" || key == "suggestion" || key.starts_with("suggestion_")
}

/// The entry repair, after an admitted update is applied: removes each
/// element key the update wrote that [stripped_key] names, or that the
/// element's type forbids and the update set to null (admission takes null as
/// absent, while a video's own check refuses `assetId: null` by its
/// presence), and gives an emptied note one empty paragraph. O(update) plus
/// O(1) reads of the room. What it repaired.
pub fn on_entry(txn: &mut TransactionMut, update: &Update, kind: &str) -> Vec<&'static str> {
    let mut repaired = Vec::new();
    let mut stripped: Vec<(BranchPtr, Arc<str>)> = Vec::new();
    {
        let store = ReadTxn::store(txn);
        for item in ydoc::Incoming::new(update).items() {
            // As integrated: an entry written after another takes its key
            // and element from it.
            let Some(held) = store.get_item(item.id()) else {
                continue;
            };
            if held.is_deleted() {
                continue;
            }
            if let (Some(key), Some(element)) = (held.parent_sub(), held.parent_branch())
                && element.item().is_some()
                && matches!(element.type_ref(), TypeRef::XmlText)
                && (stripped_key(key)
                    || (matches!(held.content(), ItemContent::Any(values) if matches!(values.last(), Some(Any::Null)))
                        && forbids(element, key)))
            {
                stripped.push((element, key.clone()));
            }
        }
    }
    if !stripped.is_empty() {
        for (element, key) in stripped {
            XmlTextRef::from(element).remove_attribute(txn, &key);
        }
        repaired.push(STRIPPED);
    }
    if emptied(txn, kind) {
        repaired.push(EMPTIED);
    }
    repaired
}

/// The save repair, when the store refuses the document: an emptied note's
/// paragraph (an edit no admission saw, such as the children pass) and a
/// fresh id for each top-level block repeating an earlier one's id, which no
/// entry check sees (it would read every top-level id per new block). What
/// it repaired.
pub fn repair(txn: &mut TransactionMut, kind: &str) -> Vec<&'static str> {
    let mut repaired = Vec::new();
    if emptied(txn, kind) {
        repaired.push(EMPTIED);
    }
    if repeated_ids(txn) {
        repaired.push(REPEATED_IDS);
    }
    repaired
}

/// A note (a kind that requires no element) whose root holds no block gets
/// `{"type":"p","id":…,"children":[{"text":""}]}`. Two writers each deleting
/// one of the last two blocks leave it so, and no single update shows it.
fn emptied(txn: &mut TransactionMut, kind: &str) -> bool {
    if !catalog::material_kind(kind).is_some_and(|kind| kind.requires.is_none()) {
        return false;
    }
    let Some(root) = plate::content_root(txn) else {
        return false;
    };
    // The root's live length: admission keeps text out of it, so zero means
    // no block.
    if XmlTextRef::from(root).len(txn) != 0 {
        return false;
    }
    let paragraph = json!({ "type": "p", "id": "repaired", "children": [{ "text": "" }] });
    slate_yjs::insert_nodes(txn, root, 0, &[paragraph]);
    true
}

/// Gives each top-level block whose trimmed id an earlier one holds a fresh
/// id (`<id>-<n>`, taken by no block). The first in document order keeps it.
fn repeated_ids(txn: &mut TransactionMut) -> bool {
    let Some(root) = plate::content_root(txn) else {
        return false;
    };
    let Ok(delta) = plate::insert_delta(&root) else {
        return false;
    };
    let blocks: Vec<(BranchPtr, Option<String>)> = delta
        .into_iter()
        .filter_map(|op| match op.insert {
            Insert::Element(block) => Some((block, id_of(block))),
            Insert::Text(_) => None,
        })
        .collect();
    let mut taken: HashSet<String> = blocks.iter().filter_map(|(_, id)| id.clone()).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut renamed = Vec::new();
    for (block, id) in blocks {
        let Some(id) = id else { continue };
        if seen.insert(id.clone()) {
            continue;
        }
        let fresh = (2..)
            .map(|n| format!("{id}-{n}"))
            .find(|candidate| !taken.contains(candidate))
            .unwrap_or_default();
        taken.insert(fresh.clone());
        renamed.push((block, fresh));
    }
    let any = !renamed.is_empty();
    for (block, fresh) in renamed {
        XmlTextRef::from(block).insert_attribute(txn, "id", fresh);
    }
    any
}

/// Whether the catalog forbids `key` on the element's live type.
fn forbids(element: BranchPtr, key: &str) -> bool {
    let kind = element
        .entry_item("type")
        .filter(|entry| !entry.is_deleted())
        .and_then(|entry| match entry.content() {
            ItemContent::Any(values) => match values.last() {
                Some(Any::String(kind)) => Some(kind.clone()),
                _ => None,
            },
            _ => None,
        });
    kind.and_then(|kind| catalog::element(&kind))
        .is_some_and(|element| element.forbidden.contains(&key))
}

/// A block's live `id`, trimmed as the store compares it.
fn id_of(block: BranchPtr) -> Option<String> {
    let entry = block.entry_item("id").filter(|entry| !entry.is_deleted())?;
    match entry.content() {
        ItemContent::Any(values) => match values.last() {
            Some(Any::String(id)) if !js_trim(id).is_empty() => Some(js_trim(id).to_owned()),
            _ => None,
        },
        _ => None,
    }
}
