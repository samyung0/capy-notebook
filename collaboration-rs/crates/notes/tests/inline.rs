#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! Plate's combobox inputs (`mention_input`, `slash_input`) stay inline in the
//! headless editor, as links, mentions and inline equations do (Epo,
//! 2026-10-07). The corpus holds no combobox input, so these are hand cases;
//! the expectations are what Node's slate + slate-yjs editor does with the
//! same `isInline` (with `isInline` false it unwraps the input after text into
//! "a @b").
mod common;

use notes::slate::editor::Editor;
use notes::{plate, slate_yjs};
use serde_json::{Value, json};
use yrs::Transact;
use yrs::branch::{Branch, BranchPtr};

/// Opens the headless editor on a note holding `value`: the operations its
/// normalization applied, its tree, and the note's projection after.
fn open(value: Value) -> (Vec<String>, Vec<Value>, Vec<Value>) {
    let state = slate_yjs::state_from_value(value.as_array().unwrap(), 1);
    let doc = common::doc(&state, 2);
    let root = doc.get_or_insert_text(plate::CONTENT_ROOT);
    let (operations, tree) = {
        let mut txn = doc.transact_mut();
        let editor = Editor::open(&mut txn, BranchPtr::from(root.as_ref() as &Branch)).unwrap();
        let operations = editor
            .operations
            .iter()
            .map(|op| {
                serde_json::to_value(op).unwrap()["type"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        (operations, editor.root.children.clone())
    };
    (operations, tree, plate::value(&doc.transact()).unwrap())
}

#[test]
fn combobox_inputs_normalize_and_project_as_inline() {
    for (kind, trigger) in [("mention_input", "@"), ("slash_input", "/")] {
        let input = json!({ "type": kind, "trigger": trigger, "children": [{ "text": format!("{trigger}b") }] });

        // After text: only the empty text Slate keeps after an inline; the
        // note keeps the input.
        let after_text = json!([{ "type": "p", "children": [{ "text": "a " }, input.clone()] }]);
        let (operations, tree, projected) = open(after_text.clone());
        assert_eq!(operations, ["insert_node"], "{kind}");
        assert_eq!(
            tree,
            [json!({ "type": "p", "children": [{ "text": "a " }, input.clone(), { "text": "" }] })],
            "{kind}"
        );
        assert_eq!(Value::from(projected), after_text, "{kind}");

        // Alone in a paragraph: empty texts on both sides, the note unchanged.
        let alone = json!([{ "type": "p", "children": [input.clone()] }]);
        let (operations, tree, projected) = open(alone.clone());
        assert_eq!(operations, ["insert_node", "insert_node"], "{kind}");
        assert_eq!(
            tree,
            [json!({ "type": "p", "children": [{ "text": "" }, input.clone(), { "text": "" }] })],
            "{kind}"
        );
        assert_eq!(Value::from(projected), alone, "{kind}");
    }
}
