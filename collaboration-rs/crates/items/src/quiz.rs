//! Quiz documents (live-items DESIGN.md 1.2, 1.3; Epo 2026-10-10). A quiz
//! has two: the content document (`material:<id>:schema:<n>`), which readers
//! join too, and the keys document (`keys:<id>:schema:<n>`), which only
//! editors with write access join, so answer keys never reach a reader.
//!
//! Content: `questions`, question id to `{order, layout, labels, level?,
//! topicIds?, stem, groups?, parts}` (`topicIds` a plain list, never empty);
//! group id to `{blocks}`; part id to `{order, marks, blocks, answer, group?}`; the answer map holds the type and what a learner
//! may see: mcq `options`, `multiple` (true while several are correct or
//! the author's flag is set), `shuffle` and `locked` (ticks by option id;
//! Shuffle options, Epo 2026-11-15), a short answer's `unit` and matching
//! `left` items.
//! A group has no order of its own: it sits where its first part sits, and a
//! merge's leftovers read repaired (`q::repair_groups`, Epo 2026-11-04).
//!
//! Keys: `keys`, part id to `{type, solution, correct | accepted |
//! markscheme | gaps | options | pairs | items}`, and an mcq's author
//! `multiple` flag (Multiple answer, Epo 2026-11-15). Editors type ordering items
//! and matching options here, where their Yjs ids record typing order (for
//! ordering, usually the answer). Readers get those items outside Yjs, as a
//! plain shuffled list per part the content room pushes ([ReaderLists];
//! D3 as revised 2026-10-10), so the content document holds nothing derived
//! from them and nothing in either document is written by the server alone.
//!
//! A block entry holds its fields (D8 superseded by Epo 2026-11-16, D2, D3
//! and D9): a chart, plot or graph entry is the figure map a note figure's
//! `block` is too (D15), beside its `order`, read, written and admitted by
//! `notes::figure_map`: plain fields each replaced whole, a graph's `board`
//! and its `elements` keyed by element id, a chart's series and labels held
//! as a table's rows and columns with their names and values. Each read is
//! repaired (`q::repair_figure`), as a merge may leave what no editor wrote.
//!
//! The projection is today's quiz block with only the questions that pass
//! the strict validator (D4), so grading and fresh reads see what a Save
//! would have stored.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use serde_json::{Value, json};
use yrs::block::ItemContent;
use yrs::types::{ToJson, TypeRef};
use yrs::{
    Any, Doc, GetString, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Text, TextPrelim,
    TextRef, Transact, TransactionMut, WriteTxn,
};

use notes::edit::{DocumentCommand, EditError, EditErrorCode};
use notes::figure_map::{self, any_json, json_any};
/// Ids a writer mints (map keys): `[A-Za-z0-9_-]`, at most [MAX_ID] long.
pub use notes::figure_map::{MAX_ID, valid_id};
use notes::limits::merged_cap;
use notes::questions::{self as q, Policy, model_marked};
use ydoc::Incoming;
use ydoc::steps::{Walk, step};

use crate::locate::{Locator, Place};
use crate::{Growth, order};

pub const QUESTIONS_ROOT: &str = "questions";
pub const KEYS_ROOT: &str = "keys";
/// The projected `quiz` block's id (one block per quiz document).
pub const BLOCK_ID: &str = "quiz";

const ANSWER_TYPES: &[&str] = &[
    "mcq", "boolean", "short", "matching", "ordering", "open", "gaps", "drawing",
];
/// The question block kinds a live quiz holds: the embed catalog's question
/// blocks (chart, plot, graph) and the plain ones it does not list.
pub const BLOCK_TYPES: &[&str] = &["text", "table", "image", "chart", "plot", "graph"];
/// Whole marks a marking item carries.
const MAX_MARKS: f64 = q::QUESTION_MARKS_MAX;
/// Whole marks a part carries: an open part's are its marking items' total,
/// which two editors' items merged at once may take past the cap, up to twice
/// it (Epo 2026-11-22); a part turned closed meanwhile keeps it, so any part
/// may hold it (its editor brings a closed part back to the cap).
const MAX_PART_MARKS: f64 = merged_cap(q::QUESTION_MARKS_MAX as usize) as f64;
/// An open part's sample answers: at most one, optional (Epo 2026-10-15).
const OPEN_ACCEPTED_MAX: usize = 1;

/// A question's own topics: 1 to QUESTION_TOPICS_MAX distinct ids, each as
/// `q::identifier` holds it.
fn topic_ids(topics: &[Any]) -> bool {
    let mut seen = HashSet::new();
    !topics.is_empty()
        && topics.len() <= q::QUESTION_TOPICS_MAX
        && topics.iter().all(|topic| {
            matches!(topic, Any::String(id)
                if !id.trim().is_empty() && id.chars().count() <= MAX_ID && seen.insert(id.clone()))
        })
}

/// A stored question's id, held to what the validators hold it to, as a part's
/// and a group's are: a stored `q1.1` seeds and saves. Only a key a client
/// creates must be `valid_id`.
fn stored_id(question: &Value) -> bool {
    q::identifier(&question["id"], "id").is_ok()
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

fn number(value: f64) -> Value {
    any_json(&Any::Number(value))
}

fn read_block<T: ReadTxn>(txn: &T, map: &MapRef) -> Option<Value> {
    let kind = str_at(txn, map, "type")?;
    match kind.as_str() {
        "text" => Some(json!({ "type": "text", "text": text_at(txn, map, "text") })),
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
        "chart" | "plot" | "graph" => figure_map::read(map.as_ref(), &kind),
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
            || ordered(txn, map_at(txn, &question.map, "groups").as_ref())
                .iter()
                .any(|group| unknown(map_at(txn, &group.map, "blocks")))
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
            let mut value = json!({
                "type": kind,
                "options": options.iter().map(|o| text_at(content, &o.map, "text")).collect::<Vec<_>>(),
                "correct": correct,
            });
            if keys.is_some_and(|(txn, key)| {
                matches!(any_at(txn, key, "multiple"), Some(Any::Bool(true)))
            }) {
                value["multiple"] = json!(true);
            }
            // Locked options count only while Shuffle options is on.
            if let Some(answer) = answer
                && matches!(any_at(content, answer, "shuffle"), Some(Any::Bool(true)))
            {
                value["shuffle"] = json!(true);
                let locked: Vec<usize> = match map_at(content, answer, "locked") {
                    Some(ticks) => options
                        .iter()
                        .enumerate()
                        .filter(|(_, o)| {
                            matches!(ticks.get(content, &o.id), Some(Out::Any(Any::Bool(true))))
                        })
                        .map(|(i, _)| i)
                        .collect(),
                    None => Vec::new(),
                };
                if !locked.is_empty() {
                    value["locked"] = json!(locked);
                }
            }
            (value, None)
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
        "open" | "drawing" => {
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
            let value = if kind == "open" {
                json!({ "type": "open", "accepted": key_texts("accepted") })
            } else {
                // A drawn sample answer is a key: its board and image asset ids.
                let sample = keys.and_then(|(txn, key)| {
                    Some(json!({
                        "board": str_at(txn, key, "sampleBoard")?,
                        "image": str_at(txn, key, "sampleImage")?,
                    }))
                });
                match sample {
                    Some(sample) => json!({ "type": "drawing", "sample": sample }),
                    None => json!({ "type": "drawing" }),
                }
            };
            (value, Some(Value::Array(scheme)))
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
/// alone holds it (`keys` none), in order, as the shared question JSON, a
/// merge's leftover groups repaired.
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

/// A question as the shared JSON, a merge's leftover groups repaired.
fn question_json<C: ReadTxn, K: ReadTxn>(
    content: &C,
    keys: Option<&KeysRead<'_, K>>,
    id: &str,
    map: &MapRef,
) -> Value {
    let mut question = held_question_json(content, keys, id, map);
    q::repair_groups(&mut question);
    question
}

/// A question as its documents hold it, a group no part names included: what
/// the limits measure and what keeps an image in use.
fn held_question_json<C: ReadTxn, K: ReadTxn>(
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
                // A part with marking items is worth their total: the editor
                // stops adding at a total of QUESTION_MARKS_MAX, two editors'
                // adds at once may pass it (Epo 2026-11-22, "Yes, A
                // everywhere"), and the part's own marks fall short of it.
                if let Some(total) = scheme_total(&markscheme) {
                    value["marks"] = number(total);
                }
                value["markscheme"] = markscheme;
            }
            if let Some(group) = str_at(content, &part.map, "group") {
                value["group"] = json!(group);
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
    let groups: Vec<Value> = ordered(content, map_at(content, map, "groups").as_ref())
        .iter()
        .map(|group| {
            json!({
                "id": group.id,
                "blocks": read_blocks(content, map_at(content, &group.map, "blocks").as_ref()),
            })
        })
        .collect();
    if !groups.is_empty() {
        value["groups"] = Value::Array(groups);
    }
    if let Some(level) = str_at(content, map, "level") {
        value["level"] = json!(level);
    }
    if let Some(Any::Array(topics)) = any_at(content, map, "topicIds")
        && !topics.is_empty()
    {
        value["topicIds"] = Value::Array(topics.iter().map(any_json).collect());
    }
    value
}

/// The marks a marking scheme's items add up to; none without items.
fn scheme_total(markscheme: &Value) -> Option<f64> {
    let items = markscheme.as_array().filter(|items| !items.is_empty())?;
    Some(items.iter().filter_map(|item| item["marks"].as_f64()).sum())
}

/// Every question as its documents hold it ([held_question_json]).
fn held_questions_json<C: ReadTxn, K: ReadTxn>(
    content: &C,
    keys: Option<&KeysRead<'_, K>>,
) -> Vec<Value> {
    let root = content.get_map(QUESTIONS_ROOT);
    ordered(content, root.as_ref())
        .iter()
        .map(|question| held_question_json(content, keys, &question.id, &question.map))
        .collect()
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
/// blocks, a blank short-answer unit and blank accepted answers (a gap's too)
/// never leave it incomplete (no accepted answer left does), and the
/// projection drops them; a blank figure description goes, and
/// a chart series short of its labels takes nulls, an empty value being null
/// (Epo 2026-10-14). Blank marking items go too, and then the part's marks are
/// the rest's total (Epo 2026-10-15; a part with items is worth their total,
/// 2026-11-22). A room's table is a grid, so its rows are always even.
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
    if let Some(groups) = question.get_mut("groups").and_then(Value::as_array_mut) {
        for group in groups {
            keep(&mut group["blocks"]);
        }
    }
    if let Some(parts) = question["parts"].as_array_mut() {
        for part in parts {
            keep(&mut part["blocks"]);
            keep(&mut part["solution"]);
            if let Some(answer) = part["answer"].as_object_mut() {
                if answer.get("unit").is_some_and(blank) {
                    answer.remove("unit");
                }
                // Short and open answers' accepted texts; a gaps answer's
                // accepted lists hold one list per gap.
                if let Some(list) = answer.get_mut("accepted").and_then(Value::as_array_mut) {
                    list.retain(|item| !blank(item));
                    for gap in list.iter_mut().filter_map(Value::as_array_mut) {
                        gap.retain(|item| !blank(item));
                    }
                }
            }
            if let Some(items) = part.get_mut("markscheme").and_then(Value::as_array_mut) {
                let before = items.len();
                items.retain(|item| !blank(&item["text"]));
                if items.len() != before {
                    let total: f64 = items.iter().filter_map(|item| item["marks"].as_f64()).sum();
                    part["marks"] = number(total);
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
    for question in held_questions_json(content, Some(&KeysRead::new(keys))) {
        walk(&question, &mut ids);
    }
    // Drawn sample answers live in the keys: read them there, whatever the
    // part's answer type says now, so one being written stays in use.
    if let Some(root) = keys.get_map(KEYS_ROOT) {
        for (_, entry) in root.iter(keys) {
            if let Out::YMap(key) = entry {
                for name in ["sampleBoard", "sampleImage"] {
                    if let Some(id) = str_at(keys, &key, name)
                        && !id.trim().is_empty()
                    {
                        ids.insert(id);
                    }
                }
            }
        }
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
        held_questions_json::<T, T>(txn, None)
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
// lists by the browser's rule ([sync_entries]), so an editor typing into
// the same question keeps every character (D7: no revision check; REVIEW1
// S6). On empty documents it writes the question whole.

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

/// A list of entries (`list`) holds one entry per item afterwards,
/// written as the browser's `writeList` and `writeBlocks` (liveQuiz.ts)
/// write it, assuming one editor action. Entries that read as their item
/// (`read`) at the head and tail stay untouched; a middle that is a
/// permutation of the held one only moves (order keys change, entries keep
/// their contents); otherwise the middle is changed in place by position
/// (`fill`; an entry that cannot hold its item, `fits`, gives way to a fresh
/// one under its order key), extra items get fresh entries between their
/// neighbours and extra entries go. Order keys are [order::rising], so an
/// empty list takes ids `prefix0..` under keys `a0..`. The ids, in order.
fn sync_entries<I: PartialEq>(
    txn: &mut TransactionMut,
    list: &MapRef,
    prefix: &str,
    items: &[I],
    read: impl Fn(&TransactionMut, &MapRef) -> Option<I>,
    fits: impl Fn(Option<&I>, &I) -> bool,
    mut fill: impl FnMut(&mut TransactionMut, &MapRef, &I),
) -> Vec<String> {
    let held = ordered(txn, Some(list));
    let reads: Vec<Option<I>> = held.iter().map(|entry| read(txn, &entry.map)).collect();
    let same = |h: usize, w: usize| reads[h].as_ref() == Some(&items[w]);
    let places = moved(held.len(), items.len(), same)
        .unwrap_or_else(|| figure_map::align_places(held.len(), items.len(), same));
    // Each slot's id first (fresh ones in slot order), so order keys compare
    // ties by id as readers sort.
    let reused: Vec<Option<usize>> = items
        .iter()
        .zip(&places)
        .map(|(item, at)| at.filter(|&h| fits(reads[h].as_ref(), item)))
        .collect();
    let mut n = 0;
    let ids: Vec<String> = reused
        .iter()
        .map(|at| match at {
            Some(h) => held[*h].id.clone(),
            None => fresh_id(txn, list, prefix, &mut n),
        })
        .collect();
    let offered: Vec<(&str, &str)> = ids
        .iter()
        .zip(&places)
        .map(|(id, at)| (id.as_str(), at.map_or("", |h| held[h].order.as_str())))
        .collect();
    let orders = order::rising(&offered);
    for (w, (item, order)) in items.iter().zip(orders).enumerate() {
        let entry = match reused[w] {
            Some(h) => held[h].map.clone(),
            None => list.insert(txn, ids[w].clone(), MapPrelim::default()),
        };
        sync_plain(txn, &entry, "order", Some(order_any(&order)));
        if reused[w].is_none_or(|h| !same(h, w)) {
            fill(txn, &entry, item);
        }
    }
    // Last, so a fresh id never takes one this write let go.
    let kept: HashSet<&str> = ids.iter().map(String::as_str).collect();
    for entry in &held {
        if !kept.contains(entry.id.as_str()) {
            list.remove(txn, &entry.id);
        }
    }
    ids
}

/// The held index each of `count` wanted entries keeps when, past the alike
/// head and tail, the held middle is a permutation of the wanted one (a
/// move: entries are matched by `same`, first alike first); none otherwise.
fn moved(
    held: usize,
    count: usize,
    same: impl Fn(usize, usize) -> bool + Copy,
) -> Option<Vec<Option<usize>>> {
    if held != count {
        return None;
    }
    let (head, tail) = figure_map::ends(held, count, same);
    let mut pool: Vec<usize> = (head..held - tail).collect();
    if pool.len() < 2 {
        return None;
    }
    (0..count)
        .map(|w| {
            if w < head || w >= count - tail {
                return Some(Some(w));
            }
            let at = pool.iter().position(|&h| same(h, w))?;
            Some(Some(pool.remove(at)))
        })
        .collect()
}

/// A list of `{order, text}` entries holding `items` ([sync_entries],
/// compared by text). The ids, in order.
fn sync_texts(
    txn: &mut TransactionMut,
    parent: &MapRef,
    key: &str,
    prefix: &str,
    items: &[String],
) -> Vec<String> {
    let list = child_map(txn, parent, key);
    sync_entries(
        txn,
        &list,
        prefix,
        items,
        |txn, entry| Some(text_at(txn, entry, "text")),
        |_, _| true,
        |txn, entry, text| sync_text(txn, entry, "text", text),
    )
}

/// The fixed entry key of an open part's one sample answer, the same on every
/// writer (the browser's `SAMPLE_KEY`).
pub const SAMPLE_KEY: &str = "sample";

/// An open part's one sample answer ([OPEN_ACCEPTED_MAX]) under [SAMPLE_KEY]
/// (Epo 2026-11-22, "then last save wins? if we change the question data
/// structure now we need to change the UI as well, dont"): two writers adding
/// it at once set the same entry and one of the two wins, so the list never
/// holds two. One held under
/// another key (seeded content) is changed or removed in place.
fn sync_sample(txn: &mut TransactionMut, key: &MapRef, sample: Option<&str>) {
    let list = child_map(txn, key, "accepted");
    let held = ordered(txn, Some(&list));
    for entry in held.iter().skip(usize::from(sample.is_some())) {
        list.remove(txn, &entry.id);
    }
    let Some(sample) = sample else { return };
    let entry = match held.first() {
        Some(entry) => entry.map.clone(),
        None => {
            let entry = list.insert(txn, SAMPLE_KEY, MapPrelim::default());
            let order = order::rising(&[(SAMPLE_KEY, "")]).remove(0);
            sync_plain(txn, &entry, "order", Some(order_any(&order)));
            entry
        }
    };
    sync_text(txn, &entry, "text", sample);
}

/// A block list holding `blocks` ([sync_entries]): a block is the same as
/// an entry that reads back as it ([read_block], the room's read), changed
/// in place while its type stays (a block of another type, or one that
/// cannot be read, gives way to a fresh entry).
fn sync_blocks(txn: &mut TransactionMut, parent: &MapRef, key: &str, blocks: &[Value]) {
    let list = child_map(txn, parent, key);
    sync_entries(
        txn,
        &list,
        "b",
        blocks,
        |txn, entry| read_block(txn, entry),
        |held, block| held.is_some_and(|held| held["type"] == block["type"]),
        sync_block,
    );
}

/// A block entry (of the block's type, or fresh) made to hold `block`,
/// writing only what differs.
fn sync_block(txn: &mut TransactionMut, map: &MapRef, block: &Value) {
    let kind = str_of(block, "type");
    sync_plain(txn, map, "type", Some(string_any(kind)));
    let plain_str = |key: &str| block.get(key).and_then(Value::as_str).map(string_any);
    match kind {
        "text" => {
            sync_text(txn, map, "text", str_of(block, "text"));
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
            let (columns, rows) = align_table(txn, map, grid, width);
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
        _ => figure_map::sync(txn, map, kind, block),
    }
}

/// A table's columns and rows aligned by `figure_map::align_axis` as the
/// browser's `writeTable` does: columns first (one added or removed shifts
/// every row alike), then rows, each compared by its cells' texts. The
/// column and row ids, in order.
fn align_table(
    txn: &mut TransactionMut,
    map: &MapRef,
    grid: &[Value],
    width: usize,
) -> (Vec<String>, Vec<String>) {
    let row_map = child_map(txn, map, "rows");
    let column_map = child_map(txn, map, "columns");
    let cells = child_map(txn, map, "cells");
    let held_rows = ordered_keys(txn, Some(&row_map));
    let held_columns = ordered_keys(txn, Some(&column_map));
    let cell = |txn: &TransactionMut, row: &str, column: &str| {
        text_at(txn, &cells, &format!("{row}/{column}"))
    };
    let wanted = |row: &Value, c: usize| {
        row.get(c)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    // As the browser compares: the texts joined.
    let joined = |texts: Vec<String>| texts.join("\u{0}");
    let columns = figure_map::align_axis(
        txn,
        &column_map,
        width,
        |txn, h, w| {
            let held = held_rows.iter().map(|row| cell(txn, row, &held_columns[h]));
            let rows = grid.iter().take(held_rows.len());
            joined(held.collect()) == joined(rows.map(|row| wanted(row, w)).collect())
        },
        "col",
        |txn, column| {
            for row in &held_rows {
                cells.remove(txn, &format!("{row}/{column}"));
            }
        },
    );
    let rows = figure_map::align_axis(
        txn,
        &row_map,
        grid.len(),
        |txn, h, w| {
            let held = columns
                .iter()
                .map(|column| cell(txn, &held_rows[h], column));
            let wanted = (0..columns.len()).map(|c| wanted(&grid[w], c));
            joined(held.collect()) == joined(wanted.collect())
        },
        "row",
        |txn, row| {
            for column in &columns {
                cells.remove(txn, &format!("{row}/{column}"));
            }
        },
    );
    (columns, rows)
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
            let ids = sync_texts(content, &answer_map, "options", "o", &options);
            let flag = answer.get("multiple") == Some(&Value::Bool(true));
            let multiple = (flag || indexes.len() > 1).then_some(Any::Bool(true));
            sync_plain(content, &answer_map, "multiple", multiple);
            sync_plain(keys, &key, "multiple", flag.then_some(Any::Bool(true)));
            let shuffle = answer.get("shuffle") == Some(&Value::Bool(true));
            sync_plain(
                content,
                &answer_map,
                "shuffle",
                shuffle.then_some(Any::Bool(true)),
            );
            let locked: HashSet<&str> = array_of(&answer, "locked")
                .iter()
                .filter_map(|i| ids.get(i.as_u64()? as usize))
                .map(String::as_str)
                .collect();
            if shuffle && !locked.is_empty() {
                let pins = child_map(content, &answer_map, "locked");
                remove_keys(content, &pins, |id| locked.contains(id));
                for id in locked {
                    sync_plain(content, &pins, id, Some(Any::Bool(true)));
                }
            } else if answer_map.get(content, "locked").is_some() {
                answer_map.remove(content, "locked");
            }
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
            sync_texts(keys, &key, "accepted", "a", &strings(&answer, "accepted"));
        }
        "open" | "drawing" => {
            if kind == "drawing" {
                let sample = answer.get("sample");
                let id = |name: &str| {
                    sample
                        .and_then(|s| s.get(name))
                        .and_then(Value::as_str)
                        .map(string_any)
                };
                sync_plain(keys, &key, "sampleBoard", id("board"));
                sync_plain(keys, &key, "sampleImage", id("image"));
            }
            if kind == "open" {
                let accepted = strings(&answer, "accepted");
                sync_sample(keys, &key, accepted.first().map(String::as_str));
            }
            // Matched by text, as the browser's; the marks follow the ids.
            let items = array_of(part, "markscheme");
            let texts: Vec<String> = items
                .iter()
                .map(|item| str_of(item, "text").to_owned())
                .collect();
            let ids = sync_texts(keys, &key, "markscheme", "m", &texts);
            let list = child_map(keys, &key, "markscheme");
            for (id, item) in ids.iter().zip(items) {
                if let Some(entry) = map_at(keys, &list, id) {
                    let marks = item.get("marks").and_then(Value::as_f64).unwrap_or(1.0);
                    sync_plain(keys, &entry, "marks", Some(Any::Number(marks)));
                }
            }
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
                sync_texts(keys, &gaps, &(n + 1).to_string(), "g", &items);
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
            let left_ids = sync_texts(content, &answer_map, "left", "l", &left);
            let options = strings(&answer, "options");
            let option_ids = sync_texts(keys, &key, "options", "o", &options);
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
            sync_texts(keys, &key, "items", "i", &strings(&answer, "items"));
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
    let topics = array_of(question, "topicIds");
    sync_plain(
        content,
        &map,
        "topicIds",
        (!topics.is_empty()).then(|| json_any(&question["topicIds"])),
    );
    sync_blocks(content, &map, "stem", array_of(question, "stem"));
    sync_groups(content, &map, array_of(question, "groups"));
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
    let mut last: Option<(&str, String)> = None;
    for part in parts {
        let id = str_of(part, "id");
        let entry = child_map(content, &parts_map, id);
        let held = str_at(content, &entry, "order");
        let order = figure_map::next_order(
            id,
            held.as_deref(),
            last.as_ref().map(|(id, order)| (*id, order.as_str())),
        );
        sync_plain(content, &entry, "order", Some(order_any(&order)));
        last = Some((id, order));
        // An open part's marks are its items' total, which merges may take
        // past twice the cap; its own marks stop where the room admits them,
        // and the total past it stays the warning the user tunes.
        let marks = part.get("marks").and_then(Value::as_f64);
        let marks = marks.map(|marks| Any::Number(marks.min(MAX_PART_MARKS)));
        sync_plain(content, &entry, "marks", marks);
        let group = part.get("group").and_then(Value::as_str).map(string_any);
        sync_plain(content, &entry, "group", group);
        sync_blocks(content, &entry, "blocks", array_of(part, "blocks"));
        sync_answer(content, &entry, keys, key_root, part);
    }
}

/// A question's groups, written as what differs; a question that has none and
/// never had gets no map.
fn sync_groups(content: &mut TransactionMut, question: &MapRef, groups: &[Value]) {
    if groups.is_empty() && !question.contains_key(content, "groups") {
        return;
    }
    let map = child_map(content, question, "groups");
    let wanted: HashSet<&str> = groups.iter().map(|group| str_of(group, "id")).collect();
    remove_keys(content, &map, |id| wanted.contains(id));
    for group in groups {
        let entry = child_map(content, &map, str_of(group, "id"));
        sync_blocks(content, &entry, "blocks", array_of(group, "blocks"));
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
            if !stored_id(&question) || !seen.insert(id.to_owned()) {
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

/// What readers get of one part's key: a matching or ordering part's
/// entries as the keys document holds them ((entry id, text) in the keys'
/// order), and the marks a part with marking items is worth, their total.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ItemsPart {
    pub part: String,
    pub kind: String,
    pub entries: Vec<(String, String)>,
    pub total: Option<u32>,
}

/// Every matching and ordering part's entries and every marked part's total,
/// by part id.
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
                "matching" => Some("options"),
                "ordering" => Some("items"),
                _ => None,
            };
            let scheme = ordered(keys, map_at(keys, &key, "markscheme").as_ref());
            // A part with marking items is worth their total, which two
            // editors' adds at once may take past the cap (Epo 2026-11-22,
            // "Yes, A everywhere"); readers without the keys learn it here.
            let total = (!scheme.is_empty()).then(|| {
                scheme
                    .iter()
                    .map(|item| num_at(keys, &item.map, "marks").unwrap_or(1.0) as u32)
                    .sum()
            });
            if list.is_none() && total.is_none() {
                return None;
            }
            let entries = list
                .map(|list| {
                    ordered(keys, map_at(keys, &key, list).as_ref())
                        .iter()
                        .map(|entry| (entry.id.clone(), text_at(keys, &entry.map, "text")))
                        .collect()
                })
                .unwrap_or_default();
            Some(ItemsPart {
                part: part.to_owned(),
                kind,
                entries,
                total,
            })
        })
        .collect();
    out.sort_by(|a, b| a.part.cmp(&b.part));
    out
}

/// A random index below its argument (the server draws from the OS; tests
/// seed it).
pub type Pick<'a> = &'a mut dyn FnMut(usize) -> usize;

/// One part's list as readers get it: its kind, its texts (none but a
/// matching or ordering part's) and its marking items' total.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReaderList {
    pub kind: String,
    pub items: Vec<String>,
    pub total: Option<u32>,
}

/// A part's list as the readers hold it: its kind, (entry id, text) in the
/// readers' order and its total.
#[derive(Debug)]
struct HeldList {
    kind: String,
    entries: Vec<(String, String)>,
    total: Option<u32>,
}

impl HeldList {
    fn reader(&self) -> ReaderList {
        ReaderList {
            kind: self.kind.clone(),
            items: self.entries.iter().map(|(_, text)| text.clone()).collect(),
            total: self.total,
        }
    }
}

/// What readers get of matching options and ordering items (D3, revised by
/// Epo 2026-10-10): not Yjs, which keeps every deleted struct, but a plain
/// list of texts per part that the content room pushes over its channels
/// whenever the keys change, keeping no history. A part whose entries
/// changed as a set, or changed more than one text at once (a write that
/// reorders and edits at once changes its middle by position), or took a
/// text another entry shows, is
/// shuffled afresh (a uniform permutation, so the list says nothing about
/// the order the keys hold or were typed in or which text replaced which);
/// one where a single text changed in place keeps its order.
#[derive(Debug, Default)]
pub struct ReaderLists {
    parts: HashMap<String, HeldList>,
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
            // (typing). A write that reorders and edits at once is not a
            // move, so it changes the middle by position: several texts
            // under the same ids. Keeping the order would show readers which
            // old text each new one replaced
            // (REVIEW2 M2), so that, too, shuffles afresh. So does a text
            // retyped into one another entry shows: two retypes in separate
            // windows would otherwise show a swap (REVIEW3 N1).
            let in_place = held.is_some_and(|HeldList { kind, entries, .. }| {
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
                Some(HeldList { entries, .. }) if in_place => entries
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
            if held.is_some_and(|held| {
                held.kind == part.kind && held.entries == next && held.total == part.total
            }) {
                continue;
            }
            let list = HeldList {
                kind: part.kind.clone(),
                entries: next,
                total: part.total,
            };
            changed.push((part.part.clone(), Some(list.reader())));
            self.parts.insert(part.part.clone(), list);
        }
        changed.sort_by(|a, b| a.0.cmp(&b.0));
        changed
    }

    /// Every part's list, for a channel that joins.
    pub fn all(&self) -> Vec<(String, ReaderList)> {
        let mut out: Vec<(String, ReaderList)> = self
            .parts
            .iter()
            .map(|(part, list)| (part.clone(), list.reader()))
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
                Some(list) => {
                    let mut value = json!({ "kind": list.kind, "items": list.items });
                    if let Some(total) = list.total {
                        value["total"] = json!(total);
                    }
                    value
                }
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

/// An image's `{url}` a live quiz room admits:
/// blank while its upload is pending, else one a stored question keeps
/// (hosted under the policy's figure host, `BANK_ASSETS_URL`).
fn figure_url(url: &str, policy: &Policy) -> bool {
    url.is_empty()
        || (url.encode_utf16().count() <= q::QUESTION_ASSET_URL_MAX && policy.hosted(url))
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

/// An image's attribution: metadata, measured in UTF-16 units as the
/// question schema measures it.
fn a_meta(content: &ItemContent) -> bool {
    matches!(one_any(content), Some(Any::String(value)) if value.encode_utf16().count() <= q::QUESTION_METADATA_MAX)
}

fn a_bool(content: &ItemContent) -> bool {
    matches!(one_any(content), Some(Any::Bool(_)))
}

/// Whole marks up to `max` a part or a marking item may carry (the store's
/// caps, REVIEW1 M4: nothing the store refuses gets past admission).
fn whole_marks(content: &ItemContent, max: f64) -> bool {
    matches!(one_any(content), Some(Any::Number(value))
        if value.fract() == 0.0 && (1.0..=max).contains(value))
}

/// What one update adds, which texts it types into and which lists it grows.
struct Tally<'a> {
    /// The figure host links must be under ([figure_url]).
    policy: &'a Policy,
    growth: Growth,
    /// Full path of a text (its container keys) to the UTF-16 units added.
    typed: HashMap<Vec<Arc<str>>, u64>,
    /// A list's (or table axis's) path to the entries the update adds there.
    added: HashMap<Vec<Arc<str>>, u64>,
    /// Answer types the update sets to `open`.
    open: u64,
}

impl Tally<'_> {
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
        ([], Some("type")) if one_of(content, BLOCK_TYPES) => tally.value(content),
        ([], Some("attribution")) if a_meta(content) => tally.value(content),
        ([], Some("header")) if a_bool(content) => tally.value(content),
        // An image waiting for its upload is structure, not a refused value
        // (D4, REVIEW1 M3): blank, it only leaves the question incomplete.
        ([], Some("image")) => match one_any(content) {
            Some(Any::Map(image))
                if image.len() == 1
                    && (matches!(image.get("assetId"), Some(Any::String(id)) if id.chars().count() <= q::QUESTION_ID_MAX)
                        || matches!(image.get("url"), Some(Any::String(url)) if figure_url(url, tally.policy))) =>
            {
                tally.value(content)
            }
            _ => return refuse("an image that is not {assetId} or a hosted {url}"),
        },
        ([], Some("text" | "description")) if is_text(content) => tally.structure(32),
        ([], Some("rows" | "columns" | "cells")) if is_map(content) => tally.structure(8),
        ([], Some(key)) if figure_map::is_map_key(key) && is_map(content) => tally.structure(8),
        // An image's size and a chart's, plot's or graph's plain fields (Epo
        // 2026-11-16), each held to its cap as a note figure's are
        // (`figure_map`); their form is the validators'. A figure is never
        // one value (the layout before it is refused).
        ([], Some(key)) => match one_any(content) {
            Some(value) => {
                figure_map::check_field(key, value).or_else(refuse)?;
                tally.value(content);
            }
            None => return refuse("a struct outside its shape"),
        },
        (["rows" | "columns"], Some(id)) if valid_id(id) && order_key(content) => {
            tally.entry(path, 8);
        }
        // An entry of a figure's maps: a series' or label's order key, a
        // name, a value, a board field, a graph element by its id.
        ([inner], Some(key)) if figure_map::is_map_key(inner) => match one_any(content) {
            Some(value) => {
                figure_map::check_entry(inner, key, value).or_else(refuse)?;
                if *inner != "board" {
                    tally.entry(path, 8);
                }
                if !matches!(*inner, "series" | "labels") {
                    tally.value(content);
                }
            }
            None => return refuse("a figure entry that is not plain"),
        },
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
        ([], Some("marks")) if marks && whole_marks(content, MAX_MARKS) => tally.value(content),
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
        // A question's own topics (Epo 2026-11-15), distinct ids as the
        // validators check them; whether each is one of the workspace's is read
        // where it counts.
        ([R, _], Some("topicIds")) => match one_any(content) {
            Some(Any::Array(topics)) if topic_ids(topics) => {
                tally.value(content);
                Ok(())
            }
            _ => refuse("topics that are not distinct ids"),
        },
        ([R, _], Some("stem" | "groups" | "parts")) if is_map(content) => {
            tally.structure(16);
            Ok(())
        }
        ([R, _, "stem"], Some(id))
        | ([R, _, "groups"], Some(id))
        | ([R, _, "groups", _, "blocks"], Some(id))
        | ([R, _, "parts", _, "blocks"], Some(id)) => new_entry(content, id, full, tally),
        ([R, _, "stem", _, rest @ ..], key)
        | ([R, _, "groups", _, "blocks", _, rest @ ..], key) => {
            block_shape(rest, key, content, full, tally)
        }
        ([R, _, "groups", _], Some("blocks")) if is_map(content) => {
            tally.structure(16);
            Ok(())
        }
        ([R, _, "parts"], Some(id)) => new_entry(content, id, full, tally),
        // Names a group of any id the validators let it have: a stored one may hold
        // what a key a client creates may not (`new_entry`), as a part's id may.
        ([R, _, "parts", _], Some("group")) => match one_any(content) {
            Some(Any::String(group)) if !group.is_empty() && group.chars().count() <= MAX_ID => {
                tally.value(content);
                Ok(())
            }
            _ => refuse("a part's group that does not name one"),
        },
        ([R, _, "parts", _], Some("order")) if order_key(content) => {
            tally.value(content);
            Ok(())
        }
        ([R, _, "parts", _], Some("marks")) if whole_marks(content, MAX_PART_MARKS) => {
            tally.value(content);
            Ok(())
        }
        ([R, _, "parts", _], Some("marks")) => {
            refuse(format!("a part outside 1 to {MAX_PART_MARKS} whole marks"))
        }
        ([R, _, "parts", _], Some("blocks" | "answer")) if is_map(content) => {
            tally.structure(16);
            Ok(())
        }
        ([R, _, "parts", _, "blocks", _, rest @ ..], key) => {
            block_shape(rest, key, content, full, tally)
        }
        ([R, _, "parts", _, "answer"], Some("type")) if one_of(content, ANSWER_TYPES) => {
            if one_of(content, &["open", "drawing"]) {
                tally.open += 1;
            }
            tally.value(content);
            Ok(())
        }
        ([R, _, "parts", _, "answer"], Some("multiple" | "shuffle")) if a_bool(content) => {
            tally.value(content);
            Ok(())
        }
        // Shuffle options' locked options: a map of ticks by option id.
        ([R, _, "parts", _, "answer"], Some("locked")) if is_map(content) => {
            tally.structure(16);
            Ok(())
        }
        ([R, _, "parts", _, "answer", "locked"], Some(option)) if valid_id(option) => {
            match one_any(content) {
                Some(Any::Bool(true)) => {
                    tally.value(content);
                    tally.count(full);
                    Ok(())
                }
                _ => refuse("a lock that is not true"),
            }
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
    const LISTS: &[&str] = &["accepted", "markscheme", "options", "items"];
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
        // An mcq's Multiple answer flag (Epo 2026-11-15).
        ([K, _], Some("multiple")) if a_bool(content) => {
            tally.value(content);
            Ok(())
        }
        ([K, _], Some("sampleBoard" | "sampleImage")) if a_string(content, q::QUESTION_ID_MAX) => {
            tally.value(content);
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

/// A text's cap by its path (characters; its UTF-16 length bounds them):
/// twice the text's own, as two people typing in it at once may pass that
/// (Epo 2026-11-22, "Yes, A everywhere"); the editors stop at the cap.
fn text_cap(path: &[&str], open_part: bool) -> usize {
    merged_cap(match path {
        [KEYS_ROOT, _, "markscheme", _, "text"] => q::QUESTION_MARK_ITEM_MAX,
        [KEYS_ROOT, _, "accepted", _, "text"] if open_part => q::QUIZ_OPEN_ANSWER_MAX,
        // An image block's description (a block's only text so named).
        [.., "description"] => q::QUESTION_DESCRIPTION_MAX,
        _ => q::QUESTION_TEXT_MAX,
    })
}

/// A block's own list's cap by its field: a table's axes and cells and a
/// figure's maps (`figure_map::map_cap`), each at twice its cap, as two
/// people's adds at once may pass that.
fn block_list_cap(field: &str) -> Option<usize> {
    let (rows, columns) = (
        merged_cap(q::QUESTION_TABLE_ROWS_MAX),
        merged_cap(q::QUESTION_TABLE_COLUMNS_MAX),
    );
    Some(match field {
        "rows" => rows,
        "columns" => columns,
        "cells" => rows * columns,
        _ => return figure_map::map_cap(field),
    })
}

/// A list's (or table axis's) cap by its path, as the exact check counts it:
/// twice the list's own (a gap's number is its key, so the gaps stop at
/// theirs).
fn list_cap(path: &[&str]) -> Option<usize> {
    const R: &str = QUESTIONS_ROOT;
    const K: &str = KEYS_ROOT;
    let table = match path {
        [R, _, "stem", _, field]
        | [R, _, "groups", _, "blocks", _, field]
        | [R, _, "parts", _, "blocks", _, field]
        | [K, _, "solution", _, field] => Some(*field),
        _ => None,
    };
    if let Some(field) = table {
        return block_list_cap(field);
    }
    if matches!(path, [K, _, "gaps"]) {
        return Some(q::QUESTION_ANSWERS_MAX);
    }
    Some(merged_cap(match path {
        [R, _, "stem"]
        | [R, _, "groups", _, "blocks"]
        | [R, _, "parts", _, "blocks"]
        | [K, _, "solution"] => q::QUESTION_BLOCKS_MAX,
        [R] => q::QUIZ_PARTS_MAX,
        // A group has at least one part, so no more groups than parts.
        [R, _, "parts"] | [R, _, "groups"] => q::QUIZ_QUESTION_PARTS_MAX,
        [R, _, "parts", _, "answer", "options" | "left"] => q::QUESTION_ANSWERS_MAX,
        [K] => q::QUIZ_PARTS_MAX * 2,
        [K, _, "accepted" | "options" | "items" | "correct" | "pairs"] => q::QUESTION_ANSWERS_MAX,
        [K, _, "markscheme"] => q::QUIZ_MARKSCHEME_MAX,
        [K, _, "gaps", _] => q::QUESTION_ANSWERS_MAX,
        _ => return None,
    }))
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
            if map_at(txn, &part, "answer").is_some_and(|answer| {
                str_at(txn, &answer, "type").is_some_and(|kind| model_marked(&kind))
            }) {
                open += 1;
            }
        }
    }
    (parts, open)
}

/// One document's shape table: a struct's container path, its key, its
/// content and its full path, tallied.
type Shape = fn(&[&str], Option<&str>, &ItemContent, &[Arc<str>], &mut Tally) -> Result<(), String>;

fn admit<T: ReadTxn>(
    txn: &T,
    incoming: &Incoming,
    shape: Shape,
    policy: &Policy,
) -> Result<Growth, String> {
    let state = txn.state_vector();
    let mut locator = Locator::new(txn, incoming);
    let mut tally = Tally {
        policy,
        growth: Growth::default(),
        typed: HashMap::new(),
        added: HashMap::new(),
        open: 0,
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
        if parts + new_parts > merged_cap(q::QUIZ_PARTS_MAX) as u64
            || open + tally.open > merged_cap(q::QUIZ_OPEN_PARTS_MAX) as u64
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
pub fn admit_content<T: ReadTxn>(
    txn: &T,
    incoming: &Incoming,
    policy: &Policy,
) -> Result<Growth, String> {
    admit(txn, incoming, content_shape, policy)
}

/// The same for the keys document.
pub fn admit_keys<T: ReadTxn>(
    txn: &T,
    incoming: &Incoming,
    policy: &Policy,
) -> Result<Growth, String> {
    admit(txn, incoming, keys_shape, policy)
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

fn check_marks(marks: Option<f64>, max: f64, what: &str) -> Result<(), String> {
    match marks {
        None => Ok(()),
        Some(marks) if marks.fract() == 0.0 && (1.0..=max).contains(&marks) => Ok(()),
        Some(_) => Err(format!("{what} carries 1 to {max} whole marks")),
    }
}

/// A count, typed text or part's marks that two people's edits at once may
/// take past its cap, up to twice it (Epo 2026-11-22), as the exact check
/// meets it: where it sits (`at`, ids that stay across edits, with `field`),
/// what it is, what it holds now and its own cap. A writer's edit may not
/// grow one past its cap ([check_written]). A writer's rewrite gives an entry
/// it cannot match its id by place, so a text or a block's list is placed by
/// its list or section alone and held by rank among that place's values.
pub struct Measure<'a> {
    at: &'a str,
    field: &'a str,
    what: &'a str,
    value: usize,
    cap: usize,
    unit: &'a str,
}

impl Measure<'_> {
    fn key(&self) -> String {
        format!("{}/{}", self.at, self.field)
    }
}

/// Each [Measure] the exact check meets, handed on as it goes.
type Visit<'v> = &'v mut dyn FnMut(&Measure) -> Result<(), String>;

/// A count up to twice its cap, handed to `visit`.
fn measure_count(
    visit: Visit,
    at: &str,
    field: &str,
    what: &str,
    value: usize,
    cap: usize,
) -> Result<(), String> {
    check_count(value, merged_cap(cap), what)?;
    visit(&Measure {
        at,
        field,
        what,
        value,
        cap,
        unit: "",
    })
}

/// A typed text up to twice its cap, handed to `visit`.
fn measure_text(
    visit: Visit,
    at: &str,
    field: &str,
    what: &str,
    text: &str,
    cap: usize,
) -> Result<(), String> {
    check_text(text, merged_cap(cap), what)?;
    visit(&Measure {
        at,
        field,
        what,
        value: chars(text),
        cap,
        unit: " characters",
    })
}

/// A section's blocks, each typed text and list up to twice its cap (Epo
/// 2026-11-22); a figure's plain fields at theirs, as they came. `at` names
/// the section.
fn check_blocks<T: ReadTxn>(
    txn: &T,
    map: Option<&MapRef>,
    at: &str,
    visit: Visit,
) -> Result<(), String> {
    let blocks = ordered(txn, map);
    measure_count(
        visit,
        at,
        "blocks",
        "a section",
        blocks.len(),
        q::QUESTION_BLOCKS_MAX,
    )?;
    for block in &blocks {
        measure_text(
            visit,
            at,
            "text",
            "a question text",
            &text_at(txn, &block.map, "text"),
            q::QUESTION_TEXT_MAX,
        )?;
        measure_text(
            visit,
            at,
            "description",
            "a description",
            &text_at(txn, &block.map, "description"),
            q::QUESTION_DESCRIPTION_MAX,
        )?;
        if let Some(meta) = str_at(txn, &block.map, "attribution")
            && meta.encode_utf16().count() > q::QUESTION_METADATA_MAX
        {
            return Err(format!(
                "an attribution holds at most {} characters",
                q::QUESTION_METADATA_MAX
            ));
        }
        for field in ["width", "height"] {
            if let Some(size) = num_at(txn, &block.map, field)
                && !(size.fract() == 0.0 && (1.0..=q::QUESTION_IMAGE_DIMENSION_MAX).contains(&size))
            {
                return Err(format!("an image's {field} is out of range"));
            }
        }
        // A figure's description is plain; its other fields were held to
        // their caps as they came.
        if let Some(description) = str_at(txn, &block.map, "description") {
            check_text(&description, q::QUESTION_DESCRIPTION_MAX, "a description")?;
        }
        for field in [
            "rows", "columns", "cells", "series", "labels", "names", "values", "elements",
        ] {
            if let (Some(map), Some(cap)) = (map_at(txn, &block.map, field), block_list_cap(field))
            {
                let owner = if matches!(field, "rows" | "columns" | "cells") {
                    "a table"
                } else {
                    "a figure"
                };
                let what = format!("{owner}'s {field}");
                let count = map.len(txn) as usize;
                check_count(count, cap, &what)?;
                // The lists an editor adds to; the rest follow them.
                if matches!(field, "rows" | "columns" | "series" | "labels" | "elements") {
                    visit(&Measure {
                        at,
                        field,
                        what: &what,
                        value: count,
                        cap: cap / 2,
                        unit: "",
                    })?;
                }
            }
        }
        if let Some(cells) = map_at(txn, &block.map, "cells") {
            for (_, value) in cells.iter(txn) {
                if let Out::YText(text) = value {
                    measure_text(
                        visit,
                        at,
                        "cell",
                        "a table cell",
                        &text.get_string(txn),
                        q::QUESTION_TEXT_MAX,
                    )?;
                }
            }
        }
    }
    Ok(())
}

/// A list of typed entries: at most twice `cap` entries, each text at most
/// twice `text_cap` (Epo 2026-11-22). `at` names the list.
#[allow(clippy::too_many_arguments)]
fn check_list<T: ReadTxn>(
    txn: &T,
    map: Option<&MapRef>,
    cap: usize,
    text_cap: usize,
    what: &str,
    at: &str,
    visit: Visit,
) -> Result<(), String> {
    let items = ordered(txn, map);
    measure_count(visit, at, "count", what, items.len(), cap)?;
    for item in &items {
        measure_text(
            visit,
            at,
            "text",
            what,
            &text_at(txn, &item.map, "text"),
            text_cap,
        )?;
    }
    Ok(())
}

/// The content document's caps, exactly (the exact check's candidate): each
/// count and typed text up to twice its cap, as two editors' edits at once may
/// leave it (Epo 2026-11-22).
pub fn check_content_caps<T: ReadTxn>(txn: &T) -> Result<(), String> {
    walk_content(txn, &mut |_| Ok(()))
}

/// [check_content_caps], handing each [Measure] to `visit`.
fn walk_content<T: ReadTxn>(txn: &T, visit: Visit) -> Result<(), String> {
    let root = txn.get_map(QUESTIONS_ROOT);
    let questions = ordered(txn, root.as_ref());
    let question_parts_max = merged_cap(q::QUIZ_QUESTION_PARTS_MAX);
    check_count(
        questions.len(),
        merged_cap(q::QUIZ_PARTS_MAX),
        "a quiz's questions",
    )?;
    let (mut parts, mut open) = (0usize, 0usize);
    for question in &questions {
        let at = &question.id;
        check_blocks(
            txn,
            map_at(txn, &question.map, "stem").as_ref(),
            &format!("{at}/stem"),
            visit,
        )?;
        let groups = ordered(txn, map_at(txn, &question.map, "groups").as_ref());
        measure_count(
            visit,
            at,
            "groups",
            "a question's groups",
            groups.len(),
            q::QUIZ_QUESTION_PARTS_MAX,
        )?;
        for group in &groups {
            check_blocks(
                txn,
                map_at(txn, &group.map, "blocks").as_ref(),
                &format!("{at}/groups/{}", group.id),
                visit,
            )?;
        }
        let question_parts = ordered(txn, map_at(txn, &question.map, "parts").as_ref());
        check_count(
            question_parts.len(),
            question_parts_max,
            "a question's parts",
        )?;
        visit(&Measure {
            at,
            field: "parts",
            what: "a question's parts",
            value: question_parts.len(),
            cap: q::QUIZ_QUESTION_PARTS_MAX,
            unit: "",
        })?;
        parts += question_parts.len();
        for part in &question_parts {
            let at = &part.id;
            check_blocks(
                txn,
                map_at(txn, &part.map, "blocks").as_ref(),
                &format!("{at}/blocks"),
                visit,
            )?;
            let marks = num_at(txn, &part.map, "marks");
            check_marks(marks, MAX_PART_MARKS, "a part")?;
            if let Some(marks) = marks {
                visit(&Measure {
                    at,
                    field: "marks",
                    what: "a part",
                    value: marks as usize,
                    cap: MAX_MARKS as usize,
                    unit: " marks",
                })?;
            }
            let Some(answer) = map_at(txn, &part.map, "answer") else {
                continue;
            };
            if str_at(txn, &answer, "type").is_some_and(|kind| model_marked(&kind)) {
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
                    &format!("{at}/{list}"),
                    visit,
                )?;
            }
        }
    }
    measure_count(
        visit,
        "",
        "parts",
        "a quiz's parts",
        parts,
        q::QUIZ_PARTS_MAX,
    )?;
    measure_count(
        visit,
        "",
        "open",
        "a quiz's AI-marked parts",
        open,
        q::QUIZ_OPEN_PARTS_MAX,
    )
}

/// The keys document's caps, exactly, each up to twice its cap.
pub fn check_keys_caps<T: ReadTxn>(txn: &T) -> Result<(), String> {
    walk_keys(txn, &mut |_| Ok(()))
}

/// [check_keys_caps], handing each [Measure] to `visit`.
fn walk_keys<T: ReadTxn>(txn: &T, visit: Visit) -> Result<(), String> {
    let Some(root) = txn.get_map(KEYS_ROOT) else {
        return Ok(());
    };
    check_count(
        root.len(txn) as usize,
        merged_cap(q::QUIZ_PARTS_MAX * 2),
        "a quiz's keys",
    )?;
    for (part, value) in root.iter(txn) {
        let Out::YMap(key) = value else { continue };
        check_blocks(
            txn,
            map_at(txn, &key, "solution").as_ref(),
            &format!("{part}/solution"),
            visit,
        )?;
        let open = str_at(txn, &key, "type").as_deref() == Some("open");
        let accepted = format!("{part}/accepted");
        if open {
            // An open part's one sample answer is a single field in its
            // editor, so its count stays at its cap.
            let samples = ordered(txn, map_at(txn, &key, "accepted").as_ref());
            check_count(samples.len(), OPEN_ACCEPTED_MAX, "accepted answers")?;
            for sample in &samples {
                measure_text(
                    visit,
                    &accepted,
                    "text",
                    "accepted answers",
                    &text_at(txn, &sample.map, "text"),
                    q::QUIZ_OPEN_ANSWER_MAX,
                )?;
            }
        } else {
            check_list(
                txn,
                map_at(txn, &key, "accepted").as_ref(),
                q::QUESTION_ANSWERS_MAX,
                q::QUESTION_TEXT_MAX,
                "accepted answers",
                &accepted,
                visit,
            )?;
        }
        for list in ["correct", "pairs"] {
            if let Some(map) = map_at(txn, &key, list) {
                measure_count(
                    visit,
                    &format!("{part}/{list}"),
                    "count",
                    "an answer list",
                    map.len(txn) as usize,
                    q::QUESTION_ANSWERS_MAX,
                )?;
            }
        }
        for list in ["options", "items"] {
            check_list(
                txn,
                map_at(txn, &key, list).as_ref(),
                q::QUESTION_ANSWERS_MAX,
                q::QUESTION_TEXT_MAX,
                "an answer list",
                &format!("{part}/{list}"),
                visit,
            )?;
        }
        let scheme_at = format!("{part}/markscheme");
        let scheme = ordered(txn, map_at(txn, &key, "markscheme").as_ref());
        measure_count(
            visit,
            &scheme_at,
            "count",
            "a marking scheme",
            scheme.len(),
            q::QUIZ_MARKSCHEME_MAX,
        )?;
        for item in &scheme {
            measure_text(
                visit,
                &scheme_at,
                "text",
                "a marking item",
                &text_at(txn, &item.map, "text"),
                q::QUESTION_MARK_ITEM_MAX,
            )?;
            check_marks(num_at(txn, &item.map, "marks"), MAX_MARKS, "a marking item")?;
        }
        if let Some(gaps) = map_at(txn, &key, "gaps") {
            check_count(
                gaps.len(txn) as usize,
                q::QUESTION_ANSWERS_MAX,
                "a part's gaps",
            )?;
            for (gap, list) in gaps.iter(txn) {
                if let Out::YMap(list) = list {
                    check_list(
                        txn,
                        Some(&list),
                        q::QUESTION_ANSWERS_MAX,
                        q::QUESTION_TEXT_MAX,
                        "a gap's accepted answers",
                        &format!("{part}/gaps/{gap}"),
                        visit,
                    )?;
                }
            }
        }
    }
    Ok(())
}

/// What each count, typed text and part's marks a document holds now, by
/// where it sits, each place's values largest first: a writer's edit is
/// checked against it ([check_written]).
pub type Held = HashMap<String, Vec<usize>>;

/// The [Held] measures of a quiz's content and keys documents. A part's held
/// marks are the more of its own and its marking items' total, which reads
/// report (`held_question_json`) and a writer may send back as they are.
pub fn held<C: ReadTxn, K: ReadTxn>(content: &C, keys: &K) -> (Held, Held) {
    let collect = |walk: &dyn Fn(Visit) -> Result<(), String>| {
        let mut held = Held::new();
        // A document already past twice a cap holds what it holds.
        let _ = walk(&mut |measure: &Measure| {
            held.entry(measure.key()).or_default().push(measure.value);
            Ok(())
        });
        for values in held.values_mut() {
            values.sort_unstable_by(|a, b| b.cmp(a));
        }
        held
    };
    let mut content_held = collect(&|visit| walk_content(content, visit));
    let keys_held = collect(&|visit| walk_keys(keys, visit));
    if let Some(root) = keys.get_map(KEYS_ROOT) {
        for (part, value) in root.iter(keys) {
            let Out::YMap(key) = value else { continue };
            // An item with no marks reads as worth 1, as every reader takes it.
            let total: f64 = ordered(keys, map_at(keys, &key, "markscheme").as_ref())
                .iter()
                .map(|item| num_at(keys, &item.map, "marks").unwrap_or(1.0))
                .sum();
            let marks = content_held.entry(format!("{part}/marks")).or_default();
            match marks.first_mut() {
                Some(own) => *own = (*own).max(total as usize),
                None => marks.push(total as usize),
            }
        }
    }
    (content_held, keys_held)
}

/// A server writer's edit (an agent's, question media, the content save API)
/// on a quiz's content and keys documents, against what they held before
/// ([held]): every count and text within twice its cap, and none grown past
/// its cap, as an editor stops there (Epo 2026-11-22, "Yes, A everywhere");
/// one a merge already took past it may stay or shrink.
pub fn check_written<C: ReadTxn, K: ReadTxn>(
    content: &C,
    keys: &K,
    (content_held, keys_held): &(Held, Held),
) -> Result<(), String> {
    within(content_held, &|visit| walk_content(content, visit))?;
    within(keys_held, &|visit| walk_keys(keys, visit))
}

/// Each place's values within their cap or held by rank: its n-th largest
/// no larger than the cap or the place's n-th largest before. A trimmed text
/// a block moved past still goes in, and neither a sibling grown towards a
/// long one nor a new long entry beside it does.
fn within(held: &Held, walk: &dyn Fn(Visit) -> Result<(), String>) -> Result<(), String> {
    // Place -> (the refusal, the cap, its values now).
    let mut now: BTreeMap<String, (String, usize, Vec<usize>)> = BTreeMap::new();
    walk(&mut |measure: &Measure| {
        let place = now.entry(measure.key()).or_insert_with(|| {
            let refusal = format!(
                "{} holds at most {}{}",
                measure.what, measure.cap, measure.unit
            );
            (refusal, measure.cap, Vec::new())
        });
        place.2.push(measure.value);
        Ok(())
    })?;
    for (place, (refusal, cap, mut values)) in now {
        values.sort_unstable_by(|a, b| b.cmp(a));
        let before = held.get(&place).map_or(&[][..], Vec::as_slice);
        let over = values
            .iter()
            .enumerate()
            .any(|(rank, value)| *value > cap.max(before.get(rank).copied().unwrap_or(0)));
        if over {
            return Err(refusal);
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
        if !stored_id(question) || !seen.insert(id.to_owned()) {
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
/// `remove_child` on the `quiz` parent) on both documents.
pub fn apply_commands(
    content: &mut TransactionMut,
    keys: &mut TransactionMut,
    commands: &[DocumentCommand],
) -> Result<(), EditError> {
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
                put_question(content, keys, &question, &order[at].order);
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
            }
            DocumentCommand::RemoveChild {
                parent_type,
                node_id,
            } if parent_type == "quiz" => {
                if !order.iter().any(|e| &e.id == node_id) {
                    return unavailable(format!("{node_id} no longer exists"));
                }
                remove_question(content, keys, node_id);
            }
            _ => {
                return invalid(
                    EditErrorCode::UnsupportedOperation,
                    "use the question commands for this material",
                );
            }
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
