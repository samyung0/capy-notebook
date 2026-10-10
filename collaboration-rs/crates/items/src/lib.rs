//! Pure functions over the live item documents (track live-items, DESIGN.md
//! in capy-harness/2026-10-06-rust-round/live-items): flashcard sets now,
//! quizzes and their keys documents next. No I/O: the server owns rooms,
//! Postgres and timers, as with the notes crate.
//!
//! An item room admits only the shapes its editors write (Epo, 2026-10-08,
//! for notes; the same rule here): every struct a writer's update adds is
//! placed (`locate`) and checked against the document's shape, and its
//! growth is bounded per touched text (`Growth`), so typing never copies the
//! room. Only an update whose bound crosses a cap or a limit is applied to a
//! copy and checked exactly. Every walk is counted (`ydoc::steps`).

pub mod flashcards;
pub mod locate;
pub mod order;
pub mod validator;

pub use validator::{Admission, Refusal, Validator};

/// What one update may add to an item's projection, read from its structs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Growth {
    /// JSON bytes the projection may grow by, at most.
    pub bytes: u64,
    /// Plate nodes it may gain, at most.
    pub nodes: u64,
    /// A touched text may pass its cap: check exactly.
    pub over_cap: bool,
}

/// Which item document a room holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Flashcards,
}

impl Kind {
    /// The item kind behind a material kind; notes and diagrams are Plate.
    pub fn of_material(kind: &str) -> Option<Kind> {
        match kind {
            "flashcards" => Some(Kind::Flashcards),
            _ => None,
        }
    }

    /// The material kind the projection is checked as.
    pub fn material_kind(self) -> &'static str {
        match self {
            Kind::Flashcards => "flashcards",
        }
    }

    pub fn assert_roots<T: yrs::ReadTxn>(self, txn: &T) -> Result<(), String> {
        match self {
            Kind::Flashcards => flashcards::assert_roots(txn),
        }
    }

    /// The Plate value the document projects to (`materials.content`).
    pub fn value<T: yrs::ReadTxn>(self, txn: &T) -> Vec<serde_json::Value> {
        match self {
            Kind::Flashcards => flashcards::value(txn),
        }
    }

    /// Everything the document holds as a Plate value: what the limits
    /// measure and the shape check reads (the projection may leave parts out).
    pub fn document_value<T: yrs::ReadTxn>(self, txn: &T) -> Vec<serde_json::Value> {
        match self {
            Kind::Flashcards => flashcards::document_value(txn),
        }
    }

    /// The document seeded from a Plate value.
    pub fn state_from_value(self, value: &[serde_json::Value], client_id: u64) -> Vec<u8> {
        match self {
            Kind::Flashcards => flashcards::state_from_value(value, client_id),
        }
    }

    /// The whole document's caps, exactly.
    pub fn check_caps<T: yrs::ReadTxn>(self, txn: &T) -> Result<(), String> {
        match self {
            Kind::Flashcards => flashcards::check_caps(txn),
        }
    }

    pub fn admit_shapes<T: yrs::ReadTxn>(
        self,
        txn: &T,
        incoming: &ydoc::Incoming,
    ) -> Result<Growth, String> {
        match self {
            Kind::Flashcards => flashcards::admit_shapes(txn, incoming),
        }
    }

    /// The agent's commands on the document, with inverses and guards.
    pub fn apply_commands(
        self,
        txn: &mut yrs::TransactionMut,
        commands: &[notes::edit::DocumentCommand],
    ) -> Result<notes::edit::EditOutcome, notes::edit::EditError> {
        match self {
            Kind::Flashcards => flashcards::apply_commands(txn, commands),
        }
    }

    pub fn verify_guards<T: yrs::ReadTxn>(
        self,
        txn: &T,
        guards: &[notes::edit::GuardTarget],
    ) -> Result<(), notes::edit::EditError> {
        match self {
            Kind::Flashcards => flashcards::verify_guards(txn, guards),
        }
    }

    /// The content save API's replacement block, written as the fewest
    /// changes (`replace-block` without a revision, D7).
    pub fn replace_block(
        self,
        txn: &mut yrs::TransactionMut,
        block: &serde_json::Value,
    ) -> Result<(), String> {
        match self {
            Kind::Flashcards => {
                if block.get("type").and_then(serde_json::Value::as_str) != Some("flashcards") {
                    return Err("replacement must be a flashcards block".into());
                }
                let cards = flashcards::cards_from_value(std::slice::from_ref(block));
                if cards.iter().any(|card| !flashcards::valid_id(&card.id)) {
                    return Err("invalid card id".into());
                }
                flashcards::set_cards(txn, &cards);
                Ok(())
            }
        }
    }
}

/// The projected value checked as the material kind and measured: refused
/// past a limit unless it shrank towards it (`notes::limits::recovers`).
pub fn check_value(
    kind: Kind,
    value: &[serde_json::Value],
    previous: Option<&notes::limits::Metrics>,
) -> Result<notes::limits::Metrics, Refusal> {
    notes::material::assert_canonical(value, kind.material_kind())
        .map_err(|error| Refusal::Shape(error.0))?;
    let metrics = notes::limits::measure_value(value);
    if let Some(code) = notes::limits::limit_code(&metrics)
        && !notes::limits::recovers(&metrics, previous)
    {
        return Err(Refusal::Limit { code, metrics });
    }
    Ok(metrics)
}
