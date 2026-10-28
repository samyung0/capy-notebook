//! A Plate value to the tree of [Block]s the room stores, with the spec's
//! nesting rule and normalizations N1–N6.

use std::collections::{BTreeMap, HashSet};

use serde_json::{Map, Value, json};

use crate::schema::{self, *};
use crate::{Block, ConvertError, NOTE_ID, Prop, ROOT_ID, Run, normalize};

/// Keys every block may carry: list keys a non-list block drops (N2), the
/// indent (nesting) and `textIndent` (N5).
const BLOCK_KEYS: &[&str] = &[
    "id",
    "type",
    "children",
    "indent",
    "listStyleType",
    "checked",
    "listStart",
    "listRestart",
    "listRestartPolite",
    "textIndent",
];

/// Elements never written to the blocks layout.
fn transient(ty: &str) -> bool {
    matches!(ty, "mention_input" | "slash_input" | "placeholder")
}

/// The note's content blocks; one empty paragraph for an empty value.
pub(crate) fn content(value: &[Value]) -> Result<Vec<Block>, ConvertError> {
    let mut ids = Ids::default();
    ids.used.insert(ROOT_ID.into());
    ids.used.insert(NOTE_ID.into());
    let mut blocks = container(value, NOTE_ID, Container::Note, &mut ids)?;
    if blocks.is_empty() {
        let id = ids.block(None, NOTE_ID, 0);
        blocks.push(paragraph(id, "text", Vec::new()));
    }
    Ok(blocks)
}

/// Block ids: a Plate id is kept when it is a non-empty string not used
/// before; otherwise the block gets `<parent id>-b<index>`.
#[derive(Default)]
struct Ids {
    used: HashSet<String>,
}

impl Ids {
    fn block(&mut self, id: Option<&Value>, parent: &str, index: usize) -> String {
        if let Some(Value::String(id)) = id
            && !id.is_empty()
            && self.used.insert(id.clone())
        {
            return id.clone();
        }
        unique(&mut self.used, format!("{parent}-b{index}"))
    }
}

fn unique(used: &mut HashSet<String>, base: String) -> String {
    let mut candidate = base.clone();
    let mut n = 1;
    while !used.insert(candidate.clone()) {
        n += 1;
        candidate = format!("{base}-{n}");
    }
    candidate
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Container {
    Note,
    Callout,
    Column,
}

fn shape(ty: &str, reason: &str) -> ConvertError {
    ConvertError::Shape {
        ty: ty.into(),
        reason: reason.into(),
    }
}

fn object<'a>(node: &'a Value, ty: &str) -> Result<&'a Map<String, Value>, ConvertError> {
    node.as_object().ok_or_else(|| shape(ty, "not an object"))
}

fn is_leaf(node: &Map<String, Value>) -> bool {
    node.contains_key("text") && !node.contains_key("type")
}

fn type_of(node: &Map<String, Value>) -> Result<&str, ConvertError> {
    node.get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| shape("node", "no type"))
}

fn children(node: &Map<String, Value>) -> &[Value] {
    node.get("children")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// Refuses keys outside `BLOCK_KEYS` and `extra`.
fn keys(node: &Map<String, Value>, ty: &str, extra: &[&str]) -> Result<(), ConvertError> {
    keys_in(node, ty, BLOCK_KEYS, extra)
}

fn keys_in(
    node: &Map<String, Value>,
    ty: &str,
    base: &[&str],
    extra: &[&str],
) -> Result<(), ConvertError> {
    match node
        .keys()
        .find(|k| !base.contains(&k.as_str()) && !extra.contains(&k.as_str()))
    {
        Some(key) => Err(ConvertError::Key {
            ty: ty.into(),
            key: key.clone(),
        }),
        None => Ok(()),
    }
}

/// A flat Plate block list (a container's children) as nested blocks: a
/// list's target depth is `indent - 1`, any other block's `indent`, clamped
/// to one below the deepest open paragraph or list (N1).
fn container(
    nodes: &[Value],
    parent: &str,
    kind: Container,
    ids: &mut Ids,
) -> Result<Vec<Block>, ConvertError> {
    let mut out = Vec::new();
    // stack[d] is the open paragraph or list at depth d.
    let mut stack: Vec<Block> = Vec::new();
    fn attach(stack: &mut [Block], out: &mut Vec<Block>, block: Block) {
        match stack.last_mut() {
            Some(top) => top.children.push(block),
            None => out.push(block),
        }
    }
    for (index, node) in nodes.iter().enumerate() {
        let element = object(node, "node")?;
        if is_leaf(element) {
            // The placeholder leaf of an empty value or element.
            if element.get("text").and_then(Value::as_str) == Some("") {
                continue;
            }
            return Err(shape("text", "a text leaf among blocks"));
        }
        let ty = type_of(element)?;
        if transient(ty) {
            continue;
        }
        let (block, target) = block(element, ty, parent, index, ids)?;
        let note_only = schema::flavour(&block.flavour).is_some_and(|f| f.parents == [NOTE]);
        if kind != Container::Note && note_only {
            return Err(shape(ty, "only at the top level"));
        }
        if kind == Container::Callout && !holds_indented(&block.flavour) {
            return Err(shape(ty, "not a text block in a callout"));
        }
        let depth = if note_only {
            0
        } else {
            target.min(stack.len())
        };
        while stack.len() > depth {
            if let Some(done) = stack.pop() {
                attach(&mut stack, &mut out, done);
            }
        }
        if holds_indented(&block.flavour) {
            stack.push(block);
        } else {
            attach(&mut stack, &mut out, block);
        }
    }
    while let Some(done) = stack.pop() {
        attach(&mut stack, &mut out, done);
    }
    Ok(out)
}

fn indent(node: &Map<String, Value>) -> usize {
    node.get("indent").and_then(Value::as_u64).unwrap_or(0) as usize
}

/// A block with its flavour's defaults and empty texts.
fn new_block(id: String, flavour: &str) -> Block {
    let mut block = Block {
        id,
        flavour: flavour.into(),
        props: Vec::new(),
        children: Vec::new(),
    };
    for (key, value) in schema::defaults(flavour) {
        block.set(key, Prop::Native(value));
    }
    for key in schema::text_props(flavour) {
        if block.prop(key).is_none() {
            block.set(key, Prop::Text(Vec::new()));
        }
    }
    block
}

fn paragraph(id: String, ty: &str, text: Vec<Run>) -> Block {
    let mut block = new_block(id, PARAGRAPH);
    block.set("type", Prop::Native(json!(ty)));
    block.set("text", Prop::Text(text));
    block
}

/// Copies `key` into prop `to` when present.
fn copy(block: &mut Block, node: &Map<String, Value>, key: &str, to: &str) {
    if let Some(value) = node.get(key) {
        block.set(to, Prop::Native(normalize(value)));
    }
}

fn text_align(node: &Map<String, Value>, ty: &str) -> Result<Option<&'static str>, ConvertError> {
    Ok(match node.get("align") {
        None => None,
        Some(align) => Some(match align.as_str() {
            Some("left" | "start") => "left",
            Some("center") => "center",
            Some("right" | "end") => "right",
            Some("justify") => "justify",
            _ => return Err(shape(ty, "unsupported align")),
        }),
    })
}

/// `listStyleType` → list `type`.
fn list_type(style: &str) -> &'static str {
    match style {
        "disc" => "bulleted",
        "decimal" => "numbered",
        "todo" => "todo",
        s if s.ends_with("-alpha") || s.ends_with("-roman") || s.starts_with("decimal-") => {
            "numbered"
        }
        _ => "bulleted",
    }
}

/// One block and its target depth.
fn block(
    node: &Map<String, Value>,
    ty: &str,
    parent: &str,
    index: usize,
    ids: &mut Ids,
) -> Result<(Block, usize), ConvertError> {
    let id = ids.block(node.get("id"), parent, index);
    let depth = indent(node);
    let block = match ty {
        "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            keys(node, ty, &["align"])?;
            let text = inline(children(node))?;
            let style = node.get("listStyleType").and_then(Value::as_str);
            let mut block = match style {
                // N2: only a paragraph is a list item.
                Some(style) if ty == "p" => {
                    let list = list_type(style);
                    let mut block = new_block(id, LIST);
                    block.set("type", Prop::Native(json!(list)));
                    block.set("text", Prop::Text(text));
                    if list == "todo" {
                        let checked = node.get("checked").and_then(Value::as_bool);
                        block.set("checked", Prop::Native(json!(checked.unwrap_or(false))));
                    }
                    let order = ["listRestart", "listRestartPolite", "listStart"]
                        .iter()
                        .find_map(|k| node.get(*k).filter(|v| v.is_number()));
                    if let Some(order) = order {
                        block.set("order", Prop::Native(normalize(order)));
                    }
                    block.set("listStyleType", Prop::Native(json!(style)));
                    let align = text_align(node, ty)?;
                    if let Some(align) = align {
                        block.set("textAlign", Prop::Native(json!(align)));
                    }
                    return Ok((block, depth.saturating_sub(1)));
                }
                _ => paragraph(id, if ty == "p" { "text" } else { ty }, text),
            };
            if let Some(align) = text_align(node, ty)? {
                block.set("textAlign", Prop::Native(json!(align)));
            }
            block
        }
        "blockquote" => {
            keys(node, ty, &["align"])?;
            // N3: one quote paragraph, its paragraphs joined with "\n".
            let mut parts = Vec::new();
            quote_parts(children(node), &mut parts)?;
            let mut block = paragraph(id, "quote", join(parts));
            if let Some(align) = text_align(node, ty)? {
                block.set("textAlign", Prop::Native(json!(align)));
            }
            block
        }
        "code_block" => {
            keys(node, ty, &["lang"])?;
            let mut lines = Vec::new();
            for line in children(node) {
                let line = object(line, "code_line")?;
                if type_of(line)? != "code_line" {
                    return Err(shape(ty, "a child that is not a code_line"));
                }
                keys_in(line, "code_line", &["id", "type", "children"], &[])?;
                lines.push(inline(children(line))?);
            }
            let mut block = new_block(id, CODE);
            block.set("text", Prop::Text(join(lines)));
            copy(&mut block, node, "lang", "language");
            block
        }
        "hr" => {
            keys(node, ty, &[])?;
            new_block(id, DIVIDER)
        }
        "toc" => {
            keys(node, ty, &[])?;
            new_block(id, TOC)
        }
        "callout" => {
            keys(node, ty, &["variant"])?;
            let mut block = new_block(id, CALLOUT);
            copy(&mut block, node, "variant", "variant");
            block.children = container(children(node), &block.id, Container::Callout, ids)?;
            block
        }
        "equation" => {
            keys(node, ty, &["texExpression"])?;
            let mut block = new_block(id, LATEX);
            copy(&mut block, node, "texExpression", "latex");
            block
        }
        "img" => {
            keys(
                node,
                ty,
                &[
                    "assetId",
                    "sizeBytes",
                    "caption",
                    "align",
                    "width",
                    "name",
                    "contentType",
                ],
            )?;
            let mut block = new_block(id, IMAGE);
            copy(&mut block, node, "assetId", "sourceId");
            copy(&mut block, node, "sizeBytes", "size");
            caption(&mut block, node)?;
            if let Some(align) = text_align(node, ty)? {
                block.set("textAlign", Prop::Native(json!(align)));
            }
            copy(&mut block, node, "width", "widthPercent");
            copy(&mut block, node, "name", "name");
            copy(&mut block, node, "contentType", "contentType");
            block
        }
        "audio" => {
            keys(
                node,
                ty,
                &["assetId", "name", "contentType", "sizeBytes", "caption"],
            )?;
            let mut block = new_block(id, AUDIO);
            for key in ["assetId", "name", "contentType", "sizeBytes"] {
                copy(&mut block, node, key, key);
            }
            caption(&mut block, node)?;
            block
        }
        "video" => {
            keys(node, ty, &["provider", "videoId", "width", "caption"])?;
            let mut block = new_block(id, VIDEO);
            for key in ["provider", "videoId", "width"] {
                copy(&mut block, node, key, key);
            }
            caption(&mut block, node)?;
            block
        }
        "chart" | "plot" | "graph" => {
            keys(node, ty, &["block", "width"])?;
            let flavour = match ty {
                "chart" => CHART,
                "plot" => PLOT,
                _ => GRAPH,
            };
            let mut block = new_block(id, flavour);
            if !node.get("block").is_some_and(Value::is_object) {
                return Err(shape(ty, "block must be an object"));
            }
            copy(&mut block, node, "block", "block");
            copy(&mut block, node, "width", "width");
            block
        }
        "html_embed" => {
            keys(node, ty, &["html", "caption"])?;
            let mut block = new_block(id, HTML);
            copy(&mut block, node, "html", "html");
            copy(&mut block, node, "caption", "caption");
            block
        }
        "mermaid" => {
            keys(node, ty, &["source", "theme", "width"])?;
            let mut block = new_block(id, MERMAID);
            let source = node.get("source").and_then(Value::as_str).unwrap_or("");
            block.set("source", Prop::Text(plain_runs(source)));
            let mut caption = Vec::new();
            for child in children(node) {
                let child = object(child, "mermaid_caption")?;
                if is_leaf(child) && child.get("text").and_then(Value::as_str) == Some("") {
                    continue;
                }
                if type_of(child)? != "mermaid_caption" {
                    return Err(shape(ty, "a child that is not a mermaid_caption"));
                }
                keys_in(child, "mermaid_caption", &["id", "type", "children"], &[])?;
                caption = inline(children(child))?;
            }
            block.set("caption", Prop::Text(caption));
            copy(&mut block, node, "width", "width");
            copy(&mut block, node, "theme", "theme");
            block
        }
        "material_ref" => {
            keys(node, ty, &["materialId", "refKind", "pending"])?;
            // An imported fence body no stored document holds (the Plate
            // room refuses to load one too); null is absent.
            if node.get("pending").is_some_and(|p| !p.is_null()) {
                return Err(shape(ty, "holds a pending import"));
            }
            let mut block = new_block(id, MATERIAL_REF);
            copy(&mut block, node, "materialId", "materialId");
            copy(&mut block, node, "refKind", "refKind");
            block
        }
        "column_group" => {
            keys(node, ty, &[])?;
            let mut block = new_block(id, COLUMNS);
            for (index, column) in children(node).iter().enumerate() {
                let column = object(column, "column")?;
                if type_of(column)? != "column" {
                    return Err(shape(ty, "a child that is not a column"));
                }
                keys_in(column, "column", &["id", "type", "children", "width"], &[])?;
                let column_id = ids.block(column.get("id"), &block.id, index);
                let mut inner = new_block(column_id, COLUMN);
                copy(&mut inner, column, "width", "width");
                inner.children = container(children(column), &inner.id, Container::Column, ids)?;
                block.children.push(inner);
            }
            block
        }
        "table" => table(node, id)?,
        other => return Err(ConvertError::Type(other.into())),
    };
    Ok((block, depth))
}

/// The paragraphs of a blockquote, nested quotes included, in order.
fn quote_parts(nodes: &[Value], parts: &mut Vec<Vec<Run>>) -> Result<(), ConvertError> {
    for node in nodes {
        let node = object(node, "blockquote")?;
        if is_leaf(node) {
            // A quote whose children are its text directly.
            parts.push(inline(std::slice::from_ref(&Value::Object(node.clone())))?);
            continue;
        }
        match type_of(node)? {
            "blockquote" => {
                keys(node, "blockquote", &["align"])?;
                quote_parts(children(node), parts)?;
            }
            ty @ ("p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => {
                keys(node, ty, &["align"])?;
                parts.push(inline(children(node))?);
            }
            "a" | "mention" | "inline_equation" => {
                parts.push(inline(std::slice::from_ref(&Value::Object(node.clone())))?);
            }
            other => return Err(shape("blockquote", &format!("holds a {other}"))),
        }
    }
    Ok(())
}

/// The plain text of a media caption (`[{text}]`, a paragraph list or a
/// string): leaves concatenated, paragraphs joined with "\n".
fn caption(block: &mut Block, node: &Map<String, Value>) -> Result<(), ConvertError> {
    fn text(node: &Value) -> String {
        match node {
            Value::String(s) => s.clone(),
            Value::Array(nodes) => nodes.iter().map(text).collect(),
            Value::Object(o) => match o.get("text") {
                Some(Value::String(s)) if !o.contains_key("type") => s.clone(),
                _ => o.get("children").map(text).unwrap_or_default(),
            },
            _ => String::new(),
        }
    }
    let plain = match node.get("caption") {
        None | Some(Value::Null) => return Ok(()),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(nodes)) => {
            if nodes.iter().all(|n| n.get("type").is_none()) {
                text(&Value::Array(nodes.clone()))
            } else {
                nodes.iter().map(text).collect::<Vec<_>>().join("\n")
            }
        }
        Some(_) => return Err(shape("caption", "not text")),
    };
    block.set("caption", Prop::Native(json!(plain)));
    Ok(())
}

fn plain_runs(text: &str) -> Vec<Run> {
    if text.is_empty() {
        return Vec::new();
    }
    vec![Run {
        text: text.into(),
        attrs: BTreeMap::new(),
    }]
}

/// Texts joined with "\n" (N3, N6, code lines).
fn join(parts: Vec<Vec<Run>>) -> Vec<Run> {
    let mut runs = Vec::new();
    for (i, part) in parts.into_iter().enumerate() {
        if i > 0 {
            runs.push(Run {
                text: "\n".into(),
                attrs: BTreeMap::new(),
            });
        }
        runs.extend(part);
    }
    merge(runs)
}

/// Adjacent runs with equal attributes as one, as Y.Text gives them back.
pub(crate) fn merge(runs: Vec<Run>) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::with_capacity(runs.len());
    for run in runs {
        if run.text.is_empty() {
            continue;
        }
        match out.last_mut() {
            Some(last) if last.attrs == run.attrs => last.text.push_str(&run.text),
            _ => out.push(run),
        }
    }
    out
}

/// A text block's children (leaves and inline elements) as Y.Text runs.
fn inline(nodes: &[Value]) -> Result<Vec<Run>, ConvertError> {
    let mut runs = Vec::new();
    for node in nodes {
        let node = object(node, "inline")?;
        if is_leaf(node) {
            runs.push(leaf(node, BTreeMap::new())?);
            continue;
        }
        let ty = type_of(node)?;
        match ty {
            "a" => {
                keys_in(node, ty, &["id", "type", "children", "url", "target"], &[])?;
                let url = node.get("url").cloned().unwrap_or(Value::Null);
                for child in children(node) {
                    let child = object(child, "a")?;
                    if !is_leaf(child) {
                        return Err(shape(ty, "holds an element"));
                    }
                    let mut attrs = BTreeMap::new();
                    attrs.insert("link".to_string(), url.clone());
                    runs.push(leaf(child, attrs)?);
                }
            }
            "inline_equation" => {
                keys_in(node, ty, &["id", "type", "children", "texExpression"], &[])?;
                let tex = node.get("texExpression").cloned().unwrap_or(json!(""));
                runs.push(embed("latex", tex));
            }
            "mention" => {
                keys_in(node, ty, &["id", "type", "children", "key", "value"], &[])?;
                let mut mention = Map::new();
                if let Some(key) = node.get("key") {
                    mention.insert("member".into(), key.clone());
                }
                if let Some(value) = node.get("value") {
                    mention.insert("name".into(), value.clone());
                }
                runs.push(embed("mention", Value::Object(mention)));
            }
            ty if transient(ty) => {}
            other => return Err(ConvertError::Type(other.into())),
        }
    }
    Ok(merge(runs))
}

fn embed(attribute: &str, value: Value) -> Run {
    let mut attrs = BTreeMap::new();
    attrs.insert(attribute.to_string(), normalize(&value));
    Run {
        text: " ".into(),
        attrs,
    }
}

fn leaf(
    node: &Map<String, Value>,
    mut attrs: BTreeMap<String, Value>,
) -> Result<Run, ConvertError> {
    let text = node.get("text").and_then(Value::as_str).unwrap_or("");
    for (key, value) in node {
        if key == "text" || schema::dropped_mark(key) {
            continue;
        }
        let attribute = attribute_of_mark(key).ok_or_else(|| ConvertError::Mark(key.clone()))?;
        attrs.insert(attribute.into(), normalize(value));
    }
    Ok(Run {
        text: text.into(),
        attrs,
    })
}

/// Fractional index keys in order (`a0`…`az`, `b00`…), as
/// `generateKeyBetween` gives them appending.
pub(crate) fn order_key(mut index: usize) -> String {
    const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut len = 1u32;
    let mut head = b'a';
    while index >= 62usize.pow(len) {
        index -= 62usize.pow(len);
        len += 1;
        head += 1;
    }
    let mut digits = vec![b'0'; len as usize];
    for slot in digits.iter_mut().rev() {
        *slot = DIGITS[index % 62];
        index /= 62;
    }
    let mut key = String::from(head as char);
    key.push_str(&String::from_utf8_lossy(&digits));
    key
}

/// A table as flat data: rows and columns with fractional orders, one text
/// per cell (N4, N6). Row and column ids hold no "." (BlockSuite splits flat
/// keys on it).
fn table(node: &Map<String, Value>, id: String) -> Result<Block, ConvertError> {
    keys_in(node, "table", BLOCK_KEYS, &["colSizes", "marginLeft"])?;
    struct Cell {
        text: Vec<Run>,
        header: bool,
    }
    let prefix = id.replace('.', "_");
    let mut row_ids = Vec::new();
    let mut used = HashSet::new();
    // grid[r][c]: the cell placed there; a merged cell's other positions are
    // `Some(None)`.
    let mut grid: Vec<Vec<Option<Option<Cell>>>> = Vec::new();
    let rows = children(node);
    for (r, row) in rows.iter().enumerate() {
        let row = object(row, "tr")?;
        if type_of(row)? != "tr" {
            return Err(shape("table", "a child that is not a tr"));
        }
        keys_in(row, "tr", &["id", "type", "children", "size"], &[])?;
        let row_id = match row.get("id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() && !id.contains('.') && used.insert(id.to_string()) => {
                id.to_string()
            }
            _ => unique(&mut used, format!("{prefix}-r{r}")),
        };
        row_ids.push(row_id);
        if grid.len() <= r {
            grid.resize_with(r + 1, Vec::new);
        }
        let mut c = 0;
        for cell in children(row) {
            let cell = object(cell, "td")?;
            let ty = type_of(cell)?;
            if ty != "td" && ty != "th" {
                return Err(shape("tr", "a child that is not a cell"));
            }
            keys_in(
                cell,
                ty,
                &[
                    "id",
                    "type",
                    "children",
                    "colSpan",
                    "rowSpan",
                    "attributes",
                    "background",
                    "borders",
                    "size",
                ],
                &[],
            )?;
            while grid[r].get(c).is_some_and(Option::is_some) {
                c += 1;
            }
            let span = |key: &str| {
                cell.get(key)
                    .and_then(Value::as_u64)
                    .map_or(1, |n| n.max(1) as usize)
            };
            let (col_span, row_span) = (span("colSpan"), span("rowSpan"));
            let mut parts = Vec::new();
            for paragraph in children(cell) {
                let paragraph = object(paragraph, ty)?;
                let pty = type_of(paragraph)?;
                if !matches!(pty, "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
                    return Err(shape(ty, &format!("holds a {pty}")));
                }
                keys_in(paragraph, pty, &["id", "type", "children"], &[])?;
                parts.push(inline(children(paragraph))?);
            }
            // N4: a merged cell is split; its other positions are empty.
            for dr in 0..row_span {
                let rr = r + dr;
                if rr >= rows.len() {
                    break;
                }
                if grid.len() <= rr {
                    grid.resize_with(rr + 1, Vec::new);
                }
                for dc in 0..col_span {
                    let cc = c + dc;
                    if grid[rr].len() <= cc {
                        grid[rr].resize_with(cc + 1, || None);
                    }
                    grid[rr][cc] = Some(None);
                }
            }
            grid[r][c] = Some(Some(Cell {
                text: join(std::mem::take(&mut parts)),
                header: ty == "th",
            }));
            c += col_span;
        }
    }
    let columns = grid.iter().map(Vec::len).max().unwrap_or(0);
    let column_ids: Vec<String> = (0..columns).map(|i| format!("{prefix}-c{i}")).collect();
    let sizes = node.get("colSizes").and_then(Value::as_array);

    let mut block = new_block(id, TABLE);
    for (r, row_id) in row_ids.iter().enumerate() {
        let placed: Vec<&Cell> = grid[r].iter().flatten().flatten().collect();
        let header = !placed.is_empty() && placed.iter().all(|cell| cell.header);
        block.set(&format!("rows.{row_id}.rowId"), Prop::Native(json!(row_id)));
        block.set(
            &format!("rows.{row_id}.order"),
            Prop::Native(json!(order_key(r))),
        );
        if header {
            block.set(&format!("rows.{row_id}.header"), Prop::Native(json!(true)));
        }
    }
    for (c, column_id) in column_ids.iter().enumerate() {
        block.set(
            &format!("columns.{column_id}.columnId"),
            Prop::Native(json!(column_id)),
        );
        block.set(
            &format!("columns.{column_id}.order"),
            Prop::Native(json!(order_key(c))),
        );
        if let Some(width) = sizes.and_then(|s| s.get(c)).filter(|w| w.is_number()) {
            block.set(
                &format!("columns.{column_id}.width"),
                Prop::Native(normalize(width)),
            );
        }
    }
    for (r, row_id) in row_ids.iter().enumerate() {
        for (c, column_id) in column_ids.iter().enumerate() {
            let text = match grid[r].get_mut(c) {
                Some(Some(Some(cell))) => std::mem::take(&mut cell.text),
                _ => Vec::new(),
            };
            block.set(
                &format!("cells.{row_id}:{column_id}.text"),
                Prop::Text(text),
            );
        }
    }
    Ok(block)
}
