#![allow(clippy::unwrap_used)] // Tests panic on a broken fixture.
#![allow(dead_code)]
//! Shared fixtures: the notes crate's bootstrap corpus, the Go fixtures and
//! documents built from seeds.

use std::io::Read;
use std::path::PathBuf;

use serde_json::Value;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Array, ArrayPrelim, ArrayRef, GetString, Map, MapPrelim, MapRef, Out, ReadTxn, Text,
    TextPrelim, TextRef, Transact, TransactionMut,
};

pub fn repo(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(path)
}

/// `notes/tests/corpus/bootstrap.json.gz`: `[{name, state, value}]`.
pub fn bootstrap() -> Vec<Value> {
    let path = repo("collaboration-rs/crates/notes/tests/corpus/bootstrap.json.gz");
    let mut text = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(path).unwrap())
        .read_to_string(&mut text)
        .unwrap();
    serde_json::from_str::<Value>(&text)
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

/// `every-block-note.json`'s value.
pub fn every_block_note() -> Vec<Value> {
    let path = repo("server/internal/materialdoc/testdata/every-block-note.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    doc["value"].as_array().unwrap().clone()
}

/// A document holding `state`.
pub fn doc(state: &[u8], client: u64) -> yrs::Doc {
    let doc = yrs::Doc::with_options(ydoc::doc_options(client));
    apply(&doc, state);
    doc
}

pub fn apply(doc: &yrs::Doc, update: &[u8]) {
    doc.transact_mut()
        .apply_update(yrs::Update::decode_v1(update).unwrap())
        .unwrap();
}

pub fn state(doc: &yrs::Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&yrs::StateVector::default())
}

/// `value(state_from_value(value))`.
pub fn round_trip(value: &[Value]) -> Vec<Value> {
    let state = blocks::state_from_value(value, 7).unwrap();
    let doc = doc(&state, 99);
    let txn = doc.transact();
    blocks::value(&txn).unwrap()
}

/// The first top-level index where two values differ, with both nodes.
pub fn first_difference(left: &[Value], right: &[Value]) -> Option<String> {
    let len = left.len().max(right.len());
    (0..len).find_map(|i| {
        let (a, b) = (left.get(i), right.get(i));
        (a != b).then(|| {
            format!(
                "block {i}:\n  left  {}\n  right {}",
                a.map_or("none".into(), Value::to_string),
                b.map_or("none".into(), Value::to_string)
            )
        })
    })
}

pub fn blocks_map(txn: &impl ReadTxn) -> MapRef {
    txn.get_map(blocks::BLOCKS_ROOT).unwrap()
}

pub fn children(txn: &impl ReadTxn, id: &str) -> ArrayRef {
    let Some(Out::YMap(block)) = blocks_map(txn).get(txn, id) else {
        panic!("no block {id}");
    };
    let Some(Out::YArray(children)) = block.get(txn, "sys:children") else {
        panic!("no children on {id}");
    };
    children
}

pub fn child_ids(txn: &impl ReadTxn, id: &str) -> Vec<String> {
    children(txn, id)
        .iter(txn)
        .map(|v| v.to_string(txn))
        .collect()
}

/// The parent listing `id`, if any (the first one).
pub fn parent_of(txn: &impl ReadTxn, id: &str) -> Option<String> {
    let blocks = blocks_map(txn);
    let mut keys: Vec<String> = blocks.keys(txn).map(str::to_string).collect();
    keys.sort();
    keys.into_iter()
        .find(|p| child_ids(txn, p).iter().any(|c| c == id))
}

/// BlockSuite's move: out of its parent's children, into `to`'s at `index`.
pub fn move_block(txn: &mut TransactionMut, id: &str, to: &str, index: u32) {
    if let Some(from) = parent_of(txn, id) {
        let at = child_ids(txn, &from).iter().position(|c| c == id).unwrap();
        children(txn, &from).remove(txn, at as u32);
    }
    let target = children(txn, to);
    let index = index.min(target.len(txn));
    target.insert(txn, index, Any::from(id));
}

/// BlockSuite's delete: out of its parent, then it and its subtree from the
/// map.
pub fn delete_block(txn: &mut TransactionMut, id: &str) {
    if let Some(from) = parent_of(txn, id) {
        let at = child_ids(txn, &from).iter().position(|c| c == id).unwrap();
        children(txn, &from).remove(txn, at as u32);
    }
    let mut stack = vec![id.to_string()];
    while let Some(id) = stack.pop() {
        if blocks_map(txn).get(txn, &id).is_some() {
            stack.extend(child_ids(txn, &id));
            blocks_map(txn).remove(txn, &id);
        }
    }
}

/// Exchanges full states between every pair of docs.
pub fn sync(docs: &[yrs::Doc]) {
    let states: Vec<Vec<u8>> = docs.iter().map(state).collect();
    for doc in docs {
        for other in &states {
            apply(doc, other);
        }
    }
}

/// A paragraph as BlockSuite's `addBlock` writes it, listed under `parent`
/// at `index`.
pub fn add_paragraph(txn: &mut TransactionMut, id: &str, text: &str, parent: &str, index: u32) {
    let block = blocks_map(txn).insert(txn, id, MapPrelim::default());
    block.insert(txn, "sys:id", id);
    block.insert(txn, "sys:flavour", "affine:paragraph");
    block.insert(txn, "sys:version", Any::Number(1.0));
    block.insert(txn, "sys:children", ArrayPrelim::default());
    block.insert(txn, "prop:type", "text");
    block.insert(txn, "prop:collapsed", false);
    let y = block.insert(txn, "prop:text", TextPrelim::new(""));
    y.insert(txn, 0, text);
    let children = children(txn, parent);
    let index = index.min(children.len(txn));
    children.insert(txn, index, Any::from(id));
}

/// Block `id`'s `prop:text`.
pub fn text(txn: &impl ReadTxn, id: &str) -> TextRef {
    let Some(Out::YMap(block)) = blocks_map(txn).get(txn, id) else {
        panic!("no block {id}");
    };
    let Some(Out::YText(text)) = block.get(txn, "prop:text") else {
        panic!("no text on {id}");
    };
    text
}

pub fn text_of(txn: &impl ReadTxn, id: &str) -> String {
    text(txn, id).get_string(txn)
}
