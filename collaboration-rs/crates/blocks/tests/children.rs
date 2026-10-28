#![allow(clippy::unwrap_used)]
//! The children pass on a blocks room: what an update wrote, and the answer
//! repointing or dropping the blocks.

mod common;

use std::collections::BTreeMap;

use serde_json::json;
use yrs::updates::decoder::Decode;
use yrs::{Map as _, Out, ReadTxn, Transact};

fn seeded() -> yrs::Doc {
    let value = json!([
        {"id": "a", "type": "p", "children": [{"text": "A"}]},
        {"id": "i", "type": "img", "assetId": "asset_1", "children": [{"text": ""}]},
        {"id": "r", "type": "material_ref", "materialId": "mat_1", "refKind": "quiz", "children": [{"text": ""}]},
    ]);
    common::doc(
        &blocks::state_from_value(value.as_array().unwrap(), 1).unwrap(),
        2,
    )
}

fn prop(doc: &yrs::Doc, id: &str, key: &str) -> Option<String> {
    let txn = doc.transact();
    let Some(Out::YMap(block)) = common::blocks_map(&txn).get(&txn, id) else {
        return None;
    };
    block.get(&txn, key).map(|v| v.to_string(&txn))
}

/// A pasted image and reference (as one update) name their asset and block;
/// typing names nothing.
#[test]
fn a_paste_names_its_children() {
    let doc = seeded();
    let before = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        let blocks = common::blocks_map(&txn);
        for (id, key, value) in [
            ("i", "prop:sourceId", "asset_2"),
            ("r", "prop:materialId", "mat_2"),
        ] {
            let Some(Out::YMap(block)) = blocks.get(&txn, id) else {
                panic!()
            };
            block.insert(&mut txn, key, value);
        }
    }
    let update = doc.transact().encode_state_as_update_v1(&before);
    let update = yrs::Update::decode_v1(&update).unwrap();
    let writes = blocks::children::child_writes(&doc.transact(), &update).unwrap();
    assert_eq!(writes.asset_ids, ["asset_2"]);
    assert_eq!(writes.blocks, ["r"]);
    assert_eq!(
        blocks::children::material_refs(&doc.transact()),
        [("r".to_string(), "mat_2".to_string())]
    );

    let typed = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        let Some(Out::YMap(block)) = common::blocks_map(&txn).get(&txn, "a") else {
            panic!()
        };
        let Some(Out::YText(text)) = block.get(&txn, "prop:text") else {
            panic!()
        };
        yrs::Text::insert(&text, &mut txn, 1, "B");
    }
    let update = doc.transact().encode_state_as_update_v1(&typed);
    let update = yrs::Update::decode_v1(&update).unwrap();
    assert!(blocks::children::child_writes(&doc.transact(), &update).is_none());
}

/// The answer repoints a moved asset and reference, and drops a block whose
/// child is gone ("").
#[test]
fn the_answer_repoints_and_drops() {
    let doc = seeded();
    let assets = BTreeMap::from([("asset_1".to_string(), "asset_own".to_string())]);
    let refs = BTreeMap::from([("r".to_string(), "mat_copy".to_string())]);
    assert!(blocks::children::apply(
        &mut doc.transact_mut(),
        &assets,
        &refs
    ));
    assert_eq!(
        prop(&doc, "i", "prop:sourceId").as_deref(),
        Some("asset_own")
    );
    assert_eq!(
        prop(&doc, "r", "prop:materialId").as_deref(),
        Some("mat_copy")
    );
    blocks::check(&doc.transact()).unwrap();

    let gone = BTreeMap::from([("asset_own".to_string(), String::new())]);
    assert!(blocks::children::apply(
        &mut doc.transact_mut(),
        &gone,
        &BTreeMap::new()
    ));
    let txn = doc.transact();
    blocks::check(&txn).unwrap();
    assert_eq!(common::child_ids(&txn, "note"), ["a", "r"]);
}
