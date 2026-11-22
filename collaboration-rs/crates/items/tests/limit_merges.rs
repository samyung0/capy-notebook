#![allow(clippy::unwrap_used)]
//! Two writers start from one room state, each stays within a cap, and the
//! room admits their updates one after the other, as `room.rs` does (Epo
//! 2026-11-22, "Yes, A everywhere"): the merge past the cap is admitted and
//! every reader keeps it whole, up to twice the cap; past twice it, refused.

use items::{Admission, Kind, Refusal, Validator, quiz};
use notes::limits::{self, Admission as NoteAdmission, Refusal as NoteRefusal, merged_cap};
use notes::questions as q;
use notes::{material, order, plate, slate_yjs};
use serde_json::{Value, json};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Text, TextPrelim, Transact,
    Update, Xml, XmlTextRef,
};

fn load(state: &[u8], client: u64) -> Doc {
    let doc = Doc::with_options(ydoc::doc_options(client));
    doc.transact_mut()
        .apply_update(Update::decode_v1(state).unwrap())
        .unwrap();
    doc
}

fn copy_of(doc: &Doc, client: u64) -> Doc {
    load(
        &doc.transact()
            .encode_state_as_update_v1(&StateVector::default()),
        client,
    )
}

fn diff(client: &Doc, room: &Doc) -> Vec<u8> {
    client
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector())
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

fn last_order(doc: &Doc, map: &MapRef) -> String {
    let txn = doc.transact();
    map.iter(&txn)
        .filter_map(|(_, value)| match value {
            Out::Any(Any::String(order)) => Some(order.to_string()),
            Out::Any(Any::Map(entry)) => match entry.get("order") {
                Some(Any::String(order)) => Some(order.to_string()),
                _ => None,
            },
            Out::YMap(entry) => match entry.get(&txn, "order") {
                Some(Out::Any(Any::String(order))) => Some(order.to_string()),
                _ => None,
            },
            _ => None,
        })
        .max()
        .unwrap()
}

/* ------------------------------------------------------------------ quiz */

fn part(id: &str) -> Value {
    json!({
        "id": id, "blocks": [{ "type": "text", "text": "Answer?" }],
        "answer": { "type": "short", "accepted": ["alpha"] }, "marks": 1, "solution": [],
    })
}

fn question(stem: Value, parts: usize) -> Value {
    json!({
        "id": "q1", "layout": "paper", "labels": "letters", "stem": stem,
        "parts": (1..=parts).map(|n| part(&format!("part-{n}"))).collect::<Vec<_>>(),
    })
}

fn chart(labels: usize) -> Value {
    json!({
        "type": "chart", "kind": "bar", "title": "T",
        "labels": (0..labels).map(|n| format!("L{n}")).collect::<Vec<_>>(),
        "series": [{ "name": "S", "values": vec![1; labels] }],
    })
}

fn graph(points: usize) -> Value {
    json!({
        "type": "graph", "board": { "bbox": [-5, 5, 5, -5], "axis": true, "grid": true },
        "elements": (0..points).map(|n| json!({ "type": "point", "id": format!("p{n}"), "coords": [0, n] })).collect::<Vec<_>>(),
        "width": 320, "height": 190,
    })
}

/// The quiz's content and keys rooms for one question.
fn quiz_rooms(question: &Value) -> (Doc, Doc) {
    quiz_rooms_of(std::slice::from_ref(question))
}

/// The quiz's content and keys rooms for `questions`.
fn quiz_rooms_of(questions: &[Value]) -> (Doc, Doc) {
    let children: Vec<Value> = questions
        .iter()
        .map(|question| {
            json!({ "type": "quiz_question", "id": question["id"], "question": question, "children": [{ "text": "" }] })
        })
        .collect();
    let value = vec![json!({ "type": "quiz", "id": "quiz", "children": children })];
    let (content, keys) = quiz::states_from_value(&value, 0);
    (load(&content, 1), load(&keys, 1))
}

/// Questions `q1`.. holding `parts` short parts in all, at most seven each,
/// the first `open` of them open.
fn many_parts(parts: usize, open: usize) -> Vec<Value> {
    let ids: Vec<usize> = (0..parts).collect();
    ids.chunks(q::QUIZ_QUESTION_PARTS_MAX)
        .enumerate()
        .map(|(at, chunk)| {
            let parts: Vec<Value> = chunk
                .iter()
                .map(|&n| {
                    let mut part = part(&format!("part-{n}"));
                    if n < open {
                        part["answer"] = json!({ "type": "open", "accepted": [] });
                        part["markscheme"] = json!([{ "marks": 1, "text": "Names it." }]);
                    }
                    part
                })
                .collect();
            json!({
                "id": format!("q{}", at + 1), "layout": "paper", "labels": "letters",
                "stem": [], "parts": parts,
            })
        })
        .collect()
}

/// Two writers' updates admitted one after the other into `room`.
fn both_admitted(kind: Kind, room: &Doc, a: &Doc, b: &Doc) {
    let mut check = validator(kind, room);
    accepted(&mut check, room, a);
    accepted(&mut check, room, b);
    kind.check_caps(&room.transact()).unwrap();
}

/// Adds an id after the last one to an axis map (a chart's series, a table's
/// rows or columns), named `name` when the block names its entries.
fn add_axis_entry(client: &Doc, block: &[&str], axis: &str, id: &str) {
    let map = map_in(client, &[block, &[axis]].concat());
    let key = order::after(Some(&last_order(client, &map)));
    let names = (axis == "series").then(|| map_in(client, &[block, &["names"]].concat()));
    let mut txn = client.transact_mut();
    map.insert(&mut txn, id, key.as_str());
    if let Some(names) = names {
        names.insert(&mut txn, id, format!("N{id}"));
    }
}

fn validator(kind: Kind, doc: &Doc) -> Validator {
    let metrics = notes::limits::measure_value(&kind.document_value(&doc.transact()));
    Validator::new(kind, Some(metrics))
}

fn quiz_admit(validator: &mut Validator, room: &Doc, client: &Doc) -> Result<Admission, Refusal> {
    let update = diff(client, room);
    let result = validator.admit(room, &Update::decode_v1(&update).unwrap());
    if matches!(result, Ok(Admission::Accepted)) {
        room.transact_mut()
            .apply_update(Update::decode_v1(&update).unwrap())
            .unwrap();
    }
    result
}

fn accepted(validator: &mut Validator, room: &Doc, client: &Doc) {
    let result = quiz_admit(validator, room, client);
    assert!(matches!(result, Ok(Admission::Accepted)), "{result:?}");
}

/// The questions the quiz projects to `materials.content` (complete ones).
fn projected(content: &Doc, keys: &Doc) -> Vec<Value> {
    quiz::questions_from_value(&quiz::value(&content.transact(), &keys.transact()))
}

/// The questions as server writers read them, keys included.
fn read(content: &Doc, keys: &Doc) -> Vec<Value> {
    quiz::questions_json(
        &content.transact(),
        Some(&quiz::KeysRead::new(&keys.transact())),
    )
}

/// Adds a label (id, name, a value for the first series) after the last one.
fn add_label(client: &Doc, block: &[&str], id: &str) {
    let map = |key: &str| map_in(client, &[block, &[key]].concat());
    let (labels, names, values, series) =
        (map("labels"), map("names"), map("values"), map("series"));
    let first = series.keys(&client.transact()).next().unwrap().to_owned();
    let key = order::after(Some(&last_order(client, &labels)));
    let mut txn = client.transact_mut();
    labels.insert(&mut txn, id, key.as_str());
    names.insert(&mut txn, id, format!("N{id}"));
    values.insert(&mut txn, format!("{first}/{id}"), 1.0);
}

fn add_point(client: &Doc, elements: &MapRef, id: &str) {
    let key = order::after(Some(&last_order(client, elements)));
    let entry: Any = serde_json::from_value(json!({
        "element": { "type": "point", "id": id, "coords": [1, 1] }, "order": key,
    }))
    .unwrap();
    elements.insert(&mut client.transact_mut(), id, entry);
}

fn add_part(client: &Doc, id: &str) {
    let parts = map_in(client, &["questions", "q1", "parts"]);
    let last = last_order(client, &parts);
    let mut txn = client.transact_mut();
    let new = parts.insert(&mut txn, id, MapPrelim::default());
    new.insert(&mut txn, "order", order::after(Some(&last)).as_str());
}

const STEM: [&str; 4] = ["questions", "q1", "stem", "b0"];

#[test]
fn quiz_chart_labels_merged_past_the_cap_are_kept_and_projected() {
    let (content, keys) = quiz_rooms(&question(
        json!([chart(q::QUESTION_CHART_LABELS_MAX - 1)]),
        1,
    ));
    let (a, b) = (copy_of(&content, 3), copy_of(&content, 4));
    add_label(&a, &STEM, "la");
    add_label(&b, &STEM, "lb");
    let mut check = validator(Kind::Quiz, &content);
    accepted(&mut check, &content, &a);
    accepted(&mut check, &content, &b);
    Kind::Quiz.check_caps(&content.transact()).unwrap();
    let questions = projected(&content, &keys);
    assert_eq!(questions.len(), 1, "the question stays in the stored quiz");
    let labels = questions[0]["stem"][0]["labels"].as_array().unwrap().len();
    assert_eq!(labels, q::QUESTION_CHART_LABELS_MAX + 1);
}

#[test]
fn quiz_chart_labels_at_twice_the_cap_take_no_more() {
    let most = merged_cap(q::QUESTION_CHART_LABELS_MAX);
    let (content, keys) = quiz_rooms(&question(json!([chart(most)]), 1));
    assert_eq!(projected(&content, &keys).len(), 1, "twice the cap reads");
    let a = copy_of(&content, 3);
    add_label(&a, &STEM, "la");
    let mut check = validator(Kind::Quiz, &content);
    assert!(quiz_admit(&mut check, &content, &a).is_err());
}

#[test]
fn quiz_graph_merged_to_101_projects_every_point_and_a_server_write_keeps_them() {
    let (content, keys) = quiz_rooms(&question(
        json!([graph(q::QUESTION_GRAPH_ELEMENTS_MAX - 1)]),
        1,
    ));
    let (a, b) = (copy_of(&content, 3), copy_of(&content, 4));
    let path = [&STEM[..], &["elements"]].concat();
    add_point(&a, &map_in(&a, &path), "pz");
    add_point(&b, &map_in(&b, &path), "pa");
    let mut check = validator(Kind::Quiz, &content);
    accepted(&mut check, &content, &a);
    accepted(&mut check, &content, &b);
    Kind::Quiz.check_caps(&content.transact()).unwrap();
    let ids = |content: &Doc| -> Vec<String> {
        projected(content, &keys)[0]["stem"][0]["elements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let shown = ids(&content);
    assert_eq!(shown.len(), q::QUESTION_GRAPH_ELEMENTS_MAX + 1);
    assert!(shown.contains(&"pa".to_owned()) && shown.contains(&"pz".to_owned()));
    // A server write (the agent's, the content API's set_questions) that
    // changes the figure rewrites it from a read that holds every point.
    let mut changed = read(&content, &keys);
    changed[0]["stem"][0]["width"] = json!(330);
    quiz::set_questions(
        &mut content.transact_mut(),
        &mut keys.transact_mut(),
        &changed,
    )
    .unwrap();
    assert_eq!(map_in(&content, &path).len(&content.transact()), 101);
}

#[test]
fn quiz_stem_text_typed_past_the_cap_by_two_is_kept() {
    let text = "x".repeat(q::QUESTION_TEXT_MAX - 2);
    let (content, keys) = quiz_rooms(&question(json!([{ "type": "text", "text": text }]), 1));
    let (a, b) = (copy_of(&content, 3), copy_of(&content, 4));
    for (client, typed) in [(&a, "aa"), (&b, "bb")] {
        let block = map_in(client, &STEM);
        let txn = client.transact();
        let Some(Out::YText(t)) = block.get(&txn, "text") else {
            panic!("no text")
        };
        drop(txn);
        let mut txn = client.transact_mut();
        let len = t.len(&txn);
        t.insert(&mut txn, len, typed);
    }
    let mut check = validator(Kind::Quiz, &content);
    accepted(&mut check, &content, &a);
    accepted(&mut check, &content, &b);
    let questions = projected(&content, &keys);
    let stem = questions[0]["stem"][0]["text"].as_str().unwrap();
    assert_eq!(stem.chars().count(), q::QUESTION_TEXT_MAX + 2);
}

#[test]
fn quiz_stem_text_at_twice_the_cap_takes_no_more() {
    let text = "x".repeat(merged_cap(q::QUESTION_TEXT_MAX));
    let (content, keys) = quiz_rooms(&question(json!([{ "type": "text", "text": text }]), 1));
    assert_eq!(projected(&content, &keys).len(), 1, "twice the cap reads");
    let a = copy_of(&content, 3);
    {
        let block = map_in(&a, &STEM);
        let txn = a.transact();
        let Some(Out::YText(t)) = block.get(&txn, "text") else {
            panic!("no text")
        };
        drop(txn);
        t.insert(&mut a.transact_mut(), 0, "y");
    }
    let mut check = validator(Kind::Quiz, &content);
    assert!(quiz_admit(&mut check, &content, &a).is_err());
}

#[test]
fn quiz_part_added_past_the_cap_by_two_is_kept() {
    let (content, _) = quiz_rooms(&question(
        json!([{ "type": "text", "text": "Q" }]),
        q::QUIZ_QUESTION_PARTS_MAX - 1,
    ));
    let (a, b) = (copy_of(&content, 3), copy_of(&content, 4));
    add_part(&a, "part-a");
    add_part(&b, "part-b");
    let mut check = validator(Kind::Quiz, &content);
    accepted(&mut check, &content, &a);
    accepted(&mut check, &content, &b);
    let held = map_in(&content, &["questions", "q1", "parts"]).len(&content.transact());
    assert_eq!(held as usize, q::QUIZ_QUESTION_PARTS_MAX + 1);
}

#[test]
fn quiz_parts_at_twice_the_cap_take_no_more() {
    let most = merged_cap(q::QUIZ_QUESTION_PARTS_MAX);
    let (content, keys) = quiz_rooms(&question(json!([{ "type": "text", "text": "Q" }]), most));
    assert_eq!(
        projected(&content, &keys)[0]["parts"]
            .as_array()
            .unwrap()
            .len(),
        most
    );
    let a = copy_of(&content, 3);
    add_part(&a, "part-x");
    let mut check = validator(Kind::Quiz, &content);
    match quiz_admit(&mut check, &content, &a) {
        Err(error) => assert!(error.to_string().contains("parts"), "{error}"),
        other => panic!("{other:?}"),
    }
}

/// An open part whose one marking item is worth `marks`.
fn open_question() -> Value {
    json!({
        "id": "q1", "layout": "paper", "labels": "letters", "stem": [],
        "parts": [{
            "id": "part-1", "blocks": [{ "type": "text", "text": "Explain." }],
            "answer": { "type": "open", "accepted": [] }, "marks": 2, "solution": [],
            "markscheme": [{ "marks": 2, "text": "Names it." }],
        }],
    })
}

/// Adds a marking item as an editor does (a fresh id, after the last one).
fn add_item(client: &Doc, id: &str, text: &str, marks: f64) {
    let list = map_in(client, &["keys", "part-1", "markscheme"]);
    let last = last_order(client, &list);
    let mut txn = client.transact_mut();
    let entry = list.insert(&mut txn, id, MapPrelim::default());
    entry.insert(&mut txn, "order", order::after(Some(&last)).as_str());
    entry.insert(&mut txn, "marks", marks);
    entry.insert(&mut txn, "text", TextPrelim::new(text));
}

#[test]
fn marking_items_two_editors_add_at_once_keep_the_question_worth_their_total() {
    let (content, keys) = quiz_rooms(&open_question());
    let (a, b) = (copy_of(&keys, 3), copy_of(&keys, 4));
    let (a_content, b_content) = (copy_of(&content, 5), copy_of(&content, 6));
    // Each editor adds an item and writes the part's marks as its own total.
    for (client, client_content, id) in [(&a, &a_content, "ma"), (&b, &b_content, "mb")] {
        add_item(client, id, "Explains it.", 3.0);
        let part = map_in(client_content, &["questions", "q1", "parts", "part-1"]);
        part.insert(&mut client_content.transact_mut(), "marks", 5.0);
    }
    let mut check = validator(Kind::QuizKeys, &keys);
    accepted(&mut check, &keys, &a);
    accepted(&mut check, &keys, &b);
    let mut check = validator(Kind::Quiz, &content);
    accepted(&mut check, &content, &a_content);
    accepted(&mut check, &content, &b_content);
    // The content's marks say 5 (each writer's own total); the items add to 8.
    let questions = projected(&content, &keys);
    assert_eq!(questions.len(), 1, "the question stays in the stored quiz");
    assert_eq!(
        questions[0]["parts"][0]["markscheme"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(questions[0]["parts"][0]["marks"], json!(8));
}

/// After a merge takes a part's items to 30, one editor writes marks 30 while
/// another turns the part closed: both go in, in either order, and the
/// question stays in the stored quiz (a closed part may hold twice the cap).
#[test]
fn marks_written_while_another_editor_turns_the_part_closed_both_go_in() {
    let part = ["questions", "q1", "parts", "part-1"];
    let answer = ["questions", "q1", "parts", "part-1", "answer"];
    for a_first in [true, false] {
        let (content, keys) = quiz_rooms(&open_question());
        let (a, b) = (copy_of(&content, 3), copy_of(&content, 4));
        map_in(&a, &part).insert(&mut a.transact_mut(), "marks", 30.0);
        {
            let (answer_map, part_map) = (map_in(&b, &answer), map_in(&b, &part));
            let mut txn = b.transact_mut();
            answer_map.insert(&mut txn, "type", "short");
            part_map.insert(&mut txn, "marks", q::QUESTION_MARKS_MAX);
        }
        {
            let key = map_in(&keys, &["keys", "part-1"]);
            let mut txn = keys.transact_mut();
            key.insert(&mut txn, "type", "short");
            key.remove(&mut txn, "markscheme");
            let accepted = key.insert(&mut txn, "accepted", MapPrelim::default());
            let entry = accepted.insert(&mut txn, "a1", MapPrelim::default());
            entry.insert(&mut txn, "order", "a0");
            entry.insert(&mut txn, "text", TextPrelim::new("alpha"));
        }
        let mut check = validator(Kind::Quiz, &content);
        let order = if a_first { [&a, &b] } else { [&b, &a] };
        for client in order {
            accepted(&mut check, &content, client);
        }
        Kind::Quiz.check_caps(&content.transact()).unwrap();
        let questions = projected(&content, &keys);
        assert_eq!(questions.len(), 1, "the question stays in the stored quiz");
        assert_eq!(questions[0]["parts"][0]["answer"]["type"], json!("short"));
    }
    // Past twice the cap, refused.
    let (content, _) = quiz_rooms(&question(json!([]), 1));
    let c = copy_of(&content, 5);
    map_in(&c, &part).insert(&mut c.transact_mut(), "marks", 41.0);
    match quiz_admit(&mut validator(Kind::Quiz, &content), &content, &c) {
        Err(error) => assert!(error.to_string().contains("whole marks"), "{error}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn quiz_chart_series_merged_past_the_cap_are_kept_and_projected() {
    let mut block = chart(3);
    block["series"] = json!(
        (0..q::QUESTION_CHART_SERIES_MAX - 1)
            .map(|n| json!({ "name": format!("S{n}"), "values": [1, 2, 3] }))
            .collect::<Vec<_>>()
    );
    let (content, keys) = quiz_rooms(&question(json!([block]), 1));
    let (a, b) = (copy_of(&content, 3), copy_of(&content, 4));
    add_axis_entry(&a, &STEM, "series", "sa");
    add_axis_entry(&b, &STEM, "series", "sb");
    both_admitted(Kind::Quiz, &content, &a, &b);
    let questions = projected(&content, &keys);
    assert_eq!(questions.len(), 1, "the question stays in the stored quiz");
    let series = questions[0]["stem"][0]["series"].as_array().unwrap().len();
    assert_eq!(series, q::QUESTION_CHART_SERIES_MAX + 1);
}

#[test]
fn quiz_table_rows_and_columns_merged_past_the_cap_are_kept_and_projected() {
    let (rows, columns) = (
        q::QUESTION_TABLE_ROWS_MAX - 1,
        q::QUESTION_TABLE_COLUMNS_MAX - 1,
    );
    let table = json!({
        "type": "table", "header": false,
        "rows": vec![vec!["c"; columns]; rows],
    });
    let (content, keys) = quiz_rooms(&question(json!([table]), 1));
    let (a, b) = (copy_of(&content, 3), copy_of(&content, 4));
    for (client, id) in [(&a, "a"), (&b, "b")] {
        add_axis_entry(client, &STEM, "rows", &format!("row-{id}"));
        add_axis_entry(client, &STEM, "columns", &format!("col-{id}"));
    }
    both_admitted(Kind::Quiz, &content, &a, &b);
    let questions = projected(&content, &keys);
    assert_eq!(questions.len(), 1, "the question stays in the stored quiz");
    let grid = questions[0]["stem"][0]["rows"].as_array().unwrap();
    assert_eq!(grid.len(), q::QUESTION_TABLE_ROWS_MAX + 1);
    assert_eq!(
        grid[0].as_array().unwrap().len(),
        q::QUESTION_TABLE_COLUMNS_MAX + 1
    );
}

#[test]
fn quiz_wide_parts_merged_past_the_cap_are_kept_and_projected() {
    let (content, keys) = quiz_rooms_of(&many_parts(q::QUIZ_PARTS_MAX - 1, 0));
    let last = format!(
        "q{}",
        (q::QUIZ_PARTS_MAX - 1).div_ceil(q::QUIZ_QUESTION_PARTS_MAX)
    );
    let (a, b) = (copy_of(&content, 3), copy_of(&content, 4));
    for (client, id) in [(&a, "part-a"), (&b, "part-b")] {
        let parts = map_in(client, &["questions", &last, "parts"]);
        let key = order::after(Some(&last_order(client, &parts)));
        let mut txn = client.transact_mut();
        let new = parts.insert(&mut txn, id, MapPrelim::default());
        new.insert(&mut txn, "order", key.as_str());
    }
    both_admitted(Kind::Quiz, &content, &a, &b);
    let held: usize = read(&content, &keys)
        .iter()
        .map(|question| question["parts"].as_array().unwrap().len())
        .sum();
    assert_eq!(held, q::QUIZ_PARTS_MAX + 1);
}

#[test]
fn ai_marked_parts_merged_past_the_cap_are_kept() {
    let open = q::QUIZ_OPEN_PARTS_MAX - 1;
    let (content, keys) = quiz_rooms_of(&many_parts(open + 2, open));
    let (a, b) = (copy_of(&content, 3), copy_of(&content, 4));
    // Each editor turns one of the two short parts open.
    for (client, n) in [(&a, open), (&b, open + 1)] {
        let question = format!("q{}", n / q::QUIZ_QUESTION_PARTS_MAX + 1);
        let answer = map_in(
            client,
            &[
                "questions",
                &question,
                "parts",
                &format!("part-{n}"),
                "answer",
            ],
        );
        answer.insert(&mut client.transact_mut(), "type", "open");
    }
    both_admitted(Kind::Quiz, &content, &a, &b);
    let marked = read(&content, &keys)
        .iter()
        .flat_map(|question| question["parts"].as_array().unwrap().clone())
        .filter(|part| part["answer"]["type"] == "open")
        .count();
    assert_eq!(marked, q::QUIZ_OPEN_PARTS_MAX + 1);
}

#[test]
fn answer_options_merged_past_the_cap_are_kept_and_projected() {
    let options: Vec<String> = (0..q::QUESTION_ANSWERS_MAX - 1)
        .map(|n| format!("o{n}"))
        .collect();
    let mut mcq = question(json!([]), 1);
    mcq["parts"][0]["answer"] = json!({ "type": "mcq", "options": options, "correct": [0] });
    let (content, keys) = quiz_rooms(&mcq);
    let (a, b) = (copy_of(&content, 3), copy_of(&content, 4));
    for (client, id) in [(&a, "oa"), (&b, "ob")] {
        let list = map_in(
            client,
            &["questions", "q1", "parts", "part-1", "answer", "options"],
        );
        let key = order::after(Some(&last_order(client, &list)));
        let mut txn = client.transact_mut();
        let entry = list.insert(&mut txn, id, MapPrelim::default());
        entry.insert(&mut txn, "order", key.as_str());
        entry.insert(&mut txn, "text", TextPrelim::new(id));
    }
    both_admitted(Kind::Quiz, &content, &a, &b);
    let questions = projected(&content, &keys);
    assert_eq!(questions.len(), 1, "the question stays in the stored quiz");
    let options = questions[0]["parts"][0]["answer"]["options"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(options, q::QUESTION_ANSWERS_MAX + 1);
}

/// Two editors each type an open part's first sample answer at once (Epo
/// 2026-11-22, "then last save wins? ... dont"): both write the one fixed
/// entry key, so both updates are admitted in either order, one sample stays
/// and the question stays in the stored quiz. Fails if a writer keys the
/// sample freshly again (the second is refused: at most 1).
#[test]
fn two_first_sample_answers_at_once_leave_one() {
    let mut open = open_question();
    let sent = |text: &str| {
        let mut sent = open.clone();
        sent["parts"][0]["answer"]["accepted"] = json!([text]);
        sent
    };
    let (a_sent, b_sent) = (sent("alpha"), sent("beta"));
    open["parts"][0]["answer"]["accepted"] = json!([]);
    for a_first in [true, false] {
        let (content, keys) = quiz_rooms(&open);
        let clients = [(3, &a_sent), (4, &b_sent)].map(|(client, question)| {
            let (content, keys) = (copy_of(&content, client), copy_of(&keys, client + 10));
            quiz::set_questions(
                &mut content.transact_mut(),
                &mut keys.transact_mut(),
                std::slice::from_ref(question),
            )
            .unwrap();
            keys
        });
        let mut check = validator(Kind::QuizKeys, &keys);
        let order = if a_first { [0, 1] } else { [1, 0] };
        for at in order {
            accepted(&mut check, &keys, &clients[at]);
        }
        Kind::QuizKeys.check_caps(&keys.transact()).unwrap();
        let questions = projected(&content, &keys);
        assert_eq!(questions.len(), 1, "the question stays in the stored quiz");
        let samples = questions[0]["parts"][0]["answer"]["accepted"]
            .as_array()
            .unwrap();
        assert_eq!(samples.len(), 1, "{samples:?}");
    }
}

/// A server writer's rewrite of question q1 from `held` to `sent`, checked as
/// `compute_quiz` checks it.
fn written(held: &Value, sent: &Value) -> Result<(), String> {
    let (content, keys) = quiz_rooms(held);
    let before = quiz::held(&content.transact(), &keys.transact());
    quiz::set_questions(
        &mut content.transact_mut(),
        &mut keys.transact_mut(),
        std::slice::from_ref(sent),
    )?;
    quiz::check_written(&content.transact(), &keys.transact(), &before)
}

/// A writer's rewrite gives entries it cannot match their ids by place, so a
/// text a merge took past its cap is held by rank among its list's or
/// section's texts: trimming it while inserting a block before it, or removing
/// an option before it, goes in; growing it past what was held, growing a
/// sibling towards it, or adding a second long one beside it is refused.
/// Fails if the texts are held by entry id again, or by the longest alone.
#[test]
fn a_writer_trimming_an_over_cap_text_while_moving_entries_is_taken() {
    let over = "c".repeat(13_000);
    let trimmed = "c".repeat(12_500);
    let text = |text: &str| json!({ "type": "text", "text": text });
    let mcq = |blocks: Value, options: Value| {
        let mut held = question(json!([]), 1);
        held["parts"][0]["blocks"] = blocks;
        held["parts"][0]["answer"] = json!({ "type": "mcq", "options": options, "correct": [0] });
        held
    };
    let options = json!(["o0", "o1"]);
    written(
        &mcq(json!([text("A"), text(&over)]), options.clone()),
        &mcq(
            json!([text("A"), text("X"), text(&trimmed)]),
            options.clone(),
        ),
    )
    .unwrap();
    written(
        &mcq(json!([text("A")]), json!(["o0", over, "o2"])),
        &mcq(json!([text("A")]), json!([trimmed, "o2"])),
    )
    .unwrap();
    let grown = written(
        &mcq(json!([text("A"), text(&over)]), options.clone()),
        &mcq(
            json!([text("A"), text("X"), text(&format!("{over}c"))]),
            options.clone(),
        ),
    );
    assert_eq!(
        grown,
        Err("a question text holds at most 12000 characters".into())
    );
    let sibling = written(
        &mcq(json!([text("A")]), json!(["o0", over, "o2"])),
        &mcq(json!([text("A")]), json!(["o0", over, trimmed])),
    );
    assert_eq!(
        sibling,
        Err("an answer list holds at most 12000 characters".into())
    );
    let beside = written(
        &mcq(json!([text("A"), text(&over)]), options.clone()),
        &mcq(json!([text("A"), text(&over), text(&over)]), options),
    );
    assert_eq!(
        beside,
        Err("a question text holds at most 12000 characters".into())
    );
}

/// A part whose marking items two editors' adds took past twice the cap
/// reads as their total (45); a writer sending the question back with an edit
/// elsewhere writes its own marks at most 40, so the room admits the edit and
/// the total stays the warning the user tunes. Fails if the read total is
/// written as the part's own marks (refused: outside 1 to 40).
#[test]
fn a_part_worth_more_than_twice_the_cap_still_takes_an_edit() {
    let mut open = open_question();
    open["parts"][0]["marks"] = json!(40);
    open["parts"][0]["markscheme"] = json!([
        { "marks": 15, "text": "Names it." },
        { "marks": 15, "text": "Explains it." },
        { "marks": 15, "text": "Applies it." },
    ]);
    let (content, keys) = quiz_rooms(&open);
    let mut question = read(&content, &keys).remove(0);
    assert_eq!(question["parts"][0]["marks"], json!(45));
    question["stem"] = json!([{ "type": "text", "text": "Read the passage." }]);
    let before = quiz::held(&content.transact(), &keys.transact());
    let (writer, writer_keys) = (copy_of(&content, 3), copy_of(&keys, 4));
    quiz::set_questions(
        &mut writer.transact_mut(),
        &mut writer_keys.transact_mut(),
        std::slice::from_ref(&question),
    )
    .unwrap();
    quiz::check_written(&writer.transact(), &writer_keys.transact(), &before).unwrap();
    let mut check = validator(Kind::Quiz, &content);
    accepted(&mut check, &content, &writer);
    let part = &read(&content, &keys)[0]["parts"][0];
    assert_eq!(part["marks"], json!(45));
}

/* ------------------------------------------------------------------ note */

fn note_room(block: Value) -> Doc {
    let kind = block["type"].clone();
    let value = vec![
        json!({ "type": kind, "id": "f1", "block": block, "children": [{ "text": "" }] }),
        json!({ "type": "p", "id": "p1", "children": [{ "text": "text" }] }),
    ];
    load(&slate_yjs::state_from_value(&value, 1), 2)
}

fn note_block_map(doc: &Doc) -> MapRef {
    let txn = doc.transact();
    let element = match &plate::insert_delta(&plate::content_root(&txn).unwrap()).unwrap()[0].insert
    {
        plate::Insert::Element(branch) => XmlTextRef::from(*branch),
        plate::Insert::Text(_) => panic!("not a block"),
    };
    match element.get_attribute(&txn, "block") {
        Some(Out::YMap(map)) => map,
        other => panic!("{other:?}"),
    }
}

fn inner(doc: &Doc, map: &MapRef, key: &str) -> MapRef {
    match map.get(&doc.transact(), key) {
        Some(Out::YMap(inner)) => inner,
        other => panic!("{key}: {other:?}"),
    }
}

fn note_admit(
    validator: &mut limits::Validator,
    room: &Doc,
    client: &Doc,
) -> Result<NoteAdmission, NoteRefusal> {
    let update = diff(client, room);
    let result = validator.admit(room, &Update::decode_v1(&update).unwrap());
    if matches!(result, Ok(NoteAdmission::Accepted)) {
        room.transact_mut()
            .apply_update(Update::decode_v1(&update).unwrap())
            .unwrap();
    }
    result
}

#[test]
fn note_chart_labels_merged_past_the_cap_are_admitted_and_read_whole() {
    let room = note_room(chart(q::QUESTION_CHART_LABELS_MAX - 1));
    let (a, b) = (copy_of(&room, 3), copy_of(&room, 4));
    for (client, id) in [(&a, "la"), (&b, "lb")] {
        let block = note_block_map(client);
        let (labels, names, values, series) = (
            inner(client, &block, "labels"),
            inner(client, &block, "names"),
            inner(client, &block, "values"),
            inner(client, &block, "series"),
        );
        let first = series.keys(&client.transact()).next().unwrap().to_owned();
        let key = order::after(Some(&last_order(client, &labels)));
        let mut txn = client.transact_mut();
        labels.insert(&mut txn, id, key.as_str());
        names.insert(&mut txn, id, "N");
        values.insert(&mut txn, format!("{first}/{id}"), 1.0);
    }
    let mut check = limits::Validator::new("note");
    assert!(matches!(
        note_admit(&mut check, &room, &a),
        Ok(NoteAdmission::Accepted)
    ));
    assert!(matches!(
        note_admit(&mut check, &room, &b),
        Ok(NoteAdmission::Accepted)
    ));
    let value = plate::value(&room.transact()).unwrap();
    let labels = value[0]["block"]["labels"].as_array().unwrap().len();
    assert_eq!(labels, q::QUESTION_CHART_LABELS_MAX + 1);
    material::assert_canonical(&value, "note").unwrap();
}

#[test]
fn note_graph_merged_to_101_is_kept_and_read_whole() {
    let room = note_room(graph(q::QUESTION_GRAPH_ELEMENTS_MAX - 1));
    let (a, b) = (copy_of(&room, 3), copy_of(&room, 4));
    for (client, id) in [(&a, "pz"), (&b, "pa")] {
        let elements = inner(client, &note_block_map(client), "elements");
        add_point(client, &elements, id);
    }
    let mut check = limits::Validator::new("note");
    assert!(matches!(
        note_admit(&mut check, &room, &a),
        Ok(NoteAdmission::Accepted)
    ));
    assert!(matches!(
        note_admit(&mut check, &room, &b),
        Ok(NoteAdmission::Accepted)
    ));
    let value = plate::value(&room.transact()).unwrap();
    assert_eq!(value[0]["block"]["elements"].as_array().unwrap().len(), 101);
    material::assert_canonical(&value, "note").unwrap();
    let repaired = notes::repair::repair(&mut room.transact_mut(), "note");
    assert!(repaired.is_empty());
}
