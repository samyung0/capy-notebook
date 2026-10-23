#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! Security regression (yrs GC neighbours, 2026-10-23): an item next to a
//! collected unit is collected, as in Yjs. Through a note room's admission,
//! apply and store, such an item adds nothing: admission's bound counts no
//! growth, the room holds it as a collected unit, and the stored state, its
//! log row and the projection keep the note's text. Fails if the fork's yrs
//! patch (`missing_dependency` in `third_party/yrs/src/update.rs`) is
//! reverted.
//!
//! Security regression (yrs overlap placement, 2026-10-23, phase 0 review):
//! yrs trims an incoming item that overlaps the room's held clock and places
//! the kept tail after the writer's own unit just before the held clock.
//! Admission reads the same place (through `ydoc::Incoming::landing`), so it
//! counts the tail's text and checks its content there. Fails if `landing` is
//! reverted.

use notes::limits::{Admission, Refusal, Validator, measure};
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

/// Client 10's "X" in the live paragraph (origin the space at 1:8, right origin
/// 1:9), admitted and applied. The room then holds client 10 up to clock 1, so
/// a client-10 update at clock 0 of length 2 overlaps: yrs keeps its tail after
/// this "X".
fn with_held_x(room: &Doc) {
    let update = ydoc::decode(&x_between(8, 9)).unwrap();
    assert!(matches!(
        Validator::new("note").admit(room, &update),
        Ok(Admission::Accepted)
    ));
    ydoc::apply(room, update).unwrap();
    assert_eq!(room.transact().state_vector().get(&ClientID::new(10)), 1);
}

fn note_room() -> Doc {
    let room = Doc::with_options(ydoc::doc_options(5));
    ydoc::replay(&room, NOTE, &[] as &[Vec<u8>]).unwrap();
    room
}

#[test]
fn an_overlap_items_text_is_counted_where_yrs_places_it() {
    // Row 1: "XY" of client 10 at clock 0, origin a collected unit (1:20),
    // right origin live (1:9). yrs trims it to "Y" after the held "X"; the
    // bound counts that text there.
    let u2: &[u8] = &[1, 1, 10, 0, 196, 1, 20, 1, 9, 2, 88, 89, 0];
    let room = note_room();
    with_held_x(&room);
    let growth = bound::update_growth(&room.transact(), u2).unwrap();
    assert!(growth.content_bytes >= 1, "the tail's text is counted");
    let update = ydoc::decode(u2).unwrap();
    assert!(matches!(
        Validator::new("note").admit(&room, &update),
        Ok(Admission::Accepted)
    ));
    ydoc::apply(&room, update).unwrap();
    let txn = room.transact();
    assert_eq!(txn.state_vector().get(&ClientID::new(10)), 2);
    let text = value(&txn)[0]["children"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        text.contains('Y'),
        "the tail lands in the paragraph: {text}"
    );
}

#[test]
fn an_overlap_items_non_text_content_is_refused() {
    // Rows 2 and 3: a ContentAny of client 10 at clock 0, length 2, that yrs
    // places in the paragraph text after the held "X". One has a collected
    // origin (1:20); the other's origin is the paragraph's id value (1:2).
    // Either way the tail is non-text in a note text and is refused there.
    let rows: [&[u8]; 2] = [
        &[1, 1, 10, 0, 200, 1, 20, 1, 9, 2, 119, 1, 88, 119, 1, 89, 0],
        &[
            1, 1, 10, 0, 136, 1, 2, 2, 119, 2, 115, 49, 119, 2, 122, 122, 0,
        ],
    ];
    for u2 in rows {
        let room = note_room();
        with_held_x(&room);
        let update = ydoc::decode(u2).unwrap();
        assert!(
            matches!(
                Validator::new("note").admit(&room, &update),
                Err(Refusal::Content(_))
            ),
            "the overlap tail's non-text content is refused",
        );
    }
}

#[test]
fn an_honest_merged_overlap_draft_is_admitted() {
    // A client that typed "X" then "Y" re-sends the merged run as one struct of
    // client 10 at clock 0, length 2, origin the live space (1:8): a draft
    // store does this with Y.mergeUpdates. The room holds "X" already, so it
    // overlaps; yrs keeps "Y" after "X". Admission accepts it and counts the
    // tail, the same with or without the overlap rule.
    let u2: &[u8] = &[1, 1, 10, 0, 196, 1, 8, 1, 9, 2, 88, 89, 0];
    let room = note_room();
    with_held_x(&room);
    let growth = bound::update_growth(&room.transact(), u2).unwrap();
    assert!(growth.content_bytes >= 1);
    let update = ydoc::decode(u2).unwrap();
    assert!(matches!(
        Validator::new("note").admit(&room, &update),
        Ok(Admission::Accepted)
    ));
    ydoc::apply(&room, update).unwrap();
    let txn = room.transact();
    assert_eq!(txn.state_vector().get(&ClientID::new(10)), 2);
    assert!(
        value(&txn)[0]["children"][0]["text"]
            .as_str()
            .unwrap()
            .contains('Y')
    );
}

#[test]
fn a_dependent_item_retried_after_its_dependency_is_collected() {
    // L1: client 11's item depends on client 10's, which integrates as
    // collected (its origin 1:20 is a collected unit). Delivered dependency
    // first, both collect, as Yjs reruns getMissing on retry. Delivered
    // dependent first, it waits in pending and the retry collects it too.
    let dependency: &[u8] = &x_between(20, 9); // client 10, origin collected 1:20
    let dependent: &[u8] = &[1, 1, 11, 0, 196, 10, 0, 1, 9, 1, 89, 0]; // origin 10:0, right 1:9
    let collected = |txn: &yrs::Transaction, client: u64| {
        let id = ID::new(ClientID::new(client), 0);
        txn.store().get_block_range(&id).unwrap().1.is_none()
    };
    // In order.
    let ordered = note_room();
    for u in [dependency, dependent] {
        ydoc::apply(&ordered, ydoc::decode(u).unwrap()).unwrap();
    }
    {
        let txn = ordered.transact();
        assert!(txn.store().pending_update().is_none());
        assert!(
            collected(&txn, 10) && collected(&txn, 11),
            "both collected in order"
        );
    }
    // Dependent first: it waits, then the dependency's arrival retries it.
    let reversed = note_room();
    ydoc::apply(&reversed, ydoc::decode(dependent).unwrap()).unwrap();
    assert!(
        reversed.transact().store().pending_update().is_some(),
        "the dependent waits for client 10",
    );
    ydoc::apply(&reversed, ydoc::decode(dependency).unwrap()).unwrap();
    let txn = reversed.transact();
    assert!(
        txn.store().pending_update().is_none(),
        "the retry clears pending"
    );
    assert!(
        collected(&txn, 10) && collected(&txn, 11),
        "both collected on retry"
    );
    assert_eq!(
        value(&txn),
        value(&ordered.transact()),
        "same as in-order delivery"
    );
}
