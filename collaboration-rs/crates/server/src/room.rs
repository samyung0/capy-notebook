//! One task per loaded room (DESIGN.md 4): it owns the yrs document and does
//! every check that reads it, then the apply; it batches broadcasts over the
//! 30 ms flush window with no echo to the sender, acknowledges each writer's
//! messages once per window, keeps awareness as bytes, writes contributor
//! markers once per store window, stores with delta rows, projects notes on
//! idle and unloads once empty and clean. Note rooms validate Plate content
//! (`notes`); source rooms admit and store through `sources`.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use bytes::BytesMut;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use yrs::{Doc, ReadTxn, StateVector, Transact};

use crate::app::{Outbox, RoomHandle, RoomView, Shared, ViewState};
use crate::auth::{Access, Context, RoomName};
use crate::drafts::{Class, Refused};
use crate::incidents::{self, Cause, Incident, Kind as IncidentKind};
use crate::markers::{self, Contributor, Markers};
use crate::note_store::{self, StoreError};
use crate::observe::{self, Level, log};
use crate::projection;
use crate::protocol::{self, Kind, awareness, sync};

/// Broadcasts merge over this window (approved by Epo, 2026-10-04).
pub const FLUSH_WINDOW: Duration = Duration::from_millis(30);
/// Checkpoint requests waiting per room.
const MAX_PENDING_CHECKPOINTS: usize = 64;
const MAX_CHECKPOINT_ID: usize = 128;
/// Consecutive unplaceable step 2 replies before a channel closes.
pub const MAX_UNPLACED_STEPS: u32 = 2;
/// The largest sync message a note room takes: twice the 2 MiB of unsaved
/// edits an offline editor may hold, so its reconnect always fits (Epo,
/// 2026-10-08). Source rooms take whole states up to the frame cap.
pub const NOTE_MAX_SYNC_BYTES: usize = 4 * 1024 * 1024;
/// The largest awareness entry a room keeps and relays.
pub const MAX_AWARENESS_ENTRY: usize = 64 * 1024;
/// Awareness client ids one channel may hold, and a room (Epo 2026-10-19):
/// an editor sends its document's one, a new one only when Yjs renews it.
/// A new id past either is not kept.
pub const MAX_CLIENTS_PER_MEMBER: usize = 4;
pub const MAX_CLIENTS_PER_ROOM: usize = 256;
/// Why a note room holding a block the embed catalog does not list refuses
/// every writer (Epo 2026-10-13): the browser shows it for the
/// `unsupported_block` code.
pub const UNSUPPORTED_BLOCK: &str = "this document has a block this version can't edit";
/// What a channel hears when its open waits on its user's open budget
/// (`OPEN_SLOWED_TYPE` in src/features/collaboration/roomProvider.ts): the
/// editor keeps loading and says so after a while, never offline.
pub const OPEN_SLOWED_TYPE: &str = "open-slowed";
/// Failed stores retry after 5 s, doubling to 60 s.
const RETRY_FIRST: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(60);

pub type MemberKey = (u64, u64);

/// Messages to a room task.
pub enum RoomCmd {
    Join {
        key: MemberKey,
        context: Context,
        out: Outbox,
        socket: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Leave(MemberKey),
    Sync(MemberKey, bytes::Bytes),
    Awareness(MemberKey, bytes::Bytes),
    QueryAwareness(MemberKey),
    Stateless(MemberKey, String),
    Token(MemberKey, Context),
    /// A store's I/O finished.
    Stored(Box<StoreDone>),
    /// A projection finished.
    Projected(i64, Result<(), String>),
    /// Store now (if anything is unsaved) and answer once it is durable.
    Persist(oneshot::Sender<Result<(), String>>),
    /// Persist, then project, and answer with the projected version.
    Project(oneshot::Sender<Result<i64, String>>),
    /// Send every channel a stateless message.
    Broadcast(String),
    /// An eviction (DESIGN.md 9): drain stores and closes, discard throws
    /// unsaved state away; both close every channel after `notification`.
    Evict {
        drain: bool,
        notification: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Close every channel of a user (account access changed).
    CloseUser(String, u16, String),
    /// A fold of the log finished: rows and bytes it removed, the new base size.
    Folded(Option<(i64, i64, i64)>),
    /// The source handoff: a channel goes read-only, every channel back to
    /// its token's access, channels close (none named: all of them).
    SetReadOnly(u64),
    RestoreAccess,
    CloseChannels {
        channel: Option<u64>,
        code: Option<u16>,
        reason: String,
    },
    /// A source epoch ended: unload without storing once every channel left.
    Unload(oneshot::Sender<()>),
    /// The Office maintenance pause flushed this room (true) or ended.
    SetPaused(bool),
    /// The room's whole state (a server edit merges the live room).
    Snapshot(oneshot::Sender<Vec<u8>>),
    /// A server edit committed beside the room's stores.
    ServiceEdit(Box<ServiceEdit>),
    /// A children pass for an update this room holds (`children.rs`).
    ChildPass(Box<ChildPass>),
    /// The API's answer to the running pass.
    ChildAnswer {
        pass: Box<ChildPass>,
        plan: notes::children::ChildPlan,
        answer: Result<(notes::children::ChildAnswer, bool), String>,
    },
    /// A quiz's keys room to its content room: the matching and ordering
    /// entries the readers' lists follow (D3 as revised 2026-10-10).
    Items(Vec<items::quiz::ItemsPart>),
    /// A quiz room loaded: the other one sends its entries and metrics again.
    PeerLoaded,
    /// The other document's metrics: a quiz's two documents count together
    /// against the material's limits (REVIEW1 S3).
    PeerMetrics(notes::limits::Metrics),
    /// A server edit changed the other document while its room was not
    /// loaded: read it from the store.
    PeerReload,
    /// What that read found (dropped when the other room loaded meanwhile).
    PeerStored(notes::limits::Metrics, Vec<items::quiz::ItemsPart>),
    /// Stored drafts from a browser with no editor open (`drafts.rs`).
    Draft(Box<Draft>),
}

/// A draft send: a writer's update without a channel. The reply is the
/// admission's refusal, or the answer of the store that will hold it.
pub struct Draft {
    pub context: Context,
    pub update: bytes::Bytes,
    /// The base the drafts grew over (an Office file needs the room's).
    pub base: Option<String>,
    pub reply: oneshot::Sender<Result<Durable, Refused>>,
}

/// Answers once a store holds the admitted update (or with its failure).
pub type Durable = oneshot::Receiver<Result<(), String>>;

/// What the room decided about a writer's update.
enum Outcome {
    /// Applied, or nothing new: acknowledged.
    Admitted,
    /// It refers to content the room does not hold (a channel resyncs).
    Unheld,
    /// Refused: what a channel hears before it closes, why, and the class a
    /// draft send answers with.
    Refused {
        payloads: Vec<String>,
        reason: String,
        class: Class,
    },
}

impl Outcome {
    fn refused(class: Class, reason: impl Into<String>) -> Self {
        Outcome::Refused {
            payloads: Vec::new(),
            reason: reason.into(),
            class,
        }
    }
}

/// An update that wrote child ids, the writer it is attributed to, and the
/// channel to tell when storage refused a copy.
pub struct ChildPass {
    pub actor: String,
    pub update: Vec<u8>,
    pub notify: Option<MemberKey>,
}

/// A server edit (an agent edit or Undo, a command) committed as its own row:
/// what the live room lacks of it, the stored cover it makes, and the
/// note's stored version or the source's checkpoint it reached.
pub struct ServiceEdit {
    pub update: Vec<u8>,
    pub durable: ydoc::Durable,
    pub version: u64,
    pub row_bytes: usize,
}

struct Member {
    context: Context,
    /// The handoff's name for this channel.
    channel_id: u64,
    read_only: bool,
    /// A viewer's channel: no awareness either way (kept across refreshes;
    /// a role change evicts the channel).
    viewer: bool,
    /// The source handoff made this channel read-only until RestoreAccess;
    /// a token refresh keeps it so.
    held_read_only: bool,
    out: Outbox,
    socket: String,
    /// Awareness client ids this channel sent.
    clients: HashSet<u64>,
    /// Consecutive unplaceable step 2 replies.
    unplaced: u32,
    /// Update and step 2 messages handled since the last ACK.
    acks: u64,
    /// Its step 1 and awareness query waiting for its user's open budget.
    opening: Option<Opening>,
}

/// A member's latest step 1 and awareness query while they wait on its
/// user's open budget (Epo 2026-10-20), and its place among the waiting.
struct Opening {
    step1: Option<StateVector>,
    query: bool,
    order: u64,
}

/// A user's turn to encode a large answer (`Allowances::open_turn`): their
/// next one waits until this one ends, charged by `bytes`. Dropped early (a
/// panic in the encode), the turn ends anyway.
struct OpenTurn {
    app: Shared,
    user: String,
    bytes: usize,
}

impl Drop for OpenTurn {
    fn drop(&mut self) {
        self.app
            .allowances
            .end_turn(&self.user, self.bytes, Instant::now());
    }
}

struct AwarenessEntry {
    entry: awareness::Entry,
    owner: Option<MemberKey>,
    /// The user whose channel set it: only their channels write it.
    user: String,
}

/// A note room's own state.
struct Note {
    material_id: String,
    schema: i64,
    kind: String,
    /// What the document is: Plate (notes) or a live item (live-items).
    model: crate::model::Model,
    /// The material's content document, or a quiz's keys document.
    doc: note_store::Doc,
    /// A keys room: the matching and ordering entries last sent to the
    /// content room (none: send them at the next flush).
    items_sent: Option<Vec<items::quiz::ItemsPart>>,
    /// A quiz content room: the lists readers get, pushed over every channel
    /// as `quiz-items` (none: not read yet).
    reader: Option<items::quiz::ReaderLists>,
    /// A quiz room: the metrics last sent to the other document's room.
    metrics_sent: Option<notes::limits::Metrics>,
    validator: crate::model::RoomValidator,
    /// The stored document is one the store would refuse, or a quiz either
    /// of whose documents holds a block kind its rooms do not admit
    /// (`Model::stored`): it stays readable and no writer edits it until it
    /// is fixed (Epo 2026-10-13).
    unlisted: bool,
    durable_metrics: Option<notes::limits::Metrics>,
    stored_version: i64,
    projected_version: i64,
    projecting: bool,
    /// When the room last projected (or loaded): edits that never pause
    /// still project every `projection_cadence`.
    projected_at: Instant,
    project_waiters: Vec<oneshot::Sender<Result<i64, String>>>,
    log_bytes: i64,
    log_rows: i64,
    base_bytes: i64,
    folding: bool,
}

/// A source room's own state.
struct Source {
    room: sources::SourceRoom,
    format: sources::SourceFormat,
    /// The room's state size by applied bytes less what deletes freed, for
    /// the cap check.
    estimate: sources::Estimate,
    /// The room's state cap (`sources::state_cap`).
    state_cap: u64,
    /// An Office room's seed state vector (`sources::Loaded::seed`).
    seed: Option<StateVector>,
    checkpoint: u64,
    log_bytes: i64,
    log_rows: i64,
    base_bytes: i64,
    folding: bool,
    /// Pending content found by a store, reported once per load.
    pending_reported: bool,
    /// The maintenance pause flushed the room: writer updates are refused.
    paused: bool,
    /// When this room's saves started failing without a success.
    failing_since: Option<Instant>,
    /// This room's load: its sources record (by generation) and its hold on
    /// the disk store files, which goes with the room, also when a panic
    /// unwinds it.
    hold: sources::Hold,
    /// The session's base, which an Office file's drafts must have grown over.
    base_sha256: String,
}

/// Why a store failed.
pub enum StoreFailure {
    Note(StoreError),
    Source(sources::SourceError),
}

impl std::fmt::Display for StoreFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreFailure::Note(error) => error.fmt(f),
            StoreFailure::Source(error) => error.fmt(f),
        }
    }
}

/// What a store carried, back from its I/O.
pub struct StoreDone {
    result: Result<i64, StoreFailure>,
    started: Instant,
    row_bytes: usize,
    contributors: Vec<Contributor>,
    claimed: Vec<String>,
    durable: ydoc::Durable,
    metrics: Option<notes::limits::Metrics>,
    limit_code: Option<notes::limits::LimitCode>,
}

enum Kindly {
    Note(Box<Note>),
    Source(Box<Source>),
}

struct Store {
    /// Content changed since the last snapshot.
    dirty: bool,
    first_change: Option<Instant>,
    last_change: Option<Instant>,
    running: bool,
    /// Store again right after the running one.
    again: bool,
    /// A failed store's retry (backoff) and its first event.
    retry_at: Option<Instant>,
    retry_delay: Duration,
    failed_event: Option<String>,
    waiters: Vec<oneshot::Sender<Result<(), String>>>,
}

/// See `sync_message`: not a valid update, so a release build refuses it.
#[cfg(debug_assertions)]
const IT_PANIC_UPDATE: &[u8] = b"capy-it-panic";

/// See `load`: the first load of a note whose id holds this panics, in debug
/// builds only.
#[cfg(debug_assertions)]
const IT_PANIC_LOAD: &str = "capy-it-panic-load";
#[cfg(debug_assertions)]
static IT_PANICKED_LOAD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub struct Room {
    app: Shared,
    id: u64,
    name: String,
    doc: Doc,
    members: HashMap<MemberKey, Member>,
    awareness: HashMap<u64, AwarenessEntry>,
    changed_awareness: BTreeSet<u64>,
    /// This window's updates and who sent each (none: everyone gets it).
    window: Vec<(Option<MemberKey>, Vec<u8>)>,
    flush_at: Option<Instant>,
    markers: Markers,
    receipts: Vec<String>,
    durable: ydoc::Durable,
    store: Store,
    idle_at: Option<Instant>,
    kind: Kindly,
    /// A refusal for good threw the unsaved state away: the room unloads and
    /// moves its lineage before it is accepted again.
    discard_pending: Option<Cause>,
    view: Arc<RoomView>,
    /// Membership, access or store state changed since the view was set.
    view_dirty: bool,
    /// A source epoch ended: the room unloads without storing, then answers.
    forced_unload: Vec<oneshot::Sender<()>>,
    /// Children passes waiting, and whether one waits on the API.
    child_passes: std::collections::VecDeque<ChildPass>,
    child_running: bool,
    /// An update is going into the document (see `update_panicked`).
    applying: bool,
    /// When waiting opens look at their users' budgets again, and the next
    /// one's place.
    open_at: Option<Instant>,
    openings: u64,
}

/// Spawns a room task; its handle goes into the registry. `actor` is the
/// first joiner (a source room loads its session as that user).
pub fn spawn(app: &Shared, name: &RoomName, id: u64, actor: &str) -> RoomHandle {
    let (tx, rx) = mpsc::channel(4096);
    let view = Arc::new(RoomView::default());
    let (app, name, actor, room_view) = (app.clone(), name.clone(), actor.to_owned(), view.clone());
    tokio::spawn(async move {
        use futures::FutureExt;
        let room = name.to_string();
        let ran = std::panic::AssertUnwindSafe(run(app.clone(), name, id, actor, room_view, rx))
            .catch_unwind()
            .await;
        // A panic outside the room's own steps (its load, its unload): the
        // Sentry hook reported it; the next join loads afresh.
        if ran.is_err() {
            app.rooms.remove_if(&room, id, || true);
        }
    });
    RoomHandle { id, tx, view }
}

/// Takes `bytes` off the loaded rooms' log bytes, never below zero (an
/// accounting slip must not wrap the metric).
fn unlog_bytes(app: &Shared, bytes: u64) {
    let _ = app
        .stats
        .log_bytes
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |held| {
            Some(held.saturating_sub(bytes))
        });
}

/// A room's stored bytes (its base and log rows), for the load and unload
/// lines: known without encoding the document on the room's thread.
fn stored_bytes(kind: &Kindly) -> i64 {
    match kind {
        Kindly::Note(note) => note.base_bytes + note.log_bytes,
        Kindly::Source(source) => source.base_bytes + source.log_bytes,
    }
}

/// Picks a client id the loaded state does not hold (markers and server
/// edits are written under it).
fn fresh_doc(held: &StateVector) -> Doc {
    loop {
        let doc = Doc::with_options(ydoc::doc_options(0));
        if held.get(&doc.client_id()) == 0 {
            return doc;
        }
    }
}

/// What a join waiting on a source room load the disk store refused is
/// answered: the socket refuses it without counting an authentication
/// failure (the load logged and counted it).
pub const DISK_FULL: &str = "source disk store full";

/// Why a room did not load: a failure (reported), or the disk store's
/// refusal (logged and counted where it is refused).
enum LoadError {
    Failed(String),
    DiskFull,
}

impl From<String> for LoadError {
    fn from(error: String) -> Self {
        LoadError::Failed(error)
    }
}

async fn load(
    app: &Shared,
    name: &RoomName,
    actor: &str,
) -> Result<(Doc, Kindly, ydoc::Durable, Option<sources::LoadTimes>), LoadError> {
    match name {
        RoomName::Material {
            material_id,
            schema,
            keys,
        } => {
            // Debug builds only: the integration tests' panic during a load,
            // outside the room's own steps (once, so the next join loads).
            #[cfg(debug_assertions)]
            if material_id.contains(IT_PANIC_LOAD)
                && !IT_PANICKED_LOAD.swap(true, Ordering::Relaxed)
            {
                panic!("integration test panic during a load");
            }
            let doc_kind = if *keys {
                note_store::Doc::Keys
            } else {
                note_store::Doc::Content
            };
            let loaded = note_store::load(&app.db, material_id, *schema, doc_kind)
                .await
                .map_err(|error| error.to_string())?;
            let kind = loaded.material_kind.clone();
            let model = if *keys {
                if kind != "quiz" {
                    return Err("only a quiz has a keys document".to_owned().into());
                }
                crate::model::Model::Item(items::Kind::QuizKeys)
            } else {
                crate::model::Model::of(&kind)
            };
            let (log_rows, base_bytes) = (loaded.rows.len() as i64, loaded.base.len() as i64);
            let (stored_version, projected_version, log_bytes) = (
                loaded.stored_version,
                loaded.projected_version,
                loaded.log_bytes,
            );
            let material_kind = kind.clone();
            let (doc, durable, metrics, mut refused) =
                tokio::task::spawn_blocking(move || -> Result<_, String> {
                    let scratch = ydoc::scratch_doc();
                    ydoc::replay(&scratch, &loaded.base, &loaded.rows)
                        .map_err(|error| error.to_string())?;
                    let held = scratch.transact().state_vector();
                    let state = scratch
                        .transact()
                        .encode_state_as_update_v1(&StateVector::default());
                    let doc = fresh_doc(&held);
                    {
                        let mut txn = doc.transact_mut();
                        txn.apply_update(ydoc::decode(&state).map_err(|error| error.to_string())?)
                            .map_err(|error| error.to_string())?;
                    }
                    let txn = doc.transact();
                    model.assert_roots(&txn)?;
                    markers::contributors_in(&txn).map_err(|error| error.to_string())?;
                    let metrics = model.measure(&txn)?;
                    let refused = model.stored(&material_kind, &txn)?;
                    let durable = ydoc::Durable::of(&txn);
                    drop(txn);
                    Ok((doc, durable, metrics, refused))
                })
                .await
                .map_err(|error| error.to_string())??;
            // A quiz's other document as stored: its metrics count with this
            // one's, the content room's readers get the keys' items, and a
            // block this version cannot read in either makes both rooms
            // read-only (a save in one would rebuild the quiz without it).
            let mut validator = model.validator(&kind, metrics);
            let mut reader = None;
            if model.quiz() {
                let other = match doc_kind {
                    note_store::Doc::Content => note_store::Doc::Keys,
                    note_store::Doc::Keys => note_store::Doc::Content,
                };
                let (peer, parts, peer_unlisted) =
                    peer_state(app, material_id, *schema, other).await?;
                validator.set_peer(peer);
                if peer_unlisted && refused.is_none() {
                    refused = Some(crate::model::UNKNOWN_QUIZ_BLOCK.to_owned());
                }
                if doc_kind == note_store::Doc::Content {
                    let mut lists = items::quiz::ReaderLists::default();
                    lists.follow(&parts, &mut random_pick);
                    reader = Some(lists);
                }
            }
            // Operators see which rooms load read-only, and why (R2-L1).
            if let Some(reason) = &refused {
                log(
                    Level::Warn,
                    "room loads read-only",
                    json!({ "reason": reason, "room": name.to_string() }),
                );
            }
            let note = Note {
                material_id: material_id.clone(),
                schema: *schema,
                kind,
                // The load measured the room exactly (off the room task), so
                // the first update takes the growth bound instead of copying
                // and measuring a near-limit note on the room task (~55 ms).
                validator,
                unlisted: refused.is_some(),
                model,
                doc: doc_kind,
                items_sent: None,
                reader,
                metrics_sent: None,
                durable_metrics: Some(metrics),
                stored_version,
                projected_version,
                projecting: false,
                projected_at: Instant::now(),
                project_waiters: Vec::new(),
                log_bytes,
                log_rows,
                base_bytes,
                folding: false,
            };
            Ok((doc, Kindly::Note(Box::new(note)), durable, None))
        }
        RoomName::Source { .. } => {
            let room = name
                .source_room()
                .ok_or_else(|| "invalid source room".to_owned())?;
            let doc = Doc::with_options(ydoc::doc_options(0));
            let loaded = match app.sources.load(&room, actor, &doc).await {
                Ok(loaded) => loaded,
                // Expected while loaded rooms fill the disk store: logged and
                // counted, not reported; Edit shows collaboration unavailable
                // (the refusal retries) and View needs no room.
                Err(error @ sources::SourceError::StoreFull { .. }) => {
                    app.stats
                        .source_disk_refusals
                        .fetch_add(1, Ordering::Relaxed);
                    log(
                        Level::Warn,
                        "source room refused: disk store full",
                        json!({ "error": error.to_string(), "room": name.to_string() }),
                    );
                    return Err(LoadError::DiskFull);
                }
                Err(error) => return Err(error.to_string().into()),
            };
            // O(store) walks, on the blocking pool (the room is not serving yet).
            let checked = doc.clone();
            let durable = tokio::task::spawn_blocking(move || -> Result<_, String> {
                let txn = checked.transact();
                // Markers and server edits go under the room's own client.
                if txn.state_vector().get(&checked.client_id()) > 0 {
                    return Err("source room client collided with its state".into());
                }
                markers::contributors_in(&txn).map_err(|error| error.to_string())?;
                Ok(ydoc::Durable::of(&txn))
            })
            .await
            .map_err(|error| error.to_string())
            .and_then(|checked| checked);
            let durable = match durable {
                Ok(durable) => durable,
                Err(error) => {
                    // The room never serves: its record goes, and its files
                    // with `loaded`.
                    app.sources.forget(&room, loaded.hold.generation()).await;
                    return Err(error.into());
                }
            };
            let source = Source {
                room,
                format: loaded.format,
                estimate: sources::Estimate::new(loaded.bytes),
                state_cap: loaded.state_cap,
                seed: loaded.seed,
                checkpoint: loaded.checkpoint,
                log_bytes: loaded.row_bytes as i64,
                log_rows: loaded.rows as i64,
                base_bytes: loaded.base_bytes as i64,
                folding: false,
                pending_reported: false,
                paused: false,
                failing_since: None,
                hold: loaded.hold,
                base_sha256: loaded.session.base_source_sha256,
            };
            Ok((
                doc,
                Kindly::Source(Box::new(source)),
                durable,
                Some(loaded.times),
            ))
        }
    }
}

/// A random index below `n` (the readers' shuffles).
fn random_pick(n: usize) -> usize {
    (uuid::Uuid::new_v4().as_u128() % n.max(1) as u128) as usize
}

/// A quiz's other document as stored: its metrics and, for the keys
/// document, its matching and ordering entries.
async fn peer_state(
    app: &Shared,
    material_id: &str,
    schema: i64,
    doc: note_store::Doc,
) -> Result<(notes::limits::Metrics, Vec<items::quiz::ItemsPart>, bool), String> {
    let loaded = note_store::load(&app.db, material_id, schema, doc)
        .await
        .map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || -> Result<_, String> {
        let scratch = ydoc::scratch_doc();
        ydoc::replay(&scratch, &loaded.base, &loaded.rows).map_err(|error| error.to_string())?;
        let txn = scratch.transact();
        let unlisted = items::quiz::holds_unknown_block(&txn);
        Ok(match doc {
            note_store::Doc::Keys => (
                notes::limits::measure_value(&items::Kind::QuizKeys.document_value(&txn)),
                items::quiz::item_parts(&txn),
                unlisted,
            ),
            note_store::Doc::Content => (
                notes::limits::measure_value(&items::Kind::Quiz.document_value(&txn)),
                Vec::new(),
                unlisted,
            ),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn run(
    app: Shared,
    name: RoomName,
    id: u64,
    actor: String,
    view: Arc<RoomView>,
    mut rx: mpsc::Receiver<RoomCmd>,
) {
    let room_name = name.to_string();
    let started = Instant::now();
    let loaded = load(&app, &name, &actor).await;
    let (doc, kind, durable, times) = match loaded {
        Ok(loaded) => loaded,
        Err(error) => {
            let error = match error {
                LoadError::Failed(error) => {
                    observe::capture(
                        &error,
                        None,
                        &[("room", &room_name), ("stage", "room_load")],
                    );
                    error
                }
                LoadError::DiskFull => DISK_FULL.to_owned(),
            };
            // Refuse every queued join and draft; the next one loads again.
            app.rooms.remove_if(&room_name, id, || true);
            rx.close();
            while let Some(command) = rx.recv().await {
                match command {
                    RoomCmd::Join { reply, .. } => {
                        let _ = reply.send(Err(error.clone()));
                    }
                    RoomCmd::Draft(draft) => {
                        let _ = draft
                            .reply
                            .send(Err(Refused::new(Class::Unavailable, error.clone())));
                    }
                    _ => {}
                }
            }
            return;
        }
    };
    let mut fields = json!({ "bytes": stored_bytes(&kind), "ms": started.elapsed().as_millis() as u64, "room": room_name });
    if let Some(times) = times {
        // A source room's stages, so a slow open shows its cause.
        fields["stages"] = json!(times);
    }
    log(Level::Info, "room_load", fields);
    let mut room = Room {
        markers: Markers::new(&app.instance_id),
        app,
        id,
        name: room_name,
        doc,
        members: HashMap::new(),
        awareness: HashMap::new(),
        changed_awareness: BTreeSet::new(),
        window: Vec::new(),
        flush_at: None,
        receipts: Vec::new(),
        durable,
        store: Store {
            dirty: false,
            first_change: None,
            last_change: None,
            running: false,
            again: false,
            retry_at: None,
            retry_delay: RETRY_FIRST / 2,
            failed_event: None,
            waiters: Vec::new(),
        },
        idle_at: None,
        kind,
        discard_pending: None,
        view,
        view_dirty: true,
        forced_unload: Vec::new(),
        child_passes: std::collections::VecDeque::new(),
        child_running: false,
        applying: false,
        open_at: None,
        openings: 0,
    };
    let log_bytes = match &room.kind {
        Kindly::Note(note) => note.log_bytes,
        Kindly::Source(source) => source.log_bytes,
    };
    room.app
        .stats
        .log_bytes
        .fetch_add(log_bytes.max(0) as u64, Ordering::Relaxed);
    if matches!(&room.kind, Kindly::Note(note) if note.model.quiz()) {
        room.send_peer(RoomCmd::PeerLoaded);
        room.schedule_flush();
    }
    room.serve(&mut rx).await;
}

impl Room {
    async fn serve(&mut self, rx: &mut mpsc::Receiver<RoomCmd>) {
        loop {
            let deadline = self.next_deadline();
            use futures::FutureExt;
            // A panic in any step leaves the task alive to discard the room
            // (no dead handle in the registry); the Sentry hook reported it.
            let step = tokio::select! {
                command = rx.recv() => match command {
                    Some(command) => {
                        std::panic::AssertUnwindSafe(self.handle(command))
                            .catch_unwind()
                            .await
                    }
                    None => return,
                },
                () = sleep_until(deadline) => {
                    std::panic::AssertUnwindSafe(self.on_timers()).catch_unwind().await
                }
            };
            if step.is_err() {
                self.discard_after_panic("room_panicked", 0);
            }
            self.publish_view();
            if self.unloadable() {
                let id = self.id;
                let removed = self.app.rooms.remove_if(&self.name, id, || rx.is_empty());
                if removed {
                    rx.close();
                    // Joins that slipped in after the lookup fail and look up again.
                    while let Ok(command) = rx.try_recv() {
                        if let RoomCmd::Join { reply, .. } = command {
                            let _ = reply.send(Err("room unloaded".into()));
                        }
                    }
                    self.unload().await;
                    return;
                }
            }
        }
    }

    fn next_deadline(&self) -> Option<Instant> {
        [self.flush_at, self.store_due(), self.idle_at, self.open_at]
            .into_iter()
            .flatten()
            .min()
    }

    fn store_due(&self) -> Option<Instant> {
        if self.store.running {
            return None;
        }
        if let Some(retry) = self.store.retry_at {
            return Some(retry);
        }
        if !self.store.dirty {
            return None;
        }
        let config = &self.app.config;
        let (debounce, max) = match self.kind {
            Kindly::Note(_) => (config.debounce, config.max_debounce),
            Kindly::Source(_) => (config.source_debounce, config.source_max_debounce),
        };
        let last = self.store.last_change? + debounce;
        let first = self.store.first_change? + max;
        Some(last.min(first))
    }

    async fn on_timers(&mut self) {
        let now = Instant::now();
        if self.flush_at.is_some_and(|at| at <= now) {
            self.flush();
        }
        if self.store_due().is_some_and(|at| at <= now) {
            self.store.retry_at = None;
            self.start_store().await;
        }
        if self.idle_at.is_some_and(|at| at <= now) {
            self.idle_at = None;
            self.start_projection().await;
        }
        if self.open_at.is_some_and(|at| at <= now) {
            self.open_at = None;
            self.release_openings().await;
        }
    }

    /// The handoff's view of the room, when something it reads changed.
    fn publish_view(&mut self) {
        if !std::mem::take(&mut self.view_dirty) {
            return;
        }
        self.view.set(ViewState {
            loaded: true,
            channels: self
                .members
                .values()
                .map(|member| sources::Channel {
                    id: member.channel_id,
                    write: member.context.access == Access::Write,
                    read_only: member.read_only,
                })
                .collect(),
            storing: self.store.running || self.store.retry_at.is_some(),
        });
    }

    fn unloadable(&self) -> bool {
        if self.discard_pending.is_some() || !self.forced_unload.is_empty() {
            return self.members.is_empty() && !self.store.running;
        }
        self.members.is_empty()
            && self.child_passes.is_empty()
            && !self.child_running
            && !self.store.dirty
            && !self.store.running
            && self.store.retry_at.is_none()
            && self.store.waiters.is_empty()
            && !markers::pending(&self.doc)
    }

    async fn handle(&mut self, command: RoomCmd) {
        match command {
            RoomCmd::Join {
                key,
                context,
                out,
                socket,
                reply,
            } => {
                let _ = reply.send(self.join(key, context, out, socket));
            }
            RoomCmd::Leave(key) => self.leave(key),
            RoomCmd::Sync(key, payload) => match self.step1_vector(key, &payload) {
                Some(since) => self.on_step1(key, since).await,
                None => self.on_sync(key, &payload),
            },
            RoomCmd::Awareness(key, payload) => self.on_awareness(key, &payload),
            RoomCmd::QueryAwareness(key) => self.on_query(key),
            RoomCmd::Stateless(key, payload) => self.on_stateless(key, &payload).await,
            RoomCmd::Token(key, context) => {
                if let Some(member) = self.members.get_mut(&key) {
                    member.read_only = member.held_read_only || context.access == Access::Read;
                    member.context = context;
                    self.view_dirty = true;
                }
            }
            RoomCmd::Stored(done) => self.stored(*done),
            RoomCmd::Projected(version, result) => self.projected(version, result),
            RoomCmd::Persist(reply) => {
                if !self.store.dirty
                    && !self.store.running
                    && !markers::pending(&self.doc)
                    && self.store.retry_at.is_none()
                {
                    let _ = reply.send(Ok(()));
                } else {
                    self.store.waiters.push(reply);
                    self.start_store().await;
                }
            }
            RoomCmd::Project(reply) => {
                let Kindly::Note(note) = &mut self.kind else {
                    let _ = reply.send(Err("not a note room".into()));
                    return;
                };
                note.project_waiters.push(reply);
                if self.store.dirty || markers::pending(&self.doc) {
                    self.start_store().await;
                } else {
                    self.start_projection().await;
                }
            }
            // The API's comment relays reach editors only: viewers have no
            // comments (Epo 2026-10-10).
            RoomCmd::Broadcast(payload) => {
                let text = protocol::text(&payload);
                for (key, member) in &self.members {
                    if !member.viewer {
                        self.send(*key, Kind::Stateless, &text);
                    }
                }
            }
            RoomCmd::Evict {
                drain,
                notification,
                reply,
            } => self.evict(drain, notification, reply).await,
            RoomCmd::CloseUser(user, code, reason) => {
                let keys: Vec<MemberKey> = self
                    .members
                    .iter()
                    .filter(|(_, member)| member.context.user_id == user)
                    .map(|(key, _)| *key)
                    .collect();
                for key in keys {
                    self.close_channel(key, None, code, &reason);
                }
            }
            RoomCmd::Folded(folded) => {
                let (folding, log_rows, log_bytes, base_bytes) = match &mut self.kind {
                    Kindly::Note(note) => (
                        &mut note.folding,
                        &mut note.log_rows,
                        &mut note.log_bytes,
                        &mut note.base_bytes,
                    ),
                    Kindly::Source(source) => (
                        &mut source.folding,
                        &mut source.log_rows,
                        &mut source.log_bytes,
                        &mut source.base_bytes,
                    ),
                };
                *folding = false;
                if let Some((rows, bytes, base)) = folded {
                    *log_rows -= rows;
                    *log_bytes -= bytes;
                    *base_bytes = base;
                    unlog_bytes(&self.app, bytes.max(0) as u64);
                }
            }
            RoomCmd::SetReadOnly(channel) => {
                if let Some(member) = self
                    .members
                    .values_mut()
                    .find(|member| member.channel_id == channel)
                {
                    member.read_only = true;
                    member.held_read_only = true;
                    self.view_dirty = true;
                }
            }
            RoomCmd::RestoreAccess => {
                for member in self.members.values_mut() {
                    member.held_read_only = false;
                    member.read_only = member.context.access == Access::Read;
                }
                self.view_dirty = true;
            }
            RoomCmd::CloseChannels {
                channel,
                code,
                reason,
            } => {
                let keys: Vec<MemberKey> = self
                    .members
                    .iter()
                    .filter(|(_, member)| channel.is_none_or(|id| member.channel_id == id))
                    .map(|(key, _)| *key)
                    .collect();
                for key in keys {
                    self.close_channel(key, None, code.unwrap_or(0), &reason);
                }
            }
            RoomCmd::Unload(reply) => self.forced_unload.push(reply),
            RoomCmd::SetPaused(paused) => {
                if let Kindly::Source(source) = &mut self.kind {
                    source.paused = paused;
                }
            }
            RoomCmd::Snapshot(reply) => {
                let state = self.encoded(StateVector::default()).await;
                let _ = reply.send(state);
            }
            RoomCmd::ServiceEdit(edit) => self.service_edit(*edit),
            RoomCmd::Items(parts) => self.follow_items(&parts),
            RoomCmd::PeerLoaded => {
                if let Kindly::Note(note) = &mut self.kind {
                    note.items_sent = None;
                    note.metrics_sent = None;
                }
                self.schedule_flush();
            }
            RoomCmd::PeerMetrics(metrics) => {
                if let Kindly::Note(note) = &mut self.kind {
                    note.validator.set_peer(metrics);
                }
            }
            RoomCmd::PeerReload => self.reload_peer(),
            RoomCmd::PeerStored(metrics, parts) => {
                if self.peer().is_none() {
                    if let Kindly::Note(note) = &mut self.kind {
                        note.validator.set_peer(metrics);
                    }
                    self.follow_items(&parts);
                }
            }
            RoomCmd::ChildPass(pass) => {
                self.child_passes.push_back(*pass);
                self.next_child_pass();
            }
            RoomCmd::ChildAnswer { pass, plan, answer } => self.child_answer(*pass, plan, answer),
            RoomCmd::Draft(draft) => self.draft(*draft).await,
        }
    }

    /// A draft send: a source room takes none during a publication handoff,
    /// and an Office file's only when they grew over the room's base (the
    /// editor's lineage rule); then the writer admission without a channel
    /// (a read token's draft as a read channel's update), then a store now,
    /// whose answer the reply carries.
    async fn draft(&mut self, draft: Draft) {
        let Draft {
            context,
            update,
            base,
            reply,
        } = draft;
        if let Kindly::Source(source) = &self.kind {
            // A publication handoff holds every writer read-only.
            let refused = if self.app.handoff().busy(&self.name) {
                Some((Class::Unavailable, "a publication is under way"))
            } else if source.format != sources::SourceFormat::Text
                && base.as_deref() != Some(source.base_sha256.as_str())
            {
                Some((Class::Lineage, "the drafts grew over another base"))
            } else {
                None
            };
            if let Some((class, message)) = refused {
                let _ = reply.send(Err(Refused::new(class, message)));
                return;
            }
        }
        self.app.stats.updates.fetch_add(1, Ordering::Relaxed);
        let read_only = context.access != Access::Write;
        let checked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // Debug builds only: the integration tests' panicking update.
            #[cfg(debug_assertions)]
            if update == IT_PANIC_UPDATE {
                panic!("integration test panic");
            }
            self.admit_update(None, &context, read_only, &update)
        }));
        let outcome = checked.unwrap_or_else(|_| {
            self.update_panicked(None, update.len());
            Outcome::refused(Class::Malformed, "update cannot be checked")
        });
        let answer = match outcome {
            Outcome::Admitted => {
                let (done, durable) = oneshot::channel();
                if self.nothing_to_store() {
                    let _ = done.send(Ok(()));
                } else {
                    self.store.waiters.push(done);
                    self.start_store().await;
                }
                Ok(durable)
            }
            Outcome::Unheld => Err(Refused::new(
                Class::Unheld,
                "the update needs content the room does not hold",
            )),
            Outcome::Refused { reason, class, .. } => Err(Refused::new(class, reason)),
        };
        let _ = reply.send(answer);
    }

    /// Starts the next waiting children pass: the update's child writes as
    /// this room reads them, then the API call (one at a time, in order). A
    /// pass with nothing to ask still tells editors which ids stayed.
    fn next_child_pass(&mut self) {
        if self.child_running {
            return;
        }
        let Kindly::Note(note) = &self.kind else {
            self.child_passes.clear();
            return;
        };
        // Item documents hold no note children (their images are the set's).
        if note.model != crate::model::Model::Note {
            self.child_passes.clear();
            return;
        }
        let material_id = note.material_id.clone();
        while let Some(pass) = self.child_passes.pop_front() {
            let plan = {
                let txn = self.doc.transact();
                let Ok(update) = ydoc::decode(&pass.update) else {
                    continue;
                };
                let Some(writes) = notes::children::child_writes(&txn, &update) else {
                    continue;
                };
                let Some(root) = txn.get_text(notes::plate::CONTENT_ROOT) else {
                    continue;
                };
                notes::children::plan(root.as_ref(), &writes)
            };
            if plan.asset_ids.is_empty() && plan.blocks.is_empty() {
                let kept = notes::children::kept_ids(&plan, &Default::default());
                self.broadcast_children_ready(&kept);
                continue;
            }
            let Some(handle) = self.own_handle() else {
                return;
            };
            self.child_running = true;
            let (app, material_id) = (self.app.clone(), material_id.clone());
            tokio::spawn(async move {
                let answer = crate::children::adopt(&app, &material_id, &pass.actor, &plan).await;
                let _ = handle
                    .tx
                    .send(RoomCmd::ChildAnswer {
                        pass: Box::new(pass),
                        plan,
                        answer,
                    })
                    .await;
            });
            return;
        }
    }

    /// The API answered a pass: the sender hears a storage refusal, nodes
    /// that moved are repointed or dropped as the writer's own change, and
    /// every editor learns which ids stayed.
    fn child_answer(
        &mut self,
        pass: ChildPass,
        plan: notes::children::ChildPlan,
        answer: Result<(notes::children::ChildAnswer, bool), String>,
    ) {
        self.child_running = false;
        match answer {
            Err(error) => {
                observe::capture(
                    &error,
                    None,
                    &[("room", &self.name), ("stage", "children_pass")],
                );
            }
            Ok((answer, refused)) => {
                if refused && let Some(key) = pass.notify {
                    let payload = json!({ "reason": "storage", "type": "children-refused" });
                    self.send(key, Kind::Stateless, &protocol::text(&payload.to_string()));
                }
                let moved = answer.assets.iter().any(|(from, to)| from != to)
                    || plan.blocks.iter().any(|block| {
                        answer.blocks.get(&block.block_id) != Some(&block.material_id)
                    });
                if moved {
                    self.apply_children(&pass.actor, &answer);
                }
                let kept = notes::children::kept_ids(&plan, &answer);
                self.broadcast_children_ready(&kept);
            }
        }
        self.next_child_pass();
    }

    /// Repoints or drops the moved children as the writer's change, stored
    /// with the room's next store.
    fn apply_children(&mut self, actor: &str, answer: &notes::children::ChildAnswer) {
        let context = Context {
            access: Access::Write,
            expires_at: i64::MAX,
            token_id: "children-pass".into(),
            user_id: actor.to_owned(),
            viewer: false,
            parent: None,
        };
        if let Some(marker) = self.markers.write(&self.doc, &context) {
            self.broadcast_update(None, marker);
        }
        let root = self.doc.get_or_insert_text(notes::plate::CONTENT_ROOT);
        let mut txn = self.doc.transact_mut();
        let applied = notes::children::apply(&mut txn, &root, answer);
        let update = ydoc::committed_update(txn);
        if let Err(error) = applied {
            observe::capture(
                &error.to_string(),
                None,
                &[("room", &self.name), ("stage", "children_pass")],
            );
        }
        if !update.is_empty() {
            // Content the validator did not admit: its growth bound is stale.
            if let Kindly::Note(note) = &mut self.kind {
                note.validator.invalidate();
            }
            self.content_changed();
            self.broadcast_update(None, update);
        }
    }

    /// The other document's room of a quiz (`keys:` for `material:`, and
    /// back), when it is loaded here.
    fn peer(&self) -> Option<crate::app::RoomHandle> {
        let Kindly::Note(note) = &self.kind else {
            return None;
        };
        let name = match note.doc {
            note_store::Doc::Content => format!("keys:{}:schema:{}", note.material_id, note.schema),
            note_store::Doc::Keys => {
                format!("material:{}:schema:{}", note.material_id, note.schema)
            }
        };
        self.app.rooms.get(&name)
    }

    fn send_peer(&self, cmd: RoomCmd) {
        if let Some(peer) = self.peer() {
            tokio::spawn(async move {
                let _ = peer.tx.send(cmd).await;
            });
        }
    }

    /// Once per flush window at most: a quiz room sends the other room its
    /// metrics when they changed, and a keys room its matching and ordering
    /// entries.
    fn send_to_peer(&mut self) {
        if !matches!(&self.kind, Kindly::Note(note) if note.model.quiz()) {
            return;
        }
        let Some(peer) = self.peer() else {
            return;
        };
        let parts = match &self.kind {
            Kindly::Note(note) if note.doc == note_store::Doc::Keys => {
                Some(items::quiz::item_parts(&self.doc.transact()))
            }
            _ => None,
        };
        let Kindly::Note(note) = &mut self.kind else {
            return;
        };
        let mut commands = Vec::new();
        let metrics = note.validator.bound();
        if metrics.is_some() && metrics != note.metrics_sent {
            note.metrics_sent = metrics;
            commands.extend(metrics.map(RoomCmd::PeerMetrics));
        }
        if let Some(parts) = parts
            && note.items_sent.as_ref() != Some(&parts)
        {
            note.items_sent = Some(parts.clone());
            commands.push(RoomCmd::Items(parts));
        }
        if !commands.is_empty() {
            tokio::spawn(async move {
                for command in commands {
                    let _ = peer.tx.send(command).await;
                }
            });
        }
    }

    /// The content room's readers' lists follow the keys' entries; channels
    /// hear what changed (D3 as revised 2026-10-10: plain lists outside Yjs,
    /// no history).
    fn follow_items(&mut self, parts: &[items::quiz::ItemsPart]) {
        let Kindly::Note(note) = &mut self.kind else {
            return;
        };
        if note.model != crate::model::Model::Item(items::Kind::Quiz) {
            return;
        }
        let first = note.reader.is_none();
        let reader = note.reader.get_or_insert_with(Default::default);
        let changed = reader.follow(parts, &mut random_pick);
        let message = if first {
            let all: Vec<_> = reader
                .all()
                .into_iter()
                .map(|(part, list)| (part, Some(list)))
                .collect();
            items::quiz::reader_message(true, &all)
        } else if changed.is_empty() {
            return;
        } else {
            items::quiz::reader_message(false, &changed)
        };
        self.broadcast_stateless(&message.to_string());
    }

    /// The other document changed in the store while its room was not loaded
    /// here: its room sends again when it is, else the store is read.
    fn reload_peer(&mut self) {
        if self.peer().is_some() {
            self.send_peer(RoomCmd::PeerLoaded);
            return;
        }
        let Kindly::Note(note) = &self.kind else {
            return;
        };
        if !note.model.quiz() {
            return;
        }
        let other = match note.doc {
            note_store::Doc::Content => note_store::Doc::Keys,
            note_store::Doc::Keys => note_store::Doc::Content,
        };
        let (app, material_id, schema) = (self.app.clone(), note.material_id.clone(), note.schema);
        let Some(handle) = self.own_handle() else {
            return;
        };
        let room = self.name.clone();
        tokio::spawn(async move {
            match peer_state(&app, &material_id, schema, other).await {
                // Admission and service edits refuse a block kind the room does not
                // admit, so the peer gains none after the load.
                Ok((metrics, parts, _)) => {
                    let _ = handle.tx.send(RoomCmd::PeerStored(metrics, parts)).await;
                }
                Err(error) => {
                    observe::capture(&error, None, &[("room", &room), ("stage", "peer_reload")]);
                }
            }
        });
    }

    fn broadcast_children_ready(&self, kept: &notes::children::KeptIds) {
        let mut payload = serde_json::to_value(kept).unwrap_or_else(|_| json!({}));
        payload["type"] = json!("children-ready");
        self.broadcast_stateless(&payload.to_string());
    }

    /// A server edit reaches the editors; it is durable already, so the room
    /// stays clean and its cover takes the edit's row in.
    fn service_edit(&mut self, edit: ServiceEdit) {
        let applied = ydoc::decode(&edit.update)
            .map_err(|error| error.to_string())
            .and_then(|update| ydoc::apply(&self.doc, update).map_err(|error| error.to_string()));
        let applied_bytes = match applied {
            Ok(update) => {
                let bytes = update.len() as u64;
                self.broadcast_update(None, update);
                bytes
            }
            Err(error) => {
                observe::capture(
                    &error,
                    None,
                    &[("room", &self.name), ("stage", "service_edit")],
                );
                return;
            }
        };
        self.durable.union(&edit.durable);
        self.app
            .stats
            .log_bytes
            .fetch_add(edit.row_bytes as u64, Ordering::Relaxed);
        match &mut self.kind {
            Kindly::Note(note) => {
                // Content the validator did not admit: its growth bound is stale.
                note.validator.invalidate();
                note.stored_version = note.stored_version.max(edit.version as i64);
                note.log_rows += 1;
                note.log_bytes += edit.row_bytes as i64;
            }
            Kindly::Source(source) => {
                // An agent's growth counts toward the cap as a writer's does.
                source.estimate.applied(applied_bytes, 0);
                source.checkpoint = source.checkpoint.max(edit.version);
                source.log_rows += 1;
                source.log_bytes += edit.row_bytes as i64;
            }
        }
        self.maybe_fold();
    }

    /// Sends `notification` (if any) and CLOSED, and forgets the channel.
    fn close_channel(
        &mut self,
        key: MemberKey,
        notification: Option<&str>,
        code: u16,
        reason: &str,
    ) {
        if let Some(payload) = notification {
            self.send(key, Kind::Stateless, &protocol::text(payload));
        }
        self.send(key, Kind::Closed, &protocol::closed(code, reason));
        if let Some(member) = self.members.get(&key) {
            member.out.channel_closed(key.1);
        }
        self.leave(key);
    }

    /// `evictLocalRoom` on this room: every channel hears the notification and
    /// closes. A drain stores first and answers with the store's outcome; a
    /// discard throws unsaved state away and moves the lineage when it held
    /// any (`discardMovesLineage`).
    async fn evict(
        &mut self,
        drain: bool,
        notification: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    ) {
        let client = notification.as_deref().map(incidents::client_payload);
        let keys: Vec<MemberKey> = self.members.keys().copied().collect();
        for key in keys {
            self.close_channel(key, client.as_deref(), 0, "collaboration room evicted");
        }
        self.flush();
        if drain {
            if self.nothing_to_store() {
                let _ = reply.send(Ok(()));
            } else {
                self.store.waiters.push(reply);
                self.start_store().await;
            }
            return;
        }
        let unsaved =
            self.store.dirty || self.store.retry_at.is_some() || markers::pending(&self.doc);
        if unsaved && self.discard_pending.is_none() {
            let cause = incidents::broadcast_cause(notification.as_deref());
            self.record_room_incidents(&cause, None);
            self.app.evictions.reject(&self.name);
            self.discard_pending = Some(cause);
        }
        self.store.dirty = false;
        self.store.retry_at = None;
        self.answer_store_waiters(Err("collaboration room discarded".into()));
        let _ = reply.send(Ok(()));
    }

    /// `roomIncidents`: one incident per writer with unsaved work in the room,
    /// or one naming nobody.
    fn record_room_incidents(&self, cause: &Cause, bytes: Option<u64>) {
        let users: BTreeSet<String> = self
            .markers
            .contributors(&self.doc)
            .unwrap_or_default()
            .into_iter()
            .map(|c| c.user_id)
            .collect();
        // Else the room's estimate (a source room's applied bytes, a note's
        // stored ones), not an encode of the document on the room's thread.
        let size = bytes.or(Some(match &self.kind {
            Kindly::Source(source) => source.estimate.bytes,
            kind => stored_bytes(kind).max(0) as u64,
        }));
        let list: Vec<Incident> = if users.is_empty() {
            vec![Incident {
                cause: cause.clone(),
                room: self.name.clone(),
                size_bytes: size,
                user_id: None,
            }]
        } else {
            users
                .into_iter()
                .map(|user| Incident {
                    cause: cause.clone(),
                    room: self.name.clone(),
                    size_bytes: size,
                    user_id: Some(user),
                })
                .collect()
        };
        incidents::record(&self.app, list);
    }

    /// Folds the log once it passes the configured size (DESIGN.md 3.5).
    fn maybe_fold(&mut self) {
        let (min_bytes, max_rows) = (
            self.app.config.fold_min_bytes as i64,
            self.app.config.fold_max_rows as i64,
        );
        let Some(handle) = self
            .app
            .rooms
            .get(&self.name)
            .filter(|handle| handle.id == self.id)
        else {
            return;
        };
        let note = match &mut self.kind {
            Kindly::Note(note) => note,
            Kindly::Source(source) => {
                if source.folding
                    || (source.log_bytes < min_bytes.max(source.base_bytes)
                        && source.log_rows < max_rows)
                {
                    return;
                }
                source.folding = true;
                let (app, room) = (self.app.clone(), source.room.clone());
                tokio::spawn(async move {
                    let folded = match app.sources.fold(&room).await {
                        Ok(folded) => (folded.rows > 0).then_some((
                            folded.rows as i64,
                            folded.row_bytes as i64,
                            folded.base_bytes as i64,
                        )),
                        Err(error) => {
                            observe::capture(
                                &error.to_string(),
                                None,
                                &[("room", &room.name()), ("stage", "fold")],
                            );
                            None
                        }
                    };
                    let _ = handle.tx.send(RoomCmd::Folded(folded)).await;
                });
                return;
            }
        };
        if note.folding
            || (note.log_bytes < min_bytes.max(note.base_bytes) && note.log_rows < max_rows)
        {
            return;
        }
        note.folding = true;
        let (app, material_id, schema, through, doc_kind) = (
            self.app.clone(),
            note.material_id.clone(),
            note.schema,
            note.stored_version,
            note.doc,
        );
        tokio::spawn(async move {
            let folded = match note_store::fold(
                &app.db,
                &material_id,
                schema,
                doc_kind,
                Some(through),
            )
            .await
            {
                Ok(folded) => folded.map(|f| (f.rows as i64, f.log_bytes, f.base_bytes)),
                Err(error) => {
                    observe::capture(
                        &error.to_string(),
                        None,
                        &[("room", &material_id), ("stage", "fold")],
                    );
                    None
                }
            };
            let _ = handle.tx.send(RoomCmd::Folded(folded)).await;
        });
    }

    // ---------------------------------------------------------------- channels

    fn send(&self, key: MemberKey, kind: Kind, payload: &[u8]) {
        if let Some(member) = self.members.get(&key) {
            member.out.frame(protocol::message(key.1, kind, payload));
        }
    }

    /// Charges a full-document answer of `bytes` to the member's user's open
    /// budget (`rate.rs`).
    fn charge_open(&self, key: MemberKey, bytes: usize) {
        if let Some(member) = self.members.get(&key) {
            self.app
                .allowances
                .charge_open(&member.context.user_id, bytes, Instant::now());
        }
    }

    /// A member's step 1, answered with up to the whole state (encoded on the
    /// blocking pool) and charged to its user's open budget by the answer's
    /// bytes (Epo 2026-10-19). An answer under `SMALL_ANSWER` goes at once
    /// while the user owes less than a full budget (Epo 2026-10-20). Any
    /// other is encoded in its user's turn, so their waiting answers are
    /// charged one at a time, and waits while the budget is spent or another
    /// one of theirs is being encoded: the member then keeps only its latest
    /// step 1 and hears once that its open is slowed. A bounded walk tells a
    /// large answer before the encode (the encode checks it after), so a
    /// waiting step 1 costs no encode.
    async fn on_step1(&mut self, key: MemberKey, since: StateVector) {
        let Some(member) = self.members.get_mut(&key) else {
            return;
        };
        if let Some(opening) = &mut member.opening {
            // One joining a wait that held no step 1 (its JOIN's awareness)
            // hears that its open is slowed too (rate-limit review r7 S-1).
            if opening.step1.replace(since).is_none() {
                self.open_slowed(key);
            }
            return;
        }
        let user = member.context.user_id.clone();
        let small = crate::rate::SMALL_ANSWER;
        if self.app.allowances.small_skips(&user, Instant::now())
            && !ydoc::answer_at_least(&self.doc.transact(), &since, small)
        {
            let diff = self.encoded(since.clone()).await;
            if diff.len() < small {
                self.charge_open(key, diff.len());
                self.answer(key, &diff);
                return;
            }
            match self.app.allowances.open_turn(&user, Instant::now()) {
                Ok(()) => {
                    let mut turn = self.turn(user);
                    turn.bytes = self.answer(key, &diff);
                }
                Err(wait) => self.wait_to_open(key, Some(since), false, wait),
            }
            return;
        }
        match self.app.allowances.open_turn(&user, Instant::now()) {
            Ok(()) => {
                let mut turn = self.turn(user);
                let diff = self.encoded(since).await;
                turn.bytes = self.answer(key, &diff);
            }
            Err(wait) => self.wait_to_open(key, Some(since), false, wait),
        }
    }

    fn turn(&self, user: String) -> OpenTurn {
        OpenTurn {
            app: self.app.clone(),
            user,
            bytes: 0,
        }
    }

    /// Sends a step 1's answer; its bytes, or 0 when the member left.
    fn answer(&self, key: MemberKey, diff: &[u8]) -> usize {
        if !self.members.contains_key(&key) {
            return 0;
        }
        self.send(key, Kind::Sync, &sync::encode(sync::STEP2, diff));
        diff.len()
    }

    /// A member's awareness query: answered and charged at once, or kept
    /// (the latest) while its user's open budget is spent.
    fn on_query(&mut self, key: MemberKey) {
        let Some(member) = self.members.get_mut(&key) else {
            return;
        };
        if let Some(opening) = &mut member.opening {
            opening.query = true;
            return;
        }
        let user = &member.context.user_id;
        if let Some(wait) = self.app.allowances.open_wait(user, Instant::now()) {
            self.wait_to_open(key, None, true, wait);
            return;
        }
        let sent = self.send_awareness_states(key);
        self.charge_open(key, sent);
    }

    /// The member's step 1 or query begins to wait `wait` for its user's open
    /// budget; a step 1 tells its channel that the open is slowed.
    fn wait_to_open(
        &mut self,
        key: MemberKey,
        step1: Option<StateVector>,
        query: bool,
        wait: Duration,
    ) {
        let order = self.openings;
        let Some(member) = self.members.get_mut(&key) else {
            return;
        };
        self.openings += 1;
        let slowed = step1.is_some();
        let opening = member.opening.get_or_insert(Opening {
            step1: None,
            query: false,
            order,
        });
        opening.query |= query;
        if step1.is_some() {
            opening.step1 = step1;
        }
        if slowed {
            self.open_slowed(key);
        }
        self.look_again(wait);
    }

    fn open_slowed(&self, key: MemberKey) {
        let notice = json!({ "type": OPEN_SLOWED_TYPE }).to_string();
        self.send(key, Kind::Stateless, &protocol::text(&notice));
    }

    fn look_again(&mut self, wait: Duration) {
        let at = Instant::now() + wait;
        self.open_at = Some(self.open_at.map_or(at, |open_at| open_at.min(at)));
    }

    /// Waiting step 1s and queries look at their users' budgets again, in
    /// the order they began to wait: a user's large answers go one at a
    /// time, each charged before the next is looked at, and the rest wait
    /// on. A user in a timeout meanwhile joins again when it ends and asks
    /// again then, so their waiting opens are dropped.
    async fn release_openings(&mut self) {
        let mut waiting: Vec<(u64, MemberKey)> = self
            .members
            .iter()
            .filter_map(|(key, member)| {
                member.opening.as_ref().map(|opening| (opening.order, *key))
            })
            .collect();
        waiting.sort_unstable();
        for (_, key) in waiting {
            let Some(member) = self.members.get_mut(&key) else {
                continue;
            };
            let Some(opening) = member.opening.take() else {
                continue;
            };
            let user = member.context.user_id.clone();
            if self
                .app
                .allowances
                .remaining(&user, Instant::now())
                .is_some()
            {
                continue;
            }
            if let Some(since) = opening.step1 {
                match self.app.allowances.open_turn(&user, Instant::now()) {
                    Ok(()) => {
                        let mut turn = self.turn(user.clone());
                        let diff = self.encoded(since).await;
                        turn.bytes = self.answer(key, &diff);
                    }
                    Err(wait) => {
                        let step1 = Some(since);
                        self.keep_waiting(key, Opening { step1, ..opening }, wait);
                        continue;
                    }
                }
            }
            if opening.query {
                match self.app.allowances.open_wait(&user, Instant::now()) {
                    Some(wait) => {
                        let step1 = None;
                        self.keep_waiting(key, Opening { step1, ..opening }, wait);
                    }
                    None => {
                        let sent = self.send_awareness_states(key);
                        self.charge_open(key, sent);
                    }
                }
            }
        }
    }

    /// A waiting open looked again and waits on (its member handled nothing
    /// meanwhile: the room awaits its encodes).
    fn keep_waiting(&mut self, key: MemberKey, opening: Opening, wait: Duration) {
        if let Some(member) = self.members.get_mut(&key) {
            member.opening = Some(opening);
        }
        self.look_again(wait);
    }

    fn join(
        &mut self,
        key: MemberKey,
        context: Context,
        out: Outbox,
        socket: String,
    ) -> Result<(), String> {
        if self.app.evictions.blocks(&self.name, false) {
            return Err("collaboration room is being reset".into());
        }
        let user = context.user_id.clone();
        // A writer of a document holding a block this version cannot edit
        // joins read-only and hears why.
        let unsupported = context.access == Access::Write && self.unsupported().is_some();
        let read_only = context.access == Access::Read || unsupported;
        // A writer joining after the maintenance pause ended takes edits again.
        if let Kindly::Source(source) = &mut self.kind
            && !read_only
        {
            source.paused = false;
        }
        out.frame(protocol::message(
            key.1,
            Kind::Joined,
            &[u8::from(!read_only)],
        ));
        self.view_dirty = true;
        let viewer = context.viewer;
        self.members.insert(
            key,
            Member {
                viewer,
                context,
                channel_id: self.app.next_channel.fetch_add(1, Ordering::Relaxed),
                read_only,
                held_read_only: false,
                out,
                socket,
                clients: HashSet::new(),
                unplaced: 0,
                acks: 0,
                opening: None,
            },
        );
        if unsupported && let Some(notice) = self.unsupported() {
            self.send(key, Kind::Stateless, &protocol::text(&notice));
        }
        let sv = self.doc.transact().state_vector();
        use yrs::updates::encoder::Encode;
        self.send(key, Kind::Sync, &sync::encode(sync::STEP1, &sv.encode_v1()));
        if !(viewer || self.awareness.is_empty()) {
            // Past the small-answer floor it waits like an awareness query
            // (Epo 2026-10-20, rate-limit review r6 S-1).
            let now = Instant::now();
            let allowances = &self.app.allowances;
            match allowances.open_wait(&user, now) {
                Some(wait) if !allowances.small_skips(&user, now) => {
                    self.wait_to_open(key, None, true, wait);
                }
                _ => {
                    let sent = self.send_awareness_states(key);
                    self.charge_open(key, sent);
                }
            }
        }
        // A quiz's readers get the matching and ordering lists as they stand.
        if let Kindly::Note(note) = &self.kind
            && let Some(reader) = &note.reader
        {
            let all: Vec<_> = reader
                .all()
                .into_iter()
                .map(|(part, list)| (part, Some(list)))
                .collect();
            let message = items::quiz::reader_message(true, &all).to_string();
            self.send(key, Kind::Stateless, &protocol::text(&message));
        }
        Ok(())
    }

    /// The `room-read-only` notice of a material room holding a block this
    /// version cannot read; none for any other room.
    fn unsupported(&self) -> Option<String> {
        match &self.kind {
            Kindly::Note(note) if note.unlisted => Some(
                json!({ "code": "unsupported_block", "room": self.name, "type": "room-read-only" })
                    .to_string(),
            ),
            _ => None,
        }
    }

    fn leave(&mut self, key: MemberKey) {
        let Some(member) = self.members.remove(&key) else {
            return;
        };
        self.view_dirty = true;
        if let Kindly::Source(_) = &self.kind {
            self.app.handoff().closed(&self.name, member.channel_id);
        }
        // Its awareness states go, as Hocuspocus removes a closed connection's
        // (not one another channel of its user took over since).
        for client in member.clients {
            if let Some(state) = self.awareness.get_mut(&client)
                && state.owner == Some(key)
            {
                if !state.entry.removed() {
                    state.entry.clock += 1;
                    state.entry.state = "null".into();
                }
                state.owner = None;
                self.changed_awareness.insert(client);
            }
        }
        if !self.changed_awareness.is_empty() {
            self.schedule_flush();
        }
    }

    /// Refuses a channel for good: it hears why (`payloads`), then CLOSED.
    fn refuse(&mut self, key: MemberKey, payloads: &[String], reason: &str) {
        for payload in payloads {
            self.send(key, Kind::Stateless, &protocol::text(payload));
        }
        self.send(key, Kind::Closed, &protocol::closed(0, reason));
        if let Some(member) = self.members.get(&key) {
            member.out.channel_closed(key.1);
        }
        self.leave(key);
    }

    fn schedule_flush(&mut self) {
        if self.flush_at.is_none() {
            self.flush_at = Some(Instant::now() + FLUSH_WINDOW);
        }
    }

    /// The window goes out: each channel gets the merge of the updates it did
    /// not send, the awareness of clients it does not own and its ACK, in one
    /// frame.
    fn flush(&mut self) {
        self.flush_at = None;
        self.send_to_peer();
        let window = std::mem::take(&mut self.window);
        let senders: HashSet<MemberKey> = window.iter().filter_map(|(sender, _)| *sender).collect();
        let everyone = merge(window.iter().map(|(_, update)| update.as_slice()));
        let changed: Vec<u64> = std::mem::take(&mut self.changed_awareness)
            .into_iter()
            .collect();
        let keys: Vec<MemberKey> = self.members.keys().copied().collect();
        for key in keys {
            let mut frame = BytesMut::new();
            let update = if senders.contains(&key) {
                merge(
                    window
                        .iter()
                        .filter(|(sender, _)| *sender != Some(key))
                        .map(|(_, update)| update.as_slice()),
                )
            } else {
                everyone.clone()
            };
            if let Some(update) = update {
                protocol::encode(
                    &mut frame,
                    key.1,
                    Kind::Sync,
                    &sync::encode(sync::UPDATE, &update),
                );
            }
            let Some(member) = self.members.get_mut(&key) else {
                continue;
            };
            let entries: Vec<&awareness::Entry> = changed
                .iter()
                .filter(|client| !(member.viewer || member.clients.contains(client)))
                .filter_map(|client| self.awareness.get(client).map(|state| &state.entry))
                .collect();
            if !entries.is_empty() {
                protocol::encode(
                    &mut frame,
                    key.1,
                    Kind::Awareness,
                    &awareness::encode(entries.into_iter()),
                );
            }
            if member.acks > 0 {
                protocol::encode(&mut frame, key.1, Kind::Ack, &protocol::ack(member.acks));
                member.acks = 0;
            }
            if !frame.is_empty() {
                member.out.frame(frame.freeze());
            }
        }
        // Removed clients are forgotten once their removal went out.
        self.awareness
            .retain(|_, state| !(state.entry.removed() && state.owner.is_none()));
    }

    fn broadcast_update(&mut self, sender: Option<MemberKey>, update: Vec<u8>) {
        if update.is_empty() {
            return;
        }
        self.window.push((sender, update));
        self.schedule_flush();
    }

    fn broadcast_stateless(&self, payload: &str) {
        let text = protocol::text(payload);
        for key in self.members.keys() {
            self.send(*key, Kind::Stateless, &text);
        }
    }

    // ------------------------------------------------------------- sync and updates

    fn on_sync(&mut self, key: MemberKey, payload: &[u8]) {
        let checked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.sync_message(key, payload)
        }));
        if checked.is_err() {
            self.update_panicked(Some(key), payload.len());
        }
    }

    /// A panic in yrs on a crafted message (the Sentry panic hook reported
    /// it). Before an update went in, only its sender is refused (a channel
    /// here; a draft send by its caller); while it went in, the document may
    /// hold part of it, so the room is discarded as one whose store was
    /// refused for good.
    fn update_panicked(&mut self, writer: Option<MemberKey>, bytes: usize) {
        if !self.applying {
            if let Kindly::Note(note) = &mut self.kind {
                note.validator.invalidate();
            }
            if let Some(key) = writer {
                self.refuse(key, &[], "update cannot be checked");
            }
            return;
        }
        self.discard_after_panic("update_panicked", bytes);
    }

    /// A panic in the room's own work, past a point where its document may
    /// hold half an operation: the room is discarded as one whose store was
    /// refused for good (editors drop back to the durable state, the
    /// lineage moves once it unloads).
    fn discard_after_panic(&mut self, reason: &str, bytes: usize) {
        self.applying = false;
        if let Kindly::Note(note) = &mut self.kind {
            note.validator.invalidate();
        }
        let eviction = uuid::Uuid::new_v4().to_string();
        let cause = Cause::new(IncidentKind::SaveRefused, reason);
        let mut payload = match self.kind {
            Kindly::Note(_) => json!({
                "code": "invalid_document",
                "evictionId": eviction,
                "materialId": self.material_id(),
                "room": self.name,
                "type": "document-rejected",
            }),
            Kindly::Source(_) => {
                json!({ "evictionId": eviction, "room": self.name, "type": "authorization-revoked" })
            }
        };
        payload["incident"] = json!({ "kind": cause.kind.as_str(), "reason": cause.reason });
        self.reject_room(cause, bytes, &eviction, payload.to_string());
    }

    /// The state vector of a member's well-formed sync step 1, if `payload`
    /// is one (anything else goes through `on_sync`).
    fn step1_vector(&self, key: MemberKey, payload: &[u8]) -> Option<StateVector> {
        use yrs::updates::decoder::Decode;
        if !self.members.contains_key(&key)
            || (matches!(self.kind, Kindly::Note(_)) && payload.len() > NOTE_MAX_SYNC_BYTES)
        {
            return None;
        }
        match sync::decode(payload) {
            Ok((sync::STEP1, body)) => StateVector::decode_v1(body).ok(),
            _ => None,
        }
    }

    /// The room's state beyond `since`, encoded on the blocking pool; the
    /// room waits for it, as for a store's validation, so nothing changes the
    /// document meanwhile. A panic in the encode is the room's own.
    async fn encoded(&self, since: StateVector) -> Vec<u8> {
        let doc = self.doc.clone();
        tokio::task::spawn_blocking(move || doc.transact().encode_state_as_update_v1(&since))
            .await
            .unwrap_or_else(|error| std::panic::resume_unwind(error.into_panic()))
    }

    fn sync_message(&mut self, key: MemberKey, payload: &[u8]) {
        if !self.members.contains_key(&key) {
            return;
        }
        if matches!(self.kind, Kindly::Note(_)) && payload.len() > NOTE_MAX_SYNC_BYTES {
            self.refuse(key, &[], "malformed update");
            return;
        }
        let Ok((kind, body)) = sync::decode(payload) else {
            self.refuse(key, &[], "malformed sync message");
            return;
        };
        if kind == sync::STEP1 {
            // A well-formed step 1 was answered before this (`step1_vector`).
            self.refuse(key, &[], "malformed state vector");
            return;
        }
        self.app.stats.updates.fetch_add(1, Ordering::Relaxed);
        // Debug builds only: the integration tests' stand-in for an update
        // that panics yrs (the hardened fork has none left to send).
        #[cfg(debug_assertions)]
        if body == IT_PANIC_UPDATE {
            panic!("integration test panic");
        }
        self.on_update(key, body, kind == sync::STEP2);
    }

    fn on_update(&mut self, key: MemberKey, bytes: &[u8], step2: bool) {
        let Some(member) = self.members.get(&key) else {
            return;
        };
        let (context, read_only) = (member.context.clone(), member.read_only);
        match self.admit_update(Some(key), &context, read_only, bytes) {
            Outcome::Admitted => {}
            Outcome::Unheld => self.resync(key, step2, &context),
            Outcome::Refused {
                payloads, reason, ..
            } => self.refuse(key, &payloads, &reason),
        }
    }

    /// A writer's update through every check that reads the room, then the
    /// apply and the broadcast. `writer` is its channel, or none for a draft
    /// send: nothing to acknowledge or tell of a children refusal, and every
    /// editor receives the update.
    fn admit_update(
        &mut self,
        writer: Option<MemberKey>,
        context: &Context,
        read_only: bool,
        bytes: &[u8],
    ) -> Outcome {
        if self.app.evictions.blocks(&self.name, false) {
            return Outcome::refused(Class::Unavailable, "collaboration room is being reset");
        }
        if context.expires_at <= crate::auth::now_seconds() {
            return Outcome::refused(Class::Permission, "collaboration token expired");
        }
        let Ok(update) = ydoc::decode(bytes) else {
            return Outcome::refused(Class::Malformed, "malformed update");
        };
        let changes = ydoc::contains_changes(&self.doc.transact(), &update);
        if read_only {
            if changes {
                return Outcome::refused(
                    Class::Permission,
                    "read-only connection sent a document update",
                );
            }
            self.ack(writer);
            return Outcome::Admitted;
        }
        // A document holding a block this version cannot edit stays as it is
        // (a writer whose access came back after it joined, a draft).
        if changes && let Some(notice) = self.unsupported() {
            return Outcome::Refused {
                payloads: vec![notice],
                reason: UNSUPPORTED_BLOCK.into(),
                class: Class::Permission,
            };
        }
        // A writer that slipped past the maintenance pause: it goes read-only
        // (or to recovery with unsent changes) and its update is refused.
        if let Kindly::Source(source) = &self.kind
            && source.paused
        {
            let payload = json!({
                "epoch": source.room.epoch,
                "fileId": source.room.file_id,
                "type": "source-editing-paused",
            })
            .to_string();
            return Outcome::Refused {
                payloads: vec![payload],
                reason: "Office editing is paused".into(),
                class: Class::Unavailable,
            };
        }
        if markers::check(&self.doc.transact(), &update, self.doc.client_id()).is_err() {
            return Outcome::refused(
                Class::Malformed,
                "client update changed collaboration metadata",
            );
        }
        // Admission and apply run off the runtime's workers while the room
        // waits, unless the update is a small edit of a few structs (REVIEW2
        // S1, REVIEW3 S1): a trial on a copy, a source's exact measure near
        // its cap, or a large update of what the room holds already would
        // hold a worker. This room's messages queue; every other room and
        // socket keeps its thread. A note update touching a media block's
        // attributes is checked on a copy of the room (REVIEW5 M1).
        let heavy = match &self.kind {
            // The note scan reads Plate content; an item room's admission
            // copies only past its own bound.
            Kindly::Note(note) if note.model == crate::model::Model::Note => {
                notes::limits::heavy(&self.doc.transact(), &update, bytes.len(), &note.kind)
            }
            Kindly::Note(_) => !ydoc::applies_inline(
                &self.doc.transact(),
                &ydoc::Incoming::new(&update),
                bytes.len(),
            ),
            Kindly::Source(source) => {
                !ydoc::applies_inline(
                    &self.doc.transact(),
                    &ydoc::Incoming::new(&update),
                    bytes.len(),
                ) || source.estimate.bytes + bytes.len() as u64
                    > sources::admission_cap(source.state_cap)
            }
        };
        let mut admit = || match &mut self.kind {
            Kindly::Note(note) => match note.validator.admit(&self.doc, &update) {
                crate::model::Admitted::Accepted => Verdict::Accept,
                crate::model::Admitted::Unheld => Verdict::Unheld,
                crate::model::Admitted::Limit(code, metrics) => Verdict::Limit(code, metrics),
                crate::model::Admitted::Refused(message) => Verdict::Refused(message),
            },
            Kindly::Source(source) => {
                match sources::admit_update(
                    &self.doc,
                    source.format,
                    bytes,
                    &mut source.estimate,
                    source.state_cap,
                ) {
                    sources::Admission::Accept => Verdict::Accept,
                    sources::Admission::Unheld => Verdict::Unheld,
                    sources::Admission::Refuse(refusal) => Verdict::Source(refusal),
                }
            }
        };
        let verdict = if heavy {
            tokio::task::block_in_place(admit)
        } else {
            admit()
        };
        match verdict {
            Verdict::Unheld => return Outcome::Unheld,
            Verdict::Accept => {}
            Verdict::Source(sources::Refusal::Malformed(message)) => {
                return Outcome::refused(Class::Malformed, message);
            }
            Verdict::Source(refusal) => {
                return self.source_update_refused(writer, context, &refusal, bytes.len());
            }
            Verdict::Limit(code, metrics) => {
                let payload = self.rejection_payload(code, metrics, None);
                incidents::record(
                    &self.app,
                    vec![Incident {
                        cause: Cause::new(IncidentKind::OverLimit, code.as_str()),
                        room: self.name.clone(),
                        size_bytes: Some(bytes.len() as u64),
                        user_id: Some(context.user_id.clone()),
                    }],
                );
                return Outcome::Refused {
                    payloads: vec![payload],
                    reason: "invalid material document".into(),
                    class: Class::Limit,
                };
            }
            // Refused on entry (Epo 2026-10-18): the room keeps its state, the
            // writer's editor reloads it on a fresh document and channel on
            // the same socket, and only this channel closes.
            Verdict::Refused(error) => {
                let payload = json!({
                    "code": "invalid_document",
                    "materialId": self.material_id(),
                    "room": self.name,
                    "type": "document-rejected",
                });
                return Outcome::Refused {
                    payloads: vec![payload.to_string()],
                    reason: error,
                    class: Class::Malformed,
                };
            }
        }
        self.placed(writer, context);
        if !changes {
            self.ack(writer);
            return Outcome::Admitted;
        }
        let mut applied = 0;
        self.applying = true;
        if let Some(marker) = self.markers.write(&self.doc, context) {
            applied += marker.len();
            self.broadcast_update(None, marker);
        }
        // A source room's estimate also takes off what the update's deletes
        // freed (Epo 2026-10-19).
        let seed = match &self.kind {
            Kindly::Source(source) => Some(source.seed.as_ref()),
            Kindly::Note(_) => None,
        };
        let apply = || match seed {
            Some(seed) => ydoc::apply_freeing(&self.doc, update, seed),
            None => ydoc::apply(&self.doc, update).map(|content| (content, 0)),
        };
        let content = if heavy {
            tokio::task::block_in_place(apply)
        } else {
            apply()
        };
        self.applying = false;
        let (content, freed) = match content {
            Ok(content) => content,
            Err(error) => {
                return Outcome::refused(
                    Class::Malformed,
                    format!("update cannot be applied: {error}"),
                );
            }
        };
        applied += content.len();
        if let Kindly::Source(source) = &mut self.kind {
            source.estimate.applied(applied as u64, freed);
        }
        self.ack(writer);
        if !content.is_empty() {
            self.content_changed();
            self.broadcast_update(writer, content);
            self.repair_on_entry(bytes, heavy);
            // A paste, undo or replayed draft that wrote child ids gets a
            // children pass; typing writes none and costs a decode.
            if matches!(&self.kind, Kindly::Note(note) if note.model == crate::model::Model::Note)
                && let Ok(update) = ydoc::decode(bytes)
                && notes::children::child_writes(&self.doc.transact(), &update).is_some()
            {
                self.child_passes.push_back(ChildPass {
                    actor: context.user_id.clone(),
                    update: bytes.to_vec(),
                    notify: writer,
                });
                self.next_child_pass();
            }
        }
        Outcome::Admitted
    }

    /// The cheap repairs after a writer's update went in (Epo 2026-10-19:
    /// repaired on entry first), as a server transaction in the same flush:
    /// keys no node carries stripped, an emptied note's paragraph, an emptied
    /// set's blank card (`Model::repair_on_entry`). O(update), off the async
    /// workers for an update that applied off them.
    fn repair_on_entry(&mut self, bytes: &[u8], heavy: bool) {
        let Kindly::Note(note) = &self.kind else {
            return;
        };
        let (model, kind) = (note.model, note.kind.clone());
        if !model.repairs() {
            return;
        }
        let repair = || {
            let update = ydoc::decode(bytes).ok()?;
            let mut txn = self.doc.transact_mut();
            let repaired = model.repair_on_entry(&mut txn, &update, &kind);
            Some((repaired, ydoc::committed_update(txn)))
        };
        let Some((repaired, fix)) = (if heavy {
            tokio::task::block_in_place(repair)
        } else {
            repair()
        }) else {
            return;
        };
        if fix.is_empty() {
            return;
        }
        log(
            Level::Info,
            "room repaired an edit",
            json!({ "repaired": repaired, "room": self.name }),
        );
        if let Kindly::Note(note) = &mut self.kind {
            // Content the validator did not admit: its growth bound is stale.
            note.validator.invalidate();
        }
        self.broadcast_update(None, fix);
    }

    /// The writer's update was placed: its channel's unplaceable count and
    /// the step 2 incident's once-per-user mark start over.
    fn placed(&mut self, writer: Option<MemberKey>, context: &Context) {
        if let Some(member) = writer.and_then(|key| self.members.get_mut(&key)) {
            member.unplaced = 0;
        }
        self.app.unplaced.placed(&self.name, &context.user_id);
    }

    /// A source update past the state cap or outside the Office roots: the
    /// sender hears it is unrecoverable (it stops resending), one incident,
    /// and the channel closes.
    fn source_update_refused(
        &mut self,
        writer: Option<MemberKey>,
        context: &Context,
        refusal: &sources::Refusal,
        bytes: usize,
    ) -> Outcome {
        self.placed(writer, context);
        let Kindly::Source(source) = &self.kind else {
            return Outcome::refused(Class::Malformed, refusal.message());
        };
        let payload = json!({
            "checkpointIds": [],
            "epoch": source.room.epoch,
            "fileId": source.room.file_id,
            "recoverable": false,
            "type": "source-checkpoint-failed",
        })
        .to_string();
        let (cause, class) = match refusal {
            sources::Refusal::StateBytes => (
                Cause::new(IncidentKind::OverLimit, "source_state_bytes"),
                Class::Limit,
            ),
            _ => (
                Cause::new(IncidentKind::SaveRefused, "office_update"),
                Class::Malformed,
            ),
        };
        incidents::record(
            &self.app,
            vec![Incident {
                cause,
                room: self.name.clone(),
                size_bytes: Some(bytes as u64),
                user_id: Some(context.user_id.clone()),
            }],
        );
        Outcome::Refused {
            payloads: vec![payload],
            reason: refusal.message().to_owned(),
            class,
        }
    }

    /// A channel's handled update or step 2, acknowledged in the next flush.
    fn ack(&mut self, writer: Option<MemberKey>) {
        if let Some(key) = writer {
            self.acked(key);
        }
    }

    fn acked(&mut self, key: MemberKey) {
        if let Some(member) = self.members.get_mut(&key) {
            member.acks += 1;
            self.schedule_flush();
        }
    }

    fn content_changed(&mut self) {
        let now = Instant::now();
        self.store.dirty = true;
        self.store.first_change.get_or_insert(now);
        self.store.last_change = Some(now);
        self.idle_at = None;
    }

    /// `resyncUnheld`: drop the update and send the channel step 1; the
    /// client's step 2 brings everything the room lacks. Two unplaceable step
    /// 2 replies in a row close the channel.
    fn resync(&mut self, key: MemberKey, step2: bool, context: &Context) {
        let Some(member) = self.members.get_mut(&key) else {
            return;
        };
        member.unplaced = if step2 { member.unplaced + 1 } else { 0 };
        if member.unplaced >= MAX_UNPLACED_STEPS {
            let socket = member.socket.clone();
            let kind = match self.kind {
                Kindly::Note(_) => "note",
                Kindly::Source(_) => "source",
            };
            let stage = format!("{kind}_step2_unplaced");
            observe::capture(
                &format!("{kind} sync step 2 cannot be placed in the room"),
                None,
                &[
                    ("room", &self.name),
                    ("socket_id", &socket),
                    ("stage", &stage),
                    ("user_id", &context.user_id),
                ],
            );
            if self.app.unplaced.first(&self.name, &context.user_id) {
                incidents::record(
                    &self.app,
                    vec![Incident {
                        cause: Cause {
                            kind: IncidentKind::Step2Unplaced,
                            reason: None,
                        },
                        room: self.name.clone(),
                        size_bytes: None,
                        user_id: Some(context.user_id.clone()),
                    }],
                );
            }
            self.refuse(key, &[], "sync step 2 cannot be placed in the room");
            return;
        }
        use yrs::updates::encoder::Encode;
        let sv = self.doc.transact().state_vector().encode_v1();
        self.send(key, Kind::Sync, &sync::encode(sync::STEP1, &sv));
        // Handled (dropped for the resync): its ACK follows the step 1.
        self.acked(key);
    }

    fn rejection_payload(
        &self,
        code: notes::limits::LimitCode,
        metrics: notes::limits::Metrics,
        eviction: Option<&str>,
    ) -> String {
        let mut payload = json!({
            "code": code.as_str(),
            "limits": {
                "maxContentBytes": notes::limits::MAX_CONTENT_BYTES,
                "maxDepth": notes::limits::MAX_DEPTH,
                "maxNodes": notes::limits::MAX_NODES,
            },
            "materialId": self.material_id(),
            "metrics": metrics,
            "room": self.name,
            "type": "document-rejected",
        });
        if let Some(eviction) = eviction {
            payload["evictionId"] = json!(eviction);
        }
        payload.to_string()
    }

    // ------------------------------------------------------------------ awareness

    fn on_awareness(&mut self, key: MemberKey, payload: &[u8]) {
        self.app.stats.awareness.fetch_add(1, Ordering::Relaxed);
        let Ok(entries) = awareness::decode(payload) else {
            self.refuse(key, &[], "malformed awareness update");
            return;
        };
        // A cursor is ~200 B; an entry past this is refused (Epo 2026-10-08).
        if entries
            .iter()
            .any(|entry| entry.state.len() > MAX_AWARENESS_ENTRY)
        {
            self.refuse(key, &[], "awareness entry too large");
            return;
        }
        let Some(member) = self.members.get_mut(&key) else {
            return;
        };
        // A viewer's channel sends no presence (live-items D1).
        if member.viewer {
            return;
        }
        let mut entries = entries;
        if member.read_only {
            for entry in &mut entries {
                without_uploads(entry);
            }
        }
        // Ids another channel of the same user held until now.
        let mut taken_over = Vec::new();
        for entry in entries {
            let current = self.awareness.get(&entry.client);
            // A client id is its user's: another user's channel neither
            // writes nor removes it (Epo 2026-10-19).
            if current
                .is_some_and(|state| state.owner.is_some() && state.user != member.context.user_id)
            {
                continue;
            }
            // y-protocols: a newer clock wins; at the same clock a removal wins.
            let take = match current {
                None => !entry.removed(),
                Some(state) => {
                    state.entry.clock < entry.clock
                        || (state.entry.clock == entry.clock
                            && entry.removed()
                            && !state.entry.removed())
                }
            };
            if !take {
                continue;
            }
            let held = current.and_then(|state| state.owner);
            // The room's cap counts every id it holds, removals not yet sent
            // (forgotten at the next flush) included, so ids added and
            // removed in a loop stay capped too.
            if !entry.removed()
                && held != Some(key)
                && (member.clients.len() >= MAX_CLIENTS_PER_MEMBER
                    || (current.is_none() && self.awareness.len() >= MAX_CLIENTS_PER_ROOM))
            {
                continue;
            }
            if let Some(previous) = held.filter(|previous| *previous != key) {
                taken_over.push((previous, entry.client));
            }
            if entry.removed() {
                member.clients.remove(&entry.client);
            } else {
                member.clients.insert(entry.client);
            }
            self.changed_awareness.insert(entry.client);
            self.awareness.insert(
                entry.client,
                AwarenessEntry {
                    owner: (!entry.removed()).then_some(key),
                    user: member.context.user_id.clone(),
                    entry,
                },
            );
        }
        for (previous, client) in taken_over {
            if let Some(member) = self.members.get_mut(&previous) {
                member.clients.remove(&client);
            }
        }
        if !self.changed_awareness.is_empty() {
            self.schedule_flush();
        }
    }

    /// Sends the room's awareness states to a channel; returns their bytes.
    fn send_awareness_states(&self, key: MemberKey) -> usize {
        if self.members.get(&key).is_none_or(|member| member.viewer) {
            return 0;
        }
        let entries: Vec<&awareness::Entry> = self
            .awareness
            .values()
            .filter(|state| !state.entry.removed())
            .map(|state| &state.entry)
            .collect();
        if entries.is_empty() {
            return 0;
        }
        let states = awareness::encode(entries.into_iter());
        self.send(key, Kind::Awareness, &states);
        states.len()
    }

    // ------------------------------------------------------------------ stateless

    async fn on_stateless(&mut self, key: MemberKey, payload: &str) {
        let Some(member) = self.members.get(&key) else {
            return;
        };
        if member.context.expires_at <= crate::auth::now_seconds() {
            self.refuse(key, &[], "collaboration token expired");
            return;
        }
        let Ok(event) = serde_json::from_str::<Value>(payload) else {
            return;
        };
        let channel = member.channel_id;
        // Debug builds only: the integration tests' panic inside an open
        // write transaction, outside the sync path.
        #[cfg(debug_assertions)]
        if event["type"] == "capy-it-panic" {
            let _txn = self.doc.transact_mut();
            panic!("integration test panic in a transaction");
        }
        if event["type"] == "source-handoff-ready" {
            // The handoff counts a clean writer's answer; it goes read-only.
            if matches!(self.kind, Kindly::Source(_))
                && self.app.handoff().ready(&self.name, channel, &event)
                && let Some(member) = self.members.get_mut(&key)
            {
                member.read_only = true;
                member.held_read_only = true;
                self.view_dirty = true;
            }
            return;
        }
        if event["type"] != "checkpoint-request" || member.read_only {
            return;
        }
        let Some(id) = event["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= MAX_CHECKPOINT_ID)
        else {
            return;
        };
        if let Kindly::Source(_) = &self.kind {
            // A full set is drained by storing now rather than dropping this
            // request; an explicit save stores now, and an idle request waits
            // for the debounced store unless none is waiting
            // (sourceDebounce.ts persistsNow).
            if self.receipts.len() >= MAX_PENDING_CHECKPOINTS {
                self.start_store().await;
            }
            if self.receipts.len() < 2 * MAX_PENDING_CHECKPOINTS
                && !self.receipts.iter().any(|known| known == id)
            {
                self.receipts.push(id.to_owned());
            }
            if event["flush"] == true || !self.store.dirty {
                self.start_store().await;
            }
            return;
        }
        // A note room with nothing waiting to be saved answers at once.
        if self.nothing_to_store() {
            let receipt = json!({ "checkpointIds": [id], "materialId": self.material_id(), "type": "checkpoint-persisted" });
            self.send(key, Kind::Stateless, &protocol::text(&receipt.to_string()));
            return;
        }
        if self.receipts.len() >= MAX_PENDING_CHECKPOINTS {
            return;
        }
        if !self.receipts.iter().any(|known| known == id) {
            self.receipts.push(id.to_owned());
        }
    }

    /// A note room's material id ("" in a source room).
    fn material_id(&self) -> &str {
        match &self.kind {
            Kindly::Note(note) => &note.material_id,
            Kindly::Source(_) => "",
        }
    }

    /// `sourceReceipt`: the source room's receipt for `ids` at `checkpoint`.
    fn source_receipt(&mut self, ids: &[String], checkpoint: u64) {
        let Kindly::Source(source) = &self.kind else {
            return;
        };
        let mut answered = Vec::new();
        self.receipts.retain(|id| {
            if ids.contains(id) {
                answered.push(id.clone());
                false
            } else {
                true
            }
        });
        let receipt = json!({
            "checkpoint": checkpoint,
            "checkpointIds": answered,
            "epoch": source.room.epoch,
            "fileId": source.room.file_id,
            "type": "checkpoint-persisted",
            "yjsVersion": checkpoint,
        });
        self.broadcast_stateless(&receipt.to_string());
    }

    /// `nothingToStore`: no store due or running, no failed snapshot, and no
    /// writer's update newer than the durable state.
    fn nothing_to_store(&self) -> bool {
        !self.store.dirty
            && !self.store.running
            && self.store.retry_at.is_none()
            && !markers::pending(&self.doc)
    }

    // ---------------------------------------------------------------------- stores

    async fn start_store(&mut self) {
        if self.store.running {
            self.store.again = true;
            return;
        }
        if self.app.evictions.blocks(&self.name, true) {
            return;
        }
        if !self.store.dirty && !markers::pending(&self.doc) {
            self.answer_store_waiters(Ok(()));
            // A clean source room's requests are durability receipts at its
            // checkpoint, as storeSource answered them (a reconnect's flush
            // after a reload, an Edit open with no edit).
            if let Kindly::Source(source) = &self.kind
                && self.store.retry_at.is_none()
                && !self.receipts.is_empty()
            {
                let (ids, checkpoint) = (self.receipts.clone(), source.checkpoint);
                self.source_receipt(&ids, checkpoint);
            }
            return;
        }
        if matches!(self.kind, Kindly::Source(_)) {
            self.start_source_store().await;
            return;
        }
        let contributors = match self.markers.claim(&self.doc) {
            Ok(contributors) => contributors,
            Err(error) => {
                let error = StoreFailure::Note(StoreError::Other(error.to_string()));
                self.store_failed(error, Instant::now(), 0, Vec::new());
                return;
            }
        };
        let claimed = self.receipts.clone();
        self.store.dirty = false;
        self.store.first_change = None;
        let started = Instant::now();
        // Checked (and repaired) first: the row holds what a repair wrote.
        let validated = self.checked().await;
        let hidden = markers::live_items(&self.doc);
        let (row, durable) = ydoc::delta_update(&self.doc.transact(), &self.durable, &hidden);
        let (metrics, limit_code) = match validated {
            Ok(validated) => validated,
            Err(error) => {
                self.markers.unclaim(&contributors);
                self.store.dirty = true;
                self.store.first_change.get_or_insert(started);
                self.store_failed(StoreFailure::Note(error), started, row.len(), claimed);
                return;
            }
        };
        let Kindly::Note(note) = &self.kind else {
            return;
        };
        let (material_id, schema, doc_kind) = (note.material_id.clone(), note.schema, note.doc);
        let actors: Vec<String> = {
            let mut actors: Vec<String> = contributors.iter().map(|c| c.user_id.clone()).collect();
            actors.sort();
            actors.dedup();
            actors
        };
        let Some(handle) = self.own_handle() else {
            return;
        };
        self.store.running = true;
        self.view_dirty = true;
        let app = self.app.clone();
        tokio::spawn(async move {
            let result = note_store::append(&app.db, &material_id, schema, doc_kind, &row, &actors)
                .await
                .map_err(StoreFailure::Note);
            let done = StoreDone {
                result,
                started,
                row_bytes: row.len(),
                contributors,
                claimed,
                durable,
                metrics: Some(metrics),
                limit_code,
            };
            let _ = handle.tx.send(RoomCmd::Stored(Box::new(done))).await;
        });
    }

    /// The store's check of the note room ([validate]), off the room's
    /// thread. A document it refuses as invalid gets the canonical repairs
    /// once (Epo 2026-10-19: repaired at save before the reset; an emptied
    /// note or set, repeated top-level ids), as a server transaction every
    /// editor receives, and is checked again.
    async fn checked(
        &mut self,
    ) -> Result<(notes::limits::Metrics, Option<notes::limits::LimitCode>), StoreError> {
        let first = self.check().await;
        let (Err(StoreError::Invalid(reason)), Kindly::Note(note)) = (&first, &self.kind) else {
            return first;
        };
        let (model, kind) = (note.model, note.kind.clone());
        // Its own scope: a transaction is not held across an await.
        let (repaired, fix) = {
            let mut txn = self.doc.transact_mut();
            let repaired = model.repair(&mut txn, &kind);
            (repaired, ydoc::committed_update(txn))
        };
        if fix.is_empty() {
            return first;
        }
        log(
            Level::Info,
            "store repaired the document",
            json!({ "reason": reason, "repaired": repaired, "room": self.name }),
        );
        if let Kindly::Note(note) = &mut self.kind {
            note.validator.invalidate();
        }
        self.broadcast_update(None, fix);
        self.check().await
    }

    /// [validate] of the note room as it is now.
    async fn check(
        &self,
    ) -> Result<(notes::limits::Metrics, Option<notes::limits::LimitCode>), StoreError> {
        let Kindly::Note(note) = &self.kind else {
            return Err(StoreError::Other("not a material room".into()));
        };
        let doc = self.doc.clone();
        let (kind, model) = (note.kind.clone(), note.model);
        let previous = note.durable_metrics;
        let peer = note.validator.peer();
        tokio::task::spawn_blocking(move || validate(&doc, model, &kind, previous, peer))
            .await
            .unwrap_or_else(|error| Err(StoreError::Other(error.to_string())))
    }

    /// This room's registry handle (none once it unloaded).
    fn own_handle(&self) -> Option<RoomHandle> {
        self.app
            .rooms
            .get(&self.name)
            .filter(|handle| handle.id == self.id)
    }

    /// `storeSource`: the room's update since its durable state goes to the
    /// gateway's checkpoint with its effects (an Office room's whole state for
    /// the engine, a text room's effects from the change).
    async fn start_source_store(&mut self) {
        let started = Instant::now();
        // A failed store waits out its backoff; only its retry calls the engine.
        if self.store.retry_at.is_some() {
            self.answer_store_waiters(Err(sources::SourceError::Backoff.to_string()));
            return;
        }
        let pending = sources::failure::pending_source_save(&self.doc.transact());
        if pending == sources::failure::PendingSave::Wait {
            let Kindly::Source(source) = &mut self.kind else {
                return;
            };
            if std::mem::replace(&mut source.pending_reported, true) {
                log(
                    Level::Warn,
                    "source store found pending content",
                    json!({ "room": self.name }),
                );
            } else {
                observe::capture(
                    &sources::SourceError::Pending.to_string(),
                    None,
                    &[("room", &self.name), ("stage", "source_store_pending")],
                );
            }
            self.source_store_failed(sources::SourceError::Pending, started, 0, Vec::new());
            return;
        }
        let contributors = match self.markers.claim(&self.doc) {
            Ok(contributors) => contributors,
            Err(error) => {
                let error = sources::SourceError::Other(error.to_string());
                self.source_store_failed(error, started, 0, Vec::new());
                return;
            }
        };
        let claimed = self.receipts.clone();
        let hidden = markers::live_items(&self.doc);
        let Kindly::Source(source) = &self.kind else {
            return;
        };
        let (room, format) = (source.room.clone(), source.format);
        // O(state) for an Office room (its whole state for the engine) and up
        // to O(text) for a text room (the pending effect spans every edit
        // since the baseline): off the runtime's threads, while the room
        // waits as it does for a note store's validation.
        let (doc, previous, sources) = (
            self.doc.clone(),
            self.durable.clone(),
            self.app.sources.clone(),
        );
        let effect_room = room.clone();
        let computed = tokio::task::spawn_blocking(move || {
            let txn = doc.transact();
            let (row, durable) = ydoc::delta_update(&txn, &previous, &hidden);
            let (state, text) = match format {
                sources::SourceFormat::Text => {
                    (None, Some(sources.text_effects(&effect_room, &txn, &row)))
                }
                _ => (
                    Some(txn.encode_state_as_update_v1(&StateVector::default())),
                    None,
                ),
            };
            (row, durable, state, text)
        })
        .await;
        let (row, durable, state, text) = match computed {
            Ok(computed) => computed,
            Err(error) => {
                self.markers.unclaim(&contributors);
                let error = sources::SourceError::Other(error.to_string());
                self.source_store_failed(error, started, 0, claimed);
                return;
            }
        };
        let text = match text.transpose() {
            Ok(text) => text,
            Err(error) => {
                self.markers.unclaim(&contributors);
                self.source_store_failed(error, started, row.len(), claimed);
                return;
            }
        };
        self.store.dirty = false;
        self.store.first_change = None;
        let mut actors: Vec<String> = Vec::new();
        for contributor in &contributors {
            if !actors.contains(&contributor.user_id) {
                actors.push(contributor.user_id.clone());
            }
        }
        let bytes = state.as_ref().map_or(row.len(), Vec::len);
        let save = sources::Save {
            row,
            state,
            text,
            actors,
            retry_event: self.store.failed_event.clone(),
        };
        let Some(handle) = self.own_handle() else {
            return;
        };
        self.store.running = true;
        self.view_dirty = true;
        let app = self.app.clone();
        tokio::spawn(async move {
            let result = app
                .sources
                .store(&room, save)
                .await
                .map(|saved| (saved.checkpoint as i64, saved.row_bytes))
                .map_err(StoreFailure::Source);
            let row_bytes = result.as_ref().map_or(bytes, |(_, row)| *row as usize);
            let done = StoreDone {
                result: result.map(|(checkpoint, _)| checkpoint),
                started,
                row_bytes,
                contributors,
                claimed,
                durable,
                metrics: None,
                limit_code: None,
            };
            let _ = handle.tx.send(RoomCmd::Stored(Box::new(done))).await;
        });
    }

    fn stored(&mut self, done: StoreDone) {
        self.store.running = false;
        self.view_dirty = true;
        let StoreDone {
            result,
            started,
            row_bytes,
            contributors,
            claimed,
            durable,
            metrics,
            limit_code,
        } = done;
        let version = match result {
            Ok(version) => version,
            Err(error) => {
                self.markers.unclaim(&contributors);
                self.store.dirty = true;
                self.store.first_change.get_or_insert(started);
                self.store_failed(error, started, row_bytes, claimed);
                return;
            }
        };
        let timings = match self.kind {
            Kindly::Note(_) => &self.app.health.material,
            Kindly::Source(_) => &self.app.health.source,
        };
        timings.record(started.elapsed(), true, row_bytes, &self.name);
        // A source save with no writer in it appends nothing (row_bytes 0).
        if row_bytes > 0 || matches!(self.kind, Kindly::Note(_)) {
            self.durable = durable;
            self.app
                .stats
                .log_bytes
                .fetch_add(row_bytes as u64, Ordering::Relaxed);
        }
        if self.store.failed_event.take().is_some() {
            self.app.stats.failed_stores.fetch_sub(1, Ordering::Relaxed);
        }
        self.store.retry_delay = RETRY_FIRST / 2;
        if let Some(cleared) = self.markers.clear(&self.doc, &contributors) {
            self.broadcast_update(None, cleared);
        }
        match &mut self.kind {
            Kindly::Note(note) => {
                // A service edit that landed meanwhile may be ahead.
                note.stored_version = note.stored_version.max(version);
                note.durable_metrics = metrics;
                note.log_bytes += row_bytes as i64;
                note.log_rows += 1;
                let material_id = note.material_id.clone();
                // Claimed receipts, and every waiting one when no writer's
                // update reached the room after the snapshot.
                let mut ids: Vec<String> = Vec::new();
                let everything = !markers::pending(&self.doc) && !self.store.dirty;
                self.receipts.retain(|id| {
                    if everything || claimed.contains(id) {
                        ids.push(id.clone());
                        false
                    } else {
                        true
                    }
                });
                let receipt = json!({
                    "checkpointIds": ids,
                    "limitCode": limit_code.map(|code| code.as_str()),
                    "materialId": material_id,
                    "metrics": metrics,
                    "type": "checkpoint-persisted",
                    "yjsVersion": version,
                });
                self.broadcast_stateless(&receipt.to_string());
            }
            Kindly::Source(source) => {
                source.checkpoint = version as u64;
                source.failing_since = None;
                if row_bytes > 0 {
                    source.log_bytes += row_bytes as i64;
                    source.log_rows += 1;
                }
                self.source_receipt(&claimed, version as u64);
            }
        }
        self.project_on_cadence();
        if self.store.dirty || markers::pending(&self.doc) {
            if self.store.again {
                self.store.again = false;
                self.store.retry_at = Some(Instant::now());
            }
        } else {
            self.answer_store_waiters(Ok(()));
            if let Kindly::Note(note) = &self.kind {
                if note.project_waiters.is_empty() {
                    self.arm_idle();
                } else {
                    self.idle_at = Some(Instant::now());
                }
            }
        }
        self.maybe_fold();
    }

    fn store_failed(
        &mut self,
        error: StoreFailure,
        started: Instant,
        bytes: usize,
        claimed: Vec<String>,
    ) {
        let error = match error {
            StoreFailure::Note(error) => error,
            StoreFailure::Source(error) => {
                self.source_store_failed(error, started, bytes, claimed);
                return;
            }
        };
        self.app
            .health
            .material
            .record(started.elapsed(), false, bytes, &self.name);
        self.app
            .stats
            .store_failures
            .fetch_add(1, Ordering::Relaxed);
        if error.permanent() {
            // Why, under the room's name (which holds the material id): a
            // document the store can never take, such as a pending quiz
            // reference stored before fences were resolved ahead of insertion
            // (live-items REVIEW5 R1), is found in the logs by its note.
            log(
                Level::Warn,
                "store refused the document",
                json!({ "error": error.to_string(), "room": self.name }),
            );
            self.answer_store_waiters(Err(error.to_string()));
            self.reject_after_store(&error, bytes);
            return;
        }
        self.broadcast_stateless(
            &json!({ "materialId": self.material_id(), "type": "checkpoint-failed" }).to_string(),
        );
        // A View waiting on this store's projection serves the stored one now.
        if let Kindly::Note(note) = &mut self.kind {
            for waiter in note.project_waiters.drain(..) {
                let _ = waiter.send(Err(error.to_string()));
            }
        }
        self.retry_later(&error.to_string(), "document_store");
    }

    /// A failed store's retry: reported once per run of failures (each one
    /// still logs its cause), then after 5 s, doubling to 60 s.
    fn retry_later(&mut self, error: &str, stage: &str) {
        match &self.store.failed_event {
            Some(event) => log(
                Level::Warn,
                "store failed again",
                json!({ "error": error, "event_id": event, "room": self.name }),
            ),
            None => {
                self.app.stats.failed_stores.fetch_add(1, Ordering::Relaxed);
                let event =
                    observe::capture(error, None, &[("room", &self.name), ("stage", stage)]);
                self.store.failed_event = Some(event.unwrap_or_default());
            }
        }
        self.schedule_retry();
        self.answer_store_waiters(Err(error.to_owned()));
    }

    fn schedule_retry(&mut self) {
        self.store.retry_delay = (self.store.retry_delay * 2).clamp(RETRY_FIRST, RETRY_MAX);
        self.store.retry_at = Some(Instant::now() + self.store.retry_delay);
        self.view_dirty = true;
    }

    /// `storeSource`'s failure paths: a storage or frozen refusal drops every
    /// writer to view, a save that will always fail (or failed for 5 min
    /// without a success) discards the room and its editors go to recovery,
    /// anything else retries with backoff while editing goes on.
    fn source_store_failed(
        &mut self,
        error: sources::SourceError,
        started: Instant,
        bytes: usize,
        claimed: Vec<String>,
    ) {
        self.app
            .health
            .source
            .record(started.elapsed(), false, bytes, &self.name);
        self.app
            .stats
            .store_failures
            .fetch_add(1, Ordering::Relaxed);
        if error.service_secret() {
            log(
                Level::Error,
                "collaboration service secret rejected by the gateway; source saves fail until it matches",
                json!({ "room": self.name }),
            );
            observe::capture(
                &error.to_string(),
                None,
                &[("room", &self.name), ("stage", "service_secret_rejected")],
            );
        }
        let Kindly::Source(source) = &mut self.kind else {
            return;
        };
        let now = Instant::now();
        let since = *source.failing_since.get_or_insert(now);
        let (epoch, file_id) = (source.room.epoch, source.room.file_id.clone());
        let read_only = error.read_only();
        let permanent = !read_only && error.refused();
        let slow_limit = !(read_only || permanent)
            && now.duration_since(since) >= sources::failure::SLOW_SAVE_LIMIT;
        let recoverable = !(read_only || permanent || slow_limit);
        let payload = if read_only {
            log(
                Level::Warn,
                "source store refused read-only",
                json!({ "error": error.to_string(), "room": self.name }),
            );
            json!({ "room": self.name, "type": "room-read-only" })
        } else {
            let mut payload = json!({
                "checkpointIds": claimed,
                "epoch": epoch,
                "fileId": file_id,
                "recoverable": recoverable,
                "type": "source-checkpoint-failed",
            });
            if let Some(lost) = error.lost_access_field() {
                payload["lostAccess"] = json!(lost);
            }
            payload
        };
        self.broadcast_stateless(&payload.to_string());
        if recoverable {
            if matches!(error, sources::SourceError::Pending) {
                // Reported when found; the live room saves once it integrates.
                self.schedule_retry();
                self.answer_store_waiters(Err(error.to_string()));
            } else {
                self.retry_later(&error.to_string(), "document_store");
            }
            return;
        }
        if !read_only {
            observe::capture(
                &error.to_string(),
                None,
                &[("room", &self.name), ("stage", "document_store")],
            );
        }
        if self.store.failed_event.take().is_some() {
            self.app.stats.failed_stores.fetch_sub(1, Ordering::Relaxed);
        }
        if let Kindly::Source(source) = &mut self.kind {
            source.failing_since = None;
        }
        let cause = incidents::Cause::from_source(&error.discard_cause(slow_limit));
        self.answer_store_waiters(Err(error.to_string()));
        let eviction = uuid::Uuid::new_v4().to_string();
        let payload = json!({
            "evictionId": eviction,
            "incident": { "kind": cause.kind.as_str(), "reason": cause.reason },
            "room": self.name,
            "type": "authorization-revoked",
        })
        .to_string();
        self.reject_room(cause, bytes, &eviction, payload);
    }

    fn answer_store_waiters(&mut self, result: Result<(), String>) {
        for waiter in self.store.waiters.drain(..) {
            let _ = waiter.send(result.clone());
        }
    }

    /// A store refused for good discards the room: every editor drops back to
    /// the last durable state (`rejectRoom`, `rejectInvalidDocumentRoom`,
    /// `rejectAuthorizationRoom`).
    fn reject_after_store(&mut self, error: &StoreError, bytes: usize) {
        let eviction = uuid::Uuid::new_v4().to_string();
        let cause = match error {
            StoreError::Limit { code, .. } => Cause::new(IncidentKind::OverLimit, code.as_str()),
            StoreError::Invalid(_) => Cause::new(IncidentKind::SaveRefused, "invalid_document"),
            other => Cause::new(IncidentKind::DiscardUnsaved, &other.incident_reason()),
        };
        let mut payload: Value = match error {
            StoreError::Limit { code, metrics } => {
                serde_json::from_str(&self.rejection_payload(*code, *metrics, Some(&eviction)))
                    .unwrap_or(Value::Null)
            }
            StoreError::Invalid(_) => json!({
                "code": "invalid_document",
                "evictionId": eviction,
                "materialId": self.material_id(),
                "room": self.name,
                "type": "document-rejected",
            }),
            _ => {
                json!({ "evictionId": eviction, "room": self.name, "type": "authorization-revoked" })
            }
        };
        payload["incident"] = json!({ "kind": cause.kind.as_str(), "reason": cause.reason });
        self.reject_room(cause, bytes, &eviction, payload.to_string());
    }

    /// Discards the room here and on every other instance (the eviction
    /// channel, as `publishRoomEviction`): its editors hear `payload` (without
    /// the incident) and close, and the unsaved state goes with the room,
    /// whose lineage moves once it unloads.
    fn reject_room(&mut self, cause: Cause, bytes: usize, eviction: &str, payload: String) {
        if self.discard_pending.is_some() {
            return;
        }
        self.app.evictions.reject(&self.name);
        self.record_room_incidents(&cause, Some(bytes as u64));
        self.broadcast_stateless(&incidents::client_payload(&payload));
        let keys: Vec<MemberKey> = self.members.keys().copied().collect();
        for key in keys {
            self.refuse(key, &[], "collaboration room is being reset");
        }
        // This instance runs it now; the echo from the channel is a repeat
        // (a material eviction runs per room of its epochs).
        self.app.pubsub.seen(eviction);
        self.app.pubsub.seen(&format!("{eviction}:{}", self.name));
        let app = self.app.clone();
        let room = self.name.clone();
        tokio::spawn(async move {
            if let Err(error) = crate::pubsub::publish_eviction(&app, &payload).await {
                observe::capture(
                    &error,
                    None,
                    &[("room", &room), ("stage", "authorization_eviction_publish")],
                );
            }
        });
        self.store.dirty = false;
        self.store.retry_at = None;
        self.discard_pending = Some(cause);
        self.view_dirty = true;
    }

    // ---------------------------------------------------------------- projection

    /// After a store: a note whose edits have not paused long enough for the
    /// idle projection projects anyway once `projection_cadence` passed since
    /// its last projection. The live document may already hold newer edits,
    /// so this projects the durable state from the store.
    fn project_on_cadence(&mut self) {
        let handle = self.own_handle();
        let cadence = self.app.config.projection_cadence;
        let Kindly::Note(note) = &mut self.kind else {
            return;
        };
        if note.projecting
            || note.stored_version <= note.projected_version
            || note.projected_at.elapsed() < cadence
        {
            return;
        }
        let Some(handle) = handle else {
            return;
        };
        note.projecting = true;
        let (app, material_id, version) = (
            self.app.clone(),
            note.material_id.clone(),
            note.stored_version,
        );
        tokio::spawn(async move {
            let projected = match projection::project_durable(&app, &material_id).await {
                Ok(projected) => RoomCmd::Projected(projected, Ok(())),
                Err(error) => RoomCmd::Projected(version, Err(error)),
            };
            let _ = handle.tx.send(projected).await;
        });
    }

    fn arm_idle(&mut self) {
        let Kindly::Note(note) = &self.kind else {
            return;
        };
        if note.stored_version <= note.projected_version {
            return;
        }
        let from = self.store.last_change.unwrap_or_else(Instant::now);
        self.idle_at = Some((from + self.app.config.projection_idle).max(Instant::now()));
    }

    async fn start_projection(&mut self) {
        let Kindly::Note(note) = &mut self.kind else {
            return;
        };
        if note.projecting {
            return;
        }
        // A quiz's other document may have stored since this room last did:
        // an on-demand request projects both from the store.
        let asked = note.model.quiz() && !note.project_waiters.is_empty();
        if (note.stored_version <= note.projected_version && !asked) || self.store.dirty {
            let version = note.projected_version;
            for waiter in note.project_waiters.drain(..) {
                let _ = waiter.send(Ok(version));
            }
            return;
        }
        note.projecting = true;
        let version = note.stored_version;
        let material_id = note.material_id.clone();
        let app = self.app.clone();
        if note.model.quiz() {
            let Some(handle) = self.own_handle() else {
                return;
            };
            tokio::spawn(async move {
                let projected = match projection::project_durable(&app, &material_id).await {
                    Ok(projected) => RoomCmd::Projected(projected, Ok(())),
                    Err(error) => RoomCmd::Projected(version, Err(error)),
                };
                let _ = handle.tx.send(projected).await;
            });
            return;
        }
        // Read here, so the content is exactly the durable state at `version`;
        // the room waits for it as for a store's validation.
        let content = projection::content_of(self.doc.clone(), note.model).await;
        let Some(handle) = self
            .app
            .rooms
            .get(&self.name)
            .filter(|handle| handle.id == self.id)
        else {
            return;
        };
        tokio::spawn(async move {
            let result = match content {
                Ok(content) => {
                    projection::project(&app, &material_id, version, &content, None).await
                }
                Err(error) => Err(error),
            };
            let _ = handle.tx.send(RoomCmd::Projected(version, result)).await;
        });
    }

    fn projected(&mut self, version: i64, result: Result<(), String>) {
        let Kindly::Note(note) = &mut self.kind else {
            return;
        };
        note.projecting = false;
        match &result {
            Ok(()) => {
                note.projected_version = note.projected_version.max(version);
                note.projected_at = Instant::now();
                let payload = json!({ "materialId": note.material_id, "type": "projection-updated", "yjsVersion": version });
                for waiter in note.project_waiters.drain(..) {
                    let _ = waiter.send(Ok(version));
                }
                self.broadcast_stateless(&payload.to_string());
            }
            Err(error) => {
                for waiter in note.project_waiters.drain(..) {
                    let _ = waiter.send(Err(error.clone()));
                }
            }
        }
    }

    // -------------------------------------------------------------------- unload

    async fn unload(&mut self) {
        log(
            Level::Info,
            "room_unload",
            json!({ "bytes": stored_bytes(&self.kind), "room": self.name }),
        );
        for reply in self.forced_unload.drain(..) {
            let _ = reply.send(());
        }
        let note = match &self.kind {
            Kindly::Note(note) => note,
            Kindly::Source(source) => {
                unlog_bytes(&self.app, source.log_bytes.max(0) as u64);
                let (app, room, generation) = (
                    self.app.clone(),
                    source.room.clone(),
                    source.hold.generation(),
                );
                let discarded = self.discard_pending.take();
                tokio::spawn(async move {
                    app.sources.forget(&room, generation).await;
                    if let Some(cause) = discarded {
                        crate::eviction::move_lineage(&app, &room.name(), cause).await;
                        return;
                    }
                    // Compaction while the room is empty (DESIGN.md 3.5); a
                    // deferred publication's rebuild may follow now.
                    if let Err(error) = app.sources.fold(&room).await {
                        observe::capture(
                            &error.to_string(),
                            None,
                            &[("room", &room.name()), ("stage", "fold")],
                        );
                    }
                    app.handoff().schedule_rebuild(&room.file_id);
                });
                return;
            }
        };
        unlog_bytes(&self.app, note.log_bytes.max(0) as u64);
        let app = self.app.clone();
        let doc = self.doc.clone();
        let (model, doc_kind) = (note.model, note.doc);
        let (material_id, schema, stored, projected) = (
            note.material_id.clone(),
            note.schema,
            note.stored_version,
            note.projected_version,
        );
        let discarded = self.discard_pending.take();
        let room = self.name.clone();
        tokio::spawn(async move {
            if let Some(cause) = discarded {
                crate::eviction::move_lineage(&app, &room, cause).await;
                return;
            }
            // The projection reads the unloaded document, the fold the rows:
            // neither waits for the other.
            let projecting = async {
                if stored > projected
                    && let Err(error) = if model.quiz() {
                        projection::project_durable(&app, &material_id)
                            .await
                            .map(|_| ())
                    } else {
                        projection::project_doc(&app, &material_id, stored, doc, model).await
                    }
                {
                    log(
                        Level::Warn,
                        "unload projection failed",
                        json!({ "error": error, "room": material_id }),
                    );
                }
            };
            // Compaction while the room is empty (DESIGN.md 3.5).
            let folding = async {
                if let Err(error) =
                    note_store::fold(&app.db, &material_id, schema, doc_kind, None).await
                {
                    observe::capture(
                        &error.to_string(),
                        None,
                        &[("room", &material_id), ("stage", "fold")],
                    );
                }
            };
            tokio::join!(projecting, folding);
        });
    }
}

/// What admission decided about a writer's update.
enum Verdict {
    Accept,
    Unheld,
    /// A material room's limit (`document-rejected` with the code).
    Limit(notes::limits::LimitCode, notes::limits::Metrics),
    /// A material room's refusal for any other reason.
    Refused(String),
    Source(sources::Refusal),
}

/// Merges the window's updates; `None` when there are none.
fn merge<'a>(updates: impl Iterator<Item = &'a [u8]>) -> Option<Vec<u8>> {
    let updates: Vec<&[u8]> = updates.collect();
    match updates.len() {
        0 => None,
        1 => Some(updates[0].to_vec()),
        _ => yrs::merge_updates_v1(updates).ok(),
    }
}

/// The store's check of the whole document (DESIGN.md 3.2): the Plate value
/// is canonical for the material's kind, and over a bound only if it shrank.
/// A quiz document counts with its other document's metrics (`peer`).
fn validate(
    doc: &Doc,
    model: crate::model::Model,
    kind: &str,
    previous: Option<notes::limits::Metrics>,
    peer: Option<notes::limits::Metrics>,
) -> Result<(notes::limits::Metrics, Option<notes::limits::LimitCode>), StoreError> {
    let txn = doc.transact();
    model.assert_roots(&txn).map_err(StoreError::Invalid)?;
    if let crate::model::Model::Item(item) = model {
        item.check_caps(&txn).map_err(StoreError::Invalid)?;
    }
    let value = model.document_value(&txn).map_err(StoreError::Invalid)?;
    // A live quiz holds questions as typed; its projection keeps the
    // complete ones (D4), so only the limits apply here.
    if !model.quiz() {
        notes::material::assert_canonical(&value, kind)
            .map_err(|error| StoreError::Invalid(error.0))?;
    }
    let metrics = notes::limits::measure_value(&value);
    let combined = items::combine(&metrics, peer.as_ref());
    let code = notes::limits::limit_code(&combined);
    let previous = previous.map(|previous| items::combine(&previous, peer.as_ref()));
    if let Some(code) = code
        && !notes::limits::recovers(&combined, previous.as_ref())
    {
        return Err(StoreError::Limit {
            code,
            metrics: combined,
        });
    }
    Ok((metrics, code))
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
        None => std::future::pending().await,
    }
}

/// A read-only channel names no uploads in presence (REVIEW5 E2): only a
/// writer uploads, and a listed id shows that block as uploading to every
/// editor. Every entry is parsed (a key may be escaped, REVIEW5 R1), within
/// the 64 KiB entry cap and serde_json's nesting limit, and loses the field.
/// An entry serde_json refuses (an unpaired surrogate escape, which a
/// browser's `JSON.parse` takes) becomes a removal (REVIEW5 R1b).
fn without_uploads(entry: &mut awareness::Entry) {
    if entry.removed() {
        return;
    }
    match serde_json::from_str(&entry.state) {
        Ok(serde_json::Value::Object(mut state)) => {
            if state.remove("uploads").is_some() {
                entry.state = serde_json::Value::Object(state).to_string();
            }
        }
        Ok(_) => {}
        Err(_) => entry.state = "null".into(),
    }
}
