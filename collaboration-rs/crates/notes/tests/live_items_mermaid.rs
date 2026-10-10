#![allow(clippy::unwrap_used)] // Tests panic on a broken fixture.
//! A Mermaid source typed live (shape A, live-items DESIGN.md 6): the 77
//! keystroke updates `bench/collaboration/scripts/live-items/mermaid-shapes.ts`
//! recorded through the patched slate-yjs and a CodeMirror binding (67 keys,
//! 10 backspaces, then two peers typing at once), admitted and applied one
//! by one as a note room does (fixtures in `tests/fixtures/mermaid`).

mod common;

use common::AdmitBytes;
use notes::limits::{Admission, Validator};
use notes::plate;
use yrs::{Out, Transact, Xml, XmlTextRef};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/tests/fixtures/mermaid/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

/// The recorded updates, each prefixed by its length (u32, little endian).
fn updates(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let length = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        out.push(bytes[at + 4..at + 4 + length].to_vec());
        at += 4 + length;
    }
    out
}

fn source_chars(value: &[serde_json::Value]) -> usize {
    let block = value.iter().find(|node| node["type"] == "mermaid").unwrap();
    block["source"].as_str().unwrap().chars().count()
}

/// Every keystroke goes in on the bound: one exact measure (the first, with
/// no baseline yet), never a copy of the room per key. Without the bound's
/// source case each insert copies the room (67 exact checks).
#[test]
fn typed_mermaid_source_keystrokes_stay_on_the_bound() {
    let doc = common::doc(&fixture("nested.base.bin"), 77);
    let before = source_chars(&plate::value(&doc.transact()).unwrap());
    let keys = updates(&fixture("nested.updates.bin"));
    assert_eq!(keys.len(), 77);
    let mut validator = Validator::default();
    for (n, update) in keys.iter().enumerate() {
        let admitted = validator.admit_bytes(&doc, update);
        assert!(
            matches!(admitted, Ok(Admission::Accepted)),
            "update {n}: {admitted:?}"
        );
        common::apply(&doc, update);
    }
    assert_eq!(validator.exact_checks, 1);
    let txn = doc.transact();
    let value = plate::value(&txn).unwrap();
    // 67 characters typed, 10 deleted.
    assert_eq!(source_chars(&value), before + 57);
    notes::material::assert_canonical(&value, "note").unwrap();
    // The source is still a text in the room, not a string.
    let root = plate::content_root(&txn).unwrap();
    let held = plate::insert_delta(&root).unwrap().into_iter().find_map(|op| match op.insert {
        plate::Insert::Element(branch) => {
            let element = XmlTextRef::from(branch);
            matches!(element.get_attribute(&txn, "type"), Some(Out::Any(yrs::Any::String(kind))) if &*kind == "mermaid")
                .then(|| element.get_attribute(&txn, "source"))
        }
        plate::Insert::Text(_) => None,
    });
    assert!(matches!(held, Some(Some(Out::YText(_)))), "{held:?}");
}
