#![allow(clippy::unwrap_used)]
//! The in-place collection (`ydoc::gc`) on a blocks room: tabs go offline,
//! delete, move and type, come back; the room repairs on entry (D3), folds
//! and collects at a window every session reached with their held
//! deletions (H, 25 h), and swaps the collected document in (Q401). Every
//! replica then converges and passes the check, and each tab's Undo inside
//! 24 h restores what it deleted, a whole block with its text and id
//! included. Also the admission class of typing into a deleted block
//! (Q443, Q444, Q446) and the late merge's stable-left placement into
//! `sys:children` and a block's `Y.Text` after a collection.

mod common;

use std::collections::HashSet;

use serde_json::{Value, json};
use ydoc::gc::{Named, Window, collect, named_collected, names_collected};
use yrs::undo::{Options, UndoManager};
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, IdSet, Map, Origin, Out, ReadTxn, StateVector, Text, Transact, Update};

const ROOM: u64 = 2;
const TAB: &str = "tab";

fn value() -> Vec<Value> {
    json!([
        {"id": "a", "type": "p", "children": [{"text": "Alpha text"}]},
        {"id": "b", "type": "p", "children": [{"text": "Bravo text"}]},
        {"id": "c", "type": "p", "children": [{"text": "Charlie text"}]},
        {"id": "d", "type": "p", "children": [{"text": "Delta text"}]},
        {"id": "e", "type": "p", "children": [{"text": "Echo text"}]},
        {"id": "f", "type": "p", "children": [{"text": "Foxtrot text"}]},
        {"id": "z", "type": "p", "children": [{"text": ""}]},
        {"id": "t", "type": "table", "children": [
            {"id": "r0", "type": "tr", "children": [
                {"id": "c00", "type": "td", "children": [{"type": "p", "children": [{"text": "one"}]}]},
                {"id": "c01", "type": "td", "children": [{"type": "p", "children": [{"text": "two"}]}]},
            ]},
        ]},
    ])
    .as_array()
    .unwrap()
    .clone()
}

/// A tab: its document and its Undo over `blocks` (BlockSuite's undo
/// manager, D6), built after it loaded.
struct Tab {
    doc: Doc,
    undo: UndoManager<()>,
}

impl Tab {
    fn join(room: &Doc, client: u64) -> Tab {
        let doc = common::doc(&common::state(room), client);
        let mut undo = UndoManager::with_options(Options {
            capture_timeout_millis: 0,
            tracked_origins: HashSet::from([Origin::from(TAB)]),
            ..Options::default()
        });
        undo.expand_scope(&doc, &doc.get_or_insert_map(blocks::BLOCKS_ROOT));
        Tab { doc, undo }
    }

    fn edit(&self, edit: impl FnOnce(&mut yrs::TransactionMut)) {
        let mut txn = self.doc.transact_mut_with(TAB);
        edit(&mut txn);
    }

    fn since(&self, sv: &StateVector) -> Vec<u8> {
        self.doc.transact().encode_state_as_update_v1(sv)
    }

    /// Undoes every step on the stack; the update the Undos wrote.
    fn undo_all(&mut self) -> Vec<u8> {
        let before = self.doc.transact().state_vector();
        while self.undo.undo_blocking() {}
        self.since(&before)
    }
}

/// The room's side: its document, and H (what sessions' updates deleted
/// that the room held undeleted, kept 25 h from arrival).
struct Room {
    doc: Doc,
    held: IdSet,
}

impl Room {
    fn new() -> Room {
        let state = blocks::state_from_value(&value(), 1).unwrap();
        Room {
            doc: common::doc(&state, ROOM),
            held: IdSet::new(),
        }
    }

    /// Admits a session's update and holds its deletions.
    fn admit(&mut self, update: &[u8]) {
        let (_, deleted) = ydoc::apply_deleting(&self.doc, ydoc::decode(update).unwrap()).unwrap();
        self.held.merge_with(deleted);
    }

    /// The repair on entry (D3), written as an ordinary update by the room:
    /// no session holds its deletions.
    fn repair(&self) -> Vec<blocks::Repair> {
        let repairs = blocks::repair(&mut self.doc.transact_mut());
        blocks::check(&self.doc.transact()).unwrap();
        repairs
    }

    /// The fold: collects at a window of the room's document as it stands
    /// (every session reached it) with H, and swaps the result in (Q401).
    fn fold(&mut self) -> Window {
        let window = Window::of(&self.doc.transact(), 1);
        let collected = collect(&self.doc, &window, &self.held, Some(self.doc.client_id()));
        assert!(collected.units > 0, "the fold collected nothing");
        let doc = common::doc(&collected.state, ROOM);
        assert!(!ydoc::has_pending(&doc.transact()));
        assert_eq!(
            blocks::value(&doc.transact()).unwrap(),
            blocks::value(&self.doc.transact()).unwrap()
        );
        assert_eq!(
            doc.transact().state_vector(),
            self.doc.transact().state_vector()
        );
        blocks::check(&doc.transact()).unwrap();
        self.doc = doc;
        window
    }
}

/// History no session holds: three writers type `123` into `id`'s text at
/// `at`, the middle one last, and a fourth deletes it (its session ended),
/// so the run's interior is collectable.
fn ended_churn(room: &mut Room, id: &str, at: u32) {
    for (client, n) in [(3, 1), (5, 3), (4, 2)] {
        let writer = Tab::join(&room.doc, client);
        let at = at + u32::from(n != 1);
        writer.edit(|txn| common::text(txn, id).insert(txn, at, &n.to_string()));
        let before = room.doc.transact().state_vector();
        room.admit(&writer.since(&before));
    }
    let eraser = Tab::join(&room.doc, 6);
    let before = room.doc.transact().state_vector();
    eraser.edit(|txn| common::text(txn, id).remove_range(txn, at, 3));
    room.admit(&eraser.since(&before));
    room.held = IdSet::new();
}

fn sync_to(from: &Doc, to: &Doc) {
    let sv = to.transact().state_vector();
    common::apply(to, &from.transact().encode_state_as_update_v1(&sv));
}

/// Every replica holds the same blocks and passes the check.
fn converged(docs: &[&Doc]) {
    let first = blocks::blocks_json(&docs[0].transact());
    for doc in docs {
        let txn = doc.transact();
        blocks::check(&txn).unwrap();
        assert!(!ydoc::has_pending(&txn));
        assert_eq!(blocks::blocks_json(&txn), first);
    }
}

#[test]
fn offline_tabs_delete_and_move_blocks_and_undo_after_a_collection() {
    let mut room = Room::new();
    ended_churn(&mut room, "f", 3);
    let mut t1 = Tab::join(&room.doc, 10);
    let t2 = Tab::join(&room.doc, 20);
    let mut t3 = Tab::join(&room.doc, 30);
    let joined = room.doc.transact().state_vector();

    // Offline: T1 deletes b, moves c to the top and cuts a's text; T2 moves
    // c after f and types into d and into e; T3 deletes e and a table
    // cell's text.
    t1.edit(|txn| common::delete_block(txn, "b"));
    t1.edit(|txn| common::move_block(txn, "c", blocks::NOTE_ID, 0));
    t1.edit(|txn| common::text(txn, "a").remove_range(txn, 0, 6));
    t2.edit(|txn| common::move_block(txn, "c", blocks::NOTE_ID, 5));
    t2.edit(|txn| common::text(txn, "d").insert(txn, 5, " typed"));
    t2.edit(|txn| common::text(txn, "e").insert(txn, 4, " lost"));
    t3.edit(|txn| common::delete_block(txn, "e"));
    let cell = "prop:cells.r0:t-c0.text";
    t3.edit(|txn| {
        let Some(Out::YMap(table)) = common::blocks_map(txn).get(txn, "t") else {
            panic!("no table");
        };
        let Some(Out::YText(text)) = table.get(txn, cell) else {
            panic!("no cell");
        };
        text.remove_range(txn, 0, 3);
    });

    // Back online: T1, T3, then T2 (whose typing into e lands in a deleted
    // block and goes with it, Q446).
    room.admit(&t1.since(&joined));
    room.admit(&t3.since(&joined));
    room.admit(&t2.since(&joined));
    // c is listed twice (two concurrent moves): repaired on entry.
    assert!(!room.repair().is_empty());
    for tab in [&t1, &t2, &t3] {
        sync_to(&room.doc, &tab.doc);
    }
    converged(&[&room.doc, &t1.doc, &t2.doc, &t3.doc]);
    assert!(!common::child_ids(&room.doc.transact(), blocks::NOTE_ID).contains(&"e".into()));

    room.fold();
    let t4 = Tab::join(&room.doc, 40);

    // Undo inside 24 h: T1's three steps, then T3's two.
    let undone = t1.undo_all();
    assert!(!names_collected(
        &room.doc.transact(),
        &Update::decode_v1(&undone).unwrap()
    ));
    room.admit(&undone);
    let undone = t3.undo_all();
    assert!(!names_collected(
        &room.doc.transact(),
        &Update::decode_v1(&undone).unwrap()
    ));
    room.admit(&undone);
    // The Undos of two concurrent moves list c twice again.
    room.repair();
    for tab in [&t1, &t2, &t3, &t4] {
        sync_to(&tab.doc, &room.doc);
    }
    room.repair();
    for tab in [&t1, &t2, &t3, &t4] {
        sync_to(&room.doc, &tab.doc);
    }
    converged(&[&room.doc, &t1.doc, &t2.doc, &t3.doc, &t4.doc]);

    let txn = room.doc.transact();
    let notes = common::child_ids(&txn, blocks::NOTE_ID);
    // b and e are back under the note, with their ids and text.
    for (id, text) in [("b", "Bravo text"), ("e", "Echo text"), ("a", "Alpha text")] {
        assert!(notes.contains(&id.to_string()), "{id} missing: {notes:?}");
        assert_eq!(common::text_of(&txn, id), text);
        assert!(matches!(
            common::blocks_map(&txn).get(&txn, id),
            Some(Out::YMap(_))
        ));
    }
    // T3's Undo restores the cell; T2's typing into e went with e (plain
    // Yjs: T3's Undo restores what T3 deleted, which never held it).
    let Some(Out::YMap(table)) = common::blocks_map(&txn).get(&txn, "t") else {
        panic!("no table");
    };
    let Some(Out::YText(text)) = table.get(&txn, cell) else {
        panic!("no cell");
    };
    assert_eq!(text.get_string(&txn), "one");
    assert_eq!(common::text_of(&txn, "d"), "Delta typed text");
}

/// A session whose held deletions were lost (Q382): its Undo of a block
/// delete in the middle of a run of blocks other writers listed is found to
/// name collected history, never restored in part.
#[test]
fn an_undo_without_its_held_deletions_names_collected_history() {
    let mut room = Room::new();
    // p1, p3 and then p2 between them, each from its own writer: p2's
    // listing is a dead run's interior nothing names.
    for (client, id, at) in [(3, "p1", 2), (5, "p3", 3), (4, "p2", 3)] {
        let writer = Tab::join(&room.doc, client);
        writer.edit(|txn| common::add_paragraph(txn, id, id, blocks::NOTE_ID, at));
        let before = room.doc.transact().state_vector();
        room.admit(&writer.since(&before));
    }
    assert_eq!(
        common::child_ids(&room.doc.transact(), blocks::NOTE_ID)[..6],
        ["a", "b", "p1", "p2", "p3", "c"]
    );
    let mut tab = Tab::join(&room.doc, 10);
    let joined = room.doc.transact().state_vector();
    for id in ["p1", "p2", "p3"] {
        tab.edit(|txn| common::delete_block(txn, id));
    }
    room.admit(&tab.since(&joined));
    room.held = IdSet::new();
    room.fold();
    let undone = tab.undo_all();
    assert!(names_collected(
        &room.doc.transact(),
        &Update::decode_v1(&undone).unwrap()
    ));
}

/// Typing into a block a co-editor deleted: what it names is a child of the
/// deleted block's Y.Map, which Yjs drops with the block, so the room reads
/// it as collected since (a connected tab's typing goes with the block,
/// Q446; a draft group is answered late, Q444), and as collected by the
/// window once a fold's window holds the delete (Q443). An empty block
/// included: its `Y.Text` is a value of the deleted map, unlike Plate's
/// paragraph, whose XmlText is the deleted item itself.
#[test]
fn typing_into_a_deleted_block_names_collected_history() {
    let mut room = Room::new();
    let tab = Tab::join(&room.doc, 10);
    let joined = room.doc.transact().state_vector();
    tab.edit(|txn| common::text(txn, "d").insert(txn, 5, " typed"));
    let into_text = tab.since(&joined);
    let typed = tab.doc.transact().state_vector();
    tab.edit(|txn| common::text(txn, "z").insert(txn, 0, "first"));
    let into_empty = tab.since(&typed);

    let other = Tab::join(&room.doc, 20);
    other.edit(|txn| common::delete_block(txn, "d"));
    other.edit(|txn| common::delete_block(txn, "z"));
    room.admit(&other.since(&joined));
    // The deleting session ended; history elsewhere gives the fold work.
    ended_churn(&mut room, "a", 3);

    for update in [&into_text, &into_empty] {
        let update = Update::decode_v1(update).unwrap();
        assert_eq!(
            named_collected(&room.doc.transact(), &update, &IdSet::new()),
            Named::Since
        );
    }
    let window = room.fold();
    for update in [&into_text, &into_empty] {
        let update = Update::decode_v1(update).unwrap();
        assert_eq!(
            named_collected(&room.doc.transact(), &update, &window.delete_set),
            Named::Window
        );
    }

    // Plate's empty paragraph: the typing names the deleted XmlText item
    // itself, which Yjs keeps, so nothing reads as collected there.
    let plate = common::doc(
        &notes::slate_yjs::state_from_value(
            json!([{"id": "z", "type": "p", "children": [{"text": ""}]}, {"id": "y", "type": "p", "children": [{"text": "Y"}]}])
                .as_array()
                .unwrap(),
            1,
        ),
        ROOM,
    );
    let plate_tab = common::doc(&common::state(&plate), 10);
    let before = plate_tab.transact().state_vector();
    {
        let mut txn = plate_tab.transact_mut();
        let root = notes::plate::content_root(&txn).unwrap();
        let mut slate = notes::slate::Root::new(notes::plate::value(&txn).unwrap());
        let op = notes::slate::Operation::InsertText {
            path: vec![0, 0],
            offset: 0,
            text: "first".into(),
        };
        notes::slate_yjs::apply_ops(&mut txn, root, &mut slate, &[op]).unwrap();
    }
    let plate_typed = plate_tab.transact().encode_state_as_update_v1(&before);
    {
        let mut txn = plate.transact_mut();
        let root = notes::plate::content_root(&txn).unwrap();
        let mut slate = notes::slate::Root::new(notes::plate::value(&txn).unwrap());
        let node = slate.children[0].clone();
        let op = notes::slate::Operation::RemoveNode {
            path: vec![0],
            node,
        };
        notes::slate_yjs::apply_ops(&mut txn, root, &mut slate, &[op]).unwrap();
    }
    assert_eq!(
        named_collected(
            &plate.transact(),
            &Update::decode_v1(&plate_typed).unwrap(),
            &IdSet::new()
        ),
        Named::Nothing
    );
}

/// The late merge after a collection: a tab older than the window inserts
/// a block next to a listing the collection dropped and types next to text
/// it dropped; the merge places both at their stable left (after the
/// nearest unit on their left the room still holds, at the end of its
/// deleted run), and names the block it typed into that was deleted and
/// collected as hidden.
#[test]
fn the_late_merge_places_blocks_and_text_at_their_stable_left() {
    let mut room = Room::new();
    // Listings p1, p2, p3 after b and characters 1, 2, 3 after "Charlie",
    // each from its own writer, the middle one last: interiors nothing
    // names once deleted.
    for (client, n, at) in [(3, 1, 2), (5, 3, 3), (4, 2, 3)] {
        let writer = Tab::join(&room.doc, client);
        let id = format!("p{n}");
        writer.edit(|txn| common::add_paragraph(txn, &id, &id, blocks::NOTE_ID, at));
        writer.edit(|txn| {
            common::text(txn, "c").insert(txn, 7 + at - 2, &n.to_string());
        });
        let before = room.doc.transact().state_vector();
        room.admit(&writer.since(&before));
    }
    assert_eq!(
        common::text_of(&room.doc.transact(), "c"),
        "Charlie123 text"
    );

    // The late tab saw them and goes offline: a block right after p2, text
    // right after 2, and typing into f.
    let late = Tab::join(&room.doc, 50);
    late.edit(|txn| common::add_paragraph(txn, "new", "New block", blocks::NOTE_ID, 4));
    late.edit(|txn| common::text(txn, "c").insert(txn, 9, "LATE"));
    late.edit(|txn| common::text(txn, "f").insert(txn, 0, "hidden "));
    assert_eq!(
        common::text_of(&late.doc.transact(), "c"),
        "Charlie12LATE3 text"
    );

    // Meanwhile p1-p3, the three characters and f are deleted, and a fold
    // collects them (no session holds them: the tab is past the window).
    let online = Tab::join(&room.doc, 60);
    let before = room.doc.transact().state_vector();
    for id in ["p1", "p2", "p3", "f"] {
        online.edit(|txn| common::delete_block(txn, id));
    }
    online.edit(|txn| common::text(txn, "c").remove_range(txn, 7, 3));
    room.admit(&online.since(&before));
    room.held = IdSet::new();
    room.fold();

    let unsent = late.since(&before);
    assert!(names_collected(
        &room.doc.transact(),
        &Update::decode_v1(&unsent).unwrap()
    ));
    let merged = late_merge::merge(&common::state(&late.doc), &common::state(&room.doc)).unwrap();
    // f's yBlock is named hidden.
    let f_item = {
        let txn = late.doc.transact();
        let Some(Out::YMap(f)) = common::blocks_map(&txn).get(&txn, "f") else {
            panic!("no f");
        };
        *f.as_ref().item().unwrap().id()
    };
    assert_eq!(merged.hidden, [f_item]);
    assert!(!names_collected(
        &room.doc.transact(),
        &Update::decode_v1(&merged.update).unwrap()
    ));
    room.admit(&merged.update);
    room.repair();
    let txn = room.doc.transact();
    assert_eq!(
        common::child_ids(&txn, blocks::NOTE_ID)[..4],
        ["a", "b", "new", "c"]
    );
    assert_eq!(common::text_of(&txn, "new"), "New block");
    assert_eq!(common::text_of(&txn, "c"), "CharlieLATE text");
    drop(txn);
    let fresh = common::doc(&common::state(&room.doc), 70);
    converged(&[&room.doc, &fresh]);
}

/// A held deletion inside a block another session deleted next: Yjs drops
/// the block's children with it whatever H holds, so the first session's
/// Undo of its text deletion restores nothing, while the block's own Undo
/// brings the block back as its deleter saw it (as Plate's XmlText children
/// go with their block). Every replica still converges and passes.
#[test]
fn a_text_deletion_inside_a_block_deleted_next_restores_nothing() {
    let mut room = Room::new();
    ended_churn(&mut room, "f", 3);
    let mut t1 = Tab::join(&room.doc, 10);
    let mut t2 = Tab::join(&room.doc, 20);
    let joined = room.doc.transact().state_vector();
    t1.edit(|txn| common::text(txn, "d").remove_range(txn, 0, 6));
    room.admit(&t1.since(&joined));
    sync_to(&room.doc, &t2.doc);
    let seen = room.doc.transact().state_vector();
    t2.edit(|txn| common::delete_block(txn, "d"));
    room.admit(&t2.since(&seen));
    sync_to(&room.doc, &t1.doc);
    room.fold();

    for tab in [&mut t2, &mut t1] {
        let undone = tab.undo_all();
        assert!(!names_collected(
            &room.doc.transact(),
            &Update::decode_v1(&undone).unwrap()
        ));
        room.admit(&undone);
    }
    for tab in [&t1, &t2] {
        sync_to(&room.doc, &tab.doc);
    }
    converged(&[&room.doc, &t1.doc, &t2.doc]);
    assert_eq!(common::text_of(&room.doc.transact(), "d"), "text");
}
