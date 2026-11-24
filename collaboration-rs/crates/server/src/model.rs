//! What a material room's document is, by the material's kind: a Plate
//! document (notes, mindmaps, diagrams; the notes crate), a live item
//! document (flashcard sets; the items crate, live-items DESIGN.md) or a
//! canvas's board (BlockSuite's block map, which the server stores and bounds
//! but never reads beyond the assets its blocks name). All project to the same Plate
//! envelope, so storage, projection, receipts and evictions do not care which.

use notes::catalog::CANVAS_BOARD_MAX;
use notes::limits::{LimitCode, Metrics};
use serde_json::{Value, json};
use yrs::{Any, Map, Out, ReadTxn, StateVector, Transact};

/// The one root a board's editors write: BlockSuite's map of blocks by id.
pub const BOARD_ROOT: &str = "blocks";

/// A board's first state, made by the editor's own code under Yjs client id
/// 1 (`src/features/blocksuite/boardFirstState.ts`, which pins these bytes):
/// a page block holding a surface block.
const BOARD_FIRST_STATE: &[u8] = include_bytes!("../fixtures/board-first-state.bin");

/// The bytes a split adds to a board's state: the header of the piece it
/// makes (an info byte, an origin and a right origin of at most ten bytes of
/// client id and five of clock each, a length).
const SPLIT_HEADER: u64 = 36;
/// The bytes a new struct adds beyond its own when yrs deletes something
/// for it (the value its map key held, or the struct itself under a deleted
/// parent): a deleted range under a client the delete set may not name yet.
const REPLACED: u64 = 25;
/// The deepest a board nests a type below its root (`ydoc::Bounds`), so
/// yrs's recursion through nested types stays shallow: a chain of 8,000
/// maps and the deletion of its top overflowed a worker's 2 MiB stack. A
/// resource bound like the size cap, no rule on what the content is. The
/// editor's deepest today is 5 (blocks, the surface block, its elements'
/// holder and map, an element, the element's own text or map), measured on
/// the first state (3) and a saved board with a plane card (5).
pub(crate) const BOARD_DEPTH: u32 = 64;

// A joiner takes a board's whole state in one sync message.
const _: () = assert!(CANVAS_BOARD_MAX <= crate::room::NOTE_MAX_SYNC_BYTES);

/// Why a quiz room loads read-only: one of its documents holds a question
/// block kind the room does not admit.
pub const UNKNOWN_QUIZ_BLOCK: &str =
    "a quiz document holds a question block kind the room does not admit";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Model {
    Note,
    Item(items::Kind),
    Board,
}

impl Model {
    pub fn of(kind: &str) -> Model {
        if kind == "canvas" {
            return Model::Board;
        }
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
            Model::Board => board_roots(txn),
        }
    }

    /// The Plate value written to `materials.content`: a board's is its one
    /// block, at version 0 as before its first projection.
    pub fn value<T: ReadTxn>(self, txn: &T) -> Result<Vec<Value>, String> {
        match self {
            Model::Note => notes::plate::value(txn).map_err(|error| error.to_string()),
            Model::Item(kind) => Ok(kind.value(txn)),
            Model::Board => Ok(vec![board_block(txn, 0)]),
        }
    }

    /// What a projection of the stored `version` writes to
    /// `materials.content`: the Plate value, or a board's block naming that
    /// version, so each projection changes the content.
    pub fn projection<T: ReadTxn>(self, txn: &T, version: i64) -> Result<Vec<Value>, String> {
        match self {
            Model::Board => Ok(vec![board_block(txn, version)]),
            Model::Note | Model::Item(_) => self.value(txn),
        }
    }

    /// Everything the document holds as a Plate value (the shape check and
    /// the limits read it; an item's projection may leave blank cards out).
    pub fn document_value<T: ReadTxn>(self, txn: &T) -> Result<Vec<Value>, String> {
        match self {
            Model::Note | Model::Board => self.value(txn),
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
            // Whatever a board holds is its editors' to read (an element
            // type this version does not know shows as a placeholder there).
            Model::Item(items::Kind::Flashcards) | Model::Board => Ok(None),
        }
    }

    pub fn measure<T: ReadTxn>(self, txn: &T) -> Result<Metrics, String> {
        match self {
            Model::Note => notes::limits::measure(txn).map_err(|error| error.to_string()),
            Model::Item(kind) => Ok(notes::limits::measure_value(&kind.document_value(txn))),
            // A board is bounded by its live state's bytes, history included.
            Model::Board => Ok(board_metrics(state_bytes(txn))),
        }
    }

    /// The document seeded from `materials.content`'s value, as it is (one
    /// a room may not serve is refused at load: [Model::stored]). A board's
    /// content holds nothing to seed from: every board starts as the same
    /// bytes, so two first openers hold one state.
    pub fn state_from_value(self, value: &[Value]) -> Vec<u8> {
        match self {
            Model::Note => notes::slate_yjs::state_from_value(value, 0),
            Model::Item(kind) => kind.state_from_value(value, 0),
            Model::Board => BOARD_FIRST_STATE.to_vec(),
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
            Model::Item(_) | Model::Board => Vec::new(),
        }
    }

    /// Whether this document has repairs: a quiz's and a board's never do.
    pub fn repairs(self) -> bool {
        matches!(self, Model::Note | Model::Item(items::Kind::Flashcards))
    }

    /// The repairs a store refusal tries once before the room resets: an
    /// emptied note or set, repeated top-level ids.
    pub fn repair(self, txn: &mut yrs::TransactionMut, kind: &str) -> Vec<&'static str> {
        match self {
            Model::Note => notes::repair::repair(txn, kind),
            Model::Item(items::Kind::Flashcards) => blank_card(txn),
            Model::Item(_) | Model::Board => Vec::new(),
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
            // The load measured the state's bytes ([Model::measure]).
            Model::Board => RoomValidator::Board(metrics.content_bytes),
        }
    }
}

/// A board's roots: its blocks and the room's contributor markers.
fn board_roots<T: ReadTxn>(txn: &T) -> Result<(), String> {
    let mut names: Vec<String> = txn.root_refs().map(|(name, _)| name.to_string()).collect();
    names.sort();
    match names
        .iter()
        .find(|name| *name != BOARD_ROOT && *name != ydoc::CONTRIBUTORS_ROOT)
    {
        Some(name) => Err(format!("unsupported board root {name}")),
        None => Ok(()),
    }
}

/// An editor asset's id as the API mints one (`auth.rs` `id_ok`), at most 64
/// bytes.
fn asset_id_ok(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The key under which a board's block names an editor asset.
const SOURCE_ID: &str = "prop:sourceId";

/// The one thing the server reads from a board: the editor assets its blocks
/// name (a block map's `prop:sourceId`, an image's today), each once, in
/// byte order. Go keeps these and prunes the canvas's others, so a block of
/// any flavour keeps its asset: one a newer editor wrote, which this version
/// shows as a placeholder, is not deleted behind its writer's back. An id
/// that is no asset of the canvas prunes nothing.
fn board_images<T: ReadTxn>(txn: &T) -> Vec<String> {
    let Some(blocks) = txn.get_map(BOARD_ROOT) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = blocks
        .iter(txn)
        .filter_map(|(_, block)| {
            let Out::YMap(block) = block else {
                return None;
            };
            let Some(Out::Any(Any::String(id))) = block.get(txn, SOURCE_ID) else {
                return None;
            };
            asset_id_ok(&id).then(|| id.to_string())
        })
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// A canvas's one content block at stored version `version`.
fn board_block<T: ReadTxn>(txn: &T, version: i64) -> Value {
    let images: Vec<Value> = board_images(txn)
        .into_iter()
        .map(|id| json!({ "assetId": id }))
        .collect();
    json!({
        "type": "canvas_board",
        "id": "board",
        "children": [{ "text": "" }],
        "version": version,
        "images": images,
    })
}

/// Whether `update` writes a board block's asset id: an image added, pasted
/// or brought back by Undo, whose asset Go trashed when a projection no
/// longer named it. The room then projects after its next store, not at the
/// idle projection, so the image is served again within seconds.
pub fn names_asset(update: &yrs::Update) -> bool {
    update.blocks().any(|block| {
        matches!(block, yrs::UpdateBlock::Item(item)
            if item.parent_sub().is_some_and(|key| &**key == SOURCE_ID))
    })
}

fn state_bytes<T: ReadTxn>(txn: &T) -> u64 {
    txn.encode_state_as_update_v1(&StateVector::default()).len() as u64
}

/// A board's metrics: its state's bytes, or an upper bound of them.
pub(crate) fn board_metrics(content_bytes: u64) -> Metrics {
    Metrics {
        content_bytes,
        max_depth: 0,
        node_count: 0,
    }
}

/// The most `update` of `bytes` bytes adds to a board's state: its own
/// bytes, a piece's header wherever it may split an item (after a struct's
/// origin, before its right origin, at each end of a deleted range), and
/// what yrs deletes for a struct ([REPLACED]). What the update names as
/// deleted only shrinks beyond that. What yrs deletes unnamed, the content
/// of a deleted type, may grow (each isolated piece becomes a collected
/// block with a deleted range of its own): `Inspection::unnamed`, measured.
pub(crate) fn board_growth(update: &yrs::Update, bytes: usize) -> u64 {
    let (mut structs, mut sides) = (0u64, 0u64);
    for block in update.blocks() {
        structs += 1;
        if let yrs::UpdateBlock::Item(item) = block {
            sides += u64::from(item.origin().is_some()) + u64::from(item.right_origin().is_some());
        }
    }
    let ranges: usize = update
        .delete_set()
        .iter()
        .map(|(_, ranges)| ranges.len())
        .sum();
    bytes as u64 + structs * REPLACED + (sides + 2 * ranges as u64) * SPLIT_HEADER
}

/// A board update's trial, after the room's checks (the client-id rule, the
/// marker root, `board::Board::read`), on `doc`, the board's replica: one
/// the room can place, within its work budget and no deeper than
/// [BOARD_DEPTH] (`ydoc::inspect_bounded`), writing only the blocks root,
/// and keeping the state within [CANVAS_BOARD_MAX]. The room tries an
/// update so when its read flagged it or its growth would pass the cap;
/// any other enters on [RoomValidator::board_grows] alone.
///
/// `bound` is an upper bound of the state's bytes. While it and the most the
/// update can add ([board_growth]) fit the cap, the update enters unmeasured.
/// Past that, or when it deletes content it does not name, the state is
/// measured exactly without and with the update,
/// which enters when the state with it fits the cap or is no larger than
/// without it: the cap is never passed, deletions that split items count
/// like any growth, a board at its cap can always be thinned, and no update
/// is refused by a stale estimate (a person who cleared half a full board
/// draws again at once). `changes`: whether the update tells the room
/// anything new; one that does not (a joiner's step 2) leaves the size alone.
fn admit_board(
    doc: &yrs::Doc,
    update: &yrs::Update,
    bytes: &[u8],
    changes: bool,
    bound: &mut u64,
) -> Admitted {
    let cap = CANVAS_BOARD_MAX as u64;
    let txn = doc.transact();
    let incoming = ydoc::Incoming::new(update);
    let bounds = ydoc::Bounds { depth: BOARD_DEPTH };
    let inspection = match ydoc::inspect_bounded(&txn, &incoming, bounds) {
        Ok(inspection) => inspection,
        Err(error) => return Admitted::Refused(error.to_string()),
    };
    if inspection.unheld {
        return Admitted::Unheld;
    }
    if inspection
        .containers
        .iter()
        .any(|found| &*found.root != BOARD_ROOT)
    {
        return Admitted::Refused("a board update writes only the blocks root".into());
    }
    if !changes {
        return Admitted::Accepted;
    }
    let growth = board_growth(update, bytes.len());
    if !inspection.unnamed && *bound + growth <= cap {
        *bound += growth;
        return Admitted::Accepted;
    }
    let before = state_bytes(&txn);
    // The inspection tried it on a copy already, unless it is a small edit.
    let placed = match inspection.trial {
        Some(placed) => placed,
        None => match ydoc::placed(&txn, &incoming) {
            Ok(placed) => placed,
            Err(error) => return Admitted::Refused(error.to_string()),
        },
    };
    let after = state_bytes(&placed.transact());
    if after <= before.max(cap) {
        *bound = after;
        Admitted::Accepted
    } else {
        *bound = before;
        Admitted::Limit(LimitCode::DocumentSizeExceeded, board_metrics(after))
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
    Limit(LimitCode, Metrics),
    Refused(String),
    /// A note draft typing into a block the room deleted (Q237).
    Hidden,
}

pub enum RoomValidator {
    Note(notes::limits::Validator),
    Item(items::Validator),
    /// An upper bound of a board's state in bytes, held to
    /// [CANVAS_BOARD_MAX] ([admit_board]).
    Board(u64),
}

impl RoomValidator {
    /// `bytes`: the update as it was sent (a board's size is counted in
    /// them). `changes`: whether it tells the room anything new
    /// (`ydoc::contains_changes`). `draft`: a draft send's update, refused
    /// when a note's typing would be hidden in a deleted block (live typing
    /// there is collaboration). A board's `doc` is its replica
    /// (`board::Board::replica`), built for the trial of an update past a
    /// small edit or near the cap, under the board work permit, and its
    /// `update` what the board lacks of the writer's (`board::Fresh`).
    pub fn admit(
        &mut self,
        doc: &yrs::Doc,
        update: &yrs::Update,
        bytes: &[u8],
        changes: bool,
        draft: bool,
    ) -> Admitted {
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
            RoomValidator::Board(bound) => admit_board(doc, update, bytes, changes, bound),
        }
    }

    pub fn invalidate(&mut self) {
        match self {
            RoomValidator::Note(validator) => validator.invalidate(),
            RoomValidator::Item(validator) => validator.invalidate(),
            // At the cap: the next update that changes the board measures
            // it exactly.
            RoomValidator::Board(bound) => *bound = CANVAS_BOARD_MAX as u64,
        }
    }

    /// A board's update of at most `growth` bytes ([board_growth]), taken
    /// on its bound while that stays within the cap: false past it (the
    /// bound unchanged), where the update's trial measures the board
    /// exactly ([admit_board]). Only a board bounds its bytes so.
    pub fn board_grows(&mut self, growth: u64) -> bool {
        match self {
            RoomValidator::Board(bound) if *bound + growth <= CANVAS_BOARD_MAX as u64 => {
                *bound += growth;
                true
            }
            _ => false,
        }
    }

    /// A board's bound, lowered to `bound` (one a fold's exact base gave)
    /// when that is lower: both hold the state.
    pub fn tighten(&mut self, bound: u64) {
        if let RoomValidator::Board(held) = self {
            *held = (*held).min(bound);
        }
    }

    /// A board's upper bound of its state's bytes.
    pub fn board_bound(&self) -> Option<u64> {
        match self {
            RoomValidator::Board(bound) => Some(*bound),
            RoomValidator::Note(_) | RoomValidator::Item(_) => None,
        }
    }

    /// The room's own write of `bytes` to the document (a contributor
    /// marker, a map entry), on a board's bound.
    pub fn wrote(&mut self, bytes: u64) {
        if let RoomValidator::Board(bound) = self {
            *bound += bytes + REPLACED;
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
            RoomValidator::Note(_) | RoomValidator::Board(_) => None,
        }
    }

    /// This document's metrics as admission bounds them (none: unknown until
    /// the next exact check).
    pub fn bound(&self) -> Option<Metrics> {
        match self {
            RoomValidator::Item(validator) => validator.bound,
            RoomValidator::Note(validator) => validator.bound,
            RoomValidator::Board(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use serde_json::json;
    use yrs::updates::decoder::Decode;
    use yrs::{Map, MapPrelim, ReadTxn, StateVector, Text, TextPrelim, Transact, Update};

    use super::{Admitted, BOARD_FIRST_STATE, CANVAS_BOARD_MAX, LimitCode, Model, RoomValidator};

    /// A board room as it loads a fresh canvas: its document and admission.
    fn board() -> (yrs::Doc, RoomValidator) {
        let room = yrs::Doc::with_options(ydoc::doc_options(900));
        ydoc::replay(
            &room,
            &Model::Board.state_from_value(&[]),
            &[] as &[Vec<u8>],
        )
        .unwrap();
        let metrics = Model::Board.measure(&room.transact()).unwrap();
        (room, Model::Board.validator("canvas", metrics))
    }

    /// A tab's document holding the room's state, writing under `client`.
    fn tab(room: &yrs::Doc, client: u64) -> yrs::Doc {
        let tab = yrs::Doc::with_options(ydoc::doc_options(client));
        ydoc::replay(&tab, &whole(room), &[] as &[Vec<u8>]).unwrap();
        tab
    }

    fn whole(doc: &yrs::Doc) -> Vec<u8> {
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// The update of `edit` on `tab`.
    fn update(tab: &yrs::Doc, edit: impl FnOnce(&yrs::Doc)) -> Vec<u8> {
        let before = tab.transact().state_vector();
        edit(tab);
        tab.transact().encode_state_as_update_v1(&before)
    }

    /// Adds a block as BlockSuite does: a map under its id in `blocks`.
    fn add_block(doc: &yrs::Doc, id: &str, flavour: &str, props: &[(&str, &str)]) {
        let blocks = doc.get_or_insert_map(super::BOARD_ROOT);
        let mut txn = doc.transact_mut();
        let block = blocks.insert(&mut txn, id, MapPrelim::default());
        block.insert(&mut txn, "sys:flavour", flavour);
        for (key, value) in props {
            block.insert(&mut txn, *key, *value);
        }
    }

    /// Admits `bytes` and, accepted, applies them as the room does. Whatever
    /// the verdict, the board's state is within its cap and its bound no
    /// lower than the state.
    fn send(room: &yrs::Doc, validator: &mut RoomValidator, bytes: &[u8]) -> Admitted {
        let update = ydoc::decode(bytes).unwrap();
        let changes = ydoc::contains_changes(&room.transact(), &update);
        let admitted = validator.admit(room, &update, bytes, changes, false);
        if matches!(admitted, Admitted::Accepted) {
            ydoc::apply(room, update).unwrap();
        }
        let state = whole(room).len() as u64;
        assert!(state <= CANVAS_BOARD_MAX as u64, "a state of {state} bytes");
        assert!(bound(validator) >= state, "{} < {state}", bound(validator));
        admitted
    }

    fn bound(validator: &RoomValidator) -> u64 {
        let RoomValidator::Board(bound) = validator else {
            panic!("no board");
        };
        *bound
    }

    /// A pen stroke's keys as the editor writes them, its 400 points one
    /// binary value (`strokePoints.ts`: the header `[2, 0, 0, 0]`, then x and
    /// y as little-endian f32s). The editor keeps strokes among the surface's
    /// elements; the size checks read every map alike, so this one sits in
    /// the blocks root, where the tests erase it.
    fn stroke(doc: &yrs::Doc, id: &str) {
        let mut points = vec![2u8, 0, 0, 0];
        for n in (0..400u16).map(f32::from) {
            points.extend_from_slice(&(n * 1.37).to_le_bytes());
            points.extend_from_slice(&(n * 2.11).to_le_bytes());
        }
        let blocks = doc.get_or_insert_map(super::BOARD_ROOT);
        let mut txn = doc.transact_mut();
        let element = blocks.insert(&mut txn, id, MapPrelim::default());
        element.insert(&mut txn, "type", "brush");
        element.insert(&mut txn, "lineWidth", 4.0);
        element.insert(&mut txn, "points", yrs::Any::Buffer(points.into()));
    }

    /// An update of deletions alone: `ranges` (clock, length) of `client`.
    fn deleting(client: u64, ranges: &[(u32, u32)]) -> Vec<u8> {
        use yrs::encoding::write::Write;
        let mut bytes: Vec<u8> = Vec::new();
        bytes.write_var(0u32);
        bytes.write_var(1u32);
        bytes.write_var(client);
        bytes.write_var(ranges.len() as u32);
        for (clock, len) in ranges {
            bytes.write_var(*clock);
            bytes.write_var(*len);
        }
        bytes
    }

    /// A fresh canvas loads to exactly the bytes the editor's own code made
    /// (`boardFirstState.test.ts` pins the same file): all under client id
    /// 1, which no user is assigned, in the blocks root alone, a page block
    /// and a surface block.
    #[test]
    fn a_fresh_board_is_the_first_state() {
        let (room, _) = board();
        let txn = room.transact();
        assert_eq!(
            txn.encode_state_as_update_v1(&StateVector::default()),
            BOARD_FIRST_STATE
        );
        let held = txn.state_vector();
        assert_eq!(held.len(), 1);
        assert!(held.get(&yrs::block::ClientID::new(1)) > 0);
        let roots: Vec<String> = txn.root_refs().map(|(name, _)| name.to_string()).collect();
        assert_eq!(roots, [super::BOARD_ROOT]);
        Model::Board.assert_roots(&txn).unwrap();
        let blocks = txn.get_map(super::BOARD_ROOT).unwrap();
        let mut ids: Vec<String> = blocks.keys(&txn).map(str::to_owned).collect();
        ids.sort();
        assert_eq!(ids, ["page", "surface"]);
        assert_eq!(
            Model::Board.measure(&txn).unwrap().content_bytes,
            BOARD_FIRST_STATE.len() as u64
        );
        assert_eq!(Model::Board.stored("canvas", &txn), Ok(None));
    }

    /// Two tabs' blocks both enter, and a write to any other root is refused.
    #[test]
    fn a_board_takes_blocks_and_no_other_root() {
        let (room, mut validator) = board();
        let (a, b) = (tab(&room, 11), tab(&room, 12));
        let first = update(&a, |doc| add_block(doc, "a1", "affine:note", &[]));
        let second = update(&b, |doc| add_block(doc, "b1", "affine:note", &[]));
        assert!(matches!(
            send(&room, &mut validator, &first),
            Admitted::Accepted
        ));
        assert!(matches!(
            send(&room, &mut validator, &second),
            Admitted::Accepted
        ));
        let other = update(&a, |doc| {
            doc.get_or_insert_map("meta")
                .insert(&mut doc.transact_mut(), "k", "v");
        });
        assert!(matches!(
            send(&room, &mut validator, &other),
            Admitted::Refused(reason) if reason.contains("blocks root")
        ));
        let txn = room.transact();
        Model::Board.assert_roots(&txn).unwrap();
        assert_eq!(txn.get_map(super::BOARD_ROOT).unwrap().len(&txn), 4);
        // A state holding another root is refused at load and at a store.
        let stray = tab(&room, 13);
        ydoc::replay(&stray, &other, &[] as &[Vec<u8>]).unwrap();
        assert!(Model::Board.assert_roots(&stray.transact()).is_err());
    }

    /// An update taking the board over its cap is refused with the size
    /// limit and the size the board would have, each time by an exact
    /// measure; deletions alone still enter, after which the board takes
    /// growth again at once (contract C6). Fails if a board at its cap
    /// cannot be thinned, or refuses growth after it was.
    #[test]
    fn a_board_at_its_cap_refuses_growth_and_takes_deletions() {
        let (room, mut validator) = board();
        let writer = tab(&room, 11);
        let text = |bytes: usize| "x".repeat(bytes);
        let big = update(&writer, |doc| {
            add_block(
                doc,
                "big",
                "affine:note",
                &[("prop:text", &text(CANVAS_BOARD_MAX - 200_000))],
            )
        });
        assert!(matches!(
            send(&room, &mut validator, &big),
            Admitted::Accepted
        ));
        for id in ["over", "again"] {
            let more = update(&tab(&room, 12), |doc| {
                add_block(doc, id, "affine:note", &[("prop:text", &text(300_000))])
            });
            let Admitted::Limit(code, metrics) = send(&room, &mut validator, &more) else {
                panic!("{id} entered");
            };
            assert_eq!(code, LimitCode::DocumentSizeExceeded);
            // The size the board would have, exactly.
            let with = tab(&room, 14);
            ydoc::apply(&with, ydoc::decode(&more).unwrap()).unwrap();
            assert_eq!(metrics.content_bytes, whole(&with).len() as u64);
            assert!(metrics.content_bytes > CANVAS_BOARD_MAX as u64);
        }
        let thinned = update(&writer, |doc| {
            doc.get_or_insert_map(super::BOARD_ROOT)
                .remove(&mut doc.transact_mut(), "big");
        });
        assert!(
            Update::decode_v1(&thinned)
                .unwrap()
                .blocks()
                .next()
                .is_none()
        );
        assert!(matches!(
            send(&room, &mut validator, &thinned),
            Admitted::Accepted
        ));
        let more = update(&tab(&room, 12), |doc| {
            add_block(doc, "fits", "affine:note", &[("prop:text", &text(300_000))])
        });
        assert!(matches!(
            send(&room, &mut validator, &more),
            Admitted::Accepted
        ));
    }

    /// Board review 3.2: a board of strokes (maps holding their points as
    /// bytes) drawn to its cap, then half of them erased, takes the next
    /// stroke at once. The size estimate that came before counted an erased
    /// stroke as freeing nothing and refused that stroke 999 times. Fails if
    /// it is refused once.
    #[test]
    fn a_full_board_thinned_takes_a_stroke_at_once() {
        let (room, mut validator) = board();
        let writer = tab(&room, 11);
        let mut drawn = 0;
        loop {
            let bytes = update(&writer, |doc| stroke(doc, &format!("s{drawn}")));
            match send(&room, &mut validator, &bytes) {
                Admitted::Accepted => drawn += 1,
                Admitted::Limit(LimitCode::DocumentSizeExceeded, metrics) => {
                    assert!(metrics.content_bytes > CANVAS_BOARD_MAX as u64);
                    break;
                }
                _ => panic!("stroke {drawn}"),
            }
        }
        assert!(drawn > 200, "{drawn} strokes");
        let full = whole(&room).len();
        // The refused stroke stays in its writer's tab: another one erases.
        let eraser = tab(&room, 12);
        for n in 0..drawn / 2 {
            let erased = update(&eraser, |doc| {
                doc.get_or_insert_map(super::BOARD_ROOT)
                    .remove(&mut doc.transact_mut(), &format!("s{n}"));
            });
            assert!(matches!(
                send(&room, &mut validator, &erased),
                Admitted::Accepted
            ));
        }
        assert!(whole(&room).len() < full * 6 / 10);
        let again = update(&tab(&room, 13), |doc| stroke(doc, "again"));
        assert!(matches!(
            send(&room, &mut validator, &again),
            Admitted::Accepted
        ));
    }

    /// Board review 3.1: a deletion inside an item splits it, and each piece
    /// carries a header of its own, so deletions alone grow the state (about
    /// 23 bytes a range; 320,000 of them took a board at a third of its cap
    /// to four times it). They count like any growth: a long text with
    /// scattered deletions is refused where it would pass the cap, alone or
    /// beside new content, and taken where it fits, and the cap holds
    /// throughout (`send` checks it after every update).
    #[test]
    fn deletions_that_split_items_count_toward_the_cap() {
        let (room, mut validator) = board();
        let writer = tab(&room, 11);
        // 3,300 separate items of twenty characters: each typed at the start.
        let typed = update(&writer, |doc| {
            let blocks = doc.get_or_insert_map(super::BOARD_ROOT);
            let mut txn = doc.transact_mut();
            let block = blocks.insert(&mut txn, "note", MapPrelim::default());
            let text = block.insert(&mut txn, "prop:text", TextPrelim::new(""));
            for _ in 0..3_300 {
                text.insert(&mut txn, 0, &"t".repeat(20));
            }
        });
        assert!(matches!(
            send(&room, &mut validator, &typed),
            Admitted::Accepted
        ));
        // Filled to 30,000 bytes under the cap.
        let room_left = CANVAS_BOARD_MAX - whole(&room).len() - 30_000;
        let filled = update(&writer, |doc| {
            add_block(
                doc,
                "fill",
                "affine:note",
                &[("prop:text", &"x".repeat(room_left))],
            )
        });
        assert!(matches!(
            send(&room, &mut validator, &filled),
            Admitted::Accepted
        ));
        let before = whole(&room).len();
        // One character out of the middle of each item.
        let middles: Vec<(u32, u32)> = {
            let txn = room.transact();
            let Some(yrs::Out::YMap(block)) = txn
                .get_map(super::BOARD_ROOT)
                .and_then(|blocks| blocks.get(&txn, "note"))
            else {
                panic!("no block");
            };
            let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
                panic!("no text");
            };
            let branch: &yrs::branch::Branch = text.as_ref();
            let mut clocks = Vec::new();
            let mut next = branch.start();
            while let Some(item) = next {
                clocks.push((item.id().clock + 10, 1));
                next = item.right();
            }
            clocks.sort_unstable();
            clocks
        };
        assert_eq!(middles.len(), 3_300);
        // Every one of 3,000 adds two headers and a deleted range: over.
        let all = deleting(11, &middles[..3_000]);
        let Admitted::Limit(LimitCode::DocumentSizeExceeded, metrics) =
            send(&room, &mut validator, &all)
        else {
            panic!("the deletions entered");
        };
        assert!(metrics.content_bytes > CANVAS_BOARD_MAX as u64);
        assert_eq!(whole(&room).len(), before);
        // The same beside a new block.
        let block = update(&tab(&room, 12), |doc| {
            add_block(doc, "b", "affine:note", &[])
        });
        let both = yrs::merge_updates_v1([block.as_slice(), all.as_slice()]).unwrap();
        assert!(matches!(
            send(&room, &mut validator, &both),
            Admitted::Limit(LimitCode::DocumentSizeExceeded, _)
        ));
        // 300 of them fit, and grow the state.
        assert!(matches!(
            send(&room, &mut validator, &deleting(11, &middles[3_000..])),
            Admitted::Accepted
        ));
        assert!(whole(&room).len() > before);
        // Thinned, the board takes them all.
        let thinned = update(&tab(&room, 13), |doc| {
            doc.get_or_insert_map(super::BOARD_ROOT)
                .remove(&mut doc.transact_mut(), "fill");
        });
        for bytes in [&thinned, &all] {
            assert!(matches!(
                send(&room, &mut validator, bytes),
                Admitted::Accepted
            ));
        }
    }

    /// An update that tells the room nothing new (a joiner's step 2: what
    /// the room holds, its whole delete set) is taken without sizing the
    /// board, at its cap too.
    #[test]
    fn an_update_with_nothing_new_is_not_sized() {
        let (room, mut validator) = board();
        let writer = tab(&room, 11);
        let drawn = update(&writer, |doc| stroke(doc, "s"));
        assert!(matches!(
            send(&room, &mut validator, &drawn),
            Admitted::Accepted
        ));
        let erased = update(&writer, |doc| {
            doc.get_or_insert_map(super::BOARD_ROOT)
                .remove(&mut doc.transact_mut(), "s");
        });
        assert!(matches!(
            send(&room, &mut validator, &erased),
            Admitted::Accepted
        ));
        validator.invalidate();
        assert_eq!(bound(&validator), CANVAS_BOARD_MAX as u64);
        let step2 = whole(&tab(&room, 12));
        assert!(matches!(
            send(&room, &mut validator, &step2),
            Admitted::Accepted
        ));
        assert_eq!(bound(&validator), CANVAS_BOARD_MAX as u64);
        // The next update that changes the board measures it.
        let more = update(&writer, |doc| stroke(doc, "t"));
        assert!(matches!(
            send(&room, &mut validator, &more),
            Admitted::Accepted
        ));
        assert_eq!(bound(&validator), whole(&room).len() as u64);
    }

    /// An update whose placement costs yrs more than `ydoc::MAX_WORK` steps
    /// is refused: 1,500 items each placed before a tombstone, from the last
    /// back, scan 1,500 * 1,499 / 2 units.
    #[test]
    fn a_board_refuses_an_update_that_is_slow_to_place() {
        use yrs::encoding::write::Write;
        let (room, mut validator) = board();
        let writer = tab(&room, 11);
        let tombstones = 1_500u32;
        let typed = update(&writer, |doc| {
            let blocks = doc.get_or_insert_map(super::BOARD_ROOT);
            let text = {
                let mut txn = doc.transact_mut();
                let block = blocks.insert(&mut txn, "note", MapPrelim::default());
                block.insert(&mut txn, "prop:text", TextPrelim::new(""))
            };
            for _ in 0..tombstones {
                text.insert(&mut doc.transact_mut(), 0, "t");
            }
            text.remove_range(&mut doc.transact_mut(), 0, tombstones);
        });
        assert!(matches!(
            send(&room, &mut validator, &typed),
            Admitted::Accepted
        ));
        let ids: Vec<yrs::ID> = {
            let txn = room.transact();
            let Some(yrs::Out::YMap(block)) = txn
                .get_map(super::BOARD_ROOT)
                .and_then(|blocks| blocks.get(&txn, "note"))
            else {
                panic!("no block");
            };
            let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
                panic!("no text");
            };
            let branch: &yrs::branch::Branch = text.as_ref();
            let mut ids = Vec::new();
            let mut next = branch.start();
            while let Some(item) = next {
                ids.push(*item.id());
                next = item.right();
            }
            ids
        };
        assert_eq!(ids.len(), tombstones as usize);
        let client = yrs::block::ClientID::new(11);
        let mut bytes: Vec<u8> = Vec::new();
        bytes.write_var(1u32);
        bytes.write_var(tombstones);
        bytes.write_var(client.get());
        bytes.write_var(room.transact().state_vector().get(&client));
        for right in ids.iter().rev() {
            bytes.write_u8(0x40 | 4); // a right origin, a string
            bytes.write_var(right.client.get());
            bytes.write_var(right.clock);
            bytes.write_string("x");
        }
        bytes.write_var(0u32);
        assert!(matches!(
            send(&room, &mut validator, &bytes),
            Admitted::Refused(reason) if reason.contains("steps to place")
        ));
    }

    /// The server reads one thing from a board: the assets its blocks name,
    /// each once, in byte order, whatever the block's flavour (one this
    /// version does not know keeps its asset: board review 3.5); a name that
    /// is no asset id, a block naming none and a value that is no block are
    /// skipped. Its value is one block, which a projection gives the stored
    /// version projected.
    #[test]
    fn a_board_projects_its_version_and_the_assets_it_names() {
        let (room, mut validator) = board();
        let writer = tab(&room, 11);
        let long = "a".repeat(65);
        let drawn = update(&writer, |doc| {
            add_block(doc, "i1", "affine:image", &[("prop:sourceId", "asset_b")]);
            add_block(doc, "i2", "affine:image", &[("prop:sourceId", "asset_a")]);
            add_block(doc, "i3", "affine:image", &[("prop:sourceId", "asset_b")]);
            add_block(doc, "i4", "affine:image", &[("prop:sourceId", "Asset-9")]);
            add_block(doc, "i5", "affine:image", &[("prop:sourceId", "not an id")]);
            add_block(doc, "i6", "affine:image", &[("prop:sourceId", &long)]);
            add_block(doc, "i7", "affine:image", &[("prop:sourceId", "")]);
            add_block(doc, "i8", "affine:image", &[]);
            add_block(doc, "n1", "affine:note", &[("prop:text", "asset_text")]);
            add_block(
                doc,
                "f1",
                "affine:later",
                &[("prop:sourceId", "asset_later")],
            );
            let blocks = doc.get_or_insert_map(super::BOARD_ROOT);
            let mut txn = doc.transact_mut();
            blocks.insert(&mut txn, "stray", "asset_stray");
            let numbered = blocks.insert(&mut txn, "f2", MapPrelim::default());
            numbered.insert(&mut txn, "prop:sourceId", 7.0);
        });
        assert!(super::names_asset(&Update::decode_v1(&drawn).unwrap()));
        assert!(matches!(
            send(&room, &mut validator, &drawn),
            Admitted::Accepted
        ));
        let block = |version: i64| {
            json!({
                "type": "canvas_board", "id": "board", "children": [{ "text": "" }],
                "version": version,
                "images": [
                    { "assetId": "Asset-9" }, { "assetId": "asset_a" }, { "assetId": "asset_b" },
                    { "assetId": "asset_later" },
                ],
            })
        };
        let txn = room.transact();
        assert_eq!(Model::Board.projection(&txn, 7).unwrap(), [block(7)]);
        assert_eq!(Model::Board.value(&txn).unwrap(), [block(0)]);
        assert_eq!(Model::Board.document_value(&txn).unwrap(), [block(0)]);
        // An update that names no asset asks for no early projection.
        let moved = update(&writer, |doc| {
            let blocks = doc.get_or_insert_map(super::BOARD_ROOT);
            let mut txn = doc.transact_mut();
            let Some(yrs::Out::YMap(image)) = blocks.get(&txn, "i1") else {
                panic!("no block");
            };
            image.insert(&mut txn, "prop:xywh", "[0,0,10,10]");
            blocks.remove(&mut txn, "i2");
        });
        assert!(!super::names_asset(&Update::decode_v1(&moved).unwrap()));
    }

    /// An update of one GC struct, which carries no bytes: `len` clocks of
    /// `client` from `clock`.
    fn collected(client: u64, clock: u32, len: u32) -> Vec<u8> {
        use yrs::encoding::write::Write;
        let mut bytes: Vec<u8> = Vec::new();
        bytes.write_var(1u32);
        bytes.write_var(1u32);
        bytes.write_var(client);
        bytes.write_var(clock);
        bytes.write_u8(0);
        bytes.write_var(len);
        bytes.write_var(0u32);
        bytes
    }

    /// Board review 2.1: a GC struct claims any number of clocks in eleven
    /// bytes, and two of them wrapped a client's clock in a release build
    /// (`ydoc::MAX_CLOCK`). The board, the note and the item room each
    /// admitted the first before the ceiling; none takes it now.
    #[test]
    fn no_material_room_takes_a_clock_past_the_ceiling() {
        let body = json!({ "type": "p", "id": "body", "children": [{ "text": "Body" }] });
        let loaded = |model: Model, kind: &str, value: &[serde_json::Value]| {
            let room = yrs::Doc::with_options(ydoc::doc_options(900));
            ydoc::replay(&room, &model.state_from_value(value), &[] as &[Vec<u8>]).unwrap();
            let metrics = model.measure(&room.transact()).unwrap();
            (room, model.validator(kind, metrics))
        };
        let rooms = [
            ("board", board()),
            ("note", loaded(Model::Note, "note", &[body])),
            (
                "flashcards",
                loaded(Model::Item(items::Kind::Flashcards), "flashcards", &[]),
            ),
        ];
        let mut verdicts = Vec::new();
        for (name, (room, mut validator)) in rooms {
            let bytes = collected(11, 0, ydoc::MAX_CLOCK + 1);
            let update = Update::decode_v1(&bytes).unwrap();
            let verdict = match validator.admit(&room, &update, &bytes, true, false) {
                Admitted::Accepted => "accepted",
                Admitted::Unheld => "unheld",
                Admitted::Limit(..) => "limit",
                Admitted::Refused(_) => "refused",
                Admitted::Hidden => "hidden",
            };
            verdicts.push((name, verdict));
        }
        assert_eq!(
            verdicts,
            [
                ("board", "refused"),
                ("note", "refused"),
                ("flashcards", "refused")
            ]
        );
    }

    /// Board review 2.2, scoped to the board: yrs copies an item's content at
    /// every split and counts none of it, and only a board's admission
    /// counts it for now (`ydoc::inspect_bounded`). 5,000 scattered
    /// deletions out of one text of 100,000 characters are refused by a
    /// board and taken by a note room, as before the count existed: whether
    /// the other rooms should count is undecided.
    #[test]
    fn only_a_board_counts_what_its_splits_cost() {
        // The longest item of an update: its client and first clock.
        let longest = |bytes: &[u8]| {
            let update = Update::decode_v1(bytes).unwrap();
            update
                .blocks()
                .filter_map(|block| match block {
                    yrs::UpdateBlock::Item(item) => {
                        Some((item.len(), item.id().client.get(), item.id().clock))
                    }
                    _ => None,
                })
                .max()
                .unwrap()
        };
        let scattered = |bytes: &[u8]| {
            let (len, client, clock) = longest(bytes);
            assert_eq!(len, 100_000);
            let ranges: Vec<(u32, u32)> = (0..5_000).map(|k| (clock + 20 * k + 1, 1)).collect();
            deleting(client, &ranges)
        };
        let long = "x".repeat(100_000);

        let (room, mut validator) = board();
        let writer = tab(&room, 11);
        let typed = update(&writer, |doc| {
            let blocks = doc.get_or_insert_map(super::BOARD_ROOT);
            let mut txn = doc.transact_mut();
            let block = blocks.insert(&mut txn, "note", MapPrelim::default());
            block.insert(&mut txn, "prop:text", TextPrelim::new(long.as_str()));
        });
        assert!(matches!(
            send(&room, &mut validator, &typed),
            Admitted::Accepted
        ));
        assert!(matches!(
            send(&room, &mut validator, &scattered(&typed)),
            Admitted::Refused(reason) if reason.contains("steps to place")
        ));

        let body = json!({ "type": "p", "id": "body", "children": [{ "text": long }] });
        let note = yrs::Doc::with_options(ydoc::doc_options(900));
        let state = Model::Note.state_from_value(&[body]);
        ydoc::replay(&note, &state, &[] as &[Vec<u8>]).unwrap();
        let metrics = Model::Note.measure(&note.transact()).unwrap();
        let mut validator = Model::Note.validator("note", metrics);
        let bytes = scattered(&state);
        let update = Update::decode_v1(&bytes).unwrap();
        assert!(matches!(
            validator.admit(&note, &update, &bytes, true, false),
            Admitted::Accepted
        ));
    }

    /// Security regression (board review 2, finding 1): a board has no rule
    /// on what its content is, and yrs deletes and collects nested types by
    /// recursion, which overflowed a worker's stack at 8,000 levels. A board
    /// takes a type [super::BOARD_DEPTH] deep below its root (the editor's
    /// deepest is 5), what such a type holds, and no type deeper.
    #[test]
    fn a_board_refuses_a_type_nested_past_its_depth() {
        let (room, mut validator) = board();
        let writer = tab(&room, 11);
        let mut deepest = None;
        let chain = update(&writer, |doc| {
            let blocks = doc.get_or_insert_map(super::BOARD_ROOT);
            let mut txn = doc.transact_mut();
            let mut current: yrs::MapRef = blocks.insert(&mut txn, "deep", MapPrelim::default());
            for _ in 1..super::BOARD_DEPTH {
                current = current.insert(&mut txn, "k", MapPrelim::default());
            }
            deepest = Some(current);
        });
        let deepest = deepest.unwrap();
        let held = update(&writer, |doc| {
            deepest.insert(&mut doc.transact_mut(), "text", "abc");
        });
        for bytes in [&chain, &held] {
            assert!(matches!(
                send(&room, &mut validator, bytes),
                Admitted::Accepted
            ));
        }
        let deeper = update(&writer, |doc| {
            deepest.insert(&mut doc.transact_mut(), "k", MapPrelim::default());
        });
        assert!(matches!(
            send(&room, &mut validator, &deeper),
            Admitted::Refused(reason) if reason.contains("nested more than 64 deep")
        ));
    }

    /// Security regression (board review 2, finding 4): yrs deletes what a
    /// deleted type holds, and an update built by hand need not name it.
    /// Each such piece ends as a collected block with a deleted range of its
    /// own, larger than it was where it is tiny and its clock high (three
    /// bytes each here), and nothing charged that: on a board filled to just
    /// under its cap, the six-byte deletion of a block holding 4,000 of them
    /// entered unmeasured and left the state over the cap. It is measured,
    /// and refused with the size the board would have; thinned, the board
    /// takes it, measured again. Fails in `send` if the state passes the cap.
    #[test]
    fn a_type_deleted_with_content_unnamed_is_measured() {
        use yrs::Array;
        use yrs::encoding::write::Write;
        let (room, mut validator) = board();
        let writer = tab(&room, 11);
        // Two blocks, each a list of one value. `b` is the writer's first
        // struct.
        let mut anchors = Vec::new();
        let made = update(&writer, |doc| {
            let blocks = doc.get_or_insert_map(super::BOARD_ROOT);
            let mut txn = doc.transact_mut();
            for id in ["b", "o"] {
                let block = blocks.insert(&mut txn, id, MapPrelim::default());
                let list = block.insert(&mut txn, "a", yrs::ArrayPrelim::default());
                list.push_back(&mut txn, yrs::Any::Null);
                let branch: &yrs::branch::Branch = list.as_ref();
                anchors.push(*branch.start().unwrap().id());
            }
        });
        // Under one client, past 2^28 clocks (a collected struct claims
        // them, so every later clock takes five bytes): 4,000 pairs of one
        // value in `b`'s list and one in `o`'s, five bytes each.
        let pairs = 4_000u32;
        let mut tiny: Vec<u8> = Vec::new();
        tiny.write_var(1u32);
        tiny.write_var(2 * pairs + 1);
        tiny.write_var(77u64);
        tiny.write_var(0u32);
        tiny.write_u8(0);
        tiny.write_var(1u32 << 28);
        for _ in 0..pairs {
            for anchor in &anchors {
                tiny.write_u8(0x80 | 8);
                tiny.write_var(anchor.client.get());
                tiny.write_var(anchor.clock);
                tiny.write_var(1u32);
                tiny.write_u8(126);
            }
        }
        tiny.write_var(0u32);
        for bytes in [&made, &tiny] {
            assert!(matches!(
                send(&room, &mut validator, bytes),
                Admitted::Accepted
            ));
        }
        // Filled to 2,000 bytes under the cap, by a measure: the bound is
        // the state.
        let room_left = CANVAS_BOARD_MAX - whole(&room).len() - 2_000;
        let filled = update(&writer, |doc| {
            add_block(
                doc,
                "fill",
                "affine:note",
                &[("prop:text", &"x".repeat(room_left))],
            )
        });
        assert!(matches!(
            send(&room, &mut validator, &filled),
            Admitted::Accepted
        ));
        let before = whole(&room).len();
        assert_eq!(bound(&validator), before as u64);
        // `b` alone, by its id: every value in its list goes with it.
        let gone = deleting(11, &[(0, 1)]);
        let Admitted::Limit(LimitCode::DocumentSizeExceeded, metrics) =
            send(&room, &mut validator, &gone)
        else {
            panic!("the deletion entered");
        };
        let with = tab(&room, 14);
        ydoc::apply(&with, ydoc::decode(&gone).unwrap()).unwrap();
        assert_eq!(metrics.content_bytes, whole(&with).len() as u64);
        assert!(metrics.content_bytes > (before + 2 * pairs as usize) as u64);
        assert_eq!(whole(&room).len(), before);
        let thinned = update(&tab(&room, 13), |doc| {
            doc.get_or_insert_map(super::BOARD_ROOT)
                .remove(&mut doc.transact_mut(), "fill");
        });
        assert!(matches!(
            send(&room, &mut validator, &thinned),
            Admitted::Accepted
        ));
        let thin = whole(&room).len();
        assert!(matches!(
            send(&room, &mut validator, &gone),
            Admitted::Accepted
        ));
        let after = whole(&room).len();
        assert!(after > thin + 2 * pairs as usize);
        assert_eq!(bound(&validator), after as u64);
    }

    /// Board review 2: a board far from its cap is never measured, whatever
    /// an editor does to it. An exact measure leaves the bound at the state;
    /// here every update leaves it above: strokes drawn, a text typed into
    /// and cut, a text and a value written again under their keys, and
    /// blocks erased with all they hold (an editor's update names all of it).
    #[test]
    fn a_small_board_is_never_measured() {
        let (room, mut validator) = board();
        let writer = tab(&room, 11);
        let mut unmeasured = |bytes: Vec<u8>| {
            let growth = super::board_growth(&Update::decode_v1(&bytes).unwrap(), bytes.len());
            assert!(bound(&validator) + growth <= CANVAS_BOARD_MAX as u64);
            assert!(matches!(
                send(&room, &mut validator, &bytes),
                Admitted::Accepted
            ));
            assert!(bound(&validator) > whole(&room).len() as u64);
        };
        for n in 0..20 {
            unmeasured(update(&writer, |doc| stroke(doc, &format!("s{n}"))));
        }
        let blocks = writer.get_or_insert_map(super::BOARD_ROOT);
        let mut note = None;
        unmeasured(update(&writer, |doc| {
            let mut txn = doc.transact_mut();
            let block = blocks.insert(&mut txn, "note", MapPrelim::default());
            block.insert(
                &mut txn,
                "prop:text",
                TextPrelim::new("a long line of text"),
            );
            note = Some(block);
        }));
        let note: yrs::MapRef = note.unwrap();
        let Some(yrs::Out::YText(text)) = note.get(&writer.transact(), "prop:text") else {
            panic!("no text");
        };
        for at in [3, 9, 1] {
            unmeasured(update(&writer, |doc| {
                text.insert(&mut doc.transact_mut(), at, "typed");
            }));
            unmeasured(update(&writer, |doc| {
                text.remove_range(&mut doc.transact_mut(), at + 2, 4);
            }));
        }
        unmeasured(update(&writer, |doc| {
            let mut txn = doc.transact_mut();
            note.insert(&mut txn, "prop:text", TextPrelim::new("again"));
            note.insert(&mut txn, "sys:flavour", "affine:note");
            note.insert(&mut txn, "sys:flavour", "affine:edgeless-text");
        }));
        // Another tab erases: half the strokes, then the note.
        let eraser = tab(&room, 12);
        for id in ["s0", "s3", "s4", "s5", "s11", "s19", "note"] {
            unmeasured(update(&eraser, |doc| {
                doc.get_or_insert_map(super::BOARD_ROOT)
                    .remove(&mut doc.transact_mut(), id);
            }));
        }
    }

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
