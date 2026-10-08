#![allow(clippy::unwrap_used)] // Tests panic on a broken corpus.
//! Material document and question validation against the Node server on the
//! corpus: the shared Go/TS question fixtures, every fixture note, quiz and
//! flashcard set under each material kind, random structural damage to them,
//! and the bank-asset host rules. Outcomes match exactly; messages match
//! except where zod raised the error (its message is its issue list).
mod common;

use notes::material;
use notes::questions::{self, Policy};
use serde_json::{Value, json};

fn policy(fixture: &Value, host: &Value) -> Policy {
    Policy {
        bank: fixture["bank"].as_bool().unwrap_or(false),
        bank_assets_url: fixture["bankAssetsUrl"].as_str().map(str::to_owned),
        snapshot: fixture["snapshot"].as_bool().unwrap_or(false),
        quiz_assets_url: host.as_str().map(str::to_owned),
    }
}

fn compare(at: &str, ours: Result<(), String>, theirs: &Value, failures: &mut Vec<String>) {
    let ok = theirs["ok"].as_bool().unwrap();
    match ours {
        Ok(()) if ok => {}
        Err(message) if !ok => {
            let expected = theirs["message"].as_str().unwrap();
            if !theirs["zod"].as_bool().unwrap() && message != expected {
                failures.push(format!("{at}: message {message:?} != {expected:?}"));
            }
        }
        ours => failures.push(format!("{at}: {ours:?} != JS {theirs}")),
    }
}

#[test]
fn validation_matches_the_node_server() {
    let corpus = common::load("validation");
    let mut failures = Vec::new();
    for case in corpus["questions"].as_array().unwrap() {
        let at = format!("question {} (host {})", case["file"], case["host"]);
        let ours = questions::validate_question(
            &case["question"],
            &policy(&case["policy"], &case["host"]),
        )
        .map(|_| ());
        compare(&at, ours, &case["outcome"], &mut failures);
        if case["host"].is_null() && case["outcome"]["ok"].as_bool() != case["valid"].as_bool() {
            failures.push(format!("{at}: the JS outcome disagrees with the fixture"));
        }
    }
    for case in corpus["cases"].as_array().unwrap() {
        let at = format!(
            "{} as {} (host {})",
            case["name"], case["kind"], case["host"]
        );
        let policy = policy(&Value::Null, &case["host"]);
        let ours = material::assert_canonical_with(
            case["value"].as_array().unwrap(),
            case["kind"].as_str().unwrap(),
            &policy,
        )
        .map_err(|error| error.to_string());
        compare(&at, ours, &case["outcome"], &mut failures);
    }
    let cases = corpus["cases"].as_array().unwrap();
    let refused = cases.iter().filter(|c| c["outcome"]["ok"] == false).count();
    let messages = cases
        .iter()
        .filter(|c| c["outcome"]["zod"] == false)
        .count();
    eprintln!(
        "{} question fixtures, {} material cases ({refused} refused, {messages} with the message compared)",
        corpus["questions"].as_array().unwrap().len(),
        cases.len()
    );
    assert!(
        failures.is_empty(),
        "{} failures: {failures:#?}",
        failures.len()
    );
}

/// Every resizable block takes one optional `width`, exactly "<n>%" with n a
/// whole number from 20 to 100 (Epo, 2026-10-08), on an accepted corpus node
/// of each kind.
#[test]
fn resizable_blocks_take_only_the_widths_the_handles_write() {
    let corpus = common::load("validation");
    for kind in ["img", "video", "mermaid", "mindmap", "chart", "graph"] {
        let (base, material_kind) = corpus["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|case| case["outcome"]["ok"] == true)
            .find_map(|case| {
                let node = case["value"]
                    .as_array()?
                    .iter()
                    .find(|node| node["type"] == kind)?;
                Some((node.clone(), case["kind"].as_str()?.to_owned()))
            })
            .unwrap_or_else(|| panic!("no accepted {kind} in the corpus"));
        let with_width = |width: Value| {
            let mut node = base.clone();
            node["width"] = width;
            material::assert_canonical_with(&[node], &material_kind, &Policy::default())
        };
        material::assert_canonical_with(
            std::slice::from_ref(&base),
            &material_kind,
            &Policy::default(),
        )
        .unwrap();
        for width in ["20%", "55%", "100%"] {
            with_width(Value::from(width)).unwrap_or_else(|e| panic!("{kind} {width}: {e}"));
        }
        for width in [
            json!("19%"),
            json!("101%"),
            json!("020%"),
            json!("50"),
            json!("50.5%"),
            json!(" 50%"),
            json!("%"),
            json!(50),
            Value::Null,
        ] {
            let refused = with_width(width.clone()).unwrap_err();
            assert_eq!(
                refused.0, "width must be a whole percentage from 20% to 100%",
                "{kind} {width}"
            );
        }
    }
}
