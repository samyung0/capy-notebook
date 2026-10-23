#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! Security regression (yrs overlap placement, 2026-10-23, phase 0 review):
//! a flashcard room places an incoming item that overlaps its held clock where
//! yrs integrates it — after the writer's own unit just before the held clock.
//! A ContentAny in that place is non-text in a card face and is refused there.
//! Fails if `ydoc::Incoming::landing` (used by `items::locate`) is reverted.

use items::flashcards;
use serde_json::{Value, json};
use ydoc::Incoming;
use yrs::block::ClientID;
use yrs::updates::decoder::Decode;
use yrs::{Doc, Map, Out, ReadTxn, Text, TextRef, Transact, Update};

fn set_value() -> Vec<Value> {
    vec![json!({
        "type": "flashcards",
        "id": "flashcards_1",
        "children": [
            face_card("A", "af", "ab"),
            face_card("B", "bf", "bb"),
        ],
    })]
}

fn face_card(id: &str, front: &str, back: &str) -> Value {
    json!({
        "type": "flashcard",
        "id": id,
        "children": [
            { "type": "flashcard_front", "children": [{ "text": front }] },
            { "type": "flashcard_back", "children": [{ "text": back }] },
        ],
    })
}

fn back(doc: &Doc, card: &str) -> TextRef {
    let root = doc.get_or_insert_map(flashcards::ROOT);
    let Some(Out::YMap(card)) = root.get(&doc.transact(), card) else {
        panic!("no card");
    };
    match card.get(&doc.transact(), "back") {
        Some(Out::YText(text)) => text,
        _ => panic!("no back"),
    }
}

#[test]
fn an_overlapping_item_is_checked_where_yrs_places_it() {
    // Seed with a known client (7), so its B-subtree is found once collected.
    let state = flashcards::state_from_value(&set_value(), 7);
    let room = Doc::with_options(ydoc::doc_options(1));
    let client = Doc::with_options(ydoc::doc_options(2));
    for doc in [&room, &client] {
        doc.transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
    }
    // Client 2 types into card A's back, so the room holds client 2 up to
    // clock 1: a client-2 update at clock 0 of length 2 overlaps.
    back(&client, "A").insert(&mut client.transact_mut(), 0, "z");
    let diff = client
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    room.transact_mut()
        .apply_update(Update::decode_v1(&diff).unwrap())
        .unwrap();
    assert_eq!(room.transact().state_vector().get(&ClientID::new(2)), 1);

    // Delete card B; its map, faces and their text become collected units of
    // the seed client 0.
    room.get_or_insert_map(flashcards::ROOT)
        .remove(&mut room.transact_mut(), "B");
    let collected = {
        let txn = room.transact();
        let store = txn.store();
        store
            .blocks_in(&ClientID::new(7), 0..u32::MAX)
            .find(|(_, item)| item.is_none())
            .map(|(range, _)| range.clock)
            .expect("a collected seed unit")
    };
    assert!(collected < 128, "clock fits one varint byte: {collected}");

    // A client-2 update at clock 0, length 2, overlapping the held clock, a
    // ContentAny whose declared origin is a collected seed unit (7, collected).
    // yrs trims it to the tail after client 2's own "z" in card A's back, where
    // a ContentAny is not plain text in a card face.
    let update = vec![
        1,
        1,
        2,
        0,
        136,
        7,
        collected as u8,
        2,
        119,
        1,
        113,
        119,
        1,
        114,
        0,
    ];
    let decoded = Update::decode_v1(&update).unwrap();
    let incoming = Incoming::new(&decoded);
    assert!(
        flashcards::admit_shapes(&room.transact(), &incoming).is_err(),
        "a ContentAny in the card face is refused",
    );
}
