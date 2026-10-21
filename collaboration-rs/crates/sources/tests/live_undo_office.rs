//! The live Undo of an agent's Office edit (`ydoc::undo`, Epo 2026-10-20):
//! the engine's change, merged on a copy of the room as `sources::edit`
//! merges it, lands in the room keeping what it deleted, and reverting it
//! there restores the content. An XLSX formula reading the edited cell
//! computes from the restored value, as an editor's engine recalculates it;
//! structural XLSX commands (a row delete, a sheet delete) and DOCX and PPTX
//! paragraph inserts and deletes undo the same way.

#![allow(clippy::unwrap_used)]

use std::path::PathBuf;

use betteroffice_xlsx::{CalculationOptions, CellRef, CellValue, Workbook};
use office_service::{Checkpoint, Command, Determinism, Format, InspectQuery};
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
        Self::of(format, std::fs::read(root.join(path)).unwrap())
    }

    fn of(format: Format, base: Vec<u8>) -> Self {
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

    /// The file the room saves.
    fn export(&self, room: &Doc) -> Vec<u8> {
        let determinism = Determinism {
            seed: &"0".repeat(64),
            now: "2026-10-21T00:00:00.000Z",
        };
        office_service::export(&self.base, self.checkpoint(&state(room)), determinism).unwrap()
    }

    /// Whether `commands` land on the room's state (the room unchanged).
    fn lands(&self, room: &Doc, commands: &[Command]) -> bool {
        office_service::apply_commands(&self.base, self.checkpoint(&state(room)), commands).is_ok()
    }

    /// The agent's scoped XLSX read: the sheet list, or a range's cells.
    fn read(&self, room: &Doc, sheet: Option<&str>, range: Option<&str>) -> serde_json::Value {
        let query = InspectQuery {
            sheet: sheet.map(str::to_owned),
            range: range.map(str::to_owned),
            ..InspectQuery::default()
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
const LESSON_DOCX: &str = "e2e/fixtures/files/basic/lesson.docx";
const LESSON_PPTX: &str = "e2e/fixtures/files/basic/lesson.pptx";

/// lesson.docx with its first paragraph ending a section and, after its
/// table, a paragraph and a closing one, the body's last (a paragraph right
/// after a table is not one the agent edits).
fn lesson_docx() -> File {
    let lesson = File::open(Format::Docx, LESSON_DOCX);
    let parts: Vec<(String, Vec<u8>)> = ooxml_opc::unzip_parts(&lesson.base)
        .unwrap()
        .into_iter()
        .map(|(name, bytes)| {
            if name != "word/document.xml" {
                return (name, bytes);
            }
            let xml = String::from_utf8(bytes)
                .unwrap()
                .replacen(
                    "<w:p><w:r><w:t>Owner sentence",
                    r#"<w:p><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr><w:r><w:t>Owner sentence"#,
                    1,
                )
                .replacen(
                    "</w:tbl><w:sectPr",
                    "</w:tbl><w:p><w:r><w:t>After the table.</w:t></w:r></w:p><w:p><w:r><w:t>Closing line.</w:t></w:r></w:p><w:sectPr",
                    1,
                );
            (name, xml.into_bytes())
        })
        .collect();
    File::of(Format::Docx, ooxml_opc::rezip_parts(&parts).unwrap())
}

/// An insert_paragraph naming its anchor by `key` (`afterId` or `beforeId`).
fn insert(key: &str, anchor: &str, text: &str, style: Option<&str>) -> Command {
    let mut value = serde_json::json!({ "type": "insert_paragraph", "text": text });
    value[key] = anchor.into();
    if let Some(style) = style {
        value["style"] = style.into();
    }
    command(value)
}

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

/// DOCX and PPTX `insert_paragraph` and `delete_paragraph` (Epo
/// 2026-10-21): Undo takes an inserted paragraph out and puts a deleted one
/// back, the file saving as it did before the edit. That holds for the
/// inserts the engine gives no inverse too: one at a section's end, whose
/// split moves the section mark to the new paragraph as Enter does, and an
/// append.
#[test]
fn undo_reverts_paragraph_inserts_and_deletes() {
    for file in [lesson_docx(), File::open(Format::Pptx, LESSON_PPTX)] {
        let room = file.room();
        let saved = file.export(&room);
        let entries = file.entries(&room);
        let id = |text: &str| {
            entries
                .iter()
                .find(|entry| entry.value.starts_with(text))
                .unwrap_or_else(|| panic!("no paragraph reads {text:?}"))
                .id
                .clone()
        };
        let owner = id("Owner sentence");
        let text = |id: &str| {
            let entry = entries.iter().find(|entry| entry.id == id).unwrap();
            entry.value.clone()
        };
        let mut cases = vec![
            // DOCX: the section's end; PPTX: its shape's last paragraph.
            vec![insert("afterId", &owner, "Coda", None)],
            vec![insert("beforeId", &owner, "Preface", None)],
            // A delete of the paragraph an insert made not its story's last.
            vec![
                insert("afterId", &owner, "Extra", None),
                Command::DeleteParagraph {
                    target_id: owner.clone(),
                    expected_text: text(&owner),
                },
            ],
        ];
        if file.format == Format::Docx {
            cases.push(vec![insert(
                "afterId",
                &id("Closing line."),
                "Appendix",
                None,
            )]);
            cases.push(vec![insert("beforeId", &owner, "Title", Some("Heading1"))]);
            let collaborator = id("Collaborator sentence");
            cases.push(vec![Command::DeleteParagraph {
                expected_text: text(&collaborator),
                target_id: collaborator,
            }]);
        }
        for case in cases {
            let change = file.agent_edit(&room, &case);
            assert_ne!(file.export(&room), saved, "{case:?}");
            ydoc::undo::revert(&room, change).unwrap();
            assert!(file.export(&room) == saved, "{case:?} undoes");
        }
    }
}

/// What an edit's Undo and its Redo send, measured on copies of the room
/// (`ydoc::undo::revert_len`), the room left undone.
fn undo_and_redo(room: &Doc, change: Change) -> (usize, usize) {
    let undo = ydoc::undo::revert_len(room, &change);
    let redo = ydoc::undo::revert(room, change)
        .and_then(|reverted| reverted.next)
        .map_or(0, |back| ydoc::undo::revert_len(room, &back));
    (undo, redo)
}

/// Prints the ratio of `cost` to what the Undo and Redo sent (STATE.md
/// keeps them) and notes a cost that does not cover both.
fn covers(short: &mut Vec<String>, name: &str, cost: usize, (undo, redo): (usize, usize)) {
    let sent = undo.max(redo);
    eprintln!(
        "undo_cost {name}: cost {cost} B, Undo {undo} B, Redo {redo} B, ratio {:.1}",
        cost as f64 / sent.max(1) as f64
    );
    if cost < sent {
        short.push(format!("{name}: cost {cost} < Undo {undo} / Redo {redo}"));
    }
}

fn command(value: serde_json::Value) -> Command {
    serde_json::from_value(value).unwrap()
}

/// Epo 2026-10-21: an agent edit's Undo is sized from its commands
/// (`sources::undo_cost`), never by reverting on a copy. On the fixtures every
/// Office command type's rule, and the text source's, is at least what the
/// edit's Undo and its Redo send. Fails if a rule under-estimates.
#[test]
fn every_command_costs_at_least_what_its_undo_and_redo_send() {
    let mut short = Vec::new();
    let xlsx = File::open(Format::Xlsx, GRADES);
    let room = xlsx.room();
    let (sheet, name) = xlsx.sheets(&room).remove(0);
    let long = "a longer cell value, ".repeat(10);
    let grid = |rows: usize, cols: usize, text: &str| -> Vec<Vec<String>> {
        (0..rows)
            .map(|r| (0..cols).map(|c| format!("{text}{r}.{c}")).collect())
            .collect()
    };
    let empty = |rows: usize, cols: usize| vec![vec![String::new(); cols]; rows];
    // Filled cells for the cases to overwrite, format and delete.
    xlsx.agent_edit(
        &room,
        &[Command::SetRange {
            sheet: sheet.clone(),
            range: "AA1:AD40".into(),
            expected: empty(40, 4),
            values: grid(40, 4, &long),
        }],
    );
    let cases = vec![
        (
            "set_cell (new)",
            vec![command(serde_json::json!({
                "type": "set_cell", "sheet": sheet, "cell": "Z5",
                "expectedValue": "", "value": long,
            }))],
        ),
        (
            "set_cell (overwrite)",
            vec![command(serde_json::json!({
                "type": "set_cell", "sheet": sheet, "cell": "AA1",
                "expectedValue": format!("{long}0.0"), "value": "short",
            }))],
        ),
        (
            "set_range (new)",
            vec![Command::SetRange {
                sheet: sheet.clone(),
                range: "AF1:AH30".into(),
                expected: empty(30, 3),
                values: grid(30, 3, "v"),
            }],
        ),
        (
            "set_range (overwrite)",
            vec![Command::SetRange {
                sheet: sheet.clone(),
                range: "AA2:AD40".into(),
                expected: grid(40, 4, &long)[1..].to_vec(),
                values: grid(39, 4, "x"),
            }],
        ),
        (
            "format_cells",
            vec![command(serde_json::json!({
                "type": "format_cells", "sheet": sheet, "range": "AA1:AD40",
                "style": {
                    "bold": true, "italic": true, "fillColor": "#ffcc00",
                    "textColor": "#123456", "fontSize": 14, "fontFamily": "Georgia",
                },
            }))],
        ),
        (
            "add_sheet",
            vec![command(
                serde_json::json!({ "type": "add_sheet", "name": "Calibration" }),
            )],
        ),
        (
            "rename_sheet",
            vec![command(serde_json::json!({
                "type": "rename_sheet", "sheet": sheet,
                "expectedName": name, "name": "Renamed for calibration",
            }))],
        ),
        (
            "insert_rows",
            vec![command(serde_json::json!({
                "type": "insert_rows", "sheet": sheet, "at": 5, "count": 50,
            }))],
        ),
        (
            "insert_columns",
            vec![command(serde_json::json!({
                "type": "insert_columns", "sheet": sheet, "at": "B", "count": 20,
            }))],
        ),
    ];
    for (case, commands) in cases {
        let cost = commands
            .iter()
            .map(sources::undo_cost::office)
            .fold(0, usize::saturating_add);
        let change = xlsx.agent_edit(&room, &commands);
        covers(&mut short, case, cost, undo_and_redo(&room, change));
    }
    // Bands and a sheet to delete, filled first.
    xlsx.agent_edit(
        &room,
        &[
            command(serde_json::json!({ "type": "add_sheet", "name": "Data" })),
            Command::SetRange {
                sheet: "Data".into(),
                range: "A1:C30".into(),
                expected: empty(30, 3),
                values: grid(30, 3, &long),
            },
        ],
    );
    for (case, removal) in [
        (
            "delete_rows",
            command(serde_json::json!({
                "type": "delete_rows", "sheet": "Data", "at": 1, "count": 10,
                "expected": grid(10, 3, &long),
            })),
        ),
        (
            "delete_columns",
            command(serde_json::json!({
                "type": "delete_columns", "sheet": "Data", "at": "A", "count": 1,
                "expected": grid(30, 3, &long).iter().map(|row| vec![row[0].clone()]).collect::<Vec<_>>(),
            })),
        ),
        (
            "delete_sheet",
            command(serde_json::json!({
                "type": "delete_sheet", "sheet": "Data", "expectedName": "Data",
            })),
        ),
    ] {
        // Each case leaves the room undone, so the next finds its band.
        let cost = sources::undo_cost::office(&removal);
        let change = xlsx.agent_edit(&room, &[removal]);
        covers(&mut short, case, cost, undo_and_redo(&room, change));
    }

    for (format, path) in [
        (Format::Docx, "e2e/fixtures/files/basic/lesson.docx"),
        (Format::Pptx, "e2e/fixtures/files/basic/lesson.pptx"),
    ] {
        let file = File::open(format, path);
        let room = file.room();
        for entry in file
            .entries(&room)
            .into_iter()
            .filter(|entry| !entry.value.is_empty())
            .take(6)
        {
            let replace = Command::ReplaceText {
                target_id: entry.id.clone(),
                expected_text: entry.value.clone(),
                text: format!("{} {}", entry.value, "and a longer replacement".repeat(3)),
            };
            let cost = sources::undo_cost::office(&replace);
            let change = file.agent_edit(&room, &[replace]);
            covers(
                &mut short,
                &format!("{path} replace_text"),
                cost,
                undo_and_redo(&room, change),
            );
        }
        let long = "a new paragraph from the agent, ".repeat(8);
        let style = (format == Format::Docx).then_some("Heading1");
        for entry in file
            .entries(&room)
            .into_iter()
            .filter(|entry| format == Format::Pptx || entry.id.starts_with("body:"))
            .take(4)
        {
            let mut cases = vec![
                (
                    "insert_paragraph",
                    insert("afterId", &entry.id, &long, None),
                ),
                ("insert_paragraph", insert("beforeId", &entry.id, "", style)),
            ];
            let delete = Command::DeleteParagraph {
                target_id: entry.id.clone(),
                expected_text: entry.value.clone(),
            };
            if !file.lands(&room, std::slice::from_ref(&delete)) {
                // Its story's last paragraph: one more after it, kept.
                file.agent_edit(&room, &[insert("afterId", &entry.id, "kept", None)]);
            }
            cases.push(("delete_paragraph", delete));
            for (name, case) in cases {
                let cost = sources::undo_cost::office(&case);
                let change = file.agent_edit(&room, &[case]);
                covers(
                    &mut short,
                    &format!("{path} {name}"),
                    cost,
                    undo_and_redo(&room, change),
                );
            }
        }
    }

    // A text source: `replace_text` on its text.
    use yrs::{Text, WriteTxn};
    let text = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../e2e/fixtures/files/basic/notes.txt"),
    )
    .unwrap();
    let room = ydoc::scratch_doc();
    room.get_or_insert_text(sources::text::TEXT_ROOT).insert(
        &mut room.transact_mut(),
        0,
        &format!("{text}\n{}", "filler line\n".repeat(200)),
    );
    for (expected, replacement) in [
        (
            "Wetland plants absorb carbon",
            "Marsh plants hold carbon".to_owned(),
        ),
        ("LARCH-17", "a much longer code ".repeat(40)),
    ] {
        let replace = notes::edit::DocumentCommand::ReplaceText {
            block_id: None,
            expected_text: expected.into(),
            text: replacement,
        };
        let cost = sources::undo_cost::document(&replace, |_| 0);
        let scratch = doc_of(&state(&room));
        let captured = {
            let mut txn = scratch.transact_mut();
            let root = txn.get_or_insert_text(sources::text::TEXT_ROOT);
            notes::edit::apply_text_commands(&mut txn, &root, &[replace]).unwrap();
            Captured::of(&mut txn)
        };
        let update = scratch
            .transact()
            .encode_state_as_update_v1(&room.transact().state_vector());
        ydoc::undo::apply_kept(&room, Update::decode_v1(&update).unwrap()).unwrap();
        covers(
            &mut short,
            "text replace_text",
            cost,
            undo_and_redo(&room, captured.change(&room)),
        );
    }
    assert!(short.is_empty(), "{short:#?}");
}
