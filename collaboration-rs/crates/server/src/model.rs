//! What a material room's document is, by the material's kind: a Plate
//! document (notes, mindmaps, diagrams; the notes crate), a live item
//! document (flashcard sets; the items crate, live-items DESIGN.md), or, on a
//! dev stack whose layout is `blocks`, a note's BlockSuite blocks document
//! (the blocks crate, todo-blocksuite-layout.md). All project to the same
//! Plate envelope, so storage, projection, receipts and evictions do not care
//! which.

use std::sync::OnceLock;

use notes::limits::Metrics;
use serde_json::Value;
use yrs::{ReadTxn, Transact};

/// Why a quiz room loads read-only: one of its documents holds a question
/// block kind the room does not admit.
pub const UNKNOWN_QUIZ_BLOCK: &str =
    "a quiz document holds a question block kind the room does not admit";

/// How note rooms hold their document, stack-wide
/// (`COLLABORATION_DOCUMENT_LAYOUT`, todo-blocksuite-spike.md boundary 1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Layout {
    #[default]
    Plate,
    /// Notes only: mindmaps and diagrams stay Plate until the cut
    /// (`liveMermaid.ts` reads their XmlText).
    Blocks,
}

static LAYOUT: OnceLock<Layout> = OnceLock::new();

/// Set once at startup from the config, before any room loads.
pub fn set_layout(layout: Layout) {
    let _ = LAYOUT.set(layout);
}

/// Why an agent edit or a replace-block is refused in a blocks room: the
/// edit tools move to block ids later (D16); until then nothing writes a
/// blocks room but its editors.
pub const BLOCKS_LAYOUT_REFUSED: &str = "a note in the blocks layout takes no server edits yet";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Model {
    Note,
    Item(items::Kind),
    /// A note's BlockSuite blocks document.
    Blocks,
}

impl Model {
    /// The model of material kind `kind` under the stack's layout (Plate when
    /// none was set: the config's default).
    pub fn of(kind: &str) -> Model {
        Model::of_in(kind, LAYOUT.get().copied().unwrap_or_default())
    }

    pub fn of_in(kind: &str, layout: Layout) -> Model {
        match items::Kind::of_material(kind) {
            Some(item) => Model::Item(item),
            None if kind == "note" && layout == Layout::Blocks => Model::Blocks,
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
            Model::Blocks => blocks_roots(txn),
        }
    }

    /// The Plate value written to `materials.content`.
    pub fn value<T: ReadTxn>(self, txn: &T) -> Result<Vec<Value>, String> {
        match self {
            Model::Note => notes::plate::value(txn).map_err(|error| error.to_string()),
            Model::Item(kind) => Ok(kind.value(txn)),
            Model::Blocks => blocks::value(txn).map_err(|error| error.to_string()),
        }
    }

    /// Everything the document holds as a Plate value (the shape check and
    /// the limits read it; an item's projection may leave blank cards out).
    pub fn document_value<T: ReadTxn>(self, txn: &T) -> Result<Vec<Value>, String> {
        match self {
            Model::Note | Model::Blocks => self.value(txn),
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
            // Checked as its first store will repair it (D3): a tree stored
            // with a block under two parents loads writable.
            Model::Blocks => {
                let repaired = repaired_copy(txn)?;
                let txn = repaired.transact();
                if let Err(violation) = blocks::check(&txn) {
                    return Ok(Some(violation.to_string()));
                }
                Ok(match blocks::value(&txn) {
                    Ok(value) => notes::material::assert_canonical(&value, kind)
                        .err()
                        .map(|error| error.to_string()),
                    Err(error) => Some(error.to_string()),
                })
            }
        }
    }

    pub fn measure<T: ReadTxn>(self, txn: &T) -> Result<Metrics, String> {
        match self {
            Model::Note => notes::limits::measure(txn).map_err(|error| error.to_string()),
            Model::Item(kind) => Ok(notes::limits::measure_value(&kind.document_value(txn))),
            // On the projection, as an item's (the store measures the same);
            // a tree the projection cannot walk yet is measured repaired.
            Model::Blocks => {
                let value = match blocks::value(txn) {
                    Ok(value) => value,
                    Err(_) => blocks::value(&repaired_copy(txn)?.transact())
                        .map_err(|error| error.to_string())?,
                };
                Ok(notes::limits::measure_value(&value))
            }
        }
    }

    /// The document seeded from `materials.content`'s value, as it is (one
    /// a room may not serve is refused at load: [Model::stored]). A blocks
    /// document refuses a value its layout cannot hold.
    pub fn state_from_value(self, value: &[Value]) -> Result<Vec<u8>, String> {
        match self {
            Model::Note => Ok(notes::slate_yjs::state_from_value(value, 0)),
            Model::Item(kind) => Ok(kind.state_from_value(value, 0)),
            Model::Blocks => blocks::state_from_value(value, 0).map_err(|error| error.to_string()),
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
            // O(document): the room skips it after an update admitted on
            // the growth bound, which leaves a tree the check passes
            // ([RoomValidator::admitted_on_bound]).
            Model::Blocks => block_tree(txn),
        }
    }

    /// Whether this document has repairs: a quiz's never does.
    pub fn repairs(self) -> bool {
        matches!(
            self,
            Model::Note | Model::Blocks | Model::Item(items::Kind::Flashcards)
        )
    }

    /// The repairs a store refusal tries once before the room resets: an
    /// emptied note or set, repeated top-level ids.
    pub fn repair(self, txn: &mut yrs::TransactionMut, kind: &str) -> Vec<&'static str> {
        match self {
            Model::Note => notes::repair::repair(txn, kind),
            Model::Item(items::Kind::Flashcards) => blank_card(txn),
            Model::Item(_) => Vec::new(),
            Model::Blocks => block_tree(txn),
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
            // No bound until an exact check: the room may load unrepaired.
            Model::Blocks => RoomValidator::Blocks(BlocksValidator {
                material: kind.to_owned(),
                metrics: Some(metrics),
                bound: None,
                depth: 0,
                tree: None,
                exact_checks: 0,
                on_bound: false,
            }),
        }
    }
}

/// A blocks document's roots: the `blocks` map and the contributor markers,
/// neither holding sequence content.
fn blocks_roots<T: ReadTxn>(txn: &T) -> Result<(), String> {
    for (name, _) in txn.root_refs() {
        if name != blocks::BLOCKS_ROOT && name != ydoc::CONTRIBUTORS_ROOT {
            return Err(format!("unsupported collaboration document root: {name}"));
        }
    }
    for name in [blocks::BLOCKS_ROOT, ydoc::CONTRIBUTORS_ROOT] {
        if let Some(root) = yrs::branch::BranchID::get_root(txn, name)
            && root.start().is_some()
        {
            return Err(format!("invalid collaboration document root: {name}"));
        }
    }
    Ok(())
}

/// A copy of the document with the block tree repaired (D3), for reads that
/// must not write the room.
fn repaired_copy<T: ReadTxn>(txn: &T) -> Result<yrs::Doc, String> {
    let copy = ydoc::scratch_doc();
    let state = txn.encode_state_as_update_v1(&yrs::StateVector::default());
    ydoc::replay(&copy, &state, &[] as &[Vec<u8>]).map_err(|error| error.to_string())?;
    blocks::repair(&mut copy.transact_mut());
    Ok(copy)
}

/// D3's repair of a blocks document: what it repaired, by kind.
fn block_tree(txn: &mut yrs::TransactionMut) -> Vec<&'static str> {
    let mut repaired: Vec<&'static str> = blocks::repair(txn)
        .iter()
        .map(|repair| match repair {
            blocks::Repair::Dangling { .. } => "a dangling child id",
            blocks::Repair::Duplicate { .. } => "a block under two parents",
            blocks::Repair::RootListed { .. } => "the root listed as a child",
            blocks::Repair::Cycle { .. } => "a cycle of blocks",
            blocks::Repair::Orphan { .. } => "a block no parent lists",
            blocks::Repair::TooDeep { .. } => "a block nested too deep",
        })
        .collect();
    repaired.dedup();
    repaired
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
    Blocks(BlocksValidator),
}

/// A blocks room's admission (`notes::limits::Validator`'s pattern): the new
/// structs must sit under the room's roots; then an update whose growth bound
/// (`blocks::bound`) keeps the room within every limit is admitted on the
/// bound, and anything else is applied to a copy, repaired as the room will
/// repair it (D3), checked structurally and measured on its projection.
///
/// The bound, with the tree's parent index, is set by an exact check alone
/// and dropped by every write the validator did not admit (`invalidate`), so
/// while it holds, the room's tree is one that passed the structural check:
/// the repair on entry after that check's update left the tree as the check's
/// copy had it, or wrote and dropped the bound. Typing leaves that tree as it
/// is; a structural update admitted on the bound leaves a tree the check
/// passes (`blocks::bound` proves it from the blocks the update touches) and
/// moves the index along. Either way the repair on entry has nothing to do,
/// and of the texts the room holds only strings and attribute values the
/// store already took.
#[derive(Debug)]
pub struct BlocksValidator {
    /// The room's material kind (`note`).
    pub material: String,
    /// The last exact metrics (the shrink baseline).
    pub metrics: Option<Metrics>,
    /// An upper bound of the metrics now: the last exact ones plus each later
    /// update's growth bound.
    pub bound: Option<Metrics>,
    /// The deepest node of the tree's projection without what typing added
    /// since: typing nests at most one level below it.
    pub depth: u32,
    /// The room's parent index while the bound holds.
    pub tree: Option<blocks::Tree>,
    /// Exact checks taken (a copy of the room each).
    pub exact_checks: u64,
    /// The last admitted update was admitted on the bound.
    pub on_bound: bool,
}

impl BlocksValidator {
    pub fn admit(&mut self, doc: &yrs::Doc, update: &yrs::Update, draft: bool) -> Admitted {
        match self.check(doc, update, draft) {
            Ok(admitted) | Err(admitted) => admitted,
        }
    }

    fn check(
        &mut self,
        doc: &yrs::Doc,
        update: &yrs::Update,
        draft: bool,
    ) -> Result<Admitted, Admitted> {
        self.on_bound = false;
        let refused = |error: String| Admitted::Refused(error);
        let txn = doc.transact();
        blocks_roots(&txn).map_err(refused)?;
        let incoming = ydoc::Incoming::new(update);
        let inspection =
            ydoc::inspect(&txn, &incoming).map_err(|error| refused(error.to_string()))?;
        if inspection.unheld {
            return Ok(Admitted::Unheld);
        }
        // Typing a draft into a block the room deleted (Q237).
        if draft && inspection.hidden_units > 0 {
            return Ok(Admitted::Hidden);
        }
        let in_roots = inspection.containers.iter().all(|container| {
            container.key.is_some()
                && (&*container.root == blocks::BLOCKS_ROOT
                    || &*container.root == ydoc::CONTRIBUTORS_ROOT)
        });
        if !in_roots {
            return Err(refused(
                "an update outside the blocks document's roots".into(),
            ));
        }
        if let Some(next) = self.next_bound(&txn, &incoming) {
            self.take(next);
            return Ok(Admitted::Accepted);
        }
        self.exact_checks += 1;
        let candidate = match inspection.trial {
            Some(trial) => trial,
            None => {
                let candidate = ydoc::scratch_doc();
                let state = txn.encode_state_as_update_v1(&yrs::StateVector::default());
                ydoc::replay(
                    &candidate,
                    &state,
                    &[yrs::updates::encoder::Encode::encode_v1(update)],
                )
                .map_err(|error| refused(error.to_string()))?;
                candidate
            }
        };
        if self.metrics.is_none() {
            self.metrics = Some(Model::Blocks.measure(&txn).map_err(refused)?);
        }
        drop(txn);
        blocks::repair(&mut candidate.transact_mut());
        let candidate = candidate.transact();
        blocks_roots(&candidate).map_err(refused)?;
        blocks::check(&candidate).map_err(|violation| refused(violation.to_string()))?;
        let value = blocks::value(&candidate).map_err(|error| refused(error.to_string()))?;
        notes::material::assert_canonical(&value, &self.material)
            .map_err(|error| refused(error.to_string()))?;
        let metrics = notes::limits::measure_value(&value);
        if let Some(code) = notes::limits::limit_code(&metrics)
            && !notes::limits::recovers(&metrics, self.metrics.as_ref())
        {
            return Err(Admitted::Limit(code, metrics));
        }
        self.metrics = Some(metrics);
        self.bound = Some(metrics);
        self.depth = metrics.max_depth;
        self.tree = Some(blocks::Tree::of(&candidate));
        Ok(Admitted::Accepted)
    }

    /// The bound after `incoming` when the growth bound proves it keeps the
    /// room's tree valid and the room within every limit: the bytes and nodes
    /// typing adds at most (one level below the tree's deepest node), plus
    /// the exact change of the top-level elements a structural update
    /// rewrites, checked as the store checks them. `None`: check it exactly.
    fn next_bound<T: ReadTxn>(&self, txn: &T, incoming: &ydoc::Incoming) -> Option<NextBound> {
        let (bound, tree) = (self.bound?, self.tree.as_ref()?);
        let growth = blocks::bound::growth(txn, incoming, tree)?;
        if !growth.after.is_empty() {
            notes::material::assert_canonical(&growth.after, &self.material).ok()?;
        }
        let (before, after) = (slots(&growth.before), slots(&growth.after));
        let depth = self.depth.max(after.max_depth);
        let next = Metrics {
            content_bytes: (bound.content_bytes + growth.bytes + after.content_bytes)
                .saturating_sub(before.content_bytes),
            node_count: (bound.node_count + growth.nodes + after.node_count)
                .saturating_sub(before.node_count),
            max_depth: bound.max_depth.max(depth + u32::from(growth.typed)),
        };
        notes::limits::limit_code(&next)
            .is_none()
            .then_some(NextBound {
                metrics: next,
                depth,
                growth,
            })
    }

    /// An update admitted on the bound: the new bound, and the tree it left.
    fn take(&mut self, next: NextBound) {
        self.bound = Some(next.metrics);
        self.depth = next.depth;
        if let Some(tree) = &mut self.tree {
            tree.apply(&next.growth);
        }
        self.on_bound = true;
    }
}

struct NextBound {
    metrics: Metrics,
    depth: u32,
    growth: blocks::bound::Growth,
}

/// What top-level elements weigh in the measured value: their bytes with one
/// comma each, their nodes, and their deepest node.
fn slots(elements: &[Value]) -> Metrics {
    if elements.is_empty() {
        return Metrics::default();
    }
    let envelope = notes::limits::measure_value(&[]).content_bytes;
    let measured = notes::limits::measure_value(elements);
    Metrics {
        content_bytes: measured.content_bytes + 1 - envelope,
        ..measured
    }
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
            RoomValidator::Blocks(validator) => validator.admit(doc, update, draft),
        }
    }

    pub fn invalidate(&mut self) {
        match self {
            RoomValidator::Note(validator) => validator.invalidate(),
            RoomValidator::Item(validator) => validator.invalidate(),
            RoomValidator::Blocks(validator) => {
                validator.bound = None;
                validator.metrics = None;
                validator.tree = None;
            }
        }
    }

    /// Whether a blocks room admits `update` on its growth bound, without a
    /// copy of the room: the room then admits it on its async worker when it
    /// is small too.
    pub fn bounds<T: ReadTxn>(&self, txn: &T, incoming: &ydoc::Incoming) -> bool {
        match self {
            RoomValidator::Blocks(validator) => validator.next_bound(txn, incoming).is_some(),
            RoomValidator::Note(_) | RoomValidator::Item(_) => false,
        }
    }

    /// Whether the last admitted update was admitted on a blocks room's growth
    /// bound: it left a tree the check passes, so the repair on entry is
    /// skipped.
    pub fn admitted_on_bound(&self) -> bool {
        matches!(self, RoomValidator::Blocks(validator) if validator.on_bound)
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
            RoomValidator::Note(_) | RoomValidator::Blocks(_) => None,
        }
    }

    /// This document's metrics as admission bounds them (none: unknown until
    /// the next exact check).
    pub fn bound(&self) -> Option<Metrics> {
        match self {
            RoomValidator::Item(validator) => validator.bound,
            RoomValidator::Note(validator) => validator.bound,
            RoomValidator::Blocks(validator) => validator.bound,
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use serde_json::json;
    use yrs::{Array as _, ReadTxn as _, Text as _, Transact};

    use super::Model;

    fn note_stored(kind: &str, value: &[serde_json::Value]) -> Result<Option<String>, String> {
        let doc = ydoc::scratch_doc();
        ydoc::replay(
            &doc,
            &Model::Note.state_from_value(value).unwrap(),
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

    /// The layout flag turns notes alone into blocks documents: mindmaps and
    /// diagrams stay Plate (`liveMermaid.ts` reads their XmlText), items stay
    /// items, and without the flag every note is Plate.
    #[test]
    fn only_notes_take_the_blocks_layout() {
        use super::Layout;
        assert_eq!(Model::of_in("note", Layout::Blocks), Model::Blocks);
        assert_eq!(Model::of_in("note", Layout::Plate), Model::Note);
        for kind in ["mindmap", "diagram"] {
            assert_eq!(Model::of_in(kind, Layout::Blocks), Model::Note, "{kind}");
        }
        assert_eq!(
            Model::of_in("flashcards", Layout::Blocks),
            Model::Item(items::Kind::Flashcards)
        );
    }

    fn blocks_value() -> Vec<serde_json::Value> {
        ["a", "b", "c"]
            .iter()
            .map(|id| json!({ "type": "p", "id": id, "children": [{ "text": id.to_uppercase() }] }))
            .collect()
    }

    /// A blocks document holding `state`, as client `client`.
    fn blocks_doc(state: &[u8], client: u64) -> yrs::Doc {
        let doc = yrs::Doc::with_options(ydoc::doc_options(client));
        ydoc::replay(&doc, state, &[] as &[Vec<u8>]).unwrap();
        doc
    }

    fn child_array(txn: &impl yrs::ReadTxn, id: &str) -> yrs::ArrayRef {
        use yrs::Map as _;
        let blocks = txn.get_map(blocks::BLOCKS_ROOT).unwrap();
        let Some(yrs::Out::YMap(block)) = blocks.get(txn, id) else {
            panic!("no block {id}")
        };
        let Some(yrs::Out::YArray(children)) = block.get(txn, "sys:children") else {
            panic!("no children on {id}")
        };
        children
    }

    /// BlockSuite's move of `id` from the note to the end of `to`'s
    /// children, as an update.
    fn moved(doc: &yrs::Doc, id: &str, to: &str) -> Vec<u8> {
        let before = doc.transact().state_vector();
        {
            let mut txn = doc.transact_mut();
            let note = child_array(&txn, blocks::NOTE_ID);
            let at = note
                .iter(&txn)
                .position(|child| child.to_string(&txn) == id)
                .unwrap();
            note.remove(&mut txn, at as u32);
            child_array(&txn, to).push_back(&mut txn, id);
        }
        doc.transact().encode_state_as_update_v1(&before)
    }

    /// A seeded blocks note projects to its canonical value, loads writable
    /// and is measured on that projection.
    #[test]
    fn a_blocks_note_seeds_and_projects_its_value() {
        let value = blocks_value();
        let state = Model::Blocks.state_from_value(&value).unwrap();
        let doc = blocks_doc(&state, 1);
        let txn = doc.transact();
        Model::Blocks.assert_roots(&txn).unwrap();
        assert_eq!(
            Model::Blocks.value(&txn).unwrap(),
            blocks::canonical(&value).unwrap()
        );
        assert_eq!(Model::Blocks.stored("note", &txn), Ok(None));
        assert_eq!(
            Model::Blocks.measure(&txn).unwrap(),
            notes::limits::measure_value(&blocks::canonical(&value).unwrap())
        );
    }

    /// Two writers moving one block under two parents are both admitted; the
    /// repair on entry keeps the higher client id's move (D3), and the room
    /// passes the structural check. An update outside the roots (a Plate
    /// `content` root) is refused. Fails if the second move is refused or
    /// the block stays under two parents.
    #[test]
    fn a_concurrent_move_is_admitted_and_repaired_on_entry() {
        let state = Model::Blocks.state_from_value(&blocks_value()).unwrap();
        let room = blocks_doc(&state, 1);
        let (low, high) = (blocks_doc(&state, 10), blocks_doc(&state, 20));
        let metrics = Model::Blocks.measure(&room.transact()).unwrap();
        let mut validator = Model::Blocks.validator("note", metrics);
        for bytes in [moved(&low, "c", "a"), moved(&high, "c", "b")] {
            let update = ydoc::decode(&bytes).unwrap();
            assert!(matches!(
                validator.admit(&room, &update, false),
                super::Admitted::Accepted
            ));
            let mut txn = room.transact_mut();
            txn.apply_update(update).unwrap();
            Model::Blocks.repair_on_entry(&mut txn, &ydoc::decode(&bytes).unwrap(), "note");
        }
        let txn = room.transact();
        blocks::check(&txn).unwrap();
        assert_eq!(child_array(&txn, "b").len(&txn), 1);
        assert_eq!(child_array(&txn, "a").len(&txn), 0);
        drop(txn);

        let outside = {
            let doc = blocks_doc(&state, 30);
            let before = doc.transact().state_vector();
            let content = doc.get_or_insert_text("content");
            content.insert(&mut doc.transact_mut(), 0, "x");
            doc.transact().encode_state_as_update_v1(&before)
        };
        assert!(matches!(
            validator.admit(&room, &ydoc::decode(&outside).unwrap(), false),
            super::Admitted::Refused(_)
        ));
    }

    /// The growth bound admits typing without a copy only once an exact
    /// check set it (a room may load unrepaired) and only while the bound
    /// plus the keystroke stays within the limits; a format change is
    /// bounded too (its text read whole), and a keystroke near the limit
    /// takes the exact check, which resets the bound to the exact metrics.
    /// Fails if a keystroke near the limit is admitted on the bound, or
    /// typing after an exact check is not.
    #[test]
    fn typing_is_admitted_on_the_bound_until_a_limit_is_near() {
        let state = Model::Blocks.state_from_value(&blocks_value()).unwrap();
        let room = blocks_doc(&state, 1);
        let writer = blocks_doc(&state, 50);
        let metrics = Model::Blocks.measure(&room.transact()).unwrap();
        let mut validator = Model::Blocks.validator("note", metrics);
        let admit = |validator: &mut super::RoomValidator, bytes: &[u8]| {
            let admitted = validator.admit(&room, &ydoc::decode(bytes).unwrap(), false);
            assert!(matches!(admitted, super::Admitted::Accepted));
            let mut txn = room.transact_mut();
            txn.apply_update(ydoc::decode(bytes).unwrap()).unwrap();
            let super::RoomValidator::Blocks(blocks) = validator else {
                panic!("not a blocks validator")
            };
            (blocks.exact_checks, blocks.on_bound)
        };
        assert_eq!(admit(&mut validator, &keystroke(&writer, "a")), (1, false));
        assert_eq!(admit(&mut validator, &keystroke(&writer, "a")), (1, true));
        let bold = {
            use yrs::Map as _;
            let before = writer.transact().state_vector();
            let mut txn = writer.transact_mut();
            let blocks = txn.get_map(blocks::BLOCKS_ROOT).unwrap();
            let Some(yrs::Out::YMap(block)) = blocks.get(&txn, "b") else {
                panic!("no block b")
            };
            let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
                panic!("no text on b")
            };
            text.format(
                &mut txn,
                0,
                1,
                [("bold".into(), yrs::Any::Bool(true))].into(),
            );
            drop(txn);
            writer.transact().encode_state_as_update_v1(&before)
        };
        assert_eq!(admit(&mut validator, &bold), (1, true));
        assert_eq!(admit(&mut validator, &keystroke(&writer, "b")), (1, true));
        if let super::RoomValidator::Blocks(blocks) = &mut validator {
            blocks.bound = blocks.bound.map(|bound| notes::limits::Metrics {
                content_bytes: notes::limits::MAX_CONTENT_BYTES - 10,
                ..bound
            });
        }
        assert_eq!(admit(&mut validator, &keystroke(&writer, "c")), (2, false));
        assert_eq!(
            validator.bound(),
            Some(Model::Blocks.measure(&room.transact()).unwrap())
        );
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

    /// The corpus's near-limit note (`load-note`, about 2 MB of Plate JSON).
    fn load_note() -> Vec<serde_json::Value> {
        use std::io::Read as _;
        let mut text = String::new();
        flate2::read::GzDecoder::new(
            std::fs::File::open(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../notes/tests/corpus/bootstrap.json.gz"
            ))
            .unwrap(),
        )
        .read_to_string(&mut text)
        .unwrap();
        let corpus: serde_json::Value = serde_json::from_str(&text).unwrap();
        corpus
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == "load-note")
            .unwrap()["value"]
            .as_array()
            .unwrap()
            .clone()
    }

    /// The paragraph in the middle of the note's top level.
    fn middle_paragraph(txn: &impl yrs::ReadTxn) -> String {
        use yrs::Map as _;
        let blocks = txn.get_map(blocks::BLOCKS_ROOT).unwrap();
        let ids: Vec<String> = child_array(txn, blocks::NOTE_ID)
            .iter(txn)
            .map(|id| id.to_string(txn))
            .collect();
        ids[ids.len() / 2..]
            .iter()
            .find(|id| {
                let Some(yrs::Out::YMap(block)) = blocks.get(txn, id) else {
                    return false;
                };
                block.get(txn, "sys:flavour").map(|f| f.to_string(txn))
                    == Some(blocks::schema::PARAGRAPH.to_owned())
            })
            .unwrap()
            .clone()
    }

    /// One keystroke at the end of `id`'s text, as an update.
    fn keystroke(doc: &yrs::Doc, id: &str) -> Vec<u8> {
        use yrs::Map as _;
        let before = doc.transact().state_vector();
        {
            let mut txn = doc.transact_mut();
            let blocks = txn.get_map(blocks::BLOCKS_ROOT).unwrap();
            let Some(yrs::Out::YMap(block)) = blocks.get(&txn, id) else {
                panic!("no block {id}")
            };
            let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
                panic!("no text on {id}")
            };
            let at = text.len(&txn);
            text.insert(&mut txn, at, "x");
        }
        doc.transact().encode_state_as_update_v1(&before)
    }

    /// A blocks room's admission of typing on the near-limit note: one
    /// keystroke at a time into a paragraph, each admitted, applied and
    /// repaired on entry as the room does. After the first (no bound at
    /// load) every keystroke is admitted on the growth bound: no copy of the
    /// room, no projection, no repair (counted). Prints the time per update;
    /// run it with `--release --nocapture` for the numbers.
    #[test]
    fn keystrokes_on_the_near_limit_note_take_no_copy() {
        const KEYS: u32 = 20;
        let state = Model::Blocks.state_from_value(&load_note()).unwrap();
        let room = blocks_doc(&state, 1);
        let writer = blocks_doc(&state, 50);
        let target = middle_paragraph(&room.transact());
        let metrics = Model::Blocks.measure(&room.transact()).unwrap();
        let mut validator = Model::Blocks.validator("note", metrics);
        let (mut admit, mut repair) = (std::time::Duration::ZERO, std::time::Duration::ZERO);
        for key in 0..=KEYS {
            let bytes = keystroke(&writer, &target);
            let started = std::time::Instant::now();
            let admitted = validator.admit(&room, &ydoc::decode(&bytes).unwrap(), false);
            let admitted_in = started.elapsed();
            assert!(matches!(admitted, super::Admitted::Accepted));
            let started = std::time::Instant::now();
            let mut txn = room.transact_mut();
            txn.apply_update(ydoc::decode(&bytes).unwrap()).unwrap();
            if !validator.admitted_on_bound() {
                Model::Blocks.repair_on_entry(&mut txn, &ydoc::decode(&bytes).unwrap(), "note");
            }
            drop(txn);
            if key > 0 {
                admit += admitted_in;
                repair += started.elapsed();
            }
        }
        let super::RoomValidator::Blocks(blocks) = &validator else {
            panic!("not a blocks validator")
        };
        assert_eq!(blocks.exact_checks, 1);
        eprintln!(
            "blocks keystroke on the near-limit note: admit {:.3} ms, apply + repair {:.3} ms per update",
            admit.as_secs_f64() * 1e3 / f64::from(KEYS),
            repair.as_secs_f64() * 1e3 / f64::from(KEYS),
        );
    }

    /// A writer's edit as the update it sends.
    fn edit_on(doc: &yrs::Doc, edit: impl FnOnce(&mut yrs::TransactionMut)) -> Vec<u8> {
        let before = doc.transact().state_vector();
        edit(&mut doc.transact_mut());
        doc.transact().encode_state_as_update_v1(&before)
    }

    /// The exact path's projection of the room with `bytes` applied, on a
    /// copy: its metrics, and whether the tree needed the repair on entry.
    fn exact_on_copy(room: &yrs::Doc, bytes: &[u8]) -> (notes::limits::Metrics, bool) {
        let copy = blocks_doc(
            &room
                .transact()
                .encode_state_as_update_v1(&yrs::StateVector::default()),
            2,
        );
        copy.transact_mut()
            .apply_update(ydoc::decode(bytes).unwrap())
            .unwrap();
        let repaired = blocks::check(&copy.transact()).is_err()
            || !blocks::repair(&mut copy.transact_mut()).is_empty();
        let value = blocks::value(&copy.transact()).unwrap();
        notes::material::assert_canonical(&value, "note").unwrap();
        (notes::limits::measure_value(&value), repaired)
    }

    /// The validator's admission of `bytes`, applied and repaired as the room
    /// does, with an admission on the bound checked against the exact path
    /// on a copy: no repair to make, metrics within the bound, the parent
    /// index the room's. Whether it went on the bound, and the admission's
    /// milliseconds.
    fn admit_checked(
        validator: &mut super::RoomValidator,
        room: &yrs::Doc,
        bytes: &[u8],
    ) -> (bool, f64) {
        let (exact, repaired) = exact_on_copy(room, bytes);
        let started = std::time::Instant::now();
        let admitted = validator.admit(room, &ydoc::decode(bytes).unwrap(), false);
        let ms = started.elapsed().as_secs_f64() * 1e3;
        match admitted {
            super::Admitted::Accepted => {}
            super::Admitted::Refused(why) => panic!("refused: {why}"),
            super::Admitted::Limit(code, _) => panic!("refused: {}", code.as_str()),
            super::Admitted::Unheld | super::Admitted::Hidden => panic!("not placed"),
        }
        let mut txn = room.transact_mut();
        txn.apply_update(ydoc::decode(bytes).unwrap()).unwrap();
        let on_bound = validator.admitted_on_bound();
        if !on_bound {
            Model::Blocks.repair_on_entry(&mut txn, &ydoc::decode(bytes).unwrap(), "note");
        }
        drop(txn);
        let super::RoomValidator::Blocks(blocks) = validator else {
            panic!("not a blocks validator")
        };
        if on_bound {
            assert!(!repaired, "admitted on the bound, then repaired");
            let bound = blocks.bound.unwrap();
            assert!(
                exact.content_bytes <= bound.content_bytes,
                "{exact:?} past {bound:?}"
            );
            assert!(
                exact.node_count <= bound.node_count,
                "{exact:?} past {bound:?}"
            );
            assert!(
                exact.max_depth <= bound.max_depth,
                "{exact:?} past {bound:?}"
            );
            assert_eq!(
                blocks.tree.as_ref(),
                Some(&blocks::Tree::of(&room.transact()))
            );
        }
        (on_bound, ms)
    }

    /// The note's top-level ids.
    fn top_ids(doc: &yrs::Doc) -> Vec<String> {
        let txn = doc.transact();
        child_array(&txn, blocks::NOTE_ID)
            .iter(&txn)
            .map(|id| id.to_string(&txn))
            .collect()
    }

    /// BlockSuite's move of `id` from `from` into `to` at `index`.
    fn move_to(txn: &mut yrs::TransactionMut, id: &str, from: &str, to: &str, index: u32) {
        let at = child_array(txn, from)
            .iter(txn)
            .position(|child| child.to_string(txn) == id)
            .unwrap();
        child_array(txn, from).remove(txn, at as u32);
        let target = child_array(txn, to);
        let index = index.min(target.len(txn));
        target.insert(txn, index, id);
    }

    /// A paragraph as BlockSuite's `addBlock` writes it, under the note.
    fn add_paragraph(txn: &mut yrs::TransactionMut, id: &str, line: &str, index: u32) {
        use yrs::Map as _;
        let blocks = txn.get_map(blocks::BLOCKS_ROOT).unwrap();
        let block = blocks.insert(txn, id, yrs::MapPrelim::default());
        block.insert(txn, "sys:flavour", blocks::schema::PARAGRAPH);
        block.insert(txn, "sys:children", yrs::ArrayPrelim::default());
        block.insert(txn, "prop:type", "text");
        block.insert(txn, "prop:collapsed", false);
        let text = block.insert(txn, "prop:text", yrs::TextPrelim::new(""));
        text.insert(txn, 0, line);
        child_array(txn, blocks::NOTE_ID).insert(txn, index, id);
    }

    /// Structural edits on the near-limit note (moves, Enter, an indent and
    /// outdent, deletes, a heading, a paste of 150 paragraphs) are admitted on
    /// the growth bound after the first exact check, each matching the exact
    /// path on a copy. Prints the time per update; run it with `--release
    /// --nocapture` for the numbers. Fails if one takes the exact path, or the
    /// bound undercounts or admits a tree that needs a repair.
    #[test]
    fn structural_edits_on_the_near_limit_note_take_no_copy() {
        use yrs::Map as _;
        let state = Model::Blocks.state_from_value(&load_note()).unwrap();
        let room = blocks_doc(&state, 1);
        let writer = blocks_doc(&state, 50);
        let target = middle_paragraph(&room.transact());
        let metrics = Model::Blocks.measure(&room.transact()).unwrap();
        let mut validator = Model::Blocks.validator("note", metrics);
        assert!(!admit_checked(&mut validator, &room, &keystroke(&writer, &target)).0);
        let mut edits: Vec<(&str, Vec<u8>)> = Vec::new();
        let len = top_ids(&writer).len() as u32;
        for i in 0..20u32 {
            let ids = top_ids(&writer);
            let id = ids[(1 + i * 97 % (len - 2)) as usize].clone();
            let to = 1 + (i * 53) % (len - 2);
            edits.push((
                "move",
                edit_on(&writer, |txn| {
                    move_to(txn, &id, blocks::NOTE_ID, blocks::NOTE_ID, to)
                }),
            ));
        }
        for i in 0..5u32 {
            let at = top_ids(&writer)
                .iter()
                .position(|id| *id == target)
                .unwrap() as u32;
            edits.push((
                "enter",
                edit_on(&writer, |txn| {
                    add_paragraph(txn, &format!("enter{i}"), "", at + 1)
                }),
            ));
        }
        edits.push((
            "indent",
            edit_on(&writer, |txn| {
                move_to(txn, "enter0", blocks::NOTE_ID, &target, 0)
            }),
        ));
        edits.push((
            "outdent",
            edit_on(&writer, |txn| {
                move_to(txn, "enter0", &target, blocks::NOTE_ID, 0)
            }),
        ));
        edits.push((
            "heading",
            edit_on(&writer, |txn| {
                let blocks = txn.get_map(blocks::BLOCKS_ROOT).unwrap();
                let Some(yrs::Out::YMap(block)) = blocks.get(txn, "enter1") else {
                    panic!("no enter1")
                };
                block.insert(txn, "prop:type", "h2");
            }),
        ));
        for id in ["enter2", "enter3"] {
            edits.push((
                "delete",
                edit_on(&writer, |txn| {
                    let at = child_array(txn, blocks::NOTE_ID)
                        .iter(txn)
                        .position(|child| child.to_string(txn) == id)
                        .unwrap();
                    child_array(txn, blocks::NOTE_ID).remove(txn, at as u32);
                    txn.get_map(blocks::BLOCKS_ROOT).unwrap().remove(txn, id);
                }),
            ));
        }
        let line = "pasted words ".repeat(24)[..300].to_string();
        edits.push((
            "paste",
            edit_on(&writer, |txn| {
                let end = child_array(txn, blocks::NOTE_ID).len(txn);
                for i in 0..150 {
                    add_paragraph(txn, &format!("paste{i}"), &line, end + i);
                }
            }),
        ));
        let mut times: Vec<(&str, f64)> = Vec::new();
        for (name, bytes) in &edits {
            let (on_bound, ms) = admit_checked(&mut validator, &room, bytes);
            assert!(on_bound, "{name} took the exact path");
            times.push((name, ms));
        }
        let super::RoomValidator::Blocks(blocks) = &validator else {
            panic!("not a blocks validator")
        };
        assert_eq!(blocks.exact_checks, 1);
        for name in [
            "move", "enter", "indent", "outdent", "heading", "delete", "paste",
        ] {
            let picked: Vec<f64> = times
                .iter()
                .filter(|(n, _)| *n == name)
                .map(|(_, ms)| *ms)
                .collect();
            eprintln!(
                "blocks {name} on the near-limit note: admit {:.3} ms per update ({} updates)",
                picked.iter().sum::<f64>() / picked.len() as f64,
                picked.len()
            );
        }
    }

    /// The parent index lives with the bound: `invalidate` drops it and the
    /// next structural update takes the exact path, which builds it again;
    /// a live collection swaps the room's document under the same validator
    /// (`room.rs` `collect_live`) and the index still matches it, so moves
    /// stay on the bound. Fails if a move is admitted on a dropped index, or
    /// the index drifts from the room's tree.
    #[test]
    fn the_parent_index_follows_invalidation_and_collection() {
        let state = Model::Blocks.state_from_value(&blocks_value()).unwrap();
        let mut room = blocks_doc(&state, 1);
        let writer = blocks_doc(&state, 50);
        let metrics = Model::Blocks.measure(&room.transact()).unwrap();
        let mut validator = Model::Blocks.validator("note", metrics);
        let send = |validator: &mut super::RoomValidator,
                    room: &yrs::Doc,
                    edit: &dyn Fn(&mut yrs::TransactionMut)| {
            admit_checked(validator, room, &edit_on(&writer, edit)).0
        };
        let first = |txn: &mut yrs::TransactionMut| move_to(txn, "c", blocks::NOTE_ID, "a", 0);
        assert!(!send(&mut validator, &room, &first));
        let back = |txn: &mut yrs::TransactionMut| move_to(txn, "c", "a", blocks::NOTE_ID, 0);
        assert!(send(&mut validator, &room, &back));
        validator.invalidate();
        let under_b = |txn: &mut yrs::TransactionMut| move_to(txn, "c", blocks::NOTE_ID, "b", 0);
        assert!(!send(&mut validator, &room, &under_b));
        let gone = |txn: &mut yrs::TransactionMut| {
            use yrs::Map as _;
            move_to(txn, "c", "b", blocks::NOTE_ID, 0);
            let at = child_array(txn, blocks::NOTE_ID)
                .iter(txn)
                .position(|child| child.to_string(txn) == "a")
                .unwrap();
            child_array(txn, blocks::NOTE_ID).remove(txn, at as u32);
            txn.get_map(blocks::BLOCKS_ROOT).unwrap().remove(txn, "a");
        };
        assert!(send(&mut validator, &room, &gone));

        let window = ydoc::gc::Window::of(&room.transact(), 1);
        let (collected, units) =
            crate::note_store::collect_live(&room, &window, &yrs::IdSet::new(), Model::Blocks)
                .unwrap()
                .unwrap();
        assert!(units > 0);
        room = collected;
        let under_c = |txn: &mut yrs::TransactionMut| move_to(txn, "b", blocks::NOTE_ID, "c", 0);
        assert!(send(&mut validator, &room, &under_c));
        let super::RoomValidator::Blocks(blocks) = &validator else {
            panic!("not a blocks validator")
        };
        assert_eq!(blocks.exact_checks, 2);
    }
}
