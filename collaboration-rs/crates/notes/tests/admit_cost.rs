#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! `Validator::admit`'s cost on the update shapes the reviews built to find
//! quadratic paths (notes REVIEW2 M5, REVIEW3 M7 and M8, REVIEW4 M9 to M11):
//! each must stay linear, so a future quadratic path fails here. The cost is
//! counted, not timed (Epo, 2026-10-08): the steps of admission's own walks
//! (`ydoc::steps`) and yrs's integration work on the trial copy, which
//! `ydoc::MAX_WORK` bounds. Every shape is admitted against a room whose
//! validator already holds a bound, as on the room task.
use notes::limits::{Admission, Refusal, Validator};
use notes::{plate, slate_yjs};
use serde_json::json;
use ydoc::doc_options;
use ydoc::steps::{Steps, Walk};
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

/// The steps admission's walks take on `update`, with a bound in place, and
/// whether it was admitted.
fn admit_steps(room: &Doc, update: &[u8]) -> (Steps, bool) {
    let mut validator = Validator::default();
    let nothing = ydoc::decode(&since(room, room)).unwrap();
    validator.admit(room, &nothing).unwrap();
    let decoded = ydoc::decode(update).unwrap();
    ydoc::steps::take();
    let admitted = matches!(validator.admit(room, &decoded), Ok(Admission::Accepted));
    (ydoc::steps::take(), admitted)
}

/// The structs of `update`: admission walks each at least once, a step
/// each, so a test whose count falls below it is not counting (a stubbed or
/// dropped `ydoc::steps::step`).
fn structs(update: &[u8]) -> u64 {
    ydoc::decode(update).unwrap().blocks().count() as u64
}

/// Admission's steps per byte of the update and the room's state: linear
/// walks measure under 1 on every shape below; a walk that turned quadratic
/// takes thousands at these sizes.
const STEPS_PER_BYTE: u64 = 4;

fn room_bytes(room: &Doc) -> u64 {
    room.transact()
        .encode_state_as_update_v1(&StateVector::default())
        .len() as u64
}

/// `admit`'s answer to `update`, as text (`Accepted`, the refusal).
fn verdict(room: &Doc, update: &[u8]) -> String {
    let mut validator = Validator::default();
    match validator.admit(room, &ydoc::decode(update).unwrap()) {
        Ok(admission) => format!("{admission:?}"),
        Err(Refusal::Update(error)) => format!("{error:?}"),
        Err(error) => format!("{error}"),
    }
}

/// The reviewer's forward chain in one client (REVIEW3 M7): struct k takes
/// struct k + 1 of its own client as its origin.
fn forward_in_one_client(items: u32) -> (Doc, Vec<u8>) {
    let room = room("hello");
    let held = {
        let text = paragraph(&room);
        let branch: &yrs::branch::Branch = text.as_ref();
        let first = branch.start().unwrap();
        ID::new(first.id().client, first.id().clock + first.len() - 1)
    };
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(1u32);
    bytes.write_var(items);
    bytes.write_var(77u64);
    bytes.write_var(0u32);
    for k in 0..items {
        bytes.write_u8(0x80 | 4);
        if k + 1 < items {
            bytes.write_var(77u64);
            bytes.write_var(k + 1);
        } else {
            bytes.write_var(held.client.get());
            bytes.write_var(held.clock);
        }
        bytes.write_string("x");
    }
    bytes.write_var(0u32);
    (room, bytes)
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

/// A paragraph of `tombstones` separately typed and deleted characters,
/// then `items` one-character items without an origin, each naming one of the
/// tombstones as its right origin (cycling from the last): every item claims
/// its own spot, but yrs scans from the paragraph's start to its right origin
/// for each (round 8).
fn fanned(tombstones: u32, items: u32) -> (Doc, Vec<u8>) {
    let (room, _) = tomb(tombstones, 0);
    let ids: Vec<ID> = {
        let _txn = room.transact();
        let mut ids = Vec::new();
        let text = paragraph(&room);
        let branch: &yrs::branch::Branch = text.as_ref();
        let mut next = branch.start();
        while let Some(item) = next {
            ids.push(*item.id());
            next = item.right();
        }
        ids
    };
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(1u32);
    bytes.write_var(items);
    bytes.write_var(77u64);
    bytes.write_var(0u32);
    for k in 0..items as usize {
        let right = ids[ids.len() - 1 - k % ids.len()];
        bytes.write_u8(0x40 | 4); // a right origin, string content
        bytes.write_var(right.client.get());
        bytes.write_var(right.clock);
        bytes.write_string("x");
    }
    bytes.write_var(0u32);
    (room, bytes)
}

/// `clients` forged clients with one item each, each item's origin the item
/// of the client before (the first a held character): yrs's struct picker
/// stacks them all (REVIEW4 M9, M10).
fn chained_clients(clients: u64) -> (Doc, Vec<u8>) {
    let room = room("h");
    let held = {
        let text = paragraph(&room);
        let branch: &yrs::branch::Branch = text.as_ref();
        *branch.start().unwrap().id()
    };
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(clients);
    for k in 0..clients {
        let client = 1_000 + k;
        bytes.write_var(1u32);
        bytes.write_var(client);
        bytes.write_var(0u32);
        bytes.write_u8(0x80 | 4);
        if k == 0 {
            bytes.write_var(held.client.get());
            bytes.write_var(held.clock);
        } else {
            bytes.write_var(client - 1);
            bytes.write_var(0u32);
        }
        bytes.write_string("x");
    }
    bytes.write_var(0u32);
    (room, bytes)
}

/// A paragraph holding a run of `run` characters (one item of client 5)
/// followed by 50,000 separately prepended characters of that client, and
/// `items` one-character items each placed between two units of the run: no
/// conflict scan, but each splits the run, and yrs moves every later block of
/// client 5 (REVIEW4 M10, M11).
fn splits(run: u32, items: u32) -> (Doc, Vec<u8>) {
    let room = room("h");
    let writer = copy(&room, 5);
    {
        let text = paragraph(&writer);
        text.insert(&mut writer.transact_mut(), 1, &"r".repeat(run as usize));
        let mut txn = writer.transact_mut();
        for _ in 0..50_000 {
            text.insert(&mut txn, 0, "p");
        }
    }
    let typed = since(&room, &writer);
    room.transact_mut()
        .apply_update(Update::decode_v1(&typed).unwrap())
        .unwrap();
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(1u32);
    bytes.write_var(items);
    bytes.write_var(77u64);
    bytes.write_var(0u32);
    for i in 0..items {
        let k = (i * 2) % (run - 2);
        bytes.write_u8(0x80 | 0x40 | 4);
        bytes.write_var(5u64);
        bytes.write_var(k);
        bytes.write_var(5u64);
        bytes.write_var(k + 1);
        bytes.write_string("x");
    }
    bytes.write_var(0u32);
    (room, bytes)
}

/// `writers` writers each typing a first character into one empty paragraph
/// at once, merged: a class asked to type into one shared box.
fn classroom(writers: u64) -> (Doc, Vec<u8>) {
    let room = room("");
    let updates: Vec<Vec<u8>> = (0..writers)
        .map(|k| {
            let writer = copy(&room, 10 + k);
            paragraph(&writer).insert(&mut writer.transact_mut(), 0, "x");
            since(&room, &writer)
        })
        .collect();
    let update = yrs::merge_updates_v1(&updates).unwrap();
    (room, update)
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

/// Every shape at a few hundred KB stays within [STEPS_PER_BYTE] steps per
/// byte of the update and the room: before the fixes, the paste's and the
/// chain's walks were quadratic in their items (REVIEW2 M5) and the bound
/// walked a text's tombstones once per new item (REVIEW3 M8).
#[test]
fn admit_stays_linear_on_every_hostile_shape() {
    let shapes: [(&str, (Doc, Vec<u8>)); 12] = [
        ("paste", paste(3_000)),
        // Taken by the trial: one long first walk through the chain, and new
        // items with no visible neighbour in a text of tombstones.
        (
            "chained clients, within the budget",
            chained_clients(10_000),
        ),
        ("tombs, within the budget", tomb(2_000, 400)),
        ("forward chain", forward_chain(40_000)),
        ("deep", deep(20_000)),
        ("wide", wide(40_000)),
        ("tombs", tomb(20_000, 20_000)),
        ("tombs, forged clients", tomb_forged(20_000, 20_000)),
        ("fanned", fanned(10_000, 10_000)),
        ("chained clients", chained_clients(20_000)),
        ("splits", splits(200_000, 40_000)),
        ("classroom", classroom(100)),
    ];
    for (name, (room, update)) in shapes {
        let (walks, admitted) = admit_steps(&room, &update);
        let steps = walks.total();
        let bytes = update.len() as u64 + room_bytes(&room);
        let n = structs(&update);
        eprintln!(
            "{name}: {} KB, {steps} steps for {bytes} bytes",
            update.len() / 1024
        );
        assert!(steps <= STEPS_PER_BYTE * bytes, "{name}: {steps} steps");
        // Every update's structs are checked once; an admitted one's are
        // also placed in their containers, content-checked and bounded, each
        // walk at least a step per struct (REVIEW3 N1: a walk whose step goes
        // missing fails here).
        assert!(walks.of(Walk::Structs) >= n, "{name}: struct pass");
        if admitted {
            for walk in [Walk::Containers, Walk::Content, Walk::Placement] {
                assert!(walks.of(walk) >= n, "{name}: {walk:?} {}", walks.of(walk));
            }
        }
    }
    // The tombs, the fanned items, the chained clients and the splits cost
    // yrs too many steps on the trial copy (REVIEW4 M9 to M11: the splits
    // and the struct picker's scans count); a class of 100 typing into one
    // empty paragraph at once is taken; the reviewer's forward chain in one
    // client is malformed (REVIEW3 S6).
    for (room, update) in [
        tomb(20_000, 20_000),
        tomb_forged(20_000, 20_000),
        fanned(10_000, 10_000),
        chained_clients(20_000),
        splits(200_000, 40_000),
    ] {
        assert_eq!(verdict(&room, &update), "Costly");
    }
    let (room, update) = classroom(100);
    assert_eq!(verdict(&room, &update), "Accepted");
    let (room, update) = forward_in_one_client(1_000);
    assert!(verdict(&room, &update).starts_with("Decode"));
}

/// Items each claiming their own spot but all scanned past one run of
/// tombstones (round 8), clients chained one after another and items each
/// splitting one held run (REVIEW4): refused once yrs counts more than the
/// budget on the trial copy, up to the 4 MiB message cap, with admission's
/// own walks within [STEPS_PER_BYTE] per byte.
#[test]
fn a_costly_update_is_refused_within_the_budget() {
    // About 6 bytes per fanned item: 600,000 is near the 4 MiB message cap,
    // as are 330,000 chained clients.
    let shapes = [
        ("fanned 5,000 x 5,000", fanned(5_000, 5_000)),
        ("fanned 10,000 x 10,000", fanned(10_000, 10_000)),
        ("fanned 10,000 x 600,000", fanned(10_000, 600_000)),
        ("chained clients 20,000", chained_clients(20_000)),
        ("chained clients 330,000", chained_clients(330_000)),
        ("splits 100,000", splits(400_000, 100_000)),
        ("splits 250,000", splits(400_000, 250_000)),
    ];
    for (name, (room, update)) in shapes {
        assert!(update.len() <= 4 << 20, "{} bytes", update.len());
        let decoded = ydoc::decode(&update).unwrap();
        ydoc::steps::take();
        let answer = Validator::default().admit(&room, &decoded);
        let steps = ydoc::steps::take().total();
        let bytes = update.len() as u64 + room_bytes(&room);
        eprintln!(
            "{name}: {} KB refused after {steps} steps",
            update.len() / 1024
        );
        assert!(matches!(
            answer,
            Err(Refusal::Update(ydoc::UpdateError::Costly))
        ));
        assert!(steps >= structs(&update), "{name}: {steps} steps");
        assert!(steps <= STEPS_PER_BYTE * bytes, "{name}: {steps} steps");
    }
}

/// A paragraph with `keys` plain attributes besides its own, and a writer's
/// update deleting them all: one delete range of a few bytes (REVIEW5 M3).
fn cleared_attributes(keys: u32) -> (Doc, Vec<u8>) {
    let room = room("wide");
    let writer = copy(&room, 2);
    let element = paragraph(&writer);
    let mut txn = writer.transact_mut();
    for key in 0..keys {
        element.insert_attribute(&mut txn, format!("k{key}"), "v");
    }
    drop(txn);
    let attributes = since(&room, &writer);
    room.transact_mut()
        .apply_update(Update::decode_v1(&attributes).unwrap())
        .unwrap();
    let eraser = copy(&room, 3);
    let element = paragraph(&eraser);
    let mut txn = eraser.transact_mut();
    for key in 0..keys {
        element.remove_attribute(&mut txn, &format!("k{key}"));
    }
    drop(txn);
    let update = since(&room, &eraser);
    (room, update)
}

/// Security regression (REVIEW5 M3: an 8-byte update deleting all 32,000
/// attributes of one element scanned the element's map once per deleted
/// entry, seconds on an async worker). The key checks look a key up only
/// when an element may require it, each lookup counted (`Walk::Entries`):
/// the update stays inline (`heavy` false) and goes in, and `heavy`'s and
/// admission's walks stay within [STEPS_PER_BYTE] per byte, none of them on
/// these keys. The checks read an element's entries only through that
/// counted lookup: `limits.rs` holds no scan of an element's map, which the
/// steps could not count (the M3 scan took 89 s here in debug).
#[test]
fn deleting_every_attribute_of_a_wide_element_stays_inline_and_linear() {
    let checks = include_str!("../src/limits.rs");
    assert!(
        !checks.contains(".map_items("),
        "limits.rs scans an element's map outside the counted lookup"
    );
    let (room, update) = cleared_attributes(32_000);
    assert!(update.len() < 32, "{} bytes", update.len());
    let decoded = ydoc::decode(&update).unwrap();
    ydoc::steps::take();
    assert!(!notes::limits::heavy(
        &room.transact(),
        &decoded,
        update.len()
    ));
    let heavy = ydoc::steps::take();
    let (admission, admitted) = admit_steps(&room, &update);
    assert!(admitted);
    let bytes = update.len() as u64 + room_bytes(&room);
    for (name, walks) in [("heavy", &heavy), ("admit", &admission)] {
        let steps = walks.total();
        eprintln!("{name}: {steps} steps for {bytes} bytes");
        assert!(steps <= STEPS_PER_BYTE * bytes, "{name}: {steps} steps");
        assert_eq!(walks.of(Walk::Entries), 0, "{name}");
    }
    assert!(admission.of(Walk::DeleteRanges) >= 32_000);
}
