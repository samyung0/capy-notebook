#![allow(clippy::unwrap_used)] // Tests panic on a broken fixture.
//! The browser and server parity corpus (live-items REVIEW1 S5). The server
//! seeds a quiz's two documents and a set's document from stored JSON; the
//! browser reads them (`src/features/quizzes/parity.test.ts` checks
//! `tests/parity/rust.json`). The browser writes questions and cards into
//! fresh documents; the server reads them (`tests/parity/ts.json`, checked
//! here). Each side regenerates its own file with `PARITY_WRITE=1` and fails
//! when the committed one is stale.

use serde_json::{Value, json};
use yrs::types::ToJson;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, Transact, Update};

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/parity");

/// Every quiz-policy fixture the Go validator accepts, ids made unique.
fn fixtures() -> Vec<Value> {
    let dir = format!(
        "{}/../../../server/internal/questions/testdata",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut names: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|e| e == "json"))
        .collect();
    names.sort();
    let mut out = Vec::new();
    for path in names {
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        if fixture["valid"] != json!(true) || fixture["policy"] != json!({}) {
            continue;
        }
        let mut question = fixture["question"].clone();
        if question.get("parts").and_then(Value::as_array).is_none() {
            continue;
        }
        let n = out.len();
        question["id"] = json!(format!("q{n}"));
        for part in question["parts"].as_array_mut().unwrap() {
            part["id"] = json!(format!("q{n}-{}", part["id"].as_str().unwrap()));
        }
        out.push(question);
    }
    out
}

fn cards() -> Value {
    json!([
        { "id": "c1", "front": "Osmosis", "back": "Water across a membrane, $x^2$." },
        { "id": "c2", "front": "Diffusion", "back": "", "image": { "assetId": "asset_1" } },
        { "id": "c3", "front": "Ünïcødé 漢字 😀", "back": "line one\nline two" },
    ])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn load(state: &str) -> Doc {
    let doc = Doc::with_options(ydoc::doc_options(1));
    doc.transact_mut()
        .apply_update(Update::decode_v1(&unhex(state)).unwrap())
        .unwrap();
    doc
}

fn set_value(cards: &Value) -> Vec<Value> {
    vec![json!({
        "type": "flashcards",
        "id": "flashcards",
        "children": cards.as_array().unwrap().iter().map(|card| {
            let mut node = json!({
                "type": "flashcard",
                "id": card["id"],
                "children": [
                    { "type": "flashcard_front", "children": [{ "text": card["front"] }] },
                    { "type": "flashcard_back", "children": [{ "text": card["back"] }] },
                ],
            });
            if let Some(image) = card.get("image") {
                node["image"] = image.clone();
            }
            node
        }).collect::<Vec<_>>(),
    })]
}

/// A document's roots as JSON: what a writer put there, whatever order its
/// structs (or a value's map keys) were encoded in.
fn roots(state: &str) -> Value {
    let doc = load(state);
    let txn = doc.transact();
    let mut out = serde_json::Map::new();
    for (name, root) in txn.root_refs() {
        out.insert(
            name.to_owned(),
            serde_json::to_value(root.to_json(&txn)).unwrap(),
        );
    }
    Value::Object(out)
}

fn corpus(name: &str) -> String {
    std::fs::read_to_string(format!("{DIR}/{name}"))
        .unwrap()
        .replace("\r\n", "\n")
}

#[test]
fn the_server_corpus_is_current() {
    let questions: Vec<Value> = fixtures()
        .into_iter()
        .map(|question| {
            let value = vec![json!({
                "type": "quiz", "id": "quiz",
                "children": [{ "type": "quiz_question", "id": question["id"], "question": question, "children": [{ "text": "" }] }],
            })];
            let (content, keys) = items::quiz::states_from_value(&value, 0);
            json!({ "question": question, "content": hex(&content), "keys": hex(&keys) })
        })
        .collect();
    let cards = cards();
    let set = items::flashcards::state_from_value(&set_value(&cards), 0);
    let written = serde_json::to_string_pretty(&json!({
        "questions": questions,
        "cards": cards,
        "set": hex(&set),
    }))
    .unwrap()
        + "\n";
    if std::env::var_os("PARITY_WRITE").is_some() {
        std::fs::write(format!("{DIR}/rust.json"), &written).unwrap();
    }
    // A chart's value is a map whose keys yrs encodes in hash order, so the
    // documents are compared, not their bytes.
    let committed: Value = serde_json::from_str(&corpus("rust.json")).unwrap();
    let fresh: Value = serde_json::from_str(&written).unwrap();
    let stale = "tests/parity/rust.json is stale: rerun with PARITY_WRITE=1";
    assert_eq!(
        committed["questions"].as_array().map(Vec::len),
        fresh["questions"].as_array().map(Vec::len),
        "{stale}"
    );
    for (old, new) in committed["questions"]
        .as_array()
        .unwrap()
        .iter()
        .zip(fresh["questions"].as_array().unwrap())
    {
        assert_eq!(old["question"], new["question"], "{stale}");
        for doc in ["content", "keys"] {
            assert_eq!(
                roots(old[doc].as_str().unwrap()),
                roots(new[doc].as_str().unwrap()),
                "{stale}"
            );
        }
    }
    assert_eq!(committed["cards"], fresh["cards"], "{stale}");
    assert_eq!(
        roots(committed["set"].as_str().unwrap()),
        roots(fresh["set"].as_str().unwrap()),
        "{stale}"
    );
}

#[test]
fn the_server_reads_what_the_browser_writes() {
    let browser: Value = serde_json::from_str(&corpus("ts.json")).unwrap();
    let entries = browser["questions"].as_array().unwrap();
    assert_eq!(entries.len(), fixtures().len(), "ts.json is stale");
    for entry in entries {
        let content = load(entry["content"].as_str().unwrap());
        let keys = load(entry["keys"].as_str().unwrap());
        let read = items::quiz::questions_json(
            &content.transact(),
            Some(&items::quiz::KeysRead::new(&keys.transact())),
        );
        assert_eq!(read, vec![entry["question"].clone()]);
    }
    let set = load(browser["set"].as_str().unwrap());
    let read: Vec<Value> = items::flashcards::cards(&set.transact())
        .into_iter()
        .map(|card| {
            let mut value = json!({ "id": card.id, "front": card.front, "back": card.back });
            if let Some(asset) = card.image {
                value["image"] = json!({ "assetId": asset });
            }
            value
        })
        .collect();
    assert_eq!(Value::Array(read), browser["cards"]);
}
