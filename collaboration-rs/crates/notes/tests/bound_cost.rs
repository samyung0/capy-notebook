#![allow(clippy::unwrap_used)] // Tests panic on a broken corpus.
//! The bound's cost on a select-all delete of a heavily corrected, formatted
//! note (plate REVIEW1 M1, the reviewer's probe-delete-all): one delete range
//! per surviving character, every text re-priced in the JS bound. Here the
//! delete set is searched, not scanned, and deleted blocks are skipped, so the
//! cost stays linear in the note. And `admit` on a long paste, whose
//! blocks chain each to the one before (notes REVIEW2 M5).
use std::time::{Duration, Instant};

use notes::limits::{Admission, Validator};
use notes::{bound, plate, slate_yjs};
use serde_json::json;
use ydoc::doc_options;
use yrs::types::Attrs;
use yrs::updates::decoder::Decode;
use yrs::{Any, Doc, ReadTxn, StateVector, Text, Transact, Update, Xml, XmlTextPrelim};

/// `paragraphs` blocks of 80 characters, bold at 5..15 and italic at 30..40,
/// with every other character deleted afterwards, then the update of a
/// client deleting everything.
fn corrected_note(paragraphs: u32) -> (Doc, Vec<u8>) {
    let writer = Doc::with_options(doc_options(7));
    writer.get_or_insert_text(plate::CONTENT_ROOT);
    {
        let mut txn = writer.transact_mut();
        let root = yrs::XmlTextRef::from(plate::content_root(&txn).unwrap());
        for index in 0..paragraphs {
            let block = root.insert_embed(&mut txn, index, XmlTextPrelim::default());
            block.insert_attribute(&mut txn, "type", Any::from("p"));
            block.insert(&mut txn, 0, &"ab".repeat(40));
            block.format(
                &mut txn,
                5,
                10,
                Attrs::from([("bold".into(), Any::Bool(true))]),
            );
            block.format(
                &mut txn,
                30,
                10,
                Attrs::from([("italic".into(), Any::Bool(true))]),
            );
        }
    }
    let blocks: Vec<yrs::XmlTextRef> = {
        let txn = writer.transact();
        plate::insert_delta(&plate::content_root(&txn).unwrap())
            .unwrap()
            .into_iter()
            .filter_map(|op| match op.insert {
                plate::Insert::Element(branch) => Some(yrs::XmlTextRef::from(branch)),
                plate::Insert::Text(_) => None,
            })
            .collect()
    };
    for block in &blocks {
        let mut txn = writer.transact_mut();
        let mut at = block.len(&txn);
        while at >= 2 {
            at -= 2;
            block.remove_range(&mut txn, at + 1, 1);
        }
    }

    let state = writer
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let room = Doc::with_options(doc_options(1));
    room.transact_mut()
        .apply_update(Update::decode_v1(&state).unwrap())
        .unwrap();
    let client = Doc::with_options(doc_options(9));
    client
        .transact_mut()
        .apply_update(Update::decode_v1(&state).unwrap())
        .unwrap();
    let update = {
        let mut txn = client.transact_mut();
        let root = yrs::XmlTextRef::from(plate::content_root(&txn).unwrap());
        let len = root.len(&txn);
        root.remove_range(&mut txn, 0, len);
        txn.encode_update_v1()
    };
    (room, update)
}

fn growth_time(paragraphs: u32) -> Duration {
    let (room, update) = corrected_note(paragraphs);
    let decoded = ydoc::decode(&update).unwrap();
    let ranges: usize = ydoc::Incoming::new(&decoded)
        .delete_ranges()
        .map(|(_, ranges)| ranges.len())
        .sum();
    assert!(ranges as u32 >= paragraphs * 40, "{ranges} delete ranges");
    let txn = room.transact();
    // The best of three runs.
    (0..3)
        .map(|_| {
            let start = Instant::now();
            let growth = bound::update_growth(&txn, &update).expect("a delete is bounded");
            let elapsed = start.elapsed();
            // Deleting adds nothing; the JS bound priced 12 bytes and 1 node
            // per deleted formatted paragraph.
            assert_eq!(
                (growth.content_bytes, growth.node_count, growth.max_depth),
                (0, 0, 0)
            );
            elapsed
        })
        .min()
        .unwrap_or_default()
}

#[test]
fn a_select_all_delete_is_bounded_in_linear_time() {
    let small = growth_time(1_000);
    let large = growth_time(4_000);
    eprintln!(
        "growth bound on a select-all delete: 1,000 paragraphs {small:?}, 4,000 paragraphs {large:?}"
    );
    // JS before the M1 fix: 3.2 s for 1,000 and 15.6 s for 2,000.
    assert!(large < Duration::from_millis(3_000), "{large:?}");
    // Four times the paragraphs in under eight times the time: linear passes
    // (about 4x release, 5x debug), quadratic (16x) does not.
    assert!(
        large < small * 8 + Duration::from_millis(20),
        "{small:?} -> {large:?}"
    );
}

/// A writer's paste of `blocks` paragraphs (two leaves each, as
/// `slate_yjs::insert_nodes` writes them, each block chained to the one
/// before) into a one-paragraph room whose validator holds a bound: the time
/// of `admit` alone, best of three.
fn paste_time(blocks: usize) -> Duration {
    let room = Doc::with_options(doc_options(1));
    room.get_or_insert_text(plate::CONTENT_ROOT);
    {
        let mut txn = room.transact_mut();
        let root = plate::content_root(&txn).unwrap();
        slate_yjs::insert_nodes(
            &mut txn,
            root,
            0,
            &[json!({ "type": "p", "id": "a", "children": [{ "text": "hello" }] })],
        );
    }
    let state = room
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let writer = Doc::with_options(doc_options(2));
    writer
        .transact_mut()
        .apply_update(Update::decode_v1(&state).unwrap())
        .unwrap();
    {
        let mut txn = writer.transact_mut();
        let root = plate::content_root(&txn).unwrap();
        let len = yrs::XmlTextRef::from(root).len(&txn);
        let nodes: Vec<_> = (0..blocks)
            .map(|i| json!({ "type": "p", "id": format!("b{i}"), "children": [{ "text": "x" }, { "text": "y", "bold": true }] }))
            .collect();
        slate_yjs::insert_nodes(&mut txn, root, len, &nodes);
    }
    let update = writer
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    let decoded = ydoc::decode(&update).unwrap();
    (0..5)
        .map(|_| {
            // A bound in place, as in a room that has measured once.
            let mut validator = Validator::default();
            let nothing = ydoc::decode(
                &room
                    .transact()
                    .encode_state_as_update_v1(&room.transact().state_vector()),
            )
            .unwrap();
            validator.admit(&room, &nothing).unwrap();
            let start = Instant::now();
            assert_eq!(
                validator.admit(&room, &decoded).unwrap(),
                Admission::Accepted
            );
            // Both sizes stay on the bound, no copy of the room.
            assert_eq!(validator.exact_checks, 1);
            start.elapsed()
        })
        .min()
        .unwrap_or_default()
}

#[test]
fn a_paste_is_admitted_in_linear_time() {
    // 2,400 blocks bound at 9,600 nodes: both sizes stay on the bound path.
    let small = paste_time(600);
    let large = paste_time(2_400);
    eprintln!("admit of a paste: 600 blocks {small:?}, 2,400 blocks {large:?}");
    // Four times the blocks in under ten times the time (best of five, the
    // other test of this file runs beside it): linear passes (about 5x
    // measured), quadratic (16x) does not. Before the memo, release: 184 ms
    // for 1,000 blocks and 734 ms for 2,000.
    assert!(
        large < small * 10 + Duration::from_millis(20),
        "{small:?} -> {large:?}"
    );
}
