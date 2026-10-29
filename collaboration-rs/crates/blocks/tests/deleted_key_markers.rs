#![allow(clippy::unwrap_used)]
//! Whether a deleted block's key marker could live only on clients once the
//! server collected it (`blocks::unique_key`), re-sent by a tab that still
//! holds it along with its next write of that key; and the alternative of
//! re-keying a block the late merge leaves out. Yjs skips a struct below
//! its state vector the same way (`integrateStructs`, `encoding.js`).

mod common;

use serde_json::{Value, json};
use ydoc::gc::{UniqueKeys, Window, collect_with, names_collected};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ID, IdSet, Map, Out, ReadTxn, StateVector, Transact, Update, UpdateBlock};

const DELETER: u64 = 50;

fn value(ids: &[&str]) -> Vec<Value> {
    ids.iter()
        .map(|id| json!({"id": id, "type": "p", "children": [{"text": format!("Text of {id}")}]}))
        .collect()
}

fn live(doc: &Doc, id: &str) -> bool {
    let txn = doc.transact();
    common::blocks_map(&txn).get(&txn, id).is_some()
}

fn key_item(doc: &Doc, id: &str) -> ID {
    let txn = doc.transact();
    let Some(Out::YMap(block)) = common::blocks_map(&txn).get(&txn, id) else {
        panic!("no {id}");
    };
    *block.as_ref().item().unwrap().id()
}

fn keyed(doc: &Doc) -> Doc {
    let window = Window::of(&doc.transact(), 1);
    let unique: Option<UniqueKeys> = Some(&blocks::unique_key);
    let state = collect_with(doc, &window, &IdSet::new(), None, unique).state;
    common::doc(&state, 97)
}

/// R holds `a` and `b`, b's key written by `writers` in turn (each setting
/// it again, the last one `DELETER`) and then deleted; C is R collected with
/// the key rule. Returns R, C and the marker (b's last value).
fn room(writers: &[u64]) -> (Doc, Doc, ID) {
    let r = common::doc(&blocks::state_from_value(&value(&["a"]), 1).unwrap(), 2);
    for &client in writers {
        let w = common::doc(&common::state(&r), client);
        let before = w.transact().state_vector();
        if live(&w, "b") {
            // Set the key again (a rewrite of the block's map, as a paste
            // over a live id never is; it gives b's key a chain).
            let mut txn = w.transact_mut();
            common::blocks_map(&txn).insert(&mut txn, "b", yrs::MapPrelim::default());
        } else {
            common::add_paragraph(&mut w.transact_mut(), "b", "Bravo", blocks::NOTE_ID, 1);
        }
        common::apply(&r, &w.transact().encode_state_as_update_v1(&before));
    }
    let marker = key_item(&r, "b");
    let w = common::doc(&common::state(&r), 3);
    let before = w.transact().state_vector();
    {
        let mut txn = w.transact_mut();
        let at = common::child_ids(&txn, blocks::NOTE_ID)
            .iter()
            .position(|c| c == "b");
        if let Some(at) = at {
            yrs::Array::remove(
                &common::children(&txn, blocks::NOTE_ID),
                &mut txn,
                at as u32,
            );
        }
        common::blocks_map(&txn).remove(&mut txn, "b");
    }
    common::apply(&r, &w.transact().encode_state_as_update_v1(&before));
    let c = keyed(&r);
    assert!(!common::holds_key(&c.transact(), "b"));
    (r, c, marker)
}

/// A holder's update writing `b` again, re-sending b's marker: encoded
/// from just before the marker's clock, so the marker item rides along.
fn resend(holder: &Doc, c: &Doc, marker: ID) -> Vec<u8> {
    common::add_paragraph(
        &mut holder.transact_mut(),
        "b",
        "Pasted",
        blocks::NOTE_ID,
        1,
    );
    let mut lowered = StateVector::default();
    for (client, clock) in c.transact().state_vector().iter() {
        let clock = if *client == marker.client {
            marker.clock
        } else {
            *clock
        };
        lowered.set_max(*client, clock);
    }
    let update = holder.transact().encode_state_as_update_v1(&lowered);
    let decoded = Update::decode_v1(&update).unwrap();
    assert!(
        decoded
            .blocks()
            .any(|b| matches!(b, UpdateBlock::Item(i) if *i.id() == marker)),
        "the marker is in the update"
    );
    update
}

/// Case 1: yrs skips a re-sent marker: the collected range is below its state
/// vector, held as GC. The new value names the marker, so it integrates as
/// collected and the block is lost on the server and on a tab that loaded
/// after the collection, while the holder shows it.
#[test]
fn a_resent_marker_is_skipped_and_the_write_lost() {
    let (r, c, marker) = room(&[DELETER]);
    let holder = common::doc(&common::state(&r), 10);
    let late_tab = common::doc(&common::state(&c), 20);
    let update = resend(&holder, &c, marker);
    assert!(names_collected(
        &c.transact(),
        &Update::decode_v1(&update).unwrap()
    ));
    for doc in [&c, &late_tab] {
        common::apply(doc, &update);
        assert!(matches!(
            doc.transact().store().get_block_range(&marker),
            Some((_, None))
        ));
        assert!(!live(doc, "b"));
        assert!(!ydoc::has_pending(&doc.transact()));
    }
    assert!(live(&holder, "b"));
}

/// 2-3. Suppose resurrection worked as well as it can: the server writes
/// the re-sent marker back without its own origin, which a set key's
/// marker names and the server collected too (exactly what `collect` keeps
/// for a head with nothing behind it). A tab that loaded after the
/// collection writes `b` with no origin (D20 kept the id: it saw no live
/// block). The holder, with the whole chain, orders that value against the
/// chain's first value; the server against the marker alone. With b's key
/// set twice they disagree for some writers; set once, they agree.
#[test]
fn a_resurrected_marker_of_a_key_set_twice_still_orders_differently() {
    for (writers, expect_split) in [(&[DELETER][..], false), (&[30, DELETER][..], true)] {
        let mut split = Vec::new();
        for client in 1..100u64 {
            if [1, 2, 3, 30, DELETER].contains(&client) {
                continue;
            }
            let (r, c, _) = room(writers);
            // The resurrected server: the plain collection keeps the
            // marker, cut of its origin.
            let window = Window::of(&r.transact(), 1);
            let server = common::doc(
                &ydoc::gc::collect(&r, &window, &IdSet::new(), None).state,
                96,
            );
            let fresh = common::doc(&common::state(&c), client);
            let before = fresh.transact().state_vector();
            common::add_paragraph(&mut fresh.transact_mut(), "b", "Fresh", blocks::NOTE_ID, 1);
            let update = fresh.transact().encode_state_as_update_v1(&before);
            let holder = common::doc(&common::state(&r), 11);
            common::apply(&server, &update);
            common::apply(&holder, &update);
            if live(&server, "b") != live(&holder, "b") {
                split.push(client);
            }
        }
        println!("key set by {writers:?}: server and holder disagree for writers {split:?}");
        assert_eq!(!split.is_empty(), expect_split);
    }
}

/// Case 3: Resurrection everywhere would converge concurrent writes of the key
/// (a holder's, naming the marker, and an origin-less one), in either
/// order: every replica then holds the same items. But the server then
/// stores the marker again, and every replica that never saw it must take
/// it back from whichever holder writes first.
#[test]
fn with_the_marker_back_everywhere_concurrent_writes_converge() {
    for client in [5, 40, 60, 95] {
        let (r, c, _) = room(&[DELETER]);
        let holder = common::doc(&common::state(&r), 10);
        let before = holder.transact().state_vector();
        common::add_paragraph(&mut holder.transact_mut(), "b", "Held", blocks::NOTE_ID, 1);
        let held = holder.transact().encode_state_as_update_v1(&before);
        let fresh = common::doc(&common::state(&c), client);
        let before = fresh.transact().state_vector();
        common::add_paragraph(&mut fresh.transact_mut(), "b", "Fresh", blocks::NOTE_ID, 1);
        let unheld = fresh.transact().encode_state_as_update_v1(&before);
        let (one, two) = (
            common::doc(&common::state(&r), 12),
            common::doc(&common::state(&r), 13),
        );
        common::apply(&one, &unheld);
        common::apply(&one, &held);
        common::apply(&two, &held);
        common::apply(&two, &unheld);
        assert_eq!(
            blocks::blocks_json(&one.transact()),
            blocks::blocks_json(&two.transact())
        );
    }
}

/// Case 4: The alternative to the hidden block: the tab re-keys it, pasting it
/// again under a fresh id where its listing was, after the keyed merge.
/// Every replica, holders and late loaders, then agrees and shows it.
#[test]
fn rekeying_a_hidden_block_converges_everywhere() {
    for client in [10, 90] {
        let (r, c, _) = room(&[DELETER]);
        let holder_tab = common::doc(&common::state(&r), client);
        common::add_paragraph(
            &mut holder_tab.transact_mut(),
            "b",
            "Pasted",
            blocks::NOTE_ID,
            1,
        );
        let merged = late_merge::merge_keyed(
            &common::state(&holder_tab),
            &common::state(&c),
            &late_merge::BLOCKS,
        )
        .unwrap();
        assert!(merged.hidden.is_empty());
        assert_eq!(merged.rekeyed.len(), 1);
        let start = c.transact().state_vector();
        common::apply(&c, &merged.update);
        blocks::repair(&mut c.transact_mut());
        // The tab reloads on the merged document and pastes the reported
        // block again under a fresh id, at its listing's place.
        let tab = common::doc(&common::state(&c), client);
        let before = tab.transact().state_vector();
        common::repaste(
            &holder_tab,
            &mut tab.transact_mut(),
            &merged.rekeyed,
            &mut || "b-rekeyed".into(),
        );
        let pasted = tab.transact().encode_state_as_update_v1(&before);
        assert!(!names_collected(
            &c.transact(),
            &Update::decode_v1(&pasted).unwrap()
        ));
        common::apply(&c, &pasted);
        let took = c.transact().encode_state_as_update_v1(&start);
        let other_holder = common::doc(&common::state(&r), 77);
        let late_loader = common::doc(&common::state(&keyed(&r)), 78);
        for doc in [&other_holder, &late_loader] {
            common::apply(doc, &took);
        }
        let expected = blocks::blocks_json(&c.transact());
        for doc in [&c, &other_holder, &late_loader] {
            blocks::check(&doc.transact()).unwrap();
            assert_eq!(blocks::blocks_json(&doc.transact()), expected);
            assert_eq!(common::text_of(&doc.transact(), "b-rekeyed"), "Pasted");
            assert_eq!(
                common::child_ids(&doc.transact(), blocks::NOTE_ID),
                ["a", "b-rekeyed"]
            );
        }
    }
}
