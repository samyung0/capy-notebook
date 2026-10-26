//! A note room's editing sessions (in-place collection, step 1: the
//! bookkeeping; Epo 2026-10-23). A session is one Y.Doc, named by its client
//! id (`client_ids.rs`), and its Undo stack lives exactly as long. The room
//! counts a session at the stored version it last acknowledged (`ack`) or
//! named in its JOIN, and holds the deletions its own updates added: what an
//! Undo of it may restore, each released 25 h after it arrived, since editors'
//! Undo reaches back at most 24 h. A session counts while connected and for
//! 24 h after it was last seen; it ends earlier on a clean Leave naming it.
//! A later fold reads what must stay from here ([Sessions::holds]): the
//! oldest version every counted session reached and the held deletions,
//! with the agent holds stored beside the document ([agent_held]). Notes
//! only (Q274): item rooms keep their whole history.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use yrs::IdSet;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;

use crate::protocol::{read_var, write_var};

/// How long a session away from the room still counts (Q2).
pub const COUNTED_FOR: Duration = Duration::from_secs(24 * 60 * 60);
/// How long a held deletion stays after it arrived (Q2): an hour past the
/// editors' 24 h Undo, which runs on the tab's clock.
pub const HELD_FOR: Duration = Duration::from_secs(25 * 60 * 60);
/// How long an agent edit's deletions (and its Undo's and Redo's) stay
/// held, from the agent edit (Q390): an hour past its payload's offer
/// (`ydoc::undo::OFFERED_FOR`), as a person's are past theirs, so a wall
/// clock stepping back never offers an Undo whose holds went (review r3 N8).
pub const AGENT_HELD_FOR: Duration = Duration::from_secs(25 * 60 * 60);
/// Deletions arriving within this of a batch's first join it, stamped with
/// the latest arrival, so a session keeps at most one batch a minute.
const BATCH: Duration = Duration::from_secs(60);

/// What a fold's collection must keep for the room's sessions.
#[derive(Debug, PartialEq)]
pub struct Holds {
    /// The oldest stored version every counted session reached; none when
    /// no session counts.
    pub reached: Option<i64>,
    /// Every counted session's held deletions (with the stored agent holds,
    /// [agent_holds], they make H).
    pub held: IdSet,
}

/// Deletions that arrived together, released once `at` is old enough.
#[derive(Clone, Debug, PartialEq)]
struct Batch {
    started: SystemTime,
    at: SystemTime,
    ids: IdSet,
}

/// Adds `ids` arriving `now` to `held`: to its last batch while that is
/// younger than [BATCH], else as a new one.
fn hold(held: &mut Vec<Batch>, ids: IdSet, now: SystemTime) {
    match held.last_mut() {
        Some(batch) if since(batch.started, now) < BATCH => {
            batch.ids.merge_with(ids);
            batch.at = batch.at.max(now);
        }
        _ => held.push(Batch {
            started: now,
            at: now,
            ids,
        }),
    }
}

#[derive(Debug)]
struct Session {
    user: String,
    version: i64,
    channels: u32,
    seen: SystemTime,
    held: Vec<Batch>,
    ended: bool,
    /// The room answered one of its step 1s (or a row stored it): it holds
    /// the room's state. A new session (version 0) that never synced holds
    /// nothing and is left out of `reached` (review r1 H2).
    synced: bool,
    /// It acknowledged a store in this room life (or a row stored it).
    acked: bool,
    /// The change count at its last change (see [Sessions::unsaved]).
    changed: u64,
    /// The change count at its held set's last change: a store writes the
    /// set only when it changed (review r2 L4).
    held_changed: u64,
}

impl Session {
    fn new(user: &str, version: i64, seen: SystemTime) -> Self {
        Session {
            user: user.to_owned(),
            version,
            channels: 0,
            seen,
            held: Vec::new(),
            ended: false,
            synced: false,
            acked: false,
            changed: 0,
            held_changed: 0,
        }
    }

    fn counts(&self, now: SystemTime) -> bool {
        !self.ended && (self.channels > 0 || since(self.seen, now) < COUNTED_FOR)
    }
}

/// A session as its row stores it; `seen` none: it ended (the row's session
/// columns are cleared). `held` is written only when `held_changed`.
#[derive(Debug, PartialEq)]
pub struct Row {
    pub client: i64,
    pub user: String,
    pub version: i64,
    pub seen: Option<SystemTime>,
    pub held_changed: bool,
    pub held: Option<Vec<u8>>,
}

/// The `acked_version` of a session row whose record was lost (Q382's drop):
/// its tab is late when it returns, whatever version it names (Q385).
pub const LOST: i64 = -1;

/// What a store writes of the sessions: the changed rows and the change
/// count they reach ([Sessions::saved]).
#[derive(Debug, Default)]
pub struct Unsaved {
    pub rows: Vec<Row>,
    pub through: u64,
}

/// Stored session records that could not be read (Q382, Epo 2026-10-26):
/// each such session is dropped alone and reported, and its id is
/// remembered as lost (Q385: its tab returns as late).
#[derive(Debug, Default, PartialEq)]
pub struct Damaged {
    pub sessions: Vec<u64>,
}

#[derive(Debug, Default)]
pub struct Sessions {
    sessions: HashMap<u64, Session>,
    /// Ids whose session record was lost: a JOIN or draft group under one is
    /// late (Q385).
    lost: HashSet<u64>,
    changes: u64,
    saved: u64,
}

fn since(then: SystemTime, now: SystemTime) -> Duration {
    now.duration_since(then).unwrap_or_default()
}

/// Whether a JOIN or a draft group naming `version` is older than the
/// latest collection's window (`window`, 0 before any): it missed what that
/// collection discarded. Version 0 is a new session holding nothing. One
/// under a `lost` session's id is late whatever it names (Q385): its held
/// deletions were not kept.
pub fn late(window: i64, version: u64, lost: bool) -> bool {
    lost || (version > 0 && i64::try_from(version).is_ok_and(|version| version < window))
}

/// A stored version a note room now holds (its store's, or a service edit's
/// it applied), after `stored`, the latest it took: the versions it skipped
/// are service edits whose rows committed before the room applied them,
/// kept in `gaps` until they arrive (review r1 M1). The new latest.
pub fn took(stored: i64, gaps: &mut BTreeSet<i64>, version: i64) -> i64 {
    if version > stored + 1 {
        gaps.extend(stored + 1..version);
    }
    gaps.remove(&version);
    stored.max(version)
}

/// The latest version a note room holds with every version before it: what
/// its members hold once they heard its broadcasts.
pub fn whole(stored: i64, gaps: &BTreeSet<i64>) -> i64 {
    gaps.first().map_or(stored, |gap| gap - 1)
}

impl Sessions {
    /// Sessions as their rows stored them (those seen within the cap) and
    /// the ids whose records were lost; a record that cannot be read is left
    /// out and its id lost (Q382, Q385).
    pub fn load(
        rows: impl IntoIterator<Item = (u64, String, i64, SystemTime, Option<Vec<u8>>)>,
        lost: impl IntoIterator<Item = u64>,
    ) -> (Self, Damaged) {
        let mut damaged = Damaged::default();
        let mut sessions = HashMap::new();
        let mut lost: HashSet<u64> = lost.into_iter().collect();
        for (client, user, version, seen, held) in rows {
            let held = match held.map(|bytes| decode_held(&bytes)) {
                Some(Some(held)) => held,
                Some(None) => {
                    damaged.sessions.push(client);
                    lost.insert(client);
                    continue;
                }
                None => Vec::new(),
            };
            let mut session = Session::new(&user, version, seen);
            session.held = held;
            session.synced = true;
            session.acked = true;
            sessions.insert(client, session);
        }
        let sessions = Sessions {
            sessions,
            lost,
            changes: 0,
            saved: 0,
        };
        (sessions, damaged)
    }

    /// Whether `client`'s session record was lost (Q385).
    pub fn lost(&self, client: u64) -> bool {
        self.lost.contains(&client)
    }

    /// The live session under `client`, when it is `user`'s: a channel acts
    /// only on its own user's session (review r2 N3).
    fn own(&mut self, client: u64, user: &str) -> Option<&mut Session> {
        let changes = self.changes + 1;
        let session = self
            .sessions
            .get_mut(&client)
            .filter(|s| !s.ended && s.user == user)?;
        self.changes = changes;
        session.changed = changes;
        Some(session)
    }

    fn change(&mut self, client: u64) -> Option<&mut Session> {
        self.changes += 1;
        let changes = self.changes;
        let session = self.sessions.get_mut(&client)?;
        session.changed = changes;
        Some(session)
    }

    /// A channel joined under `client` naming `version` (its JOIN's). False,
    /// changing nothing, when a live session under that id is another
    /// user's: the client-id binding refuses that first (review r1 N4).
    pub fn joined(&mut self, client: u64, user: &str, version: i64, now: SystemTime) -> bool {
        let fresh = match self.sessions.get_mut(&client) {
            Some(session) if !session.ended && session.user != user => return false,
            // An ended session's id starts a new session.
            Some(session) if session.ended => {
                *session = Session::new(user, version, now);
                true
            }
            Some(_) => false,
            None => {
                self.sessions
                    .insert(client, Session::new(user, version, now));
                true
            }
        };
        if let Some(session) = self.change(client) {
            session.version = version;
            session.channels += 1;
            session.seen = now;
            // A new session's row holds none of an earlier one's deletions.
            if fresh {
                session.held_changed = session.changed;
            }
        }
        true
    }

    /// Whether a session under `client` is kept (live or ended).
    pub fn has(&self, client: u64) -> bool {
        self.sessions.contains_key(&client)
    }

    /// The room answered the session's step 1: it holds the room's state.
    pub fn synced(&mut self, client: u64) {
        if let Some(session) = self.sessions.get_mut(&client) {
            session.synced = true;
        }
    }

    /// One of `user`'s channels under `client` went (a drop, a Leave with
    /// unsent edits). A session that never acknowledged a store, holds
    /// nothing and has no row (`recorded` false) is forgotten with its last
    /// channel: its tab holds no unsent edit, so JOINs alone neither grow the
    /// map nor hold `reached` back (review r1 H2, r2 L1).
    pub fn left(&mut self, client: u64, user: &str, now: SystemTime, recorded: bool) {
        if let Some(session) = self.own(client, user) {
            session.channels = session.channels.saturating_sub(1);
            session.seen = now;
            if session.channels == 0 && !session.acked && session.held.is_empty() && !recorded {
                self.sessions.remove(&client);
            }
        }
    }

    /// A clean Leave naming `user`'s session: it ends, its deletions
    /// released.
    pub fn end(&mut self, client: u64, user: &str) {
        if let Some(session) = self.own(client, user) {
            session.ended = true;
            session.channels = 0;
            session.held.clear();
            session.held_changed = session.changed;
        }
    }

    /// `user`'s session acknowledged a store at `version`; the same version
    /// again changes nothing to write (review r1 L2).
    pub fn acked(&mut self, client: u64, user: &str, version: i64) {
        let same = self
            .sessions
            .get(&client)
            .is_some_and(|s| s.version == version);
        if let Some(session) = self.sessions.get_mut(&client).filter(|s| s.user == user) {
            session.acked = true;
        }
        if !same && let Some(session) = self.own(client, user) {
            session.version = version;
        }
    }

    /// `user`'s session's update deleted `ids`, which the room held
    /// undeleted: whether it holds them (none: no such session of that user,
    /// or nothing deleted).
    pub fn deleted(&mut self, client: u64, user: &str, ids: IdSet, now: SystemTime) -> bool {
        if ids.is_empty() {
            return false;
        }
        let Some(session) = self.own(client, user) else {
            return false;
        };
        session.held_changed = session.changed;
        hold(&mut session.held, ids, now);
        true
    }

    /// Sessions past the cap end and deletions past their hold go.
    fn expire(&mut self, now: SystemTime) {
        let mut changed = Vec::new();
        for (&client, session) in &mut self.sessions {
            let ended = !session.ended && !session.counts(now);
            let before = session.held.len();
            session.held.retain(|batch| since(batch.at, now) < HELD_FOR);
            if ended {
                session.ended = true;
                session.held.clear();
            }
            if ended || session.held.len() != before {
                changed.push(client);
            }
        }
        for client in changed {
            if let Some(session) = self.change(client) {
                session.held_changed = session.changed;
            }
        }
    }

    /// What a fold must keep now: the oldest version every counted session
    /// reached (a new one that never synced holds nothing yet), and the held
    /// deletions.
    pub fn holds(&mut self, now: SystemTime) -> Holds {
        self.expire(now);
        let mut reached = None;
        let mut held = IdSet::new();
        for session in self.sessions.values().filter(|s| s.counts(now)) {
            if session.synced || session.version > 0 {
                reached = Some(reached.map_or(session.version, |r: i64| r.min(session.version)));
            }
            for batch in &session.held {
                held.merge_with(batch.ids.clone());
            }
        }
        Holds { reached, held }
    }

    /// The rows of sessions changed since the last save that `recorded`
    /// says have a row (an accepted write recorded their id to their user)
    /// and the change count they reach: a store writes them in its
    /// transaction, so a held deletion is durable with the state holding it.
    pub fn unsaved(&mut self, now: SystemTime, recorded: impl Fn(u64, &str) -> bool) -> Unsaved {
        self.expire(now);
        let rows = self
            .sessions
            .iter()
            .filter(|&(&client, s)| s.changed > self.saved && recorded(client, &s.user))
            .map(|(&client, s)| {
                let held_changed = s.held_changed > self.saved;
                Row {
                    client: client as i64,
                    user: s.user.clone(),
                    version: s.version,
                    seen: (!s.ended).then_some(if s.channels > 0 { now } else { s.seen }),
                    held_changed,
                    held: (held_changed && !s.ended && !s.held.is_empty())
                        .then(|| encode_held(&s.held)),
                }
            })
            .collect();
        Unsaved {
            rows,
            through: self.changes,
        }
    }

    /// The rows up to change `through` were written: ended sessions go.
    pub fn saved(&mut self, through: u64) {
        self.saved = self.saved.max(through);
        let saved = self.saved;
        self.sessions
            .retain(|_, session| !(session.ended && session.changed <= saved));
    }
}

/// The agent holds as `material_yjs_documents.agent_held` stores them (review
/// r1 M3): what agent edits, their Undos and Redos deleted, so P2 never
/// collects what an unexpired Undo payload may name. Each batch is held
/// [AGENT_HELD_FOR] from its agent edit (`edited`, which an Undo or Redo
/// keeps, Q385, Q390), written in the edit's own transaction whether or not
/// a room is loaded. The stored record with `ids` added and expired batches
/// gone (none when nothing is left), and whether the stored one could not be
/// read (Q386: dropped; the caller reports it).
pub fn agent_held(
    stored: Option<&[u8]>,
    ids: IdSet,
    edited: SystemTime,
    now: SystemTime,
) -> (Option<Vec<u8>>, bool) {
    let (mut held, damaged) = agent_batches(stored, now);
    if !ids.is_empty() {
        hold(&mut held, ids, edited);
    }
    ((!held.is_empty()).then(|| encode_held(&held)), damaged)
}

/// What the stored agent holds keep at `now`, a fold's part of H beside
/// [Sessions::holds], and whether the record could not be read (Q386).
pub fn agent_holds(stored: Option<&[u8]>, now: SystemTime) -> (IdSet, bool) {
    let (held, damaged) = agent_batches(stored, now);
    let mut ids = IdSet::new();
    for batch in held {
        ids.merge_with(batch.ids);
    }
    (ids, damaged)
}

/// The unexpired batches of a stored agent record (none when unreadable).
fn agent_batches(stored: Option<&[u8]>, now: SystemTime) -> (Vec<Batch>, bool) {
    match stored.map(decode_held) {
        Some(Some(mut held)) => {
            held.retain(|batch| since(batch.at, now) < AGENT_HELD_FOR);
            (held, false)
        }
        Some(None) => (Vec::new(), true),
        None => (Vec::new(), false),
    }
}

/// Unix seconds, rounded up, so a batch read back is never released early
/// (review r1 N1).
fn unix(time: SystemTime) -> u64 {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    since.as_secs() + u64::from(since.subsec_nanos() > 0)
}

/// Held batches as stored: a count, then each batch's arrival (Unix
/// seconds) and its ids (a Yjs delete set, length-prefixed).
fn encode_held(held: &[Batch]) -> Vec<u8> {
    let mut out = Vec::new();
    write_var(&mut out, held.len() as u64);
    for batch in held {
        write_var(&mut out, unix(batch.at));
        let ids = batch.ids.encode_v1();
        write_var(&mut out, ids.len() as u64);
        out.extend_from_slice(&ids);
    }
    out
}

fn decode_held(bytes: &[u8]) -> Option<Vec<Batch>> {
    let mut at = 0;
    let count = read_var(bytes, &mut at).ok()?;
    let mut held = Vec::new();
    for _ in 0..count {
        let time = UNIX_EPOCH + Duration::from_secs(read_var(bytes, &mut at).ok()?);
        let len = usize::try_from(read_var(bytes, &mut at).ok()?).ok()?;
        let ids = IdSet::decode_v1(bytes.get(at..at.checked_add(len)?)?).ok()?;
        at += len;
        held.push(Batch {
            started: time,
            at: time,
            ids,
        });
    }
    (at == bytes.len()).then_some(held)
}

#[cfg(test)]
mod tests {
    use yrs::ID;
    use yrs::block::ClientID;

    use super::*;

    const HOUR: Duration = Duration::from_secs(60 * 60);

    fn ids(client: u64, clock: u32, len: u32) -> IdSet {
        let mut set = IdSet::new();
        set.insert(ID::new(ClientID::new(client), clock), len);
        set
    }

    fn start() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_800_000_000)
    }

    /// The reached version is the oldest acknowledgement among counted
    /// sessions; an away session counts for 24 h after it was last seen and
    /// ends on its own then; a clean Leave ends one at once.
    #[test]
    fn sessions_count_while_connected_and_24_hours_after() {
        let now = start();
        let mut sessions = Sessions::default();
        assert_eq!(sessions.holds(now).reached, None);
        sessions.joined(7, "u_a", 3, now);
        sessions.joined(8, "u_b", 0, now);
        sessions.acked(8, "u_b", 5);
        assert_eq!(sessions.holds(now).reached, Some(3));
        sessions.acked(7, "u_a", 6);
        assert_eq!(sessions.holds(now).reached, Some(5));
        sessions.left(8, "u_b", now, false);
        assert_eq!(sessions.holds(now + 23 * HOUR).reached, Some(5));
        assert_eq!(sessions.holds(now + 24 * HOUR).reached, Some(6));
        // Ended at the cap: back within it, it is not counted again.
        assert_eq!(sessions.holds(now + 23 * HOUR).reached, Some(6));
        sessions.end(7, "u_a");
        assert_eq!(sessions.holds(now).reached, None);
    }

    /// The 25 h release (Q2): each held deletion goes 25 h after it arrived,
    /// while its session still counts; a batch takes the latest arrival in
    /// it. Fails if deletions stay past 25 h or go earlier.
    #[test]
    fn held_deletions_go_25_hours_after_they_arrived() {
        let now = start();
        let mut sessions = Sessions::default();
        sessions.joined(7, "u_a", 1, now);
        sessions.deleted(7, "u_a", ids(9, 0, 2), now);
        sessions.deleted(7, "u_a", ids(9, 5, 1), now + Duration::from_secs(30));
        sessions.deleted(7, "u_a", ids(9, 10, 1), now + 2 * HOUR);
        let mut at = |hours: Duration| sessions.holds(now + hours).held;
        let mut both = ids(9, 0, 2);
        both.merge_with(ids(9, 5, 1));
        let mut all = both.clone();
        all.merge_with(ids(9, 10, 1));
        assert_eq!(at(25 * HOUR - Duration::from_secs(1)), all);
        // The first batch's last deletion arrived 30 s after its first.
        assert_eq!(at(25 * HOUR + Duration::from_secs(29)), all);
        assert_eq!(at(25 * HOUR + Duration::from_secs(30)), ids(9, 10, 1));
        assert_eq!(at(27 * HOUR), IdSet::new());
    }

    /// Only recorded sessions are written, each change once a store took it;
    /// an ended one is written cleared, then forgotten.
    #[test]
    fn changed_recorded_sessions_are_saved_once() {
        let now = start();
        let mut sessions = Sessions::default();
        sessions.joined(7, "u_a", 1, now);
        sessions.joined(8, "u_a", 1, now);
        sessions.deleted(7, "u_a", ids(9, 0, 1), now);
        let recorded = |client: u64, _: &str| client == 7;
        let Unsaved { rows, through, .. } = sessions.unsaved(now, recorded);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].client, rows[0].seen), (7, Some(now)));
        let held = decode_held(rows[0].held.as_ref().unwrap()).unwrap();
        assert_eq!(held[0].ids, ids(9, 0, 1));
        // A change while the store ran is written by the next one.
        sessions.acked(7, "u_a", 2);
        sessions.saved(through);
        let Unsaved { rows, through, .. } = sessions.unsaved(now, recorded);
        assert_eq!(rows.iter().map(|r| r.version).collect::<Vec<_>>(), [2]);
        sessions.saved(through);
        assert!(sessions.unsaved(now, recorded).rows.is_empty());
        // The same acknowledgement again writes nothing (review r1 L2).
        sessions.acked(7, "u_a", 2);
        assert!(sessions.unsaved(now, recorded).rows.is_empty());
        sessions.end(7, "u_a");
        let Unsaved { rows, through, .. } = sessions.unsaved(now, recorded);
        assert_eq!((rows[0].seen, rows[0].held.is_none()), (None, true));
        sessions.saved(through);
        assert!(!sessions.sessions.contains_key(&7));
    }

    /// Editor 2026-10-26: a session that never wrote has no row, so the next
    /// room life counts only the written ones; a window past its version
    /// then makes it late, and it holds nothing the late path could lose.
    #[test]
    fn a_session_that_never_wrote_is_counted_only_while_its_room_lives() {
        let now = start();
        let mut sessions = Sessions::default();
        sessions.joined(7, "u_a", 2, now);
        sessions.deleted(7, "u_a", ids(9, 0, 1), now);
        sessions.joined(8, "u_b", 1, now);
        sessions.acked(8, "u_b", 1);
        sessions.left(8, "u_b", now, false);
        assert_eq!(sessions.holds(now).reached, Some(1));
        let rows = sessions.unsaved(now, |client, _| client == 7).rows;
        let (mut next, _) = Sessions::load(
            rows.into_iter().map(|row| {
                let seen = row.seen.expect("a live session");
                (row.client as u64, row.user, row.version, seen, row.held)
            }),
            [],
        );
        let holds = next.holds(now);
        assert_eq!((holds.reached, holds.held), (Some(2), ids(9, 0, 1)));
        assert!(late(2, 1, false));
    }

    #[test]
    fn held_batches_round_trip_and_damage_is_refused() {
        let now = start();
        let held = vec![
            Batch {
                started: now,
                at: now,
                ids: ids(9, 0, 3),
            },
            Batch {
                started: now + HOUR,
                at: now + HOUR,
                ids: ids(4, 2, 1),
            },
        ];
        let bytes = encode_held(&held);
        assert_eq!(decode_held(&bytes), Some(held));
        assert_eq!(decode_held(&bytes[..bytes.len() - 1]), None);
        let mut longer = bytes.clone();
        longer.push(0);
        assert_eq!(decode_held(&longer), None);
    }

    /// Q382 (Epo 2026-10-26): a session row whose held deletions cannot be
    /// read is dropped alone, as if it had ended, and the rest load. Fails if
    /// one damaged record fails the load or drops the others.
    #[test]
    fn a_damaged_record_drops_only_its_own_session() {
        let now = start();
        let good = encode_held(&[Batch {
            started: now,
            at: now,
            ids: ids(9, 0, 3),
        }]);
        let rows = [
            (7, "u_a".to_owned(), 4, now, Some(vec![9])),
            (8, "u_b".to_owned(), 5, now, Some(good)),
        ];
        let (mut sessions, damaged) = Sessions::load(rows, [6]);
        assert_eq!(damaged, Damaged { sessions: vec![7] });
        let holds = sessions.holds(now);
        assert_eq!((holds.reached, holds.held), (Some(5), ids(9, 0, 3)));
        // Its id, and one lost before, are remembered lost (Q385).
        assert!(sessions.lost(7) && sessions.lost(6) && !sessions.lost(8));
    }

    /// Late detection: a version below the latest collection's window is
    /// late, a new session (0) never is, and nothing is late before any
    /// collection (window 0).
    #[test]
    fn a_version_below_the_window_is_late() {
        assert!(!late(0, 1, false));
        assert!(!late(5, 0, false));
        assert!(late(5, 4, false));
        assert!(!late(5, 5, false));
        assert!(!late(5, u64::MAX, false));
        // Review r2 M1: under a lost session's id, late whatever it names.
        assert!(late(0, 0, true));
        assert!(late(5, 9, true));
    }

    /// Review r1 H2: a new session (version 0) that never synced holds
    /// nothing, so it does not hold `reached` at 0, and its last channel's
    /// end forgets it; once synced it counts at its version, 0 included.
    /// Fails if a brief open that never synced holds `reached` at 0.
    #[test]
    fn a_new_session_counts_once_it_synced() {
        let now = start();
        let mut sessions = Sessions::default();
        sessions.joined(7, "u_a", 4, now);
        sessions.joined(8, "u_b", 0, now);
        assert_eq!(sessions.holds(now).reached, Some(4));
        sessions.left(8, "u_b", now, false);
        assert!(!sessions.sessions.contains_key(&8));
        sessions.joined(9, "u_b", 0, now);
        sessions.synced(9);
        assert_eq!(sessions.holds(now).reached, Some(0));
        sessions.acked(9, "u_b", 6);
        assert_eq!(sessions.holds(now).reached, Some(4));
    }

    /// Review r1 N4: a live session stays its user's; a JOIN of its id by
    /// another user changes nothing (the binding refuses that first). An
    /// ended session's id starts a new one.
    #[test]
    fn a_live_session_is_never_taken_by_another_user() {
        let now = start();
        let mut sessions = Sessions::default();
        sessions.joined(7, "u_a", 3, now);
        sessions.deleted(7, "u_a", ids(9, 0, 1), now);
        assert!(!sessions.joined(7, "u_b", 1, now));
        let holds = sessions.holds(now);
        assert_eq!((holds.reached, holds.held), (Some(3), ids(9, 0, 1)));
        sessions.end(7, "u_a");
        assert!(sessions.joined(7, "u_b", 1, now));
        assert_eq!(sessions.holds(now).held, IdSet::new());
    }

    /// Review r1 M3, Q390: an agent edit's deletions are held from the edit,
    /// an hour past its payload's 24 h (review r3 N8); an Undo's, added
    /// later with the edit's time, are held as long; the record drops what
    /// expired. Q386: an unreadable record is dropped and said so. Fails if
    /// a batch is not held, held past 25 h, or held from its own time.
    #[test]
    fn agent_deletions_are_held_25_hours_from_the_edit() {
        let now = start();
        let (stored, damaged) = agent_held(None, ids(3, 0, 2), now, now);
        assert!(!damaged);
        let held = |stored: &Option<Vec<u8>>, at| agent_holds(stored.as_deref(), at).0;
        assert_eq!(held(&stored, now + 24 * HOUR), ids(3, 0, 2));
        assert_eq!(held(&stored, now + 25 * HOUR), IdSet::new());
        // The Undo, an hour later, keeps the edit's time.
        let (stored, _) = agent_held(stored.as_deref(), ids(5, 0, 1), now, now + HOUR);
        let mut both = ids(3, 0, 2);
        both.merge_with(ids(5, 0, 1));
        assert_eq!(held(&stored, now + 24 * HOUR), both);
        assert_eq!(held(&stored, now + 25 * HOUR), IdSet::new());
        // A later edit's write drops what expired.
        let later = now + 26 * HOUR;
        let (stored, _) = agent_held(stored.as_deref(), ids(6, 0, 1), later, later);
        assert_eq!(held(&stored, later), ids(6, 0, 1));
        let gone = later + 25 * HOUR;
        assert_eq!(
            agent_held(stored.as_deref(), IdSet::new(), gone, gone).0,
            None
        );
        // Q386: unreadable, dropped and said so; the new batch is kept.
        let (stored, damaged) = agent_held(Some(&[9]), ids(3, 0, 2), now, now);
        assert!(damaged);
        assert_eq!(held(&stored, now), ids(3, 0, 2));
        assert!(agent_holds(Some(&[9]), now).1);
    }

    /// Review r1 N1: a batch's arrival is stored rounded up to the second,
    /// so one read back is released no earlier than 25 h after it arrived.
    #[test]
    fn a_stored_arrival_rounds_up() {
        let at = start() + Duration::from_millis(500);
        let bytes = encode_held(&[Batch {
            started: at,
            at,
            ids: ids(9, 0, 1),
        }]);
        let held = decode_held(&bytes).expect("held");
        assert_eq!(held[0].at, start() + Duration::from_secs(1));
    }

    /// Review r1 M1: a store's version past a service edit the room has not
    /// applied leaves a gap, and the room holds every version only up to it
    /// until that edit arrives, so no `stored` notice names a version its
    /// members may lack. Fails if a skipped version counts as held.
    #[test]
    fn a_skipped_version_stays_a_gap_until_applied() {
        let mut gaps = BTreeSet::new();
        let stored = took(4, &mut gaps, 5);
        assert_eq!((stored, whole(stored, &gaps)), (5, 5));
        // The service edit took 6, the next store 7; 7 arrives first.
        let stored = took(stored, &mut gaps, 7);
        assert_eq!((stored, whole(stored, &gaps)), (7, 5));
        let stored = took(stored, &mut gaps, 6);
        assert_eq!((stored, whole(stored, &gaps)), (7, 7));
        // A service edit the room loaded with already leaves no gap.
        assert_eq!(took(stored, &mut gaps, 3), 7);
        assert!(gaps.is_empty());
    }

    /// Review r2 L1: a session that never acknowledged a store, holds
    /// nothing and has no row is forgotten with its last channel, synced or
    /// not; one that acknowledged, holds deletions or has a row stays. Fails
    /// if a synced tab that closed before its ack holds `reached` for 24 h.
    #[test]
    fn a_session_that_never_acked_is_forgotten_with_its_last_channel() {
        let now = start();
        let mut sessions = Sessions::default();
        for client in [7, 8, 9, 10] {
            sessions.joined(client, "u_a", 0, now);
            sessions.synced(client);
        }
        sessions.joined(7, "u_a", 0, now);
        sessions.left(7, "u_a", now, false);
        assert!(sessions.has(7), "another channel is still open");
        sessions.left(7, "u_a", now, false);
        sessions.acked(8, "u_a", 0);
        sessions.left(8, "u_a", now, false);
        sessions.deleted(9, "u_a", ids(9, 0, 1), now);
        sessions.left(9, "u_a", now, false);
        sessions.left(10, "u_a", now, true);
        let kept: Vec<bool> = [7, 8, 9, 10].map(|client| sessions.has(client)).into();
        assert_eq!(kept, [false, true, true, true]);
    }

    /// Review r2 N3: a channel acts only on its own user's session: another
    /// user's ack, deletion, Leave or end under the id changes nothing.
    #[test]
    fn only_the_sessions_user_changes_it() {
        let now = start();
        let mut sessions = Sessions::default();
        sessions.joined(7, "u_a", 3, now);
        sessions.deleted(7, "u_a", ids(9, 0, 1), now);
        sessions.acked(7, "u_b", 1);
        assert!(!sessions.deleted(7, "u_b", ids(9, 4, 1), now));
        sessions.left(7, "u_b", now, false);
        sessions.end(7, "u_b");
        let holds = sessions.holds(now);
        assert_eq!((holds.reached, holds.held), (Some(3), ids(9, 0, 1)));
        assert_eq!(sessions.sessions[&7].channels, 1);
    }

    /// Review r2 L4: a session's held deletions are written only when they
    /// changed; an ack alone writes its version and leaves them.
    #[test]
    fn held_deletions_are_written_only_when_they_changed() {
        let now = start();
        let mut sessions = Sessions::default();
        sessions.joined(7, "u_a", 1, now);
        sessions.deleted(7, "u_a", ids(9, 0, 1), now);
        let Unsaved { rows, through, .. } = sessions.unsaved(now, |_, _| true);
        assert_eq!((rows[0].held_changed, rows[0].held.is_some()), (true, true));
        sessions.saved(through);
        sessions.acked(7, "u_a", 2);
        let Unsaved { rows, through, .. } = sessions.unsaved(now, |_, _| true);
        assert_eq!(
            (
                rows[0].version,
                rows[0].held_changed,
                rows[0].held.is_none()
            ),
            (2, false, true)
        );
        sessions.saved(through);
        sessions.end(7, "u_a");
        let rows = sessions.unsaved(now, |_, _| true).rows;
        assert_eq!((rows[0].held_changed, rows[0].held.is_none()), (true, true));
    }
}
