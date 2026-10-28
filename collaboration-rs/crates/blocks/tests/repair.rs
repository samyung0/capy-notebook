#![allow(clippy::unwrap_used)]
//! The structural check and the repair on entry (D3), on concurrent moves
//! and deletes from two clients.

mod common;

use blocks::{Repair, Violation};
use serde_json::json;
use yrs::Transact;

/// Three paragraphs a, b, c under the note, on clients 10 and 20.
fn two_clients() -> (yrs::Doc, yrs::Doc) {
    let value = json!([
        {"id": "a", "type": "p", "children": [{"text": "A"}]},
        {"id": "b", "type": "p", "children": [{"text": "B"}]},
        {"id": "c", "type": "p", "children": [{"text": "C"}]},
    ]);
    let state = blocks::state_from_value(value.as_array().unwrap(), 1).unwrap();
    (common::doc(&state, 10), common::doc(&state, 20))
}

fn repaired(doc: &yrs::Doc) -> Vec<Repair> {
    let repairs = blocks::repair(&mut doc.transact_mut());
    blocks::check(&doc.transact()).unwrap();
    repairs
}

#[test]
fn two_parents_keep_the_higher_client_ids_listing() {
    let (low, high) = two_clients();
    common::move_block(&mut low.transact_mut(), "c", "a", 0);
    common::move_block(&mut high.transact_mut(), "c", "b", 0);
    common::sync(&[low.clone(), high.clone()]);
    assert_eq!(
        blocks::check(&low.transact()),
        Err(Violation::TwoParents("c".into()))
    );
    for doc in [&low, &high] {
        let repairs = repaired(doc);
        assert_eq!(
            repairs,
            [Repair::Duplicate {
                parent: "a".into(),
                child: "c".into()
            }]
        );
        let txn = doc.transact();
        assert_eq!(common::child_ids(&txn, "b"), ["c"]);
        assert!(common::child_ids(&txn, "a").is_empty());
    }
}

#[test]
fn a_dangling_child_is_dropped() {
    let (low, high) = two_clients();
    common::delete_block(&mut low.transact_mut(), "c");
    common::move_block(&mut high.transact_mut(), "c", "b", 0);
    common::sync(&[low.clone(), high.clone()]);
    assert_eq!(
        blocks::check(&low.transact()),
        Err(Violation::Dangling {
            parent: "b".into(),
            child: "c".into()
        })
    );
    assert_eq!(
        repaired(&low),
        [Repair::Dangling {
            parent: "b".into(),
            child: "c".into()
        }]
    );
    assert_eq!(common::child_ids(&low.transact(), "note"), ["a", "b"]);
}

#[test]
fn an_orphan_goes_back_under_the_note() {
    let (low, high) = two_clients();
    // The parent is deleted while c moves into it.
    common::delete_block(&mut low.transact_mut(), "a");
    common::move_block(&mut high.transact_mut(), "c", "a", 0);
    common::sync(&[low.clone(), high.clone()]);
    assert_eq!(
        blocks::check(&low.transact()),
        Err(Violation::Unreachable("c".into()))
    );
    assert_eq!(repaired(&low), [Repair::Orphan { id: "c".into() }]);
    assert_eq!(common::child_ids(&low.transact(), "note"), ["b", "c"]);
}

#[test]
fn a_cycle_is_broken_at_the_lower_client_ids_listing() {
    let (low, high) = two_clients();
    common::move_block(&mut low.transact_mut(), "a", "b", 0);
    common::move_block(&mut high.transact_mut(), "b", "a", 0);
    common::sync(&[low.clone(), high.clone()]);
    assert_eq!(
        blocks::check(&low.transact()),
        Err(Violation::Unreachable("a".into()))
    );
    for doc in [&low, &high] {
        assert_eq!(
            repaired(doc),
            [
                Repair::Cycle {
                    parent: "b".into(),
                    child: "a".into()
                },
                Repair::Orphan { id: "a".into() },
            ]
        );
        let txn = doc.transact();
        assert_eq!(common::child_ids(&txn, "note"), ["c", "a"]);
        assert_eq!(common::child_ids(&txn, "a"), ["b"]);
    }
    assert_eq!(
        blocks::value(&low.transact()).unwrap(),
        blocks::value(&high.transact()).unwrap()
    );
}

#[test]
fn a_missing_default_is_refused() {
    let (doc, _) = two_clients();
    {
        let mut txn = doc.transact_mut();
        let blocks = common::blocks_map(&txn);
        let yrs::Out::YMap(a) = yrs::Map::get(&blocks, &txn, "a").unwrap() else {
            panic!()
        };
        yrs::Map::remove(&a, &mut txn, "prop:collapsed");
    }
    assert_eq!(
        blocks::check(&doc.transact()),
        Err(Violation::MissingDefault {
            id: "a".into(),
            key: "collapsed".into()
        })
    );
}

/// A list nested `levels` deep: one bulleted item per indent.
fn nested_list(levels: usize) -> Vec<serde_json::Value> {
    (1..=levels)
        .map(|indent| {
            json!({
                "id": format!("l{indent}"), "type": "p", "indent": indent,
                "listStyleType": "disc", "children": [{"text": "item"}],
            })
        })
        .collect()
}

/// D18: nesting is capped at 8 levels below the note, list indent included.
#[test]
fn nesting_past_eight_levels_is_refused() {
    let doc = common::doc(&blocks::state_from_value(&nested_list(8), 1).unwrap(), 2);
    blocks::check(&doc.transact()).unwrap();
    let doc = common::doc(&blocks::state_from_value(&nested_list(9), 1).unwrap(), 2);
    assert_eq!(
        blocks::check(&doc.transact()),
        Err(Violation::TooDeep("l9".into()))
    );
}

/// D13: an image uploading holds an empty `sourceId`; the room allows it and
/// its projection leaves it out.
#[test]
fn an_uploading_image_passes_and_is_not_projected() {
    let value = json!([
        {"id": "a", "type": "p", "children": [{"text": "A"}]},
        {"id": "i", "type": "img", "assetId": "asset_1", "children": [{"text": ""}]},
    ]);
    let doc = common::doc(
        &blocks::state_from_value(value.as_array().unwrap(), 1).unwrap(),
        2,
    );
    {
        let mut txn = doc.transact_mut();
        let blocks = common::blocks_map(&txn);
        let yrs::Out::YMap(image) = yrs::Map::get(&blocks, &txn, "i").unwrap() else {
            panic!()
        };
        yrs::Map::insert(&image, &mut txn, "prop:sourceId", "");
    }
    let txn = doc.transact();
    blocks::check(&txn).unwrap();
    let projected = blocks::value(&txn).unwrap();
    assert_eq!(projected.len(), 1);
    assert_eq!(projected[0]["id"], "a");
}
