#![allow(clippy::unwrap_used)] // Tests panic on a broken fixture.
//! Flashcard set documents: projection and bootstrap, two writers merging,
//! the admit's shape and cap refusals (each with its work counted, never
//! timed: Epo 2026-10-08), and the server's own writes with their Undo.

use std::collections::HashMap;
use std::sync::Arc;

use items::flashcards::{self, Card};
use items::{Admission, Kind, Refusal, Validator};
use notes::edit::DocumentCommand;
use serde_json::{Value, json};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Text, TextPrelim, TextRef,
    Transact, Update, WriteTxn,
};

fn set_value(cards: &[(&str, &str, &str)]) -> Vec<Value> {
    vec![json!({
        "type": "flashcards",
        "id": "flashcards_1",
        "children": cards.iter().map(|(id, front, back)| json!({
            "type": "flashcard",
            "id": id,
            "children": [
                { "type": "flashcard_front", "children": [{ "text": front }] },
                { "type": "flashcard_back", "children": [{ "text": back }] },
            ],
        })).collect::<Vec<_>>(),
    })]
}

/// A room document holding `value`, plus a client copy of it.
fn room(value: &[Value]) -> (Doc, Doc) {
    let state = flashcards::state_from_value(value, 0);
    let room = Doc::with_options(ydoc::doc_options(1));
    let client = Doc::with_options(ydoc::doc_options(2));
    for doc in [&room, &client] {
        doc.transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
    }
    (room, client)
}

fn root(doc: &Doc) -> MapRef {
    doc.get_or_insert_map(flashcards::ROOT)
}

fn card(doc: &Doc, id: &str) -> MapRef {
    match root(doc).get(&doc.transact(), id) {
        Some(Out::YMap(card)) => card,
        _ => panic!("no card {id}"),
    }
}

fn face(doc: &Doc, id: &str, field: &str) -> TextRef {
    match card(doc, id).get(&doc.transact(), field) {
        Some(Out::YText(text)) => text,
        _ => panic!("no {field} on {id}"),
    }
}

/// What `client` holds that `room` lacks, as the client would send it.
fn diff(client: &Doc, room: &Doc) -> Vec<u8> {
    client
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector())
}

fn metrics(doc: &Doc) -> notes::limits::Metrics {
    notes::limits::measure_value(&Kind::Flashcards.document_value(&doc.transact()))
}

fn validator(doc: &Doc) -> Validator {
    Validator::new(Kind::Flashcards, Some(metrics(doc)))
}

/// Admits `update` into `doc` (applying it when accepted), with the walk
/// steps it took.
fn admit(validator: &mut Validator, doc: &Doc, update: &[u8]) -> (Result<Admission, Refusal>, u64) {
    let _ = ydoc::steps::take();
    let decoded = Update::decode_v1(update).unwrap();
    let result = validator.admit(doc, &decoded);
    let steps = ydoc::steps::take().total();
    if matches!(result, Ok(Admission::Accepted)) {
        doc.transact_mut()
            .apply_update(Update::decode_v1(update).unwrap())
            .unwrap();
    }
    (result, steps)
}

fn cards(doc: &Doc) -> Vec<Card> {
    flashcards::cards(&doc.transact())
}

#[test]
fn projection_round_trips_the_stored_set() {
    let value = set_value(&[
        ("c1", "Osmosis", "Water across a membrane"),
        ("c2", "Diffusion", ""),
    ]);
    let (doc, _) = room(&value);
    let got = cards(&doc);
    assert_eq!(
        got.iter()
            .map(|c| (c.id.as_str(), c.front.as_str(), c.back.as_str()))
            .collect::<Vec<_>>(),
        [
            ("c1", "Osmosis", "Water across a membrane"),
            ("c2", "Diffusion", "")
        ]
    );
    assert!(got[0].order < got[1].order);
    let projected = Kind::Flashcards.value(&doc.transact());
    assert!(notes::material::assert_canonical(&projected, "flashcards").is_ok());
    assert_eq!(flashcards::cards_from_value(&projected).len(), 2);
}

#[test]
fn blank_cards_stay_out_of_the_projection_but_one_card_remains() {
    let (doc, _) = room(&set_value(&[("c1", " ", ""), ("c2", "Front", "")]));
    let projected = Kind::Flashcards.value(&doc.transact());
    let ids: Vec<String> = flashcards::cards_from_value(&projected)
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(ids, ["c2"]);
    let (doc, _) = room(&set_value(&[("c1", "", "")]));
    let projected = Kind::Flashcards.value(&doc.transact());
    assert_eq!(flashcards::cards_from_value(&projected)[0].id, "c1");
    assert!(notes::material::assert_canonical(&projected, "flashcards").is_ok());
}

#[test]
fn two_writers_typing_in_one_card_merge_through_the_room() {
    let value = set_value(&[("c1", "Osmosis", "Water moves")]);
    let (room_doc, a) = room(&value);
    let b = Doc::with_options(ydoc::doc_options(3));
    let seed = diff(&room_doc, &b);
    b.transact_mut()
        .apply_update(Update::decode_v1(&seed).unwrap())
        .unwrap();
    let mut check = validator(&room_doc);
    // A types at the end of the back, B at its start, and B adds a card.
    face(&a, "c1", "back").insert(&mut a.transact_mut(), 11, " in");
    face(&b, "c1", "back").insert(&mut b.transact_mut(), 0, "Net: ");
    {
        let last = cards(&b).last().unwrap().order.clone();
        let set = root(&b);
        let mut txn = b.transact_mut();
        set.insert(
            &mut txn,
            "c2",
            MapPrelim::from([
                (
                    "order",
                    yrs::In::Any(Any::String(Arc::from(items::order::after(Some(&last))))),
                ),
                ("front", yrs::In::from(TextPrelim::new("Turgor"))),
                ("back", yrs::In::from(TextPrelim::new(""))),
            ]),
        );
    }
    for peer in [&a, &b] {
        let update = diff(peer, &room_doc);
        let (result, _) = admit(&mut check, &room_doc, &update);
        assert_eq!(result.unwrap(), Admission::Accepted);
    }
    for peer in [&a, &b] {
        let update = diff(&room_doc, peer);
        peer.transact_mut()
            .apply_update(Update::decode_v1(&update).unwrap())
            .unwrap();
    }
    assert_eq!(cards(&a), cards(&b));
    assert_eq!(cards(&a), cards(&room_doc));
    assert_eq!(cards(&a)[0].back, "Net: Water moves in");
    assert_eq!(cards(&a)[1].front, "Turgor");
    // Typing stays on the bound: no copy of the room.
    assert_eq!(check.exact_checks, 0);
}

/// One crafted client edit, refused with its reason; the walk it cost stays
/// a few steps per struct.
fn refused(edit: impl FnOnce(&Doc), reason: &str) {
    let (room_doc, client) = room(&set_value(&[("c1", "Front", "Back")]));
    edit(&client);
    let update = diff(&client, &room_doc);
    let structs = Update::decode_v1(&update).unwrap().blocks().count() as u64;
    let mut check = validator(&room_doc);
    let (result, steps) = admit(&mut check, &room_doc, &update);
    match result {
        Err(error) => assert!(
            error.to_string().contains(reason),
            "{error} does not say {reason}"
        ),
        Ok(admission) => panic!("{admission:?}: expected a refusal for {reason}"),
    }
    assert!(
        steps <= 64 * structs.max(1),
        "{steps} steps for {structs} structs"
    );
}

#[test]
fn shapes_no_editor_writes_are_refused() {
    refused(
        |doc| {
            root(doc).insert(&mut doc.transact_mut(), "c2", TextPrelim::new("x"));
        },
        "a card that is not a map",
    );
    refused(
        |doc| {
            root(doc).insert(&mut doc.transact_mut(), "bad id!", MapPrelim::default());
        },
        "a card id",
    );
    refused(
        |doc| {
            card(doc, "c1").insert(&mut doc.transact_mut(), "front", MapPrelim::default());
        },
        "a card face that is not a text",
    );
    refused(
        |doc| {
            card(doc, "c1").insert(&mut doc.transact_mut(), "colour", "red");
        },
        "a struct outside its shape",
    );
    refused(
        |doc| {
            card(doc, "c1").insert(&mut doc.transact_mut(), "order", "not a key!");
        },
        "an order that is not an order key",
    );
    refused(
        |doc| {
            card(doc, "c1").insert(
                &mut doc.transact_mut(),
                "image",
                Any::Map(Arc::new(HashMap::from([(
                    "url".to_owned(),
                    Any::String("https://x".into()),
                )]))),
            );
        },
        "an image that is not {assetId}",
    );
    // Go reads a blank asset id as none and refuses the projection
    // (`materialdoc` trims it), so the room refuses it first.
    refused(
        |doc| {
            card(doc, "c1").insert(
                &mut doc.transact_mut(),
                "image",
                Any::Map(Arc::new(HashMap::from([(
                    "assetId".to_owned(),
                    Any::String(" 	 ".into()),
                )]))),
            );
        },
        "an image that is not {assetId}",
    );
    refused(
        |doc| {
            let text = face(doc, "c1", "front");
            let attrs = HashMap::from([(Arc::from("bold"), Any::Bool(true))]);
            text.insert_with_attributes(&mut doc.transact_mut(), 0, "x", attrs);
        },
        "anything but plain text",
    );
    refused(
        |doc| {
            let text = face(doc, "c1", "back");
            text.insert_embed(&mut doc.transact_mut(), 0, MapPrelim::default());
        },
        "anything but plain text",
    );
    refused(
        |doc| {
            doc.get_or_insert_text("other")
                .insert(&mut doc.transact_mut(), 0, "x");
        },
        "a struct outside its shape",
    );
}

#[test]
fn a_back_past_two_thousand_characters_is_refused_at_once_or_bit_by_bit() {
    // One update past the cap.
    refused(
        |doc| {
            face(doc, "c1", "back").insert(&mut doc.transact_mut(), 0, &"é".repeat(2000));
        },
        "a flashcard back holds at most 2000 characters",
    );
    // Up to the cap in one update, past it in the next: the bound sends the
    // second to the exact check, which refuses it.
    let (room_doc, client) = room(&set_value(&[("c1", "Front", "")]));
    let mut check = validator(&room_doc);
    face(&client, "c1", "back").insert(&mut client.transact_mut(), 0, &"a".repeat(2000));
    let (result, _) = admit(&mut check, &room_doc, &diff(&client, &room_doc));
    assert_eq!(result.unwrap(), Admission::Accepted);
    face(&client, "c1", "back").insert(&mut client.transact_mut(), 0, "b");
    let (result, _) = admit(&mut check, &room_doc, &diff(&client, &room_doc));
    assert!(result.unwrap_err().to_string().contains("at most 2000"));
}

#[test]
fn blank_cards_count_against_the_document_limit() {
    let (room_doc, client) = room(&set_value(&[("c1", "Front", "Back")]));
    let mut check = validator(&room_doc);
    {
        let mut txn = client.transact_mut();
        let root = txn.get_or_insert_map(flashcards::ROOT);
        let mut key = items::order::after(None);
        // 10,500 blank cards (52,500 nodes): the projection leaves them out, the
        // limit does not.
        for i in 0..10_500 {
            key = items::order::after(Some(&key));
            root.insert(
                &mut txn,
                format!("blank_{i}"),
                MapPrelim::from([
                    ("order", yrs::In::Any(Any::String(Arc::from(key.as_str())))),
                    ("front", yrs::In::from(TextPrelim::new(""))),
                    ("back", yrs::In::from(TextPrelim::new(""))),
                ]),
            );
        }
    }
    let (result, _) = admit(&mut check, &room_doc, &diff(&client, &room_doc));
    match result {
        Err(Refusal::Limit { .. }) => {}
        other => panic!("expected a limit refusal, got {other:?}"),
    }
}

fn node(id: &str, front: &str, back: &str) -> Value {
    flashcards::card_node(&Card {
        id: id.into(),
        order: String::new(),
        front: front.into(),
        back: back.into(),
        image: None,
    })
}

#[test]
/// The agent's card commands, computed on a copy as the server does, land in
/// the room, and the room's Undo of them (`ydoc::undo`) brings the set back.
fn agent_card_commands_apply_and_undo_in_the_room() {
    let (doc, _) = room(&set_value(&[("c1", "A", "a"), ("c2", "B", "b")]));
    let commands = vec![
        DocumentCommand::ReplaceChild {
            parent_type: "flashcards".into(),
            node_id: "c1".into(),
            node: node("c1", "A2", "a2"),
        },
        DocumentCommand::InsertChild {
            parent_type: "flashcards".into(),
            after_node_id: Some("c1".into()),
            node: node("c3", "C", "c"),
        },
        DocumentCommand::RemoveChild {
            parent_type: "flashcards".into(),
            node_id: "c2".into(),
        },
    ];
    let copy = Doc::with_client_id(77);
    let whole = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    copy.transact_mut()
        .apply_update(Update::decode_v1(&whole).unwrap())
        .unwrap();
    let captured = {
        let mut txn = copy.transact_mut();
        Kind::Flashcards
            .apply_commands(&mut txn, &commands)
            .unwrap();
        ydoc::undo::Captured::of(&mut txn)
    };
    let update = copy
        .transact()
        .encode_state_as_update_v1(&doc.transact().state_vector());
    ydoc::undo::apply_kept(&doc, Update::decode_v1(&update).unwrap()).unwrap();
    let after: Vec<(String, String)> = cards(&doc).into_iter().map(|c| (c.id, c.front)).collect();
    assert_eq!(
        after,
        [("c1".into(), "A2".into()), ("c3".into(), "C".into())]
    );
    ydoc::undo::revert(&doc, captured.change(&doc)).unwrap();
    let restored: Vec<(String, String, String)> = cards(&doc)
        .into_iter()
        .map(|c| (c.id, c.front, c.back))
        .collect();
    assert_eq!(
        restored,
        [
            ("c1".into(), "A".into(), "a".into()),
            ("c2".into(), "B".into(), "b".into())
        ]
    );
}

#[test]
fn the_save_api_writes_only_what_differs() {
    let (room_doc, client) = room(&set_value(&[("c1", "Osmosis", "Water"), ("c2", "B", "b")]));
    // A peer types in c2's back while the save rewrites c1 and adds c3.
    face(&client, "c2", "back").insert(&mut client.transact_mut(), 1, "ee");
    let desired = flashcards::cards_from_value(&set_value(&[
        ("c1", "Osmosis!", "Water"),
        ("c2", "B", "b"),
        ("c3", "New", "card"),
    ]));
    let typed = diff(&client, &room_doc);
    flashcards::set_cards(&mut room_doc.transact_mut(), &desired);
    room_doc
        .transact_mut()
        .apply_update(Update::decode_v1(&typed).unwrap())
        .unwrap();
    let got: Vec<(String, String, String)> = cards(&room_doc)
        .into_iter()
        .map(|c| (c.id, c.front, c.back))
        .collect();
    assert_eq!(
        got,
        [
            ("c1".into(), "Osmosis!".into(), "Water".into()),
            ("c2".into(), "B".into(), "bee".into()),
            ("c3".into(), "New".into(), "card".into())
        ]
    );
    // A reorder rewrites the keys and keeps every card.
    let reordered = flashcards::cards_from_value(&set_value(&[
        ("c3", "New", "card"),
        ("c1", "Osmosis!", "Water"),
    ]));
    flashcards::set_cards(&mut room_doc.transact_mut(), &reordered);
    let ids: Vec<String> = cards(&room_doc).into_iter().map(|c| c.id).collect();
    assert_eq!(ids, ["c3", "c1"]);
    let state = room_doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    assert!(!state.is_empty());
}

/// Security regression (room reset as last resort, Epo 2026-10-19): two
/// writers each delete one of a set's last two cards, as people editing
/// together do. Both go in, and the emptied set gets a blank card as the
/// second arrives (the entry repair), where the store refused a set with no
/// card and reset the room. Fails if the repair is reverted.
#[test]
fn an_emptied_set_gets_a_blank_card() {
    let (room, a) = room(&set_value(&[("c1", "One", "1"), ("c2", "Two", "2")]));
    let b = Doc::with_options(ydoc::doc_options(3));
    b.transact_mut()
        .apply_update(Update::decode_v1(&diff(&a, &Doc::new())).unwrap())
        .unwrap();
    root(&a).remove(&mut a.transact_mut(), "c1");
    root(&b).remove(&mut b.transact_mut(), "c2");
    let mut validator = validator(&room);
    for writer in [&a, &b] {
        let (result, _) = admit(&mut validator, &room, &diff(writer, &room));
        assert!(matches!(result, Ok(Admission::Accepted)));
        flashcards::repair(&mut room.transact_mut(), "card_fresh");
        let value = Kind::Flashcards.document_value(&room.transact());
        notes::material::assert_canonical(&value, "flashcards").unwrap();
    }
    let left = cards(&room);
    assert_eq!(left.len(), 1);
    assert!(left[0].front.is_empty() && left[0].back.is_empty());
    assert_eq!(left[0].id, "card_fresh");
    // A set holding a card is left alone.
    assert!(!flashcards::repair(&mut room.transact_mut(), "card_other"));
}
