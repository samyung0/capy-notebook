#![allow(clippy::unwrap_used)]
//! Seeded model of the in-place collection on a blocks room, after
//! `notes/tests/gc_views.rs`: a room S and four tabs that go offline, keep
//! editing (typing, deleting text, adding, moving and deleting blocks,
//! undoing their own steps), come back and send what they hold, now and then
//! reload. S repairs on entry (D3) and folds at random moments: it collects
//! at the newest window every session reached, with H the deletions
//! sessions' updates made (none expires inside a case: every Undo here is
//! inside 24 h), and swaps the collected document in (Q401). A twin room R
//! admits the same updates and never collects.
//!
//! Tabs also cut a block and paste it back, keeping its id only while they
//! still hold its key (D20 with the deleted-key rule), and a day can pass
//! while a tab is away: its session ends, its Undo empties, and it comes
//! back late, its edits placed by the late merge. The collection lets a
//! deleted block's `blocks` key go (`blocks::unique_key`), and the keyed late
//! merge (`merge_keyed`) leaves out a value for such a key, which the tab
//! pastes again under a fresh id (`common::repaste`); BLOCKS_GC_KEYED=0 runs the
//! plain collection, merge and D20, and BLOCKS_GC_KEYED=collect-only the
//! keyed collection with the plain merge and D20 (the control: it diverges).
//! plain collection, plain merge and plain D20 instead. R, which keeps every
//! key, stands for every tab open since before a collection.
//!
//! Checked: every collected state loads with nothing pending, the same
//! state vector and value, and passes the check; an update naming what a
//! collection's window deleted is answered late, and its merge names
//! nothing collected; after every admission S and R hold the same blocks;
//! at the end every tab, S and a fresh load of S converge and pass the
//! check. BLOCKS_GC_CASES and BLOCKS_GC_SEED run more or other cases.

mod common;

use std::collections::HashSet;

use serde_json::{Value, json};
use ydoc::gc::{Named, Window, collect_with, named_collected};
use yrs::undo::{Options, UndoManager};
use yrs::{Doc, IdSet, Map, Origin, Out, ReadTxn, Text, Transact};

const ROOM: u64 = 2;
const TAB: &str = "tab";

/// xorshift64.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

struct Tab {
    doc: Doc,
    undo: UndoManager<()>,
    online: bool,
    /// The window index of the last S state this tab's session reached.
    reached: usize,
    added: u32,
    /// A cut block: its id and text.
    clipboard: Option<(String, String)>,
    /// Away while a day passed: its session ended, it comes back late.
    expired: bool,
}

impl Tab {
    fn join(s: &Doc, client: u64, reached: usize) -> Tab {
        let doc = common::doc(&common::state(s), client);
        let mut undo = UndoManager::with_options(Options {
            capture_timeout_millis: 0,
            tracked_origins: HashSet::from([Origin::from(TAB)]),
            ..Options::default()
        });
        undo.expand_scope(&doc, &doc.get_or_insert_map(blocks::BLOCKS_ROOT));
        Tab {
            doc,
            undo,
            online: true,
            reached,
            added: 0,
            clipboard: None,
            expired: false,
        }
    }
}

/// `id`'s children that the map holds (an offline tab may list a block a
/// co-editor deleted until the room repairs it).
fn kids(txn: &impl ReadTxn, id: &str) -> Vec<String> {
    let blocks = common::blocks_map(txn);
    if blocks.get(txn, id).is_none() {
        return Vec::new();
    }
    common::child_ids(txn, id)
        .into_iter()
        .filter(|child| blocks.get(txn, child).is_some())
        .collect()
}

/// Content blocks reachable from the note, depth first, each once.
fn reachable(txn: &impl ReadTxn) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut stack = kids(txn, blocks::NOTE_ID);
    stack.reverse();
    while let Some(id) = stack.pop() {
        if out.contains(&id) {
            continue;
        }
        let mut children = kids(txn, &id);
        children.reverse();
        stack.extend(children);
        out.push(id);
    }
    out
}

fn descendants(txn: &impl ReadTxn, id: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut stack = vec![id.to_string()];
    while let Some(id) = stack.pop() {
        for child in kids(txn, &id) {
            if !out.contains(&child) {
                out.push(child.clone());
                stack.push(child);
            }
        }
    }
    out
}

fn flavour(txn: &impl ReadTxn, id: &str) -> String {
    let Some(Out::YMap(block)) = common::blocks_map(txn).get(txn, id) else {
        return String::new();
    };
    block
        .get(txn, "sys:flavour")
        .map(|f| f.to_string(txn))
        .unwrap_or_default()
}

fn edit(tab: &mut Tab, client: u64, rng: &mut Rng, keyed: bool) -> String {
    if rng.below(6) == 0 {
        let undone = tab.undo.undo_blocking();
        return format!("undo {undone}");
    }
    let mut txn = tab.doc.transact_mut_with(TAB);
    let ids = reachable(&txn);
    let paragraphs: Vec<String> = ids
        .iter()
        .filter(|id| flavour(&txn, id) == "affine:paragraph")
        .cloned()
        .collect();
    match rng.below(8) {
        // Cut a paragraph.
        6 if !paragraphs.is_empty() => {
            let id = paragraphs[rng.below(paragraphs.len())].clone();
            let text = common::text_of(&txn, &id);
            common::delete_block(&mut txn, &id);
            tab.clipboard = Some((id.clone(), text));
            return format!("cut {id}");
        }
        // Paste the cut block back (D20).
        7 if tab.clipboard.is_some() => {
            let (id, text) = tab.clipboard.clone().unwrap();
            tab.added += 1;
            let fresh = format!("n{client}_{}", tab.added);
            let pasted = if keyed {
                common::paste_id(&txn, &id, &fresh)
            } else if common::blocks_map(&txn).get(&txn, &id).is_some() {
                fresh
            } else {
                id.clone()
            };
            let at = rng.below(ids.len() + 1) as u32;
            common::add_paragraph(&mut txn, &pasted, &text, blocks::NOTE_ID, at);
            let kept = if pasted == id { "kept" } else { "fresh" };
            return format!("paste {kept} {pasted}");
        }
        0 if !paragraphs.is_empty() => {
            let id = &paragraphs[rng.below(paragraphs.len())];
            let text = common::text(&txn, id);
            let at = rng.below(text.len(&txn) as usize + 1) as u32;
            text.insert(&mut txn, at, ["x", "yy", "zzz"][rng.below(3)]);
            return format!("type into {id}");
        }
        1 if !paragraphs.is_empty() => {
            let id = &paragraphs[rng.below(paragraphs.len())];
            let text = common::text(&txn, id);
            let len = text.len(&txn) as usize;
            if len > 0 {
                let at = rng.below(len);
                let n = 1 + rng.below((len - at).min(4));
                text.remove_range(&mut txn, at as u32, n as u32);
            }
            return format!("delete text in {id}");
        }
        2 => {
            tab.added += 1;
            let id = format!("n{client}_{}", tab.added);
            let at = rng.below(ids.len() + 1) as u32;
            common::add_paragraph(&mut txn, &id, &id, blocks::NOTE_ID, at);
            return format!("add {id}");
        }
        3 if !ids.is_empty() => {
            let id = ids[rng.below(ids.len())].clone();
            common::delete_block(&mut txn, &id);
            return format!("delete {id}");
        }
        _ if !ids.is_empty() => {
            // Move under the note, or a paragraph under another paragraph
            // (an indent), never into itself.
            let id = ids[rng.below(ids.len())].clone();
            let below = descendants(&txn, &id);
            let mut targets: Vec<String> = if flavour(&txn, &id) == "affine:paragraph" {
                paragraphs
                    .iter()
                    .filter(|t| **t != id && !below.contains(t))
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            };
            targets.push(blocks::NOTE_ID.into());
            let to = targets[rng.below(targets.len())].clone();
            common::move_block(&mut txn, &id, &to, rng.below(4) as u32);
            return format!("move {id} under {to}");
        }
        _ => {}
    }
    "nothing".into()
}

/// S, its twin R, H and the windows S passed through.
struct Rooms {
    s: Doc,
    r: Doc,
    held: IdSet,
    windows: Vec<Window>,
    /// The delete set of the latest collection's window.
    collected: IdSet,
    /// Updates naming only what Yjs dropped under a block deleted since.
    since: u64,
    /// Updates answered late and merged.
    late: u64,
    /// Blocks the late merges hid.
    hidden: u64,
    /// Blocks pasted again under fresh ids after a keyed merge.
    rekeyed: u64,
    /// The deleted-key rule on.
    keyed: bool,
    /// The keyed merge on (the control turns it off).
    guarded: bool,
    seed: Doc,
    log: Vec<String>,
}

impl Rooms {
    fn latest(&self) -> usize {
        self.windows.len() - 1
    }

    fn mark(&mut self) {
        let window = Window::of(&self.s.transact(), self.windows.len() as i64);
        self.windows.push(window);
    }

    /// Admits a tab's update in both rooms, holds its deletions, repairs S
    /// on entry and gives R the same repair.
    /// Admits a tab's update as `room.rs` does: one naming what a
    /// collection's window deleted is answered late (Q443) and not applied;
    /// one naming only what Yjs dropped under a block deleted since is
    /// admitted, the typing going with the block (Q446).
    fn admit(&mut self, update: &[u8], case: u64) -> bool {
        let decoded = ydoc::decode(update).unwrap();
        let named = named_collected(&self.s.transact(), &decoded, &self.collected);
        if named == Named::Window {
            return false;
        }
        self.since += u64::from(named == Named::Since);
        let (_, deleted) = ydoc::apply_deleting(&self.s, decoded).unwrap();
        self.held.merge_with(deleted);
        common::apply(&self.r, update);
        let before = self.s.transact().state_vector();
        blocks::repair(&mut self.s.transact_mut());
        let repair = self.s.transact().encode_state_as_update_v1(&before);
        common::apply(&self.r, &repair);
        blocks::check(&self.s.transact()).unwrap();
        if blocks::blocks_json(&self.s.transact()) != blocks::blocks_json(&self.r.transact()) {
            eprintln!("log:\n{}", self.log.join("\n"));
            panic!("case {case}: S and R differ");
        }
        self.mark();
        true
    }

    /// Collects S at the newest window every session reached and swaps the
    /// result in; the units collected.
    fn fold(&mut self, tabs: &[Tab], case: u64) -> u64 {
        // Ended sessions no longer hold the window back.
        let reached = tabs
            .iter()
            .filter(|t| !t.expired)
            .map(|t| t.reached)
            .min()
            .unwrap_or(self.latest());
        let window = &self.windows[reached];
        let unique: Option<ydoc::gc::UniqueKeys> = self.keyed.then_some(&blocks::unique_key);
        let collected = collect_with(
            &self.s,
            window,
            &self.held,
            Some(self.s.client_id()),
            unique,
        );
        if collected.units > 0 {
            self.collected = window.delete_set.clone();
        }
        let doc = common::doc(&collected.state, ROOM);
        let txn = doc.transact();
        assert!(!ydoc::has_pending(&txn), "case {case}: pending after load");
        assert_eq!(txn.state_vector(), self.s.transact().state_vector());
        assert_eq!(
            blocks::value(&txn).unwrap(),
            blocks::value(&self.s.transact()).unwrap(),
            "case {case}: value changed by the collection"
        );
        blocks::check(&txn).unwrap();
        drop(txn);
        self.s = doc;
        collected.units
    }
}

/// Sends what the tab holds; a late answer runs the late merge (the
/// stable-left placement onto S's document, under the tab's own ids), which
/// must name nothing collected, and the tab reloads on the result with an
/// empty Undo, as the browser does; then it pastes the blocks the keyed
/// merge left out again under fresh ids (`common::repaste`), which the room
/// admits like any edit.
fn send(tab: &mut Tab, rooms: &mut Rooms, case: u64) {
    let sv = rooms.s.transact().state_vector();
    let update = tab.doc.transact().encode_state_as_update_v1(&sv);
    // A tab whose session ended is late whatever it names.
    if !tab.expired && rooms.admit(&update, case) {
        return;
    }
    rooms.late += 1;
    let (old, current) = (common::state(&tab.doc), common::state(&rooms.s));
    let merged = if rooms.guarded {
        late_merge::merge_keyed(&old, &current, &late_merge::BLOCKS)
    } else {
        late_merge::merge(&old, &current)
    }
    .unwrap();
    rooms.hidden += merged.hidden.len() as u64;
    rooms.log.push(format!(
        "tab {} answered late, {} blocks hidden",
        tab.doc.client_id().get(),
        merged.hidden.len()
    ));
    if !rooms.admit(&merged.update, case) {
        debug_named(
            &rooms.s,
            &rooms.seed,
            &ydoc::decode(&merged.update).unwrap(),
        );
        eprintln!("log:\n{}", rooms.log.join("\n"));
        panic!("case {case}: the late merge names collected history");
    }
    // The same session's id generator: ids it minted are never minted again.
    let added = tab.added;
    let old_doc = tab.doc.clone();
    let client = tab.doc.client_id().get();
    *tab = Tab::join(&rooms.s, client, rooms.latest());
    tab.added = added;
    if merged.rekeyed.is_empty() {
        return;
    }
    let before = tab.doc.transact().state_vector();
    let mut added = tab.added;
    let mapped = common::repaste(
        &old_doc,
        &mut tab.doc.transact_mut(),
        &merged.rekeyed,
        &mut || {
            added += 1;
            format!("n{client}_{added}")
        },
    );
    tab.added = added;
    rooms.rekeyed += mapped.len() as u64;
    rooms.log.push(format!("tab {client} re-keys {mapped:?}"));
    let update = tab.doc.transact().encode_state_as_update_v1(&before);
    if !rooms.admit(&update, case) {
        eprintln!("log:\n{}", rooms.log.join("\n"));
        panic!("case {case}: a re-paste was answered late");
    }
}

fn hear(tab: &mut Tab, rooms: &Rooms) {
    let sv = tab.doc.transact().state_vector();
    common::apply(&tab.doc, &rooms.s.transact().encode_state_as_update_v1(&sv));
    tab.reached = rooms.latest();
}

fn seed_value(rng: &mut Rng) -> Vec<Value> {
    let mut value: Vec<Value> = (0..4 + rng.below(6))
        .map(|i| json!({"id": format!("b{i}"), "type": "p", "children": [{"text": format!("Paragraph {i}")}]}))
        .collect();
    value.push(json!({"id": "t", "type": "table", "children": [
        {"id": "r0", "type": "tr", "children": [
            {"type": "td", "children": [{"type": "p", "children": [{"text": "one"}]}]},
            {"type": "td", "children": [{"type": "p", "children": [{"text": "two"}]}]},
        ]},
    ]}));
    value
}

#[test]
fn offline_tabs_folds_and_undo_converge_with_an_uncollected_twin() {
    let cases: u64 = std::env::var("BLOCKS_GC_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(400);
    let seed: u64 = std::env::var("BLOCKS_GC_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0x6c0_11ec7);
    let mode = std::env::var("BLOCKS_GC_KEYED").unwrap_or_default();
    let keyed = mode != "0";
    let guarded = keyed && mode != "collect-only";
    let (mut collected, mut folds, mut undos, mut since, mut days, mut late) =
        (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
    let (mut hidden, mut pastes_kept, mut expired, mut rekeyed) = (0u64, 0u64, 0u64, 0u64);
    for case in 0..cases {
        let mut rng = Rng(seed ^ (case + 1).wrapping_mul(0x9e37_79b9_7f4a_7c15));
        let state = blocks::state_from_value(&seed_value(&mut rng), 1).unwrap();
        let mut rooms = Rooms {
            s: common::doc(&state, ROOM),
            r: common::doc(&state, ROOM),
            held: IdSet::new(),
            windows: Vec::new(),
            collected: IdSet::new(),
            since: 0,
            late: 0,
            hidden: 0,
            rekeyed: 0,
            keyed,
            guarded,
            seed: common::doc(&state, 3),
            log: Vec::new(),
        };
        rooms.mark();
        let mut tabs: Vec<Tab> = (0..4)
            .map(|k| Tab::join(&rooms.s, 10 + k * 10, 0))
            .collect();
        let mut next_client = 100;
        for _step in 0..80 {
            let k = rng.below(tabs.len());
            let client = tabs[k].doc.client_id().get();
            match rng.below(14) {
                // Go offline, or come back and send what it holds.
                0 => {
                    rooms.log.push(format!("tab {client} toggles online"));
                    if tabs[k].online {
                        tabs[k].online = false;
                    } else {
                        tabs[k].online = true;
                        send(&mut tabs[k], &mut rooms, case);
                    }
                }
                // Reload: a new session on the room's current (collected)
                // state, its Undo empty; unsent edits are sent first.
                1 if tabs[k].online => {
                    rooms
                        .log
                        .push(format!("tab {client} reloads as {next_client}"));
                    tabs[k] = Tab::join(&rooms.s, next_client, rooms.latest());
                    next_client += 1;
                }
                2 => {
                    let units = rooms.fold(&tabs, case);
                    rooms.log.push(format!("fold: {units} units"));
                    folds += u64::from(units > 0);
                }
                // A day passes (26 h): Undo reaches back 24 h (Q2), so every
                // stack empties, H's 25 h are over, and a session away that
                // long ends (its tab comes back late).
                3 => {
                    for tab in tabs.iter_mut() {
                        tab.undo.clear_all();
                        if !tab.online && !tab.expired {
                            tab.expired = true;
                            expired += 1;
                        }
                    }
                    rooms.held = IdSet::new();
                    rooms.log.push("a day passes".into());
                    days += 1;
                }
                _ => {
                    let undo_before = tabs[k].undo.undo_stack().len();
                    let what = edit(&mut tabs[k], client, &mut rng, guarded);
                    pastes_kept += u64::from(what.starts_with("paste kept"));
                    rooms.log.push(format!(
                        "tab {client} ({}): {what}",
                        if tabs[k].online { "online" } else { "offline" }
                    ));
                    undos += u64::from(tabs[k].undo.undo_stack().len() < undo_before);
                    if tabs[k].online {
                        send(&mut tabs[k], &mut rooms, case);
                    }
                }
            }
            for tab in tabs.iter_mut().filter(|t| t.online) {
                hear(tab, &rooms);
            }
        }
        for tab in tabs.iter_mut() {
            if !tab.online {
                tab.online = true;
                send(tab, &mut rooms, case);
            }
        }
        late += rooms.late;
        hidden += rooms.hidden;
        rekeyed += rooms.rekeyed;
        for tab in tabs.iter_mut() {
            hear(tab, &rooms);
        }
        collected += rooms.fold(&tabs, case);
        since += rooms.since;
        let fresh = common::doc(&common::state(&rooms.s), 9_999);
        let expected = blocks::blocks_json(&rooms.r.transact());
        for doc in tabs.iter().map(|t| &t.doc).chain([&rooms.s, &fresh]) {
            let txn = doc.transact();
            blocks::check(&txn).unwrap();
            assert!(!ydoc::has_pending(&txn), "case {case}: pending");
            assert_eq!(blocks::blocks_json(&txn), expected, "case {case}: diverged");
        }
    }
    eprintln!(
        "gc fuzz (keyed {keyed}, guarded {guarded}): {cases} cases, {folds} folds that collected, {collected} units at the last folds, {undos} undos, {since} updates into blocks deleted since, {days} days passed, {expired} sessions ended away, {late} late merges hiding {hidden} blocks and re-keying {rekeyed}, {pastes_kept} pastes kept their id"
    );
    assert!(folds > 0 && undos > 0);
}

fn debug_named(s: &Doc, r: &Doc, update: &yrs::Update) {
    use yrs::UpdateBlock;
    let st = s.transact();
    let rt = r.transact();
    for block in update.blocks() {
        let UpdateBlock::Item(item) = block else {
            continue;
        };
        let parent = match item.update_parent() {
            yrs::block::UpdateParent::Item(id) => Some(*id),
            _ => None,
        };
        for (what, id) in [
            ("origin", item.origin().copied()),
            ("right", item.right_origin().copied()),
            ("parent", parent),
        ] {
            let Some(id) = id else { continue };
            if matches!(st.store().get_block_range(&id), Some((_, None))) {
                let r_item = rt.store().get_item(&id);
                let r_item = r_item.map(|i| {
                    let mut key = None;
                    let mut at = Some(i);
                    while let Some(x) = at {
                        if let Some(k) = x.parent_sub()
                            && x.parent_branch().is_some_and(|b| b.item().is_none())
                        {
                            key = Some(k.clone());
                        }
                        at = x.parent_branch().and_then(|b| b.item());
                    }
                    (i, key)
                });
                let r_item = r_item.map(|(i, key)| (key, i));
                eprintln!(
                    "item {:?} names {what} {id:?} collected in S; in R: {:?}",
                    item.id(),
                    r_item.map(|(key, i)| (
                        key,
                        i.is_deleted(),
                        i.parent_sub().cloned(),
                        format!("{:?}", i.content())
                            .chars()
                            .take(60)
                            .collect::<String>(),
                        i.parent_branch().map(|b| b.id())
                    ))
                );
            }
        }
    }
}
