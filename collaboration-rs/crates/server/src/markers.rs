//! Contributor markers (`collaboration/src/contributors.ts`, DESIGN.md 2):
//! server-owned entries in `__capy_pending_contributors` naming every writer
//! whose update no committed store holds yet. Written once per writer per
//! store window: a writer gets a fresh marker only when it has none or a
//! store snapshot has claimed the one it has.

use std::collections::{HashMap, HashSet};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use yrs::block::{ClientID, UpdateParent};
use yrs::{Any, Doc, ID, Map, MapRef, Out, ReadTxn, Transact, Update, UpdateBlock};

use crate::auth::Context;

const MAX_KEY_BYTES: usize = 512;
const MAX_NONCE_BYTES: usize = 128;
const MAX_USER_ID_BYTES: usize = 255;

/// One marker as a store snapshot reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Contributor {
    pub key: String,
    pub nonce: String,
    pub user_id: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MarkerError {
    #[error("invalid collaboration contributor marker")]
    Invalid,
    #[error("client update changed collaboration metadata")]
    Changed,
}

fn root(doc: &Doc) -> MapRef {
    doc.get_or_insert_map(ydoc::CONTRIBUTORS_ROOT)
}

/// A marker's value, validated as `contributorValue` does.
fn contributor(key: &str, value: &Out) -> Result<Contributor, MarkerError> {
    if key.is_empty() || key.len() > MAX_KEY_BYTES {
        return Err(MarkerError::Invalid);
    }
    let Out::Any(Any::Map(map)) = value else {
        return Err(MarkerError::Invalid);
    };
    let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let text = |name: &str| match map.get(name) {
        Some(Any::String(value)) => Some(value.to_string()),
        _ => None,
    };
    let (Some(access), Some(nonce), Some(user_id)) =
        (text("access"), text("nonce"), text("userId"))
    else {
        return Err(MarkerError::Invalid);
    };
    if keys != ["access", "nonce", "userId"]
        || access != "write"
        || nonce.is_empty()
        || nonce.len() > MAX_NONCE_BYTES
        || user_id.is_empty()
        || user_id.len() > MAX_USER_ID_BYTES
    {
        return Err(MarkerError::Invalid);
    }
    Ok(Contributor {
        key: key.to_owned(),
        nonce,
        user_id,
    })
}

/// Every live marker, sorted by key (`documentContributors`).
pub fn contributors(doc: &Doc) -> Result<Vec<Contributor>, MarkerError> {
    let map = root(doc);
    let txn = doc.transact();
    let mut out = map
        .iter(&txn)
        .map(|(key, value)| contributor(key, &value))
        .collect::<Result<Vec<_>, _>>()?;
    out.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(out)
}

/// Whether the room holds a writer's update no store has committed.
pub fn pending(doc: &Doc) -> bool {
    root(doc).len(&doc.transact()) > 0
}

/// The items of the live markers, which a stored row carries deleted.
pub fn live_items(doc: &Doc) -> Vec<ID> {
    let txn = doc.transact();
    let Some(branch) = txn.get_map(ydoc::CONTRIBUTORS_ROOT) else {
        return Vec::new();
    };
    let branch: &yrs::branch::Branch = branch.as_ref();
    branch
        .map_items()
        .filter(|(_, item)| !item.is_deleted())
        .map(|(_, item)| *item.id())
        .collect()
}

/// `assertUpdatePreservesContributors`: a client update may not add, replace
/// or remove markers. Read from the decoded update against the room: a new
/// struct may not sit in the marker map (named root, or an origin in it) or
/// under the room's own client (which writes the markers); the delete set may
/// not cover a live marker or reach past the room client's clock.
pub fn check<T: ReadTxn>(
    txn: &T,
    update: &Update,
    room_client: ClientID,
) -> Result<(), MarkerError> {
    let state = txn.state_vector();
    let held = |client: &ClientID| state.get(client);
    let store = txn.store();
    let markers = txn.get_map(ydoc::CONTRIBUTORS_ROOT);
    let markers_branch = markers.as_ref().map(|map| {
        let branch: &yrs::branch::Branch = map.as_ref();
        branch as *const yrs::branch::Branch
    });
    let in_markers = |id: Option<&ID>| -> bool {
        let Some(id) = id else { return false };
        if id.clock >= held(&id.client) {
            return false;
        }
        let Some(item) = store.get_item(id) else {
            return false;
        };
        match (item.parent_branch(), markers_branch) {
            (Some(parent), Some(markers)) => {
                let parent: &yrs::branch::Branch = &parent;
                std::ptr::eq(parent, markers)
            }
            _ => false,
        }
    };
    for block in update.blocks() {
        let (client, end) = match block {
            UpdateBlock::Item(item) => (item.id().client, item.id().clock + item.len()),
            UpdateBlock::Gc(range) | UpdateBlock::Skip(range) => {
                (range.client, range.clock + range.len)
            }
        };
        if end <= held(&client) {
            continue;
        }
        if client == room_client {
            return Err(MarkerError::Changed);
        }
        if let UpdateBlock::Item(item) = block {
            let in_root = matches!(item.update_parent(), UpdateParent::Root(name) if &**name == ydoc::CONTRIBUTORS_ROOT);
            if in_root || in_markers(item.origin()) || in_markers(item.right_origin()) {
                return Err(MarkerError::Changed);
            }
        }
    }
    let deletes = update.delete_set();
    if let Some(map) = markers.as_ref() {
        let branch: &yrs::branch::Branch = map.as_ref();
        for (_, item) in branch.map_items() {
            if !item.is_deleted() && deletes.contains(item.id()) {
                return Err(MarkerError::Changed);
            }
        }
    }
    for (client, ranges) in deletes.iter() {
        if *client == room_client && ranges.iter().any(|range| range.end > held(client)) {
            return Err(MarkerError::Changed);
        }
    }
    Ok(())
}

/// A room's marker bookkeeping: which live nonces a store snapshot claimed.
#[derive(Debug, Default)]
pub struct Markers {
    instance_id: String,
    claimed: HashSet<String>,
}

impl Markers {
    pub fn new(instance_id: &str) -> Self {
        Markers {
            instance_id: instance_id.to_owned(),
            claimed: HashSet::new(),
        }
    }

    fn key(&self, context: &Context) -> String {
        format!(
            "{}:{}:{}",
            self.instance_id,
            context.access.as_str(),
            URL_SAFE_NO_PAD.encode(context.user_id.as_bytes())
        )
    }

    /// Writes `context`'s marker in its own transaction when the writer has
    /// none or only a claimed one. Returns whether it wrote one.
    pub fn write(&mut self, doc: &Doc, context: &Context) -> bool {
        let key = self.key(context);
        let map = root(doc);
        let mut txn = doc.transact_mut();
        let live = match map.get(&txn, &key) {
            Some(Out::Any(Any::Map(value))) => match value.get("nonce") {
                Some(Any::String(nonce)) => Some(nonce.to_string()),
                _ => None,
            },
            _ => None,
        };
        if live.is_some_and(|nonce| !self.claimed.contains(&nonce)) {
            return false;
        }
        let value = Any::from(HashMap::from([
            ("access".to_owned(), Any::from("write")),
            (
                "nonce".to_owned(),
                Any::from(uuid::Uuid::new_v4().to_string()),
            ),
            ("userId".to_owned(), Any::from(context.user_id.as_str())),
        ]));
        map.insert(&mut txn, key, value);
        true
    }

    /// A store snapshot takes every live marker: their nonces are claimed.
    pub fn claim(&mut self, doc: &Doc) -> Result<Vec<Contributor>, MarkerError> {
        let all = contributors(doc)?;
        for contributor in &all {
            self.claimed.insert(contributor.nonce.clone());
        }
        Ok(all)
    }

    /// A failed store gives its claim back: the markers stay live.
    pub fn unclaim(&mut self, contributors: &[Contributor]) {
        for contributor in contributors {
            self.claimed.remove(&contributor.nonce);
        }
    }

    /// `clearDocumentContributors`: removes exactly the generations the
    /// committed snapshot held. Returns whether the room changed.
    pub fn clear(&mut self, doc: &Doc, committed: &[Contributor]) -> bool {
        self.unclaim(committed);
        if committed.is_empty() {
            return false;
        }
        let map = root(doc);
        let mut txn = doc.transact_mut();
        let mut changed = false;
        for contributor in committed {
            let current = map.get(&txn, &contributor.key);
            let same = current
                .as_ref()
                .and_then(|value| contributor_nonce(value))
                .is_some_and(|nonce| nonce == contributor.nonce);
            if same {
                map.remove(&mut txn, &contributor.key);
                changed = true;
            }
        }
        changed
    }
}

fn contributor_nonce(value: &Out) -> Option<String> {
    match value {
        Out::Any(Any::Map(map)) => match map.get("nonce") {
            Some(Any::String(nonce)) => Some(nonce.to_string()),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use yrs::{StateVector, Text, WriteTxn};

    use super::*;
    use crate::auth::Access;

    fn writer(user: &str) -> Context {
        Context {
            access: Access::Write,
            expires_at: i64::MAX,
            token_id: "t".into(),
            user_id: user.into(),
        }
    }

    fn room() -> Doc {
        Doc::with_options(ydoc::doc_options(11))
    }

    fn sync(from: &Doc, to: &Doc) {
        let sv = to.transact().state_vector();
        let update = from.transact().encode_state_as_update_v1(&sv);
        to.transact_mut()
            .apply_update(ydoc::decode(&update).unwrap())
            .unwrap();
    }

    #[test]
    fn markers_are_written_once_per_store_window() {
        let doc = room();
        let mut markers = Markers::new("inst");
        assert!(markers.write(&doc, &writer("u1")));
        assert!(!markers.write(&doc, &writer("u1")));
        assert!(markers.write(&doc, &writer("u2")));
        let snapshot = markers.claim(&doc).unwrap();
        assert_eq!(snapshot.len(), 2);
        // After the snapshot a writer's update gets a fresh generation...
        assert!(markers.write(&doc, &writer("u1")));
        assert!(!markers.write(&doc, &writer("u1")));
        // ...which the snapshot's clear leaves alone.
        assert!(markers.clear(&doc, &snapshot));
        let left = contributors(&doc).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].user_id, "u1");
        assert!(pending(&doc));
    }

    #[test]
    fn a_failed_store_keeps_its_markers_live() {
        let doc = room();
        let mut markers = Markers::new("inst");
        markers.write(&doc, &writer("u1"));
        let snapshot = markers.claim(&doc).unwrap();
        markers.unclaim(&snapshot);
        assert!(!markers.write(&doc, &writer("u1")));
        let again = markers.claim(&doc).unwrap();
        assert_eq!(again, snapshot);
        assert!(markers.clear(&doc, &again));
        assert!(!pending(&doc));
    }

    #[test]
    fn client_updates_may_not_touch_markers() {
        let room_doc = room();
        let room_client = room_doc.client_id();
        room_doc
            .get_or_insert_text("content")
            .insert(&mut room_doc.transact_mut(), 0, "hi");
        let mut markers = Markers::new("inst");
        markers.write(&room_doc, &writer("u1"));
        let client = Doc::with_options(ydoc::doc_options(22));
        sync(&room_doc, &client);
        let check_from = |edit: &dyn Fn(&Doc)| {
            let before = client.transact().state_vector();
            edit(&client);
            let update = client.transact().encode_state_as_update_v1(&before);
            let result = check(
                &room_doc.transact(),
                &ydoc::decode(&update).unwrap(),
                room_client,
            );
            // Keep the client in step with what the room would hold.
            sync(&room_doc, &client);
            result
        };
        // Typing is fine.
        assert_eq!(
            check_from(&|c: &Doc| c.get_or_insert_text("content").insert(
                &mut c.transact_mut(),
                2,
                "!"
            )),
            Ok(())
        );
        // Writing, replacing or removing a marker is not.
        assert_eq!(
            check_from(&|c: &Doc| {
                c.get_or_insert_map(ydoc::CONTRIBUTORS_ROOT)
                    .insert(&mut c.transact_mut(), "x", 1);
            }),
            Err(MarkerError::Changed)
        );
        let key = contributors(&room_doc).unwrap()[0].key.clone();
        assert_eq!(
            check_from(&|c: &Doc| {
                c.get_or_insert_map(ydoc::CONTRIBUTORS_ROOT)
                    .remove(&mut c.transact_mut(), &key);
            }),
            Err(MarkerError::Changed)
        );
        // A struct under the room's own client, past what the room holds, is refused.
        let impostor = Doc::with_options(ydoc::doc_options(room_client.get()));
        sync(&room_doc, &impostor);
        let before = impostor.transact().state_vector();
        let mut txn = impostor.transact_mut();
        txn.get_or_insert_text("content").insert(&mut txn, 0, "x");
        drop(txn);
        let update = impostor.transact().encode_state_as_update_v1(&before);
        assert_eq!(
            check(
                &room_doc.transact(),
                &ydoc::decode(&update).unwrap(),
                room_client
            ),
            Err(MarkerError::Changed)
        );
    }
}
