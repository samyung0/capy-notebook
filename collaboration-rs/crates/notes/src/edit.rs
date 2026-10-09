//! Direct AI content edits on a Plate material or a plain-text source
//! (`collaboration/src/editCommands.ts` minus the Office guards, which
//! `sources` owns). Commands name stable targets (block ids, child node ids)
//! and the exact text they expect; they run on an isolated document built
//! from the durable state under the material lock, through the same headless
//! Slate editor as the Node server, so the change is ordinary Slate
//! operations. The caller commits the state with the receipt, the inverse
//! commands and the post-edit guards.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
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
    /// An `EditError` of the TS: answered to the agent with its code, and for
    /// a missed target what it looks like now (`EditDetails`): the block as it
    /// reads, or the material's blocks for a gone id. The details stay out of
    /// the message, which the chat stores and shows.
    #[error("{message}")]
    Edit {
        code: EditErrorCode,
        message: String,
        details: Option<Value>,
    },
    /// Anything else the editor or the document raised (a 500 in the TS).
    #[error(transparent)]
    Editor(#[from] EditorError),
}

fn edit<T>(code: EditErrorCode, message: impl Into<String>) -> Result<T, EditError> {
    Err(EditError::Edit {
        code,
        message: message.into(),
        details: None,
    })
}

fn edit_with<T>(
    code: EditErrorCode,
    message: impl Into<String>,
    details: Value,
) -> Result<T, EditError> {
    Err(EditError::Edit {
        code,
        message: message.into(),
        details: Some(details),
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
    ReplaceBlock {
        block_id: String,
        expected_text: String,
        blocks: Vec<Value>,
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

/// An insert whose anchor block was gone, and where it landed instead: after
/// the nearest block before the anchor's place when the same call removed
/// the anchor, else at the end of the material (`end`), since a deleted
/// block's tombstone no longer carries its id. `after` none is the start.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Relocation {
    pub after: Option<String>,
    pub anchor: String,
    pub end: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EditOutcome {
    pub guards: Vec<GuardTarget>,
    pub inverse: Vec<DocumentCommand>,
    /// Material edits only (a text source has no blocks to relocate).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relocated: Option<Vec<Relocation>>,
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

/// A block's text as inspect shows it, the text an expected text matches:
/// its text with math written out, inline as `$tex$` and display as
/// `$$tex$$` (`Node.string` leaves math out), and the UTF-16 [start, end)
/// spans the math takes in it (`shownText`).
fn shown_text(node: &Value) -> (String, Vec<(usize, usize)>) {
    fn walk(node: &Value, text: &mut String, units: &mut usize, math: &mut Vec<(usize, usize)>) {
        if is_text(node) {
            let leaf = slate::text(node);
            text.push_str(leaf);
            *units += len16(leaf);
            return;
        }
        let delimiter = match node.get("type").and_then(Value::as_str) {
            Some("inline_equation") => "$",
            Some("equation") => "$$",
            _ => {
                for child in node
                    .get("children")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    walk(child, text, units, math);
                }
                return;
            }
        };
        let shown = format!(
            "{delimiter}{}{delimiter}",
            js_string(node.get("texExpression"))
        );
        let start = *units;
        *units += len16(&shown);
        math.push((start, *units));
        text.push_str(&shown);
    }
    let (mut text, mut units, mut math) = (String::new(), 0, Vec::new());
    walk(node, &mut text, &mut units, &mut math);
    (text, math)
}

/// `blockText`.
fn block_text(node: &Value) -> String {
    shown_text(node).0
}

/// An offset in a block's shown text as an offset in its text without math.
fn without_math(math: &[(usize, usize)], offset: usize) -> usize {
    math.iter()
        .filter(|(_, end)| *end <= offset)
        .fold(offset, |flat, (start, end)| flat - (end - start))
}

/// How many blocks, and how much of each, a refusal for a gone id lists.
const LISTED_BLOCKS: usize = 60;
const LISTED_PREVIEW: usize = 80;

fn shown_block(block: &Value, text: String) -> Value {
    json!({ "id": stable_id(block), "text": text, "type": js_string(block.get("type")) })
}

/// `currentBlock`: the block as it reads now.
fn current_block(block: &Value, text: String) -> Value {
    json!({ "block": shown_block(block, text) })
}

/// `blockListing`: the material's first blocks, each with a short preview.
/// A preview cut inside a surrogate pair keeps the whole character (the TS
/// keeps half of it, which a Rust string cannot hold).
fn block_listing(editor: &Editor) -> Value {
    let blocks: Vec<Value> = editor
        .root
        .children
        .iter()
        .take(LISTED_BLOCKS)
        .map(|block| {
            let text = block_text(block);
            shown_block(block, slice16(&text, 0, LISTED_PREVIEW).to_owned())
        })
        .collect();
    json!({ "blocks": blocks, "total": editor.root.children.len() })
}

/// A stale expectation's refusal carries the block as it reads now.
fn with_current(error: EditError, block: &Value, text: &str) -> EditError {
    match error {
        EditError::Edit {
            code: StaleTarget,
            message,
            details: None,
        } => EditError::Edit {
            code: StaleTarget,
            message,
            details: Some(current_block(block, text.to_owned())),
        },
        other => other,
    }
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

/// Which end of a span a point is for.
#[derive(Clone, Copy, PartialEq)]
enum Edge {
    Start,
    End,
}

/// Slate point for a UTF-16 offset inside a block's concatenated text. On a
/// boundary between two text leaves a span's start goes in the later leaf
/// and its end in the earlier one, so a span that only touches an inline
/// element (an equation, a link) does not take it in.
fn point_at(editor: &Editor, index: usize, offset: usize, edge: Edge) -> Result<Point, EditError> {
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
        if remaining < len || (edge == Edge::End && remaining == len) {
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
        None => edit_with(
            UnavailableTarget,
            format!("block {block_id} no longer exists"),
            block_listing(editor),
        ),
    }
}

fn exists(editor: &Editor, id: &str) -> bool {
    top_level(editor, |node| stable_id(node) == id).is_some()
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
    if slice16(current, offset, offset.saturating_add(len16(expected))) == expected {
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
    let mut run = Run::default();
    run_commands(&mut editor, commands, &mut run)?;
    // Guards describe the committed state. A node a later command removed
    // needs no guard of its own: that removal left a gap guard over it.
    let mut captured = Vec::new();
    for target in run.pending {
        let txn = &*editor.txn;
        let guard = match &target {
            Pending::Block(id) => block_guard(txn, &y_root, &editor, id),
            Pending::Gap(before) => {
                let after = surviving(before, |id| exists(&editor, id));
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
        inverse: run.inverse,
        relocated: Some(run.relocated),
    })
}

/// What a call's commands leave behind: their inverse, the guards to read
/// once they all ran, the inserts that landed away from a gone anchor, and
/// the blocks the call removed (by id: the ids that stood before each).
#[derive(Default)]
struct Run {
    inverse: Vec<DocumentCommand>,
    pending: Vec<Pending>,
    relocated: Vec<Relocation>,
    removed: HashMap<String, Vec<String>>,
}

fn run_commands(
    editor: &mut Editor,
    commands: &[DocumentCommand],
    run: &mut Run,
) -> Result<(), EditError> {
    let mut failure = None;
    editor
        .without_normalizing(|editor| {
            for command in commands {
                if let Err(error) = run_command(editor, command, run) {
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
    run: &mut Run,
) -> Result<(), EditError> {
    let Run {
        inverse,
        pending,
        relocated,
        removed,
    } = run;
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
            if has_media(&block) && node_string(&block)?.is_empty() {
                return edit(UnsupportedOperation, "this block holds media, not text");
            }
            // Expected text matches the block as inspect shows it, math
            // included, but only plain text around the math can be replaced.
            let (shown, math) = shown_text(&block);
            let (span_offset, span_length) = resolve_span(&shown, expected_text, *offset)
                .map_err(|error| with_current(error, &block, &shown))?;
            let span_end = span_offset.saturating_add(span_length);
            if math.iter().any(|&(from, to)| {
                if span_length > 0 {
                    span_offset < to && span_end > from
                } else {
                    from < span_offset && span_offset < to
                }
            }) {
                return edit_with(
                    InvalidInput,
                    "replace_text changes plain text and this span includes math; rewrite the block with replace_block",
                    current_block(&block, shown),
                );
            }
            let start = point_at(editor, index, without_math(&math, span_offset), Edge::Start)?;
            let end = point_at(editor, index, without_math(&math, span_end), Edge::End)?;
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
                Some(anchor) if exists(editor, anchor) => require_block(editor, anchor)?.1 + 1,
                Some(anchor) => {
                    // The anchor is gone: land the blocks rather than refuse them.
                    let before = removed.get(anchor);
                    let after = match before {
                        Some(before) => surviving(before, |id| exists(editor, id)),
                        None => editor.root.children.last().map(stable_id),
                    };
                    relocated.push(Relocation {
                        after: after.clone(),
                        anchor: anchor.clone(),
                        end: before.is_none(),
                    });
                    match after {
                        None => 0,
                        Some(after) => require_block(editor, &after)?.1 + 1,
                    }
                }
            };
            for block in blocks {
                let id = stable_id(block);
                if exists(editor, &id) {
                    return edit(StaleTarget, format!("block id {id} already exists"));
                }
            }
            editor.insert_nodes(vec![index], blocks.clone())?;
            for block in blocks.iter().rev() {
                inverse.insert(
                    0,
                    DocumentCommand::RemoveBlock {
                        block_id: stable_id(block),
                        expected_text: block_text(block),
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
            let text = block_text(&block);
            if &text != expected_text {
                return edit_with(
                    StaleTarget,
                    format!("block {block_id} changed"),
                    current_block(&block, text),
                );
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
            removed.insert(block_id.clone(), before.clone());
            inverse.insert(
                0,
                DocumentCommand::InsertBlock {
                    after_block_id: previous,
                    blocks: vec![block],
                },
            );
            // A later command in this call may remove the anchor too; the
            // gap is then guarded after the nearest block that survived.
            pending.push(Pending::Gap(before));
        }
        DocumentCommand::ReplaceBlock {
            block_id,
            expected_text,
            blocks,
        } => {
            if blocks.is_empty() {
                return edit(InvalidInput, "replace_block needs blocks");
            }
            for node in blocks {
                assert_node_shape(node, "replace_block")?;
            }
            let (block, index) = require_block(editor, block_id)?;
            let text = block_text(&block);
            if &text != expected_text {
                return edit_with(
                    StaleTarget,
                    format!("block {block_id} changed"),
                    current_block(&block, text),
                );
            }
            if has_media(&block) {
                return edit(
                    UnsupportedOperation,
                    "blocks holding media cannot be replaced by an edit",
                );
            }
            let ids: Vec<String> = blocks.iter().map(stable_id).collect();
            if let Some(id) = ids.iter().find(|id| exists(editor, id)) {
                return edit(StaleTarget, format!("block id {id} already exists"));
            }
            let mut before: Vec<String> = editor.root.children[..index]
                .iter()
                .map(stable_id)
                .collect();
            editor.remove_node(vec![index])?;
            editor.insert_nodes(vec![index], blocks.clone())?;
            // An insert after the replaced id later in this call follows the
            // replacement.
            before.extend(ids.iter().cloned());
            removed.insert(block_id.clone(), before);
            // Undo puts the original back after the first new block, then
            // removes the new blocks, so it returns to its own place.
            let undo = std::iter::once(DocumentCommand::InsertBlock {
                after_block_id: Some(ids[0].clone()),
                blocks: vec![block],
            })
            .chain(blocks.iter().map(|node| DocumentCommand::RemoveBlock {
                block_id: stable_id(node),
                expected_text: block_text(node),
            }));
            inverse.splice(0..0, undo);
            pending.extend(ids.into_iter().map(Pending::Block));
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
    Ok(EditOutcome {
        guards,
        inverse,
        relocated: None,
    })
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
                text: block_text(block),
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
