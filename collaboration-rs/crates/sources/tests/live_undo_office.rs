//! The live Undo of an agent's Office edit (`ydoc::undo`, Epo 2026-10-20):
//! the engine's change, merged on a copy of the room as `sources::edit`
//! merges it, lands in the room keeping what it deleted, and reverting it
//! there restores the content. An XLSX formula reading the edited cell
//! computes from the restored value, as an editor's engine recalculates it;
//! structural XLSX commands (a row delete, a sheet delete) undo the same way.

#![allow(clippy::unwrap_used)]

use std::path::PathBuf;

use betteroffice_xlsx::{CalculationOptions, CellRef, CellValue, Workbook};
use office_service::{Checkpoint, Command, Format, InspectQuery};
use ydoc::undo::{Captured, Change};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

struct File {
    format: Format,
    base: Vec<u8>,
    sha: String,
}

impl File {
    fn open(format: Format, path: &str) -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let base = std::fs::read(root.join(path)).unwrap();
        let sha = office_service::sha256_hex(&base);
        File { format, base, sha }
    }

    fn checkpoint<'a>(&'a self, state: &'a [u8]) -> Checkpoint<'a> {
        Checkpoint {
            format: self.format,
            schema_version: 1,
            base_sha256: &self.sha,
            state,
        }
    }

    /// A room holding the seed.
    fn room(&self) -> Doc {
        doc_of(&office_service::seed(self.format, &self.base).unwrap())
    }

    /// The agent's commands on the room: the engine runs them on the room's
    /// state, a copy merges the engine's result (the edit's own items), and
    /// the room applies the copy's change keeping what it deleted.
    fn agent_edit(&self, room: &Doc, commands: &[Command]) -> Change {
        let state = state(room);
        let applied =
            office_service::apply_commands(&self.base, self.checkpoint(&state), commands).unwrap();
        let copy = doc_of(&state);
        let captured = {
            let mut txn = copy.transact_mut();
            txn.apply_update(Update::decode_v1(&applied.state).unwrap())
                .unwrap();
            Captured::of(&mut txn)
        };
        let update = copy
            .transact()
            .encode_state_as_update_v1(&room.transact().state_vector());
        ydoc::undo::apply_kept(room, Update::decode_v1(&update).unwrap()).unwrap();
        captured.change(room)
    }

    fn entries(&self, room: &Doc) -> Vec<office_service::Entry> {
        office_service::inspect(&self.base, self.checkpoint(&state(room))).unwrap()
    }

    /// The agent's scoped XLSX read: the sheet list, or a range's cells.
    fn read(&self, room: &Doc, sheet: Option<&str>, range: Option<&str>) -> serde_json::Value {
        let query = InspectQuery {
            sheet: sheet.map(str::to_owned),
            range: range.map(str::to_owned),
        };
        office_service::inspect_scoped(&self.base, self.checkpoint(&state(room)), &query).unwrap()
    }

    /// The sheets' (id, name), in order.
    fn sheets(&self, room: &Doc) -> Vec<(String, String)> {
        let text = |value: &serde_json::Value| value.as_str().unwrap().to_owned();
        self.read(room, None, None)["sheets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|sheet| (text(&sheet["id"]), text(&sheet["name"])))
            .collect()
    }

    /// `address=input→value` for each non-empty cell of `range`.
    fn cells(&self, room: &Doc, sheet: &str, range: &str) -> Vec<String> {
        self.read(room, Some(sheet), Some(range))["cells"]
            .as_array()
            .unwrap()
            .iter()
            .map(|cell| {
                let text = |key: &str| cell[key].as_str().unwrap().to_owned();
                format!("{}={}→{}", text("address"), text("input"), text("value"))
            })
            .collect()
    }
}

const GRADES: &str = "e2e/fixtures/files/basic/grades.xlsx";

fn set_range(sheet: &str, range: &str, expected: &[&[&str]], values: &[&[&str]]) -> Command {
    let grid = |rows: &[&[&str]]| {
        rows.iter()
            .map(|row| row.iter().map(|cell| (*cell).to_owned()).collect())
            .collect()
    };
    Command::SetRange {
        sheet: sheet.to_owned(),
        range: range.to_owned(),
        expected: grid(expected),
        values: grid(values),
    }
}

fn doc_of(state: &[u8]) -> Doc {
    let doc = ydoc::scratch_doc();
    ydoc::apply(&doc, Update::decode_v1(state).unwrap()).unwrap();
    doc
}

fn state(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

/// DOCX and PPTX `replace_text`: Undo puts the paragraph's text back, Redo
/// the agent's.
#[test]
fn undo_restores_a_docx_and_a_pptx_paragraph() {
    for (format, path) in [
        (Format::Docx, "e2e/fixtures/files/basic/lesson.docx"),
        (Format::Pptx, "e2e/fixtures/files/basic/lesson.pptx"),
    ] {
        let file = File::open(format, path);
        let room = file.room();
        let entry = file
            .entries(&room)
            .into_iter()
            .find(|entry| entry.value.len() > 3)
            .unwrap();
        let edited = format!("{} edited", entry.value);
        let change = file.agent_edit(
            &room,
            &[Command::ReplaceText {
                target_id: entry.id.clone(),
                expected_text: entry.value.clone(),
                text: edited.clone(),
            }],
        );
        let text = |room: &Doc| {
            file.entries(room)
                .into_iter()
                .find(|now| now.id == entry.id)
                .unwrap()
                .value
        };
        assert_eq!(text(&room), edited, "{path}");
        let redo = ydoc::undo::revert(&room, change).unwrap().next.unwrap();
        assert_eq!(text(&room), entry.value, "{path}");
        ydoc::undo::revert(&room, redo).unwrap();
        assert_eq!(text(&room), edited, "{path}");
    }
}

/// XLSX `set_cell`: Undo puts the cell's input back, and a formula reading
/// it computes from the restored value once an engine applies the room's
/// state (Yjs holds inputs; values are the engine's).
#[test]
fn undo_restores_an_xlsx_cell_and_its_dependent_formula() {
    let file = File::open(Format::Xlsx, GRADES);
    let room = file.room();
    let entries = file.entries(&room);
    let (sheet, _) = entries[0].position.rsplit_once(':').unwrap();
    let set = |cell: &str, expected: &str, value: &str| Command::SetCell {
        sheet: sheet.to_owned(),
        cell: cell.to_owned(),
        expected_value: expected.to_owned(),
        value: value.to_owned(),
    };
    // Someone's earlier edits: an input and a formula reading it.
    file.agent_edit(&room, &[set("Z2", "", "3"), set("Z1", "", "=Z2*2")]);
    let change = file.agent_edit(&room, &[set("Z2", "3", "5")]);
    let computed = |room: &Doc, at: &str| {
        let options = CalculationOptions { now_serial: None };
        let mut workbook =
            Workbook::open_collaborative_recalculated(&file.base, 99, options).unwrap();
        workbook
            .apply_update_v1(&state(room), CalculationOptions { now_serial: None })
            .unwrap();
        workbook.model().sheets[0]
            .cell(CellRef::parse_a1(at).unwrap())
            .map(|cell| cell.value.clone())
    };
    let number = |value: f64| Some(CellValue::Number { value });
    assert_eq!(computed(&room, "Z2"), number(5.0));
    assert_eq!(computed(&room, "Z1"), number(10.0));
    ydoc::undo::revert(&room, change).unwrap();
    assert_eq!(computed(&room, "Z2"), number(3.0));
    assert_eq!(computed(&room, "Z1"), number(6.0));
}

/// XLSX `delete_rows` (structural commands get the live Undo, Epo
/// 2026-10-20): Undo brings the band's cells back, and a formula above it
/// that the delete broke reads them again.
#[test]
fn undo_restores_a_deleted_row_band_and_the_formula_reading_it() {
    let file = File::open(Format::Xlsx, GRADES);
    let room = file.room();
    let (sheet, _) = file.sheets(&room).remove(0);
    file.agent_edit(
        &room,
        &[
            set_range(&sheet, "A100:A101", &[&[""], &[""]], &[&["3"], &["4"]]),
            set_range(&sheet, "Z1", &[&[""]], &[&["=A100+A101"]]),
        ],
    );
    let read = |room: &Doc| {
        (
            file.cells(room, &sheet, "Z1"),
            file.cells(room, &sheet, "A100:A101"),
        )
    };
    let before = read(&room);
    assert_eq!(before.0, ["Z1==A100+A101→7"]);
    let change = file.agent_edit(
        &room,
        &[Command::DeleteRows {
            sheet: sheet.clone(),
            at: 100,
            count: 2,
            expected: vec![vec!["3".into()], vec!["4".into()]],
        }],
    );
    let (formula, band) = read(&room);
    assert!(
        band.is_empty() && formula[0].contains("#REF!"),
        "{formula:?}"
    );
    ydoc::undo::revert(&room, change).unwrap();
    assert_eq!(read(&room), before);
}

/// XLSX `delete_sheet`: Undo brings the sheet back in its place with its
/// cells, and a formula on another sheet reading it computes again.
#[test]
fn undo_restores_a_deleted_sheet_and_the_formula_reading_it() {
    let file = File::open(Format::Xlsx, GRADES);
    let room = file.room();
    let (sheet, _) = file.sheets(&room).remove(0);
    file.agent_edit(
        &room,
        &[
            Command::AddSheet {
                name: "Data".into(),
                after: None,
            },
            set_range("Data", "A1", &[&[""]], &[&["5"]]),
            set_range(&sheet, "Z1", &[&[""]], &[&["=Data!A1*2"]]),
        ],
    );
    let read = |room: &Doc| {
        (
            file.sheets(room),
            file.cells(room, &sheet, "Z1"),
            file.cells(room, "Data", "A1"),
        )
    };
    let before = read(&room);
    assert_eq!(before.1, ["Z1==Data!A1*2→10"]);
    let change = file.agent_edit(
        &room,
        &[Command::DeleteSheet {
            sheet: "Data".into(),
            expected_name: "Data".into(),
        }],
    );
    assert!(file.sheets(&room).iter().all(|(_, name)| name != "Data"));
    assert!(file.cells(&room, &sheet, "Z1")[0].contains("#REF!"));
    ydoc::undo::revert(&room, change).unwrap();
    assert_eq!(read(&room), before);
}
