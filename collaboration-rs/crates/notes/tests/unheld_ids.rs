#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! Security regression (yrs find-index, 2026-10-22): a writer's update whose
//! struct sits past what the room holds of its client is refused at
//! admission, and the passes that read an update's items in the room (the
//! children pass and the entry repair) look up only ids the room holds.

use notes::limits::{Admission, Validator};
use notes::{children, plate, repair};
use yrs::block::ClientID;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Text, Transact, Update, Xml, XmlTextRef};

const CLIENT: u64 = 7;

/// A room whose content root client 7 typed `typed` into, each piece at the
/// start, so each is a block of its own.
fn room(typed: &[&str]) -> Doc {
    let doc = Doc::with_options(ydoc::doc_options(CLIENT));
    let text = doc.get_or_insert_text(plate::CONTENT_ROOT);
    for piece in typed {
        text.insert(&mut doc.transact_mut(), 0, piece);
    }
    doc
}

/// Client 7's struct at `clock` alone: an asset id on the content root, a
/// ContentAny item.
fn asset_write_at(clock: u32) -> Update {
    let writer = Doc::with_options(ydoc::doc_options(CLIENT));
    let text = writer.get_or_insert_text(plate::CONTENT_ROOT);
    {
        let mut txn = writer.transact_mut();
        text.insert(&mut txn, 0, &"a".repeat(clock as usize));
        XmlTextRef::from(plate::content_root(&txn).unwrap()).insert_attribute(
            &mut txn,
            children::ASSET_KEY,
            "x",
        );
    }
    let mut since = StateVector::default();
    since.set_max(ClientID::new(CLIENT), clock);
    Update::decode_v1(&writer.transact().encode_state_as_update_v1(&since)).unwrap()
}

#[test]
fn an_update_past_what_the_room_holds_is_refused_and_not_looked_up() {
    // One unit at clock 0 and a struct at 5; three blocks (clocks 0, 1-3
    // and 4) and a struct far past them.
    for (typed, clock) in [(&["a"][..], 5), (&["a", "xyz", "b"][..], 1_000)] {
        let room = room(typed);
        let update = asset_write_at(clock);
        assert!(matches!(
            Validator::new("note").admit(&room, &update),
            Ok(Admission::Unheld)
        ));
        assert_eq!(children::child_writes(&room.transact(), &update), None);
        assert!(repair::on_entry(&mut room.transact_mut(), &update, "note").is_empty());
    }
}
