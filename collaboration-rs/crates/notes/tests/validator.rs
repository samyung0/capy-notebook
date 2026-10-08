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
    let mut validator = Validator::default();
    let hidden = edit(&room, 2, |peer| {
        peer.get_or_insert_text("unmetered")
            .insert(&mut peer.transact_mut(), 0, "hidden growth")
    });
    assert!(
        matches!(validator.admit_bytes(&room, &hidden), Err(Refusal::Roots(RootError::Unsupported(name))) if name == "unmetered")
    );
    // A fresh room state: the first update measures, the next take the bound.
    let mut validator = Validator::default();
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
        Validator::default().admit_bytes(&room, &update),
        Err(Refusal::Limit {
            code: LimitCode::DocumentNodesExceeded,
            ..
        })
    ));

    let over: Vec<Value> = (0..MAX_NODES + 100)
        .map(|i| paragraph(&format!("block {i}")))
        .collect();
    let room = document(&over);
    let update = replacing(&room, &[paragraph("recovered")]);
    assert_eq!(
        Validator::default().admit_bytes(&room, &update).unwrap(),
        Admission::Accepted
    );

    let room = document(&[paragraph("small")]);
    let mut deep = json!({ "children": [{ "text": "bottom" }], "type": "p" });
    for _ in 0..=MAX_DEPTH {
        deep = json!({ "children": [deep], "type": "blockquote" });
    }
    match Validator::default().admit_bytes(&room, &replacing(&room, &[deep])) {
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
        Validator::default().admit_bytes(&room, &update),
        Err(Refusal::Limit { .. })
    ));
}

#[test]
fn defers_an_update_the_room_cannot_place_without_copying_it() {
    let room = document(&[paragraph("small")]);
    let mut validator = Validator::default();
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
    let mut validator = Validator::default();
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
    let mut validator = Validator::default();
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
            let admitted = Validator::default().admit_bytes(&room, &update);
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
        let mut validator = Validator::default();
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
        Validator::default()
            .admit_bytes(&room, &EMPTY_CLIENT)
            .unwrap(),
        Admission::Accepted
    );
    // The bound path takes it as it is; the room then applies it.
    let mut validator = Validator::default();
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
    let mut validator = Validator::default();
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
