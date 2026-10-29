#![allow(clippy::unwrap_used, clippy::print_stdout)]
//! What deleted blocks and table rows cost after a collection, with and
//! without the deleted-key rule (`blocks::unique_key`), on the near-limit
//! note (`load-note`): bytes the encoded state spends on them, room memory
//! (the collected state loaded), and the collection's CPU; and the cheap
//! alternative, shorter block ids, at 10 and 36 characters. Plate for
//! reference. Run with `--nocapture` (release) for the numbers.

mod common;

use std::alloc::System;
use std::time::Instant;

use notes::slate::{Operation, Root};
use notes::{plate, slate_yjs};
use serde_json::{Value, json};
use stats_alloc::{INSTRUMENTED_SYSTEM, Region, StatsAlloc};
use ydoc::gc::{Window, collect_with};
use yrs::block::{ItemContent, ItemPtr};
use yrs::branch::BranchPtr;
use yrs::updates::encoder::Encode;
use yrs::{Array, Doc, ID, IdSet, Map, Out, ReadTxn, Transact};

#[global_allocator]
static GLOBAL: &StatsAlloc<System> = &INSTRUMENTED_SYSTEM;

const DELETES: usize = 1000;

fn load_note() -> Vec<Value> {
    common::bootstrap()
        .into_iter()
        .find(|case| case["name"] == "load-note")
        .unwrap()["value"]
        .as_array()
        .unwrap()
        .clone()
}

/// Every element id in `value` replaced by a unique one `len` long.
fn renamed(value: &[Value], len: usize) -> Vec<Value> {
    fn walk(node: &mut Value, len: usize, next: &mut u64) {
        if let Value::Object(map) = node {
            if map.get("id").is_some_and(Value::is_string) {
                *next += 1;
                let id = if len >= 36 {
                    format!("{:08x}-0000-4000-8000-{:012x}", next, next)
                } else {
                    format!("k{:0width$}", next, width = len - 1)
                };
                map.insert("id".into(), Value::String(id));
            }
            if let Some(Value::Array(children)) = map.get_mut("children") {
                for child in children {
                    walk(child, len, next);
                }
            }
        }
    }
    let mut out = value.to_vec();
    let mut next = 0;
    for node in &mut out {
        walk(node, len, &mut next);
    }
    out
}

/// Top-level paragraphs to delete: every third from index 10, so each
/// deleted block sits between live ones.
fn targets(value: &[Value]) -> Vec<usize> {
    (10..value.len())
        .step_by(3)
        .filter(|&i| value[i]["type"] == "p")
        .take(DELETES)
        .collect()
}

fn collect(doc: &Doc, keyed: bool) -> (Vec<u8>, f64) {
    let window = Window::of(&doc.transact(), 1);
    let unique: Option<ydoc::gc::UniqueKeys> = keyed.then_some(&blocks::unique_key);
    let mut times = Vec::new();
    let mut state = Vec::new();
    for _ in 0..5 {
        let at = Instant::now();
        state = collect_with(doc, &window, &IdSet::new(), None, unique).state;
        times.push(at.elapsed().as_secs_f64() * 1e3);
    }
    times.sort_by(f64::total_cmp);
    (state, times[2])
}

/// The bytes a loaded `state` keeps allocated.
fn memory(state: &[u8]) -> (Doc, isize) {
    let region = Region::new(GLOBAL);
    let doc = common::doc(state, 99);
    let change = region.change();
    (
        doc,
        change.bytes_allocated as isize - change.bytes_deallocated as isize,
    )
}

struct Row {
    what: String,
    state: usize,
    delete_set: usize,
    per_unit_bytes: f64,
    per_unit_items: f64,
    memory: isize,
    base_memory: isize,
    collect_ms: f64,
}

fn print(rows: &[Row]) {
    println!(
        "| case | collected state | delete set | bytes per deleted unit | items kept per unit | room memory after (base: nothing deleted) | collect (median of 5) |"
    );
    println!("| --- | --- | --- | --- | --- | --- | --- |");
    for r in rows {
        println!(
            "| {} | {} | {} | {:.1} | {:.2} | {} B ({} B) | {:.1} ms |",
            r.what,
            r.state,
            r.delete_set,
            r.per_unit_bytes,
            r.per_unit_items,
            r.memory,
            r.base_memory,
            r.collect_ms
        );
    }
}

fn delete_set_len(doc: &Doc) -> usize {
    doc.transact().snapshot().delete_set.encode_v1().len()
}

/// The blocks layout: `DELETES` blocks deleted one by one and collected.
fn blocks_run(value: &[Value], keyed: bool, label: &str) -> Row {
    let seed = blocks::state_from_value(value, 1).unwrap();
    // Memory of the collected state with nothing deleted.
    let base = {
        let doc = common::doc(&seed, 5);
        memory(&collect(&doc, keyed).0).1
    };
    let doc = common::doc(&seed, 5);
    let ids: Vec<String> = targets(value)
        .into_iter()
        .map(|i| value[i]["id"].as_str().unwrap().to_string())
        .collect();
    let mut ranges: Vec<(ID, u32)> = Vec::new();
    {
        let txn = doc.transact();
        let children = common::children(&txn, blocks::NOTE_ID);
        let mut listed = std::collections::HashMap::new();
        let mut next = BranchPtr::from(children.as_ref() as &yrs::branch::Branch).start();
        while let Some(item) = next {
            if let ItemContent::Any(values) = item.content() {
                for (at, v) in values.iter().enumerate() {
                    listed.insert(
                        v.to_string(),
                        ID::new(item.id().client, item.id().clock + at as u32),
                    );
                }
            }
            next = item.right();
        }
        for id in &ids {
            let Some(Out::YMap(block)) = common::blocks_map(&txn).get(&txn, id) else {
                panic!("no {id}");
            };
            common::subtree(block.as_ref().item().unwrap(), &mut ranges);
            ranges.push((listed[id], 1));
        }
    }
    for id in &ids {
        let mut txn = doc.transact_mut();
        let note = common::children(&txn, blocks::NOTE_ID);
        let at = note
            .iter(&txn)
            .position(|v| v.to_string(&txn) == *id)
            .unwrap();
        note.remove(&mut txn, at as u32);
        common::blocks_map(&txn).remove(&mut txn, id);
    }
    let (state, ms) = collect(&doc, keyed);
    let (loaded, mem) = memory(&state);
    blocks::check(&loaded.transact()).unwrap();
    let (bytes, items) = common::struct_bytes(&loaded, &ranges);
    let n = ids.len() as f64;
    Row {
        what: label.into(),
        state: state.len(),
        delete_set: delete_set_len(&loaded),
        per_unit_bytes: bytes as f64 / n,
        per_unit_items: items as f64 / n,
        memory: mem,
        base_memory: base,
        collect_ms: ms,
    }
}

/// Plate: the same blocks removed and collected.
fn plate_run(value: &[Value]) -> Row {
    let seed = slate_yjs::state_from_value(value, 1);
    let base = {
        let doc = common::doc(&seed, 5);
        memory(&collect(&doc, false).0).1
    };
    let doc = common::doc(&seed, 5);
    let targets = targets(value);
    let mut ranges: Vec<(ID, u32)> = Vec::new();
    {
        let txn = doc.transact();
        let root = plate::content_root(&txn).unwrap();
        let mut embeds: Vec<ItemPtr> = Vec::new();
        let mut next = root.start();
        while let Some(item) = next {
            if matches!(item.content(), ItemContent::Type(_)) && !item.is_deleted() {
                embeds.push(item);
            }
            next = item.right();
        }
        for &i in &targets {
            common::subtree(embeds[i], &mut ranges);
        }
    }
    let mut root = Root::new(plate::value(&doc.transact()).unwrap());
    for &i in targets.iter().rev() {
        let mut txn = doc.transact_mut();
        let y_root = plate::content_root(&txn).unwrap();
        let node = root.children[i].clone();
        let op = Operation::RemoveNode {
            path: vec![i],
            node,
        };
        slate_yjs::apply_ops(&mut txn, y_root, &mut root, &[op]).unwrap();
    }
    let (state, ms) = collect(&doc, false);
    let (loaded, mem) = memory(&state);
    let (bytes, items) = common::struct_bytes(&loaded, &ranges);
    let n = targets.len() as f64;
    Row {
        what: "plate, corpus ids (17 chars)".into(),
        state: state.len(),
        delete_set: delete_set_len(&loaded),
        per_unit_bytes: bytes as f64 / n,
        per_unit_items: items as f64 / n,
        memory: mem,
        base_memory: base,
        collect_ms: ms,
    }
}

/// A table of 60 rows by 3 columns; 50 rows deleted as BlockSuite's
/// `deleteRow` does (every `rows.<id>.*` and `cells.<id>:*` key), each in
/// its own transaction.
fn table_rows(keyed: bool) -> Row {
    let rows: Vec<Value> = (0..60)
        .map(|r| {
            json!({"id": format!("row{r:02}"), "type": "tr", "children": (0..3).map(|c| json!(
                {"type": "td", "children": [{"type": "p", "children": [{"text": format!("cell {r} {c}")}]}]}
            )).collect::<Vec<_>>()})
        })
        .collect();
    let value = vec![json!({"id": "tbl", "type": "table", "children": rows})];
    let seed = blocks::state_from_value(&value, 1).unwrap();
    let base = {
        let doc = common::doc(&seed, 5);
        memory(&collect(&doc, keyed).0).1
    };
    let doc = common::doc(&seed, 5);
    let deleted: Vec<String> = (5..55).map(|r| format!("row{r:02}")).collect();
    let mut ranges: Vec<(ID, u32)> = Vec::new();
    let mine = |key: &str, row: &str| {
        key.starts_with(&format!("prop:rows.{row}."))
            || key.starts_with(&format!("prop:cells.{row}:"))
    };
    {
        let txn = doc.transact();
        let Some(Out::YMap(table)) = common::blocks_map(&txn).get(&txn, "tbl") else {
            panic!("no table");
        };
        let branch = BranchPtr::from(table.as_ref() as &yrs::branch::Branch);
        for (key, head) in branch.map_items() {
            if deleted.iter().any(|row| mine(key, row)) {
                common::subtree(head, &mut ranges);
            }
        }
    }
    for row in &deleted {
        let mut txn = doc.transact_mut();
        let Some(Out::YMap(table)) = common::blocks_map(&txn).get(&txn, "tbl") else {
            panic!("no table");
        };
        let keys: Vec<String> = table
            .keys(&txn)
            .filter(|k| mine(k, row))
            .map(str::to_string)
            .collect();
        assert!(keys.len() >= 5, "{keys:?}");
        for key in keys {
            table.remove(&mut txn, &key);
        }
    }
    let (state, ms) = collect(&doc, keyed);
    let (loaded, mem) = memory(&state);
    blocks::check(&loaded.transact()).unwrap();
    let (bytes, items) = common::struct_bytes(&loaded, &ranges);
    let n = deleted.len() as f64;
    Row {
        what: format!(
            "blocks table rows (3 columns), rule {}",
            if keyed { "on" } else { "off" }
        ),
        state: state.len(),
        delete_set: delete_set_len(&loaded),
        per_unit_bytes: bytes as f64 / n,
        per_unit_items: items as f64 / n,
        memory: mem,
        base_memory: base,
        collect_ms: ms,
    }
}

#[test]
fn deleted_block_and_row_costs_with_and_without_the_rule() {
    let value = load_note();
    let short = renamed(&value, 10);
    let uuid = renamed(&value, 36);
    let rows = vec![
        blocks_run(&value, false, "blocks, corpus ids (17 chars), rule off"),
        blocks_run(&value, true, "blocks, corpus ids (17 chars), rule on"),
        blocks_run(&short, false, "blocks, 10-char ids, rule off"),
        blocks_run(&uuid, false, "blocks, UUID ids (36 chars), rule off"),
        blocks_run(&uuid, true, "blocks, UUID ids (36 chars), rule on"),
        plate_run(&value),
        table_rows(false),
        table_rows(true),
    ];
    print(&rows);
    // The rule leaves no item for a deleted block beyond Plate's.
    assert!(rows[1].per_unit_items <= rows[5].per_unit_items + 0.01);
    assert!(rows[1].per_unit_bytes < rows[0].per_unit_bytes);
}
