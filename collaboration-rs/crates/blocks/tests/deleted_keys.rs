#![allow(clippy::unwrap_used)]
//! What a deleted block leaves once its session has left and every window
//! has passed (collected at a window holding the delete, nothing held), in
//! the blocks layout and in Plate's, struct by struct; and why the
//! collection keeps a deleted `blocks` key: a replica holding that key's
//! deleted value and one that loaded a state without it order a fresh value
//! for the key differently (yrs `resolve_conflict`, by client id), so the
//! key's value is lost on one side. Run with `--nocapture` for the tables.

mod common;

use std::collections::HashSet;

use notes::slate::{Operation, Root};
use notes::{plate, slate_yjs};
use serde_json::{Value, json};
use ydoc::gc::{Window, collect, collect_with, names_collected};
use yrs::block::{ItemContent, ItemPtr};
use yrs::branch::BranchPtr;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::{Encoder, EncoderV1};
use yrs::{Doc, ID, IdSet, Map, Out, ReadTxn, Transact, Update};

fn three(ids: &[&str]) -> Vec<Value> {
    ids.iter()
        .map(|id| json!({"id": id, "type": "p", "children": [{"text": format!("Text of {id}")}]}))
        .collect()
}

/// What `doc` stores for the units in `ranges`: one row per struct, with
/// its encoded bytes, and the total.
fn stored(doc: &Doc, ranges: &[(ID, u32)]) -> (Vec<String>, usize) {
    let txn = doc.transact();
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    let mut total = 0;
    for (id, len) in ranges {
        for (range, item) in txn.store().blocks_in(&id.client, id.clock..id.clock + len) {
            if !seen.insert((id.client, range.clock)) {
                continue;
            }
            match item {
                None => {
                    // A GC struct: info byte and length.
                    let mut e = EncoderV1::new();
                    e.write_info(0);
                    e.write_len(range.len);
                    let bytes = e.to_vec().len();
                    total += bytes;
                    rows.push(format!(
                        "GC {}#{}..+{} ({bytes} B)",
                        id.client, range.clock, range.len
                    ));
                }
                Some(item) => {
                    let mut e = EncoderV1::new();
                    item.encode(&mut e);
                    let bytes = e.to_vec().len();
                    total += bytes;
                    let content = match item.content() {
                        ItemContent::Deleted(n) => format!("Deleted({n})"),
                        ItemContent::Type(_) => "Type".into(),
                        ItemContent::String(s) => format!("String({:?})", s.as_str()),
                        ItemContent::Any(v) => format!("Any({v:?})"),
                        other => format!("{other:?}").chars().take(30).collect(),
                    };
                    rows.push(format!(
                        "Item {}#{} len {} deleted {} key {:?} origin {:?} right {:?} content {content} ({bytes} B)",
                        id.client,
                        item.id().clock,
                        item.len(),
                        item.is_deleted(),
                        item.parent_sub().map(|k| k.to_string()),
                        item.origin().map(|o| (o.client.get(), o.clock)),
                        item.right_origin().map(|o| (o.client.get(), o.clock)),
                    ));
                }
            }
        }
    }
    (rows, total)
}

/// `doc` collected at a window of itself, nothing held, loaded fresh.
fn collected(doc: &Doc) -> (Doc, usize) {
    let window = Window::of(&doc.transact(), 1);
    let state = collect(doc, &window, &IdSet::new(), None).state;
    (common::doc(&state, 99), state.len())
}

/// The unit listing `id` in `txn`'s note's `sys:children`.
fn listing(doc: &Doc, id: &str) -> (ID, u32) {
    let txn = doc.transact();
    let children = common::children(&txn, blocks::NOTE_ID);
    let mut next = BranchPtr::from(children.as_ref() as &yrs::branch::Branch).start();
    while let Some(item) = next {
        if let ItemContent::Any(values) = item.content()
            && let Some(at) = values.iter().position(|v| v.to_string() == id)
        {
            return (ID::new(item.id().client, item.id().clock + at as u32), 1);
        }
        next = item.right();
    }
    panic!("{id} is not listed");
}

fn blocks_item(doc: &Doc, id: &str) -> ItemPtr {
    let txn = doc.transact();
    let Some(Out::YMap(block)) = common::blocks_map(&txn).get(&txn, id) else {
        panic!("no block {id}");
    };
    block.as_ref().item().unwrap()
}

#[test]
fn what_a_deleted_block_leaves_after_collection_blocks_and_plate() {
    for deleted in [&["b"][..], &["b", "c", "d"][..]] {
        let ids = ["a", "b", "c", "d", "e"];
        // Blocks.
        let doc = common::doc(&blocks::state_from_value(&three(&ids), 1).unwrap(), 7);
        let mut ranges = Vec::new();
        for id in deleted {
            common::subtree(blocks_item(&doc, id), &mut ranges);
            ranges.push(listing(&doc, id));
        }
        for id in deleted {
            common::delete_block(&mut doc.transact_mut(), id);
        }
        let (after, size) = collected(&doc);
        let (rows, bytes) = stored(&after, &ranges);
        println!(
            "blocks, deleted {deleted:?}: {bytes} B in structs (state {size} B)\n  {}",
            rows.join("\n  ")
        );
        let kept: Vec<&String> = rows.iter().filter(|r| r.starts_with("Item")).collect();
        // Each deleted id keeps its `blocks` key, holding no content.
        for id in deleted {
            assert!(
                kept.iter().any(|r| r.contains(&format!("key Some({:?})", id))
                    && r.contains("Deleted(1)")),
                "{rows:?}"
            );
        }
        assert!(kept.iter().all(|r| r.contains("Deleted(")), "{rows:?}");

        // Plate.
        let doc = common::doc(&slate_yjs::state_from_value(&three(&ids), 1), 7);
        let mut ranges = Vec::new();
        {
            let txn = doc.transact();
            let root = plate::content_root(&txn).unwrap();
            let mut next = root.start();
            while let Some(item) = next {
                if let ItemContent::Type(inner) = item.content() {
                    let branch = BranchPtr::from(inner.as_ref());
                    let id = branch
                        .map_items()
                        .find(|(k, _)| k.as_ref() == "id")
                        .and_then(|(_, v)| match v.content() {
                            ItemContent::Any(any) => Some(any[0].to_string()),
                            _ => None,
                        });
                    if id.is_some_and(|id| deleted.contains(&id.as_str())) {
                        common::subtree(item, &mut ranges);
                    }
                }
                next = item.right();
            }
        }
        assert!(!ranges.is_empty());
        let mut root = Root::new(plate::value(&doc.transact()).unwrap());
        {
            let mut txn = doc.transact_mut();
            let y_root = plate::content_root(&txn).unwrap();
            let node = root.children[1].clone();
            let mut ops = vec![Operation::RemoveNode {
                path: vec![1],
                node,
            }];
            for _ in 1..deleted.len() {
                let mut after = root.clone();
                for op in &ops {
                    after.apply(op).unwrap();
                }
                ops.push(Operation::RemoveNode {
                    path: vec![1],
                    node: after.children[1].clone(),
                });
            }
            slate_yjs::apply_ops(&mut txn, y_root, &mut root, &ops).unwrap();
        }
        let (after, size) = collected(&doc);
        let (rows, bytes) = stored(&after, &ranges);
        println!(
            "plate, deleted {deleted:?}: {bytes} B in structs (state {size} B)\n  {}",
            rows.join("\n  ")
        );
        let kept: Vec<&String> = rows.iter().filter(|r| r.starts_with("Item")).collect();
        assert!(kept.iter().all(|r| r.contains("key None")), "{rows:?}");
    }
    println!(
        "in memory: yrs Item {} B each (a kept key adds its Arc<str> and a map entry); a GC run is one block-store cell",
        std::mem::size_of::<yrs::block::Item>()
    );
}

/// `doc` collected at a window of itself with the blocks rule
/// (`blocks::unique_key`), `held` held, loaded fresh.
fn collected_keyed(doc: &Doc, held: &IdSet) -> Doc {
    let window = Window::of(&doc.transact(), 1);
    let state = collect_with(doc, &window, held, None, Some(&blocks::unique_key)).state;
    let fresh = common::doc(&state, 98);
    assert!(!ydoc::has_pending(&fresh.transact()));
    fresh
}

fn live(doc: &Doc, id: &str) -> bool {
    let txn = doc.transact();
    common::blocks_map(&txn).get(&txn, id).is_some()
}

/// Room R holds `a` (client 1) and `b`, added then deleted by client 50,
/// whose session then left. Returns R (uncollected: a replica holding b's
/// deleted value, as a tab open since before a collection) and C, R
/// collected with the blocks rule, which lets b's key go.
fn with_and_without_the_key() -> (Doc, Doc) {
    let room = common::doc(&blocks::state_from_value(&three(&["a"]), 1).unwrap(), 2);
    let writer = common::doc(&common::state(&room), 50);
    common::add_paragraph(&mut writer.transact_mut(), "b", "Bravo", blocks::NOTE_ID, 1);
    let head = *blocks_item(&writer, "b").id();
    common::delete_block(&mut writer.transact_mut(), "b");
    common::apply(&room, &common::state(&writer));
    let c = collected_keyed(&room, &IdSet::new());
    assert_eq!(
        blocks::value(&c.transact()).unwrap(),
        blocks::value(&room.transact()).unwrap()
    );
    assert!(!common::holds_key(&c.transact(), "b"));
    assert!(matches!(
        c.transact().store().get_block_range(&head),
        Some((_, None))
    ));
    (room, c)
}

/// The rule keeps a held key: the deleter's Undo inside 24 h sets it again
/// naming the value, and every replica agrees.
#[test]
fn a_held_deleted_key_stays_and_its_undo_agrees() {
    let room = common::doc(&blocks::state_from_value(&three(&["a"]), 1).unwrap(), 2);
    let tab = common::doc(&common::state(&room), 50);
    let mut undo = yrs::undo::UndoManager::<()>::with_options(yrs::undo::Options {
        capture_timeout_millis: 0,
        tracked_origins: HashSet::from([yrs::Origin::from("tab")]),
        ..Default::default()
    });
    undo.expand_scope(&tab, &tab.get_or_insert_map(blocks::BLOCKS_ROOT));
    common::add_paragraph(&mut tab.transact_mut(), "b", "Bravo", blocks::NOTE_ID, 1);
    common::apply(&room, &common::state(&tab));
    let before = room.transact().state_vector();
    common::delete_block(&mut tab.transact_mut_with("tab"), "b");
    let (_, held) = ydoc::apply_deleting(
        &room,
        ydoc::decode(&tab.transact().encode_state_as_update_v1(&before)).unwrap(),
    )
    .unwrap();
    let c = collected_keyed(&room, &held);
    assert!(common::holds_key(&c.transact(), "b"));
    let before = tab.transact().state_vector();
    assert!(undo.undo_blocking());
    let undone = tab.transact().encode_state_as_update_v1(&before);
    assert!(!names_collected(
        &c.transact(),
        &Update::decode_v1(&undone).unwrap()
    ));
    for doc in [&c, &room] {
        common::apply(doc, &undone);
        assert_eq!(common::text_of(&doc.transact(), "b"), "Bravo");
        blocks::check(&doc.transact()).unwrap();
    }
}

/// Without the D20 rule: a tab that loaded C (no key for `b`) pastes `b`
/// keeping its id. Its value has no origin, and on R, which holds b's
/// deleted value, yrs orders it before that value when the paster's client
/// id is lower than the deleter's (50): it reads deleted there and live on
/// C, and nothing names collected history, so admission cannot tell. With
/// the rule the paste takes a fresh id (the tab lacks the key) and every
/// replica agrees, whatever the client ids.
#[test]
fn a_paste_without_the_key_takes_a_fresh_id_and_agrees() {
    for client in [10, 90] {
        // The divergence the rule prevents.
        let (holder, c) = with_and_without_the_key();
        let paster = common::doc(&common::state(&c), client);
        let before = paster.transact().state_vector();
        common::add_paragraph(
            &mut paster.transact_mut(),
            "b",
            "Pasted",
            blocks::NOTE_ID,
            1,
        );
        let update = paster.transact().encode_state_as_update_v1(&before);
        assert!(!names_collected(
            &c.transact(),
            &Update::decode_v1(&update).unwrap()
        ));
        common::apply(&c, &update);
        common::apply(&holder, &update);
        assert!(live(&c, "b"));
        assert_eq!(live(&holder, "b"), client > 50, "paster {client}");

        // With the rule.
        let (holder, c) = with_and_without_the_key();
        let paster = common::doc(&common::state(&c), client);
        let before = paster.transact().state_vector();
        let id = common::paste_id(&paster.transact(), "b", "b-fresh");
        assert_eq!(id, "b-fresh");
        common::add_paragraph(
            &mut paster.transact_mut(),
            &id,
            "Pasted",
            blocks::NOTE_ID,
            1,
        );
        let update = paster.transact().encode_state_as_update_v1(&before);
        for doc in [&c, &holder] {
            common::apply(doc, &update);
            blocks::check(&doc.transact()).unwrap();
        }
        assert_eq!(
            blocks::blocks_json(&c.transact()),
            blocks::blocks_json(&holder.transact())
        );
    }
}

/// A tab holding b's deleted value (open since before the collection) pastes
/// `b` keeping its id (D20: it holds the key). Its value names the
/// collected value, so it is answered late (Q443). The plain late merge
/// writes it with no origin, losing it on other holders; the keyed merge
/// (`merge_keyed`) leaves it out and reports it, the tab pastes it again
/// under a fresh id after `a`, and every replica agrees.
#[test]
fn a_holder_pasting_a_let_go_key_is_answered_late_and_rekeyed() {
    for client in [10, 90] {
        let (holder, c) = with_and_without_the_key();
        let tab = common::doc(&common::state(&holder), client);
        let before = tab.transact().state_vector();
        let id = common::paste_id(&tab.transact(), "b", "b-fresh");
        assert_eq!(id, "b");
        common::add_paragraph(&mut tab.transact_mut(), &id, "Pasted", blocks::NOTE_ID, 1);
        let update = tab.transact().encode_state_as_update_v1(&before);
        assert!(names_collected(
            &c.transact(),
            &Update::decode_v1(&update).unwrap()
        ));

        // The plain merge: live on C, lost on the holder for a low id.
        let merged = late_merge::merge(&common::state(&tab), &common::state(&c)).unwrap();
        let (h2, c2) = (
            common::doc(&common::state(&holder), 4),
            common::doc(&common::state(&c), 5),
        );
        common::apply(&c2, &merged.update);
        common::apply(&h2, &merged.update);
        assert!(live(&c2, "b"));
        assert_eq!(live(&h2, "b"), client > 50);

        // The keyed merge: reported, pasted again, the same everywhere.
        let merged = late_merge::merge_keyed(
            &common::state(&tab),
            &common::state(&c),
            &late_merge::BLOCKS,
        )
        .unwrap();
        assert!(merged.hidden.is_empty());
        assert_eq!(
            merged.rekeyed,
            [late_merge::Rekey {
                key: "b".into(),
                item: *blocks_item(&tab, "b").id(),
                parent: Some(blocks::NOTE_ID.into()),
                left: Some("a".into()),
                subtree: Vec::new(),
            }]
        );
        assert!(!names_collected(
            &c.transact(),
            &Update::decode_v1(&merged.update).unwrap()
        ));
        let rekeyed = settle(&c, &tab, &merged, client);
        {
            let doc = &holder;
            common::apply(doc, &merged.update);
            common::apply(doc, &rekeyed);
        }
        for doc in [&c, &holder] {
            assert!(!live(doc, "b"));
            blocks::check(&doc.transact()).unwrap();
            assert_eq!(
                common::child_ids(&doc.transact(), blocks::NOTE_ID),
                ["a", "b-1"]
            );
            assert_eq!(common::text_of(&doc.transact(), "b-1"), "Pasted");
        }
        assert_eq!(
            blocks::blocks_json(&c.transact()),
            blocks::blocks_json(&holder.transact())
        );
    }
}

/// The room admits a keyed merge and repairs on entry; the tab reloads on
/// it and pastes the reported blocks again (`common::repaste`, ids `b-1`,
/// `b-2`, ...), which the room admits. Returns what the room took after the
/// merge (its repair and the re-paste), for the other replicas.
fn settle(room: &Doc, tab: &Doc, merged: &late_merge::Merged, client: u64) -> Vec<u8> {
    let start = room.transact().state_vector();
    common::apply(room, &merged.update);
    blocks::repair(&mut room.transact_mut());
    let reloaded = common::doc(&common::state(room), client);
    let before = reloaded.transact().state_vector();
    let mut n = 0;
    common::repaste(
        tab,
        &mut reloaded.transact_mut(),
        &merged.rekeyed,
        &mut || {
            n += 1;
            format!("b-{n}")
        },
    );
    let pasted = reloaded.transact().encode_state_as_update_v1(&before);
    assert!(!names_collected(
        &room.transact(),
        &Update::decode_v1(&pasted).unwrap()
    ));
    common::apply(room, &pasted);
    room.transact().encode_state_as_update_v1(&start)
}

/// The report's shape: a holder pastes `b` after `a` (keeping its id), adds
/// `c1` and moves it under `b`, and types into `d`, which a co-editor
/// deleted. The keyed merge reports `b` (its parent, its left sibling, and
/// `c1` below it, left out with it) and keeps the typing into `d` hidden;
/// after the re-paste every replica holds `a`, a fresh `b` with a fresh
/// `c1` under it, and no `d`.
#[test]
fn a_rekey_reports_its_place_and_subtree_and_typing_stays_hidden() {
    let r = common::doc(
        &blocks::state_from_value(&three(&["a", "d"]), 1).unwrap(),
        2,
    );
    let writer = common::doc(&common::state(&r), 50);
    common::add_paragraph(&mut writer.transact_mut(), "b", "Bravo", blocks::NOTE_ID, 1);
    common::delete_block(&mut writer.transact_mut(), "b");
    common::apply(&r, &common::state(&writer));
    let tab = common::doc(&common::state(&r), 10);
    let other = common::doc(&common::state(&r), 60);
    common::delete_block(&mut other.transact_mut(), "d");
    common::apply(&r, &common::state(&other));
    let c = collected_keyed(&r, &IdSet::new());

    assert_eq!(common::paste_id(&tab.transact(), "b", "b-fresh"), "b");
    common::add_paragraph(&mut tab.transact_mut(), "b", "Pasted", blocks::NOTE_ID, 1);
    common::add_paragraph(&mut tab.transact_mut(), "c1", "Child", blocks::NOTE_ID, 3);
    common::move_block(&mut tab.transact_mut(), "c1", "b", 0);
    {
        let mut txn = tab.transact_mut();
        yrs::Text::insert(&common::text(&txn, "d"), &mut txn, 0, "typed ");
    }

    let merged = late_merge::merge_keyed(
        &common::state(&tab),
        &common::state(&c),
        &late_merge::BLOCKS,
    )
    .unwrap();
    assert_eq!(
        merged.rekeyed,
        [late_merge::Rekey {
            key: "b".into(),
            item: *blocks_item(&tab, "b").id(),
            parent: Some(blocks::NOTE_ID.into()),
            left: Some("a".into()),
            subtree: vec!["c1".into()],
        }]
    );
    let d = {
        let txn = tab.transact();
        let Some(Out::YMap(d)) = common::blocks_map(&txn).get(&txn, "d") else {
            panic!("no d");
        };
        *d.as_ref().item().unwrap().id()
    };
    assert_eq!(merged.hidden, [d]);

    let took = settle(&c, &tab, &merged, 10);
    common::apply(&r, &took);
    for doc in [&c, &r] {
        let txn = doc.transact();
        blocks::check(&txn).unwrap();
        assert_eq!(common::child_ids(&txn, blocks::NOTE_ID), ["a", "b-1"]);
        assert_eq!(common::child_ids(&txn, "b-1"), ["b-2"]);
        assert_eq!(common::text_of(&txn, "b-1"), "Pasted");
        assert_eq!(common::text_of(&txn, "b-2"), "Child");
        assert!(!live(doc, "b") && !live(doc, "c1") && !live(doc, "d"));
    }
    assert_eq!(
        blocks::blocks_json(&c.transact()),
        blocks::blocks_json(&r.transact())
    );
}
