#![allow(clippy::unwrap_used)]
//! The shared goldens (`server/internal/materialdoc/testdata/blocks/*.json`,
//! each `{name, value, canonical, blocks}`), which the TypeScript converter
//! asserts against too. `BLOCKS_BLESS=1` rewrites `canonical` and `blocks`
//! from each file's `value`.

mod common;

use serde_json::{Value, json};
use yrs::Transact;

#[test]
fn goldens_match() {
    let dir = common::repo("server/internal/materialdoc/testdata/blocks");
    let bless = std::env::var("BLOCKS_BLESS").is_ok_and(|v| v == "1");
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|e| e == "json"))
        .collect();
    paths.sort();
    assert!(paths.len() >= 8, "goldens missing in {}", dir.display());
    let mut failures = Vec::new();
    for path in paths {
        let golden: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let name = golden["name"].as_str().unwrap();
        let value = golden["value"].as_array().unwrap();
        let canonical = blocks::canonical(value).unwrap();
        let state = blocks::state_from_value(value, 7).unwrap();
        let doc = common::doc(&state, 99);
        let txn = doc.transact();
        blocks::check(&txn).unwrap();
        assert_eq!(blocks::value(&txn).unwrap(), canonical, "{name}");
        let made = json!({
            "name": name,
            "value": value,
            "canonical": canonical,
            "blocks": blocks::blocks_json(&txn),
        });
        if bless {
            let text = serde_json::to_string_pretty(&made).unwrap() + "\n";
            std::fs::write(&path, text).unwrap();
        } else if made != golden {
            failures.push(name.to_string());
        }
    }
    assert!(failures.is_empty(), "goldens differ: {failures:?}");
}
