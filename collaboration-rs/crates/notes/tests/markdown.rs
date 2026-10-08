#![allow(clippy::unwrap_used)] // Tests panic on a broken corpus.
//! Agent markdown through the embedded import against the Node server's
//! converter on the same sources (synthetic constructs and the repository's
//! own markdown pages): the same document and drafts, or the same error.
//! Generated ids are random on both sides and compared by first occurrence.
//!
//! Needs the bundle: `node markdown/build.mjs` (or NOTES_MARKDOWN_BUNDLE
//! pointing at one). The limits run on a small stand-in bundle.
mod common;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use notes::markdown::{Converter, MAX_INPUT_BYTES, MarkdownError, TIME_LIMIT};
use notes::prescan;
use serde_json::Value;

fn bundle() -> String {
    let path = std::env::var("NOTES_MARKDOWN_BUNDLE")
        .unwrap_or_else(|_| format!("{}/markdown/markdown.bundle.js", env!("CARGO_MANIFEST_DIR")));
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
    for case in corpus.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let source = case["source"].as_str().unwrap();
        let mut expected = case["result"].clone();
        let one = Instant::now();
        let converted = converter.convert(source);
        if std::env::var("MARKDOWN_TIMES").is_ok() {
            eprintln!("{:>8} bytes {:>10.1?} {name}", source.len(), one.elapsed());
        }
        let ours = match converted {
            Ok(converted) => serde_json::to_value(converted).unwrap(),
            Err(MarkdownError::Invalid(message)) => serde_json::json!({ "error": message }),
            Err(error) => panic!("{name}: {error}"),
        };
        let mut ours = ours;
        normalize(&mut ours, &mut HashMap::new());
        normalize(&mut expected, &mut HashMap::new());
        if ours != expected {
            failures.push(format!("{name}: {ours} != JS {expected}"));
        }
    }
    eprintln!(
        "markdown: {} sources, bundle loaded in {loaded:?}, converted in {:?}",
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

/// A stand-in import: `loop` runs forever, `grow` allocates without end,
/// `throw` throws, anything else converts to an empty document.
const LIMITS_BUNDLE: &str = r#"
globalThis.__markdown = {
  convertAgentMarkdown(source) {
    if (source === 'loop') for (;;) {}
    if (source === 'grow') { const kept = []; for (;;) kept.push(new Array(1e5).fill(source)); }
    if (source === 'throw') throw new Error('Invalid quiz fence');
    if (source === 'nest') {
      let node = { text: 'x' };
      for (let i = 0; i < 100; i++) node = { type: 'blockquote', children: [node] };
      return { document: { schemaVersion: 1, value: [node] }, embedded: [] };
    }
    return { document: { schemaVersion: 1, value: [] }, embedded: [] };
  },
};
"#;

#[test]
fn conversions_stop_at_the_limits_and_the_next_one_runs() {
    let converter = Converter::new(LIMITS_BUNDLE).unwrap();
    let too_large = "a".repeat(MAX_INPUT_BYTES + 1);
    assert!(matches!(
        converter.convert(&too_large),
        Err(MarkdownError::TooLarge { bytes }) if bytes == MAX_INPUT_BYTES + 1
    ));
    converter.convert(&"a".repeat(MAX_INPUT_BYTES)).unwrap();
    assert!(matches!(
        converter.convert("throw"),
        Err(MarkdownError::Invalid(message)) if message == "Invalid quiz fence"
    ));
    // A document nesting past serde_json's 128 levels is invalid input, not
    // an engine failure.
    assert!(matches!(
        converter.convert("nest"),
        Err(MarkdownError::Invalid(message)) if message.contains("nests deeper")
    ));
    assert!(matches!(
        converter.convert("grow"),
        Err(MarkdownError::OutOfMemory)
    ));
    converter.convert("ok").unwrap();
    // Two looping conversions: the second, queued behind the first, still
    // stops TIME_LIMIT after it was submitted, not after it started.
    std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            let started = Instant::now();
            (converter.convert("loop"), started.elapsed())
        });
        std::thread::sleep(Duration::from_millis(300));
        let started = Instant::now();
        let second = converter.convert("loop");
        let waited = started.elapsed();
        let (first, took) = first.join().unwrap();
        assert!(matches!(first, Err(MarkdownError::TimedOut)));
        assert!(
            took >= TIME_LIMIT && took < TIME_LIMIT + Duration::from_secs(2),
            "{took:?}"
        );
        assert!(matches!(second, Err(MarkdownError::TimedOut)));
        assert!(waited < TIME_LIMIT + Duration::from_secs(1), "{waited:?}");
    });
    converter.convert("ok").unwrap();
}

/// The review's pathological sources fail in the pre-scan, before the
/// import, at well under a millisecond per KB. A 1 MB nested list is not
/// among them: the import writes lists as indented paragraphs, so it makes
/// a valid note, and the deadline is its backstop.
#[test]
fn the_prescan_refuses_pathological_sources_at_once() {
    let mb = 1_000_000;
    let cases = [
        ("200k quote markers", ">".repeat(200_000) + " x", "quotes"),
        (
            "800 KB wide table",
            format!("|{}\n|{}\n", "a|".repeat(200_000), "-|".repeat(200_000)),
            "nodes",
        ),
        ("1M open brackets", "[".repeat(mb), "link brackets"),
        ("250k headings", "# h\n".repeat(mb / 4), "nodes"),
        ("333k emphasis openers", "*a ".repeat(mb / 3), "emphasis"),
    ];
    for (name, source, says) in cases {
        let started = Instant::now();
        let refused = prescan::prescan(&source).unwrap_err();
        let per_kb = started.elapsed().as_secs_f64() * 1e3 / (source.len() as f64 / 1024.0);
        eprintln!(
            "{name}: {} bytes, {per_kb:.4} ms per KB: {refused}",
            source.len()
        );
        assert!(refused.contains(says), "{name}: {refused}");
        assert!(per_kb < 0.5, "{name}: {per_kb} ms per KB");
    }
    // Just under each limit passes the scan.
    for source in [
        format!("{} x", ">".repeat(16)),
        "# h\n".repeat(5_000),
        "[".repeat(10_000),
        format!("{}\n", "a|".repeat(1_000))
            + &format!("{}\n", "-|".repeat(1_000))
            + &"x|".repeat(1_000).repeat(2),
    ] {
        prescan::prescan(&source).unwrap();
    }
}
