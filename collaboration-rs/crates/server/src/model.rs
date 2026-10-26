//! What a material room's document is, by the material's kind: a Plate
//! document (notes, mindmaps, diagrams; the notes crate) or a live item
//! document (flashcard sets; the items crate, live-items DESIGN.md). Both
//! project to the same Plate envelope, so storage, projection, receipts and
//! evictions do not care which.

use notes::limits::Metrics;
use serde_json::Value;
use yrs::ReadTxn;

/// Why a quiz room loads read-only: one of its documents holds a question
/// block kind the room does not admit.
pub const UNKNOWN_QUIZ_BLOCK: &str =
    "a quiz document holds a question block kind the room does not admit";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Model {
    Note,
    Item(items::Kind),
}

impl Model {
    pub fn of(kind: &str) -> Model {
        match items::Kind::of_material(kind) {
            Some(item) => Model::Item(item),
            None => Model::Note,
        }
    }

    /// A quiz's content or keys document: it projects from both.
    pub fn quiz(self) -> bool {
        matches!(self, Model::Item(items::Kind::Quiz | items::Kind::QuizKeys))
    }

    pub fn assert_roots<T: ReadTxn>(self, txn: &T) -> Result<(), String> {
        match self {
            Model::Note => notes::validate::assert_roots(txn).map_err(|error| error.to_string()),
            Model::Item(kind) => kind.assert_roots(txn),
        }
    }

    /// The Plate value written to `materials.content`.
    pub fn value<T: ReadTxn>(self, txn: &T) -> Result<Vec<Value>, String> {
        match self {
            Model::Note => notes::plate::value(txn).map_err(|error| error.to_string()),
            Model::Item(kind) => Ok(kind.value(txn)),
        }
    }

    /// Everything the document holds as a Plate value (the shape check and
    /// the limits read it; an item's projection may leave blank cards out).
    pub fn document_value<T: ReadTxn>(self, txn: &T) -> Result<Vec<Value>, String> {
        match self {
            Model::Note => self.value(txn),
            Model::Item(kind) => Ok(kind.document_value(txn)),
        }
    }

    /// How the room serves its stored document of material kind `kind` (Epo
    /// 2026-10-13): one holding a reference's imported fence body (the quiz's
    /// answer keys, a `pending` not held at null) is refused, so no reader
    /// receives it; one the store would refuse (a type the embed catalog does not
    /// list, or not for this kind, a closed element's extra key, a reference
    /// without its row, ...) or, in this quiz document, a question block kind
    /// the room does not admit, loads read-only: the reason, which the load
    /// logs (every save would otherwise be refused and discard the room's
    /// edits). One projection and one store check per load, never per update.
    pub fn stored<T: ReadTxn>(self, kind: &str, txn: &T) -> Result<Option<String>, String> {
        match self {
            Model::Note => {
                if notes::plate::holds_pending_reference(txn) {
                    return Err("a material reference carries an imported fence body".into());
                }
                Ok(match notes::plate::value(txn) {
                    Ok(value) => notes::material::assert_canonical(&value, kind)
                        .err()
                        .map(|error| error.to_string()),
                    Err(error) => Some(error.to_string()),
                })
            }
            Model::Item(items::Kind::Quiz | items::Kind::QuizKeys) => {
                Ok(items::quiz::holds_unknown_block(txn).then(|| UNKNOWN_QUIZ_BLOCK.to_owned()))
            }
            Model::Item(items::Kind::Flashcards) => Ok(None),
        }
    }

    pub fn measure<T: ReadTxn>(self, txn: &T) -> Result<Metrics, String> {
        match self {
            Model::Note => notes::limits::measure(txn).map_err(|error| error.to_string()),
            Model::Item(kind) => Ok(notes::limits::measure_value(&kind.document_value(txn))),
        }
    }

    /// The document seeded from `materials.content`'s value, as it is (one
    /// a room may not serve is refused at load: [Model::stored]).
    pub fn state_from_value(self, value: &[Value]) -> Vec<u8> {
        match self {
            Model::Note => notes::slate_yjs::state_from_value(value, 0),
            Model::Item(kind) => kind.state_from_value(value, 0),
        }
    }

    /// The cheap repairs after an admitted `update` is applied (Epo
    /// 2026-10-19: repaired on entry first): a note's stripped keys and an
    /// emptied note's paragraph, an emptied set's blank card. What it
    /// repaired; the caller commits and broadcasts the transaction.
    pub fn repair_on_entry(
        self,
        txn: &mut yrs::TransactionMut,
        update: &yrs::Update,
        kind: &str,
    ) -> Vec<&'static str> {
        match self {
            Model::Note => notes::repair::on_entry(txn, update, kind),
            // Only a deletion empties a set.
            Model::Item(items::Kind::Flashcards) if !update.delete_set().is_empty() => {
                blank_card(txn)
            }
            Model::Item(_) => Vec::new(),
        }
    }

    /// Whether this document has repairs: a quiz's never does.
    pub fn repairs(self) -> bool {
        matches!(self, Model::Note | Model::Item(items::Kind::Flashcards))
    }

    /// The repairs a store refusal tries once before the room resets: an
    /// emptied note or set, repeated top-level ids.
    pub fn repair(self, txn: &mut yrs::TransactionMut, kind: &str) -> Vec<&'static str> {
        match self {
            Model::Note => notes::repair::repair(txn, kind),
            Model::Item(items::Kind::Flashcards) => blank_card(txn),
            Model::Item(_) => Vec::new(),
        }
    }

    /// The room's admission for this document, of material kind `kind`.
    pub fn validator(self, kind: &str, metrics: Metrics) -> RoomValidator {
        match self {
            Model::Note => RoomValidator::Note(notes::limits::Validator {
                bound: Some(metrics),
                metrics: Some(metrics),
                ..notes::limits::Validator::new(kind)
            }),
            Model::Item(kind) => RoomValidator::Item(items::Validator::new(kind, Some(metrics))),
        }
    }
}

fn blank_card(txn: &mut yrs::TransactionMut) -> Vec<&'static str> {
    let id = format!("card_{}", uuid::Uuid::new_v4().simple());
    if items::flashcards::repair(txn, &id) {
        vec!["a blank card in an emptied set"]
    } else {
        Vec::new()
    }
}

/// A writer's update checked against a material room.
pub enum Admitted {
    Accepted,
    Unheld,
    /// A limit: the writer hears `document-rejected` with the code.
    Limit(notes::limits::LimitCode, Metrics),
    Refused(String),
    /// A note draft typing into a block the room deleted (Q237).
    Hidden,
}

pub enum RoomValidator {
    Note(notes::limits::Validator),
    Item(items::Validator),
}

impl RoomValidator {
    /// `draft`: a draft send's update, refused when a note's typing would be
    /// hidden in a deleted block (live typing there is collaboration).
    pub fn admit(&mut self, doc: &yrs::Doc, update: &yrs::Update, draft: bool) -> Admitted {
        match self {
            RoomValidator::Note(validator) => match if draft {
                validator.admit_draft(doc, update)
            } else {
                validator.admit(doc, update)
            } {
                Ok(notes::limits::Admission::Accepted) => Admitted::Accepted,
                Ok(notes::limits::Admission::Unheld) => Admitted::Unheld,
                Err(notes::limits::Refusal::Limit { code, metrics }) => {
                    Admitted::Limit(code, metrics)
                }
                Err(notes::limits::Refusal::Hidden) => Admitted::Hidden,
                Err(error) => Admitted::Refused(error.to_string()),
            },
            RoomValidator::Item(validator) => match validator.admit(doc, update) {
                Ok(items::Admission::Accepted) => Admitted::Accepted,
                Ok(items::Admission::Unheld) => Admitted::Unheld,
                Err(items::Refusal::Limit { code, metrics }) => Admitted::Limit(code, metrics),
                Err(error) => Admitted::Refused(error.to_string()),
            },
        }
    }

    pub fn invalidate(&mut self) {
        match self {
            RoomValidator::Note(validator) => validator.invalidate(),
            RoomValidator::Item(validator) => validator.invalidate(),
        }
    }

    /// A quiz document: the other document's metrics (see `items::combine`).
    pub fn set_peer(&mut self, metrics: Metrics) {
        if let RoomValidator::Item(validator) = self {
            validator.peer = Some(metrics);
        }
    }

    pub fn peer(&self) -> Option<Metrics> {
        match self {
            RoomValidator::Item(validator) => validator.peer,
            RoomValidator::Note(_) => None,
        }
    }

    /// This document's metrics as admission bounds them (none: unknown until
    /// the next exact check).
    pub fn bound(&self) -> Option<Metrics> {
        match self {
            RoomValidator::Item(validator) => validator.bound,
            RoomValidator::Note(validator) => validator.bound,
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use serde_json::json;
    use yrs::Transact;

    use super::Model;

    fn note_stored(kind: &str, value: &[serde_json::Value]) -> Result<Option<String>, String> {
        let doc = ydoc::scratch_doc();
        ydoc::replay(
            &doc,
            &Model::Note.state_from_value(value),
            &[] as &[Vec<u8>],
        )
        .unwrap();
        Model::Note.stored(kind, &doc.transact())
    }

    /// Security regression (live-items REVIEW5): a note stored with a
    /// reference still carrying an imported fence body (the quiz's answer
    /// keys) is never served: its room refuses to load, so no reader joins
    /// it (Go's reads refuse it too). Fails if the room serves the fence body.
    #[test]
    fn a_stored_fence_body_is_never_served() {
        let body = json!({ "type": "p", "id": "body", "children": [{ "text": "Body" }] });
        let fence = json!({
            "type": "material_ref", "id": "fence", "materialId": "", "refKind": "quiz",
            "pending": "answer: SECRET", "children": [{ "text": "" }],
        });
        assert!(note_stored("note", &[body.clone(), fence]).is_err());
        assert_eq!(note_stored("note", &[body]), Ok(None));
    }

    /// A reference holding `pending` at null carries no fence body: the store
    /// and Go accept it, so its room loads writable. Fails if the load check
    /// counts the null entry and refuses a note every save path accepts.
    #[test]
    fn a_null_pending_loads() {
        let body = json!({ "type": "p", "id": "body", "children": [{ "text": "Body" }] });
        let reference = json!({
            "type": "material_ref", "id": "r", "materialId": "mat_quiz", "refKind": "quiz",
            "pending": null, "children": [{ "text": "" }],
        });
        assert_eq!(note_stored("note", &[body, reference]), Ok(None));
    }

    /// A stored Plate document the store would refuse loads read-only
    /// (decision 5), whatever the reason: a type the catalog does not list, a
    /// type it lists for another material kind, a closed element's extra key,
    /// a reference without its row; and the store's reason comes back for the
    /// load to log (R2-L1). Fails if any loads writable, where every save
    /// would be refused and discard the room's edits.
    #[test]
    fn a_stored_document_the_store_refuses_loads_read_only() {
        let body = json!({ "type": "p", "id": "body", "children": [{ "text": "Body" }] });
        let leaf = json!([{ "text": "" }]);
        let reference = |id: &str| json!({ "type": "material_ref", "id": "r", "materialId": id, "refKind": "quiz", "children": leaf });
        let map = json!({ "type": "mermaid", "id": "m", "source": "mindmap", "children": [
            { "type": "mermaid_caption", "children": [{ "text": "" }] },
        ] });
        let read_only = [
            (
                "note",
                json!({ "type": "timeline", "id": "t", "children": leaf }),
                "unknown element type",
            ),
            (
                "note",
                json!({ "type": "html_embed", "id": "h", "html": "<b>x</b>", "title": "old", "children": leaf }),
                "unexpected interactive field title",
            ),
            ("note", reference(""), "materialId is required"),
            (
                "mindmap",
                reference("mat_quiz"),
                "a mindmap cannot hold a material_ref block",
            ),
        ];
        for (kind, node, reason) in read_only {
            let value = if kind == "mindmap" {
                [map.clone(), node.clone()]
            } else {
                [body.clone(), node.clone()]
            };
            let stored = note_stored(kind, &value).unwrap();
            assert!(
                stored
                    .as_deref()
                    .is_some_and(|stored| stored.contains(reason)),
                "{kind}: {node}: {stored:?}"
            );
        }
        assert_eq!(
            note_stored("note", &[body.clone(), reference("mat_quiz")]),
            Ok(None)
        );
        assert_eq!(note_stored("mindmap", &[map]), Ok(None));
    }

    /// A stored quiz holding a block kind its rooms do not admit loads its
    /// room read-only instead of a save dropping the block; the room of the
    /// other document learns it from that document at load (`room::load`,
    /// tested in `tests/rooms.rs`). Fails if the quiz room loads writable.
    #[test]
    fn a_quiz_with_an_unknown_block_kind_loads_read_only() {
        let question = |stem: serde_json::Value| {
            json!({
                "id": "q1", "labels": "letters", "layout": "paper", "stem": stem,
                "parts": [{
                    "id": "q1:part:1", "marks": 1, "solution": [],
                    "blocks": [{ "type": "text", "text": "True?" }],
                    "answer": { "type": "boolean", "correct": true },
                }],
            })
        };
        let quiz = |stem: serde_json::Value| {
            [json!({ "type": "quiz", "id": "quiz", "children": [{
                "type": "quiz_question", "id": "q1", "question": question(stem),
                "children": [{ "text": "" }],
            }] })]
        };
        let stored = |stem: serde_json::Value| {
            let doc = ydoc::scratch_doc();
            let (content, _) = items::quiz::states_from_value(&quiz(stem), 0);
            ydoc::replay(&doc, &content, &[] as &[Vec<u8>]).unwrap();
            Model::Item(items::Kind::Quiz).stored("quiz", &doc.transact())
        };
        assert_eq!(
            stored(json!([{ "type": "timeline", "events": [] }])),
            Ok(Some(super::UNKNOWN_QUIZ_BLOCK.to_owned()))
        );
        assert_eq!(
            stored(json!([{ "type": "text", "text": "Stem" }])),
            Ok(None)
        );
    }
}
