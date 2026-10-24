//! Yjs client ids the server assigned (Epo 2026-10-23, Q213; Q236). Every
//! collaboration token offers an id (`clientId`, minted by Go): a fresh one,
//! or the id of the session's previous token, which a reconnect presents to
//! keep its id. A JOIN binds its channel to the id its Y.Doc names, in
//! memory, and the room records the id as its user's at the first accepted
//! write under it (one row per id, keyed by document), keeping the record in
//! memory from its load on, so reconnects and update checks read no
//! database. It admits an update's structs past what the room holds only
//! under ids of the writer's user: any recorded one (stored drafts of
//! earlier sessions too) or one bound to a live channel of the user. The
//! server's own writes (markers, agent edits, repairs, Undo, children passes)
//! go under the room's client and never through admission. A DOCX editing
//! session is offered a second id for its editor's resident layout worker
//! (`workerClientId`, Q219), bound and recorded the same way.

use std::collections::{HashMap, HashSet};

use deadpool_postgres::Pool;
use yrs::block::ClientID;
use yrs::{ReadTxn, Update, UpdateBlock};

use crate::auth::{Context, RoomName};

/// Why a JOIN was refused under this rule: a live channel holds its id. The
/// browser joins again with a fresh token, without its previous one (a Y.Doc
/// that never wrote takes the fresh token's id; one that wrote names its own
/// again and, the id still not its user's, hears [UNASSIGNED_REASON]).
pub const REFUSED_REASON: &str = "collaboration-client-id";

/// Why a JOIN was refused: the room does not hold its id for the joiner's
/// user: recorded to another user, or unrecorded and either not the one its
/// token offers (never assigned, or a row that was cleared) or with structs
/// in the document's history.
/// No retry binds it: the browser does not retry, and its edits under the
/// id are re-applied under an assigned one (Epo 2026-10-24).
pub const UNASSIGNED_REASON: &str = "collaboration-unassigned-id";

/// Client ids reserved for derived override-seed copies (Epo 2026-10-24,
/// M5): at or above 2^32 and below the PPTX bootstrap id (2^53 - 1). No
/// session is assigned one (session ids are u32); only a source room admits
/// them, from members who may edit the file.
pub const RESERVED: std::ops::Range<u64> = (1 << 32)..((1 << 53) - 1);

/// How long a row may go unwritten before a room load clears it (M3).
const UNUSED_DAYS: i32 = 7;

/// Why an update was refused: it holds structs under an id its writer's
/// user was not assigned.
pub const FOREIGN_UPDATE: &str = "update under a client id the writer was not assigned";

/// The document whose record a room keeps: a material's content or keys
/// document, or a source file's.
#[derive(Clone)]
enum Document {
    Material { material_id: String, keys: bool },
    Source { file_id: String },
}

/// One document's record: which user each recorded id belongs to, and the
/// ids whose last write this room's life has recorded.
pub struct ClientIds {
    document: Document,
    owners: HashMap<u64, String>,
    written: HashSet<u64>,
}

/// The ids a JOIN binds its channel to: its session's and, on a DOCX write
/// token, its layout worker's.
pub struct Bound {
    pub client: u64,
    pub worker: Option<u64>,
}

/// Rows to write off the room's task (a slow database stalls no channel).
pub struct Rows {
    ids: Vec<i64>,
    user: String,
    document: Document,
    change: Change,
}

enum Change {
    /// A first accepted write in this room's life: the row is recorded, or
    /// its last write time refreshed (M3).
    Written,
    /// A clean Leave: the row expires, and the next room load clears it.
    Expired,
}

impl Rows {
    pub async fn run(&self, db: &Pool) -> Result<(), String> {
        let connection = db.get().await.map_err(|error| error.to_string())?;
        let changed = match (&self.document, &self.change) {
            (Document::Material { material_id, keys }, Change::Written) => {
                connection
                    .execute(
                        "INSERT INTO material_yjs_client_ids (material_id, document, client_id, user_id)
                         SELECT $1, $2, unnest($3::bigint[]), $4
                         ON CONFLICT (material_id, document, client_id) DO UPDATE
                         SET last_write_at=now(), expired=false
                         WHERE material_yjs_client_ids.user_id=EXCLUDED.user_id",
                        &[material_id, &document_name(*keys), &self.ids, &self.user],
                    )
                    .await
            }
            (Document::Source { file_id }, Change::Written) => {
                connection
                    .execute(
                        "INSERT INTO source_document_client_ids (file_id, client_id, user_id)
                         SELECT $1, unnest($2::bigint[]), $3
                         ON CONFLICT (file_id, client_id) DO UPDATE
                         SET last_write_at=now(), expired=false
                         WHERE source_document_client_ids.user_id=EXCLUDED.user_id",
                        &[file_id, &self.ids, &self.user],
                    )
                    .await
            }
            (Document::Material { material_id, keys }, Change::Expired) => {
                connection
                    .execute(
                        "UPDATE material_yjs_client_ids SET expired=true
                         WHERE material_id=$1 AND document=$2 AND client_id=ANY($3) AND user_id=$4",
                        &[material_id, &document_name(*keys), &self.ids, &self.user],
                    )
                    .await
            }
            (Document::Source { file_id }, Change::Expired) => {
                connection
                    .execute(
                        "UPDATE source_document_client_ids SET expired=true
                         WHERE file_id=$1 AND client_id=ANY($2) AND user_id=$3",
                        &[file_id, &self.ids, &self.user],
                    )
                    .await
            }
        }
        .map_err(|error| error.to_string())?;
        // A written id's row is another user's only if another server
        // process recorded it first.
        if matches!(self.change, Change::Written) && changed != self.ids.len() as u64 {
            return Err("a client id's row belongs to another user".into());
        }
        Ok(())
    }
}

impl ClientIds {
    /// The record of `name`'s document as stored, after clearing its rows
    /// expired by a clean Leave or unwritten for 7 days (M3: one scan per
    /// room load, no scheduled job; an id stays out of reach once in the
    /// document's history).
    pub async fn load(db: &Pool, name: &RoomName) -> Result<Self, String> {
        let document = match name {
            RoomName::Material {
                material_id, keys, ..
            } => Document::Material {
                material_id: material_id.clone(),
                keys: *keys,
            },
            RoomName::Source { file_id, .. } => Document::Source {
                file_id: file_id.clone(),
            },
        };
        let client = db.get().await.map_err(|error| error.to_string())?;
        match &document {
            Document::Material { material_id, keys } => {
                client
                    .execute(
                        "DELETE FROM material_yjs_client_ids WHERE material_id=$1 AND document=$2
                         AND (expired OR last_write_at < now() - make_interval(days => $3))",
                        &[material_id, &document_name(*keys), &UNUSED_DAYS],
                    )
                    .await
            }
            Document::Source { file_id } => {
                client
                    .execute(
                        "DELETE FROM source_document_client_ids WHERE file_id=$1
                         AND (expired OR last_write_at < now() - make_interval(days => $2))",
                        &[file_id, &UNUSED_DAYS],
                    )
                    .await
            }
        }
        .map_err(|error| error.to_string())?;
        let rows = match &document {
            Document::Material { material_id, keys } => {
                client
                    .query(
                        "SELECT client_id, user_id FROM material_yjs_client_ids
                         WHERE material_id=$1 AND document=$2",
                        &[material_id, &document_name(*keys)],
                    )
                    .await
            }
            Document::Source { file_id } => client
                .query(
                    "SELECT client_id, user_id FROM source_document_client_ids WHERE file_id=$1",
                    &[file_id],
                )
                .await,
        }
        .map_err(|error| error.to_string())?;
        let owners = rows
            .iter()
            .map(|row| (row.get::<_, i64>(0) as u64, row.get::<_, String>(1)))
            .collect();
        Ok(ClientIds {
            document,
            owners,
            written: HashSet::new(),
        })
    }

    /// Every id recorded to a user, for the server's own id draws (Q226).
    pub fn ids(&self) -> HashSet<u64> {
        self.owners.keys().copied().collect()
    }

    /// Whether `client` is recorded to `user`.
    pub fn owned_by(&self, client: u64, user: &str) -> bool {
        self.owners.get(&client).is_some_and(|owner| owner == user)
    }

    /// The ids a JOIN binds its channel to, or why it is refused. `declared`
    /// is the Y.Doc's id from the JOIN; `history` says whether the room's
    /// state already has structs under an id, `live` whether a live channel
    /// is bound to it or it is the room's own. An id recorded to this user
    /// binds as it is (a reconnect, whichever id its token offers); one
    /// recorded to another user is not this user's (unassigned). An
    /// unrecorded id must be the one its token offers (fresh, or the previous
    /// token's again, Q236), outside the history (else the room no longer
    /// holds it: unassigned) and not live (two channels never share an
    /// unrecorded id). A DOCX write token's worker id binds by the same rule.
    /// Nothing is recorded until a write under the id is accepted.
    pub fn bind(
        &self,
        context: &Context,
        declared: Option<u64>,
        history: impl Fn(u64) -> bool,
        live: impl Fn(u64) -> bool,
    ) -> Result<Bound, String> {
        let Some(client) = declared else {
            return Err(REFUSED_REASON.into());
        };
        let offered = context.client_id.map(u64::from) == Some(client);
        let worker = context.worker_client_id.map(u64::from);
        let check = |id: u64, offered: bool| match self.owners.get(&id) {
            Some(owner) if *owner == context.user_id => Ok(()),
            Some(_) => Err(UNASSIGNED_REASON),
            None if !offered || history(id) => Err(UNASSIGNED_REASON),
            None if live(id) => Err(REFUSED_REASON),
            None => Ok(()),
        };
        check(client, offered)
            .and_then(|()| worker.map_or(Ok(()), |id| check(id, true)))
            .map_err(String::from)?;
        Ok(Bound { client, worker })
    }

    /// The rows of `written` (ids just written under, each recorded to the
    /// writer's user or bound to one of its channels) that this room's life
    /// has not recorded a write under yet: recorded as `user`'s, in memory
    /// now and in the database off the room's task. Reserved copy ids are
    /// never recorded.
    pub fn first_writes(&mut self, user: &str, written: &[u64]) -> Option<Rows> {
        let mut ids = Vec::new();
        for &id in written {
            if !RESERVED.contains(&id) && self.written.insert(id) {
                self.owners.insert(id, user.to_owned());
                ids.push(id as i64);
            }
        }
        (!ids.is_empty()).then(|| self.rows(ids, user, Change::Written))
    }

    /// A clean Leave (the tab holds no unsent edits for the document): the
    /// channel's ids recorded to `user` expire, so a later JOIN naming them
    /// is refused (they are in the document's history) and the next room
    /// load clears their rows.
    pub fn left_clean(&mut self, user: &str, ids: &[u64]) -> Option<Rows> {
        let mut expired = Vec::new();
        for &id in ids {
            if self.owned_by(id, user) {
                self.owners.remove(&id);
                self.written.remove(&id);
                expired.push(id as i64);
            }
        }
        (!expired.is_empty()).then(|| self.rows(expired, user, Change::Expired))
    }

    fn rows(&self, ids: Vec<i64>, user: &str, change: Change) -> Rows {
        Rows {
            ids,
            user: user.to_owned(),
            document: self.document.clone(),
            change,
        }
    }
}

/// A material document's name in the record.
fn document_name(keys: bool) -> &'static str {
    if keys { "keys" } else { "content" }
}

/// The client ids of `update` with a struct past what the room holds: the
/// ids it writes under.
pub fn written<T: ReadTxn>(txn: &T, update: &Update) -> Vec<u64> {
    let state = txn.state_vector();
    let mut ids: Vec<u64> = update
        .blocks()
        .filter_map(|block| {
            let (client, end) = block_end(&block);
            (end > state.get(&client)).then(|| client.get())
        })
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn block_end(block: &UpdateBlock) -> (ClientID, u32) {
    match block {
        UpdateBlock::Item(item) => (item.id().client, item.id().clock + item.len()),
        UpdateBlock::Gc(range) | UpdateBlock::Skip(range) => {
            (range.client, range.clock + range.len)
        }
    }
}

/// The first client id of `update` with a struct past what the room holds
/// (an item, a GC range or a skip) for which `owned` says no. Structs at
/// clocks the room holds are duplicates yrs skips; the delete set is not
/// bound (anyone editing deletes others' text).
pub fn foreign<T: ReadTxn>(txn: &T, update: &Update, owned: impl Fn(u64) -> bool) -> Option<u64> {
    let state = txn.state_vector();
    update.blocks().find_map(|block| {
        let (client, end) = block_end(&block);
        (end > state.get(&client) && !owned(client.get())).then(|| client.get())
    })
}

#[cfg(test)]
mod tests {
    use yrs::{Doc, GetString, Text, Transact};

    use super::*;

    fn doc(client: u64) -> Doc {
        Doc::with_options(ydoc::doc_options(client))
    }

    fn sync(from: &Doc, to: &Doc) {
        let update = from
            .transact()
            .encode_state_as_update_v1(&to.transact().state_vector());
        to.transact_mut()
            .apply_update(ydoc::decode(&update).unwrap())
            .unwrap();
    }

    /// `doc`'s edit as an update over `room`'s state.
    fn edit(room: &Doc, doc: &Doc, change: impl FnOnce(&Doc)) -> Update {
        sync(room, doc);
        let before = room.transact().state_vector();
        change(doc);
        ydoc::decode(&doc.transact().encode_state_as_update_v1(&before)).unwrap()
    }

    fn type_at_end(doc: &Doc, text: &str) {
        let root = doc.get_or_insert_text("content");
        let mut txn = doc.transact_mut();
        let len = root.get_string(&txn).encode_utf16().count() as u32;
        root.insert(&mut txn, len, text);
    }

    /// Security regression (Q213, Epo 2026-10-23): structs past what the
    /// room holds pass only under the writer's own ids; ones the room holds
    /// (duplicates) and deletions of others' text pass. Fails if any client
    /// id is admitted.
    #[test]
    fn only_the_writers_ids_may_add_structs() {
        let room = doc(1);
        let (alice, bob) = (doc(10), doc(20));
        let typed = edit(&room, &alice, |d| type_at_end(d, "alice"));
        room.transact_mut().apply_update(typed).unwrap();
        let alices = |id: u64| id == 10;
        let bobs = |id: u64| id == 20;
        // Bob types under his own id, with Alice's held structs alongside.
        let update = edit(&room, &bob, |d| type_at_end(d, " bob"));
        assert_eq!(foreign(&room.transact(), &update, bobs), None);
        let state = bob
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        assert_eq!(
            foreign(&room.transact(), &ydoc::decode(&state).unwrap(), bobs),
            None
        );
        // Alice relaying Bob's structs the room does not hold is refused;
        // once the room holds them they are duplicates.
        assert_eq!(
            foreign(&room.transact(), &ydoc::decode(&state).unwrap(), alices),
            Some(20)
        );
        room.transact_mut().apply_update(update).unwrap();
        assert_eq!(
            foreign(&room.transact(), &ydoc::decode(&state).unwrap(), alices),
            None
        );
        // Bob deletes Alice's text: deletions are not bound.
        let deleted = edit(&room, &bob, |d| {
            d.get_or_insert_text("content")
                .remove_range(&mut d.transact_mut(), 0, 5);
        });
        assert_eq!(foreign(&room.transact(), &deleted, bobs), None);
        // An update under Alice's id is hers alone.
        let forger = doc(10);
        let forged = edit(&room, &forger, |d| type_at_end(d, "!"));
        assert_eq!(foreign(&room.transact(), &forged, bobs), Some(10));
        assert_eq!(foreign(&room.transact(), &forged, alices), None);
    }
}
