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

    pub fn measure<T: ReadTxn>(self, txn: &T) -> Result<Metrics, String> {
        match self {
            Model::Note => notes::limits::measure(txn).map_err(|error| error.to_string()),
            Model::Item(kind) => Ok(notes::limits::measure_value(&kind.document_value(txn))),
        }
    }

    /// The document seeded from `materials.content`'s value (a note without
    /// a reference's imported fence body: `notes::material::without_pending_refs`).
    pub fn state_from_value(self, value: &[Value]) -> Vec<u8> {
        match self {
            Model::Note => match notes::material::without_pending_refs(value) {
                Some(value) => notes::slate_yjs::state_from_value(&value, 0),
                None => notes::slate_yjs::state_from_value(value, 0),
            },
            Model::Item(kind) => kind.state_from_value(value, 0),
        }
    }

    /// The room's admission for this document.
    pub fn validator(self, metrics: Metrics) -> RoomValidator {
        match self {
            Model::Note => RoomValidator::Note(notes::limits::Validator {
                bound: Some(metrics),
                metrics: Some(metrics),
                ..Default::default()
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
    /// keys) seeds its room, which every reader joins, with an empty
    /// paragraph of the same id in its place. Fails if the seed keeps it.
    #[test]
    fn a_note_seeds_without_a_pending_fence_body() {
        let value = [
            json!({ "type": "p", "id": "body", "children": [{ "text": "Body" }] }),
            json!({
                "type": "material_ref", "id": "fence", "materialId": "", "refKind": "quiz",
                "pending": "answer: SECRET", "children": [{ "text": "" }],
            }),
        ];
        let doc = ydoc::scratch_doc();
        ydoc::replay(
            &doc,
            &Model::Note.state_from_value(&value),
            &[] as &[Vec<u8>],
        )
        .unwrap();
        let seeded = Model::Note.value(&doc.transact()).unwrap();
        assert_eq!(seeded[0]["id"], "body");
        assert_eq!(
            seeded[1],
            json!({ "type": "p", "id": "fence", "children": [{ "text": "" }] })
        );
    }
}
