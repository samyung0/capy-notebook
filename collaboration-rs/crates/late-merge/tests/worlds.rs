//! The tombstone prototype's measurement of tabs that come and go (gcviews),
//! on the room's Plate mapping. A server S and up to eight tabs edit a note;
//! tabs go offline and keep editing, come back, leave, and come back after
//! leaving. S collects in place at every leave and idle moment, at the
//! window of the oldest state a counted tab acknowledged (now when none is),
//! keeping what counted sessions deleted. A tab some collection did not
//! count since its last sync takes the late path: it merges its unsent edits
//! against S's document, S takes the update, and the tab goes on with a new
//! document and client id. Every tab
//! has a twin in a reference room R that never collects.
//!
//! Per seed: every replica converges with nothing pending, every collected
//! state loads to the value collected, no merge is refused, and a merge from
//! equal states (S = R, tab = twin) never adds or loses a text character
//! (ties may order them differently). Sending the merged update again, or
//! merging again, changes nothing.
//!
//! Each late merge is also run re-authored under the tab's next client id
//! (edits under an id the room does not hold): that update holds structs
//! under the new id only, applies with nothing pending, and gives the room
//! the text the merge under the tab's own ids gives (ties aside).
//!
//! LATE_MERGE_SEEDS seeds (default 200) from LATE_MERGE_FIRST_SEED (0); the
//! prototype measured 4,000.
#![allow(clippy::unwrap_used)] // Tests panic on a broken case.

mod support;

use serde_json::Value;
use support::collect::collect;
use support::note::{Note, edit, sync};
use support::rng::Rng;
use yrs::{ID, IdSet, ReadTxn, StateVector, Transact};

#[derive(PartialEq, Clone, Copy)]
enum St {
    Online,
    Offline(usize),
    Left,
}

struct Tab {
    g: Note,
    r: Note,
    st: St,
    /// S's state vector and delete set at the tab's last sync.
    seen: (StateVector, IdSet, usize),
    /// A collection ran without counting this tab since its last sync.
    excluded: bool,
    /// What this tab's session deleted.
    held: IdSet,
}

/// How long an offline tab is still counted.
const CAP: usize = 25;

#[derive(Default)]
struct Tally {
    seeds: u64,
    converged: u64,
    collections: u64,
    load_differs: u64,
    raw_rejoins: u64,
    late_rejoins: u64,
    /// Merges from equal states: equal after, reordered only, same text
    /// characters with other marks or splits, text characters differ.
    merges: [u64; 4],
    /// Re-authored merges against the own-id merge, the same four ways.
    reauthored: [u64; 4],
    refused: Vec<String>,
    failures: Vec<String>,
}

fn delete_set(note: &Note) -> IdSet {
    note.doc.transact().snapshot().delete_set
}

/// Units in `after` that `before` lacks.
fn added(before: &IdSet, after: &IdSet) -> IdSet {
    let mut out = IdSet::new();
    for (client, ranges) in after.iter() {
        for r in ranges.iter() {
            for clock in r.clone() {
                let u = ID::new(*client, clock);
                if !before.contains(&u) {
                    out.insert(u, 1);
                }
            }
        }
    }
    out
}

/// The text characters of a value, sorted.
fn text_chars(value: &str) -> Vec<char> {
    fn walk(v: &Value, out: &mut Vec<char>) {
        match v {
            Value::Object(m) => {
                for (k, x) in m {
                    match (k.as_str(), x) {
                        ("text", Value::String(t)) => out.extend(t.chars()),
                        _ => walk(x, out),
                    }
                }
            }
            Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(&serde_json::from_str(value).unwrap(), &mut out);
    out.sort_unstable();
    out
}

fn sorted_chars(value: &str) -> Vec<char> {
    let mut chars: Vec<char> = value.chars().collect();
    chars.sort_unstable();
    chars
}

/// 0 equal, 1 reordered only, 2 the same text characters, 3 they differ.
fn compare(a: &str, b: &str) -> usize {
    if a == b {
        0
    } else if sorted_chars(a) == sorted_chars(b) {
        1
    } else if text_chars(a) == text_chars(b) {
        2
    } else {
        3
    }
}

struct World {
    s: Note,
    r: Note,
    tabs: Vec<Tab>,
    tick: usize,
    next_client: u64,
}

impl World {
    fn snapshot(&mut self) -> (StateVector, IdSet, usize) {
        self.tick += 1;
        let txn = self.s.doc.transact();
        (txn.state_vector(), txn.snapshot().delete_set, self.tick)
    }

    fn join(&mut self) {
        let c = self.next_client;
        self.next_client += 1;
        let g = Note::load(c, &format!("c{c}-"), &self.s.state());
        let mut r = Note::load(c, &format!("c{c}-"), &self.r.state());
        r.next_id = g.next_id;
        let seen = self.snapshot();
        self.tabs.push(Tab {
            g,
            r,
            st: St::Online,
            seen,
            excluded: false,
            held: IdSet::new(),
        });
    }

    fn collect(&mut self, now: usize, tally: &mut Tally) {
        let counted: Vec<usize> = (0..self.tabs.len())
            .filter(|&i| match self.tabs[i].st {
                St::Online => true,
                St::Offline(since) => now - since <= CAP,
                St::Left => false,
            })
            .collect();
        let oldest = counted
            .iter()
            .map(|&i| &self.tabs[i].seen)
            .min_by_key(|seen| seen.2)
            .cloned();
        let window = match oldest {
            Some(seen) => seen,
            None => self.snapshot(),
        };
        let mut held = IdSet::new();
        for &i in &counted {
            held.merge_with(self.tabs[i].held.clone());
        }
        let state = collect(&self.s.doc, &window.0, &window.1, &held);
        for (i, tab) in self.tabs.iter_mut().enumerate() {
            if !counted.contains(&i) {
                tab.excluded = true;
            }
        }
        tally.collections += 1;
        let before = self.s.value();
        let next_id = self.s.next_id;
        self.s = Note::load(1, "s", &state);
        self.s.next_id = next_id;
        if self.s.value() != before || self.s.pending() {
            tally.load_differs += 1;
        }
    }

    fn rejoin(&mut self, i: usize, tally: &mut Tally, seed: u64) {
        let tab = &self.tabs[i];
        if tab.excluded {
            tally.late_rejoins += 1;
            let comparable = self.s.value() == self.r.value() && tab.g.value() == tab.r.value();
            let (old, current) = (tab.g.state(), self.s.state());
            // Re-authored under the id the new session gets below.
            let reauthored = late_merge::reauthor(&old, &current, self.next_client);
            match late_merge::merge(&old, &current) {
                Ok(merged) => {
                    let update = merged.update;
                    match &reauthored {
                        Ok(reauthored) => {
                            let mut copy = Note::load(u64::from(u32::MAX), "x", &current);
                            copy.receive(&reauthored.update);
                            let foreign = ydoc::decode(&reauthored.update).is_ok_and(|u| {
                                u.blocks().any(|b| match b {
                                    yrs::UpdateBlock::Item(item) => {
                                        item.id().client.get() != self.next_client
                                    }
                                    _ => true,
                                })
                            });
                            if copy.pending() || foreign {
                                tally.failures.push(format!(
                                    "seed {seed}: a re-authored merge is pending or not all under the new id"
                                ));
                            }
                            let mut own = Note::load(u64::from(u32::MAX), "x", &current);
                            own.receive(&update);
                            tally.reauthored[compare(&copy.value(), &own.value())] += 1;
                        }
                        Err(error) => tally
                            .refused
                            .push(format!("seed {seed}: re-authored: {error}")),
                    }
                    self.s.receive(&update);
                    // Sent again, or merged again after the room took it: no change.
                    let taken = self.s.state();
                    self.s.receive(&update);
                    let again = late_merge::merge(&old, &taken);
                    match &again {
                        Ok(again) => self.s.receive(&again.update),
                        Err(error) => tally
                            .failures
                            .push(format!("seed {seed}: a second merge was refused: {error}")),
                    }
                    let carried = again.as_ref().is_ok_and(|again| {
                        ydoc::decode(&again.update).is_ok_and(|u| u.blocks().next().is_some())
                    });
                    if self.s.state() != taken || carried {
                        tally
                            .failures
                            .push(format!("seed {seed}: a repeat changed the room"));
                    }
                }
                Err(error) => tally.refused.push(format!("seed {seed}: {error}")),
            }
            // The swap: a new document and client id, its Undo empty.
            let c = self.next_client;
            self.next_client += 1;
            let tab = &mut self.tabs[i];
            let (next_id, prefix) = (tab.g.next_id, tab.g.id_prefix.clone());
            tab.g = Note::load(c, &prefix, &self.s.state());
            tab.g.next_id = next_id;
            tab.held = IdSet::new();
            sync(&tab.r, &mut self.r);
            sync(&self.r, &mut tab.r);
            if comparable {
                tally.merges[compare(&self.s.value(), &self.r.value())] += 1;
            }
        } else {
            tally.raw_rejoins += 1;
            let tab = &mut self.tabs[i];
            sync(&tab.g, &mut self.s);
            sync(&self.s, &mut tab.g);
            sync(&tab.r, &mut self.r);
            sync(&self.r, &mut tab.r);
        }
        let seen = self.snapshot();
        let tab = &mut self.tabs[i];
        tab.st = St::Online;
        tab.excluded = false;
        tab.seen = seen;
    }
}

fn run(seed: u64, tally: &mut Tally) {
    let mut rng = Rng::new(seed);
    let mut s = Note::new(1, "s");
    for k in 0..3 {
        let text = format!("paragraph {k} has some words in it");
        let n = s.root.children.len() - 1;
        let len = s.block_chars(n);
        let ops = s.insert_ops(n, len, &text);
        s.apply(&ops);
        let ops = s.split_ops(n, len + text.chars().count());
        s.apply(&ops);
    }
    let mermaid = s.mermaid();
    s.apply(&[notes::slate::Operation::InsertNode {
        path: vec![1],
        node: mermaid,
    }]);
    let r = Note::load(1, "s", &s.state());
    let mut world = World {
        s,
        r,
        tabs: Vec::new(),
        tick: 0,
        next_client: 10,
    };
    let mut twins_agree = true;
    for _ in 0..3 {
        world.join();
    }
    let steps = 60 + rng.below(60);
    for now in 1..=steps {
        let open: Vec<usize> = (0..world.tabs.len())
            .filter(|&i| world.tabs[i].st != St::Left)
            .collect();
        match rng.below(100) {
            // An open tab edits (an offline one locally).
            0..=54 if !open.is_empty() => {
                let i = open[rng.below(open.len())];
                let tab = &mut world.tabs[i];
                let before = delete_set(&tab.g);
                for ops in edit(&mut tab.g, &mut rng) {
                    if twins_agree && tab.r.try_apply(&ops).is_err() {
                        twins_agree = false;
                    }
                }
                let deleted = added(&before, &delete_set(&tab.g));
                tab.held.merge_with(deleted);
                if tab.st == St::Online {
                    let World { s, r, tabs, .. } = &mut world;
                    sync(&tabs[i].g, s);
                    sync(&tabs[i].r, r);
                    for other in tabs.iter_mut() {
                        if other.st == St::Online {
                            sync(s, &mut other.g);
                            sync(r, &mut other.r);
                        }
                    }
                    for k in 0..world.tabs.len() {
                        if world.tabs[k].st == St::Online {
                            let seen = world.snapshot();
                            world.tabs[k].seen = seen;
                        }
                    }
                }
            }
            // An online tab goes offline.
            55..=64 => {
                let on: Vec<usize> = (0..world.tabs.len())
                    .filter(|&i| world.tabs[i].st == St::Online)
                    .collect();
                if !on.is_empty() {
                    world.tabs[on[rng.below(on.len())]].st = St::Offline(now);
                }
            }
            // An offline tab, or one that left (a back/forward cache), comes back.
            65..=77 => {
                let away: Vec<usize> = (0..world.tabs.len())
                    .filter(|&i| world.tabs[i].st != St::Online)
                    .collect();
                if !away.is_empty() {
                    world.rejoin(away[rng.below(away.len())], tally, seed);
                }
            }
            // An online tab leaves cleanly; the room collects.
            78..=89 => {
                let on: Vec<usize> = (0..world.tabs.len())
                    .filter(|&i| world.tabs[i].st == St::Online)
                    .collect();
                if !on.is_empty() {
                    world.tabs[on[rng.below(on.len())]].st = St::Left;
                    world.collect(now, tally);
                }
            }
            90..=94 if world.tabs.len() < 8 => world.join(),
            // The room is idle a moment: it collects.
            _ => world.collect(now, tally),
        }
    }
    for i in 0..world.tabs.len() {
        if matches!(world.tabs[i].st, St::Offline(_)) {
            world.rejoin(i, tally, seed);
        }
    }
    let World { s, r, tabs, .. } = &mut world;
    for tab in tabs.iter_mut().filter(|t| t.st == St::Online) {
        sync(s, &mut tab.g);
        sync(r, &mut tab.r);
    }
    let fresh = Note::load(99, "f", &s.state());
    let mut values = vec![s.value(), fresh.value()];
    let mut pending = s.pending() || fresh.pending();
    for tab in tabs.iter().filter(|t| t.st == St::Online) {
        values.push(tab.g.value());
        pending |= tab.g.pending();
    }
    tally.seeds += 1;
    if values.iter().all(|v| *v == values[0]) && !pending {
        tally.converged += 1;
    } else {
        tally.failures.push(format!("seed {seed}: replicas differ"));
    }
}

fn env(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[test]
fn late_tabs_merge_without_losing_or_doubling_text() {
    let seeds = env("LATE_MERGE_SEEDS", 200);
    let first = env("LATE_MERGE_FIRST_SEED", 0);
    let mut tally = Tally::default();
    for seed in first..first + seeds {
        run(seed, &mut tally);
    }
    eprintln!(
        "seeds {} converged {} | collections {} load-differs {} | rejoins raw {} late {} | merges from equal states: equal {}, reordered {}, same text {}, text differs {} | re-authored vs own ids: equal {}, reordered {}, same text {}, text differs {} | refused {}",
        tally.seeds,
        tally.converged,
        tally.collections,
        tally.load_differs,
        tally.raw_rejoins,
        tally.late_rejoins,
        tally.merges[0],
        tally.merges[1],
        tally.merges[2],
        tally.merges[3],
        tally.reauthored[0],
        tally.reauthored[1],
        tally.reauthored[2],
        tally.reauthored[3],
        tally.refused.len(),
    );
    assert!(tally.late_rejoins > 0, "no tab took the late path");
    assert_eq!(tally.refused, Vec::<String>::new(), "refused merges");
    assert_eq!(tally.failures, Vec::<String>::new());
    assert_eq!(
        tally.load_differs, 0,
        "a collected state loads to another value"
    );
    assert_eq!(tally.merges[3], 0, "a merge lost or doubled text");
    assert_eq!(
        tally.reauthored[3], 0,
        "a re-authored merge lost or doubled text"
    );
}
