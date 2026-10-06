#![allow(clippy::unwrap_used)] // Tests panic on a broken corpus.
//! Agent markdown through the embedded import against the Node server's
//! converter on the same sources (synthetic constructs and the repository's
//! own markdown pages): the same document and drafts, or the same error.
//! Generated ids are random on both sides and compared by first occurrence.
//!
//! Needs the bundle: `node markdown/build.mjs <checkout> markdown/markdown.bundle.mjs`
//! (or NOTES_MARKDOWN_BUNDLE pointing at one).
mod common;

use std::collections::HashMap;
use std::time::Instant;

use notes::markdown::Converter;
use serde_json::Value;

fn bundle() -> String {
    let path = std::env::var("NOTES_MARKDOWN_BUNDLE").unwrap_or_else(|_| {
        format!(
            "{}/markdown/markdown.bundle.mjs",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("markdown bundle {path}: {error}; build it with markdown/build.mjs")
    })
}

/// Ids renamed by first occurrence.
fn normalize(value: &mut Value, ids: &mut HashMap<String, String>) {
    match value {
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                if key == "id"
                    && let Value::String(id) = item
                {
                    let next = format!("id{}", ids.len());
                    *id = ids.entry(id.clone()).or_insert(next).clone();
                    continue;
                }
                normalize(item, ids);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| normalize(item, ids)),
        _ => {}
    }
}

#[test]
fn markdown_matches_the_node_server() {
    let started = Instant::now();
    let converter = Converter::new(&bundle()).unwrap();
    let loaded = started.elapsed();
    let corpus = common::load("markdown");
    let mut failures = Vec::new();
    let started = Instant::now();
    // The long pages take seconds each in QuickJS: run them with
    // MARKDOWN_ALL=1 (the timing comparison does).
    let all = std::env::var("MARKDOWN_ALL").is_ok();
    let mut converted_count = 0;
    for case in corpus.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let source = case["source"].as_str().unwrap();
        if !all && source.len() > 30_000 {
            continue;
        }
        converted_count += 1;
        let mut expected = case["result"].clone();
        let one = Instant::now();
        let converted = converter.convert(source);
        if std::env::var("MARKDOWN_TIMES").is_ok() {
            eprintln!("{:>8} bytes {:>10.1?} {name}", source.len(), one.elapsed());
        }
        let ours = match converted {
            Ok(converted) => serde_json::to_value(converted).unwrap(),
            Err(error) => serde_json::json!({ "error": error.0 }),
        };
        let mut ours = ours;
        normalize(&mut ours, &mut HashMap::new());
        normalize(&mut expected, &mut HashMap::new());
        if ours != expected {
            failures.push(format!("{name}: {ours} != JS {expected}"));
        }
    }
    eprintln!(
        "markdown: {converted_count} of {} sources, bundle loaded in {loaded:?}, converted in {:?}",
        corpus.as_array().unwrap().len(),
        started.elapsed()
    );
    assert!(
        failures.is_empty(),
        "{} failures: {:#?}",
        failures.len(),
        failures
            .iter()
            .map(|f| &f[..f.len().min(600)])
            .collect::<Vec<_>>()
    );
}
