//! The part of Slate 0.124 the server's headless editors use, over Plate JSON
//! values: paths, operations and how they change the tree (`GeneralTransforms`),
//! and (in submodules) the transforms and core normalization the edit
//! commands call. Text offsets are UTF-16 units, as in JS.

pub mod editor;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type Path = Vec<usize>;
pub type Props = Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SlateError(pub String);

pub type Result<T> = std::result::Result<T, SlateError>;

pub(crate) fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(SlateError(message.into()))
}

/// A Slate operation as JSON (`{"type":"insert_text",...}`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Operation {
    InsertNode {
        path: Path,
        node: Value,
    },
    InsertText {
        path: Path,
        offset: usize,
        text: String,
    },
    MergeNode {
        path: Path,
        position: usize,
        #[serde(default)]
        properties: Props,
    },
    MoveNode {
        path: Path,
        #[serde(rename = "newPath")]
        new_path: Path,
    },
    RemoveNode {
        path: Path,
        node: Value,
    },
    RemoveText {
        path: Path,
        offset: usize,
        text: String,
    },
    SetNode {
        path: Path,
        #[serde(default)]
        properties: Props,
        #[serde(rename = "newProperties", default)]
        new_properties: Props,
    },
    SetSelection {},
    SplitNode {
        path: Path,
        position: usize,
        #[serde(default)]
        properties: Props,
    },
}

/* ------------------------------------------------------------------ nodes */

pub fn is_text(node: &Value) -> bool {
    node.get("text").is_some_and(Value::is_string)
}

pub fn is_element(node: &Value) -> bool {
    node.get("children").is_some_and(Value::is_array)
}

pub fn text(node: &Value) -> &str {
    node.get("text").and_then(Value::as_str).unwrap_or("")
}

pub fn children(node: &Value) -> &[Value] {
    node.get("children")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

pub fn children_mut(node: &mut Value) -> Result<&mut Vec<Value>> {
    match node.get_mut("children") {
        Some(Value::Array(children)) => Ok(children),
        _ => fail("Cannot get the children of a leaf node"),
    }
}

/// UTF-16 length of a Slate string.
pub fn len16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The byte index of a UTF-16 offset (clamped to the end).
pub fn byte_at(text: &str, offset: usize) -> usize {
    let mut units = 0;
    for (index, c) in text.char_indices() {
        if units >= offset {
            return index;
        }
        units += c.len_utf16();
    }
    text.len()
}

/// `text.slice(from, to)` in UTF-16 units.
pub fn slice16(text: &str, from: usize, to: usize) -> &str {
    let start = byte_at(text, from);
    let end = byte_at(text, to.max(from));
    &text[start..end]
}

/// `Node.string`: all text below a node.
pub fn string(node: &Value) -> String {
    let mut out = String::new();
    collect_string(node, &mut out);
    out
}

fn collect_string(node: &Value, out: &mut String) {
    if is_text(node) {
        out.push_str(text(node));
    } else {
        for child in children(node) {
            collect_string(child, out);
        }
    }
}

/// The editor root: a node holding the top-level blocks.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Root {
    pub children: Vec<Value>,
}

impl Root {
    pub fn new(children: Vec<Value>) -> Self {
        Root { children }
    }

    /// `Node.get(root, path)`; the root itself is not a `Value`.
    pub fn get(&self, path: &[usize]) -> Option<&Value> {
        let (first, rest) = path.split_first()?;
        let mut node = self.children.get(*first)?;
        for index in rest {
            if is_text(node) {
                return None;
            }
            node = children(node).get(*index)?;
        }
        Some(node)
    }

    pub fn get_mut(&mut self, path: &[usize]) -> Option<&mut Value> {
        let (first, rest) = path.split_first()?;
        let mut node = self.children.get_mut(*first)?;
        for index in rest {
            if is_text(node) {
                return None;
            }
            node = match node.get_mut("children") {
                Some(Value::Array(children)) => children.get_mut(*index)?,
                _ => return None,
            };
        }
        Some(node)
    }

    pub fn has(&self, path: &[usize]) -> bool {
        path.is_empty() || self.get(path).is_some()
    }

    /// The children list of the node at `path` (the root for `[]`).
    pub fn children_at(&self, path: &[usize]) -> Option<&[Value]> {
        if path.is_empty() {
            return Some(&self.children);
        }
        let node = self.get(path)?;
        if is_text(node) {
            return None;
        }
        node.get("children")?.as_array().map(Vec::as_slice)
    }

    pub fn children_at_mut(&mut self, path: &[usize]) -> Result<&mut Vec<Value>> {
        if path.is_empty() {
            return Ok(&mut self.children);
        }
        match self.get_mut(path) {
            Some(node) if !is_text(node) => children_mut(node),
            _ => fail(format!("Cannot find a descendant at path {path:?}")),
        }
    }

    /// `GeneralTransforms.transform` (selection aside: the server's editors
    /// have none).
    pub fn apply(&mut self, op: &Operation) -> Result<()> {
        match op {
            Operation::InsertNode { path, node } => {
                let (index, parent) = split_last(path)?;
                let children = self.children_at_mut(parent)?;
                if index > children.len() {
                    return fail("Cannot apply an \"insert_node\" operation past the end");
                }
                children.insert(index, node.clone());
            }
            Operation::InsertText { path, offset, text } => {
                if text.is_empty() {
                    return Ok(());
                }
                let leaf = self.leaf_mut(path)?;
                let current = self::text(leaf).to_owned();
                let at = byte_at(&current, *offset);
                let next = format!("{}{}{}", &current[..at], text, &current[at..]);
                leaf["text"] = Value::String(next);
            }
            Operation::MergeNode { path, .. } => {
                let (index, parent) = split_last(path)?;
                if index == 0 {
                    return fail("Cannot get the previous path of a first child path");
                }
                let children = self.children_at_mut(parent)?;
                let node = children
                    .get(index)
                    .cloned()
                    .ok_or_else(|| SlateError("merge_node: no node".into()))?;
                let prev = &mut children[index - 1];
                if is_text(&node) && is_text(prev) {
                    let merged = format!("{}{}", self::text(prev), self::text(&node));
                    prev["text"] = Value::String(merged);
                } else if is_element(&node) && is_element(prev) {
                    let extra = self::children(&node).to_vec();
                    children_mut(prev)?.extend(extra);
                } else {
                    return fail(
                        "Cannot apply a \"merge_node\" operation to nodes of different interfaces",
                    );
                }
                children.remove(index);
            }
            Operation::MoveNode { path, new_path } => {
                if is_ancestor(path, new_path) {
                    return fail("Cannot move a path into itself");
                }
                let node = self
                    .get(path)
                    .cloned()
                    .ok_or_else(|| SlateError("move_node: no node".into()))?;
                let (index, parent) = split_last(path)?;
                self.children_at_mut(parent)?.remove(index);
                let true_path = transform_path(path, op)
                    .ok_or_else(|| SlateError("move_node: no path".into()))?;
                let (new_index, new_parent) = split_last(&true_path)?;
                let children = self.children_at_mut(new_parent)?;
                if new_index > children.len() {
                    return fail("move_node past the end");
                }
                children.insert(new_index, node);
            }
            Operation::RemoveNode { path, .. } => {
                let (index, parent) = split_last(path)?;
                let children = self.children_at_mut(parent)?;
                if index >= children.len() {
                    return fail("remove_node: no node");
                }
                children.remove(index);
            }
            Operation::RemoveText { path, offset, text } => {
                if text.is_empty() {
                    return Ok(());
                }
                let leaf = self.leaf_mut(path)?;
                let current = self::text(leaf).to_owned();
                let start = byte_at(&current, *offset);
                let end = byte_at(&current, offset + len16(text));
                let next = format!("{}{}", &current[..start], &current[end..]);
                leaf["text"] = Value::String(next);
            }
            Operation::SetNode {
                path,
                properties,
                new_properties,
            } => {
                if path.is_empty() {
                    return fail("Cannot set properties on the root node!");
                }
                let node = self
                    .get_mut(path)
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| SlateError("set_node: no node".into()))?;
                for (key, value) in new_properties {
                    if non_settable(key) {
                        return fail(format!("Cannot set the \"{key}\" property of nodes!"));
                    }
                    if value.is_null() {
                        node.shift_remove(key);
                    } else {
                        node.insert(key.clone(), value.clone());
                    }
                }
                for key in properties.keys() {
                    if !new_properties.contains_key(key) {
                        node.shift_remove(key);
                    }
                }
            }
            Operation::SetSelection {} => {}
            Operation::SplitNode {
                path,
                position,
                properties,
            } => {
                let (index, parent) = split_last(path)?;
                let children = self.children_at_mut(parent)?;
                let node = children
                    .get_mut(index)
                    .ok_or_else(|| SlateError("split_node: no node".into()))?;
                let mut next = Map::new();
                if is_text(node) {
                    let current = text(node).to_owned();
                    let at = byte_at(&current, *position);
                    node["text"] = Value::String(current[..at].to_owned());
                    next.insert("text".into(), Value::String(current[at..].to_owned()));
                } else {
                    let list = children_mut(node)?;
                    let after = list.split_off((*position).min(list.len()));
                    next.insert("children".into(), Value::Array(after));
                }
                for (key, value) in properties {
                    if non_settable(key) {
                        return fail(format!("Cannot set the \"{key}\" property of nodes!"));
                    }
                    if !value.is_null() {
                        next.insert(key.clone(), value.clone());
                    }
                }
                children.insert(index + 1, Value::Object(next));
            }
        }
        Ok(())
    }

    fn leaf_mut(&mut self, path: &[usize]) -> Result<&mut Value> {
        match self.get_mut(path) {
            Some(node) if is_text(node) => Ok(node),
            _ => fail(format!("Cannot get the leaf node at path {path:?}")),
        }
    }
}

/// `children`, `text` and the names of `Object.prototype`.
fn non_settable(key: &str) -> bool {
    matches!(
        key,
        "children"
            | "text"
            | "constructor"
            | "__defineGetter__"
            | "__defineSetter__"
            | "hasOwnProperty"
            | "__lookupGetter__"
            | "__lookupSetter__"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "toString"
            | "valueOf"
            | "__proto__"
            | "toLocaleString"
    )
}

fn split_last(path: &[usize]) -> Result<(usize, &[usize])> {
    match path.split_last() {
        Some((last, parent)) => Ok((*last, parent)),
        None => fail("Cannot get the parent path of the root path"),
    }
}

/* ------------------------------------------------------------------ paths */

pub fn compare(a: &[usize], b: &[usize]) -> std::cmp::Ordering {
    let min = a.len().min(b.len());
    a[..min].cmp(&b[..min])
}

pub fn is_ancestor(a: &[usize], b: &[usize]) -> bool {
    a.len() < b.len() && compare(a, b).is_eq()
}

pub fn is_common(a: &[usize], b: &[usize]) -> bool {
    a.len() <= b.len() && compare(a, b).is_eq()
}

pub fn ends_before(a: &[usize], b: &[usize]) -> bool {
    let Some((last, parent)) = a.split_last() else {
        return false;
    };
    b.len() > parent.len() && b[..parent.len()] == *parent && *last < b[parent.len()]
}

pub fn is_sibling(a: &[usize], b: &[usize]) -> bool {
    a.len() == b.len()
        && !a.is_empty()
        && a[..a.len() - 1] == b[..b.len() - 1]
        && a.last() != b.last()
}

pub fn parent(path: &[usize]) -> Path {
    path[..path.len().saturating_sub(1)].to_vec()
}

pub fn next(path: &[usize]) -> Path {
    let mut next = path.to_vec();
    if let Some(last) = next.last_mut() {
        *last += 1;
    }
    next
}

pub fn previous(path: &[usize]) -> Option<Path> {
    let mut prev = path.to_vec();
    let last = prev.last_mut()?;
    *last = last.checked_sub(1)?;
    Some(prev)
}

pub fn common(a: &[usize], b: &[usize]) -> Path {
    a.iter()
        .zip(b)
        .take_while(|(x, y)| x == y)
        .map(|(x, _)| *x)
        .collect()
}

/// How a path follows a split at its own position (`Path.transform`'s
/// `affinity`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Affinity {
    Forward,
    Backward,
    None,
}

/// `Path.transform(path, op)` with the default affinity.
pub fn transform_path(path: &[usize], op: &Operation) -> Option<Path> {
    transform_path_with(path, op, Affinity::Forward)
}

/// `Path.transform`: where a path points after an operation, or `None` when
/// the operation removed it.
pub fn transform_path_with(path: &[usize], op: &Operation, affinity: Affinity) -> Option<Path> {
    let mut p = path.to_vec();
    if path.is_empty() {
        return Some(p);
    }
    match op {
        Operation::InsertNode { path: o, .. } => {
            if o == &p || ends_before(o, &p) || is_ancestor(o, &p) {
                p[o.len() - 1] += 1;
            }
        }
        Operation::RemoveNode { path: o, .. } => {
            if o == &p || is_ancestor(o, &p) {
                return None;
            } else if ends_before(o, &p) {
                p[o.len() - 1] -= 1;
            }
        }
        Operation::MergeNode {
            path: o, position, ..
        } => {
            if o == &p || ends_before(o, &p) {
                p[o.len() - 1] -= 1;
            } else if is_ancestor(o, &p) {
                p[o.len() - 1] -= 1;
                p[o.len()] += position;
            }
        }
        Operation::SplitNode {
            path: o, position, ..
        } => {
            if o == &p {
                match affinity {
                    Affinity::Forward => *p.last_mut()? += 1,
                    Affinity::Backward => {}
                    Affinity::None => return None,
                }
            } else if ends_before(o, &p) {
                p[o.len() - 1] += 1;
            } else if is_ancestor(o, &p) && path[o.len()] >= *position {
                p[o.len() - 1] += 1;
                p[o.len()] -= position;
            }
        }
        Operation::MoveNode {
            path: o,
            new_path: onp,
        } => {
            if o == onp {
                return Some(p);
            }
            if is_ancestor(o, &p) || o == &p {
                let mut copy = onp.clone();
                if ends_before(o, onp) && o.len() < onp.len() {
                    copy[o.len() - 1] -= 1;
                }
                copy.extend_from_slice(&p[o.len()..]);
                return Some(copy);
            } else if is_sibling(o, onp) && (is_ancestor(onp, &p) || onp == &p) {
                if ends_before(o, &p) {
                    p[o.len() - 1] -= 1;
                } else {
                    p[o.len() - 1] += 1;
                }
            } else if ends_before(onp, &p) || onp == &p || is_ancestor(onp, &p) {
                if ends_before(o, &p) {
                    p[o.len() - 1] -= 1;
                }
                p[onp.len() - 1] += 1;
            } else if ends_before(o, &p) {
                if onp == &p {
                    p[onp.len() - 1] += 1;
                }
                p[o.len() - 1] -= 1;
            }
        }
        _ => {}
    }
    Some(p)
}
