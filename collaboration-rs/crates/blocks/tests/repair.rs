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

/// The trimmed block map (vendor/blocksuite/README.md, local change 9): a
/// block's id is its key, and a `sys:id` or `sys:version` is refused, so a
/// room stays trimmed.
#[test]
fn a_sys_id_or_version_is_refused() {
    for (key, value) in [
        ("sys:id", yrs::Any::from("a")),
        ("sys:version", yrs::Any::Number(1.0)),
    ] {
        let (doc, _) = two_clients();
        blocks::check(&doc.transact()).unwrap();
        {
            let mut txn = doc.transact_mut();
            let blocks = common::blocks_map(&txn);
            let yrs::Out::YMap(a) = yrs::Map::get(&blocks, &txn, "a").unwrap() else {
                panic!()
            };
            yrs::Map::insert(&a, &mut txn, key, value);
        }
        assert_eq!(
            blocks::check(&doc.transact()),
            Err(Violation::Prop {
                id: "a".into(),
                key: key.into()
            })
        );
    }
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
/// The check refuses a deeper block; the repair moves it up instead.
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

/// Two writers each nest within the cap (one indents a level-8 chain's top
/// under a paragraph, one adds a child at its bottom); together the bottom
/// sits at level 9. The repair moves it, with its subtree flattened after
/// it in document order, under its level-7 ancestor, after that ancestor's
/// children; both replicas write the same repair. Fails if the room keeps
/// the too-deep block or the replicas differ.
#[test]
fn a_block_two_moves_nest_too_deep_moves_up() {
    let mut value = vec![json!({"id": "top", "type": "p", "children": [{"text": "Top"}]})];
    value.extend(nested_list(7));
    value.push(json!({"id": "x", "type": "p", "children": [{"text": "X"}]}));
    value.push(json!({"id": "y", "type": "p", "children": [{"text": "Y"}]}));
    let state = blocks::state_from_value(&value, 1).unwrap();
    let (low, high) = (common::doc(&state, 10), common::doc(&state, 20));
    // l1..l7 at levels 1..7; low moves l1 under top (l7 to level 8), high
    // moves x under l7 (level 8) and y under x (level 9).
    common::move_block(&mut low.transact_mut(), "l1", "top", 0);
    common::move_block(&mut high.transact_mut(), "x", "l7", 0);
    common::move_block(&mut high.transact_mut(), "y", "x", 0);
    blocks::check(&low.transact()).unwrap();
    assert_eq!(
        blocks::check(&high.transact()),
        Err(Violation::TooDeep("y".into()))
    );
    blocks::repair(&mut high.transact_mut());
    blocks::check(&high.transact()).unwrap();
    let (low, high) = (common::doc(&state, 10), common::doc(&state, 20));
    common::move_block(&mut low.transact_mut(), "l1", "top", 0);
    common::move_block(&mut high.transact_mut(), "x", "l7", 0);
    common::sync(&[low.clone(), high.clone()]);
    assert_eq!(
        blocks::check(&low.transact()),
        Err(Violation::TooDeep("x".into()))
    );
    for doc in [&low, &high] {
        assert_eq!(
            repaired(doc),
            [Repair::TooDeep {
                id: "x".into(),
                parent: "l6".into()
            }]
        );
        let txn = doc.transact();
        assert_eq!(common::child_ids(&txn, "l6"), ["l7", "x"]);
        assert!(common::child_ids(&txn, "l7").is_empty());
    }
    assert_eq!(
        blocks::value(&low.transact()).unwrap(),
        blocks::value(&high.transact()).unwrap()
    );
}

/// A too-deep block's subtree comes along flattened in document order, and
/// a block a callout may not hold goes to the next ancestor up that may.
#[test]
fn a_too_deep_subtree_flattens_in_order_under_an_ancestor_that_holds_it() {
    // Under l8 (level 8): a code block, then a list item with a child, all
    // past the cap: c, p, q in document order.
    let mut value = nested_list(8);
    value.extend([
        json!({"id": "c", "type": "code_block", "indent": 8, "children": [{"type": "code_line", "children": [{"text": "c"}]}]}),
        json!({"id": "p", "type": "p", "indent": 9, "listStyleType": "disc", "children": [{"text": "P"}]}),
        json!({"id": "q", "type": "p", "indent": 10, "listStyleType": "disc", "children": [{"text": "Q"}]}),
    ]);
    let doc = common::doc(&blocks::state_from_value(&value, 1).unwrap(), 5);
    assert_eq!(common::child_ids(&doc.transact(), "l8"), ["c", "p"]);
    {
        // l7 becomes a callout, which holds text blocks alone.
        let mut txn = doc.transact_mut();
        let blocks = common::blocks_map(&txn);
        let yrs::Out::YMap(l7) = yrs::Map::get(&blocks, &txn, "l7").unwrap() else {
            panic!()
        };
        yrs::Map::insert(&l7, &mut txn, "sys:flavour", "affine:callout");
    }
    let repairs = blocks::repair(&mut doc.transact_mut());
    assert_eq!(
        repairs,
        [
            Repair::TooDeep {
                id: "c".into(),
                parent: "l6".into()
            },
            Repair::TooDeep {
                id: "p".into(),
                parent: "l7".into()
            },
            Repair::TooDeep {
                id: "q".into(),
                parent: "l7".into()
            },
        ]
    );
    let txn = doc.transact();
    assert_eq!(common::child_ids(&txn, "l7"), ["l8", "p", "q"]);
    assert_eq!(common::child_ids(&txn, "l6"), ["l7", "c"]);
    assert!(common::child_ids(&txn, "p").is_empty());
}
