#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! What an update may do to the room's board (RULES.md "The room only", Epo
//! 2026-11-22): an entity written over a live one keeps its kind, identity
//! keys never written again, the page and the canvas kept, map writes without
//! a right origin and chained at a key (a run of values holding its last),
//! blocks under parents their flavour may have, an entity that misfits
//! already held to each key written; relations two honest edits can break
//! together are not refused.
mod common;

use common::*;
use yrs::branch::Branch;
use yrs::encoding::write::Write;
use yrs::{Map, MapPrelim, ReadTxn, Transact, UndoManager, any};

#[track_caller]
fn refused(verdict: Result<(), String>, reason: &str) {
    match verdict {
        Err(got) => assert!(got.contains(reason), "{got:?} names no {reason:?}"),
        Ok(()) => panic!("admitted; expected a refusal naming {reason:?}"),
    }
}

fn shape(id: &str) -> Fields {
    editor_elements(id)
        .into_iter()
        .find(|(kind, _)| *kind == "shape")
        .unwrap()
        .1
}

/// One update of `structs` under client 8 from clock 0, each encoded by
/// hand (no Yjs writer makes these), deleting nothing.
fn by_hand(structs: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(1u32);
    bytes.write_var(structs.len() as u32);
    bytes.write_var(8u64);
    bytes.write_var(0u32);
    for one in structs {
        bytes.extend_from_slice(one);
    }
    bytes.write_var(0u32);
    bytes
}

/// A map write after `origin` (a client and clock): one string, or a
/// deleted content (`None`).
fn after(origin: (u64, u32), value: Option<&str>) -> Vec<u8> {
    let mut bytes: Vec<u8> = vec![0x80 | if value.is_some() { 8 } else { 1 }];
    bytes.write_var(origin.0);
    bytes.write_var(origin.1);
    bytes.write_var(1u32);
    if let Some(value) = value {
        bytes.write_u8(119); // a string
        bytes.write_string(value);
    }
    bytes
}

/// A map write after `origin` of a run of encoded values (Yjs merges a
/// client's overwritten values at a key into one struct; yrs never does).
fn run_after(origin: (u64, u32), values: &[Vec<u8>]) -> Vec<u8> {
    let mut run: Vec<u8> = vec![0x80 | 8];
    run.write_var(origin.0);
    run.write_var(origin.1);
    run.write_var(values.len() as u32);
    for value in values {
        run.extend_from_slice(value);
    }
    run
}

/// A string, as a value in a run.
fn string(text: &str) -> Vec<u8> {
    let mut value: Vec<u8> = vec![119];
    value.write_string(text);
    value
}

/// A new map written after `origin`.
fn map_after(origin: (u64, u32)) -> Vec<u8> {
    let mut bytes: Vec<u8> = vec![0x80 | 7];
    bytes.write_var(origin.0);
    bytes.write_var(origin.1);
    bytes.write_u8(1); // a map
    bytes
}

/// A write at `key` of the map whose item is `parent`, after nothing: one
/// string, or a new map (`None`).
fn first_at(parent: (u64, u32), key: &str, value: Option<&str>) -> Vec<u8> {
    let mut bytes: Vec<u8> = vec![0x20 | if value.is_some() { 8 } else { 7 }];
    bytes.write_var(0u32); // the parent is an item
    bytes.write_var(parent.0);
    bytes.write_var(parent.1);
    bytes.write_string(key);
    match value {
        Some(value) => {
            bytes.write_var(1u32);
            bytes.write_u8(119);
            bytes.write_string(value);
        }
        None => bytes.write_u8(1),
    }
    bytes
}

fn at(id: yrs::ID) -> (u64, u32) {
    (id.client.get(), id.clock)
}

/// The last id of the room's current item at `key` of `map`.
fn current(map: &yrs::MapRef, key: &str) -> (u64, u32) {
    let branch: &Branch = map.as_ref();
    at(branch.entry_item(key).unwrap().last_id())
}

/// The item id of `map`.
fn item_of(map: &yrs::MapRef) -> (u64, u32) {
    let branch: &Branch = map.as_ref();
    at(*branch.item().unwrap().id())
}

/// A room holding shape `s1`, and a tab on it.
fn with_shape() -> (yrs::Doc, yrs::Doc) {
    let room = room();
    let writer = tab(&room, 7);
    send(
        &room,
        &update(&writer, |doc| add_element(doc, "s1", &shape("s1"))),
    )
    .unwrap();
    (room, writer)
}

#[test]
fn identity_keys_are_never_written_again() {
    let (room, writer) = with_shape();
    let rewrites: [(&str, yrs::Any); 3] = [
        ("type", any!("text")),
        ("type", any!("shape")),
        ("id", any!("s1")),
    ];
    for (key, value) in rewrites {
        let rewrite = update(&tab(&room, 8), |doc| {
            set_element(doc, "s1", &fields(&[(key, a(value.clone()))]))
        });
        refused(
            admit(&room, &rewrite),
            &format!("a canvas element's {key} is never written again"),
        );
    }
    let _ = writer;
    for (key, value) in [
        ("sys:flavour", a(any!("affine:page"))),
        ("sys:children", F::L(vec![])),
    ] {
        let rewrite = update(&tab(&room, 8), |doc| {
            set_block(doc, "page", &fields(&[(key, value.clone())]))
        });
        refused(
            admit(&room, &rewrite),
            &format!("a block's {key} is never written again"),
        );
    }
}

#[test]
fn the_page_and_the_canvas_are_kept() {
    let room = room();
    for id in ["page", "surface"] {
        let gone = update(&tab(&room, 8), |doc| {
            doc.get_or_insert_map(board::ROOT)
                .remove(&mut doc.transact_mut(), id);
        });
        refused(admit(&room, &gone), "never deleted");
    }
    let holder = update(&tab(&room, 8), |doc| {
        set_block(doc, "surface", &fields(&[("prop:elements", m(&[]))]))
    });
    refused(
        admit(&room, &holder),
        "elements holder is never written again",
    );
    let typed = update(&tab(&room, 8), |doc| {
        let txn = doc.transact();
        let blocks = txn.get_map(board::ROOT).unwrap();
        let holder = map_at(&txn, &map_at(&txn, &blocks, "surface"), "prop:elements");
        drop(txn);
        holder.insert(&mut doc.transact_mut(), "type", "other");
    });
    refused(
        admit(&room, &typed),
        "elements holder is never written again",
    );
    let emptied = update(&tab(&room, 8), |doc| {
        let txn = doc.transact();
        let blocks = txn.get_map(board::ROOT).unwrap();
        let holder = map_at(&txn, &map_at(&txn, &blocks, "surface"), "prop:elements");
        drop(txn);
        holder.remove(&mut doc.transact_mut(), "value");
    });
    refused(admit(&room, &emptied), "elements holder is never deleted");
    let page = update(&tab(&room, 8), |doc| {
        add_block(doc, "page2", "affine:page", None, &fields(&[]))
    });
    refused(
        admit(&room, &page),
        "the page and canvas blocks are never created",
    );
}

#[test]
fn an_entity_written_over_keeps_its_kind_and_a_deleted_one_comes_back() {
    let (room, writer) = with_shape();
    // An empty map written over a live entry the update does not delete.
    let entry = {
        let txn = room.transact();
        current(&elements(&room, &txn), "s1")
    };
    refused(
        admit(&room, &by_hand(&[map_after(entry)])),
        "a replaced canvas element keeps its type",
    );
    let room_note = room_with_note();
    let entry = {
        let txn = room_note.transact();
        current(&txn.get_map(board::ROOT).unwrap(), "note")
    };
    refused(
        admit(&room_note, &by_hand(&[map_after(entry)])),
        "a replaced block keeps its flavour",
    );
    // Written over by `Map.set`, which deletes it: the page never is.
    let block = update(&tab(&room, 8), |doc| {
        add_block(doc, "page", "affine:note", None, &note())
    });
    refused(
        admit(&room, &block),
        "the page and canvas blocks are never deleted",
    );
    // Erased, then brought back under its id as an undo does.
    send(&room, &update(&writer, |doc| remove_element(doc, "s1"))).unwrap();
    assert_eq!(
        send(
            &room,
            &update(&writer, |doc| add_element(doc, "s1", &shape("s1")))
        ),
        Ok(())
    );
}

/// A deleted required key leaves an entity that no longer fits.
#[test]
fn deleting_a_required_key_is_refused() {
    let (room, _) = with_shape();
    let cut = update(&tab(&room, 8), |doc| {
        let value = elements(doc, &doc.transact());
        let element = map_at(&doc.transact(), &value, "s1");
        element.remove(&mut doc.transact_mut(), "xywh");
    });
    refused(admit(&room, &cut), "canvas element shape: xywh is required");
    // An optional one goes.
    let optional = update(&tab(&room, 8), |doc| {
        let value = elements(doc, &doc.transact());
        let element = map_at(&doc.transact(), &value, "s1");
        element.remove(&mut doc.transact_mut(), "shadow");
    });
    assert_eq!(admit(&room, &optional), Ok(()));
}

/// Yjs's `Map.set` writes no right origin; a write placed before a key's
/// live value would hide itself.
#[test]
fn a_map_write_with_a_right_origin_is_refused() {
    let (room, _) = with_shape();
    let live = {
        let txn = room.transact();
        let element = map_at(&txn, &elements(&room, &txn), "s1");
        let branch: &yrs::branch::Branch = element.as_ref();
        *branch.entry_item("xywh").unwrap().id()
    };
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(1u32);
    bytes.write_var(1u32);
    bytes.write_var(8u64);
    bytes.write_var(0u32);
    bytes.write_u8(0x40 | 8); // a right origin, plain content
    bytes.write_var(live.client.get());
    bytes.write_var(live.clock);
    bytes.write_var(1u32);
    bytes.write_u8(119); // a string
    bytes.write_string("[0,0,1,1]");
    bytes.write_var(0u32);
    refused(
        admit(&room, &bytes),
        "a map entry written before its key's live value",
    );
}

#[test]
fn a_block_under_a_parent_its_flavour_may_not_have_is_refused() {
    let room = room_with_note();
    let paragraph = fields(&[("prop:text", t("x"))]);
    refused(
        send(
            &room,
            &update(&tab(&room, 8), |doc| {
                add_block(doc, "p1", "affine:paragraph", Some("surface"), &paragraph)
            }),
        ),
        "block affine:paragraph under a block affine:surface",
    );
    // A held block's id added to the wrong parent's children.
    send(
        &room,
        &update(&tab(&room, 8), |doc| {
            add_block(doc, "p1", "affine:paragraph", Some("note"), &paragraph)
        }),
    )
    .unwrap();
    let moved = update(&tab(&room, 9), |doc| {
        let txn = doc.transact();
        let blocks = txn.get_map(board::ROOT).unwrap();
        let surface = map_at(&txn, &blocks, "surface");
        let Some(yrs::Out::YArray(children)) = surface.get(&txn, "sys:children") else {
            panic!("no children");
        };
        drop(txn);
        yrs::Array::push_back(&children, &mut doc.transact_mut(), "p1");
    });
    refused(
        send(&room, &moved),
        "block affine:paragraph under a block affine:surface",
    );
    // A child id that is no id.
    let odd = update(&tab(&room, 9), |doc| {
        let txn = doc.transact();
        let blocks = txn.get_map(board::ROOT).unwrap();
        let note = map_at(&txn, &blocks, "note");
        let Some(yrs::Out::YArray(children)) = note.get(&txn, "sys:children") else {
            panic!("no children");
        };
        drop(txn);
        yrs::Array::push_back(&children, &mut doc.transact_mut(), 7);
    });
    refused(send(&room, &odd), "a child that is not an id");
}

/// Relations two people's honest edits can break together are not refused
/// (Epo 2026-11-22, "but A seems simpler, do A").
#[test]
fn relations_are_not_refused() {
    let held = room_with_note();
    let room = &held;
    let writer = tab(room, 8);
    // A child that does not exist, a block with no parent, a block under two.
    let paragraph = fields(&[("prop:text", t("x"))]);
    for edit in [
        update(&writer, |doc| {
            let txn = doc.transact();
            let note = map_at(&txn, &txn.get_map(board::ROOT).unwrap(), "note");
            let Some(yrs::Out::YArray(children)) = note.get(&txn, "sys:children") else {
                panic!("no children");
            };
            drop(txn);
            yrs::Array::push_back(&children, &mut doc.transact_mut(), "missing");
        }),
        update(&writer, |doc| {
            add_block(doc, "p1", "affine:paragraph", None, &paragraph)
        }),
        update(&writer, |doc| {
            add_block(doc, "p2", "affine:paragraph", Some("note"), &paragraph)
        }),
        update(&writer, |doc| {
            let txn = doc.transact();
            let note = map_at(&txn, &txn.get_map(board::ROOT).unwrap(), "note");
            let Some(yrs::Out::YArray(children)) = note.get(&txn, "sys:children") else {
                panic!("no children");
            };
            drop(txn);
            yrs::Array::push_back(&children, &mut doc.transact_mut(), "p2");
        }),
    ] {
        assert_eq!(send(room, &edit), Ok(()));
    }
    // A group of elements that do not exist, a connector to nothing, a mind
    // map whose nodes are no shapes.
    for (kind, fields) in editor_elements("e1") {
        if matches!(kind, "group" | "connector" | "mindmap") {
            let room = common::room();
            assert_eq!(
                send(
                    &room,
                    &update(&tab(&room, 8), |doc| add_element(doc, "e1", &fields))
                ),
                Ok(()),
                "{kind}"
            );
        }
    }
}

/// A person erases an element or a block and undoes it while offline (or
/// in a resend): the tab sends both as one update, the entry brought back
/// after the one it deletes.
#[test]
fn an_erase_and_its_undo_sent_as_one_update_are_admitted() {
    let erase_and_undo = |room: &yrs::Doc, erase: &dyn Fn(&yrs::Doc)| {
        let writer = tab(room, 8);
        let mut undo: UndoManager = UndoManager::with_options(Default::default());
        undo.expand_scope(&writer, &writer.get_or_insert_map(board::ROOT));
        update(&writer, |doc| {
            erase(doc);
            assert!(undo.undo_blocking(), "nothing to undo");
        })
    };
    // A brush stroke (a small edit, read by the overlay) and a shape (past
    // one, read from the trial).
    for (kind, fields) in editor_elements("e1") {
        if !matches!(kind, "brush" | "shape") {
            continue;
        }
        let room = room();
        send(
            &room,
            &update(&tab(&room, 7), |doc| add_element(doc, "e1", &fields)),
        )
        .unwrap();
        let bytes = erase_and_undo(&room, &|doc| remove_element(doc, "e1"));
        assert_eq!(send(&room, &bytes), Ok(()), "{kind}");
        let txn = room.transact();
        let element = map_at(&txn, &elements(&room, &txn), "e1");
        assert_eq!(element.get(&txn, "type"), Some(yrs::Out::Any(any!(kind))));
    }
    let room = room_with_note();
    let bytes = erase_and_undo(&room, &|doc| {
        doc.get_or_insert_map(board::ROOT)
            .remove(&mut doc.transact_mut(), "note");
    });
    assert_eq!(send(&room, &bytes), Ok(()));
    let txn = room.transact();
    map_at(&txn, &txn.get_map(board::ROOT).unwrap(), "note");
}

/// A replacement (an erase and its undo, `Map.set` over a live entry)
/// brings back the same kind: another would let one update put a block
/// under a parent its flavour may not have, where the children check never
/// looks.
#[test]
fn a_replaced_entity_keeps_its_kind() {
    let (room, _) = with_shape();
    let same = update(&tab(&room, 8), |doc| add_element(doc, "s1", &shape("s1")));
    assert_eq!(admit(&room, &same), Ok(()));
    let (_, text) = editor_elements("s1")
        .into_iter()
        .find(|(kind, _)| *kind == "text")
        .unwrap();
    let other = update(&tab(&room, 8), |doc| add_element(doc, "s1", &text));
    refused(
        admit(&room, &other),
        "a replaced canvas element keeps its type",
    );
    let room = room_with_note();
    let paragraph = |text: &str| fields(&[("prop:text", t(text))]);
    let under_note = update(&tab(&room, 8), |doc| {
        add_block(doc, "p1", "affine:paragraph", Some("note"), &paragraph("x"))
    });
    send(&room, &under_note).unwrap();
    let same = update(&tab(&room, 9), |doc| {
        add_block(doc, "p1", "affine:paragraph", None, &paragraph("y"))
    });
    assert_eq!(admit(&room, &same), Ok(()));
    let other = update(&tab(&room, 9), |doc| {
        add_block(doc, "p1", "affine:note", None, &note())
    });
    refused(admit(&room, &other), "a replaced block keeps its flavour");
}

/// Two writes at one key from one place: yrs keeps the earlier (it places
/// the later left of it), so a small edit's overlay, reading the last,
/// would judge what the room does not hold.
#[test]
fn a_key_written_twice_from_one_place_is_refused() {
    let (room, _) = with_shape();
    let (live, holder) = {
        let txn = room.transact();
        let value = elements(&room, &txn);
        let element = map_at(&txn, &value, "s1");
        let live = |key: &str| current(&element, key);
        ((live("shapeType"), live("xywh")), item_of(&value))
    };
    let (shape_type, xywh) = live;
    let star = by_hand(&[
        after(shape_type, Some("star")),
        after(shape_type, Some("rect")),
    ]);
    // Applied, the room keeps the star.
    let copy = tab(&room, 9);
    ydoc::apply(&copy, ydoc::decode(&star).unwrap()).unwrap();
    {
        let txn = copy.transact();
        let element = map_at(&txn, &elements(&copy, &txn), "s1");
        assert_eq!(
            element.get(&txn, "shapeType"),
            Some(yrs::Out::Any(any!("star")))
        );
    }
    refused(
        admit(&room, &star),
        "a map key written twice from one place",
    );
    // A required key deleted under a fitting write.
    let gone = by_hand(&[after(xywh, None), after(xywh, Some("[0,0,1,1]"))]);
    refused(
        admit(&room, &gone),
        "a map key written twice from one place",
    );
    // Two new elements under one id, the second a fitting shape: the first
    // would stay.
    let twice = by_hand(&[
        first_at(holder, "e9", None),
        first_at(holder, "e9", None),
        first_at((8, 1), "type", Some("shape")),
        first_at((8, 1), "id", Some("e9")),
        first_at((8, 1), "xywh", Some("[0,0,1,1]")),
    ]);
    refused(
        admit(&room, &twice),
        "a map key written twice from one place",
    );
}

/// Offline moves sent as one update: Yjs merges the overwritten values at
/// the key into one struct, a run whose last value the key holds.
#[test]
fn a_run_of_values_at_a_key_holds_its_last() {
    let (room, _) = with_shape();
    let xywh = |room: &yrs::Doc| {
        let txn = room.transact();
        current(&map_at(&txn, &elements(room, &txn), "s1"), "xywh")
    };
    let held = |room: &yrs::Doc| {
        let txn = room.transact();
        map_at(&txn, &elements(room, &txn), "s1").get(&txn, "xywh")
    };
    let moves = ["[1,0,10,10]", "[2,0,10,10]", "[3,0,10,10]"].map(string);
    // The run, then one more move after its last value.
    let bytes = by_hand(&[
        run_after(xywh(&room), &moves),
        after((8, 2), Some("[4,0,10,10]")),
    ]);
    assert_eq!(send(&room, &bytes), Ok(()));
    assert_eq!(held(&room), Some(yrs::Out::Any(any!("[4,0,10,10]"))));
    // The last value is what the rules read.
    let (room, _) = with_shape();
    let last = by_hand(&[run_after(
        xywh(&room),
        &[string("[1,0,10,10]"), string("nowhere")],
    )]);
    refused(
        admit(&room, &last),
        "canvas element shape: xywh is not what it holds",
    );
    // Every value is plain, the overwritten ones too: bytes, then a
    // fitting place.
    let mut bytes: Vec<u8> = vec![116];
    bytes.write_buf([1u8, 2]);
    let bytes_first = by_hand(&[run_after(xywh(&room), &[bytes, string("[1,0,10,10]")])]);
    refused(
        admit(&room, &bytes_first),
        "a map write holding a value that is not plain",
    );
}

/// Two people erase the same element and both undo: the second restore
/// lands over the first's, live, without deleting it, and keeps its kind.
#[test]
fn two_undos_of_one_erase_are_admitted() {
    let erased_twice = || {
        let (room, _) = with_shape();
        let tabs = [tab(&room, 8), tab(&room, 9)];
        let undos: Vec<UndoManager> = tabs
            .iter()
            .map(|tab| {
                let mut undo: UndoManager = UndoManager::with_options(Default::default());
                undo.expand_scope(tab, &tab.get_or_insert_map(board::ROOT));
                undo
            })
            .collect();
        for tab in &tabs {
            send(&room, &update(tab, |doc| remove_element(doc, "s1"))).unwrap();
        }
        (room, tabs, undos)
    };
    let (room, tabs, mut undos) = erased_twice();
    for (tab, undo) in tabs.iter().zip(&mut undos) {
        let restore = update(tab, |_| assert!(undo.undo_blocking(), "nothing to undo"));
        assert_eq!(send(&room, &restore), Ok(()));
    }
    {
        let txn = room.transact();
        let element = map_at(&txn, &elements(&room, &txn), "s1");
        assert_eq!(
            element.get(&txn, "type"),
            Some(yrs::Out::Any(any!("shape")))
        );
    }
    // Another kind written over the first's restore.
    let (room, tabs, mut undos) = erased_twice();
    send(
        &room,
        &update(&tabs[0], |_| assert!(undos[0].undo_blocking())),
    )
    .unwrap();
    let (_, text) = editor_elements("s1")
        .into_iter()
        .find(|(kind, _)| *kind == "text")
        .unwrap();
    let other = update(&tabs[1], |doc| add_element(doc, "s1", &text));
    refused(
        admit(&room, &other),
        "a replaced canvas element keeps its type",
    );
}

/// Yjs's `Map.set` chains a key's writes: setting one twice in a
/// transaction is admitted.
#[test]
fn a_key_set_twice_in_one_transaction_is_admitted() {
    let (room, _) = with_shape();
    let twice = update(&tab(&room, 8), |doc| {
        let value = elements(doc, &doc.transact());
        let element = map_at(&doc.transact(), &value, "s1");
        let mut txn = doc.transact_mut();
        element.insert(&mut txn, "shapeType", "rect");
        element.insert(&mut txn, "shapeType", "ellipse");
    });
    assert_eq!(send(&room, &twice), Ok(()));
    let txn = room.transact();
    let element = map_at(&txn, &elements(&room, &txn), "s1");
    assert_eq!(
        element.get(&txn, "shapeType"),
        Some(yrs::Out::Any(any!("ellipse")))
    );
}

/// An element stored as no rule takes (before a rule, or merged past one)
/// still moves as its placeholder: each key an update writes on it keeps
/// that key's own rule, and only a fitting entity is held whole.
#[test]
fn a_misfit_moves_and_takes_no_junk() {
    let stored = |id: &str, fields: &Fields| {
        let room = room();
        let bytes = update(&tab(&room, 7), |doc| add_element(doc, id, fields));
        ydoc::apply(&room, ydoc::decode(&bytes).unwrap()).unwrap();
        room
    };
    let write = |room: &yrs::Doc, id: &str, key: &str, value: yrs::Any| {
        update(&tab(room, 8), |doc| {
            set_element(doc, id, &fields(&[(key, a(value))]))
        })
    };
    let mut star = shape("s1");
    for (key, field) in &mut star {
        if key == "shapeType" {
            *field = a(any!("star"));
        }
    }
    let room = stored("s1", &star);
    assert_eq!(
        send(&room, &write(&room, "s1", "xywh", any!("[5,5,200,100]"))),
        Ok(())
    );
    refused(
        admit(&room, &write(&room, "s1", "junk", any!(1))),
        "canvas element shape: unknown key junk",
    );
    refused(
        admit(&room, &write(&room, "s1", "shapeType", any!("oval"))),
        "canvas element shape: shapeType is not what it holds",
    );
    // A type the board does not hold: its placeholder's place and turn.
    let unknown = fields(&[
        ("type", a(any!("sticker"))),
        ("id", a(any!("u1"))),
        ("xywh", place()),
    ]);
    let room = stored("u1", &unknown);
    assert_eq!(send(&room, &write(&room, "u1", "rotate", any!(15))), Ok(()));
    refused(
        admit(&room, &write(&room, "u1", "fillColor", any!("#000"))),
        "canvas element sticker: unknown key fillColor",
    );
    // No type at all: nothing new inside its text or its map.
    let typeless = fields(&[
        ("id", a(any!("n1"))),
        ("xywh", place()),
        ("text", t("hi")),
        ("children", m(&[])),
    ]);
    let room = stored("n1", &typeless);
    let inside = |edit: &dyn Fn(&yrs::Doc, &yrs::MapRef)| {
        update(&tab(&room, 8), |doc| {
            let element = map_at(&doc.transact(), &elements(doc, &doc.transact()), "n1");
            edit(doc, &element);
        })
    };
    let embed = inside(&|doc, element| {
        let Some(yrs::Out::YText(text)) = element.get(&doc.transact(), "text") else {
            panic!("no text");
        };
        yrs::Text::insert_embed(&text, &mut doc.transact_mut(), 0, any!({ "image": "x" }));
    });
    refused(admit(&room, &embed), board::rules::OUTSIDE);
    let entry = inside(&|doc, element| {
        let children = map_at(&doc.transact(), element, "children");
        children.insert(&mut doc.transact_mut(), "s1", true);
    });
    refused(admit(&room, &entry), board::rules::OUTSIDE);
}

#[test]
fn a_struct_outside_the_boards_shape_is_refused() {
    let room = room();
    let other = update(&tab(&room, 8), |doc| {
        doc.get_or_insert_map("meta")
            .insert(&mut doc.transact_mut(), "k", "v");
    });
    refused(admit(&room, &other), "a struct outside the board's shape");
    let not_a_map = update(&tab(&room, 8), |doc| {
        doc.get_or_insert_map(board::ROOT)
            .insert(&mut doc.transact_mut(), "stray", "value");
    });
    refused(admit(&room, &not_a_map), "a block that is not a map");
    // A map nested in an element's plain key.
    let (room, _) = with_shape();
    let nested = update(&tab(&room, 8), |doc| {
        let value = elements(doc, &doc.transact());
        let element = map_at(&doc.transact(), &value, "s1");
        let shadow = element.insert(&mut doc.transact_mut(), "shadow", MapPrelim::default());
        shadow.insert(&mut doc.transact_mut(), "blur", 1);
    });
    assert!(admit(&room, &nested).is_err());
}
