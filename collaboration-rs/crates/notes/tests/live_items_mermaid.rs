#![allow(clippy::unwrap_used, clippy::print_stdout)]
//! Prototype measurement for live-items DESIGN.md section 6 (not a CI test):
//! the keystroke updates `bench/collaboration/scripts/live-items/mermaid-shapes.ts`
//! wrote for each Mermaid source shape, admitted and applied one by one as a
//! note room does. Reports whether each update stays on the bound (no copy
//! of the room) and what the projection and the store check make of the end
//! state.
//!
//! LIVE_ITEMS_FIXTURES=<dir> cargo test -p notes --test live_items_mermaid -- --ignored --nocapture

mod common;

use std::time::Instant;

use common::AdmitBytes;
use notes::limits::{Admission, Validator};
use serde_json::Value;
use yrs::Transact;

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

fn source_of(value: &[Value]) -> Option<String> {
    let block = value.iter().find(|node| node["type"] == "mermaid")?;
    if let Some(source) = block["source"].as_str() {
        return Some(source.to_owned());
    }
    let child = block["children"]
        .as_array()?
        .iter()
        .find(|child| child["type"] == "mermaid_source")?;
    Some(
        child["children"]
            .as_array()?
            .iter()
            .filter_map(|leaf| leaf["text"].as_str())
            .collect(),
    )
}

#[test]
#[ignore = "prototype measurement; needs LIVE_ITEMS_FIXTURES"]
fn mermaid_shapes_through_the_note_room() {
    let dir = std::path::PathBuf::from(std::env::var("LIVE_ITEMS_FIXTURES").unwrap());
    for shape in ["string", "nested", "child"] {
        let base = std::fs::read(dir.join(format!("{shape}.base.bin"))).unwrap();
        let keys = updates(&std::fs::read(dir.join(format!("{shape}.updates.bin"))).unwrap());
        let doc = common::doc(&base, 77);
        let mut validator = Validator::default();
        let (mut accepted, mut refused, mut first_refusal) = (0, 0, None);
        let started = Instant::now();
        for update in &keys {
            match validator.admit_bytes(&doc, update) {
                Ok(Admission::Accepted) => {
                    accepted += 1;
                    common::apply(&doc, update);
                }
                Ok(Admission::Unheld) => refused += 1,
                Err(error) => {
                    refused += 1;
                    first_refusal.get_or_insert(error.to_string());
                }
            }
        }
        let admit_us = started.elapsed().as_secs_f64() * 1e6 / keys.len() as f64;
        let txn = doc.transact();
        let value = notes::plate::value(&txn);
        let (source, canonical) = match &value {
            Ok(value) => (
                source_of(value).map(|source| source.len()),
                notes::material::assert_canonical(value, "note")
                    .map(|_| "ok".to_owned())
                    .unwrap_or_else(|error| error.0),
            ),
            Err(error) => (None, format!("projection: {error}")),
        };
        println!(
            "{}",
            serde_json::json!({
                "shape": shape,
                "updates": keys.len(),
                "accepted": accepted,
                "refused": refused,
                "firstRefusal": first_refusal,
                "exactChecks": validator.exact_checks,
                "admitAndApplyMicrosPerUpdate": (admit_us * 10.0).round() / 10.0,
                "projectedSourceChars": source,
                "storeCheck": canonical,
            })
        );
    }
}
