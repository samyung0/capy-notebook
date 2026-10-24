//! The browser's entry: the late path's worker calls this (wasm-pack,
//! `scripts/build-late-merge.mjs`).

use wasm_bindgen::prelude::*;

/// [crate::Merged] for JavaScript: `hidden` is JSON, an array of the blocks'
/// item ids, `{ client, clock }`.
#[wasm_bindgen(getter_with_clone)]
pub struct Merged {
    pub update: Vec<u8>,
    pub hidden: String,
}

fn answer(merged: Result<crate::Merged, crate::Refused>) -> Result<Merged, JsError> {
    let merged = merged.map_err(|error| JsError::new(&error.to_string()))?;
    let hidden: Vec<serde_json::Value> = merged
        .hidden
        .iter()
        .map(|block| serde_json::json!({ "client": block.client.get(), "clock": block.clock }))
        .collect();
    Ok(Merged {
        update: merged.update,
        hidden: serde_json::Value::Array(hidden).to_string(),
    })
}

/// [crate::merge]; a refusal throws its reason.
#[wasm_bindgen]
pub fn merge(old: &[u8], current: &[u8]) -> Result<Merged, JsError> {
    answer(crate::merge(old, current))
}

/// [crate::reauthor] under `author`, a Yjs client id (32 bits); a refusal
/// throws its reason.
#[wasm_bindgen]
pub fn reauthor(old: &[u8], current: &[u8], author: u32) -> Result<Merged, JsError> {
    answer(crate::reauthor(old, current, u64::from(author)))
}
