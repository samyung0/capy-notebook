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
        Err(EditError::Edit { code, message }) => {
            json!({ "error": { "code": code, "message": message } })
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
                edit::verify_material_guards(&mut txn, &root, &guards).map(|()| Value::Null)
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
    let ours = outcome_json(&result);
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
