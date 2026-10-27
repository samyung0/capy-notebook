//! The Undo of a server edit (human/agentic-retrieval.md, 2026-10-20 and
//! 2026-10-21): where the edit is computed, its own Yjs items are read off
//! its transaction and reverted on that working document the way the
//! editor's undo reverts a person's step. The revert's update is the edit's
//! Undo payload: a delete set of the edit's own ids and copies of what it
//! deleted, with their formatting, rooted at the tombstones. The chat keeps
//! it for a day and sends it back; applied to the document then, it removes
//! only the edit's items and brings the rest back beside other people's
//! later changes, and applying it twice changes nothing.
//!
//! yrs keeps a deleted item's content from garbage collection only through
//! an `UndoManager` (its hook marks what the transaction deleted before the
//! collection runs), so each step here runs under a short-lived manager over
//! the document's roots.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use yrs::block::ItemContent;
use yrs::branch::BranchPtr;
use yrs::undo::{Options, StackItem, UndoManager};
use yrs::{
    Doc, ID, IdSet, Origin, Out, ReadTxn, StateVector, Transact, TransactionMut, Update,
    UpdateBlock, WriteTxn,
};

use crate::CONTRIBUTORS_ROOT;

/// One revertible change in a document: what it inserted and what it
/// deleted. Reverting it yields the change that reverses it (Redo).
pub type Change = StackItem<()>;

/// The transaction origin server edits and their Undo run under, so what
/// they delete is kept ([keep]).
pub const ORIGIN: &str = "capy-agent-edit";

/// While it lives, the transactions of its document under [ORIGIN] keep the
/// content of what they delete, so the edit can be reverted afterwards.
pub struct Keep {
    _manager: UndoManager<()>,
}

/// How long after an agent edit its Undo and Redo are offered (Q385, Epo
/// 2026-10-26): a payload carries its edit's time (an Undo's Redo payload
/// keeps it), and the server refuses one older than this (r1 L4).
pub const OFFERED_FOR: Duration = Duration::from_secs(24 * 60 * 60);

/// Unix seconds of `time`.
pub fn unix(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs() as i64)
}

/// Whether a payload issued at `issued_at` (Unix seconds, its agent edit's
/// time) is past its offer at `now`; the caller answers `undo_unavailable`.
/// A step across documents (a quiz's content and keys) carries one time, so
/// it ends as a whole (Q389).
pub fn expired(issued_at: i64, now: SystemTime) -> bool {
    unix(now) >= issued_at.saturating_add(OFFERED_FOR.as_secs() as i64)
}

/// Whether a payload made in lineage `made_in` is refused in lineage `now`
/// (a material's room schema, a source's epoch): today's compaction rebuilds
/// the document with new ids and the next room schema, so a payload cannot
/// apply across it, and a discard or publication moves the lineage too
/// (Q122, Epo 2026-10-22). The caller answers `undo_unavailable`.
pub fn refused_across_compaction(made_in: i64, now: i64) -> bool {
    made_in != now
}

/// Keeps what `doc`'s transactions under [ORIGIN] delete; open it before the
/// transaction.
pub fn keep(doc: &Doc) -> Keep {
    Keep {
        _manager: manager(doc, Vec::new()),
    }
}

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

    /// The change in the document `doc` that holds these items.
    pub fn change(self, doc: &Doc) -> Change {
        StackItem::new(doc.guid(), self.deletions, self.insertions)
    }
}

/// Applies `update` to `doc` in one transaction, keeping the content of what
/// it deletes so the change can be reverted; returns the change.
pub fn apply_kept(doc: &Doc, update: Update) -> Result<Captured, yrs::error::UpdateError> {
    let _keep = keep(doc);
    let mut txn = doc.transact_mut_with(ORIGIN);
    txn.apply_update(update)?;
    Ok(Captured::of(&mut txn))
}

/// The Undo payload of `captured` in `doc` (the working document the change
/// was made on, which kept what it deleted): the update [revert] makes. It
/// reverts the change on `doc`, so it is the last use of `doc`. None when
/// nothing of the change can be reverted.
pub fn payload(doc: &Doc, captured: Captured) -> Option<Vec<u8>> {
    revert(doc, captured.change(doc)).map(|reverted| reverted.update)
}

/// What sending an Undo payload back did to a document.
#[derive(Debug)]
pub enum Applied {
    /// Every struct it carries was held already: it was applied before.
    Before,
    /// It changed the document; the change (for the next payload).
    Changed(Captured),
    /// Nothing of the edit was left to revert.
    Nothing,
    /// It is not this document's: it names items the document does not hold
    /// (another lineage, a tampered payload; they stay pending, so the
    /// document must be dropped), or fails the structure checks ([foreign]).
    Unheld,
}

/// Applies an Undo payload (an update [payload] built) to `doc`, keeping what
/// it deletes. A map entry someone set after the reverted change (an XLSX
/// cell, a mark, an attribute) that a copy in the payload overwrote is put
/// back at once, in a transaction of its own, as the editor's undo leaves such
/// an entry (Epo 2026-10-20: other people's later changes stay); the change
/// returned leaves it out. Run on a working document: one that answers
/// [Applied::Unheld] is left with pending content.
pub fn apply_payload(doc: &Doc, update: Update) -> Result<Applied, yrs::error::UpdateError> {
    let carries = update.blocks().next().is_some();
    if carries && held(&update, &doc.transact().state_vector()) {
        return Ok(Applied::Before);
    }
    // A payload naming a unit `doc` holds collected would integrate that
    // part as collected and restore only part of its edit (Q419): refused,
    // as a payload naming items `doc` lacks is. The agent holds keep such
    // units meanwhile.
    if foreign(doc, &update) || crate::gc::names_collected(&doc.transact(), &update) {
        return Ok(Applied::Unheld);
    }
    let own = update.insertions(true);
    let named = update.delete_set().clone();
    let mut change = apply_kept(doc, update)?;
    if crate::has_pending(&doc.transact()) {
        return Ok(Applied::Unheld);
    }
    let beyond = change.deletions.diff(&named).diff(&own);
    let (entries, copies) = overwritten_entries(doc, &beyond, &own);
    if !entries.is_empty() {
        revert(doc, StackItem::new(doc.guid(), entries.clone(), copies));
        change.deletions = change.deletions.diff(&entries);
    }
    if change.deletions.is_empty() && !any_live(doc, &change.insertions) {
        return Ok(Applied::Nothing);
    }
    Ok(Applied::Changed(change))
}

/// Whether `update` cannot be a payload of `doc` though it may name only
/// items `doc` holds (r1 L3: defence in depth behind the gateway's
/// signature): malformed against it (`inspect_update`, as a writer's update
/// is checked), writing or deleting a contributor marker (an Undo leaves
/// provenance as it is, 2026-09-17), or carrying a copy anchored on a live
/// item. yrs re-inserts a deleted item with the tombstone itself as its
/// right origin (a copy inside a re-inserted block names other copies), so
/// a right origin `doc` holds live means another document's edit: a note
/// seeded alike, whose tombstone is a live item here.
fn foreign(doc: &Doc, update: &Update) -> bool {
    let txn = doc.transact();
    let Ok(inspection) = crate::inspect_update(&txn, update) else {
        return true;
    };
    if inspection
        .containers
        .iter()
        .any(|found| &*found.root == CONTRIBUTORS_ROOT)
    {
        return true;
    }
    let deletes = update.delete_set();
    if crate::live_markers(&txn)
        .iter()
        .any(|marker| deletes.contains(marker))
    {
        return true;
    }
    let state = txn.state_vector();
    let store = ReadTxn::store(&txn);
    update.blocks().any(|block| {
        let UpdateBlock::Item(item) = block else {
            return false;
        };
        item.right_origin().is_some_and(|right| {
            right.clock < state.get(&right.client)
                && store.get_item(right).is_some_and(|held| !held.is_deleted())
        })
    })
}

/// Whether `doc`'s state vector covers every struct `update` carries: the
/// payload was applied before. A struct past the state, or one that starts
/// after a gap (another document's, a forged one), is not held.
fn held(update: &Update, state: &StateVector) -> bool {
    update.blocks().all(|block| {
        let (client, clock, len) = match block {
            UpdateBlock::Item(item) => (item.id().client, item.id().clock, item.len()),
            UpdateBlock::Gc(range) | UpdateBlock::Skip(range) => {
                (range.client, range.clock, range.len)
            }
        };
        clock + len <= state.get(&client)
    })
}

/// The map entries among `deleted` (what a payload's transaction deleted
/// beyond its own delete set) whose key a live copy in `own` now holds: a
/// value someone set after the reverted change, overwritten by the payload;
/// and those copies.
fn overwritten_entries(doc: &Doc, deleted: &IdSet, own: &IdSet) -> (IdSet, IdSet) {
    let txn = doc.transact();
    let store = ReadTxn::store(&txn);
    let (mut entries, mut copies) = (IdSet::new(), IdSet::new());
    for (client, ranges) in deleted.iter() {
        for range in ranges.iter() {
            let mut clock = range.start;
            while clock < range.end {
                let Some((block, item)) = store.get_block_range(&ID::new(*client, clock)) else {
                    break;
                };
                clock = block.clock + block.len;
                let Some(item) = item else { continue };
                let (Some(key), Some(parent)) = (item.parent_sub(), item.parent_branch()) else {
                    continue;
                };
                if let Some(entry) = parent.entry_item(key)
                    && !entry.is_deleted()
                    && own.contains(entry.id())
                {
                    entries.insert(*item.id(), item.len());
                    copies.insert(*entry.id(), entry.len());
                }
            }
        }
    }
    (entries, copies)
}

/// Whether any unit of `set` is a live item of `doc` (not deleted, not
/// collected).
fn any_live(doc: &Doc, set: &IdSet) -> bool {
    let txn = doc.transact();
    let store = ReadTxn::store(&txn);
    set.iter().any(|(client, ranges)| {
        ranges.iter().any(|range| {
            let mut clock = range.start;
            while clock < range.end {
                let Some((block, item)) = store.get_block_range(&ID::new(*client, clock)) else {
                    return false;
                };
                if item.is_some_and(|item| !item.is_deleted()) {
                    return true;
                }
                clock = block.clock + block.len;
            }
            false
        })
    })
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

    /// An agent edit computed on a working copy of `room` as the server does
    /// (what it deletes kept), its update applied to `room` as any update is
    /// (collected), and its Undo payload.
    fn edit_with_payload(room: &Doc, edit: impl FnOnce(&mut TransactionMut)) -> Vec<u8> {
        let scratch = crate::scratch_doc();
        sync(room, &scratch);
        let before = room.transact().state_vector();
        let captured = {
            let _keep = keep(&scratch);
            let mut txn = scratch.transact_mut_with(ORIGIN);
            edit(&mut txn);
            Captured::of(&mut txn)
        };
        let update = scratch.transact().encode_state_as_update_v1(&before);
        crate::apply(room, Update::decode_v1(&update).unwrap()).unwrap();
        payload(&scratch, captured).unwrap()
    }

    /// `doc` stored and loaded again, as a room unload and reload does:
    /// deleted content is gone, the tombstones stay.
    fn reloaded(doc: &Doc) -> Doc {
        let loaded = crate::scratch_doc();
        sync(doc, &loaded);
        loaded
    }

    /// A working copy of `doc` with `payload` applied, and what that did.
    fn sent_back(doc: &Doc, payload: &[u8]) -> (Doc, Applied) {
        let scratch = crate::scratch_doc();
        sync(doc, &scratch);
        let applied = apply_payload(&scratch, Update::decode_v1(payload).unwrap()).unwrap();
        (scratch, applied)
    }

    /// Epo 2026-10-21: the payload outlives the room. Built where the edit
    /// ran, sent back to the document after it was stored and reloaded (the
    /// deleted word's content gone, its tombstone kept) and after a person
    /// typed inside the agent's text, it brings the word back and takes out
    /// only the agent's characters. Applied a second time it changes
    /// nothing; its Redo payload puts the agent's text back. Fails if the
    /// payload needs the deleted content in the document (a room-held step).
    #[test]
    fn a_payload_undoes_after_a_reload_keeps_typing_and_applies_once() {
        let room = crate::scratch_doc();
        room.get_or_insert_text("source")
            .insert(&mut room.transact_mut(), 0, "hello world");
        let undo = edit_with_payload(&room, |txn| {
            let source = txn.get_or_insert_text("source");
            source.remove_range(txn, 6, 5);
            source.insert(txn, 6, "there");
        });
        let room = reloaded(&room);
        room.get_or_insert_text("source")
            .insert(&mut room.transact_mut(), 8, "X");
        assert_eq!(text(&room), "hello thXere");

        let (undone, applied) = sent_back(&room, &undo);
        let Applied::Changed(change) = applied else {
            panic!("{applied:?}");
        };
        assert_eq!(text(&undone).replace('X', ""), "hello world");
        assert!(text(&undone).contains('X'));
        let undone = reloaded(&undone);
        assert!(matches!(sent_back(&undone, &undo).1, Applied::Before));

        // The Redo payload, built on the working copy that kept what the
        // Undo deleted, works on the stored document too.
        let (scratch, _) = sent_back(&room, &undo);
        let redo = payload(&scratch, change).unwrap();
        let (redone, applied) = sent_back(&undone, &redo);
        assert!(matches!(applied, Applied::Changed(_)), "{applied:?}");
        assert_eq!(text(&redone).replace('X', ""), "hello there");
        assert!(text(&redone).contains('X'));
    }

    /// The editor's undo keeps a value someone set after the agent (Epo
    /// 2026-10-20): the agent overwrote a cell, a person then set it again,
    /// and the payload's copy of the old value, which may win the tie with
    /// the person's, is put back; a cell nobody touched since reverts. Fails
    /// if the payload is applied as it is.
    #[test]
    fn a_payload_keeps_a_value_set_after_the_agent() {
        let cell = |doc: &Doc, key: &str| {
            let txn = doc.transact();
            txn.get_map("cells")
                .unwrap()
                .get(&txn, key)
                .unwrap()
                .to_string(&txn)
        };
        for attempt in 0..20 {
            let room = crate::scratch_doc();
            {
                let cells = room.get_or_insert_map("cells");
                let mut txn = room.transact_mut();
                cells.insert(&mut txn, "A1", "1");
                cells.insert(&mut txn, "B1", "1");
            }
            let undo = edit_with_payload(&room, |txn| {
                let cells = txn.get_or_insert_map("cells");
                cells.insert(txn, "A1", "2");
                cells.insert(txn, "B1", "2");
            });
            let person = reloaded(&room);
            person
                .get_or_insert_map("cells")
                .insert(&mut person.transact_mut(), "A1", "3");
            let (undone, applied) = sent_back(&person, &undo);
            assert!(matches!(applied, Applied::Changed(_)), "{applied:?}");
            assert_eq!(cell(&undone, "A1"), "3", "attempt {attempt}");
            assert_eq!(cell(&undone, "B1"), "1", "attempt {attempt}");
        }
    }

    /// A payload of another document's edit names items this one lacks: it
    /// is caught as unheld, not left to wait in a stored document.
    #[test]
    fn a_payload_of_another_document_is_unheld() {
        let other = crate::scratch_doc();
        other
            .get_or_insert_text("source")
            .insert(&mut other.transact_mut(), 0, "hello world");
        let undo = edit_with_payload(&other, |txn| {
            txn.get_or_insert_text("source").remove_range(txn, 0, 6);
        });
        let room = crate::scratch_doc();
        room.get_or_insert_text("source")
            .insert(&mut room.transact_mut(), 0, "hello world");
        assert!(matches!(sent_back(&room, &undo).1, Applied::Unheld));
    }

    /// Two notes seeded alike share their seed's ids, so another note's
    /// payload finds its anchors here; it still names the other edit's own
    /// items, which this note lacks, and is unheld, not taken for a payload
    /// applied before. Fails if a gap in the payload's clocks reads as held.
    #[test]
    fn a_payload_of_a_note_seeded_alike_is_unheld() {
        let seed = crate::scratch_doc();
        seed.get_or_insert_text("source")
            .insert(&mut seed.transact_mut(), 0, "hello world");
        let (other, room) = (reloaded(&seed), reloaded(&seed));
        let undo = edit_with_payload(&other, |txn| {
            let text = txn.get_or_insert_text("source");
            text.remove_range(txn, 0, 5);
            text.insert(txn, 0, "howdy");
        });
        assert!(matches!(sent_back(&room, &undo).1, Applied::Unheld));
    }

    /// r1 L3 (defence in depth behind the gateway's signature): an edit that
    /// only deleted has a payload of copies alone, anchored on ids a note
    /// seeded alike holds too. There its tombstone is a live item, and the
    /// payload is refused rather than doubling the text; in its own note
    /// it applies. Fails if the copies' anchors go unchecked.
    #[test]
    fn a_deletion_only_payload_of_a_note_seeded_alike_is_unheld() {
        let seed = crate::scratch_doc();
        seed.get_or_insert_text("source")
            .insert(&mut seed.transact_mut(), 0, "hello world");
        let (other, room) = (reloaded(&seed), reloaded(&seed));
        let undo = edit_with_payload(&other, |txn| {
            txn.get_or_insert_text("source").remove_range(txn, 0, 6);
        });
        assert!(matches!(sent_back(&room, &undo).1, Applied::Unheld));
        assert_eq!(text(&room), "hello world");
        let (undone, applied) = sent_back(&reloaded(&other), &undo);
        assert!(matches!(applied, Applied::Changed(_)), "{applied:?}");
        assert_eq!(text(&undone), "hello world");
    }

    /// r1 L3: an update writing the contributor markers is no payload (an
    /// Undo leaves provenance as it is). Fails if a marker write applies.
    #[test]
    fn a_payload_writing_a_contributor_marker_is_unheld() {
        let room = crate::scratch_doc();
        room.get_or_insert_text("source")
            .insert(&mut room.transact_mut(), 0, "hello");
        let forged = crate::scratch_doc();
        sync(&room, &forged);
        let before = room.transact().state_vector();
        forged.get_or_insert_map(CONTRIBUTORS_ROOT).insert(
            &mut forged.transact_mut(),
            "u_forged",
            "1",
        );
        let update = forged.transact().encode_state_as_update_v1(&before);
        assert!(matches!(sent_back(&room, &update).1, Applied::Unheld));
    }

    /// r1 L4, Q385: a payload is offered 24 h from its edit, then refused.
    #[test]
    fn a_payload_expires_24_hours_after_its_edit() {
        let edited = SystemTime::now();
        let issued = unix(edited);
        assert!(!expired(
            issued,
            edited + OFFERED_FOR - Duration::from_secs(1)
        ));
        assert!(expired(issued, edited + OFFERED_FOR));
    }

    /// Once a person removed everything the agent wrote, its payload has
    /// nothing left to do.
    #[test]
    fn a_payload_with_nothing_left_is_nothing() {
        let room = crate::scratch_doc();
        let undo = edit_with_payload(&room, |txn| {
            txn.get_or_insert_text("source").insert(txn, 0, "abc");
        });
        room.get_or_insert_text("source")
            .remove_range(&mut room.transact_mut(), 0, 3);
        assert!(matches!(sent_back(&room, &undo).1, Applied::Nothing));
    }
}
