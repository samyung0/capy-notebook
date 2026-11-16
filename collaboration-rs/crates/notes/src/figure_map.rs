//! A chart, plot or graph held live (Epo 2026-11-16, D2/D3/D9/D15): one
//! layout wherever a room holds one, a quiz room's block entry (beside its
//! `order`) and a note figure's `block` alike, read, written and admitted by
//! this module for both (the browser's twin is
//! `src/features/figures/figureMap.ts`). A figure is a map of its fields, each
//! a plain value replaced whole:
//!
//! - graph `{type, width, height, description?, board: {bbox, axis, grid,
//!   polar?}, elements: element id -> {element, order}}`;
//! - chart `{type, kind, title, xTitle?, yTitle?, gridlines?, description?,
//!   series: id -> order key, labels: id -> order key, names: series or label
//!   id -> its name, values: "series/label" -> number}` (no value: an empty
//!   cell), its series and labels held as a table's rows and columns;
//! - plot `{type, ...its fields}`.
//!
//! Order keys sort as strings and a tie (two editors adding at once) is broken
//! by id. A read is repaired (`questions::repair_figure`), as a merge may leave
//! what no editor wrote; the writer writes only what differs, so another
//! writer's change to a different field, element or value survives.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::{Map, Value, json};
use ydoc::steps::{Walk, step};
use yrs::block::{ItemContent, ItemPtr};
use yrs::branch::{Branch, BranchPtr};
use yrs::types::TypeRef;
use yrs::{Any, Map as _, MapPrelim, MapRef, Out, TransactionMut};

use crate::json::{self, Unencodable};
use crate::order;
use crate::questions as q;

/// The element types held as a figure map.
pub const TYPES: [&str; 3] = ["chart", "plot", "graph"];

pub fn is_figure(kind: &str) -> bool {
    TYPES.contains(&kind)
}

/// The keys a figure of `kind` holds as maps, never as its plain fields.
pub fn maps(kind: &str) -> &'static [&'static str] {
    match kind {
        "chart" => &["series", "labels", "names", "values"],
        "graph" => &["board", "elements"],
        _ => &[],
    }
}

/// Whether `key` is one of some figure's maps.
pub fn is_map_key(key: &str) -> bool {
    matches!(
        key,
        "series" | "labels" | "names" | "values" | "board" | "elements"
    )
}

/// Keys a container gives a figure's map besides its block: a quiz entry's
/// `order`, and the `type` a read takes from its caller.
fn held(key: &str, kind: &str) -> bool {
    key == "order" || key == "type" || maps(kind).contains(&key)
}

/// Ids a writer mints (map keys): `[A-Za-z0-9_-]`, at most this long.
pub const MAX_ID: usize = 128;

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/* ------------------------------------------------------------- reading */

/// A map's live entries, each counted (`Walk::Exact`).
fn entries(branch: &Branch) -> impl Iterator<Item = (&Arc<str>, ItemPtr)> {
    branch.map_items().filter(|(_, item)| {
        step(Walk::Exact);
        !item.is_deleted()
    })
}

/// An entry's plain value (a cheap clone: strings, lists and maps are
/// shared).
fn plain_of(item: ItemPtr) -> Option<Any> {
    match item.content() {
        ItemContent::Any(values) => values
            .last()
            .filter(|value| !matches!(value, Any::Undefined))
            .cloned(),
        _ => None,
    }
}

/// The plain value under `key`.
fn plain_at(branch: &Branch, key: &str) -> Option<Any> {
    plain_of(branch.entry_item(key).filter(|item| !item.is_deleted())?)
}

/// The map under `key`.
fn map_at(branch: &Branch, key: &str) -> Option<BranchPtr> {
    let item = branch.entry_item(key).filter(|item| !item.is_deleted())?;
    match item.content() {
        ItemContent::Type(map) if matches!(map.type_ref(), TypeRef::Map) => {
            Some(BranchPtr::from(map.as_ref()))
        }
        _ => None,
    }
}

/// An axis's ids (id -> order key: a chart's series or labels) with their
/// keys, in order.
fn ordered_pairs(branch: &Branch) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = entries(branch)
        .map(|(id, item)| {
            let order = match plain_of(item) {
                Some(Any::String(order)) => order.to_string(),
                _ => String::new(),
            };
            (order, id.to_string())
        })
        .collect();
    out.sort();
    out.into_iter().map(|(order, id)| (id, order)).collect()
}

/// A graph's element entries as held, by order key then id, as `(id, order,
/// element)`; one not `{element, order}` under its own id is left out.
fn element_entries(branch: &Branch) -> Vec<(String, String, Any)> {
    let mut out: Vec<(String, String, Any)> = entries(branch)
        .filter_map(|(id, item)| {
            let Some(Any::Map(entry)) = plain_of(item) else {
                return None;
            };
            let Some(Any::String(order)) = entry.get("order") else {
                return None;
            };
            let element = entry.get("element")?;
            match element {
                Any::Map(inner)
                    if matches!(inner.get("id"), Some(Any::String(own)) if own.as_ref() == id.as_ref()) =>
                {
                    Some((id.to_string(), order.to_string(), element.clone()))
                }
                _ => None,
            }
        })
        .collect();
    out.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    out
}

/// A figure map's plain fields, its type among them.
fn fields(branch: &Branch, kind: &str) -> Result<Map<String, Value>, Unencodable> {
    let mut out = Map::new();
    for (key, item) in entries(branch) {
        if held(key, kind) {
            continue;
        }
        if let Some(value) = plain_of(item) {
            out.insert(key.to_string(), json::any_to_value(&value)?);
        }
    }
    out.insert("type".into(), json!(kind));
    Ok(out)
}

/// A figure as held, not repaired; none while it lacks the maps its kind
/// writes.
fn build(branch: &Branch, kind: &str) -> Result<Option<Value>, Unencodable> {
    let mut block = fields(branch, kind)?;
    match kind {
        "graph" => {
            let (Some(board), Some(elements)) =
                (map_at(branch, "board"), map_at(branch, "elements"))
            else {
                return Ok(None);
            };
            let mut board_fields = Map::new();
            for (key, item) in entries(&board) {
                if let Some(value) = plain_of(item) {
                    board_fields.insert(key.to_string(), json::any_to_value(&value)?);
                }
            }
            block.insert("board".into(), Value::Object(board_fields));
            let elements = element_entries(&elements)
                .iter()
                .map(|(_, _, element)| json::any_to_value(element))
                .collect::<Result<_, _>>()?;
            block.insert("elements".into(), Value::Array(elements));
        }
        "chart" => {
            let (Some(labels), Some(series)) = (map_at(branch, "labels"), map_at(branch, "series"))
            else {
                return Ok(None);
            };
            let labels = ordered_pairs(&labels);
            let series = ordered_pairs(&series);
            let names = map_at(branch, "names");
            let values = map_at(branch, "values");
            let name = |id: &str| match names.and_then(|names| plain_at(&names, id)) {
                Some(Any::String(name)) => name.to_string(),
                _ => String::new(),
            };
            let value = |series: &str, label: &str| match values
                .and_then(|values| plain_at(&values, &format!("{series}/{label}")))
            {
                Some(Any::Number(n)) => json::number_value(n),
                _ => Value::Null,
            };
            block.insert(
                "labels".into(),
                labels.iter().map(|(id, _)| json!(name(id))).collect(),
            );
            block.insert(
                "series".into(),
                series
                    .iter()
                    .map(|(id, _)| {
                        json!({
                            "name": name(id),
                            "values": labels.iter().map(|(label, _)| value(id, label)).collect::<Vec<_>>(),
                        })
                    })
                    .collect(),
            );
        }
        _ => {}
    }
    Ok(Some(Value::Object(block)))
}

/// A figure map as the plain block it holds, not repaired (what an editor
/// shows with its issues, and what a room measures): a map lacking the maps
/// its kind writes reads as its plain fields.
pub fn held_block(branch: &Branch, kind: &str) -> Result<Value, Unencodable> {
    Ok(match build(branch, kind)? {
        Some(block) => block,
        None => Value::Object(fields(branch, kind)?),
    })
}

/// A figure map as its block, repaired: what readers draw and the projection
/// stores.
pub fn block(branch: &Branch, kind: &str) -> Result<Value, Unencodable> {
    let mut block = held_block(branch, kind)?;
    q::repair_figure(&mut block);
    Ok(block)
}

/// A figure map as its block, repaired; none while it lacks the maps its
/// kind writes (a quiz room skips it).
pub fn read(branch: &Branch, kind: &str) -> Option<Value> {
    let mut block = build(branch, kind).ok()??;
    q::repair_figure(&mut block);
    Some(block)
}

/* ------------------------------------------------------------- writing */

/// JSON of a plain value: whole numbers print as integers, as the JSON a
/// stored block came from.
pub fn any_json(value: &Any) -> Value {
    match value {
        Any::Null | Any::Undefined => Value::Null,
        Any::Bool(value) => json!(value),
        Any::Number(value) => {
            if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
                json!(*value as i64)
            } else {
                json!(value)
            }
        }
        Any::BigInt(value) => json!(value),
        Any::String(value) => json!(value.as_ref()),
        Any::Buffer(_) => Value::Null,
        Any::Array(items) => Value::Array(items.iter().map(any_json).collect()),
        Any::Map(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), any_json(value)))
                .collect(),
        ),
    }
}

/// A plain value of JSON.
pub fn json_any(value: &Value) -> Any {
    match value {
        Value::Null => Any::Null,
        Value::Bool(value) => Any::Bool(*value),
        Value::Number(value) => Any::Number(value.as_f64().unwrap_or(0.0)),
        Value::String(value) => Any::String(Arc::from(value.as_str())),
        Value::Array(items) => Any::Array(items.iter().map(json_any).collect()),
        Value::Object(map) => Any::Map(Arc::new(
            map.iter()
                .map(|(key, value)| (key.clone(), json_any(value)))
                .collect(),
        )),
    }
}

fn string_any(value: &str) -> Any {
    Any::String(Arc::from(value))
}

/// The map under `key`, created when missing (or holding something else).
fn child_map(txn: &mut TransactionMut, parent: &MapRef, key: &str) -> MapRef {
    match parent.get(txn, key) {
        Some(Out::YMap(map)) => map,
        _ => parent.insert(txn, key, MapPrelim::default()),
    }
}

/// Sets a plain value (none removes it), writing only a change.
fn sync_plain(txn: &mut TransactionMut, map: &MapRef, key: &str, value: Option<Any>) {
    match value {
        Some(value) => {
            let held = match map.get(txn, key) {
                Some(Out::Any(held)) => Some(held),
                _ => None,
            };
            if held.as_ref() != Some(&value) {
                map.insert(txn, key, value);
            }
        }
        None => {
            if map.contains_key(txn, key) {
                map.remove(txn, key);
            }
        }
    }
}

/// Removes the keys of `map` that `keep` refuses.
fn remove_keys(txn: &mut TransactionMut, map: &MapRef, keep: impl Fn(&str) -> bool) {
    let stale: Vec<String> = map
        .keys(txn)
        .filter(|key| !keep(key))
        .map(str::to_owned)
        .collect();
    for key in stale {
        map.remove(txn, &key);
    }
}

/// An id `prefix<n>` (from `n` up) the map does not hold.
fn fresh_id(txn: &TransactionMut, map: &MapRef, prefix: &str, n: &mut usize) -> String {
    loop {
        let id = format!("{prefix}{n}");
        *n += 1;
        if !map.contains_key(txn, &id) {
            return id;
        }
    }
}

/// An order key after `last` for an entry whose key is `held`: the held one
/// while it still sorts after `last`.
pub fn next_order(held: Option<&str>, last: Option<&str>) -> String {
    match held {
        Some(held) if !held.is_empty() && last.is_none_or(|last| last < held) => held.to_owned(),
        _ => order::after(last),
    }
}

/// An axis's ids (id to order key: a table's rows or columns, a chart's
/// series or labels) for `count` of them, by position, in order.
pub fn sync_keys(
    txn: &mut TransactionMut,
    parent: &MapRef,
    key: &str,
    prefix: &str,
    count: usize,
) -> Vec<String> {
    let map = child_map(txn, parent, key);
    let held = ordered_pairs(map.as_ref());
    let mut ids = Vec::with_capacity(count);
    let mut last: Option<String> = None;
    let mut n = 0;
    for i in 0..count {
        let id = match held.get(i) {
            Some((id, _)) => id.clone(),
            None => fresh_id(txn, &map, prefix, &mut n),
        };
        let held_order = held.get(i).map(|(_, order)| order.as_str());
        let order = next_order(held_order, last.as_deref());
        sync_plain(txn, &map, &id, Some(string_any(&order)));
        last = Some(order);
        ids.push(id);
    }
    for (id, _) in held.iter().skip(count) {
        map.remove(txn, id);
    }
    ids
}

fn str_of<'v>(value: &'v Value, key: &str) -> &'v str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn array_of<'v>(value: &'v Value, key: &str) -> &'v [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// A figure's map made to hold `block` (of `kind`), writing only what
/// differs: its plain fields, a graph's board fields and elements by id, a
/// chart's series and labels as a table's rows and columns (by position) with
/// their names and values. Nothing is written whole, so another writer's
/// change to another field, element or value meanwhile survives. The map's
/// `type` (and a quiz entry's `order`) are its container's.
pub fn sync(txn: &mut TransactionMut, map: &MapRef, kind: &str, block: &Value) {
    let maps = maps(kind);
    let empty = Map::new();
    let fields = block.as_object().unwrap_or(&empty);
    for (key, value) in fields {
        if !held(key, kind) {
            sync_plain(txn, map, key, (!value.is_null()).then(|| json_any(value)));
        }
    }
    remove_keys(txn, map, |key| {
        key == "order" || key == "type" || maps.contains(&key) || fields.contains_key(key)
    });
    match kind {
        "graph" => {
            let board = child_map(txn, map, "board");
            let wanted = block
                .get("board")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            for (key, value) in wanted {
                sync_plain(txn, &board, key, Some(json_any(value)));
            }
            remove_keys(txn, &board, |key| wanted.contains_key(key));
            let elements = child_map(txn, map, "elements");
            sync_elements(txn, &elements, array_of(block, "elements"));
        }
        "chart" => sync_chart(txn, map, block),
        _ => {}
    }
}

/// A graph's elements as `elements`, by id: an equal one keeps its entry, a
/// changed or moved one is set again, a gone one goes.
fn sync_elements(txn: &mut TransactionMut, map: &MapRef, elements: &[Value]) {
    let held: HashMap<String, (String, Any)> = element_entries(map.as_ref())
        .into_iter()
        .map(|(id, order, element)| (id, (order, element)))
        .collect();
    let mut kept = HashSet::new();
    let mut last: Option<String> = None;
    for element in elements {
        let Some(id) = element.get("id").and_then(Value::as_str) else {
            continue;
        };
        let held = held.get(id);
        let order = next_order(held.map(|(order, _)| order.as_str()), last.as_deref());
        let wanted = json_any(element);
        if held.is_none_or(|(at, was)| *at != order || *was != wanted) {
            let entry = HashMap::from([
                ("element".to_owned(), wanted),
                ("order".to_owned(), string_any(&order)),
            ]);
            map.insert(txn, id, Any::Map(Arc::new(entry)));
        }
        kept.insert(id.to_owned());
        last = Some(order);
    }
    remove_keys(txn, map, |id| kept.contains(id));
}

/// A chart's labels and series as a table's columns and rows ([sync_keys]),
/// their names, and each value (none for an empty cell).
fn sync_chart(txn: &mut TransactionMut, map: &MapRef, block: &Value) {
    let labels = array_of(block, "labels");
    let series = array_of(block, "series");
    let label_ids = sync_keys(txn, map, "labels", "l", labels.len());
    let series_ids = sync_keys(txn, map, "series", "s", series.len());
    let names = child_map(txn, map, "names");
    let values = child_map(txn, map, "values");
    let mut named = HashSet::new();
    let mut kept = HashSet::new();
    for (id, label) in label_ids.iter().zip(labels) {
        let label = label.as_str().unwrap_or_default();
        sync_plain(txn, &names, id, Some(string_any(label)));
        named.insert(id.clone());
    }
    for (id, entry) in series_ids.iter().zip(series) {
        sync_plain(txn, &names, id, Some(string_any(str_of(entry, "name"))));
        named.insert(id.clone());
        let cells = array_of(entry, "values");
        for (l, label) in label_ids.iter().enumerate() {
            let key = format!("{id}/{label}");
            let value = cells.get(l).and_then(Value::as_f64).map(Any::Number);
            sync_plain(txn, &values, &key, value);
            kept.insert(key);
        }
    }
    remove_keys(txn, &names, |id| named.contains(id));
    remove_keys(txn, &values, |key| kept.contains(key));
}

/// A new figure map for `block` under `key` of `parent` (an insert or a
/// clone): its type, then [sync].
pub fn insert(txn: &mut TransactionMut, parent: &MapRef, key: &str, block: &Value) -> MapRef {
    let kind = str_of(block, "type").to_owned();
    let map = parent.insert(txn, key, MapPrelim::default());
    map.insert(txn, "type", string_any(&kind));
    sync(txn, &map, &kind, block);
    map
}

/* ----------------------------------------------------------- admission */

/// A chart's or plot's kind: a short name (the validators know the kinds).
const KIND_MAX: usize = 16;

const fn larger(a: usize, b: usize) -> usize {
    if a > b { a } else { b }
}

/// A chart's or plot's title, axis title or unit.
const TITLE_MAX: usize = larger(q::QUESTION_CHART_TITLE_MAX, q::QUESTION_PLOT_TITLE_MAX);
/// A chart series' or label's name.
const NAME_MAX: usize = larger(
    q::QUESTION_CHART_LABEL_MAX,
    q::QUESTION_CHART_SERIES_NAME_MAX,
);

fn string_within(value: &Any, cap: usize) -> bool {
    matches!(value, Any::String(text) if text.chars().count() <= cap)
}

fn finite(value: &Any) -> bool {
    matches!(value, Any::Number(n) if n.is_finite())
}

/// The entries one of a figure's maps holds at most: a chart's series,
/// labels, names and values and a graph's elements at twice their caps, as a
/// merge may pass a cap and its read keeps the first ones (Epo 2026-10-18).
pub fn map_cap(key: &str) -> Option<usize> {
    let (series, labels) = (
        2 * q::QUESTION_CHART_SERIES_MAX,
        2 * q::QUESTION_CHART_LABELS_MAX,
    );
    Some(match key {
        "series" => series,
        "labels" => labels,
        "names" => series + labels,
        "values" => series * labels,
        "elements" => 2 * q::QUESTION_GRAPH_ELEMENTS_MAX,
        _ => return None,
    })
}

/// One plain field of a figure's map (its `type` and a quiz entry's `order`
/// are the container's to check), held to its cap; its form is the
/// validators'.
pub fn check_field(key: &str, value: &Any) -> Result<(), String> {
    let fits = match key {
        "kind" => string_within(value, KIND_MAX),
        "title" | "xTitle" | "yTitle" | "unit" => string_within(value, TITLE_MAX),
        "gridlines" => {
            matches!(value, Any::String(lines) if matches!(lines.as_ref(), "normal" | "fine"))
        }
        "description" => string_within(value, q::QUESTION_DESCRIPTION_MAX),
        "width" | "height" => matches!(value, Any::Number(size)
            if size.fract() == 0.0 && (1.0..=q::QUESTION_IMAGE_DIMENSION_MAX).contains(size)),
        // A plot's lists are plain values, held to the plot's caps.
        "series" | "lines" | "marks" => {
            return match value {
                Any::Array(_) => {
                    let list =
                        json::any_to_value(value).map_err(|_| "a plot list that is not plain")?;
                    q::figure_caps("plot", &json!({ key: list }))
                }
                _ => Err("a plot list that is not a list".into()),
            };
        }
        _ => false,
    };
    if fits {
        Ok(())
    } else {
        Err("a struct outside its shape".into())
    }
}

/// One entry of a figure's map `inner` under `key`: a series or label id's
/// order key, a name, a cell's number, a board field, or a graph element's
/// `{element, order}` under its own id, the element one a writer writes
/// (`questions::graph_element`) within the graph's caps.
pub fn check_entry(inner: &str, key: &str, value: &Any) -> Result<(), String> {
    let fits = match inner {
        "series" | "labels" => {
            valid_id(key) && matches!(value, Any::String(order) if order::valid(order))
        }
        "names" => valid_id(key) && string_within(value, NAME_MAX),
        "values" => {
            let mut ids = key.split('/');
            let fits = matches!((ids.next(), ids.next(), ids.next()), (Some(series), Some(label), None)
                if valid_id(series) && valid_id(label))
                && finite(value)
                && json::any_to_value(value)
                    .is_ok_and(|value| q::chart_value(&value, "a chart value").is_ok());
            return if fits {
                Ok(())
            } else {
                Err("a chart value that is not a number keyed series/label".into())
            };
        }
        "board" => match key {
            "bbox" => {
                matches!(value, Any::Array(items) if items.len() == 4 && items.iter().all(finite))
            }
            "axis" | "grid" | "polar" => matches!(value, Any::Bool(_)),
            _ => false,
        },
        "elements" => return element_entry(key, value),
        _ => false,
    };
    if fits {
        Ok(())
    } else {
        Err("a struct outside its shape".into())
    }
}

fn element_entry(id: &str, value: &Any) -> Result<(), String> {
    let element = match value {
        Any::Map(entry)
            if entry.len() == 2
                && matches!(entry.get("order"), Some(Any::String(order)) if order::valid(order)) =>
        {
            entry.get("element")
        }
        _ => None,
    };
    match element {
        Some(element @ Any::Map(inner))
            if matches!(inner.get("id"), Some(Any::String(own)) if own.as_ref() == id)
                && q::identifier(&json!(id), "id").is_ok() =>
        {
            let element =
                json::any_to_value(element).map_err(|_| "a graph element that is not plain")?;
            q::figure_caps("graph", &json!({ "elements": [&element] }))?;
            q::graph_element_shape(&element)
        }
        _ => Err("a graph element that is not {element, order} under its id".into()),
    }
}

/// A figure map as a room holds it, every entry one a writer could write
/// (the ones a read leaves out too, Epo 2026-10-18): plain fields, its maps
/// with plain entries, each map within [map_cap]. The repaired block's own
/// checks are the validators' (`material::live_figure_block`).
pub fn check_held(branch: &Branch) -> Result<(), String> {
    for (key, item) in entries(branch) {
        match item.content() {
            ItemContent::Any(_) if &**key == "type" => {}
            ItemContent::Any(_) => match plain_of(item) {
                Some(value) => check_field(key, &value)?,
                None => return Err(format!("a figure field {key} that is not plain")),
            },
            ItemContent::Type(inner)
                if matches!(inner.type_ref(), TypeRef::Map) && is_map_key(key) =>
            {
                let mut count = 0;
                for (entry, item) in entries(inner) {
                    count += 1;
                    match plain_of(item) {
                        Some(value) => check_entry(key, entry, &value)?,
                        None => return Err(format!("a figure's {key} entry that is not plain")),
                    }
                }
                if map_cap(key).is_some_and(|cap| count > cap) {
                    return Err(format!("a figure's {key} past twice its cap"));
                }
            }
            _ => return Err(format!("a figure field {key} outside its shape")),
        }
    }
    Ok(())
}
