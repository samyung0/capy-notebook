#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! The browser's and the room's copies of the board's rules agree
//! (RULES.md): `tests/parity/ts.json`, written by the browser's
//! `boardRules.parity.test.ts`, holds cases made by changing a Yjs document
//! as an editor does, each from the board's first state, with the browser's
//! verdict. The room admits every update of a case but the last, and the last
//! iff the browser says the board still fits, refusing it by the rule the
//! browser's check holds (an entity's or the tree's, not one of the room's
//! own on what an update may do); its enums are the browser's.
mod common;

use common::*;
use serde_json::Value;

fn hex(text: &str) -> Vec<u8> {
    assert!(text.len().is_multiple_of(2), "odd hex");
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

fn ts() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/parity/ts.json");
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("{path}: {error} (written by boardRules.parity.test.ts)"));
    serde_json::from_str(&text).unwrap()
}

/// Whether a refusal is in one of the forms the entity, tree and text rules
/// give (RULES.md "Words", "Elements", "Blocks"), rather than the room's own
/// on what an update may do or a struct the board has no place for.
fn names_a_rule(reason: &str) -> bool {
    const WHOLE: &[&str] = &[
        "a canvas element without a string type",
        "a canvas element that is not a map",
        "a block without a string flavour",
        "a block that is not a map",
        "a text holds something other than text and formats",
    ];
    // "canvas element {type}: …" or "block {flavour}: …", by a key or an
    // entry of its type.
    let of_kind = |what: &str| {
        reason
            .strip_prefix(what)
            .and_then(|rest| rest.split_once(": "))
            .is_some_and(|(kind, rule)| !kind.is_empty() && !kind.contains(' ') && !rule.is_empty())
    };
    let unheld =
        |what: &str| reason.starts_with(what) && reason.ends_with(" the board does not hold");
    let tree = reason.starts_with("block ") && reason.ends_with(", which it may not sit under");
    WHOLE.contains(&reason)
        || of_kind("canvas element ")
        || of_kind("block ")
        || unheld("a canvas element of type ")
        || unheld("a block of flavour ")
        || tree
}

#[test]
fn the_room_admits_what_the_browser_says_fits() {
    let ts = ts();
    let mut wrong = Vec::new();
    for case in ts["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let fits = case["fits"].as_bool().unwrap();
        let updates: Vec<Vec<u8>> = case["updates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|update| hex(update.as_str().unwrap()))
            .collect();
        let room = room();
        let (last, earlier) = updates.split_last().unwrap();
        if let Some((at, Err(reason))) = earlier
            .iter()
            .map(|update| send(&room, update))
            .enumerate()
            .find(|(_, verdict)| verdict.is_err())
        {
            wrong.push(format!("{name}: update {at} refused: {reason}"));
            continue;
        }
        match (admit(&room, last), fits) {
            (Ok(()), true) => {}
            (Err(reason), false) if names_a_rule(&reason) => {}
            (Err(reason), false) => {
                wrong.push(format!(
                    "{name}: refused by no entity or tree rule: {reason}"
                ));
            }
            (Ok(()), false) => wrong.push(format!("{name}: admitted, the browser refuses it")),
            (Err(reason), true) => wrong.push(format!("{name}: refused: {reason}")),
        }
    }
    assert!(
        wrong.is_empty(),
        "{} cases disagree:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}

#[test]
fn the_enums_are_the_browsers() {
    let ts = ts();
    let mut theirs: Vec<(String, Vec<String>)> = ts["enums"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, values)| {
            let mut values: Vec<String> = values
                .as_array()
                .unwrap()
                .iter()
                .map(Value::to_string)
                .collect();
            values.sort();
            (name.clone(), values)
        })
        .collect();
    theirs.sort();
    let mut ours: Vec<(String, Vec<String>)> = board::rules::ENUMS
        .iter()
        .map(|(name, values)| {
            let mut values: Vec<String> = match values {
                board::rules::Enum::Strs(values) => {
                    values.iter().map(|v| Value::from(*v).to_string()).collect()
                }
                board::rules::Enum::Nums(values) => values
                    .iter()
                    .map(|v| serde_json::json!(*v as i64).to_string())
                    .collect(),
            };
            values.sort();
            ((*name).to_owned(), values)
        })
        .collect();
    ours.sort();
    assert_eq!(ours, theirs);
}
