//! Document limits and exact metrics (`collaboration/src/limits.ts` on
//! capy-side/plate; Go `materialdoc`): the UTF-8 size of
//! `JSON.stringify({schemaVersion:1, value})` with runtime comment marks
//! stripped from text leaves, the node count and the deepest node.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use yrs::branch::Branch;
use yrs::{Any, ReadTxn};

use crate::json;
use crate::plate::{self, Insert, ProjectionError};

// IMPORTANT: keep in sync with src/lib/const.ts and Go materialdoc.
pub const MAX_CONTENT_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_NODES: u64 = 10_000;
pub const MAX_DEPTH: u32 = 16;
/// Structural validation refuses nesting past this; measurement stops here.
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
/// (at `depth`) into `metrics`.
fn children_len(
    branch: &Branch,
    depth: u32,
    metrics: &mut Metrics,
) -> Result<usize, ProjectionError> {
    let delta = plate::insert_delta(branch)?;
    let counted = depth <= DEPTH_CEILING;
    if delta.is_empty() {
        if counted {
            metrics.node_count += 1;
            metrics.max_depth = metrics.max_depth.max(depth);
        }
        return Ok(2 + 11);
    }
    let mut len = 2 + delta.len() - 1;
    for op in &delta {
        if counted {
            metrics.node_count += 1;
            metrics.max_depth = metrics.max_depth.max(depth);
        }
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

/// Bytes of an element node at `depth`; its children count at `depth + 1`,
/// as long as `depth` is under the ceiling.
fn element_len(
    branch: &Branch,
    depth: u32,
    metrics: &mut Metrics,
) -> Result<usize, ProjectionError> {
    let properties = plate::properties(branch)?;
    let leaf = properties
        .iter()
        .any(|(key, value)| &**key == "text" && !matches!(value, Any::Null | Any::Undefined));
    let mut child_metrics = Metrics::default();
    let children = children_len(
        branch,
        depth + 1,
        if depth < DEPTH_CEILING {
            metrics
        } else {
            &mut child_metrics
        },
    )?;
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
