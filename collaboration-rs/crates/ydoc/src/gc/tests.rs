use std::collections::HashSet;

use yrs::block::ClientID;
use yrs::undo::{Options, UndoManager};
use yrs::{
    Any, Array, Doc, GetString, ID, IdSet, Map, Origin, Out, ReadTxn, Text, TextPrelim, Transact,
};

use super::*;
use crate::{decode, doc_options, has_pending};

fn doc(client: u64) -> Doc {
    Doc::with_options(doc_options(client))
}

fn sync(from: &Doc, to: &Doc) {
    let sv = to.transact().state_vector();
    let update = from.transact().encode_state_as_update_v1(&sv);
    to.transact_mut()
        .apply_update(decode(&update).unwrap())
        .unwrap();
}

fn id(client: u64, clock: u32) -> ID {
    ID::new(ClientID::new(client), clock)
}

/// `doc` collected at `window` with `held`, loaded into a fresh document.
fn collected_at(doc: &Doc, window: &Window, held: &IdSet, live_room: Option<u64>) -> Doc {
    let state = collect(doc, window, held, live_room.map(ClientID::new)).state;
    let fresh = self::doc(99);
    fresh
        .transact_mut()
        .apply_update(decode(&state).unwrap())
        .unwrap();
    assert!(!has_pending(&fresh.transact()));
    fresh
}

/// `doc` collected at a window of itself: everything it deleted is dead.
fn collected(doc: &Doc, held: &IdSet) -> Doc {
    collected_at(doc, &Window::of(&doc.transact(), 1), held, None)
}

fn is_collected(doc: &Doc, unit: ID) -> bool {
    matches!(
        doc.transact().store().get_block_range(&unit),
        Some((_, None))
    )
}

fn text(doc: &Doc) -> String {
    doc.get_or_insert_text("t").get_string(&doc.transact())
}

fn key(doc: &Doc) -> Option<Out> {
    doc.get_or_insert_map("m").get(&doc.transact(), "k")
}

/// A room holding `L a b c R` in text root `t`, with a, b and c each typed by
/// its own writer (clients 2, 3, 4), so the run is three items, and b typed
/// last between a and c, so no other item names it.
fn run_of_three() -> Doc {
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "LR");
    for (client, at, s) in [(2, 1, "a"), (4, 2, "c"), (3, 2, "b")] {
        let writer = doc(client);
        sync(&room, &writer);
        writer
            .get_or_insert_text("t")
            .insert(&mut writer.transact_mut(), at, s);
        sync(&writer, &room);
    }
    room
}

/// A tab holding `room`, whose Undo tracks its own edits (origin "tab").
fn tab(room: &Doc, client: u64) -> (Doc, UndoManager<()>) {
    let tab = doc(client);
    sync(room, &tab);
    let mut undo = UndoManager::with_options(Options {
        capture_timeout_millis: 0,
        tracked_origins: HashSet::from([Origin::from("tab")]),
        ..Options::default()
    });
    undo.expand_scope(&tab, &tab.get_or_insert_text("t"));
    (tab, undo)
}

/// The units `edit` deleted in `doc`.
fn deleted_by(doc: &Doc, edit: impl FnOnce(&mut yrs::TransactionMut)) -> IdSet {
    let mut txn = doc.transact_mut_with("tab");
    edit(&mut txn);
    txn.commit();
    txn.delete_set().clone()
}

#[test]
fn a_deleted_run_keeps_the_units_an_insert_can_name() {
    let room = run_of_three();
    // The same run in an array: L a b c R, a b c from clients 2, 3, 4.
    room.get_or_insert_array("a")
        .insert_range(&mut room.transact_mut(), 0, ["L", "R"]);
    for (client, at) in [(2, 1), (4, 2), (3, 2)] {
        let writer = doc(client);
        sync(&room, &writer);
        writer
            .get_or_insert_array("a")
            .insert(&mut writer.transact_mut(), at, "x");
        sync(&writer, &room);
    }
    room.get_or_insert_text("t")
        .remove_range(&mut room.transact_mut(), 1, 3);
    room.get_or_insert_array("a")
        .remove_range(&mut room.transact_mut(), 1, 3);
    let (tab, _) = tab(&room, 5);
    let collected = collected(&room, &IdSet::new());
    // b's text and array units go; the run's edges stay.
    for b in [id(3, 0), id(3, 1)] {
        assert!(is_collected(&collected, b), "{b}");
    }
    for edge in [id(2, 0), id(4, 0), id(2, 1), id(4, 1)] {
        assert!(!is_collected(&collected, edge), "{edge}");
    }
    // Typing after L names c (the run's last unit); an array insert after L
    // names a (its first) as right origin. Both land in the collected state.
    let before = tab.transact().state_vector();
    tab.get_or_insert_text("t")
        .insert(&mut tab.transact_mut(), 1, "X");
    tab.get_or_insert_array("a")
        .insert(&mut tab.transact_mut(), 1, "Y");
    let typed = tab.transact().encode_state_as_update_v1(&before);
    collected
        .transact_mut()
        .apply_update(decode(&typed).unwrap())
        .unwrap();
    assert_eq!(text(&collected), "LXR");
    let array = collected.get_or_insert_array("a");
    let txn = collected.transact();
    let values: Vec<String> = array.iter(&txn).map(|v| v.to_string(&txn)).collect();
    assert_eq!(values, ["L", "Y", "R"]);
}

#[test]
fn units_deleted_after_the_window_stay() {
    let room = run_of_three();
    let window = Window::of(&room.transact(), 1);
    room.get_or_insert_text("t")
        .remove_range(&mut room.transact_mut(), 1, 3);
    let collected = collected_at(&room, &window, &IdSet::new(), None);
    assert!(!is_collected(&collected, id(3, 0)));
    assert_eq!(text(&collected), "LR");
}

/// A run's interior unit that a kept item names stays (here an item newer
/// than the window, typed by a tab that held b live).
#[test]
fn what_a_kept_item_names_stays() {
    let room = run_of_three();
    let late = doc(5);
    sync(&room, &late);
    let before = late.transact().state_vector();
    // After b: origin b, right origin c.
    late.get_or_insert_text("t")
        .insert(&mut late.transact_mut(), 3, "X");
    let typed = late.transact().encode_state_as_update_v1(&before);
    room.get_or_insert_text("t")
        .remove_range(&mut room.transact_mut(), 1, 3);
    let window = Window::of(&room.transact(), 1);
    room.transact_mut()
        .apply_update(decode(&typed).unwrap())
        .unwrap();
    let collected = collected_at(&room, &window, &IdSet::new(), None);
    assert!(!is_collected(&collected, id(3, 0)));
    assert_eq!(text(&collected), "LXR");
}

/// A session's Undo re-creates each item it deleted naming the item itself:
/// what it deleted is held, so its Undo restores everything after a
/// collection.
#[test]
fn held_deletions_stay_for_their_sessions_undo() {
    let room = run_of_three();
    let (tab, mut undo) = tab(&room, 5);
    let t = tab.get_or_insert_text("t");
    let held = deleted_by(&tab, |txn| t.remove_range(txn, 1, 3));
    sync(&tab, &room);
    let collected = collected(&room, &held);
    let before = tab.transact().state_vector();
    assert!(undo.undo_blocking());
    let undone = tab.transact().encode_state_as_update_v1(&before);
    collected
        .transact_mut()
        .apply_update(decode(&undone).unwrap())
        .unwrap();
    assert_eq!(text(&tab), "LabcR");
    assert_eq!(text(&collected), "LabcR");
}

/// An Undo payload naming a collected unit is refused: it would integrate as
/// collected and restore only part of its edit.
#[test]
fn an_update_naming_a_collected_unit_is_detected() {
    let room = run_of_three();
    let (tab, mut undo) = tab(&room, 5);
    let t = tab.get_or_insert_text("t");
    deleted_by(&tab, |txn| t.remove_range(txn, 1, 3));
    sync(&tab, &room);
    // Nothing held: b goes, and the Undo's copy of b names it.
    let collected = collected(&room, &IdSet::new());
    let before = tab.transact().state_vector();
    assert!(undo.undo_blocking());
    let undone = tab.transact().encode_state_as_update_v1(&before);
    let undone = decode(&undone).unwrap();
    assert!(names_collected(&collected.transact(), &undone));
    assert!(!names_collected(&room.transact(), &undone));
}

/// An item with neither origin names its parent: a first insert into a
/// nested type that a collection dropped is detected too.
#[test]
fn an_update_naming_a_collected_parent_is_detected() {
    let room = doc(1);
    room.get_or_insert_array("a")
        .insert_range(&mut room.transact_mut(), 0, ["L", "R"]);
    // Three empty texts from clients 2, 4 and 3 (b last, between): b is a
    // run's interior that nothing names.
    for (client, at) in [(2, 1), (4, 2), (3, 2)] {
        let writer = doc(client);
        sync(&room, &writer);
        writer
            .get_or_insert_array("a")
            .insert(&mut writer.transact_mut(), at, TextPrelim::new(""));
        sync(&writer, &room);
    }
    let tab = doc(5);
    sync(&room, &tab);
    room.get_or_insert_array("a")
        .remove_range(&mut room.transact_mut(), 1, 3);
    let collected = collected(&room, &IdSet::new());
    assert!(is_collected(&collected, id(3, 0)));
    let before = tab.transact().state_vector();
    let Some(Out::YText(b)) = tab.get_or_insert_array("a").get(&tab.transact(), 2) else {
        panic!("b is a text");
    };
    b.insert(&mut tab.transact_mut(), 0, "x");
    let typed = tab.transact().encode_state_as_update_v1(&before);
    let typed = decode(&typed).unwrap();
    assert!(names_collected(&collected.transact(), &typed));
    assert!(!names_collected(&room.transact(), &typed));
}

/// `L a c R`; tab T holds it and goes offline; b lands between a and c, T
/// types Y between a and c, and a b c are deleted. The window is that state.
/// Returns the room, T and the window, before T comes back.
fn run_with_an_offline_insert() -> (Doc, Doc, Window) {
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "LR");
    for (client, at, s) in [(2, 1, "a"), (4, 2, "c")] {
        let writer = doc(client);
        sync(&room, &writer);
        writer
            .get_or_insert_text("t")
            .insert(&mut writer.transact_mut(), at, s);
        sync(&writer, &room);
    }
    let offline = doc(9);
    sync(&room, &offline);
    let writer = doc(3);
    sync(&room, &writer);
    writer
        .get_or_insert_text("t")
        .insert(&mut writer.transact_mut(), 2, "b");
    sync(&writer, &room);
    offline
        .get_or_insert_text("t")
        .insert(&mut offline.transact_mut(), 2, "Y");
    room.get_or_insert_text("t")
        .remove_range(&mut room.transact_mut(), 1, 3);
    let window = Window::of(&room.transact(), 1);
    (room, offline, window)
}

/// `typer` types `X` at `at`; the update lands on the room and on the
/// collected state.
fn type_on_both(typer: &Doc, at: u32, room: &Doc, collected: &Doc) {
    let before = typer.transact().state_vector();
    typer
        .get_or_insert_text("t")
        .insert(&mut typer.transact_mut(), at, "X");
    let typed = typer.transact().encode_state_as_update_v1(&before);
    for doc in [room, collected] {
        doc.transact_mut()
            .apply_update(decode(&typed).unwrap())
            .unwrap();
    }
}

/// T's Y comes back after the window and lands after b (client 3 < 9):
/// `L a b Y c R`. Typing just before Y names b, so b ends the run although
/// it is interior in the window's order.
#[test]
fn a_unit_newer_than_the_window_ends_a_deleted_run() {
    let (room, offline, window) = run_with_an_offline_insert();
    sync(&offline, &room);
    assert_eq!(text(&room), "LYR");
    let collected = collected_at(&room, &window, &IdSet::new(), None);
    assert!(!is_collected(&collected, id(3, 0)));
    let typer = doc(6);
    sync(&room, &typer);
    type_on_both(&typer, 1, &room, &collected);
    assert_eq!(text(&room), "LXYR");
    assert_eq!(text(&collected), "LXYR");
}

/// The same with Y deleted after the window: a session that still shows Y
/// live types before it, naming b.
#[test]
fn a_unit_deleted_after_the_window_ends_a_deleted_run() {
    let (room, offline, window) = run_with_an_offline_insert();
    sync(&offline, &room);
    let typer = doc(6);
    sync(&room, &typer);
    room.get_or_insert_text("t")
        .remove_range(&mut room.transact_mut(), 1, 1);
    assert_eq!(text(&room), "LR");
    let collected = collected_at(&room, &window, &IdSet::new(), None);
    assert!(!is_collected(&collected, id(3, 0)));
    type_on_both(&typer, 1, &room, &collected);
    assert_eq!(text(&room), "LXR");
    assert_eq!(text(&collected), "LXR");
}

#[test]
fn the_value_current_at_the_window_drops_the_values_behind_it() {
    let room = doc(1);
    let map = room.get_or_insert_map("m");
    for value in 0..3 {
        map.insert(&mut room.transact_mut(), "k", value);
    }
    let collected = collected(&room, &IdSet::new());
    assert!(is_collected(&collected, id(1, 0)));
    assert!(is_collected(&collected, id(1, 1)));
    assert_eq!(key(&collected), Some(Out::Any(Any::from(2))));
}

/// Measured (REPORT-3 5d): a tab set the key from the value behind the head
/// (16's value names 1's), and it arrived after the window. Cut, the head
/// would load on the far side of it and the key would read as deleted.
#[test]
fn a_head_keeps_its_origin_when_a_later_value_names_one_behind_it() {
    let room = doc(1);
    room.get_or_insert_map("m")
        .insert(&mut room.transact_mut(), "k", 0);
    let (head, later) = (doc(12), doc(16));
    sync(&room, &head);
    sync(&room, &later);
    head.get_or_insert_map("m")
        .insert(&mut head.transact_mut(), "k", 1);
    sync(&head, &room);
    let window = Window::of(&room.transact(), 1);
    later
        .get_or_insert_map("m")
        .insert(&mut later.transact_mut(), "k", 2);
    sync(&later, &room);
    assert_eq!(key(&room), Some(Out::Any(Any::from(2))));
    let collected = collected_at(&room, &window, &IdSet::new(), None);
    assert_eq!(key(&collected), Some(Out::Any(Any::from(2))));
}

/// A value newer than the window that landed behind the head (a lower client
/// set the key from the value before it) stays, so the head keeps its origin.
#[test]
fn a_head_keeps_its_origin_when_a_newer_value_lands_behind_it() {
    let room = doc(1);
    let first = doc(30);
    first
        .get_or_insert_map("m")
        .insert(&mut first.transact_mut(), "k", 0);
    sync(&first, &room);
    let (head, newer) = (doc(20), doc(10));
    sync(&room, &head);
    sync(&room, &newer);
    head.get_or_insert_map("m")
        .insert(&mut head.transact_mut(), "k", 1);
    sync(&head, &room);
    let window = Window::of(&room.transact(), 1);
    newer
        .get_or_insert_map("m")
        .insert(&mut newer.transact_mut(), "k", 2);
    sync(&newer, &room);
    assert_eq!(key(&room), Some(Out::Any(Any::from(1))));
    let collected = collected_at(&room, &window, &IdSet::new(), None);
    assert_eq!(key(&collected), Some(Out::Any(Any::from(1))));
}

/// Marker chains of ended room lives go whole, whatever the window; the open
/// room's own chain stays.
#[test]
fn marker_chains_of_ended_room_lives_go_whole() {
    let room = doc(1);
    let markers = room.get_or_insert_map(CONTRIBUTORS_ROOT);
    // An ended life (client 1) wrote two generations and cleared them.
    for nonce in ["n1", "n2"] {
        markers.insert(&mut room.transact_mut(), "ended:write:x", nonce);
    }
    markers.remove(&mut room.transact_mut(), "ended:write:x");
    let open = doc(2);
    sync(&room, &open);
    let markers = open.get_or_insert_map(CONTRIBUTORS_ROOT);
    markers.insert(&mut open.transact_mut(), "open:write:y", "n3");
    markers.remove(&mut open.transact_mut(), "open:write:y");
    // A window from before anything: no other unit is dead.
    let window = Window::of(&doc(3).transact(), 0);
    let collected = collected_at(&open, &window, &IdSet::new(), Some(2));
    assert!(is_collected(&collected, id(1, 0)));
    assert!(is_collected(&collected, id(1, 1)));
    assert!(!is_collected(&collected, id(2, 0)));
}

#[test]
fn the_window_is_the_newest_every_counted_session_reached() {
    let at = |stored_version| Window {
        stored_version,
        state_vector: Default::default(),
        delete_set: IdSet::new(),
    };
    let windows = [at(3), at(7), at(5)];
    assert_eq!(window_for(&windows, 6).map(|w| w.stored_version), Some(5));
    assert_eq!(window_for(&windows, 7).map(|w| w.stored_version), Some(7));
    assert_eq!(window_for(&windows, 2), None);
}
