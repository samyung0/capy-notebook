#![allow(clippy::unwrap_used)]
//! The structural growth bound (`blocks::bound` with `structure.rs`) against
//! the exact path, update by update: seeded walks of BlockSuite's edits
//! (Enter, merge, deletes, moves in and out of columns, callouts and lists,
//! indent, outdent, pastes of 1–150 blocks, table rows and cells, prop
//! writes, typing, some edits a broken client would send, and offline
//! batches of them sent as one update) over the
//! every-block note and the near-limit load note, by one to four replicas
//! whose updates reach the room in a shuffled order.
//!
//! Every update runs through both: the bound (with the room's parent index,
//! the store's canonical check on the elements it gives and the limits, as
//! `BlocksValidator::next_bound` does) and the exact path (a copy, the
//! repair, the structural check, the projection, the canonical check, the
//! measure). When the bound admits, the exact path must admit with no
//! repair to make, its metrics must not exceed the bound's, a structural
//! update without typing must move the metrics by exactly what the bound
//! says, and the index the bound moved along must equal the room's.
//!
//! Seeds: `BLOCKS_BOUND_SEEDS` (40) from `BLOCKS_BOUND_FIRST_SEED` (1); a
//! failing seed prints its steps and becomes a named test below.

mod common;

use std::collections::{BTreeMap, HashMap, HashSet};

use notes::limits::Metrics;
use serde_json::Value;
use yrs::types::Attrs;
use yrs::types::text::YChange;
use yrs::{
    Any, Array, ArrayPrelim, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, Text, TextPrelim, TextRef,
    Transact, TransactionMut,
};

use blocks::schema::{
    CALLOUT, CODE, COLUMN, COLUMNS, DIVIDER, HTML, IMAGE, LIST, NOTE, PARAGRAPH, TABLE,
};

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

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        (!items.is_empty()).then(|| &items[self.below(items.len())])
    }
}

// ------------------------------------------------------------------ notes

/// The every-block note as a room may serve it: its reference names a row.
fn every_block() -> Vec<Value> {
    let mut value = common::every_block_note();
    for node in &mut value {
        if let Some(node) = node.as_object_mut() {
            node.remove("pending");
            if node.get("type").and_then(Value::as_str) == Some("material_ref") {
                node.insert("materialId".into(), "mat_quiz".into());
            }
        }
    }
    value
}

fn load_note() -> Vec<Value> {
    common::bootstrap()
        .into_iter()
        .find(|case| case["name"] == "load-note")
        .unwrap()["value"]
        .as_array()
        .unwrap()
        .clone()
}

// ------------------------------------------------------------- doc reads

fn block(txn: &impl ReadTxn, id: &str) -> Option<MapRef> {
    match common::blocks_map(txn).get(txn, id) {
        Some(Out::YMap(map)) => Some(map),
        _ => None,
    }
}

fn flavour(txn: &impl ReadTxn, id: &str) -> String {
    block(txn, id)
        .and_then(|map| map.get(txn, "sys:flavour"))
        .map(|f| f.to_string(txn))
        .unwrap_or_default()
}

fn prop_text(txn: &impl ReadTxn, id: &str, key: &str) -> Option<TextRef> {
    match block(txn, id)?.get(txn, key) {
        Some(Out::YText(text)) => Some(text),
        _ => None,
    }
}

/// Every block below the note, depth first, with its parent, each once: a
/// writer's own doc may hold a block listed twice or a cycle until the
/// room's repair reaches it.
fn walk(txn: &impl ReadTxn) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut stack: Vec<(String, String)> = common::child_ids(txn, blocks::NOTE_ID)
        .into_iter()
        .rev()
        .map(|id| (id, blocks::NOTE_ID.to_string()))
        .collect();
    while let Some((id, parent)) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        if block(txn, &id).is_some() {
            stack.extend(
                common::child_ids(txn, &id)
                    .into_iter()
                    .rev()
                    .map(|child| (child, id.clone())),
            );
        }
        out.push((id, parent));
    }
    out
}

/// `id` and every block below it, each once.
fn subtree(txn: &impl ReadTxn, id: &str) -> Vec<String> {
    let mut out = vec![id.to_string()];
    let mut seen = HashSet::from([id.to_string()]);
    let mut at = 0;
    while at < out.len() {
        if block(txn, &out[at]).is_some() {
            for child in common::child_ids(txn, &out[at]) {
                if seen.insert(child.clone()) {
                    out.push(child);
                }
            }
        }
        at += 1;
    }
    out
}

fn index_in(txn: &impl ReadTxn, parent: &str, id: &str) -> Option<u32> {
    common::child_ids(txn, parent)
        .iter()
        .position(|c| c == id)
        .map(|i| i as u32)
}

/// A text's runs: string and attributes.
fn runs(txn: &impl ReadTxn, text: &TextRef) -> Vec<(String, Attrs)> {
    text.diff(txn, YChange::identity)
        .into_iter()
        .filter_map(|diff| match diff.insert {
            Out::Any(Any::String(s)) => Some((
                s.to_string(),
                diff.attributes.map(|a| *a).unwrap_or_default(),
            )),
            _ => None,
        })
        .collect()
}

// ------------------------------------------------------------- doc writes

fn unlist(txn: &mut TransactionMut, parent: &str, id: &str) {
    if let Some(at) = index_in(txn, parent, id) {
        common::children(txn, parent).remove(txn, at);
    }
}

fn list(txn: &mut TransactionMut, parent: &str, id: &str, index: u32) {
    let children = common::children(txn, parent);
    let index = index.min(children.len(txn));
    children.insert(txn, index, Any::from(id));
}

/// BlockSuite's delete: out of its parent, then it and its subtree.
fn delete(txn: &mut TransactionMut, parent: &str, id: &str) {
    unlist(txn, parent, id);
    for id in subtree(txn, id) {
        common::blocks_map(txn).remove(txn, &id);
    }
}

/// A block as BlockSuite's `addBlock` writes it, listed under `parent`.
fn add(
    txn: &mut TransactionMut,
    id: &str,
    flavour: &str,
    props: &[(&str, Any)],
    text: Option<&[(String, Attrs)]>,
    parent: &str,
    index: u32,
) {
    let map = common::blocks_map(txn).insert(txn, id, MapPrelim::default());
    map.insert(txn, "sys:flavour", flavour);
    map.insert(txn, "sys:children", ArrayPrelim::default());
    for (key, value) in props {
        map.insert(txn, format!("prop:{key}"), value.clone());
    }
    if flavour == CALLOUT {
        let icon = map.insert(txn, "prop:icon", MapPrelim::default());
        icon.insert(txn, "type", "emoji");
        icon.insert(txn, "unicode", "\u{1f4a1}");
    }
    if let Some(runs) = text {
        let y = map.insert(txn, "prop:text", TextPrelim::new(""));
        for (s, attrs) in runs {
            let at = y.len(txn);
            y.insert_with_attributes(txn, at, s, attrs.clone());
        }
    }
    list(txn, parent, id, index);
}

fn paragraph_props(kind: &str) -> Vec<(&'static str, Any)> {
    vec![("type", Any::from(kind)), ("collapsed", Any::Bool(false))]
}

fn list_props(kind: &str) -> Vec<(&'static str, Any)> {
    vec![
        ("type", Any::from(kind)),
        ("checked", Any::Bool(false)),
        ("collapsed", Any::Bool(false)),
        ("order", Any::Null),
    ]
}

fn image_props(source: &str) -> Vec<(&'static str, Any)> {
    vec![
        ("caption", Any::from("")),
        ("sourceId", Any::from(source)),
        ("width", Any::Number(0.0)),
        ("height", Any::Number(0.0)),
        ("index", Any::from("a0")),
        ("xywh", Any::from("[0,0,0,0]")),
        ("lockedBySelf", Any::Bool(false)),
        ("rotate", Any::Number(0.0)),
        ("size", Any::Number(-1.0)),
    ]
}

fn attrs(rng: &mut Rng) -> Attrs {
    match rng.below(8) {
        0 => Attrs::from([("bold".into(), Any::Bool(true))]),
        1 => Attrs::from([("italic".into(), Any::Bool(true))]),
        2 => Attrs::from([("link".into(), Any::from("https://example.com/a"))]),
        _ => Attrs::new(),
    }
}

fn words(rng: &mut Rng, max: usize) -> String {
    const WORDS: &[&str] = &["tide", "marsh", "salt", "a", "the", "estuary", "\"q\"", "x"];
    (0..1 + rng.below(max))
        .map(|_| WORDS[rng.below(WORDS.len())])
        .collect::<Vec<_>>()
        .join(" ")
}

/// One replica: its document and the ids it makes.
struct Writer {
    doc: Doc,
    client: u64,
    made: u64,
}

impl Writer {
    fn new(state: &[u8], client: u64) -> Writer {
        Writer {
            doc: common::doc(state, client),
            client,
            made: 0,
        }
    }

    fn fresh_id(&mut self) -> String {
        self.made += 1;
        format!("w{}n{}", self.client, self.made)
    }
}

/// Text blocks a caret can sit in.
fn texts(txn: &impl ReadTxn, blocks: &[(String, String)]) -> Vec<String> {
    blocks
        .iter()
        .filter(|(id, _)| matches!(flavour(txn, id).as_str(), PARAGRAPH | LIST | CODE | CALLOUT))
        .map(|(id, _)| id.clone())
        .collect()
}

fn holds_indent(flavour: &str) -> bool {
    flavour == PARAGRAPH || flavour == LIST
}

/// One edit on `w`'s document, as its update, with the op's name.
fn edit(w: &mut Writer, rng: &mut Rng) -> Option<(&'static str, Vec<u8>)> {
    let doc = w.doc.clone();
    let before = doc.transact().state_vector();
    let op = {
        let mut txn = doc.transact_mut();
        edit_in(&mut txn, w, rng)?
    };
    let update = doc.transact().encode_state_as_update_v1(&before);
    (update.len() > 2).then_some((op, update))
}

fn edit_in(txn: &mut TransactionMut, w: &mut Writer, rng: &mut Rng) -> Option<&'static str> {
    let all = walk(txn);
    let ids: Vec<String> = all.iter().map(|(id, _)| id.clone()).collect();
    let parent_of: HashMap<String, String> = all.iter().cloned().collect();
    let roll = rng.below(100);
    Some(match roll {
        // Typing, some of it formatted.
        0..=14 => {
            let id = rng.pick(&texts(txn, &all))?.clone();
            let text = prop_text(txn, &id, "prop:text")?;
            let at = rng.below(text.len(txn) as usize + 1) as u32;
            let typed = words(rng, 2);
            if rng.chance(15) {
                let attrs = attrs(rng);
                text.insert_with_attributes(txn, at, &typed, attrs);
                "format"
            } else {
                text.insert(txn, at, &typed);
                "type"
            }
        }
        // Enter: the text after the caret into a new block after it, with
        // the block's children when it has some.
        15..=26 => {
            let candidates: Vec<String> = all
                .iter()
                .filter(|(id, _)| holds_indent(&flavour(txn, id)))
                .map(|(id, _)| id.clone())
                .collect();
            let id = rng.pick(&candidates)?.clone();
            let parent = parent_of[&id].clone();
            let kind = flavour(txn, &id);
            let text = prop_text(txn, &id, "prop:text")?;
            let len = text.len(txn);
            let at = rng.below(len as usize + 1) as u32;
            let mut tail = Vec::new();
            let mut offset = 0u32;
            for (s, attrs) in runs(txn, &text) {
                let units = s.encode_utf16().count() as u32;
                if offset + units > at {
                    let skip = at.saturating_sub(offset) as usize;
                    let rest: String =
                        String::from_utf16_lossy(&s.encode_utf16().collect::<Vec<_>>()[skip..]);
                    tail.push((rest, attrs));
                }
                offset += units;
            }
            text.remove_range(txn, at, len - at);
            let new = w.fresh_id();
            let props = if kind == LIST {
                list_props("bulleted")
            } else {
                paragraph_props("text")
            };
            let index = index_in(txn, &parent, &id).unwrap_or(0) + 1;
            add(txn, &new, &kind, &props, Some(&tail), &parent, index);
            if rng.chance(50) {
                for child in common::child_ids(txn, &id) {
                    unlist(txn, &id, &child);
                    list(txn, &new, &child, u32::MAX);
                }
            }
            "enter"
        }
        // Backspace at a block's start: its text joins the block before,
        // its children follow, and it goes.
        27..=33 => {
            let candidates: Vec<(String, String)> = all
                .iter()
                .filter(|(id, parent)| {
                    holds_indent(&flavour(txn, id))
                        && index_in(txn, parent, id).is_some_and(|i| i > 0)
                })
                .cloned()
                .collect();
            let (id, parent) = rng.pick(&candidates)?.clone();
            let at = index_in(txn, &parent, &id)?;
            let previous = common::child_ids(txn, &parent)[at as usize - 1].clone();
            if !holds_indent(&flavour(txn, &previous)) {
                return None;
            }
            let into = prop_text(txn, &previous, "prop:text")?;
            for (s, attrs) in runs(txn, &prop_text(txn, &id, "prop:text")?) {
                let end = into.len(txn);
                into.insert_with_attributes(txn, end, &s, attrs);
            }
            for child in common::child_ids(txn, &id) {
                unlist(txn, &id, &child);
                list(txn, &previous, &child, u32::MAX);
            }
            delete(txn, &parent, &id);
            "merge"
        }
        // A block, or a run of siblings, deleted.
        34..=43 => {
            let (id, parent) = rng.pick(&all)?.clone();
            if rng.chance(30) {
                let siblings = common::child_ids(txn, &parent);
                let from = index_in(txn, &parent, &id)? as usize;
                let to = (from + 1 + rng.below(4)).min(siblings.len());
                for sibling in &siblings[from..to] {
                    delete(txn, &parent, sibling);
                }
                "delete-range"
            } else {
                delete(txn, &parent, &id);
                "delete"
            }
        }
        // A move: within its parent, to another, into or out of a column, a
        // callout or a list; now and then where its flavour may not sit.
        44..=58 => {
            let (id, parent) = rng.pick(&all)?.clone();
            let inside = subtree(txn, &id);
            let containers: Vec<String> = std::iter::once(blocks::NOTE_ID.to_string())
                .chain(ids.iter().cloned())
                .filter(|t| !inside.contains(t))
                .filter(|t| {
                    let f = flavour(txn, t);
                    rng.chance(4)
                        || matches!(f.as_str(), NOTE | PARAGRAPH | LIST | CALLOUT | COLUMN)
                })
                .collect();
            let to = if rng.chance(30) {
                parent.clone()
            } else {
                rng.pick(&containers)?.clone()
            };
            if to == parent && rng.chance(3) {
                // Listed a second time, as a broken client would.
                let index = rng.below(5) as u32;
                list(txn, &to, &id, index);
                return Some("list-twice");
            }
            unlist(txn, &parent, &id);
            let index = rng.below(common::child_ids(txn, &to).len() + 1) as u32;
            list(txn, &to, &id, index);
            "move"
        }
        // Indent under the sibling before; outdent after the parent, taking
        // the siblings after along as children.
        59..=68 => {
            let (id, parent) = rng.pick(&all)?.clone();
            if rng.chance(50) {
                let at = index_in(txn, &parent, &id)?;
                if at == 0 {
                    return None;
                }
                let previous = common::child_ids(txn, &parent)[at as usize - 1].clone();
                unlist(txn, &parent, &id);
                list(txn, &previous, &id, u32::MAX);
                "indent"
            } else {
                if parent == blocks::NOTE_ID || !holds_indent(&flavour(txn, &parent)) {
                    return None;
                }
                let grand = parent_of.get(&parent)?.clone();
                let at = index_in(txn, &parent, &id)? as usize;
                let after: Vec<String> = common::child_ids(txn, &parent)[at + 1..].to_vec();
                unlist(txn, &parent, &id);
                for sibling in &after {
                    unlist(txn, &parent, sibling);
                    list(txn, &id, sibling, u32::MAX);
                }
                let index = index_in(txn, &grand, &parent)? + 1;
                list(txn, &grand, &id, index);
                "outdent"
            }
        }
        // A paste of 1 to 150 blocks: paragraphs and lists (some nested,
        // some formatted), now and then a code block, a divider, a callout,
        // an image, a column group or an HTML embed.
        69..=78 => {
            let targets: Vec<String> = std::iter::once(blocks::NOTE_ID.to_string())
                .chain(
                    ids.iter()
                        .filter(|t| matches!(flavour(txn, t).as_str(), PARAGRAPH | LIST | COLUMN))
                        .cloned(),
                )
                .collect();
            let to = rng.pick(&targets)?.clone();
            let count = if rng.chance(10) {
                150
            } else {
                1 + rng.below(12)
            };
            let mut index = rng.below(common::child_ids(txn, &to).len() + 1) as u32;
            let mut last: Option<String> = None;
            for _ in 0..count {
                let id = w.fresh_id();
                let text = vec![(words(rng, 6), attrs(rng))];
                let (parent, at) = match &last {
                    Some(previous) if rng.chance(20) => (previous.clone(), 0),
                    _ => {
                        index += 1;
                        (to.clone(), index - 1)
                    }
                };
                let in_column = flavour(txn, &parent) == COLUMN;
                let at_note = parent == blocks::NOTE_ID;
                match rng.below(20) {
                    0 if in_column || at_note => add(
                        txn,
                        &id,
                        CODE,
                        &[
                            ("language", Any::Null),
                            ("wrap", Any::Bool(false)),
                            ("caption", Any::from("")),
                        ],
                        Some(&text),
                        &parent,
                        at,
                    ),
                    1 if in_column || at_note => add(txn, &id, DIVIDER, &[], None, &parent, at),
                    2 if in_column || at_note => {
                        add(
                            txn,
                            &id,
                            CALLOUT,
                            &[("backgroundColorName", Any::from("grey"))],
                            Some(&[]),
                            &parent,
                            at,
                        );
                        let inner = w.fresh_id();
                        add(
                            txn,
                            &inner,
                            PARAGRAPH,
                            &paragraph_props("text"),
                            Some(&text),
                            &id,
                            0,
                        );
                    }
                    3 if in_column || at_note => {
                        let source = if rng.chance(50) { "" } else { "asset_pasted" };
                        add(txn, &id, IMAGE, &image_props(source), None, &parent, at)
                    }
                    4 if at_note => {
                        add(txn, &id, COLUMNS, &[], None, &parent, at);
                        for side in 0..2 {
                            let column = w.fresh_id();
                            add(
                                txn,
                                &column,
                                COLUMN,
                                &[("width", Any::from("50%"))],
                                None,
                                &id,
                                side,
                            );
                            let inner = w.fresh_id();
                            add(
                                txn,
                                &inner,
                                PARAGRAPH,
                                &paragraph_props("text"),
                                Some(&text),
                                &column,
                                0,
                            );
                        }
                    }
                    5 if at_note && rng.chance(20) => add(
                        txn,
                        &id,
                        HTML,
                        &[("html", Any::from("<b>x</b>")), ("caption", Any::from(""))],
                        None,
                        &parent,
                        at,
                    ),
                    6..=9 => add(
                        txn,
                        &id,
                        LIST,
                        &list_props(["bulleted", "numbered", "todo"][rng.below(3)]),
                        Some(&text),
                        &parent,
                        at,
                    ),
                    _ => add(
                        txn,
                        &id,
                        PARAGRAPH,
                        &paragraph_props(["text", "h1", "h2", "quote"][rng.below(4)]),
                        Some(&text),
                        &parent,
                        at,
                    ),
                }
                if holds_indent(&flavour(txn, &id)) {
                    last = Some(id);
                }
            }
            "paste"
        }
        // A table: a row added, a cell typed into, a column resized.
        79..=84 => {
            let tables: Vec<String> = ids
                .iter()
                .filter(|t| flavour(txn, t) == TABLE)
                .cloned()
                .collect();
            let table = rng.pick(&tables)?.clone();
            let map = block(txn, &table)?;
            let keys: Vec<String> = map.keys(txn).map(str::to_string).collect();
            let columns: Vec<String> = keys
                .iter()
                .filter_map(|k| {
                    k.strip_prefix("prop:columns.")?
                        .strip_suffix(".columnId")
                        .map(str::to_string)
                })
                .collect();
            let cells: Vec<String> = keys
                .iter()
                .filter(|k| k.starts_with("prop:cells."))
                .cloned()
                .collect();
            match rng.below(3) {
                0 => {
                    let row = w.fresh_id();
                    map.insert(txn, format!("prop:rows.{row}.rowId"), row.as_str());
                    map.insert(txn, format!("prop:rows.{row}.order"), format!("z{row}"));
                    for column in &columns {
                        let cell = map.insert(
                            txn,
                            format!("prop:cells.{row}:{column}.text"),
                            TextPrelim::new(""),
                        );
                        cell.insert(txn, 0, "cell");
                    }
                    "table-row"
                }
                1 => {
                    let key = rng.pick(&cells)?.clone();
                    let Some(Out::YText(cell)) = map.get(txn, &key) else {
                        return None;
                    };
                    cell.insert(txn, 0, "x");
                    "table-cell"
                }
                _ => {
                    let column = rng.pick(&columns)?.clone();
                    map.insert(
                        txn,
                        format!("prop:columns.{column}.width"),
                        Any::Number(80.0 + rng.below(100) as f64),
                    );
                    "table-width"
                }
            }
        }
        // Prop writes and deletes, valid and not.
        _ => {
            let (id, _) = rng.pick(&all)?.clone();
            let map = block(txn, &id)?;
            let f = flavour(txn, &id);
            let (key, value): (&str, Option<Any>) = match (f.as_str(), rng.below(8)) {
                (LIST, 0) => (
                    "prop:type",
                    Some(Any::from(["bulleted", "numbered", "todo"][rng.below(3)])),
                ),
                (LIST, 1) => ("prop:checked", Some(Any::Bool(rng.chance(50)))),
                (LIST, 2) => (
                    "prop:listStyleType",
                    Some(Any::from(
                        ["disc", "decimal", "upper-roman", "zz"][rng.below(4)],
                    )),
                ),
                (LIST, 3) => ("prop:order", Some(Any::Number(1.0 + rng.below(9) as f64))),
                (PARAGRAPH, 0..=2) => (
                    "prop:type",
                    Some(Any::from(
                        ["text", "h1", "h3", "quote", "bogus"][rng.below(5)],
                    )),
                ),
                (PARAGRAPH | LIST, 4) => (
                    "prop:textAlign",
                    Some(Any::from(["left", "center", "right"][rng.below(3)])),
                ),
                (PARAGRAPH | LIST, 5) => ("prop:textAlign", None),
                (CODE, _) => (
                    "prop:language",
                    Some(Any::from(["rust", "python"][rng.below(2)])),
                ),
                (CALLOUT, _) => (
                    "prop:variant",
                    Some(Any::from(["tip", "warning", "nonsense"][rng.below(3)])),
                ),
                (IMAGE, _) => (
                    "prop:width",
                    Some(Any::Number(100.0 + rng.below(600) as f64)),
                ),
                (COLUMN, _) => (
                    "prop:width",
                    Some(Any::from(["30%", "70%", "wide"][rng.below(3)])),
                ),
                // A broken client: a wrong kind, an unknown key, a default gone.
                (_, 6) => ("prop:collapsed", Some(Any::from("yes"))),
                (_, 7) => ("prop:type", None),
                _ => ("prop:mystery", Some(Any::Bool(true))),
            };
            match value {
                Some(value) => {
                    map.insert(txn, key, value);
                }
                None => {
                    map.remove(txn, key);
                }
            }
            "prop"
        }
    })
}

// ------------------------------------------------------------------ room

/// What the room's admission does with an update: the bound (as
/// `next_bound`) or the exact path.
#[derive(Default)]
struct Stats {
    /// Per op: admitted on the bound, admitted exactly, refused, with no
    /// bound to try (after load or a repair).
    ops: BTreeMap<&'static str, [u64; 4]>,
}

impl Stats {
    fn add(&mut self, other: &Stats) {
        for (op, counts) in &other.ops {
            let mine = self.ops.entry(op).or_default();
            for i in 0..4 {
                mine[i] += counts[i];
            }
        }
    }

    fn structural(&self) -> (u64, u64) {
        self.ops
            .iter()
            .filter(|(op, _)| !matches!(**op, "type" | "table-cell"))
            .fold((0, 0), |(bound, exact), (_, c)| {
                (bound + c[0], exact + c[1])
            })
    }
}

struct Room {
    doc: Doc,
    /// The bound, its tree depth and the parent index, while they hold.
    bound: Option<(Metrics, u32, blocks::Tree)>,
    /// The last exact metrics (the shrink baseline) and the room's now.
    baseline: Metrics,
    exact: Metrics,
}

fn measure(txn: &impl ReadTxn) -> Metrics {
    notes::limits::measure_value(&blocks::value(txn).unwrap())
}

/// `model.rs`'s `slots`.
fn slots(elements: &[Value]) -> Metrics {
    if elements.is_empty() {
        return Metrics::default();
    }
    let envelope = notes::limits::measure_value(&[]).content_bytes;
    let measured = notes::limits::measure_value(elements);
    Metrics {
        content_bytes: measured.content_bytes + 1 - envelope,
        ..measured
    }
}

enum Verdict {
    Bound,
    Exact,
    Refused(String),
}

/// The exact path on a copy: the metrics, whether the tree needed a repair,
/// or the refusal.
fn exact(room: &Doc, update: &[u8], baseline: &Metrics) -> Result<(Metrics, bool), String> {
    let copy = common::doc(&common::state(room), 2);
    common::apply(&copy, update);
    let unrepaired = blocks::check(&copy.transact()).is_err();
    let repairs = blocks::repair(&mut copy.transact_mut());
    let txn = copy.transact();
    blocks::check(&txn).map_err(|v| v.to_string())?;
    let value = blocks::value(&txn).map_err(|e| e.to_string())?;
    notes::material::assert_canonical(&value, "note").map_err(|e| e.to_string())?;
    let metrics = notes::limits::measure_value(&value);
    if notes::limits::limit_code(&metrics).is_some()
        && !notes::limits::recovers(&metrics, Some(baseline))
    {
        return Err("limit".into());
    }
    Ok((metrics, unrepaired || !repairs.is_empty()))
}

impl Room {
    fn new(state: &[u8]) -> Room {
        let doc = common::doc(state, 1);
        let exact = measure(&doc.transact());
        Room {
            doc,
            bound: None,
            baseline: exact,
            exact,
        }
    }

    /// The bound's next metrics, depth and growth, when it admits.
    fn on_bound(&self, update: &yrs::Update) -> Option<(Metrics, u32, blocks::bound::Growth)> {
        let (bound, depth, tree) = self.bound.as_ref()?;
        let txn = self.doc.transact();
        let growth = blocks::bound::growth(&txn, &ydoc::Incoming::new(update), tree)?;
        if !growth.after.is_empty() {
            notes::material::assert_canonical(&growth.after, "note").ok()?;
        }
        let (before, after) = (slots(&growth.before), slots(&growth.after));
        let depth = (*depth).max(after.max_depth);
        let next = Metrics {
            content_bytes: (bound.content_bytes + growth.bytes + after.content_bytes)
                .saturating_sub(before.content_bytes),
            node_count: (bound.node_count + growth.nodes + after.node_count)
                .saturating_sub(before.node_count),
            max_depth: bound.max_depth.max(depth + u32::from(growth.typed)),
        };
        notes::limits::limit_code(&next)
            .is_none()
            .then_some((next, depth, growth))
    }

    fn receive(&mut self, update: &[u8]) -> Result<Verdict, String> {
        let decoded = ydoc::decode(update).unwrap();
        let bounded = self.on_bound(&decoded);
        let exact = exact(&self.doc, update, &self.baseline);
        let Some((next, depth, growth)) = bounded else {
            let (metrics, _) = match exact {
                Ok(exact) => exact,
                Err(why) => return Ok(Verdict::Refused(why)),
            };
            common::apply(&self.doc, update);
            let repairs = blocks::repair(&mut self.doc.transact_mut());
            let txn = self.doc.transact();
            self.exact = measure(&txn);
            self.baseline = metrics;
            // The room's repair writes: the server drops its bound.
            self.bound = repairs
                .is_empty()
                .then(|| (metrics, metrics.max_depth, blocks::Tree::of(&txn)));
            return Ok(Verdict::Exact);
        };
        let (metrics, repaired) =
            exact.map_err(|why| format!("bound admits what the exact path refuses: {why}"))?;
        if repaired {
            return Err("bound admits an update the tree needs repaired after".into());
        }
        let (bound, _, _) = self.bound.as_ref().unwrap();
        if metrics.content_bytes > next.content_bytes
            || metrics.node_count > next.node_count
            || metrics.max_depth > next.max_depth
        {
            return Err(format!("exact {metrics:?} past the bound {next:?}"));
        }
        // Without typing, the elements the bound reads are the whole change
        // (erasing alone it prices at nothing).
        if !growth.typed && !(growth.before.is_empty() && growth.after.is_empty()) {
            let moved = |a: u64, b: u64| a as i64 - b as i64;
            let said = (
                moved(next.content_bytes, bound.content_bytes),
                moved(next.node_count, bound.node_count),
            );
            let did = (
                moved(metrics.content_bytes, self.exact.content_bytes),
                moved(metrics.node_count, self.exact.node_count),
            );
            if said != did {
                return Err(format!(
                    "structure moved the metrics by {did:?}, the bound says {said:?}"
                ));
            }
        }
        common::apply(&self.doc, update);
        let txn = self.doc.transact();
        blocks::check(&txn).map_err(|v| format!("on the bound, then: {v}"))?;
        self.exact = metrics;
        let (_, _, tree) = self.bound.as_mut().unwrap();
        tree.apply(&growth);
        if *tree != blocks::Tree::of(&txn) {
            return Err("the parent index the bound moved along differs from the room's".into());
        }
        self.bound.as_mut().unwrap().0 = next;
        self.bound.as_mut().unwrap().1 = depth;
        Ok(Verdict::Bound)
    }
}

/// One seed: a note, one to four replicas, rounds of local edits whose
/// updates reach the room shuffled, then everyone catches up. `Err` holds
/// the seed's steps up to the failure.
fn run(seed: u64, note: &[Value], rounds: usize) -> Result<Stats, String> {
    let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
    let state = blocks::state_from_value(note, 1).unwrap();
    let mut room = Room::new(&state);
    let replicas = 1 + rng.below(4);
    let mut next_client = 100;
    let mut writers: Vec<Writer> = (0..replicas)
        .map(|_| {
            next_client += 1;
            Writer::new(&state, next_client)
        })
        .collect();
    let mut stats = Stats::default();
    let mut steps: Vec<String> = Vec::new();
    for round in 0..rounds {
        let mut sent: Vec<(usize, &'static str, Vec<u8>)> = Vec::new();
        for (i, w) in writers.iter_mut().enumerate() {
            for _ in 0..1 + rng.below(3) {
                if rng.chance(15) {
                    // Offline: several edits sent as one update, what was
                    // typed and erased meanwhile as deleted structs.
                    let before = w.doc.transact().state_vector();
                    for _ in 0..2 + rng.below(6) {
                        edit(w, &mut rng);
                    }
                    let update = w.doc.transact().encode_state_as_update_v1(&before);
                    if update.len() > 2 {
                        sent.push((i, "offline", update));
                    }
                } else if let Some((op, update)) = edit(w, &mut rng) {
                    sent.push((i, op, update));
                }
            }
        }
        // Shuffled: concurrent edits reach the room in any order, each
        // writer's own in its order.
        let mut order: Vec<usize> = (0..sent.len()).collect();
        for i in (1..order.len()).rev() {
            order.swap(i, rng.below(i + 1));
        }
        let mut sequence: Vec<usize> = Vec::new();
        let mut taken = vec![false; sent.len()];
        for &pick in &order {
            let writer = sent[pick].0;
            // The writer's earliest update not taken yet.
            let first = (0..sent.len())
                .find(|&j| sent[j].0 == writer && !taken[j])
                .unwrap();
            taken[first] = true;
            sequence.push(first);
        }
        let mut refused = vec![false; writers.len()];
        for j in sequence {
            let (writer, op, update) = &sent[j];
            if refused[*writer] {
                continue;
            }
            let had_bound = room.bound.is_some();
            let verdict = room.receive(update).map_err(|why| {
                steps.push(format!("round {round}: writer {writer} {op}"));
                format!("seed {seed}: {why}\nsteps:\n  {}", steps.join("\n  "))
            })?;
            let (column, why) = match verdict {
                Verdict::Bound => (0, String::new()),
                Verdict::Exact if !had_bound => (3, String::new()),
                Verdict::Exact => (1, String::new()),
                Verdict::Refused(why) => {
                    refused[*writer] = true;
                    (2, why)
                }
            };
            stats.ops.entry(op).or_default()[column] += 1;
            steps.push(format!(
                "round {round}: writer {writer} {op} -> {} {why}",
                ["bound", "exact", "refused", "exact (no bound)"][column]
            ));
        }
        let now = common::state(&room.doc);
        for (i, w) in writers.iter_mut().enumerate() {
            if refused[i] {
                // A refused editor reloads on a fresh document.
                next_client += 1;
                *w = Writer::new(&now, next_client);
            } else {
                let sv = w.doc.transact().state_vector();
                common::apply(&w.doc, &room.doc.transact().encode_state_as_update_v1(&sv));
            }
        }
    }
    Ok(stats)
}

fn run_or_report(seed: u64, note: &[Value], rounds: usize) -> Stats {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(seed, note, rounds))) {
        Ok(Ok(stats)) => stats,
        Ok(Err(report)) => panic!("{report}"),
        Err(_) => panic!(
            "seed {seed} panicked (rerun with BLOCKS_BOUND_FIRST_SEED={seed} BLOCKS_BOUND_SEEDS=1)"
        ),
    }
}

fn env(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn report(name: &str, seeds: u64, stats: &Stats) {
    let (bound, exact) = stats.structural();
    eprintln!(
        "{name}: {seeds} seeds; structural updates {bound} on the bound, {exact} exact ({:.1}% on the bound)",
        100.0 * bound as f64 / (bound + exact).max(1) as f64
    );
    for (op, [b, e, r, n]) in &stats.ops {
        eprintln!("  {op:<13} bound {b:>6}  exact {e:>6}  refused {r:>6}  no bound {n:>5}");
    }
}

/// The walks over the every-block note: never admits on the bound what the
/// exact path refuses or must repair, never undercounts, prices structure
/// exactly, and keeps the index in step. Fails with the seed and its steps.
#[test]
fn structural_walks_match_the_exact_path() {
    let seeds = env("BLOCKS_BOUND_SEEDS", 40);
    let first = env("BLOCKS_BOUND_FIRST_SEED", 1);
    let note = every_block();
    let mut stats = Stats::default();
    for seed in first..first + seeds {
        stats.add(&run_or_report(seed, &note, 12));
    }
    report("every-block walks", seeds, &stats);
    let (bound, exact) = stats.structural();
    assert!(
        bound > exact,
        "{bound} structural updates on the bound, {exact} exact"
    );
}

/// The same on the near-limit load note (about 2 MB of Plate JSON): a few
/// seeds, each update's exact path a copy of the whole room.
#[test]
fn structural_walks_on_the_near_limit_note() {
    let seeds = env("BLOCKS_BOUND_LOAD_SEEDS", 2);
    let first = env("BLOCKS_BOUND_FIRST_SEED", 1);
    let note = load_note();
    let mut stats = Stats::default();
    for seed in first..first + seeds {
        stats.add(&run_or_report(seed, &note, 4));
    }
    report("near-limit walks", seeds, &stats);
    let (bound, _) = stats.structural();
    assert!(bound > 0);
}

/// Seed 10013 (sweep 2026-10-29): an offline batch that only erased text,
/// which the bound prices at nothing while the projection shrinks; the walk
/// had taken it for a structural update priced wrong.
#[test]
fn seed_10013_offline_erasing_alone() {
    run_or_report(10013, &every_block(), 12);
}

/// Seed 430 (sweep 2026-10-29): a writer's own doc lists a block twice
/// until the room's repair reaches it, and the walk helpers looped over it,
/// growing without end (gigabytes per process). Fails by running out of
/// memory if `walk` or `subtree` revisits a block.
#[test]
fn seed_430_a_writer_doc_listing_a_block_twice() {
    run_or_report(430, &every_block(), 12);
}

// --------------------------------------------------- concurrent, named

fn three() -> Vec<u8> {
    let value = serde_json::json!([
        {"id": "a", "type": "p", "children": [{"text": "A"}]},
        {"id": "b", "type": "p", "children": [{"text": "B"}]},
        {"id": "c", "type": "p", "children": [{"text": "C"}]},
    ]);
    blocks::state_from_value(value.as_array().unwrap(), 1).unwrap()
}

/// Updates made on replicas of `state`, each by its own client.
fn on_replicas(state: &[u8], edits: &[&dyn Fn(&mut TransactionMut)]) -> Vec<Vec<u8>> {
    edits
        .iter()
        .enumerate()
        .map(|(i, edit)| {
            let doc = common::doc(state, 200 + i as u64);
            let before = doc.transact().state_vector();
            edit(&mut doc.transact_mut());
            doc.transact().encode_state_as_update_v1(&before)
        })
        .collect()
}

/// Each named race: the first update reaches the room on the bound, the
/// second would leave the tree needing the repair on entry (a block under
/// two parents, a block listed under a deleted one, a cycle), so the bound
/// gives it to the exact path, which repairs it. Fails if the bound admits
/// the second.
#[test]
fn races_the_repair_settles_go_to_the_exact_path() {
    let state = three();
    let mv = |id: &'static str, to: &'static str| {
        move |txn: &mut TransactionMut| {
            let from = if index_in(txn, blocks::NOTE_ID, id).is_some() {
                blocks::NOTE_ID.to_string()
            } else {
                walk(txn).into_iter().find(|(b, _)| b == id).unwrap().1
            };
            unlist(txn, &from, id);
            list(txn, to, id, 0);
        }
    };
    let races: Vec<(&str, Vec<Vec<u8>>)> = vec![
        (
            "one block moved by two",
            on_replicas(&state, &[&mv("c", "a"), &mv("c", "b")]),
        ),
        (
            "a move into a deleted block",
            on_replicas(
                &state,
                &[
                    &|txn: &mut TransactionMut| delete(txn, blocks::NOTE_ID, "a"),
                    &mv("c", "a"),
                ],
            ),
        ),
        (
            "A into B against B into A",
            on_replicas(&state, &[&mv("a", "b"), &mv("b", "a")]),
        ),
    ];
    for (name, updates) in races {
        let room = common::doc(&state, 1);
        let tree = blocks::Tree::of(&room.transact());
        let first = ydoc::decode(&updates[0]).unwrap();
        assert!(
            blocks::bound::growth(&room.transact(), &ydoc::Incoming::new(&first), &tree).is_some(),
            "{name}: the first"
        );
        let mut tree = tree;
        let growth =
            blocks::bound::growth(&room.transact(), &ydoc::Incoming::new(&first), &tree).unwrap();
        common::apply(&room, &updates[0]);
        tree.apply(&growth);
        let second = ydoc::decode(&updates[1]).unwrap();
        assert_eq!(
            blocks::bound::growth(&room.transact(), &ydoc::Incoming::new(&second), &tree),
            None,
            "{name}: the second"
        );
        let exact = exact(&room, &updates[1], &measure(&room.transact()));
        assert!(
            matches!(exact, Ok((_, true))),
            "{name}: the exact path repairs it"
        );
    }
}
