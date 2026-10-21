//! Direct AI content edits on a Plate material or a plain-text source
//! (`collaboration/src/editCommands.ts` minus Office, which `sources` owns).
//! Commands name stable targets (block ids, child node ids) and the exact
//! text they expect; they run on an isolated document built from the
//! durable state under the material lock, through the same headless Slate
//! editor as the Node server, so the change is ordinary Slate operations.
//! The caller commits the state with the receipt; the edit's Undo reverts its
//! Yjs items in the live room (`ydoc::undo`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use yrs::branch::{Branch, BranchPtr};
use yrs::{GetString, ReadTxn, Text, TextRef, TransactionMut};

use crate::catalog;
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

/// Same JSON as the TS `DocumentCommand`.
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

/// What a material edit reports beyond its change: the inserts that landed
/// away from a gone anchor.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EditOutcome {
    pub relocated: Vec<Relocation>,
}

/// A media block an agent's edit cannot write: an uploaded file
/// ([crate::material::MEDIA_TYPES]) or an embedded video (the catalog's
/// elements that require or forbid `assetId`).
pub fn media_type(kind: &str) -> bool {
    kind == "video" || crate::material::MEDIA_TYPES.contains(&kind)
}
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
    media_type(&js_string(node.get("type")))
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

/// [block_listing] of an inspection: a material rebuilt since the agent read
/// it refuses with its blocks as they are now, as a gone id does.
pub fn listing(blocks: &[InspectedBlock]) -> Value {
    let listed: Vec<Value> = blocks
        .iter()
        .take(LISTED_BLOCKS)
        .map(|block| {
            json!({
                "id": block.id,
                "text": slice16(&block.text, 0, LISTED_PREVIEW),
                "type": block.kind,
            })
        })
        .collect();
    json!({ "blocks": listed, "total": blocks.len() })
}

/// A refused span on a material (stale, or an expected text that occurs more
/// than once) carries its block as it reads now, so the retry needs no
/// inspect.
fn with_current(error: EditError, block: &Value, text: &str) -> EditError {
    match error {
        EditError::Edit { code, message, .. } => EditError::Edit {
            code,
            message,
            details: Some(current_block(block, text.to_owned())),
        },
        other => other,
    }
}

/// How many lines an ambiguous span lists, and how many characters of each.
const LISTED_LINES: usize = 20;
const LISTED_LINE_CHARS: usize = 1000;

/// An expected text that occurs more than once: the lines its occurrences
/// start in, each once and at most [LISTED_LINES], as inspect pages a text
/// source (`start`, the line's UTF-16 offset; its text without the newline,
/// cut after [LISTED_LINE_CHARS] characters with a trailing `…`), so the
/// retry can add context and the refusal stays small (Epo 2026-10-14).
fn occurrence_lines(text: &str, expected: &str) -> Value {
    let mut lines = Vec::new();
    // The end of the last line listed, and the UTF-16 offset counted so far.
    let (mut listed_end, mut counted, mut units) = (0, 0, 0);
    for (at, _) in text.match_indices(expected) {
        if at < listed_end {
            continue;
        }
        if lines.len() == LISTED_LINES {
            break;
        }
        let start = text[..at].rfind('\n').map_or(0, |i| i + 1);
        listed_end = text[at..].find('\n').map_or(text.len(), |i| at + i);
        units += len16(&text[counted..start]);
        counted = start;
        let line = &text[start..listed_end];
        let shown = match line.char_indices().nth(LISTED_LINE_CHARS) {
            Some((cut, _)) => format!("{}…", &line[..cut]),
            None => line.to_owned(),
        };
        lines.push(json!({ "start": units, "text": shown }));
    }
    json!({ "lines": lines })
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
        None => edit(
            UnavailableTarget,
            format!("block {block_id} no longer exists"),
        ),
    }
}

/// A command's target block: a gone id refuses with the material's blocks.
fn target_block(editor: &Editor, block_id: &str) -> Result<(Value, usize), EditError> {
    require_block(editor, block_id).map_err(|error| match error {
        EditError::Edit {
            code: UnavailableTarget,
            message,
            details: None,
        } => EditError::Edit {
            code: UnavailableTarget,
            message,
            details: Some(block_listing(editor)),
        },
        other => other,
    })
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
    if inserts_media(node) {
        return edit(
            UnsupportedOperation,
            "media nodes cannot be inserted by an edit",
        );
    }
    // A figure an edit writes is checked whole, as outside a room: what a
    // merge may leave in a room (no series, a pie without a positive total)
    // is no block an agent writes (Epo 2026-10-18).
    let kind = js_string(node.get("type"));
    let block = node.get("block").unwrap_or(&Value::Null);
    if crate::plate::holds_map(&kind, "block")
        && let Err(error) = crate::material::figure_block(&kind, block)
    {
        return edit(InvalidInput, format!("{what}: {}", error.0));
    }
    Ok(())
}

/// Media an edit may not insert: anything [has_media] finds except an `img`
/// naming an asset (no URL), which is how a library figure arrives: Go stores
/// it as the note's own editor asset before the edit's blocks (`figure:<id>`
/// in agent markdown), and the children pass after the edit keeps, copies or
/// drops any image as it does for a paste.
fn inserts_media(node: &Value) -> bool {
    let named_image = js_string(node.get("type")) == "img"
        && node
            .get("assetId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
        && node.get("url").is_none()
        && node.get("src").is_none();
    (!named_image && (media_type(&js_string(node.get("type"))) || node.get("assetId").is_some()))
        || node
            .get("children")
            .and_then(Value::as_array)
            .is_some_and(|children| children.iter().any(inserts_media))
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

/// `resolveSpan`: the span a command replaces, as UTF-16 offset and length.
fn resolve_span(current: &str, expected: &str) -> Result<(usize, usize), EditError> {
    let length = len16(expected);
    if length > MAX_TEXT_EDIT_CHARS {
        return edit(InvalidInput, "expected text is too long");
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
        n => edit_with(
            InvalidInput,
            format!("expected text occurs {n} times; include more context"),
            occurrence_lines(current, expected),
        ),
    }
}

/* ---------------------------------------------------------------- material */

/// `applyMaterialCommands` on an isolated document (the durable state merged
/// with the live room); the caller commits state and receipt. Each command
/// validates against the document as the earlier ones left it; a failing
/// command leaves the document partially applied, and the caller discards it.
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
    Ok(EditOutcome {
        relocated: run.relocated,
    })
}

/// What a call's commands leave behind: the inserts that landed away from a
/// gone anchor, and the blocks the call removed (by id: the ids that stood
/// before each).
#[derive(Default)]
struct Run {
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
    let Run { relocated, removed } = run;
    match command {
        DocumentCommand::ReplaceText {
            block_id,
            expected_text,
            text,
        } => {
            let Some(block_id) = block_id.as_deref().filter(|id| !id.is_empty()) else {
                return edit(InvalidInput, "replace_text on a material needs target_id");
            };
            let (block, index) = target_block(editor, block_id)?;
            if has_media(&block) && node_string(&block)?.is_empty() {
                return edit(UnsupportedOperation, "this block holds media, not text");
            }
            // Expected text matches the block as inspect shows it, math
            // included, but only plain text around the math can be replaced.
            let (shown, math) = shown_text(&block);
            let (span_offset, span_length) = resolve_span(&shown, expected_text)
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
        }
        DocumentCommand::RemoveBlock {
            block_id,
            expected_text,
        } => {
            let (block, index) = target_block(editor, block_id)?;
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
            editor.remove_node(vec![index])?;
            removed.insert(block_id.clone(), before);
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
            let (block, index) = target_block(editor, block_id)?;
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
            before.extend(ids);
            removed.insert(block_id.clone(), before);
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
            editor.remove_node(vec![parent_index, at])?;
            editor.insert_nodes(vec![parent_index, at], vec![node.clone()])?;
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
        }
        DocumentCommand::RemoveChild {
            parent_type,
            node_id,
        } => {
            let (parent, parent_index) = require_parent(editor, parent_type)?;
            let Some(at) = child_index(&parent, node_id) else {
                return edit(UnavailableTarget, format!("{node_id} no longer exists"));
            };
            if children(&parent).len() == 1 {
                return edit(
                    UnsupportedOperation,
                    format!("a {parent_type} block must keep one item"),
                );
            }
            editor.remove_node(vec![parent_index, at])?;
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
                // The value as it is now (a diagram's source), as a stale
                // block carries its text.
                return edit_with(
                    StaleTarget,
                    format!("{node_type}.{property} changed"),
                    current_block(&node, current.to_owned()),
                );
            }
            let props = Map::from_iter([(property.clone(), Value::String(value.clone()))]);
            editor.set_nodes_at(vec![index], &props)?;
        }
    }
    Ok(())
}

/* ----------------------------------------------------------- text sources */

/// `applyTextCommands` on a text source's `source` Y.Text.
pub fn apply_text_commands(
    txn: &mut TransactionMut,
    text: &TextRef,
    commands: &[DocumentCommand],
) -> Result<(), EditError> {
    if commands.is_empty() {
        return edit(InvalidInput, "no commands");
    }
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for command in commands {
        let DocumentCommand::ReplaceText {
            expected_text,
            text: replacement,
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
        let (span_offset, span_length) = resolve_span(&current, expected_text)?;
        // Later spans are checked against the earlier ones: those after this
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
        spans.push((span_offset, len16(replacement)));
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
            // A figure (chart, plot, graph) prints its question block.
            if catalog::element(&kind).is_some_and(|element| element.required.contains(&"block")) {
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
