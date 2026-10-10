//! Pure functions over the live item documents (track live-items, DESIGN.md
//! in capy-harness/2026-10-06-rust-round/live-items): flashcard sets, and
//! quizzes with their keys documents. No I/O: the server owns rooms,
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
pub mod quiz;
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
    /// A quiz's content document (readers and editors).
    Quiz,
    /// A quiz's keys document (editors with write access only).
    QuizKeys,
}

impl Kind {
    /// The item kind behind a material kind; notes and diagrams are Plate.
    pub fn of_material(kind: &str) -> Option<Kind> {
        match kind {
            "flashcards" => Some(Kind::Flashcards),
            "quiz" => Some(Kind::Quiz),
            _ => None,
        }
    }

    /// The material kind the projection is checked as.
    pub fn material_kind(self) -> &'static str {
        match self {
            Kind::Flashcards => "flashcards",
            Kind::Quiz | Kind::QuizKeys => "quiz",
        }
    }

    pub fn assert_roots<T: yrs::ReadTxn>(self, txn: &T) -> Result<(), String> {
        match self {
            Kind::Flashcards => flashcards::assert_roots(txn),
            Kind::Quiz => quiz::assert_content_roots(txn),
            Kind::QuizKeys => quiz::assert_keys_roots(txn),
        }
    }

    /// The Plate value the document projects to (`materials.content`). A
    /// quiz projects from both its documents (`quiz::value`); one alone gives
    /// what it holds.
    pub fn value<T: yrs::ReadTxn>(self, txn: &T) -> Vec<serde_json::Value> {
        match self {
            Kind::Flashcards => flashcards::value(txn),
            Kind::Quiz | Kind::QuizKeys => self.document_value(txn),
        }
    }

    /// Everything the document holds as a Plate value: what the limits
    /// measure and the shape check reads (the projection may leave parts out).
    pub fn document_value<T: yrs::ReadTxn>(self, txn: &T) -> Vec<serde_json::Value> {
        match self {
            Kind::Flashcards => flashcards::document_value(txn),
            Kind::Quiz => quiz::content_document_value(txn),
            Kind::QuizKeys => quiz::keys_document_value(txn),
        }
    }

    /// The document seeded from a Plate value (a quiz's two documents seed
    /// from the same questions, `quiz::states_from_value`).
    pub fn state_from_value(self, value: &[serde_json::Value], client_id: u64) -> Vec<u8> {
        match self {
            Kind::Flashcards => flashcards::state_from_value(value, client_id),
            Kind::Quiz => quiz::states_from_value(value, client_id).0,
            Kind::QuizKeys => quiz::states_from_value(value, client_id).1,
        }
    }

    /// The whole document's caps, exactly.
    pub fn check_caps<T: yrs::ReadTxn>(self, txn: &T) -> Result<(), String> {
        match self {
            // A set's caps are `notes::material::validate_flashcard`'s, which
            // every path runs on the document value after this.
            Kind::Flashcards => Ok(()),
            Kind::Quiz => quiz::check_content_caps(txn),
            Kind::QuizKeys => quiz::check_keys_caps(txn),
        }
    }

    pub fn admit_shapes<T: yrs::ReadTxn>(
        self,
        txn: &T,
        incoming: &ydoc::Incoming,
    ) -> Result<Growth, String> {
        match self {
            Kind::Flashcards => flashcards::admit_shapes(txn, incoming),
            Kind::Quiz => quiz::admit_content(txn, incoming),
            Kind::QuizKeys => quiz::admit_keys(txn, incoming),
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
            Kind::Quiz | Kind::QuizKeys => Err(notes::edit::EditError::Edit {
                code: notes::edit::EditErrorCode::UnsupportedOperation,
                message: "a quiz edits both its documents (quiz::apply_commands)".into(),
                details: None,
            }),
        }
    }

    pub fn verify_guards<T: yrs::ReadTxn>(
        self,
        txn: &T,
        guards: &[notes::edit::GuardTarget],
    ) -> Result<(), notes::edit::EditError> {
        match self {
            Kind::Flashcards => flashcards::verify_guards(txn, guards),
            Kind::Quiz | Kind::QuizKeys => Err(notes::edit::EditError::Edit {
                code: notes::edit::EditErrorCode::UnsupportedOperation,
                message: "a quiz checks both its documents (quiz::verify_guards)".into(),
                details: None,
            }),
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
            Kind::Quiz | Kind::QuizKeys => {
                Err("a quiz saves both its documents (quiz::set_questions)".into())
            }
        }
    }
}

/// A quiz document's metrics with its other document's (`peer`): the two
/// count together against the material's limits.
pub fn combine(
    metrics: &notes::limits::Metrics,
    peer: Option<&notes::limits::Metrics>,
) -> notes::limits::Metrics {
    match peer {
        Some(peer) => notes::limits::Metrics {
            content_bytes: metrics.content_bytes + peer.content_bytes,
            max_depth: metrics.max_depth.max(peer.max_depth),
            node_count: metrics.node_count + peer.node_count,
        },
        None => *metrics,
    }
}

/// The projected value checked as the material kind and measured: refused
/// past a limit (with `peer`, a quiz's other document, counted in) unless it
/// shrank towards it (`notes::limits::recovers`).
pub fn check_value(
    kind: Kind,
    value: &[serde_json::Value],
    previous: Option<&notes::limits::Metrics>,
    peer: Option<&notes::limits::Metrics>,
) -> Result<notes::limits::Metrics, Refusal> {
    // A live quiz admits structure and caps only; its projection holds the
    // complete questions (D4, Epo 2026-10-10).
    if kind == Kind::Flashcards {
        notes::material::assert_canonical(value, kind.material_kind())
            .map_err(|error| Refusal::Shape(error.0))?;
    }
    let metrics = notes::limits::measure_value(value);
    let combined = combine(&metrics, peer);
    let previous = previous.map(|previous| combine(previous, peer));
    if let Some(code) = notes::limits::limit_code(&combined)
        && !notes::limits::recovers(&combined, previous.as_ref())
    {
        return Err(Refusal::Limit {
            code,
            metrics: combined,
        });
    }
    Ok(metrics)
}
