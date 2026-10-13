#![allow(clippy::unwrap_used)] // Tests panic on a broken corpus.
//! The room validator's focused cases, ported from limits.test.ts
//! (capy-side/plate): roots, limits, recovery, unplaceable updates, and when
//! the bound spares the room copy.
mod common;

use common::AdmitBytes;
use notes::limits::{
    self, Admission, LimitCode, MAX_CONTENT_BYTES, MAX_DEPTH, MAX_NODES, Refusal, Validator,
};
use std::collections::HashMap;
use std::sync::Arc;

use notes::plate::{ProjectStateError, ProjectionError};
use notes::validate::RootError;
use notes::{plate, slate_yjs};
use serde_json::{Value, json};
use ydoc::{CONTRIBUTORS_ROOT, doc_options};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Array, Doc, GetString, Map, MapPrelim, ReadTxn, StateVector, Text, Transact, Update, Xml,
    XmlTextPrelim, XmlTextRef,
};

fn paragraph(text: &str) -> Value {
    json!({ "children": [{ "text": text }], "type": "p" })
}

fn nested(depth: usize) -> Value {
    let mut node = json!({ "text": "bottom" });
    for _ in 0..depth {
        node = json!({ "children": [node], "type": "blockquote" });
    }
    node
}

/// Inserts `value` at the end of the content root, as slate-yjs would.
fn insert_value(doc: &Doc, value: &[Value]) {
    doc.get_or_insert_text(plate::CONTENT_ROOT);
    let mut txn = doc.transact_mut();
    let y_root = plate::content_root(&txn).unwrap();
    let start = XmlTextRef::from(y_root).len(&txn);
    slate_yjs::insert_nodes(&mut txn, y_root, start, value);
}

fn document(value: &[Value]) -> Doc {
    let doc = Doc::with_options(doc_options(1));
    insert_value(&doc, value);
    doc
}

fn copy(doc: &Doc, client: u64) -> Doc {
    let copy = Doc::with_options(doc_options(client));
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    copy.transact_mut()
        .apply_update(Update::decode_v1(&state).unwrap())
        .unwrap();
    copy
}

fn apply(doc: &Doc, update: &[u8]) {
    doc.transact_mut()
        .apply_update(Update::decode_v1(update).unwrap())
        .unwrap();
}

/// What a peer's edit sends: its changes since the room's state.
fn edit(room: &Doc, client: u64, change: impl FnOnce(&Doc)) -> Vec<u8> {
    let peer = copy(room, client);
    change(&peer);
    let vector = room.transact().state_vector();
    peer.transact().encode_state_as_update_v1(&vector)
}

/// The text of top-level block `index` of a peer.
fn block(doc: &Doc, index: usize) -> XmlTextRef {
    let txn = doc.transact();
    match &plate::insert_delta(&plate::content_root(&txn).unwrap()).unwrap()[index].insert {
        plate::Insert::Element(branch) => XmlTextRef::from(*branch),
        plate::Insert::Text(_) => panic!("not a block"),
    }
}

/// An update replacing the whole value.
fn replacing(room: &Doc, value: &[Value]) -> Vec<u8> {
    edit(room, 50, |peer| {
        {
            let mut txn = peer.transact_mut();
            let root = XmlTextRef::from(plate::content_root(&txn).unwrap());
            let len = root.len(&txn);
            root.remove_range(&mut txn, 0, len);
        }
        insert_value(peer, value);
    })
}

#[test]
fn refuses_unsupported_roots_also_between_measurements() {
    let room = document(&[paragraph("small")]);
    let mut validator = Validator::new("note");
    let hidden = edit(&room, 2, |peer| {
        peer.get_or_insert_text("unmetered")
            .insert(&mut peer.transact_mut(), 0, "hidden growth")
    });
    assert!(
        matches!(validator.admit_bytes(&room, &hidden), Err(Refusal::Roots(RootError::Unsupported(name))) if name == "unmetered")
    );
    // A fresh room state: the first update measures, the next take the bound.
    let mut validator = Validator::new("note");
    for client in 3..6 {
        let typing = edit(&room, client, |peer| {
            block(peer, 0).insert(&mut peer.transact_mut(), 1, "x")
        });
        assert_eq!(
            validator.admit_bytes(&room, &typing).unwrap(),
            Admission::Accepted
        );
        apply(&room, &typing);
    }
    assert_eq!(validator.exact_checks, 1);
    let content_attribute = edit(&room, 6, |peer| {
        let mut txn = peer.transact_mut();
        XmlTextRef::from(plate::content_root(&txn).unwrap()).insert_attribute(&mut txn, "a", "b");
    });
    assert!(matches!(
        validator.admit_bytes(&room, &content_attribute),
        Err(Refusal::Roots(RootError::Content))
    ));
    let marker = edit(&room, 7, |peer| {
        peer.get_or_insert_map(CONTRIBUTORS_ROOT)
            .insert(&mut peer.transact_mut(), "c", "d");
    });
    assert_eq!(
        validator.admit_bytes(&room, &marker).unwrap(),
        Admission::Accepted
    );
    let sequence = edit(&room, 8, |peer| {
        peer.get_or_insert_array(CONTRIBUTORS_ROOT)
            .insert(&mut peer.transact_mut(), 0, "e");
    });
    assert!(matches!(
        validator.admit_bytes(&room, &sequence),
        Err(Refusal::Roots(RootError::Contributors))
    ));
}

#[test]
fn refuses_growth_past_a_limit_and_keeps_an_over_limit_note_shrinkable() {
    let room = document(&[paragraph("small")]);
    let oversized: Vec<Value> = (0..MAX_NODES)
        .map(|i| paragraph(&format!("block {i}")))
        .collect();
    let update = replacing(&room, &oversized);
    assert!(matches!(
        Validator::new("note").admit_bytes(&room, &update),
        Err(Refusal::Limit {
            code: LimitCode::DocumentNodesExceeded,
            ..
        })
    ));

    let over: Vec<Value> = (0..MAX_NODES + 100)
        .map(|i| paragraph(&format!("block {i}")))
        .collect();
    let room = document(&over);
    let update = replacing(
        &room,
        &[json!({ "children": [{ "text": "recovered" }], "id": "r1", "type": "p" })],
    );
    assert_eq!(
        Validator::new("note").admit_bytes(&room, &update).unwrap(),
        Admission::Accepted
    );

    let room = document(&[paragraph("small")]);
    let mut deep = json!({ "children": [{ "text": "bottom" }], "type": "p" });
    for _ in 0..=MAX_DEPTH {
        deep = json!({ "children": [deep], "type": "blockquote" });
    }
    match Validator::new("note").admit_bytes(&room, &replacing(&room, &[deep])) {
        Err(Refusal::Limit {
            code: LimitCode::DocumentDepthExceeded,
            metrics,
        }) => assert!(metrics.max_depth > MAX_DEPTH),
        other => panic!("{other:?}"),
    }
}

#[test]
fn refuses_deep_growth_behind_shrinking_content() {
    let mut value = vec![nested(300)];
    value.extend((0..1000).map(|i| paragraph(&format!("discarded sibling {i}"))));
    let room = document(&value);
    let update = replacing(&room, &[nested(301)]);
    assert!(matches!(
        Validator::new("note").admit_bytes(&room, &update),
        Err(Refusal::Limit { .. })
    ));
}

#[test]
fn defers_an_update_the_room_cannot_place_without_copying_it() {
    let room = document(&[paragraph("small")]);
    let mut validator = Validator::new("note");
    let client = copy(&room, 2);
    block(&client, 0).insert(&mut client.transact_mut(), 5, " lost"); // never reached the room
    let vector = client.transact().state_vector();
    block(&client, 0).insert(&mut client.transact_mut(), 0, ">");
    let keystroke = client.transact().encode_state_as_update_v1(&vector);
    assert_eq!(
        validator.admit_bytes(&room, &keystroke).unwrap(),
        Admission::Unheld
    );
    assert_eq!(validator.exact_checks, 0);
    let step2 = client
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    assert_eq!(
        validator.admit_bytes(&room, &step2).unwrap(),
        Admission::Accepted
    );
    apply(&room, &step2);
    assert!(room.transact().store().pending_update().is_none());
    assert_eq!(block(&room, 0).get_string(&room.transact()), ">small lost");
}

#[test]
fn types_near_the_size_limit_with_one_copy_and_measures_after_a_service_edit() {
    let near = || {
        document(&[
            paragraph(&"a".repeat(MAX_CONTENT_BYTES as usize - 1000)),
            paragraph("typing here"),
        ])
    };
    let keystroke = |room: &Doc, client: u64, text: &str| {
        edit(room, client, |peer| {
            block(peer, 1).insert(&mut peer.transact_mut(), 5, text)
        })
    };
    let room = near();
    let mut validator = Validator::new("note");
    for client in 2..52 {
        let update = keystroke(&room, client, "x");
        assert_eq!(
            validator.admit_bytes(&room, &update).unwrap(),
            Admission::Accepted
        );
        apply(&room, &update);
    }
    assert_eq!(validator.exact_checks, 1);
    // Past the limit the bound gives way to the exact check, which refuses.
    let big = keystroke(&room, 60, &"z".repeat(1000));
    assert!(matches!(
        validator.admit_bytes(&room, &big),
        Err(Refusal::Limit {
            code: LimitCode::DocumentSizeExceeded,
            ..
        })
    ));

    let room = near();
    let mut validator = Validator::new("note");
    let update = keystroke(&room, 2, "x");
    validator.admit_bytes(&room, &update).unwrap();
    apply(&room, &update);
    // A service edit applies outside the client protocol.
    apply(&room, &keystroke(&room, 3, "agent"));
    validator.invalidate();
    validator
        .admit_bytes(&room, &keystroke(&room, 4, "x"))
        .unwrap();
    assert_eq!(validator.exact_checks, 2);
}

#[test]
fn measures_runtime_comment_marks_out_of_text_leaves() {
    let clean = [
        json!({ "children": [{ "bold": true, "commentary": "kept", "text": "annotated" }], "id": "block_1", "type": "p" }),
    ];
    let marked = [json!({
        "children": [{ "bold": true, "comment": "discussion_1", "comment_thread_1": true, "commentary": "kept", "text": "annotated" }],
        "id": "block_1",
        "type": "p",
    })];
    assert_eq!(
        limits::measure_value(&marked),
        limits::measure_value(&clean)
    );
    assert_eq!(
        limits::measure(&document(&marked).transact()).unwrap(),
        limits::measure_value(&clean)
    );
    let deep = limits::measure_value(&[nested(300)]);
    assert_eq!((deep.max_depth, deep.node_count), (300, 301));
}

/* ------------------------------------------------------- hostile updates */

/// Runs `check` on a thread with the 2 MiB stack a server task has.
fn on_task_stack<T: Send + 'static>(check: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .stack_size(2 << 20)
        .spawn(check)
        .unwrap()
        .join()
        .unwrap()
}

/// A peer's update appending one chain of `depth` nested blockquotes.
fn chain(room: &Doc, depth: usize) -> Vec<u8> {
    edit(room, 2, |peer| {
        let mut txn = peer.transact_mut();
        let root = XmlTextRef::from(plate::content_root(&txn).unwrap());
        let len = root.len(&txn);
        let mut current: XmlTextRef = root.insert_embed(&mut txn, len, XmlTextPrelim::new(""));
        current.insert_attribute(&mut txn, "type", "blockquote");
        for _ in 1..depth {
            let next: XmlTextRef = current.insert_embed(&mut txn, 0, XmlTextPrelim::new(""));
            next.insert_attribute(&mut txn, "type", "blockquote");
            current = next;
        }
        current.insert(&mut txn, 0, "x");
    })
}

#[test]
fn refuses_nesting_past_the_ceiling_on_a_task_stack() {
    let ceiling = limits::DEPTH_CEILING as usize;
    // The chain whose leaf sits at the ceiling still measures (and is over the
    // depth limit); one level more, or a 20,000-level chain (about 600 KB,
    // which ran a 2 MiB stack out before), stops the walk.
    for depth in [ceiling, ceiling + 1, 20_000] {
        let room = document(&[paragraph("hello")]);
        let update = chain(&room, depth);
        let (admitted, measured, projected) = on_task_stack(move || {
            let admitted = Validator::new("note").admit_bytes(&room, &update);
            apply(&room, &update);
            let measured = limits::measure(&room.transact());
            let state = room
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            let projected = plate::project_state(&state).map(|content| content.value.len());
            (admitted, measured, projected)
        });
        if depth == ceiling {
            assert!(
                matches!(&admitted, Err(Refusal::Limit { code: LimitCode::DocumentDepthExceeded, metrics }) if metrics.max_depth == limits::DEPTH_CEILING),
                "{depth}: {admitted:?}"
            );
            assert_eq!(measured.unwrap().max_depth, limits::DEPTH_CEILING);
            assert_eq!(projected.unwrap(), 2);
        } else {
            assert!(
                matches!(
                    &admitted,
                    Err(Refusal::Projection(ProjectionError::TooDeep))
                ),
                "{depth}: {admitted:?}"
            );
            assert_eq!(measured, Err(ProjectionError::TooDeep));
            assert!(matches!(
                projected,
                Err(ProjectStateError::Projection(ProjectionError::TooDeep))
            ));
        }
    }
}

#[test]
fn refuses_a_deeply_nested_attribute_value_on_a_task_stack() {
    let room = document(&[paragraph("hello")]);
    let state = room
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let vector = room.transact().state_vector();
    // A value nesting `depth` arrays, built on a large stack (yrs encodes and
    // drops it recursively).
    let nested_value = move |depth: usize| {
        let (state, vector) = (state.clone(), vector.clone());
        std::thread::Builder::new()
            .stack_size(256 << 20)
            .spawn(move || {
                let peer = Doc::with_options(doc_options(2));
                apply(&peer, &state);
                let mut value = Any::Null;
                for _ in 0..depth {
                    value = Any::Array(Arc::from([value]));
                }
                block(&peer, 0).insert_attribute(&mut peer.transact_mut(), "deep", value);
                peer.transact().encode_state_as_update_v1(&vector)
            })
            .unwrap()
            .join()
            .unwrap()
    };
    let shallow = nested_value(100);
    let deep = nested_value(10_000); // about 20 KB
    let (shallow, deep) = on_task_stack(move || {
        let mut validator = Validator::new("note");
        (
            validator.admit_bytes(&room, &shallow),
            validator.admit_bytes(&room, &deep),
        )
    });
    assert_eq!(shallow.unwrap(), Admission::Accepted);
    assert!(matches!(deep, Err(Refusal::Update(_))), "{deep:?}");
}

/// Six bytes listing one client with no structs, which panicked yrs's apply.
const EMPTY_CLIENT: [u8; 6] = [0x01, 0x00, 0x01, 0x01, 0x00, 0x18];

#[test]
fn takes_an_update_listing_a_client_without_structs() {
    let room = document(&[paragraph("hello")]);
    // The exact path applies it to a copy of the room.
    assert_eq!(
        Validator::new("note")
            .admit_bytes(&room, &EMPTY_CLIENT)
            .unwrap(),
        Admission::Accepted
    );
    // The bound path takes it as it is; the room then applies it.
    let mut validator = Validator::new("note");
    let typing = edit(&room, 2, |peer| {
        block(peer, 0).insert(&mut peer.transact_mut(), 0, ">")
    });
    validator.admit_bytes(&room, &typing).unwrap();
    apply(&room, &typing);
    let exact = validator.exact_checks;
    assert_eq!(
        validator.admit_bytes(&room, &EMPTY_CLIENT).unwrap(),
        Admission::Accepted
    );
    assert_eq!(validator.exact_checks, exact);
    apply(&room, &EMPTY_CLIENT);
    assert_eq!(
        plate::value(&room.transact()).unwrap(),
        [paragraph(">hello")]
    );
}

#[test]
fn refuses_content_the_editor_never_writes() {
    let room = document(&[paragraph("hello")]);
    // Binary content in a paragraph's text: a typed string with its content
    // reference turned from String (4) to Binary (3), as the layouts match.
    let mut binary = edit(&room, 2, |peer| {
        block(peer, 0).insert(&mut peer.transact_mut(), 5, &"B".repeat(64))
    });
    let at = binary.iter().position(|b| *b == 0x84).unwrap();
    binary[at] = 0x83;
    let buffer = edit(&room, 3, |peer| {
        block(peer, 0).insert_attribute(
            &mut peer.transact_mut(),
            "data",
            Any::Buffer(Arc::from(&b"blob"[..])),
        );
    });
    let shared = edit(&room, 4, |peer| {
        block(peer, 0).insert_attribute(&mut peer.transact_mut(), "map", MapPrelim::default());
    });
    let mut validator = Validator::new("note");
    for update in [&binary, &buffer, &shared] {
        assert!(
            matches!(
                validator.admit_bytes(&room, update),
                Err(Refusal::Content(_))
            ),
            "{update:?}"
        );
    }
    // What the editor writes still goes through: a mark and a plain attribute.
    let plain = edit(&room, 5, |peer| {
        let text = block(peer, 0);
        let mut txn = peer.transact_mut();
        text.format(
            &mut txn,
            0,
            2,
            HashMap::from([(Arc::<str>::from("bold"), Any::Bool(true))]),
        );
        text.insert_attribute(&mut txn, "align", "center");
    });
    assert_eq!(
        validator.admit_bytes(&room, &plain).unwrap(),
        Admission::Accepted
    );
}

fn media(kind: &str, extra: Value) -> Value {
    let mut node = json!({ "children": [{ "text": "" }], "id": "m1", "type": kind });
    for (key, value) in extra.as_object().unwrap() {
        node[key] = value.clone();
    }
    node
}

/// Security regression (REVIEW5 N1: an update the store would refuse, so
/// the room would be discarded). Media blocks name their file (Epo,
/// 2026-10-10): an image, audio or file element without its asset id, or
/// with a URL, is refused when the update arrives, whether it brings the
/// element, sets the URL, changes a block's type or deletes the asset id; one
/// with its asset id goes in.
#[test]
fn a_media_block_without_its_asset_id_is_refused_at_admit() {
    let room = document(&[paragraph("intro"), media("img", json!({ "assetId": "a1" }))]);
    let refused = |update: &[u8]| {
        matches!(
            Validator::new("note").admit_bytes(&room, update),
            Err(Refusal::Content(what)) if what == "a media block without its asset id"
        )
    };
    let inserting = |node: Value| edit(&room, 2, |peer| insert_value(peer, &[node]));
    // The legacy `image` is no element the catalog lists (Epo 2026-10-13).
    assert!(matches!(
        Validator::new("note").admit_bytes(&room, &inserting(media("image", json!({})))),
        Err(Refusal::Content(what)) if what == limits::UNLISTED_TYPE
    ));
    for kind in notes::material::MEDIA_TYPES {
        assert!(
            refused(&inserting(media(kind, json!({})))),
            "{kind} without an asset id"
        );
        assert!(
            refused(&inserting(media(kind, json!({ "assetId": "" })))),
            "{kind} empty id"
        );
        assert!(
            refused(&inserting(media(
                kind,
                json!({ "assetId": "a2", "url": "https://x.test/a.png" })
            ))),
            "{kind} with a url"
        );
        assert!(
            refused(&inserting(media(
                kind,
                json!({ "assetId": "a2", "src": "https://x.test/a.png" })
            ))),
            "{kind} with a src"
        );
        assert_eq!(
            Validator::new("note")
                .admit_bytes(&room, &inserting(media(kind, json!({ "assetId": "a2" }))))
                .unwrap(),
            Admission::Accepted,
            "{kind} with its asset id"
        );
    }
    let set_url = edit(&room, 3, |peer| {
        block(peer, 1).insert_attribute(&mut peer.transact_mut(), "url", "https://x.test/a.png");
    });
    assert!(refused(&set_url), "a url set on an image");
    let retype = edit(&room, 4, |peer| {
        block(peer, 0).insert_attribute(&mut peer.transact_mut(), "type", "img");
    });
    assert!(refused(&retype), "a paragraph made an image");
    let unnamed = edit(&room, 5, |peer| {
        block(peer, 1).remove_attribute(&mut peer.transact_mut(), &"assetId".to_owned())
    });
    assert!(refused(&unnamed), "an image's asset id deleted");
    let renamed = edit(&room, 6, |peer| {
        block(peer, 1).insert_attribute(&mut peer.transact_mut(), "assetId", "a3");
    });
    assert_eq!(
        Validator::new("note").admit_bytes(&room, &renamed).unwrap(),
        Admission::Accepted,
        "an image's asset replaced"
    );
}

/// Security regression (REVIEW5 M1, resource exhaustion): a small update
/// touching a media attribute must not copy the room on an async worker. A
/// `src` set on a held paragraph is decided from the room, with no copy, and
/// stays inline; one that touches an image is checked on a copy, and only off
/// the async workers (`limits::heavy`).
#[test]
fn a_media_key_update_copies_the_room_only_off_the_async_workers() {
    let room = document(&[paragraph("intro"), media("img", json!({ "assetId": "a1" }))]);
    let typed = edit(&room, 2, |peer| {
        block(peer, 0).insert(&mut peer.transact_mut(), 5, "!");
    });
    let paragraph_src = edit(&room, 3, |peer| {
        block(peer, 0).insert_attribute(&mut peer.transact_mut(), "src", Any::Null);
    });
    let image_url = edit(&room, 4, |peer| {
        block(peer, 1).insert_attribute(&mut peer.transact_mut(), "url", "https://x.test/a.png");
    });
    for (name, update, heavy) in [
        ("typing", &typed, false),
        ("a src on a paragraph", &paragraph_src, false),
        ("a url on an image", &image_url, true),
    ] {
        let decoded = ydoc::decode(update).unwrap();
        assert_eq!(
            limits::heavy(&room.transact(), &decoded, update.len(), "note"),
            heavy,
            "{name}"
        );
    }
    // With the room's bound in place, as on the room task.
    let mut validator = Validator::new("note");
    let nothing = room
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    validator.admit_bytes(&room, &nothing).unwrap();
    let copies = validator.exact_checks;
    assert_eq!(
        validator.admit_bytes(&room, &paragraph_src).unwrap(),
        Admission::Accepted
    );
    assert_eq!(
        (validator.media_copies, validator.exact_checks),
        (0, copies)
    );
    assert!(validator.admit_bytes(&room, &image_url).is_err());
    assert_eq!(validator.media_copies, 1);
}

/// Security regression (REVIEW5 R2: an update the store refuses discards the
/// room for every editor). An update that leaves an element without a key
/// the store requires is refused when it arrives, with no copy of the room:
/// a deleted `type`, a deleted top-level `id`, a new top-level block without
/// an id or without a type, a paragraph made a reference without its
/// material id, a reference's material id deleted. A deleted optional key,
/// a new block with its keys, retyping a heading and deleting whole blocks
/// go in, still with no copy.
#[test]
fn an_element_left_without_a_required_key_is_refused_at_admit() {
    let room = document(&[
        json!({ "children": [{ "text": "intro" }], "id": "p1", "indent": 1, "type": "p" }),
        json!({ "children": [{ "text": "" }], "id": "q1", "materialId": "m1", "refKind": "quiz", "type": "material_ref" }),
        json!({ "children": [{ "text": "end" }], "id": "p2", "type": "p" }),
    ]);
    let mut validator = Validator::new("note");
    let nothing = room
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    validator.admit_bytes(&room, &nothing).unwrap();
    let copies = validator.exact_checks;
    let unset = |index: usize, key: &'static str| {
        edit(&room, 2, move |peer| {
            block(peer, index).remove_attribute(&mut peer.transact_mut(), &key.to_owned())
        })
    };
    let set = |index: usize, key: &'static str, value: &'static str| {
        edit(&room, 3, move |peer| {
            block(peer, index).insert_attribute(&mut peer.transact_mut(), key, value);
        })
    };
    let inserting = |node: Value| edit(&room, 4, |peer| insert_value(peer, &[node]));
    let refused = [
        ("a deleted type", unset(0, "type")),
        ("a deleted top-level id", unset(0, "id")),
        (
            "a new block without an id",
            inserting(json!({ "children": [{ "text": "x" }], "type": "p" })),
        ),
        (
            "a new block without a type",
            inserting(json!({ "children": [{ "text": "x" }], "id": "n1" })),
        ),
        (
            "a paragraph made a reference",
            set(2, "type", "material_ref"),
        ),
        ("a reference's material id deleted", unset(1, "materialId")),
    ];
    for (name, update) in refused {
        assert!(
            matches!(
                validator.admit_bytes(&room, &update),
                Err(Refusal::Content(what)) if what == "an element without a key it requires"
            ),
            "{name}"
        );
    }
    let delete_blocks = edit(&room, 5, |peer| {
        peer.get_or_insert_text(plate::CONTENT_ROOT)
            .remove_range(&mut peer.transact_mut(), 0, 2);
    });
    let accepted = [
        ("an optional key deleted", unset(0, "indent")),
        (
            "a new block with its keys",
            inserting(json!({ "children": [{ "text": "x" }], "id": "n2", "type": "p" })),
        ),
        ("a paragraph made a heading", set(2, "type", "h1")),
        ("whole blocks deleted", delete_blocks),
    ];
    for (name, update) in accepted {
        assert_eq!(
            validator.admit_bytes(&room, &update).unwrap(),
            Admission::Accepted,
            "{name}"
        );
    }
    assert_eq!(
        (
            validator.media_copies,
            validator.key_copies,
            validator.exact_checks
        ),
        (0, 0, copies)
    );
    // The same on the exact path (no bound yet, as a room's first update).
    assert!(matches!(
        Validator::new("note").admit_bytes(&room, &unset(0, "type")),
        Err(Refusal::Content(what)) if what == limits::MISSING_KEY
    ));
}

/// Security regression (live-items REVIEW5, pending references): an imported
/// quiz fence's body holds its answer keys, and a note's room reaches every
/// reader. A new reference carrying one, one set on a held reference and a
/// new reference without its material id are refused at admit, as the store's
/// check refuses them. Fails if the admit lets any in.
#[test]
fn a_reference_carrying_a_fence_body_is_refused_at_admit() {
    let room = document(&[
        json!({ "children": [{ "text": "intro" }], "id": "p1", "type": "p" }),
        json!({ "children": [{ "text": "" }], "id": "q1", "materialId": "m1", "refKind": "quiz", "type": "material_ref" }),
    ]);
    let mut validator = Validator::new("note");
    let nothing = room
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    validator.admit_bytes(&room, &nothing).unwrap();
    let pending = json!({
        "children": [{ "text": "" }], "id": "f1", "materialId": "", "pending": "answer: KEY",
        "refKind": "quiz", "type": "material_ref",
    });
    let inserting = |node: Value| edit(&room, 4, |peer| insert_value(peer, &[node]));
    let refused = [
        (
            "a new reference with a fence body",
            inserting(pending.clone()),
        ),
        (
            "a fence body on a held reference",
            edit(&room, 3, |peer| {
                block(peer, 1).insert_attribute(&mut peer.transact_mut(), "pending", "answer: KEY");
            }),
        ),
        (
            "a new reference without its material id",
            inserting(json!({
                "children": [{ "text": "" }], "id": "f2", "materialId": "", "refKind": "quiz",
                "type": "material_ref",
            })),
        ),
    ];
    for (name, update) in refused {
        assert!(
            matches!(
                validator.admit_bytes(&room, &update),
                Err(Refusal::Content(_))
            ),
            "{name}"
        );
    }
    assert!(notes::material::assert_canonical(&[pending], "note").is_err());
}

/// A material reference below the top level is refused when it arrives, as
/// the store refuses it, so only that writer's update is lost: a blockquote
/// holding a reference (a pasted quoted fence a writer did not lift) and a
/// paragraph inside a blockquote retyped to a reference (live-items REVIEW5
/// R2). A top-level reference still goes in. Fails without the check.
#[test]
fn a_nested_reference_is_refused_at_admit() {
    let room = document(&[
        json!({ "children": [{ "text": "intro" }], "id": "p1", "type": "p" }),
        json!({
            "children": [{ "children": [{ "text": "quoted" }], "type": "p" }],
            "id": "bq", "type": "blockquote",
        }),
    ]);
    let mut validator = Validator::new("note");
    let nothing = room
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    validator.admit_bytes(&room, &nothing).unwrap();
    let reference = |id: &str| {
        json!({
            "children": [{ "text": "" }], "id": id, "materialId": "row_1", "refKind": "quiz",
            "type": "material_ref",
        })
    };
    let quoted = edit(&room, 4, |peer| {
        insert_value(
            peer,
            &[json!({ "children": [reference("r1")], "id": "bq2", "type": "blockquote" })],
        );
    });
    let retyped = edit(&room, 5, |peer| {
        let quote = block(peer, 1);
        let inner = {
            let _txn = peer.transact();
            match &plate::insert_delta(quote.as_ref()).unwrap()[0].insert {
                plate::Insert::Element(branch) => XmlTextRef::from(*branch),
                plate::Insert::Text(_) => panic!("no paragraph in the quote"),
            }
        };
        let mut txn = peer.transact_mut();
        inner.insert_attribute(&mut txn, "type", "material_ref");
        inner.insert_attribute(&mut txn, "materialId", "row_1");
        inner.insert_attribute(&mut txn, "refKind", "quiz");
    });
    for (name, update) in [
        ("a quoted reference", quoted),
        ("a retyped quote line", retyped),
    ] {
        assert!(
            matches!(
                validator.admit_bytes(&room, &update),
                Err(Refusal::Content(what)) if what == limits::NESTED_REFERENCE
            ),
            "{name}"
        );
    }
    let top = edit(&room, 6, |peer| insert_value(peer, &[reference("r2")]));
    assert_eq!(
        validator.admit_bytes(&room, &top).unwrap(),
        Admission::Accepted
    );
}

/// Security regression (REVIEW5 R2b: two crafted shapes still took a block's
/// `type`, and the store then discarded the room). The key check reads the
/// element's state after the update: a `type` overwritten and the new entry
/// deleted in the same update (a writer's two updates merged), and a stale
/// writer's `type` that loses the conflict sent with a delete of the current
/// one, are refused on both paths. The losing write alone goes in. Its entry
/// does not follow the room's current one, so the key is read on the room
/// with the update applied: the trial copy that such an update (no small
/// edit) gets anyway, off the async workers, with no copy of its own.
#[test]
fn a_type_deleted_behind_an_overwrite_or_a_losing_write_is_refused_at_admit() {
    let room = document(&[json!({ "children": [{ "text": "intro" }], "id": "p1", "type": "p" })]);
    let retype = |peer: &Doc, kind: &str| {
        block(peer, 0).insert_attribute(&mut peer.transact_mut(), "type", kind);
    };
    let untype = |peer: &Doc| {
        block(peer, 0).remove_attribute(&mut peer.transact_mut(), &"type".to_owned());
    };
    // Client 3 retypes from before client 5's newer type, which wins.
    let stale = copy(&room, 3);
    apply(&room, &edit(&room, 5, |peer| retype(peer, "h2")));
    retype(&stale, "h3");
    let losing = stale
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    let losing_and_untyped = yrs::merge_updates_v1([&losing, &edit(&room, 8, untype)]).unwrap();
    // One writer's two updates: a new type, then that entry deleted.
    let writer = copy(&room, 7);
    let base = room.transact().state_vector();
    retype(&writer, "h1");
    let middle = writer.transact().state_vector();
    let typed = writer.transact().encode_state_as_update_v1(&base);
    untype(&writer);
    let untyped = writer.transact().encode_state_as_update_v1(&middle);
    let overwritten = yrs::merge_updates_v1([&typed, &untyped]).unwrap();
    let heavy = |update: &[u8]| {
        limits::heavy(
            &room.transact(),
            &ydoc::decode(update).unwrap(),
            update.len(),
            "note",
        )
    };
    let mut validator = Validator::new("note");
    let nothing = room
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    validator.admit_bytes(&room, &nothing).unwrap();
    for (name, update) in [
        ("overwritten and deleted", &overwritten),
        (
            "a losing type and the current one deleted",
            &losing_and_untyped,
        ),
    ] {
        for (path, answer) in [
            ("bound", validator.admit_bytes(&room, update)),
            ("exact", Validator::new("note").admit_bytes(&room, update)),
        ] {
            assert!(
                matches!(answer, Err(Refusal::Content(what)) if what == limits::MISSING_KEY),
                "{name}, {path} path: {answer:?}"
            );
        }
    }
    assert!(!heavy(&overwritten));
    assert!(heavy(&losing_and_untyped));
    assert!(heavy(&losing));
    assert_eq!(
        validator.admit_bytes(&room, &losing).unwrap(),
        Admission::Accepted
    );
    assert_eq!((validator.media_copies, validator.key_copies), (0, 0));
}

fn varuint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
}

/// The last unit of block `index`'s current `key` entry.
fn entry_tail(room: &Doc, index: usize, key: &str) -> yrs::ID {
    let xml = block(room, index);
    let branch =
        yrs::branch::BranchPtr::from(<XmlTextRef as AsRef<yrs::branch::Branch>>::as_ref(&xml));
    let item = branch.entry_item(key).unwrap();
    yrs::ID::new(item.id().client, item.id().clock + item.len() - 1)
}

/// The reviewer's crafted small edit (REVIEW5 final recheck): a fresh client
/// 9 writes two `type` entries on block 1, both after its current entry (a
/// conflict only Yjs orders, so the key check needs the result), and, with
/// `untype`, deletes block 0's `type` entry (a refusal).
fn conflicting_types(room: &Doc, untype: bool) -> Vec<u8> {
    let current = entry_tail(room, 1, "type");
    let mut out = Vec::new();
    varuint(&mut out, 1); // clients
    varuint(&mut out, 2); // structs
    varuint(&mut out, 9); // client
    varuint(&mut out, 0); // clock
    for kind in ["h1", "h2"] {
        out.push(0x88); // an origin, ContentAny
        varuint(&mut out, current.client.get());
        varuint(&mut out, current.clock as u64);
        varuint(&mut out, 1); // one value
        out.push(119); // a string
        varuint(&mut out, kind.len() as u64);
        out.extend_from_slice(kind.as_bytes());
    }
    if untype {
        let doomed = entry_tail(room, 0, "type");
        varuint(&mut out, 1);
        varuint(&mut out, doomed.client.get());
        varuint(&mut out, 1);
        varuint(&mut out, doomed.clock as u64);
        varuint(&mut out, 1);
    } else {
        varuint(&mut out, 0);
    }
    out
}

fn two_paragraphs() -> Doc {
    document(&[
        json!({ "children": [{ "text": "a" }], "id": "p1", "type": "p" }),
        json!({ "children": [{ "text": "b" }], "id": "p2", "type": "p" }),
    ])
}

/// Security regression (REVIEW5 final S2: without `heavy`'s key branch, the
/// copy for this update ran on an async worker, repeatably, as in M1). A
/// crafted small edit whose `type` entries conflict is inline by size, yet
/// its key check reads the result: `heavy` says so, and admit takes the one
/// copy it needs.
#[test]
fn a_small_edit_whose_keys_need_the_result_is_heavy() {
    let room = two_paragraphs();
    let update = conflicting_types(&room, false);
    let decoded = ydoc::decode(&update).unwrap();
    assert!(update.len() <= 32, "{} bytes", update.len());
    assert!(ydoc::applies_inline(
        &room.transact(),
        &ydoc::Incoming::new(&decoded),
        update.len()
    ));
    assert!(limits::heavy(
        &room.transact(),
        &decoded,
        update.len(),
        "note"
    ));
    let mut validator = Validator::new("note");
    let nothing = room
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    validator.admit_bytes(&room, &nothing).unwrap();
    assert_eq!(
        validator.admit_bytes(&room, &update).unwrap(),
        Admission::Accepted
    );
    assert_eq!(validator.key_copies, 1);
}

/// Security regression (REVIEW5 final S1: the key check stopped at the first
/// element needing a copy, in the set's random order, so `heavy` could say
/// inline while `admit` copied the room on the worker before refusing). One
/// element refused and another needing the result: `heavy` and `admit` agree
/// on every run, the update is refused inline and no copy is taken.
#[test]
fn heavy_and_admit_agree_on_a_refusal_beside_a_needed_copy() {
    let room = two_paragraphs();
    let update = conflicting_types(&room, true);
    let decoded = ydoc::decode(&update).unwrap();
    assert!(ydoc::applies_inline(
        &room.transact(),
        &ydoc::Incoming::new(&decoded),
        update.len()
    ));
    let nothing = room
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    let (mut heavy, mut copies) = (0, 0);
    for _ in 0..100 {
        heavy += usize::from(limits::heavy(
            &room.transact(),
            &decoded,
            update.len(),
            "note",
        ));
        let mut validator = Validator::new("note");
        validator.admit_bytes(&room, &nothing).unwrap();
        assert!(matches!(
            validator.admit_bytes(&room, &update),
            Err(Refusal::Content(what)) if what == limits::MISSING_KEY
        ));
        copies += validator.key_copies;
    }
    assert_eq!((heavy, copies), (0, 0));
}

/// A writer that already wrote pastes several blocks, an image among them:
/// the elements it creates sit at clocks the room has not seen, which yrs's
/// lookup must not be asked for (it indexes past the client's last block and
/// panics), so the paste goes in (REVIEW5 recheck, the key and media checks).
#[test]
fn a_paste_by_a_writer_that_already_wrote_goes_in() {
    let room = document(&[json!({ "children": [{ "text": "intro" }], "id": "p1", "type": "p" })]);
    for at in [0, 5] {
        let typed = edit(&room, 2, |peer| {
            block(peer, 0).insert(&mut peer.transact_mut(), at, "x");
        });
        apply(&room, &typed);
    }
    let mut blocks: Vec<Value> = (0..5)
        .map(|n| json!({ "children": [{ "text": format!("pasted {n}") }], "id": format!("n{n}"), "type": "p" }))
        .collect();
    blocks
        .push(json!({ "assetId": "a1", "children": [{ "text": "" }], "id": "i1", "type": "img" }));
    let paste = edit(&room, 2, |peer| insert_value(peer, &blocks));
    assert_eq!(
        Validator::new("note").admit_bytes(&room, &paste).unwrap(),
        Admission::Accepted
    );
}
