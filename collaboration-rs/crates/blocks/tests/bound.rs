#![allow(clippy::unwrap_used)]
//! The growth bound of a blocks room (`blocks::bound`): for typing, never
//! below the exact growth of the projection's measure; for anything else,
//! `None`.

mod common;

use serde_json::{Value, json};
use yrs::{Any, Map, Out, ReadTxn, StateVector, Text, TextRef, Transact};

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
        (self.next() % n.max(1) as u64) as usize
    }
}

/// Every text prop of a block: (block id, prop key).
fn texts(txn: &impl ReadTxn) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let blocks = common::blocks_map(txn);
    for (id, block) in blocks.iter(txn) {
        let Out::YMap(block) = block else { continue };
        for (key, value) in block.iter(txn) {
            if matches!(value, Out::YText(_)) {
                out.push((id.to_string(), key.to_string()));
            }
        }
    }
    out.sort();
    out
}

fn text(txn: &impl ReadTxn, id: &str, key: &str) -> TextRef {
    let Some(Out::YMap(block)) = common::blocks_map(txn).get(txn, id) else {
        panic!("no block {id}")
    };
    let Some(Out::YText(text)) = block.get(txn, key) else {
        panic!("no text {key} on {id}")
    };
    text
}

fn metrics(doc: &yrs::Doc) -> notes::limits::Metrics {
    notes::limits::measure_value(&blocks::value(&doc.transact()).unwrap())
}

/// `edit` made on a writer holding `state`, as an update.
fn update_of(state: &[u8], edit: impl FnOnce(&mut yrs::TransactionMut)) -> Vec<u8> {
    let writer = common::doc(state, 77);
    let before = writer.transact().state_vector();
    edit(&mut writer.transact_mut());
    writer.transact().encode_state_as_update_v1(&before)
}

fn growth(state: &[u8], update: &[u8]) -> Option<blocks::bound::Growth> {
    let room = common::doc(state, 1);
    let update = ydoc::decode(update).unwrap();
    let txn = room.transact();
    blocks::bound::growth(&txn, &ydoc::Incoming::new(&update), &blocks::Tree::of(&txn))
}

fn every_block() -> Vec<Value> {
    let mut value = common::every_block_note();
    for node in &mut value {
        if let Some(node) = node.as_object_mut() {
            node.remove("pending");
        }
    }
    value
}

const TYPED: &[&str] = &["x", "ab", "\n", "a\nb", "😀", "\"q\"\\", "\u{1}"];

/// Random typing (strings typed anywhere in any text, ranges deleted) into
/// the every-block note and the corpus's small notes: the bound, when it
/// gives one, is never below the exact growth of bytes and nodes, nor of
/// depth past one level below the room's deepest leaf. Fails if the bound
/// undercounts any edit, or gives up on most of them.
#[test]
fn the_bound_covers_the_exact_growth_of_typing() {
    let mut values = vec![every_block()];
    values.extend(
        common::bootstrap()
            .iter()
            .filter(|case| case["name"] != "load-note")
            .map(|case| case["value"].as_array().unwrap().clone()),
    );
    let mut rng = Rng(0x5eed_b0d5);
    let (mut bounded, mut edits) = (0, 0);
    for value in &values {
        let Ok(state) = blocks::state_from_value(value, 3) else {
            continue;
        };
        let room = common::doc(&state, 1);
        let before = metrics(&room);
        let props = texts(&room.transact());
        for _ in 0..60 {
            let (id, key) = &props[rng.below(props.len())];
            let len = text(&room.transact(), id, key).len(&room.transact());
            let typed = TYPED[rng.below(TYPED.len())];
            let at = rng.below(len as usize + 1) as u32;
            let delete = rng.below(4) == 0 && len > 0;
            let count = 1 + rng.below(3) as u32;
            let update = update_of(&state, |txn| {
                let text = text(txn, id, key);
                if delete {
                    let at = at.min(len - 1);
                    text.remove_range(txn, at, count.min(len - at));
                } else {
                    text.insert(txn, at, typed);
                }
            });
            edits += 1;
            let Some(growth) = growth(&state, &update) else {
                continue;
            };
            bounded += 1;
            let after = common::doc(&state, 1);
            common::apply(&after, &update);
            blocks::check(&after.transact()).unwrap();
            let exact = metrics(&after);
            let at = format!("{id} {key}: {typed:?} at {at} (delete {delete})");
            assert!(
                exact.content_bytes <= before.content_bytes + growth.bytes,
                "{at}: {} bytes past the bound",
                exact.content_bytes - before.content_bytes - growth.bytes
            );
            assert!(
                exact.node_count <= before.node_count + growth.nodes,
                "{at}: nodes"
            );
            let depth = if growth.typed {
                before.max_depth + 1
            } else {
                before.max_depth
            };
            assert!(exact.max_depth <= depth, "{at}: depth");
        }
    }
    eprintln!("bound: {bounded} of {edits} typing edits bounded");
    assert!(bounded * 10 >= edits * 9, "{bounded} of {edits} bounded");
}

fn three_paragraphs() -> Vec<u8> {
    let value = json!([
        {"id": "a", "type": "p", "children": [{"text": "A"}]},
        {"id": "b", "type": "p", "children": [{"text": "B"}]},
        {"id": "m", "type": "mermaid", "source": "flowchart LR", "children": [
            {"type": "mermaid_caption", "children": [{"text": "Cap"}]},
        ]},
    ]);
    blocks::state_from_value(value.as_array().unwrap(), 1).unwrap()
}

/// A Mermaid source and an embed in a text are checked exactly; a format, a
/// move, a prop write and a delete are bounded with the top-level elements
/// they rewrite (`structure.rs` walks the rest). Typing into a text holding
/// a format value no visible char shows (a zero-width link) is checked
/// exactly too: the store never took that value. Fails if a source or an
/// embed is bounded, or a plain format or structural edit is not.
#[test]
fn sources_and_embeds_are_unbounded() {
    let state = three_paragraphs();
    let source = update_of(&state, |txn| {
        text(txn, "m", "prop:source").insert(txn, 0, "x");
    });
    let embed = update_of(&state, |txn| {
        text(txn, "a", "prop:text").insert_embed(txn, 0, Any::from("x"));
    });
    for (name, update) in [("source", source), ("embed", embed)] {
        assert_eq!(growth(&state, &update), None, "{name}");
    }
    let bold = update_of(&state, |txn| {
        let text = text(txn, "a", "prop:text");
        text.format(txn, 0, 1, [("bold".into(), Any::Bool(true))].into());
    });
    let moved = update_of(&state, |txn| common::move_block(txn, "b", "a", 0));
    let prop = update_of(&state, |txn| {
        let Some(Out::YMap(block)) = common::blocks_map(txn).get(txn, "a") else {
            panic!()
        };
        block.insert(txn, "prop:type", "h1");
    });
    let deleted = update_of(&state, |txn| common::delete_block(txn, "b"));
    for (name, update, before, after) in [
        ("format", bold, 1, 1),
        ("move", moved, 1, 1),
        ("prop", prop, 1, 1),
        ("delete", deleted, 1, 0),
    ] {
        let growth = growth(&state, &update).unwrap_or_else(|| panic!("{name}"));
        assert_eq!(
            (growth.before.len(), growth.after.len()),
            (before, after),
            "{name}"
        );
    }

    // A link typed and deleted leaves its format items around nothing.
    let room = common::doc(&state, 1);
    {
        let mut txn = room.transact_mut();
        let text = text(&txn, "a", "prop:text");
        let link = [("link".into(), Any::from("javascript:void(0)"))].into();
        text.insert_with_attributes(&mut txn, 1, "zz", link);
    }
    {
        let mut txn = room.transact_mut();
        text(&txn, "a", "prop:text").remove_range(&mut txn, 1, 2);
    }
    let zero_width = room
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let typed = update_of(&zero_width, |txn| {
        text(txn, "a", "prop:text").insert(txn, 0, "x");
    });
    assert_eq!(growth(&zero_width, &typed), None, "zero-width link");
    let other = update_of(&zero_width, |txn| {
        text(txn, "b", "prop:text").insert(txn, 0, "x");
    });
    assert!(growth(&zero_width, &other).is_some(), "another text");
}

/// A keystroke into the mermaid caption, the page title and a paragraph is
/// bounded, and a deleted range adds nothing.
#[test]
fn typing_is_bounded() {
    let state = three_paragraphs();
    for (id, key) in [
        ("a", "prop:text"),
        ("m", "prop:caption"),
        ("root", "prop:title"),
    ] {
        let update = update_of(&state, |txn| text(txn, id, key).insert(txn, 0, "x"));
        let growth = growth(&state, &update).unwrap_or_else(|| panic!("{id} {key}"));
        assert!(growth.typed && growth.bytes > 0, "{id} {key}");
    }
    let update = update_of(&state, |txn| {
        text(txn, "a", "prop:text").remove_range(txn, 0, 1);
    });
    assert_eq!(
        growth(&state, &update),
        Some(blocks::bound::Growth::default())
    );
}

/// A string typed inside an inline equation's run becomes one equation per
/// UTF-16 unit, each carrying the run's expression: bounded, and the bound
/// covers it. Fails if the bound prices the string as text alone.
#[test]
fn typing_inside_an_inline_equation_is_priced_per_unit() {
    let tex = "x^2".repeat(60);
    let equation =
        json!({"type": "inline_equation", "texExpression": tex, "children": [{"text": ""}]});
    let value = json!([{"id": "a", "type": "p", "children": [
        {"text": "a"}, equation, {"text": ""}, equation, {"text": "b"},
    ]}]);
    let state = blocks::state_from_value(value.as_array().unwrap(), 1).unwrap();
    let update = update_of(&state, |txn| {
        text(txn, "a", "prop:text").insert(txn, 2, "xyz")
    });
    let growth = growth(&state, &update).unwrap();
    let room = common::doc(&state, 1);
    let before = metrics(&room);
    common::apply(&room, &update);
    let projected = blocks::value(&room.transact()).unwrap();
    let equations = projected[0]["children"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|node| node["type"] == "inline_equation")
        .count();
    assert_eq!(equations, 5);
    let exact = metrics(&room);
    assert!(exact.content_bytes <= before.content_bytes + growth.bytes);
    assert!(exact.node_count <= before.node_count + growth.nodes);
}
