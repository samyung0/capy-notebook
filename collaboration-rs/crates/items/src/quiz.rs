//! Quiz documents (live-items DESIGN.md 1.2, 1.3; Epo 2026-10-10). A quiz
//! has two: the content document (`material:<id>:schema:<n>`), which readers
//! join too, and the keys document (`keys:<id>:schema:<n>`), which only
//! editors with write access join, so answer keys never reach a reader.
//!
//! Content: `questions`, question id to `{order, layout, labels, level?,
//! stem, parts}`; part id to `{order, marks, blocks, answer}`; the answer map
//! holds the type and what a learner may see: mcq and multi `options`, a
//! short answer's `unit`, matching `left` items, and `copy`, the reader copy
//! of matching options and ordering items, which only the server writes
//! (slot id to `{text}`, read sorted by slot: a stable shuffle).
//!
//! Keys: `keys`, part id to `{type, solution, correct | accepted | hints |
//! markscheme | gaps | options | pairs | items}`. Editors type ordering items
//! and matching options here, where their Yjs ids record typing order (for
//! ordering, usually the answer); each such entry's `slot` (server-written)
//! names its entry in the reader copy.
//!
//! The projection is today's quiz block with only the questions that pass
//! the strict validator (D4), so grading and fresh reads see what a Save
//! would have stored.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::{Value, json};
use yrs::block::ItemContent;
use yrs::types::{ToJson, TypeRef};
use yrs::{
    Any, Doc, GetString, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Text, TextPrelim,
    TextRef, Transact, TransactionMut, WriteTxn,
};

use notes::edit::{DocumentCommand, EditError, EditErrorCode, EditOutcome, GuardTarget};
use notes::questions::{self as q, Policy};
use ydoc::Incoming;
use ydoc::steps::{Walk, step};

use crate::locate::{Locator, Place};
use crate::{Growth, order};

pub const QUESTIONS_ROOT: &str = "questions";
pub const KEYS_ROOT: &str = "keys";
/// The projected `quiz` block's id (one block per quiz document).
pub const BLOCK_ID: &str = "quiz";
/// Ids a writer mints (map keys): `[A-Za-z0-9_-]`, at most this long.
pub const MAX_ID: usize = 128;

const ANSWER_TYPES: &[&str] = &[
    "mcq", "multi", "boolean", "short", "matching", "ordering", "open", "gaps",
];
const BLOCK_TYPES: &[&str] = &["text", "table", "image", "chart", "graph"];
/// Whole marks a part or a marking item carries.
const MAX_MARKS: f64 = q::QUESTION_MARKS_MAX;

/// A slot id for a reader copy entry: random, so its sort order says
/// nothing about the answer (the server passes uuids; tests a seeded source).
pub type SlotSource<'a> = &'a mut dyn FnMut() -> String;

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/* ------------------------------------------------------------- reading */

struct Entry {
    id: String,
    map: MapRef,
    order: String,
}

fn map_at<T: ReadTxn>(txn: &T, map: &MapRef, key: &str) -> Option<MapRef> {
    match map.get(txn, key) {
        Some(Out::YMap(found)) => Some(found),
        _ => None,
    }
}

fn text_at<T: ReadTxn>(txn: &T, map: &MapRef, key: &str) -> String {
    match map.get(txn, key) {
        Some(Out::YText(text)) => text.get_string(txn),
        _ => String::new(),
    }
}

fn any_at<T: ReadTxn>(txn: &T, map: &MapRef, key: &str) -> Option<Any> {
    match map.get(txn, key) {
        Some(Out::Any(value)) => Some(value),
        _ => None,
    }
}

fn str_at<T: ReadTxn>(txn: &T, map: &MapRef, key: &str) -> Option<String> {
    match any_at(txn, map, key) {
        Some(Any::String(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn num_at<T: ReadTxn>(txn: &T, map: &MapRef, key: &str) -> Option<f64> {
    match any_at(txn, map, key) {
        Some(Any::Number(value)) => Some(value),
        Some(Any::BigInt(value)) => Some(value as f64),
        _ => None,
    }
}

/// A map's entries that are maps, in `(order, id)` order.
fn ordered<T: ReadTxn>(txn: &T, map: Option<&MapRef>) -> Vec<Entry> {
    let Some(map) = map else {
        return Vec::new();
    };
    let mut out: Vec<Entry> = map
        .iter(txn)
        .filter_map(|(id, value)| match value {
            Out::YMap(entry) => {
                let order = match entry.get(txn, "order") {
                    Some(Out::Any(Any::String(order))) => order.to_string(),
                    _ => String::new(),
                };
                Some(Entry {
                    id: id.to_owned(),
                    map: entry,
                    order,
                })
            }
            _ => None,
        })
        .collect();
    out.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    out
}

/// A table's row or column ids (id to order key), in order.
fn ordered_keys<T: ReadTxn>(txn: &T, map: Option<&MapRef>) -> Vec<String> {
    let Some(map) = map else {
        return Vec::new();
    };
    let mut out: Vec<(String, String)> = map
        .iter(txn)
        .map(|(id, value)| {
            let order = match value {
                Out::Any(Any::String(order)) => order.to_string(),
                _ => String::new(),
            };
            (order, id.to_owned())
        })
        .collect();
    out.sort();
    out.into_iter().map(|(_, id)| id).collect()
}

/// JSON of a plain value: whole numbers print as integers, as the JSON the
/// stored questions came from.
fn any_json(value: &Any) -> Value {
    match value {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(value) => json!(value),
        Any::Number(value) => {
            if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
                json!(*value as i64)
            } else {
                json!(value)
            }
        }
        Any::BigInt(value) => json!(value),
        Any::String(value) => json!(value.as_ref()),
        Any::Buffer(_) => Value::Null,
        Any::Array(items) => Value::Array(items.iter().map(any_json).collect()),
        Any::Map(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), any_json(value)))
                .collect(),
        ),
    }
}

fn json_any(value: &Value) -> Any {
    match value {
        Value::Null => Any::Null,
        Value::Bool(value) => Any::Bool(*value),
        Value::Number(value) => Any::Number(value.as_f64().unwrap_or(0.0)),
        Value::String(value) => Any::String(Arc::from(value.as_str())),
        Value::Array(items) => Any::Array(items.iter().map(json_any).collect()),
        Value::Object(map) => Any::Map(Arc::new(
            map.iter()
                .map(|(key, value)| (key.clone(), json_any(value)))
                .collect(),
        )),
    }
}

fn number(value: f64) -> Value {
    any_json(&Any::Number(value))
}

fn read_block<T: ReadTxn>(txn: &T, map: &MapRef) -> Option<Value> {
    let kind = str_at(txn, map, "type")?;
    match kind.as_str() {
        "text" => {
            let mut block = json!({ "type": "text", "text": text_at(txn, map, "text") });
            if let Some(label) = str_at(txn, map, "label") {
                block["label"] = json!(label);
            }
            Some(block)
        }
        "table" => {
            let rows = ordered_keys(txn, map_at(txn, map, "rows").as_ref());
            let columns = ordered_keys(txn, map_at(txn, map, "columns").as_ref());
            let cells = map_at(txn, map, "cells");
            let cell = |row: &str, column: &str| match &cells {
                Some(cells) => text_at(txn, cells, &format!("{row}/{column}")),
                None => String::new(),
            };
            Some(json!({
                "type": "table",
                "header": matches!(any_at(txn, map, "header"), Some(Any::Bool(true))),
                "rows": rows.iter().map(|row| {
                    columns.iter().map(|column| cell(row, column)).collect::<Vec<_>>()
                }).collect::<Vec<_>>(),
            }))
        }
        "image" => {
            let mut block = json!({
                "type": "image",
                "image": any_at(txn, map, "image").map(|image| any_json(&image)).unwrap_or(json!({ "url": "" })),
                "width": number(num_at(txn, map, "width").unwrap_or(1.0)),
                "height": number(num_at(txn, map, "height").unwrap_or(1.0)),
                "description": text_at(txn, map, "description"),
            });
            if let Some(attribution) = str_at(txn, map, "attribution") {
                block["attribution"] = json!(attribution);
            }
            Some(block)
        }
        "chart" | "graph" => match any_at(txn, map, "value") {
            Some(value @ Any::Map(_)) => {
                let mut block = any_json(&value);
                block["type"] = json!(kind);
                Some(block)
            }
            _ => None,
        },
        _ => None,
    }
}

fn read_blocks<T: ReadTxn>(txn: &T, map: Option<&MapRef>) -> Vec<Value> {
    ordered(txn, map)
        .iter()
        .filter_map(|entry| read_block(txn, &entry.map))
        .collect()
}

fn texts<T: ReadTxn>(txn: &T, map: Option<&MapRef>) -> Vec<String> {
    ordered(txn, map)
        .iter()
        .map(|entry| text_at(txn, &entry.map, "text"))
        .collect()
}

/// The keys side of a read: the keys document's transaction and root.
pub struct KeysRead<'a, K: ReadTxn> {
    pub txn: &'a K,
    pub root: Option<MapRef>,
}

impl<'a, K: ReadTxn> KeysRead<'a, K> {
    pub fn new(txn: &'a K) -> Self {
        KeysRead {
            txn,
            root: txn.get_map(KEYS_ROOT),
        }
    }

    /// A part's keys, unless they were written for another answer type.
    fn part(&self, part: &str, kind: &str) -> Option<MapRef> {
        let key = map_at(self.txn, self.root.as_ref()?, part)?;
        (str_at(self.txn, &key, "type").as_deref() == Some(kind)).then_some(key)
    }
}

/// A part's answer JSON (and an open part's marking scheme) from the content
/// answer map and the part's keys.
fn read_answer<C: ReadTxn, K: ReadTxn>(
    content: &C,
    answer: Option<&MapRef>,
    keys: Option<(&K, &MapRef)>,
) -> (Value, Option<Value>) {
    let kind = answer
        .and_then(|answer| str_at(content, answer, "type"))
        .unwrap_or_default();
    let key_map = |name: &str| keys.and_then(|(txn, key)| map_at(txn, key, name));
    let key_texts = |name: &str| match keys {
        Some((txn, key)) => texts(txn, map_at(txn, key, name).as_ref()),
        None => Vec::new(),
    };
    match kind.as_str() {
        "mcq" | "multi" => {
            let options = ordered(
                content,
                answer.and_then(|a| map_at(content, a, "options")).as_ref(),
            );
            let correct: Vec<usize> = match keys {
                Some((txn, key)) if kind == "mcq" => match str_at(txn, key, "correct") {
                    Some(id) => options
                        .iter()
                        .position(|o| o.id == id)
                        .into_iter()
                        .collect(),
                    None => Vec::new(),
                },
                Some((txn, key)) => match map_at(txn, key, "correct") {
                    Some(ticks) => options
                        .iter()
                        .enumerate()
                        .filter(|(_, o)| {
                            matches!(ticks.get(txn, &o.id), Some(Out::Any(Any::Bool(true))))
                        })
                        .map(|(i, _)| i)
                        .collect(),
                    None => Vec::new(),
                },
                None => Vec::new(),
            };
            (
                json!({
                    "type": kind,
                    "options": options.iter().map(|o| text_at(content, &o.map, "text")).collect::<Vec<_>>(),
                    "correct": correct,
                }),
                None,
            )
        }
        "boolean" => {
            let correct = keys.is_some_and(|(txn, key)| {
                matches!(any_at(txn, key, "correct"), Some(Any::Bool(true)))
            });
            (json!({ "type": "boolean", "correct": correct }), None)
        }
        "short" => {
            let mut value = json!({ "type": "short", "accepted": key_texts("accepted") });
            if let Some(unit) = answer.and_then(|a| str_at(content, a, "unit")) {
                value["unit"] = json!(unit);
            }
            (value, None)
        }
        "open" => {
            let scheme = match keys {
                Some((txn, key)) => ordered(txn, map_at(txn, key, "markscheme").as_ref())
                    .iter()
                    .map(|item| {
                        json!({
                            "text": text_at(txn, &item.map, "text"),
                            "marks": number(num_at(txn, &item.map, "marks").unwrap_or(1.0)),
                        })
                    })
                    .collect(),
                None => Vec::new(),
            };
            (
                json!({ "type": "open", "accepted": key_texts("accepted"), "hints": key_texts("hints") }),
                Some(Value::Array(scheme)),
            )
        }
        "gaps" => {
            let accepted: Vec<Vec<String>> = match (keys, key_map("gaps")) {
                (Some((txn, _)), Some(gaps)) => {
                    let mut numbers: Vec<(u32, MapRef)> = gaps
                        .iter(txn)
                        .filter_map(|(number, value)| match value {
                            Out::YMap(list) => number.parse::<u32>().ok().map(|n| (n, list)),
                            _ => None,
                        })
                        .collect();
                    numbers.sort_by_key(|(n, _)| *n);
                    numbers
                        .iter()
                        .map(|(_, list)| texts(txn, Some(list)))
                        .collect()
                }
                _ => Vec::new(),
            };
            (json!({ "type": "gaps", "accepted": accepted }), None)
        }
        "matching" => {
            let (options, pairs) = match keys {
                Some((txn, key)) => {
                    let options = ordered(txn, map_at(txn, key, "options").as_ref());
                    let pairs: HashMap<String, String> = match map_at(txn, key, "pairs") {
                        Some(pairs) => pairs
                            .iter(txn)
                            .filter_map(|(left, value)| match value {
                                Out::Any(Any::String(option)) => {
                                    Some((left.to_owned(), option.to_string()))
                                }
                                _ => None,
                            })
                            .collect(),
                        None => HashMap::new(),
                    };
                    let ids: Vec<String> = options.iter().map(|o| o.id.clone()).collect();
                    let texts: Vec<String> = options
                        .iter()
                        .map(|o| text_at(txn, &o.map, "text"))
                        .collect();
                    (Some((ids, texts)), pairs)
                }
                None => (None, HashMap::new()),
            };
            let (ids, option_texts) = options.unwrap_or_default();
            let left = ordered(
                content,
                answer.and_then(|a| map_at(content, a, "left")).as_ref(),
            );
            let pairs: Vec<Value> = left
                .iter()
                .map(|item| {
                    let right = pairs
                        .get(&item.id)
                        .and_then(|option| ids.iter().position(|id| id == option))
                        .map_or(json!(-1), |i| json!(i));
                    json!({ "left": text_at(content, &item.map, "text"), "right": right })
                })
                .collect();
            (
                json!({ "type": "matching", "options": option_texts, "pairs": pairs }),
                None,
            )
        }
        "ordering" => (
            json!({ "type": "ordering", "items": key_texts("items") }),
            None,
        ),
        _ => (json!({ "type": kind }), None),
    }
}

/// Every question as editors see it (with keys) or as the content document
/// alone holds it (`keys` none), in order, as the shared question JSON.
pub fn questions_json<C: ReadTxn, K: ReadTxn>(
    content: &C,
    keys: Option<&KeysRead<'_, K>>,
) -> Vec<Value> {
    let root = content.get_map(QUESTIONS_ROOT);
    ordered(content, root.as_ref())
        .iter()
        .map(|question| question_json(content, keys, &question.id, &question.map))
        .collect()
}

fn question_json<C: ReadTxn, K: ReadTxn>(
    content: &C,
    keys: Option<&KeysRead<'_, K>>,
    id: &str,
    map: &MapRef,
) -> Value {
    let parts: Vec<Value> = ordered(content, map_at(content, map, "parts").as_ref())
        .iter()
        .map(|part| {
            let answer_map = map_at(content, &part.map, "answer");
            let kind = answer_map
                .as_ref()
                .and_then(|a| str_at(content, a, "type"))
                .unwrap_or_default();
            let key = keys.and_then(|keys| keys.part(&part.id, &kind));
            let key_pair = match (keys, &key) {
                (Some(keys), Some(key)) => Some((keys.txn, key)),
                _ => None,
            };
            let (answer, markscheme) = read_answer(content, answer_map.as_ref(), key_pair);
            let solution = match (keys, &key) {
                (Some(keys), Some(key)) => {
                    read_blocks(keys.txn, map_at(keys.txn, key, "solution").as_ref())
                }
                _ => Vec::new(),
            };
            let mut value = json!({
                "id": part.id,
                "blocks": read_blocks(content, map_at(content, &part.map, "blocks").as_ref()),
                "answer": answer,
                "marks": number(num_at(content, &part.map, "marks").unwrap_or(1.0)),
                "solution": solution,
            });
            if let Some(markscheme) = markscheme {
                value["markscheme"] = markscheme;
            }
            value
        })
        .collect();
    let mut value = json!({
        "id": id,
        "layout": str_at(content, map, "layout").unwrap_or_else(|| "paper".into()),
        "labels": str_at(content, map, "labels").unwrap_or_else(|| "letters".into()),
        "stem": read_blocks(content, map_at(content, map, "stem").as_ref()),
        "parts": parts,
    });
    if let Some(level) = str_at(content, map, "level") {
        value["level"] = json!(level);
    }
    value
}

fn question_node(question: Value) -> Value {
    json!({
        "type": "quiz_question",
        "id": question["id"].clone(),
        "question": question,
        "children": [{ "text": "" }],
    })
}

fn quiz_block(children: Vec<Value>) -> Vec<Value> {
    let children = if children.is_empty() {
        vec![json!({ "text": "" })]
    } else {
        children
    };
    vec![json!({ "type": "quiz", "id": BLOCK_ID, "children": children })]
}

/// The Plate value the quiz projects to (`materials.content`): the complete
/// questions only (each passes the strict validator, and the quiz's part and
/// open-part bounds hold), so grading sees what a Save would have stored.
pub fn value<C: ReadTxn, K: ReadTxn>(content: &C, keys: &K) -> Vec<Value> {
    let keys = KeysRead::new(keys);
    let policy = Policy::quiz();
    let (mut parts, mut open) = (0usize, 0usize);
    let mut children = Vec::new();
    for question in questions_json(content, Some(&keys)) {
        let Ok(checked) = q::validate_question(&question, &policy) else {
            continue;
        };
        if q::assert_quiz_bounds(parts + checked.part_ids.len(), open + checked.open_parts).is_err()
        {
            continue;
        }
        parts += checked.part_ids.len();
        open += checked.open_parts;
        children.push(question_node(question));
    }
    quiz_block(children)
}

/// Every question as typed with its keys, complete or not: what an editor
/// (and the agent's inspect) reads.
pub fn editor_value<C: ReadTxn, K: ReadTxn>(content: &C, keys: &K) -> Vec<Value> {
    let keys = KeysRead::new(keys);
    quiz_block(
        questions_json(content, Some(&keys))
            .into_iter()
            .map(question_node)
            .collect(),
    )
}

/// Everything the content document holds, every question as typed: what the
/// limits measure.
pub fn content_document_value<T: ReadTxn>(txn: &T) -> Vec<Value> {
    quiz_block(
        questions_json::<T, T>(txn, None)
            .into_iter()
            .map(question_node)
            .collect(),
    )
}

/// The keys document as one value under a quiz block: what its limits measure
/// (its bytes join the projection's).
pub fn keys_document_value<T: ReadTxn>(txn: &T) -> Vec<Value> {
    let keys = match txn.get_map(KEYS_ROOT) {
        Some(root) => any_json(&root.to_json(txn)),
        None => json!({}),
    };
    vec![json!({ "type": "quiz", "id": "keys", "keys": keys, "children": [{ "text": "" }] })]
}

/* --------------------------------------------------------------- roots */

fn assert_root<T: ReadTxn>(txn: &T, own: &str, what: &str) -> Result<(), String> {
    for (name, _) in txn.root_refs() {
        if name != own && name != ydoc::CONTRIBUTORS_ROOT {
            return Err(format!("unsupported collaboration document root: {name}"));
        }
    }
    for root in [own, ydoc::CONTRIBUTORS_ROOT] {
        if let Some(branch) = yrs::branch::BranchID::get_root(txn, root)
            && branch.start().is_some()
        {
            return Err(format!("invalid {what} root"));
        }
    }
    Ok(())
}

pub fn assert_content_roots<T: ReadTxn>(txn: &T) -> Result<(), String> {
    assert_root(txn, QUESTIONS_ROOT, "quiz")
}

pub fn assert_keys_roots<T: ReadTxn>(txn: &T) -> Result<(), String> {
    assert_root(txn, KEYS_ROOT, "quiz keys")
}

/* ------------------------------------------------------------- writing */

fn order_any(key: &str) -> Any {
    Any::String(Arc::from(key))
}

/// A fresh map under `key`, replacing whatever was there.
fn insert_map(txn: &mut TransactionMut, parent: &MapRef, key: &str) -> MapRef {
    parent.insert(txn, key, MapPrelim::default())
}

fn insert_text(txn: &mut TransactionMut, parent: &MapRef, key: &str, text: &str) {
    parent.insert(txn, key, TextPrelim::new(text));
}

fn str_of<'v>(value: &'v Value, key: &str) -> &'v str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn array_of<'v>(value: &'v Value, key: &str) -> &'v [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn write_block(txn: &mut TransactionMut, parent: &MapRef, id: &str, order: &str, block: &Value) {
    let map = insert_map(txn, parent, id);
    map.insert(txn, "order", order_any(order));
    let kind = str_of(block, "type").to_owned();
    map.insert(txn, "type", Any::String(Arc::from(kind.as_str())));
    match kind.as_str() {
        "text" => {
            insert_text(txn, &map, "text", str_of(block, "text"));
            if let Some(label) = block.get("label").and_then(Value::as_str) {
                map.insert(txn, "label", Any::String(Arc::from(label)));
            }
        }
        "table" => {
            map.insert(
                txn,
                "header",
                Any::Bool(block.get("header").and_then(Value::as_bool) == Some(true)),
            );
            let rows = insert_map(txn, &map, "rows");
            let columns = insert_map(txn, &map, "columns");
            let cells = insert_map(txn, &map, "cells");
            let grid = array_of(block, "rows");
            let width = grid
                .iter()
                .map(|row| row.as_array().map_or(0, Vec::len))
                .max()
                .unwrap_or(0);
            let mut key: Option<String> = None;
            for c in 0..width {
                let next = order::after(key.as_deref());
                columns.insert(txn, format!("c{c}"), order_any(&next));
                key = Some(next);
            }
            key = None;
            for (r, row) in grid.iter().enumerate() {
                let next = order::after(key.as_deref());
                rows.insert(txn, format!("r{r}"), order_any(&next));
                key = Some(next);
                for c in 0..width {
                    let text = row
                        .get(c)
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    insert_text(txn, &cells, &format!("r{r}/c{c}"), &text);
                }
            }
        }
        "image" => {
            if let Some(image) = block.get("image") {
                map.insert(txn, "image", json_any(image));
            }
            for field in ["width", "height"] {
                if let Some(value) = block.get(field).and_then(Value::as_f64) {
                    map.insert(txn, field, Any::Number(value));
                }
            }
            insert_text(txn, &map, "description", str_of(block, "description"));
            if let Some(attribution) = block.get("attribution").and_then(Value::as_str) {
                map.insert(txn, "attribution", Any::String(Arc::from(attribution)));
            }
        }
        _ => {
            let mut value = block.clone();
            if let Some(object) = value.as_object_mut() {
                object.remove("type");
            }
            map.insert(txn, "value", json_any(&value));
        }
    }
}

fn write_blocks(txn: &mut TransactionMut, parent: &MapRef, key: &str, blocks: &[Value]) {
    let map = insert_map(txn, parent, key);
    let mut order: Option<String> = None;
    for (i, block) in blocks.iter().enumerate() {
        let next = order::after(order.as_deref());
        write_block(txn, &map, &format!("b{i}"), &next, block);
        order = Some(next);
    }
}

/// A list of `{order, text}` entries under fresh ids `prefix0`, `prefix1`, ...
fn write_texts(
    txn: &mut TransactionMut,
    parent: &MapRef,
    key: &str,
    prefix: &str,
    items: &[String],
) -> Vec<(String, MapRef)> {
    let map = insert_map(txn, parent, key);
    let mut order: Option<String> = None;
    let mut out = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let next = order::after(order.as_deref());
        let id = format!("{prefix}{i}");
        let entry = insert_map(txn, &map, &id);
        entry.insert(txn, "order", order_any(&next));
        insert_text(txn, &entry, "text", item);
        out.push((id, entry));
        order = Some(next);
    }
    out
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    array_of(value, key)
        .iter()
        .map(|item| item.as_str().unwrap_or_default().to_owned())
        .collect()
}

/// Writes one question (the shared JSON) into both documents under `order`.
fn write_question(
    content: &mut TransactionMut,
    questions: &MapRef,
    keys: &mut TransactionMut,
    key_root: &MapRef,
    question: &Value,
    order: &str,
) {
    let id = str_of(question, "id").to_owned();
    let map = insert_map(content, questions, &id);
    map.insert(content, "order", order_any(order));
    for field in ["layout", "labels", "level"] {
        if let Some(value) = question.get(field).and_then(Value::as_str) {
            map.insert(content, field, Any::String(Arc::from(value)));
        }
    }
    write_blocks(content, &map, "stem", array_of(question, "stem"));
    let parts = insert_map(content, &map, "parts");
    let mut part_order: Option<String> = None;
    for part in array_of(question, "parts") {
        let part_id = str_of(part, "id").to_owned();
        let next = order::after(part_order.as_deref());
        let entry = insert_map(content, &parts, &part_id);
        entry.insert(content, "order", order_any(&next));
        part_order = Some(next);
        if let Some(marks) = part.get("marks").and_then(Value::as_f64) {
            entry.insert(content, "marks", Any::Number(marks));
        }
        write_blocks(content, &entry, "blocks", array_of(part, "blocks"));
        let answer = part.get("answer").cloned().unwrap_or(Value::Null);
        let kind = str_of(&answer, "type").to_owned();
        let answer_map = insert_map(content, &entry, "answer");
        answer_map.insert(content, "type", Any::String(Arc::from(kind.as_str())));
        let key = insert_map(keys, key_root, &part_id);
        key.insert(keys, "type", Any::String(Arc::from(kind.as_str())));
        write_blocks(keys, &key, "solution", array_of(part, "solution"));
        match kind.as_str() {
            "mcq" | "multi" => {
                let options = write_texts(
                    content,
                    &answer_map,
                    "options",
                    "o",
                    &strings(&answer, "options"),
                );
                let correct: Vec<usize> = array_of(&answer, "correct")
                    .iter()
                    .filter_map(|i| i.as_u64().map(|i| i as usize))
                    .collect();
                if kind == "mcq" {
                    if let Some((id, _)) = correct.first().and_then(|i| options.get(*i)) {
                        key.insert(keys, "correct", Any::String(Arc::from(id.as_str())));
                    }
                } else {
                    let ticks = insert_map(keys, &key, "correct");
                    for i in correct {
                        if let Some((id, _)) = options.get(i) {
                            ticks.insert(keys, id.as_str(), Any::Bool(true));
                        }
                    }
                }
            }
            "boolean" => {
                key.insert(
                    keys,
                    "correct",
                    Any::Bool(answer.get("correct").and_then(Value::as_bool) == Some(true)),
                );
            }
            "short" => {
                if let Some(unit) = answer.get("unit").and_then(Value::as_str) {
                    answer_map.insert(content, "unit", Any::String(Arc::from(unit)));
                }
                write_texts(keys, &key, "accepted", "a", &strings(&answer, "accepted"));
            }
            "open" => {
                write_texts(keys, &key, "accepted", "a", &strings(&answer, "accepted"));
                write_texts(keys, &key, "hints", "h", &strings(&answer, "hints"));
                let scheme = insert_map(keys, &key, "markscheme");
                let mut item_order: Option<String> = None;
                for (i, item) in array_of(part, "markscheme").iter().enumerate() {
                    let next = order::after(item_order.as_deref());
                    let entry = insert_map(keys, &scheme, &format!("m{i}"));
                    entry.insert(keys, "order", order_any(&next));
                    insert_text(keys, &entry, "text", str_of(item, "text"));
                    entry.insert(
                        keys,
                        "marks",
                        Any::Number(item.get("marks").and_then(Value::as_f64).unwrap_or(1.0)),
                    );
                    item_order = Some(next);
                }
            }
            "gaps" => {
                let gaps = insert_map(keys, &key, "gaps");
                for (n, accepted) in array_of(&answer, "accepted").iter().enumerate() {
                    let items: Vec<String> = accepted
                        .as_array()
                        .map(|items| {
                            items
                                .iter()
                                .map(|item| item.as_str().unwrap_or_default().to_owned())
                                .collect()
                        })
                        .unwrap_or_default();
                    write_texts(keys, &gaps, &(n + 1).to_string(), "g", &items);
                }
            }
            "matching" => {
                let pairs_json = array_of(&answer, "pairs");
                let left: Vec<String> = pairs_json
                    .iter()
                    .map(|pair| str_of(pair, "left").to_owned())
                    .collect();
                let left_ids = write_texts(content, &answer_map, "left", "l", &left);
                let options = write_texts(keys, &key, "options", "o", &strings(&answer, "options"));
                let pairs = insert_map(keys, &key, "pairs");
                for (pair, (left_id, _)) in pairs_json.iter().zip(&left_ids) {
                    if let Some((option, _)) = pair
                        .get("right")
                        .and_then(Value::as_u64)
                        .and_then(|i| options.get(i as usize))
                    {
                        pairs.insert(
                            keys,
                            left_id.as_str(),
                            Any::String(Arc::from(option.as_str())),
                        );
                    }
                }
            }
            "ordering" => {
                write_texts(keys, &key, "items", "i", &strings(&answer, "items"));
            }
            _ => {}
        }
    }
}

/// The questions of a projected (stored) quiz value.
pub fn questions_from_value(value: &[Value]) -> Vec<Value> {
    value
        .iter()
        .filter(|node| node.get("type").and_then(Value::as_str) == Some("quiz"))
        .flat_map(|block| array_of(block, "children").iter())
        .filter(|node| node.get("type").and_then(Value::as_str) == Some("quiz_question"))
        .filter_map(|node| node.get("question").cloned())
        .collect()
}

/// Both documents seeded from a stored quiz value (first open, a clone's
/// first open, a lineage rebuild), reader copies included.
pub fn states_from_value(
    value: &[Value],
    client_id: u64,
    slot: SlotSource<'_>,
) -> (Vec<u8>, Vec<u8>) {
    let content = Doc::with_options(ydoc::doc_options(client_id));
    let keys = Doc::with_options(ydoc::doc_options(client_id));
    let questions = content.get_or_insert_map(QUESTIONS_ROOT);
    let key_root = keys.get_or_insert_map(KEYS_ROOT);
    {
        let mut content_txn = content.transact_mut();
        let mut keys_txn = keys.transact_mut();
        let mut order: Option<String> = None;
        let mut seen = HashSet::new();
        for question in questions_from_value(value) {
            let id = str_of(&question, "id");
            if !valid_id(id) || !seen.insert(id.to_owned()) {
                continue;
            }
            let next = order::after(order.as_deref());
            write_question(
                &mut content_txn,
                &questions,
                &mut keys_txn,
                &key_root,
                &question,
                &next,
            );
            order = Some(next);
        }
        let parts = copy_parts(&keys_txn);
        let slots = apply_copy(&mut content_txn, &parts, slot);
        apply_slots(&mut keys_txn, &key_root, &slots);
    }
    let encode = |doc: &Doc| {
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default())
    };
    (encode(&content), encode(&keys))
}

/* --------------------------------------------------- the reader copy */

/// One matching or ordering part's entries as the keys document holds them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CopyPart {
    pub part: String,
    pub kind: String,
    /// (entry id, text, slot) in the keys' order.
    pub entries: Vec<(String, String, Option<String>)>,
}

/// Every matching and ordering part's copyable entries.
pub fn copy_parts<K: ReadTxn>(keys: &K) -> Vec<CopyPart> {
    let Some(root) = keys.get_map(KEYS_ROOT) else {
        return Vec::new();
    };
    let mut out: Vec<CopyPart> = root
        .iter(keys)
        .filter_map(|(part, value)| {
            let Out::YMap(key) = value else { return None };
            let kind = str_at(keys, &key, "type")?;
            let list = match kind.as_str() {
                "matching" => "options",
                "ordering" => "items",
                _ => return None,
            };
            let entries = ordered(keys, map_at(keys, &key, list).as_ref())
                .iter()
                .map(|entry| {
                    (
                        entry.id.clone(),
                        text_at(keys, &entry.map, "text"),
                        str_at(keys, &entry.map, "slot"),
                    )
                })
                .collect();
            Some(CopyPart {
                part: part.to_owned(),
                kind,
                entries,
            })
        })
        .collect();
    out.sort_by(|a, b| a.part.cmp(&b.part));
    out
}

/// The content document's answer map of every part, by part id.
fn answers<T: ReadTxn>(txn: &T) -> HashMap<String, MapRef> {
    let mut out = HashMap::new();
    let root = txn.get_map(QUESTIONS_ROOT);
    for question in ordered(txn, root.as_ref()) {
        for part in ordered(txn, map_at(txn, &question.map, "parts").as_ref()) {
            if let Some(answer) = map_at(txn, &part.map, "answer") {
                out.insert(part.id, answer);
            }
        }
    }
    out
}

/// Writes the reader copies (D3, decided 2026-10-10): a part whose keys
/// entries all carry slots its copy holds exactly gets each slot's text
/// mirrored as the fewest changes (a text edit reveals no order); any other
/// part's copy is rewritten whole, under fresh random slots inserted in slot
/// order, so neither the slot order nor the copy's Yjs ids follow the keys'.
/// Returns the new slots to write into the keys entries: (part, entry, slot).
pub fn apply_copy(
    content: &mut TransactionMut,
    parts: &[CopyPart],
    slot: SlotSource<'_>,
) -> Vec<(String, String, String)> {
    let answers = answers(content);
    let mut slots = Vec::new();
    for part in parts {
        let Some(answer) = answers.get(&part.part) else {
            continue;
        };
        if str_at(content, answer, "type").as_deref() != Some(part.kind.as_str()) {
            continue;
        }
        let copy = match map_at(content, answer, "copy") {
            Some(copy) => copy,
            None => insert_map(content, answer, "copy"),
        };
        let held: HashSet<String> = copy.keys(content).map(str::to_owned).collect();
        let intact = part.entries.len() == held.len()
            && part
                .entries
                .iter()
                .all(|(_, _, slot)| slot.as_ref().is_some_and(|slot| held.contains(slot)));
        if intact {
            for (_, text, slot) in &part.entries {
                let Some(slot) = slot else { continue };
                if let Some(Out::YMap(entry)) = copy.get(content, slot)
                    && let Some(Out::YText(current)) = entry.get(content, "text")
                {
                    crate::flashcards::edit_text(content, &current, text);
                }
            }
            continue;
        }
        for held in held {
            copy.remove(content, &held);
        }
        let mut fresh: Vec<(String, &str, &str)> = part
            .entries
            .iter()
            .map(|(id, text, _)| (slot(), id.as_str(), text.as_str()))
            .collect();
        fresh.sort();
        for (slot, id, text) in fresh {
            let entry = insert_map(content, &copy, &slot);
            insert_text(content, &entry, "text", text);
            slots.push((part.part.clone(), id.to_owned(), slot));
        }
    }
    slots
}

/// Writes the slots a copy rewrite assigned into the keys entries.
pub fn apply_slots(keys: &mut TransactionMut, root: &MapRef, slots: &[(String, String, String)]) {
    for (part, entry, slot) in slots {
        let Some(key) = map_at(keys, root, part) else {
            continue;
        };
        let list = match str_at(keys, &key, "type").as_deref() {
            Some("matching") => "options",
            Some("ordering") => "items",
            _ => continue,
        };
        if let Some(list) = map_at(keys, &key, list)
            && let Some(item) = map_at(keys, &list, entry)
        {
            item.insert(keys, "slot", Any::String(Arc::from(slot.as_str())));
        }
    }
}

/* ------------------------------------------------- shape and caps */

fn utf16(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

fn plain(value: &Any) -> bool {
    !matches!(value, Any::Buffer(_) | Any::BigInt(_))
}

fn refuse<T>(what: impl Into<String>) -> Result<T, String> {
    Err(format!("a quiz cannot hold {}", what.into()))
}

fn one_any(content: &ItemContent) -> Option<&Any> {
    match content {
        ItemContent::Any(values) if values.len() == 1 => values.first(),
        _ => None,
    }
}

fn is_type(content: &ItemContent, kind: fn(&TypeRef) -> bool) -> bool {
    matches!(content, ItemContent::Type(branch) if kind(branch.type_ref()))
}

fn is_map(content: &ItemContent) -> bool {
    is_type(content, |t| matches!(t, TypeRef::Map))
}

fn is_text(content: &ItemContent) -> bool {
    is_type(content, |t| matches!(t, TypeRef::Text))
}

fn order_key(content: &ItemContent) -> bool {
    matches!(one_any(content), Some(Any::String(key)) if order::valid(key))
}

fn one_of(content: &ItemContent, allowed: &[&str]) -> bool {
    matches!(one_any(content), Some(Any::String(value)) if allowed.contains(&value.as_ref()))
}

fn a_string(content: &ItemContent) -> bool {
    matches!(one_any(content), Some(Any::String(_)))
}

fn a_number(content: &ItemContent) -> bool {
    matches!(one_any(content), Some(Any::Number(value)) if value.is_finite())
}

fn a_bool(content: &ItemContent) -> bool {
    matches!(one_any(content), Some(Any::Bool(_)))
}

/// What one update adds, and which texts it types into.
struct Tally {
    growth: Growth,
    /// Full path of a text (its container keys) to the UTF-16 units added.
    typed: HashMap<Vec<Arc<str>>, u64>,
}

impl Tally {
    fn structure(&mut self, bytes: u64) {
        // A new map, text or list entry: the exact check counts the caps.
        self.growth.bytes += bytes;
        self.growth.nodes += 1;
        self.growth.over_cap = true;
    }

    fn value(&mut self, content: &ItemContent) {
        if let Some(value) = one_any(content) {
            self.growth.bytes += notes::json::value_len(&any_json(value)) as u64 + 8;
        }
    }
}

/// A block's own fields: `rest` is the path below the block id.
fn block_shape(
    rest: &[&str],
    key: Option<&str>,
    content: &ItemContent,
    path: &[Arc<str>],
    tally: &mut Tally,
) -> Result<(), String> {
    match (rest, key) {
        ([], Some("order")) if order_key(content) => tally.value(content),
        ([], Some("type")) if one_of(content, BLOCK_TYPES) => tally.value(content),
        ([], Some("label" | "attribution")) if a_string(content) => tally.value(content),
        ([], Some("header")) if a_bool(content) => tally.value(content),
        ([], Some("width" | "height")) if a_number(content) => tally.value(content),
        ([], Some("image")) => match one_any(content) {
            Some(Any::Map(image))
                if image.len() == 1
                    && matches!(image.get("assetId").or(image.get("url")), Some(Any::String(value)) if !value.trim().is_empty() && value.len() <= q::QUESTION_ASSET_URL_MAX) =>
            {
                tally.value(content)
            }
            _ => return refuse("an image that is not {assetId} or {url}"),
        },
        // A chart or graph is one value, written at its dialog's Done (D8).
        ([], Some("value")) => match one_any(content) {
            Some(Any::Map(_)) => tally.value(content),
            _ => return refuse("a chart or graph that is not one value"),
        },
        ([], Some("text" | "description")) if is_text(content) => tally.structure(32),
        ([], Some("rows" | "columns" | "cells")) if is_map(content) => tally.structure(8),
        (["rows" | "columns"], Some(id)) if valid_id(id) && order_key(content) => {
            tally.structure(8);
        }
        (["cells"], Some(cell)) if is_text(content) => {
            let mut ids = cell.split('/');
            match (ids.next(), ids.next(), ids.next()) {
                (Some(row), Some(column), None) if valid_id(row) && valid_id(column) => {
                    tally.structure(8);
                }
                _ => return refuse("a table cell keyed otherwise than row/column"),
            }
        }
        (["text" | "description"] | ["cells", _], None) => match content {
            ItemContent::String(text) => {
                tally.growth.bytes += notes::json::escaped_len(text.as_str()) as u64;
                *tally.typed.entry(path.to_vec()).or_default() += utf16(text.as_str());
            }
            _ => return refuse("anything but plain text in a question text"),
        },
        _ => return refuse("a struct outside its shape"),
    }
    Ok(())
}

/// A list entry `{order, text}` (plus `marks` in a marking scheme): `rest`
/// below the entry id.
fn entry_shape(
    rest: &[&str],
    key: Option<&str>,
    content: &ItemContent,
    path: &[Arc<str>],
    marks: bool,
    tally: &mut Tally,
) -> Result<(), String> {
    match (rest, key) {
        ([], Some("order")) if order_key(content) => tally.value(content),
        ([], Some("marks")) if marks && a_number(content) => tally.value(content),
        ([], Some("text")) if is_text(content) => tally.structure(24),
        ([], Some("slot")) => return refuse("a reader copy slot, which only the server writes"),
        (["text"], None) => match content {
            ItemContent::String(text) => {
                tally.growth.bytes += notes::json::escaped_len(text.as_str()) as u64;
                *tally.typed.entry(path.to_vec()).or_default() += utf16(text.as_str());
            }
            _ => return refuse("anything but plain text in an answer"),
        },
        _ => return refuse("a struct outside its shape"),
    }
    Ok(())
}

fn new_entry(content: &ItemContent, id: &str, tally: &mut Tally) -> Result<(), String> {
    if !valid_id(id) {
        return refuse("an id that is not 1-128 letters, digits, - or _");
    }
    if !is_map(content) {
        return refuse("an entry that is not a map");
    }
    tally.structure(id.len() as u64 + 16);
    Ok(())
}

fn contributor(content: &ItemContent) -> Result<(), String> {
    match content {
        ItemContent::Any(values) if values.iter().all(plain) => Ok(()),
        _ => refuse("a contributor marker that is not plain"),
    }
}

fn content_shape(
    path: &[&str],
    key: Option<&str>,
    content: &ItemContent,
    full: &[Arc<str>],
    tally: &mut Tally,
) -> Result<(), String> {
    const R: &str = QUESTIONS_ROOT;
    match (path, key) {
        ([R], Some(id)) => new_entry(content, id, tally),
        ([R, _], Some("order")) if order_key(content) => {
            tally.value(content);
            Ok(())
        }
        ([R, _], Some("layout")) if one_of(content, &["paper", "split"]) => {
            tally.value(content);
            Ok(())
        }
        ([R, _], Some("labels")) if one_of(content, &["letters", "numbers"]) => {
            tally.value(content);
            Ok(())
        }
        ([R, _], Some("level")) if one_of(content, &["recall", "application", "analysis"]) => {
            tally.value(content);
            Ok(())
        }
        ([R, _], Some("stem" | "parts")) if is_map(content) => {
            tally.structure(16);
            Ok(())
        }
        ([R, _, "stem"], Some(id)) | ([R, _, "parts", _, "blocks"], Some(id)) => {
            new_entry(content, id, tally)
        }
        ([R, _, "stem", _, rest @ ..], key) => block_shape(rest, key, content, full, tally),
        ([R, _, "parts"], Some(id)) => new_entry(content, id, tally),
        ([R, _, "parts", _], Some("order")) if order_key(content) => {
            tally.value(content);
            Ok(())
        }
        ([R, _, "parts", _], Some("marks")) if a_number(content) => {
            tally.value(content);
            Ok(())
        }
        ([R, _, "parts", _], Some("blocks" | "answer")) if is_map(content) => {
            tally.structure(16);
            Ok(())
        }
        ([R, _, "parts", _, "blocks", _, rest @ ..], key) => {
            block_shape(rest, key, content, full, tally)
        }
        ([R, _, "parts", _, "answer"], Some("type")) if one_of(content, ANSWER_TYPES) => {
            tally.value(content);
            Ok(())
        }
        ([R, _, "parts", _, "answer"], Some("unit")) if a_string(content) => {
            tally.value(content);
            Ok(())
        }
        ([R, _, "parts", _, "answer"], Some("options" | "left")) if is_map(content) => {
            tally.structure(16);
            Ok(())
        }
        ([R, _, "parts", _, "answer", "copy", ..], _)
        | ([R, _, "parts", _, "answer"], Some("copy")) => {
            refuse("a reader copy, which only the server writes")
        }
        ([R, _, "parts", _, "answer", "options" | "left"], Some(id)) => {
            new_entry(content, id, tally)
        }
        ([R, _, "parts", _, "answer", "options" | "left", _, rest @ ..], key) => {
            entry_shape(rest, key, content, full, false, tally)
        }
        ([ydoc::CONTRIBUTORS_ROOT], Some(_)) => contributor(content),
        _ => refuse("a struct outside its shape"),
    }
}

fn keys_shape(
    path: &[&str],
    key: Option<&str>,
    content: &ItemContent,
    full: &[Arc<str>],
    tally: &mut Tally,
) -> Result<(), String> {
    const K: &str = KEYS_ROOT;
    const LISTS: &[&str] = &["accepted", "hints", "markscheme", "options", "items"];
    match (path, key) {
        ([K], Some(id)) => new_entry(content, id, tally),
        ([K, _], Some("type")) if one_of(content, ANSWER_TYPES) => {
            tally.value(content);
            Ok(())
        }
        // mcq: an option id; boolean: true or false; multi: a map of ticks.
        ([K, _], Some("correct")) if a_string(content) || a_bool(content) || is_map(content) => {
            tally.structure(16);
            Ok(())
        }
        ([K, _, "correct"], Some(option)) if valid_id(option) => match one_any(content) {
            Some(Any::Bool(true)) => {
                tally.value(content);
                Ok(())
            }
            _ => refuse("a tick that is not true"),
        },
        ([K, _], Some(list))
            if (LISTS.contains(&list) || matches!(list, "solution" | "gaps" | "pairs"))
                && is_map(content) =>
        {
            tally.structure(16);
            Ok(())
        }
        ([K, _, "solution"], Some(id)) => new_entry(content, id, tally),
        ([K, _, "solution", _, rest @ ..], key) => block_shape(rest, key, content, full, tally),
        ([K, _, "pairs"], Some(left)) if valid_id(left) => match one_any(content) {
            Some(Any::String(option)) if valid_id(option) => {
                tally.value(content);
                Ok(())
            }
            _ => refuse("a pair that does not name an option"),
        },
        ([K, _, "gaps"], Some(number)) => match number.parse::<u32>() {
            Ok(n) if (1..=q::QUESTION_ANSWERS_MAX as u32).contains(&n) && is_map(content) => {
                tally.structure(8);
                Ok(())
            }
            _ => refuse("a gap that is not numbered 1 to 100"),
        },
        ([K, _, "gaps", _], Some(id)) => new_entry(content, id, tally),
        ([K, _, "gaps", _, _, rest @ ..], key) => {
            entry_shape(rest, key, content, full, false, tally)
        }
        ([K, _, list], Some(id)) if LISTS.contains(list) => new_entry(content, id, tally),
        ([K, _, list, _, rest @ ..], key) if LISTS.contains(list) => {
            entry_shape(rest, key, content, full, *list == "markscheme", tally)
        }
        ([ydoc::CONTRIBUTORS_ROOT], Some(_)) => contributor(content),
        _ => refuse("a struct outside its shape"),
    }
}

/// A text's cap by its path (characters; its UTF-16 length bounds them).
fn text_cap(path: &[&str], open_part: bool) -> usize {
    match path {
        [KEYS_ROOT, _, "markscheme", _, "text"] => q::QUESTION_MARK_ITEM_MAX,
        [KEYS_ROOT, _, "accepted", _, "text"] if open_part => q::QUIZ_OPEN_ANSWER_MAX,
        _ => q::QUESTION_TEXT_MAX,
    }
}

/// The text at `path` (keys from a root), when the document holds it.
fn text_by_path<T: ReadTxn>(txn: &T, path: &[Arc<str>]) -> Option<TextRef> {
    let (root, rest) = path.split_first()?;
    let (last, between) = rest.split_last()?;
    let mut map = txn.get_map(&**root)?;
    for key in between {
        map = map_at(txn, &map, key)?;
    }
    match map.get(txn, last) {
        Some(Out::YText(text)) => Some(text),
        _ => None,
    }
}

fn open_part<T: ReadTxn>(txn: &T, part: &str) -> bool {
    txn.get_map(KEYS_ROOT)
        .and_then(|root| map_at(txn, &root, part))
        .is_some_and(|key| str_at(txn, &key, "type").as_deref() == Some("open"))
}

/// One document's shape table: a struct's container path, its key, its
/// content and its full path, tallied.
type Shape = fn(&[&str], Option<&str>, &ItemContent, &[Arc<str>], &mut Tally) -> Result<(), String>;

fn admit<T: ReadTxn>(txn: &T, incoming: &Incoming, shape: Shape) -> Result<Growth, String> {
    let state = txn.state_vector();
    let mut locator = Locator::new(txn, incoming);
    let mut tally = Tally {
        growth: Growth::default(),
        typed: HashMap::new(),
    };
    for item in incoming.items() {
        step(Walk::Content);
        let id = item.id();
        if id.clock + item.len() <= state.get(&id.client) {
            continue;
        }
        let content = item.content();
        if matches!(content, ItemContent::Deleted(_)) {
            continue;
        }
        let (path, key) = match locator.place(item) {
            Place::Gone => continue,
            Place::Unknown => return refuse("a struct outside its shape"),
            Place::At { path, key } => (path, key),
        };
        let keys: Vec<&str> = path.iter().map(|k| &**k).collect();
        shape(&keys, key.as_deref(), content, &path, &mut tally)?;
    }
    for (path, units) in &tally.typed {
        let keys: Vec<&str> = path.iter().map(|k| &**k).collect();
        let open =
            matches!(keys.as_slice(), [KEYS_ROOT, part, "accepted", ..] if open_part(txn, part));
        let current = text_by_path(txn, path).map_or(0, |text| u64::from(text.len(txn)));
        if current + units > text_cap(&keys, open) as u64 {
            tally.growth.over_cap = true;
        }
    }
    Ok(tally.growth)
}

/// Checks each struct a writer's update adds to the content document against
/// its shape, and bounds what it adds. A new structure (a question, part,
/// block, entry or text) goes to the exact check, which counts the caps;
/// typing into an existing text takes the bound unless it may pass the cap.
pub fn admit_content<T: ReadTxn>(txn: &T, incoming: &Incoming) -> Result<Growth, String> {
    admit(txn, incoming, content_shape)
}

/// The same for the keys document.
pub fn admit_keys<T: ReadTxn>(txn: &T, incoming: &Incoming) -> Result<Growth, String> {
    admit(txn, incoming, keys_shape)
}

fn chars(text: &str) -> usize {
    text.chars().count()
}

fn check_text(text: &str, cap: usize, what: &str) -> Result<(), String> {
    if chars(text) > cap {
        return Err(format!("{what} holds at most {cap} characters"));
    }
    Ok(())
}

fn check_count(count: usize, cap: usize, what: &str) -> Result<(), String> {
    if count > cap {
        return Err(format!("{what} holds at most {cap}"));
    }
    Ok(())
}

fn check_marks(marks: Option<f64>, what: &str) -> Result<(), String> {
    match marks {
        None => Ok(()),
        Some(marks) if marks.fract() == 0.0 && (1.0..=MAX_MARKS).contains(&marks) => Ok(()),
        Some(_) => Err(format!("{what} carries 1 to {MAX_MARKS} whole marks")),
    }
}

fn check_blocks<T: ReadTxn>(txn: &T, map: Option<&MapRef>) -> Result<(), String> {
    let blocks = ordered(txn, map);
    check_count(blocks.len(), q::QUESTION_BLOCKS_MAX, "a section")?;
    for block in &blocks {
        for field in ["text", "description"] {
            check_text(
                &text_at(txn, &block.map, field),
                q::QUESTION_TEXT_MAX,
                "a question text",
            )?;
        }
        if let Some(label) = str_at(txn, &block.map, "label") {
            check_text(&label, q::QUESTION_TEXT_MAX, "a label")?;
        }
        let rows = map_at(txn, &block.map, "rows").map_or(0, |m| m.len(txn) as usize);
        let columns = map_at(txn, &block.map, "columns").map_or(0, |m| m.len(txn) as usize);
        check_count(rows, q::QUESTION_TABLE_ROWS_MAX, "a table's rows")?;
        check_count(columns, q::QUESTION_TABLE_COLUMNS_MAX, "a table's columns")?;
        if let Some(cells) = map_at(txn, &block.map, "cells") {
            check_count(
                cells.len(txn) as usize,
                q::QUESTION_TABLE_ROWS_MAX * q::QUESTION_TABLE_COLUMNS_MAX,
                "a table's cells",
            )?;
            for (_, value) in cells.iter(txn) {
                if let Out::YText(text) = value {
                    check_text(&text.get_string(txn), q::QUESTION_TEXT_MAX, "a table cell")?;
                }
            }
        }
    }
    Ok(())
}

fn check_list<T: ReadTxn>(
    txn: &T,
    map: Option<&MapRef>,
    cap: usize,
    text_cap: usize,
    what: &str,
) -> Result<(), String> {
    let items = ordered(txn, map);
    check_count(items.len(), cap, what)?;
    for item in &items {
        check_text(&text_at(txn, &item.map, "text"), text_cap, what)?;
    }
    Ok(())
}

/// The content document's caps, exactly (the exact check's candidate).
pub fn check_content_caps<T: ReadTxn>(txn: &T) -> Result<(), String> {
    let root = txn.get_map(QUESTIONS_ROOT);
    let questions = ordered(txn, root.as_ref());
    let (mut parts, mut open) = (0usize, 0usize);
    for question in &questions {
        check_blocks(txn, map_at(txn, &question.map, "stem").as_ref())?;
        let question_parts = ordered(txn, map_at(txn, &question.map, "parts").as_ref());
        check_count(
            question_parts.len(),
            q::QUIZ_QUESTION_PARTS_MAX,
            "a question's parts",
        )?;
        parts += question_parts.len();
        for part in &question_parts {
            check_marks(num_at(txn, &part.map, "marks"), "a part")?;
            check_blocks(txn, map_at(txn, &part.map, "blocks").as_ref())?;
            let Some(answer) = map_at(txn, &part.map, "answer") else {
                continue;
            };
            if str_at(txn, &answer, "type").as_deref() == Some("open") {
                open += 1;
            }
            if let Some(unit) = str_at(txn, &answer, "unit") {
                check_text(&unit, q::QUESTION_UNIT_MAX, "a unit")?;
            }
            for list in ["options", "left"] {
                check_list(
                    txn,
                    map_at(txn, &answer, list).as_ref(),
                    q::QUESTION_ANSWERS_MAX,
                    q::QUESTION_TEXT_MAX,
                    "an answer list",
                )?;
            }
        }
    }
    check_count(parts, q::QUIZ_PARTS_MAX, "a quiz's parts")?;
    check_count(open, q::QUIZ_OPEN_PARTS_MAX, "a quiz's open parts")
}

/// The keys document's caps, exactly.
pub fn check_keys_caps<T: ReadTxn>(txn: &T) -> Result<(), String> {
    let Some(root) = txn.get_map(KEYS_ROOT) else {
        return Ok(());
    };
    check_count(
        root.len(txn) as usize,
        q::QUIZ_PARTS_MAX * 2,
        "a quiz's keys",
    )?;
    for (_, value) in root.iter(txn) {
        let Out::YMap(key) = value else { continue };
        check_blocks(txn, map_at(txn, &key, "solution").as_ref())?;
        let open = str_at(txn, &key, "type").as_deref() == Some("open");
        let accepted_cap = if open {
            q::QUIZ_OPEN_ANSWER_MAX
        } else {
            q::QUESTION_TEXT_MAX
        };
        check_list(
            txn,
            map_at(txn, &key, "accepted").as_ref(),
            q::QUESTION_ANSWERS_MAX,
            accepted_cap,
            "accepted answers",
        )?;
        for list in ["hints", "options", "items"] {
            check_list(
                txn,
                map_at(txn, &key, list).as_ref(),
                q::QUESTION_ANSWERS_MAX,
                q::QUESTION_TEXT_MAX,
                "an answer list",
            )?;
        }
        let scheme = ordered(txn, map_at(txn, &key, "markscheme").as_ref());
        check_count(scheme.len(), q::QUIZ_MARKSCHEME_MAX, "a marking scheme")?;
        for item in &scheme {
            check_text(
                &text_at(txn, &item.map, "text"),
                q::QUESTION_MARK_ITEM_MAX,
                "a marking item",
            )?;
            check_marks(num_at(txn, &item.map, "marks"), "a marking item")?;
        }
        if let Some(gaps) = map_at(txn, &key, "gaps") {
            check_count(
                gaps.len(txn) as usize,
                q::QUESTION_ANSWERS_MAX,
                "a part's gaps",
            )?;
            for (_, list) in gaps.iter(txn) {
                if let Out::YMap(list) = list {
                    check_list(
                        txn,
                        Some(&list),
                        q::QUESTION_ANSWERS_MAX,
                        q::QUESTION_TEXT_MAX,
                        "a gap's accepted answers",
                    )?;
                }
            }
        }
    }
    Ok(())
}

/* ------------------------------------------- the server's own writes */

fn question_map<T: ReadTxn>(txn: &T, id: &str) -> Option<MapRef> {
    map_at(txn, &txn.get_map(QUESTIONS_ROOT)?, id)
}

fn part_ids<T: ReadTxn>(txn: &T, question: &MapRef) -> Vec<String> {
    map_at(txn, question, "parts")
        .map(|parts| parts.keys(txn).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// A question as editors read it now (JSON), or none.
fn read_question<C: ReadTxn, K: ReadTxn>(content: &C, keys: &K, id: &str) -> Option<Value> {
    let map = question_map(content, id)?;
    Some(question_json(content, Some(&KeysRead::new(keys)), id, &map))
}

fn remove_question(content: &mut TransactionMut, keys: &mut TransactionMut, id: &str) {
    let Some(map) = question_map(content, id) else {
        return;
    };
    let parts = part_ids(content, &map);
    let questions = content.get_or_insert_map(QUESTIONS_ROOT);
    questions.remove(content, id);
    let key_root = keys.get_or_insert_map(KEYS_ROOT);
    for part in parts {
        key_root.remove(keys, &part);
    }
}

/// Replaces (or inserts) one question wholesale under `order`.
fn put_question(
    content: &mut TransactionMut,
    keys: &mut TransactionMut,
    question: &Value,
    order: &str,
) {
    let id = str_of(question, "id").to_owned();
    remove_question(content, keys, &id);
    let questions = content.get_or_insert_map(QUESTIONS_ROOT);
    let key_root = keys.get_or_insert_map(KEYS_ROOT);
    write_question(content, &questions, keys, &key_root, question, order);
}

fn sync_copies(content: &mut TransactionMut, keys: &mut TransactionMut, slot: SlotSource<'_>) {
    let parts = copy_parts(keys);
    let slots = apply_copy(content, &parts, slot);
    let root = keys.get_or_insert_map(KEYS_ROOT);
    apply_slots(keys, &root, &slots);
}

/// The quiz holds exactly `questions` afterwards (the content save API, D7,
/// no revision): a question that reads the same stays untouched, a changed
/// one is rewritten whole in both documents (its ids kept), new ones go in,
/// missing ones go, and the order follows the list. Reader copies follow.
pub fn set_questions(
    content: &mut TransactionMut,
    keys: &mut TransactionMut,
    questions: &[Value],
    slot: SlotSource<'_>,
) -> Result<(), String> {
    let mut seen = HashSet::new();
    for question in questions {
        let id = str_of(question, "id");
        if !valid_id(id) || !seen.insert(id.to_owned()) {
            return Err("invalid or repeated question id".into());
        }
    }
    let current: Vec<String> = ordered(content, content.get_map(QUESTIONS_ROOT).as_ref())
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    for id in &current {
        if !seen.contains(id) {
            remove_question(content, keys, id);
        }
    }
    let mut previous: Option<String> = None;
    for question in questions {
        let id = str_of(question, "id");
        let unchanged = read_question(content, keys, id).as_ref() == Some(question);
        let existing = question_map(content, id).and_then(|map| str_at(content, &map, "order"));
        let key = match existing {
            Some(key) if previous.as_deref().is_none_or(|p| p < key.as_str()) => key,
            _ => order::after(previous.as_deref()),
        };
        if unchanged {
            if let Some(map) = question_map(content, id)
                && str_at(content, &map, "order").as_deref() != Some(key.as_str())
            {
                map.insert(content, "order", order_any(&key));
            }
        } else {
            put_question(content, keys, question, &key);
        }
        previous = Some(key);
    }
    sync_copies(content, keys, slot);
    Ok(())
}

fn unavailable<T>(message: String) -> Result<T, EditError> {
    Err(EditError::Edit {
        code: EditErrorCode::UnavailableTarget,
        message,
        details: None,
    })
}

fn invalid<T>(code: EditErrorCode, message: impl Into<String>) -> Result<T, EditError> {
    Err(EditError::Edit {
        code,
        message: message.into(),
        details: None,
    })
}

fn question_value<C: ReadTxn, K: ReadTxn>(content: &C, keys: &K, id: &str) -> Value {
    read_question(content, keys, id)
        .map(question_node)
        .unwrap_or(Value::Null)
}

fn parse_question(node: &Value, what: &str) -> Result<Value, EditError> {
    match node.get("question") {
        Some(question) if node.get("type").and_then(Value::as_str) == Some("quiz_question") => {
            Ok(question.clone())
        }
        _ => invalid(
            EditErrorCode::InvalidInput,
            format!("{what} needs a quiz_question"),
        ),
    }
}

/// The agent's question commands (`replace_child`, `insert_child`,
/// `remove_child` on the `quiz` parent) on both documents, with inverses and
/// guards (each touched question as it reads afterwards).
pub fn apply_commands(
    content: &mut TransactionMut,
    keys: &mut TransactionMut,
    commands: &[DocumentCommand],
    slot: SlotSource<'_>,
) -> Result<EditOutcome, EditError> {
    let mut outcome = EditOutcome::default();
    let mut touched: Vec<String> = Vec::new();
    for command in commands {
        let order: Vec<Entry> = ordered(content, content.get_map(QUESTIONS_ROOT).as_ref());
        match command {
            DocumentCommand::ReplaceChild {
                parent_type,
                node_id,
                node,
            } if parent_type == "quiz" => {
                let Some(at) = order.iter().position(|e| &e.id == node_id) else {
                    return unavailable(format!("{node_id} no longer exists"));
                };
                let question = parse_question(node, "replace_child")?;
                if question.get("id").and_then(Value::as_str) != Some(node_id.as_str()) {
                    return invalid(
                        EditErrorCode::InvalidInput,
                        "replacement must keep the node id",
                    );
                }
                let previous = question_value(content, keys, node_id);
                put_question(content, keys, &question, &order[at].order);
                outcome.inverse.insert(
                    0,
                    DocumentCommand::ReplaceChild {
                        node: previous,
                        node_id: node_id.clone(),
                        parent_type: parent_type.clone(),
                    },
                );
                touched.push(node_id.clone());
            }
            DocumentCommand::InsertChild {
                parent_type,
                after_node_id,
                node,
            } if parent_type == "quiz" => {
                let question = parse_question(node, "insert_child")?;
                let id = str_of(&question, "id").to_owned();
                if !valid_id(&id) {
                    return invalid(EditErrorCode::InvalidInput, "invalid question id");
                }
                if order.iter().any(|e| e.id == id) {
                    return invalid(EditErrorCode::StaleTarget, format!("{id} already exists"));
                }
                let at = match after_node_id {
                    None => 0,
                    Some(after) => match order.iter().position(|e| &e.id == after) {
                        Some(i) => i + 1,
                        None => return unavailable(format!("{after} no longer exists")),
                    },
                };
                let before = at.checked_sub(1).map(|i| order[i].order.as_str());
                let after = order.get(at).map(|e| e.order.as_str());
                let key = order::between(before, after).unwrap_or_else(|| order::after(before));
                put_question(content, keys, &question, &key);
                outcome.inverse.insert(
                    0,
                    DocumentCommand::RemoveChild {
                        node_id: id.clone(),
                        parent_type: parent_type.clone(),
                    },
                );
                touched.push(id);
            }
            DocumentCommand::RemoveChild {
                parent_type,
                node_id,
            } if parent_type == "quiz" => {
                let Some(at) = order.iter().position(|e| &e.id == node_id) else {
                    return unavailable(format!("{node_id} no longer exists"));
                };
                let previous = question_value(content, keys, node_id);
                remove_question(content, keys, node_id);
                outcome.inverse.insert(
                    0,
                    DocumentCommand::InsertChild {
                        after_node_id: at.checked_sub(1).map(|i| order[i].id.clone()),
                        node: previous,
                        parent_type: parent_type.clone(),
                    },
                );
                touched.push(node_id.clone());
            }
            _ => {
                return invalid(
                    EditErrorCode::UnsupportedOperation,
                    "use the question commands for this material",
                );
            }
        }
    }
    sync_copies(content, keys, slot);
    touched.dedup();
    outcome.guards = touched
        .iter()
        .map(|id| GuardTarget::Item {
            path: vec![QUESTIONS_ROOT.into(), id.clone()],
            value: question_value(content, keys, id),
        })
        .collect();
    Ok(outcome)
}

/// Undo's check: every question an edit touched reads as the edit left it.
pub fn verify_guards<C: ReadTxn, K: ReadTxn>(
    content: &C,
    keys: &K,
    guards: &[GuardTarget],
) -> Result<(), EditError> {
    for target in guards {
        let GuardTarget::Item { path, value } = target else {
            return invalid(
                EditErrorCode::StaleTarget,
                "the quiz changed since this edit",
            );
        };
        let [root, id] = path.as_slice() else {
            return invalid(
                EditErrorCode::StaleTarget,
                "the quiz changed since this edit",
            );
        };
        if root != QUESTIONS_ROOT || &question_value(content, keys, id) != value {
            return invalid(
                EditErrorCode::StaleTarget,
                format!("question {id} changed since this edit"),
            );
        }
    }
    Ok(())
}

/// The quiz block JSON's questions, for the save API.
pub fn block_questions(block: &Value) -> Result<Vec<Value>, String> {
    if block.get("type").and_then(Value::as_str) != Some("quiz") {
        return Err("replacement must be a quiz block".into());
    }
    Ok(questions_from_value(std::slice::from_ref(block)))
}
