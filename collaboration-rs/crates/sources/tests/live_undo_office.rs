//! The live Undo of an agent's Office edit (`ydoc::undo`, Epo 2026-10-20):
//! the engine's change, merged on a copy of the room as `sources::edit`
//! merges it, lands in the room keeping what it deleted, and reverting it
//! there restores the content. An XLSX formula reading the edited cell
//! computes from the restored value, as an editor's engine recalculates it.

#![allow(clippy::unwrap_used)]

use std::path::PathBuf;

use betteroffice_xlsx::{CalculationOptions, CellRef, CellValue, Workbook};
use office_service::{Checkpoint, Command, Format};
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
        let (_, redo) = ydoc::undo::revert(&room, change).unwrap();
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
    let file = File::open(Format::Xlsx, "e2e/fixtures/files/basic/grades.xlsx");
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
