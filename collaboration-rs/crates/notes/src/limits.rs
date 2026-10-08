//! Document limits and exact metrics (`collaboration/src/limits.ts` on
//! capy-side/plate; Go `materialdoc`): the UTF-8 size of
//! `JSON.stringify({schemaVersion:1, value})` with runtime comment marks
//! stripped from text leaves, the node count and the deepest node.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use yrs::block::ItemContent;
use yrs::branch::Branch;
use yrs::types::TypeRef;
use yrs::updates::encoder::Encode;
use yrs::{Any, ReadTxn, Update};

use crate::json;
use crate::plate::{self, Insert, ProjectionError};

// IMPORTANT: keep in sync with src/lib/const.ts and Go materialdoc.
pub const MAX_CONTENT_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_NODES: u64 = 10_000;
pub const MAX_DEPTH: u32 = 16;
/// Structural validation refuses nesting past this; the projection and
/// [measure] stop here with [ProjectionError::TooDeep] (each recurses once per
/// level, and a writer's update can nest far deeper).
pub const DEPTH_CEILING: u32 = 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub content_bytes: u64,
    pub max_depth: u32,
    pub node_count: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitCode {
    DocumentDepthExceeded,
    DocumentNodesExceeded,
    DocumentSizeExceeded,
    UndoPayloadExceeded,
}

impl LimitCode {
    pub fn as_str(self) -> &'static str {
        match self {
            LimitCode::DocumentDepthExceeded => "document_depth_exceeded",
            LimitCode::DocumentNodesExceeded => "document_nodes_exceeded",
            LimitCode::DocumentSizeExceeded => "document_size_exceeded",
            LimitCode::UndoPayloadExceeded => "undo_payload_exceeded",
        }
    }
}

/// `materialLimitCode`.
pub fn limit_code(metrics: &Metrics) -> Option<LimitCode> {
    if metrics.content_bytes > MAX_CONTENT_BYTES {
        Some(LimitCode::DocumentSizeExceeded)
    } else if metrics.node_count > MAX_NODES {
        Some(LimitCode::DocumentNodesExceeded)
    } else if metrics.max_depth > MAX_DEPTH {
        Some(LimitCode::DocumentDepthExceeded)
    } else {
        None
    }
}

/// `recoversMaterialLimits`: an over-limit document stays editable in the
/// shrinking direction; without a baseline nothing recovers.
pub fn recovers(next: &Metrics, previous: Option<&Metrics>) -> bool {
    previous.is_some_and(|previous| {
        next.content_bytes <= previous.content_bytes
            && next.node_count <= previous.node_count
            && next.max_depth <= previous.max_depth
    })
}

/// A key the stored value leaves out of a text leaf: runtime comment marks.
fn runtime_comment(key: &str) -> bool {
    key == "comment" || key.starts_with("comment_")
}

/// `{"schemaVersion":1,"value":[` and `]}`.
const ENVELOPE_BYTES: u64 = 28 + 2;

/// `measureMaterialValue` over a Plate value.
pub fn measure_value(value: &[Value]) -> Metrics {
    let mut metrics = Metrics {
        content_bytes: ENVELOPE_BYTES + value.len().saturating_sub(1) as u64,
        ..Metrics::default()
    };
    for node in value {
        metrics.content_bytes += node_len(node) as u64;
        visit(node, 0, &mut metrics);
    }
    return metrics;

    fn node_len(node: &Value) -> usize {
        let Value::Object(map) = node else {
            return json::value_len(node);
        };
        let leaf = map.get("text").is_some_and(|text| !text.is_null());
        let mut len = 2;
        let mut entries: usize = 0;
        for (key, item) in map {
            if leaf && runtime_comment(key) {
                continue;
            }
            let item_len = match (key.as_str(), item) {
                ("children", Value::Array(children)) => {
                    2 + children.len().saturating_sub(1)
                        + children.iter().map(node_len).sum::<usize>()
                }
                _ => json::value_len(item),
            };
            len += json::escaped_len(key) + 3 + item_len;
            entries += 1;
        }
        len + entries.saturating_sub(1)
    }

    fn visit(node: &Value, depth: u32, metrics: &mut Metrics) {
        metrics.node_count += 1;
        metrics.max_depth = metrics.max_depth.max(depth);
        if depth >= DEPTH_CEILING {
            return;
        }
        if let Some(Value::Array(children)) = node.get("children") {
            for child in children {
                visit(child, depth + 1, metrics);
            }
        }
    }
}

/// `measureMaterialValue(plateValue(doc))` read straight from the tree,
/// without building the value.
pub fn measure<T: ReadTxn>(txn: &T) -> Result<Metrics, ProjectionError> {
    let mut metrics = Metrics {
        content_bytes: ENVELOPE_BYTES,
        ..Metrics::default()
    };
    match plate::content_root(txn) {
        Some(root) => metrics.content_bytes += children_len(&root, 0, &mut metrics)? as u64 - 2,
        // `[{"text":""}]` without its brackets.
        None => {
            metrics.content_bytes += 11;
            metrics.node_count = 1;
        }
    }
    Ok(metrics)
}

/// Bytes of an element's `"children":[...]` array value, counting its nodes
/// (at `depth`) into `metrics`; past [DEPTH_CEILING] it stops with an error.
fn children_len(
    branch: &Branch,
    depth: u32,
    metrics: &mut Metrics,
) -> Result<usize, ProjectionError> {
    if depth > DEPTH_CEILING {
        return Err(ProjectionError::TooDeep);
    }
    let delta = plate::insert_delta(branch)?;
    if delta.is_empty() {
        metrics.node_count += 1;
        metrics.max_depth = metrics.max_depth.max(depth);
        return Ok(2 + 11);
    }
    let mut len = 2 + delta.len() - 1;
    for op in &delta {
        metrics.node_count += 1;
        metrics.max_depth = metrics.max_depth.max(depth);
        len += match &op.insert {
            Insert::Text(text) => {
                let mut entries = 1;
                let mut node = 2 + 7 + json::escaped_len(text) + 2;
                for attr in &op.attributes {
                    if &*attr.key == "text" || runtime_comment(&attr.key) {
                        continue;
                    }
                    if let Some(value) = json::any_len(&attr.value)? {
                        node += json::escaped_len(&attr.key) + 3 + value;
                        entries += 1;
                    }
                }
                node + entries - 1
            }
            Insert::Element(inner) => element_len(inner, depth, metrics)?,
        };
    }
    Ok(len)
}

/// Bytes of an element node at `depth`; its children count at `depth + 1`.
fn element_len(
    branch: &Branch,
    depth: u32,
    metrics: &mut Metrics,
) -> Result<usize, ProjectionError> {
    let properties = plate::properties(branch)?;
    let leaf = properties
        .iter()
        .any(|(key, value)| &**key == "text" && !matches!(value, Any::Null | Any::Undefined));
    let children = children_len(branch, depth + 1, metrics)?;
    let mut len = 2 + 11 + children;
    let mut entries = 1;
    for (key, value) in &properties {
        if &**key == "children" || (leaf && runtime_comment(key)) {
            continue;
        }
        if let Some(value) = json::any_len(value)? {
            len += json::escaped_len(key) + 3 + value;
            entries += 1;
        }
    }
    Ok(len + entries - 1)
}

/// A writer's update the room may take (`validateUpdate`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    Accepted,
    /// The room cannot place it yet: the server drops it and resyncs.
    Unheld,
}

#[derive(Debug, thiserror::Error)]
pub enum Refusal {
    /// Sent to the writer as `document-rejected` with `code` and `metrics`.
    #[error("invalid material document: {}", code.as_str())]
    Limit { code: LimitCode, metrics: Metrics },
    #[error(transparent)]
    Roots(#[from] crate::validate::RootError),
    #[error(transparent)]
    Update(#[from] ydoc::UpdateError),
    #[error(transparent)]
    Projection(#[from] ProjectionError),
    /// Content the editor never writes, which the projection and the
    /// metrics do not see (Epo, 2026-10-08): refused, not stored unmetered.
    #[error("a note cannot hold {0}")]
    Content(&'static str),
}

/// What a note may hold: its texts strings, formats and element texts, every
/// attribute, mark or marker entry a plain value. Only what the room does not
/// hold yet counts (Yjs skips the rest).
fn plain_content<T: ReadTxn>(txn: &T, incoming: &ydoc::Incoming) -> Result<(), Refusal> {
    fn plain(value: &Any) -> bool {
        match value {
            Any::Buffer(_) | Any::BigInt(_) => false,
            Any::Array(items) => items.iter().all(plain),
            Any::Map(entries) => entries.values().all(plain),
            _ => true,
        }
    }
    let state = txn.state_vector();
    let store = txn.store();
    // Whether an item is a map entry (an attribute or a marker), or none when
    // Yjs drops it (its origin was garbage-collected). An item with an origin
    // does not encode its parent: it takes its origin's, which the room or
    // this update holds. Each item resolves once per update (a pasted run
    // chains every item to the one before it); a chain that loops is none.
    let mut entries: HashMap<yrs::ID, Option<bool>> = HashMap::new();
    let mut entry = |start: &yrs::block::Item| -> Option<bool> {
        let mut chain: Vec<yrs::ID> = Vec::new();
        let mut seen: HashSet<yrs::ID> = HashSet::new();
        let mut item = start;
        let found = loop {
            ydoc::steps::step();
            if let Some(known) = entries.get(item.id()) {
                break *known;
            }
            // A cycle check per step, not a scan of the chain (REVIEW3 M7). Its
            // cost also stays bounded because a long chain cannot get here
            // untried: the trial sizing counts every struct the room lacks, and
            // the trial refuses chains of about 13,000 clients and more
            // (ydoc `a_chain_of_clients_applies_on_a_task_stack`,
            // admit_cost's chained clients).
            if !seen.insert(*item.id()) {
                break None;
            }
            chain.push(*item.id());
            if item.parent_sub().is_some() {
                break Some(true);
            }
            if !matches!(item.update_parent(), yrs::block::UpdateParent::Unknown) {
                break Some(false);
            }
            let Some(origin) = item.origin().or(item.right_origin()) else {
                break None;
            };
            if origin.clock < state.get(&origin.client) {
                break store
                    .get_item(origin)
                    .map(|held| held.parent_sub().is_some());
            }
            match incoming.item_at(origin) {
                Some(next) => item = next,
                None => break None,
            }
        };
        for id in chain {
            entries.insert(id, found);
        }
        found
    };
    for item in incoming.items() {
        let id = item.id();
        if id.clock + item.len() <= state.get(&id.client) {
            continue;
        }
        let Some(entry) = entry(item) else {
            continue;
        };
        let refused = match (entry, item.content()) {
            (_, ItemContent::Deleted(_)) => None,
            (true, ItemContent::Any(values)) if values.iter().all(plain) => None,
            (true, _) => Some("a non-plain attribute value"),
            (false, ItemContent::String(_)) => None,
            (false, ItemContent::Format(_, value)) if plain(value) => None,
            (false, ItemContent::Type(branch)) if matches!(branch.type_ref(), TypeRef::XmlText) => {
                None
            }
            (false, ItemContent::Format(..)) => Some("a non-plain mark value"),
            (false, _) => Some("content other than text in a note text"),
        };
        if let Some(what) = refused {
            return Err(Refusal::Content(what));
        }
    }
    Ok(())
}

/// One note room's limit state between exact measurements (`RoomValidator`):
/// the last exact metrics (the shrink baseline) and an upper bound of the
/// metrics now, the exact ones plus each later update's growth bound. The
/// bound holds only while every content change is an update `admit` checked
/// against the room as it was; the server calls `invalidate` for any other
/// (a service edit, a children pass, a reload).
#[derive(Debug, Default)]
pub struct Validator {
    pub bound: Option<Metrics>,
    pub metrics: Option<Metrics>,
    /// Exact measurements taken (a copy of the room each).
    pub exact_checks: u64,
}

impl Validator {
    /// Checks a writer's update (decoded once by the server) against `doc`
    /// before the server applies it: the bound when it fits, else an exact
    /// measure of a candidate copy. Rejecting after the fact is not an
    /// option: yrs cannot undo a peer's update, so the only remedy left would
    /// be discarding the whole room.
    pub fn admit(&mut self, doc: &yrs::Doc, update: &Update) -> Result<Admission, Refusal> {
        use yrs::Transact;
        let txn = doc.transact();
        crate::validate::assert_roots(&txn)?;
        let incoming = ydoc::Incoming::new(update);
        let inspection = ydoc::inspect(&txn, &incoming)?;
        if inspection.unheld {
            return Ok(Admission::Unheld);
        }
        // An update outside the roots goes to the exact check, which refuses
        // it as such; one inside them must hold only what the editor writes.
        let keeps_roots = crate::validate::keeps_roots(&inspection.containers);
        if keeps_roots {
            plain_content(&txn, &incoming)?;
        }
        // The common case: the room's bound plus this update's growth bound
        // stays within every limit, so the room is not copied per keystroke.
        // The exact measurement below decides anything else, and refuses a
        // root violation.
        let growth = match self.bound {
            Some(_) if keeps_roots && plate::content_root(&txn).is_some() => {
                crate::bound::growth(&txn, &incoming)
            }
            _ => None,
        };
        if let (Some(bound), Some(growth)) = (self.bound, growth) {
            let next = Metrics {
                content_bytes: bound.content_bytes + growth.content_bytes,
                max_depth: bound.max_depth.max(growth.max_depth),
                node_count: bound.node_count + growth.node_count,
            };
            if limit_code(&next).is_none() {
                self.bound = Some(next);
                return Ok(Admission::Accepted);
            }
        }
        self.exact_checks += 1;
        // The trial copy when inspect made one; for a small edit, a copy now.
        let candidate = if let Some(trial) = inspection.trial {
            trial
        } else {
            let candidate = ydoc::scratch_doc();
            let mut copy = candidate.transact_mut();
            let state = txn.encode_state_as_update_v1(&yrs::StateVector::default());
            // yrs applies an update by value: the copy takes it re-encoded.
            let update = update.encode_v1();
            for bytes in [state.as_slice(), update.as_slice()] {
                copy.apply_update(ydoc::decode(bytes)?)
                    .map_err(|error| ydoc::UpdateError::Decode(error.to_string()))?;
            }
            drop(copy);
            candidate
        };
        let candidate_txn = candidate.transact();
        crate::validate::assert_roots(&candidate_txn)?;
        // A document that loaded already over a limit still needs a baseline,
        // or the edits that bring it back under are the ones refused. Between
        // exact measurements the baseline may be older than the room, but then
        // the bound kept the room within every limit, and against a baseline
        // within the limits an over-limit candidate never recovers.
        if self.metrics.is_none() {
            self.metrics = Some(measure(&txn)?);
        }
        let metrics = measure(&candidate_txn)?;
        if let Some(code) = limit_code(&metrics)
            && !recovers(&metrics, self.metrics.as_ref())
        {
            return Err(Refusal::Limit { code, metrics });
        }
        self.bound = Some(metrics);
        self.metrics = Some(metrics);
        Ok(Admission::Accepted)
    }

    /// A content change `admit` did not check entered the room: the next
    /// update measures exactly. The server calls it after every transaction
    /// of its own on the room that commits a non-empty update: agent
    /// commands, replace-block, the children pass, guard verification (which
    /// opens the headless editor, whose normalization may write), a reload.
    pub fn invalidate(&mut self) {
        self.bound = None;
        self.metrics = None;
    }
}
