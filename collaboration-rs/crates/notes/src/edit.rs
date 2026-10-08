//! Direct AI content edits on a Plate material or a plain-text source
//! (`collaboration/src/editCommands.ts` minus the Office guards, which
//! `sources` owns). Commands name stable targets (block ids, child node ids)
//! and the exact text they expect; they run on an isolated document built
//! from the durable state under the material lock, through the same headless
//! Slate editor as the Node server, so the change is ordinary Slate
//! operations. The caller commits the state with the receipt, the inverse
//! commands and the post-edit guards.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ydoc::guards::{GuardRun, guards_equal, range_guard};
use yrs::branch::{Branch, BranchPtr};
use yrs::{GetString, ReadTxn, Text, TextRef, TransactionMut};

use crate::material::MATERIAL_REF_TYPE;
use crate::plate;
use crate::slate::editor::{Editor, EditorError, Point};
use crate::slate::{self, Path, children, is_text, len16, slice16};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditErrorCode {
    InvalidInput,
    StaleTarget,
    UnavailableTarget,
    UnsupportedOperation,
}

#[derive(Debug, thiserror::Error)]
pub enum EditError {
    /// An `EditError` of the TS: answered to the agent with its code.
    #[error("{message}")]
    Edit {
        code: EditErrorCode,
        message: String,
    },
    /// Anything else the editor or the document raised (a 500 in the TS).
    #[error(transparent)]
    Editor(#[from] EditorError),
}

fn edit<T>(code: EditErrorCode, message: impl Into<String>) -> Result<T, EditError> {
    Err(EditError::Edit {
        code,
        message: message.into(),
    })
}

use EditErrorCode::{InvalidInput, StaleTarget, UnavailableTarget, UnsupportedOperation};

/// Same JSON as the TS `DocumentCommand`, stored in `agent_edit_inverses`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DocumentCommand {
    ReplaceText {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_id: Option<String>,
        expected_text: String,
        text: String,
        /// Set on inverses: replace exactly this span instead of searching.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset: Option<usize>,
    },
    InsertBlock {
        after_block_id: Option<String>,
        blocks: Vec<Value>,
    },
    RemoveBlock {
        block_id: String,
        expected_text: String,
    },
    ReplaceChild {
        parent_type: String,
        node_id: String,
        node: Value,
    },
    InsertChild {
        parent_type: String,
        after_node_id: Option<String>,
        node: Value,
    },
    RemoveChild {
        parent_type: String,
        node_id: String,
    },
    SetProperty {
        node_type: String,
        property: String,
        expected_value: String,
        value: String,
    },
}

/// One guarded region after an edit (`GuardTarget`); `office` targets are
/// built and checked by `sources`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum GuardTarget {
    Block {
        block_id: String,
        runs: Vec<GuardRun>,
    },
    Gap {
        after_block_id: Option<String>,
        runs: Vec<GuardRun>,
    },
    Child {
        parent_id: String,
        node_id: String,
        runs: Vec<GuardRun>,
    },
    ChildGap {
        parent_id: String,
        after_node_id: Option<String>,
        runs: Vec<GuardRun>,
    },
    Text {
        offset: usize,
        length: usize,
        /// The span's content after the edit, used to re-find a moved span.
        text: String,
        runs: Vec<GuardRun>,
    },
    Office {
        id: String,
        path: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        range: Option<[u32; 2]>,
        runs: Vec<GuardRun>,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EditOutcome {
    pub guards: Vec<GuardTarget>,
    pub inverse: Vec<DocumentCommand>,
}

const MEDIA_TYPES: [&str; 8] = [
    "img",
    "image",
    "video",
    "audio",
    "file",
    "media_embed",
    "youtube",
    "excalidraw",
];
pub const MAX_TEXT_EDIT_CHARS: usize = 200_000;

fn stable_id(node: &Value) -> String {
    node.get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// `String(value ?? '')`.
pub(crate) fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => crate::json::js_number(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_string(Some(item)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

fn has_media(node: &Value) -> bool {
    MEDIA_TYPES.contains(&js_string(node.get("type")).as_str())
        || node.get("assetId").is_some()
        || node
            .get("children")
            .and_then(Value::as_array)
            .is_some_and(|children| children.iter().any(has_media))
}

/// UTF-16 positions of the non-overlapping occurrences of `needle`.
fn occurrences(haystack: &str, needle: &str) -> Vec<usize> {
    if needle.is_empty() {
        return Vec::new();
    }
    haystack
        .match_indices(needle)
        .map(|(at, _)| len16(&haystack[..at]))
        .collect()
}

/// Slate point for a UTF-16 offset inside a block's concatenated text.
fn point_at(editor: &Editor, index: usize, offset: usize) -> Result<Point, EditError> {
    let mut remaining = offset;
    let mut last = None;
    let mut texts = Vec::new();
    collect_texts(
        editor.root.children.get(index),
        &mut vec![index],
        &mut texts,
    );
    for (path, text) in texts {
        let len = len16(&text);
        if remaining <= len {
            return Ok(Point {
                path,
                offset: remaining,
            });
        }
        remaining -= len;
        last = Some(Point { path, offset: len });
    }
    match last {
        Some(point) if remaining == 0 => Ok(point),
        _ => edit(StaleTarget, "text offset is outside the target"),
    }
}

fn collect_texts(node: Option<&Value>, path: &mut Path, out: &mut Vec<(Path, String)>) {
    let Some(node) = node else { return };
    if is_text(node) {
        out.push((path.clone(), slate::text(node).to_owned()));
        return;
    }
    for (i, child) in children(node).iter().enumerate() {
        path.push(i);
        collect_texts(Some(child), path, out);
        path.pop();
    }
}

fn top_level(editor: &Editor, predicate: impl Fn(&Value) -> bool) -> Option<(Value, usize)> {
    editor
        .root
        .children
        .iter()
        .position(predicate)
        .map(|index| (editor.root.children[index].clone(), index))
}

fn require_block(editor: &Editor, block_id: &str) -> Result<(Value, usize), EditError> {
    match top_level(editor, |node| stable_id(node) == block_id) {
        Some(entry) => Ok(entry),
        None => edit(
            UnavailableTarget,
            format!("block {block_id} no longer exists"),
        ),
    }
}

fn require_parent(editor: &Editor, parent_type: &str) -> Result<(Value, usize), EditError> {
    match top_level(editor, |node| {
        node.get("type").and_then(Value::as_str) == Some(parent_type)
    }) {
        Some(entry) => Ok(entry),
        None => edit(
            UnavailableTarget,
            format!("no {parent_type} block in this material"),
        ),
    }
}

fn child_index(parent: &Value, node_id: &str) -> Option<usize> {
    children(parent)
        .iter()
        .position(|child| stable_id(child) == node_id)
}

/// Nearest of `candidates` (from the end) that still exists, else none.
fn surviving(candidates: &[String], exists: impl Fn(&str) -> bool) -> Option<String> {
    candidates.iter().rev().find(|id| exists(id)).cloned()
}

fn assert_node_shape(node: &Value, what: &str) -> Result<(), EditError> {
    if !node.is_object()
        || stable_id(node).is_empty()
        || !node.get("type").is_some_and(Value::is_string)
    {
        return edit(
            InvalidInput,
            format!("{what} requires a typed node with a stable id"),
        );
    }
    if !node.get("children").is_some_and(Value::is_array) {
        return edit(InvalidInput, format!("{what} requires children"));
    }
    if has_media(node) {
        return edit(
            UnsupportedOperation,
            "media nodes cannot be inserted by an edit",
        );
    }
    Ok(())
}

/// `Node.string(node)`, which throws on an element without children.
fn node_string(node: &Value) -> Result<String, EditError> {
    fn walk(node: &Value, out: &mut String) -> bool {
        if is_text(node) {
            out.push_str(slate::text(node));
            return true;
        }
        match node.get("children").and_then(Value::as_array) {
            Some(children) => children.iter().all(|child| walk(child, out)),
            None => false,
        }
    }
    let mut out = String::new();
    if walk(node, &mut out) {
        Ok(out)
    } else {
        Err(EditorError::Slate(slate::SlateError(
            "Cannot read properties of undefined (reading 'map')".into(),
        ))
        .into())
    }
}

/// Where a remembered span sits now: at its stored offset when the text still
/// matches there, else at its unique occurrence, else nowhere. An empty span
/// can only be trusted at its offset.
fn anchor_span(current: &str, offset: usize, expected: &str) -> Option<usize> {
    if slice16(current, offset, offset + len16(expected)) == expected {
        return Some(offset);
    }
    let found = occurrences(current, expected);
    if expected.is_empty() || found.len() != 1 {
        return None;
    }
    Some(found[0])
}

/// `resolveSpan`: the span a command replaces, as UTF-16 offset and length.
fn resolve_span(
    current: &str,
    expected: &str,
    offset: Option<usize>,
) -> Result<(usize, usize), EditError> {
    let length = len16(expected);
    if length > MAX_TEXT_EDIT_CHARS {
        return edit(InvalidInput, "expected text is too long");
    }
    if let Some(offset) = offset {
        return match anchor_span(current, offset, expected) {
            Some(offset) => Ok((offset, length)),
            None => edit(StaleTarget, "the edited span changed"),
        };
    }
    if expected.is_empty() {
        return edit(
            InvalidInput,
            "expected_text must not be empty; include surrounding text",
        );
    }
    let found = occurrences(current, expected);
    match found.len() {
        0 => edit(StaleTarget, "expected text was not found in the target"),
        1 => Ok((found[0], length)),
        n => edit(
            InvalidInput,
            format!("expected text occurs {n} times; include more context"),
        ),
    }
}

/* ---------------------------------------------------------------- guards */

fn block_guard<T: ReadTxn>(
    txn: &T,
    root: &Branch,
    editor: &Editor,
    block_id: &str,
) -> Result<GuardTarget, EditError> {
    let (_, index) = require_block(editor, block_id)?;
    Ok(GuardTarget::Block {
        block_id: block_id.to_owned(),
        runs: range_guard(txn, root, index as u32, index as u32 + 1, 0),
    })
}

/// The nested Y.XmlText of the top-level element at `index`.
fn nested_type_at(root: &Branch, index: usize) -> Result<BranchPtr, EditError> {
    let mut position = 0;
    let mut next = root.start();
    while let Some(item) = next {
        next = item.right();
        if item.is_deleted() || !item.is_countable() {
            continue;
        }
        if position + item.len() as usize > index {
            if let Some(branch) = plate::xml_text(item) {
                return Ok(branch);
            }
            break;
        }
        position += item.len() as usize;
    }
    edit(StaleTarget, "the parent block is not an element")
}

fn child_guard<T: ReadTxn>(
    txn: &T,
    root: &Branch,
    editor: &Editor,
    parent_id: &str,
    node_id: &str,
) -> Result<GuardTarget, EditError> {
    let (parent, index) = require_block(editor, parent_id)?;
    let Some(at) = child_index(&parent, node_id) else {
        return edit(UnavailableTarget, format!("{node_id} no longer exists"));
    };
    Ok(GuardTarget::Child {
        node_id: node_id.to_owned(),
        parent_id: parent_id.to_owned(),
        runs: range_guard(
            txn,
            &*nested_type_at(root, index)?,
            at as u32,
            at as u32 + 1,
            0,
        ),
    })
}

fn child_gap_guard<T: ReadTxn>(
    txn: &T,
    root: &Branch,
    editor: &Editor,
    parent_id: &str,
    after_node_id: Option<&str>,
) -> Result<GuardTarget, EditError> {
    let (parent, index) = require_block(editor, parent_id)?;
    let at = match after_node_id {
        None => 0,
        Some(id) => match child_index(&parent, id) {
            Some(i) => i + 1,
            None => return edit(UnavailableTarget, format!("{id} no longer exists")),
        },
    };
    Ok(GuardTarget::ChildGap {
        after_node_id: after_node_id.map(str::to_owned),
        parent_id: parent_id.to_owned(),
        runs: range_guard(txn, &*nested_type_at(root, index)?, at as u32, at as u32, 1),
    })
}

fn gap_guard<T: ReadTxn>(
    txn: &T,
    root: &Branch,
    editor: &Editor,
    after_block_id: Option<&str>,
) -> Result<GuardTarget, EditError> {
    let index = match after_block_id {
        None => 0,
        Some(id) => require_block(editor, id)?.1 + 1,
    };
    Ok(GuardTarget::Gap {
        after_block_id: after_block_id.map(str::to_owned),
        runs: range_guard(txn, root, index as u32, index as u32, 1),
    })
}

/// A guard to read once the commands are applied.
enum Pending {
    Block(String),
    Gap(Vec<String>),
    Child(String, String),
    ChildGap(String, Vec<String>),
}

fn dedupe(guards: Vec<GuardTarget>) -> Vec<GuardTarget> {
    let mut seen = std::collections::HashSet::new();
    guards
        .into_iter()
        .filter(|guard| {
            let key = match guard {
                GuardTarget::Block { block_id, .. } => format!("block:{block_id}"),
                GuardTarget::Gap { after_block_id, .. } => {
                    format!("gap:{}", after_block_id.as_deref().unwrap_or(""))
                }
                GuardTarget::Child {
                    parent_id, node_id, ..
                } => format!("child:{parent_id}:{node_id}"),
                GuardTarget::ChildGap {
                    parent_id,
                    after_node_id,
                    ..
                } => format!(
                    "child_gap:{parent_id}:{}",
                    after_node_id.as_deref().unwrap_or("")
                ),
                GuardTarget::Text { offset, length, .. } => format!("text:{offset}:{length}"),
                GuardTarget::Office { id, .. } => format!("office:{id}"),
            };
            seen.insert(key)
        })
        .collect()
}

fn unavailable(error: &EditError) -> bool {
    matches!(
        error,
        EditError::Edit {
            code: UnavailableTarget,
            ..
        }
    )
}

/* ---------------------------------------------------------------- material */

/// `applyMaterialCommands` on an isolated document (the durable state merged
/// with the live room); the caller commits state, receipt and inverse. Each
/// command validates against the document as the earlier ones left it; a
/// failing command leaves the document partially applied, and the caller
/// discards it.
pub fn apply_material_commands(
    txn: &mut TransactionMut,
    root: &TextRef,
    commands: &[DocumentCommand],
) -> Result<EditOutcome, EditError> {
    if commands.is_empty() {
        return edit(InvalidInput, "no commands");
    }
    let y_root = BranchPtr::from(root.as_ref() as &Branch);
    let mut editor = Editor::open(txn, y_root)?;
    let mut inverse: Vec<DocumentCommand> = Vec::new();
    let mut pending: Vec<Pending> = Vec::new();
    run_commands(&mut editor, commands, &mut inverse, &mut pending)?;
    // Guards describe the committed state. A node a later command removed
    // needs no guard of its own: that removal left a gap guard over it.
    let mut captured = Vec::new();
    for target in pending {
        let txn = &*editor.txn;
        let guard = match &target {
            Pending::Block(id) => block_guard(txn, &y_root, &editor, id),
            Pending::Gap(before) => {
                let after = surviving(before, |id| {
                    top_level(&editor, |n| stable_id(n) == id).is_some()
                });
                gap_guard(txn, &y_root, &editor, after.as_deref())
            }
            Pending::Child(parent, node) => child_guard(txn, &y_root, &editor, parent, node),
            Pending::ChildGap(parent, before) => match require_block(&editor, parent) {
                Ok((parent_node, _)) => {
                    let after = surviving(before, |id| child_index(&parent_node, id).is_some());
                    child_gap_guard(txn, &y_root, &editor, parent, after.as_deref())
                }
                Err(error) => Err(error),
            },
        };
        match guard {
            Ok(guard) => captured.push(guard),
            Err(error) if unavailable(&error) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(EditOutcome {
        guards: dedupe(captured),
        inverse,
    })
}

fn run_commands(
    editor: &mut Editor,
    commands: &[DocumentCommand],
    inverse: &mut Vec<DocumentCommand>,
    pending: &mut Vec<Pending>,
) -> Result<(), EditError> {
    let mut failure = None;
    editor
        .without_normalizing(|editor| {
            for command in commands {
                if let Err(error) = run_command(editor, command, inverse, pending) {
                    failure = Some(error);
                    // Leave the without-normalizing block as the TS's throw does:
                    // no closing normalization.
                    return Err(EditorError::Slate(slate::SlateError("aborted".into())));
                }
            }
            Ok(())
        })
        .map_err(|error| match failure.take() {
            Some(failure) => failure,
            None => error.into(),
        })
}

fn run_command(
    editor: &mut Editor,
    command: &DocumentCommand,
    inverse: &mut Vec<DocumentCommand>,
    pending: &mut Vec<Pending>,
) -> Result<(), EditError> {
    match command {
        DocumentCommand::ReplaceText {
            block_id,
            expected_text,
            text,
            offset,
        } => {
            let Some(block_id) = block_id.as_deref().filter(|id| !id.is_empty()) else {
                return edit(InvalidInput, "replace_text on a material needs target_id");
            };
            let (block, index) = require_block(editor, block_id)?;
            let current = node_string(&block)?;
            if has_media(&block) && current.is_empty() {
                return edit(UnsupportedOperation, "this block holds media, not text");
            }
            let (span_offset, span_length) = resolve_span(&current, expected_text, *offset)?;
            let start = point_at(editor, index, span_offset)?;
            let end = point_at(editor, index, span_offset + span_length)?;
            if span_length > 0 {
                editor.delete_range(start.clone(), end)?;
            }
            if !text.is_empty() {
                editor.insert_text(start, text)?;
            }
            inverse.insert(
                0,
                DocumentCommand::ReplaceText {
                    block_id: Some(block_id.to_owned()),
                    expected_text: text.clone(),
                    offset: Some(span_offset),
                    text: expected_text.clone(),
                },
            );
            pending.push(Pending::Block(block_id.to_owned()));
        }
        DocumentCommand::InsertBlock {
            after_block_id,
            blocks,
        } => {
            if blocks.is_empty() {
                return edit(InvalidInput, "insert_block needs blocks");
            }
            for block in blocks {
                assert_node_shape(block, "insert_block")?;
            }
            let index = match after_block_id {
                None => 0,
                Some(id) => require_block(editor, id)?.1 + 1,
            };
            for block in blocks {
                let id = stable_id(block);
                if top_level(editor, |node| stable_id(node) == id).is_some() {
                    return edit(StaleTarget, format!("block id {id} already exists"));
                }
            }
            editor.insert_nodes(vec![index], blocks.clone())?;
            for block in blocks.iter().rev() {
                inverse.insert(
                    0,
                    DocumentCommand::RemoveBlock {
                        block_id: stable_id(block),
                        expected_text: node_string(block)?,
                    },
                );
            }
            for block in blocks {
                pending.push(Pending::Block(stable_id(block)));
            }
        }
        DocumentCommand::RemoveBlock {
            block_id,
            expected_text,
        } => {
            let (block, index) = require_block(editor, block_id)?;
            if &node_string(&block)? != expected_text {
                return edit(StaleTarget, format!("block {block_id} changed"));
            }
            if has_media(&block) {
                return edit(
                    UnsupportedOperation,
                    "blocks holding media cannot be removed by an edit",
                );
            }
            if editor.root.children.len() == 1 {
                return edit(
                    UnsupportedOperation,
                    "a material must keep at least one block",
                );
            }
            let before: Vec<String> = editor.root.children[..index]
                .iter()
                .map(stable_id)
                .collect();
            let previous = before.last().cloned();
            editor.remove_node(vec![index])?;
            inverse.insert(
                0,
                DocumentCommand::InsertBlock {
                    after_block_id: previous,
                    blocks: vec![block],
                },
            );
            pending.push(Pending::Gap(before));
        }
        DocumentCommand::ReplaceChild {
            parent_type,
            node_id,
            node,
        } => {
            assert_node_shape(node, "replace_child")?;
            let (parent, parent_index) = require_parent(editor, parent_type)?;
            let Some(at) = child_index(&parent, node_id) else {
                return edit(UnavailableTarget, format!("{node_id} no longer exists"));
            };
            if &stable_id(node) != node_id {
                return edit(InvalidInput, "replacement must keep the node id");
            }
            let current = children(&parent)[at].clone();
            editor.remove_node(vec![parent_index, at])?;
            editor.insert_nodes(vec![parent_index, at], vec![node.clone()])?;
            inverse.insert(
                0,
                DocumentCommand::ReplaceChild {
                    node: current,
                    node_id: node_id.clone(),
                    parent_type: parent_type.clone(),
                },
            );
            pending.push(Pending::Child(stable_id(&parent), node_id.clone()));
        }
        DocumentCommand::InsertChild {
            parent_type,
            after_node_id,
            node,
        } => {
            assert_node_shape(node, "insert_child")?;
            let (parent, parent_index) = require_parent(editor, parent_type)?;
            let id = stable_id(node);
            if child_index(&parent, &id).is_some() {
                return edit(StaleTarget, format!("{id} already exists"));
            }
            let at = match after_node_id {
                None => 0,
                Some(after) => match child_index(&parent, after) {
                    Some(i) => i + 1,
                    None => return edit(UnavailableTarget, format!("{after} no longer exists")),
                },
            };
            editor.insert_nodes(vec![parent_index, at], vec![node.clone()])?;
            inverse.insert(
                0,
                DocumentCommand::RemoveChild {
                    node_id: id.clone(),
                    parent_type: parent_type.clone(),
                },
            );
            pending.push(Pending::Child(stable_id(&parent), id));
        }
        DocumentCommand::RemoveChild {
            parent_type,
            node_id,
        } => {
            let (parent, parent_index) = require_parent(editor, parent_type)?;
            let Some(at) = child_index(&parent, node_id) else {
                return edit(UnavailableTarget, format!("{node_id} no longer exists"));
            };
            let list = children(&parent);
            if list.len() == 1 {
                return edit(
                    UnsupportedOperation,
                    format!("a {parent_type} block must keep one item"),
                );
            }
            let current = list[at].clone();
            let before: Vec<String> = list[..at].iter().map(stable_id).collect();
            let previous = before.last().cloned();
            editor.remove_node(vec![parent_index, at])?;
            inverse.insert(
                0,
                DocumentCommand::InsertChild {
                    after_node_id: previous,
                    node: current,
                    parent_type: parent_type.clone(),
                },
            );
            pending.push(Pending::ChildGap(stable_id(&parent), before));
        }
        DocumentCommand::SetProperty {
            node_type,
            property,
            expected_value,
            value,
        } => {
            let (node, index) = require_parent(editor, node_type)?;
            let current = node.get(property).and_then(Value::as_str).unwrap_or("");
            if current != expected_value {
                return edit(StaleTarget, format!("{node_type}.{property} changed"));
            }
            let props = Map::from_iter([(property.clone(), Value::String(value.clone()))]);
            editor.set_nodes_at(vec![index], &props)?;
            inverse.insert(
                0,
                DocumentCommand::SetProperty {
                    expected_value: value.clone(),
                    node_type: node_type.clone(),
                    property: property.clone(),
                    value: expected_value.clone(),
                },
            );
            pending.push(Pending::Block(stable_id(&node)));
        }
    }
    Ok(())
}

/// `verifyMaterialGuards`: recompute each guarded region and compare. Opens
/// the headless editor, so its normalization reaches the document, as in the
/// TS: returns whether it wrote into the transaction (it may have, too, when
/// it refuses), and the server invalidates the room's validator when the
/// transaction commits a change.
pub fn verify_material_guards(
    txn: &mut TransactionMut,
    root: &TextRef,
    guards: &[GuardTarget],
) -> Result<bool, EditError> {
    let y_root = BranchPtr::from(root.as_ref() as &Branch);
    let editor = Editor::open(txn, y_root)?;
    for guard in guards {
        let txn = &*editor.txn;
        let now = match guard {
            GuardTarget::Block { block_id, .. } => block_guard(txn, &y_root, &editor, block_id),
            GuardTarget::Gap { after_block_id, .. } => {
                gap_guard(txn, &y_root, &editor, after_block_id.as_deref())
            }
            GuardTarget::Child {
                parent_id, node_id, ..
            } => child_guard(txn, &y_root, &editor, parent_id, node_id),
            GuardTarget::ChildGap {
                parent_id,
                after_node_id,
                ..
            } => child_gap_guard(txn, &y_root, &editor, parent_id, after_node_id.as_deref()),
            GuardTarget::Text { .. } | GuardTarget::Office { .. } => Ok(GuardTarget::Gap {
                after_block_id: None,
                runs: Vec::new(),
            }),
        };
        let now = match now {
            Ok(target) => runs_of(&target).to_vec(),
            Err(EditError::Edit { .. }) => {
                return edit(StaleTarget, "an edited target no longer exists");
            }
            Err(error) => return Err(error),
        };
        if !guards_equal(&now, runs_of(guard)) {
            return edit(StaleTarget, "an edited target changed since this edit");
        }
    }
    Ok(!editor.operations.is_empty())
}

fn runs_of(guard: &GuardTarget) -> &[GuardRun] {
    match guard {
        GuardTarget::Block { runs, .. }
        | GuardTarget::Gap { runs, .. }
        | GuardTarget::Child { runs, .. }
        | GuardTarget::ChildGap { runs, .. }
        | GuardTarget::Text { runs, .. }
        | GuardTarget::Office { runs, .. } => runs,
    }
}

/* ----------------------------------------------------------- text sources */

/// `applyTextCommands` on a text source's `source` Y.Text.
pub fn apply_text_commands(
    txn: &mut TransactionMut,
    text: &TextRef,
    commands: &[DocumentCommand],
) -> Result<EditOutcome, EditError> {
    if commands.is_empty() {
        return edit(InvalidInput, "no commands");
    }
    let mut inverse = Vec::new();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for command in commands {
        let DocumentCommand::ReplaceText {
            expected_text,
            text: replacement,
            offset,
            ..
        } = command
        else {
            return edit(
                UnsupportedOperation,
                "text sources support replace_text only",
            );
        };
        if len16(replacement) > MAX_TEXT_EDIT_CHARS {
            return edit(InvalidInput, "replacement text is too long");
        }
        let current = text.get_string(txn);
        let (span_offset, span_length) = resolve_span(&current, expected_text, *offset)?;
        // Earlier spans keep describing the final text: those after this
        // replacement shift by its length change, overlaps are refused.
        let delta = len16(replacement) as isize - span_length as isize;
        for earlier in &mut spans {
            if earlier.0 >= span_offset + span_length {
                earlier.0 = (earlier.0 as isize + delta) as usize;
            } else if earlier.0 + earlier.1 > span_offset {
                return edit(InvalidInput, "commands overlap");
            }
        }
        if span_length > 0 {
            text.remove_range(txn, span_offset as u32, span_length as u32);
        }
        if !replacement.is_empty() {
            text.insert(txn, span_offset as u32, replacement);
        }
        inverse.insert(
            0,
            DocumentCommand::ReplaceText {
                block_id: None,
                expected_text: replacement.clone(),
                offset: Some(span_offset),
                text: expected_text.clone(),
            },
        );
        spans.push((span_offset, len16(replacement)));
    }
    let current = text.get_string(txn);
    let branch: &Branch = text.as_ref();
    let guards = spans
        .into_iter()
        .map(|(offset, length)| GuardTarget::Text {
            length,
            offset,
            runs: text_span_guard(txn, branch, offset, length),
            text: slice16(&current, offset, offset + length).to_owned(),
        })
        .collect();
    Ok(EditOutcome { guards, inverse })
}

/// A replaced span guards its own runs; a pure deletion needs a neighbour.
fn text_span_guard<T: ReadTxn>(
    txn: &T,
    text: &Branch,
    offset: usize,
    length: usize,
) -> Vec<GuardRun> {
    range_guard(
        txn,
        text,
        offset as u32,
        (offset + length) as u32,
        if length > 0 { 0 } else { 1 },
    )
}

/// `verifyTextGuards`.
pub fn verify_text_guards<T: ReadTxn>(
    txn: &T,
    text: &TextRef,
    guards: &[GuardTarget],
) -> Result<(), EditError> {
    let current = text.get_string(txn);
    let branch: &Branch = text.as_ref();
    for guard in guards {
        let GuardTarget::Text {
            offset,
            length,
            text: expected,
            runs,
        } = guard
        else {
            return edit(StaleTarget, "guard does not fit a text source");
        };
        let found = anchor_span(&current, *offset, expected);
        let matches =
            found.is_some_and(|at| guards_equal(&text_span_guard(txn, branch, at, *length), runs));
        if !matches {
            return edit(StaleTarget, "the edited text changed since this edit");
        }
    }
    Ok(())
}

/* ---------------------------------------------------------------- inspect */

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InspectedChild {
    pub id: String,
    pub text: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InspectedBlock {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<InspectedChild>>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub properties: Option<Map<String, Value>>,
    pub text: String,
    #[serde(rename = "type")]
    pub kind: String,
}

/// `inspectMaterial`: top-level blocks with ids and flattened text. Object
/// values (a quiz question, a chart block) print with sorted keys: the
/// document keeps no key order for them.
pub fn inspect_material<T: ReadTxn>(txn: &T) -> Result<Vec<InspectedBlock>, EditError> {
    let value = plate::value(txn).map_err(EditorError::from)?;
    value
        .iter()
        .map(|block| {
            let kind = js_string(block.get("type"));
            let mut out = InspectedBlock {
                children: None,
                id: stable_id(block),
                properties: None,
                text: node_string(block)?,
                kind: kind.clone(),
            };
            if kind == "quiz" || kind == "flashcards" {
                out.children = Some(
                    children(block)
                        .iter()
                        .map(|child| {
                            let child_kind = js_string(child.get("type"));
                            Ok(InspectedChild {
                                id: stable_id(child),
                                text: if child_kind == "quiz_question" {
                                    child
                                        .get("question")
                                        .map(crate::json::stringify)
                                        .unwrap_or_default()
                                } else {
                                    node_string(child)?
                                },
                                kind: child_kind,
                            })
                        })
                        .collect::<Result<_, EditError>>()?,
                );
            }
            let props = |entries: Vec<(&str, String)>| {
                Some(
                    entries
                        .into_iter()
                        .map(|(k, v)| (k.to_owned(), Value::String(v)))
                        .collect::<Map<String, Value>>(),
                )
            };
            if kind == "chart" || kind == "graph" {
                let printed = block
                    .get("block")
                    .map(crate::json::stringify)
                    .unwrap_or_default();
                out.properties = props(vec![("block", printed)]);
            }
            if kind == "mermaid"
                && let Some(source) = block.get("source").and_then(Value::as_str)
            {
                out.properties = props(vec![("source", source.to_owned())]);
            }
            if kind == "html_embed"
                && let Some(caption) = block.get("caption").and_then(Value::as_str)
            {
                out.properties = props(vec![("caption", caption.to_owned())]);
            }
            if kind == MATERIAL_REF_TYPE {
                out.properties = props(vec![
                    ("materialId", js_string(block.get("materialId"))),
                    ("refKind", js_string(block.get("refKind"))),
                ]);
            }
            if has_media(block) {
                out.properties
                    .get_or_insert_with(Map::new)
                    .insert("media".into(), Value::String("true".into()));
            }
            Ok(out)
        })
        .collect()
}
