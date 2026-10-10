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

    /// The document seeded from `materials.content`'s value.
    pub fn state_from_value(self, value: &[Value]) -> Vec<u8> {
        match self {
            Model::Note => notes::slate_yjs::state_from_value(value, 0),
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
}
