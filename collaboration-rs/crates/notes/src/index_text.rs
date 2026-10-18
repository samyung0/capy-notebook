//! A note's index text, the text retrieval chunks and note effects read,
//! exactly as Go's `materialdoc.ExtractIndexBlocks` gives it: each element
//! contributes what its embed catalog index rule says (`catalog::Index`,
//! openwiki/embeds.md "Index text"), one entry per top-level block that has
//! text, in document order. Both read the golden fixtures in
//! `server/internal/materialdoc/testdata/index_text`.
//!
//! No I/O: the caller passes each embedded item's text ([ItemText], from the
//! item's loaded room, else its stored `materials.content`, through
//! [item_from_content]).

use serde_json::Value;
use yrs::ReadTxn;
use yrs::branch::BranchPtr;

use crate::catalog::{self, Index};
use crate::plate::{self, Insert, ProjectionError};

/// The index text of one top-level block.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IndexBlock {
    pub id: String,
    pub text: String,
}

/// The text of a note's embedded items by material id.
pub trait ItemText {
    fn item_text(&self, material_id: &str) -> Option<String>;
}

/// An item holds no references.
struct NoItems;

impl ItemText for NoItems {
    fn item_text(&self, _: &str) -> Option<String> {
        None
    }
}

/// The material ids a live note references, in document order (an item
/// reference is a top-level block only). `root` is the note's content root,
/// read under `_txn`.
pub fn item_refs<T: ReadTxn>(_txn: &T, root: BranchPtr) -> Result<Vec<String>, ProjectionError> {
    let mut out = Vec::new();
    for op in plate::insert_delta(&root)? {
        if let Insert::Element(element) = op.insert
            && plate::string_attribute(element, "type")
                .as_deref()
                .map(rule)
                == Some(Index::Item)
            && let Some(id) = plate::string_attribute(element, "materialId")
        {
            out.push(id);
        }
    }
    Ok(out)
}

/// The material ids stored content (`{"schemaVersion":1,"value":[...]}`)
/// references, in document order.
pub fn content_item_refs(value: &Value) -> Vec<String> {
    top_level(value)
        .filter(|node| node_rule(node) == Index::Item)
        .filter_map(|node| node["materialId"].as_str().map(str::to_owned))
        .collect()
}

/// A live note's index text per block, read from its room's content root
/// under `_txn`: one top-level element at a time, a figure's `block` through
/// `plate::block_value`.
pub fn from_doc<T: ReadTxn>(
    _txn: &T,
    root: BranchPtr,
    items: &impl ItemText,
) -> Result<Vec<IndexBlock>, ProjectionError> {
    let mut blocks = Vec::new();
    for op in plate::insert_delta(&root)? {
        let mut pieces = Vec::new();
        let id = match op.insert {
            Insert::Text(text) => {
                push(&mut pieces, text.trim().to_owned());
                String::new()
            }
            Insert::Element(element) => {
                let typ = plate::string_attribute(element, "type");
                if typ.as_deref().map(rule) == Some(Index::Figure) {
                    if let Some(block) = plate::block_value(element)? {
                        push(&mut pieces, figure(&block));
                    }
                } else {
                    write_block(&plate::element(&element)?, items, &mut pieces);
                }
                plate::string_attribute(element, "id").unwrap_or_default()
            }
        };
        if !pieces.is_empty() {
            blocks.push(IndexBlock {
                id,
                text: pieces.join("\n\n"),
            });
        }
    }
    Ok(blocks)
}

/// Stored content's (`{"schemaVersion":1,"value":[...]}`) index text per block.
pub fn from_content(value: &Value, items: &impl ItemText) -> Vec<IndexBlock> {
    top_level(value)
        .filter_map(|node| {
            let mut pieces = Vec::new();
            write_block(node, items, &mut pieces);
            (!pieces.is_empty()).then(|| IndexBlock {
                id: node["id"].as_str().unwrap_or_default().to_owned(),
                text: pieces.join("\n\n"),
            })
        })
        .collect()
}

/// An embedded quiz's or flashcard set's own text from its stored content:
/// what a note gives at its reference.
pub fn item_from_content(value: &Value) -> String {
    let mut pieces = Vec::new();
    for node in top_level(value) {
        write_block(node, &NoItems, &mut pieces);
    }
    pieces.join("\n\n")
}

/// A note's whole index text: its blocks, a blank line apart.
pub fn join(blocks: &[IndexBlock]) -> String {
    blocks
        .iter()
        .map(|block| block.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn top_level(value: &Value) -> impl Iterator<Item = &Value> {
    value["value"].as_array().into_iter().flatten()
}

/// An element type's rule. A type the catalog does not list gives its text,
/// as the read-only View shows an unsupported block's text (Epo 2026-10-13:
/// such a document stays readable).
fn rule(typ: &str) -> Index {
    catalog::element(typ).map_or(Index::Text, |element| element.index)
}

fn node_rule(node: &Value) -> Index {
    rule(node["type"].as_str().unwrap_or_default())
}

fn push(out: &mut Vec<String>, text: String) {
    if !text.is_empty() {
        out.push(text);
    }
}

fn children(node: &Value) -> impl Iterator<Item = &Value> {
    node["children"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|child| child.is_object())
}

const CONTAINERS: &[&str] = &["callout", "column_group", "column", "quiz", "flashcards"];

fn write_block(node: &Value, items: &impl ItemText, out: &mut Vec<String>) {
    let typ = node["type"].as_str().unwrap_or_default();
    match node_rule(node) {
        Index::None => return,
        Index::Figure => return push(out, figure(&node["block"])),
        Index::Mermaid => {
            let mut lines = Vec::new();
            let caption = node_text(node);
            if !caption.trim().is_empty() {
                lines.push(caption.trim().to_owned());
            }
            if let Some(source) = node["source"].as_str().filter(|s| !blank(s)) {
                lines.push(format!("```mermaid\n{source}\n```"));
            }
            return push(out, lines.join("\n"));
        }
        Index::Question => return out.extend(question(&node["question"])),
        Index::Item => {
            let id = node["materialId"].as_str().unwrap_or_default();
            return push(out, items.item_text(id).unwrap_or_default());
        }
        Index::Text => {}
    }
    if CONTAINERS.contains(&typ) {
        for child in children(node) {
            write_block(child, items, out);
        }
        return;
    }
    match typ {
        "table" => {
            let rows: Vec<String> = children(node)
                .filter_map(|tr| {
                    let cells: Vec<String> = children(tr)
                        .map(|td| node_text(td).trim().to_owned())
                        .collect();
                    (!cells.is_empty()).then(|| table_row(&cells))
                })
                .collect();
            return push(out, rows.join("\n"));
        }
        // One card a block: its front, then its back.
        "flashcard" => {
            let sides: Vec<String> = children(node)
                .map(|side| node_text(side).trim().to_owned())
                .filter(|side| !side.is_empty())
                .collect();
            return push(out, sides.join("\n"));
        }
        "code_block" => {
            let lines: Vec<String> = children(node).map(node_text).collect();
            let lang = node["lang"].as_str().unwrap_or_default();
            return push(out, format!("```{lang}\n{}\n```", lines.join("\n")));
        }
        _ => {}
    }
    let text = node_text(node);
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    let bytes = typ.as_bytes();
    let text = if bytes.len() == 2 && bytes[0] == b'h' && (b'1'..=b'6').contains(&bytes[1]) {
        format!("{} {text}", "#".repeat(usize::from(bytes[1] - b'0')))
    } else if typ == "blockquote" {
        format!("> {text}")
    } else if let Some(style) = node["listStyleType"]
        .as_str()
        .filter(|style| typ == "p" && !style.is_empty())
    {
        // Go's int(n): toward zero. The store refuses an indent past
        // LIST_INDENT_MAX; the bound keeps a deeper one from the repeat.
        let indent = match node["indent"].as_f64() {
            Some(n) if n > 1.0 => n.min(crate::catalog::LIST_INDENT_MAX as f64) as usize - 1,
            _ => 0,
        };
        let prefix = match style {
            "decimal" => "1. ",
            "todo" if node["checked"].as_bool() == Some(true) => "- [x] ",
            "todo" => "- [ ] ",
            _ => "- ",
        };
        format!("{}{prefix}{text}", "  ".repeat(indent))
    } else {
        text.to_owned()
    };
    out.push(text);
}

/// A node's text, leaving out elements whose rule is none.
fn node_text(node: &Value) -> String {
    let mut out = String::new();
    fn walk(node: &Value, out: &mut String) {
        if let Some(text) = node["text"].as_str() {
            out.push_str(text);
            return;
        }
        if node_rule(node) == Index::None {
            return;
        }
        for child in children(node) {
            walk(child, out);
        }
    }
    walk(node, &mut out);
    out
}

fn table_row(cells: &[String]) -> String {
    format!("| {} |", cells.join(" | "))
}

fn blank(s: &str) -> bool {
    s.trim().is_empty()
}

/// A string field as stored; blank or missing gives "".
fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .filter(|s| !blank(s))
        .unwrap_or_default()
}

/// A number in plain decimal, the shortest that reads back exactly, never
/// with an exponent (Go's `strconv.FormatFloat(n, 'f', -1, 64)`), -0 as 0.
fn number(value: &Value) -> Option<String> {
    let n = value.as_f64()?;
    Some(format!("{}", if n == 0.0 { 0.0 } else { n }))
}

/// `[x, y]` as "(x, y)".
fn pair(value: &Value) -> Option<String> {
    match value.as_array().map(Vec::as_slice) {
        Some([x, y]) => Some(format!("({}, {})", number(x)?, number(y)?)),
        _ => None,
    }
}

fn objects(value: &Value) -> impl Iterator<Item = &Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v.is_object())
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| v.as_str().unwrap_or_default())
        .collect()
}

/// "head: tail", or whichever of the two is not empty.
fn labelled(head: &str, tail: &str) -> String {
    match (head.is_empty(), tail.is_empty()) {
        (true, _) => tail.to_owned(),
        (_, true) => head.to_owned(),
        _ => format!("{head}: {tail}"),
    }
}

/// A chart, plot or graph block, its fields on lines and empty ones left out,
/// read as it is drawn: repaired (`questions::repair_figure`, Epo
/// 2026-10-18), whether it comes from a room (already repaired by
/// `plate::block_value`) or from stored content a whole-document write left
/// as sent. Go's `figureIndexText` repairs the same way.
fn figure(block: &Value) -> String {
    let mut repaired = block.clone();
    crate::questions::repair_figure(&mut repaired);
    let block = &repaired;
    let mut lines: Vec<String> = Vec::new();
    let mut add = |prefix: &str, value: &str| {
        if !value.is_empty() {
            lines.push(format!("{prefix}{value}"));
        }
    };
    match block["type"].as_str() {
        Some("chart") => {
            add("", field(block, "title"));
            add("", field(block, "description"));
            add("x: ", field(block, "xTitle"));
            add("y: ", field(block, "yTitle"));
            let labels = strings(&block["labels"]);
            let series: Vec<&Value> = objects(&block["series"]).collect();
            if !labels.is_empty() && !series.is_empty() {
                let mut header = vec![field(block, "xTitle").to_owned()];
                let mut rule = vec!["---".to_owned()];
                for s in &series {
                    header.push(field(s, "name").to_owned());
                    rule.push("---".to_owned());
                }
                lines.push(table_row(&header));
                lines.push(table_row(&rule));
                for (i, label) in labels.iter().enumerate() {
                    let mut row = vec![(*label).to_owned()];
                    // Values past the labels are left out and missing ones
                    // are empty, as a merged chart is repaired on read.
                    for s in &series {
                        row.push(number(&s["values"][i]).unwrap_or_default());
                    }
                    lines.push(table_row(&row));
                }
            }
        }
        Some("plot") => {
            add("", field(block, "title"));
            add("", field(block, "description"));
            add("x: ", field(block, "xTitle"));
            add("y: ", field(block, "yTitle"));
            add("unit: ", field(block, "unit"));
            for s in objects(&block["series"]) {
                let points: Vec<String> = s["points"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(pair)
                    .collect();
                add("", &labelled(field(s, "name"), &points.join(", ")));
            }
            for line in objects(&block["lines"]) {
                if let Some(value) = number(&line["value"]) {
                    let axis = line["axis"].as_str().unwrap_or_default();
                    add(
                        "",
                        &labelled(&format!("{axis} = {value}"), field(line, "label")),
                    );
                }
            }
            for mark in objects(&block["marks"]) {
                if let Some(at) = pair(&Value::Array(vec![mark["x"].clone(), mark["y"].clone()])) {
                    add("", &labelled(&at, field(mark, "label")));
                }
            }
        }
        Some("graph") => {
            add("", field(block, "description"));
            let mut points: Vec<(&str, String)> = Vec::new();
            for e in objects(&block["elements"]).filter(|e| e["type"] == "point") {
                let id = e["id"].as_str().unwrap_or_default();
                if points.iter().any(|(seen, _)| *seen == id) {
                    continue;
                }
                let name = field(e, "name");
                if !name.is_empty() {
                    points.push((id, name.to_owned()));
                } else if let Some(at) = pair(&e["coords"]) {
                    points.push((id, at));
                }
            }
            for e in objects(&block["elements"]) {
                if e["hidden"].as_bool() != Some(true) {
                    add("", &graph_element(e, &points));
                }
            }
        }
        _ => {}
    }
    lines.join("\n")
}

/// One graph element as stored: its type, then its term, points (by name,
/// else coordinates), text or label. An element naming a point that is gone
/// is left out, as a merged graph is repaired on read.
fn graph_element(e: &Value, points: &[(&str, String)]) -> String {
    let refs = |ids: &[&str]| -> Option<String> {
        let names: Option<Vec<&str>> = ids
            .iter()
            .map(|id| {
                points
                    .iter()
                    .find(|(seen, _)| seen == id)
                    .map(|(_, name)| name.as_str())
            })
            .collect();
        Some(names?.join(", "))
    };
    let string = |key: &str| e[key].as_str().unwrap_or_default();
    let mut typ = string("type").to_owned();
    let body = match typ.as_str() {
        "functiongraph" => {
            let mut body = string("term").to_owned();
            if let Some([a, b]) = e["domain"].as_array().map(Vec::as_slice)
                && let (Some(a), Some(b)) = (number(a), number(b))
            {
                body.push_str(&format!(" on [{a}, {b}]"));
            }
            Some(body)
        }
        "point" => {
            let body = pair(&e["coords"]);
            let name = field(e, "name");
            if !name.is_empty() {
                typ.push(' ');
                typ.push_str(name);
            }
            body
        }
        "line" | "segment" | "polygon" => refs(&strings(&e["points"])),
        "angle" => {
            let label = field(e, "label");
            if !label.is_empty() {
                typ.push(' ');
                typ.push_str(label);
            }
            refs(&strings(&e["points"]))
        }
        "circle" => refs(&[string("center")])
            .zip(number(&e["radius"]))
            .map(|(center, radius)| format!("center {center}, radius {radius}")),
        "arc" | "sector" => refs(&[string("center")])
            .zip(refs(&strings(&e["points"])))
            .map(|(center, ends)| format!("center {center}, {ends}")),
        "text" => Some(field(e, "text").to_owned()),
        _ => None,
    };
    match body {
        Some(body) if !body.is_empty() => format!("{typ}: {body}"),
        _ => String::new(),
    }
}

/// A quiz question: its stem blocks, then each part's blocks and options
/// (mcq options; matching prompts, then choices). Worked solutions and
/// ordering items stay out, as in Go's `questionIndexPieces` (no answer
/// keys, Epo 2026-10-18).
fn question(q: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let blocks = |value: &Value, out: &mut Vec<String>| {
        for b in objects(value) {
            push(out, question_block(b));
        }
    };
    let list = |items: Vec<&str>, out: &mut Vec<String>| {
        let lines: Vec<String> = items
            .into_iter()
            .filter(|item| !blank(item))
            .map(|item| format!("- {item}"))
            .collect();
        push(out, lines.join("\n"));
    };
    blocks(&q["stem"], &mut out);
    for part in objects(&q["parts"]) {
        blocks(&part["blocks"], &mut out);
        let answer = &part["answer"];
        match answer["type"].as_str() {
            Some("mcq") => list(strings(&answer["options"]), &mut out),
            Some("matching") => {
                let lefts = objects(&answer["pairs"])
                    .map(|pair| pair["left"].as_str().unwrap_or_default())
                    .collect();
                list(lefts, &mut out);
                list(strings(&answer["options"]), &mut out);
            }
            _ => {}
        }
    }
    out
}

/// One question block: a text's label and text, a figure's rendering, a
/// table's rows or an image's description.
fn question_block(b: &Value) -> String {
    match b["type"].as_str() {
        Some("text") => {
            let (label, text) = (field(b, "label"), field(b, "text"));
            match (label.is_empty(), text.is_empty()) {
                (true, _) => text.to_owned(),
                (_, true) => label.to_owned(),
                _ => format!("{label}\n{text}"),
            }
        }
        Some("chart" | "plot" | "graph") => figure(b),
        Some("table") => b["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| {
                let cells: Vec<String> = strings(row).into_iter().map(str::to_owned).collect();
                (!cells.is_empty()).then(|| table_row(&cells))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some("image") => field(b, "description").to_owned(),
        _ => String::new(),
    }
}
