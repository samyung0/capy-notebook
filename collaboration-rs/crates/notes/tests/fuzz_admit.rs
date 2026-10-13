#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! A deterministic mutation fuzz of the room path: real updates (typing,
//! deleting, formatting, attributes, new and removed blocks, a paste,
//! concurrent writers) and crafted ones (items fanned over a paragraph, 40
//! chained clients, splits of every held item) mutated by one to six bytes,
//! then decoded, admitted and, when admitted, applied, measured and projected. It fails on a panic
//! or on a case whose admission walks take more than [STEPS_PER_BYTE] steps
//! per byte of the update and the room (a stall counted, not timed),
//! printing the case to replay. A fixed
//! seed and case count keep it repeatable in CI; FUZZ_CASES and FUZZ_SEED
//! run more or other cases locally.
use std::panic::{AssertUnwindSafe, catch_unwind};

use notes::limits::{Admission, Validator};
use notes::{plate, slate_yjs};
use serde_json::json;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Text, Transact, Update, Xml, XmlTextPrelim, XmlTextRef};

/// xorshift64.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn room() -> Doc {
    let doc = Doc::with_options(ydoc::doc_options(1));
    doc.get_or_insert_text(plate::CONTENT_ROOT);
    let mut txn = doc.transact_mut();
    let root = plate::content_root(&txn).unwrap();
    slate_yjs::insert_nodes(
        &mut txn,
        root,
        0,
        &[
            json!({"type":"p","id":"a","children":[{"text":"hello "},{"text":"bold","bold":true},{"text":" 😀 world"}]}),
            json!({"type":"table","id":"t","children":[{"type":"tr","children":[{"type":"td","children":[{"type":"p","children":[{"text":"cell"}]}]}]}]}),
            json!({"type":"p","id":"b","children":[{"text":"x"},{"type":"a","url":"u","children":[{"text":"link"}]},{"text":"y"}]}),
        ],
    );
    drop(txn);
    doc
}

fn state(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn load(state: &[u8], client: u64) -> Doc {
    let doc = Doc::with_options(ydoc::doc_options(client));
    doc.transact_mut()
        .apply_update(Update::decode_v1(state).unwrap())
        .unwrap();
    doc
}

/// What one peer of the room writes, as the update the room receives.
fn seeds(base: &[u8]) -> Vec<Vec<u8>> {
    let held = load(base, 1).transact().state_vector();
    let mut out = Vec::new();
    for kind in 0..8u64 {
        let peer = load(base, 10 + kind);
        {
            let mut txn = peer.transact_mut();
            let root = XmlTextRef::from(plate::content_root(&txn).unwrap());
            let block = match &plate::insert_delta(root.as_ref()).unwrap()[0].insert {
                plate::Insert::Element(branch) => XmlTextRef::from(*branch),
                plate::Insert::Text(_) => panic!("not a block"),
            };
            match kind {
                0 => block.insert(&mut txn, 3, "typed"),
                1 => block.remove_range(&mut txn, 2, 6),
                2 => block.format(
                    &mut txn,
                    0,
                    5,
                    [("italic".into(), true.into())].into_iter().collect(),
                ),
                3 => {
                    block.insert_attribute(&mut txn, "align", "center");
                }
                4 => {
                    let added: XmlTextRef = root.insert_embed(&mut txn, 1, XmlTextPrelim::new(""));
                    added.insert_attribute(&mut txn, "type", "p");
                    added.insert(&mut txn, 0, "new block");
                }
                5 => root.remove_range(&mut txn, 0, 1),
                6 => {
                    let len = root.len(&txn);
                    let nodes: Vec<_> = (0..40)
                        .map(|i| json!({"type":"p","id":format!("p{i}"),"children":[{"text":"x"},{"text":"y","bold":true}]}))
                        .collect();
                    let root = plate::content_root(&txn).unwrap();
                    slate_yjs::insert_nodes(&mut txn, root, len, &nodes);
                }
                _ => {
                    for i in 0..30u32 {
                        block.insert(&mut txn, 0, if i % 2 == 0 { "q" } else { "r" });
                    }
                }
            }
        }
        out.push(peer.transact().encode_state_as_update_v1(&held));
    }
    // Three writers typing at one place at once, merged.
    let concurrent: Vec<Vec<u8>> = (0..3)
        .map(|k| {
            let peer = load(base, 30 + k);
            let block = {
                let txn = peer.transact();
                match &plate::insert_delta(&plate::content_root(&txn).unwrap()).unwrap()[0].insert {
                    plate::Insert::Element(branch) => XmlTextRef::from(*branch),
                    plate::Insert::Text(_) => panic!("not a block"),
                }
            };
            block.insert(&mut peer.transact_mut(), 4, "c");
            peer.transact().encode_state_as_update_v1(&held)
        })
        .collect();
    out.push(yrs::merge_updates_v1(&concurrent).unwrap());
    let units = units(base);
    out.push(fanned(&units));
    out.push(chained_clients(&units, 40));
    out.push(splits(&units));
    out
}

/// The units of the first paragraph, in order (its characters and marks).
fn units(base: &[u8]) -> Vec<yrs::ID> {
    let room = load(base, 1);
    let txn = room.transact();
    let block = match &plate::insert_delta(&plate::content_root(&txn).unwrap()).unwrap()[0].insert {
        plate::Insert::Element(branch) => *branch,
        plate::Insert::Text(_) => panic!("not a block"),
    };
    let mut units = Vec::new();
    let mut next = block.start();
    while let Some(item) = next {
        let id = *item.id();
        units.extend((0..item.len()).map(|offset| yrs::ID::new(id.client, id.clock + offset)));
        next = item.right();
    }
    units
}

/// `clients` clients with one item each, each item's origin the item of the
/// client before, the first after the paragraph's first unit (REVIEW4 M9).
fn chained_clients(units: &[yrs::ID], clients: u64) -> Vec<u8> {
    use yrs::encoding::write::Write;
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(clients);
    for k in 0..clients {
        bytes.write_var(1u32);
        bytes.write_var(60 + k);
        bytes.write_var(0u32);
        bytes.write_u8(0x80 | 4); // an origin, a string
        if k == 0 {
            bytes.write_var(units[0].client.get());
            bytes.write_var(units[0].clock);
        } else {
            bytes.write_var(60 + k - 1);
            bytes.write_var(0u32);
        }
        bytes.write_string("x");
    }
    bytes.write_var(0u32);
    bytes
}

/// One-character items each between two consecutive units of one held item
/// of the paragraph: each splits it (REVIEW4 M10, M11).
fn splits(units: &[yrs::ID]) -> Vec<u8> {
    use yrs::encoding::write::Write;
    let pairs: Vec<_> = units
        .windows(2)
        .filter(|pair| pair[0].client == pair[1].client && pair[0].clock + 1 == pair[1].clock)
        .collect();
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(1u32);
    bytes.write_var(pairs.len() as u32);
    bytes.write_var(55u64);
    bytes.write_var(0u32);
    for pair in pairs {
        bytes.write_u8(0x80 | 0x40 | 4); // an origin, a right origin, a string
        for unit in pair {
            bytes.write_var(unit.client.get());
            bytes.write_var(unit.clock);
        }
        bytes.write_string("x");
    }
    bytes.write_var(0u32);
    bytes
}

/// One-character items with only a right origin, each a unit of the first
/// paragraph from its last back: each claims a spot of its own, and yrs scans
/// from the paragraph's start to each (round 8's costly shape, small).
fn fanned(units: &[yrs::ID]) -> Vec<u8> {
    use yrs::encoding::write::Write;
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(1u32);
    bytes.write_var(units.len() as u32);
    bytes.write_var(50u64);
    bytes.write_var(0u32);
    for right in units.iter().rev() {
        bytes.write_u8(0x40 | 4); // a right origin, a string
        bytes.write_var(right.client.get());
        bytes.write_var(right.clock);
        bytes.write_string("x");
    }
    bytes.write_var(0u32);
    bytes
}

/// As `admit_cost.rs`: linear walks take under one step per byte.
const STEPS_PER_BYTE: u64 = 4;

#[test]
fn mutated_updates_never_panic_or_stall() {
    let cases: u64 = std::env::var("FUZZ_CASES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(2_000);
    let seed: u64 = std::env::var("FUZZ_SEED")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0x9e37_79b9_7f4a_7c15);
    let base = state(&room());
    let seeds = seeds(&base);
    let mut rng = Rng(seed);
    let (mut accepted, mut unheld, mut refused, mut most) = (0u64, 0u64, 0u64, 0u64);
    for case in 0..cases {
        let mut update = seeds[rng.below(seeds.len())].clone();
        for _ in 0..1 + rng.below(6) {
            let at = rng.below(update.len());
            match rng.below(3) {
                0 => update[at] = rng.next() as u8,
                1 => update[at] ^= 1 << rng.below(8),
                _ => update[at] = update[at].wrapping_add(1),
            }
        }
        let room = load(&base, 1);
        let mut validator = Validator::new("note");
        let nothing = ydoc::decode(
            &room
                .transact()
                .encode_state_as_update_v1(&room.transact().state_vector()),
        )
        .unwrap();
        validator.admit(&room, &nothing).unwrap();
        ydoc::steps::take();
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let Ok(decoded) = ydoc::decode(&update) else {
                return None;
            };
            let admitted = validator.admit(&room, &decoded);
            if let Ok(Admission::Accepted) = admitted {
                room.transact_mut().apply_update(decoded).ok();
                let _ = notes::limits::measure(&room.transact());
                let _ = plate::project(&room.transact());
            }
            Some(admitted.ok())
        }));
        let steps = ydoc::steps::take().total();
        let replay = || format!("case {case} (seed {seed}): {update:02x?}");
        match outcome {
            Err(_) => panic!("panicked on {}", replay()),
            Ok(Some(Some(Admission::Accepted))) => accepted += 1,
            Ok(Some(Some(Admission::Unheld))) => unheld += 1,
            Ok(_) => refused += 1,
        }
        let bytes = (update.len() + base.len()) as u64;
        // Admission walks the structs of a decoded update (up to the first a
        // check refuses): a case with structs counts at least one step.
        if ydoc::decode(&update).is_ok_and(|decoded| decoded.blocks().next().is_some()) {
            assert!(steps > 0, "no steps on {}", replay());
        }
        most = most.max(steps * 1_000 / bytes);
        assert!(
            steps <= STEPS_PER_BYTE * bytes,
            "{steps} steps on {}",
            replay()
        );
    }
    eprintln!(
        "{cases} cases: {accepted} accepted, {unheld} unheld, {refused} refused; at most {most} steps per KB"
    );
}
