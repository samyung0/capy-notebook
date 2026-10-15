#![allow(clippy::unwrap_used)] // Tests panic on a broken corpus.
//! Agent edit commands, guards, Undo, inspect, text-source commands, the
//! replace-block command and the children pass, replayed on the states the
//! Node server saw (tests/corpus/{edits,children,commands,inspect}.json.gz):
//! the same result or refusal (code and message), the same Plate value after,
//! and, where the update bytes match, the same guards.
mod common;

use notes::children::{self, ChildAnswer};
use notes::commands::{self, ReplaceBlock};
use notes::edit::{self, DocumentCommand, EditError, EditOutcome};
use notes::plate;
use serde_json::{Value, json};
use yrs::{GetString, ReadTxn, Transact};

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
    guards_compared: usize,
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

fn strip_runs(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(guards) = value.get_mut("guards").and_then(Value::as_array_mut) {
        for guard in guards {
            guard.as_object_mut().unwrap().remove("runs");
        }
    }
    value
}

/// One recorded step: what Rust does on the same state, compared.
fn replay_step(
    script: &str,
    index: usize,
    step: &Value,
    records: &[Value],
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
    let commands =
        |value: &Value| -> Vec<DocumentCommand> { serde_json::from_value(value.clone()).unwrap() };
    let of = |field: &str| records[action["of"].as_u64().unwrap() as usize]["ok"][field].clone();
    let result: Result<Value, EditError> = match kind {
        "apply" | "undo" => {
            let list = if kind == "apply" {
                commands(&action["commands"])
            } else {
                commands(&of("inverse"))
            };
            let mut txn = doc.transact_mut();
            let outcome = if text_source {
                edit::apply_text_commands(&mut txn, &root, &list)
            } else {
                edit::apply_material_commands(&mut txn, &root, &list)
            };
            outcome.map(|o: EditOutcome| {
                let mut value = serde_json::to_value(o).unwrap();
                if text_source {
                    value["text"] = Value::String(root.get_string(&txn));
                }
                value
            })
        }
        "verify" => {
            let guards: Vec<edit::GuardTarget> = serde_json::from_value(of("guards")).unwrap();
            let mut txn = doc.transact_mut();
            if text_source {
                edit::verify_text_guards(&txn, &root, &guards).map(|()| Value::Null)
            } else {
                edit::verify_material_guards(&mut txn, &root, &guards).map(|_| Value::Null)
            }
        }
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
        json!({ "ok": step["ok"] })
    } else if step.get("error").is_some() {
        json!({ "error": step["error"] })
    } else {
        json!({ "thrown": step["thrown"] })
    };
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
    let has_guards = ours.get("guards").is_some();
    if bytes_match || !has_guards {
        tally.guards_compared += usize::from(has_guards);
        if !same(ours, theirs) {
            failures.push(format!("{at}: result {ours} != JS {theirs}"));
        }
    } else if !same(&strip_runs(ours), &strip_runs(theirs)) {
        // Guards name items; with other bytes, other items.
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
                replay_step(
                    name,
                    index,
                    step,
                    steps,
                    text_source,
                    &mut tally,
                    &mut failures,
                );
            }
        }
    }
    eprintln!(
        "{} steps, {} with a result: {} updates with the same items ({} byte-identical), guards compared exactly on {}",
        tally.steps, tally.updates, tally.same_bytes, tally.raw_bytes, tally.guards_compared
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
/// an expected text that occurs more than once comes with its block, and a
/// stale `set_mermaid` (a set_property) with the source the diagram holds.
#[test]
fn ambiguous_spans_and_stale_properties_carry_the_current_target() {
    let refusal = |value: Value, command: DocumentCommand| {
        let doc = common::doc(&notes::slate_yjs::state_from_value(&[value], 3), 4);
        let root = doc.get_or_insert_text(plate::CONTENT_ROOT);
        match edit::apply_material_commands(&mut doc.transact_mut(), &root, &[command]) {
            Err(EditError::Edit {
                code,
                message,
                details,
            }) => (json!(code), message, details),
            other => panic!("expected a refusal, got {other:?}"),
        }
    };
    let text = "the cell and the cell wall";
    assert_eq!(
        refusal(
            json!({ "type": "p", "id": "b1", "children": [{ "text": text }] }),
            DocumentCommand::ReplaceText {
                block_id: Some("b1".into()),
                expected_text: "the cell".into(),
                text: "a cell".into(),
                offset: None,
            },
        ),
        (
            json!("invalid_input"),
            "expected text occurs 2 times; include more context".to_owned(),
            Some(json!({ "block": { "id": "b1", "text": text, "type": "p" } })),
        )
    );
    let source = "graph TD\n  A --> B";
    assert_eq!(
        refusal(
            json!({ "type": "mermaid", "id": "m1", "source": source, "children": [{ "text": "" }] }),
            DocumentCommand::SetProperty {
                node_type: "mermaid".into(),
                property: "source".into(),
                expected_value: "graph TD\n  A".into(),
                value: "graph LR\n  A --> C".into(),
            },
        ),
        (
            json!("stale_target"),
            "mermaid.source changed".to_owned(),
            Some(json!({ "block": { "id": "m1", "text": source, "type": "mermaid" } })),
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
            offset: None,
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

/// The Undo of an edit that placed a library figure removes it again (the
/// children pass then lets its asset go), while an edit itself still may not
/// remove a block holding media.
#[test]
fn undo_removes_the_figure_its_edit_inserted() {
    let value = vec![json!({ "type": "p", "id": "b1", "children": [{ "text": "intro" }] })];
    let doc = common::doc(&notes::slate_yjs::state_from_value(&value, 3), 4);
    let root = doc.get_or_insert_text(plate::CONTENT_ROOT);
    let figure = json!({
        "assetId": "ea_figure", "caption": [{ "text": "A leaf" }],
        "children": [{ "text": "" }], "id": "f1", "type": "img",
    });
    let outcome = edit::apply_material_commands(
        &mut doc.transact_mut(),
        &root,
        &[DocumentCommand::InsertBlock {
            after_block_id: Some("b1".into()),
            blocks: vec![figure],
        }],
    )
    .unwrap();
    let refused = edit::apply_material_commands(&mut doc.transact_mut(), &root, &outcome.inverse);
    assert!(
        matches!(&refused, Err(EditError::Edit { message, .. }) if message == "blocks holding media cannot be removed by an edit"),
        "{refused:?}"
    );
    edit::undo_material_commands(&mut doc.transact_mut(), &root, &outcome.inverse).unwrap();
    assert_eq!(plate::value(&doc.transact()).unwrap(), value);
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
    for case in corpus.as_array().unwrap() {
        let doc = common::doc(&common::bytes(&case["state"]), 99);
        let ours = serde_json::to_value(edit::inspect_material(&doc.transact()).unwrap()).unwrap();
        if !same(&parse(ours.clone()), &parse(case["blocks"].clone())) {
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
