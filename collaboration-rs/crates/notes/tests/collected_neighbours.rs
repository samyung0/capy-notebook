#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! Security regression (yrs GC neighbours, 2026-10-23): an item next to a
//! collected unit is collected, as in Yjs. Through a note room's admission,
//! apply and store, such an item adds nothing: admission's bound counts no
//! growth, the room holds it as a collected unit, and the stored state, its
//! log row and the projection keep the note's text. Fails if the fork's yrs
//! patch (`missing_dependency` in `third_party/yrs/src/update.rs`) is
//! reverted.

use notes::limits::{Admission, Validator, measure};
use notes::{bound, plate};
use serde_json::{Value, json};
use yrs::block::ClientID;
use yrs::{Doc, ID, ReadTxn, StateVector, Transact};

/// A note with one paragraph, "hel world" after deletions (clocks 3..14 of
/// client 1), then a deleted paragraph whose children are collected (clocks
/// 15..24).
const NOTE: &[u8] = &[
    1, 8, 1, 0, 7, 1, 7, 99, 111, 110, 116, 101, 110, 116, 6, 40, 0, 1, 0, 4, 116, 121, 112, 101,
    1, 119, 1, 112, 40, 0, 1, 0, 2, 105, 100, 1, 119, 2, 115, 49, 4, 0, 1, 0, 3, 104, 101, 108,
    129, 1, 5, 2, 132, 1, 7, 6, 32, 119, 111, 114, 108, 100, 129, 1, 0, 1, 0, 9, 1, 1, 2, 6, 2, 14,
    10,
];

/// One "X" of client 10 with origin and right origin at clocks of client 1.
fn x_between(origin: u8, right: u8) -> Vec<u8> {
    vec![1, 1, 10, 0, 196, 1, origin, 1, right, 1, 88, 0]
}

fn value<T: ReadTxn>(txn: &T) -> Value {
    Value::Array(plate::value(txn).unwrap())
}

#[test]
fn an_item_next_to_a_collected_unit_is_collected_in_a_note_room() {
    let note = json!([{ "type": "p", "id": "s1", "children": [{ "text": "hel world" }] }]);
    // A collected origin with a live right origin, and the reverse.
    for (origin, right) in [(20, 8), (8, 20)] {
        let room = Doc::with_options(ydoc::doc_options(5));
        ydoc::replay(&room, NOTE, &[] as &[Vec<u8>]).unwrap();
        let before = measure(&room.transact()).unwrap();
        let bytes = x_between(origin, right);
        let growth = bound::update_growth(&room.transact(), &bytes).unwrap();
        assert_eq!(growth.content_bytes, 0, "{origin}/{right}");
        let update = ydoc::decode(&bytes).unwrap();
        assert!(matches!(
            Validator::new("note").admit(&room, &update),
            Ok(Admission::Accepted)
        ));
        let row = ydoc::apply(&room, update).unwrap();

        let txn = room.transact();
        let id = ID::new(ClientID::new(10), 0);
        assert_eq!(txn.state_vector().get(&id.client), 1);
        assert!(txn.store().get_block_range(&id).unwrap().1.is_none());
        assert_eq!(value(&txn), note, "{origin}/{right}");
        assert_eq!(measure(&txn).unwrap(), before);
        let stored = txn.encode_state_as_update_v1(&StateVector::default());
        for (base, rows) in [(stored.as_slice(), Vec::new()), (NOTE, vec![row.clone()])] {
            let loaded = ydoc::scratch_doc();
            ydoc::replay(&loaded, base, &rows).unwrap();
            assert_eq!(value(&loaded.transact()), note, "{origin}/{right}");
        }
    }
}
