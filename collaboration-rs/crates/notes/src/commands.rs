//! The gateway's `replace-block` collaboration command
//! (`collaboration/src/commands.ts`): one stable block replaced through the
//! headless editor, refused when the block moved on.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use yrs::branch::{Branch, BranchPtr};
use yrs::{TextRef, TransactionMut};

use crate::slate::editor::{Editor, EditorError};
use crate::slate::{Path, children, is_element, is_text};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceBlock {
    pub actor_user_id: String,
    pub expected_block: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<i64>,
    pub material_id: String,
    pub replacement_block: Value,
    pub room: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error("{0}")]
    Refused(String),
    #[error(transparent)]
    Editor(#[from] EditorError),
}

fn refuse<T>(message: &str) -> Result<T, CommandError> {
    Err(CommandError::Refused(message.into()))
}

/// `stableId`: the trimmed id, or "".
fn stable_id(node: &Value) -> String {
    node.get("id")
        .and_then(Value::as_str)
        .map(|id| crate::questions::js_trim(id).to_owned())
        .unwrap_or_default()
}

/// Node's `isDeepStrictEqual` over JSON: objects by keys in any order,
/// numbers by value.
fn deep_strict_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| deep_strict_equal(v, w)))
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(v, w)| deep_strict_equal(v, w))
        }
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

/// The first element (pre-order) with this `id`.
fn find(nodes: &[Value], id: &str, path: &mut Path) -> Option<(Value, Path)> {
    for (i, node) in nodes.iter().enumerate() {
        path.push(i);
        if is_element(node) && node.get("id").and_then(Value::as_str) == Some(id) {
            return Some((node.clone(), path.clone()));
        }
        if !is_text(node)
            && let Some(found) = find(children(node), id, path)
        {
            return Some(found);
        }
        path.pop();
    }
    None
}

/// `applyCollaborationCommand`.
pub fn replace_block(
    txn: &mut TransactionMut,
    root: &TextRef,
    command: &ReplaceBlock,
) -> Result<(), CommandError> {
    let expected_id = stable_id(&command.expected_block);
    if expected_id.is_empty() || expected_id != stable_id(&command.replacement_block) {
        return refuse("replacement must preserve a stable block ID");
    }
    let kind = command.expected_block.get("type");
    if kind != command.replacement_block.get("type") || !kind.is_some_and(Value::is_string) {
        return refuse("replacement must preserve the block type");
    }
    if !command
        .replacement_block
        .get("children")
        .is_some_and(Value::is_array)
    {
        return refuse("replacement block requires children");
    }
    let y_root = BranchPtr::from(root.as_ref() as &Branch);
    let mut editor = Editor::open(txn, y_root)?;
    let Some((current, path)) = find(&editor.root.children, &expected_id, &mut Vec::new()) else {
        return refuse("target block no longer exists");
    };
    if command.expected_revision.is_some() && !deep_strict_equal(&current, &command.expected_block)
    {
        return refuse("target block changed concurrently");
    }
    if deep_strict_equal(&current, &command.replacement_block) {
        return Ok(());
    }
    if !deep_strict_equal(&current, &command.expected_block) {
        return refuse("target block changed concurrently");
    }
    // A figure keeping its keys changes in place: its `set_node` writes only
    // the figure map's entries that differ (`figure_map::sync`, Epo
    // 2026-11-16), so a peer's edit to another element or value stays.
    let figure = kind
        .and_then(Value::as_str)
        .is_some_and(crate::figure_map::is_figure);
    if figure && same_keys(&current, &command.replacement_block) {
        let mut props = command
            .replacement_block
            .as_object()
            .cloned()
            .unwrap_or_default();
        props.remove("children");
        editor.set_nodes_at(path, &props)?;
        return Ok(());
    }
    let replacement = command.replacement_block.clone();
    editor.without_normalizing(|editor| {
        editor.remove_node(path.clone())?;
        editor.insert_nodes(path, vec![replacement])
    })?;
    Ok(())
}

/// Whether two elements carry the same keys.
fn same_keys(a: &Value, b: &Value) -> bool {
    match (a.as_object(), b.as_object()) {
        (Some(a), Some(b)) => a.len() == b.len() && a.keys().all(|key| b.contains_key(key)),
        _ => false,
    }
}
