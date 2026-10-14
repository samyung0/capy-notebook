//! Quiz documents (live-items DESIGN.md 1.2, 1.3; Epo 2026-10-10). A quiz
//! has two: the content document (`material:<id>:schema:<n>`), which readers
//! join too, and the keys document (`keys:<id>:schema:<n>`), which only
//! editors with write access join, so answer keys never reach a reader.
//!
//! Content: `questions`, question id to `{order, layout, labels, level?,
//! stem, parts}`; part id to `{order, marks, blocks, answer}`; the answer map
//! holds the type and what a learner may see: mcq `options`, a
//! short answer's `unit` and matching `left` items.
//!
//! Keys: `keys`, part id to `{type, solution, correct | accepted | hints |
//! markscheme | gaps | options | pairs | items}`. Editors type ordering items
//! and matching options here, where their Yjs ids record typing order (for
//! ordering, usually the answer). Readers get those items outside Yjs, as a
//! plain shuffled list per part the content room pushes ([ReaderLists];
//! D3 as revised 2026-10-10), so the content document holds nothing derived
//! from them and nothing in either document is written by the server alone.
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
    "mcq", "boolean", "short", "matching", "ordering", "open", "gaps",
];
/// The question block kinds a live quiz holds: the embed catalog's question
/// blocks (chart, plot, graph) and the plain ones it does not list.
pub const BLOCK_TYPES: &[&str] = &["text", "table", "image", "chart", "plot", "graph"];
/// Whole marks a part or a marking item carries.
const MAX_MARKS: f64 = q::QUESTION_MARKS_MAX;
/// An open part's sample answers: at most one, optional (Epo 2026-10-15).
const OPEN_ACCEPTED_MAX: usize = 1;

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
                step(Walk::Exact);
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

/// A table's row or column ids with their order keys, in order.
fn ordered_pairs<T: ReadTxn>(txn: &T, map: Option<&MapRef>) -> Vec<(String, String)> {
    let Some(map) = map else {
        return Vec::new();
    };
    let mut out: Vec<(String, String)> = map
        .iter(txn)
        .map(|(id, value)| {
            step(Walk::Exact);
            let order = match value {
                Out::Any(Any::String(order)) => order.to_string(),
                _ => String::new(),
            };
            (order, id.to_owned())
        })
        .collect();
    out.sort();
    out.into_iter().map(|(order, id)| (id, order)).collect()
}

/// A table's row or column ids, in order.
fn ordered_keys<T: ReadTxn>(txn: &T, map: Option<&MapRef>) -> Vec<String> {
    ordered_pairs(txn, map)
        .into_iter()
        .map(|(id, _)| id)
        .collect()
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
            });
            // An image without a description holds an empty text (optional).
            let description = text_at(txn, map, "description");
            if !description.is_empty() {
                block["description"] = json!(description);
            }
            if let Some(attribution) = str_at(txn, map, "attribution") {
                block["attribution"] = json!(attribution);
            }
            Some(block)
        }
        "chart" | "plot" | "graph" => match any_at(txn, map, "value") {
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

/// Whether a quiz document (content or keys) holds a question block of a
/// kind the room does not admit ([BLOCK_TYPES]), which [read_block] cannot
/// read: a stored quiz a newer version wrote. Its rooms load read-only (Epo
/// 2026-10-13), as a note holding a block the embed catalog does not list.
pub fn holds_unknown_block<T: ReadTxn>(txn: &T) -> bool {
    let unknown = |blocks: Option<MapRef>| {
        ordered(txn, blocks.as_ref()).iter().any(|block| {
            str_at(txn, &block.map, "type")
                .is_some_and(|kind| !BLOCK_TYPES.contains(&kind.as_str()))
        })
    };
    let questions = ordered(txn, txn.get_map(QUESTIONS_ROOT).as_ref());
    let keys = ordered(txn, txn.get_map(KEYS_ROOT).as_ref());
    questions.iter().any(|question| {
        unknown(map_at(txn, &question.map, "stem"))
            || ordered(txn, map_at(txn, &question.map, "parts").as_ref())
                .iter()
                .any(|part| unknown(map_at(txn, &part.map, "blocks")))
    }) || keys
        .iter()
        .any(|part| unknown(map_at(txn, &part.map, "solution")))
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
        "mcq" => {
            let options = ordered(
                content,
                answer.and_then(|a| map_at(content, a, "options")).as_ref(),
            );
            // The correct options are a map of ticks by option id.
            let correct: Vec<usize> = match keys {
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

/// The question without blanks, as `withoutBlanks` in the browser: empty text
/// blocks, a blank short-answer unit, blank accepted answers (a gap's too) and
/// blank open-answer hints never leave it incomplete (no accepted answer left
/// does), and the projection drops them; a blank figure description goes, and
/// a chart series short of its labels takes nulls, an empty value being null
/// (Epo 2026-10-14). Blank marking items go too, and then the part's marks are
/// the rest's total capped at QUESTION_MARKS_MAX (Epo 2026-10-15). A room's
/// table is a grid, so its rows are always even.
fn without_blanks(mut question: Value) -> Value {
    let blank = |value: &Value| {
        value
            .as_str()
            .is_some_and(|text| q::js_trim(text).is_empty())
    };
    let keep = |blocks: &mut Value| {
        let Some(blocks) = blocks.as_array_mut() else {
            return;
        };
        blocks.retain(|block| block["type"] != "text" || !blank(&block["text"]));
        for block in blocks.iter_mut().filter_map(Value::as_object_mut) {
            if block.get("description").is_some_and(blank) {
                block.remove("description");
            }
            if block.get("type").and_then(Value::as_str) != Some("chart") {
                continue;
            }
            let labels = block
                .get("labels")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let series = block.get_mut("series").and_then(Value::as_array_mut);
            for values in series
                .into_iter()
                .flatten()
                .filter_map(|series| series.get_mut("values").and_then(Value::as_array_mut))
            {
                if values.len() < labels {
                    values.resize(labels, Value::Null);
                }
                for value in values.iter_mut().filter(|value| !value.is_number()) {
                    *value = Value::Null;
                }
            }
        }
    };
    keep(&mut question["stem"]);
    if let Some(parts) = question["parts"].as_array_mut() {
        for part in parts {
            keep(&mut part["blocks"]);
            keep(&mut part["solution"]);
            if let Some(answer) = part["answer"].as_object_mut() {
                if answer.get("unit").is_some_and(blank) {
                    answer.remove("unit");
                }
                // Short and open answers' lists of texts; a gaps answer's
                // accepted lists hold one list per gap.
                for key in ["accepted", "hints"] {
                    if let Some(list) = answer.get_mut(key).and_then(Value::as_array_mut) {
                        list.retain(|item| !blank(item));
                        for gap in list.iter_mut().filter_map(Value::as_array_mut) {
                            gap.retain(|item| !blank(item));
                        }
                    }
                }
            }
            if let Some(items) = part.get_mut("markscheme").and_then(Value::as_array_mut) {
                let before = items.len();
                items.retain(|item| !blank(&item["text"]));
                if items.len() != before {
                    let total: f64 = items.iter().filter_map(|item| item["marks"].as_f64()).sum();
                    part["marks"] = number(total.min(MAX_MARKS));
                }
            }
        }
    }
    question
}

/// The Plate value the quiz projects to (`materials.content`): the complete
/// questions only (each passes the strict validator, and the quiz's part and
/// open-part bounds hold), so grading sees what a Save would have stored.
pub fn value<C: ReadTxn, K: ReadTxn>(content: &C, keys: &K) -> Vec<Value> {
    let keys = KeysRead::new(keys);
    let policy = Policy::quiz();
    let (mut parts, mut open) = (0usize, 0usize);
    let mut children = Vec::new();
    for question in questions_json(content, Some(&keys))
        .into_iter()
        .map(without_blanks)
    {
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

/// Every editor asset the quiz's documents reference, complete questions or
/// not: an image in a question still being written stays in use (REVIEW1 S4).
pub fn asset_ids<C: ReadTxn, K: ReadTxn>(content: &C, keys: &K) -> Vec<String> {
    fn walk(value: &Value, ids: &mut std::collections::BTreeSet<String>) {
        match value {
            Value::Object(map) => {
                if let Some(Value::String(id)) = map.get("assetId")
                    && !id.trim().is_empty()
                {
                    ids.insert(id.clone());
                }
                for value in map.values() {
                    walk(value, ids);
                }
            }
            Value::Array(items) => {
                for value in items {
                    walk(value, ids);
                }
            }
            _ => {}
        }
    }
    let mut ids = std::collections::BTreeSet::new();
    for question in questions_json(content, Some(&KeysRead::new(keys))) {
        walk(&question, &mut ids);
    }
    ids.into_iter().collect()
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

// Every server write of a question (the first open, the save API, the
// agent's commands) goes through `sync_question`: it writes only what
// differs from what the documents hold, texts as the fewest changes and
// lists by position, so an editor typing into the same question keeps every
// character (D7: no revision check; REVIEW1 S6). On empty documents it
// writes the question whole.

fn order_any(key: &str) -> Any {
    Any::String(Arc::from(key))
}

fn string_any(value: &str) -> Any {
    Any::String(Arc::from(value))
}

/// The map under `key`, created when missing (or holding something else).
fn child_map(txn: &mut TransactionMut, parent: &MapRef, key: &str) -> MapRef {
    match parent.get(txn, key) {
        Some(Out::YMap(map)) => map,
        _ => parent.insert(txn, key, MapPrelim::default()),
    }
}

/// Sets a plain value (none removes it), writing only a change.
fn sync_plain(txn: &mut TransactionMut, map: &MapRef, key: &str, value: Option<Any>) {
    match value {
        Some(value) => {
            if any_at(txn, map, key).as_ref() != Some(&value) {
                map.insert(txn, key, value);
            }
        }
        None => {
            if map.contains_key(txn, key) {
                map.remove(txn, key);
            }
        }
    }
}

/// The text under `key` reads `text` afterwards, changed as little as can be.
fn sync_text(txn: &mut TransactionMut, map: &MapRef, key: &str, text: &str) {
    match map.get(txn, key) {
        Some(Out::YText(current)) => crate::flashcards::edit_text(txn, &current, text),
        _ => {
            map.insert(txn, key, TextPrelim::new(text));
        }
    }
}

/// Removes every field of `map` but its order key.
fn clear(txn: &mut TransactionMut, map: &MapRef) {
    let fields: Vec<String> = map
        .keys(txn)
        .filter(|key| *key != "order")
        .map(str::to_owned)
        .collect();
    for field in fields {
        map.remove(txn, &field);
    }
}

/// An id `prefix<n>` (from `n` up) the map does not hold.
fn fresh_id<T: ReadTxn>(txn: &T, map: &MapRef, prefix: &str, n: &mut usize) -> String {
    loop {
        let id = format!("{prefix}{n}");
        *n += 1;
        if !map.contains_key(txn, &id) {
            return id;
        }
    }
}

/// An order key after `last` for an entry whose key is `held`: the held one
/// while it still sorts after `last`.
fn next_order(held: Option<&str>, last: Option<&str>) -> String {
    match held {
        Some(held) if !held.is_empty() && last.is_none_or(|last| last < held) => held.to_owned(),
        _ => order::after(last),
    }
}

/// The list of entries under `key` holds one entry per item afterwards, by
/// position: the i-th entry is filled from the i-th item, extra items get
/// fresh entries after the last, extra entries go. The entry ids, in order.
fn sync_entries<I>(
    txn: &mut TransactionMut,
    parent: &MapRef,
    key: &str,
    prefix: &str,
    items: &[I],
    mut fill: impl FnMut(&mut TransactionMut, &MapRef, &I),
) -> Vec<String> {
    let list = child_map(txn, parent, key);
    let held = ordered(txn, Some(&list));
    let mut ids = Vec::with_capacity(items.len());
    let mut last: Option<String> = None;
    let mut n = 0;
    for (i, item) in items.iter().enumerate() {
        let entry = match held.get(i) {
            Some(entry) => {
                ids.push(entry.id.clone());
                entry.map.clone()
            }
            None => {
                let id = fresh_id(txn, &list, prefix, &mut n);
                ids.push(id.clone());
                list.insert(txn, id, MapPrelim::default())
            }
        };
        let held_order = held.get(i).map(|entry| entry.order.as_str());
        let order = next_order(held_order, last.as_deref());
        sync_plain(txn, &entry, "order", Some(order_any(&order)));
        last = Some(order);
        fill(txn, &entry, item);
    }
    for entry in held.iter().skip(items.len()) {
        list.remove(txn, &entry.id);
    }
    ids
}

// `sync_entries` hands each item by reference; a list of texts is Strings.
#[allow(clippy::ptr_arg)]
fn text_fill(txn: &mut TransactionMut, entry: &MapRef, text: &String) {
    sync_text(txn, entry, "text", text);
}

/// A table's row or column ids (id to order key) for `count` of them, by
/// position, in order.
fn sync_keys(
    txn: &mut TransactionMut,
    parent: &MapRef,
    key: &str,
    prefix: &str,
    count: usize,
) -> Vec<String> {
    let map = child_map(txn, parent, key);
    let held = ordered_pairs(txn, Some(&map));
    let mut ids = Vec::with_capacity(count);
    let mut last: Option<String> = None;
    let mut n = 0;
    for i in 0..count {
        let id = match held.get(i) {
            Some((id, _)) => id.clone(),
            None => fresh_id(txn, &map, prefix, &mut n),
        };
        let held_order = held.get(i).map(|(_, order)| order.as_str());
        let order = next_order(held_order, last.as_deref());
        sync_plain(txn, &map, &id, Some(order_any(&order)));
        last = Some(order);
        ids.push(id);
    }
    for (id, _) in held.iter().skip(count) {
        map.remove(txn, id);
    }
    ids
}

fn sync_block(txn: &mut TransactionMut, map: &MapRef, block: &Value) {
    let kind = str_of(block, "type");
    if str_at(txn, map, "type").as_deref() != Some(kind) {
        clear(txn, map);
        map.insert(txn, "type", string_any(kind));
    }
    let plain_str = |key: &str| block.get(key).and_then(Value::as_str).map(string_any);
    match kind {
        "text" => {
            sync_text(txn, map, "text", str_of(block, "text"));
            sync_plain(txn, map, "label", plain_str("label"));
        }
        "table" => {
            let header = block.get("header").and_then(Value::as_bool) == Some(true);
            sync_plain(txn, map, "header", Some(Any::Bool(header)));
            let grid = array_of(block, "rows");
            let width = grid
                .iter()
                .map(|row| row.as_array().map_or(0, Vec::len))
                .max()
                .unwrap_or(0);
            let columns = sync_keys(txn, map, "columns", "c", width);
            let rows = sync_keys(txn, map, "rows", "r", grid.len());
            let cells = child_map(txn, map, "cells");
            let mut kept = HashSet::new();
            for (row, row_id) in grid.iter().zip(&rows) {
                for (c, column_id) in columns.iter().enumerate() {
                    let cell = format!("{row_id}/{column_id}");
                    let text = row.get(c).and_then(Value::as_str).unwrap_or_default();
                    sync_text(txn, &cells, &cell, text);
                    kept.insert(cell);
                }
            }
            let stale: Vec<String> = cells
                .keys(txn)
                .filter(|cell| !kept.contains(*cell))
                .map(str::to_owned)
                .collect();
            for cell in stale {
                cells.remove(txn, &cell);
            }
        }
        "image" => {
            sync_plain(txn, map, "image", block.get("image").map(json_any));
            for field in ["width", "height"] {
                let value = block.get(field).and_then(Value::as_f64).map(Any::Number);
                sync_plain(txn, map, field, value);
            }
            sync_text(txn, map, "description", str_of(block, "description"));
            sync_plain(txn, map, "attribution", plain_str("attribution"));
        }
        _ => {
            let mut value = block.clone();
            if let Some(object) = value.as_object_mut() {
                object.remove("type");
            }
            sync_plain(txn, map, "value", Some(json_any(&value)));
        }
    }
}

fn sync_blocks(txn: &mut TransactionMut, parent: &MapRef, key: &str, blocks: &[Value]) {
    sync_entries(txn, parent, key, "b", blocks, sync_block);
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

fn strings(value: &Value, key: &str) -> Vec<String> {
    array_of(value, key)
        .iter()
        .map(|item| item.as_str().unwrap_or_default().to_owned())
        .collect()
}

/// Removes the keys of `map` that `keep` refuses.
fn remove_keys(txn: &mut TransactionMut, map: &MapRef, keep: impl Fn(&str) -> bool) {
    let stale: Vec<String> = map
        .keys(txn)
        .filter(|key| !keep(key))
        .map(str::to_owned)
        .collect();
    for key in stale {
        map.remove(txn, &key);
    }
}

/// A part's answer in both documents: the learner's side in the content
/// document's answer map, the keys in the part's keys entry. Another answer
/// type starts both over.
fn sync_answer(
    content: &mut TransactionMut,
    part_map: &MapRef,
    keys: &mut TransactionMut,
    key_root: &MapRef,
    part: &Value,
) {
    let answer = part.get("answer").cloned().unwrap_or(Value::Null);
    let kind = str_of(&answer, "type").to_owned();
    let answer_map = child_map(content, part_map, "answer");
    let key = child_map(keys, key_root, str_of(part, "id"));
    if str_at(content, &answer_map, "type").as_deref() != Some(kind.as_str()) {
        clear(content, &answer_map);
    }
    if str_at(keys, &key, "type").as_deref() != Some(kind.as_str()) {
        clear(keys, &key);
    }
    sync_plain(content, &answer_map, "type", Some(string_any(&kind)));
    sync_plain(keys, &key, "type", Some(string_any(&kind)));
    sync_blocks(keys, &key, "solution", array_of(part, "solution"));
    let indexes: Vec<usize> = array_of(&answer, "correct")
        .iter()
        .filter_map(|i| i.as_u64().map(|i| i as usize))
        .collect();
    match kind.as_str() {
        "mcq" => {
            let options = strings(&answer, "options");
            let ids = sync_entries(content, &answer_map, "options", "o", &options, text_fill);
            let ticks = child_map(keys, &key, "correct");
            let wanted: HashSet<&str> = indexes
                .iter()
                .filter_map(|i| ids.get(*i))
                .map(String::as_str)
                .collect();
            remove_keys(keys, &ticks, |id| wanted.contains(id));
            for id in wanted {
                sync_plain(keys, &ticks, id, Some(Any::Bool(true)));
            }
        }
        "boolean" => {
            let correct = answer.get("correct").and_then(Value::as_bool) == Some(true);
            sync_plain(keys, &key, "correct", Some(Any::Bool(correct)));
        }
        "short" => {
            let unit = answer.get("unit").and_then(Value::as_str).map(string_any);
            sync_plain(content, &answer_map, "unit", unit);
            sync_entries(
                keys,
                &key,
                "accepted",
                "a",
                &strings(&answer, "accepted"),
                text_fill,
            );
        }
        "open" => {
            sync_entries(
                keys,
                &key,
                "accepted",
                "a",
                &strings(&answer, "accepted"),
                text_fill,
            );
            sync_entries(
                keys,
                &key,
                "hints",
                "h",
                &strings(&answer, "hints"),
                text_fill,
            );
            sync_entries(
                keys,
                &key,
                "markscheme",
                "m",
                array_of(part, "markscheme"),
                |txn, entry, item| {
                    sync_text(txn, entry, "text", str_of(item, "text"));
                    let marks = item.get("marks").and_then(Value::as_f64).unwrap_or(1.0);
                    sync_plain(txn, entry, "marks", Some(Any::Number(marks)));
                },
            );
        }
        "gaps" => {
            let gaps = child_map(keys, &key, "gaps");
            let accepted = array_of(&answer, "accepted");
            for (n, list) in accepted.iter().enumerate() {
                let items: Vec<String> = list
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .map(|item| item.as_str().unwrap_or_default().to_owned())
                            .collect()
                    })
                    .unwrap_or_default();
                sync_entries(keys, &gaps, &(n + 1).to_string(), "g", &items, text_fill);
            }
            let count = accepted.len();
            remove_keys(keys, &gaps, |number| {
                number
                    .parse::<usize>()
                    .is_ok_and(|n| (1..=count).contains(&n))
            });
        }
        "matching" => {
            let pairs_json = array_of(&answer, "pairs");
            let left: Vec<String> = pairs_json
                .iter()
                .map(|pair| str_of(pair, "left").to_owned())
                .collect();
            let left_ids = sync_entries(content, &answer_map, "left", "l", &left, text_fill);
            let options = strings(&answer, "options");
            let option_ids = sync_entries(keys, &key, "options", "o", &options, text_fill);
            let pairs = child_map(keys, &key, "pairs");
            for (pair, left_id) in pairs_json.iter().zip(&left_ids) {
                let option = pair
                    .get("right")
                    .and_then(Value::as_u64)
                    .and_then(|i| option_ids.get(i as usize))
                    .map(|id| string_any(id));
                sync_plain(keys, &pairs, left_id, option);
            }
            let kept: HashSet<&str> = left_ids.iter().map(String::as_str).collect();
            remove_keys(keys, &pairs, |left| kept.contains(left));
        }
        "ordering" => {
            sync_entries(
                keys,
                &key,
                "items",
                "i",
                &strings(&answer, "items"),
                text_fill,
            );
        }
        _ => {}
    }
}

/// One question (the shared JSON) in both documents under `order`, written
/// as what differs from what they hold.
fn sync_question(
    content: &mut TransactionMut,
    questions: &MapRef,
    keys: &mut TransactionMut,
    key_root: &MapRef,
    question: &Value,
    order: &str,
) {
    let map = child_map(content, questions, str_of(question, "id"));
    sync_plain(content, &map, "order", Some(order_any(order)));
    for field in ["layout", "labels", "level"] {
        let value = question.get(field).and_then(Value::as_str).map(string_any);
        sync_plain(content, &map, field, value);
    }
    sync_blocks(content, &map, "stem", array_of(question, "stem"));
    let parts_map = child_map(content, &map, "parts");
    let parts = array_of(question, "parts");
    let wanted: HashSet<&str> = parts.iter().map(|part| str_of(part, "id")).collect();
    let gone: Vec<String> = parts_map
        .keys(content)
        .filter(|id| !wanted.contains(*id))
        .map(str::to_owned)
        .collect();
    for id in gone {
        parts_map.remove(content, &id);
        key_root.remove(keys, &id);
    }
    let mut last: Option<String> = None;
    for part in parts {
        let entry = child_map(content, &parts_map, str_of(part, "id"));
        let held = str_at(content, &entry, "order");
        let order = next_order(held.as_deref(), last.as_deref());
        sync_plain(content, &entry, "order", Some(order_any(&order)));
        last = Some(order);
        let marks = part.get("marks").and_then(Value::as_f64).map(Any::Number);
        sync_plain(content, &entry, "marks", marks);
        sync_blocks(content, &entry, "blocks", array_of(part, "blocks"));
        sync_answer(content, &entry, keys, key_root, part);
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
/// first open, a lineage rebuild).
pub fn states_from_value(value: &[Value], client_id: u64) -> (Vec<u8>, Vec<u8>) {
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
            sync_question(
                &mut content_txn,
                &questions,
                &mut keys_txn,
                &key_root,
                &question,
                &next,
            );
            order = Some(next);
        }
    }
    let encode = |doc: &Doc| {
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default())
    };
    (encode(&content), encode(&keys))
}

/* ------------------------------------------- the readers' item lists */

/// One matching or ordering part's entries as the keys document holds them:
/// (entry id, text) in the keys' order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ItemsPart {
    pub part: String,
    pub kind: String,
    pub entries: Vec<(String, String)>,
}

/// Every matching and ordering part's entries, by part id.
pub fn item_parts<K: ReadTxn>(keys: &K) -> Vec<ItemsPart> {
    let Some(root) = keys.get_map(KEYS_ROOT) else {
        return Vec::new();
    };
    let mut out: Vec<ItemsPart> = root
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
                .map(|entry| (entry.id.clone(), text_at(keys, &entry.map, "text")))
                .collect();
            Some(ItemsPart {
                part: part.to_owned(),
                kind,
                entries,
            })
        })
        .collect();
    out.sort_by(|a, b| a.part.cmp(&b.part));
    out
}

/// A random index below its argument (the server draws from the OS; tests
/// seed it).
pub type Pick<'a> = &'a mut dyn FnMut(usize) -> usize;

/// One part's list as readers get it: its kind and its texts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReaderList {
    pub kind: String,
    pub items: Vec<String>,
}

/// What readers get of matching options and ordering items (D3, revised by
/// Epo 2026-10-10): not Yjs, which keeps every deleted struct, but a plain
/// list of texts per part that the content room pushes over its channels
/// whenever the keys change, keeping no history. A part whose entries
/// changed as a set, or changed more than one text at once (a server write
/// reordering by position), or took a text another entry shows, is
/// shuffled afresh (a uniform permutation, so the list says nothing about
/// the order the keys hold or were typed in or which text replaced which);
/// one where a single text changed in place keeps its order.
#[derive(Debug, Default)]
pub struct ReaderLists {
    /// Part id to its kind and (entry id, text) in the readers' order.
    parts: HashMap<String, (String, Vec<(String, String)>)>,
}

impl ReaderLists {
    /// Follows the keys' parts; returns the parts whose list changed (none:
    /// the part has no list any more), by part id.
    pub fn follow(
        &mut self,
        parts: &[ItemsPart],
        pick: Pick<'_>,
    ) -> Vec<(String, Option<ReaderList>)> {
        let present: HashSet<&str> = parts.iter().map(|part| part.part.as_str()).collect();
        let mut changed: Vec<(String, Option<ReaderList>)> = Vec::new();
        let gone: Vec<String> = self
            .parts
            .keys()
            .filter(|id| !present.contains(id.as_str()))
            .cloned()
            .collect();
        for id in gone {
            self.parts.remove(&id);
            changed.push((id, None));
        }
        for part in parts {
            let texts: HashMap<&str, &str> = part
                .entries
                .iter()
                .map(|(id, text)| (id.as_str(), text.as_str()))
                .collect();
            let held = self.parts.get(&part.part);
            // The order stays only for one entry's text changing in place
            // (typing). A server write fills lists by position, so a
            // reorder changes several texts under the same ids: keeping the
            // order would show readers which old text each new one replaced
            // (REVIEW2 M2), so that, too, shuffles afresh. So does a text
            // retyped into one another entry shows: two retypes in separate
            // windows would otherwise show a swap (REVIEW3 N1).
            let in_place = held.is_some_and(|(kind, entries)| {
                if *kind != part.kind
                    || entries.len() != part.entries.len()
                    || !entries
                        .iter()
                        .all(|(id, _)| texts.contains_key(id.as_str()))
                {
                    return false;
                }
                let mut edited = entries
                    .iter()
                    .filter(|(id, text)| texts[id.as_str()] != text.as_str());
                match (edited.next(), edited.next()) {
                    (None, _) => true,
                    (Some((id, _)), None) => {
                        let now = texts[id.as_str()];
                        !entries
                            .iter()
                            .any(|(other, text)| other != id && text == now)
                    }
                    _ => false,
                }
            });
            let next: Vec<(String, String)> = match held {
                Some((_, entries)) if in_place => entries
                    .iter()
                    .map(|(id, _)| (id.clone(), texts[id.as_str()].to_owned()))
                    .collect(),
                _ => {
                    let mut entries = part.entries.clone();
                    for i in (1..entries.len()).rev() {
                        entries.swap(i, pick(i + 1).min(i));
                    }
                    entries
                }
            };
            if held.is_some_and(|(kind, entries)| *kind == part.kind && *entries == next) {
                continue;
            }
            changed.push((
                part.part.clone(),
                Some(ReaderList {
                    kind: part.kind.clone(),
                    items: next.iter().map(|(_, text)| text.clone()).collect(),
                }),
            ));
            self.parts
                .insert(part.part.clone(), (part.kind.clone(), next));
        }
        changed.sort_by(|a, b| a.0.cmp(&b.0));
        changed
    }

    /// Every part's list, for a channel that joins.
    pub fn all(&self) -> Vec<(String, ReaderList)> {
        let mut out: Vec<(String, ReaderList)> = self
            .parts
            .iter()
            .map(|(part, (kind, entries))| {
                (
                    part.clone(),
                    ReaderList {
                        kind: kind.clone(),
                        items: entries.iter().map(|(_, text)| text.clone()).collect(),
                    },
                )
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }
}

/// The `quiz-items` message (DESIGN.md 2.6): `full` replaces what the
/// channel holds (a join), otherwise the listed parts change and a `null`
/// part has no list any more.
pub fn reader_message(full: bool, parts: &[(String, Option<ReaderList>)]) -> Value {
    let parts: serde_json::Map<String, Value> = parts
        .iter()
        .map(|(part, list)| {
            let value = match list {
                Some(list) => json!({ "kind": list.kind, "items": list.items }),
                None => Value::Null,
            };
            (part.clone(), value)
        })
        .collect();
    json!({ "type": "quiz-items", "full": full, "parts": parts })
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

/// A string of at most `cap` characters.
fn a_string(content: &ItemContent, cap: usize) -> bool {
    matches!(one_any(content), Some(Any::String(value)) if value.chars().count() <= cap)
}

/// A label or an attribution: metadata, measured in UTF-16 units as the
/// question schema measures it.
fn a_meta(content: &ItemContent) -> bool {
    matches!(one_any(content), Some(Any::String(value)) if value.encode_utf16().count() <= q::QUESTION_METADATA_MAX)
}

/// An image's width or height: whole pixels, 1 to the image bound.
fn image_size(content: &ItemContent) -> bool {
    matches!(one_any(content), Some(Any::Number(value))
        if value.fract() == 0.0 && (1.0..=q::QUESTION_IMAGE_DIMENSION_MAX).contains(value))
}

fn a_bool(content: &ItemContent) -> bool {
    matches!(one_any(content), Some(Any::Bool(_)))
}

/// Whole marks a part or a marking item may carry (the store's caps, REVIEW1
/// M4: nothing the store refuses gets past admission).
fn whole_marks(content: &ItemContent) -> bool {
    matches!(one_any(content), Some(Any::Number(value))
        if value.fract() == 0.0 && (1.0..=MAX_MARKS).contains(value))
}

/// What one update adds, which texts it types into and which lists it grows.
struct Tally {
    growth: Growth,
    /// Full path of a text (its container keys) to the UTF-16 units added.
    typed: HashMap<Vec<Arc<str>>, u64>,
    /// A list's (or table axis's) path to the entries the update adds there.
    added: HashMap<Vec<Arc<str>>, u64>,
    /// Answer types the update sets to `open`.
    open: u64,
    /// A block's type and figure value the update writes, by the block's
    /// path: a chart, plot or graph is checked against its kind's caps.
    figures: HashMap<Vec<Arc<str>>, Figure>,
}

/// A block's type and its figure value, as an update writes them.
type Figure = (Option<String>, Option<Any>);

impl Tally {
    fn structure(&mut self, bytes: u64) {
        self.growth.bytes += bytes;
        self.growth.nodes += 1;
    }

    /// A new entry in the list at `path`: its count is bounded like a text's
    /// length (held plus added against the list's cap, REVIEW1 S2).
    fn entry(&mut self, path: &[Arc<str>], bytes: u64) {
        self.structure(bytes);
        self.count(path);
    }

    /// One more entry in the list at `path`, held plus added against its cap.
    fn count(&mut self, path: &[Arc<str>]) {
        *self.added.entry(path.to_vec()).or_default() += 1;
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
        ([], Some("type")) if one_of(content, BLOCK_TYPES) => {
            if let Some(Any::String(kind)) = one_any(content) {
                tally.figures.entry(path.to_vec()).or_default().0 = Some(kind.to_string());
            }
            tally.value(content);
        }
        ([], Some("label" | "attribution")) if a_meta(content) => tally.value(content),
        ([], Some("header")) if a_bool(content) => tally.value(content),
        ([], Some("width" | "height")) if image_size(content) => tally.value(content),
        // An image waiting for its upload is structure, not a refused value
        // (D4, REVIEW1 M3): blank, it only leaves the question incomplete.
        ([], Some("image")) => match one_any(content) {
            Some(Any::Map(image))
                if image.len() == 1
                    && (matches!(image.get("assetId"), Some(Any::String(id)) if id.chars().count() <= q::QUESTION_ID_MAX)
                        || matches!(image.get("url"), Some(Any::String(url)) if url.encode_utf16().count() <= q::QUESTION_ASSET_URL_MAX)) =>
            {
                tally.value(content)
            }
            _ => return refuse("an image that is not {assetId} or {url}"),
        },
        // A chart, plot or graph is one value, written at its dialog's Done
        // (D8); its caps depend on the block's type, read after the walk.
        ([], Some("value")) => match one_any(content) {
            Some(value @ Any::Map(_)) => {
                tally.figures.entry(path.to_vec()).or_default().1 = Some(value.clone());
                tally.value(content);
            }
            _ => return refuse("a chart, plot or graph that is not one value"),
        },
        ([], Some("text" | "description")) if is_text(content) => tally.structure(32),
        ([], Some("rows" | "columns" | "cells")) if is_map(content) => tally.structure(8),
        (["rows" | "columns"], Some(id)) if valid_id(id) && order_key(content) => {
            tally.entry(path, 8);
        }
        (["cells"], Some(cell)) if is_text(content) => {
            let mut ids = cell.split('/');
            match (ids.next(), ids.next(), ids.next()) {
                (Some(row), Some(column), None) if valid_id(row) && valid_id(column) => {
                    tally.entry(path, 8);
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
        ([], Some("marks")) if marks && whole_marks(content) => tally.value(content),
        ([], Some("marks")) if marks => {
            return refuse(format!(
                "a marking item outside 1 to {MAX_MARKS} whole marks"
            ));
        }
        ([], Some("text")) if is_text(content) => tally.structure(24),
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

fn new_entry(
    content: &ItemContent,
    id: &str,
    path: &[Arc<str>],
    tally: &mut Tally,
) -> Result<(), String> {
    if !valid_id(id) {
        return refuse("an id that is not 1-128 letters, digits, - or _");
    }
    if !is_map(content) {
        return refuse("an entry that is not a map");
    }
    tally.entry(path, id.len() as u64 + 16);
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
        ([R], Some(id)) => new_entry(content, id, full, tally),
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
            new_entry(content, id, full, tally)
        }
        ([R, _, "stem", _, rest @ ..], key) => block_shape(rest, key, content, full, tally),
        ([R, _, "parts"], Some(id)) => new_entry(content, id, full, tally),
        ([R, _, "parts", _], Some("order")) if order_key(content) => {
            tally.value(content);
            Ok(())
        }
        ([R, _, "parts", _], Some("marks")) if whole_marks(content) => {
            tally.value(content);
            Ok(())
        }
        ([R, _, "parts", _], Some("marks")) => {
            refuse(format!("a part outside 1 to {MAX_MARKS} whole marks"))
        }
        ([R, _, "parts", _], Some("blocks" | "answer")) if is_map(content) => {
            tally.structure(16);
            Ok(())
        }
        ([R, _, "parts", _, "blocks", _, rest @ ..], key) => {
            block_shape(rest, key, content, full, tally)
        }
        ([R, _, "parts", _, "answer"], Some("type")) if one_of(content, ANSWER_TYPES) => {
            if one_of(content, &["open"]) {
                tally.open += 1;
            }
            tally.value(content);
            Ok(())
        }
        ([R, _, "parts", _, "answer"], Some("unit")) if a_string(content, q::QUESTION_UNIT_MAX) => {
            tally.value(content);
            Ok(())
        }
        ([R, _, "parts", _, "answer"], Some("options" | "left")) if is_map(content) => {
            tally.structure(16);
            Ok(())
        }
        ([R, _, "parts", _, "answer", "options" | "left"], Some(id)) => {
            new_entry(content, id, full, tally)
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
        ([K], Some(id)) => new_entry(content, id, full, tally),
        ([K, _], Some("type")) if one_of(content, ANSWER_TYPES) => {
            // Open answers hold shorter accepted texts: the exact check reads
            // them against the type the update leaves.
            if one_of(content, &["open"]) {
                tally.growth.over_cap = true;
            }
            tally.value(content);
            Ok(())
        }
        // boolean: true or false; mcq: a map of ticks by option id.
        ([K, _], Some("correct")) if a_bool(content) || is_map(content) => {
            tally.structure(16);
            Ok(())
        }
        ([K, _, "correct"], Some(option)) if valid_id(option) => match one_any(content) {
            Some(Any::Bool(true)) => {
                tally.value(content);
                tally.count(full);
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
        ([K, _, "solution"], Some(id)) => new_entry(content, id, full, tally),
        ([K, _, "solution", _, rest @ ..], key) => block_shape(rest, key, content, full, tally),
        ([K, _, "pairs"], Some(left)) if valid_id(left) => match one_any(content) {
            Some(Any::String(option)) if valid_id(option) => {
                tally.value(content);
                tally.count(full);
                Ok(())
            }
            _ => refuse("a pair that does not name an option"),
        },
        ([K, _, "gaps"], Some(number)) => match number.parse::<u32>() {
            Ok(n) if (1..=q::QUESTION_ANSWERS_MAX as u32).contains(&n) && is_map(content) => {
                tally.entry(full, 8);
                Ok(())
            }
            _ => refuse("a gap that is not numbered 1 to 100"),
        },
        ([K, _, "gaps", _], Some(id)) => new_entry(content, id, full, tally),
        ([K, _, "gaps", _, _, rest @ ..], key) => {
            entry_shape(rest, key, content, full, false, tally)
        }
        ([K, _, list], Some(id)) if LISTS.contains(list) => new_entry(content, id, full, tally),
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
        // An image block's description (a block's only text so named).
        [.., "description"] => q::QUESTION_DESCRIPTION_MAX,
        _ => q::QUESTION_TEXT_MAX,
    }
}

/// A list's (or table axis's) cap by its path, as the exact check counts it.
fn list_cap(path: &[&str]) -> Option<usize> {
    const R: &str = QUESTIONS_ROOT;
    const K: &str = KEYS_ROOT;
    let table = match path {
        [R, _, "stem", _, field]
        | [R, _, "parts", _, "blocks", _, field]
        | [K, _, "solution", _, field] => Some(*field),
        _ => None,
    };
    if let Some(field) = table {
        return match field {
            "rows" => Some(q::QUESTION_TABLE_ROWS_MAX),
            "columns" => Some(q::QUESTION_TABLE_COLUMNS_MAX),
            "cells" => Some(q::QUESTION_TABLE_ROWS_MAX * q::QUESTION_TABLE_COLUMNS_MAX),
            _ => None,
        };
    }
    Some(match path {
        [R, _, "stem"] | [R, _, "parts", _, "blocks"] | [K, _, "solution"] => {
            q::QUESTION_BLOCKS_MAX
        }
        [R] => q::QUIZ_PARTS_MAX,
        [R, _, "parts"] => q::QUIZ_QUESTION_PARTS_MAX,
        [R, _, "parts", _, "answer", "options" | "left"] => q::QUESTION_ANSWERS_MAX,
        [K] => q::QUIZ_PARTS_MAX * 2,
        [
            K,
            _,
            "accepted" | "hints" | "options" | "items" | "correct" | "pairs",
        ] => q::QUESTION_ANSWERS_MAX,
        [K, _, "markscheme"] => q::QUIZ_MARKSCHEME_MAX,
        [K, _, "gaps"] | [K, _, "gaps", _] => q::QUESTION_ANSWERS_MAX,
        _ => return None,
    })
}

/// The map at `path` (keys from a root), when the document holds it.
fn map_by_path<T: ReadTxn>(txn: &T, path: &[Arc<str>]) -> Option<MapRef> {
    let (root, rest) = path.split_first()?;
    let mut map = txn.get_map(&**root)?;
    for key in rest {
        map = map_at(txn, &map, key)?;
    }
    Some(map)
}

/// The text at `path` (keys from a root), when the document holds it.
fn text_by_path<T: ReadTxn>(txn: &T, path: &[Arc<str>]) -> Option<TextRef> {
    let (last, container) = path.split_last()?;
    match map_by_path(txn, container)?.get(txn, last) {
        Some(Out::YText(text)) => Some(text),
        _ => None,
    }
}

/// Entries a map holds, each counted as a step of the walk.
fn counted_len<T: ReadTxn>(txn: &T, map: &MapRef) -> u64 {
    let len = u64::from(map.len(txn));
    for _ in 0..len.max(1) {
        step(Walk::Exact);
    }
    len
}

fn open_part<T: ReadTxn>(txn: &T, part: &str) -> bool {
    txn.get_map(KEYS_ROOT)
        .and_then(|root| map_at(txn, &root, part))
        .is_some_and(|key| str_at(txn, &key, "type").as_deref() == Some("open"))
}

/// The quiz's parts and open parts, counted (only for an update that adds a
/// part or sets an answer type to `open`).
fn part_counts<T: ReadTxn>(txn: &T) -> (u64, u64) {
    let (mut parts, mut open) = (0, 0);
    let Some(root) = txn.get_map(QUESTIONS_ROOT) else {
        return (0, 0);
    };
    for (_, question) in root.iter(txn) {
        step(Walk::Exact);
        let Out::YMap(question) = question else {
            continue;
        };
        let Some(list) = map_at(txn, &question, "parts") else {
            continue;
        };
        for (_, part) in list.iter(txn) {
            step(Walk::Exact);
            let Out::YMap(part) = part else { continue };
            parts += 1;
            if map_at(txn, &part, "answer")
                .is_some_and(|answer| str_at(txn, &answer, "type").as_deref() == Some("open"))
            {
                open += 1;
            }
        }
    }
    (parts, open)
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
        added: HashMap::new(),
        open: 0,
        figures: HashMap::new(),
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
    // A figure is checked whole, its type or value read from the block when
    // the update writes only the other.
    for (path, (kind, value)) in &tally.figures {
        let held = map_by_path(txn, path);
        let kind = kind
            .clone()
            .or_else(|| held.as_ref().and_then(|block| str_at(txn, block, "type")));
        let value = value
            .clone()
            .or_else(|| held.as_ref().and_then(|block| any_at(txn, block, "value")));
        if let (Some(kind), Some(value @ Any::Map(_))) = (kind, value) {
            notes::questions::figure_caps(&kind, &any_json(&value)).or_else(refuse)?;
        }
    }
    // A text, a list or the quiz's part counts that may pass a cap send the
    // update to the exact check; the held count is read only for what the
    // update grows, so the work follows the touched item.
    for (path, units) in &tally.typed {
        let keys: Vec<&str> = path.iter().map(|k| &**k).collect();
        let open =
            matches!(keys.as_slice(), [KEYS_ROOT, part, "accepted", ..] if open_part(txn, part));
        let current = text_by_path(txn, path).map_or(0, |text| u64::from(text.len(txn)));
        if current + units > text_cap(&keys, open) as u64 {
            tally.growth.over_cap = true;
        }
    }
    let mut new_parts = 0;
    for (path, added) in &tally.added {
        let keys: Vec<&str> = path.iter().map(|k| &**k).collect();
        if matches!(keys.as_slice(), [QUESTIONS_ROOT, _, "parts"]) {
            new_parts += added;
        }
        let cap = match keys.as_slice() {
            [KEYS_ROOT, part, "accepted"] if open_part(txn, part) => OPEN_ACCEPTED_MAX,
            _ => match list_cap(&keys) {
                Some(cap) => cap,
                None => continue,
            },
        };
        let held = map_by_path(txn, path).map_or(0, |map| counted_len(txn, &map));
        if held + added > cap as u64 {
            tally.growth.over_cap = true;
        }
    }
    if new_parts > 0 || tally.open > 0 {
        let (parts, open) = part_counts(txn);
        if parts + new_parts > q::QUIZ_PARTS_MAX as u64
            || open + tally.open > q::QUIZ_OPEN_PARTS_MAX as u64
        {
            tally.growth.over_cap = true;
        }
    }
    Ok(tally.growth)
}

/// Checks each struct a writer's update adds to the content document against
/// its shape and its value caps, and bounds what it adds: a text's length and
/// a list's count are held plus added against their caps, and only one that
/// may pass its cap goes to the exact check.
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
        check_text(
            &text_at(txn, &block.map, "text"),
            q::QUESTION_TEXT_MAX,
            "a question text",
        )?;
        check_text(
            &text_at(txn, &block.map, "description"),
            q::QUESTION_DESCRIPTION_MAX,
            "a description",
        )?;
        for field in ["label", "attribution"] {
            if let Some(meta) = str_at(txn, &block.map, field)
                && meta.encode_utf16().count() > q::QUESTION_METADATA_MAX
            {
                return Err(format!(
                    "a {field} holds at most {} characters",
                    q::QUESTION_METADATA_MAX
                ));
            }
        }
        for field in ["width", "height"] {
            if let Some(size) = num_at(txn, &block.map, field)
                && !(size.fract() == 0.0 && (1.0..=q::QUESTION_IMAGE_DIMENSION_MAX).contains(&size))
            {
                return Err(format!("an image's {field} is out of range"));
            }
        }
        if let (Some(kind), Some(value @ Any::Map(_))) = (
            str_at(txn, &block.map, "type"),
            any_at(txn, &block.map, "value"),
        ) {
            notes::questions::figure_caps(&kind, &any_json(&value))?;
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
    check_count(questions.len(), q::QUIZ_PARTS_MAX, "a quiz's questions")?;
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
        let (accepted_count, accepted_cap) = if open {
            (OPEN_ACCEPTED_MAX, q::QUIZ_OPEN_ANSWER_MAX)
        } else {
            (q::QUESTION_ANSWERS_MAX, q::QUESTION_TEXT_MAX)
        };
        check_list(
            txn,
            map_at(txn, &key, "accepted").as_ref(),
            accepted_count,
            accepted_cap,
            "accepted answers",
        )?;
        for list in ["correct", "pairs"] {
            if let Some(map) = map_at(txn, &key, list) {
                check_count(
                    map.len(txn) as usize,
                    q::QUESTION_ANSWERS_MAX,
                    "an answer list",
                )?;
            }
        }
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

/// Writes (or inserts) one question under `order`, as what differs.
fn put_question(
    content: &mut TransactionMut,
    keys: &mut TransactionMut,
    question: &Value,
    order: &str,
) {
    let questions = content.get_or_insert_map(QUESTIONS_ROOT);
    let key_root = keys.get_or_insert_map(KEYS_ROOT);
    sync_question(content, &questions, keys, &key_root, question, order);
}

/// The quiz holds exactly `questions` afterwards (the content save API, D7,
/// no revision): a question that reads the same stays untouched, a changed
/// one is written as what differs (REVIEW1 S6), new ones go in, missing
/// ones go, and the order follows the list.
pub fn set_questions(
    content: &mut TransactionMut,
    keys: &mut TransactionMut,
    questions: &[Value],
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
