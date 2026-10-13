//! Question and embed-block validation (`collaboration/src/questions.ts`, a
//! zod schema plus checks; Go `internal/questions` keeps the same contract and
//! the shared fixtures in `server/internal/questions/testdata` exercise all
//! three). Values are JSON as stored; strings are measured as JS measures them
//! (`length` in UTF-16 units, `[...value].length` in code points, `trim()`
//! with the ECMAScript whitespace set).
//!
//! Where the TS raises a zod error, this returns its own message: callers only
//! show it. The checks after the schema keep the TS messages.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

// The question bounds every validator shares, from the embed catalog
// (Go `fieldlimits.QuestionBounds`).
pub use crate::catalog::{
    QUESTION_ANSWERS_MAX, QUESTION_ASSET_URL_MAX, QUESTION_BLOCKS_MAX, QUESTION_CHART_LABELS_MAX,
    QUESTION_CHART_SERIES_MAX, QUESTION_GRAPH_ELEMENTS_MAX, QUESTION_GRAPH_POLYGON_MAX,
    QUESTION_GRAPH_TERM_MAX, QUESTION_ID_MAX, QUESTION_IMAGE_DIMENSION_MAX, QUESTION_MARK_ITEM_MAX,
    QUESTION_MARKS_MAX, QUESTION_MARKSCHEME_MAX, QUESTION_PARTS_MAX, QUESTION_PLOT_MARKS_MAX,
    QUESTION_PLOT_POINTS_MAX, QUESTION_PLOT_SERIES_MAX, QUESTION_SVG_BYTES_MAX,
    QUESTION_TABLE_COLUMNS_MAX, QUESTION_TABLE_ROWS_MAX, QUESTION_TEXT_MAX, QUESTION_UNIT_MAX,
    QUIZ_MARKSCHEME_MAX, QUIZ_OPEN_ANSWER_MAX, QUIZ_OPEN_PARTS_MAX, QUIZ_PARTS_MAX,
    QUIZ_QUESTION_PARTS_MAX,
};

/// `QuestionPolicy`, plus the host a quiz figure may link: the TS reads
/// `process.env.BANK_ASSETS_URL` there (Go's QuizBankAssetsURL).
#[derive(Debug, Clone, Default)]
pub struct Policy {
    pub bank: bool,
    pub bank_assets_url: Option<String>,
    pub snapshot: bool,
    pub quiz_assets_url: Option<String>,
}

impl Policy {
    /// A quiz question's policy, the host read from `BANK_ASSETS_URL` per
    /// call as the Node server reads it.
    pub fn quiz() -> Self {
        Policy {
            quiz_assets_url: std::env::var("BANK_ASSETS_URL").ok(),
            ..Policy::default()
        }
    }

    fn figure_host(&self) -> Option<&str> {
        if self.bank {
            self.bank_assets_url.as_deref()
        } else {
            self.quiz_assets_url.as_deref()
        }
        .filter(|host| !host.is_empty())
    }
}

type Check = Result<(), String>;

fn fail<T>(message: impl Into<String>) -> Result<T, String> {
    Err(message.into())
}

/* ------------------------------------------------------------- JS strings */

/// ECMAScript `String.prototype.trim` whitespace: WhiteSpace and
/// LineTerminator code points.
pub fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(js_whitespace)
}

/// `value.length`.
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `[...value].length`.
fn code_points(text: &str) -> usize {
    text.chars().count()
}

/// JS `\s` as a regex class body.
const WS: &str = r"\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

fn js_regex(pattern: &str) -> Regex {
    Regex::new(
        &pattern
            .replace(r"\s", &format!("[{WS}]"))
            .replace(r"\S", &format!("[^{WS}]")),
    )
    .expect("valid regex")
}

/* ------------------------------------------------------------ primitives */

fn object<'a>(value: &'a Value, what: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{what}: expected an object"))
}

/// A strict object: every required key present, nothing outside the lists.
fn strict(map: &Map<String, Value>, what: &str, required: &[&str], optional: &[&str]) -> Check {
    for key in required {
        if !map.contains_key(*key) {
            return fail(format!("{what}: {key} is required"));
        }
    }
    for key in map.keys() {
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            return fail(format!("{what}: unrecognized key {key}"));
        }
    }
    Ok(())
}

fn present<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    map.get(key)
}

/// `text`: trimmed, non-empty, at most QUESTION_TEXT_MAX code points.
fn text(value: &Value, what: &str) -> Result<String, String> {
    let Some(raw) = value.as_str() else {
        return fail(format!("{what}: expected a string"));
    };
    let trimmed = js_trim(raw);
    if utf16_len(trimmed) < 1 {
        return fail(format!("{what}: too short"));
    }
    if code_points(trimmed) > QUESTION_TEXT_MAX {
        return fail(format!("{what}: Text is too long."));
    }
    Ok(trimmed.to_owned())
}

/// `identifier`.
fn identifier(value: &Value, what: &str) -> Result<String, String> {
    let Some(raw) = value.as_str() else {
        return fail(format!("{what}: expected a string"));
    };
    if utf16_len(raw) < 1 || js_trim(raw).is_empty() {
        return fail(format!("{what}: An ID is required."));
    }
    if code_points(raw) > QUESTION_ID_MAX {
        return fail(format!("{what}: Text is too long."));
    }
    Ok(raw.to_owned())
}

/// `meta`: a string of at most 1000 UTF-16 units.
fn meta(value: &Value, what: &str) -> Check {
    match value.as_str() {
        Some(raw) if utf16_len(raw) <= 1000 => Ok(()),
        Some(_) => fail(format!("{what}: too long")),
        None => fail(format!("{what}: expected a string")),
    }
}

fn optional<F: FnOnce(&Value) -> Check>(map: &Map<String, Value>, key: &str, check: F) -> Check {
    match present(map, key) {
        Some(value) => check(value),
        None => Ok(()),
    }
}

fn number(value: &Value, what: &str) -> Result<f64, String> {
    value
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or_else(|| format!("{what}: expected a number"))
}

/// `z.number().int()`: a safe integer.
fn integer(value: &Value, what: &str) -> Result<f64, String> {
    let n = number(value, what)?;
    if n.fract() != 0.0 || n.abs() > 9_007_199_254_740_991.0 {
        return fail(format!("{what}: expected an integer"));
    }
    Ok(n)
}

fn index(value: &Value, what: &str) -> Result<f64, String> {
    let n = integer(value, what)?;
    if n < 0.0 {
        return fail(format!("{what}: expected a nonnegative integer"));
    }
    Ok(n)
}

fn boolean(value: &Value, what: &str) -> Check {
    if value.is_boolean() {
        Ok(())
    } else {
        fail(format!("{what}: expected a boolean"))
    }
}

fn one_of<'a>(value: &'a Value, what: &str, options: &[&str]) -> Result<&'a str, String> {
    match value.as_str() {
        Some(v) if options.contains(&v) => Ok(v),
        _ => fail(format!("{what}: expected one of {options:?}")),
    }
}

fn array<'a>(value: &'a Value, what: &str, min: usize, max: usize) -> Result<&'a [Value], String> {
    let Some(items) = value.as_array() else {
        return fail(format!("{what}: expected an array"));
    };
    if items.len() < min {
        return fail(format!("{what}: too few items"));
    }
    if items.len() > max {
        return fail(format!("{what}: too many items"));
    }
    Ok(items)
}

/// `list`: 1..=QUESTION_ANSWERS_MAX texts.
fn list(value: &Value, what: &str, min: usize) -> Result<Vec<String>, String> {
    array(value, what, min, QUESTION_ANSWERS_MAX)?
        .iter()
        .map(|item| text(item, what))
        .collect()
}

fn coords(value: &Value, what: &str) -> Check {
    let items = array(value, what, 2, 2)?;
    for item in items {
        number(item, what)?;
    }
    Ok(())
}

fn image_size(map: &Map<String, Value>, what: &str) -> Check {
    for key in ["height", "width"] {
        let n = integer(&map[key], what)?;
        if !(1.0..=QUESTION_IMAGE_DIMENSION_MAX).contains(&n) {
            return fail(format!("{what}: {key} out of range"));
        }
    }
    Ok(())
}

fn style(map: &Map<String, Value>, what: &str) -> Check {
    optional(map, "dash", |v| boolean(v, what))?;
    optional(map, "hidden", |v| boolean(v, what))
}

/// `z.url().max(QUESTION_ASSET_URL_MAX)`: a WHATWG URL after trimming.
fn url(value: &Value, what: &str) -> Result<String, String> {
    let Some(raw) = value.as_str() else {
        return fail(format!("{what}: expected a string"));
    };
    let trimmed = js_trim(raw);
    if url::Url::parse(trimmed).is_err() {
        return fail(format!("{what}: Invalid URL"));
    }
    if utf16_len(trimmed) > QUESTION_ASSET_URL_MAX {
        return fail(format!("{what}: too long"));
    }
    Ok(trimmed.to_owned())
}

/* ------------------------------------------------------------- patterns */

static QUANTITY: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?(?:\s*/\s*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)?$",
    )
});
static TERM_TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[A-Za-z]+|[+\-*/^(),]")
        .expect("valid regex")
});
static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"\s"));
static GAP_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(([0-9]+)\) ?_{3,}").expect("valid regex"));
// The SVG patterns run on an ASCII-lowercased copy for the ones JS matches
// case-insensitively (JS `i` without `u` folds ASCII only).
static SVG_START: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^\s*<svg[\s>]"));
static SVG_END: LazyLock<Regex> = LazyLock::new(|| js_regex(r"</svg>\s*$"));
static SVG_UNSAFE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"<!|<\?|(?-u:\b)on[A-Za-z0-9_]+\s*=|javascript:|data:|<\s*/?\s*(?:script|foreignobject|style|image|use|a|animate[A-Za-z0-9_]*|set)(?-u:\b)",
    )
});
static SVG_REFERENCES: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r#"(?:[a-z]+:)?(?:href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)"#));
static SVG_LOCAL_REFERENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^["']#[A-Za-z0-9_-]+["']$"#).expect("valid regex"));
static SVG_URLS: LazyLock<Regex> = LazyLock::new(|| js_regex(r"url\s*\([^)]*\)"));
static SVG_LOCAL_URL: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r#"^url\s*\(\s*["']?#[A-Za-z0-9_-]+["']?\s*\)$"#));
static SVG_ESCAPED_STYLE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r#"style\s*=\s*(?:"[^"<>]*\\|'[^'<>]*\\)"#));
static SVG_TAGS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"</?([A-Za-z][A-Za-z0-9_:-]*)(?-u:\b)").expect("valid regex"));

/// `validQuantityValue`: values only; a fraction's denominator not zero.
pub fn valid_quantity_value(value: &str) -> bool {
    let input = js_trim(value);
    if !QUANTITY.is_match(input) {
        return false;
    }
    match input.split('/').nth(1) {
        None => true,
        Some(denominator) => {
            let mantissa = denominator.split(['e', 'E']).next().unwrap_or("");
            mantissa.chars().any(|c| ('1'..='9').contains(&c))
        }
    }
}

/// `validGraphTerm`.
pub fn valid_graph_term(term: &str) -> bool {
    if term.is_empty() || utf16_len(term) > QUESTION_GRAPH_TERM_MAX {
        return false;
    }
    let tokens: Vec<&str> = TERM_TOKENS.find_iter(term).map(|m| m.as_str()).collect();
    if tokens.is_empty() || tokens.concat() != WHITESPACE.replace_all(term, "") {
        return false;
    }
    const NAMES: [&str; 19] = [
        "x", "pi", "e", "sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "abs", "exp", "log",
        "ln", "floor", "ceil", "pow", "min", "max",
    ];
    tokens
        .iter()
        .all(|t| !t.starts_with(|c: char| c.is_ascii_alphabetic()) || NAMES.contains(t))
}

/// `validGraphSvg`: the static subset rendered as an image.
pub fn valid_graph_svg(svg: &str) -> bool {
    if svg.len() > QUESTION_SVG_BYTES_MAX || !SVG_START.is_match(svg) || !SVG_END.is_match(svg) {
        return false;
    }
    let lower = svg.to_ascii_lowercase();
    if SVG_UNSAFE.is_match(&lower) || SVG_ESCAPED_STYLE.is_match(&lower) {
        return false;
    }
    if SVG_REFERENCES
        .captures_iter(&lower)
        .any(|c| !SVG_LOCAL_REFERENCE.is_match(&c[1]))
    {
        return false;
    }
    if SVG_URLS
        .find_iter(&lower)
        .any(|m| !SVG_LOCAL_URL.is_match(m.as_str()))
    {
        return false;
    }
    const ALLOWED: [&str; 16] = [
        "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text",
        "tspan", "defs", "marker", "clipPath", "title", "desc",
    ];
    SVG_TAGS
        .captures_iter(svg)
        .all(|c| ALLOWED.contains(&&c[1]))
}

/* ----------------------------------------------------------- the schema */

/// A block as the schema leaves it, for the checks after it.
pub struct Block {
    pub kind: String,
    pub text: Option<String>,
    /// `image.url` (trimmed), `image.assetId` or `image.svg`.
    pub image: Option<(&'static str, String)>,
}

/// `graphElement`.
/// A graph element as the schema leaves it, for the board checks.
struct GraphElement {
    id: String,
    kind: &'static str,
    points: Vec<String>,
    center: Option<String>,
    domain: Option<(f64, f64)>,
}

fn graph_element(value: &Value) -> Result<GraphElement, String> {
    let what = "graph element";
    let map = object(value, what)?;
    let kind = map.get("type").and_then(Value::as_str).unwrap_or("");
    let mut points = Vec::new();
    let mut center = None;
    let mut domain = None;
    let kind: &'static str = match kind {
        "functiongraph" => {
            strict(
                map,
                what,
                &["id", "term", "type"],
                &["domain", "dash", "hidden"],
            )?;
            if let Some(d) = present(map, "domain") {
                coords(d, what)?;
                let d = d
                    .as_array()
                    .map(|a| (a[0].as_f64().unwrap_or(0.0), a[1].as_f64().unwrap_or(0.0)));
                domain = d;
            }
            match map["term"].as_str() {
                Some(term) if valid_graph_term(term) => {}
                _ => return fail("Use a supported mathematical expression."),
            }
            style(map, what)?;
            "functiongraph"
        }
        "point" => {
            strict(map, what, &["coords", "id", "type"], &["hidden", "name"])?;
            coords(&map["coords"], what)?;
            optional(map, "hidden", |v| boolean(v, what))?;
            optional(map, "name", |v| meta(v, what))?;
            "point"
        }
        "line" | "segment" => {
            let segment = kind == "segment";
            let extra: &[&str] = if segment {
                &["ticks", "dash", "hidden"]
            } else {
                &["dash", "hidden"]
            };
            strict(map, what, &["id", "points", "type"], extra)?;
            for p in array(&map["points"], what, 2, 2)? {
                points.push(identifier(p, what)?);
            }
            if segment {
                optional(map, "ticks", |v| {
                    let n = integer(v, what)?;
                    if (1.0..=3.0).contains(&n) {
                        Ok(())
                    } else {
                        fail(format!("{what}: ticks out of range"))
                    }
                })?;
            }
            style(map, what)?;
            if segment { "segment" } else { "line" }
        }
        "circle" => {
            strict(
                map,
                what,
                &["center", "id", "radius", "type"],
                &["dash", "hidden"],
            )?;
            center = Some(identifier(&map["center"], what)?);
            if number(&map["radius"], what)? <= 0.0 {
                return fail(format!("{what}: radius must be positive"));
            }
            style(map, what)?;
            "circle"
        }
        "text" => {
            strict(map, what, &["coords", "id", "text", "type"], &["hidden"])?;
            coords(&map["coords"], what)?;
            optional(map, "hidden", |v| boolean(v, what))?;
            text(&map["text"], what)?;
            "text"
        }
        "angle" => {
            strict(map, what, &["id", "points", "type"], &["hidden", "label"])?;
            optional(map, "hidden", |v| boolean(v, what))?;
            optional(map, "label", |v| meta(v, what))?;
            for p in array(&map["points"], what, 3, 3)? {
                points.push(identifier(p, what)?);
            }
            "angle"
        }
        "arc" | "sector" => {
            let sector = kind == "sector";
            let extra: &[&str] = if sector {
                &["shade", "dash", "hidden"]
            } else {
                &["dash", "hidden"]
            };
            strict(map, what, &["center", "id", "points", "type"], extra)?;
            center = Some(identifier(&map["center"], what)?);
            for p in array(&map["points"], what, 2, 2)? {
                points.push(identifier(p, what)?);
            }
            if sector {
                optional(map, "shade", |v| boolean(v, what))?;
            }
            style(map, what)?;
            if sector { "sector" } else { "arc" }
        }
        "polygon" => {
            strict(
                map,
                what,
                &["id", "points", "type"],
                &["shade", "dash", "hidden"],
            )?;
            for p in array(&map["points"], what, 3, QUESTION_GRAPH_POLYGON_MAX)? {
                points.push(identifier(p, what)?);
            }
            optional(map, "shade", |v| boolean(v, what))?;
            style(map, what)?;
            "polygon"
        }
        _ => return fail(format!("{what}: invalid type")),
    };
    let id = identifier(&map["id"], what)?;
    Ok(GraphElement {
        id,
        kind,
        points,
        center,
        domain,
    })
}

/// `questionBlockSchema`.
pub fn block(value: &Value) -> Result<Block, String> {
    let what = "block";
    let map = object(value, what)?;
    let kind = map.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "text" => {
            strict(map, what, &["text", "type"], &["label"])?;
            optional(map, "label", |v| meta(v, what))?;
            let text = text(&map["text"], what)?;
            Ok(Block {
                kind: "text".into(),
                text: Some(text),
                image: None,
            })
        }
        "table" => {
            strict(map, what, &["header", "rows", "type"], &[])?;
            boolean(&map["header"], what)?;
            let rows = array(&map["rows"], what, 1, QUESTION_TABLE_ROWS_MAX)?;
            let mut widths = Vec::new();
            for row in rows {
                let cells = array(row, what, 1, QUESTION_TABLE_COLUMNS_MAX)?;
                for cell in cells {
                    match cell.as_str() {
                        Some(cell) if code_points(cell) <= QUESTION_TEXT_MAX => {}
                        _ => return fail(format!("{what}: invalid cell")),
                    }
                }
                widths.push(cells.len());
            }
            if widths.iter().any(|w| *w != widths[0]) {
                return fail("Table rows must have the same number of cells.");
            }
            Ok(Block {
                kind: "table".into(),
                text: None,
                image: None,
            })
        }
        "chart" => {
            strict(
                map,
                what,
                &["kind", "labels", "series", "title", "type"],
                &["gridlines", "xTitle", "yTitle"],
            )?;
            optional(map, "gridlines", |v| {
                one_of(v, what, &["normal", "fine"]).map(|_| ())
            })?;
            let chart = one_of(
                &map["kind"],
                what,
                &["bar", "hbar", "line", "area", "pie", "stacked"],
            )?;
            let labels = array(&map["labels"], what, 1, QUESTION_CHART_LABELS_MAX)?;
            for label in labels {
                text(label, what)?;
            }
            let series = array(&map["series"], what, 1, QUESTION_CHART_SERIES_MAX)?;
            let mut values_of = Vec::new();
            for entry in series {
                let entry_map = object(entry, what)?;
                strict(entry_map, what, &["name", "values"], &[])?;
                meta(&entry_map["name"], what)?;
                let values = array(&entry_map["values"], what, 1, QUESTION_CHART_LABELS_MAX)?;
                let mut numbers = Vec::new();
                for value in values {
                    numbers.push(number(value, what)?);
                }
                values_of.push(numbers);
            }
            meta(&map["title"], what)?;
            for key in ["xTitle", "yTitle"] {
                optional(map, key, |v| meta(v, what))?;
            }
            if values_of.iter().any(|v| v.len() != labels.len()) {
                return fail("Each series needs a value for every label.");
            }
            if matches!(chart, "pie" | "stacked")
                && (values_of.len() != 1
                    || values_of[0].iter().any(|n| *n < 0.0)
                    || !values_of[0].iter().any(|n| *n > 0.0))
            {
                return fail(
                    "Pie and stacked charts need one nonnegative series with a positive total.",
                );
            }
            Ok(Block {
                kind: "chart".into(),
                text: None,
                image: None,
            })
        }
        "plot" => {
            // Go's validatePlot: one to four series of [x, y] points drawn
            // as a line or a scatter, optional reference lines and labelled
            // points.
            strict(
                map,
                what,
                &["series", "title", "type", "xTitle", "yTitle"],
                &["kind", "lines", "marks", "unit"],
            )?;
            optional(map, "kind", |v| {
                one_of(v, what, &["line", "scatter"]).map(|_| ())
            })?;
            for key in ["title", "xTitle", "yTitle"] {
                meta(&map[key], what)?;
            }
            optional(map, "unit", |v| meta(v, what))?;
            for curve in array(&map["series"], what, 1, QUESTION_PLOT_SERIES_MAX)? {
                let curve = object(curve, what)?;
                strict(curve, what, &["name", "points"], &[])?;
                meta(&curve["name"], what)?;
                for point in array(&curve["points"], what, 2, QUESTION_PLOT_POINTS_MAX)? {
                    coords(point, what)?;
                }
            }
            optional(map, "lines", |v| {
                for line in array(v, what, 0, QUESTION_PLOT_MARKS_MAX)? {
                    let line = object(line, what)?;
                    strict(line, what, &["axis", "value"], &["label"])?;
                    one_of(&line["axis"], what, &["x", "y"])?;
                    number(&line["value"], what)?;
                    optional(line, "label", |v| meta(v, what))?;
                }
                Ok(())
            })?;
            optional(map, "marks", |v| {
                for mark in array(v, what, 0, QUESTION_PLOT_MARKS_MAX)? {
                    let mark = object(mark, what)?;
                    strict(mark, what, &["label", "x", "y"], &[])?;
                    meta(&mark["label"], what)?;
                    number(&mark["x"], what)?;
                    number(&mark["y"], what)?;
                }
                Ok(())
            })?;
            Ok(Block {
                kind: "plot".into(),
                text: None,
                image: None,
            })
        }
        "image" => {
            strict(
                map,
                what,
                &["description", "height", "image", "type", "width"],
                &["attribution"],
            )?;
            let image = figure(&map["image"], false)?;
            image_size(map, what)?;
            optional(map, "attribution", |v| meta(v, what))?;
            text(&map["description"], what)?;
            Ok(Block {
                kind: "image".into(),
                text: None,
                image: Some(image),
            })
        }
        "graph" => {
            strict(
                map,
                what,
                &[
                    "board",
                    "description",
                    "elements",
                    "height",
                    "image",
                    "type",
                    "width",
                ],
                &["attribution"],
            )?;
            let board = object(&map["board"], what)?;
            strict(board, what, &["axis", "bbox", "grid"], &[])?;
            boolean(&board["axis"], what)?;
            let bbox: Vec<f64> = array(&board["bbox"], what, 4, 4)?
                .iter()
                .map(|v| number(v, what))
                .collect::<Result<_, _>>()?;
            boolean(&board["grid"], what)?;
            let elements: Vec<_> = array(&map["elements"], what, 0, QUESTION_GRAPH_ELEMENTS_MAX)?
                .iter()
                .map(graph_element)
                .collect::<Result<_, _>>()?;
            let image = figure(&map["image"], true)?;
            image_size(map, what)?;
            optional(map, "attribution", |v| meta(v, what))?;
            text(&map["description"], what)?;
            let (left, top, right, bottom) = (bbox[0], bbox[1], bbox[2], bbox[3]);
            if left >= right || bottom >= top {
                return fail("Graph bounds must have positive width and height.");
            }
            let point_ids: HashSet<&str> = elements
                .iter()
                .filter(|e| e.kind == "point")
                .map(|e| e.id.as_str())
                .collect();
            let mut ids = HashSet::new();
            for GraphElement {
                id,
                kind,
                points,
                center,
                domain,
            } in &elements
            {
                if !ids.insert(id.as_str()) {
                    return fail("Graph element IDs must be unique.");
                }
                let has_points = !matches!(*kind, "functiongraph" | "point" | "circle" | "text");
                if has_points {
                    let unique: HashSet<&String> = points.iter().collect();
                    if points.iter().any(|p| !point_ids.contains(p.as_str()))
                        || unique.len() != points.len()
                    {
                        return fail("Lines must refer to existing points.");
                    }
                }
                if let Some(center) = center
                    && (!point_ids.contains(center.as_str())
                        || (has_points && points.contains(center)))
                {
                    return fail("Circle centers must refer to existing points.");
                }
                if let Some((from, to)) = domain
                    && from >= to
                {
                    return fail("Function domain must be increasing.");
                }
            }
            Ok(Block {
                kind: "graph".into(),
                text: None,
                image: Some(image),
            })
        }
        _ => fail(format!("{what}: invalid type")),
    }
}

/// An image or graph's `image`: `{url}`, `{assetId}` (images) or `{svg}`
/// (graphs).
fn figure(value: &Value, graph: bool) -> Result<(&'static str, String), String> {
    let what = "image";
    let map = object(value, what)?;
    if map.contains_key("url") && map.len() == 1 {
        return Ok(("url", url(&map["url"], what)?));
    }
    if graph {
        if map.contains_key("svg") && map.len() == 1 {
            return match map["svg"].as_str() {
                Some(svg) if valid_graph_svg(svg) => Ok(("svg", svg.to_owned())),
                _ => fail("Graph SVG contains unsupported content."),
            };
        }
    } else if map.contains_key("assetId") && map.len() == 1 {
        return Ok(("assetId", identifier(&map["assetId"], what)?));
    }
    fail(format!("{what}: invalid input"))
}

/// One part as the schema leaves it.
struct Part {
    id: String,
    answer: String,
    gaps: usize,
    open_accepted: Vec<String>,
    awarded: Option<f64>,
    item_awards: Option<Vec<f64>>,
    marks: f64,
    markscheme: Option<Vec<f64>>,
    blocks: Vec<Block>,
    solution: Vec<Block>,
}

/// `answerSchema`; returns the answer type, the gaps count and an open
/// answer's accepted texts.
fn answer(value: &Value) -> Result<(String, usize, Vec<String>), String> {
    let what = "answer";
    let map = object(value, what)?;
    let kind = map.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "mcq" | "multi" => {
            strict(map, what, &["correct", "options", "type"], &[])?;
            let correct: Vec<f64> = array(&map["correct"], what, 1, QUESTION_ANSWERS_MAX)?
                .iter()
                .map(|v| index(v, what))
                .collect::<Result<_, _>>()?;
            let options = list(&map["options"], what, 2)?;
            let distinct: HashSet<u64> = correct.iter().map(|n| *n as u64).collect();
            if distinct.len() != correct.len()
                || correct.iter().any(|n| *n >= options.len() as f64)
                || (kind == "mcq" && correct.len() != 1)
            {
                return fail("Choose valid, distinct correct options.");
            }
            Ok((kind.into(), 0, vec![]))
        }
        "boolean" => {
            strict(map, what, &["correct", "type"], &[])?;
            boolean(&map["correct"], what)?;
            Ok((kind.into(), 0, vec![]))
        }
        "short" => {
            strict(map, what, &["accepted", "type"], &["unit"])?;
            let accepted = list(&map["accepted"], what, 1)?;
            let unit = match present(map, "unit") {
                Some(unit) => {
                    let Some(raw) = unit.as_str() else {
                        return fail(format!("{what}: unit must be a string"));
                    };
                    let trimmed = js_trim(raw);
                    if trimmed.is_empty() || code_points(trimmed) > QUESTION_UNIT_MAX {
                        return fail(format!("{what}: invalid unit"));
                    }
                    true
                }
                None => false,
            };
            if unit && !accepted.iter().all(|a| valid_quantity_value(a)) {
                return fail("Accepted answers must contain values only, in the required unit.");
            }
            Ok((kind.into(), 0, vec![]))
        }
        "matching" => {
            strict(map, what, &["options", "pairs", "type"], &[])?;
            let options = list(&map["options"], what, 1)?;
            let pairs = array(&map["pairs"], what, 1, QUESTION_ANSWERS_MAX)?;
            let mut rights = Vec::new();
            for pair in pairs {
                let pair = object(pair, what)?;
                strict(pair, what, &["left", "right"], &[])?;
                text(&pair["left"], what)?;
                rights.push(index(&pair["right"], what)?);
            }
            if rights.iter().any(|r| *r >= options.len() as f64) {
                return fail("Every pair needs a choice from the pool.");
            }
            Ok((kind.into(), 0, vec![]))
        }
        "ordering" => {
            strict(map, what, &["items", "type"], &[])?;
            list(&map["items"], what, 2)?;
            Ok((kind.into(), 0, vec![]))
        }
        "gaps" => {
            strict(map, what, &["accepted", "type"], &[])?;
            let lists = array(&map["accepted"], what, 1, QUESTION_ANSWERS_MAX)?;
            for item in lists {
                list(item, what, 1)?;
            }
            Ok((kind.into(), lists.len(), vec![]))
        }
        "open" => {
            strict(map, what, &["accepted", "hints", "type"], &[])?;
            let accepted = list(&map["accepted"], what, 1)?;
            for hint in array(&map["hints"], what, 0, QUESTION_ANSWERS_MAX)? {
                text(hint, what)?;
            }
            Ok((kind.into(), 0, accepted))
        }
        _ => fail(format!("{what}: invalid type")),
    }
}

fn block_list(value: &Value, min: usize) -> Result<Vec<Block>, String> {
    array(value, "blocks", min, QUESTION_BLOCKS_MAX)?
        .iter()
        .map(block)
        .collect()
}

fn part(value: &Value) -> Result<Part, String> {
    let what = "part";
    let map = object(value, what)?;
    strict(
        map,
        what,
        &["answer", "blocks", "id", "marks", "solution"],
        &["awarded", "itemAwards", "markscheme"],
    )?;
    let (answer, gaps, open_accepted) = answer(&map["answer"])?;
    let awarded = match present(map, "awarded") {
        Some(v) => {
            let n = number(v, what)?;
            if n < 0.0 {
                return fail(format!("{what}: awarded must be nonnegative"));
            }
            Some(n)
        }
        None => None,
    };
    let blocks = block_list(&map["blocks"], 1)?;
    let id = identifier(&map["id"], what)?;
    let item_awards = match present(map, "itemAwards") {
        Some(v) => Some(
            array(v, what, 0, usize::MAX)?
                .iter()
                .map(|n| number(n, what))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        None => None,
    };
    let marks = integer(&map["marks"], what)?;
    if !(1.0..=QUESTION_MARKS_MAX).contains(&marks) {
        return fail(format!("{what}: marks out of range"));
    }
    let markscheme = match present(map, "markscheme") {
        Some(v) => {
            let mut items = Vec::new();
            for item in array(v, what, 1, QUESTION_MARKSCHEME_MAX)? {
                let item = object(item, what)?;
                strict(item, what, &["marks", "text"], &[])?;
                let marks = integer(&item["marks"], what)?;
                if marks < 1.0 {
                    return fail(format!("{what}: marking item marks below 1"));
                }
                let Some(raw) = item["text"].as_str() else {
                    return fail(format!("{what}: marking item text must be a string"));
                };
                let trimmed = js_trim(raw);
                if trimmed.is_empty() || utf16_len(trimmed) > QUESTION_MARK_ITEM_MAX {
                    return fail(format!("{what}: invalid marking item text"));
                }
                items.push(marks);
            }
            Some(items)
        }
        None => None,
    };
    let solution = block_list(&map["solution"], 0)?;
    Ok(Part {
        id,
        answer,
        gaps,
        open_accepted,
        awarded,
        item_awards,
        marks,
        markscheme,
        blocks,
        solution,
    })
}

/// A question as the schema leaves it.
pub struct Question {
    pub id: String,
    pub open_parts: usize,
    pub part_ids: Vec<String>,
}

/// `hostedAsset(url, base)`.
fn hosted_asset(value: &str, base: Option<&str>) -> bool {
    let Some(base) = base else {
        return false;
    };
    let (Ok(url), Ok(allowed)) = (url::Url::parse(value), url::Url::parse(base)) else {
        return false;
    };
    let prefix = format!(
        "{}/",
        allowed.path().strip_suffix('/').unwrap_or(allowed.path())
    );
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none_or(str::is_empty)
        && url.query().is_none_or(str::is_empty)
        && url.fragment().is_none_or(str::is_empty)
        && url.origin() == allowed.origin()
        && url.path().starts_with(&prefix)
}

/// `validateQuestion(value, policy)`.
pub fn validate_question(value: &Value, policy: &Policy) -> Result<Question, String> {
    let what = "question";
    let map = object(value, what)?;
    strict(
        map,
        what,
        &["id", "labels", "layout", "parts", "stem"],
        &["level"],
    )?;
    let id = identifier(&map["id"], what)?;
    one_of(&map["labels"], what, &["letters", "numbers"])?;
    one_of(&map["layout"], what, &["paper", "split"])?;
    optional(map, "level", |v| {
        one_of(v, what, &["recall", "application", "analysis"]).map(|_| ())
    })?;
    let parts: Vec<Part> = array(&map["parts"], what, 1, QUESTION_PARTS_MAX)?
        .iter()
        .map(part)
        .collect::<Result<_, _>>()?;
    let stem = block_list(&map["stem"], 0)?;

    let mut ids = HashSet::new();
    for part in &parts {
        if !ids.insert(part.id.as_str()) {
            return fail("Part IDs must be unique.");
        }
        if !policy.snapshot && (part.awarded.is_some() || part.item_awards.is_some()) {
            return fail("Authored questions cannot contain awarded marks.");
        }
        if part.answer == "gaps" {
            let numbers: Vec<String> = part
                .blocks
                .iter()
                .filter(|b| b.kind == "text")
                .flat_map(|b| {
                    GAP_MARKER
                        .captures_iter(b.text.as_deref().unwrap_or(""))
                        .map(|c| js_number_string(&c[1]))
                        .collect::<Vec<_>>()
                })
                .collect();
            let expected: Vec<String> = (1..=part.gaps).map(|n| n.to_string()).collect();
            if numbers.join(",") != expected.join(",") {
                return fail(
                    "Write each gap in the text as (1) ______, (2) ______ and so on, one per accepted list.",
                );
            }
        }
        if (part.answer == "open") != part.markscheme.is_some() {
            return fail("Open answers need a marking scheme, and only open answers have one.");
        }
        let marks = part.markscheme.clone().unwrap_or_default();
        if part.markscheme.is_some() && marks.iter().sum::<f64>() != part.marks {
            return fail("The marking items must add up to the part's marks.");
        }
        if let Some(awarded) = part.awarded
            && (awarded > part.marks || (awarded * 2.0) % 1.0 != 0.0)
        {
            return fail("Awarded marks exceed the part or are not half marks.");
        }
        if let Some(awards) = &part.item_awards {
            let valid = part.markscheme.is_some()
                && awards.len() == marks.len()
                && awards
                    .iter()
                    .zip(&marks)
                    .all(|(award, item)| *award == 0.0 || *award == item / 2.0 || award == item)
                && Some(awards.iter().sum::<f64>()) == part.awarded;
            if !valid {
                return fail(
                    "Item awards must give none, half or all of each marking item's marks.",
                );
            }
        }
        if policy.bank && part.solution.is_empty() {
            return fail("Bank questions need a worked solution for every part.");
        }
        if !policy.bank && marks.len() > QUIZ_MARKSCHEME_MAX {
            return fail(format!(
                "A part has at most {QUIZ_MARKSCHEME_MAX} marking items."
            ));
        }
        if !policy.bank
            && part.answer == "open"
            && part
                .open_accepted
                .iter()
                .any(|t| code_points(t) > QUIZ_OPEN_ANSWER_MAX)
        {
            return fail(format!(
                "Sample answers are limited to {QUIZ_OPEN_ANSWER_MAX} characters."
            ));
        }
    }
    if !policy.bank && parts.len() > QUIZ_QUESTION_PARTS_MAX {
        return fail(format!(
            "A question has at most {QUIZ_QUESTION_PARTS_MAX} parts."
        ));
    }
    let host = policy.figure_host();
    for block in stem.iter().chain(
        parts
            .iter()
            .flat_map(|p| p.blocks.iter().chain(&p.solution)),
    ) {
        if block.kind != "image" && block.kind != "graph" {
            continue;
        }
        let refused = match &block.image {
            Some(("url", url)) => !hosted_asset(url, host),
            Some(("assetId", _)) => policy.bank,
            _ => false,
        };
        if refused {
            return fail("Figures must use the configured bank asset host.");
        }
        if policy.bank && block.kind == "graph" && matches!(block.image, Some(("svg", _))) {
            return fail("Upload bank graphs before saving the question.");
        }
    }
    Ok(Question {
        id,
        open_parts: parts.iter().filter(|p| p.answer == "open").count(),
        part_ids: parts.into_iter().map(|p| p.id).collect(),
    })
}

/// `Number(digits)` as JS prints it (leading zeros dropped).
fn js_number_string(digits: &str) -> String {
    let trimmed = digits.trim_start_matches('0');
    if trimmed.is_empty() {
        return "0".into();
    }
    match trimmed.parse::<f64>() {
        Ok(n) => crate::json::js_number(n),
        Err(_) => trimmed.into(),
    }
}

/// `assertQuizBounds`: one attempt's open parts fit one grading request.
pub fn assert_quiz_bounds(parts: usize, open_parts: usize) -> Check {
    if parts > QUIZ_PARTS_MAX {
        return fail(format!("A quiz has at most {QUIZ_PARTS_MAX} parts."));
    }
    if open_parts > QUIZ_OPEN_PARTS_MAX {
        return fail(format!(
            "A quiz has at most {QUIZ_OPEN_PARTS_MAX} open parts."
        ));
    }
    Ok(())
}
