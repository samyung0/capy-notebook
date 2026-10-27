#![allow(clippy::unwrap_used)] // Tests panic on a broken fixture.
//! Quiz documents: the projection round trip over the shared question
//! fixtures, incomplete questions left out, two writers merging (an edit
//! against a move, a type change against typing), the admit's shape, value
//! and cap refusals (work counted, never timed), Undo of removals, the
//! readers' lists of ordering items and matching options (D3 as revised
//! 2026-10-10), the combined limits and the server's own writes.

use std::collections::HashMap;
use std::sync::Arc;

use items::quiz::{self, ReaderLists};
use items::{Admission, Kind, Refusal, Validator};
use notes::edit::DocumentCommand;
use notes::questions::Policy;
use serde_json::{Value, json};
use yrs::branch::BranchPtr;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Text, TextPrelim, TextRef,
    Transact, UndoManager, Update,
};

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
    assert!(out.len() >= 10, "{} fixtures", out.len());
    out
}

fn quiz_value(questions: &[Value]) -> Vec<Value> {
    vec![json!({
        "type": "quiz",
        "id": "quiz",
        "children": questions.iter().map(|q| json!({
            "type": "quiz_question", "id": q["id"], "question": q, "children": [{ "text": "" }],
        })).collect::<Vec<_>>(),
    })]
}

fn load(state: &[u8], client: u64) -> Doc {
    let doc = Doc::with_options(ydoc::doc_options(client));
    doc.transact_mut()
        .apply_update(Update::decode_v1(state).unwrap())
        .unwrap();
    doc
}

/// The room's content and keys documents for `questions`, plus a client
/// copy of each.
fn rooms(questions: &[Value]) -> (Doc, Doc, Doc, Doc) {
    let (content, keys) = quiz::states_from_value(&quiz_value(questions), 0);
    (
        load(&content, 1),
        load(&keys, 1),
        load(&content, 2),
        load(&keys, 2),
    )
}

/// A copy of `doc` under client `client`.
fn copy_of(doc: &Doc, client: u64) -> Doc {
    load(
        &doc.transact()
            .encode_state_as_update_v1(&StateVector::default()),
        client,
    )
}

fn projected(content: &Doc, keys: &Doc) -> Vec<Value> {
    quiz::questions_from_value(&quiz::value(&content.transact(), &keys.transact()))
}

fn diff(client: &Doc, room: &Doc) -> Vec<u8> {
    client
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector())
}

fn validator(kind: Kind, doc: &Doc) -> Validator {
    let metrics = notes::limits::measure_value(&kind.document_value(&doc.transact()));
    Validator::new(kind, Some(metrics))
}

fn admit(validator: &mut Validator, doc: &Doc, update: &[u8]) -> (Result<Admission, Refusal>, u64) {
    let _ = ydoc::steps::take();
    let result = validator.admit(doc, &Update::decode_v1(update).unwrap());
    let steps = ydoc::steps::take().total();
    if matches!(result, Ok(Admission::Accepted)) {
        doc.transact_mut()
            .apply_update(Update::decode_v1(update).unwrap())
            .unwrap();
    }
    (result, steps)
}

fn accepted(validator: &mut Validator, room: &Doc, client: &Doc) {
    let (result, _) = admit(validator, room, &diff(client, room));
    assert!(matches!(result, Ok(Admission::Accepted)), "{result:?}");
}

fn map_in(doc: &Doc, path: &[&str]) -> MapRef {
    let (root, rest) = path.split_first().unwrap();
    let txn = doc.transact();
    let mut map = txn.get_map(*root).unwrap();
    for key in rest {
        map = match map.get(&txn, key) {
            Some(Out::YMap(next)) => next,
            other => panic!("no map at {key}: {other:?}"),
        };
    }
    map
}

fn text_in(doc: &Doc, path: &[&str], key: &str) -> TextRef {
    let map = map_in(doc, path);
    match map.get(&doc.transact(), key) {
        Some(Out::YText(text)) => text,
        other => panic!("no text {key}: {other:?}"),
    }
}

fn first_key(map: &MapRef, doc: &Doc) -> String {
    let txn = doc.transact();
    let mut keys: Vec<String> = map.keys(&txn).map(str::to_owned).collect();
    keys.sort();
    keys.remove(0)
}

/// The part id of the fixture whose first part has `kind`.
fn part_of(questions: &[Value], kind: &str) -> (String, String) {
    let question = questions
        .iter()
        .find(|q| q["parts"][0]["answer"]["type"] == json!(kind))
        .unwrap();
    (
        question["id"].as_str().unwrap().to_owned(),
        question["parts"][0]["id"].as_str().unwrap().to_owned(),
    )
}

#[test]
fn every_fixture_round_trips_through_both_documents() {
    let questions = fixtures();
    let (content, keys, _, _) = rooms(&questions);
    assert_eq!(projected(&content, &keys), questions);
    let value = quiz::value(&content.transact(), &keys.transact());
    assert!(notes::material::assert_canonical(&value, "quiz").is_ok());
    // The content document alone holds no key: no correct options, accepted
    // answers, marking schemes, solutions, pairs, matching options or
    // ordering items.
    let state = content
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let held = String::from_utf8_lossy(&state);
    for question in &questions {
        for part in question["parts"].as_array().unwrap() {
            let answer = &part["answer"];
            let mut secrets: Vec<&str> = Vec::new();
            for solution in part["solution"].as_array().unwrap() {
                secrets.extend(solution["text"].as_str());
            }
            if answer["type"] == json!("ordering") {
                secrets.extend(
                    answer["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(Value::as_str),
                );
            }
            if answer["type"] == json!("matching") {
                secrets.extend(
                    answer["options"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(Value::as_str),
                );
            }
            for secret in secrets.into_iter().filter(|t| t.len() > 3) {
                assert!(
                    !held.contains(secret),
                    "the content document holds {secret}"
                );
            }
        }
    }
}

/// The live quiz's block kinds against the embed catalog (openwiki/embeds.md):
/// the room admits every question block the catalog lists, and the shared
/// fixtures hold a block of every kind it admits, so the round trip above
/// reads each one back: a kind added without a reader fails here instead of
/// vanishing from the room's projection, as plot once did.
#[test]
fn every_admitted_block_kind_round_trips() {
    for embed in notes::catalog::EMBEDS.iter().filter(|e| e.question_block) {
        assert!(
            quiz::BLOCK_TYPES.contains(&embed.kind),
            "a live quiz refuses the catalog's {} block",
            embed.kind
        );
    }
    let questions = fixtures();
    let mut held = std::collections::BTreeSet::new();
    for question in &questions {
        let parts = question["parts"].as_array().unwrap();
        let lists = std::iter::once(&question["stem"])
            .chain(parts.iter().map(|part| &part["blocks"]))
            .chain(parts.iter().map(|part| &part["solution"]));
        for block in lists.filter_map(Value::as_array).flatten() {
            held.insert(block["type"].as_str().unwrap().to_owned());
        }
    }
    let admitted: std::collections::BTreeSet<String> = quiz::BLOCK_TYPES
        .iter()
        .map(|kind| (*kind).to_owned())
        .collect();
    assert_eq!(held, admitted);
    let (content, keys, _, _) = rooms(&questions);
    assert_eq!(projected(&content, &keys), questions);
    assert!(!quiz::holds_unknown_block(&content.transact()));
    assert!(!quiz::holds_unknown_block(&keys.transact()));
}

/// A stored quiz holding a block kind the room does not admit (a newer
/// version wrote it), in a stem or a solution, is found in the document it
/// seeds, so the room loads read-only (Epo 2026-10-13) instead of dropping the
/// block from what it reads. Fails if the check misses either document.
#[test]
fn a_seeded_unknown_block_kind_is_found() {
    let timeline = json!({ "type": "timeline", "events": ["Mitosis"] });
    let mut in_stem = fixtures()[0].clone();
    in_stem["stem"] = json!([timeline]);
    let (content, keys, _, _) = rooms(&[in_stem]);
    assert!(quiz::holds_unknown_block(&content.transact()));
    assert!(!quiz::holds_unknown_block(&keys.transact()));
    let mut in_solution = fixtures()[0].clone();
    in_solution["parts"][0]["solution"] = json!([timeline]);
    let (content, keys, _, _) = rooms(&[in_solution]);
    assert!(!quiz::holds_unknown_block(&content.transact()));
    assert!(quiz::holds_unknown_block(&keys.transact()));
}

#[test]
fn an_incomplete_question_stays_out_of_the_projection() {
    let questions = fixtures();
    let (content, keys, _, _) = rooms(&questions);
    let (question, part) = part_of(&questions, "mcq");
    // An editor clears the correct option: readers still see the question
    // live, the projection (and so grading) leaves it out.
    map_in(&keys, &["keys", &part]).remove(&mut keys.transact_mut(), "correct");
    let ids: Vec<Value> = projected(&content, &keys)
        .iter()
        .map(|q| q["id"].clone())
        .collect();
    assert!(!ids.contains(&json!(question)));
    assert_eq!(ids.len(), questions.len() - 1);
    // Keys written for another answer type count as none.
    map_in(&keys, &["keys", &part]).insert(&mut keys.transact_mut(), "type", "boolean");
    assert_eq!(projected(&content, &keys).len(), questions.len() - 1);
}

#[test]
fn blanks_are_dropped_from_the_projection() {
    let mut questions = fixtures();
    let empty = json!({ "type": "text", "text": "  " });
    // A blank paragraph in a body and a solution leaves the question complete.
    let part = &mut questions[0]["parts"][0];
    let body = part["blocks"].clone();
    part["blocks"].as_array_mut().unwrap().push(empty.clone());
    part["solution"].as_array_mut().unwrap().push(empty.clone());
    // A part holding only blank text has no body: the question is incomplete.
    questions[1]["parts"][0]["blocks"] = json!([empty]);
    // A blank unit means no unit, and a blank hint or accepted answer none.
    let of_type = |questions: &[Value], kind: &str| {
        (2..questions.len())
            .find(|&i| questions[i]["parts"][0]["answer"]["type"] == kind)
            .unwrap()
    };
    let short = of_type(&questions, "short");
    let open = of_type(&questions, "open");
    questions[short]["parts"][0]["answer"]["unit"] = json!(" ");
    let accepted = questions[short]["parts"][0]["answer"]["accepted"].clone();
    questions[short]["parts"][0]["answer"]["accepted"]
        .as_array_mut()
        .unwrap()
        .push(json!(" "));
    questions[open]["parts"][0]["answer"]["hints"] = json!(["", "Think of the area.", " "]);
    // A blank gap answer and a blank marking item go; the part's marks are
    // then the rest's (Epo 2026-10-15).
    let gaps = of_type(&questions, "gaps");
    let gap_answers = questions[gaps]["parts"][0]["answer"]["accepted"].clone();
    questions[gaps]["parts"][0]["answer"]["accepted"][1]
        .as_array_mut()
        .unwrap()
        .push(json!(" "));
    let scheme = questions[open]["parts"][0]["markscheme"].clone();
    let marks = questions[open]["parts"][0]["marks"].clone();
    questions[open]["parts"][0]["markscheme"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "text": " ", "marks": 2 }));
    questions[open]["parts"][0]["marks"] = json!(marks.as_f64().unwrap() + 2.0);
    // A chart series short of its labels takes nulls (empty cells), and a
    // blank description goes.
    let chart_at = |q: &Value| {
        q["stem"]
            .as_array()
            .and_then(|stem| stem.iter().position(|b| b["type"] == "chart"))
    };
    let chart = (2..questions.len())
        .find(|&i| chart_at(&questions[i]).is_some())
        .unwrap();
    let at = chart_at(&questions[chart]).unwrap();
    let block = &mut questions[chart]["stem"][at];
    let labels = block["labels"].as_array().unwrap().len();
    block["series"][0]["values"] = json!([null]);
    block["description"] = json!("  ");
    let (content, keys, _, _) = rooms(&questions);
    let projected = projected(&content, &keys);
    assert_eq!(projected.len(), questions.len() - 1);
    let find = |id: &Value| projected.iter().find(|q| &q["id"] == id).unwrap();
    assert_eq!(find(&questions[0]["id"])["parts"][0]["blocks"], body);
    assert!(!projected.iter().any(|q| q["id"] == questions[1]["id"]));
    let answer = &find(&questions[short]["id"])["parts"][0]["answer"];
    assert!(answer.get("unit").is_none());
    assert_eq!(answer["accepted"], accepted);
    let block = &find(&questions[chart]["id"])["stem"][at];
    assert_eq!(
        block["series"][0]["values"],
        json!(vec![Value::Null; labels])
    );
    assert!(block.get("description").is_none());
    let open_part = &find(&questions[open]["id"])["parts"][0];
    assert_eq!(open_part["answer"]["hints"], json!(["Think of the area."]));
    assert_eq!(open_part["markscheme"], scheme);
    assert_eq!(open_part["marks"], marks);
    assert_eq!(
        find(&questions[gaps]["id"])["parts"][0]["answer"]["accepted"],
        gap_answers
    );
}

#[test]
fn two_editors_merge_an_option_and_its_correct_answer() {
    let questions = fixtures();
    let (content, keys, _, keys_b) = rooms(&questions);
    let (question, part) = part_of(&questions, "mcq");
    let options = ["questions", &question, "parts", &part, "answer", "options"];
    // A types into option 0 in the content document; B, in the keys, makes
    // option 1 the correct one.
    let mut check = validator(Kind::Quiz, &content);
    let a = copy_of(&content, 3);
    text_in(&a, &[&options[..], &["o0"]].concat(), "text").insert(
        &mut a.transact_mut(),
        0,
        "Very ",
    );
    accepted(&mut check, &content, &a);
    assert_eq!(check.exact_checks, 0, "typing takes the bound");
    let mut keys_check = validator(Kind::QuizKeys, &keys);
    let ticks = map_in(&keys_b, &["keys", &part, "correct"]);
    {
        let mut txn = keys_b.transact_mut();
        ticks.remove(&mut txn, "o0");
        ticks.insert(&mut txn, "o1", true);
    }
    accepted(&mut keys_check, &keys, &keys_b);
    let after = projected(&content, &keys);
    let merged = after.iter().find(|q| q["id"] == json!(question)).unwrap();
    assert!(
        merged["parts"][0]["answer"]["options"][0]
            .as_str()
            .unwrap()
            .starts_with("Very ")
    );
    assert_eq!(merged["parts"][0]["answer"]["correct"], json!([1]));
}

/// Both writers' updates go to the room in either order: each is admitted,
/// and both orders end in the same document.
fn converge(room: &Doc, kind: Kind, a: &Doc, b: &Doc) -> Doc {
    let other = copy_of(room, 9);
    for (first, second, target) in [(a, b, room), (b, a, &other)] {
        let mut check = validator(kind, target);
        accepted(&mut check, target, first);
        accepted(&mut check, target, second);
    }
    assert_eq!(
        room.transact()
            .encode_state_as_update_v1(&StateVector::default())
            .len(),
        other
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
            .len()
    );
    assert_eq!(
        quiz::content_document_value(&room.transact()),
        quiz::content_document_value(&other.transact())
    );
    other
}

/// DESIGN 9.2: one editor moves a question while another types inside it;
/// both land.
#[test]
fn a_move_during_an_edit_inside_the_question_keeps_both() {
    let questions = fixtures();
    let (content, keys, _, _) = rooms(&questions);
    let moved = questions[0]["id"].as_str().unwrap().to_owned();
    let last = questions.last().unwrap()["id"].as_str().unwrap().to_owned();
    let a = copy_of(&content, 3);
    let b = copy_of(&content, 4);
    let after = {
        let txn = a.transact();
        match map_in(&a, &["questions", &last]).get(&txn, "order") {
            Some(Out::Any(Any::String(order))) => items::order::after(Some(&order)),
            other => panic!("{other:?}"),
        }
    };
    map_in(&a, &["questions", &moved]).insert(&mut a.transact_mut(), "order", after.as_str());
    let part = questions[0]["parts"][0]["id"].as_str().unwrap();
    let blocks = map_in(&b, &["questions", &moved, "parts", part, "blocks"]);
    let block = first_key(&blocks, &b);
    text_in(
        &b,
        &["questions", &moved, "parts", part, "blocks", &block],
        "text",
    )
    .insert(&mut b.transact_mut(), 0, "Typed: ");
    converge(&content, Kind::Quiz, &a, &b);
    let after = projected(&content, &keys);
    assert_eq!(after.last().unwrap()["id"], json!(moved));
    assert!(
        after.last().unwrap()["parts"][0]["blocks"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("Typed: ")
    );
}

/// DESIGN 9.2: one editor changes a part's type (the answer map replaced, as
/// the dialog does) while another types into one of its options; both
/// orders converge on the new type.
#[test]
fn a_type_change_during_an_edit_in_an_option_converges() {
    let questions = fixtures();
    let (content, _, _, _) = rooms(&questions);
    let (question, part) = part_of(&questions, "mcq");
    let path = ["questions", question.as_str(), "parts", part.as_str()];
    let a = copy_of(&content, 3);
    let b = copy_of(&content, 4);
    {
        let part_map = map_in(&a, &path);
        let mut txn = a.transact_mut();
        let answer = part_map.insert(&mut txn, "answer", MapPrelim::default());
        answer.insert(&mut txn, "type", "ordering");
    }
    text_in(
        &b,
        &[&path[..], &["answer", "options", "o0"]].concat(),
        "text",
    )
    .insert(&mut b.transact_mut(), 0, "Late ");
    let other = converge(&content, Kind::Quiz, &a, &b);
    for doc in [&content, &other] {
        let txn = doc.transact();
        let answer = map_in(doc, &[&path[..], &["answer"]].concat());
        assert!(
            matches!(answer.get(&txn, "type"), Some(Out::Any(Any::String(t))) if &*t == "ordering")
        );
    }
}

/// One crafted edit of the room's `kind` document, refused with `reason`,
/// its walk a few steps per struct.
fn refused(kind: Kind, edit: impl FnOnce(&Doc), reason: &str) {
    let questions = fixtures();
    let (content, keys, client_content, client_keys) = rooms(&questions);
    let (room, client) = match kind {
        Kind::QuizKeys => (keys, client_keys),
        _ => (content, client_content),
    };
    edit(&client);
    let update = diff(&client, &room);
    let structs = Update::decode_v1(&update).unwrap().blocks().count() as u64;
    let mut check = validator(kind, &room);
    let (result, steps) = admit(&mut check, &room, &update);
    match result {
        Err(error) => assert!(
            error.to_string().contains(reason),
            "{error} does not say {reason}"
        ),
        Ok(admission) => panic!("{admission:?}: expected a refusal for {reason}"),
    }
    assert!(
        steps <= 64 * structs.max(1),
        "{steps} steps for {structs} structs"
    );
}

#[test]
fn shapes_no_editor_writes_are_refused() {
    let questions = fixtures();
    let (question, ordering) = part_of(&questions, "ordering");
    let answer = ["questions", &question, "parts", &ordering, "answer"];
    // Security regression (D3): nothing derived from the keys' items goes in
    // the content document, nor a server-only field in the keys.
    refused(
        Kind::Quiz,
        |doc| {
            map_in(doc, &answer).insert(&mut doc.transact_mut(), "copy", MapPrelim::default());
        },
        "outside its shape",
    );
    refused(
        Kind::Quiz,
        |doc| {
            map_in(doc, &answer).insert(&mut doc.transact_mut(), "items", MapPrelim::default());
        },
        "outside its shape",
    );
    refused(
        Kind::QuizKeys,
        |doc| {
            let items = map_in(doc, &["keys", &ordering, "items"]);
            let first = first_key(&items, doc);
            map_in(doc, &["keys", &ordering, "items", &first]).insert(
                &mut doc.transact_mut(),
                "slot",
                "mine",
            );
        },
        "outside its shape",
    );
    refused(
        Kind::Quiz,
        |doc| {
            doc.get_or_insert_map("keys").insert(
                &mut doc.transact_mut(),
                "p",
                MapPrelim::default(),
            );
        },
        "outside its shape",
    );
    refused(
        Kind::Quiz,
        |doc| {
            let stem = map_in(doc, &["questions", &question, "stem"]);
            stem.insert(&mut doc.transact_mut(), "bad id!", MapPrelim::default());
        },
        "an id that is not",
    );
    refused(
        Kind::Quiz,
        |doc| {
            let stem = map_in(doc, &["questions", &question, "stem"]);
            let block = stem.insert(&mut doc.transact_mut(), "b9", MapPrelim::default());
            block.insert(&mut doc.transact_mut(), "type", "video");
        },
        "outside its shape",
    );
    refused(
        Kind::Quiz,
        |doc| {
            let (q, p) = part_of(&fixtures(), "mcq");
            let text = text_in(
                doc,
                &["questions", &q, "parts", &p, "answer", "options", "o0"],
                "text",
            );
            let attrs = HashMap::from([(Arc::from("bold"), Any::Bool(true))]);
            text.insert_with_attributes(&mut doc.transact_mut(), 0, "x", attrs);
        },
        "anything but plain text",
    );
    refused(
        Kind::QuizKeys,
        |doc| {
            map_in(doc, &["keys", &ordering]).insert(
                &mut doc.transact_mut(),
                "secret",
                TextPrelim::new("x"),
            );
        },
        "outside its shape",
    );
}

/// REVIEW1 M4: every value the store's caps refuse is refused at admission,
/// so the store never meets one (and never discards a room for it).
#[test]
fn values_past_their_caps_are_refused_at_admission() {
    let questions = fixtures();
    let (question, ordering) = part_of(&questions, "ordering");
    let part = ["questions", question.as_str(), "parts", ordering.as_str()];
    for marks in [0.0, 2.5, 21.0, 500.0] {
        refused(
            Kind::Quiz,
            |doc| {
                map_in(doc, &part).insert(&mut doc.transact_mut(), "marks", marks);
            },
            "whole marks",
        );
    }
    refused(
        Kind::Quiz,
        |doc| {
            map_in(doc, &part).insert(&mut doc.transact_mut(), "marks", "two");
        },
        "whole marks",
    );
    let (short_question, short) = part_of(&questions, "short");
    refused(
        Kind::Quiz,
        |doc| {
            map_in(
                doc,
                &["questions", &short_question, "parts", &short, "answer"],
            )
            .insert(&mut doc.transact_mut(), "unit", "m".repeat(101));
        },
        "outside its shape",
    );
    refused(
        Kind::Quiz,
        |doc| {
            let stem = map_in(doc, &["questions", &question, "stem"]);
            let block = stem.insert(&mut doc.transact_mut(), "b9", MapPrelim::default());
            block.insert(&mut doc.transact_mut(), "label", "l".repeat(1_001));
        },
        "outside its shape",
    );
    let (open_question, open) = part_of(&questions, "open");
    refused(
        Kind::QuizKeys,
        |doc| {
            let scheme = map_in(doc, &["keys", &open, "markscheme"]);
            let first = first_key(&scheme, doc);
            map_in(doc, &["keys", &open, "markscheme", &first]).insert(
                &mut doc.transact_mut(),
                "marks",
                21.0,
            );
        },
        "whole marks",
    );
    // At the caps exactly, admitted.
    let (content, _, client, _) = rooms(&questions);
    map_in(
        &client,
        &["questions", &short_question, "parts", &short, "answer"],
    )
    .insert(&mut client.transact_mut(), "unit", "m".repeat(100));
    map_in(&client, &part).insert(&mut client.transact_mut(), "marks", 20.0);
    let stem = map_in(&client, &["questions", &question, "stem"]);
    let block = stem.insert(&mut client.transact_mut(), "b9", MapPrelim::default());
    block.insert(&mut client.transact_mut(), "order", "a5");
    block.insert(&mut client.transact_mut(), "type", "text");
    block.insert(&mut client.transact_mut(), "label", "l".repeat(1_000));
    let mut check = validator(Kind::Quiz, &content);
    accepted(&mut check, &content, &client);
    assert!(items::quiz::check_content_caps(&content.transact()).is_ok());
    let _ = open_question;
}

/// A chart, plot or graph past its kind's caps is refused as it arrives,
/// whether the update writes its value, its type or both; an unfinished one
/// (D4) is admitted.
#[test]
fn figures_past_their_caps_are_refused_at_admission() {
    let questions = fixtures();
    let (question, _) = part_of(&questions, "boolean");
    let figure = |doc: &Doc, kind: &str, value: Value| {
        let stem = map_in(doc, &["questions", &question, "stem"]);
        let block = stem.insert(&mut doc.transact_mut(), "b9", MapPrelim::default());
        block.insert(&mut doc.transact_mut(), "order", "a5");
        block.insert(&mut doc.transact_mut(), "type", kind);
        let value: Any = serde_json::from_value(value).unwrap();
        block.insert(&mut doc.transact_mut(), "value", value);
    };
    refused(
        Kind::Quiz,
        |doc| figure(doc, "chart", json!({ "title": "t".repeat(1_001) })),
        "title too long",
    );
    refused(
        Kind::Quiz,
        |doc| figure(doc, "chart", json!({ "labels": vec!["a"; 51] })),
        "too many items",
    );
    refused(
        Kind::Quiz,
        |doc| figure(doc, "plot", json!({ "series": vec![json!({}); 5] })),
        "too many items",
    );
    refused(
        Kind::Quiz,
        |doc| figure(doc, "graph", json!({ "description": "d".repeat(501) })),
        "description too long",
    );
    refused(
        Kind::Quiz,
        |doc| {
            let stem = map_in(doc, &["questions", &question, "stem"]);
            let block = stem.insert(&mut doc.transact_mut(), "b8", MapPrelim::default());
            block.insert(&mut doc.transact_mut(), "order", "a6");
            block.insert(&mut doc.transact_mut(), "type", "image");
            block.insert(
                &mut doc.transact_mut(),
                "description",
                TextPrelim::new("d".repeat(501)),
            );
        },
        "a description holds at most 500",
    );
    refused(
        Kind::Quiz,
        |doc| {
            let term = "x+".repeat(100) + "x";
            figure(
                doc,
                "graph",
                json!({ "elements": [{ "type": "functiongraph", "term": term }] }),
            )
        },
        "supported mathematical expression",
    );
    // A chart's value retyped as a plot is checked as a plot.
    let (content, _, client, _) = rooms(&questions);
    figure(&client, "chart", json!({ "series": vec![json!({}); 6] }));
    let mut check = validator(Kind::Quiz, &content);
    accepted(&mut check, &content, &client);
    map_in(&client, &["questions", &question, "stem", "b9"]).insert(
        &mut client.transact_mut(),
        "type",
        "plot",
    );
    let (result, _) = admit(&mut check, &content, &diff(&client, &content));
    assert!(
        matches!(result, Err(Refusal::Shape(ref m)) if m.contains("too many items")),
        "{result:?}"
    );
    // Unfinished, admitted and kept by the store's caps.
    let (content, _, client, _) = rooms(&questions);
    figure(
        &client,
        "chart",
        json!({ "title": "", "labels": [], "series": [] }),
    );
    let mut check = validator(Kind::Quiz, &content);
    accepted(&mut check, &content, &client);
    assert!(items::quiz::check_content_caps(&content.transact()).is_ok());
}

/// Accepted answers turned open are held to the open bound in the update
/// that turns them; ticks are counted like any answer list, and an open part
/// takes at most one sample answer (Epo 2026-10-15).
#[test]
fn answer_keys_past_their_caps_are_refused() {
    let questions = fixtures();
    let (_, open) = part_of(&questions, "open");
    refused(
        Kind::QuizKeys,
        |doc| {
            let accepted = map_in(doc, &["keys", &open, "accepted"]);
            let mut txn = doc.transact_mut();
            for (id, order) in [("a8", "a5"), ("a9", "a6")] {
                let entry = accepted.insert(&mut txn, id, MapPrelim::default());
                entry.insert(&mut txn, "order", order);
                entry.insert(&mut txn, "text", TextPrelim::new("a sample"));
            }
        },
        "accepted answers",
    );
    let (_, short) = part_of(&questions, "short");
    refused(
        Kind::QuizKeys,
        |doc| {
            let accepted = map_in(doc, &["keys", &short, "accepted"]);
            let first = first_key(&accepted, doc);
            text_in(doc, &["keys", &short, "accepted", &first], "text").insert(
                &mut doc.transact_mut(),
                0,
                &"a".repeat(5_001),
            );
            map_in(doc, &["keys", &short]).insert(&mut doc.transact_mut(), "type", "open");
        },
        "accepted answers",
    );
    let (_, mcq) = part_of(&questions, "mcq");
    refused(
        Kind::QuizKeys,
        |doc| {
            let correct = map_in(doc, &["keys", &mcq, "correct"]);
            for i in 0..101 {
                correct.insert(&mut doc.transact_mut(), format!("t{i}"), true);
            }
        },
        "an answer list",
    );
}

#[test]
fn texts_and_counts_past_their_caps_are_refused() {
    let questions = fixtures();
    let (question, part) = part_of(&questions, "open");
    // A part text past 12,000 characters.
    let (content, _, client, _) = rooms(&questions);
    let blocks = map_in(&client, &["questions", &question, "parts", &part, "blocks"]);
    let first = first_key(&blocks, &client);
    let text = text_in(
        &client,
        &["questions", &question, "parts", &part, "blocks", &first],
        "text",
    );
    text.insert(&mut client.transact_mut(), 0, &"x".repeat(12_001));
    let mut check = validator(Kind::Quiz, &content);
    let (result, _) = admit(&mut check, &content, &diff(&client, &content));
    assert!(
        matches!(result, Err(Refusal::Shape(ref m)) if m.contains("12000")),
        "{result:?}"
    );
    // A sixth marking item in the keys.
    let (_, keys, _, client_keys) = rooms(&questions);
    let scheme = map_in(&client_keys, &["keys", &part, "markscheme"]);
    for i in 0..5 {
        let item = scheme.insert(
            &mut client_keys.transact_mut(),
            format!("extra{i}"),
            MapPrelim::default(),
        );
        item.insert(&mut client_keys.transact_mut(), "order", "a5");
        item.insert(
            &mut client_keys.transact_mut(),
            "text",
            TextPrelim::new("step"),
        );
        item.insert(&mut client_keys.transact_mut(), "marks", 1.0);
    }
    let mut check = validator(Kind::QuizKeys, &keys);
    let (result, _) = admit(&mut check, &keys, &diff(&client_keys, &keys));
    assert!(
        matches!(result, Err(Refusal::Shape(ref m)) if m.contains("marking scheme")),
        "{result:?}"
    );
}

/// REVIEW1 M3: an image block added before its upload returns is structure
/// (D4): admitted, and the question stays out of the projection until the
/// image names its asset.
#[test]
fn a_blank_image_block_is_admitted_and_leaves_its_question_incomplete() {
    let questions = fixtures();
    let (content, keys, client, _) = rooms(&questions);
    let (question, _) = part_of(&questions, "boolean");
    let stem = map_in(&client, &["questions", &question, "stem"]);
    {
        let mut txn = client.transact_mut();
        let block = stem.insert(&mut txn, "bimg", MapPrelim::default());
        block.insert(&mut txn, "order", items::order::after(None).as_str());
        block.insert(&mut txn, "type", "image");
        let image = Any::Map(Arc::new(HashMap::from([(
            "url".to_owned(),
            Any::String(Arc::from("")),
        )])));
        block.insert(&mut txn, "image", image);
        block.insert(&mut txn, "description", TextPrelim::new(""));
    }
    let mut check = validator(Kind::Quiz, &content);
    accepted(&mut check, &content, &client);
    assert!(
        !projected(&content, &keys)
            .iter()
            .any(|q| q["id"] == json!(question))
    );
}

/// Live quiz rooms accept only hosted question images, as a stored question
/// keeps them: with the quiz figure host set (`BANK_ASSETS_URL`), an image or
/// a graph linking a URL under it is admitted, one linking anywhere else is
/// refused at admission, and an uploaded asset and the blank image waiting
/// for its upload are admitted. Fails if admission takes any URL again, or
/// none under the host.
#[test]
fn a_live_quiz_admits_only_hosted_question_images() {
    let questions = fixtures();
    let (question, _) = part_of(&questions, "boolean");
    let hosted = "https://assets.example.test/bank/q1/figure.png";
    let elsewhere = "https://images.example.test/a.png";
    let block = |doc: &Doc, kind: &str, key: &str, value: Value| {
        let stem = map_in(doc, &["questions", &question, "stem"]);
        let mut txn = doc.transact_mut();
        let block = stem.insert(&mut txn, "bfig", MapPrelim::default());
        block.insert(&mut txn, "order", items::order::after(None).as_str());
        block.insert(&mut txn, "type", kind);
        block.insert(&mut txn, key, serde_json::from_value::<Any>(value).unwrap());
    };
    let admitted = |kind: &str, key: &str, value: Value| {
        let (content, _, client, _) = rooms(&questions);
        block(&client, kind, key, value);
        let mut check = validator(Kind::Quiz, &content);
        check.policy = Policy {
            quiz_assets_url: Some("https://assets.example.test/bank".into()),
            ..Policy::default()
        };
        admit(&mut check, &content, &diff(&client, &content)).0
    };
    let graph = |url: &str| json!({ "image": { "url": url }, "width": 10, "height": 10 });
    for image in [
        json!({ "assetId": "ea_upload" }),
        json!({ "url": "" }),
        json!({ "url": hosted }),
    ] {
        let result = admitted("image", "image", image.clone());
        assert!(
            matches!(result, Ok(Admission::Accepted)),
            "{image}: {result:?}"
        );
    }
    let result = admitted("graph", "value", graph(hosted));
    assert!(matches!(result, Ok(Admission::Accepted)), "{result:?}");
    for (kind, key, value, reason) in [
        (
            "image",
            "image",
            json!({ "url": elsewhere }),
            "an image that is not {assetId} or a hosted {url}",
        ),
        (
            "graph",
            "value",
            graph(elsewhere),
            "a graph image that is not a hosted {url}",
        ),
    ] {
        let result = admitted(kind, key, value);
        assert!(
            matches!(&result, Err(Refusal::Shape(m)) if m.contains(reason)),
            "{kind}: {result:?}"
        );
    }
}

/// REVIEW1 S2: a structural edit (Add option) on a large quiz takes the
/// counted bound, not a copy and a walk of the whole quiz: no exact check,
/// and the work follows the touched list.
#[test]
fn a_structural_edit_scales_with_the_touched_item() {
    let mcq = fixtures()
        .into_iter()
        .find(|q| q["parts"][0]["answer"]["type"] == json!("mcq"))
        .unwrap();
    let quiz_of = |count: usize| -> Vec<Value> {
        (0..count)
            .map(|n| {
                let mut q = mcq.clone();
                q["id"] = json!(format!("q{n}"));
                q["parts"][0]["id"] = json!(format!("q{n}-p"));
                q
            })
            .collect()
    };
    let mut steps_of = Vec::new();
    for count in [2, 90] {
        let questions = quiz_of(count);
        let (content, _, client, _) = rooms(&questions);
        let options = map_in(
            &client,
            &["questions", "q1", "parts", "q1-p", "answer", "options"],
        );
        {
            let mut txn = client.transact_mut();
            let entry = options.insert(&mut txn, "added", MapPrelim::default());
            entry.insert(&mut txn, "order", items::order::after(Some("a5")).as_str());
            entry.insert(&mut txn, "text", TextPrelim::new("A new option"));
        }
        let mut check = validator(Kind::Quiz, &content);
        let (result, steps) = admit(&mut check, &content, &diff(&client, &content));
        assert!(matches!(result, Ok(Admission::Accepted)), "{result:?}");
        assert_eq!(check.exact_checks, 0, "Add option copied the room");
        steps_of.push(steps);
    }
    assert!(
        steps_of[1] <= steps_of[0] + 8,
        "steps grew with the quiz: {steps_of:?}"
    );
}

/// REVIEW1 S3: the content and keys documents count together against the
/// material's limits: an update the content document alone would fit is
/// refused once the keys take the rest.
#[test]
fn both_documents_count_against_the_limits() {
    let questions = fixtures();
    let (content, _, client, _) = rooms(&questions);
    let (question, part) = part_of(&questions, "open");
    let blocks = map_in(&client, &["questions", &question, "parts", &part, "blocks"]);
    let first = first_key(&blocks, &client);
    text_in(
        &client,
        &["questions", &question, "parts", &part, "blocks", &first],
        "text",
    )
    .insert(&mut client.transact_mut(), 0, &"y".repeat(5_000));
    let update = diff(&client, &content);
    let mut alone = validator(Kind::Quiz, &content);
    let probe = copy_of(&content, 5);
    let (result, _) = admit(&mut alone, &probe, &update);
    assert!(matches!(result, Ok(Admission::Accepted)), "{result:?}");
    let mut together = validator(Kind::Quiz, &content);
    together.peer = Some(notes::limits::Metrics {
        content_bytes: notes::limits::MAX_CONTENT_BYTES - 1_000,
        max_depth: 1,
        node_count: 1,
    });
    let (result, _) = admit(&mut together, &content, &update);
    assert!(matches!(result, Err(Refusal::Limit { .. })), "{result:?}");
}

/// REVIEW1 M1: Undo of a removal re-creates only what an editor wrote, so the
/// room admits it: a question, an ordering item, a matching option, a type
/// change. Fails if the server writes into either document again (a reader
/// copy, a slot), which an editor's Undo would re-create and the room refuse.
#[test]
fn undo_of_removals_and_type_changes_is_admitted() {
    let questions = fixtures();
    let (ordering_question, ordering) = part_of(&questions, "ordering");
    let (_, matching) = part_of(&questions, "matching");
    type Edit = Box<dyn Fn(&Doc)>;
    let cases: Vec<(Kind, &str, Edit)> = vec![
        (
            Kind::Quiz,
            "questions",
            Box::new({
                let q = ordering_question.clone();
                move |doc| {
                    doc.get_or_insert_map("questions")
                        .remove(&mut doc.transact_mut(), &q);
                }
            }),
        ),
        (
            Kind::QuizKeys,
            "keys",
            Box::new({
                let part = ordering.clone();
                move |doc| {
                    doc.get_or_insert_map("keys")
                        .remove(&mut doc.transact_mut(), &part);
                }
            }),
        ),
        (
            Kind::QuizKeys,
            "keys",
            Box::new({
                let part = ordering.clone();
                move |doc| {
                    let items = map_in(doc, &["keys", &part, "items"]);
                    let first = first_key(&items, doc);
                    items.remove(&mut doc.transact_mut(), &first);
                }
            }),
        ),
        (
            Kind::QuizKeys,
            "keys",
            Box::new({
                let part = matching.clone();
                move |doc| {
                    let options = map_in(doc, &["keys", &part, "options"]);
                    let first = first_key(&options, doc);
                    options.remove(&mut doc.transact_mut(), &first);
                }
            }),
        ),
        (
            Kind::QuizKeys,
            "keys",
            Box::new({
                let part = ordering.clone();
                move |doc| {
                    let root = doc.get_or_insert_map("keys");
                    let mut txn = doc.transact_mut();
                    let key = root.insert(&mut txn, part.as_str(), MapPrelim::default());
                    key.insert(&mut txn, "type", "mcq");
                }
            }),
        ),
    ];
    for (kind, root_name, edit) in cases {
        let (content, keys, client_content, client_keys) = rooms(&questions);
        let (room, client) = match kind {
            Kind::QuizKeys => (keys, client_keys),
            _ => (content, client_content),
        };
        let root = client.get_or_insert_map(root_name);
        let mut undo: UndoManager = UndoManager::with_options(Default::default());
        undo.expand_scope(&client, &root);
        edit(&client);
        let mut check = validator(kind, &room);
        accepted(&mut check, &room, &client);
        assert!(undo.undo_blocking(), "nothing to undo");
        accepted(&mut check, &room, &client);
    }
}

/// A seeded pick: the same shuffle every run.
fn seeded(seed: u64) -> impl FnMut(usize) -> usize {
    let mut state = seed;
    move |n| {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((state >> 33) % n as u64) as usize
    }
}

/// Security regression (D3 as revised by Epo 2026-10-10): an editor typing
/// ordering items one by one in answer order. The readers' lists are plain
/// texts outside Yjs: every list a set change makes is a fresh shuffle (not
/// the last list with the new item added), the content document never holds
/// an item, and a reader who arrives afterwards gets one list whose order is
/// not the typing order. Fails if the lists follow the keys' order or grow
/// by appending.
#[test]
fn the_readers_lists_never_follow_typing_order() {
    let questions = fixtures();
    let (content, keys, _, _) = rooms(&questions);
    let (_, part) = part_of(&questions, "ordering");
    let items = map_in(&keys, &["keys", &part, "items"]);
    let held: Vec<String> = items.keys(&keys.transact()).map(str::to_owned).collect();
    for id in held {
        items.remove(&mut keys.transact_mut(), &id);
    }
    let mut lists = ReaderLists::default();
    let mut pick = seeded(42);
    lists.follow(&quiz::item_parts(&keys.transact()), &mut pick);
    let typed: Vec<String> = (1..=8).map(|n| format!("step {n}")).collect();
    let mut order: Option<String> = None;
    let mut appended = 0;
    let mut previous: Vec<String> = Vec::new();
    for (n, text) in typed.iter().enumerate() {
        let next = items::order::after(order.as_deref());
        let entry = items.insert(
            &mut keys.transact_mut(),
            format!("t{n}"),
            MapPrelim::default(),
        );
        entry.insert(&mut keys.transact_mut(), "order", next.as_str());
        entry.insert(
            &mut keys.transact_mut(),
            "text",
            TextPrelim::new(text.as_str()),
        );
        order = Some(next);
        let changed = lists.follow(&quiz::item_parts(&keys.transact()), &mut pick);
        let list = changed
            .into_iter()
            .find(|(id, _)| *id == part)
            .and_then(|(_, list)| list)
            .unwrap()
            .items;
        let mut sorted = list.clone();
        sorted.sort();
        let mut want = typed[..=n].to_vec();
        want.sort();
        assert_eq!(sorted, want, "each list holds the items once");
        if n > 0 && list[..n] == previous[..] {
            appended += 1;
        }
        previous = list;
    }
    assert!(appended < typed.len() - 2, "the lists grew by appending");
    // A reader arriving now gets one list, not in typing order, and the
    // content document holds none of the items.
    let (_, list) = lists.all().into_iter().find(|(id, _)| *id == part).unwrap();
    assert_ne!(list.items, typed, "the list follows the typing order");
    let state = content
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let held = String::from_utf8_lossy(&state);
    assert!(typed.iter().all(|t| !held.contains(t.as_str())));
    // A text edit keeps the order and changes only that text.
    let before = list.items.clone();
    text_in(&keys, &["keys", &part, "items", "t0"], "text").insert(
        &mut keys.transact_mut(),
        6,
        "!",
    );
    let changed = lists.follow(&quiz::item_parts(&keys.transact()), &mut pick);
    let after = changed[0].1.clone().unwrap().items;
    let edited: Vec<String> = before
        .iter()
        .map(|t| {
            if t == "step 1" {
                "step 1!".to_owned()
            } else {
                t.clone()
            }
        })
        .collect();
    assert_eq!(after, edited);
    // A part whose type changes away from ordering has no list any more.
    map_in(&keys, &["keys", &part]).insert(&mut keys.transact_mut(), "type", "short");
    let changed = lists.follow(&quiz::item_parts(&keys.transact()), &mut pick);
    assert_eq!(changed, vec![(part.clone(), None)]);
}

/// Security regression (REVIEW2 M2): a server write (the save API, the
/// agent's `replace_question`, bank copy) fills lists by position, so a
/// reorder keeps the item ids and moves texts between them. The readers'
/// list must then be a fresh shuffle, not the last list with each text
/// replaced by its new neighbour, which would show a reader old position to
/// new. Fails if the list keeps its order whenever the ids stay.
#[test]
fn a_server_reorder_reshuffles_the_readers_list() {
    let questions = fixtures();
    let (content, keys, _, _) = rooms(&questions);
    let (question, part) = part_of(&questions, "ordering");
    let at = questions
        .iter()
        .position(|q| q["id"] == json!(question))
        .unwrap();
    let periods = ["Permian", "Triassic", "Jurassic", "Cretaceous", "Paleogene"];
    let mut next = questions.clone();
    next[at]["parts"][0]["answer"]["items"] = json!(periods);
    quiz::set_questions(&mut content.transact_mut(), &mut keys.transact_mut(), &next).unwrap();
    let mut lists = ReaderLists::default();
    let mut pick = seeded(7);
    lists.follow(&quiz::item_parts(&keys.transact()), &mut pick);
    let before = lists
        .all()
        .into_iter()
        .find(|(id, _)| *id == part)
        .unwrap()
        .1
        .items;
    // What each reader slot would show if the order stayed: the id behind a
    // text before carries the text now at its keys position.
    let ids_before: Vec<(String, String)> = quiz::item_parts(&keys.transact())
        .into_iter()
        .find(|p| p.part == part)
        .unwrap()
        .entries;
    let mut reversed = periods;
    reversed.reverse();
    next[at]["parts"][0]["answer"]["items"] = json!(reversed);
    quiz::set_questions(&mut content.transact_mut(), &mut keys.transact_mut(), &next).unwrap();
    let ids_after: Vec<(String, String)> = quiz::item_parts(&keys.transact())
        .into_iter()
        .find(|p| p.part == part)
        .unwrap()
        .entries;
    assert_eq!(
        ids_before.iter().map(|(id, _)| id).collect::<Vec<_>>(),
        ids_after.iter().map(|(id, _)| id).collect::<Vec<_>>(),
        "the server write kept the ids (it fills by position)"
    );
    let text_of = |id: &str| ids_after.iter().find(|(i, _)| i == id).unwrap().1.clone();
    let id_of = |text: &str| {
        ids_before
            .iter()
            .find(|(_, t)| t == text)
            .unwrap()
            .0
            .clone()
    };
    let leaky: Vec<String> = before.iter().map(|text| text_of(&id_of(text))).collect();
    let changed = lists.follow(&quiz::item_parts(&keys.transact()), &mut pick);
    let after = changed
        .into_iter()
        .find(|(id, _)| *id == part)
        .and_then(|(_, list)| list)
        .expect("a push")
        .items;
    let mut sorted = after.clone();
    sorted.sort();
    let mut want: Vec<String> = periods.iter().map(|p| (*p).to_owned()).collect();
    want.sort();
    assert_eq!(sorted, want);
    assert_ne!(after, leaky, "the push maps old positions to new");
}

/// Security regression (REVIEW3 N1): an editor retyping two items in
/// separate windows (A to B, then B to A) changes one text each time. Kept
/// in place, a watching reader would see A's place become B and then B's
/// become A, so the two swapped places in the answer. A text retyped into
/// one another entry shows reshuffles the list. Fails if a single changed
/// text always keeps the order.
#[test]
fn a_text_retyped_into_another_entrys_reshuffles_the_readers_list() {
    let part = |texts: [&str; 4]| {
        vec![quiz::ItemsPart {
            part: "p1".to_owned(),
            kind: "ordering".to_owned(),
            entries: texts
                .iter()
                .enumerate()
                .map(|(n, text)| (format!("i{n}"), (*text).to_owned()))
                .collect(),
        }]
    };
    let draws = std::cell::Cell::new(0);
    let mut rng = seeded(3);
    let mut pick = |n: usize| {
        draws.set(draws.get() + 1);
        rng(n)
    };
    let mut lists = ReaderLists::default();
    lists.follow(&part(["Alpha", "Beta", "Gamma", "Delta"]), &mut pick);
    assert!(draws.get() > 0, "the first list is a shuffle");
    // Typing a text no other entry shows keeps the order.
    draws.set(0);
    lists.follow(&part(["Alphas", "Beta", "Gamma", "Delta"]), &mut pick);
    assert_eq!(draws.get(), 0, "typing keeps the order");
    // Retyping it into the text the second entry shows reshuffles.
    lists.follow(&part(["Beta", "Beta", "Gamma", "Delta"]), &mut pick);
    assert!(
        draws.get() > 0,
        "a retype into another entry's text keeps the order"
    );
    let mut held = lists.all().remove(0).1.items;
    held.sort();
    assert_eq!(held, ["Beta", "Beta", "Delta", "Gamma"]);
}

/// REVIEW1 S6: the save API writes what differs, so an editor typing into
/// the same question keeps their characters.
#[test]
fn the_save_api_keeps_concurrent_typing() {
    let questions = fixtures();
    let (content, keys, client, _) = rooms(&questions);
    let (question, part) = part_of(&questions, "mcq");
    let option = [
        "questions",
        &question,
        "parts",
        &part,
        "answer",
        "options",
        "o0",
    ];
    text_in(&client, &option, "text").insert(&mut client.transact_mut(), 0, "Very ");
    let mut next = questions.clone();
    let at = next
        .iter()
        .position(|q| q["id"] == json!(question))
        .unwrap();
    next[at]["stem"] = json!([{ "type": "text", "text": "A rewritten stem" }]);
    quiz::set_questions(&mut content.transact_mut(), &mut keys.transact_mut(), &next).unwrap();
    let mut check = validator(Kind::Quiz, &content);
    accepted(&mut check, &content, &client);
    let after = projected(&content, &keys);
    let merged = after.iter().find(|q| q["id"] == json!(question)).unwrap();
    assert_eq!(merged["stem"][0]["text"], json!("A rewritten stem"));
    assert!(
        merged["parts"][0]["answer"]["options"][0]
            .as_str()
            .unwrap()
            .starts_with("Very "),
        "{merged}"
    );
}

#[test]
fn the_save_api_rewrites_only_changed_questions() {
    let questions = fixtures();
    let (content, keys, _, _) = rooms(&questions);
    let mut next = questions.clone();
    let (question, _) = part_of(&questions, "boolean");
    let at = next
        .iter()
        .position(|q| q["id"] == json!(question))
        .unwrap();
    next[at]["parts"][0]["answer"]["correct"] = json!(true);
    next.swap(0, 1);
    let untouched = next[2]["id"].as_str().unwrap().to_owned();
    let branch =
        |doc: &Doc, id: &str| BranchPtr::from(map_in(doc, &["questions", id]).as_ref()).id();
    let kept = branch(&content, &untouched);
    quiz::set_questions(&mut content.transact_mut(), &mut keys.transact_mut(), &next).unwrap();
    assert_eq!(projected(&content, &keys), next);
    assert_eq!(
        branch(&content, &untouched),
        kept,
        "an unchanged question is not rewritten"
    );
    next.pop();
    quiz::set_questions(&mut content.transact_mut(), &mut keys.transact_mut(), &next).unwrap();
    assert_eq!(projected(&content, &keys), next);
}

/// The agent's question commands, computed on copies of both documents as
/// the server does, land in the two rooms, and each room's Undo
/// (`ydoc::undo`) brings the quiz back.
#[test]
fn agent_question_commands_apply_and_undo_in_the_rooms() {
    let questions = fixtures();
    let (content, keys, _, _) = rooms(&questions);
    let mut replaced = questions[0].clone();
    replaced["stem"] = json!([{ "type": "text", "text": "Rewritten stem" }]);
    let id = replaced["id"].as_str().unwrap().to_owned();
    let node = json!({ "type": "quiz_question", "id": id, "question": replaced, "children": [{ "text": "" }] });
    let commands = vec![DocumentCommand::ReplaceChild {
        parent_type: "quiz".into(),
        node_id: id.clone(),
        node,
    }];
    let copy = |room: &Doc, client: u64| {
        let doc = Doc::with_client_id(client);
        let whole = room
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        doc.transact_mut()
            .apply_update(Update::decode_v1(&whole).unwrap())
            .unwrap();
        doc
    };
    let (content_copy, keys_copy) = (copy(&content, 71), copy(&keys, 72));
    let (content_edit, keys_edit) = {
        let mut content_txn = content_copy.transact_mut();
        let mut keys_txn = keys_copy.transact_mut();
        quiz::apply_commands(&mut content_txn, &mut keys_txn, &commands).unwrap();
        (
            ydoc::undo::Captured::of(&mut content_txn),
            ydoc::undo::Captured::of(&mut keys_txn),
        )
    };
    let mut changes = Vec::new();
    for (room, copy, edit) in [
        (&content, &content_copy, content_edit),
        (&keys, &keys_copy, keys_edit),
    ] {
        let update = copy
            .transact()
            .encode_state_as_update_v1(&room.transact().state_vector());
        ydoc::undo::apply_kept(room, Update::decode_v1(&update).unwrap()).unwrap();
        changes.push((room, edit.change(room)));
    }
    assert_eq!(projected(&content, &keys)[0], replaced);
    for (room, change) in changes {
        // A document the edit left as it was has nothing to revert.
        let _ = ydoc::undo::revert(room, change);
    }
    assert_eq!(projected(&content, &keys), questions);
}

/// The asset ids a projection names beside its value: every image, in
/// complete questions or not.
#[test]
fn asset_ids_cover_incomplete_questions() {
    let questions = fixtures();
    let (content, keys, _, _) = rooms(&questions);
    let with_asset = questions
        .iter()
        .find(|q| serde_json::to_string(q).unwrap().contains("assetId"))
        .unwrap();
    let ids = quiz::asset_ids(&content.transact(), &keys.transact());
    assert!(!ids.is_empty());
    // Incomplete now (no correct option on any mcq does not matter here):
    // drop every key, the projection empties, the ids stay.
    let root = keys.get_or_insert_map("keys");
    let parts: Vec<String> = root.keys(&keys.transact()).map(str::to_owned).collect();
    for part in parts {
        let key = map_in(&keys, &["keys", &part]);
        key.insert(&mut keys.transact_mut(), "type", "none");
    }
    assert!(
        !projected(&content, &keys)
            .iter()
            .any(|q| q["id"] == with_asset["id"])
    );
    assert_eq!(quiz::asset_ids(&content.transact(), &keys.transact()), ids);
}
