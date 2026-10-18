//! Document limits and exact metrics (`collaboration/src/limits.ts` on
//! capy-side/plate; Go `materialdoc`): the UTF-8 size of
//! `JSON.stringify({schemaVersion:1, value})` with runtime comment marks
//! stripped from text leaves, the node count and the deepest node.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use yrs::block::{ItemContent, UpdateParent};
use yrs::branch::{Branch, BranchID, BranchPtr};
use yrs::types::TypeRef;
use yrs::updates::encoder::Encode;
use yrs::{Any, ReadTxn, Update};

use crate::plate::{self, Insert, ProjectionError};
use crate::{catalog, json};

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
        if let Some(value) = property_len(branch, key, value)? {
            len += json::escaped_len(key) + 3 + value;
            entries += 1;
        }
    }
    Ok(len + entries - 1)
}

/// Bytes of an element's property `key`: a figure's live block as the room
/// holds it, the entries a read drops included (Epo 2026-10-18). Its own
/// frame, so the element walk's stays as small as before.
fn property_len(branch: &Branch, key: &str, value: &Any) -> Result<Option<usize>, ProjectionError> {
    if plate::map_key(key)
        && let Some(held) = plate::held_block_value(BranchPtr::from(branch))?
    {
        return Ok(Some(json::value_len(&held)));
    }
    Ok(json::any_len(value)?)
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

/// Where an item of an update sits: in a sequence (a text, a root) of its
/// parent, or an entry of a map (an attribute or a marker) under `key` of its
/// parent.
#[derive(Clone)]
enum Place {
    Sequence(Option<BranchID>),
    Entry(Arc<str>, Option<BranchID>),
}

/// What an update does to the keys [required_keys] reads ([guarded]): the
/// entries it writes per element and key, the keys whose current entry in the
/// room it deletes, and the elements it creates with their parent.
#[derive(Default)]
struct Shape {
    set: HashMap<BranchID, HashMap<Arc<str>, Vec<Written>>>,
    cleared: HashMap<BranchID, HashSet<Arc<str>>>,
    created: HashMap<BranchID, Option<BranchID>>,
    /// The update writes into a figure's live block: measured exactly.
    exact: bool,
}

/// An entry the update writes under a key: its id and last unit, the entry it
/// was written after (`origin`), whether it names a right origin, and its
/// value (none for deleted content).
struct Written {
    id: yrs::ID,
    last: yrs::ID,
    origin: Option<yrs::ID>,
    right: bool,
    value: Option<Any>,
}

/// Each type's keys the store requires besides `type` (and `id` at the top
/// level): `material::assert_canonical`, the embed catalog's `required` of
/// the elements a Plate room holds, less a media block's `assetId`
/// ([on_candidate] checks it).
pub const OWN_KEYS: [(&str, &[&str]); 7] = [
    // Not a top-level block only, so its id is its own key.
    ("mermaid", &["id", "source"]),
    ("chart", &["block"]),
    ("plot", &["block"]),
    ("graph", &["block"]),
    (crate::material::HTML_EMBED_TYPE, &["html"]),
    (
        crate::material::MATERIAL_REF_TYPE,
        &["materialId", "refKind"],
    ),
    ("video", &["provider", "videoId"]),
];

/// The keys an element of type `kind` needs besides `type` and `id`.
fn own_keys(kind: Option<&Any>) -> &'static [&'static str] {
    match kind {
        Some(Any::String(kind)) => OWN_KEYS
            .iter()
            .find(|(name, _)| *name == kind.as_ref())
            .map_or(&[], |(_, keys)| keys),
        _ => &[],
    }
}

/// Whether a document of material kind `material` may hold an element of
/// type `kind`: the embed catalog lists it for that kind. The store refuses
/// any other (Epo 2026-10-13).
pub fn may_hold(material: &str, kind: &str) -> bool {
    catalog::element(kind).is_some_and(|element| element.materials.contains(&material))
}

/// Whether some Plate document (a note, mindmap or diagram) may hold the
/// element: the catalog lists it for a material kind that is not an item.
fn plate_element(element: &catalog::Element) -> bool {
    element
        .materials
        .iter()
        .any(|material| catalog::material_kind(material).is_some_and(|kind| !kind.item))
}

/// The closed key set of an element of type `kind`, when it has one (chart,
/// plot, graph, html_embed).
fn closed_fields(kind: &str) -> Option<&'static [&'static str]> {
    catalog::element(kind).and_then(|element| element.fields)
}

/// The keys the catalog forbids on an element of type `kind` (none for a
/// type it does not list).
fn forbidden_keys(kind: Option<&Any>) -> &'static [&'static str] {
    match kind {
        Some(Any::String(kind)) => catalog::element(kind).map_or(&[], |element| element.forbidden),
        _ => &[],
    }
}

/// Every key the catalog forbids on an element a Plate room holds.
static FORBIDDEN: std::sync::LazyLock<Vec<&'static str>> = std::sync::LazyLock::new(|| {
    let mut keys: Vec<&'static str> = catalog::ELEMENTS
        .iter()
        .filter(|element| plate_element(element))
        .flat_map(|element| element.forbidden.iter().copied())
        .collect();
    keys.sort_unstable();
    keys.dedup();
    keys
});

/// The keys some element holds as a text ([plate::holds_text]) and as a map
/// ([plate::holds_map]), each once.
static TEXT_KEYS: std::sync::LazyLock<Vec<&'static str>> =
    std::sync::LazyLock::new(|| shared_keys(|element| element.shared_text));
static MAP_KEYS: std::sync::LazyLock<Vec<&'static str>> =
    std::sync::LazyLock::new(|| shared_keys(|element| element.shared_map));

fn shared_keys(keys: fn(&catalog::Element) -> &'static [&'static str]) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = catalog::ELEMENTS.iter().flat_map(keys).copied().collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// The keys whose value the store checks beyond its presence ([value_ok]).
const VALUE_KEYS: [&str; 9] = [
    "refKind", "provider", "videoId", "width", "html", "caption", "block", "source", "indent",
];

/// Whether the store takes `value` under `key` on an element of type `kind`
/// (`material::assert_canonical`): a reference names an item kind, a video
/// is a YouTube id, a resizable block's width is one the handles write, an
/// interactive block's html and caption fit, a figure's
/// block is a valid question block of its type, a Mermaid source is a string
/// (or its shared text), any block's indent stops at `LIST_INDENT_MAX`.
fn value_ok(kind: &str, key: &str, value: &Any) -> bool {
    match (kind, key, value) {
        (crate::material::MATERIAL_REF_TYPE, "refKind", Any::String(item)) => {
            catalog::material_kind(item).is_some_and(|item| item.item)
        }
        ("video", "provider", Any::String(provider)) => &**provider == "youtube",
        ("video", "videoId", Any::String(id)) => crate::material::youtube_id(id),
        (crate::material::HTML_EMBED_TYPE, "html", Any::String(html)) => {
            html.len() <= catalog::HTML_EMBED_MAX_BYTES
        }
        (crate::material::HTML_EMBED_TYPE, "caption", value) => {
            matches!(value, Any::String(caption) if caption.chars().count() <= catalog::BLOCK_CAPTION_MAX)
        }
        // A figure's block only as its live map (Epo 2026-10-18), checked
        // whole on the copy; never as one plain value.
        (kind, key, value) if plate::holds_map(kind, key) => matches!(value, Any::Buffer(_)),
        (kind, key, value) if plate::holds_text(kind, key) => matches!(value, Any::String(_)),
        (_, "width", value) if catalog::element(kind).is_some_and(|e| e.resizable) => {
            matches!(value, Any::String(width) if crate::material::valid_width(width))
        }
        (_, "indent", Any::Number(indent)) => *indent <= catalog::LIST_INDENT_MAX as f64,
        (crate::material::MATERIAL_REF_TYPE, "refKind", _)
        | ("video", "provider" | "videoId", _)
        | (crate::material::HTML_EMBED_TYPE, "html", _) => false,
        _ => true,
    }
}

/// Whether some element may need `key`, may not carry it, or may not carry
/// a value of it: an update that writes or deletes only other keys leaves
/// every required, forbidden and checked key as it was.
fn guarded(key: &str) -> bool {
    key == "type"
        || key == "id"
        || OWN_KEYS.iter().any(|(_, keys)| keys.contains(&key))
        || VALUE_KEYS.contains(&key)
        || FORBIDDEN.contains(&key)
}

/// What a note may hold: its texts strings, formats and element texts, every
/// attribute, mark or marker entry a plain value, except a `mermaid` block's
/// `source`, which may be a text of strings alone (shape A, Epo 2026-10-10:
/// no formats, embeds or attributes in it, on no other key or element). Only
/// what the room does not hold yet counts (Yjs skips the rest). Every
/// element `type` is one the catalog lists for `material`, the room's kind.
/// Returns the elements [on_candidate] checks on the result: those whose
/// media attributes the update sets or deletes (`type` to a media type,
/// `assetId`, `url`, `src`), less those the room shows are not media: held,
/// of a non-media `type` the update leaves alone (REVIEW5 M1: a `src` on a
/// paragraph needs no copy of the room); and those it makes a closed element
/// (chart, plot, graph, html_embed) or gives a key outside a held closed
/// element's fields (a width on a chart needs no copy).
fn plain_content<T: ReadTxn>(
    txn: &T,
    incoming: &ydoc::Incoming,
    shape: &mut Shape,
    material: &str,
) -> Result<HashSet<BranchID>, Refusal> {
    fn plain(value: &Any) -> bool {
        match value {
            Any::Buffer(_) | Any::BigInt(_) => false,
            Any::Array(items) => items.iter().all(plain),
            Any::Map(entries) => entries.values().all(plain),
            _ => true,
        }
    }
    fn parent_of(item: &yrs::block::Item) -> Option<BranchID> {
        match item.update_parent() {
            UpdateParent::Root(name) => Some(BranchID::Root(name.clone())),
            UpdateParent::Item(id) => Some(BranchID::Nested(*id)),
            UpdateParent::Branch(branch) => Some(branch.id()),
            UpdateParent::Unknown => None,
        }
    }
    let state = txn.state_vector();
    let store = txn.store();
    // Where each item sits, or none when Yjs drops it (its origin was
    // garbage-collected). An item with an origin does not encode its parent
    // or key: it takes its origin's, which the room or this update holds.
    // Each item resolves once per update (a pasted run chains every item to
    // the one before it); a chain that loops is none.
    let mut places: HashMap<yrs::ID, Option<Place>> = HashMap::new();
    let mut place = |start: &yrs::block::Item| -> Option<Place> {
        let mut chain: Vec<yrs::ID> = Vec::new();
        let mut seen: HashSet<yrs::ID> = HashSet::new();
        let mut item = start;
        let found = loop {
            ydoc::steps::step(ydoc::steps::Walk::Content);
            if let Some(known) = places.get(item.id()) {
                break known.clone();
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
            if let Some(key) = item.parent_sub() {
                break Some(Place::Entry(key.clone(), parent_of(item)));
            }
            if !matches!(item.update_parent(), UpdateParent::Unknown) {
                break Some(Place::Sequence(parent_of(item)));
            }
            let Some(origin) = item.origin().or(item.right_origin()) else {
                break None;
            };
            if origin.clock < state.get(&origin.client) {
                break store.get_item(origin).map(|held| match held.parent_sub() {
                    Some(key) => Place::Entry(key.clone(), held.parent_branch().map(|b| b.id())),
                    None => Place::Sequence(held.parent_branch().map(|b| b.id())),
                });
            }
            match incoming.item_at(origin) {
                Some(next) => item = next,
                None => break None,
            }
        };
        for id in chain {
            places.insert(id, found.clone());
        }
        found
    };
    // Whether a parent is a Mermaid source: the only text that is not an
    // element (a Y.XmlText) the admit lets in, so its type tells.
    let mut sources: HashMap<yrs::ID, bool> = HashMap::new();
    let mut is_source = |parent: &Option<BranchID>| -> bool {
        let Some(BranchID::Nested(id)) = parent else {
            return false;
        };
        *sources.entry(*id).or_insert_with(|| {
            ydoc::steps::step(ydoc::steps::Walk::Content);
            let text = |content: &ItemContent| {
                matches!(content, ItemContent::Type(branch) if matches!(branch.type_ref(), TypeRef::Text))
            };
            if id.clock < state.get(&id.client) {
                store.get_item(id).is_some_and(|held| text(held.content()))
            } else {
                incoming.item_at(id).is_some_and(|item| text(item.content()))
            }
        })
    };
    // Every new item placed first: a figure's map and lists are read by their
    // own places below ([Parts]).
    let located: Vec<(&yrs::block::Item, Place)> = incoming
        .items()
        .filter(|item| item.id().clock + item.len() > state.get(&item.id().client))
        .filter_map(|item| place(item).map(|at| (item, at)))
        .collect();
    let mut parts = Parts {
        txn,
        state: &state,
        incoming,
        places: &places,
        known: HashMap::new(),
    };
    let mut media = HashSet::new();
    let mut typed = HashSet::new();
    // Elements made closed, and the other keys the update writes per element.
    let mut closed: HashSet<BranchID> = HashSet::new();
    let mut keyed: HashMap<BranchID, Vec<Arc<str>>> = HashMap::new();
    // Elements given a source text (by its key), and the `type` values the
    // update writes per element.
    let mut holders: HashMap<BranchID, Arc<str>> = HashMap::new();
    let mut types: HashMap<BranchID, Vec<Option<Arc<str>>>> = HashMap::new();
    // Figures whose live block the update writes into (Epo 2026-10-17): read
    // and checked whole on the copy ([on_candidate]).
    let mut figures: HashSet<BranchID> = HashSet::new();
    for (item, at) in located {
        let id = item.id();
        let parent = match &at {
            Place::Entry(_, parent) | Place::Sequence(parent) => parent,
        };
        // Inside a figure's block: plain entries in the block and its list
        // entries, lists of maps under the block, nothing else.
        if let Some(part) = parts.of_parent(parent) {
            let fits = match (&at, part, item.content()) {
                (_, _, ItemContent::Deleted(_)) => true,
                (Place::Entry(..), Part::Block(_) | Part::Entry(_), ItemContent::Any(values)) => {
                    values.iter().all(plain)
                }
                (Place::Entry(key, _), Part::Block(_), ItemContent::Type(branch)) => {
                    matches!(branch.type_ref(), TypeRef::Array) && plate::list_key(key)
                }
                (Place::Sequence(_), Part::List(_), ItemContent::Type(branch)) => {
                    matches!(branch.type_ref(), TypeRef::Map)
                }
                _ => false,
            };
            if !fits {
                return Err(Refusal::Content(FIGURE_SHAPE));
            }
            figures.insert(part.owner());
            continue;
        }
        let refused = match (&at, item.content()) {
            (_, ItemContent::Deleted(_)) => None,
            (Place::Entry(_, parent), _) if is_source(parent) => {
                Some("an attribute on a Mermaid source")
            }
            (Place::Sequence(parent), ItemContent::String(_)) if is_source(parent) => None,
            (Place::Sequence(parent), _) if is_source(parent) => {
                Some("content other than text in a Mermaid source")
            }
            // An imported fence's body holds the answer keys: a reference
            // names its row instead (live-items REVIEW5).
            (Place::Entry(key, _), _) if &**key == PENDING_KEY => {
                Some("an imported fence body on a material reference")
            }
            (Place::Entry(..), ItemContent::Any(values)) if values.iter().all(plain) => None,
            (Place::Entry(key, Some(parent)), ItemContent::Type(branch))
                if plate::text_key(key)
                    && matches!(branch.type_ref(), TypeRef::Text)
                    && matches!(parent, BranchID::Nested(_)) =>
            {
                holders.insert(parent.clone(), key.clone());
                None
            }
            // A figure's live block (Epo 2026-10-17), on an element: checked
            // whole on the copy, its type there among them.
            (Place::Entry(key, Some(parent)), ItemContent::Type(branch))
                if plate::map_key(key)
                    && matches!(branch.type_ref(), TypeRef::Map)
                    && parts.is_element(parent) =>
            {
                figures.insert(parent.clone());
                None
            }
            (Place::Entry(..), _) => Some("a non-plain attribute value"),
            (Place::Sequence(_), ItemContent::String(_)) => None,
            (Place::Sequence(_), ItemContent::Format(_, value)) if plain(value) => None,
            (Place::Sequence(_), ItemContent::Type(branch))
                if matches!(branch.type_ref(), TypeRef::XmlText) =>
            {
                None
            }
            (Place::Sequence(_), ItemContent::Format(..)) => Some("a non-plain mark value"),
            (Place::Sequence(_), _) => Some("content other than text in a note text"),
        };
        if let Some(what) = refused {
            return Err(Refusal::Content(what));
        }
        if let (Place::Sequence(parent), ItemContent::Type(_)) = (&at, item.content()) {
            shape.created.insert(BranchID::Nested(*id), parent.clone());
        }
        if let Place::Entry(key, Some(parent)) = &at
            && guarded(key)
        {
            let value = match item.content() {
                ItemContent::Any(values) => Some(values.last().cloned().unwrap_or(Any::Null)),
                // A Mermaid source text (admitted above only as `source`).
                ItemContent::Type(branch) if matches!(branch.type_ref(), TypeRef::Text) => {
                    Some(source_text())
                }
                // A figure's live block (admitted above only as `block`).
                ItemContent::Type(branch) if matches!(branch.type_ref(), TypeRef::Map) => {
                    Some(live_block())
                }
                _ => None,
            };
            shape
                .set
                .entry(parent.clone())
                .or_default()
                .entry(key.clone())
                .or_default()
                .push(Written {
                    id: *id,
                    last: yrs::ID::new(id.client, id.clock + item.len().saturating_sub(1)),
                    origin: item.origin().copied(),
                    right: item.right_origin().is_some(),
                    value,
                });
        }
        if let (Place::Entry(key, Some(parent)), ItemContent::Any(values)) = (&at, item.content()) {
            let media_type = || {
                matches!(values.last(), Some(Any::String(kind))
                    if crate::material::MEDIA_TYPES.contains(&&**kind))
            };
            if &**key == "type" {
                // A type the catalog lists for this material kind, nothing
                // else (Epo 2026-10-13): the store refuses any other.
                if let Some(Any::String(kind)) = values.last() {
                    if !may_hold(material, kind) {
                        return Err(Refusal::Content(UNLISTED_TYPE));
                    }
                    if closed_fields(kind).is_some() {
                        closed.insert(parent.clone());
                    }
                }
                typed.insert(parent.clone());
                types
                    .entry(parent.clone())
                    .or_default()
                    .push(match values.last() {
                        Some(Any::String(kind)) => Some(kind.clone()),
                        _ => None,
                    });
            }
            if matches!(&**key, "assetId" | "url" | "src") || (&**key == "type" && media_type()) {
                media.insert(parent.clone());
            }
            if &**key != "type" && matches!(parent, BranchID::Nested(_)) {
                keyed.entry(parent.clone()).or_default().push(key.clone());
            }
        }
    }
    // A source text sits on an element holding it (the catalog's
    // `sharedText`: a `mermaid` block's source) only: one the update gives a
    // source, or retypes while it holds one, is such an element afterwards.
    // A figure's live block likewise, checked on the copy.
    for element in types.keys() {
        if let Some(key) = held_source(txn, incoming, element) {
            holders.entry(element.clone()).or_insert(key);
        }
        if held_block(txn, element) {
            figures.insert(element.clone());
        }
    }
    for (element, key) in &holders {
        ydoc::steps::step(ydoc::steps::Walk::Content);
        let holds = |kind: Option<&str>| kind.is_some_and(|kind| plate::holds_text(kind, key));
        let fits = match types.get(element) {
            Some(written) => written.iter().all(|kind| holds(kind.as_deref())),
            None => holds(held_type(txn, element).as_deref()),
        };
        if !fits {
            return Err(Refusal::Content("a Mermaid source outside a mermaid block"));
        }
    }
    // A deleted asset id leaves its block without one; any deleted current
    // entry is a key the element may no longer have.
    for (client, ranges) in incoming.delete_ranges() {
        let end = state.get(client);
        for &(from, to) in ranges {
            let until = to.min(end);
            let mut clock = from;
            while clock < until {
                ydoc::steps::step(ydoc::steps::Walk::DeleteRanges);
                let Some((range, item)) = store.get_block_range(&yrs::ID::new(*client, clock))
                else {
                    break;
                };
                clock = range.clock + range.len;
                if let Some(item) = item
                    && !item.is_deleted()
                    && let Some(parent) = item.parent_branch()
                    && let Some(figure) = held_figure(parent)
                {
                    // An entry, list entry or list of a figure's live block.
                    figures.insert(figure);
                    continue;
                }
                if let Some(item) = item
                    && !item.is_deleted()
                    && let Some(key) = item.parent_sub()
                    && let Some(parent) = item.parent_branch()
                {
                    if &**key == "assetId" {
                        media.insert(parent.id());
                    }
                    // The key's current entry, looked up, not scanned for
                    // (REVIEW5 M3: a scan per deleted entry was quadratic).
                    if guarded(key)
                        && entry_of(parent, key).is_some_and(|current| current.id() == item.id())
                    {
                        shape
                            .cleared
                            .entry(parent.id())
                            .or_default()
                            .insert(key.clone());
                    }
                }
            }
        }
    }
    // A held closed element given a key outside its fields, whatever `type`
    // the update writes too: a written type may lose Yjs's conflict order,
    // so the copy decides.
    for (element, keys) in &keyed {
        let outside = held_type(txn, element)
            .and_then(|kind| closed_fields(&kind))
            .is_some_and(|fields| keys.iter().any(|key| !fields.contains(&&**key)));
        if outside {
            closed.insert(element.clone());
        }
    }
    media.retain(|id| {
        typed.contains(id)
            || held_branch(txn, id).is_none_or(|branch| {
                entry_of(branch, "type")
                    .filter(|item| !item.is_deleted())
                    .is_none_or(|item| match item.content() {
                        ItemContent::Any(values) => matches!(values.last(),
                            Some(Any::String(kind)) if crate::material::MEDIA_TYPES.contains(&&**kind)),
                        _ => true,
                    })
            })
    });
    media.extend(closed);
    // A figure's live block is measured exactly too: its repair on read can
    // make a deletion grow the value (a capped series moving up).
    shape.exact = !figures.is_empty();
    media.extend(figures);
    Ok(media)
}

/// The `type` a held element has, if the room holds it.
fn held_type<T: ReadTxn>(txn: &T, element: &BranchID) -> Option<String> {
    let item = entry_of(held_branch(txn, element)?, "type").filter(|item| !item.is_deleted())?;
    match item.content() {
        ItemContent::Any(values) => match values.last() {
            Some(Any::String(kind)) => Some(kind.to_string()),
            _ => None,
        },
        _ => None,
    }
}

/// The key of a source text a held element holds and this update leaves in
/// place, if it holds one.
fn held_source<T: ReadTxn>(
    txn: &T,
    incoming: &ydoc::Incoming,
    element: &BranchID,
) -> Option<Arc<str>> {
    let branch = held_branch(txn, element)?;
    for key in TEXT_KEYS.iter().copied() {
        let held = entry_of(branch, key).is_some_and(|item| {
            let id = item.id();
            !item.is_deleted()
                && !incoming.deletes(&id.client, id.clock, id.clock + item.len())
                && matches!(item.content(), ItemContent::Type(text) if matches!(text.type_ref(), TypeRef::Text))
        });
        if held {
            return Some(Arc::from(key));
        }
    }
    None
}

/// Whether a held element holds a figure's live block (a map).
fn held_block<T: ReadTxn>(txn: &T, element: &BranchID) -> bool {
    let Some(branch) = held_branch(txn, element) else {
        return false;
    };
    MAP_KEYS.iter().any(|key| {
        entry_of(branch, key).is_some_and(|item| {
            !item.is_deleted()
                && matches!(item.content(), ItemContent::Type(map) if matches!(map.type_ref(), TypeRef::Map))
        })
    })
}

/// The element whose live block holds the held map or list `branch` (at most
/// three levels up: block, list, list entry).
fn held_figure(branch: yrs::branch::BranchPtr) -> Option<BranchID> {
    let mut current = branch;
    for _ in 0..3 {
        if !matches!(current.type_ref(), TypeRef::Map | TypeRef::Array) {
            return None;
        }
        let up = current.item()?.parent_branch()?;
        if matches!(up.type_ref(), TypeRef::XmlText) {
            return Some(up.id());
        }
        current = up;
    }
    None
}

/// Where a map or list sits inside a figure's live block, with the figure
/// element ([Parts::of]).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Part {
    /// The block map (`block` of the element).
    Block(yrs::ID),
    /// A list of maps under the block (series, graph elements).
    List(yrs::ID),
    /// One map of such a list.
    Entry(yrs::ID),
}

impl Part {
    fn owner(self) -> BranchID {
        match self {
            Part::Block(element) | Part::List(element) | Part::Entry(element) => {
                BranchID::Nested(element)
            }
        }
    }
}

/// Resolves the types an update writes into: held, or new in it (placed by
/// [plain_content]'s first pass), each resolved once.
struct Parts<'a, T: ReadTxn> {
    txn: &'a T,
    state: &'a yrs::StateVector,
    incoming: &'a ydoc::Incoming<'a>,
    places: &'a HashMap<yrs::ID, Option<Place>>,
    known: HashMap<yrs::ID, Option<Part>>,
}

impl<T: ReadTxn> Parts<'_, T> {
    /// The type the item `id` makes and where it sits.
    fn holder(&self, id: &yrs::ID) -> Option<(TypeRef, Option<Place>)> {
        ydoc::steps::step(ydoc::steps::Walk::Content);
        if id.clock < self.state.get(&id.client) {
            let held = self.txn.store().get_item(id)?;
            let ItemContent::Type(branch) = held.content() else {
                return None;
            };
            let parent = held.parent_branch().map(|parent| parent.id());
            let place = match held.parent_sub() {
                Some(key) => Place::Entry(key.clone(), parent),
                None => Place::Sequence(parent),
            };
            return Some((branch.type_ref().clone(), Some(place)));
        }
        let item = self.incoming.item_at(id)?;
        let ItemContent::Type(branch) = item.content() else {
            return None;
        };
        Some((
            branch.type_ref().clone(),
            self.places.get(id).cloned().flatten(),
        ))
    }

    /// Whether `parent` is an element (a Y.XmlText).
    fn is_element(&self, parent: &BranchID) -> bool {
        let BranchID::Nested(id) = parent else {
            return false;
        };
        matches!(self.holder(id), Some((TypeRef::XmlText, _)))
    }

    /// The part of a figure's block a parent is, if it is one.
    fn of_parent(&mut self, parent: &Option<BranchID>) -> Option<Part> {
        match parent {
            Some(BranchID::Nested(id)) => self.of(id),
            _ => None,
        }
    }

    /// The part of a figure's block the type made by item `id` is: the
    /// element's `block` map, a list in it, or a map in that list. At most
    /// three holder lookups, however deep the update nests: a part is known
    /// from its own holder and at most its parent's and grandparent's.
    fn of(&mut self, id: &yrs::ID) -> Option<Part> {
        if let Some(known) = self.known.get(id) {
            return *known;
        }
        let part = match self.holder(id) {
            Some((TypeRef::Map, Some(Place::Sequence(Some(BranchID::Nested(list)))))) => {
                self.list_of(&list).map(Part::Entry)
            }
            Some((TypeRef::Array, _)) => self.list_of(id).map(Part::List),
            Some((TypeRef::Map, _)) => self.block_of(id).map(Part::Block),
            _ => None,
        };
        self.known.insert(*id, part);
        part
    }

    /// The figure element whose `block` map the item `id` makes.
    fn block_of(&self, id: &yrs::ID) -> Option<yrs::ID> {
        match self.holder(id) {
            Some((TypeRef::Map, Some(Place::Entry(key, Some(BranchID::Nested(element))))))
                if plate::map_key(&key) && self.is_element(&BranchID::Nested(element)) =>
            {
                Some(element)
            }
            _ => None,
        }
    }

    /// The figure element whose block holds the list the item `id` makes.
    fn list_of(&self, id: &yrs::ID) -> Option<yrs::ID> {
        match self.holder(id) {
            Some((TypeRef::Array, Some(Place::Entry(key, Some(BranchID::Nested(block))))))
                if plate::list_key(&key) =>
            {
                self.block_of(&block)
            }
            _ => None,
        }
    }
}

/// Whether admitting `update` takes the room's thread off the async workers
/// (`block_in_place`): a large update ([ydoc::applies_inline]), or one that
/// [Validator::admit] checks on a copy of the room: it touches a media
/// block's attributes (REVIEW5 M1) or a closed element's keys, or writes a
/// required key that Yjs's conflict order places (REVIEW5 R2b). `material`
/// is the room's material kind.
pub fn heavy<T: ReadTxn>(txn: &T, update: &Update, bytes: usize, material: &str) -> bool {
    let incoming = ydoc::Incoming::new(update);
    if !ydoc::applies_inline(txn, &incoming, bytes) {
        return true;
    }
    let mut shape = Shape::default();
    plain_content(txn, &incoming, &mut shape, material).is_ok_and(|media| {
        !media.is_empty() || matches!(required_keys(txn, &incoming, &shape, None), Ok(true))
    })
}

/// [Refusal::Content] for an update that leaves an element without a key the
/// store requires ([required_keys]).
pub const MISSING_KEY: &str = "an element without a key it requires";
/// A top-level-only block (a reference, a figure, an interactive block)
/// below the top level, which the store refuses.
pub const NESTED_BLOCK: &str = "a top-level block below the top level";
/// [Refusal::Content] for a value the store refuses ([value_ok]).
pub const BAD_VALUE: &str = "an element with a value it cannot hold";
/// [Refusal::Content] for more interactive blocks than a document holds.
pub const TOO_MANY_EMBEDS: &str = "more interactive blocks than a document holds";
/// [Refusal::Content] for an element given a key the catalog forbids it.
pub const FORBIDDEN_KEY: &str = "an element with a key it never carries";
/// [Refusal::Content] for a block type the catalog does not list for the
/// room's material kind ([may_hold]).
pub const UNLISTED_TYPE: &str = "a block type the embed catalog does not list for it";
/// [Refusal::Content] for a closed element with a key outside its fields.
pub const UNEXPECTED_KEY: &str = "an element with a key outside its fields";
/// [Refusal::Content] for a figure's live block holding other than its
/// entries: plain values, lists of maps of plain values.
pub const FIGURE_SHAPE: &str = "a figure block holding other than its entries";
/// [Refusal::Content] for a figure's block written as one plain value: rooms
/// hold it as its map only (Epo 2026-10-18).
pub const PLAIN_BLOCK: &str = "a figure block as one plain value";
/// [Refusal::Content] for a live block map on an element that holds none.
pub const STRAY_MAP: &str = "a figure block outside a chart, plot or graph";
/// The key a markdown fence's body sat under on a reference without its row.
const PENDING_KEY: &str = "pending";

/// The room's branch `id`, or none when the room does not hold it (an element
/// the update creates). yrs's lookup indexes past a client's last block for a
/// clock beyond it, so a clock the room has not seen is not looked up.
fn held_branch<T: ReadTxn>(txn: &T, id: &BranchID) -> Option<yrs::branch::BranchPtr> {
    match id {
        BranchID::Nested(item) if item.clock >= txn.state_vector().get(&item.client) => None,
        _ => id.get_branch(txn),
    }
}

/// Whether the update itself deletes the item `id` (a binary search).
fn deleted_by(incoming: &ydoc::Incoming, id: &yrs::ID) -> bool {
    incoming.deletes(&id.client, id.clock, id.clock + 1)
}

/// The current entry of `key` in an element's map (live or deleted), a
/// counted lookup.
fn entry_of(branch: yrs::branch::BranchPtr, key: &str) -> Option<yrs::block::ItemPtr> {
    ydoc::steps::step(ydoc::steps::Walk::Entries);
    branch.entry_item(key)
}

/// The plain value an entry holds while it is live; a Mermaid source text
/// counts as a string ([source_text]).
fn live_value(item: yrs::block::ItemPtr) -> Option<Any> {
    match item.content() {
        _ if item.is_deleted() => None,
        ItemContent::Any(values) => Some(values.last().cloned().unwrap_or(Any::Null)),
        ItemContent::Type(branch) if matches!(branch.type_ref(), TypeRef::Text) => {
            Some(source_text())
        }
        ItemContent::Type(branch) if matches!(branch.type_ref(), TypeRef::Map) => {
            Some(live_block())
        }
        _ => None,
    }
}

/// What a Mermaid `source` held as a text (shape A) stands for in the key
/// checks: the string the projection reads from it, whose content they never
/// need.
fn source_text() -> Any {
    Any::String(Arc::from(""))
}

/// What a figure's live block (a map, Epo 2026-10-17) stands for in the key
/// checks: present, its value checked whole on the copy ([on_candidate]). A
/// buffer, which no plain entry holds ([plain_content] refuses one), so no
/// update can write it.
fn live_block() -> Any {
    Any::Buffer(Arc::from(Vec::new()))
}

/// A key's value after the update, read without applying it (REVIEW5 R2b).
/// With no entry written: the room's current one, unless the update deletes
/// it. Otherwise the update's entries must chain from the room's current
/// entry (or from none when the room never held the key), each written right
/// after the one before with no right origin, as a writer's own sets are;
/// the last one is the value, unless the update deletes it. `None` when they
/// do not chain (a stale or concurrent write, writers merged into one
/// update): Yjs's conflict order places those, read on the result instead.
fn value_after(
    current: Option<yrs::block::ItemPtr>,
    written: &[Written],
    cleared: bool,
    incoming: &ydoc::Incoming,
) -> Option<Option<Any>> {
    if written.is_empty() {
        return Some(if cleared {
            None
        } else {
            current.and_then(live_value)
        });
    }
    // Each entry by the one it was written after; two after the same one
    // (or one with a right origin) is a conflict for Yjs to order.
    let mut after: HashMap<Option<yrs::ID>, &Written> = HashMap::with_capacity(written.len());
    for entry in written {
        ydoc::steps::step(ydoc::steps::Walk::Entries);
        if entry.right || after.insert(entry.origin, entry).is_some() {
            return None;
        }
    }
    let mut tail =
        current.map(|item| yrs::ID::new(item.id().client, item.id().clock + item.len() - 1));
    let mut last = None;
    let mut chained: HashSet<yrs::ID> = HashSet::with_capacity(written.len());
    for _ in written {
        ydoc::steps::step(ydoc::steps::Walk::Entries);
        let entry = after.get(&tail)?;
        if !chained.insert(entry.id) {
            return None;
        }
        tail = Some(entry.last);
        last = Some(*entry);
    }
    let last = last?;
    Some(match &last.value {
        Some(value) if !deleted_by(incoming, &last.last) => Some(value.clone()),
        _ => None,
    })
}

/// Elements keep the keys the store requires (`material::assert_canonical`;
/// REVIEW5 R2): after the update, an element whose [guarded] keys it writes
/// or clears, or that it creates, still has each key it had of a non-empty
/// `type`, an `id` at the top level and its type's own keys, and an element
/// it creates or retypes has them all. Each key is looked up, in the room and
/// in the update's entries ([value_after]), without a copy. An element whose
/// entries Yjs's conflict order places is read on `result`, the room with the
/// update applied; without one the answer is `Ok(true)`, a copy needed
/// (which [heavy] reports, so it is made off the async workers), once every
/// other element passed: a refusal anywhere answers first. Refused here, so
/// only this writer's update is lost: the store would discard the room.
fn required_keys<T: ReadTxn>(
    txn: &T,
    incoming: &ydoc::Incoming,
    shape: &Shape,
    result: Option<&yrs::Doc>,
) -> Result<bool, Refusal> {
    use yrs::Transact;
    fn holds(key: &str, value: Option<&Any>) -> bool {
        match (key, value) {
            ("type" | "id" | "materialId", Some(Any::String(value))) => {
                !crate::questions::js_trim(value).is_empty()
            }
            ("type" | "id" | "materialId", _) => false,
            (_, value) => value.is_some_and(|value| !matches!(value, Any::Null | Any::Undefined)),
        }
    }
    let result = result.map(|doc| doc.transact());
    let root = BranchID::Root(plate::CONTENT_ROOT.into());
    let touched: HashSet<&BranchID> = shape
        .set
        .keys()
        .chain(shape.cleared.keys())
        .chain(shape.created.keys())
        .collect();
    let mut copy_needed = false;
    for id in touched {
        let (branch, parent, created) = match (id, held_branch(txn, id)) {
            (BranchID::Root(_), _) => continue,
            (_, Some(branch)) => {
                let Some(item) = branch.item() else { continue };
                if !matches!(branch.type_ref(), TypeRef::XmlText)
                    || item.is_deleted()
                    || deleted_by(incoming, item.id())
                {
                    continue;
                }
                (Some(branch), item.parent_branch().map(|p| p.id()), false)
            }
            (BranchID::Nested(item), None) => match shape.created.get(id) {
                Some(parent) if !deleted_by(incoming, item) => (None, parent.clone(), true),
                _ => continue,
            },
        };
        let before = |key: &str| {
            branch
                .and_then(|branch| entry_of(branch, key))
                .and_then(live_value)
        };
        let written = shape.set.get(id);
        let cleared = shape.cleared.get(id);
        let resolved = |key: &str| {
            value_after(
                branch.and_then(|branch| entry_of(branch, key)),
                written
                    .and_then(|keys| keys.get(key))
                    .map_or(&[], Vec::as_slice),
                cleared.is_some_and(|keys| keys.contains(key)),
                incoming,
            )
        };
        let top = parent.as_ref() == Some(&root);
        let retyped = written.is_some_and(|keys| keys.contains_key("type"))
            || cleared.is_some_and(|keys| keys.contains("type"));
        // Ok(true) when a key's value is not known without the result.
        let check = |after: &dyn Fn(&str) -> Option<Option<Any>>| -> Result<bool, Refusal> {
            let Some(kind) = after("type") else {
                return Ok(true);
            };
            // A top-level-only block (a reference, a figure, an interactive
            // block) sits at the top level, as the store requires (live-items
            // REVIEW5 R2): one this update creates or retypes below it is
            // refused.
            if !top
                && (created || retyped)
                && matches!(&kind, Some(Any::String(kind))
                    if catalog::element(kind).is_some_and(|element| element.top_level))
            {
                return Err(Refusal::Content(NESTED_BLOCK));
            }
            let own = own_keys(kind.as_ref());
            let mut required = vec!["type"];
            if top {
                required.push("id");
            }
            required.extend_from_slice(own);
            for key in required {
                let value = if key == "type" {
                    kind.clone()
                } else {
                    match after(key) {
                        Some(value) => value,
                        None => return Ok(true),
                    }
                };
                if holds(key, value.as_ref()) {
                    continue;
                }
                // A key the element already lacked is not this update's
                // doing, unless the update created it or gave it the type
                // that needs it.
                let imposed = created || (retyped && (key == "type" || own.contains(&key)));
                if imposed || holds(key, before(key).as_ref()) {
                    return Err(Refusal::Content(MISSING_KEY));
                }
            }
            // Nor a key the catalog forbids it: one this update writes, or
            // one a block it creates or retypes holds.
            for key in forbidden_keys(kind.as_ref()) {
                let value = match after(key) {
                    Some(value) => value,
                    None => return Ok(true),
                };
                let wrote = written.is_some_and(|keys| keys.contains_key(*key));
                if (created || retyped || wrote) && holds(key, value.as_ref()) {
                    return Err(Refusal::Content(FORBIDDEN_KEY));
                }
            }
            // Nor a value the store refuses: one this update writes, or one
            // a block it creates or retypes holds.
            if let Some(Any::String(name)) = &kind {
                for key in VALUE_KEYS {
                    let wrote = written.is_some_and(|keys| keys.contains_key(key));
                    if !(created || retyped || wrote) {
                        continue;
                    }
                    let value = match after(key) {
                        Some(value) => value,
                        None => return Ok(true),
                    };
                    if let Some(value) = value.filter(|value| !matches!(value, Any::Undefined))
                        && !value_ok(name, key, &value)
                    {
                        // A figure's block takes its live map only.
                        return Err(Refusal::Content(if plate::holds_map(name, key) {
                            PLAIN_BLOCK
                        } else {
                            BAD_VALUE
                        }));
                    }
                }
            }
            Ok(false)
        };
        if check(&resolved)? {
            // Every other element is still checked, so a refusal wins
            // whatever order the set walks in: `heavy` and `admit` then
            // agree (REVIEW5 final S1).
            let Some(result) = &result else {
                copy_needed = true;
                continue;
            };
            let Some(branch) = id.get_branch(result) else {
                continue;
            };
            if branch.item().is_some_and(|item| item.is_deleted()) {
                continue;
            }
            check(&|key: &str| Some(entry_of(branch, key).and_then(live_value)))?;
        }
    }
    Ok(copy_needed)
}

/// The elements [plain_content] named, read in `candidate`, the room with the
/// update applied. Media blocks name their file (Epo, 2026-10-10): an `img`
/// or `audio` element carries a non-empty `assetId` and no `url` or `src`. A
/// closed element (chart, plot, graph, html_embed) carries only its fields.
/// Refused here, when the update arrives, so only this writer's update is
/// lost; the store's check would discard the room.
fn on_candidate(candidate: &yrs::Doc, touched: &HashSet<BranchID>) -> Result<(), Refusal> {
    use yrs::Transact;
    let txn = candidate.transact();
    let mut embeds_counted = false;
    for id in touched {
        let Some(branch) = id.get_branch(&txn) else {
            continue;
        };
        if branch.item().is_some_and(|item| item.is_deleted()) {
            continue;
        }
        let attributes: HashMap<Arc<str>, Any> = plate::properties(&branch)?.into_iter().collect();
        let kind = match attributes.get("type") {
            Some(Any::String(kind)) => kind.to_string(),
            _ => String::new(),
        };
        // A live block map sits on a figure only, and holds a block its store
        // takes, read as the projection reads it (repaired, Epo 2026-10-17).
        // Only a shared-map key may hold one ([plain_content]).
        for key in MAP_KEYS.iter().copied() {
            let map = entry_of(branch, key).is_some_and(|item| {
                !item.is_deleted()
                    && matches!(item.content(), ItemContent::Type(map) if matches!(map.type_ref(), TypeRef::Map))
            });
            if !map {
                continue;
            }
            if !plate::holds_map(&kind, key) {
                return Err(Refusal::Content(STRAY_MAP));
            }
            let block = attributes
                .get(key)
                .map(json::any_to_value)
                .transpose()
                .map_err(ProjectionError::from)?
                .unwrap_or(Value::Null);
            // Every held list entry is one a writer could write, the ones a
            // read leaves out too (Epo 2026-10-18); the repaired block is one
            // the room's store takes.
            let held = plate::held_block_value(branch)?.unwrap_or(Value::Null);
            if crate::questions::figure_entries(&held).is_err()
                || crate::material::live_figure_block(&kind, &block).is_err()
            {
                return Err(Refusal::Content(BAD_VALUE));
            }
        }
        if let Some(Any::String(kind)) = attributes.get("type")
            && let Some(fields) = closed_fields(kind)
            && attributes
                .iter()
                .any(|(key, value)| !matches!(value, Any::Undefined) && !fields.contains(&&**key))
        {
            return Err(Refusal::Content(UNEXPECTED_KEY));
        }
        // An interactive block made: the document's top level holds at most
        // `HTML_EMBED_MAX_COUNT`, counted once on the copy.
        if !embeds_counted
            && matches!(attributes.get("type"), Some(Any::String(kind))
                if &**kind == crate::material::HTML_EMBED_TYPE)
        {
            embeds_counted = true;
            if top_level_embeds(&txn)? > catalog::HTML_EMBED_MAX_COUNT {
                return Err(Refusal::Content(TOO_MANY_EMBEDS));
            }
        }
        let media = matches!(attributes.get("type"), Some(Any::String(kind))
            if crate::material::MEDIA_TYPES.contains(&&**kind));
        if !media {
            continue;
        }
        let named =
            matches!(attributes.get("assetId"), Some(Any::String(asset)) if !asset.is_empty());
        let linked = ["url", "src"].iter().any(|key| {
            attributes
                .get(*key)
                .is_some_and(|value| !matches!(value, Any::Null))
        });
        if !named || linked {
            return Err(Refusal::Content("a media block without its asset id"));
        }
    }
    Ok(())
}

/// The interactive blocks at a document's top level.
fn top_level_embeds<T: ReadTxn>(txn: &T) -> Result<usize, Refusal> {
    let Some(root) = plate::content_root(txn) else {
        return Ok(0);
    };
    let mut count = 0;
    for op in plate::insert_delta(&root)? {
        if let Insert::Element(element) = op.insert {
            let kind = plate::properties(&element)?
                .into_iter()
                .find(|(key, _)| &**key == "type");
            if matches!(kind, Some((_, Any::String(kind))) if &*kind == crate::material::HTML_EMBED_TYPE)
            {
                count += 1;
            }
        }
    }
    Ok(count)
}

/// The room with `update` applied, on a copy.
fn candidate_of<T: ReadTxn>(txn: &T, update: &Update) -> Result<yrs::Doc, Refusal> {
    use yrs::Transact;
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
    Ok(candidate)
}

/// One note room's limit state between exact measurements (`RoomValidator`):
/// the last exact metrics (the shrink baseline) and an upper bound of the
/// metrics now, the exact ones plus each later update's growth bound. The
/// bound holds only while every content change is an update `admit` checked
/// against the room as it was; the server calls `invalidate` for any other
/// (a service edit, a children pass, a reload).
#[derive(Debug)]
pub struct Validator {
    /// The room's material kind (`note`, `mindmap`, `diagram`): the element
    /// types it may hold.
    pub material: String,
    pub bound: Option<Metrics>,
    pub metrics: Option<Metrics>,
    /// Exact measurements taken (a copy of the room each).
    pub exact_checks: u64,
    /// Copies of the room taken for the media and closed-field checks alone.
    pub media_copies: u64,
    /// Copies of the room taken to read required keys whose entries Yjs's
    /// conflict order places ([required_keys]).
    pub key_copies: u64,
}

impl Validator {
    /// A room's admission for a document of material kind `material`, with no
    /// metrics yet (the first update measures exactly).
    pub fn new(material: &str) -> Validator {
        Validator {
            material: material.to_owned(),
            bound: None,
            metrics: None,
            exact_checks: 0,
            media_copies: 0,
            key_copies: 0,
        }
    }

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
        let mut trial = inspection.trial;
        // Checked once the update is within the limits, so a limit refusal
        // keeps its reason.
        let mut shape = Shape::default();
        if keeps_roots {
            let media = plain_content(&txn, &incoming, &mut shape, &self.material)?;
            if !media.is_empty() {
                // Rare (an image inserted, a file named): the room is copied
                // only when inspect did not already.
                let candidate = match trial.take() {
                    Some(trial) => trial,
                    None => {
                        self.media_copies += 1;
                        candidate_of(&txn, update)?
                    }
                };
                on_candidate(&candidate, &media)?;
                trial = Some(candidate);
            }
        }
        // The common case: the room's bound plus this update's growth bound
        // stays within every limit, so the room is not copied per keystroke.
        // The exact measurement below decides anything else, and refuses a
        // root violation.
        let growth = match self.bound {
            Some(_) if keeps_roots && !shape.exact && plate::content_root(&txn).is_some() => {
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
                if required_keys(&txn, &incoming, &shape, trial.as_ref())? {
                    self.key_copies += 1;
                    required_keys(&txn, &incoming, &shape, Some(&candidate_of(&txn, update)?))?;
                }
                self.bound = Some(next);
                return Ok(Admission::Accepted);
            }
        }
        self.exact_checks += 1;
        // The trial copy when inspect made one; for a small edit, a copy now.
        let candidate = match trial {
            Some(trial) => trial,
            None => candidate_of(&txn, update)?,
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
        drop(candidate_txn);
        required_keys(&txn, &incoming, &shape, Some(&candidate))?;
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
