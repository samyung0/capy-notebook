//! The late merge on small hand-made documents: where a run lands next to
//! collected units, the snap to the end of a deleted run, the tab's own ids,
//! held units skipped, a map value on a collected origin, repeats, refusals,
//! the re-authored mode (the same places under a newly assigned id), the
//! blocks holding what a merge would hide, and the cost of structs claiming
//! near-maximal lengths.
#![allow(clippy::unwrap_used)] // Tests panic on a broken case.

mod support;

use std::time::Duration;

use notes::plate;
use notes::slate::Operation;
use serde_json::json;
use support::collect::collect;
use support::note::{Note, paragraph};
use yrs::block::{ClientID, ItemContent};
use yrs::branch::BranchPtr;
use yrs::encoding::write::Write;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::{Encoder, EncoderV1};
use yrs::{
    Any, Array, Doc, GetString, ID, IdSet, Map, Out, ReadTxn, StateVector, Text, TextPrelim,
    Transact, Update, UpdateBlock, Xml, XmlTextRef,
};

fn id(client: u64, clock: u32) -> ID {
    ID::new(ClientID::new(client), clock)
}

fn doc(client: u64) -> Doc {
    Doc::with_options(ydoc::doc_options(client))
}

fn state(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn sync(from: &Doc, to: &Doc) {
    let sv = to.transact().state_vector();
    let diff = from.transact().encode_state_as_update_v1(&sv);
    to.transact_mut()
        .apply_update(Update::decode_v1(&diff).unwrap())
        .unwrap();
}

fn apply(to: &Doc, update: &[u8]) {
    to.transact_mut()
        .apply_update(Update::decode_v1(update).unwrap())
        .unwrap();
}

fn text(doc: &Doc) -> String {
    doc.get_or_insert_text("t").get_string(&doc.transact())
}

/// Types `chunk` at `index` of the text as client `client`, into `room`.
fn type_as(room: &Doc, client: u64, index: u32, chunk: &str) {
    let writer = doc(client);
    sync(room, &writer);
    let t = writer.get_or_insert_text("t");
    t.insert(&mut writer.transact_mut(), index, chunk);
    sync(&writer, room);
}

/// `room` collected at its own state (no session counted).
fn collected(room: &Doc) -> Doc {
    let (sv, ds) = {
        let txn = room.transact();
        (txn.state_vector(), txn.snapshot().delete_set)
    };
    let out = doc(1);
    apply(&out, &collect(room, &sv, &ds, &IdSet::new()));
    out
}

/// The update's items: (id, origin, right origin).
fn items(update: &[u8]) -> Vec<(ID, Option<ID>, Option<ID>)> {
    let update = Update::decode_v1(update).unwrap();
    update
        .blocks()
        .filter_map(|block| match block {
            UpdateBlock::Item(item) => Some((
                *item.id(),
                item.origin().copied(),
                item.right_origin().copied(),
            )),
            _ => None,
        })
        .collect()
}

/// `L a b c R` with a, b and c separate blocks and b named by nobody: a
/// typed, then c after a, then b between them. A tab holds it and goes
/// offline; the room deletes a b c and collects b.
fn room_and_tab() -> (Doc, Doc) {
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "LR");
    type_as(&room, 3, 1, "a");
    type_as(&room, 5, 2, "c");
    type_as(&room, 4, 2, "b");
    assert_eq!(text(&room), "LabcR");
    let tab = doc(2);
    sync(&room, &tab);
    room.get_or_insert_text("t")
        .remove_range(&mut room.transact_mut(), 1, 3);
    (room, tab)
}

#[test]
fn a_run_after_a_collected_unit_lands_at_the_end_of_its_deleted_run() {
    let (room, tab) = room_and_tab();
    // The tab types between b and c: X names b, which the room collects.
    tab.get_or_insert_text("t")
        .insert(&mut tab.transact_mut(), 3, "X");
    let current = collected(&room);
    let b = id(4, 0);
    assert!(
        current.transact().store().get_item(&b).is_none(),
        "b is collected"
    );
    let update = late_merge::merge(&state(&tab), &state(&current))
        .unwrap()
        .update;
    // After a (b's nearest held left neighbour), snapped past the deleted
    // run to after c, before R.
    let (c, r) = (id(5, 0), id(1, 1));
    assert_eq!(items(&update), vec![(id(2, 0), Some(c), Some(r))]);
    // Re-authored under the tab's new id 9: the same place.
    let fresh = collected(&room);
    let reauthored = late_merge::reauthor(&state(&tab), &state(&fresh), 9)
        .unwrap()
        .update;
    assert_eq!(items(&reauthored), vec![(id(9, 0), Some(c), Some(r))]);
    apply(&fresh, &reauthored);
    assert_eq!(text(&fresh), "LXR");
    apply(&current, &update);
    assert_eq!(text(&current), "LXR");
}

#[test]
fn the_merged_update_keeps_the_tabs_own_ids() {
    let (room, tab) = room_and_tab();
    let t = tab.get_or_insert_text("t");
    t.insert(&mut tab.transact_mut(), 1, "hello ");
    t.insert(&mut tab.transact_mut(), 0, "> ");
    let current = collected(&room);
    let update = late_merge::merge(&state(&tab), &state(&current))
        .unwrap()
        .update;
    let mut ids: Vec<ID> = items(&update).into_iter().map(|(id, _, _)| id).collect();
    ids.sort_by_key(|id| id.clock);
    assert_eq!(ids, vec![id(2, 0), id(2, 6)]);
    apply(&current, &update);
    assert_eq!(text(&current), "> Lhello R");
}

#[test]
fn sending_again_or_merging_again_changes_nothing() {
    let (room, tab) = room_and_tab();
    tab.get_or_insert_text("t")
        .insert(&mut tab.transact_mut(), 3, "X");
    let current = collected(&room);
    let update = late_merge::merge(&state(&tab), &state(&current))
        .unwrap()
        .update;
    apply(&current, &update);
    let taken = state(&current);
    apply(&current, &update);
    assert_eq!(state(&current), taken);
    let again = late_merge::merge(&state(&tab), &taken).unwrap().update;
    assert!(items(&again).is_empty(), "a second merge sends no item");
    apply(&current, &again);
    assert_eq!(state(&current), taken);
}

#[test]
fn units_the_room_already_holds_are_skipped() {
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "ab");
    let tab = doc(2);
    sync(&room, &tab);
    let t = tab.get_or_insert_text("t");
    t.insert(&mut tab.transact_mut(), 1, "X");
    // The room stored X; the tab never heard (its acknowledgement was lost).
    sync(&tab, &room);
    t.insert(&mut tab.transact_mut(), 2, "Y");
    let update = late_merge::merge(&state(&tab), &state(&room))
        .unwrap()
        .update;
    assert_eq!(
        items(&update),
        vec![(id(2, 1), Some(id(2, 0)), Some(id(1, 1)))]
    );
    apply(&room, &update);
    assert_eq!(text(&room), "aXYb");
}

#[test]
fn a_map_value_over_a_collected_one_follows_the_keys_current_value() {
    let room = doc(1);
    let set = |client: u64, value: i64| {
        let writer = doc(client);
        sync(&room, &writer);
        writer
            .get_or_insert_map("m")
            .insert(&mut writer.transact_mut(), "k", value);
        sync(&writer, &room);
    };
    set(3, 1);
    set(4, 2);
    let tab = doc(2);
    sync(&room, &tab);
    // The tab's write names 4:0; the room writes over it twice and collects
    // what is behind its head.
    tab.get_or_insert_map("m")
        .insert(&mut tab.transact_mut(), "k", "tab");
    set(5, 3);
    set(6, 4);
    let current = collected(&room);
    assert!(current.transact().store().get_item(&id(4, 0)).is_none());
    let update = late_merge::merge(&state(&tab), &state(&current))
        .unwrap()
        .update;
    assert_eq!(items(&update), vec![(id(2, 0), Some(id(6, 0)), None)]);
    let reauthored = late_merge::reauthor(&state(&tab), &state(&current), 9)
        .unwrap()
        .update;
    assert_eq!(items(&reauthored), vec![(id(9, 0), Some(id(6, 0)), None)]);
    apply(&current, &update);
    let value = current.get_or_insert_map("m").get(&current.transact(), "k");
    assert_eq!(value, Some(Out::Any(Any::from("tab"))));
}

/// The room's admission of a client id binding: structs past what the room
/// holds, under an id not assigned to the writer, refuse the update.
fn refused_as_is(update: &[u8], room: &Doc, assigned: &[u64]) -> bool {
    let held = room.transact().state_vector();
    Update::decode_v1(update).unwrap().blocks().any(|block| {
        let (client, end) = match block {
            UpdateBlock::Item(item) => (item.id().client, item.id().clock + item.len()),
            UpdateBlock::Gc(r) | UpdateBlock::Skip(r) => (r.client, r.clock + r.len),
        };
        end > held.get(&client) && !assigned.contains(&client.get())
    })
}

#[test]
fn edits_under_an_unassigned_id_refused_as_they_are_go_in_reauthored() {
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "ab");
    // The tab wrote under 2, an id the room never assigned (or no longer
    // holds): it types XYZ, removes its own Z and the room's b.
    let tab = doc(2);
    sync(&room, &tab);
    let t = tab.get_or_insert_text("t");
    t.insert(&mut tab.transact_mut(), 1, "XYZ");
    t.remove_range(&mut tab.transact_mut(), 3, 2);
    assert_eq!(text(&tab), "aXY");
    let assigned = [1, 9];
    let as_is = late_merge::merge(&state(&tab), &state(&room))
        .unwrap()
        .update;
    assert!(refused_as_is(&as_is, &room, &assigned));
    // Its newly assigned id is 9: the same edits, all of them under it.
    let reauthored = late_merge::reauthor(&state(&tab), &state(&room), 9)
        .unwrap()
        .update;
    assert!(!refused_as_is(&reauthored, &room, &assigned));
    assert!(
        items(&reauthored)
            .iter()
            .all(|(id, _, _)| id.client.get() == 9)
    );
    apply(&room, &reauthored);
    assert_eq!(text(&room), "aXY");
    assert!(room.transact().store().pending_update().is_none());
}

#[test]
fn input_that_is_not_yjs_is_refused() {
    let (room, _) = room_and_tab();
    let good = state(&room);
    for (old, current) in [(&b"not yjs"[..], &good[..]), (&good[..], &b"\x05"[..])] {
        assert!(matches!(
            late_merge::merge(old, current),
            Err(late_merge::Refused::Decode(_))
        ));
    }
}

/// One struct of `client` at clock 0 claiming `len` units, as a collaborator
/// may plant it (the room admits it): a deleted item at the head of the
/// text `t`, or a GC struct.
fn planted(client: u64, len: u32, deleted_item: bool) -> Vec<u8> {
    let mut enc = EncoderV1::new();
    enc.write_var(1u32);
    enc.write_var(1u32);
    enc.write_client(ClientID::new(client));
    enc.write_var(0u32);
    if deleted_item {
        // Content 1 (deleted), no origins: the parent is named.
        enc.write_info(1);
        enc.write_parent_info(true);
        enc.write_string("t");
    } else {
        enc.write_info(0);
    }
    enc.write_len(len);
    // No delete set.
    enc.write_var(0u32);
    enc.to_vec()
}

/// `work` finishes within `seconds`, or the test fails then.
fn in_time<T: Send + 'static>(seconds: u64, work: impl FnOnce() -> T + Send + 'static) -> T {
    let (done, answer) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = done.send(work());
    });
    answer
        .recv_timeout(Duration::from_secs(seconds))
        .expect("the merge finishes in time")
}

#[test]
fn structs_claiming_near_maximal_lengths_cost_what_their_bytes_cost() {
    const HUGE: u32 = u32::MAX - 1;
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "LR");
    // Planted in the room by collaborators: a deleted item and a GC struct.
    apply(&room, &planted(7, HUGE, true));
    apply(&room, &planted(8, HUGE, false));
    let tab = doc(2);
    sync(&room, &tab);
    tab.get_or_insert_text("t")
        .insert(&mut tab.transact_mut(), 1, "X");
    // And unsent in the tab's own document (a hand-made draft).
    apply(&tab, &planted(9, HUGE, true));
    apply(&tab, &planted(10, HUGE, false));
    let (old, current) = (state(&tab), state(&room));
    let (merged, reauthored) = in_time(10, move || {
        (
            late_merge::merge(&old, &current).unwrap(),
            late_merge::reauthor(&old, &current, 11).unwrap(),
        )
    });
    let (l, r) = (id(1, 0), id(1, 1));
    assert_eq!(items(&merged.update), vec![(id(2, 0), Some(l), Some(r))]);
    assert_eq!(
        items(&reauthored.update),
        vec![(id(11, 0), Some(l), Some(r))]
    );
    assert!(merged.hidden.is_empty() && reauthored.hidden.is_empty());
    apply(&room, &merged.update);
    assert_eq!(text(&room), "LXR");
}

#[test]
fn reauthored_clocks_running_past_the_largest_one_are_refused() {
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "LR");
    // The room holds the assigned id 11 up to its second-last clock.
    apply(&room, &planted(11, u32::MAX - 1, false));
    let tab = doc(2);
    sync(&room, &tab);
    tab.get_or_insert_text("t")
        .insert(&mut tab.transact_mut(), 1, "XY");
    assert!(matches!(
        late_merge::reauthor(&state(&tab), &state(&room), 11),
        Err(late_merge::Refused::Shape(_))
    ));
}

/// The top-level element at `index` of a note: its item id and its type.
fn element(doc: &Doc, index: usize) -> (ID, XmlTextRef) {
    let txn = doc.transact();
    let root = plate::content_root(&txn).unwrap();
    let mut next = root.start();
    let mut seen = 0;
    while let Some(item) = next {
        next = item.right();
        if item.is_deleted() {
            continue;
        }
        if let ItemContent::Type(inner) = item.content() {
            if seen == index {
                return (
                    *item.id(),
                    XmlTextRef::from(BranchPtr::from(inner.as_ref())),
                );
            }
            seen += 1;
        }
    }
    panic!("no element {index}");
}

/// The note's top-level block at `index` removed, as a peer deletes it (a
/// tombstone, not collected).
fn remove_block(note: &mut Note, index: usize) {
    let node = note.root.children[index].clone();
    note.apply(&[Operation::RemoveNode {
        path: vec![index],
        node,
    }]);
}

#[test]
fn text_typed_into_a_collected_block_names_its_block() {
    let room = doc(1);
    let a = room.get_or_insert_array("a");
    a.insert(&mut room.transact_mut(), 0, "p1");
    a.insert(&mut room.transact_mut(), 1, "p2");
    // The block between, named by neither neighbour.
    a.insert(&mut room.transact_mut(), 1, TextPrelim::new("abc"));
    let tab = doc(2);
    sync(&room, &tab);
    {
        let a = tab.get_or_insert_array("a");
        let Some(Out::YText(block)) = a.get(&tab.transact(), 1) else {
            panic!("the block is a text");
        };
        block.insert(&mut tab.transact_mut(), 3, "XY");
    }
    // The room deletes all three; the collection discards the block.
    a.remove_range(&mut room.transact_mut(), 0, 3);
    let current = collected(&room);
    let merged = late_merge::merge(&state(&tab), &state(&current)).unwrap();
    assert_eq!(merged.hidden, vec![id(1, 2)]);
    assert!(items(&merged.update).is_empty());
    let reauthored = late_merge::reauthor(&state(&tab), &state(&current), 9).unwrap();
    assert_eq!(reauthored.hidden, vec![id(1, 2)]);
    assert!(items(&reauthored.update).is_empty());
}

/// Re-authored edits (the route for ids the room never recorded, review r3
/// M3) keep what the tab made: typed text, a mark over it and a new block,
/// every piece under the assigned id, the note reading as the tab's.
#[test]
fn reauthored_edits_keep_text_marks_and_new_blocks() {
    let mut room = Note::new(1, "s");
    room.apply(&[Operation::InsertNode {
        path: vec![1],
        node: paragraph("s2", "abc"),
    }]);
    let mut tab = Note::load(2, "t", &room.state());
    let typing = tab.insert_ops(1, 3, " typed");
    tab.apply(&typing);
    let bold = tab.format_ops(1, 0, 3, "bold", true);
    tab.apply(&bold);
    let enter = tab.split_ops(1, 5);
    tab.apply(&enter);
    let reauthored = late_merge::reauthor(&tab.state(), &room.state(), 9).unwrap();
    assert!(reauthored.hidden.is_empty());
    let pieces = items(&reauthored.update);
    assert!(!pieces.is_empty());
    assert!(
        pieces.iter().all(|(id, ..)| id.client.get() == 9),
        "{pieces:?}"
    );
    let mut after = Note::load(3, "x", &room.state());
    after.receive(&reauthored.update);
    assert_eq!(after.value(), tab.value());
    assert!(after.value().contains("bold"), "{}", after.value());
}

#[test]
fn text_typed_into_a_block_a_peer_deleted_names_its_block() {
    let mut room = Note::new(1, "s");
    room.apply(&[Operation::InsertNode {
        path: vec![1],
        node: paragraph("s2", "abc"),
    }]);
    let mut tab = Note::load(2, "t", &room.state());
    let (block, _) = element(&tab.doc, 1);
    let typing = tab.insert_ops(1, 3, "XY");
    tab.apply(&typing);
    remove_block(&mut room, 1);
    for merged in [
        late_merge::merge(&tab.state(), &room.state()).unwrap(),
        late_merge::reauthor(&tab.state(), &room.state(), 9).unwrap(),
    ] {
        assert_eq!(merged.hidden, vec![block]);
        // The update still carries the text, into the deleted block, where
        // it does not show.
        let mut after = Note::load(3, "x", &room.state());
        after.receive(&merged.update);
        assert!(!after.value().contains("XY"));
    }
}

#[test]
fn a_block_typed_into_a_container_a_peer_deleted_names_the_container() {
    let mut room = Note::new(1, "s");
    room.apply(&[Operation::InsertNode {
        path: vec![1],
        node: json!({"type": "callout", "id": "c", "children": [paragraph("c1", "in")]}),
    }]);
    let mut tab = Note::load(2, "t", &room.state());
    let (container, _) = element(&tab.doc, 1);
    tab.apply(&[Operation::InsertNode {
        path: vec![1, 1],
        node: paragraph("t1", "new words"),
    }]);
    remove_block(&mut room, 1);
    for merged in [
        late_merge::merge(&tab.state(), &room.state()).unwrap(),
        late_merge::reauthor(&tab.state(), &room.state(), 9).unwrap(),
    ] {
        assert_eq!(merged.hidden, vec![container]);
    }
}

#[test]
fn attributes_written_in_blocks_a_peer_deleted_name_their_blocks() {
    let mut room = Note::new(1, "s");
    let mermaid = room.mermaid();
    room.apply(&[
        Operation::InsertNode {
            path: vec![1],
            node: mermaid,
        },
        Operation::InsertNode {
            path: vec![2],
            node: json!({"type": "html_embed", "id": "h", "html": "<b>x</b>", "caption": "old", "children": [{"text": ""}]}),
        },
    ]);
    let tab = Note::load(2, "t", &room.state());
    let (diagram, source_of) = element(&tab.doc, 1);
    let (embed, caption_of) = element(&tab.doc, 2);
    {
        // A source written over the stored one (as the Mermaid dialog's
        // lookup makes a text of a stored string), then typed into; and a
        // caption written over the stored one.
        let mut txn = tab.doc.transact_mut();
        let source = source_of.insert_attribute(&mut txn, "source", TextPrelim::new("graph LR"));
        source.insert(&mut txn, 8, "\n  A --> B");
        caption_of.insert_attribute(&mut txn, "caption", Any::from("new caption"));
    }
    remove_block(&mut room, 2);
    remove_block(&mut room, 1);
    let mut both = vec![diagram, embed];
    both.sort();
    for merged in [
        late_merge::merge(&tab.state(), &room.state()).unwrap(),
        late_merge::reauthor(&tab.state(), &room.state(), 9).unwrap(),
    ] {
        assert_eq!(merged.hidden, both);
    }
}
