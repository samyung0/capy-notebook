//! A note's children (`collaboration/src/children.ts`): the asset and quiz
//! ids a writer's update wrote, what to ask the API for, and repointing or
//! dropping nodes from its answer. The server makes the API call and applies
//! the answer in the room.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use yrs::block::ItemContent;
use yrs::branch::{Branch, BranchID, BranchPtr};
use yrs::{Any, ReadTxn, TextRef, TransactionMut, Update, UpdateBlock};

use crate::material::MATERIAL_REF_TYPE;
use crate::slate::editor::{Editor, EditorError};
use crate::slate::{Path, children, is_element, is_text};

pub const ASSET_KEY: &str = "assetId";
pub const MATERIAL_KEY: &str = "materialId";

/// The child ids an update wrote, looked up in the room it was applied to:
/// the asset ids in write order, and the `material_ref` blocks (by their
/// Y.XmlText) whose `materialId` it wrote.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChildWrites {
    pub asset_ids: Vec<String>,
    pub blocks: Vec<BranchID>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockRequest {
    pub block_id: String,
    /// Another block keeps this quiz: this one asks for its own copy.
    pub copy: bool,
    pub material_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildPlan {
    pub asset_ids: Vec<String>,
    pub blocks: Vec<BlockRequest>,
}

/// Asset id or block id → the material's own child id, or "" to drop it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChildAnswer {
    pub assets: BTreeMap<String, String>,
    pub blocks: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptIds {
    pub asset_ids: Vec<String>,
    pub material_ids: Vec<String>,
}

fn attribute(branch: &Branch, key: &str) -> Option<Any> {
    branch
        .map_items()
        .find(|(k, item)| &***k == key && !item.is_deleted())
        .and_then(|(_, item)| match item.content() {
            ItemContent::Any(values) => values.last().cloned(),
            _ => None,
        })
}

/// `childWrites`: call after the update was applied to `txn`'s document.
/// Element properties are attributes of their Y.XmlText, and only the item in
/// the document knows its key (a decoded overwrite carries none). Typing
/// writes no ContentAny item, so most updates cost a decode and nothing more.
pub fn child_writes<T: ReadTxn>(txn: &T, update: &Update) -> Option<ChildWrites> {
    let store = txn.store();
    let mut writes = ChildWrites::default();
    let mut assets = HashSet::new();
    let mut blocks = HashSet::new();
    // Yjs writes (and decodes) clients in descending id order.
    let mut items: Vec<_> = update
        .blocks()
        .filter_map(|block| match block {
            UpdateBlock::Item(item) => Some(item),
            _ => None,
        })
        .collect();
    items.sort_by_key(|item| (std::cmp::Reverse(item.id().client.get()), item.id().clock));
    for decoded in items {
        if !matches!(decoded.content(), ItemContent::Any(_)) {
            continue;
        }
        let Some(item) = store.get_item(decoded.id()) else {
            continue;
        };
        if item.is_deleted() {
            continue;
        }
        let ItemContent::Any(values) = item.content() else {
            continue;
        };
        let Some(Any::String(value)) = values.first() else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        let key = item.parent_sub().map(|k| &**k);
        if key == Some(ASSET_KEY) {
            if assets.insert(value.to_string()) {
                writes.asset_ids.push(value.to_string());
            }
        } else if key == Some(MATERIAL_KEY) {
            let Some(parent) = item.parent_branch() else {
                continue;
            };
            let is_ref = matches!(parent.type_ref(), yrs::types::TypeRef::XmlText)
                && matches!(attribute(&parent, "type"), Some(Any::String(t)) if &*t == MATERIAL_REF_TYPE);
            if is_ref && blocks.insert(parent.id()) {
                writes.blocks.push(parent.id());
            }
        }
    }
    (!writes.asset_ids.is_empty() || !writes.blocks.is_empty()).then_some(writes)
}

/// `planChildren`: every written asset id, and each written quiz block. A
/// quiz now in several blocks stays with one of them, the first that the
/// update did not write (it keeps the original) or else the first in the
/// document; every other block asks for a copy. Blocks are top-level.
pub fn plan(root: &Branch, writes: &ChildWrites) -> ChildPlan {
    struct Ref {
        block: BranchID,
        block_id: String,
        material_id: String,
    }
    let mut refs = Vec::new();
    let mut next = root.start();
    while let Some(item) = next {
        next = item.right();
        if item.is_deleted() {
            continue;
        }
        let ItemContent::Type(branch) = item.content() else {
            continue;
        };
        let branch = BranchPtr::from(branch.as_ref());
        if !matches!(branch.type_ref(), yrs::types::TypeRef::XmlText) {
            continue;
        }
        let kind = attribute(&branch, "type");
        let id = attribute(&branch, "id");
        let material = attribute(&branch, MATERIAL_KEY);
        if let (Some(Any::String(kind)), Some(Any::String(id)), Some(Any::String(material))) =
            (kind, id, material)
        {
            if &*kind == MATERIAL_REF_TYPE && !material.is_empty() {
                refs.push(Ref {
                    block: branch.id(),
                    block_id: id.to_string(),
                    material_id: material.to_string(),
                });
            }
        }
    }
    let mut kept: Vec<(String, BranchID)> = Vec::new();
    let keep = |kept: &mut Vec<(String, BranchID)>, r: &Ref| {
        if !kept.iter().any(|(m, _)| *m == r.material_id) {
            kept.push((r.material_id.clone(), r.block.clone()));
        }
    };
    for r in refs.iter().filter(|r| !writes.blocks.contains(&r.block)) {
        keep(&mut kept, r);
    }
    for r in &refs {
        keep(&mut kept, r);
    }
    ChildPlan {
        asset_ids: writes.asset_ids.clone(),
        blocks: refs
            .iter()
            .filter(|r| writes.blocks.contains(&r.block))
            .map(|r| BlockRequest {
                block_id: r.block_id.clone(),
                copy: kept
                    .iter()
                    .find(|(m, _)| *m == r.material_id)
                    .is_none_or(|(_, b)| *b != r.block),
                material_id: r.material_id.clone(),
            })
            .collect(),
    }
}

/// `applyChildren`: repoints nodes to the material's own children and drops
/// the rest through the headless editor, so the change is ordinary Slate
/// operations; nodes are found by id at apply time. Returns whether anything
/// changed. Opening the editor normalizes the document, as in the TS, even
/// when nothing changes.
pub fn apply(
    txn: &mut TransactionMut,
    root: &TextRef,
    answer: &ChildAnswer,
) -> Result<bool, EditorError> {
    let y_root = BranchPtr::from(root.as_ref() as &Branch);
    let mut editor = Editor::open(txn, y_root)?;
    let mut targets: Vec<(Value, Path)> = Vec::new();
    collect(&editor.root.children, answer, &mut Vec::new(), &mut targets);
    if targets.is_empty() {
        return Ok(false);
    }
    editor.without_normalizing(|editor| {
        // Last first, so removing one does not shift the paths still to go.
        for (node, path) in targets.into_iter().rev() {
            let id = node.get("id").and_then(Value::as_str).unwrap_or("");
            let is_ref = node.get("type").and_then(Value::as_str) == Some(MATERIAL_REF_TYPE);
            let (key, value) = if is_ref && answer.blocks.contains_key(id) {
                (MATERIAL_KEY, answer.blocks.get(id))
            } else {
                let asset = node.get(ASSET_KEY).and_then(Value::as_str).unwrap_or("");
                (ASSET_KEY, answer.assets.get(asset))
            };
            match value.filter(|v| !v.is_empty()) {
                Some(value) => {
                    let props = Map::from_iter([(key.to_owned(), Value::String(value.clone()))]);
                    editor.set_nodes_at(path, &props)?;
                }
                None => editor.remove_node(path)?,
            }
        }
        Ok(())
    })?;
    Ok(true)
}

fn collect(nodes: &[Value], answer: &ChildAnswer, path: &mut Path, out: &mut Vec<(Value, Path)>) {
    for (i, node) in nodes.iter().enumerate() {
        path.push(i);
        if is_element(node) {
            let asset = node.get(ASSET_KEY).and_then(Value::as_str);
            let asset_moves = asset.is_some_and(|a| answer.assets.get(a).is_some_and(|to| to != a));
            let id = node.get("id").and_then(Value::as_str);
            let is_ref = node.get("type").and_then(Value::as_str) == Some(MATERIAL_REF_TYPE);
            let current = node.get(MATERIAL_KEY).and_then(Value::as_str);
            let block_moves = is_ref
                && id.is_some_and(|id| {
                    answer
                        .blocks
                        .get(id)
                        .is_some_and(|to| Some(to.as_str()) != current)
                });
            if asset_moves || block_moves {
                out.push((node.clone(), path.clone()));
            }
        }
        if !is_text(node) {
            collect(children(node), answer, path, out);
        }
        path.pop();
    }
}

/// `keptIds`: ids an answer kept as they are (the material's own children,
/// some just restored from the trash, which open editors load again).
pub fn kept_ids(plan: &ChildPlan, answer: &ChildAnswer) -> KeptIds {
    KeptIds {
        asset_ids: plan
            .asset_ids
            .iter()
            .filter(|id| answer.assets.get(*id) == Some(*id))
            .cloned()
            .collect(),
        material_ids: plan
            .blocks
            .iter()
            .filter(|b| answer.blocks.get(&b.block_id) == Some(&b.material_id))
            .map(|b| b.material_id.clone())
            .collect(),
    }
}
