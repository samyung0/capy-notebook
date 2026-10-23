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

use std::collections::HashMap;

use deadpool_postgres::Pool;
use yrs::block::ClientID;
use yrs::{ReadTxn, Update, UpdateBlock};

use crate::auth::{Access, Context, RoomName};

/// Why a JOIN was refused under this rule: its id is another user's, an id
/// offered again, not the one its token offers, or one already in use. The
/// browser joins again with a fresh token (a Y.Doc not bound yet takes that
/// token's id; a bound one names its own again).
pub const REFUSED_REASON: &str = "collaboration-client-id";

/// Why an update was refused: it holds structs under an id its writer's
/// user was not assigned.
pub const FOREIGN_UPDATE: &str = "update under a client id the writer was not assigned";

/// The document whose record a room keeps: a material's content or keys
/// document, or a source file's.
enum Document {
    Material { material_id: String, keys: bool },
    Source { file_id: String },
}

/// One document's record: which user each assigned id belongs to.
pub struct ClientIds {
    document: Document,
    owners: HashMap<u64, String>,
}

impl ClientIds {
    /// The record of `name`'s document as stored.
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
        Ok(ClientIds { document, owners })
    }

    /// Whether `client` was assigned to `user`.
    pub fn owned_by(&self, client: u64, user: &str) -> bool {
        self.owners.get(&client).is_some_and(|owner| owner == user)
    }

    /// The id a JOIN binds its channel to, or why it is refused. `declared`
    /// is the Y.Doc's id from the JOIN; `taken` says whether the room's
    /// state already has structs under an id or a live channel is bound to
    /// it. An id assigned to this user binds as it is when the token offers
    /// another (a reconnect). A new id must be the token's own and free, and
    /// a writer's is stored before the channel joins; a reader's binds for
    /// the channel's life only (its awareness), since it never writes. An id
    /// offered again, even to its own user, is refused: two Y.Docs on one id
    /// would write over each other's clocks. A write token's worker id
    /// (DOCX) follows the same rule and is stored by the join that stores
    /// the session's id; a reconnect, whose session id is stored already,
    /// stores none.
    pub async fn bind(
        &mut self,
        db: &Pool,
        context: &Context,
        declared: Option<u64>,
        taken: impl Fn(u64) -> bool,
    ) -> Result<u64, String> {
        let Some(client) = declared else {
            return Err(REFUSED_REASON.into());
        };
        let offered = context.client_id.map(u64::from) == Some(client);
        match self.owners.get(&client) {
            Some(owner) if *owner == context.user_id && !offered => return Ok(client),
            Some(_) => return Err(REFUSED_REASON.into()),
            None => {}
        }
        if !offered || taken(client) {
            return Err(REFUSED_REASON.into());
        }
        if context.access == Access::Write {
            let worker = context.worker_client_id.map(u64::from);
            if worker.is_some_and(|id| self.owners.contains_key(&id) || taken(id)) {
                return Err(REFUSED_REASON.into());
            }
            let ids: Vec<u64> = [Some(client), worker].into_iter().flatten().collect();
            self.record(db, &ids, &context.user_id).await?;
        }
        Ok(client)
    }

    /// Stores `clients` as `user`'s. A row already there (another server
    /// process stored it first) refuses.
    async fn record(&mut self, db: &Pool, clients: &[u64], user: &str) -> Result<(), String> {
        let connection = db.get().await.map_err(|error| error.to_string())?;
        let ids: Vec<i64> = clients.iter().map(|&id| id as i64).collect();
        let stored = match &self.document {
            Document::Material { material_id, keys } => {
                connection
                    .execute(
                        "INSERT INTO material_yjs_client_ids (material_id, document, client_id, user_id)
                         SELECT $1, $2, unnest($3::bigint[]), $4 ON CONFLICT DO NOTHING",
                        &[material_id, &document_name(*keys), &ids, &user],
                    )
                    .await
            }
            Document::Source { file_id } => {
                connection
                    .execute(
                        "INSERT INTO source_document_client_ids (file_id, client_id, user_id)
                         SELECT $1, unnest($2::bigint[]), $3 ON CONFLICT DO NOTHING",
                        &[file_id, &ids, &user],
                    )
                    .await
            }
        }
        .map_err(|error| error.to_string())?;
        if stored != clients.len() as u64 {
            return Err(REFUSED_REASON.into());
        }
        for &client in clients {
            self.owners.insert(client, user.to_owned());
        }
        Ok(())
    }
}

/// A material document's name in the record.
fn document_name(keys: bool) -> &'static str {
    if keys { "keys" } else { "content" }
}

/// The first client id of `update` with a struct past what the room holds
/// (an item, a GC range or a skip) for which `owned` says no. Structs at
/// clocks the room holds are duplicates yrs skips; the delete set is not
/// bound (anyone editing deletes others' text).
pub fn foreign<T: ReadTxn>(txn: &T, update: &Update, owned: impl Fn(u64) -> bool) -> Option<u64> {
    let state = txn.state_vector();
    update.blocks().find_map(|block| {
        let (client, end): (ClientID, u32) = match block {
            UpdateBlock::Item(item) => (item.id().client, item.id().clock + item.len()),
            UpdateBlock::Gc(range) | UpdateBlock::Skip(range) => {
                (range.client, range.clock + range.len)
            }
        };
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
        // Bob writing at Alice's next clocks under her id is caught.
        let forger = doc(10);
        let forged = edit(&room, &forger, |d| type_at_end(d, "!"));
        assert_eq!(foreign(&room.transact(), &forged, bobs), Some(10));
        assert_eq!(foreign(&room.transact(), &forged, alices), None);
    }
}
