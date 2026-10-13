//! What a material room's document is, by the material's kind: a Plate
//! document (notes, mindmaps, diagrams; the notes crate) or a live item
//! document (flashcard sets; the items crate, live-items DESIGN.md). Both
//! project to the same Plate envelope, so storage, projection, receipts and
//! evictions do not care which.

use notes::limits::Metrics;
use serde_json::Value;
use yrs::ReadTxn;

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

    /// How the room serves its stored document (Epo 2026-10-13): one holding
    /// a reference's imported fence body (the quiz's answer keys) is refused,
    /// as Go's reads refuse it, so no reader receives it; one holding a block
    /// this version cannot read (a type the embed catalog does not list, a
    /// quiz block kind the room does not admit) loads read-only (`true`).
    pub fn stored<T: ReadTxn>(self, txn: &T) -> Result<bool, String> {
        match self {
            Model::Note => {
                if notes::plate::holds_pending_reference(txn) {
                    return Err("a material reference carries an imported fence body".into());
                }
                Ok(notes::plate::unlisted_type(txn).is_some())
            }
            Model::Item(items::Kind::Quiz | items::Kind::QuizKeys) => {
                Ok(items::quiz::holds_unknown_block(txn))
            }
            Model::Item(items::Kind::Flashcards) => Ok(false),
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

/// A writer's update checked against a material room.
pub enum Admitted {
    Accepted,
    Unheld,
    /// A limit: the writer hears `document-rejected` with the code.
    Limit(notes::limits::LimitCode, Metrics),
    Refused(String),
}

pub enum RoomValidator {
    Note(notes::limits::Validator),
    Item(items::Validator),
}

impl RoomValidator {
    pub fn admit(&mut self, doc: &yrs::Doc, update: &yrs::Update) -> Admitted {
        match self {
            RoomValidator::Note(validator) => match validator.admit(doc, update) {
                Ok(notes::limits::Admission::Accepted) => Admitted::Accepted,
                Ok(notes::limits::Admission::Unheld) => Admitted::Unheld,
                Err(notes::limits::Refusal::Limit { code, metrics }) => {
                    Admitted::Limit(code, metrics)
                }
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

    /// Security regression (live-items REVIEW5): a note stored with a
    /// reference still carrying an imported fence body (the quiz's answer
    /// keys) is never served: its room refuses to load, so no reader joins
    /// it (Go's reads refuse it too). A note holding a block the catalog does
    /// not list loads read-only; a plain note loads for writers. Fails if the
    /// room serves the fence body.
    #[test]
    fn a_stored_fence_body_is_never_served() {
        let body = json!({ "type": "p", "id": "body", "children": [{ "text": "Body" }] });
        let fence = json!({
            "type": "material_ref", "id": "fence", "materialId": "", "refKind": "quiz",
            "pending": "answer: SECRET", "children": [{ "text": "" }],
        });
        let future = json!({ "type": "timeline", "id": "later", "children": [{ "text": "" }] });
        let stored = |value: &[serde_json::Value]| {
            let doc = ydoc::scratch_doc();
            ydoc::replay(
                &doc,
                &Model::Note.state_from_value(value),
                &[] as &[Vec<u8>],
            )
            .unwrap();
            Model::Note.stored(&doc.transact())
        };
        assert!(stored(&[body.clone(), fence]).is_err());
        assert_eq!(stored(&[body.clone(), future]), Ok(true));
        assert_eq!(stored(&[body]), Ok(false));
    }

    /// A stored quiz holding a block kind its rooms do not admit loads both
    /// rooms read-only, as a note holding an unlisted block does, instead of
    /// its projection dropping the block. Fails if a quiz room loads writable.
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
            Model::Item(items::Kind::Quiz).stored(&doc.transact())
        };
        assert_eq!(
            stored(json!([{ "type": "timeline", "events": [] }])),
            Ok(true)
        );
        assert_eq!(
            stored(json!([{ "type": "text", "text": "Stem" }])),
            Ok(false)
        );
    }
}
