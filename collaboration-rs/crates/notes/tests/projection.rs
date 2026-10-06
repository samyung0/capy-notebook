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
