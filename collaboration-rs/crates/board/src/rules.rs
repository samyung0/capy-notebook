//! The rules a canvas board's elements and blocks keep (RULES.md, Epo
//! 2026-11-22 "sure A then"), the room's copy of the browser's
//! `boardRules.ts`: read side by side, the names match (`element_fits`,
//! `block_fits`, `child_fits`, the entry rules and `merged_cap`).
//!
//! An entity (an element of the canvas, a block of the tree) is checked over
//! its direct keys, each key's stored value read as plain, text, map, array or
//! anything else ([Stored]): strict keys, each value's kind, the required
//! ones present. What its nested types hold is checked item by item as it
//! arrives (the entry rules and [text_content_fits]), so a check never reads
//! more of an entity than its direct keys. Relations two people's honest edits
//! can break together (a mind map's nodes against the canvas, a group's
//! children existing, a connector's ends, the tree's parent links) are not
//! checked (Epo 2026-11-22, "but A seems simpler, do A"); a block under a
//! parent its flavour may not have is ([child_fits]).

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use yrs::Any;
use yrs::block::ItemContent;
use yrs::types::TypeRef;

use ydoc::steps::{Walk, step};

use crate::catalog;

/// The board a canvas room holds: the catalog's workspace canvas.
pub const BOARD: &str = "workspace";

/// Every refusal names its rule; this one is for a struct the board's shape
/// has no place for.
pub const OUTSIDE: &str = "a struct outside the board's shape";

/// A key's stored value as the check reads it: a Yjs Any, a Y.Text, a Y.Map,
/// a Y.Array, or anything else (another Yjs type, an embed), which never
/// fits. A string where a Y.Text belongs is told apart.
#[derive(Clone, Debug, PartialEq)]
pub enum Stored {
    Plain(Any),
    Text,
    Map,
    Array,
    Other,
}

impl Stored {
    /// What an item at a map key stores: none when it is deleted. A map reads
    /// the last value of its item, as Yjs does.
    pub fn of(content: &ItemContent) -> Option<Stored> {
        Some(match content {
            ItemContent::Deleted(_) => return None,
            ItemContent::Any(values) => match values.last() {
                Some(value) => Stored::Plain(value.clone()),
                None => Stored::Other,
            },
            ItemContent::Type(branch) => match branch.type_ref() {
                TypeRef::Text => Stored::Text,
                TypeRef::Map => Stored::Map,
                TypeRef::Array => Stored::Array,
                _ => Stored::Other,
            },
            _ => Stored::Other,
        })
    }
}

/// An entity's direct keys as an update leaves them (an absent key is not
/// here; one holding `undefined` is).
pub type Keys = BTreeMap<Arc<str>, Stored>;

/// A plain object's entries.
pub type Object = HashMap<String, Any>;

/* ---------------------------------------------------------------- enums */

/// A closed set of values: strings, or numbers.
#[derive(Debug)]
pub enum Enum {
    Strs(&'static [&'static str]),
    Nums(&'static [f64]),
}

impl Enum {
    pub fn holds(&self, value: &Any) -> bool {
        match (self, value) {
            (Enum::Strs(values), Any::String(value)) => values.contains(&value.as_ref()),
            (Enum::Nums(values), Any::Number(value)) => values.contains(value),
            _ => false,
        }
    }
}

pub const SHAPE_TYPE: Enum = Enum::Strs(&[
    "rect",
    "ellipse",
    "diamond",
    "triangle",
    "rightTriangle",
    "parallelogram",
    "trapezium",
    "pentagon",
    "hexagon",
]);
pub const SHAPE_STYLE: Enum = Enum::Strs(&["General", "Scribbled"]);
pub const STROKE_STYLE: Enum = Enum::Strs(&["solid", "dash", "none"]);
pub const FONT_STYLE: Enum = Enum::Strs(&["normal", "italic"]);
pub const FONT_WEIGHT: Enum = Enum::Strs(&["300", "400", "500", "600", "700"]);
pub const TEXT_ALIGN: Enum = Enum::Strs(&["left", "center", "right"]);
pub const TEXT_VERTICAL_ALIGN: Enum = Enum::Strs(&["top", "center", "bottom"]);
pub const TEXT_RESIZING: Enum = Enum::Nums(&[0.0, 1.0]);
pub const POINT_STYLE: Enum = Enum::Strs(&["Arrow", "Circle", "Diamond", "None", "Triangle"]);
pub const CONNECTOR_MODE: Enum = Enum::Nums(&[0.0, 1.0, 2.0]);
pub const LABEL_ANCHOR: Enum = Enum::Strs(&["top", "center", "bottom"]);
pub const MINDMAP_LAYOUT_TYPE: Enum = Enum::Nums(&[0.0, 1.0, 2.0]);
pub const MINDMAP_STYLE: Enum = Enum::Nums(&[1.0, 2.0, 3.0, 4.0]);
pub const NOTE_SHADOW: Enum = Enum::Strs(&[
    "",
    "--affine-note-shadow-box",
    "--affine-note-shadow-film",
    "--affine-note-shadow-float",
    "--affine-note-shadow-paper",
    "--affine-note-shadow-sticker",
]);
pub const NOTE_DISPLAY_MODE: Enum = Enum::Strs(&["both", "doc", "edgeless"]);
pub const PARAGRAPH_TYPE: Enum = Enum::Strs(&["text", "quote", "h1", "h2", "h3", "h4", "h5", "h6"]);
pub const LIST_TYPE: Enum = Enum::Strs(&["bulleted", "numbered", "todo", "toggle"]);
const CHART_KIND: Enum = Enum::Strs(&["bar", "pie"]);
const MATERIAL_KIND: Enum = Enum::Strs(&["quiz", "flashcards"]);

/// The enums by the names the browser's parity test writes them under
/// (`tests/parity.rs` compares the two).
pub const ENUMS: &[(&str, &Enum)] = &[
    ("shapeType", &SHAPE_TYPE),
    ("shapeStyle", &SHAPE_STYLE),
    ("strokeStyle", &STROKE_STYLE),
    ("fontStyle", &FONT_STYLE),
    ("fontWeight", &FONT_WEIGHT),
    ("textAlign", &TEXT_ALIGN),
    ("textVerticalAlign", &TEXT_VERTICAL_ALIGN),
    ("textResizing", &TEXT_RESIZING),
    ("pointStyle", &POINT_STYLE),
    ("connectorMode", &CONNECTOR_MODE),
    ("labelAnchor", &LABEL_ANCHOR),
    ("layoutType", &MINDMAP_LAYOUT_TYPE),
    ("mindmapStyle", &MINDMAP_STYLE),
    ("noteShadow", &NOTE_SHADOW),
    ("noteDisplayMode", &NOTE_DISPLAY_MODE),
    ("paragraphType", &PARAGRAPH_TYPE),
    ("listType", &LIST_TYPE),
];

/* ---------------------------------------------------------- value kinds */

/// How many entries a keyed list may hold whose add tools stop at `cap`:
/// twice it, as two people's adds at the same moment merge past the cap (Epo
/// 2026-11-22, "sure A"), the browser's `mergedCap`. The one place the
/// doubling lives.
pub const fn merged_cap(cap: usize) -> usize {
    2 * cap
}

/// UTF-16 units, as JavaScript's `length`.
pub fn utf16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// An id: 1 to 128 of `[A-Za-z0-9_-]`, never `__proto__`.
pub fn is_id(id: &str) -> bool {
    notes::figure_map::valid_id(id) && id != "__proto__"
}

fn finite(value: &Any) -> bool {
    matches!(value, Any::Number(n) if n.is_finite())
}

fn finite_at(object: &Object, key: &str) -> bool {
    object.get(key).is_some_and(finite)
}

fn string(value: &Any) -> bool {
    matches!(value, Any::String(_))
}

fn string_upto(value: &Any, max: usize) -> bool {
    matches!(value, Any::String(text) if utf16(text) <= max)
}

/// Absent or `undefined`: an optional key not given.
fn unset(value: Option<&Any>) -> bool {
    matches!(value, None | Some(Any::Undefined))
}

/// A board colour, as BlockSuite's `Color` stores it (`isColour`): an
/// object with both `dark` and `light` holds strings in both (its
/// `resolveColor` takes them whenever both keys are there), any other holds
/// a string `normal`.
pub fn is_colour(value: &Any) -> bool {
    match value {
        Any::String(_) => true,
        Any::Map(colour) if colour.contains_key("dark") && colour.contains_key("light") => {
            colour.get("dark").is_some_and(string) && colour.get("light").is_some_and(string)
        }
        Any::Map(colour) => colour.get("normal").is_some_and(string),
        _ => false,
    }
}

/// `[x,y,w,h]` as a string of JSON, as the board and its preview read a
/// place (`isPlace`).
pub fn is_place(value: &Any) -> bool {
    let Any::String(text) = value else {
        return false;
    };
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Array(place)) => {
            place.len() == 4
                && place
                    .iter()
                    .all(|n| n.as_f64().is_some_and(|n| n.is_finite()))
        }
        _ => false,
    }
}

/// A plain array of `len` finite numbers.
fn numbers(value: &Any, len: usize) -> bool {
    matches!(value, Any::Array(items) if items.len() == len && items.iter().all(finite))
}

/// A stroke's points: `[x, y]` or `[x, y, pressure]` each.
fn points(value: &Any) -> bool {
    let Any::Array(points) = value else {
        return false;
    };
    points.iter().all(|point| {
        step(Walk::Board);
        numbers(point, 2) || numbers(point, 3)
    })
}

/// A connector's end: on an element (by id) or at a point.
fn connection(value: &Any) -> bool {
    let Any::Map(end) = value else {
        return false;
    };
    end.get("id").is_some_and(string) || end.get("position").is_some_and(|p| numbers(p, 2))
}

fn shadow(value: &Any) -> bool {
    match value {
        Any::Null => true,
        Any::Map(shadow) => {
            ["blur", "offsetX", "offsetY"]
                .iter()
                .all(|key| finite_at(shadow, key))
                && shadow.get("color").is_some_and(is_colour)
        }
        _ => false,
    }
}

fn label_constraints(value: &Any) -> bool {
    matches!(value, Any::Map(c)
        if matches!(c.get("hasMaxWidth"), Some(Any::Bool(_))) && finite_at(c, "maxWidth"))
}

fn label_offset(value: &Any) -> bool {
    matches!(value, Any::Map(offset)
        if finite_at(offset, "distance")
            && (unset(offset.get("anchor"))
                || offset.get("anchor").is_some_and(|a| LABEL_ANCHOR.holds(a))))
}

fn label_style(value: &Any) -> bool {
    let Any::Map(style) = value else {
        return false;
    };
    style.get("color").is_some_and(is_colour)
        && style.get("fontFamily").is_some_and(string)
        && finite_at(style, "fontSize")
        && style.get("fontStyle").is_some_and(|v| FONT_STYLE.holds(v))
        && style
            .get("fontWeight")
            .is_some_and(|v| FONT_WEIGHT.holds(v))
        && style.get("textAlign").is_some_and(|v| TEXT_ALIGN.holds(v))
}

/// Whether a value is plain at every depth: no bytes and no bigint (the
/// browser reads them as a Uint8Array or a bigint, which no rule takes; Yjs
/// writes neither for a board, and its integers read as numbers), and no
/// `__proto__` key (Yjs's `toJSON` turns one into a prototype, which hides
/// its entry from the browser's checks).
pub fn is_plain(value: &Any) -> bool {
    step(Walk::Board);
    match value {
        Any::Buffer(_) | Any::BigInt(_) => false,
        Any::Map(object) => object
            .iter()
            .all(|(key, value)| key != "__proto__" && is_plain(value)),
        Any::Array(items) => items.iter().all(is_plain),
        _ => true,
    }
}

/// What a key's value must be.
#[derive(Clone, Copy)]
enum Kind {
    Str,
    StrUpto(usize),
    /// A string of 1 to this many units.
    Named(usize),
    Finite,
    /// Finite and above zero.
    Positive,
    /// Finite, above zero and at most the catalog's axis top.
    AxisMax,
    FiniteOrNull,
    Bool,
    Colour,
    Place,
    Pair,
    /// Four finite numbers (a connector label's place).
    Quad,
    Points,
    Connection,
    Shadow,
    LabelConstraints,
    LabelOffset,
    LabelStyle,
    /// `false`, or a finite width.
    MaxWidth,
    /// A plain object of boolean values (an element's comments).
    Comments,
    /// `''` or a YouTube video's 11-character id.
    VideoId,
    One(&'static Enum),
    /// A colour, or a map of its `dark`/`light`/`normal` strings (a note's).
    Background,
    Text,
    Map,
    Array,
}

fn plain_fits(kind: Kind, value: &Any) -> bool {
    match kind {
        Kind::Str => string(value),
        Kind::StrUpto(max) => string_upto(value, max),
        Kind::Named(max) => matches!(value, Any::String(text) if (1..=max).contains(&utf16(text))),
        Kind::Finite => finite(value),
        Kind::Positive => matches!(value, Any::Number(n) if n.is_finite() && *n > 0.0),
        Kind::AxisMax => {
            matches!(value, Any::Number(n) if n.is_finite() && *n > 0.0 && *n <= catalog::AXIS_MAX as f64)
        }
        Kind::FiniteOrNull => matches!(value, Any::Null) || finite(value),
        Kind::Bool => matches!(value, Any::Bool(_)),
        Kind::Colour | Kind::Background => is_colour(value),
        Kind::Place => is_place(value),
        Kind::Pair => numbers(value, 2),
        Kind::Quad => numbers(value, 4),
        Kind::Points => points(value),
        Kind::Connection => connection(value),
        Kind::Shadow => shadow(value),
        Kind::LabelConstraints => label_constraints(value),
        Kind::LabelOffset => label_offset(value),
        Kind::LabelStyle => label_style(value),
        Kind::MaxWidth => matches!(value, Any::Bool(false)) || finite(value),
        Kind::Comments => {
            matches!(value, Any::Map(object) if object.values().all(|v| matches!(v, Any::Bool(_))))
        }
        Kind::VideoId => matches!(value, Any::String(id) if id.is_empty() || video_id(id)),
        Kind::One(values) => values.holds(value),
        Kind::Text | Kind::Map | Kind::Array => false,
    }
}

/// Whether a stored value is what `kind` takes; `undefined` is (the
/// required check is apart).
fn stored_fits(kind: Kind, stored: &Stored) -> bool {
    match (kind, stored) {
        (_, Stored::Plain(Any::Undefined)) => true,
        (Kind::Text, Stored::Text) | (Kind::Map, Stored::Map) | (Kind::Array, Stored::Array) => {
            true
        }
        (Kind::Background, Stored::Map) => true,
        (_, Stored::Plain(value)) => plain_fits(kind, value) && is_plain(value),
        _ => false,
    }
}

fn video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/* -------------------------------------------------------- entity tables */

/// One key of an element type or a block flavour.
#[derive(Clone, Copy)]
struct Field {
    name: &'static str,
    kind: Kind,
    required: bool,
}

const fn opt(name: &'static str, kind: Kind) -> Field {
    Field {
        name,
        kind,
        required: false,
    }
}

const fn req(name: &'static str, kind: Kind) -> Field {
    Field {
        name,
        kind,
        required: true,
    }
}

use Kind::*;

/// Every element's keys besides `type` and `id`, which [element_fits] reads.
const ELEMENT_BASE: &[Field] = &[
    opt("index", Str),
    opt("seed", Finite),
    opt("hidden", Bool),
    opt("lockedBySelf", Bool),
    opt("comments", Comments),
];

const BRUSH: &[Field] = &[
    opt("color", Colour),
    opt("lineWidth", Finite),
    opt("points", Points),
    opt("rotate", Finite),
    req("xywh", Place),
];

const SHAPE: &[Field] = &[
    opt("color", Colour),
    opt("fillColor", Colour),
    opt("filled", Bool),
    opt("fontFamily", Str),
    opt("fontSize", Finite),
    opt("fontStyle", One(&FONT_STYLE)),
    opt("fontWeight", One(&FONT_WEIGHT)),
    opt("maxWidth", MaxWidth),
    opt("padding", Pair),
    opt("radius", Finite),
    opt("rotate", Finite),
    opt("roughness", Finite),
    opt("shadow", Shadow),
    opt("shapeStyle", One(&SHAPE_STYLE)),
    req("shapeType", One(&SHAPE_TYPE)),
    opt("strokeColor", Colour),
    opt("strokeStyle", One(&STROKE_STYLE)),
    opt("strokeWidth", Finite),
    opt("text", Text),
    opt("textAlign", One(&TEXT_ALIGN)),
    opt("textHorizontalAlign", One(&TEXT_ALIGN)),
    opt("textResizing", One(&TEXT_RESIZING)),
    opt("textVerticalAlign", One(&TEXT_VERTICAL_ALIGN)),
    req("xywh", Place),
];

/// A connector stores no place or turn: its ends make them.
const CONNECTOR: &[Field] = &[
    opt("frontEndpointStyle", One(&POINT_STYLE)),
    opt("rearEndpointStyle", One(&POINT_STYLE)),
    opt("labelConstraints", LabelConstraints),
    opt("labelDisplay", Bool),
    opt("labelOffset", LabelOffset),
    opt("labelStyle", LabelStyle),
    opt("labelXYWH", Quad),
    req("mode", One(&CONNECTOR_MODE)),
    opt("rough", Bool),
    opt("roughness", Finite),
    req("source", Connection),
    req("target", Connection),
    opt("stroke", Colour),
    opt("strokeStyle", One(&STROKE_STYLE)),
    opt("strokeWidth", Finite),
    opt("text", Text),
];

const TEXT: &[Field] = &[
    opt("color", Colour),
    opt("fontFamily", Str),
    opt("fontSize", Finite),
    opt("fontStyle", One(&FONT_STYLE)),
    opt("fontWeight", One(&FONT_WEIGHT)),
    opt("hasMaxWidth", Bool),
    opt("rotate", Finite),
    req("text", Text),
    opt("textAlign", One(&TEXT_ALIGN)),
    req("xywh", Place),
];

/// A group's and a mind map's place comes from what they hold.
const GROUP: &[Field] = &[req("children", Map), req("title", Text)];

const MINDMAP: &[Field] = &[
    req("children", Map),
    req("layoutType", One(&MINDMAP_LAYOUT_TYPE)),
    req("style", One(&MINDMAP_STYLE)),
];

const PLANE: &[Field] = &[
    opt("fit", Bool),
    req("elements", Map),
    opt("polar", Bool),
    req("ppu", Positive),
    opt("rotate", Finite),
    req("x0", Finite),
    req("y0", Finite),
    req("xywh", Place),
];

const CHART: &[Field] = &[
    req("axisMax", AxisMax),
    req("axisStep", Positive),
    req("bars", Map),
    req("kind", One(&CHART_KIND)),
    req("labels", Map),
    opt("rotate", Finite),
    req("spokes", Map),
    req("xywh", Place),
];

const FORMULA: &[Field] = &[
    req("latex", StrUpto(catalog::LATEX_MAX)),
    opt("rotate", Finite),
    req("xywh", Place),
];

fn element_fields(kind: &str) -> Option<&'static [Field]> {
    Some(match kind {
        "brush" | "highlighter" => BRUSH,
        "shape" => SHAPE,
        "connector" => CONNECTOR,
        "text" => TEXT,
        "group" => GROUP,
        "mindmap" => MINDMAP,
        "plane" => PLANE,
        "chart" => CHART,
        "formula" => FORMULA,
        _ => return None,
    })
}

/// Every block's keys besides `sys:flavour` and `sys:id`, which
/// [block_fits] reads.
const BLOCK_BASE: &[Field] = &[req("sys:children", Array), opt("sys:version", Finite)];

const PAGE: &[Field] = &[opt("prop:title", Text)];

/// The canvas: its elements' holder, a map of `type` and `value` that no
/// update writes again (the first state's).
const SURFACE: &[Field] = &[req("prop:elements", Map)];

const NOTE: &[Field] = &[
    req("prop:xywh", Place),
    opt("prop:rotate", Finite),
    opt("prop:background", Background),
    opt("prop:index", Str),
    opt("prop:lockedBySelf", Bool),
    opt("prop:hidden", Bool),
    opt("prop:displayMode", One(&NOTE_DISPLAY_MODE)),
    opt("prop:edgeless", Map),
    opt("prop:comments", Map),
];

const PARAGRAPH: &[Field] = &[
    opt("prop:type", One(&PARAGRAPH_TYPE)),
    opt("prop:text", Text),
    opt("prop:textAlign", One(&TEXT_ALIGN)),
    opt("prop:collapsed", Bool),
    opt("prop:comments", Map),
];

const LIST: &[Field] = &[
    opt("prop:type", One(&LIST_TYPE)),
    opt("prop:text", Text),
    opt("prop:checked", Bool),
    opt("prop:collapsed", Bool),
    opt("prop:order", FiniteOrNull),
    opt("prop:textAlign", One(&TEXT_ALIGN)),
    opt("prop:comments", Map),
];

const IMAGE: &[Field] = &[
    opt("prop:caption", Str),
    opt("prop:sourceId", Str),
    opt("prop:width", Finite),
    opt("prop:height", Finite),
    opt("prop:size", Finite),
    opt("prop:index", Str),
    opt("prop:xywh", Place),
    opt("prop:lockedBySelf", Bool),
    opt("prop:rotate", Finite),
    opt("prop:textAlign", One(&TEXT_ALIGN)),
    opt("prop:comments", Map),
];

const PICTURE: &[Field] = &[
    opt("prop:index", Str),
    opt("prop:lockedBySelf", Bool),
    req("prop:rotate", Finite),
    req("prop:xywh", Place),
    req("prop:kind", Str),
    req("prop:ref", StrUpto(catalog::PICTURE_REF_MAX)),
    req("prop:label", StrUpto(catalog::PICTURE_LABEL_MAX)),
];

const LINK: &[Field] = &[
    opt("prop:index", Str),
    opt("prop:lockedBySelf", Bool),
    req("prop:rotate", Finite),
    req("prop:xywh", Place),
    req("prop:url", StrUpto(catalog::LINK_URL_MAX)),
    req("prop:videoId", VideoId),
];

const MATERIAL: &[Field] = &[
    opt("prop:index", Str),
    opt("prop:lockedBySelf", Bool),
    req("prop:rotate", Finite),
    req("prop:xywh", Place),
    req("prop:kind", One(&MATERIAL_KIND)),
    req("prop:materialId", Named(catalog::MATERIAL_ID_MAX)),
    req("prop:title", StrUpto(catalog::CARD_TITLE_MAX)),
];

pub const PAGE_FLAVOUR: &str = "affine:page";
pub const SURFACE_FLAVOUR: &str = "affine:surface";
pub const NOTE_FLAVOUR: &str = "affine:note";
const PICTURE_FLAVOUR: &str = "affine:embed-capy-picture";
const LINK_FLAVOUR: &str = "affine:embed-capy-link";

/// Who made and last changed a block, which the paragraph, list and image
/// schemas declare (`BlockMeta`).
const META: &[Field] = &[
    opt("prop:meta:createdAt", Finite),
    opt("prop:meta:updatedAt", Finite),
    opt("prop:meta:createdBy", Str),
    opt("prop:meta:updatedBy", Str),
];

/// A flavour's keys: every block's, then its props.
fn block_fields(flavour: &str) -> Option<&'static [&'static [Field]]> {
    Some(match flavour {
        PAGE_FLAVOUR => &[BLOCK_BASE, PAGE],
        SURFACE_FLAVOUR => &[BLOCK_BASE, SURFACE],
        NOTE_FLAVOUR => &[BLOCK_BASE, NOTE],
        "affine:paragraph" => &[BLOCK_BASE, PARAGRAPH, META],
        "affine:list" => &[BLOCK_BASE, LIST, META],
        "affine:image" => &[BLOCK_BASE, IMAGE, META],
        PICTURE_FLAVOUR => &[BLOCK_BASE, PICTURE],
        LINK_FLAVOUR => &[BLOCK_BASE, LINK],
        "affine:embed-capy-material" => &[BLOCK_BASE, MATERIAL],
        _ => return None,
    })
}

/// The props whose BlockSuite default is `undefined`: loading fills only
/// absent props, so any other holding `undefined` stays so and breaks its
/// block.
const UNDEFINED_PROPS: &[&str] = &[
    "prop:textAlign",
    "prop:comments",
    "prop:meta:createdAt",
    "prop:meta:updatedAt",
    "prop:meta:createdBy",
    "prop:meta:updatedBy",
];

/// One key against `tables`: listed, its value of its kind; a block's prop
/// holds `undefined` only where its default is.
fn key_fits(what: &str, key: &str, stored: &Stored, tables: &[&[Field]]) -> Result<(), String> {
    if matches!(stored, Stored::Plain(Any::Undefined))
        && key.starts_with("prop:")
        && !UNDEFINED_PROPS.contains(&key)
    {
        return Err(format!(
            "{what}: {key} holds undefined, which loading never fills"
        ));
    }
    let field = tables
        .iter()
        .flat_map(|table| table.iter())
        .find(|field| field.name == key);
    let Some(field) = field else {
        return Err(format!("{what}: unknown key {key}"));
    };
    if stored_fits(field.kind, stored) {
        Ok(())
    } else {
        Err(format!("{what}: {key} is not what it holds"))
    }
}

/// `keys` against `fields`: every key listed (`fixed` are read by the
/// caller), each value of its kind, the required ones present.
fn fields_fit(what: &str, keys: &Keys, fixed: &[&str], tables: &[&[Field]]) -> Result<(), String> {
    for (key, stored) in keys {
        step(Walk::Board);
        if !fixed.contains(&key.as_ref()) {
            key_fits(what, key, stored, tables)?;
        }
    }
    for field in tables.iter().flat_map(|table| table.iter()) {
        if field.required
            && matches!(
                keys.get(field.name),
                None | Some(Stored::Plain(Any::Undefined))
            )
        {
            return Err(format!("{what}: {} is required", field.name));
        }
    }
    Ok(())
}

fn plain<'k>(keys: &'k Keys, key: &str) -> Option<&'k Any> {
    match keys.get(key) {
        Some(Stored::Plain(value)) => Some(value),
        _ => None,
    }
}

fn plain_str<'k>(keys: &'k Keys, key: &str) -> Option<&'k str> {
    match plain(keys, key) {
        Some(Any::String(text)) => Some(text),
        _ => None,
    }
}

/* --------------------------------------------------------- the entities */

/// An element of the canvas under its key `id`: a type the board holds, its
/// `id` its key, strict keys of its type.
pub fn element_fits(id: &str, keys: &Keys) -> Result<(), String> {
    let Some(kind) = plain_str(keys, "type") else {
        return Err("a canvas element without a string type".into());
    };
    let held = catalog::element(kind).is_some_and(|element| element.boards.contains(&BOARD));
    let fields = element_fields(kind).filter(|_| held);
    let Some(fields) = fields else {
        return Err(format!(
            "a canvas element of type {kind} the board does not hold"
        ));
    };
    let what = format!("canvas element {kind}");
    if !is_id(id) {
        return Err(format!("{what}: its key is not an id"));
    }
    if plain_str(keys, "id") != Some(id) {
        return Err(format!("{what}: its id is not its key"));
    }
    fields_fit(&what, keys, &["type", "id"], &[ELEMENT_BASE, fields])
}

/// A block of the tree under its key `id`: a flavour the board holds, strict
/// keys of its flavour, a card's fields as its renderer reads them.
pub fn block_fits(id: &str, keys: &Keys) -> Result<(), String> {
    let Some(flavour) = plain_str(keys, "sys:flavour") else {
        return Err("a block without a string flavour".into());
    };
    let held = catalog::block(flavour).is_some_and(|block| block.boards.contains(&BOARD));
    let Some(tables) = block_fields(flavour).filter(|_| held) else {
        return Err(format!(
            "a block of flavour {flavour} the board does not hold"
        ));
    };
    let what = format!("block {flavour}");
    if !is_id(id) {
        return Err(format!("{what}: its key is not an id"));
    }
    if let Some(stored) = keys.get("sys:id") {
        own_id_fits(&what, id, stored)?;
    }
    fields_fit(&what, keys, &["sys:flavour", "sys:id"], tables)?;
    let fits = match flavour {
        PICTURE_FLAVOUR => picture_fits(keys),
        LINK_FLAVOUR => link_fits(keys),
        _ => true,
    };
    if fits {
        Ok(())
    } else {
        Err(format!("{what}: its card fields do not fit"))
    }
}

/// A block's `sys:id`, when it holds one: its key.
fn own_id_fits(what: &str, id: &str, stored: &Stored) -> Result<(), String> {
    match stored {
        Stored::Plain(Any::Undefined) => Ok(()),
        Stored::Plain(Any::String(own)) if own.as_ref() == id => Ok(()),
        _ => Err(format!("{what}: sys:id is not its key")),
    }
}

/// What an element the board cannot read holds besides the base keys as
/// its placeholder draws it (vendor local change 62: its place and turn),
/// so it can still be moved.
const ELEMENT_PLACEHOLDER: &[Field] = &[opt("xywh", Place), opt("rotate", Finite)];

/// A block's, for its card on the canvas: place, order and turn.
const BLOCK_PLACEHOLDER: &[Field] = &[
    opt("prop:xywh", Place),
    opt("prop:index", Str),
    opt("prop:rotate", Finite),
];

/// One key an update writes on an element the room holds that misfits
/// already (stored before a rule, or two edits merged past one): the key's
/// own rule for its type `kind`, or its placeholder's keys for a type the
/// board does not hold. Moving what a tab draws as a placeholder stays
/// possible, and nothing turns a fitting element into a misfit
/// ([element_fits] holds those whole).
pub fn element_key_fits(kind: Option<&str>, key: &str, stored: &Stored) -> Result<(), String> {
    let held = kind.filter(|kind| {
        catalog::element(kind).is_some_and(|element| element.boards.contains(&BOARD))
    });
    let fields = held.and_then(element_fields).unwrap_or(ELEMENT_PLACEHOLDER);
    let what = format!("canvas element {}", kind.unwrap_or("without a type"));
    key_fits(&what, key, stored, &[ELEMENT_BASE, fields])
}

/// [element_key_fits] for a block under its key `id`, of flavour `flavour`.
pub fn block_key_fits(
    id: &str,
    flavour: Option<&str>,
    key: &str,
    stored: &Stored,
) -> Result<(), String> {
    let held = flavour.filter(|flavour| {
        catalog::block(flavour).is_some_and(|block| block.boards.contains(&BOARD))
    });
    let tables = held
        .and_then(block_fields)
        .unwrap_or(&[BLOCK_BASE, BLOCK_PLACEHOLDER]);
    let what = format!("block {}", flavour.unwrap_or("without a flavour"));
    if key == "sys:id" {
        return own_id_fits(&what, id, stored);
    }
    key_fits(&what, key, stored, tables)
}

/// A picture: an emoji of the catalog by its code points, or a GIF by its
/// KLIPY link (https on a `.klipy.com` host).
fn picture_fits(keys: &Keys) -> bool {
    let (Some(kind), Some(reference)) = (plain_str(keys, "prop:kind"), plain_str(keys, "prop:ref"))
    else {
        return false;
    };
    match kind {
        "emoji" => catalog::EMOJI.contains(&reference),
        "klipy" => url::Url::parse(reference).is_ok_and(|url| {
            url.scheme() == "https"
                && url
                    .host_str()
                    .is_some_and(|host| host.ends_with(".klipy.com"))
        }),
        _ => false,
    }
}

/// A link card: an http or https address (WHATWG, as the browser's `URL`).
fn link_fits(keys: &Keys) -> bool {
    plain_str(keys, "prop:url").is_some_and(|address| {
        url::Url::parse(address).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
    })
}

/// Whether a block of flavour `child` may sit under one of flavour `parent`
/// (the catalog's parents).
pub fn child_fits(parent: &str, child: &str) -> bool {
    catalog::block(child).is_some_and(|block| block.parents.contains(&parent))
}

/// The keys of an element type held as Y.Text.
pub fn element_text(kind: &str, key: &str) -> bool {
    matches!(
        (kind, key),
        ("shape" | "connector" | "text", "text") | ("group", "title")
    )
}

/// The keys of a block flavour held as Y.Text.
pub fn block_text(flavour: &str, key: &str) -> bool {
    matches!(
        (flavour, key),
        (PAGE_FLAVOUR, "prop:title") | ("affine:paragraph" | "affine:list", "prop:text")
    )
}

/* ------------------------------------------------------------- entries */

/// A text's content: string runs and formats whose values are plain, with
/// no `__proto__` key inside (the board's reference, footnote and mention
/// formats are objects; BlockSuite checks each format as it reads it and
/// drops a bad one); no embeds, no types.
pub fn text_content_fits(content: &ItemContent) -> Result<(), String> {
    match content {
        ItemContent::String(_) | ItemContent::Deleted(_) => Ok(()),
        ItemContent::Format(_, value) if is_plain(value) => Ok(()),
        _ => Err("a text holds something other than text and formats".into()),
    }
}

/// A keyed list of an element type: its add tools' cap and how it takes an
/// item.
#[derive(Clone, Copy)]
pub struct Keyed {
    pub cap: usize,
    pub fits: fn(&Object) -> bool,
}

/// The keyed list at `key` of an element of type `kind` (Epo 2026-11-16, a
/// plane's elements; 2026-11-22, a chart's bars, labels and lines).
pub fn keyed(kind: &str, key: &str) -> Option<Keyed> {
    let (cap, fits): (usize, fn(&Object) -> bool) = match (kind, key) {
        ("plane", "elements") => (
            notes::catalog::QUESTION_GRAPH_ELEMENTS_MAX,
            plane_element_fits,
        ),
        ("chart", "bars") => (catalog::BARS_MAX, bar_fits),
        ("chart", "labels") => (catalog::LABELS_MAX, pie_label_fits),
        ("chart", "spokes") => (catalog::SPOKES_MAX, spoke_fits),
        _ => return None,
    };
    Some(Keyed { cap, fits })
}

/// One of a plane's elements, of any kind a graph holds, checked as every
/// graph's (the graph model's one check, with the note figure's limits).
/// Only a key its type may leave unset holds `undefined` (zod's
/// `strictObject` refuses any other key, `undefined` or not); the JSON the
/// check reads drops those.
pub fn plane_element_fits(element: &Object) -> bool {
    let kind = match element.get("type") {
        Some(Any::String(kind)) => kind.as_ref(),
        _ => "",
    };
    let unset_fits = element.iter().all(|(key, value)| {
        !matches!(value, Any::Undefined) || notes::questions::graph_element_optional(kind, key)
    });
    unset_fits
        && notes::json::any_to_value(&Any::Map(Arc::new(element.clone())))
            .is_ok_and(|value| notes::questions::graph_element_shape(&value).is_ok())
}

pub fn bar_fits(bar: &Object) -> bool {
    let fill = bar.get("fill");
    finite_at(bar, "value")
        && bar
            .get("label")
            .is_some_and(|label| string_upto(label, catalog::LABEL_LENGTH_MAX))
        && (unset(fill) || fill.is_some_and(is_colour))
}

pub fn pie_label_fits(label: &Object) -> bool {
    let size = label.get("size");
    label
        .get("text")
        .is_some_and(|text| string_upto(text, catalog::LABEL_LENGTH_MAX))
        && finite_at(label, "angle")
        && finite_at(label, "reach")
        && (unset(size)
            || matches!(size, Some(Any::Number(n)) if n.fract() == 0.0
                && (catalog::TEXT_SIZE_MIN as f64..=catalog::TEXT_SIZE_MAX as f64).contains(n)))
}

/// A pie line, with the fill of the slice it starts.
pub fn spoke_fits(spoke: &Object) -> bool {
    let fill = spoke.get("fill");
    finite_at(spoke, "angle") && (unset(fill) || fill.is_some_and(is_colour))
}

/// A keyed list's entry under `id`: `{order, element}` with the element's
/// `id` its key, the element as the list takes it (`keyedFit`).
pub fn keyed_entry_fits(id: &str, value: &Any, list: Keyed) -> bool {
    let Any::Map(entry) = value else {
        return false;
    };
    let Some(Any::Map(element)) = entry.get("element") else {
        return false;
    };
    is_id(id)
        && entry.get("order").is_some_and(string)
        && matches!(element.get("id"), Some(Any::String(own)) if own.as_ref() == id)
        && (list.fits)(element)
}

/// A mind map's node under its shape's id: `{index, parent?, collapsed?}`.
fn mindmap_child_fits(value: &Any) -> bool {
    let Any::Map(node) = value else {
        return false;
    };
    let (parent, collapsed) = (node.get("parent"), node.get("collapsed"));
    node.get("index").is_some_and(string)
        && (unset(parent) || parent.is_some_and(string))
        && (unset(collapsed) || matches!(collapsed, Some(Any::Bool(_))))
}

/// An entry `entry` of the map at `key` of an element of type `kind`: a
/// keyed list's item, a group's child (`true`) or a mind map's node.
pub fn element_entry_fits(
    kind: &str,
    key: &str,
    entry: &str,
    stored: &Stored,
) -> Result<(), String> {
    let what = format!("canvas element {kind}");
    let Some(value) = (match stored {
        Stored::Plain(value) if is_plain(value) => Some(value),
        _ => None,
    }) else {
        return Err(format!("{what}: an entry of {key} that is not plain"));
    };
    let fits = match (kind, key) {
        ("group", "children") => is_id(entry) && matches!(value, Any::Bool(true)),
        ("mindmap", "children") => is_id(entry) && mindmap_child_fits(value),
        _ => match keyed(kind, key) {
            Some(list) => keyed_entry_fits(entry, value, list),
            None => return Err(OUTSIDE.into()),
        },
    };
    if fits {
        Ok(())
    } else {
        Err(format!("{what}: an entry of {key} that does not fit"))
    }
}

/// An entry `entry` of a block's nested map at `path` (keys below the
/// block): a note's background, edgeless and its style, a block's comments.
pub fn block_entry_fits(
    flavour: &str,
    path: &[&str],
    entry: &str,
    stored: &Stored,
) -> Result<(), String> {
    let what = format!("block {flavour}");
    let comments = matches!(
        flavour,
        NOTE_FLAVOUR | "affine:paragraph" | "affine:list" | "affine:image"
    );
    let kind = match (path, entry) {
        (["prop:background"], "dark" | "light" | "normal") if flavour == NOTE_FLAVOUR => Str,
        (["prop:edgeless"], "style") if flavour == NOTE_FLAVOUR => Map,
        (["prop:edgeless"], "collapse") if flavour == NOTE_FLAVOUR => Bool,
        (["prop:edgeless"], "collapsedHeight" | "scale") if flavour == NOTE_FLAVOUR => Finite,
        (["prop:edgeless", "style"], "borderRadius" | "borderSize") if flavour == NOTE_FLAVOUR => {
            Finite
        }
        (["prop:edgeless", "style"], "borderStyle") if flavour == NOTE_FLAVOUR => {
            One(&STROKE_STYLE)
        }
        (["prop:edgeless", "style"], "shadowType") if flavour == NOTE_FLAVOUR => One(&NOTE_SHADOW),
        (["prop:comments"], id) if comments && is_id(id) => Bool,
        (["prop:background"] | ["prop:edgeless"] | ["prop:edgeless", "style"], _)
            if flavour == NOTE_FLAVOUR =>
        {
            return Err(format!("{what}: {} holds no key {entry}", path.join(".")));
        }
        (["prop:comments"], _) if comments => {
            return Err(format!(
                "{what}: prop:comments holds a key that is not an id"
            ));
        }
        _ => return Err(OUTSIDE.into()),
    };
    // A background's colours and a comment's mark are always given.
    let given = matches!(path, ["prop:background"] | ["prop:comments"]);
    let fits = match stored {
        Stored::Plain(Any::Undefined) => !given,
        stored => stored_fits(kind, stored),
    };
    if fits {
        Ok(())
    } else {
        Err(format!(
            "{what}: {} {entry} is not what it holds",
            path.join(".")
        ))
    }
}
