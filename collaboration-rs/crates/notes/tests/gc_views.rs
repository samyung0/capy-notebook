#![allow(clippy::unwrap_used)] // Tests panic on a broken run.
//! The in-place collection (`ydoc::gc`) against tabs that come and go: a
//! room S and up to eight tabs edit a Plate note through the room's
//! slate-yjs mapping. Tabs join, edit online, go offline and keep editing,
//! hold edits the room has not admitted while they keep hearing it, come
//! back and send their drafts, leave for good, and undo or redo their own
//! steps. Every tab has a twin editing a room R that never collects.
//!
//! As the server does, the open room keeps its whole history, and what is
//! stored is a base plus the rows stored since (each store's update, with
//! the room's contributor marker for the writer written and claimed). A fold
//! replays them and collects the result into the new base: at every leave
//! and idle moment with the room open (the open room's own marker chains
//! stay), and when the last online tab goes (the room unloads; its next life
//! loads the stored state under a new client):
//! * counted tabs are the connected ones and those offline for at most 25
//!   steps (the cap). A tab reports the last store it heard, never above the
//!   version its oldest unsent edit was made at (PLAN section 4);
//! * the window is the newest of the last four stored snapshots that every
//!   counted tab has reached, or the folded document itself when no tab is
//!   counted, and each fold stores the folded document as the next snapshot;
//! * H is what the counted tabs' sessions deleted (their Undo may restore it).
//!
//! A third of the edits land on one spot of the first paragraph (typing
//! there, range deletes around it), and now and then a contended episode
//! plays out there: an offline (or holding) tab and an online one type at
//! the spot, a third tab deletes the range around it and leaves, and the
//! room folds before or after the draft arrives, so the draft sits inside a
//! run the window holds deleted.
//!
//! A tab some fold did not count (it left, or stayed offline past the cap)
//! comes back on the late path. The late merge is not exercised here: the
//! tab and its twin both drop their unsent edits and load the current state
//! under a new client id, with an empty Undo stack. Every other tab comes
//! back raw and sends its drafts.
//!
//! Checked for every seed:
//! * every collected state loads to the value the uncollected fold's state
//!   loads to, with the same state vector and nothing pending, and that value
//!   is the folded document's (a separate count: a document that does not
//!   survive its own reload is not the collection's doing);
//! * no counted tab can name a unit the collected state dropped: in its
//!   view, the units next to every live unit, each list's first and last
//!   unit and each key's current value stay;
//! * at the end every tab, the open room and a fresh load of the stored state
//!   are equal, with nothing pending;
//! * they equal R: an Undo after a collection restores what it restores
//!   without one.
//!
//! A sample of collected states, each with the state it was collected from
//! and the rows stored after it, is loaded by Yjs (`gc_yjs_load.mjs`, the
//! browser's Yjs from the repository's node_modules), which must read both
//! alike before and after the rows; without Node the check skips unless
//! CAPY_IT_REQUIRED is set (CI).
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
use yrs::block::ItemContent;
use yrs::branch::{BranchID, BranchPtr};
use yrs::undo::{Options, UndoManager};
use yrs::{Any, Doc, ID, IdSet, Map as _, Origin, ReadTxn, StateVector, Transact};

/// The origin of a replica's own edits: its Undo tracks only these.
const LOCAL: &str = "local";
const MARKS: [&str; 3] = ["bold", "italic", "code"];
/// Window snapshots kept, as the fold keeps them.
const WINDOWS_KEPT: usize = 4;
/// Collected states sent to Yjs at most.
const YJS_SAMPLE: usize = 600;
/// Steps an offline tab stays counted.
const CAP: usize = 25;
/// The char offset of the first paragraph where a third of the edits land.
const HOT: usize = 5;

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
        // The hot spot: typing at it, or a range delete around it.
        if rng.chance(0.33) {
            let b = blocks[0];
            let n = self.chars(b);
            let at = HOT.min(n);
            if n > 0 && rng.chance(0.4) {
                let start = at.saturating_sub(rng.below(4)).min(n - 1);
                let count = 1 + rng.below((n - start).min(6));
                return self.remove_ops(b, start, count);
            }
            let text: String = (0..1 + rng.below(3))
                .map(|_| (b'a' + rng.below(26) as u8) as char)
                .collect();
            return self.insert_ops(b, at, &text);
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
    /// Connected and hearing the room, but its own edits wait for a resend
    /// (the room did not admit them yet).
    Holding,
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
    /// The version the tab reports: S's stored version at its last sync
    /// from S, never above `unsent`.
    reached: i64,
    /// The version the tab held when it made its oldest edit S has not got.
    unsent: Option<i64>,
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
            St::Online | St::Holding => true,
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
    /// Units a counted tab can name that a collected state dropped.
    unnameable: u64,
    /// Folded documents that read differently once their own state is
    /// loaded: not the collection's doing (the uncollected fold writes it).
    reloads_differ: u64,
    contended: u64,
    /// Contended episodes whose draft was held while its tab heard the room.
    holding: u64,
    failures: Vec<String>,
    /// For Yjs: the state collected from, the collected state, and the rows
    /// stored after the fold, as a load replays them.
    sample: Vec<Sampled>,
}

struct Sampled {
    before: Vec<u8>,
    after: Vec<u8>,
    later: Vec<Vec<u8>>,
}

/// How many units a session holding `view` can name in its next edit that
/// the collection of `folded` into `base` dropped: in every list, the unit
/// before and after each live unit (typing names the deleted unit just before
/// the next live one, a list insert the one just after a live one) and the
/// first and last unit; each key's current value. The marker root is the
/// room's alone. (A deleted type's children are collected at its deletion,
/// as Yjs does, before any fold.)
fn named_but_collected(view: &Doc, folded: &Doc, base: &Doc) -> usize {
    let (txn, before, after) = (view.transact(), folded.transact(), base.transact());
    let collected = |id: &ID| {
        matches!(before.store().get_block_range(id), Some((_, Some(_))))
            && matches!(after.store().get_block_range(id), Some((_, None)))
    };
    let mut branches: Vec<BranchPtr> = txn
        .root_refs()
        .filter(|(name, _)| *name != ydoc::CONTRIBUTORS_ROOT)
        .filter_map(|(name, _)| BranchID::get_root(&txn, name))
        .collect();
    let nested = |item: &yrs::block::ItemPtr, branches: &mut Vec<BranchPtr>| {
        if let ItemContent::Type(inner) = item.content()
            && !item.is_deleted()
        {
            branches.push(BranchPtr::from(inner.as_ref()));
        }
    };
    let mut count = 0;
    while let Some(branch) = branches.pop() {
        let mut items = Vec::new();
        let mut next = branch.start();
        while let Some(item) = next {
            items.push(item);
            next = item.right();
        }
        let mut named: Vec<ID> = Vec::new();
        if let (Some(first), Some(last)) = (items.first(), items.last()) {
            named.extend([*first.id(), last.last_id()]);
        }
        for (k, item) in items.iter().enumerate() {
            if item.is_deleted() {
                continue;
            }
            if k > 0 {
                named.push(items[k - 1].last_id());
            }
            if let Some(after) = items.get(k + 1) {
                named.push(*after.id());
            }
            nested(item, &mut branches);
        }
        for (_, current) in branch.map_items() {
            named.push(*current.id());
            nested(&current, &mut branches);
        }
        count += named.iter().filter(|id| collected(id)).count();
    }
    count
}

struct World {
    /// The open room's document (its whole history); stale while closed.
    s: Note,
    open: bool,
    /// Room lives so far: each loads the stored state under a new client,
    /// which writes its markers.
    lives: u64,
    /// The stored state: the base and the rows stored since the last fold.
    base: Vec<u8>,
    rows: Vec<Vec<u8>>,
    /// S's state vector at its last row.
    stored_sv: StateVector,
    /// The sample entry of the last fold, waiting for the rows after it.
    sampled: Option<usize>,
    r: Note,
    /// The stored version: one more for every row.
    version: i64,
    windows: Vec<Window>,
    tabs: Vec<Tab>,
    next_client: u64,
    /// Every tab and its twin applied the same edits.
    twins_agree: bool,
}

impl World {
    /// The stored state loaded, as a fold or the next room life reads it.
    fn stored(&self, client: u64) -> Note {
        let mut note = Note::load(client, "s", &self.base);
        for row in &self.rows {
            note.doc
                .transact_mut()
                .apply_update(ydoc::decode(row).unwrap())
                .unwrap();
        }
        note.refresh();
        note
    }

    /// A closed room loads the stored state under a new client.
    fn open_room(&mut self) {
        if self.open {
            return;
        }
        let c = self.next_client;
        self.next_client += 1;
        self.s = self.stored(c);
        self.stored_sv = self.s.doc.transact().state_vector();
        self.lives += 1;
        self.open = true;
    }

    fn connected(&self) -> bool {
        self.tabs
            .iter()
            .any(|t| matches!(t.st, St::Online | St::Holding))
    }

    /// A tab is no longer online: the room folds, unloading first when no
    /// tab is left connected.
    fn went(&mut self, now: usize, tally: &mut Tally) {
        if !self.connected() {
            self.open = false;
        }
        self.fold(now, tally);
    }

    /// Every connected tab hears the room and acknowledges the last store,
    /// never above the version its oldest unsent edit was made at.
    fn hear(&mut self) {
        for t in self
            .tabs
            .iter_mut()
            .filter(|t| matches!(t.st, St::Online | St::Holding))
        {
            sync(&self.s, &mut t.g);
            sync(&self.r, &mut t.r);
            t.reached = t.unsent.map_or(self.version, |at| at.min(self.version));
        }
    }

    /// Tab `i` made an edit: online, it stores and every connected tab hears
    /// the room; otherwise the edit waits, unsent.
    fn edited(&mut self, i: usize) {
        if self.tabs[i].st == St::Online {
            self.store_from(i);
            self.hear();
        } else {
            let t = &mut self.tabs[i];
            t.unsent.get_or_insert(t.reached);
        }
    }

    /// Tab `i` and its twin apply `ops`; the tab's session holds what they
    /// delete. Online, it stores and every online tab hears the room.
    fn type_ops(&mut self, i: usize, ops: &[Operation]) {
        let t = &mut self.tabs[i];
        let before = t.g.delete_set();
        t.g.apply(ops);
        t.r.apply(ops);
        let deleted = t.g.delete_set().diff(&before);
        t.held.merge_with(deleted);
        self.edited(i);
    }

    /// The contended episode (module docs): tab T goes offline, B types at
    /// the spot, T types there too, D deletes from the unit before the spot
    /// through the one after B's text and leaves (a fold), T comes back raw
    /// and the room folds at a window holding the deletion. Half the time T
    /// goes offline again first, still showing its draft, and B deletes the
    /// draft: deleted after the window, it still splits the run.
    ///
    /// Or T holds instead: it types first, its edit unsent, B types, D
    /// deletes and leaves, T hears all of it and the room folds before T
    /// resends. T must not count as past the window then (PLAN section 4).
    fn contended(&mut self, now: usize, rng: &mut Rng, tally: &mut Tally) {
        for i in 0..self.tabs.len() {
            if matches!(self.tabs[i].st, St::Offline(_) | St::Holding) {
                self.rejoin(i, tally);
            }
        }
        self.hear();
        let spot = |note: &Note| {
            note.text_blocks()
                .first()
                .copied()
                .filter(|&b| note.chars(b) > HOT)
        };
        let mut on: Vec<usize> = (0..self.tabs.len())
            .filter(|&i| self.tabs[i].st == St::Online)
            .collect();
        if on.len() < 3 || spot(&self.s).is_none() {
            return;
        }
        let mut take = || on.remove(rng.below(on.len()));
        let (t, b, d) = (take(), take(), take());
        tally.contended += 1;
        let holding = rng.chance(0.5);
        tally.holding += u64::from(holding);
        let order = if holding {
            self.tabs[t].st = St::Holding;
            [t, b]
        } else {
            self.tabs[t].st = St::Offline(now);
            [b, t]
        };
        // How many letters B and T typed.
        let mut typed = [0, 0];
        for i in order {
            let Some(block) = spot(&self.tabs[i].g) else {
                return;
            };
            let text: String = (0..1 + rng.below(3))
                .map(|_| (b'a' + rng.below(26) as u8) as char)
                .collect();
            typed[usize::from(i == t)] = text.chars().count();
            let ops = self.tabs[i].g.insert_ops(block, HOT, &text);
            self.type_ops(i, &ops);
        }
        let deleter = &self.tabs[d].g;
        let Some(block) = spot(deleter) else {
            return;
        };
        let count = (typed[0] + 2).min(deleter.chars(block) - (HOT - 1));
        let ops = deleter.remove_ops(block, HOT - 1, count);
        self.type_ops(d, &ops);
        self.tabs[d].st = St::Left;
        self.went(now, tally);
        if holding {
            // B types elsewhere, so the room has a row to fold; T hears it
            // all before its draft is sent.
            let Some(block) = spot(&self.tabs[b].g) else {
                return;
            };
            let ops = self.tabs[b].g.insert_ops(block, 0, "z");
            self.type_ops(b, &ops);
            self.fold(now, tally);
            self.rejoin(t, tally);
            self.hear();
            return;
        }
        self.rejoin(t, tally);
        if rng.chance(0.5) {
            self.hear();
            self.tabs[t].st = St::Offline(now);
            let Some(block) = spot(&self.tabs[b].g) else {
                return;
            };
            let count = typed[1].min(self.tabs[b].g.chars(block) - (HOT - 1));
            let ops = self.tabs[b].g.remove_ops(block, HOT - 1, count);
            self.type_ops(b, &ops);
        }
        self.fold(now, tally);
    }

    fn join(&mut self) {
        self.open_room();
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
            unsent: None,
            excluded: false,
            ug,
            ur,
            held: IdSet::new(),
        });
    }

    /// Tab `i` comes back: raw (it sends its drafts) when every fold since
    /// its last sync counted it, else on the late path's stand-in.
    fn rejoin(&mut self, i: usize, tally: &mut Tally) {
        self.open_room();
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
        t.unsent = None;
    }

    /// Tab `i` sends what it has (a store), and hears S back. The room
    /// writes the writer's contributor marker and the store claims it, so
    /// the row carries it deleted.
    fn store_from(&mut self, i: usize) {
        let t = &mut self.tabs[i];
        sync(&t.g, &mut self.s);
        sync(&t.r, &mut self.r);
        let markers = self.s.doc.get_or_insert_map(ydoc::CONTRIBUTORS_ROOT);
        let key = format!("{}-{}", self.lives, t.prefix);
        let marker = Any::from(std::collections::HashMap::from([
            ("access".to_owned(), Any::from("write")),
            ("nonce".to_owned(), Any::from(self.version.to_string())),
        ]));
        markers.insert(&mut self.s.doc.transact_mut(), key.clone(), marker);
        markers.remove(&mut self.s.doc.transact_mut(), &key);
        let row = self
            .s
            .doc
            .transact()
            .encode_state_as_update_v1(&self.stored_sv);
        self.rows.push(row);
        self.stored_sv = self.s.doc.transact().state_vector();
        self.version += 1;
        sync(&self.s, &mut t.g);
        sync(&self.r, &mut t.r);
        t.reached = self.version;
        t.unsent = None;
    }

    /// A fold: replay the stored state, collect it at the window the counted
    /// tabs allow into the new base, and store it as the next window
    /// candidate. With no row since the last fold there is nothing to fold.
    fn fold(&mut self, now_step: usize, tally: &mut Tally) {
        if self.rows.is_empty() {
            return;
        }
        for t in self.tabs.iter_mut().filter(|t| !t.counted(now_step)) {
            t.excluded = true;
        }
        if let Some(k) = self.sampled.take() {
            tally.sample[k].later = self.rows.clone();
        }
        let folded = self.stored(1);
        // What the fold writes without the collection, as a load reads it.
        let whole = Note::load(1, "s", &folded.state());
        if whole.value() != folded.value() {
            tally.reloads_differ += 1;
        }
        let counted: Vec<&Tab> = self.tabs.iter().filter(|t| t.counted(now_step)).collect();
        let now = Window::of(&folded.doc.transact(), self.version);
        let window = match counted.iter().map(|t| t.reached).min() {
            None => Some(now.clone()),
            Some(reached) => gc::window_for(&self.windows, reached).cloned(),
        };
        self.base = match window {
            Some(window) => {
                let mut held = IdSet::new();
                for t in &counted {
                    held.merge_with(t.held.clone());
                }
                let live_room = self.open.then(|| self.s.doc.client_id());
                let collected = gc::collect(&folded.doc, &window, &held, live_room);
                let loaded = Note::load(1, "s", &collected.state);
                let same_vector =
                    loaded.doc.transact().state_vector() == folded.doc.transact().state_vector();
                if loaded.value() != whole.value() || loaded.pending() || !same_vector {
                    tally.load_differs += 1;
                }
                for t in &counted {
                    tally.unnameable +=
                        named_but_collected(&t.g.doc, &folded.doc, &loaded.doc) as u64;
                }
                tally.collections += 1;
                tally.units += collected.units;
                if collected.units > 0
                    && tally.sample.len() < YJS_SAMPLE
                    && tally.collections.is_multiple_of(3)
                {
                    self.sampled = Some(tally.sample.len());
                    tally.sample.push(Sampled {
                        before: folded.state(),
                        after: collected.state.clone(),
                        later: Vec::new(),
                    });
                }
                collected.state
            }
            None => folded.state(),
        };
        self.rows.clear();
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
    let (base, stored_sv) = (s.state(), s.doc.transact().state_vector());
    let mut w = World {
        s,
        open: true,
        lives: 1,
        base,
        rows: Vec::new(),
        stored_sv,
        sampled: None,
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
                w.edited(i);
            }
            // An online tab goes offline.
            55..=60 => {
                let on: Vec<usize> = (0..w.tabs.len())
                    .filter(|&i| w.tabs[i].st == St::Online)
                    .collect();
                if !on.is_empty() {
                    w.tabs[on[rng.below(on.len())]].st = St::Offline(now);
                    if !w.connected() {
                        w.went(now, tally);
                    }
                }
            }
            // An online tab's next edits wait for a resend while it keeps
            // hearing the room.
            61..=64 => {
                let on: Vec<usize> = (0..w.tabs.len())
                    .filter(|&i| w.tabs[i].st == St::Online)
                    .collect();
                if !on.is_empty() {
                    w.tabs[on[rng.below(on.len())]].st = St::Holding;
                }
            }
            // An offline tab comes back, or one that left (a back/forward
            // cache restore), or a holding tab resends.
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
                    w.went(now, tally);
                }
            }
            90..=94 if w.tabs.len() < 8 => w.join(),
            95 | 96 => w.contended(now, &mut rng, tally),
            // The room is idle a moment: it folds.
            _ => w.fold(now, tally),
        }
    }
    // Every tab still away or holding comes back; every open tab syncs.
    for i in 0..w.tabs.len() {
        if matches!(w.tabs[i].st, St::Offline(_) | St::Holding) {
            w.rejoin(i, tally);
        }
    }
    w.open_room();
    for t in w.tabs.iter_mut().filter(|t| t.st == St::Online) {
        sync(&w.s, &mut t.g);
        sync(&w.r, &mut t.r);
    }
    if let Some(k) = w.sampled.take() {
        tally.sample[k].later = w.rows.clone();
    }
    let fresh = w.stored(99);
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

/// Loads each sampled pair in Yjs, then the rows stored after it on each;
/// both must read alike.
fn yjs_check(sample: &[Sampled]) {
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
        .map(|pair| {
            json!({
                "before": b64.encode(&pair.before),
                "after": b64.encode(&pair.after),
                "later": pair.later.iter().map(|row| b64.encode(row)).collect::<Vec<_>>(),
            })
        })
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
        "gc_views: seeds {} converged {} equals R {} | collections {} (units collected {}, loads differing {}, unnameable {}, reloads differing {}) | contended {} (holding {}) | rejoins raw {} late {} | undos {} | {:.1} s",
        tally.seeds,
        tally.converged,
        tally.equals_reference,
        tally.collections,
        tally.units,
        tally.load_differs,
        tally.unnameable,
        tally.reloads_differ,
        tally.contended,
        tally.holding,
        tally.raw_rejoins,
        tally.late_rejoins,
        tally.undos,
        started.elapsed().as_secs_f64()
    );
    assert!(tally.failures.is_empty(), "{:?}", tally.failures);
    assert_eq!(tally.load_differs, 0);
    assert_eq!(tally.unnameable, 0);
    assert_eq!(
        tally.reloads_differ, 0,
        "a folded document reads differently after its own reload, collection or not"
    );
    // Not vacuous: collections ran, discarded units, tabs undid steps and
    // contended episodes played out.
    assert!(tally.collections > seeds && tally.units > 0 && tally.undos > seeds);
    assert!(tally.contended > seeds / 4 && tally.holding > seeds / 8);
    yjs_check(&tally.sample);
}
