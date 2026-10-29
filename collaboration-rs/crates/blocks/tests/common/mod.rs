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
    block.insert(txn, "sys:flavour", "affine:paragraph");
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

/// Whether `txn`'s `blocks` map holds a value for `id`, live or deleted.
pub fn holds_key(txn: &impl ReadTxn, id: &str) -> bool {
    let blocks = blocks_map(txn);
    let branch = yrs::branch::BranchPtr::from(blocks.as_ref() as &yrs::branch::Branch);
    branch.map_items().any(|(key, _)| key.as_ref() == id)
}

/// The id a pasted block takes (D20 with the deleted-key rule): its own
/// while no live block holds it and this document still holds its key (a
/// block cut here), else `fresh`.
pub fn paste_id(txn: &impl ReadTxn, id: &str, fresh: &str) -> String {
    let live = blocks_map(txn).get(txn, id).is_some();
    if !live && holds_key(txn, id) {
        id.to_string()
    } else {
        fresh.to_string()
    }
}

/// `item` and every item below it, as id ranges.
pub fn subtree(item: yrs::block::ItemPtr, out: &mut Vec<(yrs::ID, u32)>) {
    out.push((*item.id(), item.len()));
    if let yrs::block::ItemContent::Type(inner) = item.content() {
        let branch = yrs::branch::BranchPtr::from(inner.as_ref());
        let mut next = branch.start();
        while let Some(child) = next {
            subtree(child, out);
            next = child.right();
        }
        for (_, head) in branch.map_items() {
            let mut at = Some(head);
            while let Some(child) = at {
                subtree(child, out);
                at = child.left();
            }
        }
    }
}

/// The bytes `doc`'s encoded structs spend on the units in `ranges` (each
/// struct once: an item as it encodes, a collected run as its info byte and
/// length), and how many of them are items.
pub fn struct_bytes(doc: &yrs::Doc, ranges: &[(yrs::ID, u32)]) -> (usize, usize) {
    use yrs::updates::encoder::{Encoder, EncoderV1};
    let txn = doc.transact();
    let mut seen = std::collections::HashSet::new();
    let (mut bytes, mut items) = (0, 0);
    for (id, len) in ranges {
        for (range, item) in txn.store().blocks_in(&id.client, id.clock..id.clock + len) {
            if !seen.insert((id.client, range.clock)) {
                continue;
            }
            let mut e = EncoderV1::new();
            match item {
                Some(item) => {
                    item.encode(&mut e);
                    items += 1;
                }
                None => {
                    e.write_info(0);
                    e.write_len(range.len);
                }
            }
            bytes += e.to_vec().len();
        }
    }
    (bytes, items)
}

/// The live children `old` lists under `id` (empty when it lacks `id`).
fn listed(txn: &impl ReadTxn, id: &str) -> Vec<String> {
    let Some(Out::YMap(block)) = blocks_map(txn).get(txn, id) else {
        return Vec::new();
    };
    match block.get(txn, "sys:children") {
        Some(Out::YArray(children)) => children.iter(txn).map(|v| v.to_string(txn)).collect(),
        _ => Vec::new(),
    }
}

/// The block listing `id` in `txn` (the first in key order).
fn lister(txn: &impl ReadTxn, id: &str) -> Option<String> {
    let mut keys: Vec<String> = blocks_map(txn).keys(txn).map(str::to_string).collect();
    keys.sort();
    keys.into_iter()
        .find(|k| listed(txn, k).iter().any(|c| c == id))
}

/// One block of `old` written again under `to`'s id `fresh`, its props and
/// texts copied, with no children, listed under `parent` at `index`.
fn copy_block(
    old: &yrs::Doc,
    txn: &mut TransactionMut,
    id: &str,
    fresh: &str,
    parent: &str,
    index: u32,
) {
    use yrs::types::text::YChange;
    let source = old.transact();
    let Some(Out::YMap(from)) = blocks_map(&source).get(&source, id) else {
        panic!("the old document lacks {id}");
    };
    let block = blocks_map(txn).insert(txn, fresh, MapPrelim::default());
    for (key, value) in from.iter(&source) {
        match value {
            _ if key == "sys:children" => {
                block.insert(txn, key, ArrayPrelim::default());
            }
            Out::YText(text) => {
                let target = block.insert(txn, key, TextPrelim::new(""));
                for chunk in text.diff(&source, YChange::identity) {
                    if let Out::Any(Any::String(s)) = chunk.insert {
                        let at = target.len(txn);
                        let attrs = chunk.attributes.map(|a| *a).unwrap_or_default();
                        target.insert_with_attributes(txn, at, &s, attrs);
                    }
                }
            }
            Out::Any(any) => {
                block.insert(txn, key, any);
            }
            other => panic!("copy_block: {key} holds {other:?}"),
        }
    }
    let children = children(txn, parent);
    let index = index.min(children.len(txn));
    children.insert(txn, index, Any::from(fresh));
}

/// The re-key a tab runs after a keyed late merge (Epo 2026-10-29): each
/// reported block and its subtree written again from the tab's `old`
/// document under fresh ids (from `fresh`), the block after the nearest
/// earlier sibling the new document still lists under its parent (the
/// note when the parent is gone, first when none is), its subtree under
/// the copies in order. Returns old id → new id.
pub fn repaste(
    old: &yrs::Doc,
    txn: &mut TransactionMut,
    reports: &[late_merge::Rekey],
    fresh: &mut dyn FnMut() -> String,
) -> std::collections::HashMap<String, String> {
    let mut mapped: std::collections::HashMap<String, String> = Default::default();
    for report in reports {
        let source = old.transact();
        let parent = report
            .parent
            .as_ref()
            .map(|p| mapped.get(p).cloned().unwrap_or_else(|| p.clone()))
            .filter(|p| blocks_map(txn).get(txn, p).is_some())
            .unwrap_or_else(|| blocks::NOTE_ID.to_string());
        // The siblings before it in the old listing, nearest first.
        let before: Vec<String> = match &report.parent {
            Some(p) => {
                let siblings = listed(&source, p);
                let at = siblings.iter().position(|s| *s == report.key).unwrap_or(0);
                siblings[..at].iter().rev().cloned().collect()
            }
            None => Vec::new(),
        };
        drop(source);
        let now = listed(txn, &parent);
        let index = before
            .iter()
            .map(|s| mapped.get(s).cloned().unwrap_or_else(|| s.clone()))
            .find_map(|s| now.iter().position(|n| *n == s))
            .map_or(0, |at| at + 1);
        let id = fresh();
        copy_block(old, txn, &report.key, &id, &parent, index as u32);
        mapped.insert(report.key.clone(), id);
        for child in &report.subtree {
            let source = old.transact();
            let old_parent = lister(&source, child).expect("a subtree block is listed");
            drop(source);
            let new_parent = mapped[&old_parent].clone();
            let id = fresh();
            copy_block(old, txn, child, &id, &new_parent, u32::MAX);
            mapped.insert(child.clone(), id);
        }
    }
    mapped
}
