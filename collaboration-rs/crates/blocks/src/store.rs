//! [Block]s in the room doc: the seed writes them as BlockSuite's `addBlock`
//! does, the reads give them back.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use serde_json::{Map, Value, json};
use yrs::types::Attrs;
use yrs::types::text::YChange;
use yrs::{
    Any, Array, ArrayPrelim, ArrayRef, Map as _, MapPrelim, MapRef, Out, ReadTxn, Text, TextPrelim,
    TextRef, TransactionMut,
};

use crate::schema::{self, NOTE, PAGE};
use crate::{BLOCKS_ROOT, Block, NOTE_ID, ProjectionError, Prop, ROOT_ID, Run, number_value};

/// Nesting deeper than this is refused rather than walked.
pub(crate) const MAX_DEPTH: usize = 256;

/// Writes the hubs and the note's content.
pub(crate) fn seed(txn: &mut TransactionMut, blocks: &MapRef, content: &[Block]) {
    let root = Block {
        id: ROOT_ID.into(),
        flavour: PAGE.into(),
        props: vec![("title".into(), Prop::Text(Vec::new()))],
        children: Vec::new(),
    };
    let note = Block {
        id: NOTE_ID.into(),
        flavour: NOTE.into(),
        props: schema::defaults(NOTE)
            .into_iter()
            .map(|(k, v)| (k.to_string(), Prop::Native(v)))
            .collect(),
        children: Vec::new(),
    };
    write(txn, blocks, &root, &[NOTE_ID]);
    let ids: Vec<&str> = content.iter().map(|b| b.id.as_str()).collect();
    write(txn, blocks, &note, &ids);
    // Depth first, parents before children.
    let mut stack: Vec<&Block> = content.iter().rev().collect();
    while let Some(block) = stack.pop() {
        let ids: Vec<&str> = block.children.iter().map(|b| b.id.as_str()).collect();
        write(txn, blocks, block, &ids);
        stack.extend(block.children.iter().rev());
    }
}

fn write(txn: &mut TransactionMut, blocks: &MapRef, block: &Block, children: &[&str]) {
    let version = schema::flavour(&block.flavour).map_or(1, |f| f.version);
    let y = blocks.insert(txn, block.id.as_str(), MapPrelim::default());
    y.insert(txn, "sys:id", block.id.as_str());
    y.insert(txn, "sys:flavour", block.flavour.as_str());
    y.insert(txn, "sys:version", Any::Number(f64::from(version)));
    y.insert(
        txn,
        "sys:children",
        ArrayPrelim::from(children.iter().map(|id| Any::from(*id))),
    );
    for (key, prop) in &block.props {
        let key = format!("prop:{key}");
        match prop {
            Prop::Text(runs) => {
                let text = y.insert(txn, key, TextPrelim::new(""));
                write_runs(txn, &text, runs);
            }
            Prop::Native(value) => insert_native(txn, &y, &key, value),
        }
    }
}

pub(crate) fn write_runs(txn: &mut TransactionMut, text: &TextRef, runs: &[Run]) {
    for run in runs {
        let attrs: Attrs = run
            .attrs
            .iter()
            .map(|(k, v)| (Arc::from(k.as_str()), to_any(v)))
            .collect();
        let at = text.len(txn);
        text.insert_with_attributes(txn, at, &run.text, attrs);
    }
}

/// `native2Y`, deep: objects as Y.Map, arrays as Y.Array.
fn insert_native(txn: &mut TransactionMut, map: &MapRef, key: &str, value: &Value) {
    match value {
        Value::Object(object) => {
            let inner = map.insert(txn, key, MapPrelim::default());
            for (k, v) in object {
                insert_native(txn, &inner, k, v);
            }
        }
        Value::Array(items) => {
            let inner = map.insert(txn, key, ArrayPrelim::default());
            for item in items {
                push_native(txn, &inner, item);
            }
        }
        primitive => {
            map.insert(txn, key, to_any(primitive));
        }
    }
}

fn push_native(txn: &mut TransactionMut, array: &ArrayRef, value: &Value) {
    match value {
        Value::Object(object) => {
            let inner = array.push_back(txn, MapPrelim::default());
            for (k, v) in object {
                insert_native(txn, &inner, k, v);
            }
        }
        Value::Array(items) => {
            let inner = array.push_back(txn, ArrayPrelim::default());
            for item in items {
                push_native(txn, &inner, item);
            }
        }
        primitive => {
            array.push_back(txn, to_any(primitive));
        }
    }
}

/// A JSON value as a yrs `Any` (text attributes; primitives of `native2Y`).
pub(crate) fn to_any(value: &Value) -> Any {
    match value {
        Value::Null => Any::Null,
        Value::Bool(b) => Any::Bool(*b),
        Value::Number(n) => Any::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => Any::String(s.as_str().into()),
        Value::Array(items) => Any::Array(items.iter().map(to_any).collect()),
        Value::Object(map) => Any::Map(Arc::new(
            map.iter().map(|(k, v)| (k.clone(), to_any(v))).collect(),
        )),
    }
}

/// A yrs `Any` as JSON (object keys sorted).
pub(crate) fn any_value(value: &Any) -> Value {
    match value {
        Any::Undefined | Any::Null | Any::Buffer(_) => Value::Null,
        Any::Bool(b) => Value::Bool(*b),
        Any::Number(n) => number_value(*n),
        Any::BigInt(n) => Value::from(*n),
        Any::String(s) => Value::String(s.to_string()),
        Any::Array(items) => Value::Array(items.iter().map(any_value).collect()),
        Any::Map(map) => {
            let sorted: BTreeMap<&String, &Any> = map.iter().collect();
            Value::Object(
                sorted
                    .into_iter()
                    .map(|(k, v)| (k.clone(), any_value(v)))
                    .collect(),
            )
        }
    }
}

/// A Y.Text's runs, adjacent equal attributes merged; `None` for an embed.
pub(crate) fn runs<T: ReadTxn>(txn: &T, text: &TextRef) -> Option<Vec<Run>> {
    let mut runs = Vec::new();
    for diff in text.diff(txn, YChange::identity) {
        let Out::Any(Any::String(s)) = diff.insert else {
            return None;
        };
        let attrs = diff
            .attributes
            .map(|attrs| {
                attrs
                    .iter()
                    .filter(|(_, v)| !matches!(v, Any::Null | Any::Undefined))
                    .map(|(k, v)| (k.to_string(), any_value(v)))
                    .collect()
            })
            .unwrap_or_default();
        runs.push(Run {
            text: s.to_string(),
            attrs,
        });
    }
    Some(crate::plate_in::merge(runs))
}

/// A Y.Map or Y.Array value as JSON; `None` for a Y.Text or other type.
pub(crate) fn out_value<T: ReadTxn>(txn: &T, out: &Out) -> Option<Value> {
    Some(match out {
        Out::Any(any) => any_value(any),
        Out::YMap(map) => {
            let mut entries: Vec<(String, Out)> =
                map.iter(txn).map(|(k, v)| (k.to_string(), v)).collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            let mut object = Map::new();
            for (k, v) in entries {
                object.insert(k, out_value(txn, &v)?);
            }
            Value::Object(object)
        }
        Out::YArray(array) => Value::Array(
            array
                .iter(txn)
                .map(|v| out_value(txn, &v))
                .collect::<Option<_>>()?,
        ),
        _ => return None,
    })
}

pub(crate) fn yblock<T: ReadTxn>(txn: &T, blocks: &MapRef, id: &str) -> Option<MapRef> {
    match blocks.get(txn, id) {
        Some(Out::YMap(map)) => Some(map),
        _ => None,
    }
}

pub(crate) fn string<T: ReadTxn>(txn: &T, map: &MapRef, key: &str) -> Option<String> {
    match map.get(txn, key) {
        Some(Out::Any(Any::String(s))) => Some(s.to_string()),
        _ => None,
    }
}

pub(crate) fn child_array<T: ReadTxn>(txn: &T, map: &MapRef) -> Option<ArrayRef> {
    match map.get(txn, "sys:children") {
        Some(Out::YArray(array)) => Some(array),
        _ => None,
    }
}

/// The child ids of a block; `None` when one is not a string.
pub(crate) fn child_ids<T: ReadTxn>(txn: &T, map: &MapRef) -> Option<Vec<String>> {
    child_array(txn, map)?
        .iter(txn)
        .map(|v| match v {
            Out::Any(Any::String(s)) => Some(s.to_string()),
            _ => None,
        })
        .collect()
}

/// The note's content blocks.
pub(crate) fn content<T: ReadTxn>(txn: &T) -> Result<Vec<Block>, ProjectionError> {
    let blocks = txn
        .get_map(BLOCKS_ROOT)
        .ok_or(ProjectionError::MissingHub("blocks"))?;
    let note = yblock(txn, &blocks, NOTE_ID).ok_or(ProjectionError::MissingHub("note"))?;
    let mut seen = HashSet::from([ROOT_ID.to_string(), NOTE_ID.to_string()]);
    let ids = child_ids(txn, &note).ok_or_else(|| ProjectionError::Block(NOTE_ID.into()))?;
    ids.iter()
        .map(|id| read(txn, &blocks, id, &mut seen, 1))
        .collect()
}

fn read<T: ReadTxn>(
    txn: &T,
    blocks: &MapRef,
    id: &str,
    seen: &mut HashSet<String>,
    depth: usize,
) -> Result<Block, ProjectionError> {
    let missing = || ProjectionError::Block(id.into());
    if depth > MAX_DEPTH {
        return Err(missing());
    }
    if !seen.insert(id.to_string()) {
        return Err(ProjectionError::Revisited(id.into()));
    }
    let map = yblock(txn, blocks, id).ok_or_else(missing)?;
    let flavour = string(txn, &map, "sys:flavour").ok_or_else(missing)?;
    let mut props = Vec::new();
    for (key, out) in map.iter(txn) {
        let Some(name) = key.strip_prefix("prop:") else {
            continue;
        };
        let bad = || ProjectionError::Prop {
            id: id.into(),
            key: name.into(),
        };
        let prop = match &out {
            Out::YText(text) => Prop::Text(runs(txn, text).ok_or_else(bad)?),
            other => Prop::Native(out_value(txn, other).ok_or_else(bad)?),
        };
        props.push((name.to_string(), prop));
    }
    props.sort_by(|a, b| a.0.cmp(&b.0));
    let children = child_ids(txn, &map)
        .ok_or_else(missing)?
        .iter()
        .map(|child| read(txn, blocks, child, seen, depth + 1))
        .collect::<Result<_, _>>()?;
    Ok(Block {
        id: id.into(),
        flavour,
        props,
        children,
    })
}

/// The `blocks` map as JSON, for the goldens: block id →
/// `{flavour, version, children, props}`, a Y.Text as its delta, a Y.Map as
/// an object (keys sorted) and a Y.Array as an array.
pub fn blocks_json<T: ReadTxn>(txn: &T) -> Value {
    let Some(blocks) = txn.get_map(BLOCKS_ROOT) else {
        return Value::Null;
    };
    let mut ids: Vec<String> = blocks.keys(txn).map(str::to_string).collect();
    ids.sort();
    let mut out = Map::new();
    for id in ids {
        let Some(map) = yblock(txn, &blocks, &id) else {
            out.insert(id, Value::Null);
            continue;
        };
        let mut props = BTreeMap::new();
        for (key, value) in map.iter(txn) {
            if let Some(name) = key.strip_prefix("prop:") {
                props.insert(name.to_string(), json_of(txn, &value));
            }
        }
        out.insert(
            id,
            json!({
                "flavour": map.get(txn, "sys:flavour").map(|v| json_of(txn, &v)),
                "version": map.get(txn, "sys:version").map(|v| json_of(txn, &v)),
                "children": map.get(txn, "sys:children").map(|v| json_of(txn, &v)),
                "props": props,
            }),
        );
    }
    Value::Object(out)
}

fn json_of<T: ReadTxn>(txn: &T, out: &Out) -> Value {
    match out {
        Out::YText(text) => {
            let delta = text
                .diff(txn, YChange::identity)
                .into_iter()
                .map(|diff| {
                    let mut op = Map::new();
                    let insert = match &diff.insert {
                        Out::Any(any) => any_value(any),
                        _ => Value::Null,
                    };
                    op.insert("insert".into(), insert);
                    if let Some(attrs) = diff.attributes.filter(|a| !a.is_empty()) {
                        let sorted: BTreeMap<String, Value> = attrs
                            .iter()
                            .map(|(k, v)| (k.to_string(), any_value(v)))
                            .collect();
                        op.insert("attributes".into(), json!(sorted));
                    }
                    Value::Object(op)
                })
                .collect();
            Value::Array(delta)
        }
        Out::YMap(map) => {
            let sorted: BTreeMap<String, Value> = map
                .iter(txn)
                .map(|(k, v)| (k.to_string(), json_of(txn, &v)))
                .collect();
            json!(sorted)
        }
        Out::YArray(array) => Value::Array(array.iter(txn).map(|v| json_of(txn, &v)).collect()),
        Out::Any(any) => any_value(any),
        _ => Value::Null,
    }
}
