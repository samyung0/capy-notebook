//! One task per loaded room (DESIGN.md 4): it owns the yrs document (a
//! canvas's board: its saved bytes, `board.rs`) and does every check that
//! reads it, then the apply; it batches broadcasts over the
//! 30 ms flush window with no echo to the sender, acknowledges each writer's
//! messages once per window, keeps awareness as bytes, writes contributor
//! markers once per store window, stores with delta rows, projects notes on
//! idle and unloads once empty and clean. Note rooms validate Plate content
//! (`notes`); source rooms admit and store through `sources`.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use bytes::BytesMut;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use yrs::block::ClientID;
use yrs::{Doc, ReadTxn, StateVector, Transact};

use crate::app::{GroupClaim, Outbox, RoomHandle, RoomView, Shared, ViewState, draft_slot};
use crate::auth::{Access, Context, RoomName};
use crate::board::{self, Board};
use crate::client_ids::{self, ClientIds};
use crate::drafts::{Class, Refused};
use crate::incidents::{self, Cause, Incident, Kind as IncidentKind};
use crate::markers::{self, Contributor, Markers};
use crate::note_store::{self, StoreError};
use crate::observe::{self, Level, log};
use crate::presence::Fields;
use crate::projection;
use crate::protocol::{self, Kind, awareness, sync};
use crate::sessions::Sessions;
use crate::work::WorkKind;

/// Broadcasts merge over this window (approved by Epo, 2026-10-04).
pub const FLUSH_WINDOW: Duration = Duration::from_millis(30);
/// Checkpoint requests waiting per room.
const MAX_PENDING_CHECKPOINTS: usize = 64;
const MAX_CHECKPOINT_ID: usize = 128;
/// Consecutive unplaceable step 2 replies before a channel closes.
pub const MAX_UNPLACED_STEPS: u32 = 2;
/// The largest sync message a note room takes, and the most one group of
/// pieces gathers there: twice the 2 MiB of unsaved edits an offline editor
/// may hold, so its reconnect always fits (Epo, 2026-10-08). Source rooms
/// take whole states up to the frame cap, and groups up to their state cap.
pub const NOTE_MAX_SYNC_BYTES: usize = 4 * 1024 * 1024;
/// The largest awareness state a room keeps and relays (Epo 2026-10-28): a
/// note's caret is ~24 B, its largest state with the app's ids (100 uploads,
/// 16 block runs of UUIDs) 3.8 KB, and its sender leaves the block runs out
/// past this (Q524).
pub const MAX_AWARENESS_ENTRY: usize = 4 * 1024;
/// Awareness client ids a room keeps (Epo 2026-10-19); a channel writes only
/// its session's (Q213). A new id past the cap is not kept.
pub const MAX_CLIENTS_PER_ROOM: usize = 256;
/// Why a note room holding a block the embed catalog does not list refuses
/// every writer (Epo 2026-10-13): the browser shows it for the
/// `unsupported_block` code.
pub const UNSUPPORTED_BLOCK: &str = "this document has a block this version can't edit";
/// What a channel hears when its open waits on its user's open budget
/// (`OPEN_SLOWED_TYPE` in src/features/collaboration/roomProvider.ts): the
/// editor keeps loading and says so after a while, never offline.
pub const OPEN_SLOWED_TYPE: &str = "open-slowed";
/// What a note room tells a synced editor once a store committed, and once
/// it answered its step 1: `{"type": "stored", "version": v}`, the stored
/// version it now holds (`STORED_TYPE` in
/// src/features/collaboration/roomProvider.ts). The editor answers
/// `{"type": "ack", "version": v}`, never above the version its oldest
/// unsent edit was made at, and its session counts at that (`sessions.rs`).
/// An edit stays unsent until the second store's notice after its ACK (the
/// first notice on a channel answers its step 1 and is no store's; review r1
/// H1): stores run one at a time, so that store began after the edit was
/// admitted and holds it.
pub const STORED_TYPE: &str = "stored";
const ACK_TYPE: &str = "ack";
/// The room's presence (Epo 2026-10-20): the editors in it, for the avatar
/// group and cursor labels (`PRESENCE_TYPE` in
/// src/features/collaboration/presence.ts). It goes out a flush window after
/// a change and at most once a second, listing at most `MAX_PRESENCE`
/// connections, oldest first.
pub const PRESENCE_TYPE: &str = "room-presence";
pub const PRESENCE_EVERY: Duration = Duration::from_secs(1);
pub const MAX_PRESENCE: usize = 64;
/// A board folds once its log passes this (Epo 2026-11-24, bytes-room
/// plan step 2), or at the store's own rule, whichever comes first.
const BOARD_TAIL: i64 = 256 * 1024;
/// Failed stores retry after 5 s, doubling to 60 s.
const RETRY_FIRST: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(60);
/// A client-id row batch that failed is tried again after these waits; a
/// batch failing them all is logged as lost (r2 S3).
const ROW_RETRIES: [Duration; 4] = [
    Duration::from_millis(250),
    Duration::from_secs(1),
    Duration::from_secs(4),
    Duration::from_secs(10),
];

pub type MemberKey = (u64, u64);

/// A canvas's board room's answer to [RoomCmd::LiveNote] and
/// [RoomCmd::Snapshot].
pub struct IsBoard;

/// Messages to a room task.
pub enum RoomCmd {
    Join {
        key: MemberKey,
        context: Context,
        /// The session's client id the JOIN names (`client_ids.rs`).
        client: Option<u64>,
        /// The stored version the session holds (`sessions.rs`).
        version: Option<u64>,
        /// The editing session's random id (Q472).
        session_id: Option<u128>,
        out: Outbox,
        socket: String,
        /// An embed's channel inside its note's (Epo 2026-10-20).
        inside: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// A channel's Leave; `clean`: its tab holds no unsent edits for the
    /// document (Q236); the session it names (`sessions.rs`), which a clean
    /// Leave ends.
    Leave(MemberKey, bool, Option<u64>),
    Sync(MemberKey, bytes::Bytes),
    Awareness(MemberKey, bytes::Bytes),
    QueryAwareness(MemberKey),
    Stateless(MemberKey, String),
    Token(MemberKey, Context),
    /// A store's I/O finished.
    Stored(Box<StoreDone>),
    /// The head of the client-id row queue was written, or failed every try.
    RowsWritten(Result<(), String>),
    /// The client ids bound to live channels, for the server's own id draws
    /// (r2 N7).
    LiveIds(oneshot::Sender<HashSet<u64>>),
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
    /// Close every channel of a user (their access changed), with no notice.
    CloseUser(String, u16, String),
    /// Who is connected, each user with whether a channel of theirs needs an
    /// editing role (`pubsub::revoke_local`).
    Holders(oneshot::Sender<HashMap<String, bool>>),
    /// A fold of the log finished: rows and bytes it removed, the new base
    /// size; with a collection, its window and held set
    /// (`note_store::Folded`).
    Folded(
        Option<(i64, i64, i64)>,
        Option<Box<(ydoc::gc::Window, yrs::IdSet)>>,
    ),
    /// A board's fold finished: what it folded, or none when it failed or
    /// found nothing to fold.
    BoardFolded(board::Fold, Option<Box<BoardFold>>),
    /// A board fold's projection was sent, at the version it folded through
    /// (`note_store::Folded::projection`).
    FoldProjected(i64, Result<(), String>),
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
    /// The room's whole state (a server edit merges the live room). A
    /// board has none to give and says so.
    Snapshot(oneshot::Sender<Result<Vec<u8>, IsBoard>>),
    /// A note's whole state when it holds edits its projected content lacks
    /// (unsaved, being stored, or stored and not projected yet), else none:
    /// a detailed read's live note content (Q417).
    /// A board holds no note content and says so.
    LiveNote(oneshot::Sender<Result<Option<Vec<u8>>, IsBoard>>),
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
    /// A quiz room loaded: the other one sends its entries again.
    PeerLoaded,
    /// A server edit changed the other document while its room was not
    /// loaded: read it from the store.
    PeerReload,
    /// What that read found (dropped when the other room loaded meanwhile).
    PeerStored(notes::limits::Metrics, Vec<items::quiz::ItemsPart>),
    /// Stored drafts from a browser with no editor open (`drafts.rs`).
    Draft(Box<Draft>),
    /// A draft piece's body is still arriving (`drafts.rs`): the group `id`
    /// of `user` lives on for the slack from now, so a slow but live uplink
    /// lands it (round 4, finding 9).
    DraftArriving {
        user: String,
        id: String,
    },
    /// An agent edit, Undo or Redo admitted like a person's edit (Q402).
    AgentEdit(Box<AgentEdit>),
    /// A quiz's keys update its content room admits with its own (Q403):
    /// admitted here alone, its answer back to the content room.
    AgentKeys {
        actor: String,
        update: Vec<u8>,
        undo: bool,
        reply: oneshot::Sender<Result<(), crate::edits::DocumentError>>,
    },
    /// What this room holds of an agent operation before its request
    /// computes (Q402): see [AgentSteps::known].
    AgentKnown {
        id: String,
        request_hash: String,
        undo_of: Option<String>,
        actor: String,
        reply: oneshot::Sender<Result<Option<Value>, crate::edits::DocumentError>>,
    },
}

/// A draft send: a writer's update without a channel. The reply is the
/// admission's refusal, or the answer of the store that will hold it.
pub struct Draft {
    pub context: Context,
    pub update: bytes::Bytes,
    /// The base the drafts grew over (an Office file needs the room's).
    pub base: Option<String>,
    /// Client ids the drafts' stored tokens offered (Q288), checked here
    /// under the JOIN's rule before the drafts may write under them.
    pub granted: Vec<u64>,
    /// The stored version the drafts were made at, their oldest's
    /// (`X-Capy-Version`, `sessions.rs`): 1 or later.
    pub version: u64,
    /// A piece of a group the page cut a large update in (`X-Capy-Group`):
    /// held until the group's last ([Room::draft_piece]).
    pub group: Option<DraftPiece>,
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

/// A server edit committed as its own row (a command, a repair, an agent
/// edit written while no room was loaded): what the live room lacks of it,
/// the stored cover it makes, and the note's stored version or the source's
/// checkpoint it reached.
pub struct ServiceEdit {
    pub update: Vec<u8>,
    pub durable: ydoc::Durable,
    pub version: u64,
    pub row_bytes: usize,
}

/// The token id of the context an agent edit is admitted under (Q402): its
/// actor's write, with no token or channel of its own.
pub const AGENT_TOKEN: &str = "agent-edit";

/// Why an Office writer's update is refused during the maintenance pause.
const OFFICE_PAUSED: &str = "Office editing is paused";

/// An agent edit, Undo or Redo for a loaded room to admit like a person's
/// edit (Q402): computed on the room's snapshot, admitted in the room's
/// queue, answered at admission, its receipt stored with the room's next
/// store, which starts at once (Q403).
pub struct AgentEdit {
    /// The chat's user, as whom the edit is admitted.
    pub actor: String,
    /// The receipt the room's store writes; an Undo's operation and chat
    /// identity are filled from its step.
    pub receipt: note_store::AgentReceipt,
    /// The step an Undo or Redo reverses, as stored (none: not stored yet,
    /// or unknown).
    pub step: Option<AgentStep>,
    /// This room's update (none: it changes nothing here).
    pub update: Option<Vec<u8>>,
    /// A quiz's keys update: this content room has its keys room admit it
    /// in the same step, both or neither (Q403).
    pub keys: Option<Vec<u8>>,
    pub reply: oneshot::Sender<AgentAnswer>,
}

/// A room's answer to an agent edit: the receipt and whether this request
/// was admitted (false: a retry's, or another request's for the same step),
/// or the refusal a person's edit would get.
pub type AgentAnswer = Result<(Value, bool), crate::edits::DocumentError>;

/// What an Undo needs of the step it reverses.
#[derive(Clone, Debug)]
pub struct AgentStep {
    pub actor: String,
    pub conversation_id: Option<String>,
    pub message_id: Option<String>,
    /// The step's own effect (`edited`, `edit_undone`).
    pub operation: Option<String>,
}

impl AgentStep {
    fn of(receipt: &note_store::AgentReceipt) -> Self {
        AgentStep {
            actor: receipt.actor.clone(),
            conversation_id: receipt.conversation_id.clone(),
            message_id: receipt.message_id.clone(),
            operation: receipt.effect["operation"].as_str().map(str::to_owned),
        }
    }
}

/// The agent steps a room admitted (Q402): waiting for a store, written by
/// the running one, and stored this life (the last [AGENT_STORED_KEPT], for
/// an Undo of a step stored while its request was on the way).
#[derive(Default)]
struct AgentSteps {
    pending: Vec<note_store::AgentReceipt>,
    storing: Vec<note_store::AgentReceipt>,
    stored: VecDeque<note_store::AgentReceipt>,
}

const AGENT_STORED_KEPT: usize = 256;

/// The agent steps a room keeps waiting for a store (pending and storing)
/// before it refuses new ones (Q432): a checkpoint carries at most this
/// many, and a store failing for good holds them.
const AGENT_UNSTORED_MAX: usize = 256;

impl AgentSteps {
    fn find(
        &self,
        matches: impl Fn(&note_store::AgentReceipt) -> bool,
    ) -> Option<&note_store::AgentReceipt> {
        self.pending
            .iter()
            .chain(&self.storing)
            .chain(&self.stored)
            .find(|receipt| matches(receipt))
    }

    /// The receipt of a step this room holds for this request: its own
    /// (a retry's), or another request's that reversed the same step. An
    /// Undo or Redo of a step `actor` did not make, or whose reversal is
    /// another user's, is refused here, before any receipt answers it or
    /// anything computes (Q432, Q451).
    fn known(
        &self,
        id: &str,
        request_hash: &str,
        undo_of: Option<&str>,
        actor: &str,
    ) -> Result<Option<Value>, crate::edits::DocumentError> {
        if let Some(known) = self.find(|known| known.id == id) {
            if known.request_hash != request_hash {
                return Err(crate::edits::DocumentError::edit(
                    "invalid_input",
                    "operation id already used with a different request",
                ));
            }
            return Ok(Some(known.answer()));
        }
        let Some(of) = undo_of else {
            return Ok(None);
        };
        if self
            .find(|known| known.id == of || known.undo_of.as_deref() == Some(of))
            .is_some_and(|known| known.actor != actor)
        {
            return Err(crate::edits::DocumentError::Lifecycle(
                "the step is another user's".into(),
            ));
        }
        Ok(self
            .find(|known| known.undo_of.as_deref() == Some(of))
            .map(note_store::AgentReceipt::answer))
    }

    /// A store takes every waiting step.
    fn claim(&mut self) -> Vec<note_store::AgentReceipt> {
        self.storing = std::mem::take(&mut self.pending);
        self.storing.clone()
    }

    /// The running store committed: its steps are stored.
    fn stored(&mut self) {
        for mut receipt in self.storing.drain(..) {
            receipt.held = None;
            receipt.provenance = None;
            self.stored.push_back(receipt);
        }
        while self.stored.len() > AGENT_STORED_KEPT {
            self.stored.pop_front();
        }
    }

    /// The room threw its unsaved state away: its unstored steps are lost
    /// with everyone's unsaved edits (Q402), and a retry finds none.
    fn discard(&mut self) {
        self.pending.clear();
        self.storing.clear();
    }

    /// The running store failed: its steps wait for the next one, first.
    fn unclaim(&mut self) {
        let mut storing = std::mem::take(&mut self.storing);
        storing.append(&mut self.pending);
        self.pending = storing;
    }
}

/// [Room::check_update]'s checked update, for [Room::apply_update].
struct Checked {
    update: yrs::Update,
    written: Vec<u64>,
    heavy: bool,
}

/// What a writer's update's checks found before its admission: the update,
/// whether it tells the room anything new, the client ids it writes under,
/// and whether its admission and apply run off the async workers.
struct Screened {
    update: yrs::Update,
    changes: bool,
    written: Vec<u64>,
    heavy: bool,
}

struct Member {
    context: Context,
    /// The handoff's name for this channel.
    channel_id: u64,
    read_only: bool,
    /// A viewer's channel: no awareness either way (kept across refreshes;
    /// a lowered role closes the channel, a raised one waits for a reload).
    viewer: bool,
    /// The source handoff made this channel read-only until RestoreAccess;
    /// a token refresh keeps it so.
    held_read_only: bool,
    out: Outbox,
    socket: String,
    /// An embed's channel inside its note's: it hears no room presence.
    inside: bool,
    /// The session's client id, bound at join (Q213): the only id its
    /// awareness goes under.
    client: u64,
    /// Its DOCX layout worker's client id, bound at join (Q219).
    worker: Option<u64>,
    /// Its editing session's random id from the JOIN (Q472; none from an
    /// older client).
    session_id: Option<u128>,
    /// Awareness client ids this channel holds (its session's, or none).
    clients: HashSet<u64>,
    /// Consecutive unplaceable step 2 replies.
    unplaced: u32,
    /// Update and step 2 messages handled since the last ACK, pieces each.
    acks: u64,
    /// The pieces of a step 2 or update it sent so far (`on_piece`).
    group: Option<Group>,
    /// Its step 1 and awareness query waiting for its user's open budget.
    opening: Option<Opening>,
    /// The room answered its step 1: it holds the room's state, so it hears
    /// each store's version (`sessions.rs`).
    synced: bool,
    /// The room's admissions when it joined or its step 1 was last answered:
    /// it holds those groups, so their paced pieces skip it.
    seen: u64,
    /// The stored version it last named (its JOIN's, then each `ack`): a
    /// session made at its first write starts there (review r1 L1).
    version: i64,
}

/// A step 2 or update its client cut in pieces (`sync::PIECE`), gathered
/// until the last: nothing of it is applied, stored or broadcast before, and
/// nothing at all when a piece is refused or the channel ends first.
struct Group {
    step2: bool,
    count: u64,
    /// The place the next piece must have.
    next: u64,
    /// The pieces so far; none once the group was dropped (or found its
    /// user busy), whose later pieces are acknowledged and let go until its
    /// last.
    pieces: Option<Vec<Vec<u8>>>,
    /// The bytes of its pieces so far.
    bytes: usize,
    /// Its pieces acknowledged before it ends: its first, once held, so its
    /// client sends the rest (round 4, finding 5).
    acked: u64,
    /// Its user's one group slot ([GroupClaim]), given back when it is
    /// dropped.
    claim: Option<GroupClaim>,
    started: Instant,
    /// When it is dropped unless its next piece came ([Room::group_carry]),
    /// a message is still arriving on its socket or, while its first piece
    /// waits for its acknowledgement, its tab's heartbeat came.
    deadline: Instant,
    /// The latest its deadline may be, however much its socket hears
    /// ([Room::group_limit]).
    limit: Instant,
    /// The bytes and heartbeats its socket had read at its latest piece or
    /// renewal ([Room::drop_late_groups]).
    heard: u64,
    beats: u64,
}

/// A draft send's group (`X-Capy-Group`): its pieces kept by the room until
/// the last, which admits them as one update, as a channel's group.
#[derive(Clone, Debug)]
pub struct DraftPiece {
    /// The page's name for the group: the same for every send of the same
    /// rows, so a resend (or another tab's send of them) adds to the group
    /// the room holds instead of beside it.
    pub id: String,
    pub index: u64,
    pub count: u64,
}

/// A finished group: its pieces merged into one update, and the pieces it
/// came in (none when the room held all of them in full).
type Gathered = (Vec<u8>, Vec<Vec<u8>>);

/// A draft group the room holds, by its user and id ([Room::draft_piece]).
struct DraftGroup {
    count: u64,
    next: u64,
    /// Its pieces that change anything (one the room holds in full is
    /// neither charged nor kept, Q321), and their bytes.
    pieces: Vec<Vec<u8>>,
    bytes: usize,
    /// Its user's one group slot.
    _claim: GroupClaim,
    started: Instant,
    deadline: Instant,
    /// The latest its deadline may be, however often its pieces come again
    /// or its body keeps arriving ([Room::group_limit]).
    limit: Instant,
}

/// The least a group's pieces carry on average, with margin: the browser
/// packs each piece up to 2 MiB by its own estimate (`splitUpdate`), which
/// counts a delete range as 16 bytes against the 2 to 7 it encodes in, so a
/// delete-heavy piece may hold an eighth of that. Bytes are the bound (the
/// room's group cap); the count is only a sanity bound ([max_pieces]),
/// review of 43fae032a round 2, finding 6, and round 3, finding 9.
const PIECE_FLOOR: usize = 256 << 10;

/// The most pieces a group within `cap` bytes may have.
fn max_pieces(cap: usize) -> u64 {
    (cap / PIECE_FLOOR) as u64 + 2
}

/// Why a group of `count` pieces is refused: no client cuts one within the
/// room's group cap so, whatever its `bytes` so far (round 3, finding 9).
fn too_many_pieces(count: u64, bytes: usize, cap: usize) -> String {
    format!(
        "a group of {count} pieces ({bytes} bytes so far) has more than the {} one within the room's group cap may have",
        max_pieces(cap)
    )
}

/// The group slot a channel's groups claim ([GroupClaim::channel]): its
/// room and JOIN session id, so a busy tab keeps its place in line on its
/// next connection (round 4, finding 2); a channel naming no session, its
/// connection's.
fn channel_slot(room: &str, key: MemberKey, session: Option<u128>) -> String {
    match session {
        Some(session) => format!("{room}\nsession:{session:032x}"),
        None => format!("{room}\n{}:{}", key.0, key.1),
    }
}

/// A channel's word that the room dropped its unfinished group as late (a
/// piece did not come by the group's deadline): it acknowledged the pieces,
/// and the client sends the edit again only after its next join, so an
/// uplink too slow for one piece within the slack does not loop on resends
/// (review of 43fae032a round 2, finding 5).
pub const GROUP_DROPPED_TYPE: &str = "group-dropped";

/// A channel's word that its group's first piece found another group of its
/// user's unfinished (one at a time, Epo 2026-11-23): the room acknowledges
/// the group's pieces and lets them go, and the client joins again 10 s
/// later, its step 2 carrying the edit. Not abuse, so no timeout.
pub const GROUP_BUSY_TYPE: &str = "group-busy";

/// An update going out at a flush: who sent it (none: everyone gets it),
/// and whether it is a piece of an admitted source group, which goes as a
/// message of its own, never merged with others, at the update allowance's
/// pace ([Room::outgoing]).
struct Outgoing {
    sender: Option<MemberKey>,
    update: Vec<u8>,
    piece: bool,
    /// A piece's group's place among the room's admissions: a member that
    /// joined or was answered after it ([Member::seen]) holds the group
    /// already and skips the piece (round 3, finding 7).
    admitted: u64,
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
    /// A quiz room's `peer` is the other document's bound as last read (the
    /// store's, or its room's before it unloaded), which a loaded room's in
    /// `App::quiz_bounds` stands in for.
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
    /// A board took an update naming an asset (`model::names_asset`): it
    /// projects after its next store, whatever the cadence.
    project_soon: bool,
    project_waiters: Vec<oneshot::Sender<Result<i64, String>>>,
    log_bytes: i64,
    log_rows: i64,
    base_bytes: i64,
    folding: bool,
    /// The stored version of the latest collection's window: a session or
    /// draft group older than it is late (`sessions::late`). Loaded with the
    /// document; while a fold runs, the most that fold may move it to
    /// (`maybe_fold`).
    window: i64,
    /// The delete set of the latest collection's window (`note_store::Loaded`,
    /// then each collecting fold's): every unit a collection discarded from
    /// this document is in it, so a collected unit outside it was dropped by
    /// yrs under a holder deleted since (Q446).
    collected: yrs::IdSet,
    /// Versions below `stored_version` the room has not applied: service
    /// edits whose rows committed before a later store's (`sessions::took`).
    /// No fold runs while one is open (Q419). Note content rooms only.
    gaps: std::collections::BTreeSet<i64>,
    /// The first gap below a store the room could not announce, and whether
    /// it was warned of (`announce_stored`).
    stall: Option<(i64, bool)>,
    /// A board's growth its stored rows and folds do not hold yet.
    growth: BoardGrowth,
}

impl Note {
    /// A note's content room: the one whose sessions are kept and whose
    /// stored state is to be collected (Q274: notes only).
    fn sessioned(&self) -> bool {
        self.model == crate::model::Model::Note
            && self.kind == "note"
            && self.doc == note_store::Doc::Content
    }
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
    /// The picture byte cap on Word and PowerPoint edits
    /// (`sources::Loaded::image_cap`).
    image_cap: u64,
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
    /// The change count of the note sessions' rows it wrote
    /// (`Sessions::saved`).
    sessions: Option<u64>,
    /// A board's row, which joins its tail once committed.
    board_row: Option<board::Row>,
}

enum Kindly {
    Note(Box<Note>),
    Source(Box<Source>),
}

/// What the room holds: a live yrs document (notes, items, sources), or a
/// canvas's board as its saved bytes (Epo 2026-11-24, `board.rs`), which no
/// path may read as a document.
enum State {
    Doc(Doc),
    Board(Box<Board>),
}

impl State {
    /// The document the room writes its contributor markers in: its own, or
    /// the board's marker document.
    fn markers(&self) -> &Doc {
        match self {
            State::Doc(doc) => doc,
            State::Board(board) => board.markers(),
        }
    }

    /// Everything the room holds, its markers included.
    fn state_vector(&self) -> StateVector {
        match self {
            State::Doc(doc) => doc.transact().state_vector(),
            State::Board(board) => board.state_vector(),
        }
    }

    /// The room's own client, which writes the markers (and a document's
    /// server edits): one no stored struct names and no user was assigned.
    fn client(&self) -> ClientID {
        self.markers().client_id()
    }
}

/// A step 1's answer: a document's diff, sent as the step 2, or a board's
/// parts ([board::Join]), each sent as an update and its step 2 last, so a
/// joiner synced holds the whole board.
enum Answer {
    Diff(Vec<u8>),
    Board {
        updates: Vec<Vec<u8>>,
        step2: Vec<u8>,
    },
}

impl Answer {
    fn size(&self) -> usize {
        match self {
            Answer::Diff(diff) => diff.len(),
            Answer::Board { updates, step2 } => {
                updates.iter().map(Vec::len).sum::<usize>() + step2.len()
            }
        }
    }
}

/// What a board's size bound took that its stored rows and folds do not
/// hold yet, so a fold's exact base can tighten it (`RoomValidator::tighten`).
/// The bound is the last exact size (a trial's replica, a fold's base, the
/// base at load) and the most every update since can add: an upper bound,
/// never lowered by a deletion between measures, which the receipts'
/// `metrics.contentBytes` carry and the browser checks against its own
/// document before acting on it (`itemRoom.ts`).
#[derive(Default)]
struct BoardGrowth {
    /// The growth appended since the running store took its row (or the
    /// last one did).
    unstored: u64,
    /// The growth in the running store's row.
    storing: u64,
    /// While a fold runs: what its new base will not hold (the updates no
    /// committed row held when it began, and all growth since).
    unfolded: Option<u64>,
}

impl BoardGrowth {
    fn grew(&mut self, growth: u64) {
        self.unstored += growth;
        if let Some(unfolded) = &mut self.unfolded {
            *unfolded += growth;
        }
    }

    fn row_taken(&mut self) {
        self.storing = std::mem::take(&mut self.unstored);
    }

    fn row_ended(&mut self, committed: bool) {
        let storing = std::mem::take(&mut self.storing);
        if !committed {
            self.unstored += storing;
        }
    }

    fn fold_began(&mut self) {
        self.unfolded = Some(self.unstored + self.storing);
    }

    /// What the ended fold's base does not hold.
    fn fold_ended(&mut self) -> Option<u64> {
        self.unfolded.take()
    }
}

/// A board's fold, back from the store (`note_store::Folded`): the rows and
/// bytes it took off the log, the new base's size, the new base and its
/// indexes.
pub struct BoardFold {
    rows: i64,
    log_bytes: i64,
    base_bytes: i64,
    base: Vec<u8>,
    indexes: board::Indexes,
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

/// Why a source update or save was refused for the room's size, on its
/// `source-checkpoint-failed` (Q827 A) and its incident.
const SIZE_REASON: &str = "source_state_bytes";

/// See `sync_message`: not a valid update, so a release build refuses it.
#[cfg(debug_assertions)]
const IT_PANIC_UPDATE: &[u8] = b"capy-it-panic";

/// See `admit_update`: a group of pieces whose update holds this text panics
/// before its checks, in debug builds only.
#[cfg(debug_assertions)]
const IT_PANIC_GROUP: &[u8] = b"capy-it-panic-group";

/// See `load`: the first load of a note whose id holds this panics, in debug
/// builds only.
#[cfg(debug_assertions)]
const IT_PANIC_LOAD: &str = "capy-it-panic-load";

/// See `service_edit`: a server edit of a material whose id holds this fails
/// to apply, in debug builds only.
#[cfg(debug_assertions)]
pub const IT_FAIL_SERVICE_EDIT: &str = "capy-it-fail-service-edit";

/// See `start_store` and `start_source_store`: a store of a material or
/// source file whose id holds this commits a second late, in debug builds
/// only.
#[cfg(debug_assertions)]
pub const IT_SLOW_STORE: &str = "capy-it-slow-store";

/// See `edits::edit_in_room` and `edits::source_in_room`: an agent edit of a
/// material or source file whose id holds this computes three seconds late,
/// in debug builds only.
#[cfg(debug_assertions)]
pub const IT_SLOW_COMPUTE: &str = "capy-it-slow-compute";

/// See `edits::source_request`: a no-room source edit whose operation id
/// holds this waits half a second after its stored receipt check, in debug
/// builds only.
#[cfg(debug_assertions)]
pub const IT_SLOW_RECHECK: &str = "capy-it-slow-recheck";

/// See `edits::it_hold`: a no-room agent edit of a source file or material
/// whose id holds this waits after its snapshot of the live room, before it
/// computes, until the test releases it, in debug builds only (Q826 A: a
/// room opens meanwhile).
#[cfg(debug_assertions)]
pub const IT_HOLD_NO_ROOM: &str = "capy-it-hold-no-room";

/// See `edits::opened`: a source file whose id holds this looks loaded to a
/// no-room agent edit's last look and is never loaded for its Q402 path, as
/// if its rooms kept opening and unloading, in debug builds only (Q829 A).
#[cfg(debug_assertions)]
pub const IT_ROOM_FLAPS: &str = "capy-it-room-flaps";

/// See `RoomCmd::Snapshot`: a room whose name holds this answers no snapshot
/// within its 10 s, in debug builds only (Q829 A).
#[cfg(debug_assertions)]
const IT_SLOW_SNAPSHOT: &str = "capy-it-slow-snapshot";

/// See `RoomCmd::AgentKeys`: the keys room of a quiz whose id holds this
/// refuses an agent edit's part, in debug builds only.
#[cfg(debug_assertions)]
const IT_REFUSE_AGENT_KEYS: &str = "capy-it-refuse-agent-keys";

/// See `edits::send_writes`: a server edit of a material whose id holds this
/// reaches its room 3 s after its rows committed, in debug builds only.
#[cfg(debug_assertions)]
pub const IT_SERVICE_LATER: &str = "capy-it-service-later";

/// Debug builds only: a material whose id holds this has its open room's live
/// pass refused (Q419, Q449), while its stored folds collect.
#[cfg(debug_assertions)]
const IT_REFUSE_LIVE: &str = "capy-it-refuse-live";

/// Debug builds only: a material whose id holds this has its open room's live
/// pass panic (Q449), while its stored folds collect.
#[cfg(debug_assertions)]
const IT_PANIC_LIVE: &str = "capy-it-panic-live";

/// See `load`: a board whose id holds this keeps the board work permit 3 s
/// past taking it for its load, in debug builds only.
#[cfg(debug_assertions)]
const IT_HOLD_WORK: &str = "capy-it-hold-work";

/// See `start_store`: a store of a material whose id holds this, taken while
/// its room's fold runs, commits and then tells its room so only once the
/// test releases it (Redis `capy-it-hold-stored:<material>:release`; it
/// sets `:held` meanwhile), so the fold can swap in before the store's
/// marker clear, in debug builds only.
#[cfg(debug_assertions)]
const IT_HOLD_STORED: &str = "capy-it-hold-stored";

/// [IT_HOLD_STORED]'s wait, at most a minute.
#[cfg(debug_assertions)]
async fn it_hold_stored(app: &Shared, material_id: &str) {
    let key = format!("{IT_HOLD_STORED}:{material_id}");
    let mut redis = app.redis.clone();
    let _: Result<(), _> =
        redis::AsyncCommands::set_ex(&mut redis, format!("{key}:held"), 1, 600).await;
    for _ in 0..600 {
        let released: Option<String> =
            redis::AsyncCommands::get(&mut redis, format!("{key}:release"))
                .await
                .unwrap_or(None);
        if released.is_some() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg(debug_assertions)]
static IT_PANICKED_LOAD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub struct Room {
    app: Shared,
    id: u64,
    name: String,
    state: State,
    members: HashMap<MemberKey, Member>,
    /// Which user each client id was recorded to (Q213).
    client_ids: ClientIds,
    /// A note's editing sessions (`sessions.rs`); none in other rooms
    /// (Q274: item rooms keep their whole history).
    sessions: Option<Sessions>,
    awareness: HashMap<u64, AwarenessEntry>,
    changed_awareness: BTreeSet<u64>,
    /// Presence changed since it last went out; when it may go next.
    presence_dirty: bool,
    presence_at: Option<Instant>,
    /// Each person's number in the room's presence, kept while they are in
    /// it: never their user id, which a reader may not learn (Epo 2026-10-12).
    people: HashMap<String, u64>,
    next_person: u64,
    /// This window's updates.
    window: Vec<Outgoing>,
    flush_at: Option<Instant>,
    /// Admitted source groups' pieces, going out at the update allowance's
    /// pace ([Room::outgoing]); the pace's bytes in hand and when they were
    /// counted; when the next piece may go.
    paced: VecDeque<Outgoing>,
    pace: (f64, Instant),
    paced_at: Option<Instant>,
    /// Source groups admitted so far, the stamp of each one's pieces
    /// ([Outgoing::admitted]).
    admissions: u64,
    /// Draft groups held until their last piece, by user and group id.
    draft_groups: HashMap<(String, String), DraftGroup>,
    markers: Markers,
    receipts: Vec<String>,
    /// The agent steps this room admitted (Q402).
    agent: AgentSteps,
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
    /// Client-id rows to write, in order, one batch at a time off the room's
    /// task (r2 S3); the room unloads only once they are written.
    rows: VecDeque<client_ids::Rows>,
    rows_running: bool,
    /// An update is going into the document (see `update_panicked`).
    applying: bool,
    /// The update on hand came as a sync step 2 (Q549).
    in_step2: bool,
    /// The room reloads from the stored document (`reload`).
    reloading: bool,
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

/// A document under a random client id `taken` refuses.
fn fresh_doc(taken: impl Fn(u64) -> bool) -> Doc {
    loop {
        let doc = Doc::with_options(ydoc::doc_options(0));
        if !taken(doc.client_id().get()) {
            return doc;
        }
    }
}

/// A material room's document: the stored base and rows replayed straight
/// into it, under a client id they name nowhere and no user was assigned
/// (Q226): markers and server edits are written under it. No scratch copy
/// is held beside it and no whole state encoded (a scratch alive while the
/// room's document was built doubled a loaded room's RSS on glibc,
/// room-memory report cut 1).
fn loaded_doc(base: Vec<u8>, rows: Vec<Vec<u8>>, assigned: &HashSet<u64>) -> Result<Doc, String> {
    let stored = ydoc::Stored::decode(&base, &rows).map_err(|error| error.to_string())?;
    drop((base, rows));
    let named = stored.clients();
    let doc = fresh_doc(|id| named.contains(&id) || assigned.contains(&id));
    stored.replay(&doc).map_err(|error| error.to_string())?;
    Ok(doc)
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

/// What a load gives the room.
type Loaded = (
    State,
    Kindly,
    ydoc::Durable,
    Option<sources::LoadTimes>,
    ClientIds,
    Option<Sessions>,
);

async fn load(app: &Shared, name: &RoomName, actor: &str) -> Result<Loaded, LoadError> {
    let client_ids = ClientIds::load(&app.db, name).await?;
    let assigned = client_ids.ids();
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
            let mut loaded = note_store::load(&app.db, material_id, *schema, doc_kind)
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
            let (stored_version, projected_version, log_bytes, window) = (
                loaded.stored_version,
                loaded.projected_version,
                loaded.log_bytes,
                loaded.window,
            );
            let collected = std::mem::take(&mut loaded.collected);
            let indexes = loaded.indexes.take();
            let material_kind = kind.clone();
            // A board's load waits for the board work limit (`work.rs`),
            // taken once the load committed, so no material lock is held
            // while it waits.
            let permit = board_permit(app, model, WorkKind::Load, &name.to_string()).await;
            // Debug builds only: the integration tests' board load holding
            // the permit 3 s.
            #[cfg(debug_assertions)]
            if permit.is_some() && material_id.contains(IT_HOLD_WORK) {
                log(
                    Level::Info,
                    "it holds board work",
                    json!({ "room": name.to_string() }),
                );
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
            let (state, durable, metrics, mut refused) =
                tokio::task::spawn_blocking(move || -> Result<_, String> {
                    let _permit = permit;
                    // A board loads on its stored bytes and the indexes stored
                    // beside its base, which is never decoded; one stored
                    // without them fails here (Epo 2026-11-24). Its size is
                    // the bound the load gives, its markers a document of
                    // their own, and it holds whatever its editors wrote
                    // (`Model::stored`).
                    if model == crate::model::Model::Board {
                        let (board, bound) =
                            Board::load(loaded.base, indexes.as_ref(), loaded.rows, |id| {
                                assigned.contains(&id)
                            })
                            .map_err(|error| error.to_string())?;
                        return Ok((
                            State::Board(Box::new(board)),
                            ydoc::Durable::default(),
                            crate::model::board_metrics(bound),
                            None,
                        ));
                    }
                    let doc = loaded_doc(loaded.base, loaded.rows, &assigned)?;
                    let txn = doc.transact();
                    model.assert_roots(&txn)?;
                    markers::contributors_in(&txn).map_err(|error| error.to_string())?;
                    let metrics = model.measure(&txn)?;
                    let refused = model.stored(&material_kind, &txn)?;
                    let durable = ydoc::Durable::of(&txn);
                    drop(txn);
                    Ok((State::Doc(doc), durable, metrics, refused))
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
                durable_metrics: Some(metrics),
                stored_version,
                projected_version,
                projecting: false,
                projected_at: Instant::now(),
                project_soon: false,
                project_waiters: Vec::new(),
                log_bytes,
                log_rows,
                base_bytes,
                folding: false,
                window,
                collected,
                gaps: std::collections::BTreeSet::new(),
                stall: None,
                growth: BoardGrowth::default(),
            };
            // A note's content room keeps its sessions (Q274: notes only).
            let sessions = if note.sessioned() {
                let (sessions, damaged) = note_store::load_sessions(&app.db, material_id)
                    .await
                    .map_err(|error| error.to_string())?;
                // Dropped alone, the note loads (Q382, Epo 2026-10-26).
                let room = name.to_string();
                for client in &damaged.sessions {
                    let message = format!("session {client}: unreadable held deletions");
                    observe::capture(&message, None, &[("room", &room), ("stage", "sessions")]);
                }
                Some(sessions)
            } else {
                None
            };
            Ok((
                state,
                Kindly::Note(Box::new(note)),
                durable,
                None,
                client_ids,
                sessions,
            ))
        }
        RoomName::Source { .. } => {
            let room = name
                .source_room()
                .ok_or_else(|| "invalid source room".to_owned())?;
            let doc = fresh_doc(|id| assigned.contains(&id));
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
                image_cap: loaded.image_cap,
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
                State::Doc(doc),
                Kindly::Source(Box::new(source)),
                durable,
                Some(loaded.times),
                client_ids,
                None,
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
    let (state, kind, durable, times, client_ids, sessions) = match loaded {
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
    let pace = (app.config.update_limits.burst_bytes as f64, Instant::now());
    let mut room = Room {
        markers: Markers::new(&app.instance_id),
        app,
        id,
        name: room_name,
        state,
        members: HashMap::new(),
        client_ids,
        sessions,
        awareness: HashMap::new(),
        changed_awareness: BTreeSet::new(),
        presence_dirty: false,
        presence_at: None,
        people: HashMap::new(),
        next_person: 0,
        window: Vec::new(),
        flush_at: None,
        paced: VecDeque::new(),
        pace,
        paced_at: None,
        admissions: 0,
        draft_groups: HashMap::new(),
        receipts: Vec::new(),
        agent: AgentSteps::default(),
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
        rows: VecDeque::new(),
        rows_running: false,
        applying: false,
        in_step2: false,
        reloading: false,
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
    if let Kindly::Note(note) = &room.kind
        && note.model.quiz()
    {
        // Measured exactly by the load: the other room reads it from now.
        if let Some(bound) = note.validator.bound() {
            room.app.quiz_bounds.set(&room.name, bound);
        }
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
                    // Stored in full, its bound holds for the other room while
                    // that one is loaded (review of 43fae032a, finding 4); a
                    // next life of the room sets its own at its load.
                    if let Some(peer) = self.peer_name()
                        && matches!(&self.kind, Kindly::Note(note) if note.model.quiz())
                    {
                        let loaded = self.app.rooms.get(&peer).is_some();
                        self.app.quiz_bounds.unloaded(&self.name, &peer, loaded);
                    }
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
        let presence = self.presence_at.filter(|_| self.presence_dirty);
        [
            self.flush_at,
            self.store_due(),
            self.idle_at,
            self.open_at,
            presence,
            self.paced_at,
            self.groups_due(),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    /// When the soonest unfinished group is dropped, a channel's or a
    /// draft send's.
    fn groups_due(&self) -> Option<Instant> {
        let channels = self
            .members
            .values()
            .filter_map(|member| member.group.as_ref())
            .filter(|group| group.pieces.is_some())
            .map(|group| group.deadline);
        let drafts = self.draft_groups.values().map(|group| group.deadline);
        channels.chain(drafts).min()
    }

    /// Unfinished groups past their deadline are dropped: a channel's is
    /// acknowledged and its channel told ([GROUP_DROPPED_TYPE]), a draft
    /// group's next piece finds nothing to join (`unavailable`). A channel's
    /// group lives on for the slack when its socket heard bytes since its
    /// mark, after the socket's last whole message: a message is still
    /// arriving (a slow uplink's piece, or another message its pieces wait
    /// behind); pongs alone never renew it, as they come whole (round 4,
    /// finding 9). While its first piece is held and nothing more came, it
    /// lives on too when its tab's heartbeat came since
    /// ([crate::protocol::HEARTBEAT]): a long send to the client holds back
    /// the acknowledgement its rest waits for, and its tab's code runs,
    /// which a frozen tab's never does; a group stalled after its second
    /// piece gets no renewal from beats. Neither renews it past its limit
    /// ([Room::group_limit]). A draft group waits for one whole
    /// piece at the slowest uplink ([Room::draft_wait]), and lives on while
    /// its piece's body arrives ([RoomCmd::DraftArriving]), up to the same
    /// limit.
    fn drop_late_groups(&mut self, now: Instant) {
        self.draft_groups.retain(|_, group| group.deadline > now);
        let slack = self.app.config.group_slack;
        let mut late = Vec::new();
        for (key, member) in &mut self.members {
            let Some(group) = member
                .group
                .as_mut()
                .filter(|group| group.pieces.is_some() && group.deadline <= now)
            else {
                continue;
            };
            let traffic = member.out.traffic();
            let (heard, beats) = (traffic.heard(), traffic.beats());
            // Only its held first piece's acknowledgement can wait behind a
            // long send; a group stalled later holds its user's one slot no
            // longer for its tab's beats.
            let waiting = group.next == 1;
            if (heard > group.heard && traffic.arriving()) || (waiting && beats > group.beats) {
                (group.heard, group.beats) = (heard, beats);
                group.deadline = now + slack;
            }
            // Never past its limit (round 6, finding 4).
            group.deadline = group.deadline.min(group.limit);
            if group.deadline <= now {
                late.push(*key);
            }
        }
        for key in late {
            self.drop_noticed(key, GROUP_DROPPED_TYPE);
        }
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
        if self.groups_due().is_some_and(|at| at <= now) {
            self.drop_late_groups(now);
        }
        if self.flush_at.is_some_and(|at| at <= now) || self.paced_at.is_some_and(|at| at <= now) {
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
        if self.presence_dirty && self.presence_at.is_some_and(|at| at <= now) {
            self.send_presence(now);
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

    /// Whether the room's saves are failing (Q456): a store retrying after a
    /// failure, or a source save failing within its slow-save clock.
    fn saves_failing(&self) -> bool {
        self.store.failed_event.is_some()
            || matches!(&self.kind, Kindly::Source(source) if source.failing_since.is_some())
    }

    fn unloadable(&self) -> bool {
        let empty = self.members.is_empty() && self.rows.is_empty() && !self.rows_running;
        if self.discard_pending.is_some() || !self.forced_unload.is_empty() {
            return empty && !self.store.running;
        }
        empty
            // A draft group's last piece finds the room it began in.
            && self.draft_groups.is_empty()
            && self.child_passes.is_empty()
            && !self.child_running
            && !self.store.dirty
            && !self.store.running
            && self.store.retry_at.is_none()
            && self.store.waiters.is_empty()
            && !markers::pending(self.state.markers())
    }

    async fn handle(&mut self, command: RoomCmd) {
        match command {
            RoomCmd::Join {
                key,
                context,
                client,
                version,
                session_id,
                out,
                socket,
                inside,
                reply,
            } => {
                let stale = self.stale_channels(key, &context, client, session_id);
                let (history, live) = (self.in_history(), self.live_ids(&stale));
                let answer = self
                    .client_ids
                    .bind(&context, client, history, live)
                    .and_then(|bound| {
                        // A late session neither syncs raw nor becomes a
                        // session: its first store would overwrite a lost
                        // record (P1 review r3 N9).
                        if self.late(&[bound.client], version) {
                            return Err(crate::socket::LATE_REASON.into());
                        }
                        let bound_client = bound.client;
                        self.join(key, context, bound, session_id, out, socket, inside)?;
                        self.take_over(key, bound_client, stale);
                        Ok(())
                    });
                if answer.is_ok() {
                    self.session_joined(key, version);
                }
                let _ = reply.send(answer);
            }
            RoomCmd::Leave(key, clean, session) => {
                if clean {
                    self.left_clean(key);
                    self.end_session(key, session);
                }
                self.leave(key);
            }
            RoomCmd::Sync(key, payload) => match self.step1_vector(key, &payload) {
                Some(since) => self.on_step1(key, since).await,
                None => self.on_sync(key, &payload).await,
            },
            RoomCmd::Awareness(key, payload) => self.on_awareness(key, &payload),
            RoomCmd::QueryAwareness(key) => self.on_query(key),
            RoomCmd::Stateless(key, payload) => self.on_stateless(key, &payload).await,
            RoomCmd::Token(key, context) => {
                if let Some(member) = self.members.get_mut(&key) {
                    // A token turned writable: the channel's bound id is its
                    // own, recorded at its first accepted write (Q226 M1).
                    member.read_only = member.held_read_only || context.access == Access::Read;
                    // A narrowed writer of a source room leaves its presence.
                    let was = in_presence(member, &self.kind);
                    let renamed = member.context.identity != context.identity;
                    member.context = context;
                    self.view_dirty = true;
                    let now = in_presence(member, &self.kind);
                    if was != now || (now && renamed) {
                        self.mark_presence();
                    }
                }
            }
            RoomCmd::Stored(done) => self.stored(*done),
            RoomCmd::RowsWritten(result) => self.rows_written(result),
            RoomCmd::LiveIds(reply) => {
                let live: HashSet<u64> = self
                    .members
                    .values()
                    .flat_map(|member| std::iter::once(member.client).chain(member.worker))
                    .collect();
                let _ = reply.send(live);
            }
            RoomCmd::Projected(version, result) => self.projected(version, result),
            RoomCmd::Persist(reply) => {
                if !self.store.dirty
                    && !self.store.running
                    && !markers::pending(self.state.markers())
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
                if self.store.dirty || markers::pending(self.state.markers()) {
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
            RoomCmd::Holders(reply) => {
                let mut holders: HashMap<String, bool> = HashMap::new();
                for member in self.members.values() {
                    // A writer needs the role; so does a material room's
                    // reading tab of an editor, which is in the presence
                    // (a source room's read channels never are).
                    let editor = member.context.access == Access::Write
                        || (matches!(self.kind, Kindly::Note(_)) && !member.viewer);
                    *holders.entry(member.context.user_id.clone()).or_default() |= editor;
                }
                let _ = reply.send(holders);
            }
            RoomCmd::Folded(folded, collected) => {
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
                if let Some(collected) = collected {
                    let (window, held) = *collected;
                    if let Kindly::Note(note) = &mut self.kind {
                        note.collected.merge_with(window.delete_set.clone());
                    }
                    self.collect_live(&window, held).await;
                }
            }
            RoomCmd::BoardFolded(fold, folded) => self.board_folded(fold, folded),
            RoomCmd::FoldProjected(version, result) => self.fold_projected(version, result),
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
                // Debug builds only: the integration test's room whose
                // snapshot answers past its wait.
                #[cfg(debug_assertions)]
                if self.name.contains(IT_SLOW_SNAPSHOT) {
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(11)).await;
                        drop(reply);
                    });
                    return;
                }
                let _ = reply.send(self.snapshot().await);
            }
            RoomCmd::LiveNote(reply) => {
                let unprojected = matches!(&self.kind,
                    Kindly::Note(note) if note.stored_version > note.projected_version);
                let state = match &self.state {
                    State::Board(_) => Err(IsBoard),
                    State::Doc(doc) if self.store.dirty || self.store.running || unprojected => {
                        Ok(Some(encoded(doc.clone(), StateVector::default()).await))
                    }
                    State::Doc(_) => Ok(None),
                };
                let _ = reply.send(state);
            }
            RoomCmd::ServiceEdit(edit) => self.service_edit(*edit),
            RoomCmd::Items(parts) => self.follow_items(&parts),
            RoomCmd::PeerLoaded => {
                if let Kindly::Note(note) = &mut self.kind {
                    note.items_sent = None;
                }
                self.schedule_flush();
            }
            RoomCmd::PeerReload => self.reload_peer(),
            RoomCmd::PeerStored(metrics, parts) => {
                if self.peer().is_none() {
                    // The other document as stored now: the bound its room
                    // left at its unload no longer holds.
                    if let Some(peer) = self.peer_name() {
                        self.app.quiz_bounds.set(&peer, metrics);
                    }
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
            RoomCmd::DraftArriving { user, id } => {
                let renewed = Instant::now() + self.app.config.group_slack;
                if let Some(group) = self.draft_groups.get_mut(&(user, id)) {
                    group.deadline = group.deadline.max(renewed).min(group.limit);
                }
            }
            RoomCmd::AgentEdit(edit) => self.agent_edit(*edit).await,
            RoomCmd::AgentKeys {
                actor,
                update,
                undo,
                reply,
            } => {
                // Debug builds only: the integration test's keys room that
                // refuses a quiz edit's part, which its content room must
                // then keep out too.
                #[cfg(debug_assertions)]
                if self.name.contains(IT_REFUSE_AGENT_KEYS) {
                    let _ = reply.send(Err(crate::edits::DocumentError::Unavailable(
                        crate::edits::ROOM_RESET,
                    )));
                    return;
                }
                if self.saves_failing() {
                    let _ = reply.send(Err(crate::edits::saves_failing(undo)));
                    return;
                }
                let context = agent_context(&actor);
                let granted = self.server_ids(&update);
                let outcome = self
                    .admit_update(None, &context, false, &update, &granted, None)
                    .await;
                let admitted = matches!(outcome, Outcome::Admitted);
                let _ = reply.send(match outcome {
                    Outcome::Admitted => Ok(()),
                    outcome => Err(agent_refusal(outcome, undo)),
                });
                // Stored at once, as its content room's part (Q403).
                if admitted {
                    self.start_store().await;
                }
            }
            RoomCmd::AgentKnown {
                id,
                request_hash,
                undo_of,
                actor,
                reply,
            } => {
                let _ =
                    reply.send(
                        self.agent
                            .known(&id, &request_hash, undo_of.as_deref(), &actor),
                    );
            }
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
            granted,
            version,
            group,
            reply,
        } = draft;
        let (history, live) = (self.in_history(), self.live_ids(&[]));
        let granted: Vec<u64> = granted
            .into_iter()
            .filter(|&id| {
                self.client_ids
                    .grantable(id, &context.user_id, &history, &live)
            })
            .collect();
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
        // A group's piece is held until its last, which brings the whole.
        let (update, charged, pieces) = match group {
            None => (update.to_vec(), false, None),
            Some(piece) => match self.draft_piece(&context, piece, &update) {
                Ok(Some((whole, pieces))) => {
                    // Peers of a source room hear the pieces, each on its
                    // own, as a channel's group (finding 6; round 2,
                    // finding 2).
                    let source = matches!(self.kind, Kindly::Source(_)) && !pieces.is_empty();
                    (whole, true, source.then_some(pieces))
                }
                Ok(None) => {
                    let (held, answer) = oneshot::channel();
                    let _ = held.send(Ok(()));
                    let _ = reply.send(Ok(answer));
                    return;
                }
                Err(refusal) => {
                    let _ = reply.send(Err(refusal));
                    return;
                }
            },
        };
        let admitted = self
            .admit_draft(&context, &update, &granted, version, charged, pieces)
            .await;
        let answer = match admitted {
            // Held in full, or admitted: the receipt waits for the store.
            Ok(None | Some(Outcome::Admitted)) => Ok(self.durable().await),
            Ok(Some(Outcome::Unheld)) => Err(Refused::new(
                Class::Unheld,
                "the update needs content the room does not hold",
            )),
            Ok(Some(Outcome::Refused { reason, class, .. })) => Err(Refused::new(class, reason)),
            Err(refusal) => Err(refusal),
        };
        let _ = reply.send(answer);
    }

    /// A draft's admission, through the channels' chain ([Room::admit_update]).
    /// None for a group the room already holds in full (the sweep, an opening
    /// editor and another tab may all send it): a no-op, with no allowance
    /// charge and no new store (Epo 2026-10-24, Q321), whose answer still
    /// waits for the store that holds the group (Q360), since the browser
    /// deletes its rows on it. The room handles writes in order, so
    /// back-to-back duplicates count once. `charged`: a group's whole, whose
    /// pieces were charged to the allowance as they came; `pieces`: a source
    /// group's, for peers ([Room::tell]).
    async fn admit_draft(
        &mut self,
        context: &Context,
        update: &[u8],
        granted: &[u64],
        version: u64,
        charged: bool,
        pieces: Option<Vec<Vec<u8>>>,
    ) -> Result<Option<Outcome>, Refused> {
        use futures::FutureExt;
        // A group older than the window, or under a lost session's id, is
        // tried clean like any other (Q436): one naming nothing the room
        // holds collected is admitted as an ordinary draft; one naming
        // collected units is answered late at admission (Q443). Decoded for
        // this check alone: admission decodes it again.
        let held = ydoc::decode(update).is_ok_and(|decoded| !self.changes(&decoded));
        if held {
            return Ok(None);
        }
        if !charged {
            self.take_draft_allowance(context, update.len())?;
        }
        self.app.stats.updates.fetch_add(1, Ordering::Relaxed);
        let read_only = context.access != Access::Write;
        let checked = std::panic::AssertUnwindSafe(async {
            // Debug builds only: the integration tests' panicking update.
            #[cfg(debug_assertions)]
            if update == IT_PANIC_UPDATE {
                panic!("integration test panic");
            }
            self.admit_update(None, context, read_only, update, granted, pieces)
                .await
        })
        .catch_unwind()
        .await;
        let outcome = checked.unwrap_or_else(|_| {
            self.update_panicked(None, update.len());
            Outcome::refused(Class::Malformed, "update cannot be checked")
        });
        // Its session is not counted: until its row is stored, no fold may
        // collect past the version it was made at (Q400, review r3 M1).
        if matches!(outcome, Outcome::Admitted)
            && let (Some(sessions), Kindly::Note(note)) = (&mut self.sessions, &self.kind)
        {
            let version = i64::try_from(version).unwrap_or(i64::MAX);
            sessions.draft_admitted(version.min(note.stored_version));
        }
        Ok(Some(outcome))
    }

    /// A piece of a draft group (`X-Capy-Group`, review of 43fae032a,
    /// finding 2): the page still sends at most 2 MiB a request (Epo
    /// 2026-10-18), and the room holds the pieces by user and group id until
    /// the last, whose whole (with the pieces it came in, for peers) it hands
    /// back to admit; none while more are to come. The same bounds as a
    /// channel's group: the room's group cap, the room's unfinished groups,
    /// its user's one group at a time, its deadline, and a sanity bound on
    /// its count. A piece the room holds in full is neither charged nor kept
    /// (Q321); the others are charged as they come. Round 2:
    /// - the id is the same for every send of the same rows, so a piece the
    ///   group already holds (a resend after a lost answer, another tab's
    ///   send of the same rows) is taken as held, not charged or kept again
    ///   (findings 1 and 4), and the group goes on where it was: a first
    ///   piece sent again is held too;
    /// - a first piece while another group of its user's is unfinished, a
    ///   channel's or a draft send's, is `busy` (Epo 2026-11-23), with no
    ///   timeout;
    /// - past the room's bound on unfinished groups this group alone is
    ///   dropped as `busy` (round 3, finding 6), neither charged nor timed
    ///   out, and the page sends it again 10 s later;
    /// - a count no group within the cap could have is `malformed`, with
    ///   the bytes that came (round 3, finding 9).
    ///
    /// A piece the group does not expect (its earlier pieces dropped or
    /// refused, the room reloaded) is refused `unavailable`, and the group
    /// the room holds stays as it is.
    fn draft_piece(
        &mut self,
        context: &Context,
        piece: DraftPiece,
        update: &[u8],
    ) -> Result<Option<Gathered>, Refused> {
        let cap = self.group_cap();
        let key = (context.user_id.clone(), piece.id);
        if piece.count > max_pieces(cap) {
            let held = self
                .draft_groups
                .remove(&key)
                .map_or(0, |group| group.bytes);
            let reason = too_many_pieces(piece.count, held + update.len(), cap);
            return Err(Refused::new(Class::Malformed, reason));
        }
        let now = Instant::now();
        let (carry, wait, limit) = (
            self.group_carry(cap),
            self.draft_wait(),
            self.group_limit(cap),
        );
        // Never past its limit, as a channel's group (round 6 review).
        let renewed =
            |group: &DraftGroup| ((group.started + carry).max(now) + wait).min(group.limit);
        let held = self
            .draft_groups
            .get(&key)
            .map(|group| (group.count, group.next));
        match held {
            // Already held: renewed, nothing more.
            Some((count, next)) if count == piece.count && piece.index < next => {
                if let Some(group) = self.draft_groups.get_mut(&key) {
                    group.deadline = renewed(group);
                }
                return Ok(None);
            }
            Some((count, next)) if count == piece.count && piece.index == next => {}
            _ if piece.index == 0 => {
                let slot = draft_slot(&self.name, &key.1);
                let Some(claim) = GroupClaim::draft(&self.app, &context.user_id, &slot) else {
                    return Err(Refused::new(
                        Class::Busy,
                        "another group of the user's is unfinished",
                    ));
                };
                self.draft_groups.insert(
                    key.clone(),
                    DraftGroup {
                        count: piece.count,
                        next: 0,
                        pieces: Vec::new(),
                        bytes: 0,
                        _claim: claim,
                        started: now,
                        deadline: (now + carry + wait).min(now + limit),
                        limit: now + limit,
                    },
                );
            }
            // Never removed here: another tab may be sending the same rows
            // under the same name (round 4, finding 6).
            _ => {
                return Err(Refused::new(
                    Class::Unavailable,
                    "the draft group's earlier pieces are not held",
                ));
            }
        }
        let changes = ydoc::decode(update)
            .map(|decoded| self.changes(&decoded))
            .unwrap_or(true);
        if changes {
            let room_bytes = self.group_bytes();
            let held = self.draft_groups.get(&key).map_or(0, |group| group.bytes);
            if held + update.len() > cap {
                self.draft_groups.remove(&key);
                return Err(Refused::new(Class::Limit, "past the room's group cap"));
            }
            if room_bytes + update.len() > 2 * cap {
                self.draft_groups.remove(&key);
                return Err(Refused::new(
                    Class::Busy,
                    "the room holds too many unfinished groups",
                ));
            }
            if let Err(refusal) = self.take_draft_allowance(context, update.len()) {
                self.draft_groups.remove(&key);
                return Err(refusal);
            }
        }
        let Some(group) = self.draft_groups.get_mut(&key) else {
            return Err(Refused::new(Class::Unavailable, "the draft group is gone"));
        };
        if changes {
            group.bytes += update.len();
            group.pieces.push(update.to_vec());
        }
        group.next += 1;
        group.deadline = renewed(group);
        if group.next < group.count {
            return Ok(None);
        }
        let Some(group) = self.draft_groups.remove(&key) else {
            return Err(Refused::new(Class::Unavailable, "the draft group is gone"));
        };
        // Every piece held in full: the last stands for the whole, a no-op.
        if group.pieces.is_empty() {
            return Ok(Some((update.to_vec(), Vec::new())));
        }
        let pieces = group.pieces;
        tokio::task::block_in_place(|| yrs::merge_updates_v1(&pieces))
            .map(|whole| Some((whole, pieces)))
            .map_err(|_| Refused::new(Class::Malformed, "the draft group is not an update"))
    }

    /// Charges a draft piece to the user's update allowance; a user in a
    /// timeout is refused (`too_fast`).
    fn take_draft_allowance(&self, context: &Context, bytes: usize) -> Result<(), Refused> {
        let verdict = self
            .app
            .allowances
            .take(&context.user_id, bytes, Instant::now());
        match Refused::timed_out(&self.app, &context.user_id, verdict) {
            Some(refusal) => Err(refusal),
            None => Ok(()),
        }
    }

    /// An agent edit, Undo or Redo (Q402): a retry or a reversed step's
    /// second request answers with the receipt this room holds; otherwise
    /// the update goes through a person's admission (a quiz's keys through
    /// its keys room's, in the same step), the receipt waits for the store,
    /// which starts at once (Q403), and the answer goes at admission.
    async fn agent_edit(&mut self, edit: AgentEdit) {
        let AgentEdit {
            actor,
            mut receipt,
            step,
            update,
            keys,
            reply,
        } = edit;
        match self
            .admit_agent(&actor, &mut receipt, step, update, keys)
            .await
        {
            Ok(Some(known)) => {
                let _ = reply.send(Ok((known, false)));
            }
            Ok(None) => {
                let _ = reply.send(Ok((receipt.answer(), true)));
                self.agent.pending.push(receipt);
                self.content_changed();
                self.start_store().await;
            }
            Err(refusal) => {
                let _ = reply.send(Err(refusal));
            }
        }
    }

    async fn admit_agent(
        &mut self,
        actor: &str,
        receipt: &mut note_store::AgentReceipt,
        step: Option<AgentStep>,
        update: Option<Vec<u8>>,
        keys: Option<Vec<u8>>,
    ) -> Result<Option<Value>, crate::edits::DocumentError> {
        use crate::edits::{DocumentError, UNDO_GONE, undo_unavailable};
        let undo = receipt.undo_of.clone();
        if let Some(known) =
            self.agent
                .known(&receipt.id, &receipt.request_hash, undo.as_deref(), actor)?
        {
            return Ok(Some(known));
        }
        if self.agent.pending.len() + self.agent.storing.len() >= AGENT_UNSTORED_MAX {
            return Err(DocumentError::Unavailable(
                "too many agent edits of this document wait to be saved",
            ));
        }
        // An agent step lives only in the room until stored: none while the
        // room's saves fail (Q456). People keep editing.
        if self.saves_failing() {
            return Err(crate::edits::saves_failing(undo.is_some()));
        }
        if let Some(of) = &undo {
            // The step as this room admitted it, else as stored: a click
            // before its store works (Q403).
            let Some(step) = self
                .agent
                .find(|known| &known.id == of)
                .map(AgentStep::of)
                .or(step)
            else {
                return Err(undo_unavailable(UNDO_GONE));
            };
            if step.actor != actor {
                return Err(DocumentError::Lifecycle(
                    "the step is another user's".into(),
                ));
            }
            receipt.conversation_id = receipt.conversation_id.take().or(step.conversation_id);
            receipt.message_id = receipt.message_id.take().or(step.message_id);
            receipt.effect["operation"] =
                json!(if step.operation.as_deref() == Some("edit_undone") {
                    "edited"
                } else {
                    "edit_undone"
                });
            if update.is_none() && keys.is_none() {
                return Err(undo_unavailable(UNDO_GONE));
            }
        }
        let context = agent_context(actor);
        let undoing = undo.is_some();
        if let Some(keys) = keys {
            // Checked here first, applied once the keys room admitted its
            // part: nothing else runs in this room meanwhile, so the check
            // holds (Q403).
            if let Some(update) = &update {
                let granted = self.server_ids(update);
                match self.check_update(None, &context, false, update, &granted, &mut None) {
                    Ok(_) | Err(Outcome::Admitted) => {}
                    Err(outcome) => return Err(agent_refusal(outcome, undoing)),
                }
                if let Kindly::Note(note) = &mut self.kind {
                    note.validator.invalidate();
                }
            }
            // Loaded for this edit if it unloaded since its snapshot: its
            // stored state is then what the edit was computed on (Q403).
            let Kindly::Note(note) = &self.kind else {
                return Err(DocumentError::Unavailable(crate::edits::ROOM_RESET));
            };
            let name = RoomName::Material {
                material_id: note.material_id.clone(),
                schema: note.schema,
                keys: true,
            };
            let peer = self
                .app
                .rooms
                .get_or_spawn(&name.to_string(), |id| spawn(&self.app, &name, id, actor));
            let (done, answer) = oneshot::channel();
            let sent = peer
                .tx
                .send(RoomCmd::AgentKeys {
                    actor: actor.to_owned(),
                    update: keys,
                    undo: undoing,
                    reply: done,
                })
                .await;
            if sent.is_err() {
                return Err(DocumentError::Unavailable(crate::edits::ROOM_RESET));
            }
            match answer.await {
                Ok(Ok(())) => {}
                Ok(Err(refusal)) => return Err(refusal),
                Err(_) => return Err(DocumentError::Unavailable(crate::edits::ROOM_RESET)),
            }
        }
        if let Some(update) = update {
            // Computed on a snapshot: a live collection since may have
            // dropped a unit it names, answered late at admission (Q419,
            // Q432, Q443).
            let granted = self.server_ids(&update);
            let outcome = self
                .admit_update(None, &context, false, &update, &granted, None)
                .await;
            if !matches!(outcome, Outcome::Admitted) {
                // The check above passed on this same state; logged if the
                // keys landed alone all the same.
                log(
                    Level::Warn,
                    "agent edit refused at its apply",
                    json!({ "room": self.name }),
                );
                return Err(agent_refusal(outcome, undoing));
            }
        }
        Ok(None)
    }

    /// The ids an agent's update writes under that no user holds (Q402):
    /// the server's, the edit's scratch id and those an Undo or Redo payload
    /// carries from the step it reverses. An id recorded to a user, bound to
    /// a channel or the room's own stays refused.
    fn server_ids(&self, update: &[u8]) -> Vec<u64> {
        let Ok(decoded) = ydoc::decode(update) else {
            return Vec::new();
        };
        let recorded = self.client_ids.ids();
        let state = self.state.state_vector();
        client_ids::written(&state, &decoded)
            .into_iter()
            .filter(|id| {
                !recorded.contains(id)
                    && *id != self.state.client().get()
                    && !self
                        .members
                        .values()
                        .any(|member| member.client == *id || member.worker == Some(*id))
            })
            .collect()
    }

    /// A draft's receipt: answered once nothing is left to store, so after
    /// the store that holds what the room took.
    async fn durable(&mut self) -> Durable {
        let (done, durable) = oneshot::channel();
        if self.nothing_to_store() {
            let _ = done.send(Ok(()));
        } else {
            self.store.waiters.push(done);
            self.start_store().await;
        }
        durable
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
        let Some(doc) = self.document() else {
            self.child_passes.clear();
            return;
        };
        while let Some(pass) = self.child_passes.pop_front() {
            let plan = {
                let txn = doc.transact();
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
            client_id: None,
            worker_client_id: None,
            viewer: false,
            parent: None,
            identity: Default::default(),
        };
        // Note rooms alone run children passes (`next_child_pass`).
        let Some(doc) = self.document() else {
            return;
        };
        if let Some(marker) = self.markers.write(&doc, &context) {
            self.broadcast_update(None, marker);
        }
        let root = doc.get_or_insert_text(notes::plate::CONTENT_ROOT);
        let mut txn = doc.transact_mut();
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
        self.app.rooms.get(&self.peer_name()?)
    }

    /// The other document's room name of a note room (one only a quiz has).
    fn peer_name(&self) -> Option<String> {
        let Kindly::Note(note) = &self.kind else {
            return None;
        };
        Some(match note.doc {
            note_store::Doc::Content => format!("keys:{}:schema:{}", note.material_id, note.schema),
            note_store::Doc::Keys => {
                format!("material:{}:schema:{}", note.material_id, note.schema)
            }
        })
    }

    /// A quiz room's other document's bound as it stands: its loaded room's
    /// (`App::quiz_bounds`), else as last read.
    fn peer_bound(&self) -> Option<notes::limits::Metrics> {
        let Kindly::Note(note) = &self.kind else {
            return None;
        };
        if !note.model.quiz() {
            return None;
        }
        let loaded = self
            .peer_name()
            .and_then(|peer| self.app.quiz_bounds.get(&peer));
        loaded.or(note.validator.peer())
    }

    /// A quiz room's admitted update: its document's new bound is taken
    /// against the other document's as it stands now (`QuizBounds::take`).
    /// When the other's moved since admission read it (`read`), growth past
    /// a limit the two share is refused, though admission let it in, and the
    /// validator, which counted it, measures afresh; otherwise the update is
    /// taken as admitted, a shrink included.
    fn take_quiz_bound(
        &mut self,
        read: Option<notes::limits::Metrics>,
        before: Option<notes::limits::Metrics>,
    ) -> Result<(), (notes::limits::LimitCode, notes::limits::Metrics)> {
        let Some(peer) = self.peer_name() else {
            return Ok(());
        };
        let Kindly::Note(note) = &mut self.kind else {
            return Ok(());
        };
        let Some(own) = note.validator.bound().filter(|_| note.model.quiz()) else {
            return Ok(());
        };
        let unloaded = note.validator.peer();
        let taken = (self.app.quiz_bounds).take(&self.name, &peer, own, read, before, unloaded);
        if taken.is_err() {
            note.validator.invalidate();
        }
        taken
    }

    fn send_peer(&self, cmd: RoomCmd) {
        if let Some(peer) = self.peer() {
            tokio::spawn(async move {
                let _ = peer.tx.send(cmd).await;
            });
        }
    }

    /// Once per flush window at most: a quiz's keys room sends the content
    /// room its matching and ordering entries when they changed (the two
    /// documents' bounds meet in `App::quiz_bounds`).
    fn send_to_peer(&mut self) {
        if !matches!(&self.kind, Kindly::Note(note)
            if note.model.quiz() && note.doc == note_store::Doc::Keys)
        {
            return;
        }
        let (Some(peer), Some(doc)) = (self.peer(), self.document()) else {
            return;
        };
        let parts = items::quiz::item_parts(&doc.transact());
        let Kindly::Note(note) = &mut self.kind else {
            return;
        };
        if note.items_sent.as_ref() != Some(&parts) {
            note.items_sent = Some(parts.clone());
            tokio::spawn(async move {
                let _ = peer.tx.send(RoomCmd::Items(parts)).await;
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
        // Debug builds only: the integration test's server edit that fails.
        #[cfg(debug_assertions)]
        let failing = self.name.contains(IT_FAIL_SERVICE_EDIT);
        #[cfg(not(debug_assertions))]
        let failing = false;
        let applied = ydoc::decode(&edit.update)
            .map_err(|error| error.to_string())
            .and_then(|update| {
                if failing {
                    return Err("integration test apply failure".to_owned());
                }
                match &self.state {
                    State::Doc(doc) => ydoc::apply(doc, update).map_err(|error| error.to_string()),
                    // No server edit writes a canvas (`edits.rs` refuses
                    // them); one that did is in the stored rows the next
                    // room loads.
                    State::Board(_) => Err("a board room applies no server edit".to_owned()),
                }
            });
        let update = match applied {
            Ok(update) => update,
            Err(error) => {
                observe::capture(
                    &error,
                    None,
                    &[("room", &self.name), ("stage", "service_edit")],
                );
                // Its row committed: the room reloads from the stored
                // document, which holds it (Q389), and counts nothing past
                // it meanwhile.
                self.reload();
                return;
            }
        };
        // An agent's growth counts toward the cap as a writer's does.
        if let Kindly::Source(source) = &mut self.kind {
            source.estimate.applied(update.len() as u64, 0);
        }
        self.broadcast_update(None, update);
        self.durable.union(&edit.durable);
        self.app
            .stats
            .log_bytes
            .fetch_add(edit.row_bytes as u64, Ordering::Relaxed);
        match &mut self.kind {
            Kindly::Note(note) => {
                // Content the validator did not admit: its growth bound is stale.
                note.validator.invalidate();
                // A store that committed after the edit may have been
                // announced to no one yet (`announce_stored`).
                note.stored_version = if note.sessioned() {
                    crate::sessions::took(note.stored_version, &mut note.gaps, edit.version as i64)
                } else {
                    note.stored_version.max(edit.version as i64)
                };
                note.log_rows += 1;
                note.log_bytes += edit.row_bytes as i64;
            }
            Kindly::Source(source) => {
                source.checkpoint = source.checkpoint.max(edit.version);
                source.log_rows += 1;
                source.log_bytes += edit.row_bytes as i64;
            }
        }
        self.maybe_fold();
    }

    /// Reloads the room from the stored document (Q389: a server edit whose
    /// committed row it cannot apply): joins wait as for a drain, every
    /// channel closes as the room is reset (its tab rejoins and resyncs, its
    /// unsent edits going again), and the room stores what it holds and
    /// unloads; the next room loads every row.
    fn reload(&mut self) {
        if self.reloading {
            return;
        }
        self.reloading = true;
        self.app.evictions.begin(&self.name, true);
        let keys: Vec<MemberKey> = self.members.keys().copied().collect();
        for key in keys {
            self.close_channel(key, None, 0, crate::edits::ROOM_RESET);
        }
        self.flush();
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
        let unsaved = self.store.dirty
            || self.store.retry_at.is_some()
            || markers::pending(self.state.markers());
        if unsaved && self.discard_pending.is_none() {
            let cause = incidents::broadcast_cause(notification.as_deref());
            self.record_room_incidents(&cause, None);
            self.app.evictions.reject(&self.name);
            self.discard_pending = Some(cause);
        }
        self.store.dirty = false;
        self.store.retry_at = None;
        self.agent.discard();
        self.answer_store_waiters(Err("collaboration room discarded".into()));
        let _ = reply.send(Ok(()));
    }

    /// `roomIncidents`: one incident per writer with unsaved work in the room,
    /// or one naming nobody.
    fn record_room_incidents(&self, cause: &Cause, bytes: Option<u64>) {
        let users: BTreeSet<String> = self
            .markers
            .contributors(self.state.markers())
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

    /// Folds the log once it passes the configured size (DESIGN.md 3.5); a
    /// board's also once its tail passes [BOARD_TAIL] (Epo 2026-11-24), a
    /// compaction its room swaps in ([Room::board_folded]).
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
                    let _ = handle.tx.send(RoomCmd::Folded(folded, None)).await;
                });
                return;
            }
        };
        let mut threshold = min_bytes.max(note.base_bytes);
        if let State::Board(_) = self.state {
            threshold = threshold.min(BOARD_TAIL);
        }
        // A committed row the room has not applied (a direct write racing its
        // load): no fold until it arrives, so the window never holds a row the
        // open room lacks and a store holding a draft group is folded with it
        // (Q419); `service_edit()` folds once the gap closes.
        if note.folding
            || !note.gaps.is_empty()
            || (note.log_bytes < threshold && note.log_rows < max_rows)
        {
            return;
        }
        // A board's fold begins before it reads its rows: they hold at least
        // the ones committed now, and rows stored from now on stay in the
        // tail past its base.
        let fold = match &mut self.state {
            State::Board(board) => match board.begin_fold() {
                Some(fold) => {
                    note.growth.fold_began();
                    Some(fold)
                }
                None => return,
            },
            State::Doc(_) => None,
        };
        note.folding = true;
        let (app, material_id, schema, through, doc_kind, model) = (
            self.app.clone(),
            note.material_id.clone(),
            note.schema,
            note.stored_version,
            note.doc,
            note.model,
        );
        let holds = self.fold_holds(Some(self.state.client()));
        // The fold's window is at most the version every counted session
        // reached (the stored one when none counts): a JOIN or draft group
        // older than that while the fold runs is late already.
        if let (Some(holds), Kindly::Note(note)) = (&holds, &mut self.kind) {
            note.window = note.window.max(holds.reached.unwrap_or(through));
        }
        tokio::spawn(async move {
            let holds = one_process(&app, &material_id, holds).await;
            // The fold gives the permit back before it returns, so none is
            // held while `Folded` waits for room in the room's queue.
            let permit = board_permit(&app, model, WorkKind::Fold, &material_id).await;
            let mut folded = note_store::fold(
                &app.db,
                &material_id,
                schema,
                doc_kind,
                Some(through),
                holds,
                permit,
            )
            .await
            .unwrap_or_else(|error| {
                observe::capture(
                    &error.to_string(),
                    None,
                    &[("room", &material_id), ("stage", "fold")],
                );
                None
            });
            let projection = folded.as_mut().and_then(|f| f.projection.take());
            let done = match (fold, folded) {
                // `note_store::fold` returns a board's base and indexes, or
                // fails.
                (Some(fold), Some(f)) => {
                    let folded = f.board.map(|(base, indexes)| {
                        Box::new(BoardFold {
                            rows: f.rows as i64,
                            log_bytes: f.log_bytes,
                            base_bytes: f.base_bytes,
                            base,
                            indexes,
                        })
                    });
                    RoomCmd::BoardFolded(fold, folded)
                }
                (Some(fold), None) => RoomCmd::BoardFolded(fold, None),
                (None, Some(f)) => RoomCmd::Folded(
                    Some((f.rows as i64, f.log_bytes, f.base_bytes)),
                    f.collected.map(Box::new),
                ),
                (None, None) => RoomCmd::Folded(None, None),
            };
            let _ = handle.tx.send(done).await;
            // A board's fold projects its new base, after the swap is queued
            // (project() records and reports its own failure).
            if let Some((version, content)) = projection {
                let result = projection::project(&app, &material_id, version, &content, None).await;
                let _ = handle
                    .tx
                    .send(RoomCmd::FoldProjected(version, result))
                    .await;
            }
        });
    }

    /// A board's fold ended (`maybe_fold`): its new base and indexes replace
    /// the base and the rows it covered ([Board::folded]), the rows stored
    /// since it began staying in the tail, off the async workers. The size
    /// bound takes the base's exact bytes with what it does not hold
    /// ([BoardGrowth]). A fold that failed (the task reported why) or found
    /// nothing gives its rows back to the tail ([Board::fold_failed]).
    ///
    /// The new base deletes no live marker, so nothing is written again: a
    /// fold reads the rows through the version this room took as stored
    /// when it began (`maybe_fold`), and a row is taken as stored only as
    /// its store's commit clears the markers that row hid (`stored`), every
    /// live marker at its snapshot (`markers::Markers::claim`, with
    /// [Board::row] and no await between them). A marker the writer wrote
    /// again since is a new item, which no stored row holds. Rows of an
    /// earlier life hold none of this life's markers: a load starts its
    /// marker document empty ([Board::load]).
    fn board_folded(&mut self, fold: board::Fold, folded: Option<Box<BoardFold>>) {
        let (State::Board(board), Kindly::Note(note)) = (&mut self.state, &mut self.kind) else {
            return;
        };
        note.folding = false;
        let unfolded = note.growth.fold_ended();
        let Some(folded) = folded else {
            if let Err(error) = tokio::task::block_in_place(|| board.fold_failed(fold)) {
                observe::capture(
                    &error.to_string(),
                    None,
                    &[("room", &self.name), ("stage", "board_fold")],
                );
            }
            return;
        };
        let BoardFold {
            rows,
            log_bytes,
            base_bytes,
            base,
            indexes,
        } = *folded;
        note.log_rows -= rows;
        note.log_bytes -= log_bytes;
        note.base_bytes = base_bytes;
        let base_len = base.len() as u64;
        let swapped = tokio::task::block_in_place(|| {
            board.folded(fold, base, indexes)?;
            let markers = board
                .markers()
                .transact()
                .encode_state_as_update_v1(&StateVector::default())
                .len() as u64;
            Ok::<_, board::BoardError>(markers)
        });
        match swapped {
            Ok(markers) => {
                if let Some(unfolded) = unfolded {
                    note.validator.tighten(base_len + markers + unfolded);
                }
            }
            Err(error) => {
                observe::capture(
                    &error.to_string(),
                    None,
                    &[("room", &self.name), ("stage", "board_fold")],
                );
            }
        }
        unlog_bytes(&self.app, log_bytes.max(0) as u64);
    }

    /// A board fold's projection was sent ([Room::maybe_fold]): sent, the
    /// room's projection reaches its version, so the idle projection does
    /// not send that version again. It neither ends a running projection
    /// nor answers an on-demand one, which asks for the stored version.
    fn fold_projected(&mut self, version: i64, result: Result<(), String>) {
        if let (Kindly::Note(note), Ok(())) = (&mut self.kind, result) {
            note.projected_version = note.projected_version.max(version);
            note.projected_at = Instant::now();
        }
    }

    /// The open room collects its own document (Q401) at the window and held
    /// set its threshold fold collected the stored state at, in its own task
    /// (what arrives meanwhile waits), and swaps the result in: tabs joining
    /// get the collected state, open tabs keep their tombstones. The state
    /// vector, the unstored edits, the room's own marker chains and its
    /// window stay. A guard refusal (or a panic), reported once, drain-closes
    /// the room (Q449): it stores what it holds and unloads, its tabs
    /// reconnect, and the next room loads the collected stored copy, so the
    /// room never admits an update anchored on history its stored copy
    /// dropped. Agent edits waiting to be stored do not hold it back
    /// (Q432): their deletions are newer than any window, and their Undo is
    /// a payload checked against what the room holds collected.
    async fn collect_live(&mut self, window: &ydoc::gc::Window, held: yrs::IdSet) {
        let Kindly::Note(note) = &self.kind else {
            return;
        };
        // Debug builds only: the integration tests' refused or panicking
        // live pass (the stored fold collects).
        #[cfg(debug_assertions)]
        let (refuse, panics) = (
            note.material_id.contains(IT_REFUSE_LIVE),
            note.material_id.contains(IT_PANIC_LIVE),
        );
        #[cfg(not(debug_assertions))]
        let (refuse, panics) = (false, false);
        // Only a note's content room collects (Q274), on its document.
        let Some(doc) = self.document() else {
            return;
        };
        let (model, started) = (note.model, Instant::now());
        let window = window.clone();
        let collected = tokio::task::spawn_blocking(move || {
            if panics {
                panic!("integration test live collection panic");
            }
            if refuse {
                return Err("integration test refusal".to_owned());
            }
            note_store::collect_live(&doc, &window, &held, model)
        })
        .await
        .unwrap_or_else(|error| Err(error.to_string()));
        match collected {
            Ok(Some((doc, units))) => {
                self.state = State::Doc(doc);
                log(
                    Level::Info,
                    "live document collected",
                    json!({
                        "room": self.name,
                        "units": units,
                        "ms": started.elapsed().as_millis() as u64,
                    }),
                );
            }
            Ok(None) => {}
            Err(why) => {
                note_store::report_refusal(&note.material_id, note.doc, "live", &why);
                self.reload();
            }
        }
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
    /// blocking pool; a board's parts, [Room::step1_answer]) and charged to
    /// its user's open budget by the answer's bytes (Epo 2026-10-19). An
    /// answer under `SMALL_ANSWER` goes at once while the user owes less
    /// than a full budget (Epo 2026-10-20). Any other is encoded in its
    /// user's turn, so their waiting answers are charged one at a time, and
    /// waits while the budget is spent or another one of theirs is being
    /// encoded: the member then keeps only its latest step 1 and hears once
    /// that its open is slowed. A bounded walk tells a large answer before
    /// the encode (the encode checks it after), so a waiting step 1 costs no
    /// encode; a board's joiner behind its base is taken as large.
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
        // A board's answer is large when it diffs the base under the board
        // work permit, or sends a base of that size whole.
        let large = match &self.state {
            State::Doc(doc) => ydoc::answer_at_least(&doc.transact(), &since, small),
            State::Board(board) => {
                board.behind_base(&since)
                    || (!board.holds_base(&since) && board.base_len() >= small)
            }
        };
        if self.app.allowances.small_skips(&user, Instant::now()) && !large {
            let Some(answer) = self.step1_answer(key, since.clone()).await else {
                return;
            };
            if answer.size() < small {
                self.charge_open(key, answer.size());
                self.answer(key, &answer);
                return;
            }
            match self.app.allowances.open_turn(&user, Instant::now()) {
                Ok(()) => {
                    let mut turn = self.turn(user);
                    turn.bytes = self.answer(key, &answer);
                }
                Err(wait) => self.wait_to_open(key, Some(since), false, wait),
            }
            return;
        }
        match self.app.allowances.open_turn(&user, Instant::now()) {
            Ok(()) => {
                let mut turn = self.turn(user);
                if let Some(answer) = self.step1_answer(key, since).await {
                    turn.bytes = self.answer(key, &answer);
                }
            }
            Err(wait) => self.wait_to_open(key, Some(since), false, wait),
        }
    }

    /// The answer to a step 1 at `since`: a document's state past it,
    /// encoded on the blocking pool, or a board's [board::Join] (the base's
    /// part first, the step 2 last), built off the async workers and, for a
    /// joiner behind the base, whose answer diffs all of it, under the board
    /// work permit. The room waits for it, as for a store's validation, so
    /// nothing changes the state meanwhile. A board whose stored bytes cannot
    /// be read refuses the channel (reported); none then.
    async fn step1_answer(&mut self, key: MemberKey, since: StateVector) -> Option<Answer> {
        let board = match &self.state {
            State::Doc(doc) => return Some(Answer::Diff(encoded(doc.clone(), since).await)),
            State::Board(board) => board,
        };
        let permit = match board.behind_base(&since) {
            true => Some(
                self.app
                    .board_work
                    .acquire(WorkKind::Rejoin, &self.name)
                    .await,
            ),
            false => None,
        };
        let answer = tokio::task::block_in_place(|| {
            board.join(&since).map(|join| Answer::Board {
                updates: join.updates.into_iter().map(Cow::into_owned).collect(),
                step2: join.step2.into_owned(),
            })
        });
        drop(permit);
        match answer {
            Ok(answer) => Some(answer),
            Err(error) => {
                observe::capture(
                    &error.to_string(),
                    None,
                    &[("room", &self.name), ("stage", "board_join")],
                );
                self.refuse(key, &[], "the board cannot be read");
                None
            }
        }
    }

    fn turn(&self, user: String) -> OpenTurn {
        OpenTurn {
            app: self.app.clone(),
            user,
            bytes: 0,
        }
    }

    /// Sends a step 1's answer; its bytes, or 0 when the member left. The
    /// member holds the room's state then: a note's editor hears the stored
    /// version it holds, the latest one already committed when the answer
    /// was built (Editor 2026-10-26). `stored_version` moves only once a
    /// store or a server edit's row committed, and the room handles nothing
    /// else between encoding the answer and sending it; a store still
    /// pending is announced when it commits.
    fn answer(&mut self, key: MemberKey, answer: &Answer) -> usize {
        let Some(member) = self.members.get_mut(&key) else {
            return 0;
        };
        member.synced = true;
        member.seen = self.admissions;
        let client = member.client;
        match answer {
            Answer::Diff(diff) => self.send(key, Kind::Sync, &sync::encode(sync::STEP2, diff)),
            // The browser applies each and holds the board synced at the
            // step 2 (`roomProvider.ts`). One frame, as a document's whole
            // answer is, so the outbox takes it whole however large (the
            // recent updates still hold content deleted since the base).
            Answer::Board { updates, step2 } => {
                let size = answer.size() + 16 * (updates.len() + 1);
                let mut frame = BytesMut::with_capacity(size);
                for update in updates {
                    let message = sync::encode(sync::UPDATE, update);
                    protocol::encode(&mut frame, key.1, Kind::Sync, &message);
                }
                let message = sync::encode(sync::STEP2, step2);
                protocol::encode(&mut frame, key.1, Kind::Sync, &message);
                if let Some(member) = self.members.get(&key) {
                    member.out.frame(frame.freeze());
                }
            }
        }
        if let (Some(sessions), Kindly::Note(note)) = (&mut self.sessions, &self.kind) {
            sessions.synced(client);
            let version = crate::sessions::whole(note.stored_version, &note.gaps);
            let notice = json!({ "type": STORED_TYPE, "version": version });
            self.send(key, Kind::Stateless, &protocol::text(&notice.to_string()));
        }
        answer.size()
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
                        if let Some(answer) = self.step1_answer(key, since).await {
                            turn.bytes = self.answer(key, &answer);
                        }
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

    #[allow(clippy::too_many_arguments)]
    fn join(
        &mut self,
        key: MemberKey,
        context: Context,
        bound: client_ids::Bound,
        session_id: Option<u128>,
        out: Outbox,
        socket: String,
        inside: bool,
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
                inside,
                client: bound.client,
                worker: bound.worker,
                session_id,
                clients: HashSet::new(),
                unplaced: 0,
                acks: 0,
                group: None,
                opening: None,
                synced: false,
                seen: self.admissions,
                version: 0,
            },
        );
        if self
            .members
            .get(&key)
            .is_some_and(|member| in_presence(member, &self.kind))
        {
            self.mark_presence();
        }
        if unsupported && let Some(notice) = self.unsupported() {
            self.send(key, Kind::Stateless, &protocol::text(&notice));
        }
        let sv = self.state.state_vector();
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
        // A busy channel gone waits no more, unless its session is still here
        // on another connection (round 4, finding 2).
        let user = &member.context.user_id;
        let here = member.session_id.is_some()
            && self.members.values().any(|other| {
                other.session_id == member.session_id && &other.context.user_id == user
            });
        if !here {
            let slot = channel_slot(&self.name, key, member.session_id);
            self.app.group_slots.leave(user, &slot);
        }
        if let Some(sessions) = &mut self.sessions {
            let user = &member.context.user_id;
            let recorded = self.client_ids.owned_by(member.client, user);
            sessions.left(member.client, user, std::time::SystemTime::now(), recorded);
        }
        self.view_dirty = true;
        if in_presence(&member, &self.kind) {
            self.mark_presence();
        }
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
        let window = self.outgoing(Instant::now());
        let senders: HashSet<MemberKey> = window.iter().filter_map(|out| out.sender).collect();
        let everyone = messages(window.iter());
        let changed: Vec<u64> = std::mem::take(&mut self.changed_awareness)
            .into_iter()
            .collect();
        let keys: Vec<MemberKey> = self.members.keys().copied().collect();
        for key in keys {
            let mut frame = BytesMut::new();
            let seen = self.members.get(&key).map_or(0, |member| member.seen);
            let own = (senders.contains(&key) || held_pieces(&window, seen))
                .then(|| member_messages(&window, key, seen));
            let updates = own.as_ref().unwrap_or(&everyone);
            for update in updates {
                protocol::encode(
                    &mut frame,
                    key.1,
                    Kind::Sync,
                    &sync::encode(sync::UPDATE, update),
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
        self.window.push(Outgoing {
            sender,
            update,
            piece: false,
            admitted: 0,
        });
        self.schedule_flush();
    }

    /// What a writer's admitted update tells peers: an admitted source
    /// group's `pieces`, in yrs's encoding, each a message of its own at the
    /// update allowance's pace, as they reached the room before groups (a
    /// whole group at once could close readers as too slow, review of
    /// 43fae032a, finding 6); else `update`. They were admitted together, so
    /// peers end in the room's state either way. The pieces come with the
    /// update, never kept beside it, so a panic in its admission leaves none
    /// for the next (round 3, finding 5).
    fn tell(&mut self, writer: Option<MemberKey>, update: Vec<u8>, pieces: Option<Vec<Vec<u8>>>) {
        let Some(pieces) = pieces else {
            self.broadcast_update(writer, update);
            return;
        };
        self.admissions += 1;
        for piece in pieces {
            if let Ok(piece) = yrs::merge_updates_v1([piece.as_slice()]) {
                self.window.push(Outgoing {
                    sender: writer,
                    update: piece,
                    piece: true,
                    admitted: self.admissions,
                });
            }
        }
        self.schedule_flush();
    }

    /// What goes out at this flush ([outgoing]): the window's plain updates
    /// at once, groups' pieces at the allowance's pace.
    fn outgoing(&mut self, now: Instant) -> Vec<Outgoing> {
        let window = std::mem::take(&mut self.window);
        let limits = self.app.config.update_limits;
        let (out, next) = outgoing(window, &mut self.paced, &mut self.pace, limits, now);
        self.paced_at = next;
        out
    }

    /// The bytes of group pieces admitted and not sent yet: they count
    /// against the room's bound on unfinished groups, so writers cannot
    /// queue more than the room lets them hold (round 2, finding 3).
    fn paced_bytes(&self) -> usize {
        waiting_pieces(&self.window, &self.paced)
    }

    fn broadcast_stateless(&self, payload: &str) {
        let text = protocol::text(payload);
        for key in self.members.keys() {
            self.send(*key, Kind::Stateless, &text);
        }
    }

    // ------------------------------------------------------------- sync and updates

    async fn on_sync(&mut self, key: MemberKey, payload: &[u8]) {
        use futures::FutureExt;
        let checked = std::panic::AssertUnwindSafe(self.sync_message(key, payload))
            .catch_unwind()
            .await;
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

    /// The room's whole state for a server read of the live room (an agent
    /// edit's snapshot). A board has none: every server read and edit
    /// refuses a canvas before it asks (`edits.rs`), and one that asked
    /// anyway is refused ([IsBoard]).
    async fn snapshot(&self) -> Result<Vec<u8>, IsBoard> {
        match &self.state {
            State::Doc(doc) => Ok(encoded(doc.clone(), StateVector::default()).await),
            State::Board(_) => Err(IsBoard),
        }
    }

    async fn sync_message(&mut self, key: MemberKey, payload: &[u8]) {
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
        if kind == sync::PIECE {
            self.on_piece(key, body).await;
            return;
        }
        self.on_update(key, body, kind == sync::STEP2, 1, None)
            .await;
    }

    /// A piece of a step 2 or update its client cut in pieces: kept on its
    /// channel until the group's last, which admits them as one update, so
    /// peers and the store get all of it or nothing. Every piece is
    /// acknowledged with its group, or its channel closes or joins again
    /// (review of 43fae032a, findings 1, 3 and 7, and round 2):
    /// - a read-only channel's piece is checked on its own (a piece decodes
    ///   alone) and never kept: one that changes anything is refused;
    /// - a group past the room's group cap ([Room::group_cap]) is refused as
    ///   an update past it, with the bytes that came; one of more pieces
    ///   than any group within it could have ([max_pieces]) is refused as
    ///   malformed ([Room::too_many_pieces]);
    /// - a piece out of its group's order, or a new group over an
    ///   unfinished one, drops the group: its pieces are acknowledged and
    ///   the channel hears step 1, as for an update the room cannot place,
    ///   and its later pieces are acknowledged and let go;
    /// - a group not finished by its deadline ([Room::group_carry]) is
    ///   dropped as late ([GROUP_DROPPED_TYPE], [Room::drop_noticed]):
    ///   acknowledged, and its client sends it again only after its next
    ///   join;
    /// - a first piece while another group of its user's is unfinished, in
    ///   any room, a channel's or a draft send's, is busy (one at a time, Epo
    ///   2026-11-23, [Room::claim_channel_group]), and so is a piece taking the
    ///   room's unfinished groups (and the pieces it is still sending out)
    ///   past twice its group cap (round 3, finding 6): the channel hears
    ///   [GROUP_BUSY_TYPE] and the group's pieces are acknowledged and let
    ///   go; no one is timed out for it.
    async fn on_piece(&mut self, key: MemberKey, body: &[u8]) {
        let Some(piece) = sync::piece(body) else {
            self.refuse(key, &[], "malformed sync message");
            return;
        };
        let step2 = piece.kind == sync::STEP2;
        let Some(member) = self.members.get(&key) else {
            return;
        };
        if member.read_only {
            self.on_update(key, piece.update, step2, 1, None).await;
            return;
        }
        let user = member.context.user_id.clone();
        let cap = self.group_cap();
        // No group in progress can have so many pieces (its first was
        // refused), so the bytes that came are this piece's.
        if piece.count > max_pieces(cap) {
            self.too_many_pieces(key, piece.count, piece.update.len());
            return;
        }
        let now = Instant::now();
        let (carry, limit) = (self.group_carry(cap), self.group_limit(cap));
        let slack = self.app.config.group_slack;
        if piece.index == 0 {
            self.drop_group(key, 0);
            let claim = self.claim_channel_group(key, &user);
            let Some(member) = self.members.get_mut(&key) else {
                return;
            };
            let busy = claim.is_none();
            member.group = Some(Group {
                step2,
                count: piece.count,
                next: 0,
                pieces: (!busy).then(Vec::new),
                bytes: 0,
                acked: 0,
                claim,
                started: now,
                deadline: now + carry + slack,
                limit: now + limit,
                heard: member.out.traffic().heard(),
                beats: member.out.traffic().beats(),
            });
            if busy {
                // Before the acknowledgement, which admits none of it.
                let notice = serde_json::json!({ "room": self.name, "type": GROUP_BUSY_TYPE });
                self.send(key, Kind::Stateless, &protocol::text(&notice.to_string()));
            }
        }
        let room_bytes = self.group_bytes();
        let Some(member) = self.members.get_mut(&key) else {
            return;
        };
        let in_order = member.group.as_ref().is_some_and(|group| {
            group.step2 == step2 && group.count == piece.count && group.next == piece.index
        });
        if !in_order {
            self.drop_group(key, 1);
            // The rest of the stray piece's group is let go as it comes.
            if let Some(member) = self.members.get_mut(&key) {
                let traffic = member.out.traffic();
                let (heard, beats) = (traffic.heard(), traffic.beats());
                member.group = (piece.index + 1 < piece.count).then(|| Group {
                    step2,
                    count: piece.count,
                    next: piece.index + 1,
                    pieces: None,
                    bytes: 0,
                    acked: 0,
                    claim: None,
                    started: now,
                    deadline: now,
                    limit: now,
                    heard,
                    beats,
                });
            }
            return;
        }
        let Some(group) = member.group.as_mut() else {
            return;
        };
        group.next += 1;
        let last = group.next == group.count;
        if group.pieces.is_none() {
            // A dropped group's piece: acknowledged and let go.
            if last {
                member.group = None;
            }
            self.acked(key);
            return;
        }
        let bytes = piece.update.len();
        if group.bytes + bytes > cap {
            let held = group.bytes;
            member.group = None;
            self.group_too_large(key, held + bytes);
            return;
        }
        if room_bytes + bytes > 2 * cap {
            // Busy, not step 1, whose resend would cross the bound again at
            // once (round 3, finding 6); this piece included, as the group
            // already counts it.
            self.drop_noticed(key, GROUP_BUSY_TYPE);
            return;
        }
        group.bytes += bytes;
        if let Some(pieces) = group.pieces.as_mut() {
            pieces.push(piece.update.to_vec());
        }
        group.deadline = ((group.started + carry).max(now) + slack).min(group.limit);
        group.heard = member.out.traffic().heard();
        group.beats = member.out.traffic().beats();
        if !last {
            // The first piece held: its acknowledgement tells the client to
            // send the rest, so a busy answer costs it one piece, not its
            // burst (round 4, finding 5).
            if group.next == 1 {
                group.acked = 1;
                self.acked(key);
            }
            return;
        }
        let Some(Group {
            step2,
            count,
            pieces: Some(pieces),
            acked,
            ..
        }) = member.group.take()
        else {
            return;
        };
        let merged = tokio::task::block_in_place(|| yrs::merge_updates_v1(&pieces));
        let Ok(update) = merged else {
            self.refuse(key, &[], "malformed update");
            return;
        };
        // Peers of a source room hear the pieces, each on its own, at the
        // allowance's pace (finding 6).
        let pieces = matches!(self.kind, Kindly::Source(_)).then_some(pieces);
        self.on_update(key, &update, step2, count - acked, pieces)
            .await;
    }

    /// The most one group of pieces may gather: what one sync message may
    /// carry in a note room, a source room's state cap (a source room takes
    /// whole states).
    fn group_cap(&self) -> usize {
        match &self.kind {
            Kindly::Note(_) => NOTE_MAX_SYNC_BYTES,
            Kindly::Source(source) => usize::try_from(source.state_cap).unwrap_or(usize::MAX),
        }
    }

    /// How long the update allowance takes to carry a group of `cap` bytes.
    /// A group is dropped once it has been gathering that long and its last
    /// piece came the configured slack ago (`group_slack`): an abandoned
    /// group lets go of its bytes, and a slow uplink still finishes one.
    fn group_carry(&self, cap: usize) -> Duration {
        let rate = self.app.config.update_limits.bytes_per_second;
        Duration::from_secs_f64(cap as f64 / rate as f64)
    }

    /// The longest a group of `cap` bytes may gather, a channel's or a
    /// draft send's: its whole cap at the slowest uplink a group must land
    /// on (or its carry, if longer) and the slack. A client that reads
    /// slowly, trickles bytes or sends a held piece again holds its user's
    /// slot and its room's group bound no longer (round 6, finding 4, and
    /// its review: draft groups too).
    fn group_limit(&self, cap: usize) -> Duration {
        let config = &self.app.config;
        let slowest = Duration::from_secs_f64(cap as f64 / config.slowest_uplink as f64);
        self.group_carry(cap).max(slowest) + config.group_slack
    }

    /// How long a draft group waits for its next piece past its carry: the
    /// slack and one whole piece at the slowest uplink a group must land on
    /// ([crate::config::SLOWEST_UPLINK]). An edge or tunnel may take a
    /// request's whole body before the room hears any of it, so its
    /// [RoomCmd::DraftArriving] never comes (round 5, finding 2).
    fn draft_wait(&self) -> Duration {
        self.app.config.group_slack + self.app.config.slowest_piece()
    }

    /// The bytes the room's unfinished groups hold, its channels' and its
    /// draft sends', and the admitted groups' pieces not sent out yet.
    fn group_bytes(&self) -> usize {
        let channels: usize = self
            .members
            .values()
            .filter_map(|member| member.group.as_ref())
            .map(|group| group.bytes)
            .sum();
        let drafts: usize = self.draft_groups.values().map(|group| group.bytes).sum();
        channels + drafts + self.paced_bytes()
    }

    /// Drops `key`'s unfinished group: its pieces so far and `extra` more
    /// are acknowledged, and the channel hears step 1, whose answer carries
    /// what the room lacks, as for an update it cannot place. The group
    /// stays as dropped, so its later pieces are acknowledged as they come.
    /// None, or one dropped before: `extra` alone is acknowledged.
    fn drop_group(&mut self, key: MemberKey, extra: u64) {
        let Some(member) = self.members.get_mut(&key) else {
            return;
        };
        let mut handled = extra;
        if let Some(group) = member.group.as_mut()
            && group.pieces.take().is_some()
        {
            handled += group.next - group.acked;
            group.bytes = 0;
            group.claim = None;
        }
        if handled == 0 {
            return;
        }
        self.send_step1(key);
        self.acked_more(key, handled);
    }

    /// Drops `key`'s group with `notice` ([GROUP_DROPPED_TYPE] when late,
    /// [GROUP_BUSY_TYPE] at the room's bound or taken over): its pieces so
    /// far are acknowledged, its later ones as they come, and the channel
    /// hears the notice before the acknowledgement, never step 1, whose
    /// resend would be late or past the bound again at once (round 2,
    /// finding 5; round 3, finding 6). Its client keeps the edit unsent
    /// until its next join.
    fn drop_noticed(&mut self, key: MemberKey, notice: &str) {
        let Some(member) = self.members.get_mut(&key) else {
            return;
        };
        let Some(group) = member.group.as_mut() else {
            return;
        };
        if group.pieces.take().is_none() {
            return;
        }
        let handled = group.next - group.acked;
        group.bytes = 0;
        group.claim = None;
        let notice = serde_json::json!({ "room": self.name, "type": notice });
        self.send(key, Kind::Stateless, &protocol::text(&notice.to_string()));
        self.acked_more(key, handled);
    }

    /// The channel `key`'s group slot for its user ([GroupClaim::channel]),
    /// under its JOIN session ([channel_slot]). Taken, a group of the same
    /// session on another connection, a reconnecting tab's whose old
    /// connection the room has not seen close, is let go
    /// ([GROUP_BUSY_TYPE]); no other is, however quiet its connection: a
    /// live tab on a slow uplink sends a 2 MiB piece for longer than the
    /// pings (round 4, finding 1).
    fn claim_channel_group(&mut self, key: MemberKey, user: &str) -> Option<GroupClaim> {
        let session = self.members.get(&key)?.session_id;
        let claim = GroupClaim::channel(&self.app, user, &channel_slot(&self.name, key, session))?;
        let stale: Vec<MemberKey> = self
            .members
            .iter()
            .filter(|(other, member)| {
                **other != key
                    && session.is_some()
                    && member.session_id == session
                    && member.context.user_id == user
                    && member
                        .group
                        .as_ref()
                        .is_some_and(|group| group.claim.is_some())
            })
            .map(|(other, _)| *other)
            .collect();
        for other in stale {
            self.drop_noticed(other, GROUP_BUSY_TYPE);
        }
        Some(claim)
    }

    /// A group naming more pieces than one within [Room::group_cap] may
    /// have ([max_pieces]), refused as malformed with its own reason and
    /// the bytes that came, never as a document past its size (round 3,
    /// finding 9): a note room's editor hears `invalid_document`, a source
    /// room's sender that it is unrecoverable.
    fn too_many_pieces(&mut self, key: MemberKey, count: u64, bytes: usize) {
        let Some(context) = self.members.get(&key).map(|member| member.context.clone()) else {
            return;
        };
        let reason = too_many_pieces(count, bytes, self.group_cap());
        let payloads = match &self.kind {
            Kindly::Note(_) => vec![
                json!({
                    "code": "invalid_document",
                    "materialId": self.material_id(),
                    "room": self.name,
                    "type": "document-rejected",
                })
                .to_string(),
            ],
            Kindly::Source(_) => {
                let refusal = sources::Refusal::Malformed(reason.clone());
                match self.source_update_refused(Some(key), &context, &refusal, bytes) {
                    Outcome::Refused { payloads, .. } => payloads,
                    _ => Vec::new(),
                }
            }
        };
        self.refuse(key, &payloads, &reason);
    }

    /// A group past [Room::group_cap], refused as an update past the room's
    /// cap: a note room's with its size limit, as admission refuses a
    /// document past it, so its editor shows the size refusal instead of
    /// joining again to resend it (finding 3); a source room's as one past
    /// its state cap.
    fn group_too_large(&mut self, key: MemberKey, bytes: usize) {
        let Some(context) = self.members.get(&key).map(|member| member.context.clone()) else {
            return;
        };
        let outcome = match &self.kind {
            Kindly::Note(_) => {
                let metrics = notes::limits::Metrics {
                    content_bytes: bytes as u64,
                    max_depth: 0,
                    node_count: 0,
                };
                let code = notes::limits::LimitCode::DocumentSizeExceeded;
                self.limit_refused(&context, code, metrics, bytes)
            }
            Kindly::Source(_) => {
                let refusal = sources::Refusal::StateBytes;
                self.source_update_refused(Some(key), &context, &refusal, bytes)
            }
        };
        if let Outcome::Refused {
            payloads, reason, ..
        } = outcome
        {
            self.refuse(key, &payloads, &reason);
        }
    }

    /// `messages`: the messages it came in (a group's, or 1), each of which
    /// the client counts until acknowledged; `pieces`: a source group's, for
    /// peers ([Room::tell]).
    async fn on_update(
        &mut self,
        key: MemberKey,
        bytes: &[u8],
        step2: bool,
        messages: u64,
        pieces: Option<Vec<Vec<u8>>>,
    ) {
        let Some(member) = self.members.get(&key) else {
            return;
        };
        let (context, read_only) = (member.context.clone(), member.read_only);
        self.in_step2 = step2;
        let outcome = self
            .admit_update(Some(key), &context, read_only, bytes, &[], pieces)
            .await;
        self.in_step2 = false;
        // Admission acknowledged one message; a group's others go with it.
        let rest = messages.saturating_sub(1);
        match outcome {
            Outcome::Admitted => self.acked_more(key, rest),
            Outcome::Unheld => {
                self.resync(key, step2, &context);
                self.acked_more(key, rest);
            }
            // Q443: the tab goes late, as for a late JOIN, and merges its
            // unsent edits into a new session.
            Outcome::Refused {
                class: Class::Late, ..
            } => {
                self.send(
                    key,
                    Kind::Refused,
                    &protocol::text(crate::socket::LATE_REASON),
                );
                if let Some(member) = self.members.get(&key) {
                    member.out.channel_closed(key.1);
                }
                self.leave(key);
            }
            Outcome::Refused {
                payloads, reason, ..
            } => self.refuse(key, &payloads, &reason),
        }
    }

    /// A writer's update through every check that reads the room, then the
    /// apply and the broadcast. `writer` is its channel, or none for a draft
    /// send or an agent edit (Q402): nothing to acknowledge or tell of a
    /// children refusal, and every editor receives the update. `pieces`: an
    /// admitted source group's, which peers hear instead ([Room::tell]).
    async fn admit_update(
        &mut self,
        writer: Option<MemberKey>,
        context: &Context,
        read_only: bool,
        bytes: &[u8],
        granted: &[u64],
        mut pieces: Option<Vec<Vec<u8>>>,
    ) -> Outcome {
        // Debug builds only: the integration tests' group whose admission
        // panics, its pieces in hand.
        #[cfg(debug_assertions)]
        if pieces.is_some()
            && bytes
                .windows(IT_PANIC_GROUP.len())
                .any(|window| window == IT_PANIC_GROUP)
        {
            panic!("integration test panic");
        }
        // A board admits on its bytes; a board's peers never hear pieces
        // (only a source room's do).
        if let State::Board(_) = self.state {
            return self
                .admit_board_update(writer, context, read_only, bytes, granted)
                .await;
        }
        match self.check_update(writer, context, read_only, bytes, granted, &mut pieces) {
            Ok(checked) => self.apply_update(writer, context, bytes, checked, pieces),
            Err(outcome) => outcome,
        }
    }

    /// [Room::admit_update]'s checks on a document: the update to apply, or
    /// the outcome (an update with nothing new is admitted without an apply,
    /// and told with `pieces` when it deletes).
    fn check_update(
        &mut self,
        writer: Option<MemberKey>,
        context: &Context,
        read_only: bool,
        bytes: &[u8],
        granted: &[u64],
        pieces: &mut Option<Vec<Vec<u8>>>,
    ) -> Result<Checked, Outcome> {
        let screened = self.screen(writer, context, read_only, bytes, granted)?;
        self.admit_screened(writer, context, bytes, screened, pieces)
    }

    /// A board's writer update (Epo 2026-11-24, bytes-room plan step 2):
    /// the room's checks and [Board::read] ([Room::read_board]), then what
    /// the board lacks of it appended and relayed as it is trimmed
    /// ([Room::append_board]). A small edit enters on its growth alone
    /// (`RoomValidator::board_grows`); one past it, or whose growth would
    /// take the bound past the cap, is first tried on the board's replica
    /// under the board work permit ([Room::board_trial]), the room's queue
    /// waiting with it, as for any trial. Read, tried and appended in this
    /// one command, the update finds the board as its read did. A trial
    /// leaves the bound at the board's exact size. An update past
    /// `ydoc::INLINE_BYTES` (a small edit by its structs, large by its bytes)
    /// is read and appended off the async workers.
    async fn admit_board_update(
        &mut self,
        writer: Option<MemberKey>,
        context: &Context,
        read_only: bool,
        bytes: &[u8],
        granted: &[u64],
    ) -> Outcome {
        let large = bytes.len() > ydoc::INLINE_BYTES;
        let read = if large {
            tokio::task::block_in_place(|| {
                self.read_board(writer, context, read_only, bytes, granted)
            })
        } else {
            self.read_board(writer, context, read_only, bytes, granted)
        };
        let (mut fresh, written, names_asset) = match read {
            Ok(read) => read,
            Err(outcome) => return outcome,
        };
        let Kindly::Note(note) = &mut self.kind else {
            return Outcome::refused(Class::Unavailable, "not a material room");
        };
        let small =
            fresh.check == board::Check::Small && note.validator.board_grows(fresh.growth());
        if !small && let Err(outcome) = self.board_trial(context, bytes.len(), &mut fresh).await {
            return outcome;
        }
        self.append_board(writer, context, fresh, written, names_asset, large)
    }

    /// [Room::admit_board_update]'s checks, with no await (the decoded update
    /// may not cross one). A read-only channel's update is acknowledged when
    /// it tells the board nothing, deletions within held clocks included (a
    /// reader's step 2 names the implicit deletions the board's index
    /// misses), and refused otherwise. A writer's goes through the marker
    /// check, the client-id rule and [Board::read]: unheld, held (acknowledged),
    /// refused, or what the board lacks of it, with the ids it writes under
    /// and whether it names an asset (`model::names_asset`).
    fn read_board(
        &mut self,
        writer: Option<MemberKey>,
        context: &Context,
        read_only: bool,
        bytes: &[u8],
        granted: &[u64],
    ) -> Result<(Box<board::Fresh>, Vec<u64>, bool), Outcome> {
        if let Some(refused) = self.closed_to(context) {
            return Err(refused);
        }
        let Ok(update) = ydoc::decode(bytes) else {
            return Err(Outcome::refused(Class::Malformed, "malformed update"));
        };
        let State::Board(board) = &self.state else {
            return Err(Outcome::refused(Class::Unavailable, "not a board room"));
        };
        if read_only {
            if board.reader_changes(&update) {
                return Err(Outcome::refused(
                    Class::Permission,
                    "read-only connection sent a document update",
                ));
            }
            self.ack(writer);
            return Err(Outcome::Admitted);
        }
        let markers = board.markers();
        if markers::check(&markers.transact(), &update, markers.client_id()).is_err() {
            return Err(Outcome::refused(
                Class::Malformed,
                "client update changed collaboration metadata",
            ));
        }
        // As a document's writer (`screen`, Q213): structs only under ids
        // its user holds.
        let state = board.state_vector();
        let bound: Vec<u64> = self
            .members
            .values()
            .filter(|member| member.context.user_id == context.user_id)
            .flat_map(|member| std::iter::once(member.client).chain(member.worker))
            .collect();
        if let Some(client) = client_ids::foreign(&state, &update, |id| {
            self.client_ids.owned_by(id, &context.user_id)
                || bound.contains(&id)
                || granted.contains(&id)
        }) {
            return Err(self.foreign_update_refused(context, client, bytes.len()));
        }
        let written = client_ids::written(&state, &update);
        let names_asset = crate::model::names_asset(&update);
        match board.read(bytes, &update) {
            Ok(board::Read::New(fresh)) => Ok((fresh, written, names_asset)),
            Ok(board::Read::Held) => {
                self.placed(writer, context);
                self.ack(writer);
                Err(Outcome::Admitted)
            }
            Ok(board::Read::Unheld) => Err(Outcome::Unheld),
            Err(error) => Err(self.refused_on_entry(error.to_string())),
        }
    }

    /// A board update's trial, once the board work permit is free (`work.rs`,
    /// its warnings included): the room and the writer's token are checked
    /// again (the wait lasts as long as the permit's queue), then the board's
    /// replica is built and the update, as the board lacks it, tried on it and,
    /// near the cap or deleting content it does not name, measured
    /// (`model::admit_board`), off the async workers. Admitted, the size
    /// bound becomes the board's exact bytes with the update: the trial's own
    /// measure, or else the replica's with the update applied. The depths of
    /// new types the board's index could not give are read from the replica
    /// with the update applied ([board::Fresh::take_depths]). The replica and
    /// the permit go before anything is appended or sent.
    async fn board_trial(
        &mut self,
        context: &Context,
        sent: usize,
        fresh: &mut board::Fresh,
    ) -> Result<(), Outcome> {
        let permit = self
            .app
            .board_work
            .acquire(WorkKind::Trial, &self.name)
            .await;
        if let Some(refused) = self.closed_to(context) {
            return Err(refused);
        }
        let (State::Board(board), Kindly::Note(note)) = (&self.state, &mut self.kind) else {
            return Err(Outcome::refused(Class::Unavailable, "not a board room"));
        };
        let tried = tokio::task::block_in_place(|| -> Result<Verdict, String> {
            let replica = board.replica().map_err(|error| error.to_string())?;
            let update = ydoc::decode(fresh.bytes()).map_err(|error| error.to_string())?;
            let (admitted, measured) = note.validator.admit_board(&replica, &update, fresh.bytes());
            let verdict = match admitted {
                crate::model::Admitted::Accepted => Verdict::Accept,
                crate::model::Admitted::Unheld => Verdict::Unheld,
                crate::model::Admitted::Limit(code, metrics) => Verdict::Limit(code, metrics),
                crate::model::Admitted::Refused(message) => Verdict::Refused(message),
                crate::model::Admitted::Hidden => Verdict::Hidden,
            };
            if !matches!(verdict, Verdict::Accept) {
                return Ok(verdict);
            }
            if measured.is_none() || fresh.unplaced_types() {
                ydoc::apply(&replica, update).map_err(|error| error.to_string())?;
            }
            if fresh.unplaced_types() {
                fresh.take_depths(&replica);
            }
            if measured.is_none() {
                let exact = crate::model::state_bytes(&replica.transact());
                note.validator.board_measured(exact);
            }
            Ok(verdict)
        });
        drop(permit);
        match tried {
            Ok(Verdict::Accept) => Ok(()),
            Ok(Verdict::Unheld) => Err(Outcome::Unheld),
            Ok(Verdict::Limit(code, metrics)) => {
                Err(self.limit_refused(context, code, metrics, sent))
            }
            Ok(Verdict::Refused(message)) => Err(self.refused_on_entry(message)),
            // A note draft's verdict alone.
            Ok(Verdict::Hidden | Verdict::Source(_)) => Err(Outcome::refused(
                Class::Malformed,
                "a board update was refused",
            )),
            // The board's own bytes would not replay, or the update it read
            // would not apply where its trial passed: reported, and the
            // writer's channel closes (its editor joins again).
            Err(error) => {
                observe::capture(
                    &error,
                    None,
                    &[("room", &self.name), ("stage", "board_trial")],
                );
                Err(Outcome::refused(
                    Class::Unavailable,
                    "the board cannot be tried",
                ))
            }
        }
    }

    /// Appends an admitted board update ([Board::append]) after its writer's
    /// contributor marker, both relayed, peers hearing what the board lacked
    /// of it; then what any admitted write does: the ids it wrote recorded,
    /// its acknowledgement, the store due and, when it names an asset, a
    /// projection after that store.
    fn append_board(
        &mut self,
        writer: Option<MemberKey>,
        context: &Context,
        fresh: Box<board::Fresh>,
        written: Vec<u64>,
        names_asset: bool,
        large: bool,
    ) -> Outcome {
        self.placed(writer, context);
        self.applying = true;
        if let Some(marker) = self.markers.write(self.state.markers(), context) {
            if let Kindly::Note(note) = &mut self.kind {
                note.validator.wrote(marker.len() as u64);
            }
            self.broadcast_update(None, marker);
        }
        let growth = fresh.growth();
        let State::Board(board) = &mut self.state else {
            self.applying = false;
            return Outcome::refused(Class::Unavailable, "not a board room");
        };
        let relayed = if large {
            tokio::task::block_in_place(|| board.append(fresh).to_vec())
        } else {
            board.append(fresh).to_vec()
        };
        self.applying = false;
        if let Kindly::Note(note) = &mut self.kind {
            note.growth.grew(growth);
            note.project_soon |= names_asset;
        }
        if context.token_id != AGENT_TOKEN
            && let Some(rows) =
                self.client_ids
                    .first_writes(&context.user_id, &written, std::time::Instant::now())
        {
            self.write_rows(rows);
        }
        self.ack(writer);
        self.content_changed();
        self.broadcast_update(writer, relayed);
        Outcome::Admitted
    }

    /// The refusal of any update while the room is being reset or the
    /// writer's token has expired.
    fn closed_to(&self, context: &Context) -> Option<Outcome> {
        if self.app.evictions.blocks(&self.name, false) {
            return Some(Outcome::refused(
                Class::Unavailable,
                "collaboration room is being reset",
            ));
        }
        if context.expires_at <= crate::auth::now_seconds() {
            return Some(Outcome::refused(
                Class::Permission,
                "collaboration token expired",
            ));
        }
        None
    }

    /// The checks of a writer's update that read the room's document, up to
    /// whether its admission is heavy.
    fn screen(
        &mut self,
        writer: Option<MemberKey>,
        context: &Context,
        read_only: bool,
        bytes: &[u8],
        granted: &[u64],
    ) -> Result<Screened, Outcome> {
        if let Some(refused) = self.closed_to(context) {
            return Err(refused);
        }
        let Ok(update) = ydoc::decode(bytes) else {
            return Err(Outcome::refused(Class::Malformed, "malformed update"));
        };
        // A board's update goes through [Room::admit_board_update].
        let Some(doc) = self.document() else {
            return Err(Outcome::refused(Class::Unavailable, "not a document room"));
        };
        let changes = ydoc::contains_changes(&doc.transact(), &update);
        if read_only {
            if changes {
                return Err(Outcome::refused(
                    Class::Permission,
                    "read-only connection sent a document update",
                ));
            }
            self.ack(writer);
            return Err(Outcome::Admitted);
        }
        // A document holding a block this version cannot edit stays as it is
        // (a writer whose access came back after it joined, a draft).
        if changes && let Some(notice) = self.unsupported() {
            return Err(Outcome::Refused {
                payloads: vec![notice],
                reason: UNSUPPORTED_BLOCK.into(),
                class: Class::Permission,
            });
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
            return Err(Outcome::Refused {
                payloads: vec![payload],
                reason: OFFICE_PAUSED.into(),
                class: Class::Unavailable,
            });
        }
        if markers::check(&doc.transact(), &update, doc.client_id()).is_err() {
            return Err(Outcome::refused(
                Class::Malformed,
                "client update changed collaboration metadata",
            ));
        }
        // An update naming history a collection discarded would integrate
        // as collected, its text lost: it is answered late, and its writer's
        // late merge places it (Q443). Live updates, draft groups (Q436) and
        // agent edits and Undo all come through here; before admission, so a
        // late group is never answered hidden (merge view V-N1). A note's
        // content room only, the one collected in place: item, diagram and
        // mindmap rooms have no late path and drop typing into a deleted item
        // as Yjs does (Q445).
        if let Kindly::Note(note) = &self.kind
            && note.sessioned()
        {
            use ydoc::gc::Named;
            let late = Outcome::refused(
                Class::Late,
                "the update names units the collection discarded",
            );
            match ydoc::gc::named_collected(&doc.transact(), &update, &note.collected) {
                Named::Nothing => {}
                Named::Window => return Err(late),
                // Only what yrs dropped under a block deleted since: a
                // connected tab's typing goes with the block, as plain Yjs
                // has it (Q446); an agent edit re-reads the note (answered as
                // a hidden draft is, `agent_refusal`); a draft group stays
                // late, its merge keeping the typing as hidden pieces (Q444).
                Named::Since if writer.is_some() => {}
                Named::Since if context.token_id == AGENT_TOKEN => {
                    return Err(Outcome::refused(
                        Class::Hidden,
                        "the edit types into a block deleted since its snapshot",
                    ));
                }
                Named::Since => return Err(late),
            }
        }
        // A writer adds structs only under ids its user holds (Q213): ones
        // recorded to the user, bound to one of the user's live channels (a
        // draft send has none of its own) or granted to a draft by its stored
        // token (Q288). Reserved copy ids are refused until override-seed
        // copies exist (r2 N8).
        let state = doc.transact().state_vector();
        let bound: Vec<u64> = self
            .members
            .values()
            .filter(|member| member.context.user_id == context.user_id)
            .flat_map(|member| std::iter::once(member.client).chain(member.worker))
            .collect();
        if let Some(client) = client_ids::foreign(&state, &update, |id| {
            self.client_ids.owned_by(id, &context.user_id)
                || bound.contains(&id)
                || granted.contains(&id)
        }) {
            return Err(self.foreign_update_refused(context, client, bytes.len()));
        }
        // Recorded once the update is accepted and applied (r2 S1).
        let written = client_ids::written(&state, &update);
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
                notes::limits::heavy(&doc.transact(), &update, bytes.len(), &note.kind)
            }
            Kindly::Note(_) => {
                !ydoc::applies_inline(&doc.transact(), &ydoc::Incoming::new(&update), bytes.len())
            }
            Kindly::Source(source) => {
                !ydoc::applies_inline(&doc.transact(), &ydoc::Incoming::new(&update), bytes.len())
                    || source.estimate.bytes + bytes.len() as u64
                        > sources::admission_cap(source.state_cap)
            }
        };
        Ok(Screened {
            update,
            changes,
            written,
            heavy,
        })
    }

    /// A screened update's admission, then what it needs before its apply.
    fn admit_screened(
        &mut self,
        writer: Option<MemberKey>,
        context: &Context,
        bytes: &[u8],
        screened: Screened,
        pieces: &mut Option<Vec<Vec<u8>>>,
    ) -> Result<Checked, Outcome> {
        let Screened {
            update,
            changes,
            written,
            heavy,
        } = screened;
        // A quiz document counts with the other one's bound as it stands, and
        // its growth is taken against it again once admitted.
        let peer = self.peer_bound();
        let Some(doc) = self.document() else {
            return Err(Outcome::refused(Class::Unavailable, "not a document room"));
        };
        let before = match &mut self.kind {
            Kindly::Note(note) => {
                if let Some(peer) = peer {
                    note.validator.set_peer(peer);
                }
                note.validator.bound()
            }
            Kindly::Source(_) => None,
        };
        let mut admit = || match &mut self.kind {
            Kindly::Note(note) => match note.validator.admit(&doc, &update, writer.is_none()) {
                crate::model::Admitted::Accepted => Verdict::Accept,
                crate::model::Admitted::Unheld => Verdict::Unheld,
                crate::model::Admitted::Hidden => Verdict::Hidden,
                crate::model::Admitted::Limit(code, metrics) => Verdict::Limit(code, metrics),
                crate::model::Admitted::Refused(message) => Verdict::Refused(message),
            },
            Kindly::Source(source) => {
                match sources::admit_update(
                    &doc,
                    source.format,
                    bytes,
                    &mut source.estimate,
                    source.state_cap,
                    source.image_cap,
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
        let verdict = match verdict {
            Verdict::Accept => match self.take_quiz_bound(peer, before) {
                Ok(()) => Verdict::Accept,
                Err((code, metrics)) => Verdict::Limit(code, metrics),
            },
            verdict => verdict,
        };
        match verdict {
            Verdict::Unheld => return Err(Outcome::Unheld),
            // A draft send only: the editor's join shows it for review.
            Verdict::Hidden => {
                return Err(Outcome::refused(
                    Class::Hidden,
                    "the drafts type into a block the room deleted",
                ));
            }
            Verdict::Accept => {}
            Verdict::Source(sources::Refusal::Malformed(message)) => {
                return Err(Outcome::refused(Class::Malformed, message));
            }
            Verdict::Source(refusal) => {
                return Err(self.source_update_refused(writer, context, &refusal, bytes.len()));
            }
            Verdict::Limit(code, metrics) => {
                return Err(self.limit_refused(context, code, metrics, bytes.len()));
            }
            Verdict::Refused(error) => return Err(self.refused_on_entry(error)),
        }
        self.placed(writer, context);
        if !changes {
            // A writer's delete inside content the room already deleted tells
            // the room nothing and an editor holding that content for its
            // Undo that the writer deleted it (Q549). A resync's step 2
            // resends its whole delete set: not that.
            if matches!(self.kind, Kindly::Source(_))
                && !self.in_step2
                && !update.delete_set().is_empty()
                && let Ok(told) = yrs::merge_updates_v1([bytes])
            {
                self.tell(writer, told, pieces.take());
            }
            self.ack(writer);
            return Err(Outcome::Admitted);
        }
        Ok(Checked {
            update,
            written,
            heavy,
        })
    }

    /// [Room::admit_update]'s apply of a checked update and its broadcast.
    fn apply_update(
        &mut self,
        writer: Option<MemberKey>,
        context: &Context,
        bytes: &[u8],
        checked: Checked,
        pieces: Option<Vec<Vec<u8>>>,
    ) -> Outcome {
        let Checked {
            update,
            mut written,
            heavy,
        } = checked;
        let Some(doc) = self.document() else {
            return Outcome::refused(Class::Unavailable, "not a document room");
        };
        let mut applied = 0;
        self.applying = true;
        if let Some(marker) = self.markers.write(&doc, context) {
            applied += marker.len();
            if let Kindly::Note(note) = &mut self.kind {
                note.validator.wrote(marker.len() as u64);
            }
            self.broadcast_update(None, marker);
        }
        // A source room's estimate also takes off what the update's deletes
        // freed (Epo 2026-10-19); a note's sessions hold what it deleted.
        let seed = match &self.kind {
            Kindly::Source(source) => Some(source.seed.as_ref()),
            Kindly::Note(_) => None,
        };
        let sessioned = self.sessions.is_some();
        let apply = || match seed {
            Some(seed) => ydoc::apply_freeing(&doc, update, seed)
                .map(|(content, freed, lost)| (content, freed, yrs::IdSet::new(), lost)),
            None if sessioned => ydoc::apply_deleting(&doc, update)
                .map(|(content, deleted)| (content, 0, deleted, ydoc::Lost::default())),
            None => ydoc::apply(&doc, update)
                .map(|content| (content, 0, yrs::IdSet::new(), ydoc::Lost::default())),
        };
        let content = if heavy {
            tokio::task::block_in_place(apply)
        } else {
            apply()
        };
        self.applying = false;
        let (content, freed, deleted, lost) = match content {
            Ok(content) => content,
            Err(error) => {
                // yrs keeps the structs it integrated before the error: part
                // of a refused update may be in the document, which peers
                // lack until they resync and the next store saves. No known
                // shape gets here past admission (`ydoc::inspect` refuses an
                // item under a non-type of its own update), so it is
                // reported. The room keeps its document: discarding it would
                // drop the other editors' unsaved changes.
                let (material, kind) = match &self.kind {
                    Kindly::Note(note) => (note.material_id.as_str(), note.kind.clone()),
                    Kindly::Source(source) => (
                        source.room.file_id.as_str(),
                        format!("{:?}", source.format).to_ascii_lowercase(),
                    ),
                };
                observe::capture(
                    &format!("an admitted update failed to apply, maybe in part: {error}"),
                    None,
                    &[
                        ("room", &self.name),
                        ("stage", "live_apply"),
                        ("material", material),
                        ("kind", &kind),
                    ],
                );
                // Admission's bound may no longer match the document.
                if let Kindly::Note(note) = &mut self.kind {
                    note.validator.invalidate();
                }
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
        // A channel's own deletions are held for its session's Undo (a step
        // 2's resent delete set adds only what the room held undeleted), and
        // a deletion is a write that records the session's id, whose row
        // keeps them (`sessions.rs`). A draft send's session has ended.
        if let (Some(sessions), Some(member)) = (
            &mut self.sessions,
            writer.and_then(|key| self.members.get(&key)),
        ) {
            let now = std::time::SystemTime::now();
            // A channel with no session (a viewer whose token turned
            // writable) gets one at its first write (review r1 L1).
            if !sessions.has(member.client)
                && sessions.joined(member.client, &context.user_id, member.version, now)
                && member.synced
            {
                sessions.synced(member.client);
            }
            if sessions.deleted(member.client, &context.user_id, deleted, now)
                && !written.contains(&member.client)
            {
                written.push(member.client);
            }
        }
        // The first accepted write under an id in this room's life records
        // it as the user's (Q236), or refreshes its row once a day (M3). An
        // agent edit's scratch id is the server's, as before Q402.
        if context.token_id != AGENT_TOKEN
            && let Some(rows) =
                self.client_ids
                    .first_writes(&context.user_id, &written, std::time::Instant::now())
        {
            self.write_rows(rows);
        }
        self.ack(writer);
        if !content.is_empty() {
            self.content_changed();
            // What the room's collection took out still reaches an editor
            // whose Undo can bring it back (Q549); stored state and joiners
            // never hold it. A resync's step 2 names its whole delete set,
            // so only what landed counts there. In yrs's own encoding, as
            // everything peers hear from a room.
            let told = (lost.landed || (lost.deletions && !self.in_step2))
                .then(|| yrs::merge_updates_v1([bytes]).ok())
                .flatten();
            self.tell(writer, told.unwrap_or(content), pieces);
            self.repair_on_entry(bytes, heavy);
            // A paste, undo or replayed draft that wrote child ids gets a
            // children pass; typing writes none and costs a decode.
            if matches!(&self.kind, Kindly::Note(note) if note.model == crate::model::Model::Note)
                && let Ok(update) = ydoc::decode(bytes)
                && notes::children::child_writes(&doc.transact(), &update).is_some()
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
        let (true, Some(doc)) = (model.repairs(), self.document()) else {
            return;
        };
        let repair = || {
            let update = ydoc::decode(bytes).ok()?;
            let mut txn = doc.transact_mut();
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

    /// An update with structs under a client id its writer's user was not
    /// assigned: refused on entry, as an invalid document (a note or item:
    /// the editor keeps its unsaved edits to copy and reloads) or an
    /// unrecoverable source update (recovery). An honest editor sends one
    /// only after the server lost unstored state its tab holds (Q213).
    fn foreign_update_refused(&self, context: &Context, client: u64, bytes: usize) -> Outcome {
        log(
            Level::Warn,
            "update under another user's client id refused",
            json!({ "client": client, "room": self.name, "user_id": context.user_id }),
        );
        if context.token_id != AGENT_TOKEN {
            incidents::record(
                &self.app,
                vec![Incident {
                    cause: Cause::new(IncidentKind::SaveRefused, "client_id"),
                    room: self.name.clone(),
                    size_bytes: Some(bytes as u64),
                    user_id: Some(context.user_id.clone()),
                }],
            );
        }
        // `unassigned`: the browser does not resend them as they are; it
        // re-applies them under its assigned id (Epo 2026-10-24).
        let payload = match &self.kind {
            Kindly::Note(_) => json!({
                "code": "unassigned",
                "materialId": self.material_id(),
                "room": self.name,
                "type": "document-rejected",
            }),
            Kindly::Source(source) => json!({
                "checkpointIds": [],
                "code": "unassigned",
                "epoch": source.room.epoch,
                "fileId": source.room.file_id,
                "recoverable": false,
                "type": "source-checkpoint-failed",
            }),
        };
        Outcome::Refused {
            payloads: vec![payload.to_string()],
            reason: client_ids::FOREIGN_UPDATE.into(),
            class: Class::Unassigned,
        }
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
        let mut payload = json!({
            "checkpointIds": [],
            "epoch": source.room.epoch,
            "fileId": source.room.file_id,
            "recoverable": false,
            "type": "source-checkpoint-failed",
        });
        // The tab's recovery names the size limit (Q827 A).
        if matches!(refusal, sources::Refusal::StateBytes) {
            payload["reason"] = json!(SIZE_REASON);
        }
        let payload = payload.to_string();
        let (cause, class) = match refusal {
            sources::Refusal::StateBytes => (
                Cause::new(IncidentKind::OverLimit, SIZE_REASON),
                Class::Limit,
            ),
            _ => (
                Cause::new(IncidentKind::SaveRefused, "office_update"),
                Class::Malformed,
            ),
        };
        if context.token_id != AGENT_TOKEN {
            incidents::record(
                &self.app,
                vec![Incident {
                    cause,
                    room: self.name.clone(),
                    size_bytes: Some(bytes as u64),
                    user_id: Some(context.user_id.clone()),
                }],
            );
        }
        Outcome::Refused {
            payloads: vec![payload],
            reason: refusal.message().to_owned(),
            class,
        }
    }

    /// A material room's limit: the writer hears `document-rejected` with
    /// its code, and every editor shows its size refusal.
    fn limit_refused(
        &self,
        context: &Context,
        code: notes::limits::LimitCode,
        metrics: notes::limits::Metrics,
        bytes: usize,
    ) -> Outcome {
        let payload = self.rejection_payload(code, metrics, None);
        // An agent edit refused here loses no one's work (Q432).
        if context.token_id != AGENT_TOKEN {
            incidents::record(
                &self.app,
                vec![Incident {
                    cause: Cause::new(IncidentKind::OverLimit, code.as_str()),
                    room: self.name.clone(),
                    size_bytes: Some(bytes as u64),
                    user_id: Some(context.user_id.clone()),
                }],
            );
        }
        Outcome::Refused {
            payloads: vec![payload],
            reason: "invalid material document".into(),
            class: Class::Limit,
        }
    }

    /// A channel's handled update or step 2, acknowledged in the next flush.
    fn ack(&mut self, writer: Option<MemberKey>) {
        if let Some(key) = writer {
            self.acked(key);
        }
    }

    fn acked(&mut self, key: MemberKey) {
        self.acked_more(key, 1);
    }

    fn acked_more(&mut self, key: MemberKey, count: u64) {
        if count > 0
            && let Some(member) = self.members.get_mut(&key)
        {
            member.acks += count;
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
        self.send_step1(key);
        // Handled (dropped for the resync): its ACK follows the step 1.
        self.acked(key);
    }

    /// The room's step 1 to one channel: its answer brings what it lacks.
    fn send_step1(&mut self, key: MemberKey) {
        use yrs::updates::encoder::Encode;
        let sv = self.state.state_vector().encode_v1();
        self.send(key, Kind::Sync, &sync::encode(sync::STEP1, &sv));
    }

    fn rejection_payload(
        &self,
        code: notes::limits::LimitCode,
        metrics: notes::limits::Metrics,
        eviction: Option<&str>,
    ) -> String {
        // A board's size limit is its live state's bytes.
        let max_content_bytes = match &self.kind {
            Kindly::Note(note) if note.model == crate::model::Model::Board => {
                notes::catalog::CANVAS_BOARD_MAX as u64
            }
            _ => notes::limits::MAX_CONTENT_BYTES,
        };
        let mut payload = json!({
            "code": code.as_str(),
            "limits": {
                "maxContentBytes": max_content_bytes,
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
        let Some(member) = self.members.get_mut(&key) else {
            return;
        };
        // A viewer's channel sends no presence (live-items D1).
        if member.viewer {
            return;
        }
        // A read-only channel names no uploads (REVIEW5 E2): only a writer
        // uploads, and a listed id shows that block as uploading to everyone.
        let fields = match &self.kind {
            Kindly::Note(note) if note.doc == note_store::Doc::Content && note.kind == "note" => {
                Fields::Note {
                    uploads: !member.read_only,
                }
            }
            Kindly::Note(note) if note.model == crate::model::Model::Board => Fields::Board {
                uploads: !member.read_only,
            },
            Kindly::Note(_) => Fields::Nothing,
            Kindly::Source(_) => Fields::Source,
        };
        // Ids another channel of the same user held until now.
        let mut taken_over = Vec::new();
        // A channel's ids name its cursors in the room's presence.
        let mut clients_changed = false;
        for entry in entries {
            // A channel writes and removes only its session's client id
            // (Q213), which no other user's channel can hold.
            if entry.client != member.client {
                continue;
            }
            // A state its room kind does not list, or past the cap, is
            // neither kept nor relayed, and the sender hears nothing
            // (presence is best effort, Epo 2026-10-28); the relayed bytes
            // stay the sender's. A removal is always taken.
            if !entry.removed()
                && (entry.state.len() > MAX_AWARENESS_ENTRY || !fields.admit(&entry.state))
            {
                continue;
            }
            let current = self.awareness.get(&entry.client);
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
                && current.is_none()
                && self.awareness.len() >= MAX_CLIENTS_PER_ROOM
            {
                continue;
            }
            if let Some(previous) = held.filter(|previous| *previous != key) {
                taken_over.push((previous, entry.client));
            }
            clients_changed |= if entry.removed() {
                member.clients.remove(&entry.client)
            } else {
                member.clients.insert(entry.client)
            };
            self.changed_awareness.insert(entry.client);
            self.awareness.insert(
                entry.client,
                AwarenessEntry {
                    owner: (!entry.removed()).then_some(key),
                    entry,
                },
            );
        }
        for (previous, client) in taken_over {
            if let Some(member) = self.members.get_mut(&previous) {
                clients_changed |= member.clients.remove(&client);
            }
        }
        if clients_changed {
            self.mark_presence();
        }
        if !self.changed_awareness.is_empty() {
            self.schedule_flush();
        }
    }

    /// The room's presence changed: it goes out a flush window from now, and
    /// at most once a second.
    fn mark_presence(&mut self) {
        if self.presence_dirty {
            return;
        }
        self.presence_dirty = true;
        let soonest = Instant::now() + FLUSH_WINDOW;
        self.presence_at = Some(self.presence_at.map_or(soonest, |at| at.max(soonest)));
    }

    /// Sends each editor in the room (`in_presence`) the others: each one's
    /// verified identity from its token and the awareness client ids it
    /// holds, which name its cursor. Its own user's other tabs and devices
    /// are listed too, never its own connection. An embed's channel (inside
    /// its note's) is listed but hears none: its page's header shows the
    /// note's.
    fn send_presence(&mut self, now: Instant) {
        self.presence_dirty = false;
        self.presence_at = Some(now + PRESENCE_EVERY);
        let mut listed: Vec<(&MemberKey, &Member)> = self
            .members
            .iter()
            .filter(|(_, member)| in_presence(member, &self.kind))
            .collect();
        listed.sort_by_key(|(_, member)| member.channel_id);
        self.people.retain(|user, _| {
            listed
                .iter()
                .any(|(_, member)| member.context.user_id == *user)
        });
        let entries: Vec<(MemberKey, String)> = listed
            .into_iter()
            .map(|(key, member)| {
                let person = *self
                    .people
                    .entry(member.context.user_id.clone())
                    .or_insert_with(|| {
                        self.next_person += 1;
                        self.next_person
                    });
                (*key, presence_entry(member, person).to_string())
            })
            .collect();
        for (key, member) in &self.members {
            if member.inside || !in_presence(member, &self.kind) {
                continue;
            }
            let others: Vec<&str> = entries
                .iter()
                .filter(|(owner, _)| owner != key)
                .take(MAX_PRESENCE)
                .map(|(_, entry)| entry.as_str())
                .collect();
            let payload = format!(
                "{{\"type\":\"{PRESENCE_TYPE}\",\"connections\":[{}]}}",
                others.join(",")
            );
            self.send(*key, Kind::Stateless, &protocol::text(&payload));
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
            let _txn = self.state.markers().transact_mut();
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
        if event["type"] == ACK_TYPE {
            let (client, user) = (member.client, member.context.user_id.clone());
            if let (Some(sessions), Kindly::Note(note), Some(version)) =
                (&mut self.sessions, &self.kind, event["version"].as_i64())
            {
                let version = version.clamp(0, note.stored_version);
                sessions.acked(client, &user, version);
                if let Some(member) = self.members.get_mut(&key) {
                    member.version = version;
                }
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

    /// The room's live document; a board holds bytes instead, so each caller
    /// says what a board does.
    fn document(&self) -> Option<Doc> {
        match &self.state {
            State::Doc(doc) => Some(doc.clone()),
            State::Board(_) => None,
        }
    }

    /// Whether a writer's `update` tells the room anything new: a document's
    /// `ydoc::contains_changes`, a board's [Board::changes].
    fn changes(&self, update: &yrs::Update) -> bool {
        match &self.state {
            State::Doc(doc) => ydoc::contains_changes(&doc.transact(), update),
            State::Board(board) => board.changes(update),
        }
    }

    /// A writer's update refused on entry (Epo 2026-10-18): the room keeps
    /// its state, the writer's editor reloads it on a fresh document and
    /// channel on the same socket, and only this channel closes.
    fn refused_on_entry(&self, reason: String) -> Outcome {
        let payload = json!({
            "code": "invalid_document",
            "materialId": self.material_id(),
            "room": self.name,
            "type": "document-rejected",
        });
        Outcome::Refused {
            payloads: vec![payload.to_string()],
            reason,
            class: Class::Malformed,
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
            && !markers::pending(self.state.markers())
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
        if !self.store.dirty && !markers::pending(self.state.markers()) {
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
        let contributors = match self.markers.claim(self.state.markers()) {
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
        // A board is not validated: admission bounds its bytes and the server
        // reads no shape in it. Its bound is what the receipts carry (an upper
        // bound, tightened at each fold).
        let validated = match &self.kind {
            Kindly::Note(note) if matches!(self.state, State::Board(_)) => note
                .validator
                .board_bound()
                .map(|bound| (crate::model::board_metrics(bound), None))
                .ok_or_else(|| StoreError::Other("a board without its size bound".into())),
            // Checked (and repaired) first: the row holds what a repair wrote.
            _ => self.checked().await,
        };
        // A document's row is its delta since the durable state; a board's,
        // the updates since its last store and its marker delta, merged off
        // the async workers (live markers hidden in both).
        let written = match &mut self.state {
            State::Doc(doc) => {
                let hidden = markers::live_items(doc);
                let (row, durable) = ydoc::delta_update(&doc.transact(), &self.durable, &hidden);
                Ok((row, durable, None))
            }
            State::Board(board) => tokio::task::block_in_place(|| board.row())
                .map(|row| (Vec::new(), ydoc::Durable::default(), Some(row)))
                .map_err(|error| StoreError::Other(error.to_string())),
        };
        let (row, durable, board_row) = match written {
            Ok(written) => written,
            Err(error) => {
                self.markers.unclaim(&contributors);
                self.store.dirty = true;
                self.store.first_change.get_or_insert(started);
                self.store_failed(StoreFailure::Note(error), started, 0, claimed);
                return;
            }
        };
        if let (Some(_), Kindly::Note(note)) = (&board_row, &mut self.kind) {
            note.growth.row_taken();
        }
        let row_bytes = board_row.as_ref().map_or(row.len(), |row| row.bytes.len());
        // The sessions as of this snapshot go in its transaction, their held
        // deletions with the state that holds them.
        let (session_rows, sessions) = match &mut self.sessions {
            Some(sessions) => {
                let ids = &self.client_ids;
                let now = std::time::SystemTime::now();
                let unsaved = sessions.unsaved(now, |client, user| ids.owned_by(client, user));
                let through = unsaved.through;
                (unsaved, Some(through))
            }
            None => (crate::sessions::Unsaved::default(), None),
        };
        let (metrics, limit_code) = match validated {
            Ok(validated) => validated,
            Err(error) => {
                self.markers.unclaim(&contributors);
                self.store.dirty = true;
                self.store.first_change.get_or_insert(started);
                if let (Some(_), Kindly::Note(note)) = (&board_row, &mut self.kind) {
                    note.growth.row_ended(false);
                }
                self.store_failed(StoreFailure::Note(error), started, row_bytes, claimed);
                return;
            }
        };
        let Kindly::Note(note) = &self.kind else {
            return;
        };
        let (material_id, schema, doc_kind) = (note.material_id.clone(), note.schema, note.doc);
        #[cfg(debug_assertions)]
        let hold = note.folding && material_id.contains(IT_HOLD_STORED);
        let Some(handle) = self.own_handle() else {
            return;
        };
        // The agent steps this snapshot holds go in its transaction (Q402).
        let receipts = self.agent.claim();
        let actors: Vec<String> = {
            let mut actors: Vec<String> = contributors
                .iter()
                .map(|c| c.user_id.clone())
                .chain(receipts.iter().map(|receipt| receipt.actor.clone()))
                .collect();
            actors.sort();
            actors.dedup();
            actors
        };
        self.store.running = true;
        self.view_dirty = true;
        let app = self.app.clone();
        tokio::spawn(async move {
            // Debug builds only: the integration tests' store that commits
            // a second late, so an agent edit's answer comes first.
            #[cfg(debug_assertions)]
            if material_id.contains(IT_SLOW_STORE) {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            let stored = board_row.as_ref().map_or(row.as_slice(), |row| &row.bytes);
            let result = note_store::append(
                &app.db,
                &material_id,
                schema,
                doc_kind,
                stored,
                &actors,
                &session_rows,
                &receipts,
            )
            .await
            .map_err(StoreFailure::Note);
            // Debug builds only: the integration tests' store taken while a
            // fold runs, its room told it committed only once the test lets
            // it (`IT_HOLD_STORED`).
            #[cfg(debug_assertions)]
            if hold && result.is_ok() {
                it_hold_stored(&app, &material_id).await;
            }
            let done = StoreDone {
                result,
                started,
                row_bytes,
                contributors,
                claimed,
                durable,
                metrics: Some(metrics),
                limit_code,
                sessions,
                board_row,
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
        let Some(doc) = self.document() else {
            return first;
        };
        // Its own scope: a transaction is not held across an await.
        let (repaired, fix) = {
            let mut txn = doc.transact_mut();
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
        let (Kindly::Note(note), Some(doc)) = (&self.kind, self.document()) else {
            return Err(StoreError::Other("not a material document room".into()));
        };
        let (kind, model) = (note.kind.clone(), note.model);
        let previous = note.durable_metrics;
        let peer = self.peer_bound();
        tokio::task::spawn_blocking(move || validate(&doc, model, &kind, previous, peer))
            .await
            .unwrap_or_else(|error| Err(StoreError::Other(error.to_string())))
    }

    /// This room's registry handle (none once it unloaded).
    /// Whether the room's state holds structs under an id (Q213).
    fn in_history(&self) -> impl Fn(u64) -> bool + use<> {
        let held = self.state.state_vector();
        move |id| held.get(&yrs::block::ClientID::new(id)) > 0
    }

    /// Whether an id is bound to a live channel (a session's or its DOCX
    /// worker's) other than `except`, or is the room's own (Q213, Q226).
    fn live_ids(&self, except: &[MemberKey]) -> impl Fn(u64) -> bool + use<> {
        let own = self.state.client().get();
        let bound: HashSet<u64> = self
            .members
            .iter()
            .filter(|(key, _)| !except.contains(key))
            .flat_map(|(_, member)| std::iter::once(member.client).chain(member.worker))
            .collect();
        move |id| id == own || bound.contains(&id)
    }

    /// The channels a JOIN on `key` takes over (Q472): ones that joined
    /// before it (an earlier socket, or an earlier channel of the same one)
    /// for the same user and editing session id, holding the session's
    /// client id or the token's DOCX worker id. A session holds one channel
    /// at a time, so such a channel's socket dropped without the server
    /// seeing it close. A JOIN without a session id takes over nothing.
    fn stale_channels(
        &self,
        key: MemberKey,
        context: &Context,
        client: Option<u64>,
        session_id: Option<u128>,
    ) -> Vec<MemberKey> {
        let Some(session_id) = session_id else {
            return Vec::new();
        };
        let ids = [client, context.worker_client_id.map(u64::from)];
        self.members
            .iter()
            .filter(|(old, member)| {
                **old < key
                    && member.session_id == Some(session_id)
                    && member.context.user_id == context.user_id
                    && std::iter::once(member.client)
                        .chain(member.worker)
                        .any(|id| ids.contains(&Some(id)))
            })
            .map(|(old, _)| *old)
            .collect()
    }

    /// A same-session JOIN on `key`, bound to `client`, takes over `stale`
    /// (Q472): each stale channel's awareness entry under the session's id
    /// passes to `key`, so collaborators keep the user's cursor instead of
    /// hearing it removed (Q477), then the stale channel closes as a Leave
    /// would and its socket hears that it closed.
    fn take_over(&mut self, key: MemberKey, client: u64, stale: Vec<MemberKey>) {
        for old in stale {
            if let Some(state) = self.awareness.get_mut(&client)
                && state.owner == Some(old)
            {
                state.owner = Some(key);
                if let Some(member) = self.members.get_mut(&key) {
                    member.clients.insert(client);
                }
            }
            self.close_channel(old, None, 0, client_ids::REJOINED_REASON);
        }
    }

    /// A channel joined a note's room: its session counts at the version
    /// its JOIN names, never above the room's (a viewer, who never edits,
    /// has none). A late JOIN never gets here (`handle`).
    fn session_joined(&mut self, key: MemberKey, version: Option<u64>) {
        let (Some(sessions), Kindly::Note(note), Some(member)) =
            (&mut self.sessions, &self.kind, self.members.get_mut(&key))
        else {
            return;
        };
        let version = version
            .map_or(0, |version| i64::try_from(version).unwrap_or(i64::MAX))
            .min(note.stored_version);
        member.version = version;
        if member.context.viewer {
            return;
        }
        let now = std::time::SystemTime::now();
        if !sessions.joined(member.client, &member.context.user_id, version, now) {
            // The binding gives an id to one user only; this is a defence.
            log(
                Level::Error,
                "session of another user joined",
                json!({ "client": member.client, "room": self.name }),
            );
        }
    }

    /// A clean Leave naming its session ends it, its held deletions
    /// released. Only the session bound to the leaving channel, so a user
    /// ends only their own (in-place collection, plan section 8): another's
    /// would lose the deletions its Undo restores.
    fn end_session(&mut self, key: MemberKey, named: Option<u64>) {
        let (Some(sessions), Some(member)) = (&mut self.sessions, self.members.get(&key)) else {
            return;
        };
        if named == Some(member.client) {
            sessions.end(member.client, &member.context.user_id);
        }
    }

    /// Whether a JOIN or draft group under `clients` naming `version` is
    /// older than the latest collection's window, or comes under an id whose
    /// session record was lost (`sessions::late`, Q385); notes only. Its
    /// document may name units a collection discarded, so it never syncs
    /// raw: a late JOIN is refused with `socket::LATE_REASON` and a late
    /// group answers `Class::Late`, and the tab merges its unsent edits in a
    /// new session (src/features/collaboration/lateMerge).
    fn late(&self, clients: &[u64], version: Option<u64>) -> bool {
        match (&self.kind, &self.sessions) {
            (Kindly::Note(note), Some(sessions)) => {
                let lost = clients.iter().any(|&client| sessions.lost(client));
                crate::sessions::late(note.window, version.unwrap_or(0), lost)
            }
            _ => false,
        }
    }

    /// After the store of `store`: every update it holds goes out first, then
    /// each synced editor of a note hears the stored version, which it then
    /// holds. A store past a service edit the room has not applied yet goes
    /// unannounced (review r1 M1): its editors lack that edit, and the next
    /// store's notice covers both. Only stores announce: a tab counts its
    /// edit stored at the second notice after the edit's ACK (review r1 H1).
    fn announce_stored(&mut self, store: i64) {
        let (Some(_), Kindly::Note(note)) = (&self.sessions, &self.kind) else {
            return;
        };
        let version = crate::sessions::whole(note.stored_version, &note.gaps);
        if version < store {
            // A gap still open at the next store stalls the sessions: warned
            // once per gap (a server edit arriving after a later store's
            // notice closes its own at once, review r3 N3).
            let gap = version + 1;
            let (seen, warned) = match note.stall {
                Some((open, warned)) if open == gap => (true, warned),
                _ => (false, false),
            };
            if seen && !warned {
                log(
                    Level::Warn,
                    "store not announced",
                    json!({ "room": self.name, "store": store, "whole": version }),
                );
            }
            if let Kindly::Note(note) = &mut self.kind {
                note.stall = Some((gap, seen));
            }
            return;
        }
        let notice = json!({ "type": STORED_TYPE, "version": version }).to_string();
        self.flush();
        let text = protocol::text(&notice);
        for (key, member) in &self.members {
            if member.synced && !member.context.viewer {
                self.send(*key, Kind::Stateless, &text);
            }
        }
    }

    /// What a fold of a note must keep for its sessions (`sessions.rs`), the
    /// in-place collection's input; none with the collection off, and for
    /// rooms that keep no sessions (Q274: notes only). `live_room`: the open
    /// room's client, whose contributor markers stay.
    fn fold_holds(&mut self, live_room: Option<yrs::block::ClientID>) -> Option<note_store::Holds> {
        if !self.app.config.gc_collect {
            return None;
        }
        let holds = self.sessions.as_mut()?.holds(std::time::SystemTime::now());
        let (app, name, id) = (self.app.clone(), self.name.clone(), self.id);
        Some(note_store::Holds {
            reached: holds.reached,
            held: holds.held,
            live_room,
            alone: Box::new(move || app.rooms.get(&name).is_none_or(|room| room.id == id)),
        })
    }

    /// A clean Leave (Q236): the channel's recorded ids its token offered
    /// expire; an id it bound otherwise (another tab's, r2 N6) stays.
    fn left_clean(&mut self, key: MemberKey) {
        let Some(member) = self.members.get(&key) else {
            return;
        };
        let offered = [member.context.client_id, member.context.worker_client_id];
        let ids: Vec<u64> = std::iter::once(member.client)
            .chain(member.worker)
            .filter(|&id| offered.iter().flatten().any(|&own| u64::from(own) == id))
            .collect();
        let user = member.context.user_id.clone();
        if let Some(rows) = self.client_ids.left_clean(&user, &ids) {
            self.write_rows(rows);
        }
    }

    /// Queues client-id rows (r2 S3): written in order, one batch at a time
    /// off the room's task (Q226 M4: a slow database stalls no channel), and
    /// the room unloads only once the queue is empty.
    fn write_rows(&mut self, rows: client_ids::Rows) {
        self.rows.push_back(rows);
        self.next_rows();
    }

    /// Writes the queue's head, retrying a failure a few times.
    fn next_rows(&mut self) {
        if self.rows_running {
            return;
        }
        let Some(rows) = self.rows.front().cloned() else {
            return;
        };
        let Some(handle) = self.own_handle() else {
            // Closing: nothing more can be written.
            log(
                Level::Error,
                "client id rows lost",
                json!({ "batches": self.rows.len(), "error": "the room has no handle", "room": self.name }),
            );
            self.rows.clear();
            return;
        };
        self.rows_running = true;
        let db = self.app.db.clone();
        tokio::spawn(async move {
            let mut result = rows.run(&db).await;
            for delay in ROW_RETRIES {
                if result.is_ok() {
                    break;
                }
                tokio::time::sleep(delay).await;
                result = rows.run(&db).await;
            }
            let _ = handle.tx.send(RoomCmd::RowsWritten(result)).await;
        });
    }

    /// The queue's head was written, or failed every try (logged as lost).
    fn rows_written(&mut self, result: Result<(), String>) {
        self.rows_running = false;
        self.rows.pop_front();
        if let Err(error) = result {
            log(
                Level::Error,
                "client id rows lost",
                json!({ "error": error, "room": self.name }),
            );
        }
        self.next_rows();
    }

    fn own_handle(&self) -> Option<RoomHandle> {
        self.app
            .rooms
            .get(&self.name)
            .filter(|handle| handle.id == self.id)
    }

    /// `storeSource`: the room's update since its durable state goes to the
    /// gateway's checkpoint with a text room's effects from the change, or an
    /// Office room's whole state for the save's size check (its edited text is
    /// counted as the room applies it, Q405).
    async fn start_source_store(&mut self) {
        let started = Instant::now();
        // A failed store waits out its backoff; only its retry calls the engine.
        if self.store.retry_at.is_some() {
            self.answer_store_waiters(Err(sources::SourceError::Backoff.to_string()));
            return;
        }
        // A source room holds a document (`load`).
        let Some(doc) = self.document() else {
            let error = sources::SourceError::Other("a source room holds a document".into());
            self.source_store_failed(error, started, 0, Vec::new());
            return;
        };
        let pending = sources::failure::pending_source_save(&doc.transact());
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
        let contributors = match self.markers.claim(&doc) {
            Ok(contributors) => contributors,
            Err(error) => {
                let error = sources::SourceError::Other(error.to_string());
                self.source_store_failed(error, started, 0, Vec::new());
                return;
            }
        };
        let claimed = self.receipts.clone();
        let hidden = markers::live_items(&doc);
        let Kindly::Source(source) = &self.kind else {
            return;
        };
        let (room, format) = (source.room.clone(), source.format);
        // O(state) for an Office room (its whole state for the size check) and
        // up to O(text) for a text room (the pending effect spans every edit
        // since the baseline): off the runtime's threads, while the room
        // waits as it does for a note store's validation.
        let (previous, sources) = (self.durable.clone(), self.app.sources.clone());
        let effect_room = room.clone();
        let computed = tokio::task::spawn_blocking(move || {
            let txn = doc.transact();
            let (row, durable) = ydoc::delta_update(&txn, &previous, &hidden);
            // An Office room's edit count and version as of this row (Q435).
            let edits = sources.take_edits(&effect_room);
            let (state, text) = match format {
                sources::SourceFormat::Text => {
                    (None, Some(sources.text_effects(&effect_room, &txn, &row)))
                }
                _ => (
                    Some(txn.encode_state_as_update_v1(&StateVector::default())),
                    None,
                ),
            };
            (row, durable, state, text, edits)
        })
        .await;
        let (row, durable, state, text, edits) = match computed {
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
        let Some(handle) = self.own_handle() else {
            return;
        };
        // The agent steps this snapshot holds go in its checkpoint (Q402).
        let receipts = self.agent.claim();
        let mut actors: Vec<String> = Vec::new();
        for user in contributors
            .iter()
            .map(|contributor| &contributor.user_id)
            .chain(receipts.iter().map(|receipt| &receipt.actor))
        {
            if !actors.contains(user) {
                actors.push(user.clone());
            }
        }
        let bytes = state.as_ref().map_or(row.len(), Vec::len);
        let save = sources::Save {
            row,
            state,
            text,
            actors,
            retry_event: self.store.failed_event.clone(),
            edits,
            operations: receipts.iter().map(source_operation).collect(),
        };
        self.store.running = true;
        self.view_dirty = true;
        let app = self.app.clone();
        tokio::spawn(async move {
            // Debug builds only: the integration tests' store that commits
            // a second late, so a request comes while it runs.
            #[cfg(debug_assertions)]
            if room.file_id.contains(IT_SLOW_STORE) {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
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
                sessions: None,
                board_row: None,
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
            sessions,
            board_row,
        } = done;
        if let (Some(_), Kindly::Note(note)) = (&board_row, &mut self.kind) {
            note.growth.row_ended(result.is_ok());
        }
        let version = match result {
            Ok(version) => version,
            Err(error) => {
                self.markers.unclaim(&contributors);
                self.agent.unclaim();
                self.store.dirty = true;
                self.store.first_change.get_or_insert(started);
                self.store_failed(error, started, row_bytes, claimed);
                return;
            }
        };
        self.agent.stored();
        let timings = match self.kind {
            Kindly::Note(_) => &self.app.health.material,
            Kindly::Source(_) => &self.app.health.source,
        };
        timings.record(started.elapsed(), true, row_bytes, &self.name);
        // A source save with no writer in it appends nothing (row_bytes 0).
        if row_bytes > 0 || matches!(self.kind, Kindly::Note(_)) {
            match (board_row, &mut self.state) {
                // The row's updates join the board's tail.
                (Some(row), State::Board(board)) => {
                    if let Err(error) = tokio::task::block_in_place(|| board.stored(row)) {
                        observe::capture(
                            &error.to_string(),
                            None,
                            &[("room", &self.name), ("stage", "board_store")],
                        );
                    }
                }
                _ => self.durable = durable,
            }
            self.app
                .stats
                .log_bytes
                .fetch_add(row_bytes as u64, Ordering::Relaxed);
        }
        if self.store.failed_event.take().is_some() {
            self.app.stats.failed_stores.fetch_sub(1, Ordering::Relaxed);
        }
        self.store.retry_delay = RETRY_FIRST / 2;
        if let Some(cleared) = self.markers.clear(self.state.markers(), &contributors) {
            self.broadcast_update(None, cleared);
        }
        match &mut self.kind {
            Kindly::Note(note) => {
                // A service edit that landed meanwhile may be ahead, or behind
                // and not applied yet (`announce_stored`).
                note.stored_version = if note.sessioned() {
                    crate::sessions::took(note.stored_version, &mut note.gaps, version)
                } else {
                    note.stored_version.max(version)
                };
                note.durable_metrics = metrics;
                note.log_bytes += row_bytes as i64;
                note.log_rows += 1;
                let material_id = note.material_id.clone();
                // Claimed receipts, and every waiting one when no writer's
                // update reached the room after the snapshot.
                let mut ids: Vec<String> = Vec::new();
                let everything = !markers::pending(self.state.markers()) && !self.store.dirty;
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
                // Claimed receipts, and every waiting one when no writer's
                // update reached the room after the snapshot, as a note's: a
                // flush that came while this store ran waits for no other.
                let answered = if !self.store.dirty && !markers::pending(self.state.markers()) {
                    self.receipts.clone()
                } else {
                    claimed
                };
                self.source_receipt(&answered, version as u64);
            }
        }
        if let (Some(through), Some(written)) = (sessions, &mut self.sessions) {
            written.saved(through);
        }
        self.announce_stored(version);
        self.project_on_cadence();
        if self.store.dirty || markers::pending(self.state.markers()) {
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
            // A state over its cap: the tab's recovery names the size limit
            // (Q827 A).
            if error.status() == Some(413) {
                payload["reason"] = json!(SIZE_REASON);
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

    /// Answers the store's waiters.
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
        self.agent.discard();
    }

    // ---------------------------------------------------------------- projection

    /// After a store: a note whose edits have not paused long enough for the
    /// idle projection projects anyway once `projection_cadence` passed since
    /// its last projection, and a board that took an asset's name at once
    /// (Go trashes an asset no projection names, so an image deleted and
    /// brought back by Undo is not served until one names it again). The
    /// live document may already hold newer edits, so this projects the
    /// durable state from the store.
    fn project_on_cadence(&mut self) {
        let handle = self.own_handle();
        let cadence = self.app.config.projection_cadence;
        let Kindly::Note(note) = &mut self.kind else {
            return;
        };
        if note.projecting
            || note.stored_version <= note.projected_version
            || (note.projected_at.elapsed() < cadence && !note.project_soon)
        {
            return;
        }
        let Some(handle) = handle else {
            return;
        };
        note.projecting = true;
        note.project_soon = false;
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
        // A board projects from its durable rows (`projection::project_durable`):
        // it holds no document.
        let doc = self.document();
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
        let doc = match doc {
            Some(doc) if !note.model.quiz() => doc,
            _ => {
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
        };
        // Read here, so the content is exactly the durable state at `version`;
        // the room waits for it as for a store's validation.
        let content = projection::content_of(doc, note.model, version).await;
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
        // A reload's next room may load now.
        if std::mem::take(&mut self.reloading) {
            self.app.evictions.end(&self.name, true);
        }
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
                        crate::trim::after_unload();
                        return;
                    }
                    // The log folds while the room is empty (DESIGN.md 3.5);
                    // a deferred publication's rebuild may follow now.
                    if let Err(error) = app.sources.fold(&room).await {
                        observe::capture(
                            &error.to_string(),
                            None,
                            &[("room", &room.name()), ("stage", "fold")],
                        );
                    }
                    app.handoff().schedule_rebuild(&room.file_id);
                    // What the room and its fold freed goes back.
                    crate::trim::after_unload();
                });
                return;
            }
        };
        unlog_bytes(&self.app, note.log_bytes.max(0) as u64);
        // What the sessions did since the last store (acknowledgements,
        // departures) is written before the fold.
        let session_rows = match &mut self.sessions {
            Some(sessions) if self.discard_pending.is_none() => {
                let ids = &self.client_ids;
                let now = std::time::SystemTime::now();
                sessions.unsaved(now, |client, user| ids.owned_by(client, user))
            }
            _ => crate::sessions::Unsaved::default(),
        };
        // The room's life ended: its contributor markers go too.
        let holds = self.fold_holds(None);
        let Kindly::Note(note) = &self.kind else {
            return;
        };
        let app = self.app.clone();
        // None for a board, which projects its fold, or from its durable
        // rows.
        let doc = self.document();
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
                // Usually the document's last reference: freed before the trim.
                drop(doc);
                crate::trim::after_unload();
                return;
            }
            let failed = |error: String| {
                // Logged at info already: no failure.
                if error != projection::IN_TRASH {
                    log(
                        Level::Warn,
                        "unload projection failed",
                        json!({ "error": error, "room": material_id }),
                    );
                }
            };
            // The log folds while the room is empty (DESIGN.md 3.5); a
            // board's fold returns the projection of its new base.
            let folding = async {
                if !session_rows.rows.is_empty()
                    && let Err(error) =
                        note_store::save_sessions_now(&app.db, &material_id, &session_rows).await
                {
                    log(
                        Level::Warn,
                        "unload sessions not saved",
                        json!({ "error": error.to_string(), "room": material_id }),
                    );
                }
                let holds = one_process(&app, &material_id, holds).await;
                let permit = board_permit(&app, model, WorkKind::UnloadFold, &material_id).await;
                match note_store::fold(&app.db, &material_id, schema, doc_kind, None, holds, permit)
                    .await
                {
                    Ok(folded) => folded.and_then(|folded| folded.projection),
                    Err(error) => {
                        observe::capture(
                            &error.to_string(),
                            None,
                            &[("room", &material_id), ("stage", "fold")],
                        );
                        None
                    }
                }
            };
            if model == crate::model::Model::Board {
                // A board folds first and projects what the fold built, or,
                // with no fold, from its base's projection and rows: no
                // replay runs beside the fold's.
                let result = match folding.await {
                    Some((version, content)) => {
                        projection::project(&app, &material_id, version, &content, None).await
                    }
                    None if stored > projected => projection::project_durable(&app, &material_id)
                        .await
                        .map(|_| ()),
                    None => Ok(()),
                };
                if let Err(error) = result {
                    failed(error);
                }
            } else {
                // The projection reads the unloaded document, the fold the
                // rows: neither waits for the other.
                let projecting = async {
                    if stored > projected
                        && let Err(error) = match doc {
                            Some(doc) if !model.quiz() => {
                                projection::project_doc(&app, &material_id, stored, doc, model)
                                    .await
                            }
                            _ => projection::project_durable(&app, &material_id)
                                .await
                                .map(|_| ()),
                        }
                    {
                        failed(error);
                    }
                };
                tokio::join!(projecting, folding);
            }
            // What the room, its fold and its projection freed goes back.
            crate::trim::after_unload();
        });
    }
}

/// The board work permit (`work.rs`) for a board's `kind` of work on `room`
/// (a room or material, for the logs); none for any other model, which does
/// not take it.
async fn board_permit(
    app: &crate::app::App,
    model: crate::model::Model,
    kind: WorkKind,
    room: &str,
) -> Option<crate::work::Permit> {
    match model {
        crate::model::Model::Board => Some(app.board_work.acquire(kind, room).await),
        _ => None,
    }
}

/// `holds` collecting nothing while another collaboration process may be
/// live: the in-place collection requires one process per database (Q400,
/// review r3 L1), whose rooms' sessions and windows this one cannot see.
/// Each cause is reported once per process (Q419), to Sentry and the log
/// (`capture` logs it), tagged with the material whose fold first saw it.
async fn one_process(
    app: &crate::app::App,
    material_id: &str,
    holds: Option<note_store::Holds>,
) -> Option<note_store::Holds> {
    let holds = holds?;
    let Some((cause, detail)) = app.another_instance().await else {
        return Some(holds);
    };
    if WITHHELD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(cause)
    {
        observe::capture(
            &format!("in-place collection withheld: {cause}"),
            None,
            &[
                ("room", material_id),
                ("file_id", material_id),
                ("stage", "fold"),
                ("detail", &detail),
            ],
        );
    }
    Some(note_store::Holds {
        alone: Box::new(|| false),
        ..holds
    })
}

/// The causes of withheld collections this process reported.
static WITHHELD: std::sync::LazyLock<std::sync::Mutex<HashSet<&'static str>>> =
    std::sync::LazyLock::new(Default::default);

/// An agent step as a source room's checkpoint carries it (Go's
/// `SourceCheckpointOperation`): its identity, the step it reverses and its
/// Undo ref, which Go writes with the checkpoint (Q402).
fn source_operation(receipt: &note_store::AgentReceipt) -> Value {
    let mut operation = json!({
        "receipt": {
            "actorUserId": receipt.actor,
            "callId": receipt.call_id,
            "conversationId": receipt.conversation_id,
            "id": receipt.id,
            "messageId": receipt.message_id,
            "requestHash": receipt.request_hash,
            "toolVersion": receipt.tool_version,
        },
    });
    if let Some(of) = &receipt.undo_of {
        operation["undoOf"] = json!(of);
    }
    if !receipt.effect["undo"].is_null() {
        operation["undo"] = receipt.effect["undo"].clone();
    }
    operation
}

/// The context an agent edit is admitted under: its actor's write, with no
/// token, channel or client id of its own (Q402).
fn agent_context(actor: &str) -> Context {
    Context {
        access: Access::Write,
        expires_at: i64::MAX,
        token_id: AGENT_TOKEN.to_owned(),
        user_id: actor.to_owned(),
        client_id: None,
        worker_client_id: None,
        viewer: false,
        parent: None,
        identity: Box::default(),
    }
}

/// A person's refusal as the agent hears it (Q402): the edit's own codes
/// (an Undo past a limit: too large to undo).
fn agent_refusal(outcome: Outcome, undo: bool) -> crate::edits::DocumentError {
    use crate::edits::{DocumentError, UNDO_GONE, UNDO_TOO_LARGE, undo_unavailable};
    let Outcome::Refused {
        payloads,
        reason,
        class,
    } = outcome
    else {
        // Content the room no longer holds: its life ended meanwhile.
        return DocumentError::Unavailable(crate::edits::ROOM_RESET);
    };
    match class {
        // It names units collected since its snapshot (Q419, Q443).
        Class::Late if undo => undo_unavailable(UNDO_GONE),
        Class::Late => DocumentError::Unavailable(crate::edits::ROOM_RESET),
        // It types into a block someone deleted since its snapshot: the
        // agent re-reads (Q446).
        Class::Hidden if undo => undo_unavailable(UNDO_GONE),
        Class::Hidden => DocumentError::edit("stale_target", reason),
        Class::Limit if undo => undo_unavailable(UNDO_TOO_LARGE),
        Class::Limit => {
            let code = payloads
                .first()
                .and_then(|payload| serde_json::from_str::<Value>(payload).ok())
                .and_then(|payload| payload["code"].as_str().map(str::to_owned));
            match code {
                Some(code) => DocumentError::Quota(code),
                None => DocumentError::Source {
                    status: 413,
                    message: "Source checkpoint exceeds byte limit".into(),
                },
            }
        }
        Class::Unavailable if reason == OFFICE_PAUSED => DocumentError::Source {
            status: 423,
            message: reason,
        },
        Class::Unavailable => DocumentError::Unavailable(crate::edits::ROOM_RESET),
        Class::Permission if reason == UNSUPPORTED_BLOCK => {
            DocumentError::edit("unsupported_operation", reason)
        }
        Class::Permission => DocumentError::Lifecycle(reason),
        Class::Malformed => DocumentError::edit("invalid_input", reason),
        _ => DocumentError::Unknown(reason),
    }
}

/// What admission decided about a writer's update.
enum Verdict {
    Accept,
    Unheld,
    /// A note draft typing into a block the room deleted (Q237).
    Hidden,
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

/// The bytes of the pieces in `window` and `paced`, waiting to go out.
fn waiting_pieces(window: &[Outgoing], paced: &VecDeque<Outgoing>) -> usize {
    window
        .iter()
        .filter(|out| out.piece)
        .chain(paced.iter())
        .map(|out| out.update.len())
        .sum()
}

/// What a flush sends of `window` and the pieces waiting in `paced`, and
/// when the next piece may go. Plain updates go at once: one that builds on
/// pieces not sent yet waits on its peer, pending in Yjs, until they come
/// (round 2, finding 3: a queue of pieces held every typist back). Pieces
/// go in order once the pace (`pace`: bytes in hand, when they were
/// counted) holds their bytes: the update allowance's burst, then its bytes
/// per second, so readers get a group's pieces as fast as its writer could
/// have sent them.
fn outgoing(
    window: Vec<Outgoing>,
    paced: &mut VecDeque<Outgoing>,
    pace: &mut (f64, Instant),
    limits: crate::rate::Limits,
    now: Instant,
) -> (Vec<Outgoing>, Option<Instant>) {
    let (pieces, plain): (Vec<Outgoing>, Vec<Outgoing>) =
        window.into_iter().partition(|out| out.piece);
    paced.extend(pieces);
    if paced.is_empty() {
        return (plain, None);
    }
    let (tokens, at) = pace;
    let rate = limits.bytes_per_second as f64;
    let burst = limits.burst_bytes as f64;
    *tokens = (*tokens + now.saturating_duration_since(*at).as_secs_f64() * rate).min(burst);
    *at = now;
    // No piece is larger than the burst: a full pace takes any.
    let cost = |out: &Outgoing| (out.update.len() as f64).min(burst);
    let mut out = Vec::new();
    while let Some(next) = paced.front() {
        if *tokens < cost(next) {
            break;
        }
        *tokens -= cost(next);
        out.extend(paced.pop_front());
    }
    let next = paced
        .front()
        .map(|next| now + Duration::from_secs_f64((cost(next) - *tokens).max(0.0) / rate));
    out.extend(plain);
    (out, next)
}

/// Whether `window` holds pieces of a group admitted by a member's `seen`:
/// its step 2 held the group (round 3, finding 7).
fn held_pieces(window: &[Outgoing], seen: u64) -> bool {
    window.iter().any(|out| out.piece && out.admitted <= seen)
}

/// The update messages of `window` the member `key` gets: none it sent, and
/// no piece of a group admitted by its `seen`.
fn member_messages(window: &[Outgoing], key: MemberKey, seen: u64) -> Vec<Vec<u8>> {
    messages(
        window
            .iter()
            .filter(|out| out.sender != Some(key) && !(out.piece && out.admitted <= seen)),
    )
}

/// A flush's update messages, in order: each run of plain updates merged
/// into one, each source group's piece a message of its own.
fn messages<'a>(outgoing: impl Iterator<Item = &'a Outgoing>) -> Vec<Vec<u8>> {
    let mut messages = Vec::new();
    let mut run: Vec<&[u8]> = Vec::new();
    for out in outgoing {
        if out.piece {
            messages.extend(merge(run.drain(..)));
            messages.push(out.update.clone());
        } else {
            run.push(&out.update);
        }
    }
    messages.extend(merge(run.into_iter()));
    messages
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

/// `doc`'s state beyond `since`, encoded on the blocking pool; the room
/// waits for it, as for a store's validation, so nothing changes the
/// document meanwhile. A panic in the encode is the room's own.
async fn encoded(doc: Doc, since: StateVector) -> Vec<u8> {
    tokio::task::spawn_blocking(move || doc.transact().encode_state_as_update_v1(&since))
        .await
        .unwrap_or_else(|error| std::panic::resume_unwind(error.into_panic()))
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
        None => std::future::pending().await,
    }
}

/// Whether a channel is in the room's presence, listed and hearing it:
/// people who can edit, never viewers (Epo 2026-10-20). A material room knows
/// a viewer from the material's access at join, so an editor's reading tab (a
/// View) and a narrowed editor are in and their cursors keep their names; a
/// source room knows only the token's access, so only its write channels are.
/// A quiz's keys room has none: its writers' page shows the content room's.
fn in_presence(member: &Member, kind: &Kindly) -> bool {
    !member.viewer
        && match kind {
            Kindly::Note(note) => note.doc != note_store::Doc::Keys,
            Kindly::Source(_) => member.context.access == Access::Write,
        }
}

/// One connection in the room's presence: its person's number, the token's
/// name and avatar (nothing about its device, Epo 2026-10-20), and the
/// awareness client ids it holds.
fn presence_entry(member: &Member, person: u64) -> Value {
    let identity = &member.context.identity;
    let mut clients: Vec<u64> = member.clients.iter().copied().collect();
    clients.sort_unstable();
    json!({
        "person": person,
        "name": identity.name,
        "avatar": identity.avatar_url,
        "clients": clients,
    })
}

#[cfg(test)]
mod pace_tests {
    use super::*;

    const MIB: usize = 1024 * 1024;

    fn out(bytes: usize, piece: bool) -> Outgoing {
        Outgoing {
            sender: None,
            update: vec![0; bytes],
            piece,
            admitted: 0,
        }
    }

    const LIMITS: crate::rate::Limits = crate::rate::Limits {
        burst_updates: 10_000,
        burst_bytes: 8 << 20,
        updates_per_second: 200,
        bytes_per_second: 2 << 20,
        open_bytes: crate::rate::OPEN_BYTES,
        open_refill_seconds: 300,
    };

    /// Review of 43fae032a, finding 6: an admitted source group's pieces go
    /// out as fast as their writer could have sent them, the allowance's
    /// burst at once, then its bytes per second. Fails if a group goes out
    /// at once.
    #[test]
    fn a_groups_pieces_go_out_at_the_allowances_pace() {
        let start = Instant::now();
        let mut pace = (LIMITS.burst_bytes as f64, start);
        let mut paced = VecDeque::new();
        let window = (0..6).map(|_| out(2 * MIB, true)).collect();
        let (now, next) = outgoing(window, &mut paced, &mut pace, LIMITS, start);
        assert_eq!(now.len(), 4, "the burst");
        assert_eq!(next, Some(start + Duration::from_secs(1)));
        let later = start + Duration::from_secs(1);
        let (now, next) = outgoing(Vec::new(), &mut paced, &mut pace, LIMITS, later);
        assert_eq!(now.len(), 1);
        assert_eq!(next, Some(later + Duration::from_secs(1)));
        let (now, next) = outgoing(
            Vec::new(),
            &mut paced,
            &mut pace,
            LIMITS,
            later + Duration::from_secs(1),
        );
        assert_eq!(now.len(), 1);
        assert_eq!(next, None);
    }

    /// Round 2, finding 3: while a group's pieces wait for the pace, plain
    /// updates (others' typing, its writer's next edit) go out at once, the
    /// pieces due first. Fails if they wait behind the pieces.
    #[test]
    fn plain_updates_go_out_at_once_while_pieces_wait() {
        let start = Instant::now();
        let mut pace = (LIMITS.burst_bytes as f64, start);
        let mut paced = VecDeque::new();
        let mut window: Vec<Outgoing> = (0..6).map(|_| out(2 * MIB, true)).collect();
        window.push(out(10, false));
        let (now, _) = outgoing(window, &mut paced, &mut pace, LIMITS, start);
        assert_eq!(
            now.iter().map(|out| out.piece).collect::<Vec<_>>(),
            [true, true, true, true, false]
        );
        assert_eq!(paced.len(), 2);
        let (now, _) = outgoing(vec![out(10, false)], &mut paced, &mut pace, LIMITS, start);
        assert_eq!(
            now.iter().map(|out| out.piece).collect::<Vec<_>>(),
            [false],
            "typing waited behind the pieces"
        );
        assert_eq!(paced.len(), 2);
    }

    /// Round 3, finding 7: a member that joined or was answered after a
    /// group's admission (its `seen`) skips that group's pieces, and gets a
    /// later group's and every plain update. Fails if a joiner hears pieces
    /// its step 2 held.
    #[test]
    fn a_member_skips_the_pieces_of_groups_admitted_before_it_joined() {
        let piece = |byte: u8, admitted: u64| Outgoing {
            sender: None,
            update: vec![byte],
            piece: true,
            admitted,
        };
        let window = vec![piece(1, 1), out(1, false), piece(2, 2)];
        assert!(held_pieces(&window, 1));
        assert!(!held_pieces(&window, 0));
        let joiner = member_messages(&window, (1, 1), 1);
        assert_eq!(joiner.len(), 2);
        assert_eq!(joiner[1], vec![2]);
        assert_eq!(member_messages(&window, (1, 1), 0).len(), 3);
    }

    /// Round 2, finding 3: the pieces waiting to go out, admitted or still
    /// in the window, count against the room's bound on unfinished groups
    /// (`group_bytes`), plain updates not. Fails if a queue of pieces could
    /// grow past what the room lets writers hold.
    #[test]
    fn pieces_waiting_to_go_count_against_the_rooms_bound() {
        let paced: VecDeque<Outgoing> = (0..2).map(|_| out(2 * MIB, true)).collect();
        let window = vec![out(MIB, true), out(10, false)];
        assert_eq!(waiting_pieces(&window, &paced), 5 * MIB);
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::collections::{HashMap, HashSet};

    use serde_json::json;
    use yrs::block::{ClientID, ItemContent};
    use yrs::encoding::write::Write as _;
    use yrs::types::text::YChange;
    use yrs::updates::encoder::Encode as _;
    use yrs::{
        Any, Doc, ID, IdSet, Map, MapRef, Out, ReadTxn, StateVector, Text, TextPrelim, TextRef,
        Transact, UpdateBlock, XmlTextRef,
    };

    use crate::markers;
    use crate::model::Model;

    /// A room's document as its load built it before cut 1: the stored state
    /// replayed into a scratch document, encoded whole and applied into the
    /// room's document, here under `client`.
    fn loaded_as_before(base: &[u8], rows: &[Vec<u8>], client: u64) -> Doc {
        let scratch = ydoc::scratch_doc();
        ydoc::replay(&scratch, base, rows).unwrap();
        let doc = Doc::with_options(ydoc::doc_options(client));
        ydoc::replay(&doc, &whole(&scratch), &[] as &[Vec<u8>]).unwrap();
        doc
    }

    fn whole(doc: &Doc) -> Vec<u8> {
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// The root a kind's tabs edit under.
    #[derive(Clone, Copy)]
    enum Root {
        Text(&'static str),
        Map(&'static str),
    }

    impl Root {
        fn of(self, doc: &Doc) -> Out {
            match self {
                Root::Text(name) => Out::YText(doc.get_or_insert_text(name)),
                Root::Map(name) => Out::YMap(doc.get_or_insert_map(name)),
            }
        }
    }

    /// Where a tab types: the first text, depth first, that embeds no other
    /// (a note's first paragraph, a card's face, a board page's title).
    enum Typed {
        Text(TextRef),
        Xml(XmlTextRef),
    }

    fn sorted<T: ReadTxn>(txn: &T, map: &MapRef) -> Vec<(String, Out)> {
        let mut entries: Vec<(String, Out)> = map
            .iter(txn)
            .map(|(key, value)| (key.to_owned(), value))
            .collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries
    }

    fn text_in<T: ReadTxn>(txn: &T, out: Out) -> Option<Typed> {
        let embedded = |chunks: Vec<yrs::types::text::Diff<YChange>>| {
            chunks
                .into_iter()
                .find_map(|chunk| text_in(txn, chunk.insert))
        };
        match out {
            Out::YMap(map) => sorted(txn, &map)
                .into_iter()
                .find_map(|(_, value)| text_in(txn, value)),
            Out::YText(text) => {
                embedded(text.diff(txn, YChange::identity)).or(Some(Typed::Text(text)))
            }
            Out::YXmlText(text) => {
                embedded(text.diff(txn, YChange::identity)).or(Some(Typed::Xml(text)))
            }
            _ => None,
        }
    }

    /// The first scalar value of a map, depth first: rewritten as it is, it
    /// leaves a deleted value as a board note's size does.
    fn scalar_in<T: ReadTxn>(txn: &T, out: Out) -> Option<(MapRef, String, Any)> {
        let Out::YMap(map) = out else { return None };
        sorted(txn, &map)
            .into_iter()
            .find_map(|(key, value)| match value {
                Out::Any(any @ (Any::String(_) | Any::Number(_) | Any::Bool(_))) => {
                    Some((map.clone(), key, any))
                }
                value => scalar_in(txn, value),
            })
    }

    /// Types `typed` at the start of the first text and deletes `deleted`
    /// units after it, then rewrites the first scalar: one update.
    fn edit(doc: &Doc, root: Root, typed: &str, deleted: u32) -> Vec<u8> {
        let before = doc.transact().state_vector();
        let out = root.of(doc);
        let (text, scalar) = {
            let txn = doc.transact();
            (text_in(&txn, out.clone()), scalar_in(&txn, out))
        };
        assert!(text.is_some() || scalar.is_some(), "nothing to edit");
        let mut txn = doc.transact_mut();
        match text {
            Some(Typed::Text(text)) => {
                text.insert(&mut txn, 0, typed);
                text.remove_range(&mut txn, typed.len() as u32, deleted);
            }
            Some(Typed::Xml(text)) => {
                text.insert(&mut txn, 0, typed);
                text.remove_range(&mut txn, typed.len() as u32, deleted);
            }
            None => {}
        }
        if let Some((map, key, value)) = scalar {
            map.insert(&mut txn, key, value);
        }
        drop(txn);
        doc.transact().encode_state_as_update_v1(&before)
    }

    fn tab(state: &[u8], client: u64) -> Doc {
        let tab = Doc::with_options(ydoc::doc_options(client));
        ydoc::replay(&tab, state, &[] as &[Vec<u8>]).unwrap();
        tab
    }

    /// Stored rows as two tabs write them: concurrent typing, a deletion of
    /// the other tab's letters and map values written over.
    fn rows(base: &[u8], root: Root) -> Vec<Vec<u8>> {
        let (one, two) = (tab(base, 41), tab(base, 42));
        let first = edit(&one, root, "ab", 0);
        let second = edit(&two, root, "cd", 0);
        ydoc::replay(&one, &second, &[] as &[Vec<u8>]).unwrap();
        let third = edit(&one, root, "e", 2);
        let fourth = edit(&two, root, "f", 1);
        vec![first, second, third, fourth]
    }

    /// Cut 1: a material room replays its stored base and rows straight into
    /// its own document (a board loads on bytes, `board.rs`). For every room
    /// kind that loads so, the room holds
    /// the state the scratch copy gave, passes the same load checks, and
    /// answers the next peer write and writes its own as before, under a
    /// client id no stored struct or deletion names and no user was
    /// assigned. Fails if the replay loses or reshapes a struct, or the room
    /// takes a client id its state holds.
    #[test]
    fn a_loaded_room_holds_the_state_the_scratch_copy_gave() {
        let face = |kind: &str, text: &str| json!({ "type": kind, "children": [{ "text": text }] });
        let question = json!({
            "id": "q1", "labels": "letters", "layout": "paper",
            "stem": [{ "type": "text", "text": "Stem" }],
            "parts": [{
                "id": "q1:part:1", "marks": 1, "solution": [],
                "blocks": [{ "type": "text", "text": "True?" }],
                "answer": { "type": "boolean", "correct": true },
            }],
        });
        let quiz = [json!({ "type": "quiz", "id": "quiz", "children": [{
            "type": "quiz_question", "id": "q1", "question": question,
            "children": [{ "text": "" }],
        }] })];
        let (quiz_content, quiz_keys) = items::quiz::states_from_value(&quiz, 0);
        let note = [json!({ "type": "p", "id": "b1", "children": [{ "text": "Body text" }] })];
        let set = [json!({
            "type": "flashcards", "id": "set", "children": [{
                "type": "flashcard", "id": "c1",
                "children": [face("flashcard_front", "Front"), face("flashcard_back", "Back")],
            }],
        })];
        let cases = [
            (
                "note",
                Model::Note,
                Root::Text(notes::CONTENT_ROOT),
                Model::Note.state_from_value(&note),
            ),
            (
                "flashcards",
                Model::Item(items::Kind::Flashcards),
                Root::Map(items::flashcards::ROOT),
                Model::Item(items::Kind::Flashcards).state_from_value(&set),
            ),
            (
                "quiz",
                Model::Item(items::Kind::Quiz),
                Root::Map(items::quiz::QUESTIONS_ROOT),
                quiz_content,
            ),
            (
                "quiz",
                Model::Item(items::Kind::QuizKeys),
                Root::Map(items::quiz::KEYS_ROOT),
                quiz_keys,
            ),
        ];
        let assigned: HashSet<u64> = [41, 7].into();
        for (kind, model, root, base) in cases {
            let rows = rows(&base, root);
            assert!(
                rows.iter().all(|row| row.len() > 2),
                "{kind}: an empty edit"
            );
            let room = super::loaded_doc(base.clone(), rows.clone(), &assigned).unwrap();
            let own = room.client_id();
            let before = loaded_as_before(&base, &rows, own.get());
            let held = room.transact().state_vector();
            assert_eq!(held.get(&own), 0, "{kind}: the room's id is in its state");
            assert!(!assigned.contains(&own.get()), "{kind}: an assigned id");
            assert_eq!(whole(&room), whole(&before), "{kind}: another state");
            assert_eq!(held, before.transact().state_vector(), "{kind}");
            for doc in [&room, &before] {
                model.assert_roots(&doc.transact()).unwrap();
            }
            let checks = |doc: &Doc| {
                let txn = doc.transact();
                let durable = ydoc::Durable::of(&txn);
                (
                    markers::contributors_in(&txn).unwrap(),
                    model.measure(&txn).unwrap(),
                    model.stored(kind, &txn).unwrap(),
                    durable.state_vector,
                    durable.delete_set,
                )
            };
            assert_eq!(checks(&room), checks(&before), "{kind}: other load checks");
            // The next writes: a peer's, as the room applies and broadcasts
            // it, then the room's own.
            let peer = edit(&tab(&whole(&room), 43), root, "g", 1);
            let broadcast = |doc: &Doc| ydoc::apply(doc, ydoc::decode(&peer).unwrap()).unwrap();
            assert_eq!(
                broadcast(&room),
                broadcast(&before),
                "{kind}: another broadcast"
            );
            assert_eq!(
                edit(&room, root, "h", 1),
                edit(&before, root, "h", 1),
                "{kind}: another server write"
            );
            assert_eq!(whole(&room), whole(&before), "{kind}");
        }
    }

    /// A document room's admission, as `admit_screened` runs it.
    enum Admission {
        Doc(crate::model::RoomValidator),
        Source(sources::SourceFormat, sources::Estimate),
    }

    /// A document room on its stored base: its document as the load replays
    /// it, its admission, and the rows its stores wrote, each its delta since
    /// the last with live markers hidden.
    struct Stored {
        doc: Doc,
        base: Vec<u8>,
        rows: Vec<Vec<u8>>,
        durable: ydoc::Durable,
        admission: Admission,
        /// A note's room, whose sessions hold its deletions.
        sessioned: bool,
    }

    impl Stored {
        fn new(base: Vec<u8>, admission: impl FnOnce(&Doc) -> Admission, sessioned: bool) -> Self {
            let doc = super::loaded_doc(base.clone(), Vec::new(), &HashSet::new()).unwrap();
            let durable = ydoc::Durable::of(&doc.transact());
            Stored {
                admission: admission(&doc),
                doc,
                base,
                rows: Vec::new(),
                durable,
                sessioned,
            }
        }

        /// A writer's update through the room's marker check and admission,
        /// then applied as the room applies it; why it was refused, else.
        fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
            let update = ydoc::decode(bytes).unwrap();
            markers::check(&self.doc.transact(), &update, self.doc.client_id())
                .map_err(|error| error.to_string())?;
            match &mut self.admission {
                Admission::Doc(validator) => match validator.admit(&self.doc, &update, false) {
                    crate::model::Admitted::Accepted => {}
                    crate::model::Admitted::Refused(why) => return Err(why),
                    _ => return Err("not accepted".into()),
                },
                Admission::Source(format, estimate) => {
                    match sources::admit_update(&self.doc, *format, bytes, estimate, 4 << 20, 0) {
                        sources::Admission::Accept => {}
                        refused => return Err(format!("{refused:?}")),
                    }
                }
            }
            let applied = match (&self.admission, self.sessioned) {
                (Admission::Source(..), _) => {
                    ydoc::apply_freeing(&self.doc, update, None).map(|_| ())
                }
                (_, true) => ydoc::apply_deleting(&self.doc, update).map(|_| ()),
                (_, false) => ydoc::apply(&self.doc, update).map(|_| ()),
            };
            applied.map_err(|error| format!("applied in part: {error}"))
        }

        /// The room's marker, written under its own client as a writer's
        /// first update does; its id.
        fn mark(&self) -> ID {
            let markers = self.doc.get_or_insert_map(ydoc::CONTRIBUTORS_ROOT);
            let value = HashMap::from([
                ("access".to_owned(), Any::from("write")),
                ("nonce".to_owned(), Any::from("n1")),
            ]);
            let before = self.doc.transact().state_vector();
            markers.insert(&mut self.doc.transact_mut(), "writer", Any::from(value));
            ID::new(self.doc.client_id(), before.get(&self.doc.client_id()))
        }

        /// A store's row, then the markers it hid cleared, as the room does.
        fn store(&mut self) {
            let hidden = markers::live_items(&self.doc);
            let (row, durable) = ydoc::delta_update(&self.doc.transact(), &self.durable, &hidden);
            self.rows.push(row);
            self.durable = durable;
            let markers = self.doc.get_or_insert_map(ydoc::CONTRIBUTORS_ROOT);
            markers.remove(&mut self.doc.transact_mut(), "writer");
        }

        /// The stored base and rows as a load, a fold or a projection replays
        /// them: in one transaction.
        fn replayed(&self) -> Doc {
            let doc = ydoc::scratch_doc();
            ydoc::replay(&doc, &self.base, &self.rows).unwrap();
            doc
        }
    }

    /// A held value or text: its id and length, the item of the type
    /// holding it (none in a root) and the item after it.
    #[derive(Clone, Copy)]
    struct Held {
        id: ID,
        len: u32,
        holder: Option<ID>,
        right: Option<ID>,
    }

    /// Each live text of `doc`, then each live value, by client and clock.
    fn values(doc: &Doc) -> Vec<Held> {
        let txn = doc.transact();
        let mut clients: Vec<_> = txn.state_vector().iter().map(|(c, e)| (*c, *e)).collect();
        clients.sort_unstable();
        let (mut texts, mut values) = (Vec::new(), Vec::new());
        for (client, end) in clients {
            for (_, item) in txn.store().blocks_in(&client, 0..end) {
                let Some(item) = item.filter(|item| !item.is_deleted()) else {
                    continue;
                };
                let found = match item.content() {
                    ItemContent::String(_) => &mut texts,
                    ItemContent::Any(_) => &mut values,
                    _ => continue,
                };
                found.push(Held {
                    id: *item.id(),
                    len: item.len(),
                    holder: item
                        .parent_branch()
                        .and_then(|branch| branch.item())
                        .map(|holder| *holder.id()),
                    right: item.right().map(|right| *right.id()),
                });
            }
        }
        texts.extend(values);
        texts
    }

    /// Client `client`'s first struct under the item `parent` names by id,
    /// with no origin: `true` at key `k`, or `"x"` typed into it.
    fn under(client: u64, parent: ID, typed: bool) -> Vec<u8> {
        let mut sent = vec![1, 1];
        sent.write_var(client);
        sent.write_var(0u32);
        sent.push(if typed { 0x04 } else { 0x28 });
        sent.write_var(0u32);
        sent.write_var(parent.client.get());
        sent.write_var(parent.clock);
        if typed {
            sent.write_string("x");
        } else {
            sent.write_string("k");
            sent.extend([1, 120]);
        }
        sent.push(0);
        sent
    }

    /// Client `client`'s `"yy"` typed after `held`'s last unit, then a struct
    /// under that text, as [under] writes one.
    fn under_own(client: u64, held: Held, typed: bool) -> Vec<u8> {
        let mut sent = vec![1, 2];
        sent.write_var(client);
        sent.write_var(0u32);
        sent.push(0x84 | if held.right.is_some() { 0x40 } else { 0 });
        sent.write_var(held.id.client.get());
        sent.write_var(held.id.clock + held.len - 1);
        if let Some(right) = held.right {
            sent.write_var(right.client.get());
            sent.write_var(right.clock);
        }
        sent.write_string("yy");
        // One section: the second struct after the first, its header (one
        // client, one struct, the client, its clock) left out.
        let second = under(client, ID::new(ClientID::new(client), 0), typed);
        sent.extend(&second[4..]);
        sent
    }

    fn deleting(id: ID, len: u32) -> Vec<u8> {
        let mut deleted = IdSet::default();
        deleted.insert(id, len);
        let mut sent = vec![0];
        sent.extend(deleted.encode_v1());
        sent
    }

    /// Security audit (after the board's `parent_type` check): yrs fails to
    /// integrate an item whose parent is an item of other content than a
    /// type, where Yjs collects it. A board stores its writers' bytes and
    /// had to refuse such parents; a document room stores its own
    /// document's deltas, so what its document collected is stored as
    /// collected, and its rows replay. In each document room (a note, a
    /// flashcard set, a quiz's questions and keys, a text and a DOCX
    /// source), `true` at a key and `"x"` typed under a held value (a text
    /// where the room holds one), under the room's live marker and under a
    /// text of the update's own are refused, applying nothing (the first two
    /// by admission's trial on a copy, the last by `ydoc::inspect`); under
    /// a value deleted since the base, a unit collected since the base (a
    /// value, its holder deleted) and a marker cleared since the base they
    /// are taken, collected and stored so. After each, the stored base and
    /// rows replay in one transaction to the room's document. Fails if a
    /// room stores what its document did not integrate, or (before
    /// `ydoc::inspect` refused an item under its own update's text) with an
    /// update applied in part: the note's for the key set under its own
    /// text, the text and Word sources' for both, while the flashcard set's
    /// and the quiz's shape checks refused both first.
    #[test]
    fn a_document_rooms_stored_rows_replay_whatever_parent_an_update_names() {
        let note = [json!({ "type": "p", "id": "b1", "children": [{ "text": "Body text" }] })];
        let face = |kind: &str, text: &str| json!({ "type": kind, "children": [{ "text": text }] });
        let set = [json!({
            "type": "flashcards", "id": "set", "children": [{
                "type": "flashcard", "id": "c1",
                "children": [face("flashcard_front", "Front"), face("flashcard_back", "Back")],
            }],
        })];
        let question = json!({
            "id": "q1", "labels": "letters", "layout": "paper",
            "stem": [{ "type": "text", "text": "Stem" }],
            "parts": [{
                "id": "q1:part:1", "marks": 1, "solution": [],
                "blocks": [{ "type": "text", "text": "True?" }],
                "answer": { "type": "boolean", "correct": true },
            }],
        });
        let quiz = [json!({ "type": "quiz", "id": "quiz", "children": [{
            "type": "quiz_question", "id": "q1", "question": question,
            "children": [{ "text": "" }],
        }] })];
        let (questions, keys) = items::quiz::states_from_value(&quiz, 0);
        let docx = {
            let doc = Doc::with_options(ydoc::doc_options(5));
            doc.get_or_insert_map("stories").insert(
                &mut doc.transact_mut(),
                "body",
                TextPrelim::new("Body text"),
            );
            whole(&doc)
        };
        let validator = |model: Model, kind: &'static str| {
            move |doc: &Doc| {
                Admission::Doc(model.validator(kind, model.measure(&doc.transact()).unwrap()))
            }
        };
        let source = |format| move |_: &Doc| Admission::Source(format, sources::Estimate::new(0));
        type Open = Box<dyn Fn() -> Stored>;
        let rooms: [(&str, Open); 6] = [
            ("note", {
                let base = Model::Note.state_from_value(&note);
                Box::new(move || Stored::new(base.clone(), validator(Model::Note, "note"), true))
            }),
            ("flashcards", {
                let model = Model::Item(items::Kind::Flashcards);
                let base = model.state_from_value(&set);
                Box::new(move || Stored::new(base.clone(), validator(model, "flashcards"), false))
            }),
            ("quiz questions", {
                Box::new(move || {
                    Stored::new(
                        questions.clone(),
                        validator(Model::Item(items::Kind::Quiz), "quiz"),
                        false,
                    )
                })
            }),
            ("quiz keys", {
                Box::new(move || {
                    Stored::new(
                        keys.clone(),
                        validator(Model::Item(items::Kind::QuizKeys), "quiz"),
                        false,
                    )
                })
            }),
            ("text source", {
                let base = sources::text::text_seed(b"Line one\nLine two").unwrap();
                Box::new(move || {
                    Stored::new(base.clone(), source(sources::SourceFormat::Text), false)
                })
            }),
            (
                "docx source",
                Box::new(move || {
                    Stored::new(docx.clone(), source(sources::SourceFormat::Docx), false)
                }),
            ),
        ];
        for (room, open) in &rooms {
            for typed in [false, true] {
                let case = |shape: &str| format!("{room}, {shape}, typed {typed}");
                // The first live text (a value where none is held), and
                // one under a type of its own (none in a text source, whose
                // root holds its text).
                let values = values(&open().doc);
                let value = values[0];
                let nested = values.iter().find(|held| held.holder.is_some()).copied();
                let mut refused = vec![
                    ("a held value", open(), under(21, value.id, typed)),
                    ("its own text", open(), under_own(21, value, typed)),
                ];
                let marked = open();
                let marker = marked.mark();
                refused.push(("a marker", marked, under(21, marker, typed)));
                for (shape, mut stored, sent) in refused {
                    let before = whole(&stored.doc);
                    assert!(stored.send(&sent).is_err(), "{}", case(shape));
                    assert_eq!(
                        whole(&stored.doc),
                        before,
                        "{}: applied in part",
                        case(shape)
                    );
                }
                let mut deleted = open();
                deleted.send(&deleting(value.id, value.len)).unwrap();
                deleted.store();
                let mut taken = vec![("a deleted value", deleted, under(21, value.id, typed))];
                if let Some(nested) = nested {
                    let mut collected = open();
                    collected
                        .send(&deleting(nested.holder.unwrap(), 1))
                        .unwrap();
                    collected.store();
                    taken.push(("a collected value", collected, under(21, nested.id, typed)));
                }
                let mut cleared = open();
                let marker = cleared.mark();
                cleared.store();
                taken.push(("a cleared marker", cleared, under(21, marker, typed)));
                for (shape, mut stored, sent) in taken {
                    stored
                        .send(&sent)
                        .unwrap_or_else(|why| panic!("{}: {why}", case(shape)));
                    stored.store();
                    let row = ydoc::decode(stored.rows.last().unwrap()).unwrap();
                    assert!(
                        row.blocks().any(|block| matches!(
                            block,
                            UpdateBlock::Gc(range) if range.client == ClientID::new(21)
                        )),
                        "{}: not stored collected",
                        case(shape)
                    );
                    assert_eq!(
                        whole(&stored.replayed()),
                        whole(&stored.doc),
                        "{}",
                        case(shape)
                    );
                }
            }
        }
    }
}
