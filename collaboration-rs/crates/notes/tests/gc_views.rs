#![allow(clippy::unwrap_used)] // Tests panic on a broken run.
//! The in-place collection (`ydoc::gc`) against tabs that come and go, with
//! the server's own session bookkeeping (`sessions.rs`): a room S and up to
//! eight tabs edit a Plate note through the room's slate-yjs mapping. Tabs
//! join, edit online, go offline and keep editing, hold edits the room has
//! not admitted while they keep hearing it, come back and send their
//! drafts, leave for good (an editor's clean Leave: its Y.Doc is gone), and
//! undo or redo their own steps; the agent edits the open room and undoes or
//! redoes its steps; now and then a day passes at once. Every tab, and the
//! room's agent, has a twin editing a room R that never collects.
//!
//! As the server does, the open room keeps its whole history, and what is
//! stored is a base plus the rows stored since (each store's update, with
//! the room's contributor marker for the writer written and claimed). A fold
//! replays them and collects the result into the new base: at every leave
//! and idle moment with the room open (the open room's own marker chains
//! stay), and when the last connected tab goes (the room unloads; its next
//! life loads the stored state under a new client).
//!
//! The window and H come from the room's `Sessions`, driven as the room
//! drives it: a JOIN names the tab's version and the step 1 answer syncs it,
//! each store's notice is acknowledged (never above the version of the tab's
//! oldest unsent edit, PLAN section 4), a drop leaves the session counted
//! for 24 h, a clean Leave ends it, the deletions a tab's update makes that
//! the room held undeleted are held from their arrival (25 h), and the agent
//! steps' deletions from their edit (25 h). Each store writes the changed
//! session rows and the agent holds, as does the unload, and each room life
//! loads them back (rows seen within 24 h, and lost ids); now and then a
//! row's held deletions cannot be read and that session is written lost
//! (Q382). The window is the newest of the last four stored snapshots that
//! every counted session reached, or the folded document itself when none
//! counts, and the latest collection's window is kept.
//!
//! A day passing (26 h) clears every editor's Undo (it reaches back 24 h,
//! Q2) and the agent's (its Undo is offered 24 h, Q385), and ends the
//! sessions away that long. A tab coming back joins late when it names a
//! version below the latest collection's window or its session record was
//! lost (`sessions::late`): the late merge is not exercised here, so the tab
//! and its twin both drop their unsent edits and load the current state
//! under a new client id, with an empty Undo stack. Every other tab comes
//! back raw and sends its drafts.
//!
//! A third of the edits land on one spot of the first paragraph (typing
//! there, range deletes around it), and now and then a contended episode
//! plays out there: an offline (or holding) tab and an online one type at
//! the spot, a third tab deletes the range around it and leaves, and the
//! room folds before or after the draft arrives, so the draft sits inside a
//! run the window holds deleted.
//!
//! Checked for every seed:
//! * every collected state loads to the value the uncollected fold's state
//!   loads to, with the same state vector and nothing pending, and that value
//!   is the folded document's (a separate count: a document that does not
//!   survive its own reload is not the collection's doing);
//! * no tab that would come back raw can name a unit the collected state
//!   dropped: in its view, the units next to every live unit, each list's
//!   first and last unit and each key's current value stay;
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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use notes::plate::{self, CONTENT_ROOT};
use notes::slate::{self, Operation, Root};
use notes::slate_yjs;
use serde_json::{Map, Value, json};
use ydoc::gc::{self, Window};
use yrs::block::{ClientID, ItemContent};
use yrs::branch::{BranchID, BranchPtr};
use yrs::undo::{Options, UndoManager};
use yrs::{Any, Doc, ID, IdSet, Map as _, Origin, ReadTxn, StateVector, Transact};

/// The server's session bookkeeping itself (the server crate is a binary,
/// so it is included by path).
#[allow(dead_code)]
#[path = "../../server/src/sessions.rs"]
mod sessions;

/// The lib0 varuints `sessions.rs` takes from the server's protocol module.
mod protocol {
    pub struct Truncated;

    pub fn write_var(out: &mut Vec<u8>, mut value: u64) {
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return;
            }
            out.push(byte | 0x80);
        }
    }

    pub fn read_var(bytes: &[u8], at: &mut usize) -> Result<u64, Truncated> {
        let mut value = 0u64;
        let mut shift = 0;
        loop {
            let byte = *bytes.get(*at).ok_or(Truncated)?;
            *at += 1;
            if shift >= 64 {
                return Err(Truncated);
            }
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
            shift += 7;
        }
    }
}

/// The origin of a replica's own edits: its Undo tracks only these.
const LOCAL: &str = "local";
/// The origin of the agent's edits on the room and its twin.
const AGENT: &str = "agent";
/// Every tab's user (the sessions check that a channel acts on its own).
const USER: &str = "u";
const MARKS: [&str; 3] = ["bold", "italic", "code"];
/// Window snapshots kept, as the fold keeps them.
const WINDOWS_KEPT: usize = 4;
/// Collected states sent to Yjs at most.
const YJS_SAMPLE: usize = 600;
/// The clock's step.
const STEP: Duration = Duration::from_secs(60);
/// A day passing at once: past the editors' 24 h Undo and the sessions' 24 h
/// count, and past the 25 h holds.
const DAY: Duration = Duration::from_secs(26 * 60 * 60);
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
        self.apply_as(LOCAL, ops);
    }

    /// One transaction of `ops` with `origin`.
    fn apply_as(&mut self, origin: &str, ops: &[Operation]) {
        let mut txn = self.doc.transact_mut_with(origin);
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

    /// A random local edit, plus Slate's leaf normalization after a mark
    /// change. Returns the operation batches, to replay on the twin.
    fn edit(&mut self, rng: &mut Rng) -> Vec<Vec<Operation>> {
        self.edit_as(LOCAL, rng)
    }

    /// `edit` in transactions with `origin`.
    fn edit_as(&mut self, origin: &str, rng: &mut Rng) -> Vec<Vec<Operation>> {
        let ops = self.random_ops(rng);
        if ops.is_empty() {
            return Vec::new();
        }
        self.apply_as(origin, &ops);
        let mut batches = vec![ops.clone()];
        if let Some(Operation::SetNode { path, .. }) = ops.last()
            && path.len() == 2
        {
            let normalize = self.normalize_leaves(path[0]);
            if !normalize.is_empty() {
                self.apply_as(origin, &normalize);
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

/// The first paragraph, when it is long enough to hold the spot.
fn spot(note: &Note) -> Option<usize> {
    note.text_blocks()
        .first()
        .copied()
        .filter(|&b| note.chars(b) > HOT)
}

fn undo_manager(note: &Note, origin: &'static str) -> UndoManager<()> {
    let mut undo = UndoManager::with_options(Options {
        capture_timeout_millis: 0,
        tracked_origins: HashSet::from([Origin::from(origin)]),
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
    /// Its socket dropped: no Leave, so its session still counts for 24 h.
    Offline,
    /// Its editor sent a clean Leave and unmounted: the tab is gone.
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
    ug: UndoManager<()>,
    ur: UndoManager<()>,
}

impl Tab {
    /// Its session's id: its document's client id.
    fn client(&self) -> u64 {
        self.g.doc.client_id().get()
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
    /// Late rejoins under a session id whose record was lost.
    lost_rejoins: u64,
    /// Session rows whose held deletions could not be read at a load.
    damaged: u64,
    /// The episodes that set up an agent Undo, a lost record's return and a
    /// day-old Undo after a collection (module docs).
    agent_episodes: u64,
    lost_episodes: u64,
    day_episodes: u64,
    agent_edits: u64,
    agent_undos: u64,
    days: u64,
    load_differs: u64,
    /// Units a tab that would come back raw can name that a collected state
    /// dropped.
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

/// A session's row as a store writes it (`note_store::save_sessions`).
struct SessionRow {
    version: i64,
    seen: Option<SystemTime>,
    held: Option<Vec<u8>>,
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
    /// The latest collection's window version (`collected_window`).
    window: i64,
    /// The open room's sessions, and what their rows and the agent holds
    /// store; ids an accepted write recorded (only those get rows).
    sessions: sessions::Sessions,
    session_rows: BTreeMap<u64, SessionRow>,
    agent_held: Option<Vec<u8>>,
    recorded: HashSet<u64>,
    /// A session whose row the next room life cannot read (the lost-record
    /// episode).
    damage: Option<u64>,
    /// The agent's Undo over its steps on S and on R: the room's, gone with
    /// the room.
    agent_s: UndoManager<()>,
    agent_r: UndoManager<()>,
    clock: SystemTime,
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

    /// A closed room loads the stored state under a new client, and its
    /// sessions; the agent's steps went with the last life.
    fn open_room(&mut self, rng: &mut Rng, tally: &mut Tally) {
        if self.open {
            return;
        }
        let c = self.next_client;
        self.next_client += 1;
        self.s = self.stored(c);
        self.stored_sv = self.s.doc.transact().state_vector();
        self.lives += 1;
        self.open = true;
        // R keeps its whole state but takes the room's client, so the
        // agent's edits order against concurrent ones as they do in S.
        self.r = Note::load(c, "s", &self.r.state());
        self.agent_s = undo_manager(&self.s, AGENT);
        self.agent_r = undo_manager(&self.r, AGENT);
        self.load_sessions(rng, tally);
    }

    /// The sessions as `note_store::load_sessions` reads them: rows seen
    /// within the cap, the lost ids and the agent holds. Now and then one
    /// row's held deletions cannot be read: that session is dropped and its
    /// row written lost (Q382).
    fn load_sessions(&mut self, rng: &mut Rng, tally: &mut Tally) {
        let now = self.clock;
        let mut rows: Vec<(u64, String, i64, SystemTime, Option<Vec<u8>>)> = self
            .session_rows
            .iter()
            .filter(|(_, row)| row.version != sessions::LOST)
            .filter_map(|(&client, row)| {
                let seen = row.seen?;
                (now.duration_since(seen).unwrap_or_default() < sessions::COUNTED_FOR)
                    .then(|| (client, USER.to_owned(), row.version, seen, row.held.clone()))
            })
            .collect();
        let holding: Vec<usize> = (0..rows.len()).filter(|&k| rows[k].4.is_some()).collect();
        if let Some(client) = self.damage.take() {
            for row in rows
                .iter_mut()
                .filter(|row| row.0 == client && row.4.is_some())
            {
                row.4 = Some(vec![9]);
            }
        } else if !holding.is_empty() && rng.chance(0.25) {
            rows[holding[rng.below(holding.len())]].4 = Some(vec![9]);
        }
        let lost: Vec<u64> = self
            .session_rows
            .iter()
            .filter(|(_, row)| row.version == sessions::LOST)
            .map(|(&client, _)| client)
            .collect();
        let (loaded, damaged) = sessions::Sessions::load(rows, lost, self.agent_held.clone());
        for client in damaged.sessions {
            tally.damaged += 1;
            self.session_rows.insert(
                client,
                SessionRow {
                    version: sessions::LOST,
                    seen: None,
                    held: None,
                },
            );
        }
        self.sessions = loaded;
    }

    /// What a store (or the unload) writes of the sessions, as
    /// `note_store::save_sessions` does.
    fn save_sessions(&mut self) {
        let recorded = &self.recorded;
        let unsaved = self
            .sessions
            .unsaved(self.clock, |client, _| recorded.contains(&client));
        for row in unsaved.rows {
            let stored = self
                .session_rows
                .entry(row.client as u64)
                .or_insert(SessionRow {
                    version: 0,
                    seen: None,
                    held: None,
                });
            stored.version = row.version;
            stored.seen = row.seen;
            if row.held_changed {
                stored.held = row.held;
            }
        }
        if let Some(agent) = unsaved.agent {
            self.agent_held = agent;
        }
        self.sessions.saved(unsaved.through);
    }

    fn connected(&self) -> bool {
        self.tabs
            .iter()
            .any(|t| matches!(t.st, St::Online | St::Holding))
    }

    /// Tab `i`'s socket drops: its session counts for 24 h more.
    fn drop_tab(&mut self, i: usize) {
        let client = self.tabs[i].client();
        self.tabs[i].st = St::Offline;
        let recorded = self.recorded.contains(&client);
        self.sessions.left(client, USER, self.clock, recorded);
    }

    /// Tab `i` sends a clean Leave and unmounts: its session ends.
    fn leave(&mut self, i: usize) {
        self.tabs[i].st = St::Left;
        self.sessions.end(self.tabs[i].client(), USER);
    }

    /// A tab is no longer online: the room folds, unloading first (and
    /// writing its sessions) when no tab is left connected.
    fn went(&mut self, tally: &mut Tally) {
        if !self.connected() {
            self.save_sessions();
            self.open = false;
        }
        self.fold(tally);
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
            self.sessions.acked(t.client(), USER, t.reached);
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

    /// Tab `i` and its twin apply `ops`. Online, it stores and every online
    /// tab hears the room.
    fn type_ops(&mut self, i: usize, ops: &[Operation]) {
        let t = &mut self.tabs[i];
        t.g.apply(ops);
        t.r.apply(ops);
        self.edited(i);
    }

    /// Every away or holding tab comes back, and every connected tab hears
    /// the room.
    fn all_back(&mut self, rng: &mut Rng, tally: &mut Tally) {
        for i in 0..self.tabs.len() {
            if matches!(self.tabs[i].st, St::Offline | St::Holding) {
                self.rejoin(i, rng, tally);
            }
        }
        self.hear();
    }

    /// Two online tabs type a few letters each at the spot (small items of
    /// their own there); the online tabs, when at least `need` are and the
    /// spot exists.
    fn spot_items(&mut self, rng: &mut Rng, need: usize) -> Option<Vec<usize>> {
        let on: Vec<usize> = (0..self.tabs.len())
            .filter(|&i| self.tabs[i].st == St::Online)
            .collect();
        if on.len() < need.max(2) || spot(&self.s).is_none() {
            return None;
        }
        for &i in &on[..2] {
            let block = spot(&self.tabs[i].g)?;
            let text: String = (0..1 + rng.below(3))
                .map(|_| (b'a' + rng.below(26) as u8) as char)
                .collect();
            let ops = self.tabs[i].g.insert_ops(block, HOT, &text);
            self.type_ops(i, &ops);
        }
        Some(on)
    }

    /// The ops deleting, in `note`'s view, from the unit before the spot
    /// through the letters typed there and beyond.
    fn spot_cut(note: &Note) -> Option<Vec<Operation>> {
        let block = spot(note)?;
        let count = 8.min(note.chars(block) - (HOT - 1));
        Some(note.remove_ops(block, HOT - 1, count))
    }

    /// Online tab `i` stores twice, a fold after each once every connected
    /// tab heard: the window then holds what came before.
    fn cover(&mut self, i: usize, tally: &mut Tally) {
        for _ in 0..2 {
            let Some(&block) = self.tabs[i].g.text_blocks().first() else {
                return;
            };
            let ops = self.tabs[i].g.insert_ops(block, 0, "z");
            self.type_ops(i, &ops);
            self.fold(tally);
        }
    }

    /// Tab `i` undoes its last step, as its twin does.
    fn undo_last(&mut self, i: usize, tally: &mut Tally) {
        let t = &mut self.tabs[i];
        let (g, r) = (t.ug.undo_blocking(), t.ur.undo_blocking());
        t.g.refresh();
        t.r.refresh();
        tally.undos += u64::from(g);
        self.twins_agree &= g == r;
        self.edited(i);
    }

    /// The agent deletes around the spot's small items, the window comes to
    /// hold that deletion, and the agent undoes it: its holds keep what the
    /// Undo names.
    fn agent_episode(&mut self, rng: &mut Rng, tally: &mut Tally) {
        self.all_back(rng, tally);
        let Some(on) = self.spot_items(rng, 2) else {
            return;
        };
        self.s.refresh();
        self.r.refresh();
        if self.s.value() != self.r.value() {
            return;
        }
        let Some(ops) = Self::spot_cut(&self.s) else {
            return;
        };
        let before = self.s.delete_set();
        self.s.apply_as(AGENT, &ops);
        self.r.apply_as(AGENT, &ops);
        let deleted = self.s.delete_set().diff(&before);
        self.sessions.agent_deleted(deleted, self.clock);
        self.room_store();
        self.hear();
        tally.agent_edits += 1;
        self.cover(on[0], tally);
        self.agent_step(false, tally);
        tally.agent_episodes += 1;
    }

    /// A tab deletes around the spot's small items and drops; the room
    /// unloads and its next life cannot read that tab's row (Q382), so the
    /// window comes to hold the deletion with nothing holding it; the tab
    /// comes back late (Q385), its Undo gone with its old document.
    fn lost_episode(&mut self, rng: &mut Rng, tally: &mut Tally) {
        self.all_back(rng, tally);
        let Some(on) = self.spot_items(rng, 3) else {
            return;
        };
        let (back, t) = (on[0], on[2]);
        let Some(ops) = Self::spot_cut(&self.tabs[t].g) else {
            return;
        };
        self.type_ops(t, &ops);
        for i in 0..self.tabs.len() {
            if self.tabs[i].st == St::Online {
                self.drop_tab(i);
            }
        }
        self.went(tally);
        self.damage = Some(self.tabs[t].client());
        self.rejoin(back, rng, tally);
        self.cover(back, tally);
        self.rejoin(t, rng, tally);
        self.undo_last(t, tally);
        tally.lost_episodes += 1;
    }

    /// A tab deletes around the spot's small items, a day passes (its Undo
    /// and its holds go), and the window comes to hold the deletion; the
    /// tab's Undo reaches nothing from before the day.
    fn day_episode(&mut self, rng: &mut Rng, tally: &mut Tally) {
        self.all_back(rng, tally);
        let Some(on) = self.spot_items(rng, 3) else {
            return;
        };
        let t = on[2];
        let Some(ops) = Self::spot_cut(&self.tabs[t].g) else {
            return;
        };
        self.type_ops(t, &ops);
        self.day_passes(tally);
        self.cover(on[0], tally);
        self.undo_last(t, tally);
        tally.day_episodes += 1;
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
    fn contended(&mut self, rng: &mut Rng, tally: &mut Tally) {
        self.all_back(rng, tally);
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
            self.drop_tab(t);
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
        self.leave(d);
        self.went(tally);
        if holding {
            // B types elsewhere, so the room has a row to fold; T hears it
            // all before its draft is sent.
            let Some(block) = spot(&self.tabs[b].g) else {
                return;
            };
            let ops = self.tabs[b].g.insert_ops(block, 0, "z");
            self.type_ops(b, &ops);
            self.fold(tally);
            self.rejoin(t, rng, tally);
            self.hear();
            return;
        }
        self.rejoin(t, rng, tally);
        if rng.chance(0.5) {
            self.hear();
            self.drop_tab(t);
            let Some(block) = spot(&self.tabs[b].g) else {
                return;
            };
            let count = typed[1].min(self.tabs[b].g.chars(block) - (HOT - 1));
            let ops = self.tabs[b].g.remove_ops(block, HOT - 1, count);
            self.type_ops(b, &ops);
        }
        self.fold(tally);
    }

    /// A new session under `client` joins (naming no version), its step 1
    /// is answered and it acknowledges the room's version.
    fn new_session(&mut self, client: u64) {
        self.sessions.joined(client, USER, 0, self.clock);
        self.sessions.synced(client);
        self.sessions.acked(client, USER, self.version);
    }

    fn join(&mut self, rng: &mut Rng, tally: &mut Tally) {
        self.open_room(rng, tally);
        let c = self.next_client;
        self.next_client += 1;
        let prefix = format!("c{c}-");
        let g = Note::load(c, &prefix, &self.s.state());
        let r = Note::load(c, &prefix, &self.r.state());
        let (ug, ur) = (undo_manager(&g, LOCAL), undo_manager(&r, LOCAL));
        self.tabs.push(Tab {
            g,
            r,
            prefix,
            st: St::Online,
            reached: self.version,
            unsent: None,
            ug,
            ur,
        });
        self.new_session(c);
    }

    /// Tab `i` comes back. A holding tab resends on its open channel. An
    /// offline one joins naming its version: raw (it sends its drafts)
    /// unless that version is below the latest collection's window or its
    /// session record was lost; then on the late path's stand-in.
    fn rejoin(&mut self, i: usize, rng: &mut Rng, tally: &mut Tally) {
        self.open_room(rng, tally);
        if self.tabs[i].st == St::Holding {
            self.tabs[i].st = St::Online;
            self.store_from(i);
            return;
        }
        let (client, reached) = (self.tabs[i].client(), self.tabs[i].reached);
        let lost = self.sessions.lost(client);
        if !sessions::late(self.window, reached as u64, lost) {
            tally.raw_rejoins += 1;
            self.sessions.joined(client, USER, reached, self.clock);
            self.sessions.synced(client);
            self.tabs[i].st = St::Online;
            self.store_from(i);
            return;
        }
        tally.late_rejoins += 1;
        tally.lost_rejoins += u64::from(lost);
        let c = self.next_client;
        self.next_client += 1;
        let t = &mut self.tabs[i];
        let next_id = t.g.next_id;
        t.g = Note::load(c, &t.prefix, &self.s.state());
        t.r = Note::load(c, &t.prefix, &self.r.state());
        (t.g.next_id, t.r.next_id) = (next_id, next_id);
        (t.ug, t.ur) = (undo_manager(&t.g, LOCAL), undo_manager(&t.r, LOCAL));
        t.st = St::Online;
        t.reached = self.version;
        t.unsent = None;
        self.new_session(c);
    }

    /// The room's own change since its last row (an agent edit, or its Undo
    /// or Redo) committed as a row, with the sessions' rows.
    fn room_store(&mut self) {
        let row = self
            .s
            .doc
            .transact()
            .encode_state_as_update_v1(&self.stored_sv);
        self.rows.push(row);
        self.stored_sv = self.s.doc.transact().state_vector();
        self.version += 1;
        self.save_sessions();
    }

    /// Tab `i` sends what it has (a store), and hears S back. Its session
    /// holds what its update deleted that the room held undeleted. The room
    /// writes the writer's contributor marker and the store claims it, so
    /// the row carries it deleted; the store writes the sessions' rows.
    fn store_from(&mut self, i: usize) {
        let client = self.tabs[i].client();
        let before = self.s.delete_set();
        sync(&self.tabs[i].g, &mut self.s);
        sync(&self.tabs[i].r, &mut self.r);
        let deleted = self.s.delete_set().diff(&before);
        if self
            .s
            .doc
            .transact()
            .state_vector()
            .get(&ClientID::new(client))
            > 0
            || !deleted.is_empty()
        {
            self.recorded.insert(client);
        }
        self.sessions.deleted(client, USER, deleted, self.clock);
        let markers = self.s.doc.get_or_insert_map(ydoc::CONTRIBUTORS_ROOT);
        let key = format!("{}-{}", self.lives, self.tabs[i].prefix);
        let marker = Any::from(std::collections::HashMap::from([
            ("access".to_owned(), Any::from("write")),
            ("nonce".to_owned(), Any::from(self.version.to_string())),
        ]));
        markers.insert(&mut self.s.doc.transact_mut(), key.clone(), marker);
        markers.remove(&mut self.s.doc.transact_mut(), &key);
        self.room_store();
        let t = &mut self.tabs[i];
        sync(&self.s, &mut t.g);
        sync(&self.r, &mut t.r);
        t.reached = self.version;
        t.unsent = None;
        self.sessions.acked(client, USER, self.version);
    }

    /// The agent edits the open room (and its twin R); its step's deletions
    /// are held from the edit, the room commits the row, and the connected
    /// tabs hear it.
    fn agent_edit(&mut self, rng: &mut Rng, tally: &mut Tally) {
        self.s.refresh();
        self.r.refresh();
        if !self.open || self.s.value() != self.r.value() {
            return;
        }
        let before = self.s.delete_set();
        let batches = self.s.edit_as(AGENT, rng);
        if batches.is_empty() {
            return;
        }
        for ops in &batches {
            self.r.apply_as(AGENT, ops);
        }
        let deleted = self.s.delete_set().diff(&before);
        self.sessions.agent_deleted(deleted, self.clock);
        self.room_store();
        self.hear();
        tally.agent_edits += 1;
    }

    /// The agent undoes (or redoes) its last step on the open room, as the
    /// room's live Undo does; what that deletes is held too.
    fn agent_undo(&mut self, rng: &mut Rng, tally: &mut Tally) {
        if self.open {
            self.agent_step(rng.chance(0.3), tally);
        }
    }

    /// The agent's Undo (or Redo) of its last step on the open room.
    fn agent_step(&mut self, redo: bool, tally: &mut Tally) {
        let before = self.s.delete_set();
        let (s, r) = if redo {
            (self.agent_s.redo_blocking(), self.agent_r.redo_blocking())
        } else {
            (self.agent_s.undo_blocking(), self.agent_r.undo_blocking())
        };
        self.twins_agree &= s == r;
        if !s {
            return;
        }
        self.s.refresh();
        self.r.refresh();
        let deleted = self.s.delete_set().diff(&before);
        self.sessions.agent_deleted(deleted, self.clock);
        self.room_store();
        self.hear();
        tally.agent_undos += 1;
    }

    /// A day passes at once: every editor's Undo and the agent's are gone
    /// (24 h), and the sessions away that long, and every hold, expire.
    fn day_passes(&mut self, tally: &mut Tally) {
        self.clock += DAY;
        for t in &mut self.tabs {
            t.ug.clear_all();
            t.ur.clear_all();
        }
        self.agent_s.clear_all();
        self.agent_r.clear_all();
        tally.days += 1;
    }

    /// A fold: replay the stored state, collect it at the window the room's
    /// sessions allow into the new base, keep that window as the latest, and
    /// store the folded document as the next window candidate. With no row
    /// since the last fold there is nothing to fold.
    fn fold(&mut self, tally: &mut Tally) {
        if self.rows.is_empty() {
            return;
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
        let holds = self.sessions.holds(self.clock);
        let now = Window::of(&folded.doc.transact(), self.version);
        let window = match holds.reached {
            None => Some(now.clone()),
            Some(reached) => gc::window_for(&self.windows, reached).cloned(),
        };
        self.base = match window {
            Some(window) => {
                let live_room = self.open.then(|| self.s.doc.client_id());
                let collected = gc::collect(&folded.doc, &window, &holds.held, live_room);
                let loaded = Note::load(1, "s", &collected.state);
                let same_vector =
                    loaded.doc.transact().state_vector() == folded.doc.transact().state_vector();
                if loaded.value() != whole.value() || loaded.pending() || !same_vector {
                    tally.load_differs += 1;
                }
                // Every tab that would come back raw names only kept units.
                for t in self.tabs.iter().filter(|t| {
                    t.st != St::Left
                        && !sessions::late(
                            window.stored_version,
                            t.reached as u64,
                            self.sessions.lost(t.client()),
                        )
                }) {
                    tally.unnameable +=
                        named_but_collected(&t.g.doc, &folded.doc, &loaded.doc) as u64;
                }
                self.window = self.window.max(window.stored_version);
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
    let (agent_s, agent_r) = (undo_manager(&s, AGENT), undo_manager(&r, AGENT));
    let mut w = World {
        s,
        open: true,
        lives: 1,
        base,
        rows: Vec::new(),
        stored_sv,
        sampled: None,
        r,
        // A note's first load bootstraps it at version 1 (0 is a new tab's,
        // holding nothing).
        version: 1,
        windows: Vec::new(),
        window: 0,
        sessions: sessions::Sessions::default(),
        session_rows: BTreeMap::new(),
        agent_held: None,
        recorded: HashSet::new(),
        damage: None,
        agent_s,
        agent_r,
        clock: UNIX_EPOCH + Duration::from_secs(1_800_000_000),
        tabs: Vec::new(),
        next_client: 10,
        twins_agree: true,
    };
    for _ in 0..3 {
        w.join(&mut rng, tally);
    }
    let steps = 60 + rng.below(60);
    for _ in 1..=steps {
        w.clock += STEP;
        let roll = rng.below(116);
        let open: Vec<usize> = (0..w.tabs.len())
            .filter(|&i| w.tabs[i].st != St::Left)
            .collect();
        match roll {
            // An open tab edits (an offline one keeps a draft), or undoes or
            // redoes one of its own steps.
            0..=54 if !open.is_empty() => {
                let i = open[rng.below(open.len())];
                let t = &mut w.tabs[i];
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
                w.edited(i);
            }
            // An online tab's socket drops.
            55..=60 => {
                let on: Vec<usize> = (0..w.tabs.len())
                    .filter(|&i| w.tabs[i].st == St::Online)
                    .collect();
                if !on.is_empty() {
                    w.drop_tab(on[rng.below(on.len())]);
                    if !w.connected() {
                        w.went(tally);
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
            // An offline tab comes back, or a holding tab resends.
            65..=77 => {
                let away: Vec<usize> = (0..w.tabs.len())
                    .filter(|&i| matches!(w.tabs[i].st, St::Offline | St::Holding))
                    .collect();
                if !away.is_empty() {
                    let i = away[rng.below(away.len())];
                    w.rejoin(i, &mut rng, tally);
                }
            }
            // An online tab leaves: its session ends; the room folds.
            78..=89 => {
                let on: Vec<usize> = (0..w.tabs.len())
                    .filter(|&i| w.tabs[i].st == St::Online)
                    .collect();
                if !on.is_empty() {
                    w.leave(on[rng.below(on.len())]);
                    w.went(tally);
                }
            }
            90..=94 if w.tabs.len() < 8 => w.join(&mut rng, tally),
            95 | 96 => w.contended(&mut rng, tally),
            100..=103 => w.agent_edit(&mut rng, tally),
            104..=106 => w.agent_undo(&mut rng, tally),
            107 | 108 => w.day_passes(tally),
            109 | 110 => w.agent_episode(&mut rng, tally),
            111 | 112 => w.lost_episode(&mut rng, tally),
            113 | 114 => w.day_episode(&mut rng, tally),
            // The room is idle a moment: it folds.
            _ => w.fold(tally),
        }
    }
    // Every tab still away or holding comes back; every open tab syncs.
    for i in 0..w.tabs.len() {
        if matches!(w.tabs[i].st, St::Offline | St::Holding) {
            w.rejoin(i, &mut rng, tally);
        }
    }
    w.open_room(&mut rng, tally);
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

/// How many units a tab holding `view` can name in its next edit that
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
        "gc_views: seeds {} converged {} equals R {} | collections {} (units collected {}, loads differing {}, unnameable {}, reloads differing {}) | contended {} (holding {}) | rejoins raw {} late {} (lost {}, rows damaged {}) | undos {} | agent edits {} undos {} | days {} | episodes agent {} lost {} day {} | {:.1} s",
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
        tally.lost_rejoins,
        tally.damaged,
        tally.undos,
        tally.agent_edits,
        tally.agent_undos,
        tally.days,
        tally.agent_episodes,
        tally.lost_episodes,
        tally.day_episodes,
        started.elapsed().as_secs_f64()
    );
    assert!(tally.failures.is_empty(), "{:?}", tally.failures);
    assert_eq!(tally.load_differs, 0);
    assert_eq!(tally.unnameable, 0);
    assert_eq!(
        tally.reloads_differ, 0,
        "a folded document reads differently after its own reload, collection or not"
    );
    // Not vacuous: collections ran, discarded units, tabs and the agent
    // undid steps, days passed, tabs came back late (some under a lost
    // record) and contended episodes played out.
    assert!(tally.collections > seeds && tally.units > 0 && tally.undos > seeds);
    assert!(tally.agent_undos > seeds / 4 && tally.days > seeds / 2);
    assert!(
        tally.agent_episodes > seeds / 8
            && tally.lost_episodes > seeds / 8
            && tally.day_episodes > seeds / 8
    );
    assert!(tally.late_rejoins > seeds / 4 && tally.lost_rejoins > 0);
    assert!(tally.contended > seeds / 4 && tally.holding > seeds / 8);
    yjs_check(&tally.sample);
}
