//! A blocks room's children, as `notes::children` reads them from a Plate
//! room: the asset ids and material references an update wrote (an image's
//! `sourceId`, an audio block's `assetId`, a `capy:material-ref`'s
//! `materialId`), and repointing or dropping those blocks from the API's
//! answer. The server asks the API (`server/src/children.rs`).

use std::collections::{BTreeMap, HashSet};

use yrs::block::ItemContent;
use yrs::types::TypeRef;
use yrs::{Any, Array, Map as _, MapRef, ReadTxn, TransactionMut, Update, UpdateBlock};

use crate::schema::{AUDIO, IMAGE, MATERIAL_REF};
use crate::store::{child_array, child_ids, string, yblock};
use crate::{BLOCKS_ROOT, NOTE_ID};

const MATERIAL_PROP: &str = "prop:materialId";

/// The prop holding a block's asset id, by flavour.
fn asset_prop(flavour: &str) -> Option<&'static str> {
    match flavour {
        IMAGE => Some("prop:sourceId"),
        AUDIO => Some("prop:assetId"),
        _ => None,
    }
}

/// The child ids an update wrote, read in the room it was applied to: asset
/// ids in write order, and the ids of the reference blocks whose
/// `materialId` it wrote.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChildWrites {
    pub asset_ids: Vec<String>,
    pub blocks: Vec<String>,
}

/// Call after the update was applied to `txn`'s document. A prop is a map
/// entry of its yBlock, and only the item in the document knows its key.
/// Typing writes no ContentAny item, so most updates cost a decode.
pub fn child_writes<T: ReadTxn>(txn: &T, update: &Update) -> Option<ChildWrites> {
    let store = txn.store();
    let mut writes = ChildWrites::default();
    let (mut assets, mut blocks) = (HashSet::new(), HashSet::new());
    // Yjs writes (and decodes) clients in descending id order.
    let mut items: Vec<_> = update
        .blocks()
        .filter_map(|block| match block {
            UpdateBlock::Item(item) => Some(item),
            _ => None,
        })
        .collect();
    items.sort_by_key(|item| (std::cmp::Reverse(item.id().client.get()), item.id().clock));
    let held = txn.state_vector();
    for decoded in items {
        if !matches!(decoded.content(), ItemContent::Any(_)) {
            continue;
        }
        // Only an id the room holds is looked up: a pass may read an update
        // the room has not applied.
        let id = decoded.id();
        if id.clock >= held.get(&id.client) {
            continue;
        }
        let Some(item) = store.get_item(id) else {
            continue;
        };
        if item.is_deleted() {
            continue;
        }
        let (ItemContent::Any(values), Some(key)) = (item.content(), item.parent_sub()) else {
            continue;
        };
        let Some(Any::String(value)) = values.first() else {
            continue;
        };
        let Some(parent) = item.parent_branch() else {
            continue;
        };
        if value.is_empty() || !matches!(parent.type_ref(), TypeRef::Map) {
            continue;
        }
        let block = MapRef::from(parent);
        let Some(flavour) = string(txn, &block, "sys:flavour") else {
            continue;
        };
        if Some(&**key) == asset_prop(&flavour) {
            if assets.insert(value.to_string()) {
                writes.asset_ids.push(value.to_string());
            }
        } else if &**key == MATERIAL_PROP
            && flavour == MATERIAL_REF
            // The block's id is its key in the blocks map.
            && let Some(block_id) = parent.item().and_then(|item| item.parent_sub().cloned())
            && blocks.insert(block_id.to_string())
        {
            writes.blocks.push(block_id.to_string());
        }
    }
    (!writes.asset_ids.is_empty() || !writes.blocks.is_empty()).then_some(writes)
}

/// The note's material references in document order: (block id, material
/// id), the empty ones left out. They sit directly under the note.
pub fn material_refs<T: ReadTxn>(txn: &T) -> Vec<(String, String)> {
    let Some(root) = txn.get_map(BLOCKS_ROOT) else {
        return Vec::new();
    };
    let Some(note) = yblock(txn, &root, NOTE_ID) else {
        return Vec::new();
    };
    child_ids(txn, &note)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|id| {
            let block = yblock(txn, &root, &id)?;
            if string(txn, &block, "sys:flavour")? != MATERIAL_REF {
                return None;
            }
            let material = string(txn, &block, MATERIAL_PROP).filter(|m| !m.is_empty())?;
            Some((id, material))
        })
        .collect()
}

/// Repoints the blocks whose child moved (`assets`: asset id → the
/// material's own, `blocks`: reference block id → its material id; "" drops
/// the block). Blocks are found by id at apply time. Whether it wrote.
pub fn apply(
    txn: &mut TransactionMut,
    assets: &BTreeMap<String, String>,
    blocks: &BTreeMap<String, String>,
) -> bool {
    let Some(root) = txn.get_map(BLOCKS_ROOT) else {
        return false;
    };
    let mut ids: Vec<String> = root.keys(txn).map(str::to_string).collect();
    ids.sort();
    // (block, its prop, the new value or none to drop it)
    let mut changes: Vec<(String, &'static str, Option<String>)> = Vec::new();
    for id in &ids {
        let Some(block) = yblock(txn, &root, id) else {
            continue;
        };
        let Some(flavour) = string(txn, &block, "sys:flavour") else {
            continue;
        };
        let (prop, to) = if flavour == MATERIAL_REF && blocks.contains_key(id) {
            let current = string(txn, &block, MATERIAL_PROP);
            match blocks.get(id) {
                Some(to) if Some(to) != current.as_ref() => (MATERIAL_PROP, to),
                _ => continue,
            }
        } else if let Some(prop) = asset_prop(&flavour)
            && let Some(asset) = string(txn, &block, prop)
            && let Some(to) = assets.get(&asset).filter(|to| **to != asset)
        {
            (prop, to)
        } else {
            continue;
        };
        changes.push((
            id.clone(),
            prop,
            Some(to.clone()).filter(|to| !to.is_empty()),
        ));
    }
    for (id, prop, to) in &changes {
        match to {
            Some(to) => {
                if let Some(block) = yblock(txn, &root, id) {
                    block.insert(txn, *prop, to.as_str());
                }
            }
            None => remove(txn, &root, &ids, id),
        }
    }
    !changes.is_empty()
}

/// Takes a leaf block out of every parent listing it, then out of the map.
fn remove(txn: &mut TransactionMut, root: &MapRef, ids: &[String], id: &str) {
    for parent in ids {
        let Some(block) = yblock(txn, root, parent) else {
            continue;
        };
        let Some(array) = child_array(txn, &block) else {
            continue;
        };
        let listed: Vec<u32> = child_ids(txn, &block)
            .unwrap_or_default()
            .iter()
            .enumerate()
            .filter(|(_, child)| *child == id)
            .map(|(index, _)| index as u32)
            .collect();
        for index in listed.into_iter().rev() {
            array.remove(txn, index);
        }
    }
    root.remove(txn, id);
}
