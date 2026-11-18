//! What a material room's document is, by the material's kind: a Plate
//! document (notes, mindmaps, diagrams; the notes crate), a live item
//! document (flashcard sets; the items crate, live-items DESIGN.md) or a
//! canvas's board (BlockSuite's block map, which the server stores and bounds
//! but never reads beyond its image blocks). All project to the same Plate
//! envelope, so storage, projection, receipts and evictions do not care which.

use notes::catalog::CANVAS_BOARD_MAX;
use notes::limits::{LimitCode, Metrics};
use serde_json::{Value, json};
use yrs::{Any, Map, Out, ReadTxn, StateVector, Transact, UpdateBlock};

/// The one root a board's editors write: BlockSuite's map of blocks by id.
pub const BOARD_ROOT: &str = "blocks";

/// A board's first state, made by the editor's own code under Yjs client id
/// 1 (`src/features/blocksuite/boardFirstState.ts`, which pins these bytes):
/// a page block holding a surface block.
const BOARD_FIRST_STATE: &[u8] = include_bytes!("../fixtures/board-first-state.bin");

/// A board has no Plate value of its own: its block names the stored version
/// projected ([Model::projection]).
const BOARD_VALUE: &str = "a board projects by its stored version";

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

    /// The Plate value written to `materials.content`.
    pub fn value<T: ReadTxn>(self, txn: &T) -> Result<Vec<Value>, String> {
        match self {
            Model::Note => notes::plate::value(txn).map_err(|error| error.to_string()),
            Model::Item(kind) => Ok(kind.value(txn)),
            Model::Board => Err(BOARD_VALUE.into()),
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
            Model::Note => self.value(txn),
            Model::Item(kind) => Ok(kind.document_value(txn)),
            Model::Board => Err(BOARD_VALUE.into()),
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
            Model::Board => Ok(Metrics {
                content_bytes: txn.encode_state_as_update_v1(&StateVector::default()).len() as u64,
                max_depth: 0,
                node_count: 0,
            }),
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
            Model::Board => RoomValidator::Board(ydoc::Estimate::new(metrics.content_bytes)),
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

/// The one thing the server reads from a board: the editor assets its image
/// blocks name (a block map of flavour `affine:image`, its `prop:sourceId`),
/// each once, in byte order. Go keeps these and prunes the canvas's others.
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
            let text = |key: &str| match block.get(txn, key) {
                Some(Out::Any(Any::String(text))) => Some(text),
                _ => None,
            };
            if &*text("sys:flavour")? != "affine:image" {
                return None;
            }
            let id = text("prop:sourceId")?;
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

/// Whether `update` holds a struct past what the room holds.
fn grows<T: ReadTxn>(txn: &T, update: &yrs::Update) -> bool {
    let state = txn.state_vector();
    update.blocks().any(|block| {
        let (client, end) = match block {
            UpdateBlock::Item(item) => (item.id().client, item.id().clock + item.len()),
            UpdateBlock::Gc(range) | UpdateBlock::Skip(range) => {
                (range.client, range.clock + range.len)
            }
        };
        end > state.get(&client)
    })
}

/// A board update's own checks, after the room's (the client-id rule, the
/// marker root): one the room can place, at a cost yrs bounds, writing only
/// the blocks root, and keeping the state within [CANVAS_BOARD_MAX] by
/// `estimate`. Deletions alone skip the byte check, so a board at its cap can
/// still be thinned while the estimate refuses growth between two measures.
fn admit_board(
    doc: &yrs::Doc,
    update: &yrs::Update,
    bytes: &[u8],
    estimate: &mut ydoc::Estimate,
) -> Admitted {
    {
        let txn = doc.transact();
        let inspection = match ydoc::inspect_update(&txn, update) {
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
        if !grows(&txn, update) {
            return Admitted::Accepted;
        }
    }
    match ydoc::fits_room(doc, bytes, estimate, CANVAS_BOARD_MAX as u64) {
        Ok(true) => Admitted::Accepted,
        Ok(false) => Admitted::Limit(
            LimitCode::DocumentSizeExceeded,
            Metrics {
                content_bytes: estimate.bytes + bytes.len() as u64,
                max_depth: 0,
                node_count: 0,
            },
        ),
        Err(error) => Admitted::Refused(error),
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
    /// A board's running state size, held to [CANVAS_BOARD_MAX].
    Board(ydoc::Estimate),
}

impl RoomValidator {
    /// `bytes`: the update as it was sent (a board's size is counted in
    /// them). `draft`: a draft send's update, refused when a note's typing
    /// would be hidden in a deleted block (live typing there is collaboration).
    pub fn admit(
        &mut self,
        doc: &yrs::Doc,
        update: &yrs::Update,
        bytes: &[u8],
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
            RoomValidator::Board(estimate) => admit_board(doc, update, bytes, estimate),
        }
    }

    pub fn invalidate(&mut self) {
        match self {
            RoomValidator::Note(validator) => validator.invalidate(),
            RoomValidator::Item(validator) => validator.invalidate(),
            // At the cap with no measure pending, the next growing update
            // measures the board exactly.
            RoomValidator::Board(estimate) => {
                *estimate = ydoc::Estimate::new(CANVAS_BOARD_MAX as u64);
            }
        }
    }

    /// Whether admitting `bytes` more may measure a board exactly, which
    /// runs off the async workers.
    pub fn near_cap(&self, bytes: usize) -> bool {
        matches!(self, RoomValidator::Board(estimate)
            if estimate.bytes + bytes as u64 > CANVAS_BOARD_MAX as u64)
    }

    /// An applied update of `bytes` whose deletes freed `freed` payload
    /// bytes, on a board's estimate.
    pub fn applied(&mut self, bytes: u64, freed: u64) {
        if let RoomValidator::Board(estimate) = self {
            estimate.applied(bytes, freed);
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

    /// Admits `bytes` and, accepted, applies them as the room does.
    fn send(room: &yrs::Doc, validator: &mut RoomValidator, bytes: &[u8]) -> Admitted {
        let admitted = validator.admit(room, &ydoc::decode(bytes).unwrap(), bytes, false);
        if matches!(admitted, Admitted::Accepted) {
            let (applied, freed, _) =
                ydoc::apply_freeing(room, ydoc::decode(bytes).unwrap(), None).unwrap();
            validator.applied(applied.len() as u64, freed);
        }
        admitted
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
    /// limit, growth stays refused by the estimate until the next measure,
    /// and deletions alone still enter, after which the board takes growth
    /// again (contract C6). Fails if a board at its cap cannot be thinned.
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
                &[("prop:text", &text(1_900_000))],
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

    /// The server reads one thing from a board: the assets its image blocks
    /// name, each once, in byte order; a name that is no asset id, an image
    /// naming none and another block's `prop:sourceId` are skipped. Its
    /// projection is one block naming the stored version projected.
    #[test]
    fn a_board_projects_its_version_and_image_assets() {
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
            add_block(doc, "n1", "affine:note", &[("prop:sourceId", "asset_note")]);
            let blocks = doc.get_or_insert_map(super::BOARD_ROOT);
            blocks.insert(&mut doc.transact_mut(), "stray", "asset_stray");
        });
        assert!(matches!(
            send(&room, &mut validator, &drawn),
            Admitted::Accepted
        ));
        assert_eq!(
            Model::Board.projection(&room.transact(), 7).unwrap(),
            [json!({
                "type": "canvas_board", "id": "board", "children": [{ "text": "" }],
                "version": 7,
                "images": [
                    { "assetId": "Asset-9" }, { "assetId": "asset_a" }, { "assetId": "asset_b" },
                ],
            })]
        );
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
