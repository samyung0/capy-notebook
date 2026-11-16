//! A note's table view (Epo 2026-11-12): its `block` holds columns, rows and
//! views, which a room merges entry by entry (the catalog's sharedLists).
//! Writers keep only the structural rules ([block], Go's
//! `materialdoc.validateTableView` with its messages, the browser's
//! `isTableViewBlock`), so what a merge leaves (a cell of a deleted column, a
//! value that no longer fits its column, a sort naming a gone column) passes
//! and readers draw it as empty ([text], the index text).

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::catalog::{
    TABLE_VIEW_CELL_MAX, TABLE_VIEW_COLUMNS_MAX, TABLE_VIEW_ID_MAX, TABLE_VIEW_NAME_MAX,
    TABLE_VIEW_NUMBER_MAX, TABLE_VIEW_OPTIONS_MAX, TABLE_VIEW_ROWS_MAX, TABLE_VIEW_VIEWS_MAX,
};
use crate::plate::utf16_len;
use crate::questions::js_trim;

/// The element type.
pub const TYPE: &str = "table_view";

const COLUMN_KINDS: [&str; 6] = ["title", "text", "number", "select", "date", "checkbox"];
const VIEW_KINDS: [&str; 2] = ["table", "kanban"];
const COLORS: [&str; 9] = [
    "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red",
];

type Node = Map<String, Value>;
type Check = Result<(), String>;

/// An id starts with a letter or digit, so `__proto__` and friends never
/// pass (Revision 2).
fn id_ok(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|id| {
        id.len() <= TABLE_VIEW_ID_MAX
            && id.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

/// What an id must be, as Go's messages say it.
fn id_rule() -> String {
    format!(
        "must be 1 to {TABLE_VIEW_ID_MAX} letters, digits, _ or -, starting with a letter or digit"
    )
}

fn name_ok(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|name| utf16_len(name) as usize <= TABLE_VIEW_NAME_MAX)
}

/// Refuses a key outside the closed set of what `what` names.
fn keys(what: &str, value: &Node, allowed: &[&str]) -> Check {
    match value.keys().find(|key| !allowed.contains(&key.as_str())) {
        Some(key) => Err(format!("unexpected table view {what} field {key}")),
        None => Ok(()),
    }
}

/// A list of objects with unique ids, of `least` to `most` entries.
fn list<'a>(
    what: &str,
    value: Option<&'a Value>,
    least: usize,
    most: usize,
) -> Result<Vec<&'a Node>, String> {
    let Some(items) = value
        .and_then(Value::as_array)
        .filter(|items| (least..=most).contains(&items.len()))
    else {
        return Err(format!(
            "table view {what}s must be a list of {least} to {most}"
        ));
    };
    let mut ids = HashSet::new();
    items
        .iter()
        .map(|item| {
            let item = item
                .as_object()
                .ok_or_else(|| format!("table view {what} must be an object"))?;
            if !id_ok(item.get("id")) {
                return Err(format!("table view {what} id {}", id_rule()));
            }
            let id = item["id"].as_str().unwrap_or_default();
            if !ids.insert(id) {
                return Err(format!("duplicate table view {what} id {id}"));
            }
            Ok(item)
        })
        .collect()
}

/// A table view's `block` by the rules every writer keeps: the store
/// (`material::assert_canonical`) and room admission, on a copy of the room.
pub fn block(block: &Value) -> Check {
    let Some(block) = block.as_object() else {
        return Err("table view block must be an object".into());
    };
    keys("block", block, &["title", "columns", "rows", "views"])?;
    if !name_ok(block.get("title")) {
        return Err(format!(
            "table view title must be a string of at most {TABLE_VIEW_NAME_MAX} characters"
        ));
    }
    let columns = list("column", block.get("columns"), 1, TABLE_VIEW_COLUMNS_MAX)?;
    for column in &columns {
        validate_column(column)?;
    }
    let titles = columns
        .iter()
        .filter(|column| column.get("kind").and_then(Value::as_str) == Some("title"))
        .count();
    if titles != 1 {
        return Err("table view needs exactly one title column".into());
    }
    for row in list("row", block.get("rows"), 0, TABLE_VIEW_ROWS_MAX)? {
        validate_row(row)?;
    }
    // No view is a block too: two writers deleting the last two views at
    // once must not leave one the room refuses (Revision 2).
    for view in list("view", block.get("views"), 0, TABLE_VIEW_VIEWS_MAX)? {
        validate_view(view)?;
    }
    Ok(())
}

fn validate_column(column: &Node) -> Check {
    keys("column", column, &["id", "name", "kind", "options"])?;
    // A row keeps its cells beside its own id.
    if column.get("id").and_then(Value::as_str) == Some("id") {
        return Err("a table view column id cannot be id".into());
    }
    if !name_ok(column.get("name")) {
        return Err(format!(
            "table view column name must be a string of at most {TABLE_VIEW_NAME_MAX} characters"
        ));
    }
    let kind = column
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !COLUMN_KINDS.contains(&kind) {
        return Err("unknown table view column kind".into());
    }
    if kind != "select" {
        if column.contains_key("options") {
            return Err("table view options are on select columns only".into());
        }
        return Ok(());
    }
    for option in list("option", column.get("options"), 0, TABLE_VIEW_OPTIONS_MAX)? {
        keys("option", option, &["id", "name", "color"])?;
        if !name_ok(option.get("name")) {
            return Err(format!(
                "table view option name must be a string of at most {TABLE_VIEW_NAME_MAX} characters"
            ));
        }
        if !option
            .get("color")
            .and_then(Value::as_str)
            .is_some_and(|color| COLORS.contains(&color))
        {
            return Err("unknown table view option color".into());
        }
    }
    Ok(())
}

/// A row is flat (Revision 2): its id beside one key a cell, so two writers
/// editing different cells of a row merge key by key.
fn validate_row(row: &Node) -> Check {
    if row.len() > TABLE_VIEW_COLUMNS_MAX + 1 {
        return Err(format!(
            "a table view row holds at most {TABLE_VIEW_COLUMNS_MAX} cells"
        ));
    }
    for (key, value) in row.iter().filter(|(key, _)| *key != "id") {
        if !id_ok(Some(&Value::String(key.clone()))) {
            return Err(format!("table view cell key {}", id_rule()));
        }
        let fits = match value {
            Value::Bool(_) => true,
            Value::String(text) => utf16_len(text) as usize <= TABLE_VIEW_CELL_MAX,
            Value::Number(n) => n
                .as_f64()
                .is_some_and(|n| n.is_finite() && n.abs() <= TABLE_VIEW_NUMBER_MAX as f64),
            _ => false,
        };
        if !fits {
            return Err(format!(
                "table view cell must be a string of at most {TABLE_VIEW_CELL_MAX} characters, a number of at most {TABLE_VIEW_NUMBER_MAX} or a boolean"
            ));
        }
    }
    Ok(())
}

fn validate_view(view: &Node) -> Check {
    keys("view", view, &["id", "name", "kind", "sort", "groupBy"])?;
    if !name_ok(view.get("name")) {
        return Err(format!(
            "table view view name must be a string of at most {TABLE_VIEW_NAME_MAX} characters"
        ));
    }
    let kind = view.get("kind").and_then(Value::as_str).unwrap_or_default();
    if !VIEW_KINDS.contains(&kind) {
        return Err("unknown table view view kind".into());
    }
    if let Some(group) = view.get("groupBy")
        && (kind != "kanban" || !id_ok(Some(group)))
    {
        return Err("table view groupBy must be a column id on a kanban view".into());
    }
    let Some(sort) = view.get("sort") else {
        return Ok(());
    };
    let Some(sort) = sort.as_object() else {
        return Err("table view sort must be an object".into());
    };
    keys("sort", sort, &["columnId", "dir"])?;
    let dir = sort.get("dir").and_then(Value::as_str);
    if !id_ok(sort.get("columnId")) || !matches!(dir, Some("asc" | "desc")) {
        return Err("table view sort needs a column id and asc or desc".into());
    }
    Ok(())
}

// ---------------------------------------------------------------- reading

/// A cell as its column reads it (the browser's `cellValue`): `None` when it
/// is empty or doesn't fit. A number shows in a text column, and a decimal
/// number written as text in a number column.
enum Cell<'a> {
    Text(&'a str),
    /// A number in a text column, in plain decimal.
    Shown(String),
    /// A select cell's option.
    Option(&'a Value),
    Number(f64),
    Bool(bool),
}

fn cell<'a>(column: &'a Value, row: &'a Value) -> Option<Cell<'a>> {
    let value = &row[column["id"].as_str().unwrap_or_default()];
    match column["kind"].as_str()? {
        "title" | "text" => match value {
            Value::String(text) => Some(Cell::Text(text)),
            Value::Number(n) => Some(Cell::Shown(plain_number(n.as_f64()?))),
            _ => None,
        },
        "number" => match value {
            Value::Number(n) => n.as_f64().map(Cell::Number),
            Value::String(text) if decimal(js_trim(text)) => {
                js_trim(text).parse().ok().map(Cell::Number)
            }
            _ => None,
        },
        "select" => option(column, value).map(Cell::Option),
        "date" => value.as_str().filter(|text| date(text)).map(Cell::Text),
        "checkbox" => value.as_bool().map(Cell::Bool),
        _ => None,
    }
}

/// `-?\d+(\.\d+)?`, ASCII digits.
fn decimal(text: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    match unsigned.split_once('.') {
        Some((whole, fraction)) => digits(whole) && digits(fraction),
        None => digits(unsigned),
    }
}

/// A real calendar day as `YYYY-MM-DD` (the browser's `isDate`): a merge or
/// a hand-written fence may leave `2026-02-30`, which reads as empty.
fn date(text: &str) -> bool {
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        });
    let part = |range: std::ops::Range<usize>| text[range].parse::<u32>().unwrap_or(0);
    if !shaped {
        return false;
    }
    let (year, month, day) = (part(0..4), part(5..7), part(8..10));
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    (1..=days).contains(&day)
}

/// The select option a cell names, if it still exists.
fn option<'a>(column: &'a Value, value: &Value) -> Option<&'a Value> {
    let id = value.as_str()?;
    column["options"]
        .as_array()?
        .iter()
        .find(|option| option["id"].as_str() == Some(id))
}

/// A cell as plain text (the browser's `cellText`): option names, ISO
/// dates, ☑/☐ for checkboxes, "" when empty.
fn cell_text(column: &Value, row: &Value) -> String {
    let checkbox = column["kind"] == "checkbox";
    match cell(column, row) {
        None if checkbox => "☐".into(),
        None => String::new(),
        Some(Cell::Bool(true)) => "☑".into(),
        Some(Cell::Bool(false)) => "☐".into(),
        Some(Cell::Number(n)) => plain_number(n),
        Some(Cell::Shown(text)) => text,
        Some(Cell::Option(option)) => option["name"].as_str().unwrap_or_default().into(),
        Some(Cell::Text(text)) => text.into(),
    }
}

/// A row's sort key: a number (an option's place for a select column, 0 or
/// 1 for a checkbox), a string, or none for an empty cell.
enum Rank {
    Number(f64),
    Text(String),
}

/// The rows in the view's order (the browser's `sortedRows`): its sort when
/// it names a column, empty cells last whatever the direction and ties in
/// list order; else list order. Text compares by code point, as Go and the
/// browser's `byCodePoint` do (an astral character after U+FFFF).
fn sorted<'a>(columns: &'a [Value], rows: &'a [Value], view: &Value) -> Vec<&'a Value> {
    let sort = &view["sort"];
    let column = sort.as_object().and_then(|_| {
        columns
            .iter()
            .find(|column| column["id"] == sort["columnId"])
    });
    let Some(column) = column else {
        return rows.iter().collect();
    };
    let dir = if sort["dir"] == "asc" { 1 } else { -1 };
    let rank = |row: &Value| -> Option<Rank> {
        let value = cell(column, row)?;
        match value {
            Cell::Text("") => None,
            Cell::Text(text) => Some(Rank::Text(text.to_owned())),
            Cell::Shown(text) => Some(Rank::Text(text)),
            Cell::Number(n) => Some(Rank::Number(n)),
            Cell::Bool(b) => Some(Rank::Number(f64::from(u8::from(b)))),
            Cell::Option(option) => {
                let options = column["options"].as_array()?;
                let place = options.iter().position(|o| std::ptr::eq(o, option))?;
                Some(Rank::Number(place as f64))
            }
        }
    };
    let mut ranked: Vec<(Option<Rank>, &Value)> = rows.iter().map(|row| (rank(row), row)).collect();
    ranked.sort_by(|(a, _), (b, _)| {
        use std::cmp::Ordering;
        let order = match (a, b) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Greater,
            (_, None) => return Ordering::Less,
            (Some(Rank::Number(a)), Some(Rank::Number(b))) => {
                a.partial_cmp(b).unwrap_or(Ordering::Equal)
            }
            (Some(Rank::Text(a)), Some(Rank::Text(b))) => a.cmp(b),
            _ => Ordering::Equal,
        };
        if dir < 0 { order.reverse() } else { order }
    });
    ranked.into_iter().map(|(_, row)| row).collect()
}

/// Text on one line: each line break (`\r\n`, `\r`, `\n`) a space.
fn one_line(text: &str) -> String {
    text.replace("\r\n", " ").replace(['\r', '\n'], " ")
}

fn escape(text: &str) -> String {
    one_line(text).replace('|', "\\|")
}

/// A table view's index text (Go's `tableViewIndexText`, the browser's
/// `tableViewText`): its title as a line, then its first view's rows (list
/// order with no view) as a Markdown table, the title column first, each cell as drawn, `|` escaped
/// and line breaks as spaces. A stored block passed [block]; anything else
/// reads as what it holds.
pub fn text(block: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    // The title on one line, left out when blank.
    let title = one_line(block["title"].as_str().unwrap_or_default());
    if !js_trim(&title).is_empty() {
        lines.extend([js_trim(&title).to_owned(), String::new()]);
    }
    let all: Vec<Value> = block["columns"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|column| column.is_object())
        .cloned()
        .collect();
    if all.is_empty() {
        return lines.join("\n");
    }
    let (mut columns, rest): (Vec<&Value>, Vec<&Value>) =
        all.iter().partition(|column| column["kind"] == "title");
    columns.extend(rest);
    let line = |cells: Vec<String>| {
        let cells: Vec<String> = cells.iter().map(|cell| escape(cell)).collect();
        format!("| {} |", cells.join(" | "))
    };
    lines.push(line(
        columns
            .iter()
            .map(|column| column["name"].as_str().unwrap_or_default().to_owned())
            .collect(),
    ));
    lines.push(line(columns.iter().map(|_| "---".to_owned()).collect()));
    let rows: Vec<Value> = block["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row.is_object())
        .cloned()
        .collect();
    let first = block["views"]
        .as_array()
        .and_then(|views| views.iter().find(|view| view.is_object()))
        .unwrap_or(&Value::Null);
    for row in sorted(&all, &rows, first) {
        lines.push(line(
            columns
                .iter()
                .map(|column| cell_text(column, row))
                .collect(),
        ));
    }
    lines.join("\n")
}

/// A number in plain decimal, the shortest that reads back exactly, never
/// with an exponent, -0 as 0 (the browser's `plainNumber`, as the figures'
/// index text writes one). A decimal text too long for a float reads as
/// Infinity, as JavaScript's `Number` gives it.
fn plain_number(n: f64) -> String {
    match n {
        f64::INFINITY => "Infinity".into(),
        f64::NEG_INFINITY => "-Infinity".into(),
        0.0 => "0".into(),
        n => format!("{n}"),
    }
}
