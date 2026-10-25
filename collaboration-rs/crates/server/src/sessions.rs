//! A note room's editing sessions (in-place collection, step 1: the
//! bookkeeping; Epo 2026-10-23). A session is one Y.Doc, named by its client
//! id (`client_ids.rs`), and its Undo stack lives exactly as long. The room
//! counts a session at the stored version it last acknowledged (`ack`) or
//! named in its JOIN, and holds the deletions its own updates added: what an
//! Undo of it may restore, each released 25 h after it arrived, since editors'
//! Undo reaches back at most 24 h. A session counts while connected and for
//! 24 h after it was last seen; it ends earlier on a clean Leave naming it.
//! A later fold reads what must stay from here ([Sessions::holds]): the
//! oldest version every counted session reached and their held deletions.
//! Notes only (Q274): item rooms keep their whole history.

use std::collections::HashMap;
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
/// Deletions arriving within this of a batch's first join it, stamped with
/// the latest arrival, so a session keeps at most one batch a minute.
const BATCH: Duration = Duration::from_secs(60);

/// What a fold's collection must keep for the room's sessions.
#[derive(Debug, PartialEq)]
pub struct Holds {
    /// The oldest stored version every counted session reached; none when
    /// no session counts.
    pub reached: Option<i64>,
    /// Every counted session's held deletions.
    pub held: IdSet,
}

/// Deletions that arrived together, released once `at` is HELD_FOR old.
#[derive(Clone, Debug, PartialEq)]
struct Batch {
    started: SystemTime,
    at: SystemTime,
    ids: IdSet,
}

#[derive(Debug)]
struct Session {
    user: String,
    version: i64,
    channels: u32,
    seen: SystemTime,
    held: Vec<Batch>,
    ended: bool,
    /// The change count at its last change (see [Sessions::unsaved]).
    changed: u64,
}

impl Session {
    fn counts(&self, now: SystemTime) -> bool {
        !self.ended && (self.channels > 0 || since(self.seen, now) < COUNTED_FOR)
    }
}

/// A session as its row stores it; `seen` none: it ended (the row's session
/// columns are cleared).
#[derive(Debug, PartialEq)]
pub struct Row {
    pub client: i64,
    pub user: String,
    pub version: i64,
    pub seen: Option<SystemTime>,
    pub held: Option<Vec<u8>>,
}

#[derive(Debug, Default)]
pub struct Sessions {
    sessions: HashMap<u64, Session>,
    changes: u64,
    saved: u64,
}

fn since(then: SystemTime, now: SystemTime) -> Duration {
    now.duration_since(then).unwrap_or_default()
}

/// Whether a JOIN or a draft group naming `version` is older than the
/// latest collection's window (`window`, 0 before any): it missed what that
/// collection discarded. Version 0 is a new session holding nothing.
pub fn late(window: i64, version: u64) -> bool {
    version > 0 && i64::try_from(version).is_ok_and(|version| version < window)
}

impl Sessions {
    /// Sessions as their rows stored them (those seen within the cap).
    pub fn load(
        rows: impl IntoIterator<Item = (u64, String, i64, SystemTime, Option<Vec<u8>>)>,
    ) -> Result<Self, String> {
        let mut sessions = HashMap::new();
        for (client, user, version, seen, held) in rows {
            let held = match held {
                Some(bytes) => decode_held(&bytes)
                    .ok_or_else(|| format!("session {client}: unreadable held deletions"))?,
                None => Vec::new(),
            };
            sessions.insert(
                client,
                Session {
                    user,
                    version,
                    channels: 0,
                    seen,
                    held,
                    ended: false,
                    changed: 0,
                },
            );
        }
        Ok(Sessions {
            sessions,
            changes: 0,
            saved: 0,
        })
    }

    fn change(&mut self, client: u64) -> Option<&mut Session> {
        self.changes += 1;
        let changes = self.changes;
        let session = self.sessions.get_mut(&client)?;
        session.changed = changes;
        Some(session)
    }

    /// A channel joined under `client` naming `version` (its JOIN's).
    pub fn joined(&mut self, client: u64, user: &str, version: i64, now: SystemTime) {
        let fresh = Session {
            user: user.to_owned(),
            version,
            channels: 0,
            seen: now,
            held: Vec::new(),
            ended: false,
            changed: 0,
        };
        let session = self.sessions.entry(client).or_insert(fresh);
        if session.ended || session.user != user {
            session.user = user.to_owned();
            session.held.clear();
            session.ended = false;
            session.channels = 0;
        }
        if let Some(session) = self.change(client) {
            session.version = version;
            session.channels += 1;
            session.seen = now;
        }
    }

    /// One of its channels went (a drop, a Leave with unsent edits).
    pub fn left(&mut self, client: u64, now: SystemTime) {
        if self.sessions.get(&client).is_some_and(|s| !s.ended)
            && let Some(session) = self.change(client)
        {
            session.channels = session.channels.saturating_sub(1);
            session.seen = now;
        }
    }

    /// A clean Leave naming the session: it ends, its deletions released.
    pub fn end(&mut self, client: u64) {
        if let Some(session) = self.change(client) {
            session.ended = true;
            session.channels = 0;
            session.held.clear();
        }
    }

    /// The session acknowledged a store at `version`.
    pub fn acked(&mut self, client: u64, version: i64) {
        if self.sessions.get(&client).is_some_and(|s| !s.ended)
            && let Some(session) = self.change(client)
        {
            session.version = version;
        }
    }

    /// The session's update deleted `ids`, which the room held undeleted:
    /// whether it holds them (none: no such session, or nothing deleted).
    pub fn deleted(&mut self, client: u64, ids: IdSet, now: SystemTime) -> bool {
        if ids.is_empty() || self.sessions.get(&client).is_none_or(|s| s.ended) {
            return false;
        }
        let Some(session) = self.change(client) else {
            return false;
        };
        match session.held.last_mut() {
            Some(batch) if since(batch.started, now) < BATCH => {
                batch.ids.merge_with(ids);
                batch.at = batch.at.max(now);
            }
            _ => session.held.push(Batch {
                started: now,
                at: now,
                ids,
            }),
        }
        true
    }

    /// Sessions past the cap end and deletions past HELD_FOR go.
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
            self.change(client);
        }
    }

    /// What a fold must keep now: the oldest version every counted session
    /// reached, and their held deletions.
    pub fn holds(&mut self, now: SystemTime) -> Holds {
        self.expire(now);
        let mut reached = None;
        let mut held = IdSet::new();
        for session in self.sessions.values().filter(|s| s.counts(now)) {
            reached = Some(reached.map_or(session.version, |r: i64| r.min(session.version)));
            for batch in &session.held {
                held.merge_with(batch.ids.clone());
            }
        }
        Holds { reached, held }
    }

    /// The rows of sessions changed since the last save that `recorded`
    /// says have a row (an accepted write recorded their id to their user),
    /// and the change count they reach: a store writes them in its
    /// transaction, so a held deletion is durable with the state holding it.
    pub fn unsaved(
        &mut self,
        now: SystemTime,
        recorded: impl Fn(u64, &str) -> bool,
    ) -> (Vec<Row>, u64) {
        self.expire(now);
        let rows = self
            .sessions
            .iter()
            .filter(|&(&client, s)| s.changed > self.saved && recorded(client, &s.user))
            .map(|(&client, s)| Row {
                client: client as i64,
                user: s.user.clone(),
                version: s.version,
                seen: (!s.ended).then_some(if s.channels > 0 { now } else { s.seen }),
                held: (!s.ended && !s.held.is_empty()).then(|| encode_held(&s.held)),
            })
            .collect();
        (rows, self.changes)
    }

    /// The rows up to change `through` were written: ended sessions go.
    pub fn saved(&mut self, through: u64) {
        self.saved = self.saved.max(through);
        let saved = self.saved;
        self.sessions
            .retain(|_, session| !(session.ended && session.changed <= saved));
    }
}

fn unix(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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
        sessions.acked(8, 5);
        assert_eq!(sessions.holds(now).reached, Some(3));
        sessions.acked(7, 6);
        assert_eq!(sessions.holds(now).reached, Some(5));
        sessions.left(8, now);
        assert_eq!(sessions.holds(now + 23 * HOUR).reached, Some(5));
        assert_eq!(sessions.holds(now + 24 * HOUR).reached, Some(6));
        // Ended at the cap: back within it, it is not counted again.
        assert_eq!(sessions.holds(now + 23 * HOUR).reached, Some(6));
        sessions.end(7);
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
        sessions.deleted(7, ids(9, 0, 2), now);
        sessions.deleted(7, ids(9, 5, 1), now + Duration::from_secs(30));
        sessions.deleted(7, ids(9, 10, 1), now + 2 * HOUR);
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
        sessions.deleted(7, ids(9, 0, 1), now);
        let recorded = |client: u64, _: &str| client == 7;
        let (rows, through) = sessions.unsaved(now, recorded);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].client, rows[0].seen), (7, Some(now)));
        let held = decode_held(rows[0].held.as_ref().unwrap()).unwrap();
        assert_eq!(held[0].ids, ids(9, 0, 1));
        // A change while the store ran is written by the next one.
        sessions.acked(7, 2);
        sessions.saved(through);
        let (rows, through) = sessions.unsaved(now, recorded);
        assert_eq!(rows.iter().map(|r| r.version).collect::<Vec<_>>(), [2]);
        sessions.saved(through);
        assert!(sessions.unsaved(now, recorded).0.is_empty());
        sessions.end(7);
        let (rows, through) = sessions.unsaved(now, recorded);
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
        sessions.deleted(7, ids(9, 0, 1), now);
        sessions.joined(8, "u_b", 1, now);
        sessions.left(8, now);
        assert_eq!(sessions.holds(now).reached, Some(1));
        let (rows, _) = sessions.unsaved(now, |client, _| client == 7);
        let mut next = Sessions::load(rows.into_iter().map(|row| {
            let seen = row.seen.expect("a live session");
            (row.client as u64, row.user, row.version, seen, row.held)
        }))
        .unwrap();
        let holds = next.holds(now);
        assert_eq!((holds.reached, holds.held), (Some(2), ids(9, 0, 1)));
        assert!(late(2, 1));
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
        assert!(Sessions::load([(7, "u".into(), 1, now, Some(vec![9]))]).is_err());
    }

    /// Late detection: a version below the latest collection's window is
    /// late, a new session (0) never is, and nothing is late before any
    /// collection (window 0).
    #[test]
    fn a_version_below_the_window_is_late() {
        assert!(!late(0, 1));
        assert!(!late(5, 0));
        assert!(late(5, 4));
        assert!(!late(5, 5));
        assert!(!late(5, u64::MAX));
    }
}
