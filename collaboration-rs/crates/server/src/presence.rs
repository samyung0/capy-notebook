//! What an awareness state may hold, per room kind (Epo 2026-10-28,
//! todo-presence.md "Wire shapes"). The browser checks the same lists on
//! receive (`src/features/notes/notePresence.ts`,
//! `src/features/files/officeCursors.ts`). A state with a field its room kind
//! does not list, or a value of the wrong type or out of bounds, is neither
//! kept nor relayed (`room.rs` `on_awareness`, which also drops one past
//! `MAX_AWARENESS_ENTRY`): presence is best effort, so the sender hears
//! nothing.

use serde_json::{Map, Value};

/// Ids in a note's pointer and block selection runs.
const MAX_ID: usize = 64;
/// A caret position: base64 of `Y.encodeRelativePosition`.
const MAX_POSITION: usize = 64;
const MAX_RUNS: usize = 16;
/// The browser's 0–1000 of a block's box.
const MAX_COORDINATE: u64 = 1000;
/// Upload placeholder ids (`uploadPresence.ts`).
const MAX_UPLOADS: usize = 100;
const MAX_UPLOAD_ID: usize = 32;
/// An Office cursor's texts (`MAX_CURSOR_TEXT` in `officeProtocol.ts`).
const MAX_CURSOR_TEXT: usize = 1024;
/// A DOCX position: base64 of at most 1,024 bytes.
const MAX_CURSOR_BASE64: usize = 1368;
/// JavaScript's `Number.MAX_SAFE_INTEGER`, the browser's cell count bound.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// The fields a room kind's awareness may carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fields {
    /// A note's content room: caret anchor `s`, focus `f`, pointer `p`,
    /// block selection runs `b` and, from a writer only, the blocks it is
    /// uploading into (`uploads`).
    Note { uploads: bool },
    /// A source room (Office or text): the editor's `cursor`.
    Source,
    /// Items (quiz, flashcards, mindmap, diagram) and a quiz's keys: none,
    /// so every state is dropped.
    Nothing,
}

impl Fields {
    /// Whether `state` (a non-removal awareness state, as JSON) fits.
    pub fn admit(self, state: &str) -> bool {
        if self == Fields::Nothing {
            return false;
        }
        let Ok(Value::Object(state)) = serde_json::from_str::<Value>(state) else {
            return false;
        };
        state.iter().all(|(key, value)| match (self, key.as_str()) {
            (Fields::Note { .. }, "s" | "f") => base64(value, MAX_POSITION),
            (Fields::Note { .. }, "p") => value.is_null() || pointer(value),
            (Fields::Note { .. }, "b") => runs(value),
            (Fields::Note { uploads }, "uploads") => uploads && upload_ids(value),
            (Fields::Source, "cursor") => value.is_null() || office_cursor(value),
            _ => false,
        })
    }
}

/// A string of at most `max` UTF-16 units, as the browser's `length` counts
/// them (a UTF-8 byte count is never below it).
fn text(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|text| text.len() <= max || text.encode_utf16().count() <= max)
}

fn base64(value: &Value, max: usize) -> bool {
    value.as_str().is_some_and(|text| {
        text.len() <= max
            && text
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    })
}

fn count(value: &Value, max: u64) -> bool {
    value.as_u64().is_some_and(|number| number <= max)
}

/// `[blockId, x, y]`.
fn pointer(value: &Value) -> bool {
    matches!(value.as_array().map(Vec::as_slice), Some([id, x, y])
        if text(id, MAX_ID) && count(x, MAX_COORDINATE) && count(y, MAX_COORDINATE))
}

/// `[[firstId, lastId], ...]`.
fn runs(value: &Value) -> bool {
    value.as_array().is_some_and(|runs| {
        runs.len() <= MAX_RUNS
            && runs.iter().all(|run| {
                matches!(run.as_array().map(Vec::as_slice), Some([first, last])
                    if text(first, MAX_ID) && text(last, MAX_ID))
            })
    })
}

fn upload_ids(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|ids| ids.len() <= MAX_UPLOADS && ids.iter().all(|id| text(id, MAX_UPLOAD_ID)))
}

/// The object holds every one of `keys`, may hold `optional`, and holds
/// nothing else (the caller checks the values).
fn keys(object: &Map<String, Value>, keys: &[&str], optional: &[&str]) -> bool {
    object
        .keys()
        .all(|key| keys.contains(&key.as_str()) || optional.contains(&key.as_str()))
        && keys.iter().all(|key| object.contains_key(*key))
}

fn cell(value: &Value) -> bool {
    value.as_object().is_some_and(|cell| {
        keys(cell, &["row", "col"], &[])
            && count(&cell["row"], MAX_SAFE_INTEGER)
            && count(&cell["col"], MAX_SAFE_INTEGER)
    })
}

/// An Office cursor as Capy's adapter writes it to awareness: a DOCX story
/// and its base64 positions, an XLSX sheet and cell range, a PPTX slide and
/// shape (`isAwarenessCursor` in `officeCursors.ts`).
fn office_cursor(value: &Value) -> bool {
    let Some(cursor) = value.as_object() else {
        return false;
    };
    if cursor.contains_key("story") {
        keys(cursor, &["story", "anchor", "head"], &[])
            && text(&cursor["story"], MAX_CURSOR_TEXT)
            && base64(&cursor["anchor"], MAX_CURSOR_BASE64)
            && base64(&cursor["head"], MAX_CURSOR_BASE64)
    } else if cursor.contains_key("sheet") {
        keys(cursor, &["sheet", "anchor", "head"], &[])
            && text(&cursor["sheet"], MAX_CURSOR_TEXT)
            && cell(&cursor["anchor"])
            && cell(&cursor["head"])
    } else {
        keys(cursor, &["slideId"], &["shapeId"])
            && text(&cursor["slideId"], MAX_CURSOR_TEXT)
            && cursor
                .get("shapeId")
                .is_none_or(|shape| text(shape, MAX_CURSOR_TEXT))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: Fields = Fields::Note { uploads: true };

    #[test]
    fn a_note_state_holds_only_its_fields_within_bounds() {
        let ok = |state: &str| NOTE.admit(state);
        assert!(ok("{}"));
        assert!(ok(r#"{"s":"AQKS9tMIAQA=","f":"AQKS9tMIBwA="}"#));
        assert!(ok(&format!(r#"{{"s":"{}"}}"#, "A".repeat(64))));
        assert!(!ok(&format!(r#"{{"s":"{}"}}"#, "A".repeat(65))));
        assert!(!ok(r#"{"s":"not base64!"}"#));
        assert!(!ok(r#"{"s":1}"#));
        assert!(ok(r#"{"p":null}"#));
        assert!(ok(r#"{"p":["b1",0,1000]}"#));
        assert!(!ok(r#"{"p":["b1",1001,0]}"#));
        assert!(!ok(r#"{"p":["b1",-1,0]}"#));
        assert!(!ok(r#"{"p":["b1",0.5,0]}"#));
        assert!(!ok(r#"{"p":["b1",0]}"#));
        assert!(!ok(&format!(r#"{{"p":["{}",0,0]}}"#, "i".repeat(65))));
        // 64 UTF-16 units, 128 UTF-8 bytes.
        assert!(ok(&format!(r#"{{"p":["{}",0,0]}}"#, "é".repeat(64))));
        let runs = |n: usize| format!(r#"{{"b":[{}]}}"#, vec![r#"["a","b"]"#; n].join(","));
        assert!(ok(&runs(16)));
        assert!(!ok(&runs(17)));
        assert!(!ok(r#"{"b":[["a"]]}"#));
        assert!(ok(r#"{"uploads":["abc"]}"#));
        assert!(!ok(&format!(r#"{{"uploads":["{}"]}}"#, "u".repeat(33))));
        let uploads = |n: usize| format!(r#"{{"uploads":[{}]}}"#, vec![r#""u""#; n].join(","));
        assert!(ok(&uploads(100)));
        assert!(!ok(&uploads(101)));
        // A read-only channel uploads nothing.
        assert!(!Fields::Note { uploads: false }.admit(r#"{"uploads":["abc"]}"#));
        // Today's slate-yjs shape, and a colour a peer would paint.
        assert!(!ok(
            r#"{"data":{"color":"url(https://x)"},"selection":null}"#
        ));
        // An escaped key is the key a browser reads (REVIEW5 R1).
        assert!(!ok(r#"{"data":1}"#));
        assert!(ok(r#"{"s":"AA=="}"#));
        // An unpaired surrogate serde_json refuses (REVIEW5 R1b), and JSON
        // that is not an object.
        assert!(!ok(r#"{"s":"AA","x":"\ud800"}"#));
        assert!(!ok("[]"));
        assert!(!ok("{"));
    }

    #[test]
    fn a_source_state_holds_only_an_office_cursor() {
        let ok = |state: &str| Fields::Source.admit(state);
        assert!(ok(r#"{"cursor":null}"#));
        assert!(ok(
            r#"{"cursor":{"story":"body","anchor":"AQI=","head":"AQI="}}"#
        ));
        assert!(!ok(
            r#"{"cursor":{"story":"body","anchor":[1,2],"head":[1,2]}}"#
        ));
        assert!(!ok(&format!(
            r#"{{"cursor":{{"story":"body","anchor":"{}","head":""}}}}"#,
            "A".repeat(1369)
        )));
        let cell = r#"{"row":2,"col":1}"#;
        assert!(ok(&format!(
            r#"{{"cursor":{{"sheet":"S1","anchor":{cell},"head":{cell}}}}}"#
        )));
        assert!(!ok(&format!(
            r#"{{"cursor":{{"sheet":"S1","anchor":{cell},"head":{{"row":-1,"col":1}}}}}}"#
        )));
        assert!(ok(r#"{"cursor":{"slideId":"s1"}}"#));
        assert!(ok(r#"{"cursor":{"slideId":"s1","shapeId":"sp2"}}"#));
        assert!(!ok(r#"{"cursor":{"slideId":"s1","name":"Mallory"}}"#));
        assert!(!ok(r#"{"cursor":null,"user":{"name":"Mallory"}}"#));
        assert!(!ok(r#"{"s":"AA=="}"#));
    }

    #[test]
    fn items_and_keys_rooms_keep_no_state() {
        assert!(!Fields::Nothing.admit("{}"));
        assert!(!Fields::Nothing.admit(r#"{"cursor":null}"#));
    }
}
