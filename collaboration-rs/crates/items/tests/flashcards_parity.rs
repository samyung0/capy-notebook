#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! Security regression (room reset as last resort, Epo 2026-10-19: an
//! admission/save parity test per format): whatever a flashcard set's
//! admission takes leaves a set the store takes, once the blank-card repair
//! ran (after an update that deletes, and at save). A sweep of every single
//! write and of every pair of writes from a seeded set, then seeded random
//! updates from two writers. A rule dropped from admission, or a store rule
//! admission does not follow, fails it with the writes that broke it.

use items::flashcards;
use items::{Admission, Kind, Validator};
use serde_json::{Value, json};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Array, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, Text, TextPrelim, Transact, Update,
};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

fn seed() -> Vec<Value> {
    vec![json!({
        "type": "flashcards",
        "id": "flashcards_1",
        "children": [
            { "type": "flashcard", "id": "c1", "image": { "assetId": "asset_1" }, "children": [
                { "type": "flashcard_front", "children": [{ "text": "Osmosis" }] },
                { "type": "flashcard_back", "children": [{ "text": "Water" }] },
            ] },
            { "type": "flashcard", "id": "c2", "children": [
                { "type": "flashcard_front", "children": [{ "text": "Diffusion" }] },
                { "type": "flashcard_back", "children": [{ "text": "" }] },
            ] },
        ],
    })]
}

fn doc_from(state: &[u8], client: u64) -> Doc {
    let doc = Doc::with_options(ydoc::doc_options(client));
    doc.transact_mut()
        .apply_update(Update::decode_v1(state).unwrap())
        .unwrap();
    doc
}

fn root(doc: &Doc) -> MapRef {
    doc.get_or_insert_map(flashcards::ROOT)
}

/// The card keys a document holds, in key order.
fn keys(doc: &Doc) -> Vec<String> {
    let root = root(doc);
    let txn = doc.transact();
    let mut keys: Vec<String> = root.keys(&txn).map(str::to_owned).collect();
    keys.sort();
    keys
}

fn card(doc: &Doc, key: &str) -> Option<MapRef> {
    match root(doc).get(&doc.transact(), key) {
        Some(Out::YMap(card)) => Some(card),
        _ => None,
    }
}

/// The values a key write puts on a card.
fn values() -> Vec<Any> {
    vec![
        Any::from("a5"),
        Any::from(""),
        Any::Null,
        Any::Bool(true),
        Any::Number(3.0),
        Any::from(vec![Any::from("x")]),
        Any::from(std::collections::HashMap::from([(
            "assetId".to_owned(),
            Any::from("asset_2"),
        )])),
        Any::from(std::collections::HashMap::from([(
            "assetId".to_owned(),
            Any::from(""),
        )])),
    ]
}

const CARD_KEYS: [&str; 8] = [
    "order", "front", "back", "image", "id", "answer", "type", "children",
];

type Write = Box<dyn Fn(&Doc)>;

/// Every single write on a set: per card key, each value set and the key
/// removed, a face replaced by a fresh text, text typed into a face and a
/// face filled past its cap; a card added well-formed, with an image, under a
/// bad key, without a face, with a plain face, as a plain value and holding a
/// nested map; a card deleted and every card deleted.
fn writes() -> Vec<(String, Write)> {
    let mut out: Vec<(String, Write)> = Vec::new();
    for key in CARD_KEYS {
        for value in values() {
            out.push((
                format!("card {key}={value:?}"),
                Box::new(move |doc| {
                    if let Some(first) = keys(doc).first().and_then(|key| card(doc, key)) {
                        first.insert(&mut doc.transact_mut(), key, value.clone());
                    }
                }),
            ));
        }
        out.push((
            format!("card unset {key}"),
            Box::new(move |doc| {
                if let Some(first) = keys(doc).first().and_then(|key| card(doc, key)) {
                    first.remove(&mut doc.transact_mut(), key);
                }
            }),
        ));
    }
    for face in ["front", "back"] {
        out.push((
            format!("{face} as a fresh text"),
            Box::new(move |doc| {
                if let Some(first) = keys(doc).first().and_then(|key| card(doc, key)) {
                    first.insert(&mut doc.transact_mut(), face, TextPrelim::new("fresh"));
                }
            }),
        ));
        for (what, text) in [
            ("typed", "s".to_owned()),
            ("past its cap", "x".repeat(flashcards_cap(face) + 1)),
        ] {
            out.push((
                format!("{face} {what}"),
                Box::new(move |doc| {
                    let Some(first) = keys(doc).first().and_then(|key| card(doc, key)) else {
                        return;
                    };
                    let mut txn = doc.transact_mut();
                    if let Some(Out::YText(face)) = first.get(&txn, face) {
                        face.insert(&mut txn, 0, &text);
                    }
                }),
            ));
        }
    }
    let new_card =
        |key: &'static str, image: Option<Any>, faces: bool, plain_face: bool| -> Write {
            Box::new(move |doc| {
                let root = root(doc);
                let mut txn = doc.transact_mut();
                let card = root.insert(&mut txn, key, MapPrelim::default());
                card.insert(&mut txn, "order", "b0");
                if faces {
                    if plain_face {
                        card.insert(&mut txn, "front", "plain");
                    } else {
                        card.insert(&mut txn, "front", TextPrelim::new("New"));
                    }
                    card.insert(&mut txn, "back", TextPrelim::new(""));
                }
                if let Some(image) = image.clone() {
                    card.insert(&mut txn, "image", image);
                }
            })
        };
    out.push(("a card".into(), new_card("c_new", None, true, false)));
    out.push((
        "a card with an image".into(),
        new_card(
            "c_img",
            Some(Any::from(std::collections::HashMap::from([(
                "assetId".to_owned(),
                Any::from("asset_3"),
            )]))),
            true,
            false,
        ),
    ));
    out.push((
        "a card with a null image".into(),
        new_card("c_null", Some(Any::Null), true, false),
    ));
    out.push((
        "a card under a bad key".into(),
        new_card("bad key!", None, true, false),
    ));
    out.push((
        "a card without faces".into(),
        new_card("c_bare", None, false, false),
    ));
    out.push((
        "a card with a plain face".into(),
        new_card("c_plain", None, true, true),
    ));
    out.push((
        "a plain value as a card".into(),
        Box::new(|doc| {
            root(doc).insert(&mut doc.transact_mut(), "c_value", "x");
        }),
    ));
    out.push((
        "a card holding a nested map".into(),
        Box::new(|doc| {
            let root = root(doc);
            let mut txn = doc.transact_mut();
            let card = root.insert(&mut txn, "c_nested", MapPrelim::default());
            card.insert(&mut txn, "order", "b1");
            card.insert(&mut txn, "front", TextPrelim::new("x"));
            card.insert(&mut txn, "back", TextPrelim::new("y"));
            let inner = card.insert(&mut txn, "extra", MapPrelim::default());
            inner.insert(&mut txn, "deep", "z");
        }),
    ));
    out.push((
        "a card holding a list".into(),
        Box::new(|doc| {
            let root = root(doc);
            let mut txn = doc.transact_mut();
            let card = root.insert(&mut txn, "c_list", MapPrelim::default());
            card.insert(&mut txn, "order", "b2");
            card.insert(&mut txn, "front", TextPrelim::new("x"));
            card.insert(&mut txn, "back", TextPrelim::new("y"));
            let list = card.insert(&mut txn, "list", yrs::ArrayPrelim::default());
            list.push_back(&mut txn, "z");
        }),
    ));
    out.push((
        "a card deleted".into(),
        Box::new(|doc| {
            if let Some(first) = keys(doc).first().cloned() {
                root(doc).remove(&mut doc.transact_mut(), &first);
            }
        }),
    ));
    out.push((
        "every card deleted".into(),
        Box::new(|doc| {
            let (keys, root) = (keys(doc), root(doc));
            let mut txn = doc.transact_mut();
            for key in keys {
                root.remove(&mut txn, &key);
            }
        }),
    ));
    out
}

fn flashcards_cap(face: &str) -> usize {
    if face == "front" {
        notes::catalog::CARD_FRONT_MAX
    } else {
        notes::catalog::CARD_BACK_MAX
    }
}

/// The store's check of a set room (the server's `validate`, limits apart).
fn stored(room: &Doc) -> Result<(), String> {
    let txn = room.transact();
    Kind::Flashcards.assert_roots(&txn)?;
    Kind::Flashcards.check_caps(&txn)?;
    let value = Kind::Flashcards.document_value(&txn);
    notes::material::assert_canonical(&value, "flashcards").map_err(|error| error.0)
}

/// One update reaching the room as the server takes it: admitted, applied,
/// the blank-card repair after a deletion, then the store's check with the
/// save repair once. `Ok(true)` admitted and stored, `Ok(false)` refused.
fn arrive(room: &Doc, update: &[u8]) -> Result<bool, String> {
    let decoded = Update::decode_v1(update).unwrap();
    let metrics = notes::limits::measure_value(&Kind::Flashcards.document_value(&room.transact()));
    let mut validator = Validator::new(Kind::Flashcards, Some(metrics));
    match validator.admit(room, &decoded) {
        Ok(Admission::Accepted) => {}
        Ok(Admission::Unheld) | Err(_) => return Ok(false),
    }
    let deletes = !decoded.delete_set().is_empty();
    room.transact_mut().apply_update(decoded).unwrap();
    if deletes {
        flashcards::repair(&mut room.transact_mut(), "card_entry");
    }
    if stored(room).is_err() {
        flashcards::repair(&mut room.transact_mut(), "card_save");
    }
    stored(room).map(|()| true)
}

/// What `write` on a copy of `room` sends.
fn edit(room: &Doc, client: u64, write: &Write) -> Vec<u8> {
    let state = room
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    let peer = doc_from(&state, client);
    let before = peer.transact().state_vector();
    write(&peer);
    peer.transact().encode_state_as_update_v1(&before)
}

/// Every single write, and every pair of writes (the second on the room the
/// first left), from the seeded set.
#[test]
fn every_write_and_pair_of_writes_leaves_a_set_the_store_takes() {
    let base = flashcards::state_from_value(&seed(), 1);
    let writes = writes();
    let (mut admitted, mut refused) = (0, 0);
    for (first_name, first) in &writes {
        let room = doc_from(&base, 1);
        match arrive(&room, &edit(&room, 2, first)) {
            Ok(true) => admitted += 1,
            Ok(false) => {
                refused += 1;
                continue;
            }
            Err(error) => panic!("`{first_name}` is admitted and the store refuses: {error}"),
        }
        let after = room
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        for (second_name, second) in &writes {
            let room = doc_from(&after, 1);
            if let Err(error) = arrive(&room, &edit(&room, 3, second)) {
                panic!(
                    "`{first_name}` then `{second_name}` are admitted and the store refuses: {error}"
                );
            }
        }
    }
    assert!(
        admitted > 0 && refused > 0,
        "{admitted} admitted, {refused} refused"
    );
}

/// Seeded random rounds: two writers forked from the room each make one to
/// three writes, then send them in turn.
#[test]
fn two_writers_leave_a_set_the_store_takes() {
    let writes = writes();
    let steps: usize = std::env::var("PARITY_STEPS")
        .ok()
        .and_then(|steps| steps.parse().ok())
        .unwrap_or(300);
    let seed_value: u64 = std::env::var("PARITY_SEED")
        .ok()
        .and_then(|seed| seed.parse().ok())
        .unwrap_or(7);
    let mut rng = Rng(seed_value.max(1));
    let room = doc_from(&flashcards::state_from_value(&seed(), 1), 1);
    for step in 0..steps {
        let state = room
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        let peers = [
            doc_from(&state, 10 + 2 * step as u64),
            doc_from(&state, 11 + 2 * step as u64),
        ];
        let mut log = Vec::new();
        let mut updates = Vec::new();
        for peer in &peers {
            let before = peer.transact().state_vector();
            for _ in 0..1 + rng.below(3) {
                let (name, write) = &writes[rng.below(writes.len())];
                write(peer);
                log.push(name.clone());
            }
            updates.push(peer.transact().encode_state_as_update_v1(&before));
        }
        for update in &updates {
            if let Err(error) = arrive(&room, update) {
                panic!(
                    "seed {seed_value} step {step}: {log:?} are admitted and the store refuses: {error}"
                );
            }
        }
    }
    // The run ends on a set the store takes and that holds a card.
    assert!(stored(&room).is_ok() && !keys(&room).is_empty());
}
