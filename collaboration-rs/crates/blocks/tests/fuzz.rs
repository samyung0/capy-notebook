#![allow(clippy::unwrap_used)]
//! Seeded concurrent fuzz: several replicas move, delete, nest and type at
//! once, exchange their updates, and each repairs on entry. Every replica must
//! then pass the check with the same projection, before and after the repairs
//! are exchanged. Some notes start with a deep list and some moves nest under
//! the deepest block, so concurrent nesting past the cap (D18) is repaired
//! too. BLOCKS_CASES and BLOCKS_SEED run more or other cases.

mod common;

use serde_json::{Value, json};
use yrs::{Any, Map, Out, Text, Transact, TransactionMut};

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

/// Content blocks reachable from the note, depth first.
fn reachable(txn: &impl yrs::ReadTxn) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = common::child_ids(txn, blocks::NOTE_ID);
    stack.reverse();
    while let Some(id) = stack.pop() {
        let mut children = common::child_ids(txn, &id);
        children.reverse();
        stack.extend(children);
        out.push(id);
    }
    out
}

/// The reachable block with the most ancestors (the first one, in document
/// order).
fn deepest(txn: &impl yrs::ReadTxn) -> Option<String> {
    let mut best: Option<(usize, String)> = None;
    let mut stack: Vec<(String, usize)> = common::child_ids(txn, blocks::NOTE_ID)
        .into_iter()
        .rev()
        .map(|id| (id, 1))
        .collect();
    while let Some((id, level)) = stack.pop() {
        if best.as_ref().is_none_or(|(deepest, _)| level > *deepest) {
            best = Some((level, id.clone()));
        }
        stack.extend(
            common::child_ids(txn, &id)
                .into_iter()
                .rev()
                .map(|child| (child, level + 1)),
        );
    }
    best.map(|(_, id)| id)
}

fn descendants(txn: &impl yrs::ReadTxn, id: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![id.to_string()];
    while let Some(id) = stack.pop() {
        let children = common::child_ids(txn, &id);
        out.extend(children.iter().cloned());
        stack.extend(children);
    }
    out
}

fn edit(txn: &mut TransactionMut, rng: &mut Rng) {
    let ids = reachable(txn);
    if ids.is_empty() {
        return;
    }
    let id = ids[rng.below(ids.len())].clone();
    match rng.below(5) {
        // Move under the note or another text block, never into itself.
        0 | 1 => {
            let below = descendants(txn, &id);
            let mut targets: Vec<String> = ids
                .iter()
                .filter(|t| **t != id && !below.contains(t))
                .cloned()
                .collect();
            targets.push(blocks::NOTE_ID.into());
            let to = targets[rng.below(targets.len())].clone();
            common::move_block(txn, &id, &to, rng.below(4) as u32);
        }
        2 => common::delete_block(txn, &id),
        // Nest under the deepest block, as an indent there does.
        3 => {
            let Some(to) = deepest(txn) else { return };
            if to != id && !descendants(txn, &id).contains(&to) {
                common::move_block(txn, &id, &to, 0);
            }
        }
        _ => {
            let Some(Out::YMap(block)) = common::blocks_map(txn).get(txn, &id) else {
                return;
            };
            let Some(Out::YText(text)) = block.get(txn, "prop:text") else {
                return;
            };
            let at = rng.below(text.len(txn) as usize + 1) as u32;
            let bold = rng.below(2) == 0;
            let attrs = if bold {
                yrs::types::Attrs::from([("bold".into(), Any::Bool(true))])
            } else {
                yrs::types::Attrs::new()
            };
            text.insert_with_attributes(txn, at, "x", attrs);
        }
    }
}

fn seed_value(rng: &mut Rng) -> Vec<Value> {
    // Half the notes open on a list as deep as the cap allows, or one level
    // short of it.
    let chain = if rng.below(2) == 0 {
        blocks::MAX_NESTING - rng.below(2)
    } else {
        0
    };
    let mut value: Vec<Value> = (1..=chain)
        .map(|indent| {
            json!({"id": format!("d{indent}"), "type": "p", "indent": indent, "listStyleType": "disc", "children": [{"text": format!("D{indent}")}]})
        })
        .collect();
    value.extend((0..4 + rng.below(6)).map(|i| {
            let indent = 1 + rng.below(3);
            match rng.below(3) {
                0 => json!({"id": format!("b{i}"), "type": "p", "children": [{"text": format!("P{i}")}]}),
                1 => json!({"id": format!("b{i}"), "type": "p", "indent": indent, "listStyleType": "disc", "children": [{"text": format!("L{i}")}]}),
                _ => json!({"id": format!("b{i}"), "type": "p", "indent": indent, "children": [{"text": format!("C{i}")}]}),
            }
    }));
    value
}

fn projections(docs: &[yrs::Doc]) -> Vec<Vec<Value>> {
    docs.iter()
        .map(|doc| {
            let txn = doc.transact();
            if let Err(violation) = blocks::check(&txn) {
                panic!("check failed: {violation}");
            }
            blocks::value(&txn).unwrap()
        })
        .collect()
}

#[test]
fn concurrent_moves_deletes_and_typing_repair_to_one_tree() {
    let cases: u64 = std::env::var("BLOCKS_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300);
    let seed: u64 = std::env::var("BLOCKS_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0x5eed_b10c);
    let (mut repaired, mut too_deep) = (0, 0);
    for case in 0..cases {
        let mut rng = Rng(seed ^ (case + 1).wrapping_mul(0x9e37_79b9_7f4a_7c15));
        let value = seed_value(&mut rng);
        let state = blocks::state_from_value(&value, 1).unwrap();
        let replicas = 2 + rng.below(3);
        let docs: Vec<yrs::Doc> = (0..replicas)
            .map(|r| common::doc(&state, 100 + r as u64 * 7))
            .collect();
        for _round in 0..1 + rng.below(3) {
            for doc in &docs {
                for _ in 0..1 + rng.below(4) {
                    edit(&mut doc.transact_mut(), &mut rng);
                }
            }
            common::sync(&docs);
            for doc in &docs {
                let repairs = blocks::repair(&mut doc.transact_mut());
                repaired += usize::from(!repairs.is_empty());
                too_deep += repairs
                    .iter()
                    .filter(|r| matches!(r, blocks::Repair::TooDeep { .. }))
                    .count();
            }
            let views = projections(&docs);
            assert!(
                views.windows(2).all(|w| w[0] == w[1]),
                "case {case} (seed {seed}): replicas differ after repair"
            );
            // The repairs meet: a second pass settles duplicate re-attaches.
            common::sync(&docs);
            for doc in &docs {
                blocks::repair(&mut doc.transact_mut());
            }
            common::sync(&docs);
            let views = projections(&docs);
            assert!(
                views.windows(2).all(|w| w[0] == w[1]),
                "case {case} (seed {seed}): replicas differ after exchange"
            );
        }
    }
    eprintln!("fuzz: {cases} cases, {repaired} repairs written, {too_deep} blocks moved up");
    assert!(too_deep > 0, "no case nested past the cap");
}
