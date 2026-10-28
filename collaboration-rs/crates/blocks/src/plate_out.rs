//! The tree of [Block]s back to a Plate value: the note's subtree walked depth
//! first with the indent rule, and the derived ids of elements that have no
//! block of their own.

use serde_json::{Map, Value, json};

use crate::schema::{self, *};
use crate::{Block, ProjectionError, Run};

pub(crate) fn value(content: &[Block]) -> Result<Vec<Value>, ProjectionError> {
    let mut out = Vec::new();
    flatten(content, 0, &mut out)?;
    if out.is_empty() {
        // An empty note, as the Plate projection gives it.
        out.push(json!({"text": ""}));
    }
    Ok(out)
}

/// A container's children (the note, a callout, a column), with each
/// paragraph's and list's subtree emitted after it at one more depth.
fn flatten(blocks: &[Block], depth: usize, out: &mut Vec<Value>) -> Result<(), ProjectionError> {
    for block in blocks {
        out.push(element(block, depth)?);
        if schema::holds_indented(&block.flavour) {
            flatten(&block.children, depth + 1, out)?;
        } else if !block.children.is_empty() && !matches!(block.flavour.as_str(), CALLOUT | COLUMNS)
        {
            return Err(ProjectionError::Block(block.id.clone()));
        }
    }
    Ok(())
}

fn bad(block: &Block, key: &str) -> ProjectionError {
    ProjectionError::Prop {
        id: block.id.clone(),
        key: key.into(),
    }
}

fn empty_leaf() -> Value {
    json!([{"text": ""}])
}

/// `{id, type, ...}`; the caller adds the rest and `children`.
fn start(block: &Block, ty: &str) -> Map<String, Value> {
    let mut node = Map::new();
    node.insert("id".into(), json!(block.id));
    node.insert("type".into(), json!(ty));
    node
}

/// Copies prop `key` to `to` when present.
fn copy(node: &mut Map<String, Value>, block: &Block, key: &str, to: &str) {
    if let Some(value) = block.native(key) {
        node.insert(to.into(), value.clone());
    }
}

fn indent(node: &mut Map<String, Value>, indent: usize) {
    if indent > 0 {
        node.insert("indent".into(), json!(indent));
    }
}

fn align(node: &mut Map<String, Value>, block: &Block) {
    if let Some(align) = block.str("textAlign") {
        node.insert("align".into(), json!(align));
    }
}

/// A media caption: the Plate caption holding the plain text.
fn caption(node: &mut Map<String, Value>, block: &Block) {
    if let Some(caption) = block.str("caption").filter(|c| !c.is_empty()) {
        node.insert("caption".into(), json!([{ "text": caption }]));
    }
}

fn text<'a>(block: &'a Block, key: &str) -> Result<&'a [Run], ProjectionError> {
    block.text(key).ok_or_else(|| bad(block, key))
}

fn element(block: &Block, depth: usize) -> Result<Value, ProjectionError> {
    let mut node;
    let children: Value = match block.flavour.as_str() {
        PARAGRAPH => {
            let ty = block.str("type").ok_or_else(|| bad(block, "type"))?;
            let runs = text(block, "text")?;
            match ty {
                "text" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                    node = start(block, if ty == "text" { "p" } else { ty });
                    align(&mut node, block);
                    indent(&mut node, depth);
                    Inline::new(&block.id).nodes(runs)?
                }
                "quote" => {
                    node = start(block, "blockquote");
                    align(&mut node, block);
                    indent(&mut node, depth);
                    json!([{
                        "id": format!("{}.p", block.id),
                        "type": "p",
                        "children": Inline::new(&block.id).nodes(runs)?,
                    }])
                }
                _ => return Err(bad(block, "type")),
            }
        }
        LIST => {
            let ty = block.str("type").ok_or_else(|| bad(block, "type"))?;
            let style = match block.str("listStyleType") {
                Some(style) => style,
                None => match ty {
                    "bulleted" => "disc",
                    "numbered" => "decimal",
                    "todo" => "todo",
                    _ => return Err(bad(block, "type")),
                },
            };
            node = start(block, "p");
            node.insert("listStyleType".into(), json!(style));
            indent(&mut node, depth + 1);
            if ty == "todo" {
                let checked = block.native("checked").and_then(Value::as_bool);
                node.insert("checked".into(), json!(checked.unwrap_or(false)));
            }
            if let Some(order) = block.native("order").filter(|o| o.is_number()) {
                node.insert("listStart".into(), order.clone());
            }
            align(&mut node, block);
            Inline::new(&block.id).nodes(text(block, "text")?)?
        }
        CODE => {
            node = start(block, "code_block");
            if let Some(lang) = block.str("language") {
                node.insert("lang".into(), json!(lang));
            }
            indent(&mut node, depth);
            let mut inline = Inline::new(&block.id);
            let lines = lines(text(block, "text")?)
                .into_iter()
                .enumerate()
                .map(|(n, line)| {
                    Ok(json!({
                        "id": format!("{}.l{n}", block.id),
                        "type": "code_line",
                        "children": inline.nodes(&line)?,
                    }))
                })
                .collect::<Result<Vec<_>, ProjectionError>>()?;
            Value::Array(lines)
        }
        DIVIDER => {
            node = start(block, "hr");
            indent(&mut node, depth);
            empty_leaf()
        }
        TOC => {
            node = start(block, "toc");
            indent(&mut node, depth);
            empty_leaf()
        }
        CALLOUT => {
            node = start(block, "callout");
            copy(&mut node, block, "variant", "variant");
            indent(&mut node, depth);
            Value::Array(value(&block.children)?)
        }
        LATEX => {
            node = start(block, "equation");
            copy(&mut node, block, "latex", "texExpression");
            indent(&mut node, depth);
            empty_leaf()
        }
        IMAGE => {
            node = start(block, "img");
            copy(&mut node, block, "sourceId", "assetId");
            copy(&mut node, block, "name", "name");
            copy(&mut node, block, "contentType", "contentType");
            if let Some(size) = block.native("size").filter(|s| s.as_f64() >= Some(0.0)) {
                node.insert("sizeBytes".into(), size.clone());
            }
            if let Some(width) = block.native("width") {
                let px = width.as_f64().ok_or_else(|| bad(block, "width"))?;
                if px != 0.0 {
                    node.insert("width".into(), json!(schema::px_to_percent(px)));
                }
            }
            align(&mut node, block);
            caption(&mut node, block);
            indent(&mut node, depth);
            empty_leaf()
        }
        AUDIO => {
            node = start(block, "audio");
            for key in ["assetId", "name", "contentType", "sizeBytes"] {
                copy(&mut node, block, key, key);
            }
            caption(&mut node, block);
            indent(&mut node, depth);
            empty_leaf()
        }
        VIDEO => {
            node = start(block, "video");
            for key in ["provider", "videoId", "width"] {
                copy(&mut node, block, key, key);
            }
            caption(&mut node, block);
            indent(&mut node, depth);
            empty_leaf()
        }
        CHART | PLOT | GRAPH => {
            node = start(block, block.flavour.trim_start_matches("capy:"));
            copy(&mut node, block, "block", "block");
            copy(&mut node, block, "width", "width");
            empty_leaf()
        }
        HTML => {
            node = start(block, "html_embed");
            copy(&mut node, block, "html", "html");
            copy(&mut node, block, "caption", "caption");
            empty_leaf()
        }
        MERMAID => {
            node = start(block, "mermaid");
            let source: String = text(block, "source")?
                .iter()
                .map(|r| r.text.as_str())
                .collect();
            node.insert("source".into(), json!(source));
            copy(&mut node, block, "theme", "theme");
            copy(&mut node, block, "width", "width");
            indent(&mut node, depth);
            json!([{
                "id": format!("{}.p", block.id),
                "type": "mermaid_caption",
                "children": Inline::new(&block.id).nodes(text(block, "caption")?)?,
            }])
        }
        MATERIAL_REF => {
            node = start(block, "material_ref");
            copy(&mut node, block, "materialId", "materialId");
            copy(&mut node, block, "refKind", "refKind");
            empty_leaf()
        }
        COLUMNS => {
            node = start(block, "column_group");
            let mut columns = Vec::new();
            for column in &block.children {
                if column.flavour != COLUMN {
                    return Err(ProjectionError::Block(column.id.clone()));
                }
                let mut inner = start(column, "column");
                copy(&mut inner, column, "width", "width");
                inner.insert("children".into(), Value::Array(value(&column.children)?));
                columns.push(Value::Object(inner));
            }
            if columns.is_empty() {
                empty_leaf()
            } else {
                Value::Array(columns)
            }
        }
        TABLE => {
            node = start(block, "table");
            table(&mut node, block)?
        }
        other => return Err(ProjectionError::Flavour(other.into())),
    };
    node.insert("children".into(), children);
    Ok(Value::Object(node))
}

/// A text split at its "\n"s (code lines).
fn lines(runs: &[Run]) -> Vec<Vec<Run>> {
    let mut lines = vec![Vec::new()];
    for run in runs {
        for (i, part) in run.text.split('\n').enumerate() {
            if i > 0 {
                lines.push(Vec::new());
            }
            if !part.is_empty()
                && let Some(line) = lines.last_mut()
            {
                line.push(Run {
                    text: part.into(),
                    attrs: run.attrs.clone(),
                });
            }
        }
    }
    lines
}

/// A table's rows by order: `tr` ids are the row ids, cells `td` (`th` in a
/// header row) with derived ids, one paragraph each.
fn table(node: &mut Map<String, Value>, block: &Block) -> Result<Value, ProjectionError> {
    // (order, id, header)
    let mut rows: Vec<(String, String, bool)> = Vec::new();
    // (order, id, width)
    let mut columns: Vec<(String, String, Option<Value>)> = Vec::new();
    for (key, _) in &block.props {
        let parts: Vec<&str> = key.split('.').collect();
        match parts.as_slice() {
            ["rows", id, "rowId"] => {
                let order = block
                    .str(&format!("rows.{id}.order"))
                    .ok_or_else(|| bad(block, key))?;
                let header = block
                    .native(&format!("rows.{id}.header"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                rows.push((order.into(), (*id).into(), header));
            }
            ["columns", id, "columnId"] => {
                let order = block
                    .str(&format!("columns.{id}.order"))
                    .ok_or_else(|| bad(block, key))?;
                let width = block.native(&format!("columns.{id}.width")).cloned();
                columns.push((order.into(), (*id).into(), width));
            }
            _ => {}
        }
    }
    rows.sort();
    columns.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    if columns.iter().any(|(_, _, width)| width.is_some()) {
        let sizes = columns
            .iter()
            .map(|(_, _, width)| width.clone().unwrap_or(Value::Null))
            .collect();
        node.insert("colSizes".into(), Value::Array(sizes));
    }
    let mut trs = Vec::new();
    for (_, row_id, header) in &rows {
        let mut cells = Vec::new();
        for (_, column_id, _) in &columns {
            let cell_id = format!("{row_id}:{column_id}");
            let runs = block
                .text(&format!("cells.{cell_id}.text"))
                .unwrap_or_default();
            cells.push(json!({
                "id": cell_id,
                "type": if *header { "th" } else { "td" },
                "children": [{
                    "id": format!("{cell_id}.p"),
                    "type": "p",
                    "children": Inline::new(&cell_id).nodes(runs)?,
                }],
            }));
        }
        let cells = if cells.is_empty() {
            empty_leaf()
        } else {
            Value::Array(cells)
        };
        trs.push(json!({"id": row_id, "type": "tr", "children": cells}));
    }
    Ok(if trs.is_empty() {
        empty_leaf()
    } else {
        Value::Array(trs)
    })
}

/// Y.Text runs back to Plate leaves and inline elements, numbering the inline
/// elements `<owner>.i<n>`.
struct Inline<'a> {
    owner: &'a str,
    n: usize,
}

impl<'a> Inline<'a> {
    fn new(owner: &'a str) -> Self {
        Self { owner, n: 0 }
    }

    fn next_id(&mut self) -> String {
        let id = format!("{}.i{}", self.owner, self.n);
        self.n += 1;
        id
    }

    fn nodes(&mut self, runs: &[Run]) -> Result<Value, ProjectionError> {
        let mut nodes: Vec<Value> = Vec::new();
        let mut i = 0;
        while i < runs.len() {
            let run = &runs[i];
            if let Some(latex) = run.attrs.get("latex") {
                for _ in run.text.encode_utf16() {
                    nodes.push(json!({
                        "id": self.next_id(),
                        "type": "inline_equation",
                        "texExpression": latex,
                        "children": [{"text": ""}],
                    }));
                }
                i += 1;
            } else if let Some(mention) = run.attrs.get("mention") {
                for _ in run.text.encode_utf16() {
                    let mut node = Map::new();
                    node.insert("id".into(), json!(self.next_id()));
                    node.insert("type".into(), json!("mention"));
                    if let Some(member) = mention.get("member") {
                        node.insert("key".into(), member.clone());
                    }
                    if let Some(name) = mention.get("name") {
                        node.insert("value".into(), name.clone());
                    }
                    node.insert("children".into(), json!([{"text": ""}]));
                    nodes.push(Value::Object(node));
                }
                i += 1;
            } else if let Some(url) = run.attrs.get("link") {
                let mut leaves = Vec::new();
                while let Some(next) = runs.get(i)
                    && next.attrs.get("link") == Some(url)
                    && !next.attrs.contains_key("latex")
                    && !next.attrs.contains_key("mention")
                {
                    leaves.push(leaf(next)?);
                    i += 1;
                }
                nodes.push(json!({
                    "id": self.next_id(),
                    "type": "a",
                    "url": url,
                    "children": leaves,
                }));
            } else {
                nodes.push(leaf(run)?);
                i += 1;
            }
        }
        // Slate's normalization: a text leaf around and between inlines.
        let mut out = Vec::with_capacity(nodes.len() + 2);
        for node in nodes {
            let element = node.get("type").is_some();
            let after_element = out
                .last()
                .is_none_or(|last: &Value| last.get("type").is_some());
            if element && after_element {
                out.push(json!({"text": ""}));
            }
            out.push(node);
        }
        if out.last().is_none_or(|last| last.get("type").is_some()) {
            out.push(json!({"text": ""}));
        }
        Ok(Value::Array(out))
    }
}

fn leaf(run: &Run) -> Result<Value, ProjectionError> {
    let mut node = Map::new();
    node.insert("text".into(), json!(run.text));
    for (attribute, value) in &run.attrs {
        if attribute == "link" {
            continue;
        }
        let mark =
            mark_of_attribute(attribute).ok_or_else(|| ProjectionError::Text(attribute.clone()))?;
        node.insert(mark.into(), value.clone());
    }
    Ok(Value::Object(node))
}
