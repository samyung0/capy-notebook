#![allow(clippy::unwrap_used)] // Tests panic on a broken run.
//! The in-place collection (`ydoc::gc`) against tabs that come and go: a
//! server S and up to eight tabs edit a Plate note through the room's
//! slate-yjs mapping. Tabs join, edit online, go offline and keep editing,
//! come back and send their drafts, leave for good, and undo or redo their
//! own steps. Every tab has a twin editing a room R that never collects.
//!
//! S collects at every leave and idle moment, as a fold does, and the result
//! replaces S at once (every later joiner loads it):
//! * counted tabs are the online ones and those offline for at most 25 steps
//!   (the cap);
//! * the window is the newest of the last four stored snapshots that every
//!   counted tab has reached, or S itself when no tab is counted, and each
//!   collection stores S as the next snapshot;
//! * H is what the counted tabs' sessions deleted (their Undo may restore it).
//!
//! A tab some collection did not count (it left, or stayed offline past the
//! cap) comes back on the late path. The late merge is not exercised here: the
//! tab and its twin both drop their unsent edits and load the current state
//! under a new client id, with an empty Undo stack. Every other tab comes back
//! raw and sends its drafts.
//!
//! Checked for every seed:
//! * every collected state loads to the value collected, with the same state
//!   vector and nothing pending;
//! * at the end every tab, S and a fresh load of S are equal, with nothing
//!   pending;
//! * S equals R: an Undo after a collection restores what it restores
//!   without one.
//!
//! A sample of collected states, with the state each was collected from, is
//! loaded by Yjs (`gc_yjs_load.mjs`, the browser's Yjs from the repository's
//! node_modules), which must read both alike; without Node the check skips
//! unless CAPY_IT_REQUIRED is set (CI).
//!
//! `GC_SEEDS` (200 by default) and `GC_FIRST_SEED` (0) choose the seeds; the
//! manual run takes 4,000 in release (`--release`).

use std::collections::{BTreeMap, HashSet};

use base64::Engine;
use notes::plate::{self, CONTENT_ROOT};
use notes::slate::{self, Operation, Root};
use notes::slate_yjs;
use serde_json::{Map, Value, json};
use ydoc::gc::{self, Window};
use yrs::undo::{Options, UndoManager};
use yrs::{Doc, IdSet, Origin, ReadTxn, StateVector, Transact};

/// The origin of a replica's own edits: its Undo tracks only these.
const LOCAL: &str = "local";
const MARKS: [&str; 3] = ["bold", "italic", "code"];
/// Window snapshots kept, as the fold keeps them.
const WINDOWS_KEPT: usize = 4;
/// Collected states sent to Yjs at most.
const YJS_SAMPLE: usize = 600;
/// Steps an offline tab stays counted.
const CAP: usize = 25;

/// A small deterministic PRNG (splitmix64), so a seed replays.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed ^ 0x9E37_79B9_7F4A_7C15)
    }
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
    fn chance(&mut self, p: f64) -> bool {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64 <= p
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

fn paragraph(id: &str, text: &str) -> Value {
    json!({"type": "p", "id": id, "children": [{"text": text}]})
}

/// A note replica: a document and its Slate value, edited only through ops.
struct Note {
    doc: Doc,
    root: Root,
    next_id: u64,
    prefix: String,
}

impl Note {
    /// An empty note: one empty paragraph, as a new Plate note starts.
    fn new(client: u64, prefix: &str) -> Self {
        let doc = Doc::with_options(ydoc::doc_options(client));
        doc.get_or_insert_text(CONTENT_ROOT);
        let mut note = Note {
            doc,
            root: Root::default(),
            next_id: 0,
            prefix: prefix.to_owned(),
        };
        let id = note.new_id();
        note.apply(&[Operation::InsertNode {
            path: vec![0],
            node: paragraph(&id, ""),
        }]);
        note
    }

    fn load(client: u64, prefix: &str, state: &[u8]) -> Self {
        let doc = Doc::with_options(ydoc::doc_options(client));
        doc.get_or_insert_text(CONTENT_ROOT);
        doc.transact_mut()
            .apply_update(ydoc::decode(state).unwrap())
            .unwrap();
        let mut note = Note {
            doc,
            root: Root::default(),
            next_id: 0,
            prefix: prefix.to_owned(),
        };
        note.refresh();
        note
    }

    fn refresh(&mut self) {
        self.root = Root::new(plate::value(&self.doc.transact()).unwrap());
    }

    fn new_id(&mut self) -> String {
        self.next_id += 1;
        format!("{}{}", self.prefix, self.next_id)
    }

    /// One local transaction of `ops`.
    fn apply(&mut self, ops: &[Operation]) {
        let mut txn = self.doc.transact_mut_with(LOCAL);
        let y_root = plate::content_root(&txn).unwrap();
        slate_yjs::apply_ops(&mut txn, y_root, &mut self.root, ops).unwrap();
    }

    fn state(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    fn value(&self) -> String {
        canonical(&Value::Array(plate::value(&self.doc.transact()).unwrap()))
    }

    fn pending(&self) -> bool {
        ydoc::has_pending(&self.doc.transact())
    }

    fn delete_set(&self) -> IdSet {
        self.doc.transact().snapshot().delete_set
    }

    /* ------------------------------------------------- random note edits */

    fn is_text_block(node: &Value) -> bool {
        node.get("type")
            .and_then(Value::as_str)
            .is_some_and(|t| matches!(t, "p" | "h1" | "h2" | "h3" | "blockquote"))
    }

    fn text_blocks(&self) -> Vec<usize> {
        (0..self.root.children.len())
            .filter(|&i| Self::is_text_block(&self.root.children[i]))
            .collect()
    }

    fn chars(&self, b: usize) -> usize {
        slate::children(&self.root.children[b])
            .iter()
            .map(|leaf| slate::text(leaf).chars().count())
            .sum()
    }

    /// The (leaf, UTF-16 offset) of a char offset in a block; at a leaf
    /// boundary the left leaf.
    fn leaf_at(node: &Value, chars: usize) -> (usize, usize) {
        let leaves = slate::children(node);
        let mut left = chars;
        for (i, leaf) in leaves.iter().enumerate() {
            let text = slate::text(leaf);
            let n = text.chars().count();
            if left <= n {
                return (i, text.chars().take(left).map(char::len_utf16).sum());
            }
            left -= n;
        }
        let last = leaves.len() - 1;
        (last, slate::len16(slate::text(&leaves[last])))
    }

    fn marks(leaf: &Value) -> Map<String, Value> {
        let mut marks = leaf.as_object().cloned().unwrap_or_default();
        marks.remove("text");
        marks
    }

    /// Enter at a char offset of top-level block `b`: Slate's two splits.
    fn split_ops(&mut self, b: usize, chars: usize) -> Vec<Operation> {
        let id = self.new_id();
        let node = &self.root.children[b];
        let (leaf, offset) = Self::leaf_at(node, chars);
        let mut props = node.as_object().cloned().unwrap_or_default();
        props.remove("children");
        props.insert("id".into(), Value::String(id));
        props.insert("type".into(), Value::String("p".into()));
        vec![
            Operation::SplitNode {
                path: vec![b, leaf],
                position: offset,
                properties: Self::marks(&slate::children(node)[leaf]),
            },
            Operation::SplitNode {
                path: vec![b],
                position: leaf + 1,
                properties: props,
            },
        ]
    }

    /// Backspace at the start of block `b` (after a text block): the element
    /// merge, then the text merge when the boundary leaves' marks match.
    fn merge_ops(&self, b: usize) -> Vec<Operation> {
        let prev = &self.root.children[b - 1];
        let node = &self.root.children[b];
        let n = slate::children(prev).len();
        let mut props = node.as_object().cloned().unwrap_or_default();
        props.remove("children");
        let mut ops = vec![Operation::MergeNode {
            path: vec![b],
            position: n,
            properties: props,
        }];
        let last = &slate::children(prev)[n - 1];
        let first = &slate::children(node)[0];
        if Self::marks(last) == Self::marks(first) {
            ops.push(Operation::MergeNode {
                path: vec![b - 1, n],
                position: slate::len16(slate::text(last)),
                properties: Self::marks(first),
            });
        }
        ops
    }

    /// Removes `count` chars from a char offset of block `b`, leaf by leaf
    /// from the end.
    fn remove_ops(&self, b: usize, chars: usize, count: usize) -> Vec<Operation> {
        let mut spans = Vec::new();
        let mut start = 0;
        for (i, leaf) in slate::children(&self.root.children[b]).iter().enumerate() {
            let text = slate::text(leaf);
            let n = text.chars().count();
            let (a, z) = (chars.max(start), (chars + count).min(start + n));
            if a < z {
                let from = text.chars().take(a - start).map(char::len_utf16).sum();
                let removed = text.chars().skip(a - start).take(z - a).collect();
                spans.push((i, from, removed));
            }
            start += n;
        }
        spans
            .into_iter()
            .rev()
            .map(|(i, offset, text)| Operation::RemoveText {
                path: vec![b, i],
                offset,
                text,
            })
            .collect()
    }

    fn insert_ops(&self, b: usize, chars: usize, text: &str) -> Vec<Operation> {
        let (leaf, offset) = Self::leaf_at(&self.root.children[b], chars);
        vec![Operation::InsertText {
            path: vec![b, leaf],
            offset,
            text: text.to_owned(),
        }]
    }

    /// Marks a char range of one leaf of block `b` on or off.
    fn format_ops(
        &self,
        b: usize,
        chars: usize,
        count: usize,
        mark: &str,
        on: bool,
    ) -> Vec<Operation> {
        let node = &self.root.children[b];
        let (leaf, start) = Self::leaf_at(node, chars);
        let leaf_node = &slate::children(node)[leaf];
        let text = slate::text(leaf_node);
        let len = slate::len16(text);
        let (mut seen, mut end, mut taken) = (0, start, 0);
        for c in text.chars() {
            if seen >= start && taken < count {
                end = seen + c.len_utf16();
                taken += 1;
            }
            seen += c.len_utf16();
        }
        let end = end.min(len);
        if end <= start {
            return Vec::new();
        }
        let marks = Self::marks(leaf_node);
        let mut ops = Vec::new();
        let mut target = leaf;
        if end < len {
            ops.push(Operation::SplitNode {
                path: vec![b, leaf],
                position: end,
                properties: marks.clone(),
            });
        }
        if start > 0 {
            ops.push(Operation::SplitNode {
                path: vec![b, leaf],
                position: start,
                properties: marks.clone(),
            });
            target = leaf + 1;
        }
        let mut old = Map::new();
        if let Some(value) = marks.get(mark) {
            old.insert(mark.into(), value.clone());
        }
        let mut new = Map::new();
        new.insert(
            mark.into(),
            if on { Value::Bool(true) } else { Value::Null },
        );
        ops.push(Operation::SetNode {
            path: vec![b, target],
            properties: old,
            new_properties: new,
        });
        ops
    }

    /// Slate's normalization after a mark change: equal neighbours merge.
    fn normalize_leaves(&self, b: usize) -> Vec<Operation> {
        let leaves = slate::children(&self.root.children[b]);
        (1..leaves.len())
            .rev()
            .filter(|&i| Self::marks(&leaves[i - 1]) == Self::marks(&leaves[i]))
            .map(|i| Operation::MergeNode {
                path: vec![b, i],
                position: slate::len16(slate::text(&leaves[i - 1])),
                properties: Self::marks(&leaves[i]),
            })
            .collect()
    }

    fn mermaid(&mut self) -> Value {
        let id = self.new_id();
        json!({"type": "mermaid", "id": id, "source": "graph TD\n  A --> B\n", "children": [{"text": ""}]})
    }

    /// One random edit's operations against the note as it is (none when the
    /// pick does not apply): typing, deletion, Enter, Backspace-merge, marks,
    /// block types and attributes, removals, moves, embeds, chart values and
    /// a Mermaid source.
    fn random_ops(&mut self, rng: &mut Rng) -> Vec<Operation> {
        let blocks = self.text_blocks();
        let all = self.root.children.len();
        if blocks.is_empty() || all == 0 {
            let id = self.new_id();
            return vec![Operation::InsertNode {
                path: vec![all],
                node: paragraph(&id, "fresh"),
            }];
        }
        let b = *rng.pick(&blocks);
        let n = self.chars(b);
        match rng.below(100) {
            0..=29 => {
                let at = rng.below(n + 1);
                let text: String = (0..1 + rng.below(6))
                    .map(|_| (b'a' + rng.below(26) as u8) as char)
                    .collect();
                self.insert_ops(b, at, &text)
            }
            30..=51 if n > 0 => {
                let at = rng.below(n);
                let count = 1 + rng.below((n - at).min(8));
                self.remove_ops(b, at, count)
            }
            52..=59 => {
                let at = rng.below(n + 1);
                self.split_ops(b, at)
            }
            60..=66 => {
                let k = blocks.iter().position(|&x| x == b).unwrap();
                if k > 0 && blocks[k - 1] + 1 == b {
                    self.merge_ops(b)
                } else {
                    Vec::new()
                }
            }
            67..=79 if n >= 2 => {
                let start = rng.below(n - 1);
                let count = 1 + rng.below((n - start).min(10));
                let mark = *rng.pick(&MARKS);
                self.format_ops(b, start, count, mark, rng.chance(0.7))
            }
            80..=85 => {
                let target = rng.below(all);
                let old = self.root.children[target]
                    .get("type")
                    .cloned()
                    .unwrap_or(Value::Null);
                if old == "mermaid" || old == "chart" {
                    return Vec::new();
                }
                let (key, value) = match rng.below(3) {
                    0 => ("type", json!(*rng.pick(&["p", "h2", "blockquote"]))),
                    1 => ("indent", json!(1 + rng.below(3))),
                    _ => ("align", json!(*rng.pick(&["center", "right"]))),
                };
                let mut properties = Map::new();
                if let Some(v) = self.root.children[target].get(key) {
                    properties.insert(key.into(), v.clone());
                }
                let mut new_properties = Map::new();
                new_properties.insert(key.into(), value);
                vec![Operation::SetNode {
                    path: vec![target],
                    properties,
                    new_properties,
                }]
            }
            86..=89 if all >= 3 => {
                let target = rng.below(all);
                vec![Operation::RemoveNode {
                    path: vec![target],
                    node: self.root.children[target].clone(),
                }]
            }
            90..=92 => {
                let (from, to) = (rng.below(all), rng.below(all));
                if from == to {
                    return Vec::new();
                }
                vec![Operation::MoveNode {
                    path: vec![from],
                    new_path: vec![to],
                }]
            }
            93..=95 => {
                let at = rng.below(all + 1);
                let id = self.new_id();
                let node = match rng.below(3) {
                    0 => self.mermaid(),
                    1 => {
                        json!({"type": "chart", "id": id, "block": {"kind": "bar", "title": "t", "series": [{"id": "a", "name": "A", "values": [1, 2]}, {"id": "b", "name": "B", "values": [3]}]}, "children": [{"text": ""}]})
                    }
                    _ => paragraph(&id, "new block"),
                };
                vec![Operation::InsertNode {
                    path: vec![at],
                    node,
                }]
            }
            96 | 97 => {
                let charts: Vec<usize> = (0..all)
                    .filter(|&i| self.root.children[i]["type"] == "chart")
                    .collect();
                if charts.is_empty() {
                    return Vec::new();
                }
                let c = *rng.pick(&charts);
                let old = self.root.children[c]["block"].clone();
                let mut block = old.clone();
                let pick = rng.below(3);
                if pick == 0 {
                    block["title"] = json!(format!("t{}", rng.below(100)));
                } else {
                    let series = block["series"].as_array_mut().unwrap();
                    if pick == 1 {
                        if !series.is_empty() {
                            let k = rng.below(series.len());
                            series[k]["values"] = json!([rng.below(9), rng.below(9)]);
                        }
                    } else if rng.chance(0.5) && !series.is_empty() {
                        let k = rng.below(series.len());
                        series.remove(k);
                    } else {
                        let n = rng.below(1000);
                        series.push(json!({"id": format!("s{n}"), "name": "N", "values": [n % 7]}));
                    }
                }
                let mut properties = Map::new();
                properties.insert("block".into(), old);
                let mut new_properties = Map::new();
                new_properties.insert("block".into(), block);
                vec![Operation::SetNode {
                    path: vec![c],
                    properties,
                    new_properties,
                }]
            }
            98 | 99 => {
                let mermaids: Vec<usize> = (0..all)
                    .filter(|&i| self.root.children[i]["type"] == "mermaid")
                    .collect();
                if mermaids.is_empty() {
                    return Vec::new();
                }
                let m = *rng.pick(&mermaids);
                let old = self.root.children[m]["source"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                let mut chars: Vec<char> = old.chars().collect();
                let at = rng.below(chars.len() + 1);
                if rng.chance(0.4) && at < chars.len() {
                    chars.remove(at);
                } else {
                    chars.insert(at, (b'a' + rng.below(26) as u8) as char);
                }
                let mut properties = Map::new();
                properties.insert("source".into(), Value::String(old));
                let mut new_properties = Map::new();
                new_properties.insert("source".into(), Value::String(chars.into_iter().collect()));
                vec![Operation::SetNode {
                    path: vec![m],
                    properties,
                    new_properties,
                }]
            }
            _ => Vec::new(),
        }
    }

    /// A random edit, plus Slate's leaf normalization after a mark change.
    /// Returns the operation batches, to replay on the twin.
    fn edit(&mut self, rng: &mut Rng) -> Vec<Vec<Operation>> {
        let ops = self.random_ops(rng);
        if ops.is_empty() {
            return Vec::new();
        }
        self.apply(&ops);
        let mut batches = vec![ops.clone()];
        if let Some(Operation::SetNode { path, .. }) = ops.last()
            && path.len() == 2
        {
            let normalize = self.normalize_leaves(path[0]);
            if !normalize.is_empty() {
                self.apply(&normalize);
                batches.push(normalize);
            }
        }
        batches
    }
}

fn canonical(v: &Value) -> String {
    match v {
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(o) => {
            let sorted: BTreeMap<&String, &Value> = o.iter().collect();
            let fields: Vec<String> = sorted
                .iter()
                .map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap(), canonical(v)))
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        other => serde_json::to_string(other).unwrap(),
    }
}

/// Sends `from`'s units `to` lacks.
fn sync(from: &Note, to: &mut Note) {
    let sv = to.doc.transact().state_vector();
    let diff = from.doc.transact().encode_state_as_update_v1(&sv);
    to.doc
        .transact_mut()
        .apply_update(ydoc::decode(&diff).unwrap())
        .unwrap();
    to.refresh();
}

fn undo_manager(note: &Note) -> UndoManager<()> {
    let mut undo = UndoManager::with_options(Options {
        capture_timeout_millis: 0,
        tracked_origins: HashSet::from([Origin::from(LOCAL)]),
        ..Options::default()
    });
    undo.expand_scope(&note.doc, &note.doc.get_or_insert_text(CONTENT_ROOT));
    undo
}

#[derive(PartialEq, Clone, Copy)]
enum St {
    Online,
    /// Offline since this step.
    Offline(usize),
    Left,
}

struct Tab {
    /// The tab against S, and its twin against R.
    g: Note,
    r: Note,
    prefix: String,
    st: St,
    /// S's stored version at the tab's last sync from S.
    reached: i64,
    /// A collection ran without counting this tab since its last sync.
    excluded: bool,
    ug: UndoManager<()>,
    ur: UndoManager<()>,
    /// What this tab's session deleted: its Undo may restore any of it.
    held: IdSet,
}

impl Tab {
    fn counted(&self, now: usize) -> bool {
        match self.st {
            St::Online => true,
            St::Offline(since) => now - since <= CAP,
            St::Left => false,
        }
    }
}

#[derive(Default)]
struct Tally {
    seeds: u64,
    converged: u64,
    equals_reference: u64,
    collections: u64,
    units: u64,
    undos: u64,
    raw_rejoins: u64,
    late_rejoins: u64,
    load_differs: u64,
    failures: Vec<String>,
    /// (state collected from, collected state), for Yjs.
    sample: Vec<(Vec<u8>, Vec<u8>)>,
}

struct World {
    s: Note,
    r: Note,
    /// S's stored version: one more for every update a tab stores.
    version: i64,
    windows: Vec<Window>,
    tabs: Vec<Tab>,
    next_client: u64,
    /// Every tab and its twin applied the same edits.
    twins_agree: bool,
}

impl World {
    fn join(&mut self) {
        let c = self.next_client;
        self.next_client += 1;
        let prefix = format!("c{c}-");
        let g = Note::load(c, &prefix, &self.s.state());
        let r = Note::load(c, &prefix, &self.r.state());
        let (ug, ur) = (undo_manager(&g), undo_manager(&r));
        self.tabs.push(Tab {
            g,
            r,
            prefix,
            st: St::Online,
            reached: self.version,
            excluded: false,
            ug,
            ur,
            held: IdSet::new(),
        });
    }

    /// Tab `i` comes back: raw (it sends its drafts) when every collection
    /// since its last sync counted it, else on the late path's stand-in.
    fn rejoin(&mut self, i: usize, tally: &mut Tally) {
        if !self.tabs[i].excluded {
            tally.raw_rejoins += 1;
            self.tabs[i].st = St::Online;
            self.store_from(i);
            return;
        }
        tally.late_rejoins += 1;
        let c = self.next_client;
        self.next_client += 1;
        let t = &mut self.tabs[i];
        let next_id = t.g.next_id;
        t.g = Note::load(c, &t.prefix, &self.s.state());
        t.r = Note::load(c, &t.prefix, &self.r.state());
        (t.g.next_id, t.r.next_id) = (next_id, next_id);
        (t.ug, t.ur) = (undo_manager(&t.g), undo_manager(&t.r));
        t.held = IdSet::new();
        t.st = St::Online;
        t.excluded = false;
        t.reached = self.version;
    }

    /// Tab `i` sends what it has (a store), and hears S back.
    fn store_from(&mut self, i: usize) {
        let t = &mut self.tabs[i];
        sync(&t.g, &mut self.s);
        sync(&t.r, &mut self.r);
        self.version += 1;
        sync(&self.s, &mut t.g);
        sync(&self.r, &mut t.r);
        t.reached = self.version;
    }

    /// A fold: collect S at the window the counted tabs allow, replace S with
    /// the result and store S as the next window candidate.
    fn collect(&mut self, now_step: usize, tally: &mut Tally) {
        for t in self.tabs.iter_mut().filter(|t| !t.counted(now_step)) {
            t.excluded = true;
        }
        let counted: Vec<&Tab> = self.tabs.iter().filter(|t| t.counted(now_step)).collect();
        let now = Window::of(&self.s.doc.transact(), self.version);
        let window = match counted.iter().map(|t| t.reached).min() {
            None => Some(now.clone()),
            Some(reached) => gc::window_for(&self.windows, reached).cloned(),
        };
        if let Some(window) = window {
            let mut held = IdSet::new();
            for t in &counted {
                held.merge_with(t.held.clone());
            }
            let before = self.s.state();
            let collected = gc::collect(&self.s.doc, &window, &held, None);
            let loaded = Note::load(1, "s", &collected.state);
            let same_vector =
                loaded.doc.transact().state_vector() == self.s.doc.transact().state_vector();
            if loaded.value() != self.s.value() || loaded.pending() || !same_vector {
                tally.load_differs += 1;
            }
            tally.collections += 1;
            tally.units += collected.units;
            if collected.units > 0
                && tally.sample.len() < YJS_SAMPLE
                && tally.collections.is_multiple_of(3)
            {
                tally.sample.push((before, collected.state));
            }
            let next_id = self.s.next_id;
            self.s = loaded;
            self.s.next_id = next_id;
        }
        if !self
            .windows
            .iter()
            .any(|w| w.stored_version == now.stored_version)
        {
            self.windows.push(now);
        }
        while self.windows.len() > WINDOWS_KEPT {
            let oldest = (0..self.windows.len())
                .min_by_key(|&k| self.windows[k].stored_version)
                .unwrap();
            self.windows.remove(oldest);
        }
    }
}

fn run(seed: u64, tally: &mut Tally) {
    let mut rng = Rng::new(seed);
    let mut s = Note::new(1, "s");
    for k in 0..3 {
        let text = format!("paragraph {k} has some words in it");
        let n = s.root.children.len() - 1;
        let len = s.chars(n);
        let ops = s.insert_ops(n, len, &text);
        s.apply(&ops);
        let ops = s.split_ops(n, len + text.chars().count());
        s.apply(&ops);
    }
    let m = s.mermaid();
    s.apply(&[Operation::InsertNode {
        path: vec![1],
        node: m,
    }]);
    let r = Note::load(1, "s", &s.state());
    let mut w = World {
        s,
        r,
        version: 0,
        windows: Vec::new(),
        tabs: Vec::new(),
        next_client: 10,
        twins_agree: true,
    };
    for _ in 0..3 {
        w.join();
    }
    let steps = 60 + rng.below(60);
    for now in 1..=steps {
        let roll = rng.below(100);
        let open: Vec<usize> = (0..w.tabs.len())
            .filter(|&i| w.tabs[i].st != St::Left)
            .collect();
        match roll {
            // An open tab edits (an offline one keeps a draft), or undoes or
            // redoes one of its own steps.
            0..=54 if !open.is_empty() => {
                let i = open[rng.below(open.len())];
                let t = &mut w.tabs[i];
                let before = t.g.delete_set();
                if roll >= 45 {
                    let redo = rng.below(10) < 3;
                    let (g, r) = if redo {
                        (t.ug.redo_blocking(), t.ur.redo_blocking())
                    } else {
                        (t.ug.undo_blocking(), t.ur.undo_blocking())
                    };
                    t.g.refresh();
                    t.r.refresh();
                    tally.undos += u64::from(g);
                    w.twins_agree &= g == r;
                } else {
                    for ops in t.g.edit(&mut rng) {
                        t.r.apply(&ops);
                    }
                }
                let deleted = t.g.delete_set().diff(&before);
                t.held.merge_with(deleted);
                if t.st == St::Online {
                    w.store_from(i);
                    for t in w.tabs.iter_mut().filter(|t| t.st == St::Online) {
                        sync(&w.s, &mut t.g);
                        sync(&w.r, &mut t.r);
                        t.reached = w.version;
                    }
                }
            }
            // An online tab goes offline.
            55..=64 => {
                let on: Vec<usize> = (0..w.tabs.len())
                    .filter(|&i| w.tabs[i].st == St::Online)
                    .collect();
                if !on.is_empty() {
                    w.tabs[on[rng.below(on.len())]].st = St::Offline(now);
                }
            }
            // An offline tab comes back, or one that left (a back/forward
            // cache restore).
            65..=77 => {
                let away: Vec<usize> = (0..w.tabs.len())
                    .filter(|&i| w.tabs[i].st != St::Online)
                    .collect();
                if !away.is_empty() {
                    let i = away[rng.below(away.len())];
                    w.rejoin(i, tally);
                }
            }
            // An online tab leaves: its session ends; the room folds.
            78..=89 => {
                let on: Vec<usize> = (0..w.tabs.len())
                    .filter(|&i| w.tabs[i].st == St::Online)
                    .collect();
                if !on.is_empty() {
                    w.tabs[on[rng.below(on.len())]].st = St::Left;
                    w.collect(now, tally);
                }
            }
            90..=94 if w.tabs.len() < 8 => w.join(),
            // The room is idle a moment: it folds.
            _ => w.collect(now, tally),
        }
    }
    // Every tab still away comes back; every open tab syncs.
    for i in 0..w.tabs.len() {
        if matches!(w.tabs[i].st, St::Offline(_)) {
            w.rejoin(i, tally);
        }
    }
    for t in w.tabs.iter_mut().filter(|t| t.st == St::Online) {
        sync(&w.s, &mut t.g);
        sync(&w.r, &mut t.r);
    }
    let fresh = Note::load(99, "f", &w.s.state());
    let mut values = vec![w.s.value(), fresh.value()];
    let mut pending = w.s.pending() || fresh.pending();
    for t in w.tabs.iter().filter(|t| t.st == St::Online) {
        values.push(t.g.value());
        pending |= t.g.pending();
    }
    tally.seeds += 1;
    let converged = !pending && values.iter().all(|v| *v == values[0]);
    let equals_reference = w.twins_agree && values[0] == w.r.value();
    tally.converged += u64::from(converged);
    tally.equals_reference += u64::from(equals_reference);
    if !(converged && equals_reference) && tally.failures.len() < 20 {
        tally.failures.push(format!(
            "seed {seed}: converged {converged}, equals R {equals_reference}"
        ));
    }
}

/// Loads each sampled pair in Yjs; both states must read alike.
fn yjs_check(sample: &[(Vec<u8>, Vec<u8>)]) {
    let required = std::env::var_os("CAPY_IT_REQUIRED").is_some();
    let node = std::process::Command::new("node").arg("--version").output();
    if node.is_err() {
        assert!(!required, "CAPY_IT_REQUIRED is set but node is not on PATH");
        eprintln!("gc_views: node not found, Yjs check skipped");
        return;
    }
    let b64 = base64::engine::general_purpose::STANDARD;
    let pairs: Vec<Value> = sample
        .iter()
        .map(|(before, after)| json!({"before": b64.encode(before), "after": b64.encode(after)}))
        .collect();
    let file = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("gc_views_pairs.json");
    std::fs::write(
        &file,
        serde_json::to_vec(&json!({ "pairs": pairs })).unwrap(),
    )
    .unwrap();
    let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let out = std::process::Command::new("node")
        .arg(crate_dir.join("tests/gc_yjs_load.mjs"))
        .arg(&file)
        .arg(crate_dir.join("../../.."))
        .output()
        .unwrap();
    let report = String::from_utf8_lossy(&out.stdout);
    eprintln!("gc_views: {report}{}", String::from_utf8_lossy(&out.stderr));
    assert!(
        out.status.success(),
        "Yjs reads a collected state differently"
    );
}

#[test]
fn collections_keep_every_replica_and_every_undo_exact() {
    let seeds: u64 = std::env::var("GC_SEEDS").map_or(200, |n| n.parse().unwrap());
    let first: u64 = std::env::var("GC_FIRST_SEED").map_or(0, |n| n.parse().unwrap());
    let started = std::time::Instant::now();
    let mut tally = Tally::default();
    for seed in first..first + seeds {
        run(seed, &mut tally);
    }
    eprintln!(
        "gc_views: seeds {} converged {} equals R {} | collections {} (units collected {}, loads differing {}) | rejoins raw {} late {} | undos {} | {:.1} s",
        tally.seeds,
        tally.converged,
        tally.equals_reference,
        tally.collections,
        tally.units,
        tally.load_differs,
        tally.raw_rejoins,
        tally.late_rejoins,
        tally.undos,
        started.elapsed().as_secs_f64()
    );
    assert!(tally.failures.is_empty(), "{:?}", tally.failures);
    assert_eq!(tally.load_differs, 0);
    // Not vacuous: collections ran, discarded units, and tabs undid steps.
    assert!(tally.collections > seeds && tally.units > 0 && tally.undos > seeds);
    yjs_check(&tally.sample);
}
