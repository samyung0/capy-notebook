//! A canvas board held as its saved bytes instead of a live yrs document
//! (Epo 2026-11-24, "Approve all": the bytes-room plan, step 2): the stored
//! base, the rows stored past it (the tail), the writers' updates since the
//! last store (recent) and small indexes, about 1.1x the board's state where a
//! live document holds 12 to 19x. Nothing is integrated: an update is read
//! on its decoded structs against the indexes, trimmed to what is new,
//! appended, merged into a row at each store and answered to joiners by byte
//! diffs. A whole-board read (a diff of the base for a joiner behind it, a
//! replica for a trial) runs under the board work permit (`work.rs`), which
//! the caller holds.
//!
//! The approved rules (with the review's fixes, Epo 2026-11-24):
//! * a read-only channel's update changes the board only by a struct past the
//!   state vector or a deletion past held clocks; one within them is
//!   acknowledged and ignored, since the delete-set index misses implicit
//!   deletions until the next fold ([Board::reader_changes]);
//! * a writer's update past a small edit, read as trimmed to what the room
//!   lacks, is tried on a replica first ([Board::read]);
//! * merges take at most 256 updates a call, then 64 merged ones
//!   ([bytes::merge_chunked]);
//! * a joiner takes the base's part first, as an update, and the step 2 last
//!   ([Board::join]).

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use yrs::block::{ClientID, Item, ItemContent, UpdateParent};
use yrs::branch::BranchID;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Any, Doc, ID, IdSet, Map, Out, ReadTxn, StateVector, Transact, Update, UpdateBlock};

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
    /// A writer's update the room refuses: malformed, or writing a root
    /// other than the blocks root.
    #[error("{0}")]
    Refused(String),
    /// yrs encoded a diff's delete set otherwise than the update's own.
    #[error("a trimmed update does not end with its delete set")]
    Trim,
    /// A row older than the newest one [Board::row] made, which holds its
    /// updates.
    #[error("a store's row is older than the newest one made")]
    StaleRow,
    /// The end of a fold that is not the running one.
    #[error("a fold ended that is not the running one")]
    StaleFold,
}

/// What [Board::read] found of a writer's update.
pub enum Read {
    /// The room cannot place it yet (a gap in a client's clocks, a deletion
    /// past what either side holds, a reference neither holds): dropped, its
    /// writer resyncs (`Admitted::Unheld`). So the room's clocks stay one
    /// state vector.
    Unheld,
    /// Nothing the room lacks: acknowledged, nothing appended.
    Held,
    /// What it holds that the room lacks, for [Board::append].
    New(Fresh),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Check {
    /// A small edit: appended at once.
    Small,
    /// Past a small edit: tried on [Board::replica] under the board work
    /// permit before it is appended.
    Flagged,
}

/// A writer's update trimmed to what the room lacks ([Board::read]): its
/// structs past the room's state vector (one straddling it sliced there, as
/// yrs's diff slices it) and the deletions the index lacks.
pub struct Fresh {
    pub check: Check,
    bytes: Vec<u8>,
    /// Each writing client's clock past the trimmed structs.
    ends: StateVector,
    /// The deletions the index lacks.
    deleted: IdSet,
    taken: Taken,
}

impl Fresh {
    /// What is appended and relayed, and what a flagged update's trial
    /// applies to [Board::replica].
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// A joiner's answer ([Board::join]), sized by its bytes.
pub struct Join<'a> {
    /// Sent first, each as an update, in order: the base's part (the base as
    /// it is for a joiner holding none of it, its diff for one behind it,
    /// none for one holding it), the rows' diffs, the recent updates, the
    /// marker document's state. In this order nothing waits on a dependency:
    /// a 4,000-edit board joined in 25 ms, against 88 ms with the base last.
    pub updates: Vec<Cow<'a, [u8]>>,
    /// Sent last, as the step 2, so a synced joiner holds the whole board:
    /// the delete-set index for a joiner holding the base (deletions a fold
    /// took into it move no clock), else an empty update.
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
    /// Which row [Board::row] made it as: only the newest commits.
    made: u64,
}

/// A running fold ([Board::begin_fold]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fold(u64);

/// A base's indexes, which a load takes instead of decoding the base (T5
/// stores them with it): its state vector, its whole delete set and its
/// items' [Origins]. A load takes the rows stored past the base into them
/// too, their origins and keys included: the base's alone would pass an
/// update the rows make unsafe.
#[derive(Clone, Debug, Default)]
pub struct Indexes {
    pub sv: StateVector,
    pub deleted: IdSet,
    pub origins: Origins,
}

impl Indexes {
    /// A fold's indexes, read from the document it encodes the base from:
    /// each sequence's first item as the document holds it.
    pub fn of_doc<T: ReadTxn>(txn: &T) -> Indexes {
        let snapshot = txn.snapshot();
        let store = txn.store();
        let (mut origins, mut taken) = (Origins::default(), Taken::default());
        for (client, end) in snapshot.state_map.iter() {
            for (_, item) in store.blocks_in(client, 0..*end) {
                let Some(item) = item else {
                    continue;
                };
                taken.add(&item);
                // Every key or sequence holding items holds one with no
                // origin: its first. A collected one's parent is deleted,
                // where an insert costs nothing.
                if item.origin().is_some() {
                    continue;
                }
                let Some(parent) = item.parent_branch() else {
                    continue;
                };
                let place = match parent.id() {
                    BranchID::Nested(id) => place(Parent::Nested(id), item.parent_sub()),
                    BranchID::Root(name) => place(Parent::Root(&name), item.parent_sub()),
                };
                origins.keys.insert(place);
                if item.parent_sub().is_none() {
                    origins.heads.insert(*item.id(), place);
                    if item.left().is_none() {
                        origins.firsts.insert(place, *item.id());
                    }
                }
            }
        }
        origins.take(taken);
        Indexes {
            sv: snapshot.state_map,
            deleted: snapshot.delete_set,
            origins,
        }
    }
}

/// What the one-held-side rule reads of the held items ([Board::placed]).
/// T5 stores them with the base's other indexes; the room's take each
/// appended update's items.
#[derive(Clone, Debug, Default)]
pub struct Origins {
    /// Units a held item names as its origin, except an item's own client's
    /// previous unit: something was placed right after them. Compressed per
    /// run, as the delete-set index is.
    pub named: IdSet,
    /// Units whose client's next unit names them as its origin: a run goes
    /// on past them.
    pub continued: IdSet,
    /// The places ([place]) holding at least one item: every map key set,
    /// every sequence written. One hash each (8 bytes, about 10 to 20 in the
    /// set).
    pub keys: HashSet<u64>,
    /// Each held sequence item with no origin, by its first unit, and its
    /// sequence's place.
    pub heads: HashMap<ID, u64>,
    /// Each sequence's first item while the room knows it. An item with no
    /// origin appended to the sequence without naming its first (two tabs
    /// typing at its start at once, or crafted) may land before it, and the
    /// sequence has none until a load takes a later fold's indexes.
    pub firsts: HashMap<u64, ID>,
}

impl Origins {
    fn take(&mut self, taken: Taken) {
        let Taken {
            named,
            continued,
            unanchored,
        } = taken;
        self.named.merge_with(units(named));
        self.continued.merge_with(continued);
        for (id, anchor) in unanchored {
            let (place, first) = match anchor {
                Anchor::At { place, sequence } => {
                    let empty = self.keys.insert(place);
                    if !sequence {
                        continue;
                    }
                    (place, empty)
                }
                Anchor::Before(right) => match self.heads.get(&right) {
                    Some(&place) => (place, self.firsts.get(&place) == Some(&right)),
                    // No sequence the room knows (a map key's value, an item
                    // with an origin): never from an editor.
                    None => {
                        self.firsts.clear();
                        continue;
                    }
                },
                Anchor::Unknown => {
                    self.firsts.clear();
                    continue;
                }
            };
            self.heads.insert(id, place);
            if first {
                self.firsts.insert(place, id);
            } else {
                self.firsts.remove(&place);
            }
        }
    }
}

/// What items add to [Origins]: a fold's base, an appended update.
#[derive(Default)]
struct Taken {
    named: Vec<ID>,
    continued: IdSet,
    /// An appended update's items with no origin, in its order, and where
    /// each was put.
    unanchored: Vec<(ID, Anchor)>,
}

/// Where an item with no origin was put.
enum Anchor {
    /// With no right origin: the key or sequence its parent names.
    At { place: u64, sequence: bool },
    /// Before its right origin.
    Before(ID),
    /// Nowhere it names (never from yrs's decoder).
    Unknown,
}

impl Taken {
    fn add(&mut self, item: &Item) {
        let id = *item.id();
        let previous = id
            .clock
            .checked_sub(1)
            .map(|clock| ID::new(id.client, clock));
        match item.origin() {
            Some(origin) if Some(*origin) == previous => {
                self.continued.insert(*origin, item.len());
                return;
            }
            Some(origin) => self.named.push(*origin),
            None => {}
        }
        if item.len() > 1 {
            self.continued.insert(id, item.len() - 1);
        }
    }
}

/// Single units as a set, inserted in order.
fn units(mut ids: Vec<ID>) -> IdSet {
    ids.sort_unstable_by_key(|id| (id.client, id.clock));
    let mut set = IdSet::default();
    for id in ids {
        set.insert(id, 1);
    }
    set
}

/// A parent type: a nested type's item, or a root by name.
enum Parent<'a> {
    Nested(ID),
    Root(&'a str),
}

/// A map key, or a sequence (no key), of a parent type, as 64 bits of
/// SHA-256 over both, each part tagged and the root's name length-prefixed:
/// stable across processes and releases, since T5 stores it. Two places
/// sharing a hash only flag an update ([Board::placed] takes a held hash as
/// a place holding items), never pass one.
fn place(parent: Parent, key: Option<&Arc<str>>) -> u64 {
    let mut hash = Sha256::new();
    match parent {
        Parent::Nested(id) => {
            hash.update([0]);
            hash.update(id.client.get().to_le_bytes());
            hash.update(id.clock.to_le_bytes());
        }
        Parent::Root(name) => {
            hash.update([1]);
            hash.update((name.len() as u64).to_le_bytes());
            hash.update(name.as_bytes());
        }
    }
    if let Some(key) = key {
        hash.update([1]);
        hash.update(key.as_bytes());
    } else {
        hash.update([0]);
    }
    let mut first = [0; 8];
    first.copy_from_slice(&hash.finalize()[..8]);
    u64::from_le_bytes(first)
}

/// The place an update's item names with its parent, if it names one.
fn named_place(item: &Item) -> Option<u64> {
    let parent = match item.update_parent() {
        UpdateParent::Item(id) => Parent::Nested(*id),
        UpdateParent::Root(name) => Parent::Root(name),
        _ => return None,
    };
    Some(place(parent, item.parent_sub()))
}

/// An update's items by client, in clock order.
struct Items<'a>(HashMap<ClientID, Vec<&'a Item>>);

impl<'a> Items<'a> {
    fn of(update: &'a Update) -> Items<'a> {
        let mut items: HashMap<ClientID, Vec<&'a Item>> = HashMap::new();
        for block in update.blocks() {
            if let UpdateBlock::Item(item) = block {
                items.entry(item.id().client).or_default().push(item);
            }
        }
        Items(items)
    }

    /// The item holding `id`.
    fn at(&self, id: &ID) -> Option<&'a Item> {
        let items = self.0.get(&id.client)?;
        let at = items.partition_point(|item| item.id().clock + item.len() <= id.clock);
        items
            .get(at)
            .copied()
            .filter(|item| item.id().clock <= id.clock)
    }
}

pub struct Board {
    /// The stored base: the last fold's compacted state, or the first state.
    base: Vec<u8>,
    /// The base's state vector: a joiner at or past it holds every struct of
    /// the base.
    base_sv: StateVector,
    /// While a fold runs: which, and the rows stored before it began (the
    /// ones it covers), merged.
    folding: Option<(Fold, Vec<u8>)>,
    /// How many folds began.
    folds: u64,
    /// The rows stored past the base, or past a running fold's start, merged.
    tail: Vec<u8>,
    /// The writers' updates since the last committed store, trimmed.
    recent: Vec<Vec<u8>>,
    /// How many rows [Board::row] made.
    rows_made: u64,
    /// What base, rows and recent updates hold: a plain state vector, since
    /// unheld updates are dropped.
    sv: StateVector,
    /// Every deletion the room holds by name: the base's whole delete set and
    /// each appended update's new deletions. It lacks implicit deletions (a
    /// concurrent overwrite's loser, content added to a type deleted at the
    /// same time) until a fold's base names them.
    deleted: IdSet,
    /// The base's and every appended item's origins and places.
    origins: Origins,
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
    pub fn new(base: Vec<u8>, indexes: Indexes, room_client: ClientID) -> Board {
        let Indexes {
            sv,
            deleted,
            origins,
        } = indexes;
        Board {
            base,
            base_sv: sv.clone(),
            sv,
            folding: None,
            folds: 0,
            tail: Vec::new(),
            recent: Vec::new(),
            rows_made: 0,
            deleted,
            origins,
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

    /// A writer's update (`sent` as it came, decoded) read against the room:
    /// refused when malformed or writing a root other than the blocks root,
    /// else unheld, held, or what it holds that the room lacks. That is
    /// trimmed first (its diff against the state vector, the delete set cut
    /// to the deletions the index lacks) and checked as trimmed, as peers
    /// apply it. A small edit is at most [ydoc::SMALL_EDIT] new structs and
    /// as many fresh delete ranges, covering at most [ydoc::MAX_WORK] units
    /// (the bound `few_new_deletions` puts on the blocks its ranges cover),
    /// of one writing client, with no new type whose parent is implicit (it
    /// has no depth) and every new item placed by [Board::placed].
    pub fn read(&self, sent: &[u8], update: &Update) -> Result<Read, BoardError> {
        refuse_malformed(update)?;
        let state = self.state_vector();
        if unheld(&state, update) {
            return Ok(Read::Unheld);
        }
        let deleted = self.fresh_deletions(update);
        if !writes(&state, update) && deleted.is_empty() {
            return Ok(Read::Held);
        }
        let diffed = bytes::diff(sent, &state)?;
        let named = update.delete_set().encode_v1();
        let structs = diffed
            .strip_suffix(named.as_slice())
            .ok_or(BoardError::Trim)?;
        let mut kept = structs.to_vec();
        kept.extend_from_slice(&deleted.encode_v1());
        let trimmed = Update::decode_v1(&kept)?;
        let items = Items::of(&trimmed);
        let held = |id: &ID| id.clock < state.get(&id.client);
        let (mut ends, mut taken) = (StateVector::default(), Taken::default());
        let (mut count, mut writer, mut flagged) = (0, None, false);
        for block in trimmed.blocks() {
            let (client, end) = ydoc::struct_end(&block);
            ends.set_max(client, end);
            count += 1;
            flagged |= writer.is_some_and(|writer| writer != client);
            writer = Some(client);
            let UpdateBlock::Item(item) = block else {
                continue;
            };
            match item.update_parent() {
                UpdateParent::Root(name) if &**name != BOARD_ROOT => {
                    return Err(BoardError::Refused(
                        "a board update writes only the blocks root".into(),
                    ));
                }
                UpdateParent::Unknown => {
                    flagged |= matches!(item.content(), ItemContent::Type(_));
                }
                _ => {}
            }
            flagged |= !self.placed(item, &held, &items);
            taken.add(item);
            if item.origin().is_none() {
                let anchor = match (item.right_origin(), named_place(item)) {
                    (Some(right), _) => Anchor::Before(*right),
                    (None, Some(place)) => Anchor::At {
                        place,
                        sequence: item.parent_sub().is_none(),
                    },
                    (None, None) => Anchor::Unknown,
                };
                taken.unanchored.push((*item.id(), anchor));
            }
        }
        // T5: the depth index refuses a type past 64 levels here, and the
        // earlier lives' marker clients any struct or deletion naming one.
        let (mut ranges, mut covered) = (0, 0u64);
        for (_, of) in deleted.iter() {
            ranges += of.len();
            covered += of
                .iter()
                .map(|range| u64::from(range.end - range.start))
                .sum::<u64>();
        }
        // T5: a fresh range that covers a type is flagged (the type index).
        flagged |=
            count > ydoc::SMALL_EDIT || ranges > ydoc::SMALL_EDIT || covered > ydoc::MAX_WORK;
        Ok(Read::New(Fresh {
            check: if flagged {
                Check::Flagged
            } else {
                Check::Small
            },
            bytes: kept,
            ends,
            deleted,
            taken,
        }))
    }

    /// Appends what [Board::read] found new, before anything else changes
    /// the board (the room's queue waits with a flagged update's trial).
    /// Implicit deletions need nothing: every replica derives them from the
    /// structs it receives. What peers hear.
    pub fn append(&mut self, fresh: Fresh) -> &[u8] {
        let Fresh {
            bytes,
            ends,
            deleted,
            taken,
            ..
        } = fresh;
        self.sv.merge(ends);
        self.deleted.merge_with(deleted);
        self.origins.take(taken);
        let at = self.recent.len();
        self.recent.push(bytes);
        &self.recent[at]
    }

    /// The next store's row: the recent updates merged in chunks, with the
    /// marker document's delta (its live markers deleted in it, as today).
    /// The recent updates stay until the row commits. Only the newest row
    /// commits: an older one's updates are all in it.
    pub fn row(&mut self) -> Result<Row, BoardError> {
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
        self.rows_made += 1;
        Ok(Row {
            bytes,
            writers,
            count: self.recent.len(),
            markers: cover,
            made: self.rows_made,
        })
    }

    /// `row` committed: its recent updates join the tail. The tail takes
    /// them without the marker delta, whose deletions of live markers would
    /// reach joiners before the room clears them. A row older than the
    /// newest made is refused.
    pub fn stored(&mut self, row: Row) -> Result<(), BoardError> {
        if row.made != self.rows_made {
            return Err(BoardError::StaleRow);
        }
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
    /// stay in the tail past it. None while one runs. T7 calls this before
    /// the fold reads its rows, which must hold at least these (a row the
    /// fold reads twice, also in the tail, costs bytes; one it misses is
    /// lost at the swap).
    pub fn begin_fold(&mut self) -> Option<Fold> {
        if self.folding.is_some() {
            return None;
        }
        self.folds += 1;
        let fold = Fold(self.folds);
        self.folding = Some((fold, std::mem::take(&mut self.tail)));
        Some(fold)
    }

    /// The running fold's new base and its indexes replace the base and the
    /// rows it covered. The index keeps what it held and takes the implicit
    /// deletions the new base names; the origins hold the base's items
    /// already. A live marker the new base deletes (one a committed row hid
    /// and the room has not cleared since) is written again as a new item,
    /// since a joiner holding the deleted struct would skip the marker
    /// document's copy: that update, to relay.
    pub fn folded(
        &mut self,
        fold: Fold,
        base: Vec<u8>,
        indexes: Indexes,
    ) -> Result<Option<Vec<u8>>, BoardError> {
        if !self.running(fold) {
            return Err(BoardError::StaleFold);
        }
        let rewritten = self.rewrite_markers(&indexes.deleted);
        self.base = base;
        self.folding = None;
        self.sv.merge(indexes.sv.clone());
        self.base_sv = indexes.sv;
        self.deleted.merge_with(indexes.deleted);
        Ok(rewritten)
    }

    /// The running fold failed: the rows it covered go back to the tail.
    pub fn fold_failed(&mut self, fold: Fold) -> Result<(), BoardError> {
        if !self.running(fold) {
            return Err(BoardError::StaleFold);
        }
        let Some((fold, folding)) = self.folding.take() else {
            return Ok(());
        };
        if self.tail.is_empty() {
            self.tail = folding;
        } else if !folding.is_empty() {
            match bytes::merge(&[folding.as_slice(), self.tail.as_slice()]) {
                Ok(merged) => self.tail = merged,
                Err(error) => {
                    self.folding = Some((fold, folding));
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

    /// The answer to a joiner at `since` ([Join]): the base's part first,
    /// then the rows' diffs (as they are for a fresh joiner), the recent
    /// updates (a joiner skips what it holds) and the marker state, and the
    /// step 2 last.
    pub fn join(&self, since: &StateVector) -> Result<Join<'_>, BoardError> {
        let mut updates = Vec::new();
        let step2 = if self.holds_base(since) {
            let mut deletions = vec![0];
            deletions.extend(self.deleted.encode_v1());
            Cow::Owned(deletions)
        } else {
            updates.push(if self.holds_none_of_base(since) {
                Cow::Borrowed(self.base.as_slice())
            } else {
                Cow::Owned(bytes::diff(&self.base, since)?)
            });
            Cow::Borrowed(EMPTY_UPDATE)
        };
        for rows in self
            .folding
            .iter()
            .map(|(_, rows)| rows)
            .chain([&self.tail])
        {
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
            .map(|(_, rows)| rows)
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

    fn running(&self, fold: Fold) -> bool {
        self.folding
            .as_ref()
            .is_some_and(|(running, _)| *running == fold)
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

    /// The one-held-side rule (the review of 2026-11-24): whether a new
    /// item's conflict scan meets at most its own update's items and one
    /// held item, read from the [Origins] alone. Placed:
    /// * after a held unit nothing else was placed after (where that unit's
    ///   run goes on, just before the run's next unit);
    /// * after an item of its own update, before none, another of its update,
    ///   or what that earlier item was placed before (or inside the earlier
    ///   item), as `few_placed_structs` takes it: formatted text typed or
    ///   pasted inside a text;
    /// * with no origin, before the first item of a sequence;
    /// * with no origin and no right origin, at a key or into a sequence
    ///   holding nothing (a new block, element or property, typing into an
    ///   empty text, anything under a parent its update creates).
    ///
    /// Anything else naming held content is not: a set of a key holding
    /// values among them, which the scan would walk.
    fn placed(&self, item: &Item, held: &impl Fn(&ID) -> bool, items: &Items) -> bool {
        let origins = &self.origins;
        match (item.origin(), item.right_origin()) {
            (Some(origin), right) if held(origin) => {
                !origins.named.contains(origin)
                    && (!origins.continued.contains(origin)
                        || right == Some(&ID::new(origin.client, origin.clock + 1)))
            }
            (Some(origin), right) => {
                right.is_none_or(|right| !held(right))
                    || items.at(origin).is_some_and(|earlier| {
                        let last = earlier.id().clock + earlier.len() - 1;
                        (origin.clock == last && right == earlier.right_origin())
                            || right.is_some_and(|right| {
                                right.client == origin.client
                                    && right.clock == origin.clock + 1
                                    && right.clock <= last
                            })
                    })
            }
            (None, Some(right)) if held(right) => origins
                .heads
                .get(right)
                .is_some_and(|place| origins.firsts.get(place) == Some(right)),
            // Its parent is implicit and its scan starts at the sequence's
            // first item.
            (None, Some(_)) => false,
            (None, None) => named_place(item).is_some_and(|place| !origins.keys.contains(&place)),
        }
    }

    /// Writes again, as new items, the live markers `deleted` names. The
    /// update to relay, if any.
    fn rewrite_markers(&self, deleted: &IdSet) -> Option<Vec<u8>> {
        let (map, hidden) = {
            let txn = self.markers.transact();
            let map = txn.get_map(ydoc::CONTRIBUTORS_ROOT)?;
            let branch: &yrs::branch::Branch = map.as_ref();
            // The room writes every marker as a map of `Any`.
            let hidden: Vec<(String, Any)> = branch
                .map_items()
                .filter(|(_, item)| !item.is_deleted() && deleted.contains(item.id()))
                .filter_map(|(key, _)| match map.get(&txn, key) {
                    Some(Out::Any(value)) => Some((key.to_string(), value)),
                    _ => None,
                })
                .collect();
            (map, hidden)
        };
        if hidden.is_empty() {
            return None;
        }
        let mut txn = self.markers.transact_mut();
        for (key, value) in hidden {
            map.insert(&mut txn, key, value);
        }
        Some(ydoc::committed_update(txn))
    }
}

/// Refuses what no editor sends and the indexes cannot read: a struct or a
/// deleted range past [ydoc::MAX_CLOCK], a client's delete ranges out of
/// clock order or overlapping, an item naming itself or a later unit of its
/// client. yrs's decoder refuses a client's structs that overlap.
fn refuse_malformed(update: &Update) -> Result<(), BoardError> {
    ydoc::within_clocks(update).map_err(|error| BoardError::Refused(error.to_string()))?;
    for (client, ranges) in update.delete_set().iter() {
        let mut end = 0;
        for range in ranges.iter() {
            if range.start < end {
                return Err(BoardError::Refused(format!(
                    "the deletions of client {client} overlap or go back in clock order"
                )));
            }
            end = range.end;
        }
    }
    for block in update.blocks() {
        if let UpdateBlock::Item(item) = block {
            let ID { client, clock } = *item.id();
            if references(item).any(|id| id.client == client && id.clock >= clock) {
                return Err(BoardError::Refused(format!(
                    "struct {clock} of client {client} refers to itself or a later struct of its client"
                )));
            }
        }
    }
    Ok(())
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
    use yrs::types::{Attrs, ToJson};
    use yrs::updates::decoder::Decode;
    use yrs::updates::encoder::Encode;
    use yrs::{
        Any, Array, ArrayPrelim, Doc, ID, IdSet, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector,
        Text, TextPrelim, TextRef, Transact, TransactionMut, Update, UpdateBlock,
    };

    use super::{Board, BoardError, Check, EMPTY_UPDATE, Fold, Indexes, Read, bytes};
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

    /// `updates` as a fold stores them: compacted, with their indexes.
    fn compacted<B: AsRef<[u8]>>(updates: &[B]) -> (Vec<u8>, Indexes) {
        let doc = replica(updates);
        let txn = doc.transact();
        let state = txn.encode_state_as_update_v1(&StateVector::default());
        (state, Indexes::of_doc(&txn))
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

    /// A writer's update as the room reads it.
    fn read(board: &Board, sent: &[u8]) -> Read {
        board.read(sent, &decode(sent)).unwrap()
    }

    /// Whether a writer's update holds anything the room lacks.
    fn changes(board: &Board, sent: &[u8]) -> bool {
        !matches!(read(board, sent), Read::Held)
    }

    /// The check of a writer's update the room can place.
    fn checked(board: &Board, sent: &[u8]) -> Check {
        match read(board, sent) {
            Read::New(fresh) => fresh.check,
            Read::Unheld => panic!("unheld"),
            Read::Held => panic!("held"),
        }
    }

    /// Why the room refuses a writer's update.
    fn refusal(board: &Board, sent: &[u8]) -> String {
        match board.read(sent, &decode(sent)) {
            Err(BoardError::Refused(why)) => why,
            Err(other) => panic!("{other}"),
            Ok(_) => panic!("read"),
        }
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
            let (base, indexes) = compacted(&[&first]);
            Room {
                board: Board::new(base.clone(), indexes, ClientID::new(ROOM)),
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
            match read(&self.board, sent) {
                Read::Unheld => None,
                Read::Held => Some(false),
                Read::New(fresh) => {
                    apply(&self.peer, self.board.append(fresh));
                    Some(true)
                }
            }
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

        /// An update the room writes (a marker's), relayed to everyone.
        fn relay(&self, update: &[u8]) {
            apply(&self.reference, update);
            apply(&self.peer, update);
        }

        fn store(&mut self) {
            let row = self.board.row().unwrap();
            self.rows.push(row.bytes.clone());
            self.board.stored(row).unwrap();
        }

        /// A fold begins over the rows committed so far: which, and how many
        /// rows it covers.
        fn begin_fold(&mut self) -> (Fold, usize) {
            (self.board.begin_fold().unwrap(), self.rows.len())
        }

        /// The fold of the stored base and its first `through` rows ends, as
        /// `note_store::fold` stores it; what the room rewrote is relayed.
        fn end_fold(&mut self, fold: Fold, through: usize) -> Option<Vec<u8>> {
            let mut parts = vec![self.stored_base.clone()];
            parts.extend(self.rows.drain(..through));
            let (base, indexes) = compacted(&parts);
            self.stored_base = base.clone();
            let rewritten = self.board.folded(fold, base, indexes).unwrap();
            if let Some(update) = &rewritten {
                self.relay(update);
            }
            rewritten
        }

        fn fold(&mut self) -> Option<Vec<u8>> {
            let (fold, through) = self.begin_fold();
            self.end_fold(fold, through)
        }

        /// A joiner holding nothing, synced by the room's answer.
        fn join(&self) -> Doc {
            let doc = ydoc::scratch_doc();
            self.catch_up(&doc);
            doc
        }

        /// `doc` rejoins: the room's answer to its state vector, in order,
        /// none of it waiting on a dependency, the step 2 last.
        fn catch_up(&self, doc: &Doc) {
            let since = doc.transact().state_vector();
            let answer = self.board.join(&since).unwrap();
            assert!(answer.size() > 0);
            for update in answer.updates.iter().chain([&answer.step2]) {
                apply(doc, update);
                assert!(!pending(doc), "a part of the answer waits");
            }
        }

        /// A writer's step 2 from `doc`: all it holds past the room's state
        /// vector, its whole delete set included.
        fn step2(&self, doc: &Doc) -> Vec<u8> {
            doc.transact()
                .encode_state_as_update_v1(&self.board.state_vector())
        }

        /// The room writes the marker of `key`.
        fn mark(&self, key: &str) -> Vec<u8> {
            let markers = self
                .board
                .markers()
                .get_or_insert_map(ydoc::CONTRIBUTORS_ROOT);
            let mut txn = self.board.markers().transact_mut();
            let value = HashMap::from([
                ("access".to_owned(), Any::from("write")),
                ("nonce".to_owned(), Any::from(format!("{key}-n1"))),
            ]);
            markers.insert(&mut txn, key, Any::from(value));
            let marked = ydoc::committed_update(txn);
            self.relay(&marked);
            marked
        }

        /// The room clears the marker of `key`.
        fn clear(&self, key: &str) {
            let markers = self
                .board
                .markers()
                .get_or_insert_map(ydoc::CONTRIBUTORS_ROOT);
            let mut txn = self.board.markers().transact_mut();
            markers.remove(&mut txn, key);
            let cleared = ydoc::committed_update(txn);
            self.relay(&cleared);
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

    fn list<T: ReadTxn>(txn: &T, blocks: &MapRef, id: &str) -> yrs::ArrayRef {
        match block(txn, blocks, id).get(txn, "prop:list") {
            Some(Out::YArray(list)) => list,
            other => panic!("{id} list: {other:?}"),
        }
    }

    /// Typing "!" at `at` in block x's text.
    fn typing(at: u32) -> impl Fn(&mut TransactionMut, &MapRef) {
        move |txn, blocks| {
            text(txn, blocks, "x", "prop:text").insert(txn, at, "!");
        }
    }

    /// Block x dragged to `to`.
    fn drag(to: &'static str) -> impl Fn(&mut TransactionMut, &MapRef) {
        move |txn, blocks| {
            block(txn, blocks, "x").insert(txn, "prop:xywh", to);
        }
    }

    /// One edit as the editor makes one: a block added, dragged or deleted,
    /// text typed or erased, an element added, a list item inserted or
    /// removed. Empty when nothing changed.
    fn edit(tab: &Tab, rng: &mut Rng, n: usize) -> Vec<u8> {
        let client = tab.doc.client_id();
        edited(tab, |txn, blocks| {
            let mut ids: Vec<String> = blocks
                .keys(txn)
                .filter(|id| id.starts_with('b'))
                .map(str::to_owned)
                .collect();
            ids.sort();
            let kind = if ids.is_empty() { 0 } else { rng.below(12) };
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
                (Some(id), 10) => {
                    let list = list(txn, blocks, &id);
                    let at = rng.below(list.len(txn) as usize + 1) as u32;
                    list.insert(txn, at, format!("i{n}"));
                }
                (Some(id), 11) => {
                    let list = list(txn, blocks, &id);
                    let len = list.len(txn) as usize;
                    if len > 0 {
                        list.remove(txn, rng.below(len) as u32);
                    }
                }
                _ => {
                    let block = blocks.insert(txn, format!("b{client}-{n}"), MapPrelim::default());
                    block.insert(txn, "sys:flavour", "affine:note");
                    block.insert(txn, "prop:text", TextPrelim::new("note"));
                    block.insert(txn, "prop:elements", MapPrelim::default());
                    block
                        .insert(txn, "prop:list", ArrayPrelim::default())
                        .push_back(txn, "i");
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

    /// A fresh joiner takes the base first, then the rows and recent
    /// updates, none of them waiting on a dependency (`catch_up` checks
    /// after each), and an empty step 2 last.
    #[test]
    fn a_joiner_takes_the_base_first_and_the_step2_last() {
        let updates = session(3, 120, 21);
        let mut room = Room::new();
        for (at, sent) in updates.iter().enumerate() {
            room.deliver(sent);
            if at == 60 {
                room.store();
                room.fold();
            }
            if at % 25 == 13 {
                room.store();
            }
        }
        let answer = room.board.join(&StateVector::default()).unwrap();
        assert!(*answer.updates[0] == *room.board.base);
        assert!(answer.updates.len() > 2 && *answer.step2 == *EMPTY_UPDATE);
        assert!(held(&room.join()) == held(&room.reference));
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

    /// A struct that starts below the held clock and ends past it (a tab
    /// typed on after the room took the start of its run) is read from the
    /// held clock, after the unit before it: a small edit, appended and
    /// relayed from there.
    #[test]
    fn a_struct_straddling_the_held_clock_is_read_from_it() {
        let mut room = Room::new();
        let writer = synced(&room, 50);
        room.deliver(&edited(&writer, |txn, blocks| {
            blocks.insert(txn, "x", MapPrelim::default()).insert(
                txn,
                "prop:text",
                TextPrelim::new("hello"),
            );
        }));
        edited(&writer, typing(5));
        let sent = writer
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let client = ClientID::new(50);
        let at = room.board.state_vector().get(&client);
        assert!(decode(&sent).blocks().any(|block| {
            let (of, clock, len) = super::span(&block);
            of == client && clock < at && clock + len > at
        }));
        apply(&room.reference, &sent);
        let Read::New(fresh) = read(&room.board, &sent) else {
            panic!("nothing new");
        };
        assert_eq!(fresh.check, Check::Small);
        let relayed = room.board.append(fresh).to_vec();
        apply(&room.peer, &relayed);
        let relayed = decode(&relayed);
        let Some(UpdateBlock::Item(item)) = relayed.blocks().next() else {
            panic!("no item");
        };
        assert!(*item.id() == ID::new(client, at));
        assert!(item.origin() == Some(&ID::new(client, at - 1)));
        for doc in [&room.join(), &room.peer] {
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
        let (fold, through) = room.begin_fold();
        for sent in &updates[60..100] {
            room.deliver(sent);
        }
        room.store();
        let early = room.join();
        room.end_fold(fold, through);
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
        let (fold, _) = room.begin_fold();
        for sent in &updates[130..] {
            room.deliver(sent);
        }
        room.store();
        room.board.fold_failed(fold).unwrap();
        assert!(room.board.folding.is_none());
        let replica = room.board.replica().unwrap();
        for doc in [&room.join(), &replica] {
            assert!(held(doc) == held(&room.reference));
        }
    }

    /// Only the newest row commits (an older one's updates are all in it),
    /// and only the running fold ends: a late result of a fold that failed
    /// does not take the running fold's rows with it.
    #[test]
    fn only_the_newest_row_commits_and_only_the_running_fold_ends() {
        let updates = session(2, 90, 17);
        let mut room = Room::new();
        for sent in &updates[..30] {
            room.deliver(sent);
        }
        let older = room.board.row().unwrap();
        for sent in &updates[30..60] {
            room.deliver(sent);
        }
        room.store();
        assert!(matches!(
            room.board.stored(older),
            Err(BoardError::StaleRow)
        ));
        assert!(room.board.recent.is_empty());
        let (failed, _) = room.begin_fold();
        assert!(room.board.begin_fold().is_none());
        room.board.fold_failed(failed).unwrap();
        for sent in &updates[60..] {
            room.deliver(sent);
        }
        room.store();
        let (running, through) = room.begin_fold();
        let (late, indexes) = compacted(&[&room.stored_base]);
        assert!(matches!(
            room.board.folded(failed, late, indexes),
            Err(BoardError::StaleFold)
        ));
        assert!(matches!(
            room.board.fold_failed(failed),
            Err(BoardError::StaleFold)
        ));
        room.end_fold(running, through);
        let replica = room.board.replica().unwrap();
        for doc in [&room.join(), &replica] {
            assert!(held(doc) == held(&room.reference));
        }
    }

    /// The approved flag rule's counts: more than 16 new structs or delete
    /// ranges, or two writing clients, are tried first, as is a new type
    /// whose parent is implicit (it has no depth). Another root is refused.
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
            for key in 0..17 {
                x.insert(txn, format!("k{key}"), "v");
            }
        }));
        let mut client = 20;
        let mut check = |edit: &dyn Fn(&mut TransactionMut, &MapRef)| {
            client += 1;
            checked(&room.board, &edited(&synced(&room, client), edit))
        };
        let keys = |n: u32| {
            move |txn: &mut TransactionMut, blocks: &MapRef| {
                let x = block(txn, blocks, "x");
                for key in 0..n {
                    x.insert(txn, format!("k{key}"), "w");
                }
            }
        };
        assert_eq!(check(&keys(16)), Check::Small);
        assert_eq!(check(&keys(17)), Check::Flagged);
        let erasing = |n: u32| {
            move |txn: &mut TransactionMut, blocks: &MapRef| {
                let long = text(txn, blocks, "x", "prop:long");
                for at in (0..n).rev() {
                    long.remove_range(txn, 2 * at, 1);
                }
            }
        };
        assert_eq!(check(&erasing(16)), Check::Small);
        assert_eq!(check(&erasing(17)), Check::Flagged);
        // After a held list item: a value is placed, a map has no depth.
        assert_eq!(
            check(&|txn, blocks| {
                list(txn, blocks, "x").push_back(txn, 2);
            }),
            Check::Small
        );
        assert_eq!(
            check(&|txn, blocks| {
                list(txn, blocks, "x").push_back(txn, MapPrelim::default());
            }),
            Check::Flagged
        );
        let (a, b) = (synced(&room, 31), synced(&room, 32));
        let two = bytes::merge(&[edited(&a, typing(5)), edited(&b, typing(0))]).unwrap();
        assert_eq!(checked(&room.board, &two), Check::Flagged);
        let other = synced(&room, 33);
        let meta = other.doc.get_or_insert_map("meta");
        let mut txn = other.doc.transact_mut();
        meta.insert(&mut txn, "k", "v");
        let written = ydoc::committed_update(txn);
        assert!(refusal(&room.board, &written).contains("blocks root"));
    }

    /// Fresh deletions count by the units they cover: one range past
    /// [ydoc::MAX_WORK] units is tried first.
    #[test]
    fn fresh_deletions_count_by_the_units_they_cover() {
        let mut room = Room::new();
        let max = usize::try_from(ydoc::MAX_WORK).unwrap();
        let first = synced(&room, 11);
        room.deliver(&edited(&first, |txn, blocks| {
            blocks.insert(txn, "x", MapPrelim::default()).insert(
                txn,
                "prop:long",
                TextPrelim::new("y".repeat(max + 1)),
            );
        }));
        let eraser = synced(&room, 12);
        let erasing = |len: usize| {
            edited(&eraser, |txn, blocks| {
                text(txn, blocks, "x", "prop:long").remove_range(txn, 0, len as u32);
            })
        };
        let (most, more) = (erasing(max), erasing(1));
        assert_eq!(checked(&room.board, &most), Check::Small);
        let all = bytes::merge(&[most, more]).unwrap();
        let ranges: usize = decode(&all)
            .delete_set()
            .iter()
            .map(|(_, ranges)| ranges.len())
            .sum();
        assert_eq!(ranges, 1);
        assert_eq!(checked(&room.board, &all), Check::Flagged);
    }

    /// The one-held-side rule places these: typing at the end of a text,
    /// inside a run and at its start, dragging a block from the value it
    /// holds, bold text typed inside a text, typing into an empty text, and
    /// a new block, a new element and a property set for the first time,
    /// each at a key holding nothing.
    #[test]
    fn an_insert_its_scan_passes_quickly_is_placed() {
        let mut room = Room::new();
        let first = synced(&room, 11);
        room.deliver(&edited(&first, |txn, blocks| {
            let x = blocks.insert(txn, "x", MapPrelim::default());
            x.insert(txn, "prop:text", TextPrelim::new("hello"));
            x.insert(txn, "prop:empty", TextPrelim::new(""));
            x.insert(txn, "prop:elements", MapPrelim::default());
            x.insert(txn, "prop:xywh", "v0");
        }));
        let mut client = 20;
        let mut check = |edit: &dyn Fn(&mut TransactionMut, &MapRef)| {
            client += 1;
            checked(&room.board, &edited(&synced(&room, client), edit))
        };
        for at in [5, 2, 0] {
            assert_eq!(check(&typing(at)), Check::Small, "typing at {at}");
        }
        assert_eq!(check(&drag("v1")), Check::Small);
        let bold = |txn: &mut TransactionMut, blocks: &MapRef| {
            let attrs = Attrs::from([("bold".into(), Any::from(true))]);
            text(txn, blocks, "x", "prop:text").insert_with_attributes(txn, 2, "xy", attrs);
        };
        assert_eq!(check(&bold), Check::Small);
        assert_eq!(
            check(&|txn, blocks| {
                text(txn, blocks, "x", "prop:empty").insert(txn, 0, "a");
            }),
            Check::Small
        );
        assert_eq!(
            check(&|txn, blocks| {
                let block = blocks.insert(txn, "b40", MapPrelim::default());
                block.insert(txn, "sys:flavour", "affine:note");
                block.insert(txn, "prop:text", TextPrelim::new("note"));
                block.insert(txn, "prop:xywh", "[0,0,200,80]");
            }),
            Check::Small
        );
        assert_eq!(
            check(&|txn, blocks| {
                if let Some(Out::YMap(elements)) = block(txn, blocks, "x").get(txn, "prop:elements")
                {
                    let element = elements.insert(txn, "e1", MapPrelim::default());
                    element.insert(txn, "type", "brush");
                    element.insert(txn, "xywh", "[0,0,10,10]");
                }
            }),
            Check::Small
        );
        assert_eq!(
            check(&|txn, blocks| {
                block(txn, blocks, "x").insert(txn, "prop:color", "red");
            }),
            Check::Small
        );
    }

    /// The one-held-side rule leaves these to a trial, each an insert whose
    /// conflict scan could walk held items: a map set from a value
    /// overwritten since (a stale drag, or one crafted deep in the key's
    /// values), a key two tabs set for the first time at once (the second,
    /// with no origin, walks the first's value), typing between two units of
    /// a run others typed between, after a unit its writer typed on from, or
    /// at a start someone typed before, and a struct the room holds the start
    /// of, read from its first new unit, after one others typed after.
    #[test]
    fn an_insert_its_scan_could_walk_held_items_is_flagged() {
        let mut room = Room::new();
        let first = synced(&room, 11);
        room.deliver(&edited(&first, |txn, blocks| {
            let x = blocks.insert(txn, "x", MapPrelim::default());
            x.insert(txn, "prop:text", TextPrelim::new("hello"));
            x.insert(txn, "prop:xywh", "v0");
            x.insert(txn, "a", "a0");
        }));
        let (stale, early) = (synced(&room, 12), synced(&room, 13));
        for n in 1..=3 {
            room.deliver(&edited(&first, |txn, blocks| {
                let x = block(txn, blocks, "x");
                x.insert(txn, "prop:xywh", format!("v{n}"));
                x.insert(txn, "a", format!("a{n}"));
            }));
        }
        assert_eq!(
            checked(&room.board, &edited(&stale, drag("w"))),
            Check::Flagged
        );
        let (one, other) = (synced(&room, 14), synced(&room, 21));
        let color = |value: &'static str| {
            move |txn: &mut TransactionMut, blocks: &MapRef| {
                block(txn, blocks, "x").insert(txn, "prop:color", value);
            }
        };
        room.deliver(&edited(&one, color("red")));
        assert_eq!(
            checked(&room.board, &edited(&other, color("blue"))),
            Check::Flagged
        );
        // Others type between "h" and "e"; a tab that missed it types there.
        let between = synced(&room, 15);
        room.deliver(&edited(&between, |txn, blocks| {
            text(txn, blocks, "x", "prop:text").insert(txn, 1, "zzz");
        }));
        assert_eq!(
            checked(&room.board, &edited(&early, typing(1))),
            Check::Flagged
        );
        // A writer goes on typing at the end of its run; a tab that heard
        // only the run's start types at its end too.
        let at_end = |txn: &mut TransactionMut, blocks: &MapRef| {
            let text = text(txn, blocks, "x", "prop:text");
            let end = text.len(txn);
            text.insert(txn, end, "ab");
        };
        let writer = synced(&room, 17);
        room.deliver(&edited(&writer, at_end));
        let behind = synced(&room, 18);
        room.deliver(&edited(&writer, at_end));
        assert_eq!(
            checked(&room.board, &edited(&behind, at_end)),
            Check::Flagged
        );
        // Someone types at the start; a tab that missed it types there too.
        let (starter, opening) = (synced(&room, 19), synced(&room, 20));
        room.deliver(&edited(&starter, typing(0)));
        assert_eq!(
            checked(&room.board, &edited(&opening, typing(0))),
            Check::Flagged
        );
        // A types "p", others type after it, and A, not hearing them, types
        // "q" after its "p": one struct, from a held unit.
        let a = synced(&room, 50);
        room.deliver(&edited(&a, typing(0)));
        let b = synced(&room, 16);
        for at in 1..4 {
            room.deliver(&edited(&b, typing(at)));
        }
        edited(&a, typing(1));
        let sent = a
            .doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let squashed = ID::new(ClientID::new(50), 0);
        assert!(decode(&sent).blocks().any(|block| match block {
            UpdateBlock::Item(item) => *item.id() == squashed && item.len() == 2,
            _ => false,
        }));
        let Read::New(fresh) = read(&room.board, &sent) else {
            panic!("nothing new");
        };
        assert_eq!(fresh.check, Check::Flagged);
        // The room's trial: the trimmed update on a replica, then appended.
        apply(&room.board.replica().unwrap(), fresh.bytes());
        apply(&room.reference, &sent);
        apply(&room.peer, room.board.append(fresh));
        for doc in [&room.join(), &room.peer] {
            assert!(held(doc) == held(&room.reference));
        }
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
        let (from_a, from_b) = (edited(&a, drag("a")), edited(&b, drag("b")));
        room.deliver(&from_a);
        room.deliver(&from_b);
        let reader = room.join();
        let step2 = room.step2(&reader);
        assert!(changes(&room.board, &step2));
        assert!(!room.board.reader_changes(&decode(&step2)));
        // A hears B, and its next step 2 names the loser.
        apply(&a.doc, &from_b);
        let resent = room.step2(&a.doc);
        room.deliver(&resent);
        let named = decode(room.board.recent.last().unwrap());
        assert_eq!(named.blocks().count(), 0);
        assert!(!named.delete_set().is_empty());
        assert!(!changes(&room.board, &resent) && !changes(&room.board, &step2));
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
            let mut both = [deleting, edited(&b, typing(5))];
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
            assert!(changes(&room.board, &step2), "typing first: {typing_first}");
            assert!(!room.board.reader_changes(&decode(&step2)));
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
            assert!(!changes(&room.board, &step2));
            assert!(held(&room.join()) == held(&room.reference));
        }
    }

    /// What no editor sends is refused: an item naming itself (the bytes of
    /// one `true` at client 77's clock 0, its origin that same unit) and a
    /// client's delete ranges out of order or overlapping. yrs's decoder
    /// refuses a client's structs that overlap. A deletion past held clocks
    /// waits for a resync, and a reader's changes the board.
    #[test]
    fn a_malformed_update_is_refused_and_an_unplaceable_one_waits() {
        let room = Room::new();
        let itself = [1, 1, 77, 0, 0x88, 77, 0, 1, 120, 0];
        assert!(refusal(&room.board, &itself).contains("refers to itself"));
        for ranges in [[5, 3, 0, 2], [0, 5, 3, 4]] {
            let mut deletions = vec![0, 1, 11, 2];
            deletions.extend(ranges);
            assert!(refusal(&room.board, &deletions).contains("overlap"));
        }
        let section = [1, 77, 0, 0x28, 1, 1, b'b', 1, b'k', 1, 120];
        let mut overlapping = vec![2];
        overlapping.extend(section);
        overlapping.extend(section);
        overlapping.push(0);
        assert!(Update::decode_v1(&overlapping).is_err());
        let mut past = IdSet::default();
        past.insert(ID::new(ClientID::new(11), 0), 1000);
        let mut deleting = vec![0];
        deleting.extend(past.encode_v1());
        assert!(matches!(read(&room.board, &deleting), Read::Unheld));
        assert!(room.board.reader_changes(&decode(&deleting)));
    }

    /// A store's row is the recent updates and the marker document's delta
    /// merged, the live marker deleted in it as today; the tail takes the
    /// recent updates alone, so joiners still see the marker live. Once the
    /// room clears it, a writer's step 2 naming that deletion tells nothing
    /// new, and the stored rows hold the board.
    #[test]
    fn a_row_holds_the_recent_updates_with_live_markers_hidden() {
        let mut room = Room::new();
        room.mark("writer");
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
            let markers = room
                .board
                .markers()
                .get_or_insert_map(ydoc::CONTRIBUTORS_ROOT);
            let mut txn = room.board.markers().transact_mut();
            markers.remove(&mut txn, "writer");
            ydoc::committed_update(txn)
        };
        room.relay(&cleared);
        let step2 = room.step2(&room.join());
        assert!(
            decode(&step2)
                .delete_set()
                .get(&ClientID::new(ROOM))
                .is_some()
        );
        assert!(!changes(&room.board, &step2));
        room.store();
        let mut stored = vec![room.stored_base.clone()];
        stored.extend(room.rows.iter().cloned());
        assert!(held(&replica(&stored)) == held(&room.reference));
    }

    /// A marker still live when a fold's base holds it deleted (a committed
    /// row hid it and the room has not cleared it) is written again: fresh
    /// joiners and ones holding the base read it live, and a writer's step 2
    /// deletes no live marker, so the marker check admits it.
    #[test]
    fn a_live_marker_survives_a_fold() {
        let mut room = Room::new();
        room.mark("writer");
        for sent in &session(1, 30, 11) {
            room.deliver(sent);
        }
        room.store();
        let holding = room.join();
        assert!(room.fold().is_some());
        assert!(room.board.holds_base(&holding.transact().state_vector()));
        room.catch_up(&holding);
        let fresh = room.join();
        let replica = room.board.replica().unwrap();
        for doc in [&fresh, &holding, &room.peer, &replica] {
            assert!(held(doc) == held(&room.reference));
        }
        let live = ydoc::live_markers(&room.board.markers().transact());
        let step2 = decode(&room.step2(&fresh));
        assert!(!live.is_empty() && live.iter().all(|id| !step2.delete_set().contains(id)));
    }

    /// Markers across three folds: a live one is written again at each, one
    /// cleared between folds stays cleared, one a row hid and the room
    /// cleared before the fold is not written again, and the stored base and
    /// rows hold no live marker.
    #[test]
    fn markers_stay_right_across_folds() {
        let mut room = Room::new();
        room.mark("w1");
        room.mark("w2");
        let updates = session(2, 120, 5);
        for sent in &updates[..40] {
            room.deliver(sent);
        }
        room.store();
        let early = room.join();
        assert_eq!(decode(&room.fold().unwrap()).blocks().count(), 2);
        room.clear("w2");
        for sent in &updates[40..80] {
            room.deliver(sent);
        }
        room.store();
        assert_eq!(decode(&room.fold().unwrap()).blocks().count(), 1);
        room.mark("w3");
        room.store();
        room.clear("w3");
        for sent in &updates[80..] {
            room.deliver(sent);
        }
        room.store();
        assert_eq!(decode(&room.fold().unwrap()).blocks().count(), 1);
        room.catch_up(&early);
        let board = room.board.replica().unwrap();
        for doc in [&room.join(), &early, &room.peer, &board] {
            assert!(held(doc) == held(&room.reference));
        }
        let mut stored = vec![room.stored_base.clone()];
        stored.extend(room.rows.iter().cloned());
        let none = Some(Any::from(HashMap::<String, Any>::new()));
        assert!(held(&replica(&stored)).2[1] == none);
    }

    /// Two tabs type at a text's start at once, or tabs that never heard its
    /// first character type one there with no origins (from low client ids,
    /// so they land first): tried, each may land before the first item
    /// without naming it, so the room trusts no first for the text, and an
    /// insert before any of them, from a tab that heard them or one that
    /// holds only its own, is tried too.
    #[test]
    fn a_first_item_others_may_have_passed_is_no_longer_trusted() {
        let mut room = Room::new();
        let owner = synced(&room, 11);
        room.deliver(&edited(&owner, |txn, blocks| {
            blocks.insert(txn, "x", MapPrelim::default()).insert(
                txn,
                "prop:text",
                TextPrelim::new(""),
            );
        }));
        let empty = room
            .reference
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let typed = edited(&synced(&room, 1000), typing(0));
        assert_eq!(checked(&room.board, &typed), Check::Small);
        room.deliver(&typed);
        let (one, other) = (synced(&room, 1001), synced(&room, 1002));
        let before_first = edited(&one, typing(0));
        assert_eq!(checked(&room.board, &before_first), Check::Small);
        room.deliver(&before_first);
        let late = synced(&room, 1003);
        let at_once = edited(&other, typing(0));
        assert_eq!(checked(&room.board, &at_once), Check::Flagged);
        room.deliver(&at_once);
        for tab in [&late, &other] {
            assert_eq!(
                checked(&room.board, &edited(tab, typing(0))),
                Check::Flagged
            );
        }
        let late = synced(&room, 1004);
        let unheard: Vec<Tab> = (100..103).map(tab).collect();
        for tab in &unheard {
            apply(&tab.doc, &empty);
            let sent = edited(tab, typing(0));
            assert_eq!(checked(&room.board, &sent), Check::Flagged);
            room.deliver(&sent);
        }
        for tab in [&late, &unheard[2]] {
            assert_eq!(
                checked(&room.board, &edited(tab, typing(0))),
                Check::Flagged
            );
        }
        for doc in [&room.join(), &room.peer] {
            assert!(held(doc) == held(&room.reference));
        }
    }

    /// A five-tab session read as it arrives, stored every 50 and folded
    /// twice: each small update costs a peer's yrs at most [ydoc::SMALL_EDIT]
    /// squared steps, and the room's origins and keys cover the document's,
    /// each sequence first it trusts the document's own.
    #[test]
    fn small_stays_small_and_the_indexes_cover_the_document() {
        let updates = session(5, 600, 77);
        let mut room = Room::new();
        let mut worst = 0;
        for (at, sent) in updates.iter().enumerate() {
            apply(&room.reference, sent);
            match read(&room.board, sent) {
                Read::New(fresh) => {
                    let small = fresh.check == Check::Small;
                    let relayed = decode(room.board.append(fresh));
                    let mut txn = room.peer.transact_mut();
                    txn.limit_work(u64::MAX);
                    txn.apply_update(relayed).unwrap();
                    if small {
                        worst = worst.max(txn.work());
                    }
                    drop(txn);
                    room.resync();
                }
                Read::Unheld => room.waiting.push(sent.clone()),
                Read::Held => {}
            }
            if at % 50 == 7 {
                room.store();
            }
            if at % 250 == 125 {
                room.store();
                room.fold();
            }
        }
        assert!(room.waiting.is_empty());
        assert!(worst > 0 && worst <= (ydoc::SMALL_EDIT * ydoc::SMALL_EDIT) as u64);
        let doc = room.board.replica().unwrap();
        assert!(held(&doc) == held(&room.reference));
        let (ours, document) = (
            &room.board.origins,
            Indexes::of_doc(&doc.transact()).origins,
        );
        assert!(document.named.diff(&ours.named).is_empty());
        assert!(document.continued.diff(&ours.continued).is_empty());
        assert!(document.keys.is_subset(&ours.keys));
        // A sequence the document no longer holds is under a deleted block.
        assert!(
            ours.firsts.iter().all(|(place, first)| {
                document.firsts.get(place).is_none_or(|own| own == first)
            })
        );
    }
}
