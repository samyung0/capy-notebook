#![allow(clippy::unwrap_used)]
//! Tombstone growth of the blocks layout against Plate's slate-yjs layout:
//! the same editing scripts on the corpus's near-limit note (`load-note`),
//! measured before and after `ydoc::gc::collect` at a window holding every
//! deletion, with nothing held. Run with `--nocapture` for the table.
//!
//! What it pins: collection keeps both layouts' value and the blocks check,
//! and a deleted block's `blocks` key stays as one tombstone per id (a map
//! value current at the window is kept, `gc.rs`), where Plate collects the
//! inside of a deleted run.

mod common;

use notes::slate::{Operation, Props, Root};
use notes::{plate, slate_yjs};
use serde_json::{Value, json};
use yrs::types::Attrs;
use yrs::updates::encoder::Encode;
use yrs::{Any, Doc, IdSet, Map, Out, ReadTxn, Text, TextRef, Transact};

const SEED: u64 = 1;
const EDITOR: u64 = 5;
const CO_EDITOR: u64 = 6;

/// What `from` holds that `to` lacks, applied to `to`.
fn sync_to(from: &Doc, to: &Doc) {
    let sv = to.transact().state_vector();
    let update = from.transact().encode_state_as_update_v1(&sv);
    common::apply(to, &update);
}

fn load_note() -> Vec<Value> {
    common::bootstrap()
        .into_iter()
        .find(|case| case["name"] == "load-note")
        .unwrap()["value"]
        .as_array()
        .unwrap()
        .clone()
}

#[derive(Debug, Clone, Copy)]
struct Stats {
    state: usize,
    deleted_items: usize,
    delete_set: usize,
}

fn stats(doc: &Doc) -> Stats {
    let txn = doc.transact();
    let mut deleted_items = 0;
    for (client, clock) in txn.state_vector().iter() {
        for (_, item) in txn.store().blocks_in(client, 0..*clock) {
            if item.is_some_and(|item| item.is_deleted()) {
                deleted_items += 1;
            }
        }
    }
    Stats {
        state: txn
            .encode_state_as_update_v1(&yrs::StateVector::default())
            .len(),
        deleted_items,
        delete_set: txn.snapshot().delete_set.encode_v1().len(),
    }
}

/// `doc` collected at a window of itself (every deletion dead, none held),
/// loaded into a fresh document.
fn collected(doc: &Doc) -> Doc {
    let window = ydoc::gc::Window::of(&doc.transact(), 1);
    let state = ydoc::gc::collect(doc, &window, &IdSet::new(), None).state;
    // GC_STATE_DUMP=<file>: one line per collected state (length and hash),
    // to compare a collection change's output byte for byte.
    if let Ok(path) = std::env::var("GC_STATE_DUMP") {
        use std::hash::{Hash, Hasher};
        use std::io::Write as _;
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        state.hash(&mut hasher);
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(file, "{} {:016x}", state.len(), hasher.finish()).unwrap();
    }
    let fresh = common::doc(&state, 99);
    assert!(!ydoc::has_pending(&fresh.transact()));
    fresh
}

/* ------------------------------------------------------------- blocks side */

fn yblock(txn: &impl ReadTxn, id: &str) -> yrs::MapRef {
    match common::blocks_map(txn).get(txn, id) {
        Some(Out::YMap(block)) => block,
        _ => panic!("no block {id}"),
    }
}

fn ytext(txn: &impl ReadTxn, id: &str, key: &str) -> TextRef {
    match yblock(txn, id).get(txn, key) {
        Some(Out::YText(text)) => text,
        _ => panic!("no {key} on {id}"),
    }
}

/* -------------------------------------------------------------- Plate side */

struct Plate {
    doc: Doc,
    root: Root,
}

impl Plate {
    fn apply(&mut self, ops: &[Operation]) {
        let mut txn = self.doc.transact_mut();
        let y_root = plate::content_root(&txn).unwrap();
        slate_yjs::apply_ops(&mut txn, y_root, &mut self.root, ops).unwrap();
    }
}

fn props(value: Value) -> Props {
    value.as_object().unwrap().clone()
}

/* ----------------------------------------------------------------- scripts */

/// Top-level paragraphs of one plain ASCII leaf at least `min` long, by
/// index.
fn plain_paragraphs(value: &[Value], min: usize) -> Vec<usize> {
    value
        .iter()
        .enumerate()
        .filter(|(_, node)| {
            node["type"] == "p"
                && node["children"].as_array().is_some_and(|c| {
                    c.len() == 1
                        && c[0].as_object().is_some_and(|leaf| leaf.len() == 1)
                        && c[0]["text"]
                            .as_str()
                            .is_some_and(|t| t.is_ascii() && t.len() >= min)
                })
        })
        .map(|(i, _)| i)
        .collect()
}

fn id_at(value: &[Value], i: usize) -> String {
    value[i]["id"].as_str().unwrap().to_string()
}

fn leaf_text(value: &[Value], i: usize) -> String {
    value[i]["children"][0]["text"]
        .as_str()
        .unwrap()
        .to_string()
}

#[derive(Clone, Copy, Debug)]
enum Script {
    Typing,
    DeleteText,
    TwoWritersThenDelete,
    TextChurn,
    BlockChurn,
    DeleteBlocks,
    MoveBlocks,
    RetypeCell,
    ToggleMarks,
    Paste150,
    AgentSwap,
}

const SCRIPTS: [Script; 11] = [
    Script::Typing,
    Script::DeleteText,
    Script::TwoWritersThenDelete,
    Script::TextChurn,
    Script::BlockChurn,
    Script::DeleteBlocks,
    Script::MoveBlocks,
    Script::RetypeCell,
    Script::ToggleMarks,
    Script::Paste150,
    Script::AgentSwap,
];

const TYPED: usize = 500;
const CHURN: usize = 1000;

/// xorshift64, the same draws for both layouts.
struct Rng(u64);

impl Rng {
    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % n.max(1) as u64) as usize
    }
}

/// A churn step: insert `text` at `at`, or delete `len` units at `at`.
enum Step {
    Insert(usize, String),
    Delete(usize, usize),
}

/// Two writers taking turns at random spots of one text, words in and
/// ranges out, holding it near its start length.
fn text_churn(len: usize, rng: &mut Rng) -> Step {
    if len > 60 && rng.below(2) == 0 {
        let at = rng.below(len - 10);
        Step::Delete(at, 1 + rng.below(8))
    } else {
        Step::Insert(rng.below(len + 1), format!("w{} ", rng.below(100)))
    }
}

/// Block churn round `k`: a paragraph `churn_k` goes in at a random spot of a
/// 40-block stretch, and `churn_{k-3}` goes out.
const CHURN_ROUNDS: usize = 300;

const BLOCKS: usize = 100;
const CELL_ROUNDS: usize = 20;
const MARK_ROUNDS: usize = 20;
const SWAPS: usize = 50;

fn run_blocks(script: Script, value: &[Value], doc: &Doc) {
    let middle = value.len() / 2;
    let plain = plain_paragraphs(value, 40);
    match script {
        Script::Typing => {
            let id = id_at(value, plain[plain.len() / 2]);
            for _ in 0..TYPED {
                let mut txn = doc.transact_mut();
                let text = ytext(&txn, &id, "prop:text");
                let at = text.len(&txn);
                text.insert(&mut txn, at, "x");
            }
        }
        Script::TwoWritersThenDelete => {
            // Two writers take turns typing at one spot, so each unit is its
            // own item, then the editor deletes what they typed.
            let id = id_at(value, plain[plain.len() / 2]);
            let start = leaf_text(value, plain[plain.len() / 2]).len() as u32;
            let other = common::doc(&common::state(doc), CO_EDITOR);
            for k in 0..TYPED {
                let (writer, reader) = if k % 2 == 0 {
                    (doc, &other)
                } else {
                    (&other, doc)
                };
                let mut txn = writer.transact_mut();
                let text = ytext(&txn, &id, "prop:text");
                text.insert(&mut txn, start + k as u32, "x");
                drop(txn);
                sync_to(writer, reader);
            }
            let mut txn = doc.transact_mut();
            ytext(&txn, &id, "prop:text").remove_range(&mut txn, start, TYPED as u32);
        }
        Script::TextChurn => {
            let id = id_at(value, plain[plain.len() / 2]);
            let other = common::doc(&common::state(doc), CO_EDITOR);
            let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
            for k in 0..CHURN {
                let (writer, reader) = if k % 2 == 0 {
                    (doc, &other)
                } else {
                    (&other, doc)
                };
                let mut txn = writer.transact_mut();
                let text = ytext(&txn, &id, "prop:text");
                match text_churn(text.len(&txn) as usize, &mut rng) {
                    Step::Insert(at, s) => text.insert(&mut txn, at as u32, &s),
                    Step::Delete(at, n) => text.remove_range(&mut txn, at as u32, n as u32),
                }
                drop(txn);
                sync_to(writer, reader);
            }
        }
        Script::BlockChurn => {
            let other = common::doc(&common::state(doc), CO_EDITOR);
            let mut rng = Rng(0x2545_f491_4f6c_dd1d);
            for k in 0..CHURN_ROUNDS {
                let (writer, reader) = if k % 2 == 0 {
                    (doc, &other)
                } else {
                    (&other, doc)
                };
                let at = middle + rng.below(40);
                let mut txn = writer.transact_mut();
                common::add_paragraph(
                    &mut txn,
                    &format!("churn_{k}"),
                    &format!("Churn {k}"),
                    blocks::NOTE_ID,
                    at as u32,
                );
                if k >= 3 {
                    common::delete_block(&mut txn, &format!("churn_{}", k - 3));
                }
                drop(txn);
                sync_to(writer, reader);
            }
        }
        Script::DeleteText => {
            let mut left = TYPED;
            for &i in &plain {
                let id = id_at(value, i);
                let mut len = leaf_text(value, i).len();
                while len > 0 && left > 0 {
                    let mut txn = doc.transact_mut();
                    ytext(&txn, &id, "prop:text").remove_range(&mut txn, len as u32 - 1, 1);
                    len -= 1;
                    left -= 1;
                }
                if left == 0 {
                    break;
                }
            }
        }
        Script::DeleteBlocks => {
            // A selection of consecutive blocks deleted one by one.
            for i in middle..middle + BLOCKS {
                common::delete_block(&mut doc.transact_mut(), &id_at(value, i));
            }
        }
        Script::MoveBlocks => {
            for k in 0..BLOCKS {
                let id = id_at(value, plain[k * 3]);
                let to = (middle + k * 7) as u32;
                common::move_block(&mut doc.transact_mut(), &id, blocks::NOTE_ID, to);
            }
        }
        Script::RetypeCell => {
            let table = value.iter().find(|n| n["type"] == "table").unwrap();
            let table_id = table["id"].as_str().unwrap();
            let row = table["children"][1]["id"].as_str().unwrap();
            let key = format!("prop:cells.{row}:{table_id}-c0.text");
            for round in 0..CELL_ROUNDS {
                let mut txn = doc.transact_mut();
                let text = ytext(&txn, table_id, &key);
                let len = text.len(&txn);
                text.remove_range(&mut txn, 0, len);
                text.insert(&mut txn, 0, &format!("Glycolysis round {round}"));
            }
        }
        Script::ToggleMarks => {
            let id = id_at(value, plain[plain.len() / 2]);
            for _ in 0..MARK_ROUNDS {
                for on in [Any::Bool(true), Any::Null] {
                    let mut txn = doc.transact_mut();
                    let text = ytext(&txn, &id, "prop:text");
                    let attrs = Attrs::from([("bold".into(), on)]);
                    text.format(&mut txn, 10, 20, attrs);
                }
            }
        }
        Script::Paste150 => {
            let mut txn = doc.transact_mut();
            for k in 0..150 {
                common::add_paragraph(
                    &mut txn,
                    &format!("paste_{k:03}"),
                    &format!("Pasted paragraph {k} with some ordinary sentence text."),
                    blocks::NOTE_ID,
                    (middle + k) as u32,
                );
            }
        }
        Script::AgentSwap => {
            for &i in &plain[..SWAPS] {
                let id = id_at(value, i);
                let mut txn = doc.transact_mut();
                let at = common::child_ids(&txn, blocks::NOTE_ID)
                    .iter()
                    .position(|c| *c == id)
                    .unwrap();
                common::delete_block(&mut txn, &id);
                let text = format!("{} (edited)", leaf_text(value, i));
                common::add_paragraph(
                    &mut txn,
                    &format!("{id}_v2"),
                    &text,
                    blocks::NOTE_ID,
                    at as u32,
                );
            }
        }
    }
}

fn run_plate(script: Script, value: &[Value], plate: &mut Plate) {
    let middle = value.len() / 2;
    let plain = plain_paragraphs(value, 40);
    let leaf = |i: usize| vec![i, 0];
    match script {
        Script::Typing => {
            let i = plain[plain.len() / 2];
            let start = leaf_text(value, i).len();
            for offset in start..start + TYPED {
                plate.apply(&[Operation::InsertText {
                    path: leaf(i),
                    offset,
                    text: "x".into(),
                }]);
            }
        }
        Script::TwoWritersThenDelete => {
            let i = plain[plain.len() / 2];
            let start = leaf_text(value, i).len();
            let mut other = Plate {
                doc: common::doc(&common::state(&plate.doc), CO_EDITOR),
                root: Root::new(plate.root.children.clone()),
            };
            for k in 0..TYPED {
                let op = Operation::InsertText {
                    path: leaf(i),
                    offset: start + k,
                    text: "x".into(),
                };
                let (writer, reader) = if k % 2 == 0 {
                    (&mut *plate, &mut other)
                } else {
                    (&mut other, &mut *plate)
                };
                writer.apply(std::slice::from_ref(&op));
                sync_to(&writer.doc, &reader.doc);
                reader.root.apply(&op).unwrap();
            }
            plate.apply(&[Operation::RemoveText {
                path: leaf(i),
                offset: start,
                text: "x".repeat(TYPED),
            }]);
        }
        Script::TextChurn => {
            let i = plain[plain.len() / 2];
            let mut other = Plate {
                doc: common::doc(&common::state(&plate.doc), CO_EDITOR),
                root: Root::new(plate.root.children.clone()),
            };
            let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
            for k in 0..CHURN {
                let current = plate.root.get(&leaf(i)).unwrap()["text"]
                    .as_str()
                    .unwrap()
                    .to_string();
                let op = match text_churn(current.len(), &mut rng) {
                    Step::Insert(at, text) => Operation::InsertText {
                        path: leaf(i),
                        offset: at,
                        text,
                    },
                    Step::Delete(at, n) => Operation::RemoveText {
                        path: leaf(i),
                        offset: at,
                        text: current[at..(at + n).min(current.len())].into(),
                    },
                };
                let (writer, reader) = if k % 2 == 0 {
                    (&mut *plate, &mut other)
                } else {
                    (&mut other, &mut *plate)
                };
                writer.apply(std::slice::from_ref(&op));
                sync_to(&writer.doc, &reader.doc);
                reader.root.apply(&op).unwrap();
            }
        }
        Script::BlockChurn => {
            let mut other = Plate {
                doc: common::doc(&common::state(&plate.doc), CO_EDITOR),
                root: Root::new(plate.root.children.clone()),
            };
            let mut rng = Rng(0x2545_f491_4f6c_dd1d);
            for k in 0..CHURN_ROUNDS {
                let at = middle + rng.below(40);
                let mut ops = vec![Operation::InsertNode {
                    path: vec![at],
                    node: json!({
                        "type": "p",
                        "id": format!("churn_{k}"),
                        "children": [{"text": format!("Churn {k}")}],
                    }),
                }];
                if k >= 3 {
                    let mut after = plate.root.clone();
                    after.apply(&ops[0]).unwrap();
                    let gone = format!("churn_{}", k - 3);
                    let q = after
                        .children
                        .iter()
                        .position(|n| n["id"] == gone.as_str())
                        .unwrap();
                    ops.push(Operation::RemoveNode {
                        path: vec![q],
                        node: after.children[q].clone(),
                    });
                }
                let (writer, reader) = if k % 2 == 0 {
                    (&mut *plate, &mut other)
                } else {
                    (&mut other, &mut *plate)
                };
                writer.apply(&ops);
                sync_to(&writer.doc, &reader.doc);
                for op in &ops {
                    reader.root.apply(op).unwrap();
                }
            }
        }
        Script::DeleteText => {
            let mut left = TYPED;
            for &i in &plain {
                let text = leaf_text(value, i);
                let mut len = text.len();
                while len > 0 && left > 0 {
                    plate.apply(&[Operation::RemoveText {
                        path: leaf(i),
                        offset: len - 1,
                        text: text[len - 1..len].into(),
                    }]);
                    len -= 1;
                    left -= 1;
                }
                if left == 0 {
                    break;
                }
            }
        }
        Script::DeleteBlocks => {
            for _ in 0..BLOCKS {
                let i = middle;
                let node = plate.root.get(&[i]).unwrap().clone();
                plate.apply(&[Operation::RemoveNode {
                    path: vec![i],
                    node,
                }]);
            }
        }
        Script::MoveBlocks => {
            for k in 0..BLOCKS {
                let id = id_at(value, plain[k * 3]);
                let from = plate
                    .root
                    .children
                    .iter()
                    .position(|n| n["id"] == id.as_str())
                    .unwrap();
                plate.apply(&[Operation::MoveNode {
                    path: vec![from],
                    new_path: vec![middle + k * 7],
                }]);
            }
        }
        Script::RetypeCell => {
            let t = value.iter().position(|n| n["type"] == "table").unwrap();
            let path = vec![t, 1, 0, 0, 0];
            for round in 0..CELL_ROUNDS {
                let old = plate.root.get(&path).unwrap()["text"]
                    .as_str()
                    .unwrap()
                    .to_string();
                plate.apply(&[
                    Operation::RemoveText {
                        path: path.clone(),
                        offset: 0,
                        text: old,
                    },
                    Operation::InsertText {
                        path: path.clone(),
                        offset: 0,
                        text: format!("Glycolysis round {round}"),
                    },
                ]);
            }
        }
        Script::ToggleMarks => {
            // Editor.addMark / removeMark on [10, 30): split, set, then the
            // normalizer's merges.
            let i = plain[plain.len() / 2];
            for _ in 0..MARK_ROUNDS {
                plate.apply(&[
                    Operation::SplitNode {
                        path: leaf(i),
                        position: 30,
                        properties: Props::new(),
                    },
                    Operation::SplitNode {
                        path: leaf(i),
                        position: 10,
                        properties: Props::new(),
                    },
                    Operation::SetNode {
                        path: vec![i, 1],
                        properties: Props::new(),
                        new_properties: props(json!({"bold": true})),
                    },
                ]);
                plate.apply(&[
                    Operation::SetNode {
                        path: vec![i, 1],
                        properties: props(json!({"bold": true})),
                        new_properties: props(json!({"bold": null})),
                    },
                    Operation::MergeNode {
                        path: vec![i, 1],
                        position: 10,
                        properties: Props::new(),
                    },
                    Operation::MergeNode {
                        path: vec![i, 1],
                        position: 30,
                        properties: Props::new(),
                    },
                ]);
            }
        }
        Script::Paste150 => {
            let ops: Vec<Operation> = (0..150)
                .map(|k| Operation::InsertNode {
                    path: vec![middle + k],
                    node: json!({
                        "type": "p",
                        "id": format!("paste_{k:03}"),
                        "children": [{"text": format!("Pasted paragraph {k} with some ordinary sentence text.")}],
                    }),
                })
                .collect();
            plate.apply(&ops);
        }
        Script::AgentSwap => {
            for &i in &plain[..SWAPS] {
                let id = id_at(value, i);
                let node = plate.root.get(&[i]).unwrap().clone();
                plate.apply(&[
                    Operation::RemoveNode {
                        path: vec![i],
                        node,
                    },
                    Operation::InsertNode {
                        path: vec![i],
                        node: json!({
                            "type": "p",
                            "id": format!("{id}_v2"),
                            "children": [{"text": format!("{} (edited)", leaf_text(value, i))}],
                        }),
                    },
                ]);
            }
        }
    }
}

struct Row {
    script: Script,
    layout: &'static str,
    seed: Stats,
    before: Stats,
    after: Stats,
    /// Collected with the deleted-key rule (blocks only).
    keyed: Option<Stats>,
}

#[test]
fn tombstone_growth_blocks_against_plate_on_the_near_limit_note() {
    let value = load_note();
    let blocks_seed = blocks::state_from_value(&value, SEED).unwrap();
    let plate_seed = slate_yjs::state_from_value(&value, SEED);
    let mut rows = Vec::new();
    for script in SCRIPTS {
        // Blocks.
        let doc = common::doc(&blocks_seed, EDITOR);
        let seed = stats(&doc);
        run_blocks(script, &value, &doc);
        blocks::check(&doc.transact()).unwrap();
        let before = stats(&doc);
        let after_doc = collected(&doc);
        blocks::check(&after_doc.transact()).unwrap();
        assert_eq!(
            blocks::value(&after_doc.transact()).unwrap(),
            blocks::value(&doc.transact()).unwrap(),
            "{script:?}: blocks value after collection"
        );
        let after = stats(&after_doc);
        if let Script::DeleteBlocks | Script::AgentSwap = script {
            // One kept `blocks` key per deleted block, whatever else went.
            let gone = if let Script::DeleteBlocks = script {
                BLOCKS
            } else {
                SWAPS
            };
            assert!(after.deleted_items >= gone, "{script:?}: {after:?}");
        }
        // With the deleted-key rule: a deleted block's `blocks` key goes too.
        let keyed = {
            let window = ydoc::gc::Window::of(&doc.transact(), 1);
            let unique: Option<ydoc::gc::UniqueKeys> = Some(&blocks::unique_key);
            let state = ydoc::gc::collect_with(&doc, &window, &IdSet::new(), None, unique).state;
            let keyed = common::doc(&state, 98);
            assert!(!ydoc::has_pending(&keyed.transact()));
            blocks::check(&keyed.transact()).unwrap();
            assert_eq!(
                blocks::value(&keyed.transact()).unwrap(),
                blocks::value(&doc.transact()).unwrap()
            );
            stats(&keyed)
        };
        rows.push(Row {
            script,
            layout: "blocks",
            seed,
            before,
            after,
            keyed: Some(keyed),
        });

        // Plate.
        let doc = common::doc(&plate_seed, EDITOR);
        let root = Root::new(plate::value(&doc.transact()).unwrap());
        let mut note = Plate { doc, root };
        let seed = stats(&note.doc);
        run_plate(script, &value, &mut note);
        let before = stats(&note.doc);
        let after_doc = collected(&note.doc);
        assert_eq!(
            plate::value(&after_doc.transact()).unwrap(),
            plate::value(&note.doc.transact()).unwrap(),
            "{script:?}: plate value after collection"
        );
        rows.push(Row {
            script,
            layout: "plate",
            seed,
            before,
            after: stats(&after_doc),
            keyed: None,
        });
    }
    println!(
        "| script | layout | state seed | state edited (+growth) | state collected (+growth) | deleted items edited / collected | delete set bytes edited / collected | with the key rule: collected (+growth), deleted items |"
    );
    println!("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for row in &rows {
        println!(
            "| {:?} | {} | {} | {} (+{}) | {} (+{}) | {} / {} | {} / {} | {} |",
            row.script,
            row.layout,
            row.seed.state,
            row.before.state,
            row.before.state as i64 - row.seed.state as i64,
            row.after.state,
            row.after.state as i64 - row.seed.state as i64,
            row.before.deleted_items,
            row.after.deleted_items,
            row.before.delete_set,
            row.after.delete_set,
            row.keyed.map_or("-".to_string(), |k| format!(
                "{} (+{}), {}",
                k.state,
                k.state as i64 - row.seed.state as i64,
                k.deleted_items
            )),
        );
    }
}
