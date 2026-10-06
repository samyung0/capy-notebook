//! The headless Slate editor the Node server opens on a note
//! (`createEditor()` + `withYjs`, `openHeadlessEditor`): Slate 0.124's
//! `apply` (refs, dirty paths), `normalize` and the core `normalizeNode`, and
//! the node and text transforms the server's commands call, at paths and
//! points. Every operation goes to the yrs document as slate-yjs maps it, in
//! the caller's transaction, against the tree as it was before it.
//!
//! The Node editor answers `isInline` and `isVoid` with `false` for every
//! element (no Plate plugins): normalization treats an element child of a
//! text-led element as a block and unwraps it. [Editor::is_inline] keeps that
//! as one switch.

use std::collections::HashSet;

use serde_json::{Map, Value};
use yrs::TransactionMut;
use yrs::branch::BranchPtr;

use super::{
    Affinity, Operation, Path, Props, Root, SlateError, children, common, fail, is_ancestor,
    is_element, is_sibling, is_text, len16, next, parent, previous, slice16, text,
    transform_path_with,
};
use crate::slate_yjs::{self, MapError};

/// A point in the tree: a text's path and a UTF-16 offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Point {
    pub path: Path,
    pub offset: usize,
}

/// `Point.transform`.
pub fn transform_point(point: &Point, op: &Operation, affinity: Affinity) -> Option<Point> {
    let mut path = point.path.clone();
    let mut offset = point.offset;
    match op {
        Operation::InsertNode { .. } | Operation::MoveNode { .. } => {
            path = transform_path_with(&path, op, affinity)?;
        }
        Operation::InsertText {
            path: at,
            offset: o,
            text,
        } => {
            if at == &path && (*o < offset || (*o == offset && affinity == Affinity::Forward)) {
                offset += len16(text);
            }
        }
        Operation::MergeNode {
            path: at, position, ..
        } => {
            if at == &path {
                offset += position;
            }
            path = transform_path_with(&path, op, affinity)?;
        }
        Operation::RemoveText {
            path: at,
            offset: o,
            text,
        } => {
            if at == &path && *o <= offset {
                offset -= (offset - o).min(len16(text));
            }
        }
        Operation::RemoveNode { path: at, .. } => {
            if at == &path || is_ancestor(at, &path) {
                return None;
            }
            path = transform_path_with(&path, op, affinity)?;
        }
        Operation::SplitNode {
            path: at, position, ..
        } => {
            if at == &path {
                if *position == offset && affinity == Affinity::None {
                    return None;
                } else if *position < offset
                    || (*position == offset && affinity == Affinity::Forward)
                {
                    offset -= position;
                    path = transform_path_with(&path, op, Affinity::Forward)?;
                }
            } else {
                path = transform_path_with(&path, op, affinity)?;
            }
        }
        _ => return Some(point.clone()),
    }
    Some(Point { path, offset })
}

/// How existing dirty paths move through operations.
type PathMap<'a> = dyn Fn(&Path) -> Option<Path> + 'a;

/// A path or point that follows the operations applied after it was taken.
#[derive(Debug, Clone, Copy)]
pub struct RefId(usize);

#[derive(Debug, Clone)]
enum Tracked {
    Path(Option<Path>),
    Point(Option<Point>),
}

/// `Path.levels(path)`: the root down to `path`.
fn levels(path: &[usize]) -> Vec<Path> {
    (0..=path.len()).map(|i| path[..i].to_vec()).collect()
}

/// `Path.ancestors(path)`: the root down to `path`'s parent.
fn ancestors(path: &[usize]) -> Vec<Path> {
    (0..path.len()).map(|i| path[..i].to_vec()).collect()
}

fn transformable(op: &Operation) -> bool {
    matches!(
        op,
        Operation::InsertNode { .. }
            | Operation::RemoveNode { .. }
            | Operation::MergeNode { .. }
            | Operation::SplitNode { .. }
            | Operation::MoveNode { .. }
    )
}

/// Every node path below and including `path` of `node`, pre-order
/// (`Node.nodes(node)` mapped onto `path`).
fn subtree_paths(node: &Value, path: &[usize], out: &mut Vec<Path>) {
    out.push(path.to_vec());
    if !is_text(node) {
        for (i, child) in children(node).iter().enumerate() {
            let mut child_path = path.to_vec();
            child_path.push(i);
            subtree_paths(child, &child_path, out);
        }
    }
}

/// `Editor.getDirtyPaths(op)`.
fn dirty_paths(op: &Operation) -> Vec<Path> {
    match op {
        Operation::InsertText { path, .. }
        | Operation::RemoveText { path, .. }
        | Operation::SetNode { path, .. } => levels(path),
        Operation::InsertNode { path, node } => {
            let mut out = levels(path);
            if !is_text(node) {
                let mut below = Vec::new();
                subtree_paths(node, path, &mut below);
                out.extend(below);
            }
            out
        }
        Operation::MergeNode { path, .. } => {
            let mut out = ancestors(path);
            out.extend(previous(path));
            out
        }
        Operation::MoveNode { path, new_path } => {
            if path == new_path {
                return Vec::new();
            }
            let old: Vec<Path> = ancestors(path)
                .iter()
                .filter_map(|a| transform_path_with(a, op, Affinity::Forward))
                .collect();
            let new: Vec<Path> = ancestors(new_path)
                .iter()
                .filter_map(|a| transform_path_with(a, op, Affinity::Forward))
                .collect();
            let mut result = new.last().cloned().unwrap_or_default();
            result.push(*new_path.last().unwrap_or(&0));
            let mut out = old;
            out.extend(new);
            out.push(result);
            out
        }
        Operation::RemoveNode { path, .. } => ancestors(path),
        Operation::SplitNode { path, .. } => {
            let mut out = levels(path);
            out.push(next(path));
            out
        }
        _ => Vec::new(),
    }
}

/// The headless editor on one document's content root, inside one yrs
/// transaction.
pub struct Editor<'t, 'doc> {
    pub root: Root,
    pub txn: &'t mut TransactionMut<'doc>,
    y_root: BranchPtr,
    /// Operations applied, in order (what slate-yjs would flush).
    pub operations: Vec<Operation>,
    dirty: Vec<Path>,
    dirty_keys: HashSet<Path>,
    normalizing: bool,
    batching: bool,
    refs: Vec<(Tracked, Affinity)>,
    /// `editor.isInline`: false for every element, as the Node server's.
    pub is_inline: fn(&Value) -> bool,
}

#[derive(Debug, thiserror::Error)]
pub enum EditorError {
    #[error(transparent)]
    Slate(#[from] SlateError),
    #[error(transparent)]
    Map(#[from] MapError),
}

pub type EResult<T> = std::result::Result<T, EditorError>;

impl From<crate::plate::ProjectionError> for EditorError {
    fn from(error: crate::plate::ProjectionError) -> Self {
        EditorError::Map(MapError::Projection(error))
    }
}

impl<'t, 'doc> Editor<'t, 'doc> {
    /// `openHeadlessEditor`: the projection as the tree, then `connect`'s
    /// forced normalization (whose operations go to the document too).
    pub fn open(txn: &'t mut TransactionMut<'doc>, y_root: BranchPtr) -> EResult<Self> {
        let root = Root::new(crate::plate::children(&y_root)?);
        let mut editor = Editor {
            root,
            txn,
            y_root,
            operations: Vec::new(),
            dirty: Vec::new(),
            dirty_keys: HashSet::new(),
            normalizing: true,
            batching: false,
            refs: Vec::new(),
            is_inline: |_| false,
        };
        editor.normalize(true)?;
        Ok(editor)
    }

    /* ---------------------------------------------------------------- refs */

    pub fn path_ref(&mut self, path: Path) -> RefId {
        self.refs
            .push((Tracked::Path(Some(path)), Affinity::Forward));
        RefId(self.refs.len() - 1)
    }

    pub fn point_ref(&mut self, point: Point, affinity: Affinity) -> RefId {
        self.refs.push((Tracked::Point(Some(point)), affinity));
        RefId(self.refs.len() - 1)
    }

    pub fn current_path(&self, id: RefId) -> Option<Path> {
        match &self.refs[id.0].0 {
            Tracked::Path(path) => path.clone(),
            Tracked::Point(_) => None,
        }
    }

    pub fn current_point(&self, id: RefId) -> Option<Point> {
        match &self.refs[id.0].0 {
            Tracked::Point(point) => point.clone(),
            Tracked::Path(_) => None,
        }
    }

    /// `ref.unref()`: its current value; it stops following operations.
    pub fn unref_path(&mut self, id: RefId) -> Option<Path> {
        let current = self.current_path(id);
        self.refs[id.0].0 = Tracked::Path(None);
        current
    }

    pub fn unref_point(&mut self, id: RefId) -> Option<Point> {
        let current = self.current_point(id);
        self.refs[id.0].0 = Tracked::Point(None);
        current
    }

    /* --------------------------------------------------------------- apply */

    fn update_dirty(&mut self, new: Vec<Path>, transform: Option<&PathMap<'_>>) {
        if let Some(transform) = transform {
            let old = std::mem::take(&mut self.dirty);
            self.dirty_keys.clear();
            for path in old {
                if let Some(path) = transform(&path)
                    && self.dirty_keys.insert(path.clone())
                {
                    self.dirty.push(path);
                }
            }
        }
        for path in new {
            if self.dirty_keys.insert(path.clone()) {
                self.dirty.push(path);
            }
        }
    }

    /// `editor.apply(op)`.
    pub fn apply(&mut self, op: Operation) -> EResult<()> {
        for (tracked, affinity) in &mut self.refs {
            match tracked {
                Tracked::Path(path) => {
                    if let Some(current) = path {
                        *path = transform_path_with(current, &op, *affinity);
                    }
                }
                Tracked::Point(point) => {
                    if let Some(current) = point {
                        *point = transform_point(current, &op, *affinity);
                    }
                }
            }
        }
        if !self.batching {
            let new = dirty_paths(&op);
            if transformable(&op) {
                let op_ref = &op;
                self.update_dirty(
                    new,
                    Some(&|p: &Path| transform_path_with(p, op_ref, Affinity::Forward)),
                );
            } else {
                self.update_dirty(new, None);
            }
        }
        slate_yjs::apply_op(self.txn, self.y_root, &self.root, &op)?;
        self.root.apply(&op)?;
        self.operations.push(op);
        self.normalize(false)
    }

    /// `Editor.withoutNormalizing`: runs `f`, then normalizes once.
    pub fn without_normalizing<T>(
        &mut self,
        f: impl FnOnce(&mut Self) -> EResult<T>,
    ) -> EResult<T> {
        let value = self.normalizing;
        self.normalizing = false;
        let result = f(self);
        self.normalizing = value;
        let result = result?;
        self.normalize(false)?;
        Ok(result)
    }

    /// `Editor.normalize`.
    pub fn normalize(&mut self, force: bool) -> EResult<()> {
        if !self.normalizing {
            return Ok(());
        }
        if force {
            let mut all = vec![Vec::new()];
            for (i, child) in self.root.children.iter().enumerate() {
                subtree_paths(child, &[i], &mut all);
            }
            self.dirty_keys = all.iter().cloned().collect();
            self.dirty = all;
        }
        if self.dirty.is_empty() {
            return Ok(());
        }
        self.without_normalizing_raw(|editor| {
            // Elements with no children first: the default fix inserts a
            // text, which no other path depends on.
            // (The editor itself is not an element.)
            for path in editor.dirty.clone() {
                let empty = !path.is_empty()
                    && editor
                        .root
                        .get(&path)
                        .is_some_and(|n| is_element(n) && children(n).is_empty());
                if empty {
                    editor.normalize_node(&path)?;
                }
            }
            let initial = editor.dirty.len();
            let mut iteration = 0;
            while let Some(path) = editor.dirty.pop() {
                editor.dirty_keys.remove(&path);
                if iteration > initial * 42 {
                    return Err(SlateError(format!(
                        "Could not completely normalize the editor after {} iterations!",
                        initial * 42
                    ))
                    .into());
                }
                if editor.root.has(&path) {
                    editor.normalize_node(&path)?;
                }
                iteration += 1;
            }
            Ok(())
        })
    }

    /// `withoutNormalizing` as `normalize` itself runs it: the trailing
    /// normalize finds nothing dirty.
    fn without_normalizing_raw(&mut self, f: impl FnOnce(&mut Self) -> EResult<()>) -> EResult<()> {
        let value = self.normalizing;
        self.normalizing = false;
        let result = f(self);
        self.normalizing = value;
        result?;
        self.normalize(false)
    }

    /// The children of the node at `path` (the root for `[]`).
    fn kids(&self, path: &[usize]) -> &[Value] {
        self.root.children_at(path).unwrap_or(&[])
    }

    /// Slate's core `normalizeNode` with `isInline` and `isVoid` false.
    fn normalize_node(&mut self, path: &[usize]) -> EResult<()> {
        let is_root = path.is_empty();
        if !is_root {
            match self.root.get(path) {
                Some(node) if is_text(node) => return Ok(()),
                Some(node) if !is_element(node) => {
                    // `node.children = []`, in place: no operation.
                    if let Some(map) = self.root.get_mut(path).and_then(Value::as_object_mut) {
                        map.insert("children".into(), Value::Array(Vec::new()));
                    }
                }
                None => return Ok(()),
                _ => {}
            }
        }
        if !is_root && self.kids(path).is_empty() {
            let mut at = path.to_vec();
            at.push(0);
            self.insert_nodes(
                at,
                vec![Map::from_iter([("text".to_owned(), Value::from(""))]).into()],
            )?;
        }
        let inline = self.is_inline;
        let should_have_inlines = !is_root
            && (inline(self.root.get(path).unwrap_or(&Value::Null))
                || self
                    .kids(path)
                    .first()
                    .is_some_and(|c| is_text(c) || inline(c)));
        let mut n: isize = 0;
        if should_have_inlines {
            while (n as usize) < self.kids(path).len() {
                let kids = self.kids(path);
                let child = kids[n as usize].clone();
                let prev = if n > 0 {
                    Some(kids[n as usize - 1].clone())
                } else {
                    None
                };
                let mut at = path.to_vec();
                if is_text(&child) {
                    if let Some(prev) = prev.filter(is_text) {
                        if text(&child).is_empty() {
                            at.push(n as usize);
                            self.remove_node(at)?;
                            n -= 1;
                        } else if text(&prev).is_empty() {
                            at.push(n as usize - 1);
                            self.remove_node(at)?;
                            n -= 1;
                        } else if loose_equal(&child, &prev) {
                            at.push(n as usize);
                            self.merge_nodes_at_path(at)?;
                            n -= 1;
                        }
                    }
                } else if inline(&child) {
                    if prev.as_ref().is_none_or(|p| !is_text(p)) {
                        at.push(n as usize);
                        self.insert_nodes(at.clone(), vec![empty_text()])?;
                        at.pop();
                        n += 1;
                    }
                    if n as usize == self.kids(path).len() - 1 {
                        at.push(n as usize + 1);
                        self.insert_nodes(at, vec![empty_text()])?;
                        n += 1;
                    }
                } else {
                    at.push(n as usize);
                    self.unwrap_nodes_at(at)?;
                    n -= 1;
                }
                n += 1;
            }
        } else {
            while (n as usize) < self.kids(path).len() {
                let child = &self.kids(path)[n as usize];
                if is_text(child) || inline(child) {
                    let mut at = path.to_vec();
                    at.push(n as usize);
                    self.remove_node(at)?;
                    n -= 1;
                }
                n += 1;
            }
        }
        Ok(())
    }

    /* ----------------------------------------------------------- transforms */

    /// `Transforms.insertNodes(editor, nodes, { at: path })`.
    pub fn insert_nodes(&mut self, at: Path, nodes: Vec<Value>) -> EResult<()> {
        self.without_normalizing(|editor| {
            if nodes.is_empty() {
                return Ok(());
            }
            let parent_path = parent(&at);
            let first = *at
                .last()
                .ok_or_else(|| SlateError("insert at the root".into()))?;
            // Batched dirty paths: the inserted subtrees and the parent's levels,
            // the old ones transformed by every insert.
            let mut new_dirty = levels(&parent_path);
            let mut batched = Vec::new();
            editor.batching = true;
            let mut result = Ok(());
            for (index, node) in (first..).zip(nodes) {
                let mut path = parent_path.clone();
                path.push(index);
                if is_text(&node) {
                    new_dirty.push(path.clone());
                } else {
                    subtree_paths(&node, &path, &mut new_dirty);
                }
                let op = Operation::InsertNode { path, node };
                batched.push(op.clone());
                result = editor.apply(op);
                if result.is_err() {
                    break;
                }
            }
            editor.batching = false;
            result?;
            let transform = |p: &Path| {
                let mut current = p.clone();
                for op in &batched {
                    current = transform_path_with(&current, op, Affinity::Forward)?;
                }
                Some(current)
            };
            editor.update_dirty(new_dirty, Some(&transform));
            Ok(())
        })
    }

    /// `Transforms.removeNodes(editor, { at: path })`.
    pub fn remove_node(&mut self, at: Path) -> EResult<()> {
        self.without_normalizing(|editor| {
            let node =
                editor.root.get(&at).cloned().ok_or_else(|| {
                    SlateError(format!("Cannot find a descendant at path {at:?}"))
                })?;
            editor.apply(Operation::RemoveNode { path: at, node })
        })
    }

    /// `Transforms.setNodes(editor, props, { at: path })`.
    pub fn set_nodes_at(&mut self, at: Path, props: &Props) -> EResult<()> {
        self.without_normalizing(|editor| {
            if at.is_empty() {
                return Ok(());
            }
            let node = editor
                .root
                .get(&at)
                .and_then(Value::as_object)
                .cloned()
                .ok_or_else(|| SlateError(format!("Cannot find a descendant at path {at:?}")))?;
            let mut properties = Map::new();
            let mut new_properties = Map::new();
            let mut changes = false;
            for (key, value) in props {
                if matches!(key.as_str(), "children" | "text") {
                    continue;
                }
                let current = node.get(key);
                if !strict_equal(value, current) {
                    changes = true;
                    if let Some(current) = current {
                        properties.insert(key.clone(), current.clone());
                    }
                    if !value.is_null() {
                        new_properties.insert(key.clone(), value.clone());
                    }
                }
            }
            if changes {
                editor.apply(Operation::SetNode {
                    path: at,
                    properties,
                    new_properties,
                })?;
            }
            Ok(())
        })
    }

    /// `Transforms.moveNodes(editor, { at: path, to })`.
    pub fn move_node(&mut self, at: Path, to: Path) -> EResult<()> {
        self.without_normalizing(|editor| {
            if !at.is_empty() {
                editor.apply(Operation::MoveNode {
                    path: at,
                    new_path: to,
                })?;
            }
            Ok(())
        })
    }

    /// `Transforms.unwrapNodes(editor, { at: path, voids: true })`: lifts the
    /// node's children into its parent.
    pub fn unwrap_nodes_at(&mut self, at: Path) -> EResult<()> {
        self.without_normalizing(|editor| {
            let count = editor.kids(&at).len();
            let refs: Vec<RefId> = (0..count)
                .map(|i| {
                    let mut child = at.clone();
                    child.push(i);
                    editor.path_ref(child)
                })
                .collect();
            for id in refs {
                let Some(path) = editor.unref_path(id) else {
                    continue;
                };
                editor.lift_node(path)?;
            }
            Ok(())
        })
    }

    /// `Transforms.liftNodes(editor, { at: path })` for one node.
    fn lift_node(&mut self, path: Path) -> EResult<()> {
        self.without_normalizing(|editor| {
            if path.len() < 2 {
                return fail(format!(
                    "Cannot lift node at a path {path:?} because it has a depth of less than `2`."
                ))
                .map_err(Into::into);
            }
            let parent_path = parent(&path);
            let index = *path.last().unwrap_or(&0);
            let length = editor.kids(&parent_path).len();
            if length == 1 {
                editor.move_node(path, next(&parent_path))?;
                editor.remove_node(parent_path)?;
            } else if index == 0 {
                editor.move_node(path, parent_path)?;
            } else if index == length - 1 {
                editor.move_node(path, next(&parent_path))?;
            } else {
                editor.split_nodes_at_path(next(&path))?;
                editor.move_node(path, next(&parent_path))?;
            }
            Ok(())
        })
    }

    /// `Transforms.splitNodes(editor, { at: path })`: splits the parent
    /// before the node at `path`.
    fn split_nodes_at_path(&mut self, path: Path) -> EResult<()> {
        self.without_normalizing(|editor| {
            let parent_path = parent(&path);
            let node = editor
                .root
                .get(&parent_path)
                .cloned()
                .ok_or_else(|| SlateError("split: no parent".into()))?;
            let mut properties = node.as_object().cloned().unwrap_or_default();
            properties.shift_remove(if is_text(&node) { "text" } else { "children" });
            editor.apply(Operation::SplitNode {
                path: parent_path,
                position: *path.last().unwrap_or(&0),
                properties,
            })
        })
    }

    /// `Transforms.mergeNodes(editor, { at: path, voids: true })` for a node
    /// and its previous sibling.
    pub fn merge_nodes_at_path(&mut self, at: Path) -> EResult<()> {
        self.without_normalizing(|editor| {
            let Some(prev_path) = previous(&at) else {
                return Ok(());
            };
            editor.merge(at, prev_path)
        })
    }

    /// The end of mergeNodes: `current` at `path` merges into `prev`.
    fn merge(&mut self, path: Path, prev_path: Path) -> EResult<()> {
        if path.is_empty() || prev_path.is_empty() {
            return Ok(());
        }
        let node = self
            .root
            .get(&path)
            .cloned()
            .ok_or_else(|| SlateError("merge: no node".into()))?;
        let prev = self
            .root
            .get(&prev_path)
            .cloned()
            .ok_or_else(|| SlateError("merge: no previous".into()))?;
        let new_path = next(&prev_path);
        let common_path = common(&path, &prev_path);
        let previous_sibling = is_sibling(&path, &prev_path);
        // The highest ancestor of `path` below the common one that holds
        // nothing but this node: removed once the node moves out.
        let mut empty_ancestor = None;
        for level in common_path.len()..path.len() {
            let ancestor = &path[..level];
            if ancestor.len() <= common_path.len() {
                continue;
            }
            if self.root.get(ancestor).is_some_and(single_child_nest) {
                empty_ancestor = Some(ancestor.to_vec());
                break;
            }
        }
        let empty_ref = empty_ancestor.map(|p| self.path_ref(p));
        let (position, properties) = if is_text(&node) && is_text(&prev) {
            let mut rest = node.as_object().cloned().unwrap_or_default();
            rest.shift_remove("text");
            (len16(text(&prev)), rest)
        } else if is_element(&node) && is_element(&prev) {
            let mut rest = node.as_object().cloned().unwrap_or_default();
            rest.shift_remove("children");
            (children(&prev).len(), rest)
        } else {
            return Err(SlateError(format!(
                "Cannot merge the node at path {path:?} with the previous sibling because it is not the same kind"
            ))
            .into());
        };
        if !previous_sibling {
            self.move_node(path.clone(), new_path.clone())?;
        }
        if let Some(id) = empty_ref
            && let Some(empty) = self.current_path(id)
        {
            self.remove_node(empty)?;
        }
        let remove_prev = (is_element(&prev)
            && (children(&prev).is_empty()
                || (children(&prev).len() == 1
                    && is_text(&children(&prev)[0])
                    && text(&children(&prev)[0]).is_empty())))
            || (is_text(&prev) && text(&prev).is_empty() && prev_path.last() != Some(&0));
        if remove_prev {
            self.remove_node(prev_path)?;
        } else {
            self.apply(Operation::MergeNode {
                path: new_path,
                position,
                properties,
            })?;
        }
        if let Some(id) = empty_ref {
            self.unref_path(id);
        }
        Ok(())
    }

    /// `Transforms.mergeNodes(editor, { at: point, hanging: true })`: the
    /// lowest block holding `point` into the block before it.
    fn merge_blocks_at_point(&mut self, point: Point) -> EResult<()> {
        self.without_normalizing(|editor| {
            let Some(current) = editor.lowest_block(&point.path) else {
                return Ok(());
            };
            let Some(before) = editor.point_before(&point) else {
                return Ok(());
            };
            let Some(prev) = editor.lowest_block(&before.path) else {
                return Ok(());
            };
            editor.merge(current, prev)
        })
    }

    /// The deepest element on the way to `path` (`Editor.nodes` with a block
    /// match in `lowest` mode; every element is a block here).
    fn lowest_block(&self, path: &[usize]) -> Option<Path> {
        (1..=path.len())
            .rev()
            .map(|i| path[..i].to_vec())
            .find(|p| self.root.get(p).is_some_and(is_element))
    }

    /// `Editor.before(point)` with unit `offset`: one unit back, or the end
    /// of the text before.
    fn point_before(&self, point: &Point) -> Option<Point> {
        if point.offset > 0 {
            return Some(Point {
                path: point.path.clone(),
                offset: point.offset - 1,
            });
        }
        let mut texts = Vec::new();
        collect_texts(&self.root.children, &mut Vec::new(), &mut texts);
        let index = texts.iter().position(|p| p == &point.path)?;
        let path = texts.get(index.checked_sub(1)?)?.clone();
        let offset = len16(text(self.root.get(&path)?));
        Some(Point { path, offset })
    }

    /// `Transforms.delete(editor, { at: { anchor, focus } })` for a forward,
    /// expanded range (the edit commands' span).
    pub fn delete_range(&mut self, start: Point, end: Point) -> EResult<()> {
        self.without_normalizing(|editor| {
            if start == end {
                return Ok(());
            }
            let (start, end) = editor.unhang(start, end);
            let start_block = editor.lowest_block(&parent(&start.path));
            let end_block = editor.lowest_block(&parent(&end.path));
            let across_blocks = matches!((&start_block, &end_block), (Some(a), Some(b)) if a != b);
            let single_text = start.path == end.path;
            // The highest nodes wholly inside the range.
            let mut matches = Vec::new();
            let mut last: Option<Path> = None;
            for path in editor.paths_between(&start.path, &end.path) {
                if last
                    .as_ref()
                    .is_some_and(|l| super::compare(&path, l).is_eq())
                {
                    continue;
                }
                if !super::is_common(&path, &start.path) && !super::is_common(&path, &end.path) {
                    last = Some(path.clone());
                    matches.push(path);
                }
            }
            let refs: Vec<RefId> = matches.into_iter().map(|p| editor.path_ref(p)).collect();
            let start_ref = editor.point_ref(start.clone(), Affinity::Forward);
            let end_ref = editor.point_ref(end.clone(), Affinity::Forward);
            if !single_text && let Some(point) = editor.current_point(start_ref) {
                let leaf = editor.leaf(&point.path)?;
                let removed = slice16(&leaf, start.offset, len16(&leaf)).to_owned();
                if !removed.is_empty() {
                    editor.apply(Operation::RemoveText {
                        path: point.path,
                        offset: start.offset,
                        text: removed,
                    })?;
                }
            }
            let paths: Vec<Path> = refs
                .into_iter()
                .rev()
                .filter_map(|id| editor.unref_path(id))
                .collect();
            for path in paths {
                editor.remove_node(path)?;
            }
            if let Some(point) = editor.current_point(end_ref) {
                let leaf = editor.leaf(&point.path)?;
                let from = if single_text { start.offset } else { 0 };
                let removed = slice16(&leaf, from, end.offset).to_owned();
                if !removed.is_empty() {
                    editor.apply(Operation::RemoveText {
                        path: point.path,
                        offset: from,
                        text: removed,
                    })?;
                }
            }
            if !single_text
                && across_blocks
                && let (Some(point), Some(_)) = (
                    editor.current_point(end_ref),
                    editor.current_point(start_ref),
                )
            {
                editor.merge_blocks_at_point(point)?;
            }
            editor.unref_point(start_ref);
            editor.unref_point(end_ref);
            Ok(())
        })
    }

    /// `Editor.unhangRange` (the delete runs it unless the range ends at the
    /// document's end).
    fn unhang(&self, start: Point, end: Point) -> (Point, Point) {
        let doc_end = self.end_point(&[]);
        if doc_end.as_ref() == Some(&end) {
            return (start, end);
        }
        if start.offset != 0 || end.offset != 0 || end.path.last().is_some_and(|i| *i > 0) {
            return (start, end);
        }
        let block_path = self.lowest_block(&parent(&end.path)).unwrap_or_default();
        let mut texts = Vec::new();
        collect_texts(&self.root.children, &mut Vec::new(), &mut texts);
        let from = texts.iter().position(|p| p == &start.path);
        let to = texts.iter().position(|p| p == &end.path);
        if let (Some(from), Some(to)) = (from, to) {
            for path in texts[from..to].iter().rev() {
                let leaf = self.root.get(path).map(text).unwrap_or("");
                if !leaf.is_empty() || super::compare(path, &block_path).is_lt() {
                    let offset = len16(leaf);
                    return (
                        start,
                        Point {
                            path: path.clone(),
                            offset,
                        },
                    );
                }
            }
        }
        (start, end)
    }

    fn end_point(&self, at: &[usize]) -> Option<Point> {
        let mut path = at.to_vec();
        loop {
            let kids = self.kids(&path);
            if path.is_empty() || self.root.get(&path).is_some_and(|n| !is_text(n)) {
                if kids.is_empty() {
                    return None;
                }
                path.push(kids.len() - 1);
                continue;
            }
            let leaf = self.root.get(&path)?;
            return Some(Point {
                offset: len16(text(leaf)),
                path,
            });
        }
    }

    fn leaf(&self, path: &[usize]) -> EResult<String> {
        match self.root.get(path) {
            Some(node) if is_text(node) => Ok(text(node).to_owned()),
            _ => Err(SlateError(format!("Cannot get the leaf node at path {path:?}")).into()),
        }
    }

    /// Paths `Editor.nodes` visits for a range from `from` to `to` (both text
    /// paths): every node from the root, in document order, that is not
    /// before `from`'s branch and not after `to`.
    fn paths_between(&self, from: &[usize], to: &[usize]) -> Vec<Path> {
        let mut out = vec![Vec::new()];
        fn walk(
            nodes: &[Value],
            prefix: &mut Vec<usize>,
            from: &[usize],
            to: &[usize],
            out: &mut Vec<Path>,
        ) {
            for (i, node) in nodes.iter().enumerate() {
                prefix.push(i);
                let before_from =
                    super::compare(prefix, from).is_lt() && !is_ancestor(prefix, from);
                let after_to = super::compare(prefix, to).is_gt();
                if after_to {
                    prefix.pop();
                    return;
                }
                if !before_from {
                    out.push(prefix.clone());
                    if !is_text(node) {
                        walk(children(node), prefix, from, to, out);
                    }
                }
                prefix.pop();
            }
        }
        walk(&self.root.children, &mut Vec::new(), from, to, &mut out);
        out
    }

    /// `Transforms.insertText(editor, text, { at: point })`.
    pub fn insert_text(&mut self, at: Point, text: &str) -> EResult<()> {
        self.without_normalizing(|editor| {
            if !text.is_empty() {
                editor.apply(Operation::InsertText {
                    path: at.path,
                    offset: at.offset,
                    text: text.to_owned(),
                })?;
            }
            Ok(())
        })
    }
}

/// `{ text: '' }`.
fn empty_text() -> Value {
    Value::Object(Map::from_iter([("text".to_owned(), Value::from(""))]))
}

/// `Text.equals(a, b, { loose: true })`: Slate's `isDeepEqual` without
/// `text`.
fn loose_equal(a: &Value, b: &Value) -> bool {
    let strip = |v: &Value| {
        let mut map = v.as_object().cloned().unwrap_or_default();
        map.shift_remove("text");
        map
    };
    deep_equal(&strip(a), &strip(b))
}

/// Slate's `isDeepEqual` (objects compared key by key, arrays element by
/// element with `===`).
fn deep_equal(a: &Map<String, Value>, b: &Map<String, Value>) -> bool {
    for (key, x) in a {
        let y = b.get(key);
        match (x, y) {
            (Value::Object(x), Some(Value::Object(y))) => {
                if !deep_equal(x, y) {
                    return false;
                }
            }
            (Value::Array(x), Some(Value::Array(y))) => {
                if x.len() != y.len() || x.iter().zip(y).any(|(v, w)| !strict_equal(v, Some(w))) {
                    return false;
                }
            }
            _ => {
                if !strict_equal(x, y) {
                    return false;
                }
            }
        }
    }
    b.keys().all(|k| a.contains_key(k))
}

/// `===` between JSON values from different objects: primitives by value;
/// two distinct objects or arrays are never equal.
fn strict_equal(a: &Value, b: Option<&Value>) -> bool {
    match (a, b) {
        (Value::Null, Some(Value::Null)) => true,
        (Value::Bool(x), Some(Value::Bool(y))) => x == y,
        (Value::Number(x), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Value::String(x), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `hasSingleChildNest`.
fn single_child_nest(node: &Value) -> bool {
    is_text(node) || (children(node).len() == 1 && single_child_nest(&children(node)[0]))
}

fn collect_texts(nodes: &[Value], prefix: &mut Vec<usize>, out: &mut Vec<Path>) {
    for (i, node) in nodes.iter().enumerate() {
        prefix.push(i);
        if is_text(node) {
            out.push(prefix.clone());
        } else {
            collect_texts(children(node), prefix, out);
        }
        prefix.pop();
    }
}
