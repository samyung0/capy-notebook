#![allow(clippy::unwrap_used)] // Tests panic on a broken fixture.
//! Quiz documents: the projection round trip over the shared question
//! fixtures, incomplete questions left out, two writers merging, the admit's
//! shape and cap refusals (work counted, never timed), the reader copies of
//! ordering items and matching options (D3), and the server's own writes.

use std::collections::HashMap;
use std::sync::Arc;

use items::quiz::{self, CopyPart};
use items::{Admission, Kind, Refusal, Validator};
use notes::edit::{DocumentCommand, EditError};
use serde_json::{Value, json};
use yrs::branch::{BranchID, BranchPtr};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, GetString, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Text, TextPrelim,
    TextRef, Transact, Update,
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

/// A seeded slot source: the same shuffle every run.
fn seeded(seed: u64) -> impl FnMut() -> String {
    let mut state = seed;
    move || {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        format!("{:016x}", state)
    }
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
    let (content, keys) = quiz::states_from_value(&quiz_value(questions), 0, &mut seeded(7));
    (
        load(&content, 1),
        load(&keys, 1),
        load(&content, 2),
        load(&keys, 2),
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
    // answers, marking schemes, solutions, pairs or ordering in the answer.
    let alone = quiz::content_document_value(&content.transact()).to_vec();
    let text = serde_json::to_string(&alone).unwrap();
    for question in &questions {
        for part in question["parts"].as_array().unwrap() {
            for solution in part["solution"].as_array().unwrap() {
                if let Some(t) = solution["text"].as_str().filter(|t| t.len() > 8) {
                    assert!(
                        !text.contains(t),
                        "a solution reached the content document: {t}"
                    );
                }
            }
        }
    }
}

#[test]
fn an_incomplete_question_stays_out_of_the_projection() {
    let questions = fixtures();
    let (content, keys, _, _) = rooms(&questions);
    let (question, part) = part_of(&questions, "mcq");
    // An editor clears the correct option: readers still see the question
    // live, the projection (and so grading) leaves it out.
    keys.transact_mut();
    map_in(&keys, &["keys", &part]).remove(&mut keys.transact_mut(), "correct");
    let ids: Vec<Value> = projected(&content, &keys)
        .iter()
        .map(|q| q["id"].clone())
        .collect();
    assert!(!ids.contains(&json!(question)));
    assert_eq!(ids.len(), questions.len() - 1);
    // Keys written for another answer type count as none.
    map_in(&keys, &["keys", &part]).insert(&mut keys.transact_mut(), "type", "multi");
    assert_eq!(projected(&content, &keys).len(), questions.len() - 1);
}

#[test]
fn two_editors_merge_an_option_and_its_correct_answer() {
    let questions = fixtures();
    let (content, keys, content_b, keys_b) = rooms(&questions);
    let (question, part) = part_of(&questions, "mcq");
    let options = [
        "questions",
        question.as_str(),
        "parts",
        part.as_str(),
        "answer",
        "options",
    ];
    // A types into option 0 in the content document; B, in the keys, makes
    // option 1 the correct one.
    let mut check = validator(Kind::Quiz, &content);
    let a = Doc::with_options(ydoc::doc_options(3));
    a.transact_mut()
        .apply_update(
            Update::decode_v1(
                &content
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default()),
            )
            .unwrap(),
        )
        .unwrap();
    text_in(&a, &[&options[..], &["o0"]].concat(), "text").insert(
        &mut a.transact_mut(),
        0,
        "Very ",
    );
    let (result, _) = admit(&mut check, &content, &diff(&a, &content));
    assert!(matches!(result, Ok(Admission::Accepted)), "{result:?}");
    assert_eq!(check.exact_checks, 0, "typing takes the bound");
    let mut keys_check = validator(Kind::QuizKeys, &keys);
    map_in(&keys_b, &["keys", &part]).insert(&mut keys_b.transact_mut(), "correct", "o1");
    let (result, _) = admit(&mut keys_check, &keys, &diff(&keys_b, &keys));
    assert!(matches!(result, Ok(Admission::Accepted)), "{result:?}");
    drop(content_b);
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
    let answer = [
        "questions",
        question.as_str(),
        "parts",
        ordering.as_str(),
        "answer",
    ];
    // Security regression (D3): the reader copy and its slots are the
    // server's alone.
    refused(
        Kind::Quiz,
        |doc| {
            let copy = map_in(doc, &[&answer[..], &["copy"]].concat());
            copy.insert(&mut doc.transact_mut(), "forged", MapPrelim::default());
        },
        "reader copy",
    );
    refused(
        Kind::Quiz,
        |doc| {
            map_in(doc, &answer).insert(&mut doc.transact_mut(), "copy", MapPrelim::default());
        },
        "reader copy",
    );
    refused(
        Kind::QuizKeys,
        |doc| {
            let items = map_in(doc, &["keys", &ordering, "items"]);
            let first = items.keys(&doc.transact()).next().unwrap().to_owned();
            map_in(doc, &["keys", &ordering, "items", &first]).insert(
                &mut doc.transact_mut(),
                "slot",
                "mine",
            );
        },
        "slot",
    );
    // Keys never go in the content document, nor stray roots anywhere.
    refused(
        Kind::Quiz,
        |doc| {
            map_in(doc, &answer).insert(&mut doc.transact_mut(), "items", MapPrelim::default());
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
            map_in(doc, &["questions", &question, "parts", &ordering]).insert(
                &mut doc.transact_mut(),
                "marks",
                "two",
            );
        },
        "outside its shape",
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

#[test]
fn texts_and_counts_past_their_caps_are_refused() {
    let questions = fixtures();
    let (question, part) = part_of(&questions, "open");
    // A part text past 12,000 characters, at once or bit by bit.
    let (content, _, client, _) = rooms(&questions);
    let blocks = map_in(&client, &["questions", &question, "parts", &part, "blocks"]);
    let first = blocks.keys(&client.transact()).next().unwrap().to_owned();
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

/// The order the copy's entries were created in (their Yjs clocks), as texts.
fn creation_order(content: &Doc, answer: &[&str]) -> Vec<String> {
    let copy = map_in(content, &[answer, &["copy"]].concat());
    let txn = content.transact();
    let mut entries: Vec<(u32, String)> = copy
        .iter(&txn)
        .map(|(_, value)| {
            let Out::YMap(entry) = value else {
                panic!("a copy entry")
            };
            let BranchID::Nested(id) = BranchPtr::from(entry.as_ref()).id() else {
                panic!("a nested entry")
            };
            let Some(Out::YText(text)) = entry.get(&txn, "text") else {
                panic!("a text")
            };
            (id.clock, text.get_string(&txn))
        })
        .collect();
    entries.sort();
    entries.into_iter().map(|(_, text)| text).collect()
}

fn display_order(content: &Doc, answer: &[&str]) -> Vec<String> {
    let copy = map_in(content, &[answer, &["copy"]].concat());
    let txn = content.transact();
    let mut entries: Vec<(String, String)> = copy
        .iter(&txn)
        .map(|(slot, value)| {
            let Out::YMap(entry) = value else {
                panic!("a copy entry")
            };
            let Some(Out::YText(text)) = entry.get(&txn, "text") else {
                panic!("a text")
            };
            (slot.to_owned(), text.get_string(&txn))
        })
        .collect();
    entries.sort();
    entries.into_iter().map(|(_, text)| text).collect()
}

/// The server's copy pass after a keys change, as the keys room runs it.
fn copy_pass(content: &Doc, keys: &Doc, slot: &mut dyn FnMut() -> String) -> Vec<CopyPart> {
    let parts = quiz::copy_parts(&keys.transact());
    let slots = quiz::apply_copy(&mut content.transact_mut(), &parts, slot);
    let root = keys.get_or_insert_map(quiz::KEYS_ROOT);
    quiz::apply_slots(&mut keys.transact_mut(), &root, &slots);
    parts
}

/// Security regression (D3, Epo 2026-10-10): an editor typing ordering items
/// one by one in answer order leaves a reader copy whose Yjs ids follow the
/// server's shuffle, not the typing, and whose slot order is that shuffle.
/// Fails if the server added copy entries one by one.
#[test]
fn the_reader_copy_never_follows_typing_order() {
    let questions = fixtures();
    let (content, keys, _, _) = rooms(&questions);
    let (question, part) = part_of(&questions, "ordering");
    let answer = [
        "questions",
        question.as_str(),
        "parts",
        part.as_str(),
        "answer",
    ];
    let items = map_in(&keys, &["keys", &part, "items"]);
    let held: Vec<String> = items.keys(&keys.transact()).map(str::to_owned).collect();
    for id in held {
        items.remove(&mut keys.transact_mut(), &id);
    }
    let mut slot = seeded(42);
    copy_pass(&content, &keys, &mut slot);
    let typed: Vec<String> = (1..=8).map(|n| format!("step {n}")).collect();
    let mut order: Option<String> = None;
    for text in &typed {
        let next = items::order::after(order.as_deref());
        let entry = items.insert(
            &mut keys.transact_mut(),
            format!("t{text}").replace(' ', ""),
            MapPrelim::default(),
        );
        entry.insert(&mut keys.transact_mut(), "order", next.as_str());
        entry.insert(
            &mut keys.transact_mut(),
            "text",
            TextPrelim::new(text.as_str()),
        );
        order = Some(next);
        copy_pass(&content, &keys, &mut slot);
    }
    let created = creation_order(&content, &answer);
    let shown = display_order(&content, &answer);
    let mut sorted = created.clone();
    sorted.sort();
    assert_eq!(sorted, typed, "the copy holds every item once");
    assert_ne!(created, typed, "the copy's Yjs ids follow the typing order");
    assert_eq!(created, shown, "entries are created in slot order");
    // A text edit mirrors in place: no new entry, the order unchanged.
    let first = map_in(&keys, &["keys", &part, "items", "tstep1"]);
    let Some(Out::YText(text)) = first.get(&keys.transact(), "text") else {
        panic!()
    };
    text.insert(&mut keys.transact_mut(), 6, "!");
    let before = content.transact().state_vector();
    copy_pass(&content, &keys, &mut slot);
    assert_eq!(creation_order(&content, &answer).len(), typed.len());
    assert_eq!(
        display_order(&content, &answer)
            .iter()
            .filter(|t| t.ends_with('!'))
            .count(),
        1
    );
    let change = content.transact().encode_state_as_update_v1(&before);
    let structs = Update::decode_v1(&change).unwrap().blocks().count();
    assert!(structs <= 2, "{structs} structs for a one-character mirror");
}

#[test]
fn a_copy_the_server_failed_to_write_is_rewritten() {
    let questions = fixtures();
    let (content, keys, _, _) = rooms(&questions);
    let (question, part) = part_of(&questions, "matching");
    let answer = [
        "questions",
        question.as_str(),
        "parts",
        part.as_str(),
        "answer",
    ];
    // The copy lost an entry (a crash between the keys and content stores).
    let copy = map_in(&content, &[&answer[..], &["copy"]].concat());
    let gone = copy.keys(&content.transact()).next().unwrap().to_owned();
    copy.remove(&mut content.transact_mut(), &gone);
    copy_pass(&content, &keys, &mut seeded(3));
    let options = projected(&content, &keys)
        .into_iter()
        .find(|q| q["id"] == json!(question))
        .unwrap()["parts"][0]["answer"]["options"]
        .clone();
    let mut want: Vec<String> = serde_json::from_value(options).unwrap();
    let mut got = display_order(&content, &answer);
    want.sort();
    got.sort();
    assert_eq!(got, want);
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
    quiz::set_questions(
        &mut content.transact_mut(),
        &mut keys.transact_mut(),
        &next,
        &mut seeded(9),
    )
    .unwrap();
    assert_eq!(projected(&content, &keys), next);
    assert_eq!(
        branch(&content, &untouched),
        kept,
        "an unchanged question is not rewritten"
    );
    next.pop();
    quiz::set_questions(
        &mut content.transact_mut(),
        &mut keys.transact_mut(),
        &next,
        &mut seeded(9),
    )
    .unwrap();
    assert_eq!(projected(&content, &keys), next);
}

#[test]
fn agent_question_commands_apply_undo_and_refuse_a_changed_question() {
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
    let outcome = quiz::apply_commands(
        &mut content.transact_mut(),
        &mut keys.transact_mut(),
        &commands,
        &mut seeded(1),
    )
    .unwrap();
    assert_eq!(projected(&content, &keys)[0], replaced);
    quiz::verify_guards(&content.transact(), &keys.transact(), &outcome.guards).unwrap();
    quiz::apply_commands(
        &mut content.transact_mut(),
        &mut keys.transact_mut(),
        &outcome.inverse,
        &mut seeded(1),
    )
    .unwrap();
    assert_eq!(projected(&content, &keys), questions);
    // After someone changed it, the old guards refuse.
    let stale = quiz::verify_guards(&content.transact(), &keys.transact(), &outcome.guards);
    assert!(matches!(stale, Err(EditError::Edit { .. })));
}
