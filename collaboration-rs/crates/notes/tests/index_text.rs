#![allow(clippy::unwrap_used)] // Tests panic on a broken fixture.
//! `notes::index_text` against Go's golden fixtures
//! (`server/internal/materialdoc/testdata/index_text`, read by Go's
//! `TestExtractIndexBlocksMatchesTheGoldenFixtures`): stored content and the
//! live room built from it give Go's index text per block, byte for byte.

use std::collections::BTreeMap;

use notes::index_text::{self, IndexBlock, ItemText};
use notes::{plate, slate_yjs};
use serde_json::Value;
use yrs::updates::decoder::Decode;
use yrs::{Doc, Transact, Update};

/// Each item's text from its stored content, as a caller without the
/// item's room passes it.
struct Items(BTreeMap<String, String>);

impl ItemText for Items {
    fn item_text(&self, material_id: &str) -> Option<String> {
        self.0.get(material_id).cloned()
    }
}

fn fixtures() -> Vec<(String, Value)> {
    let dir = format!(
        "{}/../../../server/internal/materialdoc/testdata/index_text",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut out: Vec<(String, Value)> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .map(|path| {
            let text = std::fs::read_to_string(&path).unwrap();
            (
                path.display().to_string(),
                serde_json::from_str(&text).unwrap(),
            )
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(!out.is_empty(), "no index text fixtures");
    out
}

#[test]
fn content_and_room_give_gos_index_text() {
    for (name, fixture) in fixtures() {
        let items = Items(
            fixture["items"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(id, content)| (id.clone(), index_text::item_from_content(content)))
                .collect(),
        );
        let want: Vec<IndexBlock> = serde_json::from_value(fixture["blocks"].clone()).unwrap();
        let document = &fixture["document"];
        assert_eq!(
            index_text::from_content(document, &items),
            want,
            "{name}: from_content"
        );

        let doc = Doc::with_options(ydoc::doc_options(1));
        let state = slate_yjs::state_from_value(document["value"].as_array().unwrap(), 1);
        doc.transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
        let txn = doc.transact();
        let root = plate::content_root(&txn).unwrap();
        assert_eq!(
            index_text::from_doc(&txn, root, &items).unwrap(),
            want,
            "{name}: from_doc"
        );
        assert_eq!(
            index_text::item_refs(&txn, root).unwrap(),
            index_text::content_item_refs(document),
            "{name}: item_refs"
        );
    }
}
