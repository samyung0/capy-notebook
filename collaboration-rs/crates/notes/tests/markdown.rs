#![allow(clippy::unwrap_used)] // Tests panic on a broken corpus.
//! Agent markdown through the embedded import against the Node server's
//! converter on the same sources (synthetic constructs and the repository's
//! own markdown pages): the same document and drafts, or the same error, but
//! for the sources whose conversion changed on purpose since ([changed],
//! [now_expected]).
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

/// The Node server's result as the conversion now gives it on purpose: a
/// list nested past `LIST_INDENT_MAX` has its indents clamped to it on entry
/// (Epo 2026-10-19).
fn now_expected(name: &str, expected: &mut Value) {
    if name != "deep list" {
        return;
    }
    for node in expected["document"]["value"].as_array_mut().unwrap() {
        if node["indent"].as_u64().unwrap() > notes::catalog::LIST_INDENT_MAX as u64 {
            node["indent"] = notes::catalog::LIST_INDENT_MAX.into();
        }
    }
}

/// Sources whose conversion changed on purpose after the Node server was
/// frozen, each checked on its own instead: footnotes become text
/// (Epo 2026-10-14), a reference its label in superscript.
fn changed(name: &str, ours: &Value) -> Option<Result<(), String>> {
    match name {
        "footnotes" => {
            let printed = ours.to_string();
            Some(
                if !printed.contains("footnote") && printed.contains(r#""superscript":true"#) {
                    Ok(())
                } else {
                    Err(format!("{name}: footnotes kept as elements: {printed}"))
                },
            )
        }
        _ => None,
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
        if let Some(checked) = changed(name, &ours) {
            failures.extend(checked.err());
            continue;
        }
        now_expected(name, &mut expected);
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

/// Images in agent markdown (notes keep assets only, Epo 2026-10-10): a
/// library figure, `![caption](figure:<id>)`, stays an image whose assetId
/// names the figure until Go stores it as the note's own asset (main
/// 142ca296); any other image becomes a paragraph holding a link, its URL
/// cleared when it is not a valid link. No image keeps a URL, and the note
/// is valid.
#[test]
fn agent_images_keep_figures_and_link_the_rest() {
    let converter = Converter::new(&bundle()).unwrap();
    let source = [
        "![A leaf](figure:fig_1)",
        "![Tangent figure](https://cdn.example/t.png)",
        "![dot](data:image/png;base64,iVBORw0KGgo=) and ![x](javascript:alert(1))",
        "- ![i](diagram.png)",
        "> ![q](https://x.test/q.png)",
    ]
    .join("\n\n");
    let converted = converter.convert(&source).unwrap();
    notes::material::assert_canonical(&converted.document.value, "note").unwrap();
    let mut value = serde_json::to_value(&converted.document.value).unwrap();
    strip_ids(&mut value);
    assert_eq!(
        value[0],
        serde_json::json!({
            "assetId": "figure:fig_1",
            "caption": [{ "text": "A leaf" }],
            "children": [{ "text": "" }],
            "type": "img",
        })
    );
    assert_eq!(
        value[1],
        serde_json::json!({
            "children": [{
                "children": [{ "text": "Tangent figure" }],
                "type": "a",
                "url": "https://cdn.example/t.png",
            }],
            "type": "p",
        })
    );
    let text = value.to_string();
    assert_eq!(text.matches(r#""type":"img""#).count(), 1, "{text}");
    assert!(!text.contains(r#""url":"data:"#), "{text}");
    assert!(!text.contains(r#""url":"javascript:"#), "{text}");
}

fn strip_ids(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("id");
            map.values_mut().for_each(strip_ids);
        }
        Value::Array(items) => items.iter_mut().for_each(strip_ids),
        _ => {}
    }
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
    // A pathological source fails in the pre-scan, before the engine (which
    // here would take it).
    assert!(matches!(
        converter.convert(&">".repeat(200_000)),
        Err(MarkdownError::Invalid(message)) if message.contains("quotes")
    ));
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
    // Two looping conversions: both time out, the second queued behind the
    // first. That the second stops TIME_LIMIT after it was submitted, not
    // after it started, is `markdown::tests::an_expired_job_does_not_run`
    // (a deadline, not a time, so a loaded runner cannot fail it).
    std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            let started = Instant::now();
            (converter.convert("loop"), started.elapsed())
        });
        std::thread::sleep(Duration::from_millis(300));
        let second = converter.convert("loop");
        let (first, took) = first.join().unwrap();
        assert!(matches!(first, Err(MarkdownError::TimedOut)));
        assert!(took >= TIME_LIMIT, "{took:?}");
        assert!(matches!(second, Err(MarkdownError::TimedOut)));
    });
    converter.convert("ok").unwrap();
}

/// The review's pathological sources fail in the pre-scan, before the
/// import (a linear scan). A 1 MB nested list is not
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
        let refused = prescan::prescan(&source).unwrap_err();
        assert!(refused.contains(says), "{name}: {refused}");
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
    // Raw HTML blocks of types 1-5 run to their end marker and the import
    // keeps them as one text, so what they hold is not counted (notes
    // REVIEW2 S5): many blank-separated lines, or a line of quote markers.
    let lines = |n: usize| (0..n).map(|i| format!("line {i}\n\n")).collect::<String>();
    for source in [
        format!("<pre>\n{}</pre>\n", lines(5_001)),
        format!("<pre>\n{} x\n</pre>\n", ">".repeat(20)),
        format!("<!--\n{} x\n-->\n", ">".repeat(20)),
        format!("<script>\n{}</script>\n", lines(5_001)),
        format!("<?php\n{} x\n?>\n", ">".repeat(20)),
        format!("<![CDATA[\n{} x\n]]>\n", ">".repeat(20)),
    ] {
        prescan::prescan(&source).unwrap_or_else(|refused| panic!("{refused}"));
    }
    // A closed block does not hide what follows it.
    let after = format!("<pre>x</pre>\n{} x", ">".repeat(20));
    assert!(prescan::prescan(&after).unwrap_err().contains("quotes"));
    // Types 6-7 (a block tag, a lone complete tag) run to a blank line.
    for source in [
        format!("<div>\n{} x\n</div>\n", ">".repeat(20)),
        format!("<DIV class=\"a\">\n{} x\n", ">".repeat(20)),
        format!("<custom-tag>\n{} x\n", ">".repeat(20)),
    ] {
        prescan::prescan(&source).unwrap_or_else(|refused| panic!("{refused}"));
    }
    let after_blank = format!("<div>\n\n{} x", ">".repeat(20));
    assert!(
        prescan::prescan(&after_blank)
            .unwrap_err()
            .contains("quotes")
    );
}

/// Output nesting past serde_json's 128 levels (a list item opening 70
/// quotes, which the scan leaves to the import) is invalid input naming the
/// depth limit, through the real bundle.
#[test]
fn deep_output_is_invalid_input() {
    let converter = Converter::new(&bundle()).unwrap();
    let source = format!("- {}", ">".repeat(70));
    match converter.convert(&source) {
        Err(MarkdownError::Invalid(message)) => {
            assert!(
                message.contains("nests deeper than a note allows"),
                "{message}"
            );
        }
        other => panic!("{other:?}"),
    }
}
