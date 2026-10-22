#![allow(clippy::unwrap_used)] // Tests panic on a broken corpus.
//! Agent edit commands, inspect, text-source commands, the replace-block
//! command and the children pass, replayed on the states the Node server saw
//! (tests/corpus/{edits,children,commands,inspect}.json.gz): the same result
//! or refusal (code and message) and the same Plate value after. The corpus's
//! inverse commands and guards (Node's stored Undo), and the offset-anchored
//! spans only an inverse used, are left out: an edit's Undo now reverts its
//! Yjs items in the live room (`ydoc::undo`).
mod common;

use notes::children::{self, ChildAnswer};
use notes::commands::{self, ReplaceBlock};
use notes::edit::{self, DocumentCommand, EditError, EditOutcome};
use notes::{plate, slate_yjs};
use serde_json::{Value, json};
use yrs::{Any, GetString, ReadTxn, Transact, Xml, XmlTextRef};

/// JSON equality as JS sees it: key order aside, numbers by value.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(v, w)| same(v, w))
        }
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

/// The Plate value of a state, as the corpus hashes it.
fn value_hash(doc: &yrs::Doc) -> String {
    common::hash(&Value::Array(plate::value(&doc.transact()).unwrap()))
}

#[derive(Default)]
struct Tally {
    steps: usize,
    updates: usize,
    same_bytes: usize,
    raw_bytes: usize,
}

fn outcome_json(result: &Result<Value, EditError>) -> Value {
    match result {
        Ok(ok) => json!({ "ok": ok }),
        Err(EditError::Edit {
            code,
            message,
            details,
        }) => {
            let mut error = json!({ "code": code, "message": message });
            if let Some(details) = details {
                error["details"] = details.clone();
            }
            json!({ "error": error })
        }
        Err(EditError::Editor(error)) => json!({ "thrown": error.to_string() }),
    }
}

/// One recorded step: what Rust does on the same state, compared.
fn replay_step(
    script: &str,
    index: usize,
    step: &Value,
    text_source: bool,
    tally: &mut Tally,
    failures: &mut Vec<String>,
) {
    let at = format!("{script} step {index}");
    let action = &step["action"];
    let kind = action["kind"].as_str().unwrap_or("none");
    let doc = common::doc(
        &common::bytes(&step["state"]),
        step["client"].as_u64().unwrap(),
    );
    let root = doc.get_or_insert_text(if text_source {
        "source"
    } else {
        plate::CONTENT_ROOT
    });
    let before = doc.transact().state_vector();
    // An offset-anchored span is the form only Node's stored Undo sent, and
    // set_property was set_mermaid's, gone since (Epo 2026-10-21).
    let dropped = action["commands"].as_array().is_some_and(|commands| {
        commands
            .iter()
            .any(|c| c.get("offset").is_some() || c["type"] == "set_property")
    });
    if kind == "apply" && dropped {
        return;
    }
    // A Mermaid block's expected text is its source since 2026-10-22 (Node
    // compared its caption), and a rewrite keeps its caption and width:
    // mermaid_source.rs covers them.
    let mermaid = |id: &Value| {
        plate::value(&doc.transact())
            .unwrap()
            .iter()
            .any(|block| block["type"] == "mermaid" && &block["id"] == id)
    };
    if kind == "apply"
        && action["commands"]
            .as_array()
            .is_some_and(|commands| commands.iter().any(|c| mermaid(&c["blockId"])))
    {
        return;
    }
    let result: Result<Value, EditError> = match kind {
        "apply" => {
            let list: Vec<DocumentCommand> =
                serde_json::from_value(action["commands"].clone()).unwrap();
            let mut txn = doc.transact_mut();
            if text_source {
                edit::apply_text_commands(&mut txn, &root, &list)
                    .map(|()| json!({ "text": root.get_string(&txn) }))
            } else {
                edit::apply_material_commands(&mut txn, &root, &list)
                    .map(|outcome: EditOutcome| serde_json::to_value(outcome).unwrap())
            }
        }
        // Node's stored Undo: its inverse applied, its guards checked.
        "undo" | "verify" => return,
        "inspect" => edit::inspect_material(&doc.transact())
            .map(|blocks| serde_json::to_value(blocks).unwrap()),
        "edit" => {
            common::apply(&doc, &common::bytes(&step["update"]));
            Ok(Value::String(root.get_string(&doc.transact())))
        }
        // A random step that chose nothing (`skipped` or `kept`).
        _ => Ok(step["ok"].clone()),
    };
    tally.steps += 1;
    let mut ours = outcome_json(&result);
    // Every refused material span carries its block and a text source's
    // ambiguous one its lines (2026-10-14); Node's carried none.
    if step["error"].get("details").is_none()
        && ours["error"]["message"]
            .as_str()
            .is_some_and(|m| m.starts_with("expected"))
        && let Some(error) = ours["error"].as_object_mut()
    {
        error.remove("details");
    }
    let theirs = if step.get("ok").is_some() {
        let mut ok = step["ok"].clone();
        if let Some(ok) = ok.as_object_mut() {
            ok.remove("guards");
            ok.remove("inverse");
        }
        json!({ "ok": ok })
    } else if step.get("error").is_some() {
        json!({ "error": step["error"] })
    } else {
        json!({ "thrown": step["thrown"] })
    };
    // Refusals relaxed since (Epo 2026-10-21): an edit removes or replaces a
    // block holding media, and the last block (the server then gives a note
    // its empty paragraph).
    if ours.get("ok").is_some()
        && step["error"]["message"].as_str().is_some_and(|message| {
            [
                "blocks holding media cannot be removed by an edit",
                "blocks holding media cannot be replaced by an edit",
                "a material must keep at least one block",
            ]
            .contains(&message)
        })
    {
        return;
    }
    let ok = ours.get("ok").is_some() && theirs.get("ok").is_some();
    if !ok {
        if !same(&ours, &theirs) {
            failures.push(format!("{at}: {ours} != JS {theirs}"));
        }
        return;
    }
    let update = doc.transact().encode_state_as_update_v1(&before);
    tally.updates += 1;
    let raw_match = update == common::bytes(&step["update"]);
    tally.raw_bytes += usize::from(raw_match);
    let bytes_match = raw_match || common::same_update(&update, &common::bytes(&step["update"]));
    if !bytes_match && std::env::var("EDITS_DEBUG").is_ok_and(|n| at.contains(&n)) {
        use yrs::updates::decoder::Decode;
        eprintln!(
            "{at} {kind}
  js:   {:?}
  rust: {:?}",
            yrs::Update::decode_v1(&common::bytes(&step["update"])).unwrap(),
            yrs::Update::decode_v1(&update).unwrap()
        );
    }
    tally.same_bytes += usize::from(bytes_match);
    let (ours, theirs) = (&ours["ok"], &theirs["ok"]);
    if !same(ours, theirs) {
        failures.push(format!("{at}: result {ours} != JS {theirs}"));
    }
    if !text_source && step.get("value").is_some() {
        let js_value = Value::Array(step["value"].as_array().unwrap().clone());
        if value_hash(&doc) != common::hash(&js_value) {
            failures.push(format!(
                "{at}: value {} != JS {js_value}",
                Value::Array(plate::value(&doc.transact()).unwrap())
            ));
        }
    }
}

#[test]
fn edit_commands_match_the_node_server() {
    let corpus = common::load("edits");
    let mut failures = Vec::new();
    let mut tally = Tally::default();
    for (key, text_source) in [("material", false), ("text", true)] {
        for script in corpus[key].as_array().unwrap() {
            let name = script["name"].as_str().unwrap();
            let steps = script["steps"].as_array().unwrap();
            for (index, step) in steps.iter().enumerate() {
                replay_step(name, index, step, text_source, &mut tally, &mut failures);
            }
        }
    }
    eprintln!(
        "{} steps, {} with a result: {} updates with the same items ({} byte-identical)",
        tally.steps, tally.updates, tally.same_bytes, tally.raw_bytes
    );
    assert!(
        failures.is_empty(),
        "{} failures: {failures:#?}",
        failures.len()
    );
}

/// A gone id's listing cuts each preview at 80 UTF-16 units; a cut inside a
/// surrogate pair keeps the whole character (Node keeps its high half, which
/// a Rust string cannot hold), so that preview is 81 units.
#[test]
fn a_listing_preview_cut_inside_an_emoji_keeps_it_whole() {
    let kept = format!("{}\u{1F600}", "a".repeat(79));
    let value =
        [json!({ "type": "p", "id": "b1", "children": [{ "text": format!("{kept}tail") }] })];
    let doc = common::doc(&notes::slate_yjs::state_from_value(&value, 3), 4);
    let root = doc.get_or_insert_text(plate::CONTENT_ROOT);
    let refusal = edit::apply_material_commands(
        &mut doc.transact_mut(),
        &root,
        &[DocumentCommand::RemoveBlock {
            block_id: "gone".into(),
            expected_text: "x".into(),
        }],
    );
    let Err(EditError::Edit {
        details: Some(details),
        ..
    }) = refusal
    else {
        panic!("expected a refusal with details, got {refusal:?}");
    };
    let preview = details["blocks"][0]["text"].as_str().unwrap();
    assert_eq!(preview, kept);
    assert_eq!(preview.encode_utf16().count(), 81);
    // An inspection lists the same way (a material rebuilt since it was read).
    let blocks = edit::inspect_material(&doc.transact()).unwrap();
    assert_eq!(edit::listing(&blocks), details);
}

/// Refusals the agent retries carry the target as it reads now (2026-10-14):
/// an expected text that occurs more than once comes with its block.
#[test]
fn ambiguous_spans_carry_the_current_block() {
    let text = "the cell and the cell wall";
    let doc = common::doc(
        &notes::slate_yjs::state_from_value(
            &[json!({ "type": "p", "id": "b1", "children": [{ "text": text }] })],
            3,
        ),
        4,
    );
    let root = doc.get_or_insert_text(plate::CONTENT_ROOT);
    let refusal = edit::apply_material_commands(
        &mut doc.transact_mut(),
        &root,
        &[DocumentCommand::ReplaceText {
            block_id: Some("b1".into()),
            expected_text: "the cell".into(),
            text: "a cell".into(),
        }],
    );
    let Err(EditError::Edit {
        code,
        message,
        details,
    }) = refusal
    else {
        panic!("expected a refusal, got {refusal:?}");
    };
    assert_eq!(
        (json!(code), message.as_str(), details),
        (
            json!("invalid_input"),
            "expected text occurs 2 times; include more context",
            Some(json!({ "block": { "id": "b1", "text": text, "type": "p" } })),
        )
    );
}

/// A text source's expected text that occurs more than once comes back with
/// the lines it occurs in (`start`, the line's UTF-16 offset, as inspect
/// pages lines), each once and at most 20, a line's text cut after 1,000
/// characters with a trailing `…`; one not found carries nothing (Epo
/// 2026-10-14). A long line holding thousands of occurrences is listed once
/// and cut, so the refusal stays small.
#[test]
fn an_ambiguous_text_source_span_lists_the_lines_it_occurs_in() {
    use yrs::Text as _;
    let refusal = |text: &str, expected: &str| {
        let doc = yrs::Doc::new();
        let root = doc.get_or_insert_text("source");
        root.insert(&mut doc.transact_mut(), 0, text);
        let command = DocumentCommand::ReplaceText {
            block_id: None,
            expected_text: expected.into(),
            text: "x".into(),
        };
        match edit::apply_text_commands(&mut doc.transact_mut(), &root, &[command]) {
            Err(EditError::Edit {
                message, details, ..
            }) => (message, details),
            other => panic!("expected a refusal, got {other:?}"),
        }
    };
    let (message, details) = refusal("\u{1F600} cat\nthe cat and a cat\nend", "cat");
    assert_eq!(
        message,
        "expected text occurs 3 times; include more context"
    );
    assert_eq!(
        details,
        Some(json!({ "lines": [
            { "start": 0, "text": "\u{1F600} cat" },
            { "start": 7, "text": "the cat and a cat" },
        ] }))
    );
    let long = "\u{e9}cat ".repeat(5_000);
    let (message, details) = refusal(&format!("{long}\nend cat"), "cat");
    assert_eq!(
        message,
        "expected text occurs 5001 times; include more context"
    );
    assert_eq!(
        details,
        Some(json!({ "lines": [
            { "start": 0, "text": format!("{}\u{2026}", "\u{e9}cat ".repeat(200)) },
            { "start": 25_001, "text": "end cat" },
        ] }))
    );
    let lines = refusal(&"cat\n".repeat(25), "cat").1.unwrap()["lines"].clone();
    assert_eq!(lines.as_array().map(Vec::len), Some(20));
    assert_eq!(lines[19], json!({ "start": 76, "text": "cat" }));
    assert_eq!(refusal("a cat", "dog").1, None);
}

/// A library figure arrives as an `img` naming the editor asset Go stored for
/// the note before the edit (`figure:<id>` in agent markdown): an edit may
/// insert it, at the top level or inside a block. Any other media (a URL
/// image, an audio block, an asset id on a non-image) is still
/// refused, as Node refused all of it.
#[test]
fn an_edit_inserts_a_figure_image_and_no_other_media() {
    let value = [json!({ "type": "p", "id": "b1", "children": [{ "text": "intro" }] })];
    let insert = |block: Value| {
        let doc = common::doc(&notes::slate_yjs::state_from_value(&value, 3), 4);
        let root = doc.get_or_insert_text(plate::CONTENT_ROOT);
        let result = edit::apply_material_commands(
            &mut doc.transact_mut(),
            &root,
            &[DocumentCommand::InsertBlock {
                after_block_id: Some("b1".into()),
                blocks: vec![block],
            }],
        );
        result.map(|_| ()).map_err(|error| match error {
            EditError::Edit { message, .. } => message,
            other => other.to_string(),
        })
    };
    let figure = json!({
        "assetId": "ea_figure", "caption": [{ "text": "A leaf" }],
        "children": [{ "text": "" }], "id": "f1", "type": "img",
    });
    insert(figure.clone()).unwrap();
    insert(json!({ "children": [figure.clone(), { "text": "" }], "id": "p2", "type": "p" }))
        .unwrap();
    let refused = "media nodes cannot be inserted by an edit";
    for media in [
        json!({ "children": [{ "text": "" }], "id": "f2", "type": "img", "url": "https://x.test/a.png" }),
        json!({ "assetId": "", "children": [{ "text": "" }], "id": "f3", "type": "img" }),
        json!({ "assetId": "ea_1", "children": [{ "text": "" }], "id": "f4", "type": "audio" }),
        json!({ "assetId": "ea_1", "children": [{ "text": "x" }], "id": "f5", "type": "p" }),
    ] {
        assert_eq!(insert(media.clone()), Err(refused.to_owned()), "{media}");
    }
}

/// The live Undo of an edit that placed a library figure removes it again
/// (the room reverts the edit's own items; the children pass then lets the
/// asset go). (The deleted `undo_removes_the_figure_its_edit_inserted`, for
/// the live Undo.)
#[test]
fn undo_removes_the_figure_its_edit_inserted() {
    use yrs::updates::decoder::Decode;
    let value = vec![json!({ "type": "p", "id": "b1", "children": [{ "text": "intro" }] })];
    let room = common::doc(&notes::slate_yjs::state_from_value(&value, 3), 4);
    let figure = json!({
        "assetId": "ea_figure", "caption": [{ "text": "A leaf" }],
        "children": [{ "text": "" }], "id": "f1", "type": "img",
    });
    let scratch = common::doc(&common::state(&room), 9);
    let root = scratch.get_or_insert_text(plate::CONTENT_ROOT);
    let captured = {
        let mut txn = scratch.transact_mut();
        edit::apply_material_commands(
            &mut txn,
            &root,
            &[DocumentCommand::InsertBlock {
                after_block_id: Some("b1".into()),
                blocks: vec![figure],
            }],
        )
        .unwrap();
        ydoc::undo::Captured::of(&mut txn)
    };
    let update = scratch
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    ydoc::undo::apply_kept(&room, yrs::Update::decode_v1(&update).unwrap()).unwrap();
    ydoc::undo::revert(&room, captured.change(&room)).unwrap();
    assert_eq!(plate::value(&room.transact()).unwrap(), value);
}

/// An agent edit removes or replaces any note block, media included (Epo
/// 2026-10-21): an image or placed figure, audio and a YouTube video, and
/// the last block, which leaves the root empty here (the server's compute
/// adds the note's empty paragraph). Inserting media other than a library
/// figure stays refused. Fails if the media refusal comes back.
#[test]
fn an_edit_removes_or_replaces_media_and_the_last_block() {
    let media = [
        json!({ "type": "img", "id": "i1", "assetId": "ea_1", "children": [{ "text": "" }] }),
        json!({ "type": "audio", "id": "a1", "assetId": "ea_2", "children": [{ "text": "" }] }),
        json!({
            "type": "video", "id": "v1", "provider": "youtube", "videoId": "dQw4w9WgXcQ",
            "children": [{ "text": "" }],
        }),
    ];
    let apply = |value: &[Value], command: DocumentCommand| {
        let doc = common::doc(&notes::slate_yjs::state_from_value(value, 3), 4);
        let root = doc.get_or_insert_text(plate::CONTENT_ROOT);
        // The write transaction ends with this statement, before the read.
        let applied = edit::apply_material_commands(&mut doc.transact_mut(), &root, &[command]);
        applied.map(|_| plate::value(&doc.transact()).unwrap())
    };
    let paragraph = |id: &str| json!({ "type": "p", "id": id, "children": [{ "text": "kept" }] });
    for block in &media {
        let id = block["id"].as_str().unwrap();
        let value = [paragraph("b1"), block.clone()];
        let removed = apply(
            &value,
            DocumentCommand::RemoveBlock {
                block_id: id.into(),
                expected_text: String::new(),
            },
        )
        .unwrap();
        assert_eq!(removed, [paragraph("b1")], "{id}");
        let replaced = apply(
            &value,
            DocumentCommand::ReplaceBlock {
                block_id: id.into(),
                expected_text: String::new(),
                blocks: vec![paragraph("n1")],
            },
        )
        .unwrap();
        assert_eq!(replaced, [paragraph("b1"), paragraph("n1")], "{id}");
    }
    let emptied = apply(
        &[paragraph("b1")],
        DocumentCommand::RemoveBlock {
            block_id: "b1".into(),
            expected_text: "kept".into(),
        },
    )
    .unwrap();
    // A root with no block reads as one empty text.
    assert_eq!(emptied, [json!({ "text": "" })]);
    let inserted = apply(
        &[paragraph("b1")],
        DocumentCommand::ReplaceBlock {
            block_id: "b1".into(),
            expected_text: "kept".into(),
            blocks: vec![media[1].clone()],
        },
    );
    assert!(
        matches!(&inserted, Err(EditError::Edit { message, .. }) if message == "media nodes cannot be inserted by an edit"),
        "{inserted:?}"
    );
}

/// The agent's rewrite of image `i1` in a note holding `image` as one
/// block: the note after it.
fn rewrite_image(image: Value, retitle: Option<&str>, rewrite: Value) -> Vec<Value> {
    let doc = common::doc(&slate_yjs::state_from_value(&[image], 1), 2);
    let inspected = edit::inspect_material(&doc.transact()).unwrap();
    if let Some(caption) = retitle {
        // Someone retitles the picture after the agent's inspect.
        let element = {
            let txn = doc.transact();
            let root = plate::content_root(&txn).unwrap();
            match &plate::insert_delta(&root).unwrap()[0].insert {
                plate::Insert::Element(branch) => XmlTextRef::from(*branch),
                plate::Insert::Text(_) => panic!("not a block"),
            }
        };
        let retitled: Any = serde_json::from_value(json!([{ "text": caption }])).unwrap();
        element.insert_attribute(&mut doc.transact_mut(), "caption", retitled);
    }
    let root = doc.get_or_insert_text(plate::CONTENT_ROOT);
    edit::apply_material_commands(
        &mut doc.transact_mut(),
        &root,
        &[DocumentCommand::ReplaceBlock {
            block_id: "i1".into(),
            expected_text: inspected[0].text.clone(),
            blocks: vec![rewrite],
        }],
    )
    .unwrap();
    plate::value(&doc.transact()).unwrap()
}

fn image(id: &str, asset: &str, caption: Option<&str>) -> Value {
    let mut image =
        json!({ "assetId": asset, "children": [{ "text": "" }], "id": id, "type": "img" });
    if let Some(caption) = caption {
        image["caption"] = json!([{ "text": caption }]);
    }
    image
}

/// An agent edit never changes a block's caption and never compares it (Epo
/// 2026-10-22): an image rewritten with its file kept keeps the caption
/// someone changed after the inspect, and the width, over the caption the
/// agent wrote. Fails if a rewrite takes the agent's caption or loses the
/// width.
#[test]
fn an_image_rewrite_keeping_its_file_keeps_the_caption_someone_changed() {
    let mut old = image("i1", "ea_1", Some("Old"));
    old["width"] = json!("40%");
    let value = rewrite_image(old, Some("New"), image("i2", "ea_1", Some("The agent's")));
    assert_eq!(value[0]["id"], "i2");
    assert_eq!(value[0]["caption"], json!([{ "text": "New" }]));
    assert_eq!(value[0]["width"], "40%");
}

/// An image swapped for a different picture or library figure is a new
/// block with its own caption and credit (Epo 2026-10-22, refining the
/// caption rule): an uncaptioned image swapped for a figure gets the
/// figure's credit, and figure A swapped for figure B shows B's credit, not
/// A's. Fails if a swap keeps the old caption.
#[test]
fn a_swapped_picture_brings_its_own_caption_and_credit() {
    let credited = "Mitosis (credit: OpenStax Biology, CC BY 4.0)";
    let value = rewrite_image(
        image("i1", "ea_upload", None),
        None,
        image("i2", "ea_fig_b", Some(credited)),
    );
    assert_eq!(value[0]["caption"], json!([{ "text": credited }]));
    let value = rewrite_image(
        image("i1", "ea_fig_a", Some("Cell cycle (credit: NASA)")),
        None,
        image("i2", "ea_fig_b", Some(credited)),
    );
    assert_eq!(value[0]["assetId"], "ea_fig_b");
    assert_eq!(value[0]["caption"], json!([{ "text": credited }]));
}

#[test]
fn inspect_matches_the_node_server() {
    let corpus = common::load("inspect");
    let mut failures = Vec::new();
    // Object properties print as JSON text: compare them parsed.
    let parse = |mut v: Value| {
        for block in v.as_array_mut().unwrap() {
            if let Some(text) = block.pointer("/properties/block").and_then(Value::as_str) {
                let parsed: Value = serde_json::from_str(text).unwrap();
                block["properties"]["block"] = parsed;
            }
            if let Some(children) = block.get_mut("children").and_then(Value::as_array_mut) {
                for child in children {
                    if child["type"] == "quiz_question" {
                        let parsed: Value =
                            serde_json::from_str(child["text"].as_str().unwrap()).unwrap();
                        child["text"] = parsed;
                    }
                }
            }
        }
        v
    };
    // A card's sides print as JSON since 2026-10-21; Node ran them together.
    let joined = |mut v: Value| {
        for block in v.as_array_mut().unwrap() {
            for child in block
                .get_mut("children")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                if child["type"] == "flashcard" {
                    let sides: Value =
                        serde_json::from_str(child["text"].as_str().unwrap()).unwrap();
                    child["text"] = json!(format!(
                        "{}{}",
                        sides["front"].as_str().unwrap(),
                        sides["back"].as_str().unwrap()
                    ));
                }
            }
        }
        v
    };
    // A Mermaid block's text is its source since 2026-10-22, its caption
    // printed apart; Node printed the caption as its text.
    let captioned = |mut v: Value| {
        for block in v.as_array_mut().unwrap() {
            if block["type"] == "mermaid" {
                let caption = block.pointer("/properties/caption").cloned();
                block["properties"] = json!({ "source": block["text"] });
                block["text"] = caption.unwrap_or(json!(""));
            }
        }
        v
    };
    for case in corpus.as_array().unwrap() {
        let doc = common::doc(&common::bytes(&case["state"]), 99);
        let ours = serde_json::to_value(edit::inspect_material(&doc.transact()).unwrap()).unwrap();
        if !same(
            &parse(captioned(joined(ours.clone()))),
            &parse(case["blocks"].clone()),
        ) {
            failures.push(format!("{}: {ours} != JS {}", case["name"], case["blocks"]));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn replace_block_matches_the_node_server() {
    let corpus = common::load("commands");
    let mut failures = Vec::new();
    let (mut same_bytes, mut replaced) = (0, 0);
    for case in corpus.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let doc = common::doc(&common::bytes(&case["state"]), 8);
        let root = doc.get_or_insert_text(plate::CONTENT_ROOT);
        let before = doc.transact().state_vector();
        let command: ReplaceBlock = serde_json::from_value(case["command"].clone()).unwrap();
        let result = commands::replace_block(&mut doc.transact_mut(), &root, &command);
        let expected = &case["result"];
        match (result, expected.get("thrown")) {
            (Ok(()), None) => {
                let update = doc.transact().encode_state_as_update_v1(&before);
                let same = common::same_update(&update, &common::bytes(&expected["update"]));
                if !same && std::env::var("EDITS_DEBUG").is_ok() {
                    let (ours, theirs) = (
                        common::update_form(&update),
                        common::update_form(&common::bytes(&expected["update"])),
                    );
                    for (o, t) in ours.0.iter().zip(theirs.0.iter()) {
                        if o != t {
                            eprintln!(
                                "{name}
  rust: {o:?}
  js:   {t:?}"
                            );
                            break;
                        }
                    }
                    if ours.1 != theirs.1 {
                        eprintln!("{name} deletes differ");
                    }
                    if ours.0.len() != theirs.0.len() {
                        eprintln!(
                            "{name} struct counts {} vs {}",
                            ours.0.len(),
                            theirs.0.len()
                        );
                    }
                }
                same_bytes += usize::from(same);
                replaced += 1;
                let js_value = Value::Array(expected["value"].as_array().unwrap().clone());
                if value_hash(&doc) != common::hash(&js_value) {
                    failures.push(format!("{name}: value differs"));
                }
            }
            (Err(error), Some(message)) if error.to_string() == message.as_str().unwrap() => {}
            (result, _) => failures.push(format!("{name}: {result:?} != JS {expected}")),
        }
    }
    eprintln!("replace-block: {same_bytes} of {replaced} updates with the same items");
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn children_pass_matches_the_node_server() {
    let corpus = common::load("children");
    let mut failures = Vec::new();
    let mut same_bytes = 0;
    for case in corpus.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let room = common::doc(&common::bytes(&case["state"]), 1);
        let update = ydoc::decode(&common::bytes(&case["update"])).unwrap();
        let txn = room.transact();
        let writes = children::child_writes(&txn, &update);
        let ours_writes = writes.as_ref().map(|w| {
            let blocks: Vec<Value> = w
                .blocks
                .iter()
                .map(|id| {
                    let branch = id.get_branch(&txn).unwrap();
                    plate::properties(&branch)
                        .unwrap()
                        .into_iter()
                        .find(|(k, _)| &**k == "id")
                        .map_or(Value::Null, |(_, v)| notes::json::any_to_value(&v).unwrap())
                })
                .collect();
            json!({ "assetIds": w.asset_ids, "blocks": blocks })
        });
        if ours_writes.unwrap_or(Value::Null) != case["writes"] {
            failures.push(format!(
                "{name}: writes differ ({writes:?} vs {})",
                case["writes"]
            ));
            continue;
        }
        let Some(writes) = writes else { continue };
        let root = plate::content_root(&txn).unwrap();
        let plan = children::plan(&root, &writes);
        if serde_json::to_value(&plan).unwrap() != case["plan"] {
            failures.push(format!("{name}: plan {plan:?} != JS {}", case["plan"]));
        }
        drop(txn);
        let pairs = |key: &str| -> std::collections::BTreeMap<String, String> {
            case["answer"][key]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| {
                    (
                        p[0].as_str().unwrap().to_owned(),
                        p[1].as_str().unwrap().to_owned(),
                    )
                })
                .collect()
        };
        let answer = ChildAnswer {
            assets: pairs("assets"),
            blocks: pairs("blocks"),
        };
        if serde_json::to_value(children::kept_ids(&plan, &answer)).unwrap() != case["kept"] {
            failures.push(format!("{name}: kept ids differ"));
        }
        let copy = common::doc(&common::bytes(&case["state"]), 7);
        let root = copy.get_or_insert_text(plate::CONTENT_ROOT);
        let before = copy.transact().state_vector();
        let changed = children::apply(&mut copy.transact_mut(), &root, &answer).unwrap();
        let applied = &case["applied"];
        if json!(changed) != applied["ok"] {
            failures.push(format!("{name}: changed {changed} != JS {}", applied["ok"]));
        }
        let js_value = Value::Array(applied["value"].as_array().unwrap().clone());
        if value_hash(&copy) != common::hash(&js_value) {
            failures.push(format!(
                "{name}: value {} != JS {js_value}",
                Value::Array(plate::value(&copy.transact()).unwrap())
            ));
        }
        let update = copy.transact().encode_state_as_update_v1(&before);
        same_bytes += usize::from(common::same_update(
            &update,
            &common::bytes(&applied["update"]),
        ));
    }
    eprintln!(
        "children: {same_bytes} updates with the same items of {}",
        corpus.as_array().unwrap().len()
    );
    assert!(failures.is_empty(), "{failures:#?}");
}
