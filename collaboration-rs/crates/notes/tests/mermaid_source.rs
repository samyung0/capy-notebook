#![allow(clippy::unwrap_used)] // Tests panic on a broken fixture.
//! A Mermaid block's source as a text of strings (shape A, Epo 2026-10-10):
//! the bootstrap writes it so, it reads as its string, typing and pastes
//! stay on the bound while the size cap still refuses, crafted updates
//! putting a text anywhere else or anything but strings in it are refused
//! within a bounded walk, and a command's new source is a text diff that
//! keeps typing which reaches the room meanwhile.

mod common;

use std::collections::HashMap;
use std::sync::Arc;

use common::AdmitBytes;
use notes::edit::{self, DocumentCommand};
use notes::limits::{Admission, LimitCode, MAX_CONTENT_BYTES, Refusal, Validator};
use notes::{plate, slate_yjs};
use serde_json::{Value, json};
use yrs::branch::BranchPtr;
use yrs::{
    Any, Doc, GetString, Out, ReadTxn, Text, TextPrelim, TextRef, Transact, Xml, XmlTextPrelim,
    XmlTextRef,
};

const SOURCE: &str = "graph TD\n  A --> B";

fn mermaid(source: &str) -> Value {
    json!({
        "children": [{ "children": [{ "text": "" }], "type": "mermaid_caption" }],
        "id": "d1",
        "source": source,
        "type": "mermaid",
    })
}

fn paragraph(text: &str) -> Value {
    json!({ "children": [{ "text": text }], "id": "p1", "type": "p" })
}

/// A room bootstrapped from `value`, as a first open writes it.
fn room(value: &[Value]) -> Doc {
    common::doc(&slate_yjs::state_from_value(value, 1), 2)
}

/// What a peer's edit sends: its changes since the room's state.
fn edit(room: &Doc, client: u64, change: impl FnOnce(&Doc)) -> Vec<u8> {
    let peer = common::doc(&common::state(room), client);
    change(&peer);
    let vector = room.transact().state_vector();
    peer.transact().encode_state_as_update_v1(&vector)
}

/// Top-level block `index` of a document.
fn block(doc: &Doc, index: usize) -> XmlTextRef {
    let txn = doc.transact();
    match &plate::insert_delta(&plate::content_root(&txn).unwrap()).unwrap()[index].insert {
        plate::Insert::Element(branch) => XmlTextRef::from(*branch),
        plate::Insert::Text(_) => panic!("not a block"),
    }
}

/// The source text of the Mermaid block at `index`.
fn source(doc: &Doc, index: usize) -> TextRef {
    let element = block(doc, index);
    match element.get_attribute(&doc.transact(), "source") {
        Some(Out::YText(text)) => text,
        other => panic!("not a source text: {other:?}"),
    }
}

fn projected_source(doc: &Doc) -> String {
    let value = plate::value(&doc.transact()).unwrap();
    value
        .iter()
        .find(|node| node["type"] == "mermaid")
        .and_then(|node| node["source"].as_str())
        .unwrap()
        .to_owned()
}

/// A validator with its bound in place: an empty update takes the baseline.
fn validator(room: &Doc) -> Validator {
    let mut validator = Validator::default();
    validator.admit_bytes(room, &edit(room, 9, |_| {})).unwrap();
    validator
}

/// Admits `update`, counting admission's steps; applies it when accepted.
fn admit(
    validator: &mut Validator,
    room: &Doc,
    update: &[u8],
) -> (Result<Admission, Refusal>, u64) {
    ydoc::steps::take();
    let result = validator.admit_bytes(room, update);
    let steps = ydoc::steps::take().total();
    if matches!(result, Ok(Admission::Accepted)) {
        common::apply(room, update);
    }
    (result, steps)
}

fn structs(update: &[u8]) -> u64 {
    ydoc::decode(update).unwrap().blocks().count() as u64
}

#[test]
fn a_bootstrapped_source_is_a_text_that_reads_as_its_string() {
    let room = room(&[mermaid(SOURCE)]);
    assert_eq!(source(&room, 0).get_string(&room.transact()), SOURCE);
    assert_eq!(projected_source(&room), SOURCE);
    let value = plate::value(&room.transact()).unwrap();
    notes::material::assert_canonical(&value, "note").unwrap();
}

/// A keystroke and a 200,000-character paste into the source go in on the
/// bound, with no copy of the room; a paste past the size cap is measured
/// and refused.
#[test]
fn typing_and_a_large_paste_stay_on_the_bound_and_the_cap_still_refuses() {
    let room = room(&[mermaid(SOURCE), paragraph("text")]);
    let mut validator = validator(&room);
    let exact = validator.exact_checks;
    let key = edit(&room, 3, |peer| {
        let text = source(peer, 0);
        let end = text.len(&peer.transact());
        text.insert(&mut peer.transact_mut(), end, "\n  B --> C");
    });
    assert!(matches!(
        admit(&mut validator, &room, &key).0,
        Ok(Admission::Accepted)
    ));
    let paste = edit(&room, 4, |peer| {
        source(peer, 0).insert(&mut peer.transact_mut(), 0, &"x".repeat(200_000));
    });
    let (result, steps) = admit(&mut validator, &room, &paste);
    assert!(matches!(result, Ok(Admission::Accepted)), "{result:?}");
    assert!(steps <= 64 * structs(&paste), "{steps} steps");
    assert_eq!(validator.exact_checks, exact, "the room was copied");
    let over = edit(&room, 5, |peer| {
        source(peer, 0).insert(
            &mut peer.transact_mut(),
            0,
            &"y".repeat(MAX_CONTENT_BYTES as usize),
        );
    });
    let (result, _) = admit(&mut validator, &room, &over);
    assert!(
        matches!(
            result,
            Err(Refusal::Limit {
                code: LimitCode::DocumentSizeExceeded,
                ..
            })
        ),
        "{result:?}"
    );
    assert_eq!(projected_source(&room).len(), 200_000 + SOURCE.len() + 10);
}

/// Security regression (shape A's admit exception, Epo 2026-10-10: content
/// the projection and the metrics would not see, or a store check that
/// discards the room): a text under another key, on another element, in a
/// new paragraph or kept through a retype, and a format, an embed, a nested
/// text or an attribute inside a source, are each refused within 64 steps
/// per struct. Fails if the admit lets any text attribute in.
#[test]
fn crafted_sources_are_refused_within_a_bounded_walk() {
    let room = room(&[mermaid(SOURCE), paragraph("text")]);
    let bold = || HashMap::from([(Arc::<str>::from("bold"), Any::Bool(true))]);
    type Edit = Box<dyn Fn(&Doc)>;
    let cases: Vec<(&str, Edit, &str)> = vec![
        (
            "a text under another key",
            Box::new(|peer| {
                block(peer, 0).insert_attribute(
                    &mut peer.transact_mut(),
                    "url",
                    TextPrelim::new("x"),
                );
            }),
            "a non-plain attribute value",
        ),
        (
            "a source text on a paragraph",
            Box::new(|peer| {
                block(peer, 1).insert_attribute(
                    &mut peer.transact_mut(),
                    "source",
                    TextPrelim::new("x"),
                );
            }),
            "a Mermaid source outside a mermaid block",
        ),
        (
            "a new paragraph holding a source text",
            Box::new(|peer| {
                {
                    let mut txn = peer.transact_mut();
                    let root = plate::content_root(&txn).unwrap();
                    let end = XmlTextRef::from(root).len(&txn);
                    slate_yjs::insert_nodes(&mut txn, root, end, &[paragraph("new")]);
                }
                block(peer, 2).insert_attribute(
                    &mut peer.transact_mut(),
                    "source",
                    TextPrelim::new("x"),
                );
            }),
            "a Mermaid source outside a mermaid block",
        ),
        (
            "a Mermaid block retyped while it holds its source",
            Box::new(|peer| {
                block(peer, 0).insert_attribute(&mut peer.transact_mut(), "type", "p");
            }),
            "a Mermaid source outside a mermaid block",
        ),
        (
            "a format in the source",
            Box::new(move |peer| {
                source(peer, 0).format(&mut peer.transact_mut(), 0, 5, bold());
            }),
            "content other than text in a Mermaid source",
        ),
        (
            "an embed in the source",
            Box::new(|peer| {
                source(peer, 0).insert_embed(&mut peer.transact_mut(), 0, Any::from("x"));
            }),
            "content other than text in a Mermaid source",
        ),
        (
            "an element in the source",
            Box::new(|peer| {
                let _: XmlTextRef = source(peer, 0).insert_embed(
                    &mut peer.transact_mut(),
                    0,
                    XmlTextPrelim::new("x"),
                );
            }),
            "content other than text in a Mermaid source",
        ),
        (
            "an attribute on the source",
            Box::new(|peer| {
                let text = source(peer, 0);
                XmlTextRef::from(BranchPtr::from(AsRef::<yrs::branch::Branch>::as_ref(&text)))
                    .insert_attribute(&mut peer.transact_mut(), "hidden", "x");
            }),
            "an attribute on a Mermaid source",
        ),
    ];
    for (what, change, reason) in cases {
        let update = edit(&room, 7, change);
        let mut validator = validator(&room);
        let (result, steps) = admit(&mut validator, &room, &update);
        match result {
            Err(Refusal::Content(refused)) => assert_eq!(refused, reason, "{what}"),
            other => panic!("{what}: {other:?}"),
        }
        assert!(steps <= 64 * structs(&update), "{what}: {steps} steps");
    }
    // What the editor writes still goes through: a new Mermaid block, its
    // source a text, and a theme change.
    let insert = edit(&room, 8, |peer| {
        let mut txn = peer.transact_mut();
        let root = plate::content_root(&txn).unwrap();
        let end = XmlTextRef::from(root).len(&txn);
        let mut second = mermaid("pie\n  \"a\" : 1");
        second["id"] = json!("d2");
        slate_yjs::insert_nodes(&mut txn, root, end, &[second]);
    });
    let theme = edit(&room, 9, |peer| {
        block(peer, 0).insert_attribute(&mut peer.transact_mut(), "theme", "brutalist");
    });
    let mut validator = validator(&room);
    for update in [insert, theme] {
        assert!(matches!(
            admit(&mut validator, &room, &update).0,
            Ok(Admission::Accepted)
        ));
    }
    assert!(matches!(
        block(&room, 2).get_attribute(&room.transact(), "source"),
        Some(Out::YText(_))
    ));
}

/// An agent's `set_mermaid` (`set_property` of `source`) writes the change
/// as a text diff: a writer's typing that reaches the room after it, made
/// against the source before it, stays. Fails if the command replaces the
/// source text with a string again.
#[test]
fn a_source_set_by_command_keeps_typing_that_arrives_meanwhile() {
    let room = room(&[mermaid(SOURCE)]);
    let typing = edit(&room, 3, |peer| {
        let text = source(peer, 0);
        let end = text.len(&peer.transact());
        text.insert(&mut peer.transact_mut(), end, " --> C");
    });
    let root = room.get_or_insert_text(plate::CONTENT_ROOT);
    let outcome = edit::apply_material_commands(
        &mut room.transact_mut(),
        &root,
        &[DocumentCommand::SetProperty {
            expected_value: SOURCE.into(),
            node_type: "mermaid".into(),
            property: "source".into(),
            value: "flowchart TD\n  A --> B".into(),
        }],
    )
    .unwrap();
    assert_eq!(
        outcome.inverse,
        vec![DocumentCommand::SetProperty {
            expected_value: "flowchart TD\n  A --> B".into(),
            node_type: "mermaid".into(),
            property: "source".into(),
            value: SOURCE.into(),
        }]
    );
    common::apply(&room, &typing);
    assert_eq!(projected_source(&room), "flowchart TD\n  A --> B --> C");
    assert_eq!(
        source(&room, 0).get_string(&room.transact()),
        "flowchart TD\n  A --> B --> C"
    );
}

/// The store requires a `mermaid` block's `source` (rust-core REVIEW5 R2b's
/// key check): a new block whose source is a text goes in, as a writer
/// inserts one, while a new block with no source is refused as missing it.
/// Fails if the key checks read a source text as no value.
#[test]
fn a_new_block_needs_its_source_and_a_text_is_one() {
    let room = room(&[paragraph("text")]);
    let insert = |value: Value| {
        edit(&room, 8, move |peer| {
            let mut txn = peer.transact_mut();
            let root = plate::content_root(&txn).unwrap();
            let end = XmlTextRef::from(root).len(&txn);
            slate_yjs::insert_nodes(&mut txn, root, end, &[value]);
        })
    };
    let with_text = insert(mermaid(SOURCE));
    let mut validator = validator(&room);
    let (result, _) = admit(&mut validator, &room, &with_text);
    assert!(matches!(result, Ok(Admission::Accepted)), "{result:?}");
    let mut without = mermaid(SOURCE);
    without.as_object_mut().unwrap().remove("source");
    without["id"] = json!("d9");
    let refused = insert(without);
    let (result, _) = admit(&mut validator, &room, &refused);
    match result {
        Err(Refusal::Content(reason)) => assert_eq!(reason, notes::limits::MISSING_KEY),
        other => panic!("{other:?}"),
    }
}
