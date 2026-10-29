#![allow(clippy::unwrap_used)] // Tests panic on a broken fixture.
//! `notes::index_text` against Go's golden fixtures
//! (`server/internal/materialdoc/testdata/index_text`, read by Go's
//! `TestExtractIndexBlocksMatchesTheGoldenFixtures`): stored content gives
//! Go's index text per block, byte for byte.

use std::collections::BTreeMap;

use notes::index_text::{self, IndexBlock, ItemText};
use serde_json::Value;

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
fn content_gives_gos_index_text() {
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
        assert_eq!(
            index_text::from_content(&fixture["document"], &items),
            want,
            "{name}"
        );
    }
}

/// A list indent past `LIST_INDENT_MAX`, which the store refuses, still
/// reads as the deepest one instead of reaching the repeat.
#[test]
fn a_list_indent_is_bounded() {
    let document = serde_json::json!({ "schemaVersion": 1, "value": [
        { "type": "p", "id": "l1", "indent": 1e30, "listStyleType": "disc", "children": [{ "text": "deep" }] },
    ] });
    let text = format!("{}- deep", "  ".repeat(notes::catalog::LIST_INDENT_MAX - 1));
    assert_eq!(
        index_text::from_content(&document, &Items(BTreeMap::new())),
        [IndexBlock {
            id: "l1".into(),
            text
        }]
    );
}
