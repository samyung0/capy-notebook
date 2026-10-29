#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! Note edit effects on both layouts (todo-blocksuite-spike.md "Effects and
//! collection", boundary 2): one edit script runs on a Plate room (Slate
//! operations through `slate_yjs`, as the Plate editor sends them) and on a
//! blocks room (yrs writes on the `blocks` map, as BlockSuite makes them),
//! and both rooms' projections give the same index text per top-level block,
//! so Go's `NotePendingChanges` (AR:624, aligned by element id) names the
//! same blocks with the same texts. Derived ids (code lines, cells, the
//! paragraph in a cell, inline ids) differ between the two projections and
//! must change nothing.
//!
//! The cases are written to `server/internal/materialdoc/testdata/
//! effects_layouts.json`, where Go's `TestNoteChangesMatchAcrossLayouts`
//! compares the effects JSON itself. `EFFECTS_BLESS=1` rewrites the file.

use std::io::Read;

use serde_json::{Value, json};
use yrs::{
    Any, Array, ArrayPrelim, Map, MapPrelim, MapRef, Out, ReadTxn, Text, TextPrelim, TextRef,
    Transact, TransactionMut, WriteTxn,
};

use notes::index_text::{self, IndexBlock, ItemText};
use notes::slate::{Operation, Root};

fn repo(path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(path)
}

const FIXTURE: &str = "server/internal/materialdoc/testdata/effects_layouts.json";

/* --------------------------------------------------------------- the note */

fn p(id: &str, text: &str) -> Value {
    json!({ "type": "p", "id": id, "children": [{ "text": text }] })
}

fn item(id: &str, indent: u32, text: &str) -> Value {
    json!({ "type": "p", "id": id, "indent": indent, "listStyleType": "disc", "children": [{ "text": text }] })
}

fn cell(id: &str, text: &str) -> Value {
    // Stored content gives every element an id (stableElementIds.ts), the
    // paragraph in a cell too; the blocks projection derives them instead.
    json!({ "type": "td", "id": id, "children": [p(&format!("{id}p"), text)] })
}

fn quiz(stem: &str) -> Value {
    json!({ "schemaVersion": 1, "value": [{ "type": "flashcards", "id": "cards", "children": [{
        "type": "flashcard", "id": "c1", "children": [
            { "type": "flashcard_front", "children": [{ "text": stem }] },
            { "type": "flashcard_back", "children": [{ "text": "Twice a day" }] }
        ]
    }]}]})
}

fn reference(id: &str, material: &str) -> Value {
    json!({ "type": "material_ref", "id": id, "materialId": material, "refKind": "flashcards", "children": [{ "text": "" }] })
}

/// Every block kind the edits touch, with Plate's ids on nested and inline
/// elements. Top-level indexes: p1 0, l1 1, l2 2, co 3, tb 4, cb 5, p2 6,
/// mr 7, p3 8.
fn note() -> Vec<Value> {
    vec![
        p("p1", "Marsh notes."),
        item("l1", 1, "Low marsh"),
        item("l2", 2, "Cordgrass"),
        json!({ "type": "callout", "id": "co", "variant": "tip", "children": [p("co1", "Tides flood twice.")] }),
        json!({ "type": "table", "id": "tb", "children": [
            { "type": "tr", "id": "r0", "children": [cell("x0", "Site"), cell("x1", "Salinity")] },
            { "type": "tr", "id": "r1", "children": [cell("x2", "Inlet"), cell("x3", "30")] }
        ]}),
        json!({ "type": "code_block", "id": "cb", "lang": "python", "children": [
            { "type": "code_line", "id": "k0", "children": [{ "text": "x = 1" }] },
            { "type": "code_line", "id": "k1", "children": [{ "text": "y = 2" }] }
        ]}),
        json!({ "type": "p", "id": "p2", "children": [
            { "text": "Move me, see " },
            { "type": "a", "id": "ln", "url": "https://example.com", "children": [{ "text": "the link" }] },
            { "text": "." }
        ]}),
        reference("mr", "fc1"),
        p("p3", "Delete me."),
    ]
}

fn items() -> Value {
    json!({ "fc1": quiz("How often do tides flood?"), "fc2": quiz("What binds the dunes?") })
}

struct Items(Value);

impl ItemText for Items {
    fn item_text(&self, material_id: &str) -> Option<String> {
        self.0.get(material_id).map(index_text::item_from_content)
    }
}

/* ------------------------------------------------------------- the rooms */

fn plate_room(value: &[Value]) -> yrs::Doc {
    room(&notes::slate_yjs::state_from_value(value, 1))
}

fn blocks_room(value: &[Value]) -> yrs::Doc {
    room(&blocks::state_from_value(value, 1).unwrap())
}

fn room(state: &[u8]) -> yrs::Doc {
    let doc = yrs::Doc::with_options(ydoc::doc_options(2));
    ydoc::replay(&doc, state, &[] as &[Vec<u8>]).unwrap();
    doc
}

/// The Plate editor's operations, applied as one flush.
fn plate_edit(doc: &yrs::Doc, ops: &[Value]) {
    let ops: Vec<Operation> = ops
        .iter()
        .map(|op| serde_json::from_value(op.clone()).unwrap())
        .collect();
    let mut root = Root::new(notes::plate::value(&doc.transact()).unwrap());
    let mut txn = doc.transact_mut();
    let y_root = notes::plate::content_root(&txn).unwrap();
    notes::slate_yjs::apply_ops(&mut txn, y_root, &mut root, &ops).unwrap();
}

fn yblock(txn: &impl ReadTxn, id: &str) -> MapRef {
    let blocks = txn.get_map(blocks::BLOCKS_ROOT).unwrap();
    match blocks.get(txn, id) {
        Some(Out::YMap(block)) => block,
        _ => panic!("no block {id}"),
    }
}

fn ytext(txn: &impl ReadTxn, id: &str, key: &str) -> TextRef {
    match yblock(txn, id).get(txn, key) {
        Some(Out::YText(text)) => text,
        _ => panic!("no {key} in {id}"),
    }
}

fn children(txn: &impl ReadTxn, id: &str) -> yrs::ArrayRef {
    match yblock(txn, id).get(txn, "sys:children") {
        Some(Out::YArray(children)) => children,
        _ => panic!("no children in {id}"),
    }
}

fn position(txn: &impl ReadTxn, parent: &str, id: &str) -> u32 {
    children(txn, parent)
        .iter(txn)
        .position(|child| child.to_string(txn) == id)
        .unwrap() as u32
}

/// BlockSuite's `addBlock`: the yBlock with its schema defaults, then its id
/// in its parent's children.
fn add_block(
    txn: &mut TransactionMut,
    parent: &str,
    at: u32,
    id: &str,
    flavour: &str,
    props: &[(&str, Value)],
) {
    let blocks = txn.get_or_insert_map(blocks::BLOCKS_ROOT);
    let y = blocks.insert(txn, id, MapPrelim::default());
    y.insert(txn, "sys:flavour", flavour);
    y.insert(txn, "sys:children", ArrayPrelim::default());
    for (key, value) in blocks::schema::defaults(flavour) {
        y.insert(txn, format!("prop:{key}"), any(&value));
    }
    for key in blocks::schema::text_props(flavour) {
        y.insert(txn, format!("prop:{key}"), TextPrelim::new(""));
    }
    for (key, value) in props {
        match value {
            Value::String(text) if blocks::schema::text_props(flavour).contains(key) => {
                let text_ref = match y.get(txn, &format!("prop:{key}")) {
                    Some(Out::YText(text)) => text,
                    _ => unreachable!(),
                };
                text_ref.insert(txn, 0, text);
            }
            value => {
                y.insert(txn, format!("prop:{key}"), any(value));
            }
        }
    }
    children(txn, parent).insert(txn, at, Any::from(id));
}

fn any(value: &Value) -> Any {
    match value {
        Value::Null => Any::Null,
        Value::Bool(b) => Any::Bool(*b),
        Value::Number(n) => Any::Number(n.as_f64().unwrap()),
        Value::String(s) => Any::String(s.as_str().into()),
        other => panic!("not a primitive: {other}"),
    }
}

fn type_at_end(txn: &mut TransactionMut, id: &str, key: &str, text: &str) {
    let target = ytext(txn, id, key);
    let end = target.len(txn);
    target.insert(txn, end, text);
}

/// Moves `id` from `from` to index `at` of `to` (BlockSuite's `moveBlocks`:
/// the id leaves one children array and joins another).
fn move_block(txn: &mut TransactionMut, id: &str, from: &str, to: &str, at: u32) {
    let index = position(txn, from, id);
    children(txn, from).remove(txn, index);
    children(txn, to).insert(txn, at, Any::from(id));
}

/// BlockSuite's `deleteBlock`: out of its parent's children and the map.
fn delete_block(txn: &mut TransactionMut, id: &str, parent: &str) {
    let index = position(txn, parent, id);
    children(txn, parent).remove(txn, index);
    let blocks = txn.get_or_insert_map(blocks::BLOCKS_ROOT);
    blocks.remove(txn, id);
}

/* ------------------------------------------------------------- the cases */

struct Case {
    name: &'static str,
    /// The top-level blocks whose effects the edit should give.
    changed: &'static [&'static str],
    plate: Vec<Value>,
    blocks: fn(&mut TransactionMut),
}

fn text_path(path: &[usize], offset: usize, text: &str) -> Value {
    json!({ "type": "insert_text", "path": path, "offset": offset, "text": text })
}

fn cases() -> Vec<Case> {
    let base = note();
    vec![
        Case {
            name: "seed only",
            changed: &[],
            plate: vec![],
            blocks: |_| {},
        },
        Case {
            name: "typing in a paragraph",
            changed: &["p1"],
            plate: vec![text_path(&[0, 0], 12, " Salt.")],
            blocks: |txn| type_at_end(txn, "p1", "prop:text", " Salt."),
        },
        Case {
            name: "typing in a nested list item",
            changed: &["l2"],
            plate: vec![text_path(&[2, 0], 9, " grows")],
            blocks: |txn| type_at_end(txn, "l2", "prop:text", " grows"),
        },
        Case {
            name: "typing in a callout paragraph",
            changed: &["co"],
            plate: vec![text_path(&[3, 0, 0], 18, " Mostly.")],
            blocks: |txn| type_at_end(txn, "co1", "prop:text", " Mostly."),
        },
        Case {
            name: "typing in a table cell",
            changed: &["tb"],
            plate: vec![text_path(&[4, 1, 1, 0, 0], 2, " ppt")],
            blocks: |txn| type_at_end(txn, "tb", "prop:cells.r1:tb-c1.text", " ppt"),
        },
        Case {
            name: "a code line inserted first",
            changed: &["cb"],
            // Plate gives the new line a fresh id; the blocks projection
            // shifts every derived line id (cb.l0 is now the new line).
            plate: vec![json!({ "type": "insert_node", "path": [5, 0],
                "node": { "type": "code_line", "id": "k9", "children": [{ "text": "import tide" }] } })],
            blocks: |txn| ytext(txn, "cb", "prop:text").insert(txn, 0, "import tide\n"),
        },
        Case {
            name: "typing after a link",
            changed: &["p2"],
            plate: vec![text_path(&[6, 2], 1, " Done")],
            blocks: |txn| type_at_end(txn, "p2", "prop:text", " Done"),
        },
        Case {
            name: "a block moved to the top",
            changed: &["p2"],
            plate: vec![json!({ "type": "move_node", "path": [6], "newPath": [0] })],
            blocks: |txn| move_block(txn, "p2", blocks::NOTE_ID, blocks::NOTE_ID, 0),
        },
        Case {
            name: "a nested list item outdented",
            // The index text marks a list item's depth ("  - " to "- ").
            changed: &["l2"],
            plate: vec![json!({ "type": "set_node", "path": [2],
                "properties": { "indent": 2 }, "newProperties": { "indent": 1 } })],
            blocks: |txn| move_block(txn, "l2", "l1", blocks::NOTE_ID, 2),
        },
        Case {
            name: "a block deleted",
            changed: &["p3"],
            plate: vec![json!({ "type": "remove_node", "path": [8], "node": base[8] })],
            blocks: |txn| delete_block(txn, "p3", blocks::NOTE_ID),
        },
        Case {
            name: "two paragraphs pasted",
            changed: &["n1", "n2"],
            plate: vec![
                json!({ "type": "insert_node", "path": [1], "node": p("n1", "Pasted one.") }),
                json!({ "type": "insert_node", "path": [2], "node": p("n2", "Pasted two.") }),
            ],
            blocks: |txn| {
                let flavour = blocks::schema::PARAGRAPH;
                add_block(
                    txn,
                    blocks::NOTE_ID,
                    1,
                    "n1",
                    flavour,
                    &[("text", json!("Pasted one."))],
                );
                add_block(
                    txn,
                    blocks::NOTE_ID,
                    2,
                    "n2",
                    flavour,
                    &[("text", json!("Pasted two."))],
                );
            },
        },
        Case {
            name: "an embedded set's reference pasted",
            changed: &["mr2"],
            plate: vec![
                json!({ "type": "insert_node", "path": [8], "node": reference("mr2", "fc2") }),
            ],
            blocks: |txn| {
                // Before p3, which is one place up in the note's children:
                // l2 sits under l1.
                let at = position(txn, blocks::NOTE_ID, "p3");
                add_block(
                    txn,
                    blocks::NOTE_ID,
                    at,
                    "mr2",
                    blocks::schema::MATERIAL_REF,
                    &[
                        ("materialId", json!("fc2")),
                        ("refKind", json!("flashcards")),
                    ],
                );
            },
        },
    ]
}

/// What Go's `ExtractNoteBlocks` reads of a value: each top-level block's
/// id and type, and its index text.
fn read(value: &[Value], items: &Items) -> (Vec<(String, String)>, Vec<IndexBlock>) {
    let kinds = value
        .iter()
        .map(|node| {
            let field = |key: &str| node[key].as_str().unwrap_or_default().to_owned();
            (field("id"), field("type"))
        })
        .collect();
    let content = json!({ "schemaVersion": 1, "value": value });
    (kinds, index_text::from_content(&content, items))
}

fn changed_ids(before: &[IndexBlock], after: &[IndexBlock]) -> Vec<String> {
    let mut out: Vec<String> = after
        .iter()
        .filter(|block| !before.contains(block))
        .chain(
            before
                .iter()
                .filter(|block| !after.iter().any(|a| a.id == block.id)),
        )
        .map(|block| block.id.clone())
        .collect();
    out.dedup();
    out
}

/// The same edits give the same index text per top-level block on both
/// layouts, the edited blocks only, and the cases file Go reads is current.
/// Fails if a blocks edit reads as a change of another block (a derived id
/// or a normalization showing through), or the layouts disagree.
#[test]
fn the_same_edits_give_the_same_index_text_on_both_layouts() {
    let items = Items(items());
    let base = note();
    let (_, indexed) = read(&base, &items);
    let mut made = Vec::new();
    for case in cases() {
        let plate = plate_room(&base);
        plate_edit(&plate, &case.plate);
        let plate = notes::plate::value(&plate.transact()).unwrap();
        let blocks = blocks_room(&base);
        (case.blocks)(&mut blocks.transact_mut());
        let blocks = {
            let txn = blocks.transact();
            blocks::check(&txn).unwrap();
            blocks::value(&txn).unwrap()
        };
        let (plate_kinds, plate_text) = read(&plate, &items);
        let (blocks_kinds, blocks_text) = read(&blocks, &items);
        assert_eq!(plate_kinds, blocks_kinds, "{}: top-level blocks", case.name);
        assert_eq!(plate_text, blocks_text, "{}: index text", case.name);
        // The paragraph moved is the only one whose place changed; Go names
        // it from the order, not the text.
        let mut expected: Vec<String> = case.changed.iter().map(|id| id.to_string()).collect();
        if case.name == "a block moved to the top" {
            expected.clear();
        }
        assert_eq!(
            changed_ids(&indexed, &blocks_text),
            expected,
            "{}",
            case.name
        );
        made.push(json!({
            "name": case.name,
            "changed": case.changed,
            "plate": plate,
            "blocks": blocks,
        }));
    }
    let fixture = json!({ "indexed": base, "items": items.0, "cases": made });
    let path = repo(FIXTURE);
    if std::env::var("EFFECTS_BLESS").is_ok_and(|v| v == "1") {
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&fixture).unwrap() + "\n",
        )
        .unwrap();
    }
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
        .expect("run with EFFECTS_BLESS=1");
    assert_eq!(
        stored, fixture,
        "{FIXTURE} is stale: run with EFFECTS_BLESS=1"
    );
}

/// The corpus notes (the near-limit note included), the every-block note
/// and the shared goldens, seeded into the blocks layout and projected back,
/// keep each top-level block's index text, so a note switched to blocks
/// shows no change the person did not make; except the blocks the bridge's
/// normalizations rewrite (todo-blocksuite-layout.md "Normalizations"),
/// which read as changed at the room's first projection: an indent clamped
/// (N1), a blockquote's paragraphs joined by a newline (N3), a table's
/// merged cells split and short rows padded (N4/D15) and a cell's
/// paragraphs joined by a newline (N6). Fails if any other block changes.
#[test]
fn seeding_keeps_the_index_text() {
    let mut values: Vec<(String, Vec<Value>)> = Vec::new();
    let mut text = String::new();
    flate2::read::GzDecoder::new(
        std::fs::File::open(repo(
            "collaboration-rs/crates/notes/tests/corpus/bootstrap.json.gz",
        ))
        .unwrap(),
    )
    .read_to_string(&mut text)
    .unwrap();
    for entry in serde_json::from_str::<Value>(&text)
        .unwrap()
        .as_array()
        .unwrap()
    {
        values.push((
            format!("corpus {}", entry["name"].as_str().unwrap_or("?")),
            entry["value"].as_array().unwrap().clone(),
        ));
    }
    let every: Value = serde_json::from_str(
        &std::fs::read_to_string(repo(
            "server/internal/materialdoc/testdata/every-block-note.json",
        ))
        .unwrap(),
    )
    .unwrap();
    // Its references carry imported fence bodies, which stored content
    // never holds (the room refuses them).
    let stored: Vec<Value> = every["value"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|node| node.get("pending").is_none())
        .cloned()
        .collect();
    values.push(("every-block-note".into(), stored));
    let mut goldens: Vec<_> =
        std::fs::read_dir(repo("server/internal/materialdoc/testdata/blocks"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
    goldens.sort();
    for path in goldens {
        let golden: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        values.push((
            format!("golden {}", golden["name"].as_str().unwrap()),
            golden["value"].as_array().unwrap().clone(),
        ));
    }
    let items = Items(json!({}));
    let mut differ = Vec::new();
    for (name, mut value) in values {
        // Stored content always has unique ids; the older corpus values get
        // the ones the seed gives (`note-b<i>`).
        let mut seen = std::collections::HashSet::new();
        for (i, node) in value.iter_mut().enumerate() {
            let id = node["id"].as_str().unwrap_or_default().to_owned();
            if id.is_empty() || !seen.insert(id) {
                node["id"] = json!(format!("note-b{i}"));
            }
        }
        let canonical = match blocks::canonical(&value) {
            Ok(canonical) => canonical,
            Err(error) => {
                differ.push(format!("{name}: refused by the blocks layout: {error}"));
                continue;
            }
        };
        let (_, before) = read(&value, &items);
        let (_, after) = read(&canonical, &items);
        for id in changed_ids(&before, &after) {
            let old = before.iter().find(|b| b.id == id).map(|b| b.text.as_str());
            let new = after.iter().find(|b| b.id == id).map(|b| b.text.as_str());
            eprintln!("{name} {id}: {old:?} -> {new:?}");
            differ.push(format!("{name} {id}"));
        }
    }
    assert_eq!(
        differ,
        [
            "golden n1-indent-clamp c",
            "golden n3-blockquote q",
            "golden table tb"
        ]
    );
}
