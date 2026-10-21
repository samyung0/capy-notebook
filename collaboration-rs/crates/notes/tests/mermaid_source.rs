#![allow(clippy::unwrap_used)] // Tests panic on a broken fixture.
//! A Mermaid block's source as a text of strings (shape A, Epo 2026-10-10):
//! the bootstrap writes it so, it reads as its string, typing and pastes
//! stay on the bound while the size cap still refuses, crafted updates
//! putting a text anywhere else or anything but strings in it are refused
//! within a bounded walk, and an agent's replace_block puts a new block
//! whose source is a text again.

mod common;

use std::collections::HashMap;
use std::sync::Arc;

use common::AdmitBytes;
use notes::edit::{self, DocumentCommand, EditError, EditErrorCode};
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

/// The element at `path` of a document, its top-level block first.
fn element(doc: &Doc, path: &[usize]) -> XmlTextRef {
    let txn = doc.transact();
    let mut branch = plate::content_root(&txn).unwrap();
    for &index in path {
        branch = match &plate::insert_delta(&branch).unwrap()[index].insert {
            plate::Insert::Element(child) => *child,
            plate::Insert::Text(_) => panic!("no element at {path:?}"),
        };
    }
    XmlTextRef::from(branch)
}

/// Top-level block `index` of a document.
fn block(doc: &Doc, index: usize) -> XmlTextRef {
    element(doc, &[index])
}

/// The source text of the Mermaid block at `index`.
fn source(doc: &Doc, index: usize) -> TextRef {
    source_at(doc, &[index])
}

/// The source text of the Mermaid block at `path`.
fn source_at(doc: &Doc, path: &[usize]) -> TextRef {
    let element = element(doc, path);
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
    let mut validator = Validator::new("note");
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

/// A Mermaid block changes through replace_block like any block (Epo
/// 2026-10-21, set_mermaid gone): the agent's ```mermaid fence, converted,
/// replaces the diagram's block whole, and the new block's source is a text
/// again, so editors type into it as before. Fails if the replacement's
/// source lands as a plain string.
#[test]
fn a_replaced_mermaid_block_holds_its_source_as_a_text() {
    let room = room(&[mermaid(SOURCE)]);
    let root = room.get_or_insert_text(plate::CONTENT_ROOT);
    let mut next = mermaid("flowchart LR\n  A --> C");
    next["id"] = json!("d2");
    edit::apply_material_commands(
        &mut room.transact_mut(),
        &root,
        &[DocumentCommand::ReplaceBlock {
            block_id: "d1".into(),
            expected_text: SOURCE.into(),
            blocks: vec![next],
        }],
    )
    .unwrap();
    assert_eq!(projected_source(&room), "flowchart LR\n  A --> C");
    let text = source(&room, 0);
    text.insert(&mut room.transact_mut(), 0, "%% typed\n");
    assert_eq!(projected_source(&room), "%% typed\nflowchart LR\n  A --> C");
    notes::material::assert_canonical(&plate::value(&room.transact()).unwrap(), "diagram").unwrap();
}

/// A captioned, resized diagram block.
fn captioned(caption: &str) -> Value {
    let mut block = mermaid(SOURCE);
    block["children"][0]["children"][0]["text"] = json!(caption);
    block["width"] = json!("60%");
    block
}

/// The caption element of the Mermaid block at `path`.
fn caption(doc: &Doc, path: &[usize]) -> XmlTextRef {
    element(doc, &[path, &[0]].concat())
}

/// The agent's rewrite of block d1, expecting `expected`.
fn rewrite(room: &Doc, expected: &str) -> Result<edit::EditOutcome, EditError> {
    let root = room.get_or_insert_text(plate::CONTENT_ROOT);
    let mut next = mermaid("flowchart LR\n  A --> C");
    next["id"] = json!("d2");
    edit::apply_material_commands(
        &mut room.transact_mut(),
        &root,
        &[DocumentCommand::ReplaceBlock {
            block_id: "d1".into(),
            expected_text: expected.into(),
            blocks: vec![next],
        }],
    )
}

/// A diagram rewrite checks the source the agent inspected, never the
/// caption (Epo 2026-10-22): inspect shows the source as the block's text
/// and the caption apart, and typing in the source since makes the rewrite
/// stale, with the source as it reads now. Fails if the expected text is the
/// caption again.
#[test]
fn a_diagram_rewrite_is_stale_once_its_source_changed_since_the_inspect() {
    let room = room(&[captioned("Cell cycle")]);
    let inspected = edit::inspect_material(&room.transact()).unwrap();
    assert_eq!(inspected[0].text, SOURCE);
    assert_eq!(
        inspected[0].properties.as_ref().unwrap()["caption"],
        "Cell cycle"
    );
    let text = source(&room, 0);
    text.insert(&mut room.transact_mut(), 0, "%% typed\n");
    let typed = format!("%% typed\n{SOURCE}");
    match rewrite(&room, &inspected[0].text) {
        Err(EditError::Edit {
            code: EditErrorCode::StaleTarget,
            details: Some(details),
            ..
        }) => assert_eq!(details["block"]["text"], typed),
        other => panic!("{other:?}"),
    }
    assert_eq!(projected_source(&room), typed);
}

/// A diagram rewrite keeps the block's caption and width (Epo 2026-10-22),
/// the caption as someone changed it since the inspect, which the rewrite
/// never compares. Fails if the rewrite drops either or compares the
/// caption.
#[test]
fn a_diagram_rewrite_keeps_the_caption_and_width() {
    let room = room(&[captioned("Cell cycle")]);
    let inspected = edit::inspect_material(&room.transact()).unwrap();
    let retitled = caption(&room, &[0]);
    retitled.insert(&mut room.transact_mut(), 0, "The ");
    // replace_text would type into the caption: refused.
    let root = room.get_or_insert_text(plate::CONTENT_ROOT);
    let typed = edit::apply_material_commands(
        &mut room.transact_mut(),
        &root,
        &[DocumentCommand::ReplaceText {
            block_id: Some("d1".into()),
            expected_text: "Cell".into(),
            text: "Cat".into(),
        }],
    );
    assert!(
        matches!(
            &typed,
            Err(EditError::Edit {
                code: EditErrorCode::UnsupportedOperation,
                ..
            })
        ),
        "{typed:?}"
    );
    rewrite(&room, &inspected[0].text).unwrap();
    let value = plate::value(&room.transact()).unwrap();
    assert_eq!(value.len(), 1);
    let block = &value[0];
    assert_eq!(block["id"], "d2");
    assert_eq!(block["source"], "flowchart LR\n  A --> C");
    assert_eq!(block["children"][0]["type"], "mermaid_caption");
    assert_eq!(
        block["children"][0]["children"][0]["text"],
        "The Cell cycle"
    );
    assert_eq!(block["width"], "60%");
    notes::material::assert_canonical(&value, "diagram").unwrap();
}

/// A rewrite into the Mermaid block and a paragraph beside it keeps the
/// block's caption and width too (review r2 M1): the replacement's first
/// block of its type is its rewrite. Fails if only a one-block replacement
/// keeps them.
#[test]
fn a_diagram_rewritten_with_a_paragraph_keeps_its_caption() {
    let room = room(&[captioned("Tide flow")]);
    let root = room.get_or_insert_text(plate::CONTENT_ROOT);
    let mut next = mermaid("flowchart LR\n  A --> C");
    next["id"] = json!("d2");
    let explained =
        json!({ "children": [{ "text": "A short explanation." }], "id": "p2", "type": "p" });
    edit::apply_material_commands(
        &mut room.transact_mut(),
        &root,
        &[DocumentCommand::ReplaceBlock {
            block_id: "d1".into(),
            expected_text: SOURCE.into(),
            blocks: vec![next, explained],
        }],
    )
    .unwrap();
    let value = plate::value(&room.transact()).unwrap();
    assert_eq!(value[0]["source"], "flowchart LR\n  A --> C");
    assert_eq!(value[0]["children"][0]["children"][0]["text"], "Tide flow");
    assert_eq!(value[0]["width"], "60%");
    assert_eq!(value[1]["children"][0]["text"], "A short explanation.");
    notes::material::assert_canonical(&value, "note").unwrap();
}

/// A Mermaid block inside a container reads as its source there too (review
/// r2 L1): the callout's expected text holds the nested source, not its
/// caption, so typing in the nested source makes the agent's rewrite of the
/// callout stale while typing in the nested caption does not; replace_text
/// past the nested block edits the callout's own paragraph, and a span into
/// the source is refused. Fails if a nested caption is compared again.
#[test]
fn a_mermaid_block_in_a_callout_reads_as_its_source() {
    let room = room(&[json!({
        "children": [captioned("Cell cycle"), paragraph("Read it left to right.")],
        "id": "c1",
        "type": "callout",
    })]);
    let root = room.get_or_insert_text(plate::CONTENT_ROOT);
    let apply = |command: DocumentCommand| {
        edit::apply_material_commands(&mut room.transact_mut(), &root, &[command])
    };
    let inspect = || {
        edit::inspect_material(&room.transact()).unwrap()[0]
            .text
            .clone()
    };
    assert_eq!(inspect(), format!("{SOURCE}Read it left to right."));
    let replace_text = |expected: &str| DocumentCommand::ReplaceText {
        block_id: Some("c1".into()),
        expected_text: expected.into(),
        text: "top down".into(),
    };
    apply(replace_text("left to right")).unwrap();
    let value = plate::value(&room.transact()).unwrap();
    assert_eq!(
        value[0]["children"][1]["children"][0]["text"],
        "Read it top down."
    );
    assert_eq!(
        value[0]["children"][0]["children"][0]["children"][0]["text"],
        "Cell cycle"
    );
    assert!(matches!(
        apply(replace_text("--> B")),
        Err(EditError::Edit {
            code: EditErrorCode::InvalidInput,
            ..
        })
    ));
    let rewrite = |expected: String| DocumentCommand::ReplaceBlock {
        block_id: "c1".into(),
        expected_text: expected,
        blocks: vec![json!({ "children": [paragraph("New")], "id": "c2", "type": "callout" })],
    };
    let before = inspect();
    let text = source_at(&room, &[0, 0]);
    text.insert(&mut room.transact_mut(), 0, "%% typed\n");
    assert!(matches!(
        apply(rewrite(before)),
        Err(EditError::Edit {
            code: EditErrorCode::StaleTarget,
            ..
        })
    ));
    let before = inspect();
    let retitled = caption(&room, &[0, 0]);
    retitled.insert(&mut room.transact_mut(), 0, "The ");
    apply(rewrite(before)).unwrap();
    assert_eq!(plate::value(&room.transact()).unwrap()[0]["id"], "c2");
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

/// Security regression (rust-core REVIEW5 R2b's Mermaid case, live-items
/// REVIEW5 S4): removing a held block's source text is refused at admit, so
/// only that writer's update is lost (the store's check would refuse it and
/// discard every writer's unsaved work in the room), while another attribute
/// of the block still goes in. Fails if the key checks read a held source
/// text as no value.
#[test]
fn removing_a_held_source_text_is_refused() {
    let room = room(&[paragraph("text"), mermaid(SOURCE)]);
    let _ = source(&room, 1);
    let mut validator = validator(&room);
    let themed = edit(&room, 11, |peer| {
        let element = block(peer, 1);
        let mut txn = peer.transact_mut();
        element.insert_attribute(&mut txn, "theme", "linear-dark");
    });
    let (result, _) = admit(&mut validator, &room, &themed);
    assert!(matches!(result, Ok(Admission::Accepted)), "{result:?}");
    let removed = edit(&room, 12, |peer| {
        let element = block(peer, 1);
        let mut txn = peer.transact_mut();
        element.remove_attribute(&mut txn, &"source");
    });
    let (result, _) = admit(&mut validator, &room, &removed);
    match result {
        Err(Refusal::Content(reason)) => assert_eq!(reason, notes::limits::MISSING_KEY),
        other => panic!("a held source's removal was not refused: {other:?}"),
    }
}
