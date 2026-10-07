#![allow(clippy::unwrap_used)] // Tests panic on a broken corpus.
//! Plate projection and exact metrics against slate-yjs on the corpus.
mod common;

use notes::limits;
use notes::plate;
use serde_json::Value;
use yrs::Transact;

#[test]
fn projection_and_metrics_match_slate_yjs() {
    let corpus = common::load("projection");
    let mut failures = Vec::new();
    for case in corpus.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let doc = common::doc(&common::bytes(&case["state"]), 99);
        let txn = doc.transact();
        let value = Value::Array(plate::value(&txn).unwrap());
        let projected = plate::project_state(&common::bytes(&case["state"])).unwrap();
        assert_eq!(projected.schema_version, 1);
        assert_eq!(
            Value::Array(projected.value),
            value,
            "{name}: project_state"
        );
        if common::hash(&value) != case["hash"].as_str().unwrap() {
            failures.push(format!("{name}: value differs"));
            if !case["value"].is_null() {
                eprintln!("{name}\n  js:   {}\n  rust: {}", case["value"], value);
            }
        }
        let expected = &case["metrics"];
        match limits::measure(&txn) {
            Ok(metrics) => {
                if &common::metrics_json(&metrics) != expected {
                    failures.push(format!("{name}: metrics {metrics:?} != {expected}"));
                }
                let from_value = limits::measure_value(value.as_array().unwrap());
                if from_value != metrics {
                    failures.push(format!(
                        "{name}: measure_value {from_value:?} != {metrics:?}"
                    ));
                }
            }
            Err(error) => {
                if expected.get("error").is_none() {
                    failures.push(format!("{name}: {error}"));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// `load`'s bootstrap from `materials.content`: the same document as
/// `applyDelta(slateNodesToInsertDelta(value))`, byte for byte where a leaf
/// has at most one mark (yrs orders a leaf's format items by hash).
#[test]
fn bootstrap_matches_slate_nodes_to_insert_delta() {
    let corpus = common::load("bootstrap");
    let mut failures = Vec::new();
    let mut identical = 0;
    for case in corpus.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let value = case["value"].as_array().unwrap();
        let ours = notes::slate_yjs::state_from_value(value, 5);
        let theirs = common::bytes(&case["state"]);
        identical += usize::from(ours == theirs);
        let project = |state: &[u8]| {
            let doc = common::doc(state, 99);
            let txn = doc.transact();
            (
                common::hash(&Value::Array(plate::value(&txn).unwrap())),
                limits::measure(&txn).unwrap(),
            )
        };
        if project(&ours) != project(&theirs) {
            failures.push(format!("{name}: bootstrap differs"));
        }
    }
    eprintln!(
        "bootstrap: {identical} of {} states byte-identical",
        corpus.as_array().unwrap().len()
    );
    assert!(failures.is_empty(), "{failures:#?}");
}
