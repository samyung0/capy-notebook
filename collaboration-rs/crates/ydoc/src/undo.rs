//! The live Undo of a server edit (human/agentic-retrieval.md, 2026-10-20):
//! the edit's own Yjs items, read off its transaction where it was computed,
//! are kept by the room that applies it and reverted there the way the
//! editor's undo reverts a person's step, so other people's later changes
//! stay. Nothing is stored: it lasts while the room holds the document.
//!
//! yrs keeps a deleted item's content from garbage collection only through
//! an `UndoManager` (its hook marks what the transaction deleted before the
//! collection runs), so each step here runs under a short-lived manager over
//! the document's roots.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use yrs::block::ItemContent;
use yrs::branch::BranchPtr;
use yrs::undo::{Options, StackItem, UndoManager};
use yrs::{Doc, IdSet, Origin, Out, ReadTxn, Transact, TransactionMut, Update, WriteTxn};

use crate::CONTRIBUTORS_ROOT;

/// One revertible change in a room's document: what it inserted and what it
/// deleted. Reverting it yields the change that reverses it (Redo).
pub type Change = StackItem<()>;

/// The transaction origin a room applies and reverts server edits under.
const ORIGIN: &str = "capy-agent-edit";

/// What an edit's transaction added and removed.
#[derive(Clone, Debug, Default)]
pub struct Captured {
    pub insertions: IdSet,
    pub deletions: IdSet,
}

impl Captured {
    /// Commits `txn` and reads what it changed.
    pub fn of(txn: &mut TransactionMut) -> Self {
        txn.commit();
        Captured {
            insertions: txn.insert_set().clone(),
            deletions: txn.delete_set().clone(),
        }
    }

    /// The change in the document `doc` (a room's) that holds these items.
    pub fn change(self, doc: &Doc) -> Change {
        StackItem::new(doc.guid(), self.deletions, self.insertions)
    }
}

/// Applies a server edit's update to a room's document, keeping the content
/// of what it deletes for the edit's Undo; returns what changed (empty when
/// nothing did), as [crate::apply] does.
pub fn apply_kept(doc: &Doc, update: Update) -> Result<Vec<u8>, yrs::error::UpdateError> {
    let manager = manager(doc, Vec::new());
    let mut txn = doc.transact_mut_with(ORIGIN);
    txn.apply_update(update)?;
    let applied = crate::committed_update(txn);
    drop(manager);
    Ok(applied)
}

/// A performed revert: the update that made it, and the change that
/// reverses it (Redo), when yrs kept one.
pub struct Reverted {
    pub update: Vec<u8>,
    pub next: Option<Change>,
}

/// Reverts `change` in `doc` as the editor's undo does: what it inserted and
/// is still there goes, copies of what it deleted come back. None when nothing
/// of `change` was left to revert; a revert that ran always comes back with
/// its update, so the caller can send what changed.
pub fn revert(doc: &Doc, change: Change) -> Option<Reverted> {
    let mut manager = manager(doc, vec![change]);
    let update = Arc::new(Mutex::new(Vec::new()));
    let popped = update.clone();
    manager.observe_item_popped_with("capy-agent-edit-popped", move |txn, _| {
        let mut update = popped
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *update = txn.encode_update_v1();
    });
    if !manager.undo_blocking() {
        return None;
    }
    let next = manager.redo_stack().last().cloned();
    drop(manager);
    let update = std::mem::take(
        &mut *update
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    );
    Some(Reverted { update, next })
}

/// The size of the update reverting `change` in `doc` would send, measured
/// by reverting it on a copy that keeps deleted content as the room does
/// (0 when nothing of it is left). A copy that cannot be made counts as too
/// large: the room's own state always decodes. O(state): for the tests that
/// calibrate `sources::undo_cost` only; a room never copies its document to
/// size an Undo (Epo 2026-10-21).
pub fn revert_len(doc: &Doc, change: &Change) -> usize {
    let mut options = crate::doc_options(0);
    options.client_id = doc.client_id();
    options.guid = doc.guid();
    options.skip_gc = true;
    let copy = Doc::with_options(options);
    let state = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    let copied =
        crate::decode(&state).is_ok_and(|update| copy.transact_mut().apply_update(update).is_ok());
    if !copied {
        return usize::MAX;
    }
    revert(&copy, change.clone()).map_or(0, |reverted| reverted.update.len())
}

/// A manager over every root of `doc` but the contributor markers, holding
/// `stack` to undo. A root no code typed yet gets its type from its content
/// first: yrs reports no change of an untyped root, and the manager skips a
/// transaction whose changes it is not told of.
fn manager(doc: &Doc, stack: Vec<Change>) -> UndoManager<()> {
    let roots = {
        let mut txn = doc.transact_mut();
        type_roots(&mut txn);
        txn.root_refs()
            .filter(|(name, _)| *name != CONTRIBUTORS_ROOT)
            .filter_map(|(_, out)| out.try_branch().map(BranchPtr::from))
            .collect::<Vec<_>>()
    };
    let mut manager = UndoManager::with_options(Options {
        tracked_origins: HashSet::from([Origin::from(ORIGIN)]),
        init_undo_stack: stack,
        ..Default::default()
    });
    for root in roots {
        manager.expand_scope(doc, &root);
    }
    manager
}

/// What an untyped root holds, read the way yrs infers it.
enum RootType {
    Text,
    Array,
    Map,
}

fn type_roots(txn: &mut TransactionMut) {
    let untyped: Vec<(String, RootType)> = txn
        .root_refs()
        .filter_map(|(name, out)| {
            let Out::UndefinedRef(branch) = out else {
                return None;
            };
            let mut item = branch.start();
            while let Some(current) = item {
                if !current.is_deleted() {
                    break;
                }
                item = current.right();
            }
            let kind = match item {
                Some(item) => match item.content() {
                    ItemContent::String(_) | ItemContent::Embed(_) | ItemContent::Format(..) => {
                        RootType::Text
                    }
                    _ => RootType::Array,
                },
                None if branch.map_items().next().is_some() => RootType::Map,
                None => return None,
            };
            Some((name.to_owned(), kind))
        })
        .collect();
    for (name, kind) in untyped {
        match kind {
            RootType::Text => {
                txn.get_or_insert_text(name.as_str());
            }
            RootType::Array => {
                txn.get_or_insert_array(name.as_str());
            }
            RootType::Map => {
                txn.get_or_insert_map(name.as_str());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use yrs::updates::decoder::Decode;
    use yrs::{GetString, Map, StateVector, Text};

    use super::*;

    fn sync(from: &Doc, to: &Doc) {
        let update = from
            .transact()
            .encode_state_as_update_v1(&to.transact().state_vector());
        crate::apply(to, Update::decode_v1(&update).unwrap()).unwrap();
    }

    /// An agent edit computed on a scratch copy of `room`: its update applied
    /// to the room with its deletions kept, and its change there.
    fn agent_edit(room: &Doc, edit: impl FnOnce(&mut TransactionMut)) -> Change {
        let scratch = crate::scratch_doc();
        let whole = room
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        crate::apply(&scratch, Update::decode_v1(&whole).unwrap()).unwrap();
        let before = room.transact().state_vector();
        let captured = {
            let mut txn = scratch.transact_mut();
            edit(&mut txn);
            Captured::of(&mut txn)
        };
        let update = scratch.transact().encode_state_as_update_v1(&before);
        apply_kept(room, Update::decode_v1(&update).unwrap()).unwrap();
        captured.change(room)
    }

    fn text(doc: &Doc) -> String {
        let txn = doc.transact();
        txn.get_text("source").unwrap().get_string(&txn)
    }

    /// The agent replaces a word; a person types inside the agent's new text
    /// and beside it. Undo takes out exactly the agent's characters and brings
    /// the word back, keeping both of the person's; Redo puts the agent's
    /// text back. The room's untyped root (it only ever applied updates)
    /// still counts.
    #[test]
    fn undo_reverts_only_the_agents_items_and_redo_restores_them() {
        let person = crate::scratch_doc();
        person
            .get_or_insert_text("source")
            .insert(&mut person.transact_mut(), 0, "hello world");
        let room = crate::scratch_doc();
        sync(&person, &room);
        let change = agent_edit(&room, |txn| {
            let source = txn.get_or_insert_text("source");
            source.remove_range(txn, 6, 5);
            source.insert(txn, 6, "there");
        });
        sync(&room, &person);
        {
            let source = person.get_or_insert_text("source");
            let mut txn = person.transact_mut();
            source.insert(&mut txn, 8, "X");
            source.insert(&mut txn, 0, "Hi ");
        }
        sync(&person, &room);
        assert_eq!(text(&room), "Hi hello thXere");

        let undo = revert(&room, change).unwrap();
        assert_eq!(text(&room).replace('X', ""), "Hi hello world");
        assert!(text(&room).contains('X'));
        crate::apply(&person, Update::decode_v1(&undo.update).unwrap()).unwrap();
        assert_eq!(text(&person), text(&room));

        let again = revert(&room, undo.next.unwrap()).unwrap();
        assert_eq!(text(&room).replace('X', ""), "Hi hello there");
        crate::apply(&person, Update::decode_v1(&again.update).unwrap()).unwrap();
        assert_eq!(text(&person), text(&room));
    }

    /// A map value the agent overwrote (an XLSX cell) comes back on Undo.
    #[test]
    fn undo_restores_an_overwritten_map_value() {
        let room = crate::scratch_doc();
        room.get_or_insert_map("cells")
            .insert(&mut room.transact_mut(), "A1", "1");
        let change = agent_edit(&room, |txn| {
            txn.get_or_insert_map("cells").insert(txn, "A1", "2");
        });
        let cell = |doc: &Doc| {
            let txn = doc.transact();
            txn.get_map("cells")
                .unwrap()
                .get(&txn, "A1")
                .unwrap()
                .to_string(&txn)
        };
        assert_eq!(cell(&room), "2");
        let redo = revert(&room, change).unwrap().next.unwrap();
        assert_eq!(cell(&room), "1");
        revert(&room, redo).unwrap();
        assert_eq!(cell(&room), "2");
    }

    /// The Undo of an earlier agent edit after a later one rewrote the same
    /// span keeps both: the later text stays and the earlier edit's deleted
    /// text comes back beside it (its own text is gone already), as the
    /// editor's undo does.
    #[test]
    fn undo_of_an_earlier_edit_keeps_a_later_edit_of_its_span() {
        let room = crate::scratch_doc();
        room.get_or_insert_text("source")
            .insert(&mut room.transact_mut(), 0, "hello world");
        let first = agent_edit(&room, |txn| {
            let source = txn.get_or_insert_text("source");
            source.remove_range(txn, 6, 5);
            source.insert(txn, 6, "there");
        });
        agent_edit(&room, |txn| {
            let source = txn.get_or_insert_text("source");
            source.remove_range(txn, 6, 5);
            source.insert(txn, 6, "folks");
        });
        assert_eq!(text(&room), "hello folks");
        revert(&room, first).unwrap();
        let after = text(&room);
        assert!(
            after.contains("world") && after.contains("folks"),
            "{after}"
        );
        assert!(!after.contains("there"), "{after}");
    }

    /// The calibration's measure (`sources::undo_cost`) is the update the
    /// revert sends: a removal's Undo brings its content back, and measuring
    /// leaves the room as it was.
    #[test]
    fn revert_len_is_what_the_revert_sends() {
        let room = crate::scratch_doc();
        room.get_or_insert_text("source")
            .insert(&mut room.transact_mut(), 0, &"a".repeat(100_000));
        let change = agent_edit(&room, |txn| {
            txn.get_or_insert_text("source")
                .remove_range(txn, 0, 100_000);
        });
        let len = revert_len(&room, &change);
        assert!(len > 100_000, "{len}");
        assert_eq!(text(&room), "");
        assert_eq!(revert(&room, change).unwrap().update.len(), len);
    }

    /// Once a person removed everything the agent wrote, there is nothing
    /// left to revert.
    #[test]
    fn nothing_left_is_none() {
        let room = crate::scratch_doc();
        let change = agent_edit(&room, |txn| {
            txn.get_or_insert_text("source").insert(txn, 0, "abc");
        });
        room.get_or_insert_text("source")
            .remove_range(&mut room.transact_mut(), 0, 3);
        assert!(revert(&room, change).is_none());
    }
}
