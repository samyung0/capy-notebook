//! The room validator's focused cases, ported from limits.test.ts
//! (capy-side/plate): roots, limits, recovery, unplaceable updates, and when
//! the bound spares the room copy.
use notes::limits::{
    self, Admission, LimitCode, MAX_CONTENT_BYTES, MAX_DEPTH, MAX_NODES, Refusal, Validator,
};
use notes::validate::{CONTRIBUTORS_ROOT, RootError};
use notes::{doc_options, plate, slate_yjs};
use serde_json::{Value, json};
use yrs::updates::decoder::Decode;
use yrs::{
    Array, Doc, GetString, Map, ReadTxn, StateVector, Text, Transact, Update, Xml, XmlTextRef,
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
        matches!(validator.admit(&room, &hidden), Err(Refusal::Roots(RootError::Unsupported(name))) if name == "unmetered")
    );
    // A fresh room state: the first update measures, the next take the bound.
    let mut validator = Validator::default();
    for client in 3..6 {
        let typing = edit(&room, client, |peer| {
            block(peer, 0).insert(&mut peer.transact_mut(), 1, "x")
        });
        assert_eq!(
            validator.admit(&room, &typing).unwrap(),
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
        validator.admit(&room, &content_attribute),
        Err(Refusal::Roots(RootError::Content))
    ));
    let marker = edit(&room, 7, |peer| {
        peer.get_or_insert_map(CONTRIBUTORS_ROOT)
            .insert(&mut peer.transact_mut(), "c", "d");
    });
    assert_eq!(
        validator.admit(&room, &marker).unwrap(),
        Admission::Accepted
    );
    let sequence = edit(&room, 8, |peer| {
        peer.get_or_insert_array(CONTRIBUTORS_ROOT)
            .insert(&mut peer.transact_mut(), 0, "e");
    });
    assert!(matches!(
        validator.admit(&room, &sequence),
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
        Validator::default().admit(&room, &update),
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
        Validator::default().admit(&room, &update).unwrap(),
        Admission::Accepted
    );

    let room = document(&[paragraph("small")]);
    let mut deep = json!({ "children": [{ "text": "bottom" }], "type": "p" });
    for _ in 0..=MAX_DEPTH {
        deep = json!({ "children": [deep], "type": "blockquote" });
    }
    match Validator::default().admit(&room, &replacing(&room, &[deep])) {
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
        Validator::default().admit(&room, &update),
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
        validator.admit(&room, &keystroke).unwrap(),
        Admission::Unheld
    );
    assert_eq!(validator.exact_checks, 0);
    let step2 = client
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    assert_eq!(validator.admit(&room, &step2).unwrap(), Admission::Accepted);
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
            validator.admit(&room, &update).unwrap(),
            Admission::Accepted
        );
        apply(&room, &update);
    }
    assert_eq!(validator.exact_checks, 1);
    // Past the limit the bound gives way to the exact check, which refuses.
    let big = keystroke(&room, 60, &"z".repeat(1000));
    assert!(matches!(
        validator.admit(&room, &big),
        Err(Refusal::Limit {
            code: LimitCode::DocumentSizeExceeded,
            ..
        })
    ));

    let room = near();
    let mut validator = Validator::default();
    let update = keystroke(&room, 2, "x");
    validator.admit(&room, &update).unwrap();
    apply(&room, &update);
    // A service edit applies outside the client protocol.
    apply(&room, &keystroke(&room, 3, "agent"));
    validator.invalidate();
    validator.admit(&room, &keystroke(&room, 4, "x")).unwrap();
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
