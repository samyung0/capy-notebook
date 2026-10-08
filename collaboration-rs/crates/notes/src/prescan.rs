//! Agent markdown checked in one pass before the import runs (Epo,
//! 2026-10-08): what the editor's import would certainly turn into a note
//! past the limits is refused at once, with what to change. Every count is a
//! lower bound of what the import makes, so nothing valid is refused:
//! - quote markers that open a line (each nests one blockquote; lists do
//!   not nest, the import writes them as indented paragraphs);
//! - blocks and table cells against the node limit (a block is at least an
//!   element and its text, a cell a cell, a paragraph and its text);
//! - link brackets and emphasis delimiter runs in one paragraph, outside code
//!   spans and escapes.
//!
//! Fenced code and raw HTML blocks are skipped whole (the import keeps them
//! as text): types 1-5 (`<pre>`, `<script>`, `<style>`, `<textarea>`,
//! comments, processing instructions, declarations, CDATA) to their closing
//! marker, types 6-7 (block tags such as `<div>`, a lone complete tag) to a
//! blank line.
//!
//! The conversion's deadline stays the backstop for anything else.

use crate::limits::{MAX_DEPTH, MAX_NODES};

/// The most link brackets and emphasis delimiter runs one paragraph may hold.
pub const MAX_PARAGRAPH_MARKS: u64 = 10_000;

/// Why the scan refused the source.
pub type Refused = String;

/// Quote markers opening `line`, as CommonMark reads them (up to three
/// spaces, `>`, one optional space; four spaces start code instead), and the
/// rest of the line. `limit` stops after that many markers.
fn quote_markers(line: &str, limit: usize) -> (usize, &str) {
    let mut rest = line;
    let mut depth = 0;
    while depth < limit {
        let spaces = rest.len() - rest.trim_start_matches(' ').len();
        if spaces > 3 || !rest[spaces..].starts_with('>') {
            break;
        }
        rest = &rest[spaces + 1..];
        rest = rest.strip_prefix(' ').unwrap_or(rest);
        depth += 1;
    }
    (depth, rest)
}

/// A raw HTML block of CommonMark types 1-5 opening `text`: its end marker
/// (lowercase) and the length of the opener, after which the end may already
/// be on the same line.
fn html_open(text: &str) -> Option<(&'static str, usize)> {
    if !text.starts_with('<') {
        return None;
    }
    let head: Vec<u8> = text
        .bytes()
        .take(10)
        .map(|b| b.to_ascii_lowercase())
        .collect();
    for (tag, end) in [
        ("<pre", "</pre>"),
        ("<script", "</script>"),
        ("<style", "</style>"),
        ("<textarea", "</textarea>"),
    ] {
        if head.starts_with(tag.as_bytes())
            && matches!(
                text.as_bytes().get(tag.len()),
                None | Some(b' ' | b'\t' | b'>')
            )
        {
            return Some((end, tag.len()));
        }
    }
    if text.starts_with("<!--") {
        Some(("-->", 4))
    } else if text.starts_with("<?") {
        Some(("?>", 2))
    } else if text.starts_with("<![CDATA[") {
        Some(("]]>", 9))
    } else if text.as_bytes().get(2).is_some_and(u8::is_ascii_alphabetic) && text.starts_with("<!")
    {
        Some((">", 2))
    } else {
        None
    }
}

/// CommonMark's type 6 block tag names.
const BLOCK_TAGS: [&str; 62] = [
    "address",
    "article",
    "aside",
    "base",
    "basefont",
    "blockquote",
    "body",
    "caption",
    "center",
    "col",
    "colgroup",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "frame",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hr",
    "html",
    "iframe",
    "legend",
    "li",
    "link",
    "main",
    "menu",
    "menuitem",
    "nav",
    "noframes",
    "ol",
    "optgroup",
    "option",
    "p",
    "param",
    "search",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "track",
    "ul",
];

/// Whether `text` opens an HTML block of type 6 (a block tag, which may
/// interrupt a paragraph) or 7 (a lone complete tag, which may not), both
/// running to a blank line.
fn html_open_to_blank(text: &str, in_paragraph: bool) -> bool {
    let Some(rest) = text.strip_prefix('<') else {
        return false;
    };
    let closing = rest.starts_with('/');
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let name_len = rest
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'-')
        .count();
    if name_len == 0 || !rest.as_bytes()[0].is_ascii_alphabetic() {
        return false;
    }
    let name = rest[..name_len].to_ascii_lowercase();
    let after = &rest[name_len..];
    let ends_name =
        after.is_empty() || after.starts_with([' ', '\t', '>']) || after.starts_with("/>");
    if ends_name && BLOCK_TAGS.contains(&name.as_str()) {
        return true;
    }
    // Type 7: a complete tag alone on its line, not one of type 1's names.
    let line = text.trim_end();
    !in_paragraph
        && ends_name
        && !matches!(name.as_str(), "pre" | "script" | "style" | "textarea")
        && line.ends_with('>')
        && !line[1..line.len() - 1].contains(['<', '>'])
        && (!closing || after.trim_end() == ">")
}

/// Whether `text` holds `marker` (lowercase), ignoring ASCII case.
fn holds(text: &str, marker: &str) -> bool {
    text.to_ascii_lowercase().contains(marker)
}

/// A fence opening (` ``` ` or `~~~`, three or more): its character and length.
fn fence_open(text: &str) -> Option<(u8, usize)> {
    let ch = *text.as_bytes().first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let len = text.bytes().take_while(|b| *b == ch).count();
    let info = &text[len..];
    (len >= 3 && !(ch == b'`' && info.contains('`'))).then_some((ch, len))
}

/// A list item's content after its marker (`-`, `+`, `*` or `1.`/`1)`
/// followed by a space), and whether the marker is an ordered one other than 1.
fn list_item(text: &str) -> Option<(&str, bool)> {
    let bytes = text.as_bytes();
    let (marker, later) = match bytes.first()? {
        b'-' | b'+' | b'*' => (1, false),
        b'0'..=b'9' => {
            let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
            if digits > 9 || !matches!(bytes.get(digits), Some(b'.' | b')')) {
                return None;
            }
            (digits + 1, &text[..digits] != "1")
        }
        _ => return None,
    };
    let content = text[marker..].strip_prefix([' ', '\t'])?;
    (!content.trim().is_empty()).then_some((content, later))
}

/// `***`, `---` or `___` (spaces allowed), or a setext `===` line.
fn rule_line(text: &str) -> Option<u8> {
    let ch = *text.as_bytes().first()?;
    if !matches!(ch, b'*' | b'-' | b'_' | b'=') {
        return None;
    }
    let count = text.bytes().filter(|b| *b == ch).count();
    let only = text.bytes().all(|b| b == ch || b == b' ' || b == b'\t');
    (only && (count >= 3 || ch == b'=')).then_some(ch)
}

/// Unescaped `|` cells of a table row (outer pipes trimmed).
fn cells(text: &str) -> usize {
    let row = text.trim();
    let row = row.strip_prefix('|').unwrap_or(row);
    let mut pipes = 0;
    let mut escaped = false;
    let mut last_pipe = false;
    for b in row.bytes() {
        last_pipe = false;
        if escaped {
            escaped = false;
        } else if b == b'\\' {
            escaped = true;
        } else if b == b'|' {
            pipes += 1;
            last_pipe = true;
        }
    }
    if last_pipe { pipes } else { pipes + 1 }
}

/// `[label]: destination` (or a footnote's `[^1]: text`).
fn reference_definition(text: &str) -> bool {
    text.starts_with('[')
        && text
            .find("]:")
            .is_some_and(|end| end > 1 && !text[1..end].contains(['[', ']']))
}

/// A GFM delimiter row (`|---|:-:|`).
fn delimiter_row(text: &str) -> bool {
    let row = text.trim();
    row.contains('-')
        && row
            .bytes()
            .all(|b| matches!(b, b'|' | b'-' | b':' | b' ' | b'\t'))
}

/// Counts a paragraph's link brackets and emphasis delimiter runs, outside
/// code spans (`code` holds an open span's backtick run) and escapes.
fn count_marks(text: &[u8], code: &mut Option<usize>) -> u64 {
    let mut marks = 0;
    let mut i = 0;
    while i < text.len() {
        let b = text[i];
        if b == b'`' {
            let run = text[i..].iter().take_while(|c| **c == b'`').count();
            *code = match *code {
                Some(open) if open == run => None,
                Some(open) => Some(open),
                None => Some(run),
            };
            i += run;
            continue;
        }
        if code.is_some() {
            i += 1;
            continue;
        }
        match b {
            b'\\' => i += 1,
            b'[' | b']' => marks += 1,
            b'*' | b'_' | b'~' => {
                let run = text[i..].iter().take_while(|c| **c == b).count();
                let before = i.checked_sub(1).map(|p| text[p]);
                let after = text.get(i + run).copied();
                // An underscore run between letters or digits never emphasizes.
                let intraword = b == b'_'
                    && before.is_some_and(|c| c.is_ascii_alphanumeric())
                    && after.is_some_and(|c| c.is_ascii_alphanumeric());
                if !intraword {
                    marks += 1;
                }
                i += run;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    marks
}

/// The scan: `Err` names the line and the limit.
pub fn prescan(source: &str) -> Result<(), Refused> {
    let max_depth = MAX_DEPTH as usize;
    // An open fence: its character, length and the quote depth it opened at.
    let mut fence: Option<(u8, usize, usize)> = None;
    // An open HTML block: its end marker (none: a blank line) and the quote
    // depth it opened at.
    let mut html: Option<(Option<&'static str>, usize)> = None;
    let mut in_paragraph = false;
    let mut in_list = false;
    let mut after_blank = true;
    let mut blocks: u64 = 0;
    let mut table_nodes: u64 = 0;
    // A paragraph's first line holding pipes: its cells (a table header).
    let mut header: Option<usize> = None;
    let mut table: Option<usize> = None;
    let mut marks: u64 = 0;
    let mut code: Option<usize> = None;
    for (index, raw) in source.split('\n').enumerate() {
        let line_no = index + 1;
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some((ch, len, depth)) = fence {
            let (markers, content) = quote_markers(line, depth);
            if markers == depth {
                let text = content.trim_start_matches(' ');
                let closes = content.len() - text.len() <= 3
                    && text.bytes().take_while(|b| *b == ch).count() >= len
                    && text.trim_start_matches(ch as char).trim().is_empty();
                if closes {
                    fence = None;
                }
                continue;
            }
            // The quote it opened in ended, and the fence with it.
            fence = None;
        }
        if let Some((end, depth)) = html {
            let (markers, content) = quote_markers(line, depth);
            if markers == depth {
                let ends = match end {
                    Some(end) => holds(content, end),
                    None => content.trim().is_empty(),
                };
                if ends {
                    html = None;
                }
                continue;
            }
            html = None;
        }
        let (depth, content) = quote_markers(line, max_depth + 1);
        if depth > max_depth {
            return Err(format!(
                "markdown line {line_no} nests more than {max_depth} quotes; a note nests at most {max_depth} levels"
            ));
        }
        if content.trim().is_empty() {
            in_paragraph = false;
            after_blank = true;
            header = None;
            table = None;
            marks = 0;
            code = None;
            continue;
        }
        let indent = content.len() - content.trim_start_matches(' ').len();
        let text = content.trim_start();
        let was_blank = std::mem::replace(&mut after_blank, false);
        if content.starts_with('\t') || (indent >= 4 && !in_paragraph && !in_list) {
            // Indented code (a tab counts as four spaces).
            continue;
        }
        let to_blank = indent <= 3 && html_open_to_blank(text, in_paragraph);
        if to_blank {
            html = Some((None, depth));
            in_paragraph = false;
            header = None;
            table = None;
            marks = 0;
            code = None;
            continue;
        }
        if indent <= 3
            && let Some((end, opener)) = html_open(text)
        {
            if !holds(&text[opener..], end) {
                html = Some((Some(end), depth));
            }
            in_paragraph = false;
            header = None;
            table = None;
            marks = 0;
            code = None;
            continue;
        }
        if let Some((ch, len)) = fence_open(text) {
            fence = Some((ch, len, depth));
            blocks += 1;
            in_paragraph = false;
            header = None;
            table = None;
            continue;
        }
        if let Some(cols) = table {
            if text.contains('|') {
                table_nodes += 1 + 3 * cols as u64;
                check_nodes(blocks, table_nodes, line_no)?;
                continue;
            }
            table = None;
        }
        if let Some(cols) = header.take()
            && delimiter_row(text)
            && cells(text) == cols
        {
            // The header line counted as a paragraph block: it is the table's
            // first row instead.
            blocks -= 1;
            table_nodes += 1 + (1 + 3 * cols as u64);
            table = Some(cols);
            in_paragraph = false;
            check_nodes(blocks, table_nodes, line_no)?;
            continue;
        }
        if text.starts_with('#') {
            let hashes = text.bytes().take_while(|b| *b == b'#').count();
            let rest = &text[hashes..];
            if hashes <= 6 && (rest.is_empty() || rest.starts_with([' ', '\t'])) {
                if !rest.trim().is_empty() {
                    blocks += 1;
                }
                in_paragraph = false;
                in_list = false;
                check_marks(count_marks(rest.as_bytes(), &mut None), line_no)?;
                check_nodes(blocks, table_nodes, line_no)?;
                continue;
            }
        }
        if let Some(ch) = rule_line(text) {
            // After paragraph text, `---` and `===` make it a heading.
            let setext = in_paragraph && matches!(ch, b'-' | b'=');
            if !setext && ch != b'=' {
                blocks += 1;
                in_list = false;
            }
            in_paragraph = false;
            marks = 0;
            code = None;
            if setext || ch != b'=' {
                continue;
            }
        }
        if matches!(text.trim_end(), "-" | "+" | "*" | "1." | "1)") {
            // An empty list item: the import may make nothing of it.
            in_list = true;
            in_paragraph = false;
            continue;
        }
        if let Some((item, later)) = list_item(text)
            && (in_list || (indent <= 3 && !(in_paragraph && later)))
        {
            blocks += 1;
            in_list = true;
            in_paragraph = true;
            header = None;
            marks = count_marks(item.as_bytes(), &mut code);
            check_marks(marks, line_no)?;
            check_nodes(blocks, table_nodes, line_no)?;
            continue;
        }
        if !in_paragraph && (text.starts_with('<') || reference_definition(text)) {
            // HTML and link reference definitions may make no node at all.
            continue;
        }
        if !in_paragraph {
            blocks += 1;
            if was_blank && indent == 0 {
                in_list = false;
            }
            in_paragraph = true;
            marks = 0;
            code = None;
            header = text.contains('|').then(|| cells(text));
        } else {
            header = None;
        }
        marks += count_marks(text.as_bytes(), &mut code);
        check_marks(marks, line_no)?;
        check_nodes(blocks, table_nodes, line_no)?;
    }
    Ok(())
}

fn check_nodes(blocks: u64, table_nodes: u64, line_no: usize) -> Result<(), Refused> {
    let nodes = 2 * blocks + table_nodes;
    if nodes > MAX_NODES {
        return Err(format!(
            "markdown makes more than {MAX_NODES} nodes by line {line_no} (blocks and table cells); a note holds at most {MAX_NODES}"
        ));
    }
    Ok(())
}

fn check_marks(marks: u64, line_no: usize) -> Result<(), Refused> {
    if marks > MAX_PARAGRAPH_MARKS {
        return Err(format!(
            "markdown paragraph at line {line_no} holds more than {MAX_PARAGRAPH_MARKS} link brackets or emphasis delimiters"
        ));
    }
    Ok(())
}
