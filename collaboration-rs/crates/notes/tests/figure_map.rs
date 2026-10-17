#![allow(clippy::unwrap_used)] // Tests panic on a broken fixture.
//! A chart's, plot's or graph's `block` as a live map (Epo 2026-10-17): the
//! bootstrap and an agent's insert write it as a Y.Map with its series or
//! elements as Y.Arrays of Y.Maps, it reads as its value repaired on read
//! (the shared fixtures in server/internal/questions/testdata/repairs), two
//! writers' changes to different entries merge, the projection stores the
//! repaired merge, and admission refuses a crafted update that puts an
//! unknown key, a wrong type, an oversize value or another shape into it.
//! Each refusal fails if its check is reverted.

mod common;

use common::AdmitBytes;
use notes::limits::{self, Admission, Refusal, Validator};
use notes::slate::{Operation, Root};
use notes::{material, plate, questions, slate_yjs};
use serde_json::{Value, json};
use yrs::{
    Any, Array, ArrayPrelim, ArrayRef, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, Text, Transact,
    Xml, XmlTextRef,
};

fn read_json(path: &str) -> Value {
    let path = format!("{}/../../../{path}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn chart() -> Value {
    json!({
        "type": "chart", "kind": "bar", "title": "Sales", "labels": ["Jan", "Feb"],
        "series": [{ "name": "A", "values": [1, 2] }, { "name": "B", "values": [3, 4] }],
    })
}

fn graph() -> Value {
    json!({
        "type": "graph", "board": { "bbox": [-5, 5, 5, -5], "axis": true, "grid": true },
        "elements": [
            { "type": "point", "id": "p1", "coords": [0, 0] },
            { "type": "point", "id": "p2", "coords": [1, 1] },
            { "type": "segment", "id": "s1", "points": ["p1", "p2"] },
        ],
        "image": { "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 320 190\"><rect width=\"320\" height=\"190\" fill=\"#eeeeee\"/></svg>" },
        "width": 320, "height": 190,
    })
}

fn figure(block: Value) -> Value {
    let kind = block["type"].clone();
    let id = format!("f_{}", kind.as_str().unwrap_or_default());
    json!({ "type": kind, "id": id, "block": block, "children": [{ "text": "" }] })
}

fn paragraph(text: &str) -> Value {
    json!({ "type": "p", "id": "p1", "children": [{ "text": text }] })
}

fn room(value: &[Value]) -> Doc {
    common::doc(&slate_yjs::state_from_value(value, 1), 2)
}

/// What a peer's edit sends: its changes since the room's state.
fn edit(room: &Doc, client: u64, change: impl FnOnce(&Doc)) -> Vec<u8> {
    let peer = common::doc(&common::state(room), client);
    change(&peer);
    let vector = room.transact().state_vector();
    peer.transact().encode_state_as_update_v1(&vector)
}

fn block_element(doc: &Doc, index: usize) -> XmlTextRef {
    let txn = doc.transact();
    match &plate::insert_delta(&plate::content_root(&txn).unwrap()).unwrap()[index].insert {
        plate::Insert::Element(branch) => XmlTextRef::from(*branch),
        plate::Insert::Text(_) => panic!("not a block"),
    }
}

fn block_map(doc: &Doc, index: usize) -> MapRef {
    let element = block_element(doc, index);
    match element.get_attribute(&doc.transact(), "block") {
        Some(Out::YMap(map)) => map,
        other => panic!("not a block map: {other:?}"),
    }
}

fn list(doc: &Doc, map: &MapRef, key: &str) -> ArrayRef {
    match map.get(&doc.transact(), key) {
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

fn projected(doc: &Doc) -> Vec<Value> {
    plate::value(&doc.transact()).unwrap()
}

/// A validator with its bound in place: an empty update takes the baseline.
fn validator(room: &Doc) -> Validator {
    let mut validator = Validator::new("note");
    validator.admit_bytes(room, &edit(room, 9, |_| {})).unwrap();
    validator
}

fn admit(room: &Doc, update: &[u8]) -> Result<Admission, Refusal> {
    let result = validator(room).admit_bytes(room, update);
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

#[test]
fn a_bootstrapped_figure_holds_its_block_as_maps_read_as_its_value() {
    let value = [figure(chart()), figure(graph()), paragraph("after")];
    let doc = room(&value);
    let block = block_map(&doc, 0);
    let series = list(&doc, &block, "series");
    assert_eq!(series.len(&doc.transact()), 2);
    entry(&doc, &series, 1);
    let elements = list(&doc, &block_map(&doc, 1), "elements");
    assert_eq!(
        entry(&doc, &elements, 2).get(&doc.transact(), "id"),
        Some(Out::Any(Any::String("s1".into())))
    );
    assert_eq!(projected(&doc), value);
    material::assert_canonical(&projected(&doc), "note").unwrap();
}

#[test]
fn repairs_follow_the_shared_fixtures() {
    let cases = read_json("server/internal/questions/testdata/repairs/figures.json");
    for case in cases.as_array().unwrap() {
        let mut block = case["block"].clone();
        questions::repair_figure(&mut block);
        assert_eq!(block, case["repaired"], "{}", case["name"]);
    }
}

/// Two writers' set_node of the whole block, each from the same state, as
/// the dialogs save: each writes only its changed entries, so both stay.
#[test]
fn two_writers_changes_to_different_entries_merge() {
    let value = [figure(chart())];
    let room = room(&value);
    let save = |client: u64, block: Value| {
        edit(&room, client, |peer| {
            let mut root = Root::new(projected(peer));
            let op = Operation::SetNode {
                path: vec![0],
                properties: serde_json::Map::from_iter([("block".into(), chart())]),
                new_properties: serde_json::Map::from_iter([("block".into(), block)]),
            };
            let mut txn = peer.transact_mut();
            let y_root = plate::content_root(&txn).unwrap();
            slate_yjs::apply_ops(&mut txn, y_root, &mut root, &[op]).unwrap();
        })
    };
    let mut title = chart();
    title["title"] = json!("Revenue");
    let mut series = chart();
    series["series"][1]["values"] = json!([30, 40]);
    let (a, b) = (save(3, title), save(4, series));
    assert_eq!(admit(&room, &a).unwrap(), Admission::Accepted);
    assert_eq!(admit(&room, &b).unwrap(), Admission::Accepted);
    let mut merged = chart();
    merged["title"] = json!("Revenue");
    merged["series"][1]["values"] = json!([30, 40]);
    assert_eq!(projected(&room), [figure(merged)]);
}

/// A merge the validators would refuse (one writer adds a label while
/// another rewrites a series) is admitted, and the projection stores it
/// repaired: the series padded with an empty cell.
#[test]
fn the_projection_stores_a_merge_repaired() {
    let room = room(&[figure(chart())]);
    let labels = edit(&room, 3, |peer| {
        let block = block_map(peer, 0);
        block.insert(
            &mut peer.transact_mut(),
            "labels",
            Any::from(vec![Any::from("Jan"), Any::from("Feb"), Any::from("Mar")]),
        );
        let series = list(peer, &block, "series");
        for index in 0..2 {
            let entry = entry(peer, &series, index);
            let values = Any::from(vec![Any::from(1.0), Any::from(2.0), Any::from(3.0)]);
            entry.insert(&mut peer.transact_mut(), "values", values);
        }
    });
    let values = edit(&room, 4, |peer| {
        let series = list(peer, &block_map(peer, 0), "series");
        let entry = entry(peer, &series, 0);
        let values = Any::from(vec![Any::from(7.0), Any::from(8.0)]);
        entry.insert(&mut peer.transact_mut(), "values", values);
    });
    assert_eq!(admit(&room, &labels).unwrap(), Admission::Accepted);
    assert_eq!(admit(&room, &values).unwrap(), Admission::Accepted);
    let value = projected(&room);
    assert_eq!(
        value[0]["block"]["series"],
        json!([{ "name": "A", "values": [7, 8, null] }, { "name": "B", "values": [1, 2, 3] }])
    );
    material::assert_canonical(&value, "note").unwrap();
}

/// What a crafted update may not put into a live block, each refused as it
/// arrives so the store never sees it.
#[test]
fn admission_refuses_what_the_store_would_inside_a_block_map() {
    let value = [figure(chart()), paragraph("text")];
    let room = room(&value);
    let set = |client: u64, key: &'static str, value: Any| {
        edit(&room, client, |peer| {
            block_map(peer, 0).insert(&mut peer.transact_mut(), key, value);
        })
    };
    // An unknown key, a wrong type, an oversize title.
    refused(
        admit(&room, &set(3, "colour", Any::from("red"))),
        limits::BAD_VALUE,
    );
    refused(
        admit(&room, &set(4, "title", Any::from(5.0))),
        limits::BAD_VALUE,
    );
    let long = "x".repeat(catalog_title_max() + 1);
    refused(
        admit(&room, &set(5, "title", Any::from(long))),
        limits::BAD_VALUE,
    );
    // A series entry given an unknown key; the series list removed.
    let series_key = edit(&room, 6, |peer| {
        let series = list(peer, &block_map(peer, 0), "series");
        entry(peer, &series, 0).insert(&mut peer.transact_mut(), "colour", "red");
    });
    refused(admit(&room, &series_key), limits::BAD_VALUE);
    let no_series = edit(&room, 7, |peer| {
        block_map(peer, 0).remove(&mut peer.transact_mut(), "series");
    });
    refused(admit(&room, &no_series), limits::BAD_VALUE);
    // Other shapes: a map in a series entry, a plain value in the list, a
    // list of maps under a list entry.
    let nested = edit(&room, 8, |peer| {
        let series = list(peer, &block_map(peer, 0), "series");
        entry(peer, &series, 0).insert(&mut peer.transact_mut(), "name", MapPrelim::default());
    });
    refused(admit(&room, &nested), limits::FIGURE_SHAPE);
    let plain_item = edit(&room, 10, |peer| {
        let series = list(peer, &block_map(peer, 0), "series");
        series.push_back(&mut peer.transact_mut(), Any::from("S"));
    });
    refused(admit(&room, &plain_item), limits::FIGURE_SHAPE);
    let deep = edit(&room, 11, |peer| {
        let series = list(peer, &block_map(peer, 0), "series");
        let entry = entry(peer, &series, 0);
        entry.insert(&mut peer.transact_mut(), "values", ArrayPrelim::default());
    });
    refused(admit(&room, &deep), limits::FIGURE_SHAPE);
    // A block map on a paragraph, a chart retyped to a paragraph keeping its
    // map, and a map under a key the catalog does not share.
    let stray = edit(&room, 12, |peer| {
        let element = block_element(peer, 1);
        element.insert_attribute(&mut peer.transact_mut(), "block", MapPrelim::default());
    });
    refused(admit(&room, &stray), limits::STRAY_MAP);
    let retyped = edit(&room, 13, |peer| {
        block_element(peer, 0).insert_attribute(&mut peer.transact_mut(), "type", "p");
    });
    refused(admit(&room, &retyped), limits::STRAY_MAP);
    let other_key = edit(&room, 14, |peer| {
        block_element(peer, 0).insert_attribute(
            &mut peer.transact_mut(),
            "width",
            MapPrelim::default(),
        );
    });
    refused(admit(&room, &other_key), "a non-plain attribute value");
    // A plain block value is still checked as before.
    let plain = edit(&room, 15, |peer| {
        let mut bad = chart();
        bad["kind"] = json!("radar");
        let element = block_element(peer, 0);
        element.insert_attribute(&mut peer.transact_mut(), "block", json_any(&bad));
    });
    refused(admit(&room, &plain), limits::BAD_VALUE);
    // An honest edit goes in, and the room still reads.
    let honest = set(16, "title", Any::from("Revenue"));
    assert_eq!(admit(&room, &honest).unwrap(), Admission::Accepted);
    assert_eq!(projected(&room)[0]["block"]["title"], "Revenue");
}

/// Typing next to a figure stays on the bound with no copy of the room; a
/// change inside its block is measured exactly on one copy.
#[test]
fn typing_stays_on_the_bound_and_a_block_change_is_measured_exactly() {
    let room = room(&[figure(chart()), paragraph("text")]);
    let mut validator = validator(&room);
    let (exact, copies) = (validator.exact_checks, validator.media_copies);
    let typed = edit(&room, 3, |peer| {
        block_element(peer, 1).insert(&mut peer.transact_mut(), 4, "!");
    });
    assert_eq!(
        validator.admit_bytes(&room, &typed).unwrap(),
        Admission::Accepted
    );
    common::apply(&room, &typed);
    assert_eq!(
        (validator.exact_checks, validator.media_copies),
        (exact, copies),
        "typing copied the room"
    );
    let titled = edit(&room, 4, |peer| {
        block_map(peer, 0).insert(&mut peer.transact_mut(), "title", "Revenue");
    });
    assert_eq!(
        validator.admit_bytes(&room, &titled).unwrap(),
        Admission::Accepted
    );
    assert_eq!(validator.exact_checks, exact + 1);
}

fn catalog_title_max() -> usize {
    notes::catalog::QUESTION_CHART_TITLE_MAX
}

fn json_any(value: &Value) -> Any {
    notes::json::value_to_any(value)
}
