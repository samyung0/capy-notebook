//! Q549: a deleted slide or table restored by an editor's Undo with a peer's edits, through
//! the collaboration service's own admission and apply (`sources::admit_update`,
//! `ydoc::apply_freeing`, the relay rule of `Room::apply_update`), engines as a browser runs
//! them, and the stored change over the seed, its export, its load and a collection.

#![allow(clippy::unwrap_used)]

use std::cell::RefCell;
use std::rc::Rc;

use docx_edit::{
    EditCtx as DocxCtx, EngineSession, FormatPolicy, Position, TableLocator, UndoSession,
};
use office_service::{Checkpoint, Determinism, Format};
use pptx_edit::{DeckSession, EditCtx, TextStyle, UpdateOrigin};
use sources::{Admission, Estimate, SourceFormat};
use ydoc::gc::Window;
use yrs::updates::decoder::Decode;
use yrs::{Any, Doc, IdSet, Map, Out, ReadTxn, StateVector, Text, Transact, Update};

const DETERMINISM: Determinism = Determinism {
    seed: "0000000000000000000000000000000000000000000000000000000000000000",
    now: "2026-11-05T00:00:00.000Z",
};
const CAP: u64 = 64 << 20;

struct Room {
    format: SourceFormat,
    doc: Doc,
    seed: StateVector,
    estimate: Estimate,
}

impl Room {
    fn new(format: SourceFormat, seed: &[u8]) -> Self {
        let doc = ydoc::scratch_doc();
        ydoc::apply(&doc, Update::decode_v1(seed).unwrap()).unwrap();
        let vector = doc.transact().state_vector();
        Room {
            format,
            doc,
            seed: vector,
            estimate: Estimate::new(seed.len() as u64),
        }
    }

    /// `Room::check_update` and `apply_update`: admits, applies, returns what it relays.
    fn admit(&mut self, update: &[u8]) -> Vec<u8> {
        assert_eq!(
            sources::admit_update(&self.doc, self.format, update, &mut self.estimate, CAP, CAP),
            Admission::Accept
        );
        let decoded = Update::decode_v1(update).unwrap();
        if !ydoc::contains_changes(&self.doc.transact(), &decoded) {
            return if decoded.delete_set().is_empty() {
                Vec::new()
            } else {
                yrs::merge_updates_v1([update]).unwrap()
            };
        }
        let (content, freed, lost) =
            ydoc::apply_freeing(&self.doc, decoded, Some(&self.seed)).unwrap();
        self.estimate.applied(content.len() as u64, freed);
        if lost.landed || lost.deletions {
            yrs::merge_updates_v1([update]).unwrap()
        } else {
            content
        }
    }

    fn state(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// What a save stores: the change over the seed, which with the seed must load.
    fn stored_change(&self, seed: &[u8]) -> Vec<u8> {
        let change = self.doc.transact().encode_state_as_update_v1(&self.seed);
        let loaded = ydoc::scratch_doc();
        ydoc::replay(&loaded, seed, &[change.as_slice()]).unwrap();
        assert!(!ydoc::has_pending(&loaded.transact()));
        change
    }

    /// One collection of this state, as a note's fold runs it; it must load.
    fn collected(&self) -> Vec<u8> {
        let window = Window::of(&self.doc.transact(), 1);
        ydoc::gc::collect(&self.doc, &window, &IdSet::new(), None).state
    }
}

fn checkpoint<'a>(format: Format, sha: &'a str, state: &'a [u8]) -> Checkpoint<'a> {
    Checkpoint {
        format,
        schema_version: 1,
        base_sha256: sha,
        state,
    }
}

fn package_text(bytes: &[u8]) -> String {
    let mut text = String::new();
    for (name, part) in ooxml_opc::unzip_parts(bytes).unwrap() {
        if name.ends_with(".xml") {
            text.push_str(&String::from_utf8_lossy(&part));
        }
    }
    text
}

#[test]
fn a_deck_through_the_services_admission() {
    let base = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../vendor/betteroffice/poc/fixtures/deck-50.pptx"),
    )
    .unwrap();
    let sha = office_service::sha256_hex(&base);
    let seed = office_service::seed(Format::Pptx, &base).unwrap();
    let mut room = Room::new(SourceFormat::Pptx, &seed);
    let open = |client| {
        let session = DeckSession::open_from_update_with_source(&seed, &base, client).unwrap();
        let outbox = Rc::new(RefCell::new(Vec::<Vec<u8>>::new()));
        let sink = Rc::clone(&outbox);
        let subscription = session
            .observe_update_v1(move |event| {
                if event.origin == UpdateOrigin::Local {
                    sink.borrow_mut().push(event.update);
                }
            })
            .unwrap();
        (session, outbox, subscription)
    };
    let (left, left_out, _left_sub) = open(501);
    let (right, right_out, _right_sub) = open(502);
    let snapshot = left.snapshot().unwrap();
    let (slide, shape, story) = snapshot
        .slides
        .iter()
        .find_map(|slide| {
            slide
                .shapes
                .iter()
                .find(|shape| !shape.text_stories.is_empty())
                .map(|shape| (&slide.id, &shape.id, &shape.text_stories[0].id))
        })
        .unwrap();
    let context = EditCtx::local("user");
    let end = right.story(story).unwrap().length - 1;

    left.delete_slide(&context, slide).unwrap();
    left.add_undo_barrier();
    for update in left_out.borrow_mut().drain(..) {
        room.admit(&update);
    }
    let before_typing = room.state().len();
    right
        .insert_text(&context, story, end, "QPEERTEXT", &TextStyle::default())
        .unwrap();
    right
        .move_shape(&context, slide, shape, 1_234_567, 2_345_678)
        .unwrap();
    let mut relayed = Vec::new();
    for update in right_out.borrow_mut().drain(..) {
        relayed.push(room.admit(&update));
    }
    assert!(relayed[0].windows(9).any(|window| window == b"QPEERTEXT"));
    let after_typing = room.state();
    assert!(!after_typing.windows(9).any(|window| window == b"QPEERTEXT"));
    println!(
        "pptx: state {before_typing} B, {} B after the landed edits; relayed {:?} B",
        after_typing.len(),
        relayed.iter().map(Vec::len).collect::<Vec<_>>()
    );
    for frame in &relayed {
        left.apply_update_v1(frame).unwrap();
    }
    assert!(left.undo());
    for update in left_out.borrow_mut().drain(..) {
        println!("pptx: the Undo's update {} B", update.len());
        let frame = room.admit(&update);
        right.apply_update_v1(&frame).unwrap();
    }
    assert_eq!(left.snapshot().unwrap(), right.snapshot().unwrap());

    let state = room.state();
    let change = room.stored_change(&seed);
    println!(
        "pptx: seed {} B, state {} B, stored change {} B",
        seed.len(),
        state.len(),
        change.len()
    );
    let exported =
        office_service::export(&base, checkpoint(Format::Pptx, &sha, &state), DETERMINISM).unwrap();
    assert!(package_text(&exported).contains("QPEERTEXT"));

    // A collection of the same state keeps what readers read.
    let collected = room.collected();
    println!("pptx: state after one collection {} B", collected.len());
    let reloaded = DeckSession::open_from_update_with_source(&collected, &base, 900).unwrap();
    assert_eq!(reloaded.snapshot().unwrap(), left.snapshot().unwrap());
}

#[test]
fn a_document_through_the_services_admission() {
    let base = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../vendor/betteroffice/poc/fixtures/exchange-plan.docx"),
    )
    .unwrap();
    let sha = office_service::sha256_hex(&base);
    let seed = office_service::seed(Format::Docx, &base).unwrap();
    let mut room = Room::new(SourceFormat::Docx, &seed);
    let open = |client| {
        let engine = EngineSession::new(client);
        engine.doc().apply_update_v1(&seed).unwrap();
        engine
    };
    let (left, right) = (open(51), open(52));
    let undo = UndoSession::new();
    undo.track(left.doc());
    let ctx = DocxCtx::local("Ada", "2026-11-05T00:00:00Z");
    let cell = {
        let txn = left.doc().yrs_doc().transact();
        let Some(Out::YText(body)) = txn.get_map("stories").unwrap().get(&txn, "body") else {
            panic!("no body");
        };
        body.diff(&txn, yrs::types::text::YChange::identity)
            .into_iter()
            .find_map(|diff| match diff.insert {
                Out::YMap(table)
                    if matches!(table.get(&txn, "_kind"), Some(Out::Any(Any::String(kind))) if &*kind == "table") =>
                {
                    let Some(Out::Any(Any::Array(rows))) = table.get(&txn, "rows") else {
                        panic!("no rows");
                    };
                    let Any::Map(row) = &rows[0] else { panic!() };
                    let Some(Any::Array(cells)) = row.get("cells") else {
                        panic!()
                    };
                    let Any::Map(cell) = &cells[0] else { panic!() };
                    match cell.get("story") {
                        Some(Any::String(story)) => Some(story.to_string()),
                        _ => None,
                    }
                }
                _ => None,
            })
            .unwrap()
    };
    let base_vector = left.doc().encode_state_vector_v1();
    left.doc()
        .delete_table(&ctx, &TableLocator::new("body", 0))
        .unwrap();
    undo.add_undo_barrier();
    room.admit(&left.doc().encode_diff_v1(&base_vector).unwrap());
    let before_typing = room.state().len();

    let base_vector = right.doc().encode_state_vector_v1();
    right
        .doc()
        .insert_text(
            &ctx,
            Position::new(&cell, 0),
            "QPEERTEXT",
            FormatPolicy::Plain,
        )
        .unwrap();
    let typing = right.doc().encode_diff_v1(&base_vector).unwrap();
    let frame = room.admit(&typing);
    assert!(frame.windows(9).any(|window| window == b"QPEERTEXT"));
    let after_typing = room.state();
    assert!(!after_typing.windows(9).any(|window| window == b"QPEERTEXT"));
    println!(
        "docx: state {before_typing} B, {} B after the landed edit; relayed {} B",
        after_typing.len(),
        frame.len()
    );
    left.doc()
        .applying_peer_update(|| left.doc().apply_update_v1(&frame).unwrap());

    let base_vector = left.doc().encode_state_vector_v1();
    assert!(undo.undo());
    let restore = left.doc().encode_diff_v1(&base_vector).unwrap();
    println!("docx: the Undo's update {} B", restore.len());
    let frame = room.admit(&restore);
    right
        .doc()
        .applying_peer_update(|| right.doc().apply_update_v1(&frame).unwrap());

    let state = room.state();
    let change = room.stored_change(&seed);
    println!(
        "docx: seed {} B, state {} B, stored change {} B",
        seed.len(),
        state.len(),
        change.len()
    );
    let exported =
        office_service::export(&base, checkpoint(Format::Docx, &sha, &state), DETERMINISM).unwrap();
    assert!(package_text(&exported).contains("QPEERTEXT"));

    let collected = room.collected();
    println!("docx: state after one collection {} B", collected.len());
    let exported = office_service::export(
        &base,
        checkpoint(Format::Docx, &sha, &collected),
        DETERMINISM,
    )
    .unwrap();
    assert!(package_text(&exported).contains("QPEERTEXT"));
}
