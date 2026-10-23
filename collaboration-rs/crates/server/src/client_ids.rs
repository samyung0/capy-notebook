//! Yjs client ids the server assigned (Epo 2026-10-23, Q213). Every
//! collaboration token offers a fresh id (`clientId`, minted by Go). A Y.Doc
//! takes the id of its first token joined with write access and keeps it for
//! life, naming it in every JOIN. The room remembers which user each id was
//! assigned to: a write JOIN with a new id stores it (one row per new Y.Doc,
//! keyed by document and id), and the room keeps the record in memory from
//! its load on, so reconnects and update checks read no database. It admits
//! an update's structs past what the room holds only under ids of the
//! writer's user (any of them: stored drafts of earlier sessions too). The
//! server's own writes (markers, agent edits, repairs, Undo, children passes)
//! go under the room's client and never through admission. A DOCX editing
//! session is offered a second id for its editor's resident layout worker
//! (`workerClientId`, Q219), stored by the same join.

use std::collections::{HashMap, HashSet};

use deadpool_postgres::Pool;
use yrs::block::ClientID;
use yrs::{ReadTxn, Update, UpdateBlock};

use crate::auth::{Access, Context, RoomName};

/// Why a JOIN was refused under this rule: its id is another user's, an id
/// offered again, one already in use or being stored. The browser joins
/// again with a fresh token (a Y.Doc not bound yet takes that token's id; a
/// bound one names its own again).
pub const REFUSED_REASON: &str = "collaboration-client-id";

/// Why a JOIN was refused: its id is not the one its token offers and the
/// room holds it for no user (never assigned, or a bound Y.Doc whose row was
/// cleared). No retry binds it: the browser does not retry, and its edits
/// under the id are re-applied under an assigned one (Epo 2026-10-24).
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

/// One document's record: which user each assigned id belongs to, and the
/// ids whose store is still running (reserved: no one else may take them).
pub struct ClientIds {
    document: Document,
    owners: HashMap<u64, String>,
    pending: HashSet<u64>,
    /// Ids whose last write this room's life has recorded (M3).
    touched: HashSet<u64>,
}

/// Rows whose last write time a room's first write under them refreshes
/// (M3), off the room's task.
pub struct Touch {
    ids: Vec<i64>,
    user: String,
    document: Document,
}

impl Touch {
    pub async fn run(&self, db: &Pool) -> Result<(), String> {
        let connection = db.get().await.map_err(|error| error.to_string())?;
        match &self.document {
            Document::Material { material_id, keys } => {
                connection
                    .execute(
                        "UPDATE material_yjs_client_ids SET last_write_at=now()
                         WHERE material_id=$1 AND document=$2 AND client_id=ANY($3) AND user_id=$4",
                        &[material_id, &document_name(*keys), &self.ids, &self.user],
                    )
                    .await
            }
            Document::Source { file_id } => {
                connection
                    .execute(
                        "UPDATE source_document_client_ids SET last_write_at=now()
                         WHERE file_id=$1 AND client_id=ANY($2) AND user_id=$3",
                        &[file_id, &self.ids, &self.user],
                    )
                    .await
            }
        }
        .map(|_| ())
        .map_err(|error| error.to_string())
    }
}

/// What a JOIN's id check decided.
pub enum Binding {
    /// Bound as it is: a reconnect of a stored id, or a reader's id, which
    /// is never stored.
    Bound(u64),
    /// New ids to store as the user's before the channel joins.
    Store(Store),
}

/// Ids to store as one user's, off the room's task (a slow database stalls
/// only the channel waiting on them). Reserved in the record until
/// [ClientIds::stored] settles them.
pub struct Store {
    pub client: u64,
    ids: Vec<u64>,
    user: String,
    document: Document,
}

impl Store {
    /// Stores the ids in one insert. A row already there (another server
    /// process stored it first) refuses.
    pub async fn run(&self, db: &Pool) -> Result<(), String> {
        let connection = db.get().await.map_err(|error| error.to_string())?;
        let ids: Vec<i64> = self.ids.iter().map(|&id| id as i64).collect();
        let stored = match &self.document {
            Document::Material { material_id, keys } => {
                connection
                    .execute(
                        "INSERT INTO material_yjs_client_ids (material_id, document, client_id, user_id)
                         SELECT $1, $2, unnest($3::bigint[]), $4 ON CONFLICT DO NOTHING",
                        &[material_id, &document_name(*keys), &ids, &self.user],
                    )
                    .await
            }
            Document::Source { file_id } => {
                connection
                    .execute(
                        "INSERT INTO source_document_client_ids (file_id, client_id, user_id)
                         SELECT $1, unnest($2::bigint[]), $3 ON CONFLICT DO NOTHING",
                        &[file_id, &ids, &self.user],
                    )
                    .await
            }
        }
        .map_err(|error| error.to_string())?;
        if stored != self.ids.len() as u64 {
            return Err(REFUSED_REASON.into());
        }
        Ok(())
    }
}

impl ClientIds {
    /// The record of `name`'s document as stored, after clearing its rows
    /// unwritten for 7 days (M3: one scan per room load, no scheduled job;
    /// an id stays out of reach once in the document's history).
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
                         AND last_write_at < now() - make_interval(days => $3)",
                        &[material_id, &document_name(*keys), &UNUSED_DAYS],
                    )
                    .await
            }
            Document::Source { file_id } => {
                client
                    .execute(
                        "DELETE FROM source_document_client_ids WHERE file_id=$1
                         AND last_write_at < now() - make_interval(days => $2)",
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
            pending: HashSet::new(),
            touched: HashSet::new(),
        })
    }

    /// Every id assigned to a user, for the server's own id draws (Q226).
    pub fn ids(&self) -> HashSet<u64> {
        self.owners.keys().chain(&self.pending).copied().collect()
    }

    /// Whether `client` was assigned to `user`.
    pub fn owned_by(&self, client: u64, user: &str) -> bool {
        self.owners.get(&client).is_some_and(|owner| owner == user)
    }

    /// Whether `client` is assigned to anyone, or being stored: the server
    /// never writes under it.
    pub fn assigned(&self, client: u64) -> bool {
        self.owners.contains_key(&client) || self.pending.contains(&client)
    }

    /// The id a JOIN binds its channel to, or why it is refused. `declared`
    /// is the Y.Doc's id from the JOIN; `taken` says whether the room's
    /// state already has structs under an id, a live channel is bound to it,
    /// or it is the room's own. An id assigned to this user binds as it is
    /// when the token offers another (a reconnect). A new id must be the
    /// token's own and free; a writer's is stored before the channel joins
    /// ([Binding::Store]), a reader's binds for the channel's life only (its
    /// awareness), since it never writes. An id offered again, even to its
    /// own user, is refused: two Y.Docs on one id would write over each
    /// other's clocks. A write token's worker id (DOCX) follows the same
    /// rule and is stored with the session's id; a reconnect, whose session
    /// id is stored already, stores none.
    pub fn bind(
        &mut self,
        context: &Context,
        declared: Option<u64>,
        taken: impl Fn(u64) -> bool,
    ) -> Result<Binding, String> {
        let Some(client) = declared else {
            return Err(REFUSED_REASON.into());
        };
        let offered = context.client_id.map(u64::from) == Some(client);
        match self.owners.get(&client) {
            Some(owner) if *owner == context.user_id && !offered => {
                return Ok(Binding::Bound(client));
            }
            Some(_) => return Err(REFUSED_REASON.into()),
            None => {}
        }
        if self.pending.contains(&client) {
            return Err(REFUSED_REASON.into());
        }
        if !offered {
            return Err(UNASSIGNED_REASON.into());
        }
        if taken(client) {
            return Err(REFUSED_REASON.into());
        }
        if context.access != Access::Write {
            return Ok(Binding::Bound(client));
        }
        self.reserve(client, context, taken).map(Binding::Store)
    }

    /// The store a channel whose token turned writable needs: its bound id
    /// (and a DOCX token's worker id) stored as a writable JOIN stores them,
    /// or none when the id is the user's already. Refused when another user
    /// holds it.
    pub fn upgrade(
        &mut self,
        client: u64,
        context: &Context,
        taken: impl Fn(u64) -> bool,
    ) -> Result<Option<Store>, String> {
        match self.owners.get(&client) {
            Some(owner) if *owner == context.user_id => return Ok(None),
            Some(_) => return Err(REFUSED_REASON.into()),
            None if self.pending.contains(&client) => return Err(REFUSED_REASON.into()),
            None => {}
        }
        self.reserve(client, context, taken).map(Some)
    }

    /// Reserves `client` and the token's worker id for `context`'s user.
    fn reserve(
        &mut self,
        client: u64,
        context: &Context,
        taken: impl Fn(u64) -> bool,
    ) -> Result<Store, String> {
        let worker = context.worker_client_id.map(u64::from);
        if worker.is_some_and(|id| self.assigned(id) || taken(id)) {
            return Err(REFUSED_REASON.into());
        }
        let ids: Vec<u64> = [Some(client), worker].into_iter().flatten().collect();
        self.pending.extend(&ids);
        Ok(Store {
            client,
            ids,
            user: context.user_id.clone(),
            document: self.document.clone(),
        })
    }

    /// The rows of `written` (ids `user` just wrote under) whose last write
    /// this room's life has not recorded yet; marks them.
    pub fn first_writes(&mut self, user: &str, written: &[u64]) -> Option<Touch> {
        let ids: Vec<i64> = written
            .iter()
            .filter(|&&id| self.owned_by(id, user) && self.touched.insert(id))
            .map(|&id| id as i64)
            .collect();
        (!ids.is_empty()).then(|| Touch {
            ids,
            user: user.to_owned(),
            document: self.document.clone(),
        })
    }

    /// Settles a store: its ids are the user's once it committed, and free
    /// again when it failed.
    pub fn stored(&mut self, store: &Store, result: &Result<(), String>) {
        for id in &store.ids {
            self.pending.remove(id);
            if result.is_ok() {
                self.owners.insert(*id, store.user.clone());
            }
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
