//! A note replica edited through the room's slate-yjs mapping, and random
//! editor edits (typing, deletion, Enter, Backspace-merge, marks, block
//! types and attributes, moves, removals, embeds, chart and Mermaid edits),
//! as the tombstone prototype's worlds made them.

use std::collections::BTreeMap;

use notes::plate;
use notes::slate::{self, Operation, Root};
use notes::slate_yjs;
use serde_json::{Map, Value, json};
use yrs::{Doc, ReadTxn, StateVector, Transact};

use super::rng::Rng;

pub const MARKS: [&str; 3] = ["bold", "italic", "code"];

pub struct Note {
    pub doc: Doc,
    pub root: Root,
    pub next_id: u64,
    pub id_prefix: String,
}

pub fn paragraph(id: &str, text: &str) -> Value {
    json!({"type": "p", "id": id, "children": [{"text": text}]})
}

impl Note {
    /// An empty note: one empty paragraph, as a new Plate note starts.
    pub fn new(client_id: u64, prefix: &str) -> Self {
        let doc = Doc::with_options(ydoc::doc_options(client_id));
        doc.get_or_insert_text(plate::CONTENT_ROOT);
        let mut note = Note {
            doc,
            root: Root::default(),
            next_id: 0,
            id_prefix: prefix.to_string(),
        };
        let id = note.new_id();
        note.apply(&[Operation::InsertNode {
            path: vec![0],
            node: paragraph(&id, ""),
        }]);
        note
    }

    /// A replica loaded from a state.
    pub fn load(client_id: u64, prefix: &str, state: &[u8]) -> Self {
        let doc = Doc::with_options(ydoc::doc_options(client_id));
        doc.get_or_insert_text(plate::CONTENT_ROOT);
        doc.transact_mut()
            .apply_update(ydoc::decode(state).expect("decodes"))
            .expect("applies");
        let mut note = Note {
            doc,
            root: Root::default(),
            next_id: 0,
            id_prefix: prefix.to_string(),
        };
        note.refresh();
        note
    }

    pub fn refresh(&mut self) {
        let txn = self.doc.transact();
        self.root = Root::new(plate::value(&txn).expect("projects"));
    }

    pub fn new_id(&mut self) -> String {
        self.next_id += 1;
        format!("{}{}", self.id_prefix, self.next_id)
    }

    /// One transaction of operations made against this replica's tree.
    pub fn apply(&mut self, ops: &[Operation]) {
        self.try_apply(ops).expect("maps");
    }

    /// One transaction of operations, which a twin's tree may refuse.
    pub fn try_apply(&mut self, ops: &[Operation]) -> Result<(), String> {
        let mut txn = self.doc.transact_mut();
        let y_root = plate::content_root(&txn).ok_or("no content root")?;
        slate_yjs::apply_ops(&mut txn, y_root, &mut self.root, ops)
            .map_err(|error| error.to_string())
    }

    pub fn state(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    pub fn value(&self) -> String {
        canonical(&Value::Array(
            plate::value(&self.doc.transact()).expect("projects"),
        ))
    }

    pub fn pending(&self) -> bool {
        let txn = self.doc.transact();
        txn.store().pending_update().is_some() || txn.store().pending_ds().is_some()
    }

    /// Applies an update and projects again.
    pub fn receive(&mut self, update: &[u8]) {
        self.doc
            .transact_mut()
            .apply_update(ydoc::decode(update).expect("decodes"))
            .expect("applies");
        self.refresh();
    }

    fn is_text_block(node: &Value) -> bool {
        node.get("type")
            .and_then(Value::as_str)
            .is_some_and(|t| matches!(t, "p" | "h1" | "h2" | "h3" | "blockquote"))
    }

    /// Top-level indexes of the text blocks.
    pub fn text_blocks(&self) -> Vec<usize> {
        (0..self.root.children.len())
            .filter(|&i| Self::is_text_block(&self.root.children[i]))
            .collect()
    }

    pub fn block_chars(&self, b: usize) -> usize {
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
                let units: usize = text.chars().take(left).map(char::len_utf16).sum();
                return (i, units);
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
    pub fn split_ops(&mut self, b: usize, chars: usize) -> Vec<Operation> {
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

    /// Backspace at the start of text block `b` after text block `b - 1`.
    pub fn merge_ops(&self, b: usize) -> Vec<Operation> {
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
    pub fn remove_ops(&self, b: usize, chars: usize, count: usize) -> Vec<Operation> {
        let node = &self.root.children[b];
        let mut spans = Vec::new();
        let mut start = 0;
        for (i, leaf) in slate::children(node).iter().enumerate() {
            let text = slate::text(leaf);
            let n = text.chars().count();
            let (a, z) = (chars.max(start), (chars + count).min(start + n));
            if a < z {
                let from: usize = text.chars().take(a - start).map(char::len_utf16).sum();
                let removed: String = text.chars().skip(a - start).take(z - a).collect();
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

    pub fn insert_ops(&self, b: usize, chars: usize, text: &str) -> Vec<Operation> {
        let (leaf, offset) = Self::leaf_at(&self.root.children[b], chars);
        vec![Operation::InsertText {
            path: vec![b, leaf],
            offset,
            text: text.to_string(),
        }]
    }

    /// Marks a char range of block `b` on or off, inside one leaf.
    pub fn format_ops(
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
        if let Some(v) = marks.get(mark) {
            old.insert(mark.into(), v.clone());
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
    pub fn normalize_leaves(&self, b: usize) -> Vec<Operation> {
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

    pub fn mermaid(&mut self) -> Value {
        let id = self.new_id();
        json!({"type": "mermaid", "id": id, "source": "graph TD\n  A --> B\n", "children": [{"text": ""}]})
    }
}

pub fn canonical(v: &Value) -> String {
    match v {
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(o) => {
            let sorted: BTreeMap<&String, &Value> = o.iter().collect();
            let fields: Vec<String> = sorted
                .iter()
                .map(|(k, v)| format!("{}:{}", Value::String((*k).clone()), canonical(v)))
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        other => other.to_string(),
    }
}

/// Sends `from`'s units `to` lacks.
pub fn sync(from: &Note, to: &mut Note) {
    let sv = to.doc.transact().state_vector();
    let diff = from.doc.transact().encode_state_as_update_v1(&sv);
    to.receive(&diff);
}

/// One random editor edit's operations (none when the pick does not apply).
fn random_ops(note: &mut Note, rng: &mut Rng) -> Vec<Operation> {
    let blocks = note.text_blocks();
    let all = note.root.children.len();
    if blocks.is_empty() || all == 0 {
        let id = note.new_id();
        return vec![Operation::InsertNode {
            path: vec![all],
            node: paragraph(&id, "fresh"),
        }];
    }
    let b = *rng.pick(&blocks);
    let n = note.block_chars(b);
    match rng.below(100) {
        0..=29 => {
            let at = rng.below(n + 1);
            let text: String = (0..1 + rng.below(6))
                .map(|_| (b'a' + rng.below(26) as u8) as char)
                .collect();
            note.insert_ops(b, at, &text)
        }
        30..=51 => {
            if n == 0 {
                return Vec::new();
            }
            let at = rng.below(n);
            let count = 1 + rng.below((n - at).min(8));
            note.remove_ops(b, at, count)
        }
        52..=59 => {
            let at = rng.below(n + 1);
            note.split_ops(b, at)
        }
        60..=66 => {
            let k = blocks.iter().position(|&x| x == b).unwrap_or(0);
            if k > 0 && blocks[k - 1] + 1 == b {
                note.merge_ops(b)
            } else {
                Vec::new()
            }
        }
        67..=79 => {
            if n < 2 {
                return Vec::new();
            }
            let start = rng.below(n - 1);
            let count = 1 + rng.below((n - start).min(10));
            let mark = *rng.pick(&MARKS);
            note.format_ops(b, start, count, mark, rng.chance(0.7))
        }
        80..=85 => {
            let target = rng.below(all);
            let old = note.root.children[target]
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
            if let Some(v) = note.root.children[target].get(key) {
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
        86..=89 => {
            if all < 3 {
                return Vec::new();
            }
            let target = rng.below(all);
            vec![Operation::RemoveNode {
                path: vec![target],
                node: note.root.children[target].clone(),
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
            let id = note.new_id();
            let node = match rng.below(3) {
                0 => note.mermaid(),
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
                .filter(|&i| note.root.children[i]["type"] == "chart")
                .collect();
            if charts.is_empty() {
                return Vec::new();
            }
            let c = *rng.pick(&charts);
            let old = note.root.children[c]["block"].clone();
            let mut block = old.clone();
            match rng.below(3) {
                0 => block["title"] = json!(format!("t{}", rng.below(100))),
                1 => {
                    if let Some(series) = block["series"].as_array_mut()
                        && !series.is_empty()
                    {
                        let k = rng.below(series.len());
                        series[k]["values"] = json!([rng.below(9), rng.below(9)]);
                    }
                }
                _ => {
                    if let Some(series) = block["series"].as_array_mut() {
                        if rng.chance(0.5) && !series.is_empty() {
                            let k = rng.below(series.len());
                            series.remove(k);
                        } else {
                            let n = rng.below(1000);
                            series.push(
                                json!({"id": format!("s{n}"), "name": "N", "values": [n % 7]}),
                            );
                        }
                    }
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
        _ => {
            let mermaids: Vec<usize> = (0..all)
                .filter(|&i| note.root.children[i]["type"] == "mermaid")
                .collect();
            if mermaids.is_empty() {
                return Vec::new();
            }
            let m = *rng.pick(&mermaids);
            let old = note.root.children[m]["source"]
                .as_str()
                .unwrap_or("")
                .to_string();
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
    }
}

/// A random edit applied to `note`, with Slate's leaf normalization after a
/// mark change. Returns its batches, to replay on a twin.
pub fn edit(note: &mut Note, rng: &mut Rng) -> Vec<Vec<Operation>> {
    let ops = random_ops(note, rng);
    if ops.is_empty() {
        return Vec::new();
    }
    note.apply(&ops);
    let mut batches = vec![ops.clone()];
    if let Some(Operation::SetNode { path, .. }) = ops.last()
        && path.len() == 2
    {
        let norm = note.normalize_leaves(path[0]);
        if !norm.is_empty() {
            note.apply(&norm);
            batches.push(norm);
        }
    }
    batches
}
