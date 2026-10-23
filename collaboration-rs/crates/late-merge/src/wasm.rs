//! The browser's entry: the late path's worker calls this (wasm-pack,
//! `scripts/build-late-merge.mjs`).

use wasm_bindgen::prelude::*;

/// [crate::Merged] for JavaScript.
#[wasm_bindgen(getter_with_clone)]
pub struct Merged {
    pub update: Vec<u8>,
    pub dropped: u32,
}

fn answer(merged: Result<crate::Merged, crate::Refused>) -> Result<Merged, JsError> {
    merged
        .map(|merged| Merged {
            update: merged.update,
            dropped: merged.dropped,
        })
        .map_err(|error| JsError::new(&error.to_string()))
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
