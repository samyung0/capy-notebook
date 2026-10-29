//! The browser's entry: the late path's worker calls this (wasm-pack,
//! `scripts/build-late-merge.mjs`).

use wasm_bindgen::prelude::*;

/// [crate::Merged] for JavaScript: `hidden` is JSON, an array of the blocks'
/// item ids, `{ client, clock }`; `rekeyed` is JSON, an array of
/// `{ key, item: { client, clock }, parent, left, subtree }` (null for a
/// missing parent or left), empty but for the blocks merges.
#[wasm_bindgen(getter_with_clone)]
pub struct Merged {
    pub update: Vec<u8>,
    pub hidden: String,
    pub rekeyed: String,
}

fn answer(merged: Result<crate::Merged, crate::Refused>) -> Result<Merged, JsError> {
    let merged = merged.map_err(|error| JsError::new(&error.to_string()))?;
    let hidden: Vec<serde_json::Value> = merged
        .hidden
        .iter()
        .map(|block| serde_json::json!({ "client": block.client.get(), "clock": block.clock }))
        .collect();
    let rekeyed: Vec<serde_json::Value> = merged
        .rekeyed
        .iter()
        .map(|r| {
            serde_json::json!({
                "key": r.key,
                "item": { "client": r.item.client.get(), "clock": r.item.clock },
                "parent": r.parent,
                "left": r.left,
                "subtree": r.subtree,
            })
        })
        .collect();
    Ok(Merged {
        update: merged.update,
        hidden: serde_json::Value::Array(hidden).to_string(),
        rekeyed: serde_json::Value::Array(rekeyed).to_string(),
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

/// [crate::merge_keyed] for a blocks note ([crate::BLOCKS]).
#[wasm_bindgen]
pub fn merge_blocks(old: &[u8], current: &[u8]) -> Result<Merged, JsError> {
    answer(crate::merge_keyed(old, current, &crate::BLOCKS))
}

/// [crate::reauthor_keyed] for a blocks note ([crate::BLOCKS]).
#[wasm_bindgen]
pub fn reauthor_blocks(old: &[u8], current: &[u8], author: u32) -> Result<Merged, JsError> {
    answer(crate::reauthor_keyed(
        old,
        current,
        u64::from(author),
        &crate::BLOCKS,
    ))
}
