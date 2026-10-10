#![allow(clippy::unwrap_used)] // Tests panic on a broken corpus.
//! Traffic made by Yjs itself, the browser editor's CRDT (corpus/
//! yjs-traffic.cjs): reconnect diffs and Y.mergeUpdates bundles of one or
//! several writers. A real editor's update is never refused: each delivery
//! is admitted or, when the room cannot place it yet, unheld. Also the six
//! deliveries the round 8 placement replay refused or miscounted (notes
//! REVIEW4 M12, corpus/yjs-review4-pairs.json, each with its room state).
mod common;

use notes::limits::{Admission, Refusal, Validator};
use yrs::{Doc, ReadTxn, Transact};

fn room(state: &[u8]) -> Doc {
    let room = Doc::with_options(ydoc::doc_options(1));
    room.transact_mut()
        .apply_update(ydoc::decode(state).unwrap())
        .unwrap();
    room
}

/// The validator as the room task holds it: its bound seeded by a first
/// admission.
fn validator(room: &Doc) -> Validator {
    let mut validator = Validator::default();
    let nothing = room
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    validator
        .admit(room, &ydoc::decode(&nothing).unwrap())
        .unwrap();
    validator
}

#[test]
fn yjs_made_updates_are_never_refused() {
    let corpus = common::load("yjs-traffic");
    let (mut accepted, mut unheld, mut refused, mut tightened) = (0, 0, Vec::new(), 0);
    for (seed, record) in corpus["seeds"].as_array().unwrap().iter().enumerate() {
        let room = room(&common::bytes(&record["initial"]));
        let mut validator = validator(&room);
        for (index, delivery) in record["deliveries"].as_array().unwrap().iter().enumerate() {
            let bytes = common::bytes(&delivery["update"]);
            let admitted = validator.admit(&room, &ydoc::decode(&bytes).unwrap());
            match &admitted {
                Ok(Admission::Accepted) => accepted += 1,
                Ok(Admission::Unheld) => unheld += 1,
                // The generator inserts a block with no id and sets its type
                // in a later transaction; the note editor writes an element
                // with its type and id in one (REVIEW5 R2's key rule refuses
                // the rest). Counted; the room takes it below regardless.
                Err(Refusal::Content(what)) if *what == notes::limits::MISSING_KEY => {
                    tightened += 1;
                    validator.invalidate();
                }
                Err(error) => refused.push(format!(
                    "seed {seed} delivery {index} ({}): {error}",
                    delivery["kind"]
                )),
            }
            // As the generator's room did (Yjs keeps what it cannot place yet
            // pending, a server room never applies it).
            if delivery["applied"].as_bool().unwrap() {
                room.transact_mut()
                    .apply_update(ydoc::decode(&bytes).unwrap())
                    .unwrap();
            }
        }
    }
    eprintln!(
        "Yjs traffic ({}): {accepted} accepted, {unheld} unheld, {} refused, {tightened} without a key",
        corpus["yjs"],
        refused.len()
    );
    assert!(refused.is_empty(), "{refused:#?}");
    assert!(accepted > 1_000, "{accepted} accepted");

    let pairs = common::load("yjs-review4-pairs");
    for pair in pairs["pairs"].as_array().unwrap() {
        let room = room(&common::bytes(&pair["room"]));
        let mut validator = validator(&room);
        let admitted = validator.admit(
            &room,
            &ydoc::decode(&common::bytes(&pair["update"])).unwrap(),
        );
        // Placed and measured; the same generator's id-less blocks may meet
        // the key rule after that.
        assert!(
            admitted.is_ok()
                || matches!(&admitted, Err(Refusal::Content(what)) if *what == notes::limits::MISSING_KEY),
            "pair {}: {admitted:?}",
            pair["pair"]
        );
    }
}
