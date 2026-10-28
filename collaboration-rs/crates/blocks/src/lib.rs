//! A note room's BlockSuite blocks layout (todo-blocksuite-layout.md): one
//! root map, `blocks`, from block id to a Y.Map of `sys:*` and `prop:*` keys.
//!
//! - [state_from_value] seeds a room from a Plate value (`materials.content`).
//! - [value] projects a room back to a Plate value, so Go, the pipeline and
//!   share pages are unchanged while both editors exist.
//! - [canonical] is a Plate value after the spec's normalizations and derived
//!   ids: `value(state_from_value(v)) == canonical(v)`.
//! - [check] is the structural check and [repair] the repair on entry (D3).
//!
//! Both directions go through one tree of [Block]s: [plate_in] builds it from
//! Plate JSON, [store] writes and reads it in yrs, [plate_out] gives Plate
//! JSON back.

use std::collections::BTreeMap;

use serde_json::Value;
use yrs::{ReadTxn, Transact};

mod check;
mod plate_in;
mod plate_out;
pub mod schema;
mod store;

pub use check::{Repair, Violation, check, repair};
pub use store::blocks_json;

/// The room doc's root map.
pub const BLOCKS_ROOT: &str = "blocks";
/// The fixed ids of the two hub blocks.
pub const ROOT_ID: &str = "root";
pub const NOTE_ID: &str = "note";

/// A Plate value the blocks layout cannot hold.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConvertError {
    #[error("unsupported element type {0:?}")]
    Type(String),
    #[error("unsupported key {key:?} on {ty:?}")]
    Key { ty: String, key: String },
    #[error("unsupported mark {0:?}")]
    Mark(String),
    #[error("malformed {ty:?}: {reason}")]
    Shape { ty: String, reason: String },
}

/// A blocks room [value] cannot project.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProjectionError {
    #[error("the room has no {0} block")]
    MissingHub(&'static str),
    #[error("block {0:?} is missing or malformed")]
    Block(String),
    #[error("block {0:?} is reached twice")]
    Revisited(String),
    #[error("unsupported flavour {0:?}")]
    Flavour(String),
    #[error("block {id:?}: bad prop {key:?}")]
    Prop { id: String, key: String },
    #[error("unsupported text content in {0:?}")]
    Text(String),
}

/// One run of a Y.Text: its string and attributes (Y.Text attribute names).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Run {
    pub text: String,
    pub attrs: BTreeMap<String, Value>,
}

/// A prop value: a Y.Text, or a JSON value `native2Y` writes (objects as
/// Y.Map, arrays as Y.Array, primitives as is).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Prop {
    Text(Vec<Run>),
    Native(Value),
}

/// A block and its subtree.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Block {
    pub id: String,
    pub flavour: String,
    /// Prop names without the `prop:` prefix, in write order.
    pub props: Vec<(String, Prop)>,
    pub children: Vec<Block>,
}

impl Block {
    pub fn prop(&self, key: &str) -> Option<&Prop> {
        self.props.iter().find(|(k, _)| k == key).map(|(_, p)| p)
    }

    pub fn native(&self, key: &str) -> Option<&Value> {
        match self.prop(key) {
            Some(Prop::Native(value)) => Some(value),
            _ => None,
        }
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.native(key).and_then(Value::as_str)
    }

    pub fn text(&self, key: &str) -> Option<&[Run]> {
        match self.prop(key) {
            Some(Prop::Text(runs)) => Some(runs),
            _ => None,
        }
    }

    /// Sets `key`, replacing an earlier value in place.
    pub fn set(&mut self, key: &str, prop: Prop) {
        match self.props.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = prop,
            None => self.props.push((key.to_string(), prop)),
        }
    }
}

/// A fresh room state (v1 update) holding `value`: the `root` and `note` hubs
/// and the note's content (one empty paragraph for an empty value).
/// `client_id` 0 picks a random one.
pub fn state_from_value(value: &[Value], client_id: u64) -> Result<Vec<u8>, ConvertError> {
    let content = plate_in::content(value)?;
    let doc = yrs::Doc::with_options(ydoc::doc_options(client_id));
    let blocks = doc.get_or_insert_map(BLOCKS_ROOT);
    let mut txn = doc.transact_mut();
    store::seed(&mut txn, &blocks, &content);
    Ok(txn.encode_state_as_update_v1(&yrs::StateVector::default()))
}

/// The room's Plate value: the note's subtree, flattened by the indent rule,
/// with the derived ids.
pub fn value<T: ReadTxn>(txn: &T) -> Result<Vec<Value>, ProjectionError> {
    plate_out::value(&store::content(txn)?)
}

/// `value` after the spec's normalizations and derived ids: what
/// `value(state_from_value(value))` gives.
pub fn canonical(value: &[Value]) -> Result<Vec<Value>, ConvertError> {
    let content = plate_in::content(value)?;
    plate_out::value(&content).map_err(|e| ConvertError::Shape {
        ty: "value".into(),
        reason: e.to_string(),
    })
}

/// A JSON number as a JS number gives it back: integers stay integers.
pub(crate) fn number_value(n: f64) -> Value {
    if !n.is_finite() {
        return Value::Null;
    }
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        return Value::from(n as i64);
    }
    serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
}

/// `value` as yrs stores and gives it back (numbers as JS numbers).
pub(crate) fn normalize(value: &Value) -> Value {
    match value {
        Value::Number(n) => number_value(n.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => Value::Array(items.iter().map(normalize).collect()),
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), normalize(v))).collect())
        }
        other => other.clone(),
    }
}
