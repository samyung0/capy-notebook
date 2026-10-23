//! The browser's entry: the late path's worker calls this (wasm-pack,
//! `scripts/build-late-merge.mjs`).

use wasm_bindgen::prelude::*;

/// [crate::merge]; a refusal throws its reason.
#[wasm_bindgen]
pub fn merge(old: &[u8], base: &[u8], current: &[u8]) -> Result<Vec<u8>, JsError> {
    crate::merge(old, base, current).map_err(|error| JsError::new(&error.to_string()))
}
