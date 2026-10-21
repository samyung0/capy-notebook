//! What an agent edit's Undo may send, estimated from its commands (Epo
//! 2026-10-21): one rule per command type, scaled by what the command
//! touches, summed over the edit's commands. An Undo re-inserts what the edit
//! removed and a Redo what it inserted, so each rule counts both sides. The
//! room offers no Undo whose estimate is past the 8 MiB update cap or its
//! admission headroom, and never reverts on a copy of the document to find
//! out. The factors over-estimate the real revert on the fixtures
//! (`tests/live_undo_office.rs`, the server's `edits.rs` tests print the
//! ratios). A new command adds its rule here: both matches are exhaustive.

use notes::edit::DocumentCommand;
use office_service::Command;
use serde_json::Value;

/// Bytes a revert takes per byte of content it re-inserts or removes: the
/// text and the structure Yjs keeps around it (runs, keys, origins).
pub const CONTENT: usize = 3;

/// Bytes for one Yjs piece more: a run or block an edit splits at either
/// end, a cell, a row or column entry, a sheet entry, a cell's style.
pub const PIECE: usize = 160;

/// A note, live item or text source command. `touched` is the JSON size of
/// the node with that id in the document before the edit (what a removal or
/// replacement takes out; 0 when the id is not there).
pub fn document(command: &DocumentCommand, touched: impl Fn(&str) -> usize) -> usize {
    let content = match command {
        // In a note block the replaced span's runs come back with their
        // formatting, which its text does not show: the block bounds them.
        DocumentCommand::ReplaceText {
            block_id,
            expected_text,
            text,
        } => {
            let block = block_id.as_deref().map_or(0, &touched);
            block.max(expected_text.len()) + text.len()
        }
        DocumentCommand::InsertBlock { blocks, .. } => blocks.iter().map(json_len).sum(),
        DocumentCommand::RemoveBlock {
            block_id,
            expected_text,
        } => touched(block_id).max(expected_text.len()),
        // A rewrite as one block of the same type also writes the old
        // block's caption and width (`keep_caption`): the old block again at
        // most.
        DocumentCommand::ReplaceBlock {
            block_id,
            expected_text,
            blocks,
        } => {
            2 * touched(block_id).max(expected_text.len())
                + blocks.iter().map(json_len).sum::<usize>()
        }
        DocumentCommand::ReplaceChild { node_id, node, .. } => touched(node_id) + json_len(node),
        DocumentCommand::InsertChild { node, .. } => json_len(node),
        DocumentCommand::RemoveChild { node_id, .. } => touched(node_id),
        // The card before (both sides) and the sides it writes; what it
        // expects is not written.
        DocumentCommand::ReplaceCard {
            card_id,
            front,
            back,
            ..
        } => {
            touched(card_id)
                + front.as_deref().map_or(0, str::len)
                + back.as_deref().map_or(0, str::len)
        }
    };
    content.saturating_mul(CONTENT).saturating_add(2 * PIECE)
}

/// An Office command. XLSX cells stay in Yjs when their row, column or sheet
/// goes, so a structural command costs its entries, not their cells.
pub fn office(command: &Command) -> usize {
    let (content, pieces) = match command {
        Command::ReplaceText {
            expected_text,
            text,
            ..
        } => (expected_text.len() + text.len(), 2),
        Command::SetCell {
            expected_value,
            value,
            ..
        } => (expected_value.len() + value.len(), 1),
        Command::SetRange {
            expected, values, ..
        } => (
            grid_len(expected) + grid_len(values),
            grid_cells(expected).max(grid_cells(values)),
        ),
        // Formatting: one style entry per cell in its range.
        Command::FormatCells { range, .. } => (0, range_cells(range)),
        // A new sheet's entry is a few maps (its Redo measured 354 bytes).
        Command::AddSheet { name, .. } => (name.len(), 4),
        Command::RenameSheet {
            expected_name,
            name,
            ..
        } => (expected_name.len() + name.len(), 1),
        Command::DeleteSheet { expected_name, .. } => (expected_name.len(), 1),
        Command::InsertRows { count, .. }
        | Command::DeleteRows { count, .. }
        | Command::InsertColumns { count, .. }
        | Command::DeleteColumns { count, .. } => (0, *count as usize),
        // A new paragraph: its text and style, its mark (a copy of its
        // anchor's properties: a list item's measured 837 bytes) and the run
        // it splits.
        Command::InsertParagraph { text, style, .. } => {
            (text.len() + style.as_ref().map_or(0, String::len), 8)
        }
        // A deleted paragraph comes back with its runs' formatting and its
        // mark's properties (a list item's: 950 bytes with its text).
        Command::DeleteParagraph { expected_text, .. } => (expected_text.len(), 8),
    };
    content
        .saturating_mul(CONTENT)
        .saturating_add(pieces.saturating_mul(PIECE))
}

fn json_len(value: &Value) -> usize {
    serde_json::to_string(value).map_or(0, |json| json.len())
}

fn grid_len(grid: &[Vec<String>]) -> usize {
    grid.iter().flatten().map(String::len).sum()
}

fn grid_cells(grid: &[Vec<String>]) -> usize {
    grid.iter().map(Vec::len).sum()
}

/// The cells of an XLSX range (`A1` or `A1:C3`); one it cannot read counts
/// as unbounded (the engine refuses it anyway).
fn range_cells(range: &str) -> usize {
    let cell = |at: &str| -> Option<(u64, u64)> {
        let at = at.replace('$', "");
        let digits = at.find(|c: char| c.is_ascii_digit())?;
        let (letters, row) = at.split_at(digits);
        if letters.is_empty() || !letters.chars().all(|c| c.is_ascii_alphabetic()) {
            return None;
        }
        let column = letters.chars().fold(0u64, |column, c| {
            column.saturating_mul(26) + u64::from(c.to_ascii_uppercase() as u8 - b'A' + 1)
        });
        Some((column, row.parse().ok()?))
    };
    let mut ends = range.split(':');
    let first = ends.next().and_then(cell);
    let last = match ends.next() {
        Some(end) => cell(end),
        None => first,
    };
    match (first, last, ends.next()) {
        (Some((c1, r1)), Some((c2, r2)), None) => {
            let cells = (c1.abs_diff(c2) + 1).saturating_mul(r1.abs_diff(r2) + 1);
            usize::try_from(cells).unwrap_or(usize::MAX)
        }
        _ => usize::MAX,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Review r3 M1: a small edit's Undo costs its commands alone, whatever
    /// the room holds; nothing here takes a document, so judging it copies
    /// none (the room compares this number with its caps).
    #[test]
    fn a_small_edit_costs_its_commands_whatever_the_room() {
        let cell: Command = serde_json::from_value(serde_json::json!({
            "type": "set_cell", "sheet": "sheet:0", "cell": "B7",
            "expectedValue": "3", "value": "4",
        }))
        .unwrap();
        assert_eq!(office(&cell), 2 * CONTENT + PIECE);
        let word = DocumentCommand::ReplaceText {
            block_id: None,
            expected_text: "world".into(),
            text: "there".into(),
        };
        assert_eq!(document(&word, |_| usize::MAX), 10 * CONTENT + 2 * PIECE);
    }

    #[test]
    fn a_range_counts_its_cells() {
        assert_eq!(range_cells("B7"), 1);
        assert_eq!(range_cells("A1:C3"), 9);
        assert_eq!(range_cells("$C$3:A1"), 9);
        assert_eq!(range_cells("AA1:AJ1000"), 10_000);
        assert_eq!(range_cells("A1:B2:C3"), usize::MAX);
        assert_eq!(range_cells("not a range"), usize::MAX);
    }
}
