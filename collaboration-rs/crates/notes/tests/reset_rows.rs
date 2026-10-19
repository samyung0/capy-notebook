#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! Security regression (room reset as last resort, Epo 2026-10-18 and
//! 2026-10-19): every update that passed admission and then made the store
//! refuse the room, discarding every editor's unsaved state, now ends one of
//! three ways: repaired on entry (`repair::on_entry`, right after the apply),
//! refused on entry (`Validator::admit`, only that writer's editor reloads),
//! or repaired at save (`repair::repair`). Each case is a row the review
//! confirmed against the old server, plus the void rows; every one ends in a
//! document the store takes. Fails if any rule is reverted.

use notes::limits::{self, Admission, Refusal, Validator};
use notes::{material, plate, repair, slate_yjs};
use serde_json::{Value, json};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, ReadTxn, StateVector, Text, Transact, Update, Xml, XmlTextPrelim, XmlTextRef,
};

fn note() -> Vec<Value> {
    vec![
        json!({ "type": "p", "id": "a", "children": [{ "text": "first" }] }),
        json!({ "type": "hr", "id": "rule", "children": [{ "text": "" }] }),
        json!({ "type": "img", "id": "pic", "assetId": "asset_1", "children": [{ "text": "" }] }),
        json!({ "type": "mermaid", "id": "m", "source": "flowchart LR\n  A --> B", "children": [
            { "type": "mermaid_caption", "children": [{ "text": "Flow" }] },
        ] }),
        json!({ "type": "material_ref", "id": "ref", "materialId": "mat_cards", "refKind": "flashcards",
            "children": [{ "text": "" }] }),
        json!({ "type": "p", "id": "b", "children": [
            { "text": "say " },
            { "type": "mention", "value": "Ada", "children": [{ "text": "" }] },
            { "text": " now" },
        ] }),
    ]
}

fn mindmap() -> Vec<Value> {
    vec![
        json!({ "type": "mermaid", "id": "m", "source": "mindmap\n  root((Cells))", "children": [
            { "type": "mermaid_caption", "children": [{ "text": "Cells" }] },
        ] }),
    ]
}

/// A room holding `value`, seeded as the store seeds one.
fn room(value: &[Value]) -> Doc {
    let doc = Doc::with_options(ydoc::doc_options(1));
    doc.transact_mut()
        .apply_update(Update::decode_v1(&slate_yjs::state_from_value(value, 1)).unwrap())
        .unwrap();
    doc
}

/// What a peer's edit sends: its changes since `base`'s state.
fn edit(base: &Doc, client: u64, change: impl FnOnce(&Doc)) -> Vec<u8> {
    let peer = Doc::with_options(ydoc::doc_options(client));
    let state = base
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    peer.transact_mut()
        .apply_update(Update::decode_v1(&state).unwrap())
        .unwrap();
    let before = peer.transact().state_vector();
    change(&peer);
    peer.transact().encode_state_as_update_v1(&before)
}

fn root(peer: &Doc) -> XmlTextRef {
    XmlTextRef::from(plate::content_root(&peer.transact()).unwrap())
}

/// The top-level block at `index` of a peer.
fn block(peer: &Doc, index: usize) -> XmlTextRef {
    let txn = peer.transact();
    let root = plate::content_root(&txn).unwrap();
    let blocks: Vec<_> = plate::insert_delta(&root)
        .unwrap()
        .into_iter()
        .filter_map(|op| match op.insert {
            plate::Insert::Element(block) => Some(block),
            plate::Insert::Text(_) => None,
        })
        .collect();
    XmlTextRef::from(blocks[index])
}

fn canonical(doc: &Doc, kind: &str) -> Result<(), material::ValidationError> {
    material::assert_canonical(&plate::value(&doc.transact()).unwrap(), kind)
}

/// Admits `update` into `room` as the server does; when accepted, applies it
/// and runs the entry repair. Returns the admission.
fn arrive(room: &Doc, kind: &str, update: &[u8]) -> Result<Admission, Refusal> {
    let decoded = Update::decode_v1(update).unwrap();
    let admitted = Validator::new(kind).admit(room, &decoded)?;
    room.transact_mut().apply_update(decoded).unwrap();
    let mut txn = room.transact_mut();
    repair::on_entry(&mut txn, &Update::decode_v1(update).unwrap(), kind);
    Ok(admitted)
}

fn refused(result: Result<Admission, Refusal>, reason: &str) {
    match result {
        Err(Refusal::Content(what)) => assert_eq!(what, reason),
        other => panic!("expected a refusal ({reason}), got {other:?}"),
    }
}

#[test]
fn rows_refused_on_entry() {
    let base = room(&note());
    // A mark no leaf carries.
    for key in ["suggestion_abc", "suggestion", "children", "type"] {
        let marked = edit(&base, 2, |peer| {
            let mut attrs = yrs::types::Attrs::new();
            attrs.insert(key.into(), Any::Bool(true));
            block(peer, 0).format(&mut peer.transact_mut(), 0, 3, attrs);
        });
        refused(Validator::new("note").admit(&base, &decode(&marked)), limits::LEAF_MARK);
    }
    // A bare string at the root.
    let bare = edit(&base, 3, |peer| root(peer).insert(&mut peer.transact_mut(), 0, "bare"));
    refused(Validator::new("note").admit(&base, &decode(&bare)), limits::ROOT_TEXT);
    // An html_embed whose child is a paragraph.
    let embed_child = edit(&base, 4, |peer| {
        let mut txn = peer.transact_mut();
        let root = plate::content_root(&txn).unwrap();
        slate_yjs::insert_nodes(&mut txn, root, 0, &[json!({
            "type": "html_embed", "id": "h", "html": "<b>x</b>",
            "children": [{ "type": "p", "children": [{ "text": "inside" }] }],
        })]);
    });
    refused(Validator::new("note").admit(&base, &decode(&embed_child)), limits::CHILDREN);
    // A paragraph inside a Mermaid caption.
    let caption_element = edit(&base, 5, |peer| {
        let caption = match &plate::insert_delta(block(peer, 3).as_ref()).unwrap()[0].insert {
            plate::Insert::Element(caption) => XmlTextRef::from(*caption),
            plate::Insert::Text(_) => panic!("no caption"),
        };
        let mut txn = peer.transact_mut();
        let p: XmlTextRef = caption.insert_embed(&mut txn, 0, XmlTextPrelim::new(""));
        p.insert_attribute(&mut txn, "type", "p");
        p.insert(&mut txn, 0, "x");
    });
    refused(Validator::new("note").admit(&base, &decode(&caption_element)), limits::CHILDREN);
    // A Mermaid block holding a string instead of its caption.
    let no_caption = edit(&base, 6, |peer| {
        let mut txn = peer.transact_mut();
        let root = plate::content_root(&txn).unwrap();
        slate_yjs::insert_nodes(&mut txn, root, 0, &[json!({
            "type": "mermaid", "id": "m2", "source": "flowchart LR\n  A --> B",
            "children": [{ "text": "no caption" }],
        })]);
    });
    refused(Validator::new("note").admit(&base, &decode(&no_caption)), limits::CHILDREN);
    // A Mermaid block whose caption is deleted.
    let caption_gone = edit(&base, 7, |peer| {
        block(peer, 3).remove_range(&mut peer.transact_mut(), 0, 1);
    });
    refused(Validator::new("note").admit(&base, &decode(&caption_gone)), limits::CHILDREN);

    // A mindmap without its mermaid, emptied or holding a paragraph instead.
    let map = room(&mindmap());
    let emptied = edit(&map, 8, |peer| root(peer).remove_range(&mut peer.transact_mut(), 0, 1));
    refused(Validator::new("mindmap").admit(&map, &decode(&emptied)), limits::MISSING_REQUIRED);
    let replaced = edit(&map, 9, |peer| {
        let mut txn = peer.transact_mut();
        let root = plate::content_root(&txn).unwrap();
        XmlTextRef::from(root).remove_range(&mut txn, 0, 1);
        slate_yjs::insert_nodes(&mut txn, root, 0, &[json!({
            "type": "p", "id": "p", "children": [{ "text": "x" }],
        })]);
    });
    refused(Validator::new("mindmap").admit(&map, &decode(&replaced)), limits::MISSING_REQUIRED);
    // Editing the map's caption still goes in.
    let typed = edit(&map, 10, |peer| {
        let caption = match &plate::insert_delta(block(peer, 0).as_ref()).unwrap()[0].insert {
            plate::Insert::Element(caption) => XmlTextRef::from(*caption),
            plate::Insert::Text(_) => panic!("no caption"),
        };
        caption.insert(&mut peer.transact_mut(), 0, "Big ");
    });
    assert!(Validator::new("mindmap").admit(&map, &decode(&typed)).is_ok());
}

/// Every catalog void element holds one empty text leaf (Epo 2026-10-18):
/// text or an element written into a held one, a void block made with text,
/// and a paragraph holding text retyped into a void block are refused, while
/// a void block made empty goes in.
#[test]
fn void_children_are_refused_on_entry() {
    let base = room(&note());
    // hr, img, material_ref at the top level; mention inside paragraph b.
    for index in [1, 2, 4] {
        let text = edit(&base, 11, |peer| block(peer, index).insert(&mut peer.transact_mut(), 0, "hidden"));
        refused(Validator::new("note").admit(&base, &decode(&text)), limits::CHILDREN);
        let element = edit(&base, 12, |peer| {
            let held = block(peer, index);
            let mut txn = peer.transact_mut();
            let p: XmlTextRef = held.insert_embed(&mut txn, 0, XmlTextPrelim::new(""));
            p.insert_attribute(&mut txn, "type", "p");
        });
        refused(Validator::new("note").admit(&base, &decode(&element)), limits::CHILDREN);
    }
    let mention_text = edit(&base, 13, |peer| {
        let mention = match &plate::insert_delta(block(peer, 5).as_ref()).unwrap()[1].insert {
            plate::Insert::Element(mention) => XmlTextRef::from(*mention),
            plate::Insert::Text(_) => panic!("no mention"),
        };
        mention.insert(&mut peer.transact_mut(), 0, "hidden");
    });
    refused(Validator::new("note").admit(&base, &decode(&mention_text)), limits::CHILDREN);
    let made = |children: Value| {
        edit(&base, 14, |peer| {
            let mut txn = peer.transact_mut();
            let root = plate::content_root(&txn).unwrap();
            slate_yjs::insert_nodes(&mut txn, root, 0, &[json!({
                "type": "hr", "id": "rule2", "children": children,
            })]);
        })
    };
    refused(
        Validator::new("note").admit(&base, &decode(&made(json!([{ "text": "hr with text" }])))),
        limits::CHILDREN,
    );
    assert!(Validator::new("note").admit(&base, &decode(&made(json!([{ "text": "" }])))).is_ok());
    let retyped = edit(&base, 15, |peer| {
        block(peer, 0).insert_attribute(&mut peer.transact_mut(), "type", "hr");
    });
    refused(Validator::new("note").admit(&base, &decode(&retyped)), limits::CHILDREN);
}

fn decode(update: &[u8]) -> Update {
    Update::decode_v1(update).unwrap()
}

#[test]
fn rows_repaired_on_entry() {
    // A paragraph carrying a `text` attribute, and a block given an obsolete
    // `suggestion` key: admitted, then stripped by the entry repair.
    let doc = room(&note());
    let text_attr = edit(&doc, 2, |peer| {
        let mut txn = peer.transact_mut();
        let root = XmlTextRef::from(plate::content_root(&txn).unwrap());
        let p: XmlTextRef = root.insert_embed(&mut txn, 0, XmlTextPrelim::new(""));
        p.insert_attribute(&mut txn, "type", "p");
        p.insert_attribute(&mut txn, "id", "t");
        p.insert_attribute(&mut txn, "text", "attr");
        p.insert(&mut txn, 0, "x");
    });
    assert!(arrive(&doc, "note", &text_attr).is_ok());
    let suggestion = edit(&doc, 3, |peer| {
        block(peer, 1).insert_attribute(&mut peer.transact_mut(), "suggestion", true);
        block(peer, 2).insert_attribute(&mut peer.transact_mut(), "suggestion_x", true);
    });
    assert!(arrive(&doc, "note", &suggestion).is_ok());
    canonical(&doc, "note").unwrap();
    let value = plate::value(&doc.transact()).unwrap();
    assert_eq!(value[0]["children"], json!([{ "text": "x" }]));
    assert!(value[0].get("text").is_none() && value[1].get("suggestion").is_none());

    // Every block deleted: the note gets one empty paragraph at once.
    let doc = room(&note());
    let all = edit(&doc, 4, |peer| {
        let len = root(peer).len(&peer.transact());
        root(peer).remove_range(&mut peer.transact_mut(), 0, len);
    });
    assert!(arrive(&doc, "note", &all).is_ok());
    canonical(&doc, "note").unwrap();
    let value = plate::value(&doc.transact()).unwrap();
    assert_eq!(value.len(), 1);
    assert_eq!(value[0]["type"], "p");
    assert_eq!(value[0]["children"], json!([{ "text": "" }]));
}

/// Two writers on a two-block note each delete one of the last two blocks,
/// as people editing together do (no crafted update): both go in, and the
/// emptied note gets its paragraph as the second arrives, so nobody is
/// refused and the room never resets.
#[test]
fn two_writers_deleting_the_last_two_blocks_leave_a_paragraph() {
    let two = [
        json!({ "type": "p", "id": "a", "children": [{ "text": "one" }] }),
        json!({ "type": "p", "id": "b", "children": [{ "text": "two" }] }),
    ];
    let doc = room(&two);
    let first = edit(&doc, 2, |peer| root(peer).remove_range(&mut peer.transact_mut(), 0, 1));
    let second = edit(&doc, 3, |peer| root(peer).remove_range(&mut peer.transact_mut(), 1, 1));
    assert!(matches!(arrive(&doc, "note", &first), Ok(Admission::Accepted)));
    canonical(&doc, "note").unwrap();
    assert!(matches!(arrive(&doc, "note", &second), Ok(Admission::Accepted)));
    canonical(&doc, "note").unwrap();
    assert_eq!(plate::value(&doc.transact()).unwrap()[0]["id"], "repaired");
}

/// Two top-level blocks given one id (two writers moving one block at once
/// make it): admitted, refused by the store, repaired at save with a fresh
/// id for the later one.
#[test]
fn a_repeated_block_id_is_repaired_at_save() {
    let doc = room(&note());
    let repeated = edit(&doc, 2, |peer| {
        let mut txn = peer.transact_mut();
        let root = plate::content_root(&txn).unwrap();
        slate_yjs::insert_nodes(&mut txn, root, 1, &[json!({
            "type": "p", "id": " a", "children": [{ "text": "copy" }],
        })]);
    });
    assert!(arrive(&doc, "note", &repeated).is_ok());
    assert!(canonical(&doc, "note").is_err());
    let repaired = repair::repair(&mut doc.transact_mut(), "note");
    assert_eq!(repaired, [repair::REPEATED_IDS]);
    canonical(&doc, "note").unwrap();
    let value = plate::value(&doc.transact()).unwrap();
    assert_eq!((value[0]["id"].as_str(), value[1]["id"].as_str()), (Some("a"), Some("a-2")));
}

/// A key a video forbids, written as null: admission takes null as absent,
/// the video's own check refuses the key by its presence, so the entry
/// repair removes it (found by the parity sweep).
#[test]
fn a_forbidden_key_written_as_null_is_removed_on_entry() {
    let value = vec![
        json!({ "type": "p", "id": "a", "children": [{ "text": "x" }] }),
        json!({ "type": "video", "id": "v", "provider": "youtube", "videoId": "dQw4w9WgXcQ",
            "children": [{ "text": "" }] }),
    ];
    let doc = room(&value);
    let null = edit(&doc, 2, |peer| {
        block(peer, 1).insert_attribute(&mut peer.transact_mut(), "assetId", Any::Null);
    });
    assert!(matches!(arrive(&doc, "note", &null), Ok(Admission::Accepted)));
    canonical(&doc, "note").unwrap();
}
