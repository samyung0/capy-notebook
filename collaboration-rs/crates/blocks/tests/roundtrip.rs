#![allow(clippy::unwrap_used)]
//! value → blocks → value equals the canonical value, ids included, for the
//! bootstrap corpus and the every-block note.

mod common;

use serde_json::{Value, json};
use yrs::Transact;

fn note_kind(value: &[Value]) -> bool {
    !value
        .iter()
        .any(|node| matches!(node["type"].as_str(), Some("quiz" | "flashcards")))
}

#[test]
fn corpus_round_trips_to_canonical() {
    let mut cases: Vec<(String, Vec<Value>)> = common::bootstrap()
        .into_iter()
        .map(|case| {
            (
                case["name"].as_str().unwrap().to_string(),
                case["value"].as_array().unwrap().clone(),
            )
        })
        .collect();
    // The fixture's quiz and flashcard references carry an imported fence
    // body (`pending`), which no stored note holds; the converter refuses one.
    let mut every = common::every_block_note();
    for node in &mut every {
        if let Some(node) = node.as_object_mut() {
            node.remove("pending");
        }
    }
    cases.push(("every-block-note".into(), every));

    let mut failures = Vec::new();
    let (mut checked, mut skipped, mut unchanged) = (0, 0, 0);
    for (name, value) in &cases {
        if !note_kind(value) {
            skipped += 1;
            continue;
        }
        checked += 1;
        let canonical = blocks::canonical(value).unwrap();
        let projected = common::round_trip(value);
        if let Some(diff) = common::first_difference(&projected, &canonical) {
            failures.push(format!("{name}: {diff}"));
        }
        // The canonical value is a fixed point.
        assert_eq!(blocks::canonical(&canonical).unwrap(), canonical, "{name}");
        unchanged += usize::from(&canonical == value);
        // The seed passes the structural check.
        let doc = common::doc(&blocks::state_from_value(value, 7).unwrap(), 99);
        if let Err(violation) = blocks::check(&doc.transact()) {
            failures.push(format!("{name}: check: {violation}"));
        }
    }
    eprintln!(
        "round trip: {checked} note values ({unchanged} already canonical), {skipped} skipped"
    );
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn empty_value_seeds_root_note_and_one_paragraph() {
    for empty in [json!([]), json!([{"text": ""}])] {
        let state = blocks::state_from_value(empty.as_array().unwrap(), 7).unwrap();
        let doc = common::doc(&state, 99);
        let txn = doc.transact();
        blocks::check(&txn).unwrap();
        let map = blocks::blocks_json(&txn);
        let ids: Vec<&String> = map.as_object().unwrap().keys().collect();
        assert_eq!(ids, ["note", "note-b0", "root"]);
        assert_eq!(map["root"]["flavour"], "affine:page");
        assert_eq!(map["root"]["children"], json!(["note"]));
        assert_eq!(map["note"]["flavour"], "affine:note");
        assert_eq!(map["note"]["children"], json!(["note-b0"]));
        assert_eq!(map["note-b0"]["flavour"], "affine:paragraph");
        assert_eq!(map["note-b0"]["props"]["text"], json!([]));
        assert_eq!(
            blocks::value(&txn).unwrap(),
            vec![json!({"id": "note-b0", "type": "p", "children": [{"text": ""}]})]
        );
    }
}

#[test]
fn pending_import_is_refused() {
    let value = json!([{
        "id": "q", "type": "material_ref", "refKind": "quiz", "materialId": "",
        "pending": "{}", "children": [{"text": ""}],
    }]);
    assert!(blocks::state_from_value(value.as_array().unwrap(), 7).is_err());
}

#[test]
fn image_widths_are_pixels_against_768() {
    let img = |width: &str| {
        vec![
            json!({"id": "im", "type": "img", "assetId": "a1", "width": width, "children": [{"text": ""}]}),
        ]
    };
    let state = blocks::state_from_value(&img("33.3%"), 7).unwrap();
    let doc = common::doc(&state, 99);
    let blocks = blocks::blocks_json(&doc.transact());
    assert_eq!(blocks["im"]["props"]["width"], json!(256));
    assert_eq!(blocks["im"]["props"]["height"], json!(0));
    let widths: Vec<Value> = ["33.3%", "10%", "150%"]
        .iter()
        .map(|w| blocks::canonical(&img(w)).unwrap()[0]["width"].clone())
        .collect();
    assert_eq!(widths, [json!("33%"), json!("20%"), json!("100%")]);
}
