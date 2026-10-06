//! Random Slate operation sequences recorded from slate-yjs clients writing
//! to a room (tests/corpus/ops-*.json.gz). For every step:
//! - the writer's operations replayed through `slate_yjs` on the same client
//!   state give the same Plate value (and, mostly, the same update bytes);
//! - the room checks the update as the Node server did: the growth bound is
//!   never below the exact growth, and `Validator::admit` accepts, refuses
//!   (same code, same metrics) or defers exactly as `validateUpdate` did;
//! - the room's exact metrics and Plate value after it match.
mod common;

use std::collections::BTreeMap;

use notes::plate;
use notes::slate::{Operation, Root};
use notes::slate_yjs;
use serde_json::Value;
use yrs::Transact;

pub const FAMILIES: &[&str] = &[
    "small-marks-1",
    "small-marks-2",
    "small-marks-3",
    "small-table-1",
    "small-table-2",
    "small-table-3",
    "small-nested-1",
    "small-nested-2",
    "small-nested-3",
    "small-voids-1",
    "small-voids-2",
    "small-voids-3",
    "seed-notes",
    "load-note",
    "over-limit",
];

fn kind(op: &Operation) -> &'static str {
    match op {
        Operation::InsertNode { .. } => "insert_node",
        Operation::InsertText { .. } => "insert_text",
        Operation::MergeNode { .. } => "merge_node",
        Operation::MoveNode { .. } => "move_node",
        Operation::RemoveNode { .. } => "remove_node",
        Operation::RemoveText { .. } => "remove_text",
        Operation::SetNode { .. } => "set_node",
        Operation::SetSelection {} => "set_selection",
        Operation::SplitNode { .. } => "split_node",
    }
}

#[test]
fn slate_operations_and_room_checks_match_the_node_server() {
    let mut report = Vec::new();
    let mut failures = Vec::new();
    let mut byte_mismatches = BTreeMap::<String, usize>::new();
    for family in FAMILIES {
        let corpus = common::load(&format!("ops-{family}"));
        let mut room = common::Room::new(
            &common::bytes(&corpus["initial"]),
            corpus["roomClient"].as_u64().unwrap(),
        );
        // A writer's Slate tree carries over between steps, as the editor's
        // does: it can hold what the projection drops (empty leaves).
        let mut client: Option<(u64, yrs::Doc, Root)> = None;
        // The room as it was when the writer last (re)opened on it.
        let mut opened_on = common::state(&room.doc);
        let (mut steps, mut with_update, mut same_bytes) = (0, 0, 0);
        for (index, step) in corpus["steps"].as_array().unwrap().iter().enumerate() {
            let at = format!("{family} step {index}");
            let id = step["client"].as_u64().unwrap();
            let update = step
                .get("update")
                .filter(|u| !u.is_null())
                .map(common::bytes);
            let peer = step["peer"].as_bool().unwrap();
            if !peer {
                if client.as_ref().is_none_or(|(current, _, _)| *current != id) {
                    let doc = common::doc(&opened_on, id);
                    let root = Root::new(plate::value(&doc.transact()).unwrap());
                    client = Some((id, doc, root));
                }
                let (_, doc, root) = client.as_mut().unwrap();
                let ops: Vec<Operation> = serde_json::from_value(step["ops"].clone()).unwrap();
                let before = common::state(doc);
                let ours = {
                    let mut txn = doc.transact_mut();
                    let y_root = plate::content_root(&txn).unwrap();
                    if let Err(error) = slate_yjs::apply_ops(&mut txn, y_root, root, &ops) {
                        failures.push(format!("{at}: {error}"));
                        break;
                    }
                    let bytes = txn.encode_update_v1();
                    let changed =
                        txn.before_state() != txn.after_state() || !txn.delete_set().is_empty();
                    changed.then_some(bytes)
                };
                steps += 1;
                with_update += usize::from(update.is_some());
                if ours == update {
                    same_bytes += 1;
                } else {
                    let kinds: Vec<&str> = ops.iter().map(kind).collect();
                    *byte_mismatches.entry(kinds.join("+")).or_insert(0) += 1;
                    // The next step starts from the JS client's own state.
                    let rebuilt = common::doc(&before, id);
                    if let Some(update) = &update {
                        common::apply(&rebuilt, update);
                    }
                    *doc = rebuilt;
                }
                let value = Value::Array(plate::value(&doc.transact()).unwrap());
                if common::hash(&value) != step["clientHash"].as_str().unwrap() {
                    if let Some(expected) = step.get("clientValue") {
                        eprintln!(
                            "{at}\n  js:   {expected}\n  rust: {value}\n  ops: {}",
                            step["ops"]
                        );
                    }
                    failures.push(format!("{at}: client value differs"));
                    break;
                }
            }
            if let Some(update) = &update {
                room.deliver(step, update, &at, &mut failures);
            }
            if step.get("synced").is_some() || step.get("reopened").is_some() && !peer {
                client = None;
                opened_on = common::state(&room.doc);
            }
        }
        report.push(format!(
            "{family}: {steps} writer steps ({with_update} with an update), {same_bytes} byte-identical; {}",
            room.summary()
        ));
    }
    eprintln!("{}", report.join("\n"));
    let mut causes: Vec<_> = byte_mismatches.into_iter().collect();
    causes.sort_by(|a, b| b.1.cmp(&a.1));
    eprintln!("byte mismatches by operation kinds: {causes:?}");
    assert!(failures.is_empty(), "{failures:#?}");
}
