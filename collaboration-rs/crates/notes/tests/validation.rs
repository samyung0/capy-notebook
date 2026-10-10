#![allow(clippy::unwrap_used)] // Tests panic on a broken corpus.
//! Material document and question validation against the Node server on the
//! corpus: the shared Go/TS question fixtures, every fixture note, quiz and
//! flashcard set under each material kind, random structural damage to them,
//! and the bank-asset host rules. Outcomes match exactly; messages match
//! except where zod raised the error (its message is its issue list), and
//! except the rules the Rust store took from Go and the browser after the
//! Node server was frozen ([tightened]).
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

/// A case the Rust store refuses where the Node server accepted (or refused
/// for another reason), by the rules it took from Go and the browser at the
/// cutover: Go's card limits and image shape, media naming their asset
/// (Epo, 2026-10-10), and `diagram`/`mindmap` no longer node types.
fn tightened(ours: &Result<(), String>, value: &Value) -> bool {
    fn has_type(node: &Value, kinds: &[&str]) -> bool {
        node["type"]
            .as_str()
            .is_some_and(|kind| kinds.contains(&kind))
            || node["children"]
                .as_array()
                .is_some_and(|children| children.iter().any(|child| has_type(child, kinds)))
    }
    let Err(message) = ours else { return false };
    let message = message.trim_start_matches("invalid material document: ");
    message.starts_with("a flashcard front holds at most")
        || message.starts_with("a flashcard back holds at most")
        || message == "flashcard image must be {assetId}"
        || message.ends_with("requires an assetId")
        || message.ends_with("cannot contain url")
        || message.ends_with("cannot contain src")
        || value.as_array().is_some_and(|nodes| {
            nodes
                .iter()
                .any(|node| has_type(node, &["diagram", "mindmap"]))
        })
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
    let mut tightenings = 0;
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
        if tightened(&ours, &case["value"]) {
            tightenings += 1;
            continue;
        }
        compare(&at, ours, &case["outcome"], &mut failures);
    }
    let cases = corpus["cases"].as_array().unwrap();
    let refused = cases.iter().filter(|c| c["outcome"]["ok"] == false).count();
    let messages = cases
        .iter()
        .filter(|c| c["outcome"]["zod"] == false)
        .count();
    eprintln!(
        "{} question fixtures, {} material cases ({refused} refused, {messages} with the message compared, {tightenings} refused by the cutover's tightenings)",
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
/// whole number from 20 to 100 (Epo, 2026-10-08; plate-2 3a87184d's refused
/// values), on an accepted corpus node of each kind.
#[test]
fn resizable_blocks_take_only_the_widths_the_handles_write() {
    let corpus = common::load("validation");
    for kind in ["img", "video", "mermaid", "chart", "graph"] {
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
            json!(50),
            Value::Null,
            json!("19%"),
            json!("101%"),
            json!("50px"),
            json!("50.5%"),
            json!("050%"),
            json!("50"),
            json!(" 50%"),
        ] {
            let refused = with_width(width.clone()).unwrap_err();
            assert_eq!(
                refused.0, "width must be a whole percentage from 20 to 100",
                "{kind} {width}"
            );
        }
    }
}

/// The every-block note shared with Go (TestEveryBlockNoteFixtureIsValid)
/// and the UAT note journey: every node type a note stores is accepted.
#[test]
fn the_every_block_note_is_valid() {
    let path = format!(
        "{}/../../../server/internal/materialdoc/testdata/every-block-note.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    material::assert_canonical(fixture["value"].as_array().unwrap(), "note").unwrap();
}

fn card(front: &str, back: &str, image: Option<Value>) -> Value {
    let mut card = json!({
        "children": [
            { "children": [{ "text": front }], "type": "flashcard_front" },
            { "children": [{ "text": back }], "type": "flashcard_back" },
        ],
        "id": "c1",
        "type": "flashcard",
    });
    if let Some(image) = image {
        card["image"] = image;
    }
    card
}

fn set(card: Value) -> Result<(), String> {
    let value = [json!({ "children": [card], "id": "s1", "type": "flashcards" })];
    material::assert_canonical(&value, "flashcards").map_err(|error| error.0)
}

/// A stored set holds only what Go projects (security regression: a stored
/// set Go cannot project breaks the material for everyone): a front of at
/// most 4,000 characters and a back of at most 2,000, counted as Go counts
/// runes, and an image exactly `{assetId}` with a non-blank id of at most 128.
#[test]
fn a_card_holds_what_go_projects() {
    // Astral characters count once, as Go's runes.
    let front = "\u{1F600}".repeat(material::CARD_FRONT_MAX);
    let back = "\u{1F600}".repeat(material::CARD_BACK_MAX);
    set(card(
        &front,
        &back,
        Some(json!({ "assetId": "a".repeat(128) })),
    ))
    .unwrap();
    assert_eq!(
        set(card(&format!("{front}x"), "b", None)).unwrap_err(),
        "a flashcard front holds at most 4000 characters"
    );
    assert_eq!(
        set(card("f", &format!("{back}x"), None)).unwrap_err(),
        "a flashcard back holds at most 2000 characters"
    );
    for image in [
        json!({ "assetId": "" }),
        json!({ "assetId": "  " }),
        json!({ "assetId": "a".repeat(129) }),
        json!({ "assetId": "a1", "url": "https://x.test/a.png" }),
        json!({ "url": "https://x.test/a.png" }),
        json!("a1"),
    ] {
        assert_eq!(
            set(card("f", "b", Some(image.clone()))).unwrap_err(),
            "flashcard image must be {assetId}",
            "{image}"
        );
    }
}

/// An image, audio or file block stores its asset id and no URL, as the
/// browser and Go refuse otherwise (Epo, 2026-10-10).
#[test]
fn a_media_block_names_its_asset() {
    let note = |node: Value| material::assert_canonical(&[node], "note").map_err(|error| error.0);
    for kind in ["img", "image", "audio", "file"] {
        let node = |extra: Value| {
            let mut node = json!({ "children": [{ "text": "" }], "id": "m1", "type": kind });
            for (key, value) in extra.as_object().unwrap() {
                node[key] = value.clone();
            }
            node
        };
        note(node(json!({ "assetId": "a1" }))).unwrap();
        note(node(json!({ "assetId": "a1", "url": null }))).unwrap();
        assert_eq!(
            note(node(json!({}))).unwrap_err(),
            format!("{kind} requires an assetId")
        );
        assert_eq!(
            note(node(json!({ "assetId": "" }))).unwrap_err(),
            format!("{kind} requires an assetId")
        );
        for key in ["url", "src"] {
            let mut linked = node(json!({ "assetId": "a1" }));
            linked[key] = json!("https://x.test/a.png");
            assert_eq!(
                note(linked).unwrap_err(),
                format!("{kind} cannot contain {key}")
            );
        }
    }
}

/// `diagram` and `mindmap` are material kinds, not node types: their
/// material holds a `mermaid` block.
#[test]
fn diagram_and_mindmap_are_not_node_types() {
    let block = |kind: &str| {
        json!({
            "children": [{ "children": [{ "text": "" }], "type": "mermaid_caption" }],
            "id": "d1",
            "source": "graph TD; a-->b",
            "type": kind,
        })
    };
    for kind in ["mindmap", "diagram"] {
        material::assert_canonical(&[block("mermaid")], kind).unwrap();
        assert_eq!(
            material::assert_canonical(&[block(kind)], kind)
                .unwrap_err()
                .0,
            format!("{kind} element is required")
        );
    }
}
