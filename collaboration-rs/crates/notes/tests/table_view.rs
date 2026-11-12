#![allow(clippy::unwrap_used)] // Tests panic on a broken fixture.
//! A note's table view (Epo 2026-11-12): the store takes a block at every
//! limit and refuses a broken structure with Go's messages
//! (`materialdoc.validateTableView`), a room holds its block as a live map
//! whose columns, rows and views merge entry by entry, and admission takes
//! what a merge leaves but refuses, as the update arrives, what the store
//! would (two title columns, a 21st table view). The index text is tested on
//! the golden fixtures (`tests/index_text.rs`, `table-views.json`).

mod common;

use std::collections::HashMap;

use common::AdmitBytes;
use notes::catalog::{
    TABLE_VIEW_CELL_MAX, TABLE_VIEW_COLUMNS_MAX, TABLE_VIEW_ID_MAX, TABLE_VIEW_MAX_COUNT,
    TABLE_VIEW_NAME_MAX, TABLE_VIEW_NUMBER_MAX, TABLE_VIEW_OPTIONS_MAX, TABLE_VIEW_ROWS_MAX,
    TABLE_VIEW_VIEWS_MAX,
};
use notes::limits::{self, Admission, Refusal, Validator};
use notes::slate::{Operation, Root};
use notes::{material, plate, slate_yjs};
use serde_json::{Value, json};
use yrs::{Any, Array, ArrayRef, Doc, Map, MapRef, Out, ReadTxn, Transact, Xml, XmlTextRef};

fn small() -> Value {
    json!({
        "title": "Tracker",
        "columns": [
            { "id": "c_title", "name": "Topic", "kind": "title" },
            { "id": "c_status", "name": "Status", "kind": "select", "options": [
                { "id": "o_1", "name": "Done", "color": "green" },
            ] },
            { "id": "c_mark", "name": "Mark", "kind": "number" },
        ],
        "rows": [{ "id": "r_1", "c_title": "Krebs", "c_mark": 6 }],
        "views": [
            { "id": "v_1", "name": "Table", "kind": "table" },
            { "id": "v_2", "name": "Board", "kind": "kanban", "groupBy": "c_status" },
        ],
    })
}

/// A block at every limit (Go's `fullTableView`): the most columns, rows,
/// views and options, ids and names at their longest (a name ending in a
/// surrogate pair, two UTF-16 units), the longest cell, the largest numbers.
fn full() -> Value {
    let id = |prefix: &str, i: usize| {
        let s = format!("{prefix}{i}");
        format!("{s}{}", "_".repeat(TABLE_VIEW_ID_MAX - s.len()))
    };
    let name = format!("{}😀", "n".repeat(TABLE_VIEW_NAME_MAX - 2));
    let options: Vec<Value> = (0..TABLE_VIEW_OPTIONS_MAX)
        .map(|i| json!({ "id": id("o", i), "name": name, "color": "red" }))
        .collect();
    let mut columns = vec![
        json!({ "id": id("c", 0), "name": name, "kind": "title" }),
        json!({ "id": id("c", 1), "name": name, "kind": "select", "options": options }),
    ];
    for i in 2..TABLE_VIEW_COLUMNS_MAX {
        let kind = ["text", "number", "date", "checkbox"][i % 4];
        columns.push(json!({ "id": id("c", i), "name": name, "kind": kind }));
    }
    let number = TABLE_VIEW_NUMBER_MAX as f64;
    let cell = |i: usize| match i % 4 {
        0 => json!("x".repeat(TABLE_VIEW_CELL_MAX)),
        1 => json!(number),
        2 => json!(-number),
        _ => json!(true),
    };
    let rows: Vec<Value> = (0..TABLE_VIEW_ROWS_MAX)
        .map(|r| {
            let mut row: serde_json::Map<String, Value> = (0..TABLE_VIEW_COLUMNS_MAX)
                .map(|i| (id("c", i), cell(i)))
                .collect();
            row.insert("id".into(), json!(id("r", r)));
            Value::Object(row)
        })
        .collect();
    let views: Vec<Value> = (0..TABLE_VIEW_VIEWS_MAX)
        .map(|i| {
            let sort = json!({ "columnId": id("c", 0), "dir": "desc" });
            if i % 2 == 1 {
                json!({ "id": id("v", i), "name": name, "kind": "kanban", "groupBy": id("c", 1), "sort": sort })
            } else {
                json!({ "id": id("v", i), "name": name, "kind": "table", "sort": sort })
            }
        })
        .collect();
    json!({ "title": name, "columns": columns, "rows": rows, "views": views })
}

fn node(id: &str, block: Value) -> Value {
    json!({ "type": "table_view", "id": id, "block": block, "children": [{ "text": "" }] })
}

fn stored(block: Value) -> Result<(), String> {
    material::assert_canonical(&[node("tv", block)], "note").map_err(|error| error.0)
}

#[test]
fn the_store_takes_a_block_at_its_limits_and_what_merges_leave() {
    stored(full()).unwrap();
    let mut merged = small();
    merged["rows"][0] = json!({ "id": "r_1", "c_gone": "x", "c_status": 4.5, "c_title": true });
    merged["views"][0] = json!({ "id": "v_1", "name": "Board", "kind": "kanban", "groupBy": "c_title",
        "sort": { "columnId": "c_gone", "dir": "asc" } });
    stored(merged.clone()).unwrap();
    merged["views"] = json!([]);
    stored(merged).unwrap();

    let mut notes: Vec<Value> = (0..TABLE_VIEW_MAX_COUNT)
        .map(|i| node(&format!("tv{i}"), small()))
        .collect();
    material::assert_canonical(&notes, "note").unwrap();
    notes.push(node("tv_over", small()));
    assert_eq!(
        material::assert_canonical(&notes, "note").unwrap_err().0,
        "21 table views over 20"
    );
}

/// The refusals that matter, each with Go's message word for word (what
/// `TestTableViewRefusesBrokenStructure` gets from Go).
#[test]
fn the_store_refuses_a_broken_block_with_gos_messages() {
    let id_rule = format!(
        "must be 1 to {TABLE_VIEW_ID_MAX} letters, digits, _ or -, starting with a letter or digit"
    );
    type Case = (&'static str, fn(&mut Value), String);
    let cases: Vec<Case> = vec![
        (
            "two title columns",
            |b| b["columns"][1] = json!({ "id": "c_status", "name": "Status", "kind": "title" }),
            "table view needs exactly one title column".into(),
        ),
        (
            "a column too many",
            |b| {
                b["columns"] = full()["columns"].clone();
                b["columns"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({ "id": "c_more", "name": "More", "kind": "text" }));
            },
            "table view columns must be a list of 1 to 20".into(),
        ),
        (
            "a row too many",
            |b| {
                b["rows"] = full()["rows"].clone();
                b["rows"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({ "id": "r_more" }));
            },
            "table view rows must be a list of 0 to 500".into(),
        ),
        (
            "a view too many",
            |b| {
                b["views"] = full()["views"].clone();
                b["views"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({ "id": "v_more", "name": "More", "kind": "table" }));
            },
            "table view views must be a list of 0 to 8".into(),
        ),
        (
            "an id led by _",
            |b| b["columns"][0]["id"] = json!("__proto__"),
            format!("table view column id {id_rule}"),
        ),
        (
            "a column id id",
            |b| b["columns"][0]["id"] = json!("id"),
            "a table view column id cannot be id".into(),
        ),
        (
            "a cell too many",
            |b| {
                for i in 0..TABLE_VIEW_COLUMNS_MAX {
                    b["rows"][0][format!("c{i}")] = json!("x");
                }
            },
            "a table view row holds at most 20 cells".into(),
        ),
        (
            "a bad column kind",
            |b| b["columns"][0]["kind"] = json!("formula"),
            "unknown table view column kind".into(),
        ),
        (
            "a bad colour",
            |b| b["columns"][1]["options"][0]["color"] = json!("teal"),
            "unknown table view option color".into(),
        ),
        (
            "a bad id",
            |b| b["columns"][0]["id"] = json!("c title"),
            format!("table view column id {id_rule}"),
        ),
        (
            "a duplicate row id",
            |b| {
                let row = b["rows"][0].clone();
                b["rows"].as_array_mut().unwrap().push(row);
            },
            "duplicate table view row id r_1".into(),
        ),
        (
            "a bad cell key",
            |b| b["rows"][0]["c.title"] = json!("x"),
            format!("table view cell key {id_rule}"),
        ),
        (
            "an old cells key",
            |b| b["rows"][0]["cells"] = json!({}),
            "table view cell must be a string of at most 2000 characters, a number of at most 1000000000000000 or a boolean".into(),
        ),
        (
            "an unknown block key",
            |b| b["filter"] = json!("x"),
            "unexpected table view block field filter".into(),
        ),
        (
            "an unknown view key",
            |b| b["views"][0]["width"] = json!(3),
            "unexpected table view view field width".into(),
        ),
        (
            "options on a text column",
            |b| b["columns"][2]["options"] = json!([]),
            "table view options are on select columns only".into(),
        ),
        (
            "groupBy on a table view",
            |b| b["views"][0]["groupBy"] = json!("c_status"),
            "table view groupBy must be a column id on a kanban view".into(),
        ),
        (
            "a long title",
            |b| b["title"] = json!(format!("{}😀", "n".repeat(TABLE_VIEW_NAME_MAX - 1))),
            "table view title must be a string of at most 100 characters".into(),
        ),
        (
            "a large number",
            |b| b["rows"][0]["c_mark"] = json!(1e15 + 1.0),
            "table view cell must be a string of at most 2000 characters, a number of at most 1000000000000000 or a boolean".into(),
        ),
        (
            "a null cell",
            |b| b["rows"][0]["c_mark"] = Value::Null,
            "table view cell must be a string of at most 2000 characters, a number of at most 1000000000000000 or a boolean".into(),
        ),
    ];
    for (name, mutate, message) in cases {
        let mut block = small();
        mutate(&mut block);
        assert_eq!(stored(block), Err(message), "{name}");
    }
}

fn open(value: &[Value]) -> Doc {
    common::doc(&slate_yjs::state_from_value(value, 1), 2)
}

/// What a peer's edit sends: its changes since the room's state.
fn edit(room: &Doc, client: u64, change: impl FnOnce(&Doc)) -> Vec<u8> {
    let peer = common::doc(&common::state(room), client);
    change(&peer);
    let vector = room.transact().state_vector();
    peer.transact().encode_state_as_update_v1(&vector)
}

fn admit(room: &Doc, update: &[u8]) -> Result<Admission, Refusal> {
    let mut validator = Validator::new("note");
    validator.admit_bytes(room, &edit(room, 9, |_| {})).unwrap();
    let result = validator.admit_bytes(room, update);
    if matches!(result, Ok(Admission::Accepted)) {
        common::apply(room, update);
    }
    result
}

fn refused(result: Result<Admission, Refusal>, reason: &str) {
    match result {
        Err(Refusal::Content(what)) => assert_eq!(what, reason),
        other => panic!("{reason}: {other:?}"),
    }
}

/// The block map's list `key` of the element at `index`.
fn list(doc: &Doc, index: usize, key: &str) -> ArrayRef {
    let txn = doc.transact();
    let element =
        match &plate::insert_delta(&plate::content_root(&txn).unwrap()).unwrap()[index].insert {
            plate::Insert::Element(branch) => XmlTextRef::from(*branch),
            plate::Insert::Text(_) => panic!("not a block"),
        };
    let Some(Out::YMap(block)) = element.get_attribute(&txn, "block") else {
        panic!("not a block map");
    };
    match block.get(&txn, key) {
        Some(Out::YArray(list)) => list,
        other => panic!("{key} is not a list: {other:?}"),
    }
}

fn entry(doc: &Doc, list: &ArrayRef, index: u32) -> MapRef {
    match list.get(&doc.transact(), index) {
        Some(Out::YMap(map)) => map,
        other => panic!("entry {index} is not a map: {other:?}"),
    }
}

/// Writers' edits to different entries of one block merge, what a merge
/// leaves (a cell of a gone column) included. Two writers each making a
/// different column the title, valid alone, would leave two title columns:
/// the later one is refused as it arrives, so the store never sees it. A
/// 21st table view is refused too.
#[test]
fn admission_merges_entries_and_refuses_what_the_store_would() {
    let value = [node("tv", small())];
    let room = open(&value);
    assert_eq!(plate::value(&room.transact()).unwrap(), value);
    let rename = edit(&room, 3, |peer| {
        let columns = list(peer, 0, "columns");
        entry(peer, &columns, 2).insert(&mut peer.transact_mut(), "name", "Score");
    });
    let cell = edit(&room, 4, |peer| {
        let rows = list(peer, 0, "rows");
        entry(peer, &rows, 0).insert(&mut peer.transact_mut(), "c_gone", "kept");
    });
    // Column `at` becomes the title, the old title column text.
    let retitle = |client: u64, at: u32| {
        edit(&room, client, move |peer| {
            let columns = list(peer, 0, "columns");
            let (title, column) = (entry(peer, &columns, 0), entry(peer, &columns, at));
            let mut txn = peer.transact_mut();
            title.insert(&mut txn, "kind", "text");
            column.remove(&mut txn, "options");
            column.insert(&mut txn, "kind", "title");
        })
    };
    let (first, second) = (retitle(5, 1), retitle(6, 2));
    assert_eq!(admit(&room, &rename).unwrap(), Admission::Accepted);
    assert_eq!(admit(&room, &cell).unwrap(), Admission::Accepted);
    assert_eq!(admit(&room, &first).unwrap(), Admission::Accepted);
    refused(admit(&room, &second), limits::BAD_VALUE);
    let held = plate::value(&room.transact()).unwrap();
    let block = &held[0]["block"];
    assert_eq!(block["columns"][1]["kind"], "title");
    assert_eq!(
        block["columns"][2],
        json!({ "id": "c_mark", "name": "Score", "kind": "number" })
    );
    assert_eq!(block["rows"][0]["c_gone"], "kept");
    material::assert_canonical(&held, "note").unwrap();

    let value: Vec<Value> = (0..TABLE_VIEW_MAX_COUNT)
        .map(|i| node(&format!("tv{i}"), small()))
        .collect();
    let full_room = open(&value);
    let insert = edit(&full_room, 6, |peer| {
        let mut root = Root::new(plate::value(&peer.transact()).unwrap());
        let op = Operation::InsertNode {
            path: vec![TABLE_VIEW_MAX_COUNT],
            node: node("tv_over", small()),
        };
        let mut txn = peer.transact_mut();
        let y_root = plate::content_root(&txn).unwrap();
        slate_yjs::apply_ops(&mut txn, y_root, &mut root, &[op]).unwrap();
    });
    refused(admit(&full_room, &insert), limits::TOO_MANY_TABLE_VIEWS);
}

/// A row's cells are its own keys (Revision 2): two writers editing
/// different cells of one row both keep their edit, merged key by key on the
/// copy of the room. An old `cells` object on a row is refused.
#[test]
fn two_writers_editing_different_cells_of_a_row_both_keep_them() {
    let room = open(&[node("tv", small())]);
    let set = |client: u64, key: &'static str, value: Any| {
        edit(&room, client, move |peer| {
            let row = entry(peer, &list(peer, 0, "rows"), 0);
            row.insert(&mut peer.transact_mut(), key, value);
        })
    };
    let (title, mark) = (
        set(3, "c_title", Any::from("Krebs cycle")),
        set(4, "c_mark", Any::from(7.0)),
    );
    assert_eq!(admit(&room, &title).unwrap(), Admission::Accepted);
    assert_eq!(admit(&room, &mark).unwrap(), Admission::Accepted);
    let held = plate::value(&room.transact()).unwrap();
    assert_eq!(
        held[0]["block"]["rows"][0],
        json!({ "id": "r_1", "c_title": "Krebs cycle", "c_mark": 7 })
    );
    material::assert_canonical(&held, "note").unwrap();
    let cells = Any::from(HashMap::from([("c_title".to_owned(), Any::from("x"))]));
    refused(admit(&room, &set(5, "cells", cells)), limits::BAD_VALUE);
}

/// Two writers deleting different views, the last two, no longer wedge a
/// room (Revision 2): both deletions go in and leave a block with no view,
/// which the store takes.
#[test]
fn two_writers_deleting_the_last_two_views_both_go_in() {
    let room = open(&[node("tv", small())]);
    let delete = |client: u64, at: u32| {
        edit(&room, client, move |peer| {
            let views = list(peer, 0, "views");
            views.remove(&mut peer.transact_mut(), at);
        })
    };
    let (first, second) = (delete(3, 0), delete(4, 1));
    assert_eq!(admit(&room, &first).unwrap(), Admission::Accepted);
    assert_eq!(admit(&room, &second).unwrap(), Admission::Accepted);
    let held = plate::value(&room.transact()).unwrap();
    assert_eq!(held[0]["block"]["views"], json!([]));
    material::assert_canonical(&held, "note").unwrap();
}
