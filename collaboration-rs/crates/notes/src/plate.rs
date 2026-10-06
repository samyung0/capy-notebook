//! A note's Plate value read from its yrs document, exactly as `@slate-yjs/core`
//! 1.0.2 reads it (`yTextToSlateElement`): each Y.XmlText is an element whose
//! map entries are its properties and whose `toDelta()`, with equal-attribute
//! string runs merged (`normalizeInsertDelta`), gives its children; an element
//! without children gets the placeholder leaf `{"text":""}`.
//!
//! The walk reads items directly (`toDelta` as Yjs 13.6 writes it), so the
//! same pass serves the projection, the exact metrics (`crate::limits`) and the
//! Slate operation mapping (`crate::slate_yjs`).

use std::sync::Arc;

use serde_json::{Map, Value};
use yrs::block::{ItemContent, ItemPtr};
use yrs::branch::{Branch, BranchID, BranchPtr};
use yrs::types::TypeRef;
use yrs::{Any, ID, ReadTxn};

use crate::json::{self, Unencodable};

/// The note's Plate root (a Y.XmlText named `content`).
pub const CONTENT_ROOT: &str = "content";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProjectionError {
    /// slate-yjs reads only Y.XmlText embeds; it throws on anything else.
    #[error("unsupported embed in a note text")]
    Embed,
    /// An element property that is a shared type or a subdocument.
    #[error("unsupported element property {0}")]
    Property(String),
    #[error(transparent)]
    Unencodable(#[from] Unencodable),
}

/// One format attribute of a run: its value and the format item it came from.
/// Slate's `deepEquals` compares arrays element by element with `===`, so two
/// runs' object values are equal only when one item gave both.
#[derive(Debug, Clone)]
pub struct Attr {
    pub key: Arc<str>,
    pub value: Any,
    pub source: ID,
}

#[derive(Debug, Clone)]
pub enum Insert {
    Text(String),
    Element(BranchPtr),
}

/// One entry of a normalized insert delta. No attributes stands for both
/// `undefined` and `{}`: Yjs never writes an empty attribute object.
#[derive(Debug, Clone)]
pub struct DeltaOp {
    pub insert: Insert,
    pub attributes: Vec<Attr>,
}

impl DeltaOp {
    /// Its length in the parent: UTF-16 units for a string, 1 for an element.
    pub fn len(&self) -> u32 {
        match &self.insert {
            Insert::Text(text) => utf16_len(text),
            Insert::Element(_) => 1,
        }
    }
}

pub fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

/// The content root, if the document has one.
pub fn content_root<T: ReadTxn>(txn: &T) -> Option<BranchPtr> {
    BranchID::get_root(txn, CONTENT_ROOT)
}

/// The Y.XmlText an item holds, if it is one.
pub fn xml_text(item: ItemPtr) -> Option<BranchPtr> {
    match item.content() {
        ItemContent::Type(branch) if matches!(branch.type_ref(), TypeRef::XmlText) => {
            Some(BranchPtr::from(branch.as_ref()))
        }
        _ => None,
    }
}

/// `yTextToInsertDelta`: `toDelta()` then `normalizeInsertDelta`.
pub fn insert_delta(branch: &Branch) -> Result<Vec<DeltaOp>, ProjectionError> {
    let mut ops: Vec<DeltaOp> = Vec::new();
    let mut current: Vec<Attr> = Vec::new();
    let mut text = String::new();
    let pack = |ops: &mut Vec<DeltaOp>, text: &mut String, current: &Vec<Attr>| {
        if !text.is_empty() {
            ops.push(DeltaOp {
                insert: Insert::Text(std::mem::take(text)),
                attributes: current.clone(),
            });
        }
    };
    let mut next = branch.start();
    while let Some(item) = next {
        next = item.right();
        if item.is_deleted() {
            continue;
        }
        match item.content() {
            ItemContent::String(chunk) => {
                // Yjs drops a `ychange` attribute at the next string.
                if let Some(at) = current.iter().position(|a| &*a.key == "ychange") {
                    pack(&mut ops, &mut text, &current);
                    current.remove(at);
                }
                text.push_str(chunk.as_str());
            }
            ItemContent::Type(_) | ItemContent::Embed(_) => {
                pack(&mut ops, &mut text, &current);
                let element = xml_text(item).ok_or(ProjectionError::Embed)?;
                ops.push(DeltaOp {
                    insert: Insert::Element(element),
                    attributes: current.clone(),
                });
            }
            ItemContent::Format(key, value) => {
                pack(&mut ops, &mut text, &current);
                let at = current.iter().position(|a| a.key == *key);
                match (value.as_ref(), at) {
                    (Any::Null, Some(at)) => {
                        current.remove(at);
                    }
                    (Any::Null, None) => {}
                    // Map.set keeps an existing key's place.
                    (value, Some(at)) => {
                        current[at].value = value.clone();
                        current[at].source = *item.id();
                    }
                    (value, None) => current.push(Attr {
                        key: key.clone(),
                        value: value.clone(),
                        source: *item.id(),
                    }),
                }
            }
            _ => {}
        }
    }
    pack(&mut ops, &mut text, &current);
    Ok(normalize(ops))
}

/// `normalizeInsertDelta`: drop empty strings, merge adjacent strings whose
/// attributes Slate's `deepEquals` finds equal (the left run keeps its own).
fn normalize(delta: Vec<DeltaOp>) -> Vec<DeltaOp> {
    let mut out: Vec<DeltaOp> = Vec::with_capacity(delta.len());
    for op in delta {
        if let Insert::Text(text) = &op.insert {
            if text.is_empty() {
                continue;
            }
            if let Some(DeltaOp {
                insert: Insert::Text(prev),
                attributes,
            }) = out.last_mut()
            {
                if attributes_equal(attributes, &op.attributes) {
                    prev.push_str(text);
                    continue;
                }
            }
        }
        out.push(op);
    }
    out
}

/// Slate's `deepEquals` over two runs' attribute objects.
pub fn attributes_equal(a: &[Attr], b: &[Attr]) -> bool {
    if a.is_empty() != b.is_empty() {
        return false;
    }
    let undefined = Any::Undefined;
    for x in a {
        let y = b.iter().find(|y| y.key == x.key);
        let same = y.is_some_and(|y| y.source == x.source);
        if !value_equal(&x.value, y.map_or(&undefined, |y| &y.value), same) {
            return false;
        }
    }
    b.iter().all(|y| {
        matches!(y.value, Any::Undefined)
            || a.iter()
                .any(|x| x.key == y.key && !matches!(x.value, Any::Undefined))
    })
}

/// `deepEquals` on one property: plain objects recurse, arrays compare their
/// elements with `===`, anything else with `!==`. `same` says both values are
/// the same JS object (one format item gave both).
fn value_equal(a: &Any, b: &Any, same: bool) -> bool {
    match (a, b) {
        (Any::Map(x), Any::Map(y)) => {
            let undefined = Any::Undefined;
            x.iter()
                .all(|(k, v)| value_equal(v, y.get(k).unwrap_or(&undefined), same))
                && y.iter().all(|(k, v)| {
                    matches!(v, Any::Undefined)
                        || x.get(k).is_some_and(|w| !matches!(w, Any::Undefined))
                })
        }
        (Any::Array(x), Any::Array(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y.iter())
                    .all(|(v, w)| strict_equal(v, w, same))
        }
        _ => strict_equal(a, b, same),
    }
}

/// `===`: primitives by value, objects by identity.
fn strict_equal(a: &Any, b: &Any, same: bool) -> bool {
    match (a, b) {
        (Any::Undefined, Any::Undefined) | (Any::Null, Any::Null) => true,
        (Any::Bool(x), Any::Bool(y)) => x == y,
        (Any::Number(x), Any::Number(y)) => x == y,
        (Any::BigInt(x), Any::BigInt(y)) => x == y,
        (Any::String(x), Any::String(y)) => x == y,
        (Any::Map(_), Any::Map(_))
        | (Any::Array(_), Any::Array(_))
        | (Any::Buffer(_), Any::Buffer(_)) => same,
        _ => false,
    }
}

/// An element's properties (`getAttributes()`), keys sorted: the JS order is
/// the order Yjs integrated them in, which the document does not keep.
pub fn properties(branch: &Branch) -> Result<Vec<(Arc<str>, Any)>, ProjectionError> {
    let mut out = Vec::new();
    for (key, item) in branch.map_items() {
        if item.is_deleted() {
            continue;
        }
        let value = match item.content() {
            ItemContent::Any(values) => values.last().cloned().unwrap_or(Any::Undefined),
            ItemContent::Embed(value) => value.clone(),
            ItemContent::Binary(bytes) => Any::Buffer(bytes.clone().into()),
            ItemContent::JSON(values) => values
                .last()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .map_or(Any::Undefined, |value| json::value_to_any(&value)),
            ItemContent::String(text) => Any::String(text.as_str().into()),
            _ => return Err(ProjectionError::Property(key.to_string())),
        };
        out.push((key.clone(), value));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// `yTextToSlateElement(branch)`: `{...attributes, children}`.
pub fn element(branch: &Branch) -> Result<Value, ProjectionError> {
    let mut node = Map::new();
    for (key, value) in properties(branch)? {
        if !matches!(value, Any::Undefined) {
            node.insert(key.to_string(), json::any_to_value(&value)?);
        }
    }
    node.insert("children".into(), Value::Array(children(branch)?));
    Ok(Value::Object(node))
}

/// An element's children, with the placeholder leaf when it has none.
pub fn children(branch: &Branch) -> Result<Vec<Value>, ProjectionError> {
    let delta = insert_delta(branch)?;
    if delta.is_empty() {
        return Ok(vec![leaf("", &[])?]);
    }
    delta
        .iter()
        .map(|op| match &op.insert {
            Insert::Text(text) => leaf(text, &op.attributes),
            Insert::Element(inner) => element(inner),
        })
        .collect()
}

/// `{...attributes, text}`.
fn leaf(text: &str, attributes: &[Attr]) -> Result<Value, ProjectionError> {
    let mut node = Map::new();
    for attr in attributes {
        node.insert(attr.key.to_string(), json::any_to_value(&attr.value)?);
    }
    node.insert("text".into(), Value::String(text.into()));
    Ok(Value::Object(node))
}

/// `plateValue(document)`: the content root's children (`[{"text":""}]` for
/// an empty or missing root).
pub fn value<T: ReadTxn>(txn: &T) -> Result<Vec<Value>, ProjectionError> {
    match content_root(txn) {
        Some(root) => children(&root),
        None => Ok(vec![leaf("", &[])?]),
    }
}
