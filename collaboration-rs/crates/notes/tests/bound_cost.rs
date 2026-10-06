//! The bound's cost on a select-all delete of a heavily corrected, formatted
//! note (plate REVIEW1 M1, the reviewer's probe-delete-all): one delete range
//! per surviving character, every text re-priced in the JS bound. Here the
//! delete set is searched, not scanned, and deleted blocks are skipped, so the
//! cost stays linear in the note.
use std::time::{Duration, Instant};

use notes::{bound, plate};
use ydoc::doc_options;
use yrs::types::Attrs;
use yrs::updates::decoder::Decode;
use yrs::{Any, Doc, ReadTxn, StateVector, Text, Transact, Update, Xml, XmlTextPrelim};

/// `paragraphs` blocks of 80 characters, bold at 5..15 and italic at 30..40,
/// with every other character deleted afterwards, then the update of a
/// client deleting everything.
fn corrected_note(paragraphs: u32) -> (Doc, Vec<u8>) {
    let writer = Doc::with_options(doc_options(7));
    let content = writer.get_or_insert_text(plate::CONTENT_ROOT);
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
    drop(content);
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
    let ranges: usize = notes::update::Incoming::new(&decoded)
        .delete_ranges()
        .map(|(_, ranges)| ranges.len())
        .sum();
    assert!(ranges as u32 >= paragraphs * 40, "{ranges} delete ranges");
    let txn = room.transact();
    let start = Instant::now();
    let growth = bound::update_growth(&txn, &update).expect("a delete is bounded");
    let elapsed = start.elapsed();
    // Deleting adds nothing; the JS bound priced 12 bytes and 1 node per
    // deleted formatted paragraph.
    assert_eq!(
        (growth.content_bytes, growth.node_count, growth.max_depth),
        (0, 0, 0)
    );
    elapsed
}

#[test]
fn a_select_all_delete_is_bounded_in_linear_time() {
    let small = growth_time(1_000);
    let large = growth_time(2_000);
    eprintln!(
        "growth bound on a select-all delete: 1,000 paragraphs {small:?}, 2,000 paragraphs {large:?}"
    );
    // JS before the M1 fix: 3.2 s and 15.6 s.
    assert!(large < Duration::from_millis(1_500), "{large:?}");
    assert!(
        large < small * 4 + Duration::from_millis(50),
        "{small:?} -> {large:?}"
    );
}
