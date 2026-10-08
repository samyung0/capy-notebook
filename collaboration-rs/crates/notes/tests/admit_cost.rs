#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! `Validator::admit`'s cost, and the room's apply when it admits, on the
//! update shapes the reviews built to find quadratic paths (notes REVIEW2 M5,
//! REVIEW3 M7 and M8, the crowded spot of round 7): each must stay linear, so
//! a future quadratic path fails here. Every shape is admitted against a room
//! whose validator already holds a bound, as on the room task.
use std::time::{Duration, Instant};

use notes::limits::{Admission, Refusal, Validator};
use notes::{plate, slate_yjs};
use serde_json::json;
use ydoc::doc_options;
use yrs::encoding::write::Write;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ID, ReadTxn, StateVector, Text, Transact, Update, Xml, XmlTextPrelim, XmlTextRef};

/// A room holding one paragraph of `text`.
fn room(text: &str) -> Doc {
    let doc = Doc::with_options(doc_options(1));
    doc.get_or_insert_text(plate::CONTENT_ROOT);
    let mut txn = doc.transact_mut();
    let root = plate::content_root(&txn).unwrap();
    slate_yjs::insert_nodes(
        &mut txn,
        root,
        0,
        &[json!({ "type": "p", "id": "a", "children": [{ "text": text }] })],
    );
    drop(txn);
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

fn since(room: &Doc, peer: &Doc) -> Vec<u8> {
    peer.transact()
        .encode_state_as_update_v1(&room.transact().state_vector())
}

fn paragraph(doc: &Doc) -> XmlTextRef {
    let txn = doc.transact();
    match &plate::insert_delta(&plate::content_root(&txn).unwrap()).unwrap()[0].insert {
        plate::Insert::Element(branch) => XmlTextRef::from(*branch),
        plate::Insert::Text(_) => panic!("not a block"),
    }
}

/// How long `admit` and, when it admits, the room's apply take on `update`,
/// with a bound in place (best of three, each on a fresh copy of the room).
fn admit_time(room: &Doc, update: &[u8]) -> Duration {
    (0..3)
        .map(|_| {
            let room = copy(room, 1);
            let mut validator = Validator::default();
            let nothing = ydoc::decode(&since(&room, &room)).unwrap();
            validator.admit(&room, &nothing).unwrap();
            let decoded = ydoc::decode(update).unwrap();
            let start = Instant::now();
            if let Ok(Admission::Accepted) = validator.admit(&room, &decoded) {
                room.transact_mut().apply_update(decoded).unwrap();
            }
            start.elapsed()
        })
        .min()
        .unwrap_or_default()
}

/// Whether `admit` refuses `update` as a crowded spot.
fn crowded(room: &Doc, update: &[u8]) -> bool {
    let mut validator = Validator::default();
    matches!(
        validator.admit(room, &ydoc::decode(update).unwrap()),
        Err(Refusal::Update(ydoc::UpdateError::Crowded))
    )
}

/// How long the growth bound alone takes on `update` (best of three). The
/// tomb shape is priced here: past the bound, admit's exact check applies it
/// to a copy of the room, and yrs's own integration of items without origins
/// into a text full of them is quadratic (FIXES4 round 6).
fn growth_time(room: &Doc, update: &[u8]) -> Duration {
    let decoded = ydoc::decode(update).unwrap();
    let txn = room.transact();
    let incoming = ydoc::Incoming::new(&decoded);
    (0..3)
        .map(|_| {
            let start = Instant::now();
            let _ = notes::bound::growth(&txn, &incoming);
            start.elapsed()
        })
        .min()
        .unwrap_or_default()
}

fn ms_per_kb(time: Duration, update: &[u8]) -> f64 {
    time.as_secs_f64() * 1e3 / (update.len() as f64 / 1024.0)
}

/// A paste of `blocks` two-leaf paragraphs, each chained to the one before.
fn paste(blocks: usize) -> (Doc, Vec<u8>) {
    let room = room("hello");
    let writer = copy(&room, 2);
    {
        let mut txn = writer.transact_mut();
        let root = plate::content_root(&txn).unwrap();
        let len = XmlTextRef::from(root).len(&txn);
        let nodes: Vec<_> = (0..blocks)
            .map(|i| json!({ "type": "p", "id": format!("b{i}"), "children": [{ "text": "x" }, { "text": "y", "bold": true }] }))
            .collect();
        slate_yjs::insert_nodes(&mut txn, root, len, &nodes);
    }
    let update = since(&room, &writer);
    (room, update)
}

/// `items` one-character items that chain forward across two clients (an
/// item of client 77 takes one of client 78 as its origin, and that one the
/// next item of client 77), the last one a held character: one long first
/// walk, which never names its own client's later clock directly.
fn forward_chain(items: u32) -> (Doc, Vec<u8>) {
    let room = room("hello");
    let held = {
        let txn = room.transact();
        let block = plate::content_root(&txn).unwrap();
        let Some(paragraph) = plate::insert_delta(&block)
            .unwrap()
            .into_iter()
            .find_map(|op| match op.insert {
                plate::Insert::Element(branch) => Some(branch),
                plate::Insert::Text(_) => None,
            })
        else {
            panic!("no paragraph");
        };
        let first = paragraph.start().unwrap();
        ID::new(first.id().client, first.id().clock + first.len() - 1)
    };
    let per_client = items / 2;
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(2u32);
    for (client, other) in [(78u64, 77u64), (77, 78)] {
        bytes.write_var(per_client);
        bytes.write_var(client);
        bytes.write_var(0u32);
        for k in 0..per_client {
            bytes.write_u8(0x80 | 4); // an origin, string content
            if client == 77 {
                // 77:k -> 78:k
                bytes.write_var(other);
                bytes.write_var(k);
            } else if k + 1 < per_client {
                // 78:k -> 77:(k + 1)
                bytes.write_var(other);
                bytes.write_var(k + 1);
            } else {
                bytes.write_var(held.client.get());
                bytes.write_var(held.clock);
            }
            bytes.write_string("x");
        }
    }
    bytes.write_var(0u32);
    (room, bytes)
}

/// A paragraph holding `tombstones` separately typed and deleted characters,
/// then an update of `items` one-character items with no origins and the
/// paragraph as their parent, from one client or each from its own (forged)
/// client id.
fn tomb(tombstones: u32, items: u32) -> (Doc, Vec<u8>) {
    tomb_from(tombstones, items, false)
}

fn tomb_forged(tombstones: u32, items: u32) -> (Doc, Vec<u8>) {
    tomb_from(tombstones, items, true)
}

fn tomb_from(tombstones: u32, items: u32, forged: bool) -> (Doc, Vec<u8>) {
    let room = room("");
    let writer = copy(&room, 5);
    {
        let text = paragraph(&writer);
        for _ in 0..tombstones {
            text.insert(&mut writer.transact_mut(), 0, "t");
        }
        let len = text.len(&writer.transact());
        text.remove_range(&mut writer.transact_mut(), 0, len);
    }
    let typed = since(&room, &writer);
    room.transact_mut()
        .apply_update(Update::decode_v1(&typed).unwrap())
        .unwrap();
    let parent = {
        let txn = room.transact();
        let block = plate::content_root(&txn).unwrap();
        match &plate::insert_delta(&block).unwrap()[0].insert {
            plate::Insert::Element(branch) => *branch.item().unwrap().id(),
            plate::Insert::Text(_) => panic!("no paragraph"),
        }
    };
    let (clients, per) = if forged { (items, 1) } else { (1, items) };
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(clients);
    for client in 0..clients {
        bytes.write_var(per);
        bytes.write_var(1_000 + client as u64);
        bytes.write_var(0u32);
        for _ in 0..per {
            bytes.write_u8(4); // string content, no origins: the parent follows
            bytes.write_var(0u32); // the parent is an item
            bytes.write_var(parent.client.get());
            bytes.write_var(parent.clock);
            bytes.write_string("x");
        }
    }
    bytes.write_var(0u32);
    (room, bytes)
}

/// One chain of `depth` nested blockquotes.
fn deep(depth: usize) -> (Doc, Vec<u8>) {
    let room = room("hello");
    let writer = copy(&room, 2);
    {
        let mut txn = writer.transact_mut();
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
    }
    let update = since(&room, &writer);
    (room, update)
}

/// `chars` characters prepended one by one into one paragraph: separate
/// items in one text.
fn wide(chars: u32) -> (Doc, Vec<u8>) {
    let room = room("hello");
    let writer = copy(&room, 2);
    let text = paragraph(&writer);
    let mut txn = writer.transact_mut();
    for _ in 0..chars {
        text.insert(&mut txn, 0, "w");
    }
    drop(txn);
    let update = since(&room, &writer);
    (room, update)
}

/// Every shape at a few hundred KB stays under a cost per KB that a
/// quadratic path at that size passes by an order of magnitude (the forward
/// chain took 5.7 ms per KB at 193 KB in release before REVIEW3 M7, the
/// tombs 41 ms per KB at 60 KB before M8, the paste 17 ms per KB at 314 KB
/// before REVIEW2 M5; debug builds are about five times slower). Linear, they
/// measure under 0.5 ms per KB in release and 3.5 in debug.
#[test]
fn admit_stays_linear_on_every_hostile_shape() {
    let limit = if cfg!(debug_assertions) { 10.0 } else { 2.0 };
    let shapes: [(&str, (Doc, Vec<u8>)); 6] = [
        ("paste", paste(3_000)),
        ("forward chain", forward_chain(40_000)),
        ("deep", deep(20_000)),
        ("wide", wide(40_000)),
        ("tombs", tomb(20_000, 20_000)),
        ("tombs, forged clients", tomb_forged(20_000, 20_000)),
    ];
    for (name, (room, update)) in shapes {
        let cost = ms_per_kb(admit_time(&room, &update), &update);
        eprintln!(
            "{name}: {} KB, admit and apply {cost:.3} ms per KB",
            update.len() / 1024
        );
        assert!(cost < limit, "{name}: {cost} ms per KB");
    }
    // The tombs crowd one spot (the start of the paragraph), from one client
    // or from 20,000.
    for (room, update) in [tomb(20_000, 20_000), tomb_forged(20_000, 20_000)] {
        assert!(crowded(&room, &update));
    }
}

/// The REVIEW3 shapes at two sizes: four times the input in under eight
/// times the time (quadratic is sixteen). Admit for the forward chain, the
/// growth bound for the tombs (see [growth_time]).
#[test]
fn forward_chains_and_tombs_scale_linearly() {
    let (room, update) = forward_chain(10_000);
    let small = admit_time(&room, &update);
    let (room, update) = forward_chain(40_000);
    let large = admit_time(&room, &update);
    eprintln!("forward chain admit: 10,000 items {small:?}, 40,000 items {large:?}");
    assert!(
        large < small * 8 + Duration::from_millis(20),
        "{small:?} -> {large:?}"
    );
    let (room, update) = tomb(5_000, 5_000);
    let small = growth_time(&room, &update);
    let (room, update) = tomb(20_000, 20_000);
    let large = growth_time(&room, &update);
    eprintln!("tombs growth: 5,000 x 5,000 {small:?}, 20,000 x 20,000 {large:?}");
    assert!(
        large < small * 8 + Duration::from_millis(20),
        "{small:?} -> {large:?}"
    );
}
