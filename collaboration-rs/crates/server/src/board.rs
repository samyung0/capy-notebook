//! A canvas board held as its saved bytes instead of a live yrs document
//! (Epo 2026-11-24, "Approve all": the bytes-room plan, step 2): the stored
//! base, the rows stored past it (the tail), the writers' updates since the
//! last store (recent) and small indexes, about 1.1x the board's state where a
//! live document holds 12 to 19x. Nothing is integrated: an update is checked
//! on its decoded structs against the indexes, appended trimmed to what is
//! new, merged into a row at each store and answered to joiners by byte diffs.
//! A whole-board read (a diff of the base for a joiner behind it, a replica
//! for a trial) runs under the board work permit (`work.rs`), which the
//! caller holds.
//!
//! The approved rules:
//! * a read-only channel's update changes the board only by a struct past the
//!   state vector or a deletion past held clocks; one within them is
//!   acknowledged and ignored, since the delete-set index misses implicit
//!   deletions until the next fold ([Board::reader_changes]);
//! * an update past a small edit by its structs alone is tried on a replica
//!   first ([Board::check]);
//! * merges take at most 256 updates a call, then 64 merged ones
//!   ([bytes::merge_chunked]).

use std::borrow::Cow;
use std::collections::HashMap;

use yrs::block::{ClientID, Item, ItemContent, UpdateParent};
use yrs::updates::encoder::Encode;
use yrs::{Doc, ID, IdSet, ReadTxn, StateVector, Transact, Update, UpdateBlock};

use crate::model::BOARD_ROOT;

/// An update holding nothing: no structs, no deletions.
const EMPTY_UPDATE: &[u8] = &[0, 0];

/// The yrs seam (bytes-room plan section 7): every call that reads whole
/// update bytes. Today each decodes its input whole (`yrs::alt`), as large in
/// memory as a live document; a streaming reader in the fork replaces them
/// behind the same signatures.
pub mod bytes {
    use yrs::StateVector;
    use yrs::updates::encoder::Encode;

    pub use yrs::encoding::read::Error;

    /// The most updates one merge call takes: yrs's merge is superlinear in
    /// its inputs (16,000 small updates took 0.9 s, a 92,170-update log 93 s;
    /// in chunks, 0.48 s).
    const FIRST_CHUNK: usize = 256;
    /// The most merged chunks a later call takes.
    const NEXT_CHUNK: usize = 64;

    pub fn merge<B: AsRef<[u8]>>(updates: &[B]) -> Result<Vec<u8>, Error> {
        yrs::merge_updates_v1(updates)
    }

    /// What `update` holds past `since`, its whole delete set included.
    pub fn diff(update: &[u8], since: &StateVector) -> Result<Vec<u8>, Error> {
        yrs::diff_updates_v1(update, &since.encode_v1())
    }

    /// `updates` merged [FIRST_CHUNK] at a time, then the results
    /// [NEXT_CHUNK] at a time, until one is left.
    pub fn merge_chunked<B: AsRef<[u8]>>(updates: &[B]) -> Result<Vec<u8>, Error> {
        let mut level = updates
            .chunks(FIRST_CHUNK)
            .map(merge)
            .collect::<Result<Vec<_>, _>>()?;
        while level.len() > 1 {
            level = level
                .chunks(NEXT_CHUNK)
                .map(merge)
                .collect::<Result<Vec<_>, _>>()?;
        }
        match level.pop() {
            Some(merged) => Ok(merged),
            None => merge(updates),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BoardError {
    #[error("board bytes cannot be read: {0}")]
    Read(#[from] bytes::Error),
    #[error(transparent)]
    Replay(#[from] ydoc::ReplayError),
    /// yrs encoded a diff's delete set otherwise than the update's own.
    #[error("a trimmed update does not end with its delete set")]
    Trim,
}

/// What [Board::check] found of a writer's update.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Check {
    /// The room cannot place it yet (a gap in a client's clocks, a deletion
    /// past what either side holds, a reference neither holds): dropped, its
    /// writer resyncs (`Admitted::Unheld`). So the room's clocks stay one
    /// state vector.
    Unheld,
    /// A small edit by its structs: appended at once.
    Small,
    /// Past a small edit: tried on [Board::replica] under the board work
    /// permit before it is appended.
    Flagged,
}

/// A joiner's answer ([Board::join]), sized by its bytes.
pub struct Join<'a> {
    /// Sent first, each as an update: the rows' diffs, the recent updates,
    /// the marker document's state.
    pub updates: Vec<Cow<'a, [u8]>>,
    /// Sent last, as the step 2, so a synced joiner holds the whole board:
    /// the base's part.
    pub step2: Cow<'a, [u8]>,
}

impl Join<'_> {
    pub fn size(&self) -> usize {
        self.updates
            .iter()
            .map(|update| update.len())
            .sum::<usize>()
            + self.step2.len()
    }
}

/// A store's row ([Board::row]) until it commits ([Board::stored]).
pub struct Row {
    /// What the store writes: the recent updates and the marker document's
    /// delta, live markers deleted in it.
    pub bytes: Vec<u8>,
    /// The recent updates alone, merged: the tail's part.
    writers: Vec<u8>,
    /// How many recent updates it holds.
    count: usize,
    /// What committed rows hold of the marker document once it commits.
    markers: ydoc::Durable,
}

pub struct Board {
    /// The stored base: the last fold's compacted state, or the first state.
    base: Vec<u8>,
    /// The base's state vector: a joiner at or past it holds every struct of
    /// the base.
    base_sv: StateVector,
    /// While a fold runs, the rows stored before it began (the ones it
    /// covers), merged.
    folding: Option<Vec<u8>>,
    /// The rows stored past the base, or past a running fold's start, merged.
    tail: Vec<u8>,
    /// The writers' updates since the last committed store, trimmed.
    recent: Vec<Vec<u8>>,
    /// What base, rows and recent updates hold: a plain state vector, since
    /// unheld updates are dropped.
    sv: StateVector,
    /// Every deletion the room holds by name: the base's whole delete set and
    /// each appended update's new deletions. It lacks implicit deletions (a
    /// concurrent overwrite's loser, content added to a type deleted at the
    /// same time) until a fold's base names them.
    deleted: IdSet,
    /// This life's contributor markers, the only structs the room writes, in
    /// a document of their own under the room's client.
    markers: Doc,
    /// What committed rows hold of [Board::markers].
    markers_durable: ydoc::Durable,
}

impl Board {
    /// A board on its stored base and the base's indexes (no decode of the
    /// base). `room_client` writes the markers: one no stored struct or
    /// deletion names.
    pub fn new(
        base: Vec<u8>,
        base_sv: StateVector,
        base_ds: IdSet,
        room_client: ClientID,
    ) -> Board {
        Board {
            base,
            sv: base_sv.clone(),
            base_sv,
            folding: None,
            tail: Vec::new(),
            recent: Vec::new(),
            deleted: base_ds,
            markers: Doc::with_options(ydoc::doc_options(room_client.get())),
            markers_durable: ydoc::Durable::default(),
        }
    }

    /// The marker document, where the room writes and clears markers.
    pub fn markers(&self) -> &Doc {
        &self.markers
    }

    /// Everything the room holds, its markers included.
    pub fn state_vector(&self) -> StateVector {
        let mut state = self.sv.clone();
        state.merge(self.markers.transact().state_vector());
        state
    }

    /// Whether a writer's `update` tells the room anything: a struct past its
    /// state vector or a deletion outside its delete-set index. Deleting what
    /// the index misses counts: appended, it costs a few bytes.
    pub fn changes(&self, update: &Update) -> bool {
        writes(&self.state_vector(), update) || !self.fresh_deletions(update).is_empty()
    }

    /// Whether a read-only channel's `update` tells the room anything: a
    /// struct past its state vector or a deletion past held clocks. A
    /// deletion within them is acknowledged and ignored: a reader's step 2
    /// names the implicit deletions the index misses.
    pub fn reader_changes(&self, update: &Update) -> bool {
        let state = self.state_vector();
        writes(&state, update)
            || update
                .delete_set()
                .iter()
                .any(|(client, ranges)| ranges.iter().any(|range| range.end > state.get(client)))
    }

    /// A writer's update checked on its structs alone, as `ydoc::inspected`
    /// checks its shape and reach: the refusal when it is malformed or names
    /// a root other than the blocks root. A small edit is at most
    /// [ydoc::SMALL_EDIT] new structs and as many new delete ranges, of one
    /// writing client, with no item between two held units that are not one
    /// client's consecutive clocks (its conflict scan could pass a whole
    /// sequence) and no new type whose parent is implicit (it has no depth).
    pub fn check(&self, update: &Update) -> Result<Check, String> {
        ydoc::within_clocks(update).map_err(|error| error.to_string())?;
        let mut ends: HashMap<ClientID, u32> = HashMap::new();
        for block in update.blocks() {
            let (client, clock, len) = span(&block);
            let end = ends.entry(client).or_default();
            if clock < *end {
                return Err(format!(
                    "struct {clock} of client {client} overlaps or precedes the one before it"
                ));
            }
            *end = clock + len;
            if let UpdateBlock::Item(item) = block
                && references(item).any(|id| id.client == client && id.clock >= clock)
            {
                return Err(format!(
                    "struct {clock} of client {client} refers to itself or a later struct of its client"
                ));
            }
        }
        let state = self.state_vector();
        if unheld(&state, update) {
            return Ok(Check::Unheld);
        }
        let held = |id: &ID| id.clock < state.get(&id.client);
        let (mut structs, mut writer, mut flagged) = (0, None, false);
        for block in update.blocks() {
            let (client, end) = ydoc::struct_end(&block);
            if end <= state.get(&client) {
                continue;
            }
            structs += 1;
            flagged |= writer.is_some_and(|writer| writer != client);
            writer = Some(client);
            let UpdateBlock::Item(item) = block else {
                continue;
            };
            match item.update_parent() {
                UpdateParent::Root(name) if &**name != BOARD_ROOT => {
                    return Err("a board update writes only the blocks root".into());
                }
                UpdateParent::Unknown => {
                    flagged |= matches!(item.content(), ItemContent::Type(_));
                }
                _ => {}
            }
            if let (Some(origin), Some(right)) = (item.origin(), item.right_origin()) {
                let next = right.client == origin.client && right.clock == origin.clock + 1;
                flagged |= held(origin) && held(right) && !next;
            }
        }
        // T5: the depth index refuses a type past 64 levels here, and the
        // earlier lives' marker clients any struct or deletion naming one.
        let ranges: usize = self
            .fresh_deletions(update)
            .iter()
            .map(|(_, ranges)| ranges.len())
            .sum();
        flagged |= structs > ydoc::SMALL_EDIT || ranges > ydoc::SMALL_EDIT;
        Ok(if flagged {
            Check::Flagged
        } else {
            Check::Small
        })
    }

    /// Appends a writer's update the room placed ([Board::check]), `sent` as
    /// it came, trimmed: its diff against the state vector before it, the
    /// delete set cut to the deletions the index lacks. Implicit deletions
    /// need nothing: every replica derives them from the structs it receives.
    /// What peers hear, or none when nothing was new.
    pub fn append(&mut self, sent: &[u8], update: &Update) -> Result<Option<&[u8]>, BoardError> {
        let state = self.state_vector();
        let fresh = self.fresh_deletions(update);
        if !writes(&state, update) && fresh.is_empty() {
            return Ok(None);
        }
        let diffed = bytes::diff(sent, &state)?;
        let named = update.delete_set().encode_v1();
        let structs = diffed
            .strip_suffix(named.as_slice())
            .ok_or(BoardError::Trim)?;
        let mut trimmed = structs.to_vec();
        trimmed.extend_from_slice(&fresh.encode_v1());
        for block in update.blocks() {
            if !matches!(block, UpdateBlock::Skip(_)) {
                let (client, end) = ydoc::struct_end(&block);
                self.sv.set_max(client, end);
            }
        }
        self.deleted.merge_with(fresh);
        self.recent.push(trimmed);
        Ok(self.recent.last().map(Vec::as_slice))
    }

    /// The next store's row: the recent updates merged in chunks, with the
    /// marker document's delta (its live markers deleted in the row, as
    /// today). The recent updates stay until the row commits, one row at a
    /// time.
    pub fn row(&self) -> Result<Row, BoardError> {
        let writers = if self.recent.is_empty() {
            Vec::new()
        } else {
            bytes::merge_chunked(&self.recent)?
        };
        let (markers, cover) = {
            let txn = self.markers.transact();
            ydoc::delta_update(&txn, &self.markers_durable, &ydoc::live_markers(&txn))
        };
        let bytes = match (writers.is_empty(), markers.as_slice() == EMPTY_UPDATE) {
            (true, _) => markers,
            (false, true) => writers.clone(),
            (false, false) => bytes::merge(&[writers.as_slice(), markers.as_slice()])?,
        };
        Ok(Row {
            bytes,
            writers,
            count: self.recent.len(),
            markers: cover,
        })
    }

    /// `row` committed: its recent updates join the tail. The tail takes
    /// them without the marker delta, whose deletions of live markers would
    /// reach joiners before the room clears them.
    pub fn stored(&mut self, row: Row) -> Result<(), BoardError> {
        if !row.writers.is_empty() {
            self.tail = if self.tail.is_empty() {
                row.writers
            } else {
                bytes::merge(&[self.tail.as_slice(), row.writers.as_slice()])?
            };
        }
        self.recent.drain(..row.count);
        self.markers_durable = row.markers;
        Ok(())
    }

    /// A fold begins over the rows committed so far; rows stored from now on
    /// stay in the tail past it. With one running, nothing moves.
    pub fn begin_fold(&mut self) {
        if self.folding.is_none() {
            self.folding = Some(std::mem::take(&mut self.tail));
        }
    }

    /// The fold's new base and its stored indexes replace the base and the
    /// rows it covered. The index keeps what it held, and takes the
    /// implicit deletions the new base names.
    pub fn folded(&mut self, base: Vec<u8>, base_sv: StateVector, base_ds: IdSet) {
        self.base = base;
        self.folding = None;
        self.sv.merge(base_sv.clone());
        self.base_sv = base_sv;
        self.deleted.merge_with(base_ds);
    }

    /// A fold that failed: the rows it covered go back to the tail.
    pub fn fold_failed(&mut self) -> Result<(), BoardError> {
        let Some(folding) = self.folding.take() else {
            return Ok(());
        };
        if self.tail.is_empty() {
            self.tail = folding;
        } else if !folding.is_empty() {
            match bytes::merge(&[folding.as_slice(), self.tail.as_slice()]) {
                Ok(merged) => self.tail = merged,
                Err(error) => {
                    self.folding = Some(folding);
                    return Err(error.into());
                }
            }
        }
        Ok(())
    }

    /// Whether a joiner at `since` holds part of the base: its answer diffs
    /// the whole base, under the board work permit.
    pub fn behind_base(&self, since: &StateVector) -> bool {
        !self.holds_base(since) && !self.holds_none_of_base(since)
    }

    /// The answer to a joiner at `since`: the rows' diffs (as they are for a
    /// fresh joiner), the recent updates (a joiner skips what it holds) and
    /// the marker state, then the base's part: the base as it is when the
    /// joiner holds none of it, the delete-set index when it holds all of it
    /// (the index holds every deletion the base names), else a diff of the
    /// whole base ([Board::behind_base]).
    pub fn join(&self, since: &StateVector) -> Result<Join<'_>, BoardError> {
        let mut updates = Vec::new();
        for rows in self.folding.iter().chain([&self.tail]) {
            if rows.is_empty() {
                continue;
            }
            updates.push(if since.is_empty() {
                Cow::Borrowed(rows.as_slice())
            } else {
                Cow::Owned(bytes::diff(rows, since)?)
            });
        }
        updates.extend(
            self.recent
                .iter()
                .map(|update| Cow::Borrowed(update.as_slice())),
        );
        let markers = self.markers.transact();
        if !markers.state_vector().is_empty() {
            updates.push(Cow::Owned(markers.encode_state_as_update_v1(since)));
        }
        let step2 = if self.holds_none_of_base(since) {
            Cow::Borrowed(self.base.as_slice())
        } else if self.holds_base(since) {
            let mut deletions = vec![0];
            deletions.extend(self.deleted.encode_v1());
            Cow::Owned(deletions)
        } else {
            Cow::Owned(bytes::diff(&self.base, since)?)
        };
        Ok(Join { updates, step2 })
    }

    /// The board as one short-lived document, nothing left pending: for a
    /// flagged update's trial and an exact size, under the board work permit.
    pub fn replica(&self) -> Result<Doc, BoardError> {
        let markers = self
            .markers
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let rows: Vec<&[u8]> = self
            .folding
            .iter()
            .chain([&self.tail])
            .filter(|rows| !rows.is_empty())
            .chain(&self.recent)
            .map(Vec::as_slice)
            .chain([markers.as_slice()])
            .collect();
        let doc = ydoc::scratch_doc();
        ydoc::replay(&doc, &self.base, &rows)?;
        Ok(doc)
    }

    fn holds_base(&self, since: &StateVector) -> bool {
        self.base_sv
            .iter()
            .all(|(client, clock)| since.get(client) >= *clock)
    }

    fn holds_none_of_base(&self, since: &StateVector) -> bool {
        self.base_sv
            .iter()
            .all(|(client, _)| since.get(client) == 0)
    }

    /// `update`'s deletions the room does not hold by name: outside the
    /// index and, for the room's client, the marker document's own.
    fn fresh_deletions(&self, update: &Update) -> IdSet {
        let mut fresh = update.delete_set().diff(&self.deleted);
        if fresh.get(&self.markers.client_id()).is_some() {
            fresh.diff_with(&self.markers.transact().snapshot().delete_set);
        }
        fresh
    }
}

/// A struct's client, first clock and length.
fn span(block: &UpdateBlock) -> (ClientID, u32, u32) {
    match block {
        UpdateBlock::Item(item) => (item.id().client, item.id().clock, item.len()),
        UpdateBlock::Gc(range) | UpdateBlock::Skip(range) => (range.client, range.clock, range.len),
    }
}

/// An item's origin, right origin and named parent.
fn references(item: &Item) -> impl Iterator<Item = &ID> {
    let parent = match item.update_parent() {
        UpdateParent::Item(parent) => Some(parent),
        _ => None,
    };
    [item.origin(), item.right_origin(), parent]
        .into_iter()
        .flatten()
}

/// Whether `update` holds a struct past `state`.
fn writes(state: &StateVector, update: &Update) -> bool {
    update.blocks().any(|block| {
        let (client, end) = ydoc::struct_end(&block);
        end > state.get(&client)
    })
}

/// Whether the room at `state` cannot place `update` yet, as
/// `ydoc::inspected` reaches: a skip or a struct past a gap in its client's
/// clocks, a deletion past what either side holds, or a new item naming a
/// unit neither holds.
fn unheld(state: &StateVector, update: &Update) -> bool {
    let mut reach: HashMap<ClientID, u32> = HashMap::new();
    for block in update.blocks() {
        let (client, clock, len) = span(&block);
        let from = reach
            .get(&client)
            .copied()
            .unwrap_or_else(|| state.get(&client));
        if matches!(block, UpdateBlock::Skip(_)) || clock > from {
            return true;
        }
        reach.insert(client, from.max(clock + len));
    }
    let until = |client: &ClientID| {
        reach
            .get(client)
            .copied()
            .unwrap_or_else(|| state.get(client))
    };
    let past = update
        .delete_set()
        .iter()
        .any(|(client, ranges)| ranges.iter().any(|range| range.end > until(client)));
    past || update.blocks().any(|block| match block {
        UpdateBlock::Item(item) => {
            ydoc::struct_end(&block).1 > state.get(&item.id().client)
                && references(item).any(|id| id.clock >= until(&id.client))
        }
        UpdateBlock::Gc(_) | UpdateBlock::Skip(_) => false,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::collections::HashMap;

    use yrs::block::ClientID;
    use yrs::types::ToJson;
    use yrs::updates::decoder::Decode;
    use yrs::{
        Any, Array, ArrayPrelim, Doc, IdSet, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector,
        Text, TextPrelim, TextRef, Transact, TransactionMut, Update,
    };

    use super::{Board, Check, bytes};
    use crate::model::{BOARD_ROOT, Model};

    /// The room's client: it writes the markers.
    const ROOM: u64 = 900;

    fn first_state() -> Vec<u8> {
        Model::Board.state_from_value(&[])
    }

    fn decode(bytes: &[u8]) -> Update {
        Update::decode_v1(bytes).unwrap()
    }

    fn apply(doc: &Doc, bytes: &[u8]) {
        doc.transact_mut().apply_update(decode(bytes)).unwrap();
    }

    /// A document of `updates`, each applied in its own transaction.
    fn replica<B: AsRef<[u8]>>(updates: &[B]) -> Doc {
        let doc = ydoc::scratch_doc();
        for update in updates {
            apply(&doc, update.as_ref());
        }
        doc
    }

    /// `updates` as a fold stores them: compacted, with the state's indexes.
    fn compacted<B: AsRef<[u8]>>(updates: &[B]) -> (Vec<u8>, StateVector, IdSet) {
        let doc = replica(updates);
        let txn = doc.transact();
        let snapshot = txn.snapshot();
        let state = txn.encode_state_as_update_v1(&StateVector::default());
        (state, snapshot.state_map, snapshot.delete_set)
    }

    /// What a document holds: its clocks, its deletions and the content of
    /// both roots (yrs maps compare in any order).
    fn held(doc: &Doc) -> (StateVector, IdSet, Vec<Option<Any>>) {
        let txn = doc.transact();
        let content = [BOARD_ROOT, ydoc::CONTRIBUTORS_ROOT]
            .map(|root| txn.get_map(root).map(|map| map.to_json(&txn)))
            .to_vec();
        let snapshot = txn.snapshot();
        (snapshot.state_map, snapshot.delete_set, content)
    }

    fn pending(doc: &Doc) -> bool {
        ydoc::has_pending(&doc.transact())
    }

    /// A board room under test: the board, the rows its stores committed
    /// past the stored base, a reference document that applied every
    /// delivered update in turn (a live document room), a peer that heard
    /// only what the board relayed, and the updates waiting on a resync.
    struct Room {
        board: Board,
        stored_base: Vec<u8>,
        rows: Vec<Vec<u8>>,
        reference: Doc,
        peer: Doc,
        waiting: Vec<Vec<u8>>,
    }

    impl Room {
        /// A fresh canvas: the first state, with the indexes its seed stores.
        fn new() -> Room {
            let first = first_state();
            let (base, sv, ds) = compacted(&[&first]);
            Room {
                board: Board::new(base.clone(), sv, ds, ClientID::new(ROOM)),
                stored_base: base,
                rows: Vec::new(),
                reference: replica(&[&first]),
                peer: replica(&[&first]),
                waiting: Vec::new(),
            }
        }

        /// A writer's update as the room admits it: none when unheld, else
        /// whether it was appended (and relayed to the peer).
        fn offer(&mut self, sent: &[u8]) -> Option<bool> {
            let update = decode(sent);
            if self.board.check(&update).unwrap() == Check::Unheld {
                return None;
            }
            if !self.board.changes(&update) {
                return Some(false);
            }
            let relayed = self.board.append(sent, &update).unwrap().unwrap();
            apply(&self.peer, relayed);
            Some(true)
        }

        /// `sent` reaches the reference and the room. One the room cannot
        /// place yet waits for its writer's resync, tried again after every
        /// update the room appends.
        fn deliver(&mut self, sent: &[u8]) {
            apply(&self.reference, sent);
            match self.offer(sent) {
                None => self.waiting.push(sent.to_vec()),
                Some(true) => self.resync(),
                Some(false) => {}
            }
        }

        fn resync(&mut self) {
            loop {
                let waiting = std::mem::take(&mut self.waiting);
                let before = waiting.len();
                for sent in waiting {
                    if self.offer(&sent).is_none() {
                        self.waiting.push(sent);
                    }
                }
                if self.waiting.len() == before {
                    return;
                }
            }
        }

        fn store(&mut self) {
            let row = self.board.row().unwrap();
            self.rows.push(row.bytes.clone());
            self.board.stored(row).unwrap();
        }

        /// A fold begins over the rows committed so far: how many.
        fn begin_fold(&mut self) -> usize {
            self.board.begin_fold();
            self.rows.len()
        }

        /// The fold of the stored base and its first `through` rows ends, as
        /// `note_store::fold` stores it.
        fn end_fold(&mut self, through: usize) {
            let mut parts = vec![self.stored_base.clone()];
            parts.extend(self.rows.drain(..through));
            let (base, sv, ds) = compacted(&parts);
            self.stored_base = base.clone();
            self.board.folded(base, sv, ds);
        }

        fn fold(&mut self) {
            let through = self.begin_fold();
            self.end_fold(through);
        }

        /// A joiner holding nothing, synced by the room's answer.
        fn join(&self) -> Doc {
            let doc = ydoc::scratch_doc();
            self.catch_up(&doc);
            doc
        }

        /// `doc` rejoins: the room's answer to its state vector, the step 2
        /// last.
        fn catch_up(&self, doc: &Doc) {
            let since = doc.transact().state_vector();
            let answer = self.board.join(&since).unwrap();
            assert!(answer.size() > 0);
            for update in answer.updates.iter().chain([&answer.step2]) {
                apply(doc, update);
            }
        }

        /// A writer's step 2 from `doc`: all it holds past the room's state
        /// vector, its whole delete set included.
        fn step2(&self, doc: &Doc) -> Update {
            let since = self.board.state_vector();
            decode(&doc.transact().encode_state_as_update_v1(&since))
        }
    }

    /// The prototype's xorshift.
    struct Rng(u64);

    impl Rng {
        fn below(&mut self, n: usize) -> usize {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 % n as u64) as usize
        }
    }

    /// A tab's document under `client`, and how much of what the tabs sent
    /// it has heard.
    struct Tab {
        doc: Doc,
        blocks: MapRef,
        heard: usize,
    }

    fn tab(client: u64) -> Tab {
        let doc = Doc::with_options(ydoc::doc_options(client));
        let blocks = doc.get_or_insert_map(BOARD_ROOT);
        Tab {
            doc,
            blocks,
            heard: 0,
        }
    }

    /// A tab holding the room's board.
    fn synced(room: &Room, client: u64) -> Tab {
        let tab = tab(client);
        room.catch_up(&tab.doc);
        tab
    }

    /// The update of `edit` on `tab`, in its own transaction.
    fn edited(tab: &Tab, edit: impl FnOnce(&mut TransactionMut, &MapRef)) -> Vec<u8> {
        let mut txn = tab.doc.transact_mut();
        edit(&mut txn, &tab.blocks);
        ydoc::committed_update(txn)
    }

    fn block<T: ReadTxn>(txn: &T, blocks: &MapRef, id: &str) -> MapRef {
        match blocks.get(txn, id) {
            Some(Out::YMap(block)) => block,
            other => panic!("block {id}: {other:?}"),
        }
    }

    fn text<T: ReadTxn>(txn: &T, blocks: &MapRef, id: &str, key: &str) -> TextRef {
        match block(txn, blocks, id).get(txn, key) {
            Some(Out::YText(text)) => text,
            other => panic!("{id} {key}: {other:?}"),
        }
    }

    /// One edit as the editor makes one: a block added, dragged or deleted,
    /// text typed or erased, an element added. Empty when nothing changed.
    fn edit(tab: &Tab, rng: &mut Rng, n: usize) -> Vec<u8> {
        let client = tab.doc.client_id();
        edited(tab, |txn, blocks| {
            let mut ids: Vec<String> = blocks
                .keys(txn)
                .filter(|id| id.starts_with('b'))
                .map(str::to_owned)
                .collect();
            ids.sort();
            let kind = if ids.is_empty() { 0 } else { rng.below(10) };
            let id = (!ids.is_empty()).then(|| ids[rng.below(ids.len())].clone());
            match (id, kind) {
                (Some(id), 2 | 3) => {
                    block(txn, blocks, &id).insert(txn, "prop:xywh", format!("[{n},{n},200,80]"));
                }
                (Some(id), 4..=6) => {
                    let text = text(txn, blocks, &id, "prop:text");
                    let at = rng.below(text.len(txn) as usize + 1) as u32;
                    text.insert(txn, at, "ab");
                }
                (Some(id), 7) => {
                    let text = text(txn, blocks, &id, "prop:text");
                    let len = text.len(txn) as usize;
                    if len > 1 {
                        text.remove_range(txn, rng.below(len - 1) as u32, 2);
                    }
                }
                (Some(id), 8) => {
                    if let Some(Out::YMap(elements)) =
                        block(txn, blocks, &id).get(txn, "prop:elements")
                    {
                        let element = elements.insert(txn, format!("e{n}"), MapPrelim::default());
                        element.insert(txn, "xywh", format!("[{n},0,10,10]"));
                    }
                }
                (Some(id), 9) if ids.len() > 4 => {
                    blocks.remove(txn, &id);
                }
                _ => {
                    let block = blocks.insert(txn, format!("b{client}-{n}"), MapPrelim::default());
                    block.insert(txn, "sys:flavour", "affine:note");
                    block.insert(txn, "prop:text", TextPrelim::new("note"));
                    block.insert(txn, "prop:elements", MapPrelim::default());
                }
            }
        })
    }

    /// `edits` edits by `tabs` tabs on a fresh board, each tab hearing what
    /// the others sent now and then, so their updates overlap (concurrent
    /// drags, typing into a block another tab deleted) and depend on each
    /// other. Every update in the order it was sent.
    fn session(tabs: u64, edits: usize, seed: u64) -> Vec<Vec<u8>> {
        let first = first_state();
        let mut tabs: Vec<Tab> = (0..tabs).map(|n| tab(11 + n)).collect();
        for tab in &tabs {
            apply(&tab.doc, &first);
        }
        let mut sent: Vec<Vec<u8>> = Vec::new();
        let mut rng = Rng(seed);
        for n in 0..edits {
            let at = rng.below(tabs.len());
            let tab = &mut tabs[at];
            if rng.below(3) == 0 {
                for update in &sent[tab.heard..] {
                    apply(&tab.doc, update);
                }
                tab.heard = sent.len();
            }
            let update = edit(tab, &mut rng, n);
            if !update.is_empty() {
                sent.push(update);
            }
        }
        sent
    }

    /// The prototype's delivery orders: in order, with duplicates, with
    /// adjacent swaps, shuffled in eights.
    fn orders(updates: &[Vec<u8>]) -> Vec<(&'static str, Vec<Vec<u8>>)> {
        let n = updates.len();
        let mut duplicates = Vec::with_capacity(n * 2);
        for (i, update) in updates.iter().enumerate() {
            duplicates.push(update.clone());
            if i % 5 == 0 {
                duplicates.push(update.clone());
            }
            if i % 97 == 0 && i > 0 {
                duplicates.push(updates[i / 2].clone());
            }
        }
        duplicates.extend(updates[..100.min(n)].iter().cloned());
        let mut swaps = updates.to_vec();
        let mut i = 1;
        while i + 1 < n {
            swaps.swap(i, i + 1);
            i += 10;
        }
        let mut shuffled = updates.to_vec();
        let mut rng = Rng(0x2545_F491_4F6C_DD1D);
        for chunk in shuffled.chunks_mut(8) {
            for j in (1..chunk.len()).rev() {
                chunk.swap(j, rng.below(j + 1));
            }
        }
        vec![
            ("in order", updates.to_vec()),
            ("duplicates", duplicates),
            ("adjacent swaps", swaps),
            ("shuffled in eights", shuffled),
        ]
    }

    /// The prototype's `correct` cases: whatever order a board's updates
    /// arrive in, with stores every 25 and a fold halfway, a fresh joiner, a
    /// joiner holding the base, one behind it, a peer that heard only the
    /// relayed updates and the room's replica all hold what a live document
    /// holds.
    #[test]
    fn every_joiner_holds_the_board_whatever_the_delivery_order() {
        let updates = session(4, 400, 7);
        for (order, delivery) in orders(&updates) {
            let mut room = Room::new();
            let (third, half) = (delivery.len() / 3, delivery.len() / 2);
            let (mut behind, mut holding) = (None, None);
            for (at, sent) in delivery.iter().enumerate() {
                if at == third {
                    behind = Some(room.join());
                }
                if at == half {
                    room.store();
                    room.fold();
                    holding = Some(room.join());
                }
                room.deliver(sent);
                // Stores every 25, so the answers end with recent updates.
                if at % 25 == 13 {
                    room.store();
                }
            }
            assert!(room.waiting.is_empty(), "{order}: updates still wait");
            // The duplicates end by resending the first 100: nothing new.
            assert!(!room.board.tail.is_empty());
            assert!(order == "duplicates" || !room.board.recent.is_empty());
            assert!(!pending(&room.reference), "{order}");
            let (behind, holding) = (behind.unwrap(), holding.unwrap());
            assert!(room.board.behind_base(&behind.transact().state_vector()));
            assert!(room.board.holds_base(&holding.transact().state_vector()));
            room.catch_up(&behind);
            room.catch_up(&holding);
            let board = held(&room.reference);
            let replica = room.board.replica().unwrap();
            for (who, doc) in [
                ("a fresh joiner", &room.join()),
                ("a joiner behind the base", &behind),
                ("a joiner holding the base", &holding),
                ("the peer", &room.peer),
                ("the replica", &replica),
            ] {
                assert!(!pending(doc), "{order}: {who} holds pending structs");
                assert!(held(doc) == board, "{order}: {who} holds another board");
            }
        }
    }

    /// The prototype's `dependency` case: an update that arrives before the
    /// one it continues is dropped for a resync and leaves the room as it
    /// was, as a document room drops it (the fork's yrs would hold it past a
    /// skip, not pending); once its dependency lands the resync takes it, and
    /// joiners from before and after hold the board.
    #[test]
    fn an_update_before_its_dependency_waits_for_a_resync() {
        let updates = session(3, 120, 99);
        let continues = |a: &Update, b: &Update| {
            let mut spans = b.blocks().map(|block| super::span(&block));
            let Some((client, clock, _)) = spans.next() else {
                return false;
            };
            let end = a
                .blocks()
                .map(|block| ydoc::struct_end(&block))
                .filter(|(of, _)| *of == client)
                .map(|(_, end)| end)
                .max();
            spans.all(|(of, _, _)| of == client) && end == Some(clock) && b.delete_set().is_empty()
        };
        let j = (0..updates.len() - 1)
            .find(|&j| continues(&decode(&updates[j]), &decode(&updates[j + 1])))
            .unwrap();
        let mut room = Room::new();
        for sent in &updates[..j] {
            room.deliver(sent);
        }
        let before = room.board.state_vector();
        assert_eq!(room.offer(&updates[j + 1]), None);
        room.waiting.push(updates[j + 1].clone());
        assert!(room.board.state_vector() == before);
        let early = room.join();
        assert!(held(&early) == held(&room.reference));
        room.deliver(&updates[j]);
        assert!(room.waiting.is_empty());
        apply(&room.reference, &updates[j + 1]);
        room.catch_up(&early);
        for doc in [&early, &room.join(), &room.peer] {
            assert!(!pending(doc) && held(doc) == held(&room.reference));
        }
    }

    /// A joiner that holds every struct of the base but not a deletion a
    /// fold took into it (a deletion moves no clock) takes it from the
    /// delete-set index, with no diff of the base.
    #[test]
    fn a_joiner_holding_the_base_takes_its_deletions_from_the_index() {
        let mut room = Room::new();
        let writer = synced(&room, 11);
        room.deliver(&edited(&writer, |txn, blocks| {
            blocks.insert(txn, "x", MapPrelim::default()).insert(
                txn,
                "prop:text",
                TextPrelim::new("hello"),
            );
        }));
        room.store();
        room.fold();
        let early = room.join();
        let eraser = synced(&room, 12);
        room.deliver(&edited(&eraser, |txn, blocks| {
            blocks.remove(txn, "x");
        }));
        room.store();
        room.fold();
        let since = early.transact().state_vector();
        assert!(room.board.holds_base(&since) && !room.board.behind_base(&since));
        assert!(room.board.join(&since).unwrap().updates.is_empty());
        room.catch_up(&early);
        assert!(held(&early) == held(&room.reference));
    }

    /// A reconnect's step 2, built against the room's state vector of a
    /// while ago, carries structs the room took since and the tab's whole
    /// delete set: what is appended and relayed is only what is new.
    #[test]
    fn a_stale_step2_is_relayed_trimmed_to_what_is_new() {
        let updates = session(2, 80, 13);
        let mut room = Room::new();
        for sent in &updates[..20] {
            room.deliver(sent);
        }
        let stale = room.board.state_vector();
        for sent in &updates[20..40] {
            room.deliver(sent);
        }
        let mut reconnecting = vec![first_state()];
        reconnecting.extend_from_slice(&updates);
        let step2 = replica(&reconnecting)
            .transact()
            .encode_state_as_update_v1(&stale);
        let (state, deleted) = (room.board.state_vector(), room.board.deleted.clone());
        room.deliver(&step2);
        let relayed = room.board.recent.last().unwrap().clone();
        assert!(relayed.len() < step2.len());
        let relayed = decode(&relayed);
        assert!(relayed.blocks().all(|block| {
            let (client, clock, _) = super::span(&block);
            clock >= state.get(&client)
        }));
        assert!(relayed.delete_set().intersect(&deleted).is_empty());
        let replica = room.board.replica().unwrap();
        for doc in [&room.join(), &room.peer, &replica] {
            assert!(held(doc) == held(&room.reference));
        }
    }

    /// A merge in chunks (256, then 64) holds what its updates hold.
    #[test]
    fn a_chunked_merge_holds_what_its_updates_hold() {
        let mut updates = vec![first_state()];
        updates.extend(session(3, 700, 3));
        assert!(updates.len() > 2 * 256);
        for some in [&updates[..10], &updates[..]] {
            let merged = bytes::merge_chunked(some).unwrap();
            assert!(held(&replica(&[merged])) == held(&replica(some)));
        }
    }

    /// A fold that ends while stores go on: the rows stored after it began
    /// stay in the tail past the new base, and joiners from before and after
    /// the swap hold the board. A fold that fails gives its rows back.
    #[test]
    fn a_fold_swap_keeps_the_rows_stored_after_it_began() {
        let updates = session(3, 160, 5);
        let mut room = Room::new();
        for sent in &updates[..60] {
            room.deliver(sent);
        }
        room.store();
        let through = room.begin_fold();
        for sent in &updates[60..100] {
            room.deliver(sent);
        }
        room.store();
        let early = room.join();
        room.end_fold(through);
        assert!(room.board.folding.is_none() && !room.board.tail.is_empty());
        let mut first_60 = vec![first_state()];
        first_60.extend_from_slice(&updates[..60]);
        assert!(held(&replica(&[&room.board.base])) == held(&replica(&first_60)));
        for sent in &updates[100..130] {
            room.deliver(sent);
        }
        assert!(room.board.holds_base(&early.transact().state_vector()));
        room.catch_up(&early);
        let replica = room.board.replica().unwrap();
        for doc in [&early, &room.join(), &replica] {
            assert!(held(doc) == held(&room.reference));
        }
        room.store();
        room.board.begin_fold();
        for sent in &updates[130..] {
            room.deliver(sent);
        }
        room.store();
        room.board.fold_failed().unwrap();
        assert!(room.board.folding.is_none());
        let replica = room.board.replica().unwrap();
        for doc in [&room.join(), &replica] {
            assert!(held(doc) == held(&room.reference));
        }
    }

    /// The approved flag rule, on structs alone: a small edit passes, and
    /// more than 16 new structs or delete ranges, two writing clients, an
    /// insert between held units of two clients and a new type with an
    /// implicit parent are tried first. Another root is refused.
    #[test]
    fn past_a_small_edit_by_its_structs_an_update_is_flagged() {
        let mut room = Room::new();
        let first = synced(&room, 11);
        room.deliver(&edited(&first, |txn, blocks| {
            let x = blocks.insert(txn, "x", MapPrelim::default());
            x.insert(txn, "prop:text", TextPrelim::new("hello"));
            x.insert(txn, "prop:long", TextPrelim::new("y".repeat(40)));
            x.insert(txn, "prop:list", ArrayPrelim::default())
                .push_back(txn, 1);
        }));
        let second = synced(&room, 12);
        room.deliver(&edited(&second, |txn, blocks| {
            text(txn, blocks, "x", "prop:text").insert(txn, 5, " world");
        }));
        let mut client = 20;
        let mut check = |edit: &dyn Fn(&mut TransactionMut, &MapRef)| {
            client += 1;
            let update = edited(&synced(&room, client), edit);
            room.board.check(&decode(&update))
        };
        let typing = |at: u32| {
            move |txn: &mut TransactionMut, blocks: &MapRef| {
                text(txn, blocks, "x", "prop:text").insert(txn, at, "!");
            }
        };
        // At the end, inside one client's run, between two clients' runs.
        assert_eq!(check(&typing(11)), Ok(Check::Small));
        assert_eq!(check(&typing(2)), Ok(Check::Small));
        assert_eq!(check(&typing(5)), Ok(Check::Flagged));
        let keys = |n: u32| {
            move |txn: &mut TransactionMut, blocks: &MapRef| {
                let x = block(txn, blocks, "x");
                for key in 0..n {
                    x.insert(txn, format!("k{key}"), "v");
                }
            }
        };
        assert_eq!(check(&keys(16)), Ok(Check::Small));
        assert_eq!(check(&keys(17)), Ok(Check::Flagged));
        let erasing = |n: u32| {
            move |txn: &mut TransactionMut, blocks: &MapRef| {
                let long = text(txn, blocks, "x", "prop:long");
                for at in (0..n).rev() {
                    long.remove_range(txn, 2 * at, 1);
                }
            }
        };
        assert_eq!(check(&erasing(16)), Ok(Check::Small));
        assert_eq!(check(&erasing(17)), Ok(Check::Flagged));
        // A map under a new key names its parent; one pushed after a list
        // element does not.
        assert_eq!(
            check(&|txn, blocks| {
                block(txn, blocks, "x").insert(txn, "inner", MapPrelim::default());
            }),
            Ok(Check::Small)
        );
        assert_eq!(
            check(&|txn, blocks| {
                if let Some(Out::YArray(list)) = block(txn, blocks, "x").get(txn, "prop:list") {
                    list.push_back(txn, MapPrelim::default());
                }
            }),
            Ok(Check::Flagged)
        );
        let (a, b) = (synced(&room, 31), synced(&room, 32));
        let two = bytes::merge(&[edited(&a, typing(11)), edited(&b, typing(0))]).unwrap();
        assert_eq!(room.board.check(&decode(&two)), Ok(Check::Flagged));
        let other = synced(&room, 33);
        let meta = other.doc.get_or_insert_map("meta");
        let mut txn = other.doc.transact_mut();
        meta.insert(&mut txn, "k", "v");
        let written = ydoc::committed_update(txn);
        assert!(room.board.check(&decode(&written)).is_err());
    }

    /// Two tabs write one key at once: yrs deletes the loser where the
    /// second lands, and no update names it. Every replica holds the winner
    /// alone; a reader's step 2 naming the loser is acknowledged while a
    /// writer's appends just that deletion.
    #[test]
    fn a_concurrent_overwrites_loser_stays_deleted() {
        let mut room = Room::new();
        let first = synced(&room, 11);
        room.deliver(&edited(&first, |txn, blocks| {
            blocks
                .insert(txn, "x", MapPrelim::default())
                .insert(txn, "prop:xywh", "v0");
        }));
        let (a, b) = (synced(&room, 12), synced(&room, 13));
        let drag = |to: &'static str| {
            move |txn: &mut TransactionMut, blocks: &MapRef| {
                block(txn, blocks, "x").insert(txn, "prop:xywh", to);
            }
        };
        let (from_a, from_b) = (edited(&a, drag("a")), edited(&b, drag("b")));
        room.deliver(&from_a);
        room.deliver(&from_b);
        let reader = room.join();
        let step2 = room.step2(&reader);
        assert!(room.board.changes(&step2));
        assert!(!room.board.reader_changes(&step2));
        // A hears B, and its next step 2 names the loser.
        apply(&a.doc, &from_b);
        let resent = a
            .doc
            .transact()
            .encode_state_as_update_v1(&room.board.state_vector());
        room.deliver(&resent);
        let resent = decode(&resent);
        let named = decode(room.board.recent.last().unwrap());
        assert_eq!(named.blocks().count(), 0);
        assert!(!named.delete_set().is_empty());
        assert!(!room.board.changes(&resent) && !room.board.changes(&step2));
        let replica = room.board.replica().unwrap();
        for doc in [&room.join(), &reader, &room.peer, &replica] {
            assert!(held(doc) == held(&room.reference));
        }
    }

    /// One tab deletes a block while another types into its text: yrs
    /// deletes the typing where it lands, in either order, and no update
    /// names it. Every replica holds the block deleted; a reader's step 2
    /// naming the typing is acknowledged, and after a fold the base names it.
    #[test]
    fn content_added_to_a_type_deleted_at_once_stays_deleted() {
        for typing_first in [false, true] {
            let mut room = Room::new();
            let first = synced(&room, 11);
            room.deliver(&edited(&first, |txn, blocks| {
                blocks.insert(txn, "x", MapPrelim::default()).insert(
                    txn,
                    "prop:text",
                    TextPrelim::new("hello"),
                );
            }));
            let early = room.join();
            let (a, b) = (synced(&room, 12), synced(&room, 13));
            let deleting = edited(&a, |txn, blocks| {
                blocks.remove(txn, "x");
            });
            let typing = edited(&b, |txn, blocks| {
                text(txn, blocks, "x", "prop:text").insert(txn, 5, "!");
            });
            let mut both = [deleting, typing];
            if typing_first {
                both.reverse();
            }
            for sent in &both {
                room.deliver(sent);
            }
            {
                let txn = room.reference.transact();
                assert!(txn.get_map(BOARD_ROOT).unwrap().get(&txn, "x").is_none());
            }
            let reader = room.join();
            let step2 = room.step2(&reader);
            assert!(room.board.changes(&step2), "typing first: {typing_first}");
            assert!(!room.board.reader_changes(&step2));
            room.catch_up(&early);
            let replica = room.board.replica().unwrap();
            for doc in [&early, &reader, &room.join(), &room.peer, &replica] {
                assert!(
                    held(doc) == held(&room.reference),
                    "typing first: {typing_first}"
                );
            }
            room.store();
            room.fold();
            assert!(!room.board.changes(&step2));
            assert!(held(&room.join()) == held(&room.reference));
        }
    }

    /// A store's row is the recent updates and the marker document's delta
    /// merged, the live marker deleted in it as today; the tail takes the
    /// recent updates alone, so joiners still see the marker live. Once the
    /// room clears it, a writer's step 2 naming that deletion tells nothing
    /// new, and the stored rows hold the board.
    #[test]
    fn a_row_holds_the_recent_updates_with_live_markers_hidden() {
        let mut room = Room::new();
        let markers = room
            .board
            .markers()
            .get_or_insert_map(ydoc::CONTRIBUTORS_ROOT);
        let marked = {
            let mut txn = room.board.markers().transact_mut();
            let value = HashMap::from([
                ("access".to_owned(), Any::from("write")),
                ("nonce".to_owned(), Any::from("n1")),
            ]);
            markers.insert(&mut txn, "writer", Any::from(value));
            ydoc::committed_update(txn)
        };
        apply(&room.reference, &marked);
        // One tab: no concurrent edit leaves a deletion the index lacks.
        for sent in &session(1, 30, 11) {
            room.deliver(sent);
        }
        let row = room.board.row().unwrap();
        let stored = replica(&[first_state(), row.bytes.clone()]);
        let (stored_held, board) = (held(&stored), held(&room.reference));
        assert!(stored_held.2[0] == board.2[0]);
        assert!(stored_held.2[1] == Some(Any::from(HashMap::<String, Any>::new())));
        room.rows.push(row.bytes.clone());
        room.board.stored(row).unwrap();
        assert!(room.board.recent.is_empty() && !room.board.tail.is_empty());
        assert!(held(&room.join()) == held(&room.reference));
        let cleared = {
            let mut txn = room.board.markers().transact_mut();
            markers.remove(&mut txn, "writer");
            ydoc::committed_update(txn)
        };
        apply(&room.reference, &cleared);
        let writer = room.join();
        let step2 = room.step2(&writer);
        assert!(step2.delete_set().get(&ClientID::new(ROOM)).is_some());
        assert!(!room.board.changes(&step2));
        room.store();
        let mut stored = vec![room.stored_base.clone()];
        stored.extend(room.rows.iter().cloned());
        assert!(held(&replica(&stored)) == held(&room.reference));
    }
}
