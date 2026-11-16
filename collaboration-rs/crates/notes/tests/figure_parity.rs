#![allow(clippy::unwrap_used)] // Tests panic on a broken fixture.
//! The browser and server parity corpus for note figures (Epo 2026-11-16,
//! D15), as `items/tests/parity` is for quizzes: the server bootstraps a note
//! holding a chart, a plot and a graph (`tests/figure_parity/rust.json`,
//! which `src/features/notes/figureParity.test.ts` reads through the patched
//! slate-yjs); the browser inserts the same note (`ts.json`, read here). Each
//! side regenerates its own file with `PARITY_WRITE=1` and fails when the
//! committed one is stale. Both hold each figure as the figure map, no list.

use notes::{figure_map, json, plate, slate_yjs};
use serde_json::{Value, json};
use yrs::types::ToJson;
use yrs::updates::decoder::Decode;
use yrs::{Doc, Out, Transact, Update, Xml, XmlTextRef};

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/figure_parity");

fn value() -> Vec<Value> {
    let figure = |id: &str, block: Value| json!({ "type": block["type"], "id": id, "block": block, "children": [{ "text": "" }] });
    vec![
        figure(
            "f_chart",
            json!({
                "type": "chart", "kind": "bar", "title": "Rainfall", "xTitle": "Month",
                "labels": ["Jan", "Feb", "Mar"],
                "series": [
                    { "name": "North", "values": [1, null, 2.5] },
                    { "name": "South", "values": [-3, 4, 0] },
                ],
            }),
        ),
        figure(
            "f_plot",
            json!({
                "type": "plot", "kind": "line", "title": "Growth", "xTitle": "t", "yTitle": "n",
                "series": [{ "name": "A", "points": [[0, 0], [1, 2], [2, 3]] }],
            }),
        ),
        figure(
            "f_graph",
            json!({
                "type": "graph", "width": 320, "height": 190, "description": "A triangle",
                "board": { "bbox": [-5, 5, 5, -5], "axis": true, "grid": false },
                "elements": [
                    { "type": "point", "id": "A", "coords": [0, 0], "name": "A" },
                    { "type": "point", "id": "B", "coords": [3, 0] },
                    { "type": "point", "id": "C", "coords": [0, 4] },
                    { "type": "polygon", "id": "t", "points": ["A", "B", "C"] },
                    { "type": "functiongraph", "id": "f", "term": "0.5*x^2-3" },
                ],
            }),
        ),
        json!({ "type": "p", "id": "p1", "children": [{ "text": "After the figures." }] }),
    ]
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn load(state: &str) -> Doc {
    let doc = Doc::with_options(ydoc::doc_options(9));
    doc.transact_mut()
        .apply_update(Update::decode_v1(&unhex(state)).unwrap())
        .unwrap();
    doc
}

/// Each top-level block's figure map as JSON (none for another block): what
/// a writer put there, whatever order its structs or a value's keys were
/// encoded in. A list anywhere in it fails.
fn maps(state: &str) -> Vec<Value> {
    let doc = load(state);
    let txn = doc.transact();
    let root = plate::content_root(&txn).unwrap();
    plate::insert_delta(&root)
        .unwrap()
        .into_iter()
        .map(|op| match op.insert {
            plate::Insert::Element(branch) => {
                match XmlTextRef::from(branch).get_attribute(&txn, "block") {
                    Some(Out::YMap(map)) => {
                        let held = json::any_to_value(&map.to_json(&txn)).unwrap();
                        assert!(!holds_list(&held), "a list in {held}");
                        held
                    }
                    _ => Value::Null,
                }
            }
            plate::Insert::Text(_) => Value::Null,
        })
        .collect()
}

/// Whether a figure's map holds one of its kind's maps as anything but a map
/// (a list, as the layout before held a graph's elements and a chart's
/// series).
fn holds_list(map: &Value) -> bool {
    let kind = map["type"].as_str().unwrap_or_default();
    figure_map::maps(kind)
        .iter()
        .any(|key| !map[*key].is_object())
}

fn corpus(name: &str) -> Value {
    let text = std::fs::read_to_string(format!("{DIR}/{name}")).unwrap();
    serde_json::from_str(&text.replace("\r\n", "\n")).unwrap()
}

#[test]
fn the_server_corpus_is_current() {
    let value = value();
    let state = hex(&slate_yjs::state_from_value(&value, 1));
    let written =
        serde_json::to_string_pretty(&json!({ "value": value, "state": state })).unwrap() + "\n";
    if std::env::var_os("PARITY_WRITE").is_some() {
        std::fs::write(format!("{DIR}/rust.json"), &written).unwrap();
    }
    let committed = corpus("rust.json");
    let stale = "tests/figure_parity/rust.json is stale: rerun with PARITY_WRITE=1";
    assert_eq!(committed["value"], json!(value), "{stale}");
    assert_eq!(
        maps(committed["state"].as_str().unwrap()),
        maps(&state),
        "{stale}"
    );
}

#[test]
fn reads_what_the_browser_writes_as_the_same_note() {
    let browser = corpus("ts.json");
    assert_eq!(
        browser["value"],
        json!(value()),
        "ts.json is from another note"
    );
    let state = browser["state"].as_str().unwrap();
    let doc = load(state);
    assert_eq!(plate::value(&doc.transact()).unwrap(), value());
    // Both writers hold a figure alike: the same fields and maps, the
    // browser's chart ids and order keys aside.
    let ours = maps(&hex(&slate_yjs::state_from_value(&value(), 1)));
    for (theirs, ours) in maps(state).iter().zip(&ours) {
        let keys = |map: &Value| -> Vec<String> {
            map.as_object()
                .map_or_else(Vec::new, |map| map.keys().cloned().collect())
        };
        assert_eq!(keys(theirs), keys(ours));
        assert_eq!(
            theirs.get("elements").map(keys),
            ours.get("elements").map(keys)
        );
        assert_eq!(theirs.get("board"), ours.get("board"));
    }
}
